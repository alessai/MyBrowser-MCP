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

class MemorySink implements TelemetrySink {
  readonly events: TelemetryEvent[] = [];
  readonly close = vi.fn(async () => undefined);
  readonly flush = vi.fn(async () => undefined);

  emit(event: TelemetryEvent): void {
    this.events.push(event);
  }

  getDroppedEvents(): number {
    return 3;
  }
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

  it("preserves exact results and thrown errors when root tracing is disabled", async () => {
    const manager = TelemetryManager.disabled();
    const result = { unchanged: true };
    const error = new Error("same-error-instance");

    await expect(manager.runToolCall({
      sessionId: "session-disabled",
      toolName: "browser_type",
      arguments: { text: "RAW_DISABLED_CANARY" },
    }, async () => result)).resolves.toBe(result);

    let caught: unknown;
    try {
      await manager.runToolCall({
        sessionId: "session-disabled",
        toolName: "browser_type",
      }, async () => { throw error; });
    } catch (thrown) {
      caught = thrown;
    }
    expect(caught).toBe(error);
    expect(manager.currentRoot()).toBeUndefined();
  });

  it("propagates one private root through nested async work and emits one terminal event", async () => {
    const sink = new MemorySink();
    let id = 0;
    let mono = 100;
    const manager = TelemetryManager.fromSink(sink, {
      runId: "run-root",
      installKey: Buffer.alloc(32, 4),
      now: () => Date.UTC(2026, 6, 17),
      monotonicNow: () => mono++,
      randomUUID: () => `id-${++id}`,
    });
    const canary = "RAW_ROOT_ARGUMENT_CANARY";
    let nestedRoot: unknown;

    const value = await manager.runToolCall({
      sessionId: "RAW_SESSION_IDENTIFIER",
      toolName: "browser_type",
      arguments: { text: canary, tabId: 17, submit: true },
      classifyResult: () => ({ status: "success" }),
    }, async () => {
      const directRoot = manager.currentRoot();
      await new Promise<void>((resolve) => {
        setTimeout(() => {
          nestedRoot = manager.currentRoot();
          resolve();
        }, 0);
      });
      expect(nestedRoot).toBe(directRoot);
      return "unchanged-result";
    });

    expect(value).toBe("unchanged-result");
    expect(manager.currentRoot()).toBeUndefined();
    const toolEvents = sink.events.filter((candidate) => candidate.type.startsWith("tool_"));
    expect(toolEvents.map((candidate) => candidate.type)).toEqual(["tool_started", "tool_completed"]);
    expect(JSON.stringify(toolEvents)).not.toContain(canary);
    expect(JSON.stringify(toolEvents)).not.toContain("RAW_SESSION_IDENTIFIER");
    expect(toolEvents[0]).toMatchObject({
      type: "tool_started",
      toolName: "browser_type",
      arguments: {
        scalar: { "text.length": "17-64", submit: true },
        presence: ["submit", "tabId", "text"],
      },
    });
    expect(toolEvents[0]).toHaveProperty("argumentFingerprint");
    expect(Object.keys(toolEvents[0] ?? {})).not.toContain("model");
    expect(Object.keys(toolEvents[0] ?? {})).not.toContain("prompt");
  });

  it("classifies result failures and thrown failures without duplicating terminal events", async () => {
    const sink = new MemorySink();
    const manager = TelemetryManager.fromSink(sink, {
      runId: "run-failure",
      installKey: Buffer.alloc(32, 2),
      randomUUID: (() => { let id = 0; return () => `failure-${++id}`; })(),
    });

    const response = { isError: true, unchanged: true };
    await expect(manager.runToolCall({
      sessionId: "session-a",
      toolName: "browser_click",
      classifyResult: () => ({ status: "error", errorCategory: "ownership_denied" }),
    }, async () => response)).resolves.toBe(response);

    const thrown = new Error("raw error remains outside telemetry");
    let caught: unknown;
    try {
      await manager.runToolCall({
        sessionId: "session-a",
        toolName: "browser_click",
        classifyError: () => ({ status: "cancelled", errorCategory: "worker_restarted" }),
      }, async () => { throw thrown; });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(thrown);

    const terminals = sink.events.filter((candidate) => (
      candidate.type === "tool_completed" || candidate.type === "tool_failed"
    ));
    expect(terminals).toHaveLength(2);
    expect(terminals).toMatchObject([
      { type: "tool_failed", errorCategory: "ownership_denied" },
      { type: "tool_failed", errorCategory: "worker_restarted" },
    ]);
    expect(JSON.stringify(terminals)).not.toContain(thrown.message);
  });

  it("does not replace a tool result when terminal event construction fails", async () => {
    const sink = new MemorySink();
    let id = 0;
    const manager = TelemetryManager.fromSink(sink, {
      runId: "run-terminal-failure",
      installKey: Buffer.alloc(32, 3),
      randomUUID: () => {
        id += 1;
        if (id >= 5) throw new Error("telemetry id generator failed");
        return `terminal-${id}`;
      },
    });
    const result = { exact: true };

    await expect(manager.runToolCall({
      sessionId: "session-a",
      toolName: "list_browsers",
    }, async () => result)).resolves.toBe(result);
    expect(sink.events.map((candidate) => candidate.type)).toEqual(["run_started", "tool_started"]);
  });

  it("keeps a bounded root span when the registered-tool sanitizer fails", async () => {
    const sink = new MemorySink();
    const manager = TelemetryManager.fromSink(sink, {
      runId: "run-sanitizer-failure",
      installKey: Buffer.alloc(32, 3),
      randomUUID: (() => { let id = 0; return () => `sanitize-${++id}`; })(),
    });
    const rawToolName = "RAW_REMOVED_POLICY_CANARY";
    const result = { exact: true };

    await expect(manager.runToolCall({
      sessionId: "session-a",
      toolName: rawToolName,
      arguments: { raw: rawToolName },
    }, async () => result)).resolves.toBe(result);

    const toolEvents = sink.events.filter((event) => event.type.startsWith("tool_"));
    expect(toolEvents.map((event) => event.type)).toEqual(["tool_started", "tool_completed"]);
    expect(toolEvents[0]).toMatchObject({
      toolName: "sanitizer_failed_tool",
      sanitizerFailed: true,
      arguments: { droppedFields: 1 },
    });
    expect(JSON.stringify(toolEvents)).not.toContain(rawToolName);
  });

  it("isolates overlapping roots across asynchronous continuations", async () => {
    const sink = new MemorySink();
    const manager = TelemetryManager.fromSink(sink, {
      runId: "run-overlap",
      installKey: Buffer.alloc(32, 5),
      randomUUID: (() => { let id = 0; return () => `overlap-${++id}`; })(),
    });
    const roots = new Map<string, unknown>();

    await Promise.all(["session-a", "session-b"].map((sessionId, index) => manager.runToolCall({
      sessionId,
      toolName: "list_browsers",
    }, async () => {
      const before = manager.currentRoot();
      await new Promise((resolve) => setTimeout(resolve, index === 0 ? 5 : 0));
      expect(manager.currentRoot()).toBe(before);
      roots.set(sessionId, before);
      return sessionId;
    })));

    expect(roots.get("session-a")).not.toBe(roots.get("session-b"));
    const starts = sink.events.filter((event) => event.type === "tool_started");
    const terminals = sink.events.filter((event) => event.type === "tool_completed");
    expect(new Set(starts.map((event) => event.rootCallId)).size).toBe(2);
    expect(new Set(terminals.map((event) => event.rootCallId))).toEqual(
      new Set(starts.map((event) => event.rootCallId)),
    );
  });

  it("emits lifecycle events and closes the sink once with its bounded drop count", async () => {
    const sink = new MemorySink();
    const manager = TelemetryManager.fromSink(sink, {
      runId: "run-lifecycle",
      installKey: Buffer.alloc(32, 8),
      now: () => Date.UTC(2026, 6, 17),
      monotonicNow: () => 10,
      randomUUID: () => "lifecycle-event",
    });

    await manager.close(2_000);
    await manager.close(2_000);

    expect(sink.events.map((candidate) => candidate.type)).toEqual(["run_started", "run_stopped"]);
    expect(sink.events[1]).toMatchObject({ reason: "shutdown", droppedEvents: 3 });
    expect(sink.close).toHaveBeenCalledTimes(1);
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
