import { afterEach, describe, expect, it, vi } from "vitest";

import { getRecentExtensionIssues } from "./diagnostics";
import { reportToolFailure } from "./background-privacy";
import { MAX_RECORDED_URL_LENGTH, validateSanitizedArgs } from "./recording-parameterizer";
import { RECORDING_NUMERIC_BOUNDS } from "./tool-metadata";

import {
  MAX_ACTIVE_RECORDING_BYTES,
  MAX_ACTIVE_RECORDING_STEPS,
  MAX_AGGREGATE_RECORDING_BYTES,
  MAX_CHROME_TAB_ID,
  MAX_RECORDED_DURATION_MS,
  MAX_RECORDING_TIMESTAMP_MS,
  MAX_REQUIRED_VARIABLES,
  RECORDING_RENEWAL_ALARM,
  ChromeRecordingAlarmScheduler,
  isSanitizedRecording,
  listRecordingsFromStorage,
  loadRecordingForReplay,
  loadRecordingFromStorage,
  recordingCleanupAlarmName,
  recordingCleanupSessionId,
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

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
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
  failGetKeys: Error | undefined;
  failGetBytesInUse: Error | undefined;
  failHas: Error | undefined;
  failSetKey: string | undefined;
  failSetKeyOnCall: number | undefined;
  failSetManyOnCall: number | undefined;
  readonly failSetManyOnCalls = new Set<number>();
  failRemoveKey: string | undefined;
  failRemoveMany: Error | undefined;
  readonly removeManyCalls: string[][] = [];
  readonly getBytesInUseCalls: string[][] = [];
  bytesInUseOverride: number | undefined;
  private readonly setCounts = new Map<string, number>();
  private setManyCount = 0;

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
    if (this.failGetKeys) throw this.failGetKeys;
    return [...this.values.keys()];
  }

  async getBytesInUse(keys: string[]): Promise<number> {
    this.getBytesInUseCalls.push([...keys]);
    if (this.failGetBytesInUse) throw this.failGetBytesInUse;
    if (this.bytesInUseOverride !== undefined) return this.bytesInUseOverride;
    const encoder = new TextEncoder();
    return keys.reduce((total, key) => {
      const value = this.values.get(key);
      return value === undefined
        ? total
        : total + encoder.encode(JSON.stringify({ [key]: value })).byteLength;
    }, 0);
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
    this.setManyCount += 1;
    const entries = Object.entries(values);
    if (this.failSet || this.failSetManyOnCall === this.setManyCount
      || this.failSetManyOnCalls.has(this.setManyCount)
      || entries.some(([key]) => this.failSetKey === key)) {
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
  cleanupEnsured = 0;
  cleanupCleared = 0;
  failClear = false;
  failCleanupEnsure: Error | undefined;
  readonly cleanupSessions = new Set<string>();

  async ensureRenewal(): Promise<void> {
    this.ensured += 1;
  }

  async clearRenewal(): Promise<void> {
    this.cleared += 1;
    if (this.failClear) throw new Error("ALARM_CLEAR_FAILED");
  }

  async ensureCleanup(sessionId: string): Promise<void> {
    this.cleanupEnsured += 1;
    if (this.failCleanupEnsure) throw this.failCleanupEnsure;
    this.cleanupSessions.add(sessionId);
  }

  async clearCleanup(sessionId: string): Promise<void> {
    this.cleanupCleared += 1;
    this.cleanupSessions.delete(sessionId);
  }

  async getCleanupSessionIds(): Promise<string[]> {
    return [...this.cleanupSessions].sort();
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

const AGGREGATE_BOUNDARY_ELEMENT = "x".repeat(8_000);

async function minimumAggregateLimitForPreparedStep(sessionCount = 1): Promise<number> {
  let lower = 1;
  let upper = 100_000;
  while (lower < upper) {
    const candidate = Math.floor((lower + upper) / 2);
    const { manager } = createManager({
      limits: { maxSteps: 1_000, maxRecordingBytes: 70_000, maxAggregateBytes: candidate },
    });
    let fits = true;
    try {
      for (let index = 0; index < sessionCount; index += 1) {
        await manager.start(
          `session-${index}`,
          `flow-${index}`,
          index + 1,
          "https://example.test",
        );
      }
      await manager.prepareStep(
        "session-0",
        "browser_click",
        { element: AGGREGATE_BOUNDARY_ELEMENT },
        1,
      );
    } catch {
      fits = false;
    }
    if (fits) upper = candidate;
    else lower = candidate + 1;
  }
  return lower;
}

async function minimumAggregateLimitForStarts(sessionCount: number): Promise<number> {
  let lower = 1;
  let upper = 100_000;
  while (lower < upper) {
    const candidate = Math.floor((lower + upper) / 2);
    const { manager } = createManager({
      limits: { maxSteps: 1_000, maxRecordingBytes: 70_000, maxAggregateBytes: candidate },
    });
    let fits = true;
    try {
      for (let index = 0; index < sessionCount; index += 1) {
        await manager.start(
          `session-${index}`,
          `flow-${index}`,
          index + 1,
          "https://example.test",
        );
      }
    } catch {
      fits = false;
    }
    if (fits) upper = candidate;
    else lower = candidate + 1;
  }
  return lower;
}

function serializedStorageValueBytes(storage: MemoryStorage): number {
  const encoder = new TextEncoder();
  return [...storage.values.values()].reduce<number>(
    (total, value) => total + encoder.encode(JSON.stringify(value)).byteLength,
    0,
  );
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

describe("ChromeRecordingAlarmScheduler", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubAlarms(
    createAlarm: (name: string, info: chrome.alarms.AlarmCreateInfo) => Promise<void>,
  ) {
    const create = vi.fn(createAlarm);
    const clear = vi.fn(async () => true);
    const getAll = vi.fn(async () => [] as chrome.alarms.Alarm[]);
    vi.stubGlobal("chrome", { alarms: { create, clear, getAll } });
    return { create, clear };
  }

  function concreteManager(
    sessionStorage: MemoryStorage,
    transport = new FakeTransport(),
  ): RecordingManager {
    return new RecordingManager({
      sessionStorage,
      localStorage: new MemoryStorage(),
      transport,
      scheduler: new ChromeRecordingAlarmScheduler(),
      now: () => 1_700_000_000_000,
    });
  }

  it("does not enter queued cleanup until Chrome confirms alarm creation", async () => {
    const sessionStorage = new MemoryStorage();
    const seeded = createManager({ sessionStorage });
    await seeded.manager.start("session-a", "delayed-alarm", 11, "https://example.test");
    sessionStorage.reads.length = 0;
    const created = deferred<void>();
    let firstCleanup = true;
    const alarms = stubAlarms((name) => {
      if (name === recordingCleanupAlarmName("session-a") && firstCleanup) {
        firstCleanup = false;
        return created.promise;
      }
      return Promise.resolve();
    });
    const manager = concreteManager(sessionStorage);

    const closing = manager.abortSession("session-a");
    let settled = false;
    void closing.then(() => { settled = true; });
    await Promise.resolve();
    await Promise.resolve();

    expect(alarms.create).toHaveBeenCalledWith(
      "recording-cleanup:session-a",
      { periodInMinutes: 1 },
    );
    expect(sessionStorage.reads).toEqual([]);
    expect(settled).toBe(false);

    created.resolve();
    await closing;
    expect(sessionStorage.values.has("active-recording:session-a")).toBe(false);
    expect(alarms.clear).toHaveBeenCalledWith("recording-cleanup:session-a");
  });

  it("waits for rejected Chrome alarm creation before continuing stable cleanup", async () => {
    const sessionStorage = new MemoryStorage();
    const seeded = createManager({ sessionStorage });
    await seeded.manager.start("session-a", "rejected-alarm", 11, "https://example.test");
    sessionStorage.reads.length = 0;
    const created = deferred<void>();
    void created.promise.catch(() => undefined);
    let firstCleanup = true;
    stubAlarms((name) => {
      if (name === recordingCleanupAlarmName("session-a") && firstCleanup) {
        firstCleanup = false;
        return created.promise;
      }
      return Promise.resolve();
    });
    const manager = concreteManager(sessionStorage);

    const closing = manager.abortSession("session-a");
    await Promise.resolve();
    await Promise.resolve();
    expect(sessionStorage.reads).toEqual([]);

    created.reject(new Error(`ALARM_EXPOSED_${SECRET_TEXT}`));
    await expect(closing).resolves.toBeUndefined();
    expect(sessionStorage.values.has("active-recording:session-a")).toBe(false);
  });

  it("keeps resolved cleanup authority while an earlier queued transport is blocked", async () => {
    const sessionStorage = new MemoryStorage();
    const seeded = createManager({ sessionStorage });
    await seeded.manager.start("session-a", "blocked-queue", 11, "https://example.test");
    const renewal = deferred<unknown>();
    const transport = new FakeTransport();
    transport.responses.push(renewal.promise);
    const alarms = stubAlarms(async () => undefined);
    const manager = concreteManager(sessionStorage, transport);

    const renewing = manager.renewPersistedSessions();
    await vi.waitFor(() => expect(transport.requests).toHaveLength(1));
    const closing = manager.abortSession("session-a");
    await vi.waitFor(() => expect(alarms.create).toHaveBeenCalledWith(
      "recording-cleanup:session-a",
      { periodInMinutes: 1 },
    ));
    expect(sessionStorage.values.has("active-recording:session-a")).toBe(true);

    renewal.resolve({ ok: true });
    await renewing;
    await closing;
    expect(sessionStorage.values.has("active-recording:session-a")).toBe(false);
    expect(alarms.clear).toHaveBeenCalledWith("recording-cleanup:session-a");
  });

  it("propagates renewal creation rejection so start rolls back persisted state", async () => {
    const sessionStorage = new MemoryStorage();
    const rejected = Promise.reject(new Error(`RENEWAL_EXPOSED_${SECRET_FORM}`));
    void rejected.catch(() => undefined);
    stubAlarms((name) => name === RECORDING_RENEWAL_ALARM ? rejected : Promise.resolve());
    const manager = concreteManager(sessionStorage);

    await expect(manager.start(
      "session-a", "renewal-rejection", 11, "https://example.test",
    )).rejects.toThrow("SCHEDULE_RENEWAL_FAILED");
    expect(manager.snapshot().active).toEqual([]);
    expect(sessionStorage.values.has("active-recording:session-a")).toBe(false);
    expect(sessionStorage.values.has("active-recording-index:session-a")).toBe(false);
  });
});

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

    expect(message).toBe("RECORDED_STATE_FAILED");
    expect(manager.snapshot().active).toEqual([]);
    expect(sessionStorage.values.has("active-recording:session-a")).toBe(false);
    expect(sessionStorage.values.has("active-recording-index:session-a")).toBe(false);
    expect(scheduler.ensured).toBe(0);
    expect(scheduler.cleanupEnsured).toBeGreaterThan(0);
    expect(scheduler.cleanupCleared).toBeGreaterThan(0);
    expectAbsent({ message, snapshot: manager.snapshot() });
  });

  it("keeps failed-start cleanup counted across restart until removal succeeds", async () => {
    const maxAggregateBytes = await minimumAggregateLimitForStarts(1);
    const sessionStorage = new MemoryStorage();
    sessionStorage.failSetManyOnCall = 1;
    sessionStorage.failRemoveMany = new Error("REMOVE_FAILED");
    const scheduler = new FakeScheduler();
    const current = createManager({
      sessionStorage,
      scheduler,
      limits: { maxAggregateBytes },
    });

    await expect(current.manager.start(
      "session-0", "flow-0", 1, "https://example.test",
    )).rejects.toThrow("RECORDED_STATE_FAILED");
    expect(current.manager.snapshot().active).toEqual([]);
    expect(scheduler.cleanupSessions.has("session-0")).toBe(true);
    expect((sessionStorage.values.get("active-recording:session-0") as {
      status?: string;
    }).status).toBe("cleanup");

    const restarted = createManager({
      sessionStorage,
      scheduler,
      limits: { maxAggregateBytes },
    });
    await expect(restarted.manager.start(
      "session-1", "flow-1", 2, "https://example.test",
    )).rejects.toThrow("RECORDING_STATE_LIMIT");

    sessionStorage.failRemoveMany = undefined;
    await restarted.manager.retryCleanupSession("session-0");
    await expect(restarted.manager.start(
      "session-1", "flow-1", 2, "https://example.test",
    )).resolves.toBeUndefined();
    expect(scheduler.cleanupSessions.has("session-0")).toBe(false);
  });

  it("falls back to persisted cleanup when failed-start alarm creation rejects", async () => {
    const sessionStorage = new MemoryStorage();
    sessionStorage.failSetManyOnCall = 1;
    sessionStorage.failRemoveMany = new Error("REMOVE_FAILED");
    const scheduler = new FakeScheduler();
    scheduler.failCleanupEnsure = new Error(`ALARM_EXPOSED_${SECRET_FORM}`);
    const current = createManager({ sessionStorage, scheduler });

    await expect(current.manager.start(
      "session-a", "alarm-fallback", 11, "https://example.test",
    )).rejects.toThrow("RECORDED_STATE_FAILED");
    expect(scheduler.cleanupSessions.has("session-a")).toBe(false);
    expect((sessionStorage.values.get("active-recording:session-a") as {
      status?: string;
    }).status).toBe("cleanup");

    sessionStorage.failRemoveMany = undefined;
    scheduler.failCleanupEnsure = undefined;
    const restarted = createManager({ sessionStorage, scheduler });
    await restarted.manager.retryCleanupStates();
    expect(restarted.manager.snapshot().active).toEqual([]);
    expect(sessionStorage.values.has("active-recording:session-a")).toBe(false);
    expect(sessionStorage.values.has("active-recording-index:session-a")).toBe(false);
    expect(current.transport.requests).toEqual([]);
  });

  it("keeps an in-memory cleanup fallback when both durable rollback mechanisms fail", async () => {
    const maxAggregateBytes = await minimumAggregateLimitForStarts(1);
    const sessionStorage = new MemoryStorage();
    sessionStorage.failSetManyOnCalls.add(1);
    sessionStorage.failSetManyOnCalls.add(2);
    sessionStorage.failRemoveMany = new Error("REMOVE_FAILED");
    const scheduler = new FakeScheduler();
    scheduler.failCleanupEnsure = new Error("ALARM_FAILED");
    const context = createManager({
      sessionStorage,
      scheduler,
      limits: { maxSteps: 1_000, maxRecordingBytes: 70_000, maxAggregateBytes },
    });

    await expect(context.manager.start(
      "session-0", "flow-0", 1, "https://example.test",
    )).rejects.toThrow("RECORDED_STATE_FAILED");
    expect(sessionStorage.values.size).toBe(0);
    expect(scheduler.cleanupSessions.size).toBe(0);
    expect(sessionStorage.removeManyCalls).toHaveLength(1);
    await expect(context.manager.start(
      "session-1", "flow-1", 2, "https://example.test",
    )).rejects.toThrow("RECORDING_STATE_LIMIT");
    const attemptsBeforeKeepalive = sessionStorage.removeManyCalls.length;

    sessionStorage.failRemoveMany = undefined;
    scheduler.failCleanupEnsure = undefined;
    await context.manager.retryCleanupStates();
    expect(sessionStorage.removeManyCalls).toHaveLength(attemptsBeforeKeepalive + 1);
    await expect(context.manager.start(
      "session-1", "flow-1", 2, "https://example.test",
    )).resolves.toBeUndefined();
  });

  it("accounts and retries a fresh markerless snapshot without reading its contents", async () => {
    const sessionStorage = new MemoryStorage();
    sessionStorage.values.set("active-recording:session-a", {
      untrusted: "snapshot contents must not be read",
    });
    sessionStorage.bytesInUseOverride = MAX_AGGREGATE_RECORDING_BYTES - 1;
    sessionStorage.failRemoveMany = new Error("REMOVE_FAILED");
    const context = createManager({ sessionStorage });

    await context.manager.retryCleanupStates();
    expect(sessionStorage.reads).not.toContain("active-recording:session-a");
    expect(sessionStorage.getBytesInUseCalls).toContainEqual([
      "active-recording-index:session-a",
      "active-recording:session-a",
    ]);
    await expect(context.manager.start(
      "session-b", "blocked-by-orphan", 2, "https://example.test/b",
    )).rejects.toThrow("RECORDING_STATE_LIMIT");

    sessionStorage.failRemoveMany = undefined;
    await context.manager.retryCleanupStates();
    expect(sessionStorage.values.has("active-recording:session-a")).toBe(false);
    await expect(context.manager.start(
      "session-b", "after-orphan", 2, "https://example.test/b",
    )).resolves.toBeUndefined();
  });

  it("blocks same-session start during first markerless discovery and never deletes replacement state", async () => {
    const sessionStorage = new MemoryStorage();
    const orphan = { partial: "unknown failed write" };
    sessionStorage.values.set("active-recording:session-a", orphan);
    sessionStorage.failRemoveMany = new Error("REMOVE_FAILED");
    const context = createManager({ sessionStorage });

    await expect(context.manager.start(
      "session-a", "must-not-overwrite", 11, "https://example.test",
    )).rejects.toThrow("ACTIVE_RECORDING_EXISTS");
    expect(sessionStorage.values.get("active-recording:session-a")).toEqual(orphan);
    expect(sessionStorage.values.has("active-recording-index:session-a")).toBe(false);

    sessionStorage.failRemoveMany = undefined;
    await context.manager.retryCleanupStates();
    await expect(context.manager.start(
      "session-a", "replacement", 11, "https://example.test",
    )).resolves.toBeUndefined();
    const replacement = clone(sessionStorage.values.get("active-recording:session-a"));
    await context.manager.retryCleanupStates();
    expect(sessionStorage.values.get("active-recording:session-a")).toEqual(replacement);
    expect(sessionStorage.values.has("active-recording-index:session-a")).toBe(true);
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

  it("loads valid completed recordings without deleting them and deletes invalid ones", async () => {
    const storage = new MemoryStorage();
    const valid = {
      name: "saved-valid",
      startedAt: 1,
      stoppedAt: 2,
      url: "https://example.test/path",
      steps: [{
        action: "browser_go_back",
        args: {},
        timestamp: 1,
        durationMs: 0,
        url: "https://example.test/path",
      }],
      requiredVariables: [],
    };
    storage.values.set("recording:saved-valid", valid);

    await expect(loadRecordingFromStorage("saved-valid", storage)).resolves.toEqual(valid);
    expect(storage.values.get("recording:saved-valid")).toEqual(valid);

    storage.values.set("recording:saved-invalid", {
      ...valid,
      name: "saved-invalid",
      startedAt: -1,
    });
    await expect(loadRecordingFromStorage("saved-invalid", storage)).resolves.toBeNull();
    expect(storage.values.has("recording:saved-invalid")).toBe(false);

    storage.values.set("recording:canonical_name", { ...valid, name: "different_name" });
    await expect(loadRecordingFromStorage("canonical name", storage)).resolves.toBeNull();
    expect(storage.values.has("recording:canonical_name")).toBe(false);
  });

  it("lists only strict current recordings as compatible without deleting or exposing invalid data", async () => {
    const storage = new MemoryStorage();
    vi.spyOn(storage, "get").mockImplementation(async <T>(key: string) => (
      storage.values.get(key) as T | undefined
    ));
    const valid = {
      name: "safe-flow",
      startedAt: 1,
      stoppedAt: 2,
      url: "https://example.test/path",
      steps: [{
        action: "browser_go_back",
        args: {},
        timestamp: 1,
        durationMs: 0,
        url: "https://example.test/path",
      }],
      requiredVariables: [],
    };
    const unreadArgs = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(unreadArgs, "secret", {
      enumerable: true,
      get: () => { throw new Error(SECRET_TEXT); },
    });
    storage.values.set("recording:safe-flow", valid);
    storage.values.set("recording:action-precedence", {
      name: "different-name",
      steps: [
        { action: 42, args: {} },
        { action: "browser_new_tab", args: unreadArgs },
      ],
    });
    storage.values.set("recording:canary-args", {
      ...valid,
      name: "canary-args",
      steps: [{ ...valid.steps[0], args: unreadArgs }],
    });
    storage.values.set("recording:key-mismatch", { ...valid, name: "different-name" });
    storage.values.set("recording:malformed-envelope", {
      name: "malformed-envelope",
      steps: [{ action: "browser_go_back", args: {} }],
    });
    storage.values.set("recording:malformed-step", {
      ...valid,
      name: "malformed-step",
      steps: [{ ...valid.steps[0], timestamp: -1 }],
    });

    const entries = await listRecordingsFromStorage(storage);
    expect(entries).toEqual([
      {
        name: "action-precedence",
        compatible: false,
        reason: "RECORDING_UNSUPPORTED_MULTI_TAB",
      },
      { name: "canary-args", compatible: false, reason: "RECORDING_INVALID" },
      { name: "key-mismatch", compatible: false, reason: "RECORDING_INVALID" },
      { name: "malformed-envelope", compatible: false, reason: "RECORDING_INVALID" },
      { name: "malformed-step", compatible: false, reason: "RECORDING_INVALID" },
      { name: "safe-flow", compatible: true },
    ]);
    expectAbsent(entries);
    expect(storage.values.has("recording:action-precedence")).toBe(true);
    expect(storage.values.has("recording:canary-args")).toBe(true);
    expect(storage.values.has("recording:key-mismatch")).toBe(true);
    expect(storage.values.has("recording:malformed-envelope")).toBe(true);
    expect(storage.values.has("recording:malformed-step")).toBe(true);
  });

  it("rejects legacy multi-tab replay loading without transporting or deleting its args", async () => {
    const storage = new MemoryStorage();
    vi.spyOn(storage, "get").mockImplementation(async <T>(key: string) => (
      storage.values.get(key) as T | undefined
    ));
    const unreadArgs = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(unreadArgs, "secret", {
      enumerable: true,
      get: () => { throw new Error(SECRET_TEXT); },
    });
    const legacy = {
      name: "legacy-tabs",
      steps: [{ action: "browser_new_tab", args: unreadArgs }],
    };
    storage.values.set("recording:legacy-tabs", legacy);

    await expect(loadRecordingForReplay("legacy-tabs", storage)).rejects.toThrowError(
      "RECORDING_UNSUPPORTED_MULTI_TAB",
    );
    expect(storage.values.get("recording:legacy-tabs")).toBe(legacy);
  });

  it("uses canonical names for active/completed state and rejects local aliases at start", async () => {
    const localStorage = new MemoryStorage();
    const canonical = createManager({ localStorage });
    await canonical.manager.start("session-a", "Checkout Flow", 11, "https://example.test");
    expect(canonical.manager.snapshot().active[0]?.recording.name).toBe("Checkout_Flow");
    const stopped = await canonical.manager.stop("session-a");
    expect(stopped.recording.name).toBe("Checkout_Flow");
    expect(localStorage.values.get("recording:Checkout_Flow")).toEqual(stopped.recording);

    const conflict = createManager({ localStorage });
    await expect(conflict.manager.start(
      "session-b",
      "Checkout Flow",
      12,
      "https://example.test",
    )).rejects.toThrow("COMPLETED_RECORDING_EXISTS");
    expect(conflict.manager.snapshot().active).toEqual([]);
    expect(conflict.sessionStorage.values.has("active-recording:session-b")).toBe(false);
  });

  it("isolates simultaneous sessions, bound tabs, and replay suppression", async () => {
    const { manager } = createManager();
    await manager.start("session-a", "alpha", 11, `https://example.test/a?token=${SECRET_URL}`);
    await manager.start("session-b", "bravo", 22, "https://example.test/b");

    expect(await manager.prepareStep("session-a", "browser_type", { text: SECRET_TEXT }, 99))
      .toBeNull();
    const firstReplay = manager.beginReplay("session-a");
    const secondReplay = manager.beginReplay("session-a");
    const otherSessionReplay = manager.beginReplay("session-b");
    expect(await manager.prepareStep("session-a", "browser_type", { text: SECRET_TEXT }, 11))
      .toBeNull();
    expect(await manager.prepareStep("session-b", "browser_type", { text: SECRET_TEXT }, 22))
      .toBeNull();

    manager.endReplay("session-a", firstReplay);
    manager.endReplay("session-a", firstReplay);
    manager.endReplay("session-a", otherSessionReplay);
    expect(await manager.prepareStep("session-a", "browser_type", { text: SECRET_TEXT }, 11))
      .toBeNull();

    manager.endReplay("session-a", secondReplay);
    expect(await manager.prepareStep("session-a", "browser_type", { text: SECRET_TEXT }, 11))
      .not.toBeNull();
    expect(await manager.prepareStep("session-b", "browser_type", { text: SECRET_TEXT }, 22))
      .toBeNull();
    manager.endReplay("session-b", otherSessionReplay);
    expect(await manager.prepareStep("session-b", "browser_type", { text: SECRET_TEXT }, 22))
      .not.toBeNull();

    await expect(manager.stop("session-c")).rejects.toThrow("NO_ACTIVE_RECORDING");
    expectAbsent(manager.snapshot());
  });

  it("preserves two cross-tab replay tokens across stop and replacement recording", async () => {
    const { manager } = createManager();
    await manager.start("session-a", "first-flow", 11, "https://example.test/first");
    const firstTabReplay = manager.beginReplay("session-a");
    const secondTabReplay = manager.beginReplay("session-a");

    await expect(manager.stop("session-a")).resolves.toMatchObject({
      extensionSaved: true,
      serverSaved: true,
    });
    expect(manager.snapshot().replayingSessions).toEqual(["session-a"]);
    await manager.start("session-a", "replacement-flow", 22, "https://example.test/replacement");
    expect(await manager.prepareStep("session-a", "browser_type", { text: SECRET_TEXT }, 22))
      .toBeNull();

    manager.endReplay("session-a", firstTabReplay);
    expect(await manager.prepareStep("session-a", "browser_type", { text: SECRET_TEXT }, 22))
      .toBeNull();
    manager.endReplay("session-a", secondTabReplay);
    expect(await manager.prepareStep("session-a", "browser_type", { text: SECRET_TEXT }, 22))
      .not.toBeNull();
  });

  it("preserves replay tokens through hidden cleanup and its retry", async () => {
    const { manager, sessionStorage } = createManager();
    await manager.start("session-a", "cleanup-flow", 11, "https://example.test/cleanup");
    const firstTabReplay = manager.beginReplay("session-a");
    const secondTabReplay = manager.beginReplay("session-a");
    sessionStorage.failRemoveMany = new Error("REMOVE_FAILED");

    await expect(manager.stop("session-a")).resolves.toMatchObject({
      error: "ACTIVE_STATE_CLEANUP_FAILED",
    });
    expect(manager.snapshot().replayingSessions).toEqual(["session-a"]);
    await expect(manager.start(
      "session-a",
      "blocked-during-cleanup",
      22,
      "https://example.test/blocked",
    )).rejects.toThrow("ACTIVE_RECORDING_EXISTS");

    sessionStorage.failRemoveMany = undefined;
    await manager.retryCleanupStates();
    expect(manager.snapshot().replayingSessions).toEqual(["session-a"]);
    await manager.start("session-a", "after-cleanup", 22, "https://example.test/after");
    expect(await manager.prepareStep("session-a", "browser_type", { text: SECRET_TEXT }, 22))
      .toBeNull();
    manager.endReplay("session-a", firstTabReplay);
    expect(await manager.prepareStep("session-a", "browser_type", { text: SECRET_TEXT }, 22))
      .toBeNull();
    manager.endReplay("session-a", secondTabReplay);
    expect(await manager.prepareStep("session-a", "browser_type", { text: SECRET_TEXT }, 22))
      .not.toBeNull();
  });

  it("preserves replay tokens through failed-start rollback", async () => {
    const sessionStorage = new MemoryStorage();
    sessionStorage.failSetManyOnCall = 1;
    const { manager } = createManager({ sessionStorage });
    const firstTabReplay = manager.beginReplay("session-a");
    const secondTabReplay = manager.beginReplay("session-a");

    await expect(manager.start(
      "session-a",
      "failed-start",
      11,
      "https://example.test/failed",
    )).rejects.toThrow("RECORDED_STATE_FAILED");
    expect(manager.snapshot().replayingSessions).toEqual(["session-a"]);

    sessionStorage.failSetManyOnCall = undefined;
    await manager.start("session-a", "retry-start", 22, "https://example.test/retry");
    expect(await manager.prepareStep("session-a", "browser_type", { text: SECRET_TEXT }, 22))
      .toBeNull();
    manager.endReplay("session-a", firstTabReplay);
    expect(await manager.prepareStep("session-a", "browser_type", { text: SECRET_TEXT }, 22))
      .toBeNull();
    manager.endReplay("session-a", secondTabReplay);
    expect(await manager.prepareStep("session-a", "browser_type", { text: SECRET_TEXT }, 22))
      .not.toBeNull();
  });

  it("preserves replay tokens through reservation expiry cleanup", async () => {
    const { manager } = createManager();
    await manager.start("session-a", "expiring-flow", 11, "https://example.test/expiring");
    const firstTabReplay = manager.beginReplay("session-a");
    const secondTabReplay = manager.beginReplay("session-a");

    await manager.expireReservation("session-a", "expiring-flow");
    expect(manager.snapshot().replayingSessions).toEqual(["session-a"]);
    await manager.start("session-a", "after-expiry", 22, "https://example.test/after");
    expect(await manager.prepareStep("session-a", "browser_type", { text: SECRET_TEXT }, 22))
      .toBeNull();
    manager.endReplay("session-a", firstTabReplay);
    expect(await manager.prepareStep("session-a", "browser_type", { text: SECRET_TEXT }, 22))
      .toBeNull();
    manager.endReplay("session-a", secondTabReplay);
    expect(await manager.prepareStep("session-a", "browser_type", { text: SECRET_TEXT }, 22))
      .not.toBeNull();
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

  it("keeps pending aggregate headroom unavailable to another session until commit", async () => {
    const maxAggregateBytes = await minimumAggregateLimitForPreparedStep();
    const context = createManager({
      limits: { maxSteps: 1_000, maxRecordingBytes: 70_000, maxAggregateBytes },
    });
    await context.manager.start("session-0", "flow-0", 1, "https://example.test");
    const prepared = await context.manager.prepareStep(
      "session-0",
      "browser_click",
      { element: AGGREGATE_BOUNDARY_ELEMENT },
      1,
    );

    await expect(context.manager.start(
      "session-b", "flow-b", 2, "https://example.test/b",
    )).rejects.toThrow("RECORDING_STATE_LIMIT");
    await context.manager.commitStep("session-0", prepared!, {
      durationMs: 0.0000012345678901234567,
      currentUrl: `https://example.test/${"a".repeat(MAX_RECORDED_URL_LENGTH)}`,
    });
    expect(serializedStorageValueBytes(context.sessionStorage)).toBeLessThanOrEqual(maxAggregateBytes);
  });

  it("rejects restore promotion that would consume another session's pending reservation", async () => {
    const maxAggregateBytes = await minimumAggregateLimitForPreparedStep();
    const sessionStorage = new MemoryStorage();
    const context = createManager({
      sessionStorage,
      limits: { maxSteps: 1_000, maxRecordingBytes: 70_000, maxAggregateBytes },
    });
    await context.manager.start("session-0", "flow-0", 1, "https://example.test");
    await context.manager.prepareStep(
      "session-0",
      "browser_click",
      { element: AGGREGATE_BOUNDARY_ELEMENT },
      1,
    );
    sessionStorage.values.set("active-recording:session-b", {
      sessionId: "session-b",
      tabId: 2,
      nextVariable: 1,
      status: "active",
      recording: {
        name: "flow-b",
        startedAt: 1_700_000_000_000,
        url: "https://example.test/b",
        steps: [],
        requiredVariables: [],
      },
    });
    sessionStorage.values.set("active-recording-index:session-b", {
      sessionId: "session-b",
      status: "active",
    });

    await expect(context.manager.restoreSession("session-b")).resolves.toBe(false);
    expect(sessionStorage.values.has("active-recording:session-b")).toBe(false);
    expect(context.manager.snapshot().active.map((state) => state.sessionId)).toEqual(["session-0"]);
  });

  it("releases aggregate headroom when a prepared step is discarded", async () => {
    const maxAggregateBytes = await minimumAggregateLimitForPreparedStep();
    const { manager } = createManager({
      limits: { maxSteps: 1_000, maxRecordingBytes: 70_000, maxAggregateBytes },
    });
    await manager.start("session-0", "flow-0", 1, "https://example.test");
    const prepared = await manager.prepareStep(
      "session-0",
      "browser_click",
      { element: AGGREGATE_BOUNDARY_ELEMENT },
      1,
    );
    await expect(manager.start("session-b", "flow-b", 2, "https://example.test/b"))
      .rejects.toThrow("RECORDING_STATE_LIMIT");

    await manager.discardStep("session-0", prepared!);
    await expect(manager.start("session-b", "flow-b", 2, "https://example.test/b"))
      .resolves.toBeUndefined();
  });

  it("serializes simultaneous aggregate reservations so only one consumes the remainder", async () => {
    const maxAggregateBytes = await minimumAggregateLimitForPreparedStep(2);
    const { manager } = createManager({
      limits: { maxSteps: 1_000, maxRecordingBytes: 70_000, maxAggregateBytes },
    });
    await manager.start("session-0", "flow-0", 1, "https://example.test");
    await manager.start("session-1", "flow-1", 2, "https://example.test");

    const outcomes = await Promise.allSettled([
      manager.prepareStep(
        "session-0", "browser_click", { element: AGGREGATE_BOUNDARY_ELEMENT }, 1,
      ),
      manager.prepareStep(
        "session-1", "browser_click", { element: AGGREGATE_BOUNDARY_ELEMENT }, 2,
      ),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
  });

  it("reserves worst-case stop metadata for every active recording", async () => {
    const sessionCount = 20;
    const maxAggregateBytes = await minimumAggregateLimitForStarts(sessionCount);
    const transport = new FakeTransport();
    transport.responses.push(...Array.from(
      { length: sessionCount },
      () => new Error("SERVER_UNAVAILABLE"),
    ));
    const context = createManager({
      transport,
      limits: { maxSteps: 1_000, maxRecordingBytes: 70_000, maxAggregateBytes },
    });
    for (let index = 0; index < sessionCount; index += 1) {
      await context.manager.start(
        `session-${index}`,
        `flow-${index}`,
        index + 1,
        "https://example.test",
      );
    }

    for (let index = 0; index < sessionCount; index += 1) {
      const result = await context.manager.stop(`session-${index}`);
      expect(result.error).toBe("SERVER_PERSIST_FAILED");
    }
    expect(serializedStorageValueBytes(context.sessionStorage)).toBeLessThanOrEqual(maxAggregateBytes);
  });

  it("guarantees a prepared 2 MiB boundary step fits fractional commit metadata", async () => {
    const probe = createManager({
      limits: {
        maxSteps: MAX_ACTIVE_RECORDING_STEPS,
        maxRecordingBytes: MAX_ACTIVE_RECORDING_BYTES + 100_000,
        maxAggregateBytes: MAX_AGGREGATE_RECORDING_BYTES,
      },
    });
    await probe.manager.start("session-probe", "boundary", 11, "https://example.test");
    const empty = await probe.manager.prepareStep(
      "session-probe", "browser_click", { element: "" }, 11,
    );
    const emptyCeiling = (empty as unknown as { finalReservedBytes?: number }).finalReservedBytes;
    expect(emptyCeiling).toBeTypeOf("number");
    await probe.manager.discardStep("session-probe", empty!);

    const elementLength = MAX_ACTIVE_RECORDING_BYTES - emptyCeiling!;
    const { manager } = createManager();
    await manager.start("session-a", "boundary", 11, "https://example.test");
    const prepared = await manager.prepareStep(
      "session-a", "browser_click", { element: "x".repeat(elementLength) }, 11,
    );
    expect(prepared).not.toBeNull();
    expect(prepared!.finalReservedBytes).toBe(MAX_ACTIVE_RECORDING_BYTES);

    await expect(manager.commitStep("session-a", prepared!, {
      durationMs: 0.0000012345678901234567,
      currentUrl: `https://example.test/${"a".repeat(MAX_RECORDED_URL_LENGTH)}`,
    })).resolves.toBeUndefined();

    const recording = manager.snapshot().active[0]!.recording;
    const finalBytes = new TextEncoder().encode(JSON.stringify({
      ...recording,
      stoppedAt: MAX_RECORDING_TIMESTAMP_MS,
    })).byteLength;
    expect(finalBytes).toBeLessThanOrEqual(prepared!.finalReservedBytes);
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

  it("records nested assertions without retaining original values", async () => {
    const { manager } = createManager();
    await manager.start("session-a", "assertions", 11, "https://example.test");
    const prepared = await manager.prepareStep("session-a", "browser_assert", {
      checks: [
        { type: "text_contains", value: SECRET_TEXT, selector: "#status" },
        { type: "element_count", value: SECRET_FORM, selector: ".row", min: 0, max: 10 },
      ],
    }, 11);
    expect(prepared).not.toBeNull();
    await manager.commitStep("session-a", prepared!, {
      durationMs: 1,
      currentUrl: "https://example.test/current",
    });

    const snapshot = manager.snapshot();
    expect(snapshot.active[0]?.recording.steps[0]?.args).toEqual({
      checks: [
        { type: "text_contains", value: "{{input_1}}", selector: "#status" },
        { type: "element_count", value: "{{input_2}}", selector: ".row", min: 0, max: 10 },
      ],
    });
    expectAbsent(snapshot);
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

  it("wraps prepare restore and storage failures in a stable private envelope", async () => {
    for (const failurePoint of ["getKeys", "get"] as const) {
      const sessionStorage = new MemoryStorage();
      if (failurePoint === "get") {
        const first = createManager({ sessionStorage });
        await first.manager.start("session-a", "prepare-private", 11, "https://example.test");
        sessionStorage.failGet = new Error(`RESTORE_EXPOSED_${SECRET_TEXT}`);
      } else {
        sessionStorage.failGetKeys = new Error(`STORAGE_EXPOSED_${SECRET_FORM}`);
      }
      const { manager } = createManager({ sessionStorage });
      const run = vi.fn(async () => "must-not-run");
      const issueCount = getRecentExtensionIssues(100).length;
      const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const error = await runRecordedAction({
        manager,
        sessionId: "session-a",
        toolName: "browser_click",
        args: { element: "Account" },
        tabId: 11,
        run,
        currentUrl: async () => "https://example.test",
      }).catch((caught: unknown) => caught);
      const failure = reportToolFailure(error, {
        requestId: `prepare-${failurePoint}`,
        toolType: "browser_click",
      });
      const consoleCalls = [
        ...consoleLog.mock.calls,
        ...consoleError.mock.calls,
        ...consoleWarn.mock.calls,
      ];
      const consoleText = consoleCalls.flatMap((call) => call).map((value) => (
        value instanceof Error
          ? `${value.message}\n${value.stack ?? ""}`
          : typeof value === "string" ? value : JSON.stringify(value)
      )).join("\n");
      const evidence = {
        response: failure.responseError,
        diagnostics: getRecentExtensionIssues(100).slice(issueCount),
        console: consoleCalls,
        storage: sessionStorage.writes,
        snapshot: manager.snapshot(),
      };
      consoleLog.mockRestore();
      consoleError.mockRestore();
      consoleWarn.mockRestore();

      expect(run).not.toHaveBeenCalled();
      expect(failure).toEqual({
        responseError: "RECORDED_STATE_FAILED",
        category: "RECORDED_STATE_FAILED",
        recorded: true,
      });
      expect(consoleCalls).toEqual([]);
      expect(consoleText).not.toContain(SECRET_TEXT);
      expect(consoleText).not.toContain(SECRET_FORM);
      expect(consoleText).not.toContain("RESTORE_EXPOSED");
      expect(consoleText).not.toContain("STORAGE_EXPOSED");
      expectAbsent(evidence);
    }
  });

  it("wraps public start and stop restore failures before background reporting", async () => {
    const cases: Array<{ toolType: string; invoke: () => Promise<unknown>; storage: MemoryStorage }> = [];

    const startStorage = new MemoryStorage();
    startStorage.failGetKeys = new Error(`START_RESTORE_${SECRET_TEXT}`);
    const startManager = createManager({ sessionStorage: startStorage }).manager;
    cases.push({
      toolType: "browser_record_start",
      invoke: () => startManager.start("session-a", "private-start", 11, "https://example.test"),
      storage: startStorage,
    });

    const stopStorage = new MemoryStorage();
    const stopManager = createManager({ sessionStorage: stopStorage }).manager;
    await stopManager.start("session-a", "private-stop", 11, "https://example.test");
    stopStorage.failGet = new Error(`STOP_RESTORE_${SECRET_FORM}`);
    cases.push({
      toolType: "browser_record_stop",
      invoke: () => stopManager.stop("session-a"),
      storage: stopStorage,
    });

    for (const [index, testCase] of cases.entries()) {
      const issueCount = getRecentExtensionIssues(100).length;
      const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const error = await testCase.invoke().catch((caught: unknown) => caught);
      const failure = reportToolFailure(error, {
        requestId: `public-recording-${index}`,
        toolType: testCase.toolType,
      });
      const consoleCalls = [
        ...consoleLog.mock.calls,
        ...consoleError.mock.calls,
        ...consoleWarn.mock.calls,
      ];
      const consoleText = consoleCalls.flatMap((call) => call).map((value) => (
        value instanceof Error
          ? `${value.message}\n${value.stack ?? ""}`
          : typeof value === "string" ? value : JSON.stringify(value)
      )).join("\n");
      const evidence = {
        response: failure.responseError,
        diagnostics: getRecentExtensionIssues(100).slice(issueCount),
        console: consoleCalls,
        storage: testCase.storage.writes,
      };
      consoleLog.mockRestore();
      consoleError.mockRestore();
      consoleWarn.mockRestore();
      expect(failure).toEqual({
        responseError: "RECORDED_STATE_FAILED",
        category: "RECORDED_STATE_FAILED",
        recorded: true,
      });
      expect(consoleCalls).toEqual([]);
      expect(consoleText).not.toContain(SECRET_TEXT);
      expect(consoleText).not.toContain(SECRET_FORM);
      expect(consoleText).not.toContain("START_RESTORE");
      expect(consoleText).not.toContain("STOP_RESTORE");
      expect(consoleText).not.toContain("STOP_RESTORE_DEBUG");
      expectAbsent(evidence);
    }
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

  it("quarantines restored active state until authoritative renewal promotes it", async () => {
    const sessionStorage = new MemoryStorage();
    const first = createManager({ sessionStorage });
    await first.manager.start("session-a", "quarantine-promote", 11, "https://example.test");

    const restarted = createManager({ sessionStorage });
    expect(await restarted.manager.prepareStep(
      "session-a", "browser_click", { element: "Account" }, 11,
    )).toBeNull();
    expect(restarted.manager.snapshot().active).toEqual([]);
    expect(restarted.transport.requests).toEqual([]);

    await restarted.manager.renewPersistedSessions();

    expect(restarted.transport.requests).toEqual([
      expect.objectContaining({
        type: "renewRecordingReservation",
        payload: { sessionId: "session-a", name: "quarantine-promote" },
      }),
    ]);
    expect(await restarted.manager.prepareStep(
      "session-a", "browser_click", { element: "Account" }, 11,
    )).not.toBeNull();
    expect(sessionStorage.values.get("active-recording:session-a")).toMatchObject({ status: "active" });
    expectAbsent({ storage: sessionStorage.writes, requests: restarted.transport.requests });
  });

  it("cleans quarantined restart candidates on false or failed validation without recording", async () => {
    for (const response of [{ ok: false }, new Error(`RENEW_FAILED_${SECRET_TEXT}`)]) {
      const sessionStorage = new MemoryStorage();
      const first = createManager({ sessionStorage });
      await first.manager.start("session-a", "quarantine-reject", 11, "https://example.test");
      const transport = new FakeTransport();
      transport.responses.push(response);
      const restarted = createManager({ sessionStorage, transport });
      expect(await restarted.manager.prepareStep(
        "session-a", "browser_type", { element: "Account", text: SECRET_FORM }, 11,
      )).toBeNull();

      await restarted.manager.renewPersistedSessions();

      expect(restarted.manager.snapshot().active).toEqual([]);
      expect(sessionStorage.values.has("active-recording:session-a")).toBe(false);
      expect(sessionStorage.values.has("active-recording-index:session-a")).toBe(false);
      expectAbsent({ storage: sessionStorage.writes, requests: transport.requests });
    }
  });

  it("tombstones session closure before cleanup persistence and blocks current-worker renewal", async () => {
    const sessionStorage = new MemoryStorage();
    const transport = new FakeTransport();
    let resolveRenew!: (value: unknown) => void;
    transport.responses.push(new Promise((resolve) => { resolveRenew = resolve; }));
    const current = createManager({ sessionStorage, transport });
    await current.manager.start("session-a", "closed-race", 11, "https://example.test");
    const renewing = current.manager.renewPersistedSessions();
    await vi.waitFor(() => expect(transport.requests).toHaveLength(1));
    const closing = current.manager.abortSession("session-a");
    expect(current.scheduler.cleanupSessions.has("session-a")).toBe(true);
    resolveRenew({ ok: true });
    await renewing;
    await closing;
    expect(current.manager.snapshot().active).toEqual([]);
    expect(sessionStorage.values.has("active-recording:session-a")).toBe(false);

    const failedStorage = new MemoryStorage();
    const beforeRestart = createManager({ sessionStorage: failedStorage });
    await beforeRestart.manager.start("session-a", "closed-persist-failure", 11, "https://example.test");
    failedStorage.failSetKey = "active-recording:session-a";
    await beforeRestart.manager.abortSession("session-a");
    expect(await beforeRestart.manager.prepareStep(
      "session-a", "browser_click", { element: "Account" }, 11,
    )).toBeNull();
    expect(beforeRestart.transport.requests).toEqual([]);

    failedStorage.failSetKey = undefined;
    const rejectedTransport = new FakeTransport();
    rejectedTransport.responses.push({ ok: false });
    const restarted = createManager({ sessionStorage: failedStorage, transport: rejectedTransport });
    expect(await restarted.manager.prepareStep(
      "session-a", "browser_click", { element: "Account" }, 11,
    )).toBeNull();
    await restarted.manager.renewPersistedSessions();
    expect(restarted.manager.snapshot().active).toEqual([]);
    expect(failedStorage.values.has("active-recording:session-a")).toBe(false);
    expectAbsent({ storage: failedStorage.writes, requests: rejectedTransport.requests });
  });

  it("keeps the closure alarm when queued restore fails and clears it after cleanup", async () => {
    const sessionStorage = new MemoryStorage();
    const scheduler = new FakeScheduler();
    const { manager } = createManager({ sessionStorage, scheduler });
    await manager.start("session-a", "restore-failure", 11, "https://example.test");
    sessionStorage.failGet = new Error(`RESTORE_EXPOSED_${SECRET_TEXT}`);

    const error = await manager.abortSession("session-a").catch((reason: unknown) => reason);

    expect(error).toMatchObject({
      name: "RecordedStateFailure",
      message: "RECORDED_STATE_FAILED",
    });
    expect(JSON.stringify(error)).not.toContain(SECRET_TEXT);
    expect(scheduler.cleanupSessions.has("session-a")).toBe(true);
    expect(sessionStorage.values.has("active-recording:session-a")).toBe(true);

    sessionStorage.failGet = undefined;
    await manager.retryCleanupSession("session-a");
    expect(scheduler.cleanupSessions.has("session-a")).toBe(false);
    expect(sessionStorage.values.has("active-recording:session-a")).toBe(false);
    expect(sessionStorage.values.has("active-recording-index:session-a")).toBe(false);
  });

  it("retains a fresh authoritative cleanup footprint until successful retry frees capacity", async () => {
    const sessionStorage = new MemoryStorage();
    sessionStorage.values.set("active-recording:session-a", {
      sessionId: "session-a",
      tabId: 11,
      nextVariable: 1,
      status: "cleanup",
      recording: {
        name: "cleanup-near-cap",
        startedAt: 1_700_000_000_000,
        stoppedAt: 1_700_000_000_001,
        url: "https://example.test",
        steps: [],
        requiredVariables: [],
      },
    });
    sessionStorage.values.set("active-recording-index:session-a", {
      sessionId: "session-a",
      status: "cleanup",
    });
    sessionStorage.bytesInUseOverride = MAX_AGGREGATE_RECORDING_BYTES - 1;
    sessionStorage.failRemoveMany = new Error("REMOVE_FAILED");
    const scheduler = new FakeScheduler();
    scheduler.cleanupSessions.add("session-a");
    const context = createManager({ sessionStorage, scheduler });

    await context.manager.retryCleanupStates();
    expect(sessionStorage.getBytesInUseCalls).toContainEqual([
      "active-recording-index:session-a",
      "active-recording:session-a",
    ]);
    await expect(context.manager.start(
      "session-b", "blocked-by-cleanup", 22, "https://example.test/b",
    )).rejects.toThrow("RECORDING_STATE_LIMIT");

    sessionStorage.failRemoveMany = undefined;
    await context.manager.retryCleanupSession("session-a");
    await expect(context.manager.start(
      "session-b", "after-cleanup", 22, "https://example.test/b",
    )).resolves.toBeUndefined();
  });

  it("blocks prepares while an unmeasurable fresh cleanup footprint cannot be removed", async () => {
    const sessionStorage = new MemoryStorage();
    const context = createManager({ sessionStorage });
    await context.manager.start("session-b", "existing", 22, "https://example.test/b");
    sessionStorage.values.set("active-recording:session-a", {
      sessionId: "session-a",
      tabId: 11,
      nextVariable: 1,
      status: "cleanup",
      recording: {
        name: "unmeasurable-cleanup",
        startedAt: 1_700_000_000_000,
        stoppedAt: 1_700_000_000_001,
        url: "https://example.test",
        steps: [],
        requiredVariables: [],
      },
    });
    sessionStorage.values.set("active-recording-index:session-a", {
      sessionId: "session-a",
      status: "cleanup",
    });
    sessionStorage.failGetBytesInUse = new Error("BYTES_FAILED");
    sessionStorage.failRemoveMany = new Error("REMOVE_FAILED");
    context.scheduler.cleanupSessions.add("session-a");

    await context.manager.retryCleanupStates();
    await expect(context.manager.prepareStep(
      "session-b", "browser_click", { element: "safe" }, 22,
    )).rejects.toThrow("RECORDING_STATE_LIMIT");
    expect(context.transport.requests).toEqual([]);
  });

  it("attempts queued closure cleanup after immediate alarm scheduling rejects", async () => {
    const sessionStorage = new MemoryStorage();
    const scheduler = new FakeScheduler();
    const { manager } = createManager({ sessionStorage, scheduler });
    await manager.start("session-a", "alarm-failure", 11, "https://example.test");
    scheduler.failCleanupEnsure = new Error(`ALARM_EXPOSED_${SECRET_FORM}`);

    await expect(manager.abortSession("session-a")).resolves.toBeUndefined();

    expect(scheduler.cleanupEnsured).toBeGreaterThanOrEqual(2);
    expect(manager.snapshot().active).toEqual([]);
    expect(sessionStorage.values.has("active-recording:session-a")).toBe(false);
    expect(sessionStorage.values.has("active-recording-index:session-a")).toBe(false);
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
    await first.manager.expireReservation("session-a", "different-flow");
    expect(first.manager.snapshot().active).toHaveLength(1);
    await first.manager.expireReservation("session-a", "flow");
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

    const surfaced = await restarted.manager.stop("session-a");
    expect(surfaced).toEqual(partial);
    expect(recoveryTransport.requests).toEqual([]);
    expect(restarted.manager.snapshot().active).toHaveLength(1);
    await restarted.manager.abortSession("session-a");
    expect(restarted.manager.snapshot().active).toEqual([]);
    expectAbsent({ partial, surfaced, storage: sessionStorage.writes, local: localStorage.writes });
  });

  it("runs click, type, and navigation unrecorded while cached recovery blocks start", async () => {
    const transport = new FakeTransport();
    transport.responses.push(new Error(`persist failed ${SECRET_TEXT}`));
    const { manager, sessionStorage } = createManager({ transport });
    await manager.start("session-a", "browse-during-recovery", 11, "https://example.test");
    const partial = await manager.stop("session-a");
    const executed: string[] = [];

    for (const [toolName, args] of [
      ["browser_click", { element: "Continue" }],
      ["browser_type", { element: "Search", text: SECRET_FORM }],
      ["browser_navigate", { url: `https://example.test/?secret=${SECRET_URL}` }],
    ] as const) {
      const result = await runRecordedAction({
        manager,
        sessionId: "session-a",
        toolName,
        args,
        tabId: 11,
        run: async () => {
          executed.push(toolName);
          return { success: true };
        },
        currentUrl: async () => {
          throw new Error("recovery actions must not capture metadata");
        },
      });
      expect(result).toEqual({ success: true });
    }

    expect(executed).toEqual(["browser_click", "browser_type", "browser_navigate"]);
    expect(manager.snapshot().active[0]).toMatchObject({
      status: "stopping",
      recording: { steps: [] },
    });
    await expect(manager.start("session-a", "replacement", 11, "https://example.test"))
      .rejects.toThrow("ACTIVE_RECORDING_EXISTS");

    const requestCount = transport.requests.length;
    const surfaced = await manager.stop("session-a");
    expect(surfaced).toEqual(partial);
    expect(transport.requests).toHaveLength(requestCount);
    expect(manager.snapshot().active).toHaveLength(1);
    expectAbsent({ partial, surfaced, storage: sessionStorage.writes, snapshot: manager.snapshot() });
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
      status: "cleanup",
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

  it("enforces the v2 session grammar for starts and persisted marker suffixes", async () => {
    for (const sessionId of ["", "with space", "with:colon", "x".repeat(129)]) {
      const storage = new MemoryStorage();
      storage.values.set(`active-recording-index:${sessionId}`, {
        sessionId,
        status: "active",
      });
      storage.values.set(`active-recording:${sessionId}`, { secret: SECRET_TEXT });
      const invalid = createManager({ sessionStorage: storage });
      await invalid.manager.renewPersistedSessions();
      expect(storage.values.has(`active-recording-index:${sessionId}`)).toBe(false);
      expect(storage.values.has(`active-recording:${sessionId}`)).toBe(false);
      expect(storage.reads).not.toContain(`active-recording:${sessionId}`);
      await expect(invalid.manager.start(sessionId, "flow", 11, "https://example.test"))
        .rejects.toThrow("RECORDED_STATE_FAILED");
    }

    for (const sessionId of [
      "a",
      "x".repeat(128),
      "550e8400-e29b-41d4-a716-446655440000",
    ]) {
      const valid = createManager();
      await valid.manager.start(sessionId, "flow", 11, "https://example.test");
      expect([...valid.sessionStorage.values.keys()]).toContain(`active-recording-index:${sessionId}`);
    }
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
    expect(renewalTransport.requests).toHaveLength(1);
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

  it("persists cleanup state when active session closure removal fails and retries after restart", async () => {
    const sessionStorage = new MemoryStorage();
    const first = createManager({ sessionStorage });
    await first.manager.start("session-a", "cleanup-active", 11, "https://example.test");
    sessionStorage.failRemoveMany = new Error(`REMOVE_FAILED_${SECRET_TEXT}`);

    await first.manager.abortSession("session-a");

    expect(sessionStorage.values.get("active-recording-index:session-a")).toEqual({
      sessionId: "session-a",
      status: "cleanup",
    });
    expect(sessionStorage.values.get("active-recording:session-a")).toMatchObject({
      sessionId: "session-a",
      status: "cleanup",
    });
    expect(first.manager.snapshot().active).toEqual([]);
    expect(first.scheduler.cleanupEnsured).toBeGreaterThan(0);
    await expect(first.manager.start(
      "session-a",
      "must-not-resurrect",
      11,
      "https://example.test",
    )).rejects.toThrow("ACTIVE_RECORDING_EXISTS");

    const restarted = createManager({ sessionStorage });
    await restarted.manager.renewPersistedSessions();
    expect(restarted.transport.requests).toEqual([]);
    expect(restarted.manager.snapshot().active).toEqual([]);
    expect(restarted.scheduler.cleanupEnsured).toBeGreaterThan(0);

    sessionStorage.failRemoveMany = undefined;
    await restarted.manager.retryCleanupStates();
    expect(sessionStorage.values.has("active-recording:session-a")).toBe(false);
    expect(sessionStorage.values.has("active-recording-index:session-a")).toBe(false);
    expect(restarted.scheduler.cleanupCleared).toBeGreaterThan(0);
    expectAbsent({ writes: sessionStorage.writes, snapshot: restarted.manager.snapshot() });
  });

  it("converts stopping recovery to cleanup on session closure without exposing it", async () => {
    const sessionStorage = new MemoryStorage();
    const transport = new FakeTransport();
    transport.responses.push(new Error("SERVER_UNAVAILABLE"));
    const first = createManager({ sessionStorage, transport });
    await first.manager.start("session-a", "cleanup-stopping", 11, "https://example.test");
    const partial = await first.manager.stop("session-a");
    sessionStorage.failRemoveMany = new Error(`REMOVE_FAILED_${SECRET_FORM}`);

    await first.manager.abortSession("session-a");

    expect(sessionStorage.values.get("active-recording:session-a")).toMatchObject({
      status: "cleanup",
      stopStatus: { extensionSaved: false, serverSaved: false, error: "SERVER_PERSIST_FAILED" },
    });
    expect(first.manager.snapshot().active).toEqual([]);
    await expect(first.manager.stop("session-a")).rejects.toThrow("RECORDING_CLEANUP_PENDING");
    expect(first.manager.isRecording("session-a")).toBe(false);

    sessionStorage.failRemoveMany = undefined;
    const restarted = createManager({ sessionStorage });
    await restarted.manager.retryCleanupStates();
    expect(restarted.transport.requests).toEqual([]);
    expect(sessionStorage.values.has("active-recording:session-a")).toBe(false);
    expect(sessionStorage.values.has("active-recording-index:session-a")).toBe(false);
    expectAbsent({ partial, writes: sessionStorage.writes, snapshot: restarted.manager.snapshot() });
  });

  it("lets the global keepalive retry persisted cleanup after alarm and removal failures", async () => {
    const sessionStorage = new MemoryStorage();
    const scheduler = new FakeScheduler();
    scheduler.failCleanupEnsure = new Error(`ALARM_FAILED_${SECRET_TEXT}`);
    const context = createManager({ sessionStorage, scheduler });
    await context.manager.start("session-a", "keepalive-cleanup", 11, "https://example.test");
    sessionStorage.failRemoveMany = new Error(`REMOVE_FAILED_${SECRET_FORM}`);

    await context.manager.abortSession("session-a");

    expect(scheduler.cleanupSessions).toEqual(new Set());
    expect(sessionStorage.values.get("active-recording:session-a")).toMatchObject({
      status: "cleanup",
    });
    expect(context.manager.snapshot().active).toEqual([]);
    expect(context.transport.requests).toEqual([]);

    sessionStorage.failRemoveMany = undefined;
    await context.manager.retryCleanupStates();
    await context.manager.renewPersistedSessions();

    expect(sessionStorage.values.has("active-recording:session-a")).toBe(false);
    expect(sessionStorage.values.has("active-recording-index:session-a")).toBe(false);
    expect(scheduler.cleanupCleared).toBeGreaterThan(0);
    expect(context.manager.snapshot().active).toEqual([]);
    expect(context.transport.requests).toEqual([]);
  });

  it("treats a cleanup alarm as authoritative over a stale stopping snapshot", async () => {
    const sessionStorage = new MemoryStorage();
    const failedTransport = new FakeTransport();
    failedTransport.responses.push(new Error("SERVER_UNAVAILABLE"));
    const first = createManager({ sessionStorage, transport: failedTransport });
    await first.manager.start("session-a", "stale-stopping", 11, "https://example.test");
    const partial = await first.manager.stop("session-a");
    expect(sessionStorage.values.get("active-recording:session-a")).toMatchObject({
      status: "stopping",
      stopStatus: {
        extensionSaved: partial.extensionSaved,
        serverSaved: partial.serverSaved,
        error: partial.error,
      },
    });

    const scheduler = new FakeScheduler();
    scheduler.cleanupSessions.add("session-a");
    const restarted = createManager({ sessionStorage, scheduler });
    await restarted.manager.retryCleanupStates();
    await restarted.manager.renewPersistedSessions();

    expect(restarted.transport.requests).toEqual([]);
    expect(restarted.manager.snapshot().active).toEqual([]);
    expect(sessionStorage.values.has("active-recording:session-a")).toBe(false);
    expect(sessionStorage.values.has("active-recording-index:session-a")).toBe(false);
    expect(scheduler.cleanupSessions.has("session-a")).toBe(false);
    await expect(restarted.manager.start(
      "session-a", "replacement", 11, "https://example.test/new",
    )).resolves.toBeUndefined();
  });

  it("reschedules a stale active cleanup alarm after removal failure and deletes it eventually", async () => {
    expect(recordingCleanupAlarmName("session-a")).toBe("recording-cleanup:session-a");
    expect(recordingCleanupSessionId("recording-cleanup:session-a")).toBe("session-a");
    const sessionStorage = new MemoryStorage();
    const first = createManager({ sessionStorage });
    await first.manager.start("session-a", "stale-active", 11, "https://example.test");

    const scheduler = new FakeScheduler();
    scheduler.cleanupSessions.add("session-a");
    sessionStorage.failRemoveMany = new Error("REMOVE_FAILED");
    const restarted = createManager({ sessionStorage, scheduler });
    await restarted.manager.retryCleanupStates();

    expect(restarted.transport.requests).toEqual([]);
    expect(restarted.manager.snapshot().active).toEqual([]);
    expect(sessionStorage.values.has("active-recording:session-a")).toBe(true);
    expect(sessionStorage.values.has("active-recording-index:session-a")).toBe(true);
    expect(scheduler.cleanupSessions.has("session-a")).toBe(true);
    expect(scheduler.cleanupEnsured).toBeGreaterThan(0);
    await expect(restarted.manager.start(
      "session-a", "blocked", 11, "https://example.test/new",
    )).rejects.toThrow("ACTIVE_RECORDING_EXISTS");
    expect(restarted.transport.requests).toEqual([]);

    sessionStorage.failRemoveMany = undefined;
    await (restarted.manager as unknown as {
      retryCleanupSession(sessionId: string): Promise<void>;
    }).retryCleanupSession("session-a");

    expect(sessionStorage.values.has("active-recording:session-a")).toBe(false);
    expect(sessionStorage.values.has("active-recording-index:session-a")).toBe(false);
    expect(scheduler.cleanupSessions.has("session-a")).toBe(false);
    expect(restarted.manager.snapshot().active).toEqual([]);
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
    await expect(manager.start("session-a", "flow", 11, "https://example.test"))
      .rejects.toThrow("COMPLETED_RECORDING_EXISTS");
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
    expect(manager.snapshot().active).toHaveLength(0);
    expect(sessionStorage.values.has("active-recording:session-a")).toBe(true);
    expect(sessionStorage.values.get("active-recording-index:session-a")).toEqual({
      sessionId: "session-a",
      status: "cleanup",
    });
    expect(sessionStorage.removeManyCalls.at(-1)).toEqual([
      "active-recording:session-a",
      "active-recording-index:session-a",
    ]);
    const requestsBeforeTick = transport.requests.length;
    await manager.renewPersistedSessions();
    await manager.expireReservation("session-a", "cleanup-key");
    expect(transport.requests).toHaveLength(requestsBeforeTick);
    expect(manager.snapshot().active).toHaveLength(0);

    sessionStorage.failRemoveMany = undefined;
    const restarted = createManager({ sessionStorage, localStorage });
    await restarted.manager.retryCleanupStates();
    expect(restarted.transport.requests).toEqual([]);
    expect(restarted.manager.snapshot().active).toEqual([]);
    expect(sessionStorage.values.has("active-recording:session-a")).toBe(false);
    expect(sessionStorage.values.has("active-recording-index:session-a")).toBe(false);
    expect(localStorage.writes.filter((entry) => JSON.stringify(entry).includes("recording:cleanup-key")))
      .toHaveLength(1);
    expect(localStorage.values.get("recording:cleanup-key")).toEqual(partial.recording);
    expectAbsent({ partial, storage: sessionStorage.writes, local: localStorage.writes });
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

  it("accepts omitted generic hints and rejects invalid or non-finite persisted numerics", async () => {
    const { manager } = createManager();
    await manager.start("session-a", "schema-bounds", 11, "https://example.test");
    await runRecordedAction({
      manager,
      sessionId: "session-a",
      toolName: "browser_type",
      args: { element: "Account", text: SECRET_TEXT },
      tabId: 11,
      run: async () => "ok",
      currentUrl: async () => "https://example.test/current",
    });
    const stopped = await manager.stop("session-a");
    const withoutHint = structuredClone(stopped.recording);
    delete withoutHint.requiredVariables[0]!.hint;
    expect(isSanitizedRecording(withoutHint)).toBe(true);
    const invalidHint = structuredClone(withoutHint);
    invalidHint.requiredVariables[0]!.hint = "Account field";
    expect(isSanitizedRecording(invalidHint)).toBe(false);

    const numericMutations: Array<(recording: typeof stopped.recording) => void> = [
      (recording) => { recording.startedAt = -1; },
      (recording) => { recording.startedAt = Number.POSITIVE_INFINITY; },
      (recording) => { recording.startedAt = MAX_RECORDING_TIMESTAMP_MS + 1; },
      (recording) => { recording.startedAt = 1.5; },
      (recording) => { recording.stoppedAt = -1; },
      (recording) => { recording.stoppedAt = Number.NaN; },
      (recording) => { recording.stoppedAt = MAX_RECORDING_TIMESTAMP_MS + 1; },
      (recording) => { recording.steps[0]!.timestamp = -1; },
      (recording) => { recording.steps[0]!.timestamp = Number.POSITIVE_INFINITY; },
      (recording) => { recording.steps[0]!.timestamp = 1.5; },
      (recording) => { recording.steps[0]!.durationMs = -1; },
      (recording) => { recording.steps[0]!.durationMs = Number.NaN; },
      (recording) => { recording.steps[0]!.durationMs = MAX_RECORDED_DURATION_MS + 1; },
    ];
    for (const mutate of numericMutations) {
      const candidate = structuredClone(stopped.recording);
      mutate(candidate);
      expect(isSanitizedRecording(candidate)).toBe(false);
    }

    const boundary = structuredClone(stopped.recording);
    boundary.startedAt = 0;
    boundary.stoppedAt = MAX_RECORDING_TIMESTAMP_MS;
    boundary.steps[0]!.timestamp = MAX_RECORDING_TIMESTAMP_MS;
    boundary.steps[0]!.durationMs = MAX_RECORDED_DURATION_MS;
    expect(isSanitizedRecording(boundary)).toBe(true);

    const maxSteps = structuredClone(stopped.recording);
    while (maxSteps.steps.length < MAX_ACTIVE_RECORDING_STEPS) {
      maxSteps.steps.push({
        action: "browser_go_back",
        args: {},
        timestamp: 0,
        durationMs: 0,
        url: "",
      });
    }
    expect(isSanitizedRecording(maxSteps)).toBe(true);
    maxSteps.steps.push({ ...maxSteps.steps.at(-1)! });
    expect(isSanitizedRecording(maxSteps)).toBe(false);

    const maxTab = createManager();
    await expect(maxTab.manager.start(
      "session-max", "max-tab", MAX_CHROME_TAB_ID, "https://example.test",
    )).resolves.toBeUndefined();
    for (const tabId of [0, MAX_CHROME_TAB_ID + 1, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(createManager().manager.start(
        `session-${tabId}`, "bad-tab", tabId, "https://example.test",
      )).rejects.toThrow("RECORDED_STATE_FAILED");
    }

    for (const nextVariable of [0, MAX_REQUIRED_VARIABLES + 2]) {
      const storage = new MemoryStorage();
      const seeded = createManager({ sessionStorage: storage });
      await seeded.manager.start("session-a", "bad-counter", 11, "https://example.test");
      const state = storage.values.get("active-recording:session-a") as Record<string, unknown>;
      storage.values.set("active-recording:session-a", { ...state, nextVariable });
      const restarted = createManager({ sessionStorage: storage });
      await expect(restarted.manager.restoreSession("session-a")).resolves.toBe(false);
      expect(restarted.manager.snapshot().active).toEqual([]);
    }
  });

  it("enforces every numeric argument bound during restore before promotion", async () => {
    const numericBounds = RECORDING_NUMERIC_BOUNDS as Record<string, Record<
      string,
      { integer: boolean; min: number; max: number }
    >>;
    const validates = (action: string, path: string, value: number): boolean => {
      if (path.startsWith("checks.*.")) {
        return validateSanitizedArgs(action, {
          checks: [{ type: "element_count", [path.slice("checks.*.".length)]: value }],
        }, new Map(), new Set());
      }
      return validateSanitizedArgs(action, { [path]: value }, new Map(), new Set());
    };
    for (const [action, paths] of Object.entries(numericBounds)) {
      for (const [path, bounds] of Object.entries(paths)) {
        expect(validates(action, path, bounds.min), `${action}.${path} min`).toBe(true);
        expect(validates(action, path, bounds.max), `${action}.${path} max`).toBe(true);
        expect(validates(action, path, bounds.min - 1), `${action}.${path} below`).toBe(false);
        expect(validates(action, path, bounds.max + 1), `${action}.${path} above`).toBe(false);
        if (bounds.integer) {
          expect(validates(action, path, bounds.min + 0.5), `${action}.${path} fraction`)
            .toBe(false);
        }
        expect(validates(action, path, Number.MAX_SAFE_INTEGER + 1), `${action}.${path} unsafe`)
          .toBe(false);
        expect(validates(action, path, Number.NaN), `${action}.${path} NaN`).toBe(false);
        expect(validates(action, path, Number.POSITIVE_INFINITY), `${action}.${path} infinity`)
          .toBe(false);
      }
    }

    const sessionStorage = new MemoryStorage();
    const first = createManager({ sessionStorage });
    await first.manager.start("session-a", "invalid-restored-args", 11, "https://example.test");
    const state = structuredClone(
      sessionStorage.values.get("active-recording:session-a"),
    ) as Record<string, unknown>;
    const storedRecording = state.recording as Record<string, unknown>;
    storedRecording.steps = [{
      action: "browser_wait",
      args: { time: 2_147_483.648 },
      timestamp: 0,
      durationMs: 0,
      url: "",
    }];
    sessionStorage.values.set("active-recording:session-a", state);
    const restarted = createManager({ sessionStorage });

    await restarted.manager.renewPersistedSessions();

    expect(restarted.transport.requests).toEqual([]);
    expect(restarted.manager.snapshot().active).toEqual([]);
    expect(sessionStorage.values.has("active-recording:session-a")).toBe(false);
    expect(sessionStorage.values.has("active-recording-index:session-a")).toBe(false);
  });
});
