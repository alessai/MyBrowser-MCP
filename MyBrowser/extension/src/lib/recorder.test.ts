import { describe, expect, it, vi } from "vitest";

import { getRecentExtensionIssues } from "./diagnostics";
import { reportToolFailure } from "./background-privacy";

import {
  MAX_ACTIVE_RECORDING_BYTES,
  MAX_ACTIVE_RECORDING_STEPS,
  MAX_AGGREGATE_RECORDING_BYTES,
  isSanitizedRecording,
  RecordingManager,
  runRecordedAction,
  type RecordingAlarmScheduler,
  type RecordingStorage,
  type RecordingTransport,
} from "./recorder";

const SECRET_TEXT = "SECRET_MANAGER_ALPHA_9731";
const SECRET_FORM = "SECRET_MANAGER_BRAVO_2846";
const SECRET_SELECT = "SECRET_MANAGER_CHARLIE_6502";
const SECRET_URL = "SECRET_MANAGER_DELTA_4178";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function expectAbsent(value: unknown, secrets = [
  SECRET_TEXT,
  SECRET_FORM,
  SECRET_SELECT,
  SECRET_URL,
]): void {
  const serialized = JSON.stringify(value);
  for (const secret of secrets) expect(serialized).not.toContain(secret);
}

class MemoryStorage implements RecordingStorage {
  readonly values = new Map<string, unknown>();
  readonly writes: unknown[] = [];
  readonly reads: string[] = [];
  readonly events: string[];
  failSet: Error | undefined;
  failGet: Error | undefined;
  failHas: Error | undefined;
  failSetKey: string | undefined;
  failSetKeyOnCall: number | undefined;
  failRemoveKey: string | undefined;
  failRemoveMany: Error | undefined;
  readonly removeManyCalls: string[][] = [];
  private readonly setCounts = new Map<string, number>();

  constructor(events: string[] = []) {
    this.events = events;
  }

  async get<T>(key: string): Promise<T | undefined> {
    this.reads.push(key);
    if (this.failGet) throw this.failGet;
    const value = this.values.get(key);
    return value === undefined ? undefined : clone(value as T);
  }

  async has(key: string): Promise<boolean> {
    if (this.failHas) throw this.failHas;
    return this.values.has(key);
  }

  async getKeys(): Promise<string[]> {
    return [...this.values.keys()];
  }

  async set<T>(key: string, value: T): Promise<void> {
    const count = (this.setCounts.get(key) ?? 0) + 1;
    this.setCounts.set(key, count);
    if (this.failSet || (this.failSetKey === key
      && (this.failSetKeyOnCall === undefined || this.failSetKeyOnCall === count))) {
      throw this.failSet ?? new Error("SET_FAILED");
    }
    const copy = clone(value);
    this.events.push(`storage:set:${key}`);
    this.writes.push({ key, value: copy });
    this.values.set(key, copy);
  }

  async setMany(values: Record<string, unknown>): Promise<void> {
    const entries = Object.entries(values);
    if (this.failSet || entries.some(([key]) => this.failSetKey === key)) {
      throw this.failSet ?? new Error("SET_FAILED");
    }
    for (const [key, value] of entries) {
      const copy = clone(value);
      this.events.push(`storage:set:${key}`);
      this.writes.push({ key, value: copy });
      this.values.set(key, copy);
    }
  }

  async remove(key: string): Promise<void> {
    if (this.failRemoveKey === key) throw new Error("REMOVE_FAILED");
    this.events.push(`storage:remove:${key}`);
    this.values.delete(key);
  }

  async removeMany(keys: string[]): Promise<void> {
    this.removeManyCalls.push([...keys]);
    if (this.failRemoveMany || keys.some((key) => this.failRemoveKey === key)) {
      throw this.failRemoveMany ?? new Error("REMOVE_FAILED");
    }
    for (const key of keys) {
      this.events.push(`storage:remove:${key}`);
      this.values.delete(key);
    }
  }
}

class FakeScheduler implements RecordingAlarmScheduler {
  ensured = 0;
  cleared = 0;
  failClear = false;

  async ensureRenewal(): Promise<void> {
    this.ensured += 1;
  }

  async clearRenewal(): Promise<void> {
    this.cleared += 1;
    if (this.failClear) throw new Error("ALARM_CLEAR_FAILED");
  }
}

class FakeTransport implements RecordingTransport {
  readonly requests: Array<{ type: string; payload: unknown; timeoutMs: number }> = [];
  readonly events: string[];
  responses: unknown[] = [];

  constructor(events: string[] = []) {
    this.events = events;
  }

  async request(type: string, payload: unknown, timeoutMs: number): Promise<unknown> {
    this.events.push(`transport:${type}`);
    this.requests.push({ type, payload: clone(payload), timeoutMs });
    const response = this.responses.shift();
    if (response instanceof Error) throw response;
    return response ?? { ok: true };
  }
}

function createManager(options: {
  sessionStorage?: MemoryStorage;
  localStorage?: MemoryStorage;
  transport?: FakeTransport;
  scheduler?: FakeScheduler;
  limits?: ConstructorParameters<typeof RecordingManager>[0]["limits"];
} = {}) {
  const sessionStorage = options.sessionStorage ?? new MemoryStorage();
  const localStorage = options.localStorage ?? new MemoryStorage();
  const transport = options.transport ?? new FakeTransport();
  const scheduler = options.scheduler ?? new FakeScheduler();
  const manager = new RecordingManager({
    sessionStorage,
    localStorage,
    transport,
    scheduler,
    limits: options.limits,
    now: () => 1_700_000_000_000,
  });
  return { manager, sessionStorage, localStorage, transport, scheduler };
}

async function captureType(
  manager: RecordingManager,
  sessionId: string,
  tabId: number,
  text: string,
): Promise<void> {
  const prepared = await manager.prepareStep(sessionId, "browser_type", {
    element: "Password",
    text,
  }, tabId);
  expect(prepared).not.toBeNull();
  await manager.commitStep(sessionId, prepared!, {
    durationMs: 25,
    currentUrl: `https://example.test/account?token=${SECRET_URL}#private`,
  });
}

describe("RecordingManager privacy and ownership", () => {
  it("rolls back failed start persistence without exposing dependency errors", async () => {
    const sessionStorage = new MemoryStorage();
    sessionStorage.failSet = new Error(`start storage exposed ${SECRET_TEXT}`);
    const { manager, scheduler } = createManager({ sessionStorage });
    let message = "";
    try {
      await manager.start("session-a", "flow", 11, "https://example.test");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toBe("RECORDING_START_FAILED");
    expect(manager.snapshot().active).toEqual([]);
    expect(sessionStorage.values.has("active-recording:session-a")).toBe(false);
    expect(sessionStorage.values.has("active-recording-index:session-a")).toBe(false);
    expect(scheduler.ensured).toBe(0);
    expectAbsent({ message, snapshot: manager.snapshot() });
  });

  it("rejects completed recordings with reverse maps or raw sensitive args", () => {
    const safe = {
      name: "flow",
      startedAt: 1,
      stoppedAt: 2,
      url: "https://example.test/path",
      steps: [{
        action: "browser_type",
        args: { text: "{{input_1}}" },
        timestamp: 1,
        durationMs: 1,
        url: "https://example.test/path",
      }],
      requiredVariables: [{ name: "input_1", source: "text", hint: "text_input_1" }],
    };
    expect(isSanitizedRecording(safe)).toBe(true);
    expect(isSanitizedRecording({ ...safe, variables: { input_1: SECRET_TEXT } })).toBe(false);
    expect(isSanitizedRecording({
      ...safe,
      steps: [{ ...safe.steps[0], args: { text: SECRET_TEXT } }],
      requiredVariables: [],
    })).toBe(false);
    expect(isSanitizedRecording({
      ...safe,
      steps: [{ ...safe.steps[0], args: { text: "{{input_2}}" } }],
      requiredVariables: [{ name: "input_2", source: "text", hint: "text_input_2" }],
    })).toBe(false);
    expect(isSanitizedRecording({
      ...safe,
      requiredVariables: [{
        name: "input_1",
        source: "text",
        hint: "text_input_1",
        label: SECRET_TEXT,
      }],
    })).toBe(false);
  });

  it("isolates simultaneous sessions, bound tabs, and replay suppression", async () => {
    const { manager } = createManager();
    await manager.start("session-a", "alpha", 11, `https://example.test/a?token=${SECRET_URL}`);
    await manager.start("session-b", "bravo", 22, "https://example.test/b");

    expect(await manager.prepareStep("session-a", "browser_type", { text: SECRET_TEXT }, 99))
      .toBeNull();
    manager.setReplaying("session-a", true);
    expect(await manager.prepareStep("session-a", "browser_type", { text: SECRET_TEXT }, 11))
      .toBeNull();
    expect(await manager.prepareStep("session-b", "browser_type", { text: SECRET_TEXT }, 22))
      .not.toBeNull();
    manager.setReplaying("session-a", false);

    await expect(manager.stop("session-c")).rejects.toThrow("NO_ACTIVE_RECORDING");
    expectAbsent(manager.snapshot());
  });

  it("stores and returns only placeholders and generic required-variable hints", async () => {
    const { manager, sessionStorage, localStorage, transport } = createManager();
    await manager.start("session-a", "checkout", 11, `https://example.test/start?token=${SECRET_URL}`);

    const typed = await manager.prepareStep("session-a", "browser_type", {
      label: "Password",
      text: SECRET_TEXT,
    }, 11);
    expect(typed?.args).toEqual({ label: "Password", text: "{{input_1}}" });
    expectAbsent(typed);
    await manager.commitStep("session-a", typed!, {
      durationMs: 10,
      currentUrl: `https://example.test/account?token=${SECRET_URL}#private`,
    });

    const form = await manager.prepareStep("session-a", "browser_fill_form", {
      fields: { "Private account": SECRET_FORM },
    }, 11);
    await manager.commitStep("session-a", form!, { durationMs: 11, currentUrl: "https://example.test/form" });
    const selected = await manager.prepareStep("session-a", "browser_select_option", {
      element: "Private tier",
      values: [SECRET_SELECT],
    }, 11);
    await manager.commitStep("session-a", selected!, { durationMs: 12, currentUrl: "https://example.test/done" });

    const result = await manager.stop("session-a");
    expect(result).toMatchObject({ extensionSaved: true, serverSaved: true });
    expect(result.recording.url).toBe("https://example.test/start");
    expect(result.recording.steps[0]?.url).toBe("https://example.test/account");
    expect(result.recording.requiredVariables).toEqual([
      { name: "input_1", source: "text", hint: "text_input_1" },
      { name: "form_2", source: "form", hint: "form_input_2" },
      { name: "select_3", source: "select", hint: "select_input_3" },
    ]);

    expectAbsent({
      snapshot: manager.snapshot(),
      sessionWrites: sessionStorage.writes,
      localWrites: localStorage.writes,
      requests: transport.requests,
      result,
    });
  });

  it("discards a prepared failed action without consuming its placeholder", async () => {
    const { manager } = createManager();
    await manager.start("session-a", "flow", 11, "https://example.test");
    const failed = await manager.prepareStep("session-a", "browser_type", { text: SECRET_TEXT }, 11);
    await manager.discardStep("session-a", failed!);
    const retried = await manager.prepareStep("session-a", "browser_type", { text: SECRET_FORM }, 11);

    expect(retried?.args).toEqual({ text: "{{input_1}}" });
    expectAbsent({ failed, retried });
  });
});

describe("RecordingManager limits", () => {
  it("enforces the per-recording cap at start", async () => {
    const { manager } = createManager({
      limits: { maxSteps: 1_000, maxRecordingBytes: 400, maxAggregateBytes: 50_000 },
    });
    await expect(manager.start(
      "session-a",
      "x".repeat(500),
      11,
      "https://example.test",
    )).rejects.toThrow("RECORDING_STATE_LIMIT");
  });

  it("exports and enforces the specified default caps", async () => {
    expect(MAX_ACTIVE_RECORDING_STEPS).toBe(1_000);
    expect(MAX_ACTIVE_RECORDING_BYTES).toBe(2 * 1024 * 1024);
    expect(MAX_AGGREGATE_RECORDING_BYTES).toBe(8 * 1024 * 1024);

    const { manager } = createManager({
      limits: {
        maxSteps: 1,
        maxRecordingBytes: MAX_ACTIVE_RECORDING_BYTES,
        maxAggregateBytes: MAX_AGGREGATE_RECORDING_BYTES,
      },
    });
    await manager.start("session-a", "flow", 11, "https://example.test");
    await captureType(manager, "session-a", 11, SECRET_TEXT);

    let actionRan = false;
    await expect(manager.prepareStep("session-a", "browser_type", { text: SECRET_FORM }, 11))
      .rejects.toThrow("RECORDING_STATE_LIMIT");
    expect(actionRan).toBe(false);
    expectAbsent(manager.snapshot());
  });

  it("rejects per-recording and aggregate byte growth during preflight", async () => {
    const perRecording = createManager({
      limits: { maxSteps: 1_000, maxRecordingBytes: 9_000, maxAggregateBytes: 50_000 },
    }).manager;
    await perRecording.start("session-a", "flow", 11, "https://example.test");
    await expect(perRecording.prepareStep("session-a", "browser_click", {
      element: "x".repeat(2_000),
    }, 11)).rejects.toThrow("RECORDING_STATE_LIMIT");

    const aggregate = createManager({
      limits: { maxSteps: 1_000, maxRecordingBytes: 70_000, maxAggregateBytes: 75_000 },
    }).manager;
    await aggregate.start("session-a", "a", 11, "https://example.test/a");
    await aggregate.start("session-b", "b", 22, "https://example.test/b");
    const first = await aggregate.prepareStep("session-a", "browser_click", { element: "safe" }, 11);
    expect(first).not.toBeNull();
    await expect(aggregate.prepareStep("session-b", "browser_click", { element: "safe" }, 22))
      .rejects.toThrow("RECORDING_STATE_LIMIT");
  });

  it("allows only one prepared action per session", async () => {
    const { manager } = createManager();
    await manager.start("session-a", "flow", 11, "https://example.test");
    expect(await manager.prepareStep("session-a", "browser_click", { element: "one" }, 11))
      .not.toBeNull();

    await expect(manager.prepareStep("session-a", "browser_click", { element: "two" }, 11))
      .rejects.toThrow("RECORDING_ACTION_IN_PROGRESS");
  });
});

describe("runRecordedAction", () => {
  it("preflights before invoking the browser handler", async () => {
    const { manager } = createManager({
      limits: { maxSteps: 0, maxRecordingBytes: 20_000, maxAggregateBytes: 30_000 },
    });
    await manager.start("session-a", "flow", 11, "https://example.test");
    let actionRan = false;

    await expect(runRecordedAction({
      manager,
      sessionId: "session-a",
      toolName: "browser_type",
      args: { text: SECRET_TEXT },
      tabId: 11,
      run: async () => {
        actionRan = true;
        return "unexpected";
      },
      currentUrl: async () => "https://example.test",
    })).rejects.toThrow("RECORDING_STATE_LIMIT");

    expect(actionRan).toBe(false);
  });

  it("does not commit failed handlers or leak their error strings", async () => {
    const { manager } = createManager();
    await manager.start("session-a", "flow", 11, "https://example.test");

    await expect(runRecordedAction({
      manager,
      sessionId: "session-a",
      toolName: "browser_type",
      args: { text: SECRET_TEXT },
      tabId: 11,
      run: async () => {
        throw new Error(`handler exposed ${SECRET_TEXT}`);
      },
      currentUrl: async () => "https://example.test",
    })).rejects.toThrow("RECORDED_TOOL_ACTION_FAILED");

    await runRecordedAction({
      manager,
      sessionId: "session-a",
      toolName: "browser_type",
      args: { text: SECRET_FORM },
      tabId: 11,
      run: async () => "ok",
      currentUrl: async () => `https://example.test/path?secret=${SECRET_URL}`,
    });
    const stopped = await manager.stop("session-a");
    expect(stopped.recording.steps).toHaveLength(1);
    expect(stopped.recording.steps[0]?.args).toEqual({ text: "{{input_1}}" });
    expectAbsent(stopped);
  });

  it("keeps a prepared handler failure private after session abort", async () => {
    const { manager, sessionStorage } = createManager();
    await manager.start("session-a", "flow", 11, "https://example.test");
    let rejectAction!: (error: Error) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const action = runRecordedAction({
      manager,
      sessionId: "session-a",
      toolName: "browser_type",
      args: { text: SECRET_TEXT },
      tabId: 11,
      run: () => new Promise<never>((_resolve, reject) => {
        rejectAction = reject;
        markStarted();
      }),
      currentUrl: async () => "https://example.test",
    });
    await started;
    await manager.abortSession("session-a");
    rejectAction(new Error(`deferred handler exposed ${SECRET_TEXT}`));
    const actionError = await action.catch((error: unknown) => error);

    const issueCount = getRecentExtensionIssues(100).length;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const failure = reportToolFailure(actionError, {
      requestId: "request-private",
      toolType: "browser_type",
    });
    const evidence = {
      response: failure.responseError,
      diagnostics: getRecentExtensionIssues(100).slice(issueCount),
      console: [...consoleError.mock.calls, ...consoleWarn.mock.calls],
      storage: sessionStorage.writes,
      snapshot: manager.snapshot(),
    };
    consoleError.mockRestore();
    consoleWarn.mockRestore();

    expect(failure).toEqual({
      responseError: "RECORDED_TOOL_ACTION_FAILED",
      category: "RECORDED_TOOL_ACTION_FAILED",
      recorded: true,
    });
    expectAbsent(evidence);
  });

  it("reserves worst-case UTF-8 page metadata before browser effects", async () => {
    const { manager } = createManager({
      limits: { maxSteps: 1_000, maxRecordingBytes: 15_000, maxAggregateBytes: 50_000 },
    });
    await manager.start("session-a", "flow", 11, "https://example.test");
    let actionRan = false;

    await expect(runRecordedAction({
      manager,
      sessionId: "session-a",
      toolName: "browser_click",
      args: { element: "button" },
      tabId: 11,
      run: async () => {
        actionRan = true;
      },
      currentUrl: async () => `https://example.test/${"界".repeat(8_192)}`,
    })).rejects.toThrow("RECORDING_STATE_LIMIT");
    expect(actionRan).toBe(false);
  });
});

describe("RecordingManager restart and stop persistence", () => {
  it("restores sanitized state before restart-safe renewal", async () => {
    const sessionStorage = new MemoryStorage();
    const first = createManager({ sessionStorage });
    await first.manager.start("session-a", "flow", 11, `https://example.test?token=${SECRET_URL}`);
    await captureType(first.manager, "session-a", 11, SECRET_TEXT);

    const renewedTransport = new FakeTransport();
    const restarted = createManager({ sessionStorage, transport: renewedTransport });
    await restarted.manager.renewPersistedSessions();

    expect(renewedTransport.requests).toEqual([{
      type: "renewRecordingReservation",
      payload: { sessionId: "session-a", name: "flow" },
      timeoutMs: 10_000,
    }]);
    expect(restarted.manager.snapshot().active).toHaveLength(1);
    expectAbsent({ storage: sessionStorage.writes, requests: renewedTransport.requests });
  });

  it("persists server-failed stop recovery without renewal or expiry deletion", async () => {
    const sessionStorage = new MemoryStorage();
    const localStorage = new MemoryStorage();
    const transport = new FakeTransport();
    transport.responses.push(new Error(`persist failed ${SECRET_TEXT}`));
    const first = createManager({ sessionStorage, localStorage, transport });
    await first.manager.start("session-a", "recover-server", 11, "https://example.test");
    await captureType(first.manager, "session-a", 11, SECRET_TEXT);

    const partial = await first.manager.stop("session-a");
    expect(partial).toMatchObject({
      extensionSaved: false,
      serverSaved: false,
      error: "SERVER_PERSIST_FAILED",
    });
    expect(first.manager.snapshot().active).toEqual([
      expect.objectContaining({
        sessionId: "session-a",
        status: "stopping",
        stopStatus: {
          extensionSaved: false,
          serverSaved: false,
          error: "SERVER_PERSIST_FAILED",
        },
      }),
    ]);
    expect(first.scheduler.cleared).toBeGreaterThan(0);
    const requestCount = transport.requests.length;
    await first.manager.renewPersistedSessions();
    await first.manager.expireReservation("session-a");
    expect(transport.requests).toHaveLength(requestCount);
    expect(first.manager.snapshot().active).toHaveLength(1);
    await expect(first.manager.start("session-a", "replacement", 11, "https://example.test"))
      .rejects.toThrow("ACTIVE_RECORDING_EXISTS");

    const recoveryTransport = new FakeTransport();
    const restarted = createManager({
      sessionStorage,
      localStorage,
      transport: recoveryTransport,
    });
    await restarted.manager.renewPersistedSessions();
    expect(recoveryTransport.requests).toEqual([]);
    expect(restarted.manager.snapshot().active[0]).toMatchObject({ status: "stopping" });

    const recovered = await restarted.manager.stop("session-a");
    expect(recovered).toMatchObject({ extensionSaved: true, serverSaved: true });
    expect(recovered.recording).toEqual(partial.recording);
    expect(restarted.manager.snapshot().active).toEqual([]);
    expectAbsent({ partial, recovered, storage: sessionStorage.writes, local: localStorage.writes });
  });

  it("cleans recovery after durable server success even when local persistence fails", async () => {
    const sessionStorage = new MemoryStorage();
    const localStorage = new MemoryStorage();
    localStorage.failSet = new Error(`local failed ${SECRET_FORM}`);
    const { manager, scheduler } = createManager({ sessionStorage, localStorage });
    await manager.start("session-a", "server-only", 11, "https://example.test");

    const partial = await manager.stop("session-a");

    expect(partial).toMatchObject({
      extensionSaved: false,
      serverSaved: true,
      error: "LOCAL_PERSIST_FAILED",
    });
    expect(manager.snapshot().active).toEqual([]);
    expect(sessionStorage.values.has("active-recording:session-a")).toBe(false);
    expect(sessionStorage.values.has("active-recording-index:session-a")).toBe(false);
    expect(scheduler.cleared).toBeGreaterThan(0);
    expectAbsent(partial);
  });

  it("enumerates per-session markers and preserves concurrent sessions across stops", async () => {
    const sessionStorage = new MemoryStorage();
    const first = createManager({ sessionStorage });
    await first.manager.start("session-a", "alpha", 11, "https://example.test/a");
    await first.manager.start("session-b", "bravo", 22, "https://example.test/b");

    const restarted = createManager({ sessionStorage });
    await restarted.manager.renewPersistedSessions();
    expect(restarted.transport.requests.map((request) => request.payload)).toEqual([
      { sessionId: "session-a", name: "alpha" },
      { sessionId: "session-b", name: "bravo" },
    ]);
    await expect(restarted.manager.stop("session-c")).rejects.toThrow("NO_ACTIVE_RECORDING");
    expect(sessionStorage.values.get("active-recording-index:session-a"))
      .toEqual({ sessionId: "session-a", status: "active" });
    expect(sessionStorage.values.get("active-recording-index:session-b"))
      .toEqual({ sessionId: "session-b", status: "active" });

    await restarted.manager.stop("session-a");
    expect(sessionStorage.values.has("active-recording-index:session-a")).toBe(false);
    expect(sessionStorage.values.get("active-recording-index:session-b"))
      .toEqual({ sessionId: "session-b", status: "active" });
    expect(sessionStorage.values.has("active-recording:session-b")).toBe(true);
    expect(restarted.scheduler.cleared).toBe(0);
  });

  it("cleans an unsafe legacy indexed snapshot without reading the shared index value", async () => {
    const sessionStorage = new MemoryStorage();
    sessionStorage.values.set("active-recording-index", { secret: SECRET_TEXT });
    sessionStorage.values.set("active-recording:session-a", {
      sessionId: "session-a",
      tabId: 11,
      nextVariable: 1,
      recording: {
        name: "legacy",
        startedAt: 1,
        url: "https://example.test",
        steps: [{
          action: "browser_type",
          args: { text: SECRET_TEXT },
          timestamp: 1,
          durationMs: 1,
          url: "https://example.test",
        }],
        requiredVariables: [],
      },
    });
    const { manager } = createManager({ sessionStorage });

    await manager.renewPersistedSessions();

    expect(manager.snapshot().active).toEqual([]);
    expect(sessionStorage.values.has("active-recording:session-a")).toBe(false);
    expect(sessionStorage.values.has("active-recording-index:session-a")).toBe(false);
    expect(sessionStorage.values.has("active-recording-index")).toBe(false);
    expect(sessionStorage.reads).not.toContain("active-recording-index");
    expectAbsent({ snapshot: manager.snapshot(), writes: sessionStorage.writes });
  });

  it("cleans a markerless legacy snapshot without reading it or the shared index value", async () => {
    const sessionStorage = new MemoryStorage();
    const first = createManager({ sessionStorage });
    await first.manager.start("session-a", "legacy-migrate", 11, "https://example.test");
    sessionStorage.values.delete("active-recording-index:session-a");
    sessionStorage.values.set("active-recording-index", { secret: SECRET_FORM });
    sessionStorage.reads.length = 0;
    sessionStorage.events.length = 0;

    const restarted = createManager({ sessionStorage });
    await restarted.manager.renewPersistedSessions();

    expect(restarted.transport.requests).toHaveLength(0);
    expect(sessionStorage.values.has("active-recording-index")).toBe(false);
    expect(sessionStorage.values.has("active-recording-index:session-a")).toBe(false);
    expect(sessionStorage.values.has("active-recording:session-a")).toBe(false);
    expect(sessionStorage.reads).not.toContain("active-recording-index");
    expect(sessionStorage.reads).not.toContain("active-recording:session-a");
    expectAbsent({ snapshot: restarted.manager.snapshot(), writes: sessionStorage.writes });
  });

  it("requires a strict matching marker before reading or restoring a snapshot", async () => {
    const sessionStorage = new MemoryStorage();
    const first = createManager({ sessionStorage });
    await first.manager.start("session-a", "orphan", 11, "https://example.test");
    sessionStorage.values.delete("active-recording-index:session-a");
    sessionStorage.reads.length = 0;
    sessionStorage.writes.length = 0;

    const missingMarker = createManager({ sessionStorage });
    await expect(missingMarker.manager.stop("session-a")).rejects.toThrow("NO_ACTIVE_RECORDING");
    expect(sessionStorage.reads).toContain("active-recording-index:session-a");
    expect(sessionStorage.reads).not.toContain("active-recording:session-a");
    expect(sessionStorage.values.has("active-recording:session-a")).toBe(false);
    expect(sessionStorage.writes).toEqual([]);

    const liveStorage = new MemoryStorage();
    const live = createManager({ sessionStorage: liveStorage });
    await live.manager.start("session-a", "live-orphan", 11, "https://example.test");
    liveStorage.values.delete("active-recording-index:session-a");
    liveStorage.writes.length = 0;
    await expect(live.manager.stop("session-a")).rejects.toThrow("NO_ACTIVE_RECORDING");
    expect(liveStorage.values.has("active-recording:session-a")).toBe(false);
    expect(liveStorage.values.has("active-recording-index:session-a")).toBe(false);
    expect(liveStorage.writes).toEqual([]);

    const malformedStorage = new MemoryStorage();
    const malformedFirst = createManager({ sessionStorage: malformedStorage });
    await malformedFirst.manager.start("session-a", "malformed-marker", 11, "https://example.test");
    malformedStorage.values.set("active-recording-index:session-a", {
      sessionId: "session-a",
      status: "active",
      extra: SECRET_FORM,
    });
    malformedStorage.reads.length = 0;
    const malformedMarker = createManager({ sessionStorage: malformedStorage });
    await expect(malformedMarker.manager.restoreSession("session-a")).resolves.toBe(false);
    expect(malformedStorage.reads).not.toContain("active-recording:session-a");
    expect(malformedStorage.values.has("active-recording:session-a")).toBe(false);
    expectAbsent({ writes: malformedStorage.writes, snapshot: malformedMarker.manager.snapshot() });

    const mismatchedStorage = new MemoryStorage();
    const mismatchSource = createManager({ sessionStorage: mismatchedStorage });
    await mismatchSource.manager.start("session-a", "mismatched", 11, "https://example.test");
    const snapshot = mismatchedStorage.values.get("active-recording:session-a") as Record<string, unknown>;
    const recording = snapshot.recording as Record<string, unknown>;
    mismatchedStorage.values.set("active-recording:session-a", {
      ...snapshot,
      status: "stopping",
      recording: { ...recording, stoppedAt: 1_700_000_000_001 },
    });
    mismatchedStorage.reads.length = 0;
    const mismatched = createManager({ sessionStorage: mismatchedStorage });
    await expect(mismatched.manager.restoreSession("session-a")).resolves.toBe(false);
    expect(mismatchedStorage.reads).toContain("active-recording-index:session-a");
    expect(mismatchedStorage.reads).toContain("active-recording:session-a");
    expect(mismatchedStorage.values.has("active-recording:session-a")).toBe(false);
    expect(mismatchedStorage.values.has("active-recording-index:session-a")).toBe(false);

    const markerOnlyStorage = new MemoryStorage();
    markerOnlyStorage.values.set("active-recording-index:session-a", {
      sessionId: "session-a",
      status: "active",
    });
    const markerOnly = createManager({ sessionStorage: markerOnlyStorage });
    await expect(markerOnly.manager.restoreSession("session-a")).resolves.toBe(false);
    expect(markerOnlyStorage.values.has("active-recording-index:session-a")).toBe(false);
  });

  it("deletes restored state that exceeds current limits before renewal", async () => {
    const sessionStorage = new MemoryStorage();
    const first = createManager({ sessionStorage });
    await first.manager.start("session-a", "x".repeat(500), 11, "https://example.test");

    const restarted = createManager({
      sessionStorage,
      limits: { maxSteps: 1_000, maxRecordingBytes: 400, maxAggregateBytes: 50_000 },
    });
    await restarted.manager.renewPersistedSessions();

    expect(restarted.transport.requests).toHaveLength(0);
    expect(sessionStorage.values.has("active-recording:session-a")).toBe(false);
    expect(sessionStorage.values.has("active-recording-index:session-a")).toBe(false);
  });

  it("expires active state on false renewal and deletes stopping state on session closure", async () => {
    const sessionStorage = new MemoryStorage();
    const renewalTransport = new FakeTransport();
    renewalTransport.responses.push({ ok: false });
    const { manager, scheduler } = createManager({ sessionStorage, transport: renewalTransport });
    await manager.start("session-a", "flow", 11, "https://example.test");
    await manager.renewPersistedSessions();
    expect(manager.snapshot().active).toEqual([]);

    const failedTransport = new FakeTransport();
    failedTransport.responses.push(new Error("SERVER_UNAVAILABLE"));
    const stopping = createManager({ sessionStorage, transport: failedTransport });
    await stopping.manager.start("session-b", "close-stopping", 12, "https://example.test");
    await stopping.manager.stop("session-b");
    expect(stopping.manager.snapshot().active).toHaveLength(1);

    await stopping.manager.abortSession("session-b");

    expect(stopping.manager.snapshot().active).toEqual([]);
    expect(sessionStorage.values.has("active-recording:session-b")).toBe(false);
    expect(sessionStorage.values.has("active-recording-index:session-b")).toBe(false);
    expect(sessionStorage.removeManyCalls.at(-1)).toEqual([
      "active-recording:session-b",
      "active-recording-index:session-b",
    ]);
    expect(scheduler.cleared).toBeGreaterThan(0);
  });

  it("persists to the server before creating the local completed copy", async () => {
    const events: string[] = [];
    const transport = new FakeTransport(events);
    const localStorage = new MemoryStorage(events);
    const { manager } = createManager({ transport, localStorage });
    await manager.start("session-a", "flow", 11, "https://example.test");
    await captureType(manager, "session-a", 11, SECRET_TEXT);

    const result = await manager.stop("session-a");

    expect(events.indexOf("transport:persistRecording"))
      .toBeLessThan(events.indexOf("storage:set:recording:flow"));
    expect(result).toMatchObject({ extensionSaved: true, serverSaved: true });
    expectAbsent({ events, requests: transport.requests, result });
  });

  it("does not overwrite a local collision after server acceptance", async () => {
    const localStorage = new MemoryStorage();
    localStorage.values.set("recording:flow", { existing: true });
    const { manager } = createManager({ localStorage });
    await manager.start("session-a", "flow", 11, "https://example.test");

    const result = await manager.stop("session-a");

    expect(result).toMatchObject({
      extensionSaved: false,
      serverSaved: true,
      error: "LOCAL_RECORDING_CONFLICT",
    });
    expect(localStorage.values.get("recording:flow")).toEqual({ existing: true });
    expect(localStorage.reads).not.toContain("recording:flow");
    expect(manager.snapshot().active).toHaveLength(0);
  });

  it("serializes concurrent same-name stops and never overwrites differing content", async () => {
    const localStorage = new MemoryStorage();
    const { manager } = createManager({ localStorage });
    await manager.start("session-a", "shared", 11, "https://example.test/a");
    await manager.start("session-b", "shared", 22, "https://example.test/b");
    await captureType(manager, "session-b", 22, SECRET_TEXT);

    const [first, second] = await Promise.all([
      manager.stop("session-a"),
      manager.stop("session-b"),
    ]);

    expect(first).toMatchObject({ extensionSaved: true, serverSaved: true });
    expect(second).toMatchObject({
      extensionSaved: false,
      serverSaved: true,
      error: "LOCAL_RECORDING_CONFLICT",
    });
    expect(localStorage.values.get("recording:shared")).toEqual(first.recording);
    expect(localStorage.writes.filter((entry) => JSON.stringify(entry).includes("recording:shared")))
      .toHaveLength(1);
    expect(manager.snapshot().active).toEqual([]);
    expectAbsent({ first, second, writes: localStorage.writes, snapshot: manager.snapshot() });
  });

  it("keeps snapshot and marker atomic on cleanup failure, then retries after worker restart", async () => {
    const sessionStorage = new MemoryStorage();
    const localStorage = new MemoryStorage();
    const { manager, transport } = createManager({ sessionStorage, localStorage });
    await manager.start("session-a", "cleanup-key", 11, "https://example.test");
    await captureType(manager, "session-a", 11, SECRET_TEXT);
    sessionStorage.failRemoveMany = new Error(`REMOVE_FAILED_${SECRET_FORM}`);

    const partial = await manager.stop("session-a");
    expect(partial).toMatchObject({
      extensionSaved: true,
      serverSaved: true,
      error: "ACTIVE_STATE_CLEANUP_FAILED",
    });
    expect(manager.snapshot().active).toHaveLength(1);
    expect(sessionStorage.values.has("active-recording:session-a")).toBe(true);
    expect(sessionStorage.values.get("active-recording-index:session-a")).toEqual({
      sessionId: "session-a",
      status: "stopping",
    });
    expect(sessionStorage.removeManyCalls.at(-1)).toEqual([
      "active-recording:session-a",
      "active-recording-index:session-a",
    ]);
    const requestsBeforeTick = transport.requests.length;
    await manager.renewPersistedSessions();
    await manager.expireReservation("session-a");
    expect(transport.requests).toHaveLength(requestsBeforeTick);
    expect(manager.snapshot().active).toHaveLength(1);

    sessionStorage.failRemoveMany = undefined;
    const restarted = createManager({ sessionStorage, localStorage });
    const retried = await restarted.manager.stop("session-a");
    expect(retried).toMatchObject({ extensionSaved: true, serverSaved: true });
    expect(restarted.transport.requests).toEqual([]);
    expect(retried).not.toHaveProperty("error");
    expect(retried.recording).toEqual(partial.recording);
    expect(restarted.manager.snapshot().active).toEqual([]);
    expect(sessionStorage.values.has("active-recording:session-a")).toBe(false);
    expect(sessionStorage.values.has("active-recording-index:session-a")).toBe(false);
    expect(localStorage.writes.filter((entry) => JSON.stringify(entry).includes("recording:cleanup-key")))
      .toHaveLength(1);
    expectAbsent({ partial, retried, storage: sessionStorage.writes, local: localStorage.writes });
  });

  it("treats alarm clearing as best effort after atomic state removal", async () => {
    const sessionStorage = new MemoryStorage();
    const localStorage = new MemoryStorage();
    const scheduler = new FakeScheduler();
    scheduler.failClear = true;
    const { manager } = createManager({ sessionStorage, localStorage, scheduler });
    await manager.start("session-a", "cleanup-alarm", 11, "https://example.test");

    const result = await manager.stop("session-a");
    expect(result).toMatchObject({ extensionSaved: true, serverSaved: true });
    expect(result).not.toHaveProperty("error");
    expect(manager.snapshot().active).toEqual([]);
    expect(sessionStorage.values.has("active-recording:session-a")).toBe(false);
    expect(sessionStorage.values.has("active-recording-index:session-a")).toBe(false);

    const restarted = createManager({ sessionStorage, localStorage });
    await restarted.manager.renewPersistedSessions();
    expect(restarted.transport.requests).toEqual([]);
    expect(restarted.manager.snapshot().active).toEqual([]);
    expect(localStorage.values.get("recording:cleanup-alarm")).toEqual(result.recording);
    expectAbsent({ result, storage: sessionStorage.writes, local: localStorage.writes });
  });

  it("returns sanitized partial status for server and local failures", async () => {
    const serverTransport = new FakeTransport();
    serverTransport.responses.push(new Error(`transport ${SECRET_TEXT}`));
    const serverCase = createManager({ transport: serverTransport });
    await serverCase.manager.start("session-a", "server-failure", 11, "https://example.test");
    await captureType(serverCase.manager, "session-a", 11, SECRET_TEXT);
    const serverResult = await serverCase.manager.stop("session-a");
    expect(serverResult).toMatchObject({
      extensionSaved: false,
      serverSaved: false,
      error: "SERVER_PERSIST_FAILED",
    });
    expect(serverCase.localStorage.writes).toEqual([]);
    expect(serverCase.manager.snapshot().active).toHaveLength(1);

    const localStorage = new MemoryStorage();
    const localCase = createManager({ localStorage });
    await localCase.manager.start("session-b", "local-failure", 22, "https://example.test");
    localStorage.failSet = new Error(`storage ${SECRET_FORM}`);
    const localResult = await localCase.manager.stop("session-b");
    expect(localResult).toMatchObject({
      extensionSaved: false,
      serverSaved: true,
      error: "LOCAL_PERSIST_FAILED",
    });
    expect(localCase.manager.snapshot().active).toHaveLength(0);

    expectAbsent({
      serverResult,
      serverRequests: serverTransport.requests,
      serverSnapshot: serverCase.manager.snapshot(),
      localResult,
      localSnapshot: localCase.manager.snapshot(),
    });
  });

  it("does not expose a local collision-read error", async () => {
    const localStorage = new MemoryStorage();
    const { manager } = createManager({ localStorage });
    await manager.start("session-a", "flow", 11, "https://example.test");
    localStorage.failHas = new Error(`read ${SECRET_TEXT}`);

    const result = await manager.stop("session-a");

    expect(result).toMatchObject({
      extensionSaved: false,
      serverSaved: true,
      error: "LOCAL_PERSIST_FAILED",
    });
    expectAbsent(result);
  });
});
