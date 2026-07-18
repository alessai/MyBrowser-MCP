import { createHmac, randomUUID as cryptoRandomUUID } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join, parse, resolve } from "node:path";

import type { Command } from "commander";

import {
  analyzeTelemetryFiles,
  formatAnalysisTable,
  visitTelemetryFiles,
  type AnalysisDiagnostics,
  type AnalysisReport,
} from "./analyzer.js";
import { parseTelemetryConfig, type TelemetryCliOptions } from "./config.js";
import { serializeTelemetryEvent } from "./writer.js";
import type { FeedbackEvent, TelemetryConfig } from "./types.js";

const TRACE_FILE_PATTERN = /^trace-\d{8}-([A-Za-z0-9_-]{1,128})-\d{4}\.jsonl$/u;
const FEEDBACK_FILE_PATTERN = /^feedback-\d{8}-[A-Za-z0-9_-]{1,128}\.jsonl$/u;
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const INSTALL_KEY_BYTES = 32;
const MAX_NOTE_LENGTH = 512;
const FEEDBACK_LABELS = ["mistake", "expected", "unclear"] as const;

type FeedbackLabel = (typeof FEEDBACK_LABELS)[number];

interface TraceFile {
  path: string;
  runId?: string;
  size: number;
  mtimeMs: number;
}

interface DirectoryIdentity { dev: number; ino: number }

function requireNoFollow(): number {
  const noFollow = fsConstants.O_NOFOLLOW;
  if (typeof noFollow !== "number" || noFollow === 0) {
    throw new Error("O_NOFOLLOW is required for trace commands");
  }
  return noFollow;
}

function validateDirectory(path: string): DirectoryIdentity {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
    throw new Error("Trace directory must be a private directory with mode 0700");
  }
  return { dev: stat.dev, ino: stat.ino };
}

function assertNoSymlinkAncestors(path: string): void {
  const absolute = resolve(path);
  const parsed = parse(absolute);
  let current = parsed.root;
  for (const segment of absolute.slice(parsed.root.length).split(/[\\/]+/u).filter(Boolean)) {
    current = join(current, segment);
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error("Trace path contains a symbolic link");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") break;
      throw error;
    }
  }
}

function validateOutputParent(path: string): DirectoryIdentity {
  assertNoSymlinkAncestors(path);
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Trace export parent is not a directory");
  return { dev: stat.dev, ino: stat.ino };
}

function assertOutputParentIdentity(path: string, expected: DirectoryIdentity): void {
  const current = validateOutputParent(path);
  if (current.dev !== expected.dev || current.ino !== expected.ino) {
    throw new Error("Trace export parent identity changed during the operation");
  }
}

function assertDirectoryIdentity(path: string, expected: DirectoryIdentity): void {
  const current = validateDirectory(path);
  if (current.dev !== expected.dev || current.ino !== expected.ino) {
    throw new Error("Trace directory identity changed during the operation");
  }
}

function traceFiles(directory: string): TraceFile[] {
  if (!existsSync(directory)) return [];
  validateDirectory(directory);
  const files: TraceFile[] = [];
  for (const name of readdirSync(directory)) {
    const traceMatch = TRACE_FILE_PATTERN.exec(name);
    if (!traceMatch && !FEEDBACK_FILE_PATTERN.test(name)) continue;
    const path = join(directory, name);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== PRIVATE_FILE_MODE) {
      throw new Error("Trace inputs must be private regular files with mode 0600");
    }
    files.push({ path, runId: traceMatch?.[1], size: stat.size, mtimeMs: stat.mtimeMs });
  }
  return files.sort((left, right) => {
    const leftFeedback = left.runId === undefined ? 1 : 0;
    const rightFeedback = right.runId === undefined ? 1 : 0;
    return leftFeedback - rightFeedback || left.path.localeCompare(right.path);
  });
}

function sizeBucket(bytes: number): string {
  if (bytes < 1_024) return "<1KiB";
  if (bytes < 4_096) return "1-4KiB";
  if (bytes < 16_384) return "4-16KiB";
  if (bytes < 65_536) return "16-64KiB";
  return "64KiB+";
}

export interface TraceRunSummary {
  runId: string;
  segments: number;
  sizeBucket: string;
}

export function listTraceRuns(config: TelemetryConfig): TraceRunSummary[] {
  const grouped = new Map<string, { segments: number; bytes: number }>();
  for (const file of traceFiles(config.directory)) {
    if (!file.runId) continue;
    const current = grouped.get(file.runId) ?? { segments: 0, bytes: 0 };
    current.segments += 1;
    current.bytes += file.size;
    grouped.set(file.runId, current);
  }
  return [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([runId, value]) => ({
    runId,
    segments: value.segments,
    sizeBucket: sizeBucket(value.bytes),
  }));
}

export async function analyzeTraceDirectory(config: TelemetryConfig, runId?: string): Promise<AnalysisReport> {
  if (runId !== undefined && !SAFE_ID.test(runId)) throw new Error("Trace run identifier is invalid");
  return analyzeTelemetryFiles(traceFiles(config.directory).map((file) => file.path), runId ? { runId } : {});
}

function readInstallKey(path: string): Buffer {
  const descriptor = openSync(path, fsConstants.O_RDONLY | requireNoFollow());
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || (stat.mode & 0o777) !== PRIVATE_FILE_MODE || stat.size !== INSTALL_KEY_BYTES) {
      throw new Error("Telemetry install key must be a private 32-byte regular file");
    }
    const key = Buffer.alloc(INSTALL_KEY_BYTES);
    let offset = 0;
    while (offset < key.length) {
      const count = readSync(descriptor, key, offset, key.length - offset, offset);
      if (count === 0) throw new Error("Telemetry install key read was incomplete");
      offset += count;
    }
    return key;
  } finally {
    closeSync(descriptor);
  }
}

function notePseudonym(note: string | undefined, key: Buffer): string | undefined {
  if (note === undefined) return undefined;
  const normalized = note.trim();
  if (normalized.length === 0 || normalized.length > MAX_NOTE_LENGTH || /[\u0000-\u001f\u007f-\u009f]/u.test(normalized)) {
    return undefined;
  }
  if (/(?:bearer\s+|password\s*[:=]|token\s*[:=]|secret\s*[:=]|npm_|sk-|eyJ[A-Za-z0-9_-]+\.)/iu.test(normalized)) {
    return undefined;
  }
  return createHmac("sha256", key).update("feedback_note\0").update(normalized).digest("base64url").slice(0, 22);
}

function writeAll(descriptor: number, data: Buffer): void {
  let offset = 0;
  while (offset < data.length) {
    const written = writeSync(descriptor, data, offset, data.length - offset, null);
    if (written <= 0) throw new Error("Telemetry write made no progress");
    offset += written;
  }
}

function syncDirectory(directory: string): void {
  const descriptor = openSync(directory, fsConstants.O_RDONLY | requireNoFollow());
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function dateStamp(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10).replaceAll("-", "");
}

export interface AnnotateTraceOptions {
  runId: string;
  callId: string;
  label: FeedbackLabel;
  note?: string;
}

export interface TraceCommandRuntime {
  now(): number;
  randomUUID(): string;
}

export function annotateTrace(
  config: TelemetryConfig,
  options: AnnotateTraceOptions,
  runtime: TraceCommandRuntime = { now: Date.now, randomUUID: cryptoRandomUUID },
): { noteStored: boolean } {
  const directoryIdentity = validateDirectory(config.directory);
  if (!SAFE_ID.test(options.runId) || !SAFE_ID.test(options.callId)) throw new Error("Feedback target is invalid");
  if (!FEEDBACK_LABELS.includes(options.label)) throw new Error("Feedback label is invalid");
  const key = readInstallKey(config.keyPath);
  const timestamp = runtime.now();
  const eventId = runtime.randomUUID();
  if (!SAFE_ID.test(eventId)) throw new Error("Feedback event identifier is invalid");
  const pseudonym = notePseudonym(options.note, key);
  const event: FeedbackEvent = {
    schemaVersion: 1,
    type: "feedback",
    eventId,
    runId: options.runId,
    timestamp: new Date(timestamp).toISOString(),
    monotonicOffsetMs: 0,
    targetRunId: options.runId,
    targetCallId: options.callId,
    label: options.label,
    ...(pseudonym ? { notePseudonym: pseudonym } : {}),
  };
  const path = join(config.directory, `feedback-${dateStamp(timestamp)}-${eventId}.jsonl`);
  assertDirectoryIdentity(config.directory, directoryIdentity);
  const descriptor = openSync(
    path,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | requireNoFollow(),
    PRIVATE_FILE_MODE,
  );
  try {
    fchmodSync(descriptor, PRIVATE_FILE_MODE);
    writeAll(descriptor, Buffer.from(`${serializeTelemetryEvent(event)}\n`, "utf8"));
    fsyncSync(descriptor);
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || (stat.mode & 0o777) !== PRIVATE_FILE_MODE) throw new Error("Feedback file is not private");
  } finally {
    closeSync(descriptor);
  }
  assertDirectoryIdentity(config.directory, directoryIdentity);
  syncDirectory(config.directory);
  return { noteStored: pseudonym !== undefined };
}

function diagnosticsClean(diagnostics: AnalysisDiagnostics): boolean {
  return Object.values(diagnostics).every((value) => value === 0);
}

export interface ExportTraceOptions { output: string; runId?: string }

export async function exportTraces(config: TelemetryConfig, options: ExportTraceOptions): Promise<number> {
  if (options.runId !== undefined && !SAFE_ID.test(options.runId)) throw new Error("Trace run identifier is invalid");
  const files = traceFiles(config.directory).map((file) => file.path);
  const output = resolve(options.output);
  const parent = dirname(output);
  const parentIdentity = validateOutputParent(parent);
  const temporary = join(parent, `.${basename(output)}.${cryptoRandomUUID()}.tmp`);
  const descriptor = openSync(
    temporary,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | requireNoFollow(),
    PRIVATE_FILE_MODE,
  );
  let count = 0;
  try {
    fchmodSync(descriptor, PRIVATE_FILE_MODE);
    const diagnostics = await visitTelemetryFiles(files, options.runId ? { runId: options.runId } : {}, (event) => {
      writeAll(descriptor, Buffer.from(`${serializeTelemetryEvent(event)}\n`, "utf8"));
      count += 1;
    });
    if (!diagnosticsClean(diagnostics)) throw new Error("Trace export rejected invalid source events");
    fsyncSync(descriptor);
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || (stat.mode & 0o777) !== PRIVATE_FILE_MODE) throw new Error("Trace export is not private");
    assertOutputParentIdentity(parent, parentIdentity);
    linkSync(temporary, output);
  } finally {
    closeSync(descriptor);
    try { unlinkSync(temporary); } catch { /* private temporary file may already be absent */ }
  }
  assertOutputParentIdentity(parent, parentIdentity);
  syncDirectory(parent);
  return count;
}

export interface PurgeTraceOptions { olderThanDays?: number; now?: number }

export function purgeTraces(config: TelemetryConfig, options: PurgeTraceOptions = {}): number {
  if (!existsSync(config.directory)) return 0;
  const directoryIdentity = validateDirectory(config.directory);
  const ageMs = options.olderThanDays === undefined
    ? config.retentionMs
    : options.olderThanDays * 86_400_000;
  if (!Number.isFinite(ageMs) || ageMs < 0) throw new Error("Purge age must be a non-negative finite number");
  const cutoff = (options.now ?? Date.now()) - ageMs;
  let removed = 0;
  for (const file of traceFiles(config.directory)) {
    if (file.mtimeMs >= cutoff) continue;
    assertDirectoryIdentity(config.directory, directoryIdentity);
    unlinkSync(file.path);
    removed += 1;
  }
  if (removed > 0) {
    assertDirectoryIdentity(config.directory, directoryIdentity);
    syncDirectory(config.directory);
  }
  return removed;
}

export interface TraceCommandDependencies {
  config(options: TelemetryCliOptions): TelemetryConfig;
  stdout(text: string): void;
  now(): number;
  randomUUID(): string;
}

const defaultDependencies: TraceCommandDependencies = {
  config: (options) => parseTelemetryConfig(options),
  stdout: (text) => process.stdout.write(text),
  now: Date.now,
  randomUUID: cryptoRandomUUID,
};

function commandConfig(command: Command, dependencies: TraceCommandDependencies): TelemetryConfig {
  return dependencies.config(command.optsWithGlobals() as TelemetryCliOptions);
}

export function registerTraceCommands(root: Command, overrides: Partial<TraceCommandDependencies> = {}): void {
  const dependencies = { ...defaultDependencies, ...overrides };
  const trace = root.command("trace").description("Inspect private local AI-tool telemetry");

  trace.command("list").option("--json", "Print JSON").action((options: { json?: boolean }, command: Command) => {
    const summaries = listTraceRuns(commandConfig(command, dependencies));
    dependencies.stdout(options.json
      ? `${JSON.stringify(summaries)}\n`
      : `${summaries.map((item) => `${item.runId}  ${item.segments}  ${item.sizeBucket}`).join("\n")}\n`);
  });

  trace.command("analyze")
    .option("--run <id>", "Analyze one run")
    .option("--json", "Print JSON")
    .action(async (options: { run?: string; json?: boolean }, command: Command) => {
      const report = await analyzeTraceDirectory(commandConfig(command, dependencies), options.run);
      dependencies.stdout(options.json ? `${JSON.stringify(report)}\n` : `${formatAnalysisTable(report)}\n`);
    });

  trace.command("annotate")
    .requiredOption("--run <id>", "Target run")
    .requiredOption("--call <id>", "Target call")
    .requiredOption("--label <label>", "mistake, expected, or unclear")
    .option("--note <text>", "Optional local note")
    .action((options: { run: string; call: string; label: string; note?: string }, command: Command) => {
      if (!FEEDBACK_LABELS.includes(options.label as FeedbackLabel)) throw new Error("Feedback label is invalid");
      const result = annotateTrace(commandConfig(command, dependencies), {
        runId: options.run,
        callId: options.call,
        label: options.label as FeedbackLabel,
        note: options.note,
      }, dependencies);
      dependencies.stdout(`${JSON.stringify(result)}\n`);
    });

  trace.command("export")
    .option("--run <id>", "Export one run")
    .requiredOption("--out <file>", "Private output JSONL")
    .action(async (options: { run?: string; out: string }, command: Command) => {
      const exportedEvents = await exportTraces(commandConfig(command, dependencies), {
        output: options.out,
        runId: options.run,
      });
      dependencies.stdout(`${JSON.stringify({ exportedEvents })}\n`);
    });

  trace.command("purge")
    .option("--older-than-days <days>", "Delete older trace files", Number)
    .action((options: { olderThanDays?: number }, command: Command) => {
      const removedFiles = purgeTraces(commandConfig(command, dependencies), {
        olderThanDays: options.olderThanDays,
        now: dependencies.now(),
      });
      dependencies.stdout(`${JSON.stringify({ removedFiles })}\n`);
    });
}
