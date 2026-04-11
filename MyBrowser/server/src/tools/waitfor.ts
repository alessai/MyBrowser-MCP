import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { Tool } from "./types.js";

// --- browser_wait_for ---

const WaitForArgs = z.object({
  tabId: z.number().optional().describe("Target tab ID. If omitted, uses the active tab."),
  condition: z.enum([
    "url_contains",
    "url_matches",
    "element_visible",
    "element_not_visible",
    "text_visible",
    "text_not_visible",
    "network_idle",
  ]).describe("Condition to wait for"),
  value: z.string().optional().describe("Parameter for the condition (URL substring, regex pattern, or text to match)"),
  selector: z.string().optional().describe("CSS selector for element_visible / element_not_visible conditions"),
  timeout: z.number().optional().default(10000).describe("Max wait time in ms (default 10000)"),
  pollInterval: z.number().optional().default(500).describe("Poll interval in ms (default 500)"),
});

export const waitFor: Tool = {
  schema: {
    name: "browser_wait_for",
    description:
      "Wait for a condition to be met on the page. Polls at intervals until the condition is true or timeout is reached. Conditions: url_contains, url_matches, element_visible, element_not_visible, text_visible, text_not_visible, network_idle (no pending network requests for a quiet window).",
    inputSchema: zodToJsonSchema(WaitForArgs),
  },
  handle: async (context, params) => {
    const validated = WaitForArgs.parse(params);
    const { tabId, ...rest } = validated;
    const payload = tabId !== undefined ? { ...rest, tabId } : rest;
    const result = await context.sendSocketMessage("browser_wait_for", payload, {
      timeoutMs: validated.timeout + 5000,
    });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  },
};

// --- browser_assert ---

const AssertCheckSchema = z.object({
  type: z.enum([
    "url_contains",
    "url_matches",
    "element_visible",
    "element_not_visible",
    "text_contains",
    "text_not_contains",
    "element_count",
    "console_no_errors",
    "title_contains",
  ]).describe("Type of assertion check"),
  value: z.string().optional().describe("Value to check against (URL substring, regex, text, or title text)"),
  selector: z.string().optional().describe("CSS selector for element checks"),
  min: z.number().optional().describe("Minimum element count (for element_count)"),
  max: z.number().optional().describe("Maximum element count (for element_count)"),
});

const AssertArgs = z.object({
  tabId: z.number().optional().describe("Target tab ID. If omitted, uses the active tab."),
  checks: z.array(AssertCheckSchema).describe("List of assertion checks to run"),
});

export const assert: Tool = {
  schema: {
    name: "browser_assert",
    description:
      "Run multiple assertion checks on the current page state. Returns structured pass/fail results for each check — does NOT throw on failure, letting you decide what to do. Check types: url_contains, url_matches, element_visible, element_not_visible, text_contains, text_not_contains, element_count, console_no_errors, title_contains.",
    inputSchema: zodToJsonSchema(AssertArgs),
  },
  handle: async (context, params) => {
    const validated = AssertArgs.parse(params);
    const { tabId, ...rest } = validated;
    const payload = tabId !== undefined ? { ...rest, tabId } : rest;
    const result = await context.sendSocketMessage("browser_assert", payload);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  },
};
