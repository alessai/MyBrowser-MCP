import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { Tool } from "./types.js";

const ClipboardArgs = z.object({
  tabId: z.number().optional().describe("Target tab ID. If omitted, uses the active tab."),
  action: z.enum(["read", "write", "paste"]).describe(
    "read: read clipboard text content. write: write text to clipboard. paste: simulate Ctrl+V paste into focused element."
  ),
  text: z.string().optional().describe("Text to write to clipboard (required for 'write' action)"),
});

export const clipboard: Tool = {
  schema: {
    name: "browser_clipboard",
    description: "Read, write, or paste clipboard content. Useful for paste-based uploads on social media platforms. 'write' sets clipboard text, 'paste' simulates Ctrl+V into the focused element, 'read' returns current clipboard text.",
    inputSchema: zodToJsonSchema(ClipboardArgs),
  },
  handle: async (context, params) => {
    const args = ClipboardArgs.parse(params);
    const payload = { ...args };
    const result = await context.sendSocketMessage("browser_clipboard", payload);
    return {
      content: [
        { type: "text" as const, text: typeof result === "string" ? result : JSON.stringify(result, null, 2) },
      ],
    };
  },
};
