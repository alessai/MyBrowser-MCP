import type { Context } from "../context.js";
import { askJev } from "./client.js";
import type { JevConfig } from "./config.js";
import { describeElement, readPageState, verifyElement, type PageElement } from "./page.js";

// Messages the extension's element resolver throws before any input is sent.
// Only these are safe to retry: the first attempt never acted on the page.
const RESOLUTION_ERROR = /No element targeting params provided|Empty descriptor|No element found (matching|with text|near)|No form element found|No visible element found for selector|Element with (ref|mark) .* not found or not visible/;

export function isTargetResolutionError(error: unknown): boolean {
  return RESOLUTION_ERROR.test(error instanceof Error ? error.message : String(error));
}

export interface TargetHints {
  element: string;
  role?: string;
  name?: string;
  matchText?: string;
  label?: string;
}

export type Resolution =
  | { kind: "resolved"; selector: string; description: string; confidence: number }
  | { kind: "unresolved"; hint?: string };

const MAX_OPTIONS = 254; // Choice allows 255 including "none"

// The literal hints already failed to match, so they are framed as a failed
// search: stated as requirements they pushed Jev to "none" (measured: "the
// login link" + text "sign in" -> none @0.88; framed as a failed search -> the
// login link @0.94).
function intentOf(hints: TargetHints): string {
  const tried = [
    hints.role && `role ${hints.role}`,
    hints.name && `name "${hints.name}"`,
    hints.matchText && `text "${hints.matchText}"`,
    hints.label && `label "${hints.label}"`,
  ].filter(Boolean);
  return tried.length
    ? `${hints.element}. The agent also searched for ${tried.join(", ")}, which did not match any element exactly`
    : hints.element;
}

function capCandidates(elements: PageElement[], intent: string): PageElement[] {
  if (elements.length <= MAX_OPTIONS) return elements;
  // shortcut: lexical pre-filter for very large pages, upgrade if long-tail pages miss targets
  const words = new Set(intent.toLowerCase().split(/\W+/).filter((w) => w.length > 2));
  const score = (e: PageElement) => describeElement(e).toLowerCase().split(/\W+/).filter((w) => words.has(w)).length;
  const keep = new Set(elements.map((e, i) => ({ i, s: score(e) })).sort((a, b) => b.s - a.s).slice(0, MAX_OPTIONS).map((x) => x.i));
  return elements.filter((_, i) => keep.has(i));
}

export async function resolveTargetWithJev(
  context: Context,
  config: JevConfig,
  hints: TargetHints,
  tabId: number | undefined,
  ask = askJev,
): Promise<Resolution> {
  // One budget for the whole fallback (page read + Jev + verify), so a failing
  // action costs at most timeoutMs extra. Running out throws: callers fall back
  // to the original error.
  const deadline = Date.now() + config.timeoutMs;
  const remaining = () => {
    const ms = deadline - Date.now();
    if (ms <= 0) throw new Error("JEV_DEADLINE");
    return ms;
  };
  const page = await readPageState(context, tabId, { timeoutMs: remaining() });
  const intent = intentOf(hints);
  const candidates = capCandidates(page.elements, intent);
  if (candidates.length === 0) return { kind: "unresolved" };
  const criteria: Record<string, string> = Object.fromEntries(candidates.map((e, i) => [`e${i}`, describeElement(e)]));
  criteria.none = "No element on the page matches the target";
  const response = await ask({ ...config, timeoutMs: remaining() }, {
    state: { page: { title: page.title, url: page.url } },
    questions: {
      target: {
        type: "choice",
        instructions: `Which page element best matches this target: "${intent}"? Choose none if no element matches.`,
        criteria,
      },
    },
  });
  const answer = response.answers.target;
  if (!answer || answer.type !== "choice") return { kind: "unresolved" };
  const pick = (key: string) => (key === "none" ? undefined : candidates[Number(key.slice(1))]);
  const chosen = pick(answer.choice);
  if (chosen && answer.confidence >= config.minConfidence) {
    const check = await verifyElement(context, tabId, page.url, chosen, remaining());
    if (!check.ok) {
      return { kind: "unresolved", hint: `Jev chose ${describeElement(chosen)} but did not act: ${check.reason} since the page was read.` };
    }
    return { kind: "resolved", selector: chosen.selector, description: describeElement(chosen), confidence: answer.confidence };
  }
  const [bestKey, bestP] = Object.entries(answer.probabilities ?? {})
    .filter(([key]) => key !== "none")
    .sort((a, b) => b[1] - a[1])[0] ?? [];
  const best = bestKey ? pick(bestKey) : undefined;
  if (!best || (bestP ?? 0) < 0.2) return { kind: "unresolved" };
  // Jev reports a per-option probability and a separate answer confidence; the
  // action gate uses confidence, so show both to keep the refusal explainable.
  return {
    kind: "unresolved",
    hint: `Jev's best guess (probability ${bestP!.toFixed(2)}, answer confidence ${answer.confidence.toFixed(2)}; acts only at confidence >= ${config.minConfidence}): ${describeElement(best)} — selector: ${best.selector}`,
  };
}
