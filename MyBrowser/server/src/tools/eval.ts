import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { FRAME_DESCRIPTION } from "../utils/aria-snapshot.js";
import type { Tool } from "./types.js";

const EvalArgs = z.object({
  tabId: z.number().optional().describe("Target tab ID. If omitted, uses the active tab."),
  code: z.string().describe("JavaScript code to execute in the page context"),
  timeout: z.number().optional().default(5000).describe("Timeout in milliseconds (default 5000)"),
  frame: z.string().optional().describe(`${FRAME_DESCRIPTION} Inside a frame the code runs as a page script, so pages that forbid eval refuse it.`),
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
