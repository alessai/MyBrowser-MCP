import type { Context } from "../context.js";
import type { PageModel } from "./model.js";
import { outlineRefNumber } from "./model.js";

const key = (tabId: number | undefined) => (tabId === undefined ? "active" : String(tabId));

/** Remembers where each o-number lives, so refs into shadow DOM resolve too. */
export function rememberOutline(context: Context, tabId: number | undefined, model: PageModel): void {
  context.outlineSelectors.set(key(tabId), new Map(model.elements.map((e) => [e.n, e.selector])));
}

export function outlineSelector(context: Context, tabId: number | undefined, n: number): string {
  return context.outlineSelectors.get(key(tabId))?.get(n) ?? `[data-mbo="${n}"]`;
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
