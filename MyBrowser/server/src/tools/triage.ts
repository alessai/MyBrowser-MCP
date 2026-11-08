import { z } from "zod";
import { zodToJsonSchema } from "../utils/json-schema.js";
import { actOnCards, cardWarning, isIrreversibleAction, labelCards, readCards, type Card } from "../page/triage.js";
import type { Tool } from "./types.js";

const TriageArgs = z.object({
  tabId: z.number().optional().describe("Target tab ID. If omitted, uses this session's current tab (opened with new_tab or browser_navigate, or chosen with select_tab), never the user's active tab."),
  labels: z.record(z.string(), z.string()).describe("Label name -> what it means, e.g. {\"ignore\": \"sells software development or freelance services\", \"keep\": \"anyone else\"}"),
  cards: z.string().optional().describe("CSS selector of one card. Default: the page's main repeating list is found automatically."),
  load: z.boolean().optional().describe("Scroll and press 'Show more' until the list stops growing (default true)"),
  maxItems: z.number().int().min(1).max(1000).optional().describe("Most cards to read (default 300)"),
  minConfidence: z.number().min(0.5).max(0.99).optional().describe("Labels below this go to review (default 0.8)"),
  labelsById: z.record(z.string(), z.string()).optional().describe("Your own labels for card ids, e.g. from a run without a decision model"),
  action: z.object({
    label: z.string().describe("Which label to act on"),
    control: z.string().describe("Text of the control inside each card to click, e.g. 'Ignore' or 'Accept'"),
  }).optional(),
  confirm: z.array(z.string()).optional().describe("Card ids to act on, copied from a dry run. Required to click anything."),
  allowIrreversible: z.boolean().optional().describe("Needed when the control deletes, pays, sends, publishes, reports or removes"),
  paceMs: z.number().int().min(300).max(10_000).optional().describe("Pause between clicks (default 1500)"),
});

const short = (c: Card) => `${c.id}: ${c.text.slice(0, 140)}`;

export const triage: Tool = {
  schema: {
    name: "browser_triage",
    description:
      "Sort a list on the page (invitations, messages, search results, table rows) into your labels, then act on the confirmed cards. Step 1 (dry run, default): reads every card, loading more as needed, and returns each label's cards with ids; with a decision model the labels are assigned for you (unsure ones go to review), without one you get the cards to label yourself. Step 2: call again with action {label, control} and confirm: [ids] to click that control in each confirmed card, paced, re-finding each card before its click, stopping if a dialog opens.",
    inputSchema: zodToJsonSchema(TriageArgs),
  },
  handle: async (context, params) => {
    const args = TriageArgs.parse(params);
    const { cards, found } = await readCards(context, args.tabId, { selector: args.cards, load: args.load !== false, max: args.maxItems ?? 300 });
    if (cards.length === 0) throw new Error("No repeating list found on the page; pass cards with a CSS selector for one card.");
    const warning = cardWarning(cards);

    if (args.confirm) {
      if (!args.action) throw new Error("confirm needs action {label, control}");
      if (isIrreversibleAction(args.action.control) && args.allowIrreversible !== true) {
        throw new Error(`"${args.action.control}" may delete, pay, send, publish or report; pass allowIrreversible: true if that is intended.`);
      }
      const known = new Set(cards.map((c) => c.id));
      const missing = args.confirm.filter((id) => !known.has(id));
      const ids = args.confirm.filter((id) => known.has(id));
      const result = await actOnCards(context, args.tabId, ids, args.action.control, args.paceMs ?? 1500);
      const after = await readCards(context, args.tabId, { selector: args.cards, load: false, max: args.maxItems ?? 300 }).catch(() => undefined);
      const lines = [
        `Clicked "${args.action.control}" on ${result.done.length} of ${args.confirm.length} confirmed cards.${result.stopped ? ` Stopped: ${result.stopped}.` : ""}`,
        ...(missing.length ? [`Not on the page any more (skipped): ${missing.join(", ")}`] : []),
        ...result.failed.map((f) => `FAILED ${f.id}: ${f.reason}`),
        ...(after ? [`Cards now on the page: ${after.cards.length}.`] : []),
      ];
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }

    const decided = args.labelsById
      ? new Map(Object.entries(args.labelsById).map(([id, label]) => [id, { label, confidence: 1 }]))
      : await labelCards(context, cards, args.labels);
    if (decided.size === 0) {
      const lines = [
        `${cards.length} cards read (${found} found). No decision model is configured, so label them yourself and call again with labelsById {id: label}:`,
        ...(warning ? [warning] : []),
        ...cards.map(short),
      ];
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
    const min = args.minConfidence ?? 0.8;
    const buckets = new Map<string, Card[]>();
    const review: Array<{ card: Card; note: string }> = [];
    for (const card of cards) {
      const d = decided.get(card.id);
      if (!d || d.label === "unsure" || d.confidence < min || !(d.label in args.labels)) {
        review.push({ card, note: d ? `${d.label} ${d.confidence.toFixed(2)}` : "not labelled" });
        continue;
      }
      buckets.set(d.label, [...(buckets.get(d.label) ?? []), card]);
    }
    const lines = [
      `Dry run: ${cards.length} cards read (${found} found). No card controls were clicked${args.load !== false ? " (only 'Show more' to load the list)" : ""}.`,
      ...(warning ? [warning] : []),
      ...Object.keys(args.labels).flatMap((label) => {
        const list = buckets.get(label) ?? [];
        return [`## ${label} (${list.length})`, ...list.map(short)];
      }),
      `## review (${review.length})`,
      ...review.map((r) => `${short(r.card)} [${r.note}]`),
      "To act: call again with action {label, control} and confirm: [the ids you approve].",
    ];
    return { content: [{ type: "text", text: lines.join("\n") }] };
  },
};
