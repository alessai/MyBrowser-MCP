import { z } from "zod";
import { zodToJsonSchema } from "../utils/json-schema.js";
import type { Context } from "../context.js";
import { askJev } from "../jev/client.js";
import { isTargetResolutionError, looksIrreversible, resolveTargetWithJev, RISKY_GUESS_MIN_CONFIDENCE, type Resolution } from "../jev/resolve.js";
import { diagnoseRepeatedFailure, noteTargetedSuccess } from "../jev/stuck.js";
import { handBack, learn, readModel, resolveOnPage } from "../page/engine.js";
import { checkExpectation } from "../page/expect.js";
import { describeForDecider, outlineRefNumber } from "../page/model.js";
import { candidateLine } from "../page/resolve.js";
import { collapsedHint, findAgain, rememberedElement, withOutlineRef } from "../page/refs.js";
import { captureAriaSnapshot, FRAME_DESCRIPTION } from "../utils/aria-snapshot.js";
import type { Tool } from "./types.js";

const TabIdParam = z.object({
  tabId: z.number().optional().describe("Target tab ID. If omitted, uses this session's current tab (opened with new_tab or browser_navigate, or chosen with select_tab), never the user's active tab."),
});

// Natural language element targeting — AI can use any combination
const ElementTarget = TabIdParam.extend({
  element: z.string().optional().describe(
    "What the element is, in plain words (e.g. 'Publish button'). With no ref/selector/role/name/matchText/label it is also the target: found on the page by code, site memory, then the decision model."
  ),
  ref: z.string().optional().describe("Exact element reference: e42 from a snapshot, or o12 from browser_outline"),
  mark: z.number().optional().describe("Set-of-Marks annotation number from annotated screenshot"),
  selector: z.string().optional().describe("CSS selector to target the element directly"),
  role: z.string().optional().describe("ARIA role to match (e.g. button, searchbox, link)"),
  name: z.string().optional().describe("Accessible name or partial match"),
  matchText: z.string().optional().describe("Visible text content to match on the element"),
  label: z.string().optional().describe("Form field label text"),
  frame: z.string().optional().describe(FRAME_DESCRIPTION),
  expect: z.string().optional().describe("What should be true after the action, e.g. 'the Saved toast is shown'. The result then says confirmed, contradicted or not confirmed (checked for up to 3 s). Without a decision model only exact text is checked."),
});

type Targeted = z.infer<typeof ElementTarget> & Record<string, unknown>;

const RETARGETED_KEYS = ["ref", "mark", "role", "name", "matchText", "label"] as const;
const TARGET_KEYS = ["ref", "mark", "selector", "role", "name", "matchText", "label"] as const;

/** The label used in results: the description, else whatever targeted it. */
export function elementLabel(args: Partial<Targeted>): string {
  return String(args.element ?? args.name ?? args.matchText ?? args.label ?? args.ref ?? args.selector ?? (args.mark !== undefined ? `mark ${args.mark}` : "element"));
}

const sideEffectOf = (toolName: string, args: Targeted) => toolName === "browser_click" || toolName === "browser_select_option"
  || (toolName === "browser_type" && args.submit === true);

/**
 * Only a description was given: find it in the page model by code (exact and
 * near names, site memory), then the decision model, and hand back candidates
 * when unsure. A guessed target for an action that may pay, delete, send or
 * publish needs high confidence, as in the Jev fallback.
 */
async function resolveDescription(context: Context, toolName: string, args: Targeted): Promise<{ args: Targeted; note: string; learnIt: () => void }> {
  const description = args.element!;
  const model = await readModel(context, args.tabId);
  const [r] = await resolveOnPage(context, model, [{ target: description }]);
  if (!r || r.status === "not_found") {
    throw new Error(`No element found for "${description}"${r ? ` (${r.reason})` : ""}. Run browser_outline (or browser_find) and target it with ref: "o<n>".`);
  }
  if (r.status === "needs_choice") throw new Error(`"${description}" is ambiguous: ${handBack(r)}`);
  const e = r.element;
  if (e.where === "collapsed") throw new Error(`"${description}" is ${candidateLine(e)}, inside a collapsed section; expand it first.`);
  const jev = context.jev;
  const floor = Math.max(jev?.minConfidence ?? 0, RISKY_GUESS_MIN_CONFIDENCE);
  // Typed text can go to the wrong field (a search box sends it on input): a
  // guessed field needs the high threshold too.
  if (toolName === "browser_type" && r.via === "decider" && r.confidence < floor) {
    throw new Error(`The decision model picked ${candidateLine(e)} for "${description}" (confidence ${r.confidence.toFixed(2)}) but did not type: a guessed field needs confidence ${floor}. If it is the one you mean, use ref: "o${e.n}".`);
  }
  // Site memory only says the phrase worked once; a remembered target for an
  // action that may pay, delete, send or publish is checked like a guess.
  if (jev && sideEffectOf(toolName, args) && (r.via === "memory" || (r.via === "decider" && r.confidence < floor))) {
    // The element description only, never its state (it can hold typed values).
    const risky = await looksIrreversible(askJev, jev, { title: model.title, url: model.url }, describeForDecider(e), jev.timeoutMs);
    if (risky) {
      const how = r.via === "memory" ? "site memory" : `the decision model (confidence ${r.confidence.toFixed(2)})`;
      throw new Error(`${how} matched ${candidateLine(e)} for "${description}" but MyBrowser did not act: it may pay, delete, send or publish something, so it needs a direct target. If it is the one you mean, use ref: "o${e.n}".`);
    }
  }
  const via = r.via === "code" ? "" : r.via === "decider" ? `, decision model ${r.confidence.toFixed(2)}` : ", site memory";
  return {
    args: { ...args, selector: e.selector },
    note: ` (found ${candidateLine(e)}${via})`,
    learnIt: () => learn(model, description, e, true),
  };
}

/**
 * Send a targeted input tool.
 * - Only a description: resolved on the page model first (works without Jev).
 * - An outline ref (o12): refused with the fix when it sits in a collapsed
 *   section; found again by its role/name/section when the page re-rendered.
 * - When the extension's resolver cannot find the element (a pre-action
 *   failure, so nothing was clicked or typed) and Jev is configured, Jev picks
 *   the element from the page using the description and the tool is sent once
 *   more against that element.
 * - A failure whose outcome is unknown, or a repeated failure on the same tab,
 *   gets one line from a page check (popup, sign-in, CAPTCHA, error, loading).
 */
async function dispatchTargeted(context: Context, toolName: string, original: Targeted): Promise<string> {
  const { expect: _expect, ...sent } = original;
  let args = sent as Targeted;
  let note = "";
  let learnIt: (() => void) | undefined;
  const outlineN = outlineRefNumber(args.ref);
  if (outlineN !== undefined) {
    const hint = collapsedHint(context, args.tabId, outlineN);
    if (hint) throw new Error(hint);
  }
  const described = !args.frame && args.element !== undefined && TARGET_KEYS.every((k) => args[k] === undefined);
  try {
    if (described) ({ args, note, learnIt } = await resolveDescription(context, toolName, args));
    else args = withOutlineRef(context, args);
    note = (await dispatchWithFallback(context, toolName, args, outlineN)) || note;
    noteTargetedSuccess(context, args.tabId);
    learnIt?.();
    return note;
  } catch (error) {
    if (context.jev && error instanceof Error) {
      const hadCandidate = (error as { jevCandidate?: boolean }).jevCandidate === true;
      // Look at once only when the outcome is unknown; otherwise on a repeat.
      const immediate = /OUTCOME_UNKNOWN/.test(error.message);
      const advice = await diagnoseRepeatedFailure(context, context.jev, args.tabId, undefined, undefined, { hadCandidate, immediate });
      if (advice) error.message = `${error.message} ${advice}`;
    }
    throw error;
  }
}

async function dispatchWithFallback(context: Context, toolName: string, validated: Targeted, outlineN: number | undefined): Promise<string> {
  const { tabId, ...rest } = validated;
  const payload: Record<string, unknown> = tabId !== undefined ? { ...rest, tabId } : rest;
  try {
    await context.sendSocketMessage(toolName, payload);
    return "";
  } catch (error) {
    if (!isTargetResolutionError(error)) throw error;
    // An outline element that re-rendered: same role, name, section and row.
    if (outlineN !== undefined && !validated.frame) {
      const old = rememberedElement(context, tabId, outlineN);
      if (old) {
        const again = findAgain(await readModel(context, tabId), old);
        if (again && again.selector !== payload.selector) {
          await context.sendSocketMessage(toolName, { ...payload, selector: again.selector });
          return ` (o${outlineN} had re-rendered; found again as o${again.n})`;
        }
      }
    }
    const config = context.jev;
    // Jev reads the top page, so its picks would not exist inside a frame.
    if (!config || validated.frame) throw error;
    let resolution: Resolution;
    try {
      // Typing without submitting and hovering cannot pay, delete, or send anything.
      resolution = await resolveTargetWithJev(context, config, { ...validated, element: elementLabel(validated) }, tabId, undefined, { sideEffect: sideEffectOf(toolName, validated) });
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

/** Runs the post-action expectation check, then the usual snapshot. */
async function afterAction(context: Context, validated: Targeted, first: string) {
  const expectLine = validated.expect ? await checkExpectation(context, validated.tabId, validated.expect) : "";
  const snapshot = await captureAriaSnapshot(context, "", validated.tabId, { frame: validated.frame });
  return {
    content: [
      { type: "text" as const, text: expectLine ? `${first}\n${expectLine}` : first },
      ...snapshot.content,
    ],
  };
}

const ClickArgs = ElementTarget;

const TypeArgs = ElementTarget.extend({
  text: z.string().describe("Text to type into the element"),
  submit: z.boolean().optional().describe("Press Enter after typing (default false)"),
});

const HoverArgs = ElementTarget;

const PressKeyArgs = TabIdParam.extend({
  key: z.string().describe(
    "Name of the key to press or a character to generate, such as `ArrowLeft` or `a`"
  ),
});

const DragArgs = TabIdParam.extend({
  startElement: z.string().optional().describe(
    "Human-readable source element description"
  ),
  startRef: z.string().optional().describe("Exact source element reference from the page snapshot"),
  startMark: z.number().optional().describe("Source Set-of-Marks annotation number"),
  startSelector: z.string().optional().describe("CSS selector for the source element"),
  endElement: z.string().optional().describe(
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
    description: "Click an element. Target it by ref (e42 from a snapshot, o12 from browser_outline), mark, selector, role/name, matchText or label, or just describe it: {element: 'Publish button'}. Optional expect checks the result in the same call. E.g. {ref: 'o12'} or {element: 'Save', expect: 'Saved'}.",
    inputSchema: zodToJsonSchema(ClickArgs),
  },
  handle: async (context, params) => {
    const validated = ClickArgs.parse(params);
    const note = await dispatchTargeted(context, "browser_click", validated);
    return afterAction(context, validated, `Clicked "${elementLabel(validated)}"${note}`);
  },
};

export const type: Tool = {
  schema: {
    name: "browser_type",
    description: "Type text into an editable element (submit:true presses Enter). Target it like browser_click: ref, selector, role/name, label, or just {element: 'Email field'}. E.g. {ref: 'o7', text: 'hello'}. For several fields use browser_fill_form.",
    inputSchema: zodToJsonSchema(TypeArgs),
  },
  handle: async (context, params) => {
    const validated = TypeArgs.parse(params);
    const note = await dispatchTargeted(context, "browser_type", validated);
    return afterAction(context, validated, `Typed "${validated.text}" into "${elementLabel(validated)}"${note}`);
  },
};

export const hover: Tool = {
  schema: {
    name: "browser_hover",
    description: "Hover over an element. Target it like browser_click: ref, selector, role/name, matchText, label, or just {element: 'Account menu'}.",
    inputSchema: zodToJsonSchema(HoverArgs),
  },
  handle: async (context, params) => {
    const validated = HoverArgs.parse(params);
    const note = await dispatchTargeted(context, "browser_hover", validated);
    return afterAction(context, validated, `Hovered over "${elementLabel(validated)}"${note}`);
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
        { type: "text", text: `Dragged "${validated.startElement ?? validated.startRef ?? validated.startSelector ?? "source"}" to "${validated.endElement ?? validated.endRef ?? validated.endSelector ?? "target"}"` },
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
    description: "Select option(s) in a native dropdown. Target it like browser_click: ref, selector, role/name, label, or just {element: 'Country'}. E.g. {ref: 'o9', values: ['Oman']}. For several fields use browser_fill_form.",
    inputSchema: zodToJsonSchema(SelectOptionArgs),
  },
  handle: async (context, params) => {
    const validated = SelectOptionArgs.parse(params);
    const note = await dispatchTargeted(context, "browser_select_option", validated);
    return afterAction(context, validated, `Selected option in "${elementLabel(validated)}"${note}`);
  },
};
