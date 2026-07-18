import { closeSync, constants, createReadStream, fstatSync, lstatSync, openSync } from "node:fs";
import { join, parse, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";

import { serializeTelemetryEvent } from "./writer.js";
import type {
  ExtensionSummaryEvent,
  FeedbackEvent,
  SanitizedArgumentSummary,
  TelemetryErrorCategory,
  TelemetryEvent,
  ToolStartedEvent,
} from "./types.js";

export const ANALYSIS_CLASSIFICATIONS = [
  "exact_repeat",
  "unchanged_repeat",
  "error_retry",
  "semantic_repeat",
  "timeout_retry",
  "oscillation",
  "stale_reference_repeat",
  "recovery",
  "possible_noop",
] as const;

export type AnalysisClassification = (typeof ANALYSIS_CLASSIFICATIONS)[number];
export type FindingConfidence = "suspected" | "confirmed";

const MAX_CALL_WINDOW = 16;
const RECOVERY_WINDOW = 5;
const MAX_SESSION_PARTITIONS = 4_096;
const MAX_TRACE_OWNERS = 65_536;
const MAX_FEEDBACK = 10_000;
const MAX_FINDINGS = 10_000;
const MAX_JSONL_LINE_BYTES = 64 * 1024;

export interface AnalysisFinding {
  classification: AnalysisClassification;
  confidence: FindingConfidence;
  runId: string;
  sessionPseudonym: string;
  traceId: string;
  rootCallId: string;
  argumentFingerprint: string;
  feedbackLabel?: "mistake" | "expected" | "unclear";
  suppressed?: boolean;
}

export interface AnalysisDiagnostics {
  malformedInteriorLines: number;
  unknownSchemaVersions: number;
  crossPartitionCollisions: number;
  truncatedFinalLines: number;
  rejectedEvents: number;
  oversizedLines: number;
  evictedPartitions: number;
  evictedTraceOwners: number;
  droppedFindings: number;
}

export interface AnalysisReport {
  schemaVersion: 1;
  /** Total unsuppressed detections; bounded finding details may be fewer. */
  counts: Record<AnalysisClassification, number>;
  findings: AnalysisFinding[];
  diagnostics: AnalysisDiagnostics;
}

interface CallState {
  runId: string;
  sessionPseudonym: string;
  traceId: string;
  rootCallId: string;
  argumentFingerprint: string;
  argumentPseudonyms: Set<string>;
  toolName: string;
  findings: Set<AnalysisClassification>;
  outcome?: "success" | "failed";
  errorCategory?: TelemetryErrorCategory;
  stateChanged?: boolean;
}

interface SessionState { calls: CallState[] }

function emptyCounts(): Record<AnalysisClassification, number> {
  return {
    exact_repeat: 0, unchanged_repeat: 0, error_retry: 0, semantic_repeat: 0,
    timeout_retry: 0, oscillation: 0, stale_reference_repeat: 0, recovery: 0,
    possible_noop: 0,
  };
}

function emptyDiagnostics(): AnalysisDiagnostics {
  return {
    malformedInteriorLines: 0, unknownSchemaVersions: 0,
    crossPartitionCollisions: 0, truncatedFinalLines: 0, rejectedEvents: 0,
    oversizedLines: 0, evictedPartitions: 0, evictedTraceOwners: 0, droppedFindings: 0,
  };
}

function hasCorrelatedIdentity(event: TelemetryEvent): event is TelemetryEvent & {
  sessionPseudonym: string;
  traceId: string;
  rootCallId: string;
} {
  return "sessionPseudonym" in event && "traceId" in event && "rootCallId" in event;
}

class AnalyzerState {
  readonly findings: AnalysisFinding[] = [];
  readonly diagnostics = emptyDiagnostics();
  private readonly sessions = new Map<string, SessionState>();
  private readonly calls = new Map<string, CallState>();
  private readonly traceOwners = new Map<string, string>();
  private readonly collisionOwners = new Set<string>();
  private readonly feedback = new Map<string, FeedbackEvent["label"]>();
  private readonly counts = emptyCounts();

  consume(event: TelemetryEvent): void {
    if (event.type === "feedback") {
      if (this.feedback.size >= MAX_FEEDBACK && !this.feedback.has(`${event.targetRunId}|${event.targetCallId}`)) {
        const oldest = this.feedback.keys().next().value as string | undefined;
        if (oldest) this.feedback.delete(oldest);
      }
      this.feedback.set(`${event.targetRunId}|${event.targetCallId}`, event.label);
      return;
    }
    if (hasCorrelatedIdentity(event)) this.observeTraceOwner(event);
    switch (event.type) {
      case "tool_started": this.startCall(event); break;
      case "tool_completed": this.completeCall(event, "success"); break;
      case "tool_failed": this.completeCall(event, "failed", event.errorCategory); break;
      case "extension_summary": this.applyExtensionSummary(event); break;
      default: break;
    }
  }

  finish(): AnalysisReport {
    const counts = { ...this.counts };
    for (const finding of this.findings) {
      const label = this.feedback.get(`${finding.runId}|${finding.rootCallId}`);
      if (label !== undefined) {
        finding.feedbackLabel = label;
        if (label === "expected") {
          finding.suppressed = true;
          counts[finding.classification] = Math.max(0, counts[finding.classification] - 1);
        }
        if (label === "mistake") finding.confidence = "confirmed";
      }
    }
    return { schemaVersion: 1, counts, findings: this.findings, diagnostics: this.diagnostics };
  }

  private observeTraceOwner(event: TelemetryEvent & { sessionPseudonym: string; traceId: string }): void {
    const owner = `${event.runId}|${event.sessionPseudonym}`;
    const prior = this.traceOwners.get(event.traceId);
    if (prior === undefined) {
      if (this.traceOwners.size >= MAX_TRACE_OWNERS) {
        const oldest = this.traceOwners.keys().next().value as string | undefined;
        if (oldest) this.traceOwners.delete(oldest);
        this.diagnostics.evictedTraceOwners += 1;
      }
      this.traceOwners.set(event.traceId, owner);
    }
    else if (prior !== owner) {
      const collision = `${event.traceId}|${owner}`;
      if (!this.collisionOwners.has(collision)) {
        if (this.collisionOwners.size >= MAX_TRACE_OWNERS) {
          const oldest = this.collisionOwners.values().next().value as string | undefined;
          if (oldest) this.collisionOwners.delete(oldest);
        }
        this.collisionOwners.add(collision);
        this.diagnostics.crossPartitionCollisions += 1;
      }
    }
  }

  private startCall(event: ToolStartedEvent): void {
    const key = this.callKey(event.runId, event.sessionPseudonym, event.traceId);
    const sessionKey = `${event.runId}|${event.sessionPseudonym}`;
    let session = this.sessions.get(sessionKey);
    if (!session) {
      if (this.sessions.size >= MAX_SESSION_PARTITIONS) {
        const oldestEntry = this.sessions.entries().next().value as [string, SessionState] | undefined;
        if (oldestEntry) {
          this.sessions.delete(oldestEntry[0]);
          for (const oldCall of oldestEntry[1].calls) {
            this.calls.delete(this.callKey(oldCall.runId, oldCall.sessionPseudonym, oldCall.traceId));
          }
          this.diagnostics.evictedPartitions += 1;
        }
      }
      session = { calls: [] };
      this.sessions.set(sessionKey, session);
    }
    const call: CallState = {
      runId: event.runId,
      sessionPseudonym: event.sessionPseudonym,
      traceId: event.traceId,
      rootCallId: event.rootCallId,
      argumentFingerprint: event.argumentFingerprint,
      argumentPseudonyms: this.argumentPseudonyms(event.arguments),
      toolName: event.toolName,
      findings: new Set(),
    };
    const previous = session.calls.at(-1);
    session.calls.push(call);
    this.calls.set(key, call);
    while (session.calls.length > MAX_CALL_WINDOW) {
      const removed = session.calls.shift();
      if (removed) this.calls.delete(this.callKey(removed.runId, removed.sessionPseudonym, removed.traceId));
    }

    if (previous?.argumentFingerprint === call.argumentFingerprint) {
      this.addFinding("exact_repeat", "suspected", call);
      if (previous.outcome === "failed") this.addFinding("error_retry", "confirmed", call);
      if (previous.errorCategory === "timeout") this.addFinding("timeout_retry", "confirmed", call);
      if (previous.stateChanged === false) this.addFinding("unchanged_repeat", "confirmed", call);
      if (
        previous.errorCategory === "tab_not_found"
        && this.overlaps(previous.argumentPseudonyms, call.argumentPseudonyms)
      ) this.addFinding("stale_reference_repeat", "confirmed", call);
    }
    else if (
      previous
      && previous.toolName === call.toolName
      && this.samePseudonyms(previous.argumentPseudonyms, call.argumentPseudonyms)
    ) {
      this.addFinding("semantic_repeat", "suspected", call);
    }
    const lastFour = session.calls.slice(-4).map((entry) => entry.argumentFingerprint);
    if (
      lastFour.length === 4
      && lastFour[0] === lastFour[2]
      && lastFour[1] === lastFour[3]
      && lastFour[0] !== lastFour[1]
    ) this.addFinding("oscillation", "suspected", call);
  }

  private completeCall(
    event: TelemetryEvent & { traceId: string; sessionPseudonym: string },
    outcome: "success" | "failed",
    errorCategory?: TelemetryErrorCategory,
  ): void {
    const call = this.calls.get(this.callKey(event.runId, event.sessionPseudonym, event.traceId));
    if (!call) return;
    call.outcome = outcome;
    call.errorCategory = errorCategory;
    if (event.type === "tool_completed" && event.stateChanged !== undefined) {
      call.stateChanged = event.stateChanged;
    }
    if (outcome === "success" && call.stateChanged === false) {
      this.addFinding("possible_noop", "confirmed", call);
    }
    if (outcome !== "success" || call.stateChanged !== true) return;

    const session = this.sessions.get(`${call.runId}|${call.sessionPseudonym}`);
    if (!session) return;
    const index = session.calls.indexOf(call);
    const prior = session.calls.slice(Math.max(0, index - RECOVERY_WINDOW), index).reverse().find(
      (candidate) => candidate.outcome === "failed"
        && candidate.argumentFingerprint !== call.argumentFingerprint,
    );
    if (prior) this.addFinding("recovery", "confirmed", call);
  }
  private applyExtensionSummary(event: ExtensionSummaryEvent): void {
    const call = this.calls.get(this.callKey(event.runId, event.sessionPseudonym, event.traceId));
    if (!call) return;
    const signals = event as ExtensionSummaryEvent & Partial<Record<
      "tabChanged" | "originChanged" | "pathChanged" | "loadStatusChanged",
      boolean
    >>;
    const values = [signals.tabChanged, signals.originChanged, signals.pathChanged, signals.loadStatusChanged]
      .filter((value): value is boolean => value !== undefined);
    if (values.length > 0) call.stateChanged = values.some(Boolean);
    if (event.errorCategory !== undefined) call.errorCategory = event.errorCategory;
    if (call.outcome === "success" && call.stateChanged === false) {
      this.addFinding("possible_noop", "confirmed", call);
    }
  }

  private addFinding(
    classification: AnalysisClassification,
    confidence: FindingConfidence,
    call: CallState,
  ): void {
    if (call.findings.has(classification)) return;
    call.findings.add(classification);
    this.counts[classification] += 1;
    if (this.findings.length >= MAX_FINDINGS) {
      this.diagnostics.droppedFindings += 1;
      return;
    }
    this.findings.push({
      classification,
      confidence,
      runId: call.runId,
      sessionPseudonym: call.sessionPseudonym,
      traceId: call.traceId,
      rootCallId: call.rootCallId,
      argumentFingerprint: call.argumentFingerprint,
    });
  }

  private argumentPseudonyms(summary?: SanitizedArgumentSummary): Set<string> {
    if (!summary) return new Set();
    return new Set(Object.values(summary.pseudonyms));
  }

  private overlaps(left: Set<string>, right: Set<string>): boolean {
    for (const value of left) if (right.has(value)) return true;
    return false;
  }
  private samePseudonyms(left: Set<string>, right: Set<string>): boolean {
    if (left.size === 0 || left.size !== right.size) return false;
    for (const value of left) if (!right.has(value)) return false;
    return true;
  }
  private callKey(runId: string, sessionPseudonym: string, traceId: string): string {
    return `${runId}|${sessionPseudonym}|${traceId}`;
  }
}

export function analyzeTelemetryEvents(events: Iterable<TelemetryEvent>): AnalysisReport {
  const state = new AnalyzerState();
  for (const event of events) state.consume(event);
  return state.finish();
}

function ownSchemaVersion(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, "schemaVersion");
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function consumeParsedValue(state: AnalyzerState, value: unknown): void {
  const version = ownSchemaVersion(value);
  if (version === undefined) {
    state.diagnostics.rejectedEvents += 1;
    return;
  }
  if (version !== 1) {
    state.diagnostics.unknownSchemaVersions += 1;
    return;
  }
  try {
    const canonical = serializeTelemetryEvent(value as TelemetryEvent);
    state.consume(JSON.parse(canonical) as TelemetryEvent);
  } catch {
    state.diagnostics.rejectedEvents += 1;
  }
}

export function analyzeTelemetryJsonlText(text: string): AnalysisReport {
  const state = new AnalyzerState();
  const endsWithNewline = text.endsWith("\n");
  const lines = text.split("\n");
  if (endsWithNewline) lines.pop();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    try {
      consumeParsedValue(state, JSON.parse(line) as unknown);
    } catch {
      const finalUnterminated = index === lines.length - 1 && !endsWithNewline;
      if (finalUnterminated) state.diagnostics.truncatedFinalLines += 1;
      else state.diagnostics.malformedInteriorLines += 1;
    }
  }
  return state.finish();
}

export function formatAnalysisTable(report: AnalysisReport): string {
  const rows = ANALYSIS_CLASSIFICATIONS.map((classification) => (
    `${classification.padEnd(24)} ${String(report.counts[classification]).padStart(6)}`
  ));
  return ["classification             count", ...rows].join("\n");
}

export interface AnalyzeTelemetryFilesOptions {
  runId?: string;
}

function consumeJsonLine(
  state: AnalyzerState,
  line: string,
  finalUnterminated: boolean,
  options: AnalyzeTelemetryFilesOptions,
  onEvent: (event: TelemetryEvent) => void,
): void {
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch {
    if (finalUnterminated) state.diagnostics.truncatedFinalLines += 1;
    else state.diagnostics.malformedInteriorLines += 1;
    return;
  }
  const version = ownSchemaVersion(value);
  if (version !== undefined && version !== 1) {
    state.diagnostics.unknownSchemaVersions += 1;
    return;
  }
  if (version === undefined) {
    state.diagnostics.rejectedEvents += 1;
    return;
  }
  try {
    const event = JSON.parse(serializeTelemetryEvent(value as TelemetryEvent)) as TelemetryEvent;
    if (options.runId !== undefined) {
      if (event.type === "feedback") {
        if (event.targetRunId !== options.runId) return;
      } else if (event.runId !== options.runId) return;
    }
    onEvent(event);
  } catch {
    state.diagnostics.rejectedEvents += 1;
  }
}

function assertNoSymlinkAncestors(path: string): void {
  const absolute = resolve(path);
  const parsed = parse(absolute);
  let current = parsed.root;
  for (const segment of absolute.slice(parsed.root.length).split(/[\\/]+/u).filter(Boolean)) {
    current = join(current, segment);
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error("Trace input path contains a symbolic link");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") break;
      throw error;
    }
  }
}

async function consumeTelemetryFile(
  state: AnalyzerState,
  filePath: string,
  options: AnalyzeTelemetryFilesOptions,
  onEvent: (event: TelemetryEvent) => void,
): Promise<void> {
  assertNoSymlinkAncestors(filePath);
  const noFollow = constants.O_NOFOLLOW;
  if (typeof noFollow !== "number" || noFollow === 0) {
    throw new Error("O_NOFOLLOW is required for trace analysis");
  }
  const descriptor = openSync(filePath, constants.O_RDONLY | noFollow);
  const stat = fstatSync(descriptor);
  if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) {
    closeSync(descriptor);
    throw new Error("Trace input must be a private regular file with mode 0600");
  }

  const decoder = new StringDecoder("utf8");
  const stream = createReadStream(filePath, { fd: descriptor, autoClose: true });
  let buffer = "";
  let bufferBytes = 0;
  let discarding = false;

  const append = (piece: string, terminated: boolean): void => {
    if (discarding) {
      if (terminated) {
        discarding = false;
        state.diagnostics.oversizedLines += 1;
      }
      return;
    }
    const pieceBytes = Buffer.byteLength(piece, "utf8");
    if (bufferBytes + pieceBytes > MAX_JSONL_LINE_BYTES) {
      buffer = "";
      bufferBytes = 0;
      if (terminated) state.diagnostics.oversizedLines += 1;
      else discarding = true;
      return;
    }
    buffer += piece;
    bufferBytes += pieceBytes;
    if (terminated) {
      consumeJsonLine(
        state,
        buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer,
        false,
        options,
        onEvent,
      );
      buffer = "";
      bufferBytes = 0;
    }
  };

  for await (const chunk of stream) {
    const text = decoder.write(chunk as Buffer);
    let start = 0;
    let newline = text.indexOf("\n", start);
    while (newline >= 0) {
      append(text.slice(start, newline), true);
      start = newline + 1;
      newline = text.indexOf("\n", start);
    }
    append(text.slice(start), false);
  }
  append(decoder.end(), false);
  if (discarding) state.diagnostics.oversizedLines += 1;
  else if (buffer.length > 0) consumeJsonLine(state, buffer, true, options, onEvent);
}

export async function analyzeTelemetryFiles(
  filePaths: readonly string[],
  options: AnalyzeTelemetryFilesOptions = {},
): Promise<AnalysisReport> {
  const state = new AnalyzerState();
  for (const filePath of filePaths) {
    await consumeTelemetryFile(state, filePath, options, (event) => state.consume(event));
  }
  return state.finish();
}

export async function visitTelemetryFiles(
  filePaths: readonly string[],
  options: AnalyzeTelemetryFilesOptions,
  visitor: (event: TelemetryEvent) => void,
): Promise<AnalysisDiagnostics> {
  const state = new AnalyzerState();
  for (const filePath of filePaths) {
    await consumeTelemetryFile(state, filePath, options, visitor);
  }
  return state.diagnostics;
}
