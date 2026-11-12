import type { Context } from "../context.js";
import type { ModelElement, PageModel } from "./model.js";
import { outlineRefNumber } from "./model.js";

const key = (tabId: number | undefined) => (tabId === undefined ? "active" : String(tabId));
const LAST = "last";

/**
 * Remembers each o-number's element (selector plus role/name/section), so refs
 * into shadow DOM resolve and a re-rendered element can be found again. Stored
 * under the tab argument the outline used and as the session's latest outline,
 * so an outline read without tabId still serves a later call that names the tab.
 */
export function rememberOutline(context: Context, tabId: number | undefined, model: PageModel): void {
  const entries = new Map(model.elements.map((e) => [e.n, e]));
  context.outlineSelectors.set(key(tabId), entries);
  context.outlineSelectors.set(LAST, entries);
  context.lastRefPrefix = "o";
}

export function rememberedElement(context: Context, tabId: number | undefined, n: number): ModelElement | undefined {
  for (const k of [key(tabId), key(undefined), LAST]) {
    const e = context.outlineSelectors.get(k)?.get(n);
    if (e) return e;
  }
  return undefined;
}

export function outlineSelector(context: Context, tabId: number | undefined, n: number): string {
  return rememberedElement(context, tabId, n)?.selector ?? `[data-mbo="${n}"]`;
}

/**
 * Rewrites `ref: "o12"` (a browser_outline number) into a selector the
 * extension already understands; any other ref passes through untouched.
 */
export function withOutlineRef<T extends { ref?: string; selector?: string; tabId?: number }>(context: Context, args: T): T {
  const n = outlineRefNumber(args.ref);
  if (n === undefined) return args;
  const { ref: _ref, ...rest } = args;
  return { ...rest, selector: outlineSelector(context, args.tabId, n) } as T;
}

/** Same fingerprint (role, name, section, sub-section, row) after a re-render, if exactly one element has it. */
export function findAgain(model: PageModel, old: ModelElement): ModelElement | undefined {
  const same = model.elements.filter((e) => e.role === old.role && e.name === old.name && e.section === old.section && e.sub === old.sub && e.row === old.row);
  return same.length === 1 ? same[0] : undefined;
}

/** Why an outline element cannot be acted on as it is, or undefined when it can. */
export function collapsedHint(context: Context, tabId: number | undefined, n: number): string | undefined {
  const e = rememberedElement(context, tabId, n);
  if (!e || e.where !== "collapsed") return undefined;
  const entries = context.outlineSelectors.get(LAST);
  const opener = entries && [...entries.values()].find((x) => x.state === "collapsed" && x.section === e.section && x.n !== e.n);
  return `o${n} (${e.role} "${e.name}") is inside a collapsed section${e.section ? ` of "${e.section}"` : ""}; expand it first`
    + `${opener ? ` (click o${opener.n} ${opener.role} "${opener.name}")` : ""}, then use the ref again.`;
}
