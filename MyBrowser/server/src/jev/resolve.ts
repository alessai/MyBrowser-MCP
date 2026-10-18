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

// A guessed target that would pay, delete, send or publish needs this much confidence.
const RISKY_MIN_CONFIDENCE = 0.9;
// Measured Oct 18 2026 on 24 labelled elements (jev-1.13.0): risky 0.59-0.97,
// benign 0.02-0.38, so 0.5 flagged 12/12 risky and 0/12 benign.
const RISK_THRESHOLD = 0.5;
const RISK_QUESTION = "Would activating `element` on this page pay or buy something, delete or remove data, send or publish a message or post, or make another change that cannot easily be undone?";

async function looksIrreversible(
  ask: typeof askJev,
  config: JevConfig,
  page: { title: string; url: string },
  element: PageElement,
  timeoutMs: number,
): Promise<boolean> {
  try {
    const response = await ask({ ...config, timeoutMs }, {
      state: { page: { title: page.title, url: page.url }, element: describeElement(element) },
      questions: { risk: { type: "noul", instructions: RISK_QUESTION } },
    });
    const answer = response.answers.risk;
    return answer?.type !== "noul" || answer.noul >= RISK_THRESHOLD;
  } catch {
    return true; // unknown risk counts as risky: the fallback is optional, a wrong payment is not
  }
}

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
  options: { sideEffect?: boolean } = {},
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
    // The element list must also be in the state: with only the page title, Jev
    // answered "none" for 3 of 5 obvious targets on a 4-element page (all 5
    // right at ~1.00 with the list). On the 50-target set the list raised
    // confident picks from 39 to 41 of 42 with no wrong action (Oct 18 2026).
    state: { page: { title: page.title, url: page.url }, elements: Object.values(criteria).slice(0, -1) },
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
    const budget = remaining();
    const riskyFloor = Math.max(config.minConfidence, RISKY_MIN_CONFIDENCE);
    const [check, risky] = await Promise.all([
      verifyElement(context, tabId, page.url, chosen, budget),
      options.sideEffect && answer.confidence < riskyFloor
        ? looksIrreversible(ask, config, page, chosen, budget)
        : Promise.resolve(false),
    ]);
    if (!check.ok) {
      return { kind: "unresolved", hint: `Jev chose ${describeElement(chosen)} but did not act: ${check.reason} since the page was read.` };
    }
    if (risky) {
      // No selector here on purpose: acting on a risky guess should take a deliberate, direct target.
      return {
        kind: "unresolved",
        hint: `Jev picked ${describeElement(chosen)} (confidence ${answer.confidence.toFixed(2)}) but did not act: it may pay, delete, send, or publish something, and a guessed target for that needs confidence ${riskyFloor}. If it is the one you mean, target it directly by ref from a snapshot.`,
      };
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
