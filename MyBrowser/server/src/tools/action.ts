import { z } from "zod";
import { zodToJsonSchema } from "../utils/json-schema.js";
import { outlineRefNumber } from "../page/model.js";
import { collapsedHint, outlineSelector } from "../page/refs.js";
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
  ref: z.string().optional().describe("Element reference: e42 from a snapshot or o12 from browser_outline"),
  mark: z.number().optional().describe("Set-of-Marks annotation number"),
  selector: z.string().optional().describe("CSS selector"),
  role: z.string().optional().describe("ARIA role to match"),
  name: z.string().optional().describe("Accessible name or partial match"),
  text: z.string().optional().describe("Visible text to match (to find the element). For a type step with ref/selector/label given, text is the text to type."),
  label: z.string().optional().describe("Form field label text"),
  // Action-specific params
  url: z.string().optional().describe("URL for navigate action"),
  typedText: z.string().optional().describe("Text to type (for type action)"),
  submit: z.boolean().optional().describe("Press Enter after typing"),
  key: z.string().optional().describe("Key name for press_key (e.g. Enter, ArrowDown)"),
  time: z.number().optional().describe("Seconds to wait (for wait action). Up to 10 s it returns once the page is quiet unless exact is true."),
  exact: z.boolean().optional().describe("wait: sleep the full time even if the page settles earlier"),
  condition: z.string().optional().describe(
    "Condition for wait_for, same as browser_wait_for: text_visible, text_not_visible, url_contains, url_matches, element_visible, element_not_visible, network_idle. Put the text/URL in value and the CSS in selector, or write it as 'text_visible:Saved'."
  ),
  value: z.string().optional().describe("wait_for: the text or URL part to wait for"),
  timeout: z.number().optional().describe("Timeout in seconds for wait_for (default 10)"),
  values: z.array(z.string()).optional().describe("Values for select_option"),
  direction: z.enum(["down", "up"]).optional().describe("Scroll direction"),
  amount: z.number().optional().describe("Scroll amount in pixels (default 300)"),
  extractSelector: z.string().optional().describe("CSS selector for extract containers"),
  extractFields: z.record(z.string(), z.string()).optional().describe("Field map for extract (name -> selector)"),
  checks: z.array(AssertCheckSchema).optional().describe("Assertion checks for assert action"),
});

const ActionArgs = z.object({
  tabId: z.number().optional().describe("Target tab ID. If omitted, uses this session's current tab (opened with new_tab or browser_navigate, or chosen with select_tab), never the user's active tab."),
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
    const { tabId, stopOnError } = validated;
    // Outline refs (o12) become selectors here; the extension only knows snapshot refs.
    const steps = validated.steps.map((step, i) => {
      const n = outlineRefNumber(step.ref);
      if (n === undefined) return step;
      const hint = collapsedHint(context, tabId, n);
      if (hint) throw new Error(`Step ${i + 1}: ${hint}`);
      const { ref: _ref, ...rest } = step;
      return { ...rest, selector: outlineSelector(context, tabId, n) };
    });

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
