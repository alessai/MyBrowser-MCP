import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { captureAriaSnapshot } from "../utils/aria-snapshot.js";
import type { Tool } from "./types.js";

const SnapshotArgs = z.object({
  tabId: z.number().optional().describe("Target tab ID. If omitted, uses the active tab."),
  viewportOnly: z.boolean().optional().default(true)
    .describe("If true (default), only include elements visible in the viewport. Much smaller output. Set false for full page tree."),
  mode: z
    .enum(["full", "diff", "auto"])
    .optional()
    .default("auto")
    .describe(
      "'full' returns the whole ARIA tree (original behavior). " +
        "'diff' returns only nodes added/removed/changed since the previous snapshot " +
        "(requires a previous snapshot on the same tab + same viewportOnly setting + same URL). " +
        "'auto' (default) prefers diff when a usable baseline exists and the diff is " +
        "meaningfully smaller; falls back to full otherwise. Diff saves tokens on multi-step " +
        "flows where most of the page stays the same between calls.",
    ),
});

export const snapshot: Tool = {
  schema: {
    name: "browser_snapshot",
    description:
      "Capture accessibility snapshot of the current page. Returns ARIA tree with element references for interaction. Default: viewport-only + auto diff (compact output on repeat calls). Pass mode:'full' to force the whole tree.",
    inputSchema: zodToJsonSchema(SnapshotArgs),
  },
  handle: async (context, params) => {
    const { tabId, viewportOnly, mode } = SnapshotArgs.parse(params ?? {});
    return captureAriaSnapshot(context, "", tabId, { viewportOnly, mode });
  },
};
