import { randomUUID } from "node:crypto";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { askJev, type JevAnswer, type JevQuestion } from "../jev/client.js";
import type { JevConfig } from "../jev/config.js";
import { describeElement, readPageState } from "../jev/page.js";
import type { Tool } from "./types.js";

const Question = z.string().min(1).max(2_000);
const Options = z.array(z.string().min(1).max(500)).min(2).max(20);

const CheckArgs = z.object({
  tabId: z.number().optional().describe("Target tab ID. If omitted, uses the active tab."),
  question: Question.optional().describe(
    "What to decide about the current page, e.g. 'Is the user signed in?' or 'Which plan is selected?'",
  ),
  options: Options.optional().describe(
    "Possible answers for `question`. Omit for a yes/no question (returns the probability of yes).",
  ),
  checks: z.array(z.object({ question: Question, options: Options.optional() })).min(1).max(8).optional().describe(
    "Several questions about the same page, answered together in one call. Each is yes/no unless it has options.",
  ),
  preset: z.enum(["state"]).optional().describe(
    "'state' adds standard yes/no checks: popup or overlay covering the page, sign-in wall, CAPTCHA, error message, still loading.",
  ),
  visual: z.boolean().optional().describe(
    "Also send a screenshot of the viewport (needs jev.vision: true). Use for canvas, images, or layout questions the page text cannot answer.",
  ),
}).refine((args) => args.question !== undefined || args.checks !== undefined || args.preset !== undefined, {
  message: "Give a question, checks, or a preset",
}).refine((args) => args.options === undefined || args.question !== undefined, {
  message: "options needs a question",
});

interface Item { label: string; question: string; options?: string[] }

// Wording of each preset check: what the agent sees (label) and what Jev is asked.
export const STATE_PRESET: Item[] = [
  { label: "Popup or overlay covering the page", question: "Is a modal dialog, popup, cookie banner, or overlay covering the main content of the page?" },
  { label: "Sign-in wall", question: "Is the page asking the user to sign in or log in before it shows its content?" },
  { label: "CAPTCHA or human check", question: "Is a CAPTCHA or human-verification check blocking the page?" },
  { label: "Error message", question: "Is an error, not-found, access-denied, or form validation message visible?" },
  { label: "Still loading", question: "Is the page still loading, showing spinners or empty placeholders instead of its content?" },
];

function question(item: Item): JevQuestion {
  return item.options
    ? {
      type: "choice",
      instructions: item.question,
      // Without "none" Jev must pick one of the agent's options even when none applies.
      criteria: { ...Object.fromEntries(item.options.map((option, i) => [`o${i + 1}`, option])), none: "None of the listed answers applies" },
    }
    : { type: "noul", instructions: item.question };
}

function render(item: Item, answer: JevAnswer | undefined, config: JevConfig): string {
  if (answer?.type === "noul" && !item.options) {
    const verdict = answer.noul >= 0.8 ? "YES" : answer.noul <= 0.2 ? "NO" : "UNCERTAIN";
    return `${verdict} \u2014 probability of yes: ${answer.noul.toFixed(2)}`;
  }
  if (answer?.type === "choice" && item.options) {
    const options = item.options;
    const chosen = answer.choice === "none" ? undefined : options[Number(answer.choice.slice(1)) - 1];
    const ranked = [
      ...options.map((option, i) => `${option}: ${(answer.probabilities?.[`o${i + 1}`] ?? 0).toFixed(2)}`),
      `none of these: ${(answer.probabilities?.none ?? 0).toFixed(2)}`,
    ].join(", ");
    const verdict = chosen === undefined ? "none of the options applies" : `"${chosen}"`;
    const prefix = answer.confidence >= config.minConfidence ? "Answer" : "UNCERTAIN \u2014 leaning";
    return `${prefix}: ${verdict} (confidence ${answer.confidence.toFixed(2)}). Probabilities \u2014 ${ranked}`;
  }
  throw new Error("JEV_BAD_RESPONSE");
}

export const check: Tool = {
  schema: {
    name: "browser_check",
    description:
      "Answer yes/no or multiple-choice questions about the current page in ~0.3-0.5s using the TypeSafe Jev decision model, instead of reading a snapshot yourself. Ask several at once with `checks`, or use preset 'state' to learn whether a popup, sign-in wall, CAPTCHA, error, or loading state is in the way. Read-only. Sends the page URL, title, visible text, and interactive element names (and a screenshot when visual is true) to TypeSafe.",
    inputSchema: zodToJsonSchema(CheckArgs),
  },
  handle: async (context, params) => {
    const args = CheckArgs.parse(params);
    const config = context.jev;
    if (!config) throw new Error("browser_check needs a TypeSafe API key: run `mybrowser-mcp jev set-key`");
    if (args.visual && !config.vision) {
      throw new Error("Visual checks are off. Set jev.vision: true in ~/.mybrowser/config.json to allow sending screenshots to TypeSafe.");
    }
    const items: Item[] = [
      ...(args.question ? [{ label: args.question, question: args.question, options: args.options }] : []),
      ...(args.checks ?? []).map((c) => ({ label: c.question, question: c.question, options: c.options })),
      ...(args.preset === "state" ? STATE_PRESET : []),
    ];
    const page = await readPageState(context, args.tabId, { includeText: true });
    const image = args.visual
      ? {
        ref: `screenshot-${randomUUID()}`,
        base64: await context.sendSocketMessage("browser_screenshot", args.tabId === undefined ? {} : { tabId: args.tabId }) as string,
      }
      : undefined;
    // All questions share one page read and one request; Jev answers them in parallel.
    const response = await askJev(config, {
      state: {
        page: { url: page.url, title: page.title },
        visible_text: page.text ?? "",
        interactive_elements: page.elements.slice(0, 200).map(describeElement),
        ...(image ? { screenshot: image.ref } : {}),
      },
      questions: Object.fromEntries(items.map((item, i) => [`q${i + 1}`, question(item)])),
      ...(image ? { image } : {}),
    });
    const lines = items.map((item, i) => render(item, response.answers[`q${i + 1}`], config));
    const text = items.length === 1
      ? lines[0]!
      : items.map((item, i) => `${i + 1}. ${item.label} \u2014 ${lines[i]}`).join("\n");
    return { content: [{ type: "text", text: `${text}\n(${response.model}, ${response.ms}ms)` }] };
  },
};
