// Resolver v2: from a plain phrase ("Daily budget", "the Threads checkbox") to
// one element of a Page Model, in this order:
//   1. site memory (a phrase that resolved and was verified before),
//   2. code (exact or near-exact name, role words, section words),
//   3. a decision model, when configured,
//   4. otherwise hand back up to 5 candidates for the agent to pick by `o<n>`.
// Code never guesses: it resolves only a clear winner. Without a decision model
// every item still ends resolved, not_found, or needs_choice.

import { askMany, type JevAnswer, type JevQuestion } from "../jev/client.js";
import type { JevConfig } from "../jev/config.js";
import { phraseKey, type PhraseMemory } from "../site-knowledge.js";
import { describeForDecider, type ModelElement, type PageModel } from "./model.js";

export interface ResolveItem {
  target: string;
  /** Optional role constraint from the caller (e.g. "checkbox"). */
  role?: string;
}

export type ItemResolution =
  | { status: "resolved"; element: ModelElement; via: "memory" | "code" | "decider"; confidence: number }
  | { status: "needs_choice"; candidates: ModelElement[]; reason: string }
  | { status: "not_found"; reason: string };

const MAX_OPTIONS = 254; // Choice allows 255 including "none"
const HAND_BACK = 5;

// Words that say what kind of control is meant, not which one.
const ROLE_WORDS: Record<string, string[]> = {
  checkbox: ["checkbox", "menuitemcheckbox", "switch"],
  check: ["checkbox", "menuitemcheckbox", "switch"],
  tickbox: ["checkbox"],
  switch: ["switch", "checkbox"],
  toggle: ["switch", "checkbox", "button"],
  button: ["button"],
  link: ["link"],
  tab: ["tab"],
  radio: ["radio", "menuitemradio"],
  dropdown: ["combobox", "listbox", "button"],
  select: ["combobox", "listbox"],
  menu: ["combobox", "menuitem", "button"],
  field: ["textbox", "searchbox", "combobox", "spinbutton"],
  input: ["textbox", "searchbox", "combobox", "spinbutton"],
  textbox: ["textbox", "searchbox"],
  box: ["textbox", "searchbox", "checkbox"],
  slider: ["slider"],
};
const STOP = new Set(["the", "a", "an", "of", "in", "on", "for", "to", "and", "or", "under", "inside", "at", "with", "this", "that", "is", "be", "it", "its", "my", "your", "section", "option", "setting", "control"]);

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const words = (s: string) => norm(s).split(" ").filter((w) => w && !STOP.has(w));

function parsePhrase(target: string, role?: string): { core: string; coreWords: string[]; roles: string[] } {
  const all = words(target);
  const roles = new Set<string>(role ? [role.toLowerCase()] : []);
  const coreWords: string[] = [];
  for (const w of all) {
    const mapped = ROLE_WORDS[w];
    if (mapped) mapped.forEach((r) => roles.add(r));
    else coreWords.push(w);
  }
  // "Budget field" -> core "budget"; "Button text" keeps both when nothing else is left.
  if (coreWords.length === 0) return { core: all.join(" "), coreWords: all, roles: [] };
  return { core: coreWords.join(" "), coreWords, roles: [...roles] };
}

function score(e: ModelElement, phrase: ReturnType<typeof parsePhrase>): number {
  // An unlabeled control is known by its row text ("A/B test" next to a bare switch).
  const label = e.name || e.row;
  const nameList = words(label);
  const name = nameList.join(" ");
  const nameWords = new Set(nameList);
  const sectionText = words(`${e.section} ${e.sub}`).join(" ");
  const context = new Set(words(`${e.section} ${e.sub} ${e.name ? e.row : ""}`));
  const rest = phrase.coreWords.filter((w) => !nameWords.has(w));
  const extra = nameList.filter((w) => !phrase.coreWords.includes(w));
  let s = 0;
  if (name && name === phrase.core) s += 100;
  // "Threads placements" = "Threads" in section "Placements"; "Ad name" = "Name" in section "Ad".
  else if (name && extra.length === 0 && rest.length > 0 && rest.every((w) => context.has(w))) s += rest.join(" ") === sectionText || words(e.sub).join(" ") === rest.join(" ") || words(e.section).join(" ") === rest.join(" ") ? 110 : 100;
  // "Arabic translation" = "Arabic (machine translation)": every word, at most two more.
  else if (name && rest.length === 0 && extra.length > 0 && extra.length <= 2) s += 90;
  else if (name && phrase.core.length >= 3 && (name.startsWith(phrase.core + " ") || phrase.core.startsWith(name + " "))) s += 45;
  for (const w of phrase.coreWords) {
    if (nameWords.has(w)) s += 10;
    else if (context.has(w)) s += 4;
  }
  if (phrase.roles.length) s += phrase.roles.includes(e.role) ? 15 : -40;
  if (e.disabled) s -= 5;
  return s;
}

function sameAsMemory(e: ModelElement, m: PhraseMemory): boolean {
  return e.role === m.role && e.name === m.name && e.section === m.section && e.sub === m.sub;
}

/** Code tiers only (memory, then code). Exported for tests. */
export function resolveByCode(
  model: PageModel,
  item: ResolveItem,
  memory: Record<string, PhraseMemory> = {},
): { done?: ItemResolution; ranked: Array<{ e: ModelElement; s: number }> } {
  const remembered = memory[phraseKey(item.target)];
  if (remembered) {
    const hits = model.elements.filter((e) => sameAsMemory(e, remembered));
    if (hits.length === 1) return { done: { status: "resolved", element: hits[0]!, via: "memory", confidence: 1 }, ranked: [] };
  }
  const phrase = parsePhrase(item.target, item.role);
  const ranked = model.elements.map((e) => ({ e, s: score(e, phrase) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
  const [top, second] = ranked;
  // A clear winner: a full match on label (and section, when the phrase names one)
  // with nothing else matching fully; ties are left to the decision model or the agent.
  if (top && top.s >= 100 && (!second || second.s < 100 || top.s - second.s >= 10)) {
    return { done: { status: "resolved", element: top.e, via: "code", confidence: 1 }, ranked };
  }
  return { ranked };
}

function questionFor(target: string): string {
  return `Which page element is this target: "${target}"? Elements are listed in the state by id. Choose none if no element matches.`;
}

export async function resolveItems(
  model: PageModel,
  items: ResolveItem[],
  options: { decider?: JevConfig; memory?: Record<string, PhraseMemory>; minConfidence?: number } = {},
): Promise<{ results: ItemResolution[]; deciderRequests: number; deciderFailures: number }> {
  const results: Array<ItemResolution | undefined> = [];
  const pending: Array<{ index: number; candidates: ModelElement[] }> = [];
  for (const [index, item] of items.entries()) {
    const { done, ranked } = resolveByCode(model, item, options.memory);
    if (done) { results[index] = done; continue; }
    // Candidates for the decider: what code scored first, then the rest of the page,
    // so a synonym ("CTA" for "Call to action") is still on the list.
    const scored = new Set(ranked.map((x) => x.e));
    const pool = [...scored, ...model.elements.filter((e) => !scored.has(e))];
    if (pool.length === 0) { results[index] = { status: "not_found", reason: "the page has no interactive elements" }; continue; }
    results[index] = undefined;
    pending.push({ index, candidates: pool.slice(0, MAX_OPTIONS) });
  }

  let deciderRequests = 0;
  let deciderFailures = 0;
  if (pending.length && options.decider) {
    // One shared element list in the state; each question names its candidates by id.
    const listed = new Map<number, ModelElement>();
    for (const p of pending) for (const e of p.candidates) listed.set(e.n, e);
    const state = {
      page: { title: model.title, url: model.url },
      elements: [...listed.values()].map((e) => `o${e.n}| ${describeForDecider(e)}`),
    };
    const questions: Record<string, JevQuestion> = {};
    for (const p of pending) {
      const criteria: Record<string, string | null> = Object.fromEntries(p.candidates.map((e) => [`o${e.n}`, null]));
      criteria.none = "No listed element matches the target";
      questions[`q${p.index}`] = { type: "choice", instructions: questionFor(items[p.index]!.target), criteria };
    }
    const response = await askMany(options.decider, state, questions);
    deciderRequests = response.requests;
    deciderFailures = response.failures;
    const min = options.minConfidence ?? options.decider.minConfidence;
    for (const p of pending) {
      const answer: JevAnswer | undefined = response.answers[`q${p.index}`];
      if (answer?.type !== "choice") continue;
      const byKey = (key: string) => p.candidates.find((e) => `o${e.n}` === key);
      const chosen = answer.choice === "none" ? undefined : byKey(answer.choice);
      if (chosen && answer.confidence >= min) {
        results[p.index] = { status: "resolved", element: chosen, via: "decider", confidence: answer.confidence };
        continue;
      }
      if (answer.choice === "none" && answer.confidence >= min) {
        results[p.index] = { status: "not_found", reason: `no element matches (decision model, confidence ${answer.confidence.toFixed(2)})` };
        continue;
      }
      // Unsure: hand back the decider's own ranking.
      const ranked = Object.entries(answer.probabilities ?? {})
        .filter(([k]) => k !== "none").sort((a, b) => b[1] - a[1])
        .map(([k]) => byKey(k)).filter((e): e is ModelElement => e !== undefined);
      if (ranked.length) results[p.index] = { status: "needs_choice", candidates: ranked.slice(0, HAND_BACK), reason: `the decision model was unsure (confidence ${answer.confidence.toFixed(2)})` };
    }
  }
  for (const p of pending) {
    if (results[p.index]) continue;
    const reason = options.decider ? "the decision model did not answer" : "more than one element could match";
    results[p.index] = { status: "needs_choice", candidates: p.candidates.slice(0, HAND_BACK), reason };
  }
  return { results: results as ItemResolution[], deciderRequests, deciderFailures };
}

/** One line per candidate, for hand-back messages. */
export function candidateLine(e: ModelElement): string {
  return `o${e.n} ${describeForDecider(e)}${e.state ? ` [${e.state}]` : ""}${e.where ? ` (${e.where})` : ""}`;
}
