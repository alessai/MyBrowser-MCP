import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { captureAriaSnapshot } from "../utils/aria-snapshot.js";
import { openSessionTab } from "./tabs.js";
import type { Tool } from "./types.js";

const TabIdParam = z.object({
  tabId: z.number().optional().describe("Target tab ID. If omitted, uses this session's current tab (from new_tab or select_tab), never the user's active tab."),
});

const NavigateArgs = TabIdParam.extend({
  url: z.string().describe("The URL to navigate to"),
});

const GoBackArgs = TabIdParam;
const GoForwardArgs = TabIdParam;

const WaitArgs = TabIdParam.extend({
  time: z.number().describe("The time to wait in seconds"),
});

export const navigate = (snapshot: boolean): Tool => ({
  schema: {
    name: "browser_navigate",
    description: "Navigate to a URL. Without tabId it uses this session's current tab, or opens a new temporary tab for the session if it has none.",
    inputSchema: zodToJsonSchema(NavigateArgs),
  },
  handle: async (context, params) => {
    const { url, tabId } = NavigateArgs.parse(params);
    const payload = tabId !== undefined ? { url, tabId } : { url };
    let target = tabId;
    let opened = false;
    try {
      await context.sendSocketMessage("browser_navigate", payload);
    } catch (error) {
      // No tab of its own yet: open one rather than taking over the user's tab.
      if (tabId !== undefined || !String(error).includes("NO_SESSION_TAB")) throw error;
      target = await openSessionTab(context, url);
      opened = true;
    }
    const note = opened ? `Opened new tab ${target ?? ""} for this session (it had none).`.replace("  ", " ") : "";
    if (snapshot) {
      const result = await captureAriaSnapshot(context, "", target);
      return note ? { ...result, content: [{ type: "text", text: note }, ...result.content] } : result;
    }
    return { content: [{ type: "text", text: `${note ? `${note} ` : ""}Navigated to ${url}` }] };
  },
});

export const goBack = (snapshot: boolean): Tool => ({
  schema: {
    name: "browser_go_back",
    description: "Go back to the previous page",
    inputSchema: zodToJsonSchema(GoBackArgs),
  },
  handle: async (context, params) => {
    const { tabId } = GoBackArgs.parse(params ?? {});
    const payload = tabId !== undefined ? { tabId } : {};
    await context.sendSocketMessage("browser_go_back", payload);
    if (snapshot) {
      return captureAriaSnapshot(context, "", tabId);
    }
    return { content: [{ type: "text", text: "Navigated back" }] };
  },
});

export const goForward = (snapshot: boolean): Tool => ({
  schema: {
    name: "browser_go_forward",
    description: "Go forward to the next page",
    inputSchema: zodToJsonSchema(GoForwardArgs),
  },
  handle: async (context, params) => {
    const { tabId } = GoForwardArgs.parse(params ?? {});
    const payload = tabId !== undefined ? { tabId } : {};
    await context.sendSocketMessage("browser_go_forward", payload);
    if (snapshot) {
      return captureAriaSnapshot(context, "", tabId);
    }
    return { content: [{ type: "text", text: "Navigated forward" }] };
  },
});

export const wait: Tool = {
  schema: {
    name: "browser_wait",
    description: "Wait for a specified time in seconds",
    inputSchema: zodToJsonSchema(WaitArgs),
  },
  handle: async (context, params) => {
    const { time, tabId } = WaitArgs.parse(params);
    const payload = tabId !== undefined ? { time, tabId } : { time };
    await context.sendSocketMessage("browser_wait", payload);
    return { content: [{ type: "text", text: `Waited for ${time} seconds` }] };
  },
};
