import { z } from "zod";
import { zodToJsonSchema } from "../utils/json-schema.js";
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

// Optional in the published schema so {ms: 2000} and similar reach the server and
// are rewritten (tools/arg-aliases.ts) instead of being refused by the client.
const WaitArgs = TabIdParam.extend({
  time: z.number().optional().describe("Seconds to wait (required). Up to 10 s, returns early once the page has been quiet for 1 s; e.g. {time: 3}."),
  exact: z.boolean().optional().describe("Sleep the full time even if the page settles earlier (e.g. waiting for a timer)."),
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
    description: "Let the page settle: waits up to `time` seconds and, for waits of 10 s or less, returns as soon as the page has been quiet for 1 s (exact:true sleeps the full time). To wait for something specific use browser_wait_for, which returns the moment it appears.",
    inputSchema: zodToJsonSchema(WaitArgs),
  },
  handle: async (context, params) => {
    const { time, exact, tabId } = WaitArgs.parse(params);
    if (time === undefined || !Number.isFinite(time) || time < 0) throw new Error("browser_wait needs time in seconds, e.g. {time: 3}");
    const payload: Record<string, unknown> = { time, ...(exact ? { exact } : {}), ...(tabId !== undefined ? { tabId } : {}) };
    const result = await context.sendSocketMessage("browser_wait", payload, { timeoutMs: time * 1000 + 15_000 }) as { waitedMs?: number; settled?: boolean } | undefined;
    // Older extensions return nothing and always sleep the full time.
    const text = result?.settled
      ? `Page settled after ${(result.waitedMs! / 1000).toFixed(1)} s (waited up to ${time} s).`
      : `Waited ${time} seconds.`;
    return { content: [{ type: "text", text }] };
  },
};
