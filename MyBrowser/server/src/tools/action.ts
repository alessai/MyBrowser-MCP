import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { captureAriaSnapshot } from "../utils/aria-snapshot.js";
import type { Tool } from "./types.js";

const AssertCheckSchema = z.object({
  type: z.enum([
    "url_contains",
    "url_matches",
    "element_visible",
    "element_not_visible",
    "text_contains",
    "console_no_errors",
  ]).describe("Type of assertion to check"),
  value: z.string().optional().describe("Value to check against (URL substring, regex, text, etc.)"),
  selector: z.string().optional().describe("CSS selector for element visibility checks"),
});

const ActionStepSchema = z.object({
  action: z.enum([
    "click",
    "type",
    "navigate",
    "wait",
    "wait_for",
    "press_key",
    "snapshot",
    "screenshot",
    "select_option",
    "scroll",
    "extract",
    "assert",
  ]).describe("The action to perform"),
  // Element targeting
  ref: z.string().optional().describe("Element reference from snapshot (e.g. e42)"),
  mark: z.number().optional().describe("Set-of-Marks annotation number"),
  selector: z.string().optional().describe("CSS selector"),
  role: z.string().optional().describe("ARIA role to match"),
  name: z.string().optional().describe("Accessible name or partial match"),
  text: z.string().optional().describe("Visible text content to match"),
  label: z.string().optional().describe("Form field label text"),
  // Action-specific params
  url: z.string().optional().describe("URL for navigate action"),
  typedText: z.string().optional().describe("Text to type (for type action)"),
  submit: z.boolean().optional().describe("Press Enter after typing"),
  key: z.string().optional().describe("Key name for press_key (e.g. Enter, ArrowDown)"),
  time: z.number().optional().describe("Seconds to wait (for wait action)"),
  condition: z.string().optional().describe(
    "Condition for wait_for: 'url_contains:X', 'element_visible:selector', 'text_visible:X'"
  ),
  timeout: z.number().optional().describe("Timeout in seconds for wait_for (default 10)"),
  values: z.array(z.string()).optional().describe("Values for select_option"),
  direction: z.enum(["down", "up"]).optional().describe("Scroll direction"),
  amount: z.number().optional().describe("Scroll amount in pixels (default 300)"),
  extractSelector: z.string().optional().describe("CSS selector for extract containers"),
  extractFields: z.record(z.string()).optional().describe("Field map for extract (name -> selector)"),
  checks: z.array(AssertCheckSchema).optional().describe("Assertion checks for assert action"),
});

const ActionArgs = z.object({
  tabId: z.number().optional().describe("Target tab ID. If omitted, uses the active tab."),
  steps: z.array(ActionStepSchema).describe(
    "Array of action steps to execute in sequence. Each step runs one browser action. " +
    "The sequence stops on the first error by default. " +
    "Supported actions: click, type, navigate, wait, wait_for, press_key, snapshot, screenshot, select_option, scroll, extract, assert."
  ),
  stopOnError: z.boolean().optional().describe(
    "Stop execution on first error (default true). Set false to continue through failures."
  ),
});

export const action: Tool = {
  schema: {
    name: "browser_action",
    description:
      "Execute a sequence of browser actions in a single call. " +
      "Combines click, type, navigate, wait, press_key, snapshot, screenshot, select_option, scroll, extract, and assert steps. " +
      "Each step auto-waits for stable DOM after mutating actions. " +
      "Returns per-step results with timing. Stops on first error by default. " +
      "Use this to perform multi-step workflows efficiently in one round trip.",
    inputSchema: zodToJsonSchema(ActionArgs),
  },
  handle: async (context, params) => {
    const validated = ActionArgs.parse(params);
    const { tabId, steps, stopOnError } = validated;

    const payload: Record<string, unknown> = {
      steps,
      stopOnError: stopOnError ?? true,
    };
    if (tabId !== undefined) payload.tabId = tabId;

    const result = await context.sendSocketMessage("browser_action", payload, {
      timeoutMs: 120_000,
    });

    const actionResult = result as {
      status: string;
      stepsCompleted: number;
      totalSteps: number;
      results: Array<{
        step: number;
        action: string;
        status: string;
        result?: unknown;
        error?: string;
        durationMs: number;
      }>;
      finalSnapshot?: string;
      error?: string;
    };

    // Build response text
    const lines: string[] = [];
    lines.push(`Action sequence: ${actionResult.status} (${actionResult.stepsCompleted}/${actionResult.totalSteps} steps)`);

    for (const r of actionResult.results) {
      const icon = r.status === "success" ? "[OK]" : "[FAIL]";
      const duration = `${r.durationMs}ms`;
      const detail = r.error ? ` - ${r.error}` : "";
      lines.push(`  ${icon} Step ${r.step}: ${r.action} (${duration})${detail}`);
    }

    if (actionResult.error) {
      lines.push(`\nError: ${actionResult.error}`);
    }

    const content: Array<{ type: "text"; text: string }> = [
      { type: "text", text: lines.join("\n") },
    ];

    // If the sequence completed and the last step was a snapshot, include it
    if (actionResult.finalSnapshot) {
      content.push({
        type: "text",
        text: `\nFinal Snapshot:\n\`\`\`yaml\n${actionResult.finalSnapshot}\n\`\`\``,
      });
    }

    // Auto-capture a snapshot after sequence completes for context
    if (!actionResult.finalSnapshot && actionResult.status === "completed") {
      try {
        const snap = await captureAriaSnapshot(context, "", tabId);
        content.push(...snap.content as Array<{ type: "text"; text: string }>);
      } catch {
        // Snapshot may fail if page changed; that's ok
      }
    }

    return {
      content,
      isError: actionResult.status === "failed",
    };
  },
};
