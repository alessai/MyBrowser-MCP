import type { Context } from "../context.js";
import { askJev } from "./client.js";
import type { JevConfig } from "./config.js";
import { describeElement, readPageState } from "./page.js";

// When a targeted action fails again on the same tab soon after an earlier
// failure, ask Jev what on the page is in the way and add one line of advice to
// the error. Read-only: it never clicks, dismisses, or retries anything.
const REPEAT_WINDOW_MS = 120_000;

const CAUSES: Record<string, { criterion: string; advice: string }> = {
  overlay: {
    criterion: "A modal dialog, popup, cookie banner, or overlay covers the page",
    advice: "a popup, dialog, or cookie banner seems to be covering the page; deal with it first.",
  },
  login: {
    criterion: "The page asks the user to sign in or log in before continuing",
    advice: "the page seems to want a sign-in first.",
  },
  captcha: {
    criterion: "A CAPTCHA or human-verification check blocks the page",
    advice: "a CAPTCHA or human check seems to be blocking the page; ask the user to handle it.",
  },
  loading: {
    criterion: "The page is still loading, showing spinners or empty placeholders",
    advice: "the page still looks like it is loading; wait, then retry.",
  },
  error: {
    criterion: "The page shows an error, not-found, or access-denied message",
    advice: "the page shows an error or access-denied message.",
  },
  none: {
    criterion: "None of these: the page looks loaded and usable",
    advice: "nothing seems to be blocking the page, so the target is probably not on it; take a snapshot, scroll, or check you are on the right page.",
  },
};

const lastFailure = new WeakMap<object, Map<string, number>>();
const tabKey = (tabId: number | undefined) => (tabId === undefined ? "active" : String(tabId));

export function noteTargetedSuccess(context: Context, tabId: number | undefined): void {
  lastFailure.get(context)?.delete(tabKey(tabId));
}

export async function diagnoseRepeatedFailure(
  context: Context,
  config: JevConfig,
  tabId: number | undefined,
  ask = askJev,
  now: () => number = Date.now,
  options: { hadCandidate?: boolean } = {},
): Promise<string | undefined> {
  let failures = lastFailure.get(context);
  if (!failures) {
    failures = new Map();
    lastFailure.set(context, failures);
  }
  const at = now();
  const previous = failures.get(tabKey(tabId));
  failures.set(tabKey(tabId), at);
  if (previous === undefined || at - previous > REPEAT_WINDOW_MS) return undefined;

  try {
    const deadline = at + config.timeoutMs;
    const page = await readPageState(context, tabId, { includeText: true, timeoutMs: config.timeoutMs });
    const left = deadline - now();
    if (left <= 0) return undefined;
    const response = await ask({ ...config, timeoutMs: left }, {
      state: {
        page: { title: page.title, url: page.url },
        visible_text: page.text ?? "",
        interactive_elements: page.elements.slice(0, 120).map(describeElement),
      },
      questions: {
        cause: {
          type: "choice",
          instructions: "An automated agent has failed more than once in a row to act on an element of this page. What on the page most likely explains it?",
          criteria: Object.fromEntries(Object.entries(CAUSES).map(([key, cause]) => [key, cause.criterion])),
        },
      },
    });
    const answer = response.answers.cause;
    if (answer?.type !== "choice" || answer.confidence < config.minConfidence) return undefined;
    // "Not on the page" would contradict a candidate the fallback just offered.
    if (answer.choice === "none" && options.hadCandidate) return undefined;
    const cause = CAUSES[answer.choice];
    return cause ? `Page check after repeated failures (confidence ${answer.confidence.toFixed(2)}): ${cause.advice}` : undefined;
  } catch {
    return undefined;
  }
}
