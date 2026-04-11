import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { captureAriaSnapshot } from "../utils/aria-snapshot.js";
import type { Tool } from "./types.js";

const FillFormArgs = z.object({
  tabId: z.number().optional().describe("Target tab ID. If omitted, uses the active tab."),
  fields: z.record(z.string()).describe(
    "Map of field labels to values. Example: {\"Username\": \"admin\", \"Password\": \"secret\", \"Country\": \"UAE\"}"
  ),
  submitAfter: z.boolean().optional().default(false).describe(
    "Click the submit button after filling all fields"
  ),
  submitText: z.string().optional().describe(
    "Text of submit button to click. Default: auto-detect (Submit, Login, Sign In, Save, Continue)"
  ),
});

export const fillForm: Tool = {
  schema: {
    name: "browser_fill_form",
    description:
      "Fill a form by mapping field labels to values. Finds inputs by label text, aria-label, placeholder, or nearby text. Handles text inputs, selects, checkboxes, radios, textareas, and date fields. Optionally clicks the submit button after filling.",
    inputSchema: zodToJsonSchema(FillFormArgs),
  },
  handle: async (context, params) => {
    const validated = FillFormArgs.parse(params);
    const { tabId, ...rest } = validated;
    const payload = tabId !== undefined ? { ...rest, tabId } : rest;
    const result = await context.sendSocketMessage("browser_fill_form", payload);
    const r = result as { filled: string[]; failed: string[]; submitted: boolean };
    const lines: string[] = [];
    if (r.filled.length > 0) lines.push(`Filled: ${r.filled.join(", ")}`);
    if (r.failed.length > 0) lines.push(`Failed: ${r.failed.join(", ")}`);
    if (r.submitted) lines.push("Form submitted.");
    const summary = lines.join("\n") || "No fields processed.";
    let snapshotContent: Array<{ type: "text"; text: string }> = [];
    try {
      const snapshot = await captureAriaSnapshot(context, "", tabId);
      snapshotContent = snapshot.content;
    } catch {
      // Snapshot may fail if form submission triggered navigation
    }
    return {
      content: [
        { type: "text" as const, text: summary },
        ...snapshotContent,
      ],
    };
  },
};
