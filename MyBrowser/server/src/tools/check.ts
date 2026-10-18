import { randomUUID } from "node:crypto";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { askJev, type JevQuestion } from "../jev/client.js";
import { describeElement, readPageState } from "../jev/page.js";
import type { Tool } from "./types.js";

const CheckArgs = z.object({
  tabId: z.number().optional().describe("Target tab ID. If omitted, uses the active tab."),
  question: z.string().min(1).max(2_000).describe(
    "What to decide about the current page, e.g. 'Is the user signed in?' or 'Which plan is selected?'",
  ),
  options: z.array(z.string().min(1).max(500)).min(2).max(20).optional().describe(
    "Possible answers. Omit for a yes/no question (returns the probability of yes).",
  ),
  visual: z.boolean().optional().describe(
    "Also send a screenshot of the viewport (needs jev.vision: true). Use for canvas, images, or layout questions the page text cannot answer.",
  ),
});

export const check: Tool = {
  schema: {
    name: "browser_check",
    description:
      "Answer a yes/no or multiple-choice question about the current page in ~0.3-0.5s using the TypeSafe Jev decision model, instead of reading a snapshot yourself. Read-only. Sends the page URL, title, visible text, and interactive element names (and a screenshot when visual is true) to TypeSafe.",
    inputSchema: zodToJsonSchema(CheckArgs),
  },
  handle: async (context, params) => {
    const { tabId, question, options, visual } = CheckArgs.parse(params);
    const config = context.jev;
    if (!config) throw new Error("browser_check needs a TypeSafe API key: add a jev section to ~/.mybrowser/config.json");
    if (visual && !config.vision) {
      throw new Error("Visual checks are off. Set jev.vision: true in ~/.mybrowser/config.json to allow sending screenshots to TypeSafe.");
    }
    const page = await readPageState(context, tabId, { includeText: true });
    const image = visual
      ? {
        ref: `screenshot-${randomUUID()}`,
        base64: await context.sendSocketMessage("browser_screenshot", tabId === undefined ? {} : { tabId }) as string,
      }
      : undefined;
    const answerQuestion: JevQuestion = options
      ? {
        type: "choice",
        instructions: question,
        criteria: Object.fromEntries(options.map((option, i) => [`o${i + 1}`, option])),
      }
      : { type: "noul", instructions: question };
    const response = await askJev(config, {
      state: {
        page: { url: page.url, title: page.title },
        visible_text: page.text ?? "",
        interactive_elements: page.elements.slice(0, 200).map(describeElement),
        ...(image ? { screenshot: image.ref } : {}),
      },
      questions: { answer: answerQuestion },
      ...(image ? { image } : {}),
    });
    const answer = response.answers.answer;
    let text: string;
    if (answer?.type === "noul") {
      const verdict = answer.noul >= 0.8 ? "YES" : answer.noul <= 0.2 ? "NO" : "UNCERTAIN";
      text = `${verdict} — probability of yes: ${answer.noul.toFixed(2)}`;
    } else if (answer?.type === "choice" && options) {
      const chosen = options[Number(answer.choice.slice(1)) - 1] ?? answer.choice;
      const ranked = options
        .map((option, i) => `${option}: ${(answer.probabilities?.[`o${i + 1}`] ?? 0).toFixed(2)}`)
        .join(", ");
      text = `Answer: "${chosen}" (confidence ${answer.confidence.toFixed(2)}). Probabilities — ${ranked}`;
    } else {
      throw new Error("JEV_BAD_RESPONSE");
    }
    return { content: [{ type: "text", text: `${text}\n(${response.model}, ${response.ms}ms)` }] };
  },
};
