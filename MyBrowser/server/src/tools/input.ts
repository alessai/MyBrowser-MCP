import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { Context } from "../context.js";
import { isTargetResolutionError, resolveTargetWithJev, type Resolution } from "../jev/resolve.js";
import { diagnoseRepeatedFailure, noteTargetedSuccess } from "../jev/stuck.js";
import { withOutlineRef } from "../page/refs.js";
import { captureAriaSnapshot } from "../utils/aria-snapshot.js";
import type { Tool } from "./types.js";

const TabIdParam = z.object({
  tabId: z.number().optional().describe("Target tab ID. If omitted, uses the active tab."),
});

// Natural language element targeting — AI can use any combination
const ElementTarget = TabIdParam.extend({
  element: z.string().describe(
    "Human-readable element description used to obtain permission to interact with the element"
  ),
  ref: z.string().optional().describe("Exact element reference: e42 from a snapshot, or o12 from browser_outline"),
  mark: z.number().optional().describe("Set-of-Marks annotation number from annotated screenshot"),
  selector: z.string().optional().describe("CSS selector to target the element directly"),
  role: z.string().optional().describe("ARIA role to match (e.g. button, searchbox, link)"),
  name: z.string().optional().describe("Accessible name or partial match"),
  matchText: z.string().optional().describe("Visible text content to match on the element"),
  label: z.string().optional().describe("Form field label text"),
});

const RETARGETED_KEYS = ["ref", "mark", "role", "name", "matchText", "label"] as const;

/**
 * Send a targeted input tool. When the extension's resolver cannot find the
 * element (a pre-action failure, so nothing was clicked or typed) and the Jev
 * layer is configured, Jev picks the element from the visible page using the
 * agent's description and the tool is sent once more against that element.
 * Any Jev failure falls back to the original error. A repeated failure on the
 * same tab also gets one line of advice about what is blocking the page.
 */
async function dispatchTargeted(
  context: Context,
  toolName: string,
  original: z.infer<typeof ElementTarget> & Record<string, unknown>,
): Promise<string> {
  const validated = withOutlineRef(context, original);
  try {
    const note = await dispatchWithFallback(context, toolName, validated);
    noteTargetedSuccess(context, validated.tabId);
    return note;
  } catch (error) {
    if (context.jev) {
      const hadCandidate = (error as { jevCandidate?: boolean } | undefined)?.jevCandidate === true;
      const advice = await diagnoseRepeatedFailure(context, context.jev, validated.tabId, undefined, undefined, { hadCandidate });
      if (advice && error instanceof Error) error.message = `${error.message} ${advice}`;
    }
    throw error;
  }
}

async function dispatchWithFallback(
  context: Context,
  toolName: string,
  validated: z.infer<typeof ElementTarget> & Record<string, unknown>,
): Promise<string> {
  const { tabId, ...rest } = validated;
  const payload: Record<string, unknown> = tabId !== undefined ? { ...rest, tabId } : rest;
  try {
    await context.sendSocketMessage(toolName, payload);
    return "";
  } catch (error) {
    const config = context.jev;
    if (!config || !isTargetResolutionError(error)) throw error;
    let resolution: Resolution;
    try {
      // Typing without submitting and hovering cannot pay, delete, or send anything.
      const sideEffect = toolName === "browser_click" || toolName === "browser_select_option"
        || (toolName === "browser_type" && validated.submit === true);
      resolution = await resolveTargetWithJev(context, config, validated, tabId, undefined, { sideEffect });
    } catch {
      throw error;
    }
    if (resolution.kind === "unresolved") {
      if (resolution.hint && error instanceof Error) {
        error.message = `${error.message} ${resolution.hint}`;
        (error as { jevCandidate?: boolean }).jevCandidate = true;
      }
      throw error;
    }
    const retry: Record<string, unknown> = { ...payload, selector: resolution.selector };
    for (const key of RETARGETED_KEYS) delete retry[key];
    await context.sendSocketMessage(toolName, retry);
    return ` (resolved by Jev to ${resolution.description}, confidence ${resolution.confidence.toFixed(2)})`;
  }
}

const ClickArgs = ElementTarget;

const TypeArgs = ElementTarget.extend({
  text: z.string().describe("Text to type into the element"),
  submit: z.boolean().describe("Whether to submit entered text (press Enter after)"),
});

const HoverArgs = ElementTarget;

const PressKeyArgs = TabIdParam.extend({
  key: z.string().describe(
    "Name of the key to press or a character to generate, such as `ArrowLeft` or `a`"
  ),
});

const DragArgs = TabIdParam.extend({
  startElement: z.string().describe(
    "Human-readable source element description"
  ),
  startRef: z.string().optional().describe("Exact source element reference from the page snapshot"),
  startMark: z.number().optional().describe("Source Set-of-Marks annotation number"),
  startSelector: z.string().optional().describe("CSS selector for the source element"),
  endElement: z.string().describe(
    "Human-readable target element description"
  ),
  endRef: z.string().optional().describe("Exact target element reference from the page snapshot"),
  endMark: z.number().optional().describe("Target Set-of-Marks annotation number"),
  endSelector: z.string().optional().describe("CSS selector for the target element"),
});

const SelectOptionArgs = ElementTarget.extend({
  values: z.array(z.string()).describe(
    "Array of values to select in the dropdown. This can be a single value or multiple values."
  ),
});

export const click: Tool = {
  schema: {
    name: "browser_click",
    description: "Perform click on a web page. Target element by ref, mark number, text, role, label, or CSS selector.",
    inputSchema: zodToJsonSchema(ClickArgs),
  },
  handle: async (context, params) => {
    const validated = ClickArgs.parse(params);
    const note = await dispatchTargeted(context, "browser_click", validated);
    const snapshot = await captureAriaSnapshot(context, "", validated.tabId);
    return {
      content: [
        { type: "text", text: `Clicked "${validated.element}"${note}` },
        ...snapshot.content,
      ],
    };
  },
};

export const type: Tool = {
  schema: {
    name: "browser_type",
    description: "Type text into editable element. Target by ref, mark number, text, role, label, or CSS selector.",
    inputSchema: zodToJsonSchema(TypeArgs),
  },
  handle: async (context, params) => {
    const validated = TypeArgs.parse(params);
    const note = await dispatchTargeted(context, "browser_type", validated);
    const snapshot = await captureAriaSnapshot(context, "", validated.tabId);
    return {
      content: [
        { type: "text", text: `Typed "${validated.text}" into "${validated.element}"${note}` },
        ...snapshot.content,
      ],
    };
  },
};

export const hover: Tool = {
  schema: {
    name: "browser_hover",
    description: "Hover over element on page. Target by ref, mark number, text, role, label, or CSS selector.",
    inputSchema: zodToJsonSchema(HoverArgs),
  },
  handle: async (context, params) => {
    const validated = HoverArgs.parse(params);
    const note = await dispatchTargeted(context, "browser_hover", validated);
    const snapshot = await captureAriaSnapshot(context, "", validated.tabId);
    return {
      content: [
        { type: "text", text: `Hovered over "${validated.element}"${note}` },
        ...snapshot.content,
      ],
    };
  },
};

export const pressKey: Tool = {
  schema: {
    name: "browser_press_key",
    description: "Press a key on the keyboard",
    inputSchema: zodToJsonSchema(PressKeyArgs),
  },
  handle: async (context, params) => {
    const validated = PressKeyArgs.parse(params);
    const { tabId, ...rest } = validated;
    const payload = tabId !== undefined ? { ...rest, tabId } : rest;
    await context.sendSocketMessage("browser_press_key", payload);
    return { content: [{ type: "text", text: `Pressed key ${validated.key}` }] };
  },
};

export const drag: Tool = {
  schema: {
    name: "browser_drag",
    description: "Perform drag and drop between two elements. Target by ref, mark number, or description.",
    inputSchema: zodToJsonSchema(DragArgs),
  },
  handle: async (context, params) => {
    const validated = DragArgs.parse(params);
    const { tabId, ...rest } = validated;
    const payload = tabId !== undefined ? { ...rest, tabId } : rest;
    await context.sendSocketMessage("browser_drag", payload);
    const snapshot = await captureAriaSnapshot(context, "", tabId);
    return {
      content: [
        { type: "text", text: `Dragged "${validated.startElement}" to "${validated.endElement}"` },
        ...snapshot.content,
      ],
    };
  },
};

const MouseArgs = TabIdParam.extend({
  action: z.enum(["click", "double_click", "right_click", "hover", "drag", "scroll"]).default("click"),
  x: z.number().describe("X in pixels of the last browser_screenshot of this tab (not page or screen pixels)."),
  y: z.number().describe("Y in pixels of the last browser_screenshot of this tab."),
  toX: z.number().optional().describe("drag only: end X in screenshot pixels."),
  toY: z.number().optional().describe("drag only: end Y in screenshot pixels."),
  deltaX: z.number().optional().describe("scroll only: horizontal page pixels."),
  deltaY: z.number().optional().describe("scroll only: vertical page pixels (positive scrolls down)."),
  text: z.string().optional().describe("Typed with the keyboard after the action, into whatever then has focus."),
}).refine((a) => a.action !== "drag" || (a.toX !== undefined && a.toY !== undefined), { message: "drag needs toX and toY" });

export const mouse: Tool = {
  schema: {
    name: "browser_mouse",
    description: "Click, double-click, right-click, hover, drag or scroll at a point of the last browser_screenshot, optionally typing text afterwards. "
      + "For things with no element to target: canvases, slide or drawing editors, maps, and frames from other sites (e.g. PowerPoint/Word for the web). "
      + "Take browser_screenshot of the tab first and give x/y in that image's pixels; a new screenshot is needed after the window is resized. "
      + "Prefer browser_click and browser_type whenever the target appears in a snapshot.",
    inputSchema: zodToJsonSchema(MouseArgs),
  },
  handle: async (context, params) => {
    const validated = MouseArgs.parse(params);
    const { tabId, ...rest } = validated;
    const payload = tabId !== undefined ? { ...rest, tabId } : rest;
    const result = await context.sendSocketMessage("browser_mouse", payload) as { hit?: string } | undefined;
    const where = validated.action === "drag" ? `from (${validated.x}, ${validated.y}) to (${validated.toX}, ${validated.toY})` : `at (${validated.x}, ${validated.y})`;
    const typed = validated.text ? `, then typed ${validated.text.length} characters` : "";
    return { content: [{ type: "text", text: `${validated.action.replace("_", "-")} ${where} on ${result?.hit ?? "unknown"}${typed}. Take a screenshot to see the result.` }] };
  },
};

export const selectOption: Tool = {
  schema: {
    name: "browser_select_option",
    description: "Select an option in a dropdown. Target by ref, mark number, text, role, label, or CSS selector.",
    inputSchema: zodToJsonSchema(SelectOptionArgs),
  },
  handle: async (context, params) => {
    const validated = SelectOptionArgs.parse(params);
    const note = await dispatchTargeted(context, "browser_select_option", validated);
    const snapshot = await captureAriaSnapshot(context, "", validated.tabId);
    return {
      content: [
        { type: "text", text: `Selected option in "${validated.element}"${note}` },
        ...snapshot.content,
      ],
    };
  },
};
