import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { Tool } from "./types.js";

const TabIdParam = z.object({
  tabId: z.number().optional().describe("Target tab ID. If omitted, uses the active tab."),
});

const NetworkArgs = TabIdParam.extend({
  action: z.enum(["start_capture", "stop_capture", "get_log", "clear"]).describe(
    "start_capture: enable network capture. stop_capture: disable capture and stop recording. get_log: return captured entries with filters. clear: reset the log."
  ),
  filter: z.object({
    url: z.string().optional().describe("Filter entries by URL substring match."),
    method: z.string().optional().describe("Filter by HTTP method (GET, POST, etc)."),
    statusMin: z.number().optional().describe("Minimum HTTP status code (inclusive)."),
    statusMax: z.number().optional().describe("Maximum HTTP status code (inclusive)."),
    resourceType: z.string().optional().describe("Filter by resource type (Document, Stylesheet, Image, Script, XHR, Fetch, etc)."),
  }).optional().describe("Filters to apply when action is get_log."),
  limit: z.number().optional().default(50).describe("Max entries to return (default 50). Only used with get_log."),
});

export const network: Tool = {
  schema: {
    name: "browser_network",
    description:
      "Capture and inspect network requests. Use start_capture to begin recording HTTP traffic, get_log to retrieve captured requests with optional filters, and clear to reset.",
    inputSchema: zodToJsonSchema(NetworkArgs),
  },
  handle: async (context, params) => {
    const args = NetworkArgs.parse(params ?? {});
    const { tabId, ...rest } = args;
    const payload = tabId !== undefined ? { tabId, ...rest } : { ...rest };
    const result = await context.sendSocketMessage("browser_network", payload);
    return {
      content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result, null, 2) }],
    };
  },
};
