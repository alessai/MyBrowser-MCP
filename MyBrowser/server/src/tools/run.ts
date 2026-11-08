import { z } from "zod";
import { zodToJsonSchema } from "../utils/json-schema.js";
import { runGoal } from "../page/run.js";
import type { Tool } from "./types.js";

const RunArgs = z.object({
  tabId: z.number().optional().describe("Target tab ID. If omitted, uses this session's current tab (opened with new_tab or browser_navigate, or chosen with select_tab), never the user's active tab."),
  goal: z.string().min(3).describe("What to achieve on this page, concretely, e.g. 'search for flights from Muscat to Dubai on 12 Nov and open the results'"),
  values: z.record(z.string(), z.string()).optional().describe("Named values the run may type or choose, e.g. {\"from\": \"Muscat\", \"date\": \"2026-11-12\"}. Nothing else is ever typed."),
  allow: z.array(z.enum(["click", "type", "select", "scroll", "wait"])).optional().describe("Operations the run may use (default all)"),
  maxSteps: z.number().int().min(1).max(50).optional().describe("Step budget (default 25)"),
  stopWhen: z.string().optional().describe("Stop as soon as the page shows this, e.g. 'a results list is shown'"),
  allowIrreversible: z.boolean().optional().describe("Allow clicks that may pay, send, submit, publish or delete. Default false: the run stops and hands that click back."),
});

export const run: Tool = {
  schema: {
    name: "browser_run",
    description:
      "Autopilot for a well-defined task on the current page: a fast decision model picks each step (click, type a named value, set a control, scroll, wait) and code acts and checks the effect, without a turn of yours per step. Returns a step trace and why it stopped: done (goal met, double-checked), blocked (needs the user), needs_agent (unsure, or a risky click it will not make), stopped (loop or no progress) or max_steps. Use it for mechanical sequences; do judgment, copywriting and sign-ins yourself.",
    inputSchema: zodToJsonSchema(RunArgs),
  },
  handle: async (context, params) => {
    const args = RunArgs.parse(params);
    const result = await runGoal(context, {
      goal: args.goal,
      values: args.values ?? {},
      allow: args.allow ?? ["click", "type", "select", "scroll", "wait"],
      maxSteps: args.maxSteps ?? 25,
      stopWhen: args.stopWhen,
      tabId: args.tabId,
      allowIrreversible: args.allowIrreversible === true,
    });
    const text = [
      `${result.outcome.toUpperCase()}: ${result.reason} (${result.steps.length} steps, ${(result.ms / 1000).toFixed(1)} s, ${result.requests} decision requests).`,
      ...result.steps,
      ...(result.outcome === "done" ? [] : ["Continue with the other tools from here, or call browser_run again with a narrower goal."]),
    ].join("\n");
    return { content: [{ type: "text", text }] };
  },
};
