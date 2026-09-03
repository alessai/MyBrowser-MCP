import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { Tool } from "./types.js";

const StorageArgs = z.object({
  tabId: z.number().optional().describe("Target tab ID. If omitted, uses the active tab."),
  action: z.enum(["get", "set", "delete", "clear"]).describe("Storage operation to perform"),
  type: z.enum(["localStorage", "sessionStorage", "cookies"]).describe("Storage type to operate on"),
  key: z.string().optional().describe("Storage key (required for get/set/delete on localStorage/sessionStorage)"),
  value: z.string().optional().describe("Value to set (required for 'set' action on localStorage/sessionStorage)"),
  domain: z.string().optional().describe("Cookie domain filter (only used with cookies type; scopes 'clear' to that site's cookies)"),
  confirmWipeAllCookies: z.boolean().optional().describe("Required true to clear ALL browser cookies when no domain is given; wipes every website login"),
});

export const browserStorage: Tool = {
  schema: {
    name: "browser_storage",
    description:
      "Inspect and modify browser storage: localStorage, sessionStorage, and cookies. Use action 'get' to read, 'set' to write, 'delete' to remove a key, and 'clear' to remove entries. WARNING: clearing cookies WITHOUT a domain deletes ALL browser cookies and logs the user out of every website — that global wipe is refused unless confirmWipeAllCookies: true is set. Prefer passing domain to clear a single site's cookies.",
    inputSchema: zodToJsonSchema(StorageArgs),
  },
  handle: async (context, params) => {
    const validated = StorageArgs.parse(params);
    if (
      validated.action === "clear" &&
      validated.type === "cookies" &&
      !validated.domain &&
      validated.confirmWipeAllCookies !== true
    ) {
      throw new Error(
        "Refusing to clear ALL browser cookies — this logs the user out of every website. Pass 'domain' to clear one site's cookies, or set confirmWipeAllCookies: true for an intentional full wipe.",
      );
    }
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
