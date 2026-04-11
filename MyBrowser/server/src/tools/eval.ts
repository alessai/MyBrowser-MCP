import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { Tool } from "./types.js";

const EvalArgs = z.object({
  tabId: z.number().optional().describe("Target tab ID. If omitted, uses the active tab."),
  code: z.string().describe("JavaScript code to execute in the page context"),
  timeout: z.number().optional().default(5000).describe("Timeout in milliseconds (default 5000)"),
});

export const browserEval: Tool = {
  schema: {
    name: "browser_eval",
    description:
      "Execute JavaScript code in the page context via CDP Runtime.evaluate. Returns the result value, or error details if execution fails. Supports async/await expressions.",
    inputSchema: zodToJsonSchema(EvalArgs),
  },
  handle: async (context, params) => {
    const validated = EvalArgs.parse(params);
    const { tabId, ...rest } = validated;
    const payload = tabId !== undefined ? { ...rest, tabId } : rest;
    const result = await context.sendSocketMessage("browser_eval", payload);
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
