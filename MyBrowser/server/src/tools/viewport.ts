import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { Tool } from "./types.js";

const TabIdParam = z.object({
  tabId: z.number().optional().describe("Target tab ID. If omitted, uses the active tab."),
});

const ViewportPreset = z.enum(["iphone", "ipad", "desktop"]);
const Orientation = z.enum(["portrait", "landscape"]);

const SetViewportArgs = TabIdParam.extend({
  preset: ViewportPreset.describe(
    "Viewport preset to apply: iphone=402x874 DPR3, ipad=820x1180 DPR2, desktop=1920x1080 DPR1.",
  ),
  orientation: Orientation.optional().describe(
    "Optional orientation. Defaults to portrait for iphone/ipad and landscape for desktop.",
  ),
});

const ResetViewportArgs = TabIdParam;
const ViewportInfoArgs = TabIdParam;

function payloadWithOptionalTabId<T extends Record<string, unknown>>(
  tabId: number | undefined,
  payload: T,
): T & { tabId?: number } {
  return tabId === undefined ? payload : { ...payload, tabId };
}

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export const setViewport: Tool = {
  schema: {
    name: "browser_set_viewport",
    description:
      "Set browser viewport/device emulation for responsive testing using current primary presets: iphone, ipad, or desktop. Use browser_reset_viewport when finished.",
    inputSchema: zodToJsonSchema(SetViewportArgs),
  },
  handle: async (context, params) => {
    const { tabId, preset, orientation } = SetViewportArgs.parse(params ?? {});
    const result = await context.sendSocketMessage(
      "browser_set_viewport",
      payloadWithOptionalTabId(tabId, { preset, orientation }),
    );
    return {
      content: [{ type: "text", text: `Viewport set:\n${formatJson(result)}` }],
    };
  },
};

export const resetViewport: Tool = {
  schema: {
    name: "browser_reset_viewport",
    description:
      "Reset viewport/device emulation on the target tab back to the real browser window.",
    inputSchema: zodToJsonSchema(ResetViewportArgs),
  },
  handle: async (context, params) => {
    const { tabId } = ResetViewportArgs.parse(params ?? {});
    const result = await context.sendSocketMessage(
      "browser_reset_viewport",
      payloadWithOptionalTabId(tabId, {}),
    );
    return {
      content: [{ type: "text", text: `Viewport reset:\n${formatJson(result)}` }],
    };
  },
};

export const viewportInfo: Tool = {
  schema: {
    name: "browser_viewport_info",
    description:
      "Inspect the current viewport, window size, device pixel ratio, and any MyBrowser viewport preset applied to the target tab.",
    inputSchema: zodToJsonSchema(ViewportInfoArgs),
  },
  handle: async (context, params) => {
    const { tabId } = ViewportInfoArgs.parse(params ?? {});
    const result = await context.sendSocketMessage(
      "browser_viewport_info",
      payloadWithOptionalTabId(tabId, {}),
    );
    return {
      content: [{ type: "text", text: formatJson(result) }],
    };
  },
};
