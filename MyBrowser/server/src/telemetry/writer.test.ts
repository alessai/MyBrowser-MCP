import {
  chmodSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
  writeSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  JsonlTelemetryWriter,
  parseTelemetryJsonl,
  telemetrySegmentName,
  type WriterHealthFactory,
} from "./writer.js";
import { TELEMETRY_SCHEMA_VERSION, type TelemetryConfig, type TelemetryEvent } from "./types.js";

const START = Date.UTC(2026, 6, 17, 12, 0, 0);

function config(directory: string, overrides: Partial<TelemetryConfig> = {}): TelemetryConfig {
  return {
    enabled: true,
    directory,
    keyPath: join(directory, "..", "trace-key"),
    retentionMs: 7 * 24 * 60 * 60 * 1_000,
    maxTotalBytes: 64 * 1024 * 1024,
    maxFileBytes: 32 * 1024 * 1024,
    maxEventBytes: 16 * 1024,
    ...overrides,
  };
}

function started(id: string, payload: Record<string, unknown> = {}): TelemetryEvent {
  return {
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    eventId: id,
    runId: "run-a",
    type: "run_started",
    timestamp: new Date(START).toISOString(),
    monotonicOffsetMs: 0,
    processRole: "client",
    ...payload,
  } as TelemetryEvent;
}

function stopped(id: string): TelemetryEvent {
  return {
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    eventId: id,
    runId: "run-a",
    type: "run_stopped",
    timestamp: new Date(START).toISOString(),
    monotonicOffsetMs: 1,
    reason: "shutdown",
    droppedEvents: 0,
  };
}

const healthFactory: WriterHealthFactory = (reason, droppedEvents) => ({
  schemaVersion: TELEMETRY_SCHEMA_VERSION,
  eventId: `health-${reason}-${droppedEvents}`,
  runId: "run-a",
  type: "writer_health",
  timestamp: new Date(START).toISOString(),
  monotonicOffsetMs: 2,
  state: "dropping",
  reason,
  droppedEvents,
});

function files(directory: string): string[] {
  return readdirSync(directory).filter((name) => name.endsWith(".jsonl")).sort();
}

describe("JsonlTelemetryWriter security and buffering", () => {
  it("creates exact private modes and writes one JSON object per line under an open umask", async () => {
    const base = mkdtempSync(join(tmpdir(), "mybrowser-trace-writer-"));
    const directory = join(base, "traces");
    const previousUmask = process.umask(0o777);
    try {
      const writer = new JsonlTelemetryWriter({ config: config(directory), runId: "run-a", now: () => START });
      writer.emit(started("event-1"));
      await writer.flush();

      expect(statSync(directory).mode & 0o777).toBe(0o700);
      expect(statSync(writer.activePath).mode & 0o777).toBe(0o600);
      expect(parseTelemetryJsonl(readFileSync(writer.activePath, "utf8"))).toMatchObject([
        { eventId: "event-1", type: "run_started" },
      ]);
      await writer.close();
    } finally {
      process.umask(previousUmask);
    }
  });

  it("fails closed when O_NOFOLLOW is unavailable", () => {
    const base = mkdtempSync(join(tmpdir(), "mybrowser-trace-nofollow-"));
    expect(() =>
      new JsonlTelemetryWriter({
        config: config(join(base, "traces")),
        runId: "run-a",
        now: () => START,
        noFollowFlag: null,
      }),
    ).toThrow(/no-follow/i);
  });

  it("rejects symlink trace directories and trace files", () => {
    const base = mkdtempSync(join(tmpdir(), "mybrowser-trace-symlink-"));
    const target = join(base, "target");
    const directoryLink = join(base, "traces-link");
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, directoryLink, "dir");

    expect(() =>
      new JsonlTelemetryWriter({ config: config(directoryLink), runId: "run-a", now: () => START }),
    ).toThrow(/symbolic link/i);

    const directory = join(base, "traces");
    mkdirSync(directory, { mode: 0o700 });
    const linkedTrace = join(directory, telemetrySegmentName(START, "other-run", 9));
    symlinkSync(join(base, "missing-target"), linkedTrace);
    expect(() =>
      new JsonlTelemetryWriter({ config: config(directory), runId: "run-a", now: () => START }),
    ).toThrow(/symbolic link/i);
  });

  it("serializes once and flushes at the batch threshold or one-second timer", async () => {
    vi.useFakeTimers();
    const base = mkdtempSync(join(tmpdir(), "mybrowser-trace-flush-"));
    const writer = new JsonlTelemetryWriter({
      config: config(join(base, "traces")),
      runId: "run-a",
      now: () => START,
      flushBatchSize: 2,
      flushIntervalMs: 1_000,
    });
    writer.emit(started("event-once"));
    expect(readFileSync(writer.activePath, "utf8")).toBe("");
    writer.emit(started("event-2"));
    await writer.flush();
    expect(parseTelemetryJsonl(readFileSync(writer.activePath, "utf8"))).toHaveLength(2);

    writer.emit(started("event-3"));
    await vi.advanceTimersByTimeAsync(1_000);
    await writer.flush();
    expect(parseTelemetryJsonl(readFileSync(writer.activePath, "utf8"))).toHaveLength(3);
    await writer.close();
    vi.useRealTimers();
  });

  it("never waits for a pending disk write inside emit", async () => {
    const base = mkdtempSync(join(tmpdir(), "mybrowser-trace-async-emit-"));
    let releaseWrite!: () => void;
    const writePending = new Promise<void>((resolveWrite) => {
      releaseWrite = resolveWrite;
    });
    const asyncWrite = vi.fn(async (fd: number, data: Buffer) => {
      await writePending;
      writeSync(fd, data);
    });
    const writer = new JsonlTelemetryWriter({
      config: config(join(base, "traces")),
      runId: "run-a",
      now: () => START,
      flushBatchSize: 1,
      asyncFileOps: { write: asyncWrite },
    });

    expect(() => writer.emit(started("async-event"))).not.toThrow();
    expect(asyncWrite).toHaveBeenCalledTimes(1);
    expect(readFileSync(writer.activePath, "utf8")).toBe("");

    releaseWrite();
    await writer.flush();
    expect(parseTelemetryJsonl(readFileSync(writer.activePath, "utf8"))).toHaveLength(1);
    await writer.close();
  });

  it("rotates before the file cap and at a UTC day boundary", async () => {
    const base = mkdtempSync(join(tmpdir(), "mybrowser-trace-rotate-"));
    let now = START;
    const lineBytes = Buffer.byteLength(`${JSON.stringify(started("event-1"))}\n`, "utf8");
    const writer = new JsonlTelemetryWriter({
      config: config(join(base, "traces"), { maxFileBytes: lineBytes + 8 }),
      runId: "run-a",
      now: () => now,
      flushBatchSize: 1,
    });

    writer.emit(started("event-1"));
    writer.emit(started("event-2"));
    await writer.flush();
    expect(files(join(base, "traces"))).toHaveLength(2);

    now += 24 * 60 * 60 * 1_000;
    writer.emit(started("event-3"));
    await writer.flush();
    expect(files(join(base, "traces"))).toHaveLength(3);
    expect(basename(writer.activePath)).toContain("20260718");
    await writer.close();
  });

  it("prunes expired files and enforces the hard aggregate cap oldest-first", async () => {
    const base = mkdtempSync(join(tmpdir(), "mybrowser-trace-prune-"));
    const directory = join(base, "traces");
    mkdirSync(directory, { mode: 0o700 });
    const old = join(directory, "trace-20260710-old-0000.jsonl");
    const recentOldest = join(directory, "trace-20260717-recent-a-0000.jsonl");
    const recentNewest = join(directory, "trace-20260717-recent-b-0000.jsonl");
    for (const path of [old, recentOldest, recentNewest]) {
      writeFileSync(path, "x".repeat(600), { mode: 0o600 });
      chmodSync(path, 0o600);
    }
    utimesSync(old, new Date(START - 10 * 86_400_000), new Date(START - 10 * 86_400_000));
    utimesSync(recentOldest, new Date(START - 2 * 3_600_000), new Date(START - 2 * 3_600_000));
    utimesSync(recentNewest, new Date(START - 3_600_000), new Date(START - 3_600_000));

    const writer = new JsonlTelemetryWriter({
      config: config(directory, { retentionMs: 7 * 86_400_000, maxTotalBytes: 700 }),
      runId: "run-a",
      now: () => START,
    });

    expect(lstatSync(old, { throwIfNoEntry: false })).toBeUndefined();
    expect(lstatSync(recentOldest, { throwIfNoEntry: false })).toBeUndefined();
    expect(lstatSync(recentNewest).isFile()).toBe(true);
    await writer.close();
  });

  it("tolerates another process winning the same prune unlink", async () => {
    const base = mkdtempSync(join(tmpdir(), "mybrowser-trace-prune-race-"));
    const directory = join(base, "traces");
    mkdirSync(directory, { mode: 0o700 });
    const old = join(directory, "trace-20260710-old-0000.jsonl");
    writeFileSync(old, "{}\n", { mode: 0o600 });
    chmodSync(old, 0o600);
    utimesSync(old, new Date(START - 10 * 86_400_000), new Date(START - 10 * 86_400_000));
    let raced = false;

    const writer = new JsonlTelemetryWriter({
      config: config(directory),
      runId: "run-a",
      now: () => START,
      fileOps: {
        unlinkSync: ((path: Parameters<typeof unlinkSync>[0]) => {
          unlinkSync(path);
          if (!raced) {
            raced = true;
            const error = new Error("another process already pruned this file") as NodeJS.ErrnoException;
            error.code = "ENOENT";
            throw error;
          }
        }) as typeof unlinkSync,
      },
    });

    expect(raced).toBe(true);
    expect(writer.stats.disabled).toBe(false);
    await writer.close();
  });

  it("retains files younger than 24 hours unless the hard cap requires pruning", async () => {
    const base = mkdtempSync(join(tmpdir(), "mybrowser-trace-soft-retention-"));
    const directory = join(base, "traces");
    mkdirSync(directory, { mode: 0o700 });
    const recent = join(directory, "trace-20260717-recent-0000.jsonl");
    writeFileSync(recent, "{}\n", { mode: 0o600 });
    chmodSync(recent, 0o600);
    utimesSync(recent, new Date(START - 2 * 3_600_000), new Date(START - 2 * 3_600_000));

    const writer = new JsonlTelemetryWriter({
      config: config(directory, { retentionMs: 60 * 60 * 1_000, maxTotalBytes: 1_000_000 }),
      runId: "run-a",
      now: () => START,
    });

    expect(lstatSync(recent).isFile()).toBe(true);
    await writer.close();
  });

  it("rejects a telemetry directory whose descriptor identity differs from its path", () => {
    const base = mkdtempSync(join(tmpdir(), "mybrowser-trace-directory-race-"));
    const directory = join(base, "traces");
    expect(() =>
      new JsonlTelemetryWriter({
        config: config(directory),
        runId: "run-a",
        now: () => START,
        fileOps: {
          fstatSync: ((fd: number) => {
            const stats = fstatSync(fd);
            if (!stats.isDirectory()) return stats;
            return new Proxy(stats, {
              get(target, property) {
                if (property === "ino") return Number(target.ino) + 1;
                const value = Reflect.get(target, property, target);
                return typeof value === "function" ? value.bind(target) : value;
              },
            });
          }) as unknown as typeof fstatSync,
        },
      }),
    ).toThrow(/identity/i);
  });

  it("drops oldest non-terminal queue entries but preserves terminal events", async () => {
    const base = mkdtempSync(join(tmpdir(), "mybrowser-trace-overflow-"));
    const writer = new JsonlTelemetryWriter({
      config: config(join(base, "traces")),
      runId: "run-a",
      now: () => START,
      maxQueueEvents: 2,
      flushBatchSize: 1_000,
      flushIntervalMs: 60_000,
      createHealthEvent: healthFactory,
    });
    for (const id of ["start-1", "start-2", "start-3"]) writer.emit(started(id));
    for (const id of ["stop-1", "stop-2", "stop-3"]) writer.emit(stopped(id));
    await writer.flush();

    const events = files(join(base, "traces")).flatMap((name) =>
      parseTelemetryJsonl(readFileSync(join(base, "traces", name), "utf8")),
    ) as Array<Record<string, unknown>>;
    expect(events.filter((event) => event.type === "run_stopped").map((event) => event.eventId)).toEqual([
      "stop-1",
      "stop-2",
      "stop-3",
    ]);
    expect(events).toContainEqual(expect.objectContaining({ type: "writer_health", reason: "queue_full" }));
    expect(writer.stats.droppedEvents).toBeGreaterThan(0);
    await writer.close();
  });

  it("drops oversized events to a bounded health record", async () => {
    const base = mkdtempSync(join(tmpdir(), "mybrowser-trace-oversized-"));
    const writer = new JsonlTelemetryWriter({
      config: config(join(base, "traces"), { maxEventBytes: 512 }),
      runId: "run-a",
      now: () => START,
      createHealthEvent: healthFactory,
    });
    writer.emit({
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      eventId: "oversized",
      runId: "run-a",
      type: "tools_listed",
      timestamp: new Date(START).toISOString(),
      monotonicOffsetMs: 0,
      clientName: "x".repeat(1_000),
      toolCount: 1,
      schemaDigest: "digest",
    });
    await writer.flush();

    const events = parseTelemetryJsonl(readFileSync(writer.activePath, "utf8")) as Array<Record<string, unknown>>;
    expect(events).toEqual([
      expect.objectContaining({ type: "writer_health", reason: "event_oversized", droppedEvents: 1 }),
    ]);
    await writer.close();
  });

  it("rejects unknown fields, getters, and custom serialization without persisting canaries", async () => {
    const base = mkdtempSync(join(tmpdir(), "mybrowser-trace-runtime-schema-"));
    const writer = new JsonlTelemetryWriter({
      config: config(join(base, "traces")),
      runId: "run-a",
      now: () => START,
      createHealthEvent: healthFactory,
    });
    const unknown = { ...started("unknown"), forbidden: "RAW_SCHEMA_CANARY" } as unknown as TelemetryEvent;
    const custom = {
      ...started("custom"),
      toJSON: () => ({ ...started("custom"), processRole: "RAW_SCHEMA_CANARY" }),
    } as unknown as TelemetryEvent;
    const getter = started("getter") as TelemetryEvent & { clientName?: string };
    Object.defineProperty(getter, "clientName", {
      enumerable: true,
      get: () => "RAW_SCHEMA_CANARY",
    });

    writer.emit(unknown);
    writer.emit(custom);
    writer.emit(getter);
    await writer.flush();

    const content = readFileSync(writer.activePath, "utf8");
    expect(content).not.toContain("RAW_SCHEMA_CANARY");
    expect(parseTelemetryJsonl(content)).toEqual([
      expect.objectContaining({ type: "writer_health", reason: "serialization", droppedEvents: 3 }),
    ]);
    await writer.close();
  });

  it("disables once on write failure and never throws into emit", async () => {
    const base = mkdtempSync(join(tmpdir(), "mybrowser-trace-write-error-"));
    const diagnostics = vi.fn();
    const writer = new JsonlTelemetryWriter({
      config: config(join(base, "traces")),
      runId: "run-a",
      now: () => START,
      flushBatchSize: 1,
      onDiagnostic: diagnostics,
      asyncFileOps: {
        write: async () => {
          throw new Error("RAW_SECRET_WRITE_ERROR");
        },
      },
    });

    expect(() => writer.emit(started("event-1"))).not.toThrow();
    expect(() => writer.emit(started("event-2"))).not.toThrow();
    await writer.flush();
    expect(writer.stats.disabled).toBe(true);
    expect(diagnostics).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(diagnostics.mock.calls)).not.toContain("RAW_SECRET_WRITE_ERROR");
  });
});

describe("parseTelemetryJsonl", () => {
  it("handles empty and Unicode-complete input", () => {
    expect(parseTelemetryJsonl("")).toEqual([]);
    expect(parseTelemetryJsonl('{"text":"مرحبا🙂"}\n')).toEqual([{ text: "مرحبا🙂" }]);
  });

  it("ignores an entirely truncated final record", () => {
    expect(parseTelemetryJsonl('{"partial"')).toEqual([]);
  });

  it("rejects a complete blank line", () => {
    expect(() => parseTelemetryJsonl("\n")).toThrow(/line 1/i);
  });

  it("ignores one truncated final line", () => {
    expect(parseTelemetryJsonl('{"ok":1}\n{"partial"')).toEqual([{ ok: 1 }]);
  });

  it("rejects malformed interior or complete final lines", () => {
    expect(() => parseTelemetryJsonl('{"ok":1}\nnot-json\n{"ok":2}\n')).toThrow(/line 2/i);
    expect(() => parseTelemetryJsonl('{"ok":1}\nnot-json\n')).toThrow(/line 2/i);
  });
});
