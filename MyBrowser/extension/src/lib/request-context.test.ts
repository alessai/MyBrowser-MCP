import { describe, expect, it, vi } from "vitest";

import { RequestToolContext, resolveInitialTab } from "./request-context";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("RequestToolContext", () => {
  it("creates a distinct InputDevice for every public request", () => {
    const state = {
      setLastTab: vi.fn(async () => undefined),
      clearTab: vi.fn(async () => undefined),
    };

    const first = new RequestToolContext({
      sessionId: "session-a",
      requestId: "request-a",
      expiresAt: 100,
      tabId: 1,
      sessionState: state,
    });
    const second = new RequestToolContext({
      sessionId: "session-a",
      requestId: "request-b",
      expiresAt: 100,
      tabId: 2,
      sessionState: state,
    });

    expect(first.input).not.toBe(second.input);
    expect(first.input.tabId).toBe(1);
    expect(second.input.tabId).toBe(2);
  });

  it("owns immutable request identity and request-local tab state", () => {
    const context = new RequestToolContext({
      sessionId: "session-a",
      requestId: "request-a",
      expiresAt: 100,
      tabId: 4,
      sessionState: {
        setLastTab: vi.fn(async () => undefined),
        clearTab: vi.fn(async () => undefined),
      },
    });

    expect(context.sessionId).toBe("session-a");
    expect(context.requestId).toBe("request-a");
    expect(context.expiresAt).toBe(100);
    expect(context.getTabId()).toBe(4);
  });

  it("awaits session persistence when changing tabs", async () => {
    const write = deferred();
    const setLastTab = vi.fn(async () => write.promise);
    const context = new RequestToolContext({
      sessionId: "session-a",
      requestId: "request-a",
      expiresAt: 100,
      tabId: -1,
      sessionState: { setLastTab, clearTab: vi.fn(async () => undefined) },
    });
    let finished = false;

    const pending = context.setTabId(12).then(() => {
      finished = true;
    });
    await Promise.resolve();

    expect(context.getTabId()).toBe(12);
    expect(context.input.tabId).toBe(12);
    expect(setLastTab).toHaveBeenCalledWith("session-a", 12);
    expect(finished).toBe(false);
    write.resolve();
    await pending;
  });

  it("awaits state cleanup when its tab closes", async () => {
    const removal = deferred();
    const clearTab = vi.fn(async () => removal.promise);
    const context = new RequestToolContext({
      sessionId: "session-a",
      requestId: "request-a",
      expiresAt: 100,
      tabId: 12,
      sessionState: { setLastTab: vi.fn(async () => undefined), clearTab },
    });
    let finished = false;

    const pending = context.clearTab(12).then(() => {
      finished = true;
    });
    await Promise.resolve();

    expect(context.getTabId()).toBe(-1);
    expect(context.input.tabId).toBe(-1);
    expect(finished).toBe(false);
    removal.resolve();
    await pending;
    expect(clearTab).toHaveBeenCalledWith(12);
  });
});

describe("resolveInitialTab", () => {
  it.each([
    ["required", "TAB_CLOSED"],
    ["required", "TAB_NOT_FOUND"],
    ["optional", "TAB_CLOSED"],
    ["optional", "TAB_NOT_FOUND"],
  ] as const)(
    "propagates %s %s for an explicit tab without fallback or handler execution",
    async (requirement, errorCode) => {
      const resolveTabId = vi.fn(async (requestedTabId?: number) => {
        if (requestedTabId === 99) throw new Error(errorCode);
        return 7;
      });
      const clearFallback = vi.fn(async () => undefined);
      const handler = vi.fn(async (_tabId: number) => "handled");

      const dispatch = async (): Promise<string> => {
        const tabId = await resolveInitialTab({
          requirement,
          requestedTabId: 99,
          sessionFallback: 7,
          resolveTabId,
          clearFallback,
        });
        return handler(tabId);
      };

      await expect(dispatch()).rejects.toThrow(errorCode);
      expect(resolveTabId).toHaveBeenCalledTimes(1);
      expect(resolveTabId).toHaveBeenCalledWith(99);
      expect(clearFallback).not.toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();
    },
  );

  it.each(["required", "optional"] as const)(
    "rejects a malformed %s explicit tab without resolving a fallback",
    async (requirement) => {
      const resolveTabId = vi.fn(async () => 7);
      const handler = vi.fn(async (_tabId: number) => "handled");

      const dispatch = async (): Promise<string> => {
        const tabId = await resolveInitialTab({
          requirement,
          requestedTabId: "not-a-tab",
          sessionFallback: 7,
          resolveTabId,
          clearFallback: vi.fn(async () => undefined),
        });
        return handler(tabId);
      };

      await expect(dispatch()).rejects.toThrow("TAB_NOT_FOUND");
      expect(resolveTabId).not.toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();
    },
  );

  it("allows an optional omitted tab to use the session fallback", async () => {
    const resolveTabId = vi.fn(async () => 7);
    const handler = vi.fn(async (tabId: number) => tabId);

    const tabId = await resolveInitialTab({
      requirement: "optional",
      requestedTabId: undefined,
      sessionFallback: 7,
      resolveTabId,
      clearFallback: vi.fn(async () => undefined),
    });
    await handler(tabId);

    expect(resolveTabId).toHaveBeenCalledWith(undefined, 7);
    expect(handler).toHaveBeenCalledWith(7);
  });

  it("allows an optional omitted tab to proceed without a tab", async () => {
    const handler = vi.fn(async (tabId: number) => tabId);

    const tabId = await resolveInitialTab({
      requirement: "optional",
      requestedTabId: undefined,
      sessionFallback: undefined,
      resolveTabId: vi.fn(async () => {
        throw new Error("TAB_CLOSED");
      }),
      clearFallback: vi.fn(async () => undefined),
    });
    await handler(tabId);

    expect(handler).toHaveBeenCalledWith(-1);
  });
});
