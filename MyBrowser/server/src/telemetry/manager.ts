import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes as cryptoRandomBytes, randomUUID as cryptoRandomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import type { Stats } from "node:fs";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";

import type { TraceContextV1 } from "../protocol.js";
import {
  pseudonymizeTelemetryValue,
  summarizeFailedToolArguments,
  summarizeToolArguments,
  summarizeUnknownToolArguments,
} from "./sanitize.js";
import type {
  TelemetryConfig,
  TelemetryErrorCategory,
  TelemetryEvent,
  TelemetryEventBase,
  TelemetryOutcomeStatus,
  WriterHealthEvent,
} from "./types.js";
import { TELEMETRY_SCHEMA_VERSION } from "./types.js";
import {
  assertDescriptorMatchesPath,
  createTelemetryFileOps,
  ensurePrivateTelemetryDirectory,
  JsonlTelemetryWriter,
  resolveTelemetryNoFollow,
  syncTelemetryDirectory,
  type JsonlTelemetryWriterOptions,
  type TelemetryFileOps,
  type TelemetryWriterDiagnostic,
  type WriterDropReason,
} from "./writer.js";

const INSTALL_KEY_BYTES = 32;
const KEY_PUBLICATION_ATTEMPTS = 3;

function byteSizeBucket(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0";
  if (bytes <= 255) return "1-255";
  if (bytes <= 1_023) return "256-1023";
  if (bytes <= 4_095) return "1-4KiB";
  if (bytes <= 16_383) return "4-16KiB";
  return "16KiB+";
}

export interface TelemetrySink {
  emit(event: TelemetryEvent): void;
  flush(): Promise<void>;
  close(deadlineMs?: number): Promise<void>;
  getDroppedEvents?(): number;
}

export interface RootToolContext {
  readonly runId: string;
  readonly traceId: string;
  readonly rootCallId: string;
  readonly sessionPseudonym: string;
  readonly toolName: string;
  readonly startedMonoMs: number;
}

export type RootToolOutcome =
  | { readonly status: "success" }
  | {
    readonly status: Exclude<TelemetryOutcomeStatus, "success">;
    readonly errorCategory: TelemetryErrorCategory;
  };

export interface RootToolInput {
  readonly sessionId: string;
  readonly toolName: string;
  readonly arguments?: unknown;
  readonly unknownTool?: boolean;
  readonly classifyResult?: (result: unknown) => RootToolOutcome;
  readonly classifyError?: (error: unknown) => RootToolOutcome;
}

export interface ToolsListedInput {
  readonly clientName?: string;
  readonly clientVersion?: string;
  readonly clientSupportsSampling: boolean;
  readonly clientSupportsRoots: boolean;
  readonly clientSupportsElicitation: boolean;
  readonly toolCount: number;
  readonly schemaDigest: string;
}

export interface TransportSpanInput {
  readonly action: string;
  readonly browserId?: string;
}

export interface TransportSpanHandle {
  readonly trace: TraceContextV1;
  complete(responseBytes: number, resultPresent: boolean): void;
  fail(errorCategory: TelemetryErrorCategory): void;
}

export interface TelemetryManagerDependencies {
  now?: () => number;
  monotonicNow?: () => number;
  randomUUID?: () => string;
  randomBytes?: (size: number) => Buffer;
  noFollowFlag?: number | null;
  fileOps?: Partial<TelemetryFileOps>;
  writerOptions?: Partial<
    Pick<JsonlTelemetryWriterOptions, "flushBatchSize" | "flushIntervalMs" | "maxQueueEvents">
  >;
  onDiagnostic?: (diagnostic: TelemetryWriterDiagnostic) => void;
}

export interface TelemetryManagerTestOptions {
  runId: string;
  installKey: Buffer;
  now?: () => number;
  monotonicNow?: () => number;
  randomUUID?: () => string;
}

function readOwnPrivateKey(
  path: string,
  noFollow: number,
  ops: TelemetryFileOps,
): Buffer | undefined {
  let pathStats: Stats;
  try {
    pathStats = ops.lstatSync(path) as Stats;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  if (pathStats.isSymbolicLink()) throw new Error("Telemetry install key cannot be a symbolic link");
  if (!pathStats.isFile()) throw new Error("Telemetry install key must be a regular file");

  const fd = ops.openSync(path, fsConstants.O_RDONLY | noFollow);
  try {
    const descriptorStats = ops.fstatSync(fd);
    if (!descriptorStats.isFile() || (descriptorStats.mode & 0o777) !== 0o600) {
      throw new Error("Telemetry install key must have exact mode 0600");
    }
    if (descriptorStats.size !== INSTALL_KEY_BYTES) {
      throw new Error("Telemetry install key must contain exactly 32 bytes");
    }
    assertDescriptorMatchesPath(path, descriptorStats as Stats, ops);
    const key = Buffer.alloc(INSTALL_KEY_BYTES);
    let offset = 0;
    while (offset < key.length) {
      const bytesRead = ops.readSync(fd, key, offset, key.length - offset, offset);
      if (bytesRead <= 0) throw new Error("Telemetry install key is truncated");
      offset += bytesRead;
    }
    return key;
  } finally {
    ops.closeSync(fd);
  }
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function isMissingPath(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function publishPrivateKey(
  path: string,
  directory: string,
  key: Buffer,
  publicationId: string,
  noFollow: number,
  ops: TelemetryFileOps,
): Buffer | undefined {
  if (key.length !== INSTALL_KEY_BYTES) throw new Error("Telemetry install key generator must return 32 bytes");
  const safePublicationId = publicationId.replace(/[^A-Za-z0-9_-]/gu, "_").slice(0, 128);
  if (safePublicationId.length === 0) throw new Error("Telemetry key publication identifier is invalid");
  const temporaryPath = `${path}.${safePublicationId}.tmp`;
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow;
  const fd = ops.openSync(temporaryPath, flags, 0o600);
  let contended = false;
  try {
    ops.fchmodSync(fd, 0o600);
    const stats = ops.fstatSync(fd);
    if (!stats.isFile() || (stats.mode & 0o777) !== 0o600) {
      throw new Error("Telemetry install key must be a regular file with exact mode 0600");
    }
    ops.writeSync(fd, key, 0, key.length, 0);
    ops.fsyncSync(fd);
    const finalStats = ops.fstatSync(fd);
    if (finalStats.size !== INSTALL_KEY_BYTES) throw new Error("Telemetry install key write was incomplete");
    assertDescriptorMatchesPath(temporaryPath, finalStats as Stats, ops);
    try {
      ops.linkSync(temporaryPath, path);
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      contended = true;
    }
    if (!contended) assertDescriptorMatchesPath(path, finalStats as Stats, ops);
  } finally {
    ops.closeSync(fd);
    try {
      ops.unlinkSync(temporaryPath);
    } catch (error) {
      if (!isMissingPath(error)) throw error;
    }
  }
  syncTelemetryDirectory(directory, noFollow, ops);
  return contended ? undefined : Buffer.from(key);
}

function loadOrCreateInstallKey(
  path: string,
  noFollow: number,
  ops: TelemetryFileOps,
  randomBytes: (size: number) => Buffer,
  randomUUID: () => string,
): Buffer {
  const directory = dirname(path);
  for (let attempt = 0; attempt < KEY_PUBLICATION_ATTEMPTS; attempt += 1) {
    const existing = readOwnPrivateKey(path, noFollow, ops);
    if (existing) {
      syncTelemetryDirectory(directory, noFollow, ops);
      return existing;
    }
    const published = publishPrivateKey(
      path,
      directory,
      randomBytes(INSTALL_KEY_BYTES),
      `${randomUUID()}-${attempt}`,
      noFollow,
      ops,
    );
    if (published) return published;
  }
  throw new Error("Telemetry install key publication did not converge");
}

export class TelemetryManager implements TelemetrySink {
  private readonly sink?: TelemetrySink;
  private readonly key?: Buffer;
  private readonly monoStart: number;
  private readonly now: () => number;
  private readonly monotonicNow: () => number;
  private readonly randomUUID: () => string;
  private readonly roots = new AsyncLocalStorage<RootToolContext>();
  private closePromise?: Promise<void>;

  private constructor(
    readonly enabled: boolean,
    readonly runId: string,
    sink: TelemetrySink | undefined,
    key: Buffer | undefined,
    dependencies: {
      now: () => number;
      monotonicNow: () => number;
      randomUUID: () => string;
      monoStart?: number;
    },
  ) {
    this.sink = sink;
    this.key = key ? Buffer.from(key) : undefined;
    this.now = dependencies.now;
    this.monotonicNow = dependencies.monotonicNow;
    this.randomUUID = dependencies.randomUUID;
    this.monoStart = this.enabled ? dependencies.monoStart ?? this.monotonicNow() : 0;
  }

  static disabled(): TelemetryManager {
    const never = () => 0;
    return new TelemetryManager(false, "", undefined, undefined, {
      now: never,
      monotonicNow: never,
      randomUUID: () => "",
    });
  }

  static create(config: TelemetryConfig, dependencies: TelemetryManagerDependencies = {}): TelemetryManager {
    if (!config.enabled) return TelemetryManager.disabled();

    const now = dependencies.now ?? Date.now;
    const monotonicNow = dependencies.monotonicNow ?? (() => performance.now());
    const randomUUID = dependencies.randomUUID ?? cryptoRandomUUID;
    const randomBytes = dependencies.randomBytes ?? cryptoRandomBytes;
    const noFollow = resolveTelemetryNoFollow(
      dependencies.noFollowFlag === undefined
        ? typeof fsConstants.O_NOFOLLOW === "number"
          ? fsConstants.O_NOFOLLOW
          : undefined
        : dependencies.noFollowFlag,
    );
    const ops = createTelemetryFileOps(dependencies.fileOps);
    ensurePrivateTelemetryDirectory(dirname(config.keyPath), noFollow, ops);
    ensurePrivateTelemetryDirectory(config.directory, noFollow, ops);
    const key = loadOrCreateInstallKey(config.keyPath, noFollow, ops, randomBytes, randomUUID);
    const runId = randomUUID();
    const monoStart = monotonicNow();
    const createHealthEvent = (reason: WriterDropReason, droppedEvents: number): WriterHealthEvent => {
      const base: TelemetryEventBase = {
        schemaVersion: TELEMETRY_SCHEMA_VERSION,
        eventId: randomUUID(),
        runId,
        type: "writer_health",
        timestamp: new Date(now()).toISOString(),
        monotonicOffsetMs: Math.max(0, monotonicNow() - monoStart),
      };
      return { ...base, type: "writer_health", state: "dropping", reason, droppedEvents };
    };

    const writer = new JsonlTelemetryWriter({
      config,
      runId,
      now,
      noFollowFlag: noFollow,
      fileOps: ops,
      createHealthEvent,
      onDiagnostic: dependencies.onDiagnostic,
      ...dependencies.writerOptions,
    });
    const manager = new TelemetryManager(true, runId, writer, key, { now, monotonicNow, randomUUID, monoStart });
    manager.emitRunStarted();
    return manager;
  }

  static fromSink(sink: TelemetrySink, options: TelemetryManagerTestOptions): TelemetryManager {
    const manager = new TelemetryManager(true, options.runId, sink, options.installKey, {
      now: options.now ?? Date.now,
      monotonicNow: options.monotonicNow ?? (() => performance.now()),
      randomUUID: options.randomUUID ?? cryptoRandomUUID,
    });
    manager.emitRunStarted();
    return manager;
  }

  installKey(): Buffer | undefined {
    return this.key ? Buffer.from(this.key) : undefined;
  }

  currentRoot(): RootToolContext | undefined {
    return this.enabled ? this.roots.getStore() : undefined;
  }

  beginTransport(input: TransportSpanInput): TransportSpanHandle | undefined {
    if (!this.enabled || !this.key) return undefined;
    const root = this.roots.getStore();
    if (!root) return undefined;

    try {
      const transportSpanId = this.randomUUID();
      const startedMonoMs = this.monotonicNow();
      const trace = Object.freeze({
        schemaVersion: 1 as const,
        traceId: root.traceId,
        rootCallId: root.rootCallId,
        transportSpanId,
      });
      this.emit({
        ...this.eventBase("transport_started"),
        type: "transport_started",
        sessionPseudonym: root.sessionPseudonym,
        traceId: root.traceId,
        rootCallId: root.rootCallId,
        transportSpanId,
        action: input.action,
        ...(input.browserId
          ? { browserPseudonym: pseudonymizeTelemetryValue(this.key, "browser", input.browserId) }
          : {}),
      });

      let terminal = false;
      const durationMs = (): number => Math.max(0, this.monotonicNow() - startedMonoMs);
      return Object.freeze({
        trace,
        complete: (responseBytes: number, resultPresent: boolean): void => {
          if (terminal) return;
          terminal = true;
          try {
            this.emit({
              ...this.eventBase("transport_completed"),
              type: "transport_completed",
              sessionPseudonym: root.sessionPseudonym,
              traceId: root.traceId,
              rootCallId: root.rootCallId,
              transportSpanId,
              durationMs: durationMs(),
              responseSizeBucket: byteSizeBucket(responseBytes),
              resultPresent,
            });
          } catch {
            // Transport telemetry must not alter the response.
          }
        },
        fail: (errorCategory: TelemetryErrorCategory): void => {
          if (terminal) return;
          terminal = true;
          try {
            this.emit({
              ...this.eventBase("transport_failed"),
              type: "transport_failed",
              sessionPseudonym: root.sessionPseudonym,
              traceId: root.traceId,
              rootCallId: root.rootCallId,
              transportSpanId,
              durationMs: durationMs(),
              errorCategory,
            });
          } catch {
            // Transport telemetry must not alter the failure.
          }
        },
      });
    } catch {
      return undefined;
    }
  }

  recordToolsListed(input: ToolsListedInput): void {
    if (!this.enabled) return;
    try {
      this.emit({
        ...this.eventBase("tools_listed"),
        type: "tools_listed",
        ...(input.clientName ? { clientName: input.clientName } : {}),
        ...(input.clientVersion ? { clientVersion: input.clientVersion } : {}),
        clientSupportsSampling: input.clientSupportsSampling,
        clientSupportsRoots: input.clientSupportsRoots,
        clientSupportsElicitation: input.clientSupportsElicitation,
        toolCount: input.toolCount,
        schemaDigest: input.schemaDigest,
      });
    } catch {
      // List-tools telemetry must not affect the MCP response.
    }
  }

  async runToolCall<T>(input: RootToolInput, operation: () => Promise<T>): Promise<T> {
    if (!this.enabled || !this.key) return operation();

    let root: RootToolContext;
    let argumentSummary: ReturnType<typeof summarizeToolArguments>;
    let sanitizerFailed = false;
    try {
      const startedMonoMs = this.monotonicNow();
      let safeToolName = input.toolName;
      try {
        argumentSummary = input.unknownTool
          ? summarizeUnknownToolArguments(this.key)
          : summarizeToolArguments(input.toolName, input.arguments, this.key);
      } catch {
        safeToolName = "sanitizer_failed_tool";
        sanitizerFailed = true;
        argumentSummary = summarizeFailedToolArguments(this.key);
      }
      root = Object.freeze({
        runId: this.runId,
        traceId: this.randomUUID(),
        rootCallId: this.randomUUID(),
        sessionPseudonym: pseudonymizeTelemetryValue(this.key, "session", input.sessionId),
        toolName: safeToolName,
        startedMonoMs,
      });
      this.emit({
        ...this.eventBase("tool_started"),
        type: "tool_started",
        sessionPseudonym: root.sessionPseudonym,
        traceId: root.traceId,
        rootCallId: root.rootCallId,
        toolName: root.toolName,
        argumentFingerprint: argumentSummary.fingerprint,
        arguments: argumentSummary.summary,
        ...(sanitizerFailed ? { sanitizerFailed: true } : {}),
      });
    } catch {
      return operation();
    }

    const terminal = (outcome: RootToolOutcome): void => {
      try {
        const durationMs = Math.max(0, this.monotonicNow() - root.startedMonoMs);
        if (outcome.status === "success") {
          this.emit({
            ...this.eventBase("tool_completed"),
            type: "tool_completed",
            sessionPseudonym: root.sessionPseudonym,
            traceId: root.traceId,
            rootCallId: root.rootCallId,
            toolName: root.toolName,
            durationMs,
            status: "success",
          });
          return;
        }
        this.emit({
          ...this.eventBase("tool_failed"),
          type: "tool_failed",
          sessionPseudonym: root.sessionPseudonym,
          traceId: root.traceId,
          rootCallId: root.rootCallId,
          toolName: root.toolName,
          durationMs,
          status: outcome.status,
          errorCategory: outcome.errorCategory,
        });
      } catch {
        // Telemetry event construction must not affect the tool result or error.
      }
    };

    return this.roots.run(root, async () => {
      try {
        const result = await operation();
        let outcome: RootToolOutcome = { status: "success" };
        try {
          outcome = input.classifyResult?.(result) ?? outcome;
        } catch {
          outcome = { status: "error", errorCategory: "unknown" };
        }
        terminal(outcome);
        return result;
      } catch (error) {
        let outcome: RootToolOutcome = { status: "error", errorCategory: "unknown" };
        try {
          outcome = input.classifyError?.(error) ?? outcome;
        } catch {
          // Keep the stable unknown category without changing the thrown error.
        }
        terminal(outcome);
        throw error;
      }
    });
  }

  emit(event: TelemetryEvent): void {
    if (!this.enabled) return;
    try {
      this.sink?.emit(event);
    } catch {
      // Telemetry must not affect MCP tool behavior.
    }
  }

  async flush(): Promise<void> {
    if (!this.enabled) return;
    try {
      await this.sink?.flush();
    } catch {
      // The writer reports its own bounded diagnostic.
    }
  }

  close(deadlineMs = 2_000): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    if (this.closePromise) return this.closePromise;
    try {
      this.emit({
        ...this.eventBase("run_stopped"),
        type: "run_stopped",
        reason: "shutdown",
        droppedEvents: Math.min(2_147_483_647, Math.max(0, this.sink?.getDroppedEvents?.() ?? 0)),
      });
    } catch {
      // Lifecycle telemetry must never prevent shutdown.
    }
    const closeWork = Promise.resolve()
      .then(() => this.sink?.close(deadlineMs))
      .then(() => undefined)
      .catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolveDeadline) => {
      timer = setTimeout(resolveDeadline, Math.max(0, deadlineMs));
      timer.unref?.();
    });
    this.closePromise = Promise.race([closeWork, deadline]).finally(() => {
      if (timer) clearTimeout(timer);
    });
    return this.closePromise;
  }

  private eventBase(type: TelemetryEvent["type"]): TelemetryEventBase {
    if (!this.enabled) throw new Error("Telemetry is disabled");
    return {
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      eventId: this.randomUUID(),
      runId: this.runId,
      type,
      timestamp: new Date(this.now()).toISOString(),
      monotonicOffsetMs: Math.max(0, this.monotonicNow() - this.monoStart),
    };
  }

  private emitRunStarted(): void {
    try {
      this.emit({
        ...this.eventBase("run_started"),
        type: "run_started",
        processRole: "client",
      });
    } catch {
      // Lifecycle telemetry must never prevent startup.
    }
  }
}
