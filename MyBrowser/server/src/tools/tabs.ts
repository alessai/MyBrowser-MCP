import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { Tool } from "./types.js";

const ListTabsArgs = z.object({});

const SelectTabArgs = z.object({
  tabId: z.number().describe("The tab ID to switch to"),
});

const NewTabArgs = z.object({
  url: z.string().optional().describe("URL to open in the new tab. Opens blank tab if omitted."),
});

const CloseTabArgs = z.object({
  tabId: z.number().describe("The tab ID to close"),
});

export const listTabs: Tool = {
  schema: {
    name: "list_tabs",
    description: "List all open browser tabs with their IDs, titles, URLs, and active status",
    inputSchema: zodToJsonSchema(ListTabsArgs),
  },
  handle: async (context) => {
    const tabs = await context.sendSocketMessage("list_tabs", {});
    const text = (tabs as any[])
      .map(
        (t: any) =>
          `${t.active ? "* " : "  "}[${t.tabId}] ${t.title} - ${t.url} (window: ${t.windowId})`
      )
      .join("\n");
    return { content: [{ type: "text", text: text || "No tabs found" }] };
  },
};

export const selectTab: Tool = {
  schema: {
    name: "select_tab",
    description: "Switch to a specific browser tab by its ID",
    inputSchema: zodToJsonSchema(SelectTabArgs),
  },
  handle: async (context, params) => {
    const { tabId } = SelectTabArgs.parse(params);
    await context.sendSocketMessage("select_tab", { tabId });
    return { content: [{ type: "text", text: `Switched to tab ${tabId}` }] };
  },
};

export const newTab: Tool = {
  schema: {
    name: "new_tab",
    description: "Open a new browser tab, optionally navigating to a URL",
    inputSchema: zodToJsonSchema(NewTabArgs),
  },
  handle: async (context, params) => {
    const { url } = NewTabArgs.parse(params ?? {});
    const result = await context.sendSocketMessage("new_tab", { url });
    const tabId = (result as any)?.tabId;
    const text = url
      ? `Opened new tab ${tabId ?? ""} with ${url}`
      : `Opened new blank tab ${tabId ?? ""}`;
    return { content: [{ type: "text", text: text.trim() }] };
  },
};

export const closeTab: Tool = {
  schema: {
    name: "close_tab",
    description: "Close a specific browser tab by its ID",
    inputSchema: zodToJsonSchema(CloseTabArgs),
  },
  handle: async (context, params) => {
    const { tabId } = CloseTabArgs.parse(params);
    await context.sendSocketMessage("close_tab", { tabId });
    return { content: [{ type: "text", text: `Closed tab ${tabId}` }] };
  },
};
