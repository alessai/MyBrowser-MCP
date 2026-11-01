import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { askMany, type JevQuestion } from "../jev/client.js";
import { readPageModel, type ModelElement, type PageModel } from "../page/model.js";
import { rememberOutline } from "../page/refs.js";
import type { Tool } from "./types.js";

const OutlineArgs = z.object({
  tabId: z.number().optional().describe("Target tab ID. If omitted, uses the active tab."),
  focus: z.string().optional().describe("What you are looking for, e.g. 'placements and budget'. Returns only the relevant sections."),
  section: z.string().optional().describe("Only sections whose title contains this text."),
  sweep: z.boolean().optional().describe("Scroll through the page first so lazily loaded sections are included, then scroll back. Default false."),
});

const MAX_LINES = 600;

/** Row text is shown for unlabeled controls and for labels that repeat (30 "On/off" switches, one per campaign row). */
function line(e: ModelElement, repeated: Set<string>): string {
  const showRow = e.row && (!e.name || repeated.has(`${e.role}|${e.name}`));
  const name = e.name ? `"${e.name}"` : "(no label)";
  const bits = [`o${e.n} ${e.role} ${name}${showRow ? ` row "${e.row}"` : ""}`];
  if (e.state) bits.push(`[${e.state}]`);
  if (e.options?.length) bits.push(`options: ${e.options.slice(0, 12).join(" | ")}${e.options.length > 12 ? ` | …${e.options.length - 12} more` : ""}`);
  if (e.disabled) bits.push("(disabled)");
  if (e.where) bits.push(`(${e.where})`);
  return bits.join(" ");
}

interface Group { title: string; elements: ModelElement[] }

function groupBySection(elements: ModelElement[]): Group[] {
  const groups: Group[] = [];
  for (const e of elements) {
    const title = e.section || "(top of page)";
    const last = groups[groups.length - 1];
    if (last && last.title === title) last.elements.push(e);
    else {
      const prior = groups.find((g) => g.title === title);
      if (prior) prior.elements.push(e);
      else groups.push({ title, elements: [e] });
    }
  }
  return groups;
}

const words = (s: string) => new Set(s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2));

/** Sections relevant to `focus`: a decision model when configured, else word overlap. */
async function focusGroups(groups: Group[], focus: string, model: PageModel, decider: Parameters<typeof askMany>[0] | undefined): Promise<{ kept: Group[]; how: string }> {
  if (decider) {
    const state = {
      page: { title: model.title, url: model.url },
      sections: groups.map((g, i) => `s${i}| ${g.title}: ${g.elements.slice(0, 30).map((e) => e.name || e.row).filter(Boolean).join(", ").slice(0, 400)}`),
    };
    const questions: Record<string, JevQuestion> = Object.fromEntries(groups.map((g, i) => [`s${i}`, {
      type: "noul" as const,
      instructions: `Is section s${i} ("${g.title}") relevant to what the agent is looking for: "${focus}"?`,
    }]));
    try {
      const { answers, failures } = await askMany(decider, state, questions);
      if (failures === 0) {
        const kept = groups.filter((_, i) => { const a = answers[`s${i}`]; return a?.type === "noul" && a.noul >= 0.5; });
        if (kept.length) return { kept, how: "relevance judged by the decision model" };
      }
    } catch { /* fall through to word overlap */ }
  }
  const want = words(focus);
  const scored = groups.map((g) => {
    const have = words(`${g.title} ${g.elements.map((e) => `${e.name} ${e.sub} ${e.row}`).join(" ")}`);
    return { g, s: [...want].filter((w) => have.has(w)).length };
  });
  const kept = scored.filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 6).map((x) => x.g);
  return { kept: kept.length ? groups.filter((g) => kept.includes(g)) : groups, how: kept.length ? "matched by words" : "no section matched, showing all" };
}

export const outline: Tool = {
  schema: {
    name: "browser_outline",
    description:
      "Compact map of every control on the page, including parts below the fold and collapsed sections: grouped by section, each with an id (o12), role, label and current state (on/off, selected option, field value). Use it instead of scrolling and snapshotting to find or check settings. Pass the id as ref: \"o12\" to browser_click, browser_type, browser_hover or browser_select_option. Ids stay the same across reads of the same page.",
    inputSchema: zodToJsonSchema(OutlineArgs),
  },
  handle: async (context, params) => {
    const args = OutlineArgs.parse(params ?? {});
    const model = await readPageModel(context, args.tabId, { sweep: args.sweep === true });
    rememberOutline(context, args.tabId, model);
    let groups = groupBySection(model.elements);
    let note = "";
    if (args.section) {
      const want = args.section.toLowerCase();
      groups = groups.filter((g) => g.title.toLowerCase().includes(want));
      note = ` Filtered to sections containing "${args.section}".`;
    }
    if (args.focus) {
      const { kept, how } = await focusGroups(groups, args.focus, model, context.jev);
      groups = kept;
      note += ` Focus "${args.focus}" (${how}).`;
    }
    const counts = model.elements.reduce<Record<string, number>>((m, e) => { if (e.where) m[e.where] = (m[e.where] ?? 0) + 1; return m; }, {});
    const extra = Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ");
    const out: string[] = [
      `Outline of "${model.title}" (${model.url}): ${model.elements.length} controls in ${groupBySection(model.elements).length} sections${extra ? `; ${extra}` : ""}.${note}`,
    ];
    if (model.truncated) out.push("The page has more controls than one read covers; use section or focus to narrow it.");
    if (model.frames.sameOrigin + model.frames.crossOrigin > 0) out.push(`Not included: controls inside ${model.frames.sameOrigin + model.frames.crossOrigin} iframe(s).`);
    const seen = new Map<string, number>();
    for (const e of model.elements) seen.set(`${e.role}|${e.name}`, (seen.get(`${e.role}|${e.name}`) ?? 0) + 1);
    const repeated = new Set([...seen].filter(([, c]) => c > 1).map(([k]) => k));
    let lines = 0;
    let hidden = 0;
    for (const g of groups) {
      if (lines >= MAX_LINES) { hidden += g.elements.length; continue; }
      out.push(`## ${g.title}`);
      let sub = "";
      for (const e of g.elements) {
        if (lines >= MAX_LINES) { hidden += 1; continue; }
        if (e.sub && e.sub !== sub) { out.push(`### ${e.sub}`); sub = e.sub; }
        out.push(line(e, repeated));
        lines += 1;
      }
    }
    if (hidden) out.push(`…${hidden} more controls not shown; pass section or focus to see them.`);
    return { content: [{ type: "text", text: out.join("\n") }] };
  },
};
