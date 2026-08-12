import { describe, expect, it, vi } from "vitest";

import { NetworkCaptureController } from "./network-capture-controller";
import { RequestToolContext, resolveInitialTab } from "./request-context";
import { TemporaryTabManager } from "./temporary-tabs";

function createServices(): {
  networkCapture: NetworkCaptureController;
  temporaryTabs: TemporaryTabManager;
} {
  return {
    networkCapture: new NetworkCaptureController(),
    temporaryTabs: {} as TemporaryTabManager,
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("RequestToolContext", () => {
  it("shares only the explicitly injected network capture target", async () => {
    const networkCapture = new NetworkCaptureController();
    const sessionState = {
      setLastTab: vi.fn(async () => undefined),
      clearTab: vi.fn(async () => undefined),
    };
    const first = new RequestToolContext({
      sessionId: "session-a",
      requestId: "request-a",
      expiresAt: 100,
      tabId: 1,
      sessionState,
      services: { networkCapture, temporaryTabs: {} as TemporaryTabManager },
    });
    const second = new RequestToolContext({
      sessionId: "session-b",
      requestId: "request-b",
      expiresAt: 100,
      tabId: 2,
      sessionState,
      services: { networkCapture, temporaryTabs: {} as TemporaryTabManager },
    });

    expect(first.services).not.toBe(second.services);
    expect(first.services.networkCapture).toBe(networkCapture);
    expect(second.services.networkCapture).toBe(networkCapture);
    expect(networkCapture.targetTabId).toBeNull();

    await first.setTabId(3);
    expect(networkCapture.targetTabId).toBeNull();

    networkCapture.commitStart(networkCapture.beginStart(first.getTabId()));
    expect(networkCapture.targetTabId).toBe(3);
    expect(second.getTabId()).toBe(2);

    await second.setTabId(4);
    expect(networkCapture.targetTabId).toBe(3);
  });

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
      services: createServices(),
    });
    const second = new RequestToolContext({
      sessionId: "session-a",
      requestId: "request-b",
      expiresAt: 100,
      tabId: 2,
      sessionState: state,
      services: createServices(),
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
      services: createServices(),
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
      services: createServices(),
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
    const networkCapture = new NetworkCaptureController();
    networkCapture.commitStart(networkCapture.beginStart(12));
    const context = new RequestToolContext({
      sessionId: "session-a",
      requestId: "request-a",
      expiresAt: 100,
      tabId: 12,
      sessionState: { setLastTab: vi.fn(async () => undefined), clearTab },
      services: { networkCapture, temporaryTabs: {} as TemporaryTabManager },
    });
    let finished = false;

    const pending = context.clearTab(12).then(() => {
      finished = true;
    });
    await Promise.resolve();

    expect(context.getTabId()).toBe(-1);
    expect(context.input.tabId).toBe(-1);
    expect(networkCapture.active).toBe(false);
    expect(finished).toBe(false);
    removal.resolve();
    await pending;
    expect(clearTab).toHaveBeenCalledWith(12);
  });
});

describe("resolveInitialTab", () => {
  it("performs no tab lookup for tab:none even with an irrelevant tabId", async () => {
    const resolveTabId = vi.fn(async () => 7);
    const clearFallback = vi.fn(async () => undefined);

    await expect(resolveInitialTab({
      requirement: "none",
      requestedTabId: 99,
      sessionFallback: 8,
      resolveTabId,
      clearFallback,
    })).resolves.toBe(-1);

    expect(resolveTabId).not.toHaveBeenCalled();
    expect(clearFallback).not.toHaveBeenCalled();
  });

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
