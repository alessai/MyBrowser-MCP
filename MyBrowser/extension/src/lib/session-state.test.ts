import { beforeEach, describe, expect, it, vi } from "vitest";

import { SessionStateStore, type SessionStorageAdapter } from "./session-state";
import { resolveTabId } from "./tab-manager";
import * as eventRegistry from "./events";

class MemoryStorage implements SessionStorageAdapter {
  readonly values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async set<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value);
  }

  async remove(key: string): Promise<void> {
    this.values.delete(key);
  }

  async getBytesInUse(): Promise<number> {
    return JSON.stringify([...this.values]).length;
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function deferredValue<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("SessionStateStore", () => {
  it("rehydrates a session tab from storage", async () => {
    const storage = new MemoryStorage();
    storage.values.set("session-tab:session-a", 17);

    const state = new SessionStateStore(storage);

    await expect(state.getLastTab("session-a")).resolves.toBe(17);
  });

  it("backfills the persisted index when hydrating legacy session state", async () => {
    const storage = new MemoryStorage();
    storage.values.set("session-tab:session-a", 17);

    const state = new SessionStateStore(storage);
    await state.getLastTab("session-a");

    expect(storage.values.get("session-tab-index")).toEqual(["session-a"]);
  });

  it("awaits tab persistence before setLastTab resolves", async () => {
    const write = deferred();
    const storage = new MemoryStorage();
    storage.set = vi.fn(async () => write.promise);
    const state = new SessionStateStore(storage);
    let finished = false;

    const pending = state.setLastTab("session-a", 22).then(() => {
      finished = true;
    });
    let readFinished = false;
    const read = state.getLastTab("session-a").then((tabId) => {
      readFinished = true;
      return tabId;
    });
    await Promise.resolve();

    expect(finished).toBe(false);
    expect(readFinished).toBe(false);
    write.resolve();
    await pending;
    await expect(read).resolves.toBe(22);
    expect(storage.set).toHaveBeenCalledWith("session-tab:session-a", 22);
  });

  it("orders a later set after in-flight hydration", async () => {
    const read = deferredValue<number | undefined>();
    const storage = new MemoryStorage();
    const get = storage.get.bind(storage);
    storage.get = vi.fn((key: string) => (
      key === "session-tab:session-a"
        ? read.promise
        : get(key)
    )) as unknown as SessionStorageAdapter['get'];
    const state = new SessionStateStore(storage);

    const hydration = state.getLastTab("session-a");
    const update = state.setLastTab("session-a", 22);
    read.resolve(7);

    await expect(hydration).resolves.toBe(7);
    await update;
    await expect(state.getLastTab("session-a")).resolves.toBe(22);
  });

  it("serializes persistence so the newest tab wins", async () => {
    const firstWrite = deferred();
    const storage = new MemoryStorage();
    let writes = 0;
    storage.set = vi.fn(async (key: string, value: unknown) => {
      writes += 1;
      if (writes === 1) await firstWrite.promise;
      storage.values.set(key, value);
    });
    const state = new SessionStateStore(storage);

    const first = state.setLastTab("session-a", 1);
    await Promise.resolve();
    const second = state.setLastTab("session-a", 2);
    await Promise.resolve();

    expect(storage.set).toHaveBeenCalledTimes(1);
    firstWrite.resolve();
    await Promise.all([first, second]);
    expect(storage.values.get("session-tab:session-a")).toBe(2);
  });

  it("clears every hydrated session that points at a closed tab", async () => {
    const storage = new MemoryStorage();
    const state = new SessionStateStore(storage);
    await state.setLastTab("session-a", 9);
    await state.setLastTab("session-b", 9);
    await state.setLastTab("session-c", 10);

    await state.clearTab(9);

    await expect(state.getLastTab("session-a")).resolves.toBeUndefined();
    await expect(state.getLastTab("session-b")).resolves.toBeUndefined();
    await expect(state.getLastTab("session-c")).resolves.toBe(10);
    expect(storage.values.has("session-tab:session-a")).toBe(false);
    expect(storage.values.has("session-tab:session-b")).toBe(false);
  });

  it("clears an unhydrated persisted reference after worker restart", async () => {
    const storage = new MemoryStorage();
    storage.values.set("session-tab-index", ["session-a", "session-b"]);
    storage.values.set("session-tab:session-a", 9);
    storage.values.set("session-tab:session-b", 10);

    const state = new SessionStateStore(storage);
    await state.clearTab(9);

    expect(storage.values.has("session-tab:session-a")).toBe(false);
    expect(storage.values.get("session-tab:session-b")).toBe(10);
    expect(storage.values.get("session-tab-index")).toEqual(["session-b"]);
    await expect(state.getLastTab("session-a")).resolves.toBeUndefined();
  });

  it("orders hydration after an earlier clearTab", async () => {
    const removalStarted = deferred();
    const releaseRemoval = deferred();
    const storage = new MemoryStorage();
    storage.values.set("session-tab-index", ["session-a"]);
    storage.values.set("session-tab:session-a", 9);
    const remove = storage.remove.bind(storage);
    storage.remove = vi.fn(async (key: string) => {
      if (key === "session-tab:session-a") {
        removalStarted.resolve();
        await releaseRemoval.promise;
      }
      await remove(key);
    });
    const state = new SessionStateStore(storage);

    const clearing = state.clearTab(9);
    await removalStarted.promise;
    let hydrationFinished = false;
    const hydration = state.getLastTab("session-a").then((tabId) => {
      hydrationFinished = true;
      return tabId;
    });
    await Promise.resolve();

    expect(hydrationFinished).toBe(false);
    releaseRemoval.resolve();
    await clearing;
    await expect(hydration).resolves.toBeUndefined();
  });

  it("lets an earlier hydration finish before clearTab removes it", async () => {
    const hydrationRead = deferredValue<number | undefined>();
    const storage = new MemoryStorage();
    storage.values.set("session-tab-index", ["session-a"]);
    storage.values.set("session-tab:session-a", 9);
    const get = storage.get.bind(storage);
    let sessionReads = 0;
    let cleanupReadStarted = false;
    storage.get = vi.fn((key: string) => {
      if (key !== "session-tab:session-a") return get(key);
      sessionReads += 1;
      if (sessionReads === 1) return hydrationRead.promise;
      cleanupReadStarted = true;
      return get(key);
    }) as unknown as SessionStorageAdapter['get'];
    const state = new SessionStateStore(storage);

    const hydration = state.getLastTab("session-a");
    const clearing = state.clearTab(9);
    for (let index = 0; index < 8; index += 1) await Promise.resolve();

    expect(cleanupReadStarted).toBe(false);
    hydrationRead.resolve(9);
    await expect(hydration).resolves.toBe(9);
    await clearing;
    await expect(state.getLastTab("session-a")).resolves.toBeUndefined();
    expect(storage.values.has("session-tab:session-a")).toBe(false);
  });

  it("serializes concurrent index additions and removals", async () => {
    const storage = new MemoryStorage();
    const state = new SessionStateStore(storage);

    await Promise.all([
      state.setLastTab("session-a", 1),
      state.setLastTab("session-b", 2),
    ]);
    expect(new Set(storage.values.get("session-tab-index") as string[])).toEqual(
      new Set(["session-a", "session-b"]),
    );

    await Promise.all([
      state.clearSession("session-a"),
      state.setLastTab("session-c", 3),
    ]);
    expect(new Set(storage.values.get("session-tab-index") as string[])).toEqual(
      new Set(["session-b", "session-c"]),
    );
  });

  it("awaits an in-flight tab cleanup when clearTab is repeated", async () => {
    const removal = deferred();
    const storage = new MemoryStorage();
    const state = new SessionStateStore(storage);
    await state.setLastTab("session-a", 9);
    storage.remove = vi.fn(async () => removal.promise);

    const first = state.clearTab(9);
    await Promise.resolve();
    let repeatedFinished = false;
    const repeated = state.clearTab(9).then(() => {
      repeatedFinished = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(repeatedFinished).toBe(false);
    removal.resolve();
    await Promise.all([first, repeated]);
  });

  it("awaits session removal before clearSession resolves", async () => {
    const removal = deferred();
    const storage = new MemoryStorage();
    storage.values.set("session-tab:session-a", 5);
    storage.remove = vi.fn(async () => removal.promise);
    const state = new SessionStateStore(storage);
    await state.getLastTab("session-a");
    let finished = false;

    const pending = state.clearSession("session-a").then(() => {
      finished = true;
    });
    await Promise.resolve();

    expect(finished).toBe(false);
    removal.resolve();
    await pending;
    await expect(state.getLastTab("session-a")).resolves.toBeUndefined();
  });
});

describe("session_closed cleanup", () => {
  type CleanupDependencies = {
    scheduler: { cancelSession: (sessionId: string, code: "SESSION_CLOSED") => void };
    temporaryTabs: { cleanupSession: (sessionId: string) => Promise<unknown> };
    sessionState: { clearSession: (sessionId: string) => Promise<void> };
    recordings: { abortSession: (sessionId: string) => Promise<void> };
    clearEventMirrors: (sessionId: string) => void;
    reportFailure: (code: string) => void;
  };
  const cleanupClosedSession = (eventRegistry as unknown as {
    cleanupClosedSession: (sessionId: string, dependencies: CleanupDependencies) => Promise<void>;
  }).cleanupClosedSession;

  it("runs every cleanup step in order and reports only stable diagnostics", async () => {
    expect(cleanupClosedSession).toBeTypeOf("function");
    const order: string[] = [];
    const failures: string[] = [];
    const dependencies: CleanupDependencies = {
      scheduler: {
        cancelSession: () => {
          order.push("scheduler.cancelSession");
          throw new Error("CANARY_SCHEDULER_SECRET");
        },
      },
      temporaryTabs: {
        cleanupSession: async () => {
          order.push("temporaryTabs.cleanupSession");
          throw new Error("CANARY_TAB_SECRET");
        },
      },
      sessionState: {
        clearSession: async () => {
          order.push("sessionState.clearSession");
        },
      },
      recordings: {
        abortSession: async () => {
          order.push("recordings.abortSession");
          throw new Error("CANARY_RECORDING_SECRET");
        },
      },
      clearEventMirrors: () => {
        order.push("events.clearSession");
      },
      reportFailure: (code) => failures.push(code),
    };

    await expect(cleanupClosedSession("session-a", dependencies)).resolves.toBeUndefined();

    expect(order).toEqual([
      "scheduler.cancelSession",
      "temporaryTabs.cleanupSession",
      "sessionState.clearSession",
      "recordings.abortSession",
      "events.clearSession",
    ]);
    expect(failures).toEqual([
      "SESSION_CLEANUP_SCHEDULER_FAILED",
      "SESSION_CLEANUP_TABS_FAILED",
      "SESSION_CLEANUP_RECORDINGS_FAILED",
    ]);
    expect(JSON.stringify(failures)).not.toContain("CANARY");
  });

  it("is harmless for repeated cleanup and missing state", async () => {
    expect(cleanupClosedSession).toBeTypeOf("function");
    eventRegistry.clearHandlers();
    eventRegistry.addHandler({
      id: "handler-a",
      sessionId: "session-a",
      browserId: "b1",
      event: "dialog",
      action: "dismiss",
      createdAt: 1,
    });
    eventRegistry.addHandler({
      id: "handler-b",
      sessionId: "session-b",
      browserId: "b1",
      event: "dialog",
      action: "accept",
      createdAt: 2,
    });
    const storage = new MemoryStorage();
    const state = new SessionStateStore(storage);
    const recordingSessions = new Set(["session-a"]);
    const failures: string[] = [];
    const dependencies: CleanupDependencies = {
      scheduler: { cancelSession: () => undefined },
      temporaryTabs: { cleanupSession: async () => undefined },
      sessionState: { clearSession: (sessionId) => state.clearSession(sessionId) },
      recordings: {
        abortSession: async (sessionId) => {
          recordingSessions.delete(sessionId);
        },
      },
      clearEventMirrors: (sessionId) => {
        (eventRegistry as unknown as {
          clearHandlersForSession: (id: string) => void;
        }).clearHandlersForSession(sessionId);
      },
      reportFailure: (code) => failures.push(code),
    };

    await state.setLastTab("session-a", 7);
    await cleanupClosedSession("session-a", dependencies);
    await cleanupClosedSession("session-a", dependencies);

    await expect(state.getLastTab("session-a")).resolves.toBeUndefined();
    expect(recordingSessions).toEqual(new Set());
    expect(eventRegistry.listHandlers().map((handler) => handler.id)).toEqual(["handler-b"]);
    expect(failures).toEqual([]);
    eventRegistry.clearHandlers();
  });
});

describe("resolveTabId", () => {
  beforeEach(() => {
    vi.stubGlobal("chrome", {
      tabs: {
        get: vi.fn(async (tabId: number) => ({ id: tabId })),
        query: vi.fn(async () => [{ id: 3 }]),
      },
    });
  });

  it("prefers a valid explicit tab over the session fallback", async () => {
    await expect(resolveTabId(7, 8)).resolves.toBe(7);
    expect(chrome.tabs.get).toHaveBeenCalledWith(7);
  });

  it("rejects an invalid explicit tab instead of using the fallback", async () => {
    vi.mocked(chrome.tabs.get).mockRejectedValueOnce(new Error("missing"));

    await expect(resolveTabId(7, 8)).rejects.toThrow("TAB_CLOSED");
    expect(chrome.tabs.get).toHaveBeenCalledTimes(1);
  });

  it("uses a valid session fallback before querying the active tab", async () => {
    await expect(resolveTabId(undefined, 8)).resolves.toBe(8);
    expect(chrome.tabs.query).not.toHaveBeenCalled();
  });

  it("uses the active tab when the stored fallback is stale", async () => {
    vi.mocked(chrome.tabs.get).mockRejectedValueOnce(new Error("missing"));

    await expect(resolveTabId(undefined, 8)).resolves.toBe(3);
  });
});
