import {
  chmodSync,
  fstatSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { TelemetryManager, type TelemetrySink } from "./manager.js";
import { TELEMETRY_SCHEMA_VERSION, type TelemetryConfig, type TelemetryEvent } from "./types.js";

function config(directory: string, enabled = true): TelemetryConfig {
  return {
    enabled,
    directory,
    keyPath: join(directory, "..", "trace-key"),
    retentionMs: 7 * 86_400_000,
    maxTotalBytes: 64 * 1024 * 1024,
    maxFileBytes: 32 * 1024 * 1024,
    maxEventBytes: 16 * 1024,
  };
}

function event(runId: string): TelemetryEvent {
  return {
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    eventId: "event-1",
    runId,
    type: "run_started",
    timestamp: "2026-07-17T00:00:00.000Z",
    monotonicOffsetMs: 0,
    processRole: "client",
  };
}

describe("TelemetryManager", () => {
  it("performs zero dependency and filesystem work when disabled", async () => {
    const touched = vi.fn(() => {
      throw new Error("disabled mode touched dependencies");
    });
    const manager = TelemetryManager.create(config("/never-created", false), {
      now: touched,
      monotonicNow: touched,
      randomUUID: touched,
      randomBytes: touched,
      fileOps: new Proxy({}, { get: touched }),
    });

    expect(manager.enabled).toBe(false);
    expect(manager.installKey()).toBeUndefined();
    expect(() => manager.emit(event("disabled"))).not.toThrow();
    await expect(manager.flush()).resolves.toBeUndefined();
    await expect(manager.close()).resolves.toBeUndefined();
    expect(touched).not.toHaveBeenCalled();
  });

  it("creates and reuses one exact-0600 install key while runs own separate files", async () => {
    const base = mkdtempSync(join(tmpdir(), "mybrowser-trace-manager-"));
    const directory = join(base, "traces");
    const previousUmask = process.umask(0o777);
    let first: TelemetryManager;
    try {
      first = TelemetryManager.create(config(directory), {
        now: () => Date.UTC(2026, 6, 17),
        monotonicNow: () => 10,
        randomUUID: () => "run-first",
        randomBytes: () => Buffer.alloc(32, 7),
      });
    } finally {
      process.umask(previousUmask);
    }
    first.emit(event(first.runId));
    await first.close();

    const second = TelemetryManager.create(config(directory), {
      now: () => Date.UTC(2026, 6, 17),
      monotonicNow: () => 20,
      randomUUID: () => "run-second",
      randomBytes: () => Buffer.alloc(32, 9),
    });
    second.emit(event(second.runId));
    await second.close();

    expect(first.runId).toBe("run-first");
    expect(second.runId).toBe("run-second");
    expect(first.installKey()).toEqual(Buffer.alloc(32, 7));
    expect(second.installKey()).toEqual(Buffer.alloc(32, 7));
    expect(statSync(join(base, "trace-key")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(base, "trace-key"))).toEqual(Buffer.alloc(32, 7));
  });

  it("rejects symlink install keys and unavailable no-follow semantics", () => {
    const base = mkdtempSync(join(tmpdir(), "mybrowser-trace-manager-key-"));
    const directory = join(base, "traces");
    mkdirSync(directory, { mode: 0o700 });
    chmodSync(directory, 0o700);
    symlinkSync(join(base, "target-key"), join(base, "trace-key"));

    expect(() => TelemetryManager.create(config(directory))).toThrow(/symbolic link|no-follow/i);

    const separate = join(base, "separate");
    expect(() => TelemetryManager.create(config(separate), { noFollowFlag: null })).toThrow(/no-follow/i);
  });

  it("rejects an existing install key whose descriptor identity differs from its path", async () => {
    const base = mkdtempSync(join(tmpdir(), "mybrowser-trace-key-race-"));
    const directory = join(base, "traces");
    const initial = TelemetryManager.create(config(directory));
    await initial.close();

    expect(() =>
      TelemetryManager.create(config(directory), {
        fileOps: {
          fstatSync: ((fd: number) => {
            const stats = fstatSync(fd);
            if (!stats.isFile() || stats.size !== 32) return stats;
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

  it("reuses the winner when another process atomically publishes the first key", async () => {
    const base = mkdtempSync(join(tmpdir(), "mybrowser-trace-key-publish-race-"));
    const directory = join(base, "traces");
    let raced = false;
    const manager = TelemetryManager.create(config(directory), {
      randomBytes: () => Buffer.alloc(32, 5),
      randomUUID: () => "run-race",
      fileOps: {
        linkSync: ((existingPath: string, newPath: string) => {
          linkSync(existingPath, newPath);
          raced = true;
          const error = new Error("another process published first") as NodeJS.ErrnoException;
          error.code = "EEXIST";
          throw error;
        }) as typeof linkSync,
      },
    });

    expect(raced).toBe(true);
    expect(manager.installKey()).toEqual(Buffer.alloc(32, 5));
    expect(readFileSync(join(base, "trace-key"))).toEqual(Buffer.alloc(32, 5));
    await manager.close();
  });

  it("persists a bounded writer-health event for drops", async () => {
    const base = mkdtempSync(join(tmpdir(), "mybrowser-trace-manager-health-"));
    const directory = join(base, "traces");
    const manager = TelemetryManager.create(
      { ...config(directory), maxEventBytes: 512 },
      { now: () => Date.UTC(2026, 6, 17), monotonicNow: () => 25, randomUUID: () => "run-health" },
    );
    manager.emit({
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      eventId: "oversized",
      runId: manager.runId,
      type: "tools_listed",
      timestamp: "2026-07-17T00:00:00.000Z",
      monotonicOffsetMs: 0,
      clientName: "x".repeat(1_000),
      toolCount: 1,
      schemaDigest: "digest",
    });
    await manager.flush();
    await manager.close();

    const content = readFileSync(
      join(directory, `trace-20260717-run-health-0000.jsonl`),
      "utf8",
    );
    expect(content).toContain('"type":"writer_health"');
    expect(content).toContain('"reason":"event_oversized"');
    expect(content).not.toContain("xxxxx");
  });

  it("bounds close even when an injected sink never resolves", async () => {
    vi.useFakeTimers();
    const sink: TelemetrySink = {
      emit: vi.fn(),
      flush: vi.fn(() => new Promise<void>(() => undefined)),
      close: vi.fn(() => new Promise<void>(() => undefined)),
    };
    const manager = TelemetryManager.fromSink(sink, {
      runId: "run-test",
      installKey: Buffer.alloc(32, 1),
    });

    const closing = manager.close(2_000);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(closing).resolves.toBeUndefined();
    await expect(manager.close(2_000)).resolves.toBeUndefined();
    expect(sink.close).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
