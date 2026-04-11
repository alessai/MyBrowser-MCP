import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
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
  ref: z.string().optional().describe("Exact element reference from snapshot (e.g. e42)"),
  mark: z.number().optional().describe("Set-of-Marks annotation number from annotated screenshot"),
  selector: z.string().optional().describe("CSS selector to target the element directly"),
  role: z.string().optional().describe("ARIA role to match (e.g. button, searchbox, link)"),
  name: z.string().optional().describe("Accessible name or partial match"),
  matchText: z.string().optional().describe("Visible text content to match on the element"),
  label: z.string().optional().describe("Form field label text"),
});

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
    const { tabId, ...rest } = validated;
    const payload = tabId !== undefined ? { ...rest, tabId } : rest;
    await context.sendSocketMessage("browser_click", payload);
    const snapshot = await captureAriaSnapshot(context, "", tabId);
    return {
      content: [
        { type: "text", text: `Clicked "${validated.element}"` },
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
    const { tabId, ...rest } = validated;
    const payload = tabId !== undefined ? { ...rest, tabId } : rest;
    await context.sendSocketMessage("browser_type", payload);
    const snapshot = await captureAriaSnapshot(context, "", tabId);
    return {
      content: [
        { type: "text", text: `Typed "${validated.text}" into "${validated.element}"` },
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
    const { tabId, ...rest } = validated;
    const payload = tabId !== undefined ? { ...rest, tabId } : rest;
    await context.sendSocketMessage("browser_hover", payload);
    const snapshot = await captureAriaSnapshot(context, "", tabId);
    return {
      content: [
        { type: "text", text: `Hovered over "${validated.element}"` },
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

export const selectOption: Tool = {
  schema: {
    name: "browser_select_option",
    description: "Select an option in a dropdown. Target by ref, mark number, text, role, label, or CSS selector.",
    inputSchema: zodToJsonSchema(SelectOptionArgs),
  },
  handle: async (context, params) => {
    const validated = SelectOptionArgs.parse(params);
    const { tabId, ...rest } = validated;
    const payload = tabId !== undefined ? { ...rest, tabId } : rest;
    await context.sendSocketMessage("browser_select_option", payload);
    const snapshot = await captureAriaSnapshot(context, "", tabId);
    return {
      content: [
        { type: "text", text: `Selected option in "${validated.element}"` },
        ...snapshot.content,
      ],
    };
  },
};
