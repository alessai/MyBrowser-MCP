import type { Context } from "../context.js";
import { askPage, readPageText } from "./engine.js";

// `expect` on an action: one call does the action and reports whether the
// expected result showed up, instead of a separate "did it work?" turn.
// It only reports; it never retries or undoes anything.

const CHECK_MS = 3_000;
const POLL_MS = 500;
const YES = 0.7;

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function checkExpectation(context: Context, tabId: number | undefined, expect: string): Promise<string> {
  const started = Date.now();
  let last: number | undefined;
  let lastContra: number | undefined;
  let streak = 0;
  for (;;) {
    const page = await readPageText(context, tabId);
    if (context.jev) {
      const [shown, contradicted] = await askPage(context, page, [
        `Does the page show this: "${expect}"?`,
        `Does the page show that this did not happen or failed: "${expect}"?`,
      ]);
      last = shown;
      lastContra = contradicted;
      // Two readings in a row, like browser_wait_for until (no false alarms in testing).
      streak = shown !== undefined && shown >= YES ? streak + 1 : 0;
      if (streak >= 2) return `Expect "${expect}": confirmed (probability ${shown!.toFixed(2)}).`;
    } else if (norm(page.text).includes(norm(expect))) {
      return `Expect "${expect}": confirmed (the text is on the page).`;
    }
    if (Date.now() - started >= CHECK_MS) break;
    await sleep(streak === 1 ? 150 : POLL_MS);
  }
  if (!context.jev) {
    return `Expect "${expect}": not confirmed: that text is not on the page after ${CHECK_MS / 1000} s (no decision model is configured to judge a description, so only exact text is checked).`;
  }
  if (lastContra !== undefined && lastContra >= YES) return `Expect "${expect}": contradicted, the page shows it did not happen (probability ${lastContra.toFixed(2)}).`;
  if (last === undefined) return `Expect "${expect}": not checked (the decision model did not answer).`;
  return `Expect "${expect}": not confirmed after ${CHECK_MS / 1000} s (probability ${last.toFixed(2)}); look at the page before continuing.`;
}
