import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { fillItems } from "../page/fill.js";
import { captureAriaSnapshot } from "../utils/aria-snapshot.js";
import type { Tool } from "./types.js";

const FillFormArgs = z.object({
  tabId: z.number().optional().describe("Target tab ID. If omitted, uses this session's current tab (opened with new_tab or browser_navigate, or chosen with select_tab), never the user's active tab."),
  fields: z.record(z.string()).optional().describe(
    "Map of field labels to values. Example: {\"Username\": \"admin\", \"Password\": \"secret\", \"Country\": \"UAE\"}"
  ),
  items: z.array(z.object({
    target: z.string().describe("The control in plain words ('Daily budget', 'Threads placements') or an outline ref (o12)"),
    value: z.string().describe("Text to type, on/off for checkboxes and switches, or the option to choose"),
  })).optional().describe("Set many controls in one call, anywhere on the page (below the fold included): text fields, checkboxes, switches, radios, native and custom dropdowns. Each is checked afterwards. Buttons and links are never clicked."),
  dryRun: z.boolean().optional().describe("With items: report which control each item maps to and what would change, without changing anything"),
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
      "Fill a form. Preferred: items, a list of {target, value} that is resolved against the whole page (sections, rows and below-the-fold included), set, and verified per item in one call, with dryRun to preview. Legacy: fields, a map of label to value for the visible form, with optional submit.",
    inputSchema: zodToJsonSchema(FillFormArgs),
  },
  handle: async (context, params) => {
    const validated = FillFormArgs.parse(params);
    if (validated.items) {
      const { results, sideEffects } = await fillItems(context, validated.tabId, validated.items, validated.dryRun === true);
      const ok = results.filter((r) => r.status === "done" || r.status === "already_set").length;
      const lines = [
        `${validated.dryRun ? "Dry run: " : ""}${ok} of ${results.length} items ${validated.dryRun ? "map cleanly" : "set and verified or already set"}.`,
        ...results.map((r) => `${r.status.toUpperCase()} ${r.target}: ${r.detail}`),
        ...(sideEffects.length ? [`Other controls that changed: ${sideEffects.join("; ")}`] : []),
      ];
      if (validated.submitAfter) lines.push("submitAfter is ignored with items: submit with browser_click so it is a deliberate action.");
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }
    if (!validated.fields) throw new Error("browser_fill_form needs items or fields");
    const { tabId, items: _items, dryRun: _dryRun, ...rest } = validated;
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
