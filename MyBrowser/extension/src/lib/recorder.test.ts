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
}

class FakeScheduler implements RecordingAlarmScheduler {
  ensured = 0;
  cleared = 0;

  async ensureRenewal(): Promise<void> {
    this.ensured += 1;
  }

  async clearRenewal(): Promise<void> {
    this.cleared += 1;
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

  it("preserves other persisted sessions across cross-session and single-session stops", async () => {
    const sessionStorage = new MemoryStorage();
    const first = createManager({ sessionStorage });
    await first.manager.start("session-a", "alpha", 11, "https://example.test/a");
    await first.manager.start("session-b", "bravo", 22, "https://example.test/b");

    const restarted = createManager({ sessionStorage });
    await expect(restarted.manager.stop("session-c")).rejects.toThrow("NO_ACTIVE_RECORDING");
    expect(sessionStorage.values.get("active-recording-index"))
      .toEqual(["session-a", "session-b"]);

    await restarted.manager.stop("session-a");
    expect(sessionStorage.values.get("active-recording-index")).toEqual(["session-b"]);
    expect(sessionStorage.values.has("active-recording:session-b")).toBe(true);
    expect(restarted.scheduler.cleared).toBe(0);
  });

  it("rejects legacy restart state containing an original sensitive value", async () => {
    const sessionStorage = new MemoryStorage();
    sessionStorage.values.set("active-recording-index", ["session-a"]);
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

    await expect(manager.restoreSession("session-a")).resolves.toBe(false);

    expect(manager.snapshot().active).toEqual([]);
    expect(sessionStorage.values.has("active-recording:session-a")).toBe(false);
    expectAbsent({ snapshot: manager.snapshot(), writes: sessionStorage.writes });
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
    expect(sessionStorage.values.get("active-recording-index")).toEqual([]);
  });

  it("aborts and deletes restart state on expiry or session closure", async () => {
    const { manager, sessionStorage, scheduler } = createManager();
    await manager.start("session-a", "flow", 11, "https://example.test");

    await manager.abortSession("session-a");

    expect(manager.snapshot().active).toEqual([]);
    expect(sessionStorage.values.has("active-recording:session-a")).toBe(false);
    expect(sessionStorage.values.get("active-recording-index")).toEqual([]);
    expect(scheduler.cleared).toBe(1);
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
    expect(manager.snapshot().active).toHaveLength(1);
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
    expect(manager.snapshot().active).toEqual([expect.objectContaining({ sessionId: "session-b" })]);
    expectAbsent({ first, second, writes: localStorage.writes, snapshot: manager.snapshot() });
  });

  it("returns cleanup partial status and retries after active-key removal failure", async () => {
    const sessionStorage = new MemoryStorage();
    const localStorage = new MemoryStorage();
    const { manager } = createManager({ sessionStorage, localStorage });
    await manager.start("session-a", "cleanup-key", 11, "https://example.test");
    await captureType(manager, "session-a", 11, SECRET_TEXT);
    sessionStorage.failRemoveKey = "active-recording:session-a";

    const partial = await manager.stop("session-a");
    expect(partial).toMatchObject({
      extensionSaved: true,
      serverSaved: true,
      error: "ACTIVE_STATE_CLEANUP_FAILED",
    });
    expect(manager.snapshot().active).toHaveLength(1);
    expect(sessionStorage.values.has("active-recording:session-a")).toBe(true);
    expect(sessionStorage.values.get("active-recording-index")).toEqual(["session-a"]);

    sessionStorage.failRemoveKey = undefined;
    const retried = await manager.stop("session-a");
    expect(retried).toMatchObject({ extensionSaved: true, serverSaved: true });
    expect(retried).not.toHaveProperty("error");
    expect(retried.recording).toEqual(partial.recording);
    expect(manager.snapshot().active).toEqual([]);
    expect(sessionStorage.values.has("active-recording:session-a")).toBe(false);
    expect(sessionStorage.values.get("active-recording-index")).toEqual([]);
    expect(localStorage.writes.filter((entry) => JSON.stringify(entry).includes("recording:cleanup-key")))
      .toHaveLength(1);
    expectAbsent({ partial, retried, storage: sessionStorage.writes, local: localStorage.writes });
  });

  it("retries index cleanup idempotently without resurrection or data loss", async () => {
    const sessionStorage = new MemoryStorage();
    const localStorage = new MemoryStorage();
    const { manager } = createManager({ sessionStorage, localStorage });
    await manager.start("session-a", "cleanup-index", 11, "https://example.test");
    sessionStorage.failSetKey = "active-recording-index";
    sessionStorage.failSetKeyOnCall = 3;

    const partial = await manager.stop("session-a");
    expect(partial).toMatchObject({
      extensionSaved: true,
      serverSaved: true,
      error: "ACTIVE_STATE_CLEANUP_FAILED",
    });
    expect(manager.snapshot().active).toHaveLength(1);
    expect(sessionStorage.values.has("active-recording:session-a")).toBe(false);
    expect(sessionStorage.values.get("active-recording-index")).toEqual(["session-a"]);

    sessionStorage.failSetKey = undefined;
    sessionStorage.failSetKeyOnCall = undefined;
    const retried = await manager.stop("session-a");
    expect(retried.recording).toEqual(partial.recording);
    expect(retried).not.toHaveProperty("error");
    expect(manager.snapshot().active).toEqual([]);

    const restarted = createManager({ sessionStorage, localStorage });
    await restarted.manager.renewPersistedSessions();
    expect(restarted.transport.requests).toEqual([]);
    expect(restarted.manager.snapshot().active).toEqual([]);
    expect(localStorage.values.get("recording:cleanup-index")).toEqual(retried.recording);
    expectAbsent({ partial, retried, storage: sessionStorage.writes, local: localStorage.writes });
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
    expect(localCase.manager.snapshot().active).toHaveLength(1);

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
