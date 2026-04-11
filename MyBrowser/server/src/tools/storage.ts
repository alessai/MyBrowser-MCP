import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { Tool } from "./types.js";

const StorageArgs = z.object({
  tabId: z.number().optional().describe("Target tab ID. If omitted, uses the active tab."),
  action: z.enum(["get", "set", "delete", "clear"]).describe("Storage operation to perform"),
  type: z.enum(["localStorage", "sessionStorage", "cookies"]).describe("Storage type to operate on"),
  key: z.string().optional().describe("Storage key (required for get/set/delete on localStorage/sessionStorage)"),
  value: z.string().optional().describe("Value to set (required for 'set' action on localStorage/sessionStorage)"),
  domain: z.string().optional().describe("Cookie domain filter (only used with cookies type)"),
});

export const browserStorage: Tool = {
  schema: {
    name: "browser_storage",
    description:
      "Inspect and modify browser storage: localStorage, sessionStorage, and cookies. Use action 'get' to read, 'set' to write, 'delete' to remove a key, and 'clear' to remove all entries.",
    inputSchema: zodToJsonSchema(StorageArgs),
  },
  handle: async (context, params) => {
    const validated = StorageArgs.parse(params);
    const { tabId, ...rest } = validated;
    const payload = tabId !== undefined ? { ...rest, tabId } : rest;
    const result = await context.sendSocketMessage("browser_storage", payload);
    return {
      content: [
        {
          type: "text",
          text: typeof result === "string" ? result : JSON.stringify(result, null, 2),
        },
      ],
    };
  },
};
