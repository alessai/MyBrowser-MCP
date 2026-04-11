import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { Tool } from "./types.js";

const FindArgs = z.object({
  tabId: z.number().optional().describe("Target tab ID. If omitted, uses the active tab."),
  role: z.string().optional().describe("ARIA role to search for (e.g. button, link, searchbox)"),
  name: z.string().optional().describe("Accessible name or partial text match"),
  text: z.string().optional().describe("Visible text content to match"),
  selector: z.string().optional().describe("CSS selector"),
  limit: z.number().optional().default(10).describe("Max results to return (default 10)"),
});

export const find: Tool = {
  schema: {
    name: "browser_find",
    description: "Find elements on the page by role, name, text, or selector. Returns matching elements with their mark numbers, roles, names, and positions. Read-only — does not interact with elements.",
    inputSchema: zodToJsonSchema(FindArgs),
  },
  handle: async (context, params) => {
    const validated = FindArgs.parse(params);
    const { tabId, ...rest } = validated;
    const payload = tabId !== undefined ? { ...rest, tabId } : rest;
    const results = await context.sendSocketMessage("browser_find", payload);
    return {
      content: [
        {
          type: "text",
          text: typeof results === "string" ? results : JSON.stringify(results, null, 2),
        },
      ],
    };
  },
};
