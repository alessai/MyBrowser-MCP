import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { Context } from "../context.js";
import type { IStateManager } from "../state-manager.js";
import type { Tool } from "./types.js";

const ListTabsArgs = z.object({});
const SelectTabArgs = z.object({ tabId: z.number().describe("The tab ID to switch to") });
const NewTabArgs = z.object({
  url: z.string().optional().describe("URL to open in the new tab. Opens blank tab if omitted."),
  temporary: z.boolean().optional().describe("Temporary by default. Set false to preserve the tab without calling keep_tab."),
});
const CloseTabArgs = z.object({ tabId: z.number().describe("The tab ID to close") });
const KeepTabArgs = z.object({
  tabId: z.number().describe("The temporary tab ID to preserve"),
  browserId: z.string().optional().describe("Browser containing the tab. Defaults to this session's resolved browser."),
});
const CleanupArgs = z.object({});

export interface TabToolDependencies {
  stateManager: IStateManager;
  context: Context;
  getSessionId: () => string;
  getActiveBrowser: () => Promise<string>;
}

export function createTabTools({
  stateManager,
  context,
  getSessionId,
  getActiveBrowser,
}: TabToolDependencies) {
  const listTabs: Tool = {
    schema: {
      name: "list_tabs",
      description: "List all open browser tabs with their IDs, titles, URLs, and active status",
      inputSchema: zodToJsonSchema(ListTabsArgs),
    },
    handle: async () => {
      const tabs = await context.sendSocketMessage("list_tabs", {});
      const text = (tabs as any[]).map((t: any) =>
        `${t.active ? "* " : "  "}[${t.tabId}] ${t.title} - ${t.url} (window: ${t.windowId})`
      ).join("\n");
      return { content: [{ type: "text", text: text || "No tabs found" }] };
    },
  };

  const selectTab: Tool = {
    schema: {
      name: "select_tab",
      description: "Switch to a specific browser tab by its ID",
      inputSchema: zodToJsonSchema(SelectTabArgs),
    },
    handle: async (_context, params) => {
      const { tabId } = SelectTabArgs.parse(params);
      await context.sendSocketMessage("select_tab", { tabId });
      return { content: [{ type: "text", text: `Switched to tab ${tabId}` }] };
    },
  };

  const newTab: Tool = {
    schema: {
      name: "new_tab",
      description: "Opens a temporary tab by default. Call keep_tab to preserve it. Finish browser research with browser_cleanup.",
      inputSchema: zodToJsonSchema(NewTabArgs),
    },
    handle: async (_context, params) => {
      const { url, temporary } = NewTabArgs.parse(params ?? {});
      const result = await context.sendSocketMessage("new_tab", { url, temporary });
      const tabId = (result as any)?.tabId;
      const text = url
        ? `Opened new tab ${tabId ?? ""} with ${url}`
        : `Opened new blank tab ${tabId ?? ""}`;
      return { content: [{ type: "text", text: text.trim() }] };
    },
  };

  const closeTab: Tool = {
    schema: {
      name: "close_tab",
      description: "Close a specific browser tab by its ID",
      inputSchema: zodToJsonSchema(CloseTabArgs),
    },
    handle: async (_context, params) => {
      const { tabId } = CloseTabArgs.parse(params);
      await context.sendSocketMessage("close_tab", { tabId });
      return { content: [{ type: "text", text: `Closed tab ${tabId}` }] };
    },
  };

  const keepTab: Tool = {
    schema: {
      name: "keep_tab",
      description: "Preserve one tab created by this MCP session so browser_cleanup or session closure will not close it.",
      inputSchema: zodToJsonSchema(KeepTabArgs),
    },
    handle: async (_context, params) => {
      const { tabId, browserId: explicitBrowserId } = KeepTabArgs.parse(params);
      const browserId = explicitBrowserId ?? await getActiveBrowser();
      const result = await context.sendSocketMessageToBrowser(browserId, "keep_tab", { tabId });
      const kept = (result as { kept?: boolean } | undefined)?.kept === true;
      return {
        content: [{
          type: "text",
          text: kept ? `Tab ${tabId} will be kept.` : `Tab ${tabId} is not a temporary tab owned by this session.`,
        }],
      };
    },
  };

  const browserCleanup: Tool = {
    schema: {
      name: "browser_cleanup",
      description: "Close every temporary tab this MCP session opened across connected browsers and return routing to the shared default. Call once after browser research, including failure paths.",
      inputSchema: zodToJsonSchema(CleanupArgs),
    },
    handle: async () => {
      const sessionId = getSessionId();
      let browsers: Awaited<ReturnType<IStateManager["listBrowsers"]>> = [];
      let outcomes: PromiseSettledResult<string>[] = [];
      let enumerationFailed = false;
      let resetFailed = false;
      try {
        browsers = await stateManager.listBrowsers();
        outcomes = await Promise.allSettled(browsers.map(async ({ id }) => {
          await context.sendSocketMessageToBrowser(id, "cleanup_session_tabs", {});
          return id;
        }));
      } catch {
        enumerationFailed = true;
      } finally {
        const reset = await Promise.allSettled([
          stateManager.releaseAllTabs(sessionId),
          stateManager.clearSessionBrowser(sessionId),
        ]);
        resetFailed = reset.some(({ status }) => status === "rejected");
      }
      const failed = outcomes.flatMap((outcome, index) =>
        outcome.status === "rejected" ? [browsers[index]!.id] : []
      );
      const cleaned = outcomes.length - failed.length;
      const failedCleanup = enumerationFailed || resetFailed || failed.length > 0;
      return {
        content: [{
          type: "text",
          text: !failedCleanup
            ? `Browser cleanup completed on ${cleaned} connected browser(s); routing now follows the shared default.`
            : `Browser cleanup was partial${failed.length > 0 ? ` on browser IDs: ${failed.join(", ")}` : ""}. Claims and routing reset was attempted.`,
        }],
        ...(failedCleanup ? { isError: true } : {}),
      };
    },
  };

  return { listTabs, selectTab, newTab, closeTab, keepTab, browserCleanup };
}
