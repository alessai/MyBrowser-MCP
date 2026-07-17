import { randomBytes as cryptoRandomBytes, randomUUID as cryptoRandomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import type { Stats } from "node:fs";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";

import type { TelemetryConfig, TelemetryEvent, TelemetryEventBase, WriterHealthEvent } from "./types.js";
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

export interface TelemetrySink {
  emit(event: TelemetryEvent): void;
  flush(): Promise<void>;
  close(deadlineMs?: number): Promise<void>;
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
    return new TelemetryManager(true, runId, writer, key, { now, monotonicNow, randomUUID, monoStart });
  }

  static fromSink(sink: TelemetrySink, options: TelemetryManagerTestOptions): TelemetryManager {
    return new TelemetryManager(true, options.runId, sink, options.installKey, {
      now: options.now ?? Date.now,
      monotonicNow: options.monotonicNow ?? (() => performance.now()),
      randomUUID: options.randomUUID ?? cryptoRandomUUID,
    });
  }

  installKey(): Buffer | undefined {
    return this.key ? Buffer.from(this.key) : undefined;
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

  eventBase(type: TelemetryEvent["type"]): TelemetryEventBase {
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
}
