import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { readModel, resolveOnPage } from "../page/engine.js";
import { candidateLine } from "../page/resolve.js";
import type { Tool } from "./types.js";

const FindArgs = z.object({
  tabId: z.number().optional().describe("Target tab ID. If omitted, uses this session's current tab (opened with new_tab or browser_navigate, or chosen with select_tab), never the user's active tab."),
  role: z.string().optional().describe("ARIA role to search for (e.g. button, link, searchbox)"),
  name: z.string().optional().describe("Accessible name or partial text match"),
  text: z.string().optional().describe("Visible text content to match"),
  selector: z.string().optional().describe("CSS selector"),
  limit: z.number().optional().default(10).describe("Max results to return (default 10)"),
  query: z.string().optional().describe("Find by meaning across the whole page, e.g. 'where do I set the end date'. Returns outline refs (o12) usable as ref in other tools."),
});

export const find: Tool = {
  schema: {
    name: "browser_find",
    description: "Find elements on the page by role, name, text, or selector, or by meaning with query (whole page, returns o-refs). Read-only — does not interact with elements.",
    inputSchema: zodToJsonSchema(FindArgs),
  },
  handle: async (context, params) => {
    const validated = FindArgs.parse(params);
    if (validated.query) {
      const model = await readModel(context, validated.tabId);
      const [r] = await resolveOnPage(context, model, [{ target: validated.query }]);
      const text = r!.status === "resolved"
        ? `Best match: ${candidateLine(r!.element)} (${r!.via}${r!.via === "decider" ? `, confidence ${r!.confidence.toFixed(2)}` : ""}).`
        : r!.status === "not_found"
          ? `Not on this page: ${r!.reason}.`
          : `No single clear match (${r!.reason}). Possible: ${r!.candidates.map(candidateLine).join("; ")}`;
      return { content: [{ type: "text", text }] };
    }
    const { tabId, query: _query, ...rest } = validated;
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
