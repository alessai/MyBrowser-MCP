import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { Tool } from "./types.js";

const ExtractArgs = z.object({
  tabId: z.number().optional().describe("Target tab ID. If omitted, uses the active tab."),
  selector: z.string().describe("CSS selector for container elements to extract from (e.g. '.product-card', 'table tr')"),
  fields: z.record(z.string()).describe(
    "Map of field names to CSS selectors relative to each container. Use 'self' for the container's own text content, '@href' or '@src' for attribute values. Example: {\"name\": \"h2 a\", \"price\": \".price\", \"url\": \"a@href\"}"
  ),
  limit: z.number().optional().default(10).describe("Max items to extract (default 10)"),
});

export const extract: Tool = {
  schema: {
    name: "browser_extract",
    description: "Extract structured data from the page. Returns a JSON array of objects matching the field selectors. Treats the page as a data source — no snapshot or refs needed.",
    inputSchema: zodToJsonSchema(ExtractArgs),
  },
  handle: async (context, params) => {
    const validated = ExtractArgs.parse(params);
    const { tabId, ...rest } = validated;
    const payload = tabId !== undefined ? { ...rest, tabId } : rest;
    const results = await context.sendSocketMessage("browser_extract", payload);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(results, null, 2),
        },
      ],
    };
  },
};
