import { beforeEach, describe, expect, it, vi } from "vitest";

import { SessionStateStore, type SessionStorageAdapter } from "./session-state";
import { resolveTabId } from "./tab-manager";

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

  it("awaits tab persistence before setLastTab resolves", async () => {
    const write = deferred();
    const storage = new MemoryStorage();
    storage.set = vi.fn(async () => write.promise);
    const state = new SessionStateStore(storage);
    let finished = false;

    const pending = state.setLastTab("session-a", 22).then(() => {
      finished = true;
    });
    await Promise.resolve();

    expect(finished).toBe(false);
    expect(await state.getLastTab("session-a")).toBe(22);
    write.resolve();
    await pending;
    expect(storage.set).toHaveBeenCalledWith("session-tab:session-a", 22);
  });

  it("does not let delayed hydration overwrite newer request state", async () => {
    const read = deferredValue<number | undefined>();
    const storage = new MemoryStorage();
    storage.get = vi.fn(() => read.promise) as unknown as SessionStorageAdapter['get'];
    const state = new SessionStateStore(storage);

    const hydration = state.getLastTab("session-a");
    await state.setLastTab("session-a", 22);
    read.resolve(7);

    await expect(hydration).resolves.toBe(22);
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
