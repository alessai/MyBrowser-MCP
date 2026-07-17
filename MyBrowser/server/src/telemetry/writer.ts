import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  fsync as fsyncCallback,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  unlinkSync,
  write as writeCallback,
  writeSync,
  type Stats,
} from "node:fs";
import { parse, resolve, join } from "node:path";

import type {
  SanitizedArgumentSummary,
  TelemetryConfig,
  TelemetryEvent,
  TelemetryEventType,
  WriterHealthEvent,
} from "./types.js";

const DEFAULT_FLUSH_BATCH_SIZE = 64;
const DEFAULT_FLUSH_INTERVAL_MS = 1_000;
const DEFAULT_MAX_QUEUE_EVENTS = 1_024;
const PRUNE_INTERVAL_MS = 5 * 60 * 1_000;
const MIN_SOFT_RETENTION_MS = 24 * 60 * 60 * 1_000;
const MAX_REPORTED_DROPS = 2_147_483_647;
const TRACE_FILE_PATTERN = /^trace-\d{8}-[A-Za-z0-9_-]{1,128}-\d{4}\.jsonl$/u;
const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;
const TERMINAL_EVENT_TYPES = new Set<TelemetryEvent["type"]>([
  "run_stopped",
  "tool_completed",
  "tool_failed",
  "transport_completed",
  "transport_failed",
]);
const BASE_FIELDS = ["schemaVersion", "eventId", "runId", "type", "timestamp", "monotonicOffsetMs"] as const;
const CORRELATION_FIELDS = ["sessionPseudonym", "traceId", "rootCallId"] as const;
const EVENT_FIELDS: Readonly<Record<TelemetryEventType, readonly string[]>> = Object.freeze({
  run_started: [...BASE_FIELDS, "processRole"],
  run_stopped: [...BASE_FIELDS, "reason", "droppedEvents"],
  tools_listed: [
    ...BASE_FIELDS,
    "clientName",
    "clientVersion",
    "clientSupportsSampling",
    "clientSupportsRoots",
    "clientSupportsElicitation",
    "toolCount",
    "schemaDigest",
  ],
  tool_started: [
    ...BASE_FIELDS,
    ...CORRELATION_FIELDS,
    "toolName",
    "argumentFingerprint",
    "arguments",
    "sanitizerFailed",
  ],
  tool_completed: [...BASE_FIELDS, ...CORRELATION_FIELDS, "toolName", "durationMs", "status", "stateChanged"],
  tool_failed: [...BASE_FIELDS, ...CORRELATION_FIELDS, "toolName", "durationMs", "status", "errorCategory"],
  transport_started: [
    ...BASE_FIELDS,
    ...CORRELATION_FIELDS,
    "transportSpanId",
    "action",
    "browserPseudonym",
  ],
  transport_completed: [
    ...BASE_FIELDS,
    ...CORRELATION_FIELDS,
    "transportSpanId",
    "durationMs",
    "responseSizeBucket",
    "resultPresent",
  ],
  transport_failed: [
    ...BASE_FIELDS,
    ...CORRELATION_FIELDS,
    "transportSpanId",
    "durationMs",
    "errorCategory",
  ],
  extension_summary: [
    ...BASE_FIELDS,
    ...CORRELATION_FIELDS,
    "transportSpanId",
    "routeMode",
    "extensionRequestPseudonym",
    "resolvedTabPseudonym",
    "offscreenReceivedToBackgroundMs",
    "queueWaitMs",
    "handlerMs",
    "responseSerializeMs",
    "errorCategory",
  ],
  telemetry_integrity: [
    ...BASE_FIELDS,
    ...CORRELATION_FIELDS,
    "transportSpanId",
    "reason",
    "sizeBucket",
  ],
  feedback: [...BASE_FIELDS, "targetRunId", "targetCallId", "label", "notePseudonym"],
  writer_health: [...BASE_FIELDS, "state", "reason", "droppedEvents"],
});
const OPTIONAL_FIELDS: Readonly<Record<TelemetryEventType, readonly string[]>> = Object.freeze({
  run_started: [],
  run_stopped: [],
  tools_listed: [
    "clientName",
    "clientVersion",
    "clientSupportsSampling",
    "clientSupportsRoots",
    "clientSupportsElicitation",
  ],
  tool_started: ["arguments", "sanitizerFailed"],
  tool_completed: ["stateChanged"],
  tool_failed: [],
  transport_started: ["browserPseudonym"],
  transport_completed: [],
  transport_failed: [],
  extension_summary: [
    "resolvedTabPseudonym",
    "offscreenReceivedToBackgroundMs",
    "queueWaitMs",
    "handlerMs",
    "responseSerializeMs",
    "errorCategory",
  ],
  telemetry_integrity: [],
  feedback: ["notePseudonym"],
  writer_health: [],
});
const TELEMETRY_ERROR_CATEGORIES = new Set([
  "invalid_arguments",
  "authorization_denied",
  "ownership_denied",
  "not_connected",
  "browser_not_found",
  "tab_not_found",
  "element_not_found",
  "timeout",
  "request_expired",
  "queue_overloaded",
  "session_closed",
  "worker_restarted",
  "protocol_error",
  "extension_tool_failed",
  "tool_request_failed",
  "storage_failure",
  "internal_failure",
  "unknown",
]);
const SAFE_FIELD_NAME = /^[A-Za-z0-9_.-]{1,128}$/u;
const SAFE_IDENTIFIER = /^[A-Za-z0-9_:-]{1,128}$/u;
const SAFE_PSEUDONYM = /^[A-Za-z0-9_-]{8,64}$/u;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;

export type WriterDropReason = WriterHealthEvent["reason"];
export type WriterHealthFactory = (
  reason: WriterDropReason,
  droppedEvents: number,
) => WriterHealthEvent;

export interface TelemetryWriterDiagnostic {
  code: "TELEMETRY_WRITER_DISABLED";
  reason: "filesystem" | "serialization";
}

export interface TelemetryFileOps {
  mkdirSync: typeof mkdirSync;
  chmodSync: typeof chmodSync;
  lstatSync: typeof lstatSync;
  linkSync: typeof linkSync;
  openSync: typeof openSync;
  fchmodSync: typeof fchmodSync;
  fstatSync: typeof fstatSync;
  fsyncSync: typeof fsyncSync;
  closeSync: typeof closeSync;
  readSync: typeof readSync;
  writeSync: typeof writeSync;
  readdirSync: typeof readdirSync;
  unlinkSync: typeof unlinkSync;
}

const DEFAULT_FILE_OPS: TelemetryFileOps = {
  mkdirSync,
  chmodSync,
  lstatSync,
  linkSync,
  openSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  closeSync,
  readSync,
  writeSync,
  readdirSync,
  unlinkSync,
};

interface QueuedLine {
  line: string;
  data: Buffer;
  bytes: number;
  terminal: boolean;
}

export interface TelemetryAsyncFileOps {
  write(fd: number, data: Buffer): Promise<void>;
  fsync(fd: number): Promise<void>;
}

const DEFAULT_ASYNC_FILE_OPS: TelemetryAsyncFileOps = {
  write: (fd, data) =>
    new Promise<void>((resolveWrite, rejectWrite) => {
      let offset = 0;
      const writeNext = (): void => {
        writeCallback(fd, data, offset, data.length - offset, null, (error, bytesWritten) => {
          if (error) {
            rejectWrite(error);
            return;
          }
          if (bytesWritten <= 0) {
            rejectWrite(new Error("Telemetry write made no progress"));
            return;
          }
          offset += bytesWritten;
          if (offset >= data.length) resolveWrite();
          else writeNext();
        });
      };
      writeNext();
    }),
  fsync: (fd) =>
    new Promise<void>((resolveSync, rejectSync) => {
      fsyncCallback(fd, (error) => {
        if (error) rejectSync(error);
        else resolveSync();
      });
    }),
};

function ownDataDescriptors(value: unknown): Record<string, PropertyDescriptor> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Telemetry value must be a plain object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("Telemetry value must have a plain prototype");
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) throw new Error("Telemetry values cannot contain symbol keys");
  const result: Record<string, PropertyDescriptor> = Object.create(null);
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new Error("Telemetry values must contain enumerable data properties only");
    }
    result[key] = descriptor;
  }
  return result;
}

function cloneSafeScalarRecord(
  value: unknown,
  valueKind: "scalar" | "count" | "pseudonym",
): Record<string, boolean | number | string> {
  const descriptors = ownDataDescriptors(value);
  const result: Record<string, boolean | number | string> = Object.create(null);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!SAFE_FIELD_NAME.test(key)) throw new Error("Telemetry summary contains an invalid field name");
    const fieldValue = descriptor.value;
    if (valueKind === "count") {
      if (!Number.isSafeInteger(fieldValue) || fieldValue < 0) throw new Error("Telemetry count is invalid");
    } else if (valueKind === "pseudonym") {
      if (typeof fieldValue !== "string" || !SAFE_PSEUDONYM.test(fieldValue)) {
        throw new Error("Telemetry pseudonym is invalid");
      }
    } else if (
      !(
        typeof fieldValue === "boolean" ||
        (typeof fieldValue === "number" && Number.isFinite(fieldValue)) ||
        (typeof fieldValue === "string" && fieldValue.length <= 2_048 && !CONTROL_CHARACTERS.test(fieldValue))
      )
    ) {
      throw new Error("Telemetry scalar is invalid");
    }
    result[key] = fieldValue as boolean | number | string;
  }
  return result;
}

function clonePresence(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 256) throw new Error("Telemetry presence list is invalid");
  const result: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "string") {
      throw new Error("Telemetry presence list contains a non-data value");
    }
    if (!SAFE_FIELD_NAME.test(descriptor.value)) throw new Error("Telemetry presence field is invalid");
    result.push(descriptor.value);
  }
  const allowedKeys = new Set(["length", ...result.map((_, index) => String(index))]);
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string" || !allowedKeys.has(key))) {
    throw new Error("Telemetry presence list contains custom properties");
  }
  return result;
}

function cloneSanitizedArguments(value: unknown): SanitizedArgumentSummary {
  const descriptors = ownDataDescriptors(value);
  const expected = new Set(["scalar", "presence", "counts", "pseudonyms", "droppedFields", "truncated"]);
  if (Object.keys(descriptors).some((key) => !expected.has(key)) || Object.keys(descriptors).length !== expected.size) {
    throw new Error("Telemetry argument summary shape is invalid");
  }
  const droppedFields = descriptors.droppedFields?.value;
  const truncated = descriptors.truncated?.value;
  if (!Number.isSafeInteger(droppedFields) || droppedFields < 0 || typeof truncated !== "boolean") {
    throw new Error("Telemetry argument summary bounds are invalid");
  }
  return Object.freeze({
    scalar: Object.freeze(cloneSafeScalarRecord(descriptors.scalar?.value, "scalar")),
    presence: Object.freeze(clonePresence(descriptors.presence?.value)),
    counts: Object.freeze(cloneSafeScalarRecord(descriptors.counts?.value, "count") as Record<string, number>),
    pseudonyms: Object.freeze(
      cloneSafeScalarRecord(descriptors.pseudonyms?.value, "pseudonym") as Record<string, string>,
    ),
    droppedFields,
    truncated,
  }) as SanitizedArgumentSummary;
}

function validateEnum(type: TelemetryEventType, key: string, value: unknown): void {
  const accepted =
    key === "errorCategory"
      ? TELEMETRY_ERROR_CATEGORIES
      : type === "run_started" && key === "processRole"
        ? new Set(["client"])
        : type === "run_stopped" && key === "reason"
          ? new Set(["shutdown", "stdin_closed", "signal", "unknown"])
          : key === "status"
            ? type === "tool_completed"
              ? new Set(["success"])
              : new Set(["error", "timeout", "cancelled", "unknown"])
            : type === "extension_summary" && key === "routeMode"
              ? new Set(["direct", "hub"])
              : type === "telemetry_integrity" && key === "reason"
                ? new Set(["malformed", "oversized", "mismatched_trace", "unsupported_version"])
                : type === "feedback" && key === "label"
                  ? new Set(["mistake", "expected", "unclear"])
                  : type === "writer_health" && key === "state"
                    ? new Set(["dropping", "disabled", "recovered"])
                    : type === "writer_health" && key === "reason"
                      ? new Set(["queue_full", "event_oversized", "filesystem", "serialization"])
                      : undefined;
  if (accepted && (typeof value !== "string" || !accepted.has(value))) {
    throw new Error("Telemetry enum value is invalid");
  }
}

function cloneTelemetryEvent(event: TelemetryEvent): Record<string, unknown> {
  const descriptors = ownDataDescriptors(event);
  const type = descriptors.type?.value;
  if (typeof type !== "string" || !(type in EVENT_FIELDS)) throw new Error("Telemetry event type is invalid");
  const eventType = type as TelemetryEventType;
  const allowed = new Set(EVENT_FIELDS[eventType]);
  const optional = new Set(OPTIONAL_FIELDS[eventType]);
  if (Object.keys(descriptors).some((key) => !allowed.has(key))) {
    throw new Error("Telemetry event contains an unknown field");
  }
  for (const field of allowed) {
    if (!optional.has(field) && !(field in descriptors)) throw new Error("Telemetry event is missing a required field");
  }

  const result: Record<string, unknown> = Object.create(null);
  for (const field of EVENT_FIELDS[eventType]) {
    const descriptor = descriptors[field];
    if (!descriptor) continue;
    const value = descriptor.value;
    if (field === "arguments") {
      result[field] = cloneSanitizedArguments(value);
      continue;
    }
    if (field === "schemaVersion") {
      if (value !== 1) throw new Error("Telemetry schema version is invalid");
    } else if (typeof value === "number") {
      if (!Number.isFinite(value) || value < 0) throw new Error("Telemetry numeric field is invalid");
    } else if (typeof value === "string") {
      if (value.length === 0 || value.length > 2_048 || CONTROL_CHARACTERS.test(value)) {
        throw new Error("Telemetry string field is invalid");
      }
      if (
        (field.endsWith("Pseudonym") || field === "notePseudonym" || field === "argumentFingerprint")
        && !SAFE_PSEUDONYM.test(value)
      ) {
        throw new Error("Telemetry pseudonym field is invalid");
      }
      if (["eventId", "runId", "traceId", "rootCallId", "transportSpanId", "targetRunId", "targetCallId"].includes(field)) {
        if (!SAFE_IDENTIFIER.test(value)) throw new Error("Telemetry identifier is invalid");
      }
      if ((field === "toolName" || field === "action") && !SAFE_IDENTIFIER.test(value)) {
        throw new Error("Telemetry action name is invalid");
      }
    } else if (typeof value !== "boolean") {
      throw new Error("Telemetry event contains a non-primitive field");
    }
    validateEnum(eventType, field, value);
    result[field] = value;
  }
  return result;
}

export function serializeTelemetryEvent(event: TelemetryEvent): string {
  return JSON.stringify(cloneTelemetryEvent(event));
}

export interface JsonlTelemetryWriterOptions {
  config: TelemetryConfig;
  runId: string;
  now?: () => number;
  flushBatchSize?: number;
  flushIntervalMs?: number;
  maxQueueEvents?: number;
  noFollowFlag?: number | null;
  fileOps?: Partial<TelemetryFileOps>;
  asyncFileOps?: Partial<TelemetryAsyncFileOps>;
  createHealthEvent?: WriterHealthFactory;
  onDiagnostic?: (diagnostic: TelemetryWriterDiagnostic) => void;
}

export interface TelemetryWriterStats {
  queuedEvents: number;
  droppedEvents: number;
  disabled: boolean;
}

function isMissingPath(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function lstatIfPresent(path: string, ops: TelemetryFileOps): Stats | undefined {
  try {
    return ops.lstatSync(path) as Stats;
  } catch (error) {
    if (isMissingPath(error)) return undefined;
    throw error;
  }
}

function sameFilesystemIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

export function assertDescriptorMatchesPath(path: string, descriptorStats: Stats, ops: TelemetryFileOps): void {
  const pathStats = ops.lstatSync(path) as Stats;
  if (pathStats.isSymbolicLink() || !sameFilesystemIdentity(pathStats, descriptorStats)) {
    throw new Error(`Telemetry descriptor identity does not match its path: ${path}`);
  }
}

export function resolveTelemetryNoFollow(value: number | null | undefined): number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new Error("Telemetry storage requires no-follow filesystem semantics");
  }
  return value as number;
}

export function createTelemetryFileOps(overrides: Partial<TelemetryFileOps> = {}): TelemetryFileOps {
  return { ...DEFAULT_FILE_OPS, ...overrides };
}

function assertNoSymlinkAncestors(path: string, ops: TelemetryFileOps): void {
  const absolute = resolve(path);
  const parsed = parse(absolute);
  let current = parsed.root;
  const segments = absolute.slice(parsed.root.length).split(/[\\/]+/u).filter(Boolean);
  for (const segment of segments) {
    current = join(current, segment);
    const stats = lstatIfPresent(current, ops);
    if (!stats) break;
    if (stats.isSymbolicLink()) {
      throw new Error(`Telemetry storage path contains a symbolic link: ${current}`);
    }
  }
}

function openVerifiedDirectory(path: string, noFollow: number, ops: TelemetryFileOps): number {
  const directoryFlag = typeof fsConstants.O_DIRECTORY === "number" ? fsConstants.O_DIRECTORY : 0;
  const fd = ops.openSync(path, fsConstants.O_RDONLY | directoryFlag | noFollow);
  try {
    ops.fchmodSync(fd, 0o700);
    const stats = ops.fstatSync(fd);
    if (!stats.isDirectory() || (stats.mode & 0o777) !== 0o700) {
      throw new Error("Telemetry directory must be a directory with exact mode 0700");
    }
    assertDescriptorMatchesPath(path, stats as Stats, ops);
    return fd;
  } catch (error) {
    ops.closeSync(fd);
    throw error;
  }
}

export function ensurePrivateTelemetryDirectory(
  directory: string,
  noFollow: number,
  ops: TelemetryFileOps,
): void {
  assertNoSymlinkAncestors(directory, ops);
  ops.mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertNoSymlinkAncestors(directory, ops);
  const pathStats = ops.lstatSync(directory);
  if (pathStats.isSymbolicLink()) throw new Error("Telemetry directory cannot be a symbolic link");
  if (!pathStats.isDirectory()) throw new Error("Telemetry storage path is not a directory");
  ops.chmodSync(directory, 0o700);

  const fd = openVerifiedDirectory(directory, noFollow, ops);
  try {
    ops.fsyncSync(fd);
  } finally {
    ops.closeSync(fd);
  }
}

export function syncTelemetryDirectory(directory: string, noFollow: number, ops: TelemetryFileOps): void {
  const fd = openVerifiedDirectory(directory, noFollow, ops);
  try {
    ops.fsyncSync(fd);
  } finally {
    ops.closeSync(fd);
  }
}

function validateRegularPrivateFile(path: string, ops: TelemetryFileOps): Stats {
  const stats = ops.lstatSync(path) as Stats;
  if (stats.isSymbolicLink()) throw new Error(`Telemetry file cannot be a symbolic link: ${path}`);
  if (!stats.isFile()) throw new Error(`Telemetry artifact is not a regular file: ${path}`);
  if ((stats.mode & 0o777) !== 0o600) {
    throw new Error(`Telemetry file must have exact mode 0600: ${path}`);
  }
  return stats;
}

export function telemetrySegmentName(now: number, runId: string, segment: number): string {
  if (!RUN_ID_PATTERN.test(runId)) throw new Error("Invalid telemetry run identifier");
  if (!Number.isInteger(segment) || segment < 0 || segment > 9_999) {
    throw new Error("Invalid telemetry segment number");
  }
  const day = new Date(now).toISOString().slice(0, 10).replaceAll("-", "");
  return `trace-${day}-${runId}-${String(segment).padStart(4, "0")}.jsonl`;
}

function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export class JsonlTelemetryWriter {
  private readonly config: TelemetryConfig;
  private readonly runId: string;
  private readonly now: () => number;
  private readonly flushBatchSize: number;
  private readonly maxQueueEvents: number;
  private readonly noFollow: number;
  private readonly ops: TelemetryFileOps;
  private readonly asyncOps: TelemetryAsyncFileOps;
  private readonly createHealthEvent?: WriterHealthFactory;
  private readonly onDiagnostic?: (diagnostic: TelemetryWriterDiagnostic) => void;
  private readonly queue: QueuedLine[] = [];
  private readonly pendingDrops = new Map<WriterDropReason, number>();
  private readonly interval: ReturnType<typeof setInterval>;
  private _activePath = "";
  private fd: number;
  private segment = 0;
  private currentBytes = 0;
  private currentDay: string;
  private droppedEvents = 0;
  private disabled = false;
  private closed = false;
  private diagnosticReported = false;
  private lastPruneAt: number;
  private closing = false;
  private drainPromise?: Promise<void>;
  private writerClosePromise?: Promise<void>;

  constructor(options: JsonlTelemetryWriterOptions) {
    this.config = options.config;
    this.runId = options.runId;
    this.now = options.now ?? Date.now;
    this.flushBatchSize = options.flushBatchSize ?? DEFAULT_FLUSH_BATCH_SIZE;
    this.maxQueueEvents = options.maxQueueEvents ?? DEFAULT_MAX_QUEUE_EVENTS;
    this.createHealthEvent = options.createHealthEvent;
    this.onDiagnostic = options.onDiagnostic;
    this.ops = createTelemetryFileOps(options.fileOps);
    this.asyncOps = { ...DEFAULT_ASYNC_FILE_OPS, ...options.asyncFileOps };
    this.noFollow = resolveTelemetryNoFollow(
      options.noFollowFlag === undefined
        ? typeof fsConstants.O_NOFOLLOW === "number"
          ? fsConstants.O_NOFOLLOW
          : undefined
        : options.noFollowFlag,
    );
    if (!Number.isInteger(this.flushBatchSize) || this.flushBatchSize < 1) {
      throw new Error("flushBatchSize must be a positive integer");
    }
    if (!Number.isInteger(this.maxQueueEvents) || this.maxQueueEvents < 1) {
      throw new Error("maxQueueEvents must be a positive integer");
    }
    const intervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    if (!Number.isInteger(intervalMs) || intervalMs < 1) {
      throw new Error("flushIntervalMs must be a positive integer");
    }

    ensurePrivateTelemetryDirectory(this.config.directory, this.noFollow, this.ops);
    this.validateExistingArtifacts();
    this.prune();
    const opened = this.openSegment();
    this.fd = opened.fd;
    this._activePath = opened.path;
    this.currentDay = utcDay(this.now());
    this.lastPruneAt = this.now();

    this.interval = setInterval(() => {
      void this.requestDrain();
      if (!this.disabled && this.now() - this.lastPruneAt >= PRUNE_INTERVAL_MS) this.pruneSafely();
    }, intervalMs);
    this.interval.unref?.();
  }

  get stats(): TelemetryWriterStats {
    return Object.freeze({
      queuedEvents: this.queue.length,
      droppedEvents: this.droppedEvents,
      disabled: this.disabled,
    });
  }

  getDroppedEvents(): number {
    return this.droppedEvents;
  }

  get activePath(): string {
    return this._activePath;
  }

  emit(event: TelemetryEvent): void {
    if (this.disabled || this.closed || this.closing) return;
    let line: string;
    try {
      line = `${serializeTelemetryEvent(event)}\n`;
    } catch {
      this.recordDrop("serialization");
      return;
    }
    const bytes = Buffer.byteLength(line, "utf8");
    if (bytes > this.config.maxEventBytes) {
      this.recordDrop("event_oversized");
      return;
    }

    if (this.queue.length >= this.maxQueueEvents) {
      const droppable = this.queue.findIndex((entry) => !entry.terminal);
      if (droppable >= 0) {
        this.queue.splice(droppable, 1);
        this.recordDrop("queue_full");
      } else {
        void this.requestDrain();
      }
    }
    if (this.disabled || this.closed || this.closing) return;
    this.queue.push({ line, data: Buffer.from(line, "utf8"), bytes, terminal: TERMINAL_EVENT_TYPES.has(event.type) });
    if (this.queue.length >= this.flushBatchSize) void this.requestDrain();
  }

  async flush(): Promise<void> {
    await this.requestDrain();
  }

  close(): Promise<void> {
    if (this.writerClosePromise) return this.writerClosePromise;
    this.closing = true;
    clearInterval(this.interval);
    this.writerClosePromise = (async () => {
      await this.requestDrain();
      this.closed = true;
      if (this.disabled) return;
      try {
        this.ops.closeSync(this.fd);
      } catch {
        this.fail("filesystem");
      }
    })();
    return this.writerClosePromise;
  }

  private validateExistingArtifacts(): void {
    for (const name of this.ops.readdirSync(this.config.directory)) {
      const path = join(this.config.directory, name);
      const stats = this.ops.lstatSync(path);
      if (stats.isSymbolicLink()) {
        throw new Error(`Telemetry directory contains a symbolic link: ${path}`);
      }
      if (TRACE_FILE_PATTERN.test(name)) validateRegularPrivateFile(path, this.ops);
    }
  }

  private openSegment(): { fd: number; path: string } {
    const path = join(this.config.directory, telemetrySegmentName(this.now(), this.runId, this.segment));
    if (lstatIfPresent(path, this.ops)) throw new Error(`Telemetry segment already exists: ${path}`);
    const flags =
      fsConstants.O_WRONLY |
      fsConstants.O_APPEND |
      fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      this.noFollow;
    const fd = this.ops.openSync(path, flags, 0o600);
    try {
      this.ops.fchmodSync(fd, 0o600);
      const stats = this.ops.fstatSync(fd);
      if (!stats.isFile() || (stats.mode & 0o777) !== 0o600) {
        throw new Error("Telemetry segment must be a regular file with exact mode 0600");
      }
      assertDescriptorMatchesPath(path, stats as Stats, this.ops);
      this.ops.fsyncSync(fd);
      syncTelemetryDirectory(this.config.directory, this.noFollow, this.ops);
      return { fd, path };
    } catch (error) {
      try {
        this.ops.closeSync(fd);
      } finally {
        try {
          this.ops.unlinkSync(path);
        } catch {
          // The original initialization failure remains authoritative.
        }
      }
      throw error;
    }
  }

  private async rotate(): Promise<void> {
    await this.asyncOps.fsync(this.fd);
    this.ops.closeSync(this.fd);
    this.segment += 1;
    this.currentBytes = 0;
    this.currentDay = utcDay(this.now());
    this.prune();
    const opened = this.openSegment();
    this.fd = opened.fd;
    this._activePath = opened.path;
  }

  private requestDrain(): Promise<void> {
    if (this.disabled || this.closed) return Promise.resolve();
    if (!this.drainPromise) {
      const draining = this.drainLoop();
      this.drainPromise = draining.finally(() => {
        this.drainPromise = undefined;
        if (!this.disabled && !this.closed && this.queue.length > 0) void this.requestDrain();
      });
    }
    return this.drainPromise;
  }

  private async drainLoop(): Promise<void> {
    while (!this.disabled && !this.closed) {
      const healthLines = this.createHealthLines();
      if (this.disabled) return;
      const entries = [...healthLines, ...this.queue.splice(0)];
      if (entries.length === 0) return;

      try {
        for (const entry of entries) {
          const dayChanged = utcDay(this.now()) !== this.currentDay;
          const sizeExceeded =
            this.currentBytes > 0 && this.currentBytes + entry.bytes > this.config.maxFileBytes;
          if (dayChanged || sizeExceeded) await this.rotate();
          await this.asyncOps.write(this.fd, entry.data);
          this.currentBytes += entry.bytes;
        }
        await this.asyncOps.fsync(this.fd);
      } catch {
        this.fail("filesystem");
        return;
      }
    }
  }

  private createHealthLines(): QueuedLine[] {
    if (!this.createHealthEvent || this.pendingDrops.size === 0) return [];
    const lines: QueuedLine[] = [];
    for (const [reason, count] of this.pendingDrops) {
      try {
        const line = `${JSON.stringify(this.createHealthEvent(reason, count))}\n`;
        const bytes = Buffer.byteLength(line, "utf8");
        if (bytes <= this.config.maxEventBytes) {
          lines.push({ line, data: Buffer.from(line, "utf8"), bytes, terminal: false });
        }
      } catch {
        this.fail("serialization");
        return [];
      }
    }
    this.pendingDrops.clear();
    return lines;
  }

  private recordDrop(reason: WriterDropReason): void {
    this.droppedEvents = Math.min(MAX_REPORTED_DROPS, this.droppedEvents + 1);
    const prior = this.pendingDrops.get(reason) ?? 0;
    this.pendingDrops.set(reason, Math.min(MAX_REPORTED_DROPS, prior + 1));
  }

  private pruneSafely(): void {
    try {
      this.prune();
    } catch {
      this.fail("filesystem");
    }
  }

  private prune(): void {
    const now = this.now();
    const entries = this.ops
      .readdirSync(this.config.directory)
      .filter((name) => TRACE_FILE_PATTERN.test(name))
      .map((name) => {
        const path = join(this.config.directory, name);
        const stats = validateRegularPrivateFile(path, this.ops);
        return { path, size: stats.size, mtimeMs: stats.mtimeMs };
      })
      .sort((left, right) => left.mtimeMs - right.mtimeMs || left.path.localeCompare(right.path));
    let changed = false;
    const remaining = new Set(entries.map((entry) => entry.path));

    const removeIfPresent = (path: string): boolean => {
      try {
        this.ops.unlinkSync(path);
        return true;
      } catch (error) {
        if (isMissingPath(error)) return false;
        throw error;
      }
    };

    for (const entry of entries) {
      if (entry.path === this.activePath) continue;
      const effectiveRetention = Math.max(this.config.retentionMs, MIN_SOFT_RETENTION_MS);
      if (entry.mtimeMs < now - effectiveRetention) {
        const removedHere = removeIfPresent(entry.path);
        remaining.delete(entry.path);
        changed = changed || removedHere;
      }
    }

    let total = entries.reduce((sum, entry) => (remaining.has(entry.path) ? sum + entry.size : sum), 0);
    if (total > this.config.maxTotalBytes) {
      const softCandidates = entries.filter(
        (entry) => remaining.has(entry.path) && entry.path !== this.activePath && entry.mtimeMs <= now - MIN_SOFT_RETENTION_MS,
      );
      const hardCandidates = entries.filter(
        (entry) => remaining.has(entry.path) && entry.path !== this.activePath && !softCandidates.includes(entry),
      );
      for (const entry of [...softCandidates, ...hardCandidates]) {
        if (total <= this.config.maxTotalBytes) break;
        const removedHere = removeIfPresent(entry.path);
        remaining.delete(entry.path);
        total -= entry.size;
        changed = changed || removedHere;
      }
    }
    if (changed) syncTelemetryDirectory(this.config.directory, this.noFollow, this.ops);
    this.lastPruneAt = now;
  }

  private fail(reason: TelemetryWriterDiagnostic["reason"]): void {
    if (this.disabled) return;
    this.disabled = true;
    clearInterval(this.interval);
    try {
      this.ops.closeSync(this.fd);
    } catch {
      // The writer is already disabled; raw filesystem errors stay out of diagnostics.
    }
    if (!this.diagnosticReported) {
      this.diagnosticReported = true;
      try {
        this.onDiagnostic?.({ code: "TELEMETRY_WRITER_DISABLED", reason });
      } catch {
        // Telemetry failure must never affect tool execution.
      }
    }
  }
}

export function parseTelemetryJsonl(content: string): unknown[] {
  if (content.length === 0) return [];
  const terminated = content.endsWith("\n");
  const lines = content.split("\n");
  const last = terminated ? lines.length - 2 : lines.length - 1;
  const events: unknown[] = [];
  for (let index = 0; index <= last; index += 1) {
    const line = lines[index] ?? "";
    try {
      if (line.length === 0) throw new Error("blank line");
      events.push(JSON.parse(line));
    } catch {
      if (index === last && !terminated) return events;
      throw new Error(`Malformed telemetry JSONL at line ${index + 1}`);
    }
  }
  return events;
}
