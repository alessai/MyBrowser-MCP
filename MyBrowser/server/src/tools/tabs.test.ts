import { describe, expect, it, vi } from "vitest";
import type { Context } from "../context.js";
import type { IStateManager } from "../state-manager.js";
import { createTabTools } from "./tabs.js";

function fixture() {
  const stateManager = {
    listBrowsers: vi.fn(async () => [
      { id: "browser-a", name: "A", connectedAt: 1 },
      { id: "browser-b", name: "B", connectedAt: 2 },
    ]),
    releaseAllTabs: vi.fn(async () => undefined),
    clearSessionBrowser: vi.fn(async () => true),
  } as unknown as IStateManager;
  const context = {
    sendSocketMessage: vi.fn(async () => ({ tabId: 42 })),
    sendSocketMessageToBrowser: vi.fn(async () => ({ kept: true })),
  } as unknown as Context;
  return {
    stateManager,
    context,
    tools: createTabTools({
      stateManager,
      context,
      getSessionId: () => "session-a",
      getActiveBrowser: async () => "browser-a",
    }),
  };
}

describe("tab lifecycle tools", () => {
  it.each([
    [{}, { url: undefined, temporary: undefined }],
    [{ temporary: false }, { url: undefined, temporary: false }],
  ])("forwards temporary new-tab intent", async (params, expected) => {
    const { context, tools } = fixture();
    await tools.newTab.handle(context, params);
    expect(context.sendSocketMessage).toHaveBeenCalledWith("new_tab", expected);
  });

  it("keeps a tab on the explicit or resolved browser", async () => {
    const { context, tools } = fixture();
    await tools.keepTab.handle(context, { tabId: 7, browserId: "browser-b" });
    await tools.keepTab.handle(context, { tabId: 8 });
    expect(context.sendSocketMessageToBrowser).toHaveBeenNthCalledWith(1, "browser-b", "keep_tab", { tabId: 7 });
    expect(context.sendSocketMessageToBrowser).toHaveBeenNthCalledWith(2, "browser-a", "keep_tab", { tabId: 8 });
  });

  it("cleans every connected browser and always resets claims and routing", async () => {
    const { stateManager, context, tools } = fixture();
    vi.mocked(context.sendSocketMessageToBrowser).mockImplementation(async (browserId) => {
      if (browserId === "browser-b") throw new Error("disconnected");
      return { closed: 1 };
    });

    const result = await tools.browserCleanup.handle(context, {});

    expect(context.sendSocketMessageToBrowser).toHaveBeenCalledWith("browser-a", "cleanup_session_tabs", {});
    expect(context.sendSocketMessageToBrowser).toHaveBeenCalledWith("browser-b", "cleanup_session_tabs", {});
    expect(stateManager.releaseAllTabs).toHaveBeenCalledWith("session-a");
    expect(stateManager.clearSessionBrowser).toHaveBeenCalledWith("session-a");
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toContain("browser-b");
    expect(JSON.stringify(result)).not.toContain("session-a");
  });

  it("resets claims and routing when browser enumeration fails", async () => {
    const { stateManager, context, tools } = fixture();
    vi.mocked(stateManager.listBrowsers).mockRejectedValueOnce(new Error("registry unavailable"));

    const result = await tools.browserCleanup.handle(context, {});

    expect(context.sendSocketMessageToBrowser).not.toHaveBeenCalled();
    expect(stateManager.releaseAllTabs).toHaveBeenCalledWith("session-a");
    expect(stateManager.clearSessionBrowser).toHaveBeenCalledWith("session-a");
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).not.toContain("registry unavailable");
  });
});
