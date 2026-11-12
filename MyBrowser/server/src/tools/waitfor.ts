import { z } from "zod";
import { zodToJsonSchema } from "../utils/json-schema.js";
import { askPage, compareSetting, handBack, readModel, readPageText, resolveOnPage } from "../page/engine.js";
import { outlineRefNumber } from "../page/model.js";
import type { ItemResolution } from "../page/resolve.js";
import type { Tool } from "./types.js";

// --- browser_wait_for ---

const WaitForArgs = z.object({
  tabId: z.number().optional().describe("Target tab ID. If omitted, uses this session's current tab (opened with new_tab or browser_navigate, or chosen with select_tab), never the user's active tab."),
  // A string, not an enum, in the published schema: aliases like "el_exists" or
  // "text_visible:Saved" are rewritten on the server (tools/arg-aliases.ts).
  condition: z.string().optional().describe("Code check: url_contains, url_matches, element_visible, element_not_visible, text_visible, text_not_visible or network_idle. Omit when using until."),
  until: z.string().optional().describe("Plain-language state to wait for, e.g. 'the video upload has finished processing'. Needs a decision model; without one, use condition."),
  failIf: z.string().optional().describe("With until: stop early when this is true, e.g. 'an upload error is shown'"),
  value: z.string().optional().describe("Parameter for the condition (URL substring, regex pattern, or text to match)"),
  selector: z.string().optional().describe("CSS selector for element_visible / element_not_visible conditions"),
  timeout: z.number().optional().default(10000).describe("Max wait time in ms (default 10000; up to 300000 with until)"),
  pollInterval: z.number().optional().default(500).describe("Poll interval in ms (default 500)"),
  time: z.number().optional().describe("Seconds to simply wait when there is nothing specific to wait for (same as browser_wait)."),
});

const CONDITIONS = new Set(["url_contains", "url_matches", "element_visible", "element_not_visible", "text_visible", "text_not_visible", "network_idle"]);

// Two readings in a row at or above this count as reached (Nov 1 2026: about
// 0.7 s after the change, no false alarms in 5 runs).
const UNTIL_THRESHOLD = 0.7;

async function waitUntil(context: Parameters<Tool["handle"]>[0], args: z.infer<typeof WaitForArgs>): Promise<string> {
  if (!context.jev) {
    throw new Error("browser_wait_for until needs a decision model (mybrowser-mcp jev set-key). Without one, wait with a code condition instead: text_visible, text_not_visible, element_visible, element_not_visible, url_contains, url_matches or network_idle.");
  }
  const started = Date.now();
  const timeout = Math.min(args.timeout, 300_000);
  const interval = Math.max(args.pollInterval, 400);
  let streak = 0;
  let last: number | undefined;
  let polls = 0;
  while (Date.now() - started < timeout) {
    const pollStarted = Date.now();
    polls += 1;
    const page = await readPageText(context, args.tabId);
    const [reached, failed] = await askPage(context, page, [
      `Does the page show this state: "${args.until}"?`,
      ...(args.failIf ? [`Does the page show this: "${args.failIf}"?`] : []),
    ]);
    if (failed !== undefined && failed >= UNTIL_THRESHOLD) {
      return `Stopped after ${((Date.now() - started) / 1000).toFixed(1)} s: "${args.failIf}" is shown (probability ${failed.toFixed(2)}).`;
    }
    last = reached;
    streak = reached !== undefined && reached >= UNTIL_THRESHOLD ? streak + 1 : 0;
    if (streak >= 2) return `Reached after ${((Date.now() - started) / 1000).toFixed(1)} s: "${args.until}" (probability ${reached!.toFixed(2)}, ${polls} checks).`;
    // Confirm a first hit right away; otherwise poll on a fixed rhythm (the check itself counts).
    const wait = streak === 1 ? 150 : Math.max(0, interval - (Date.now() - pollStarted));
    await new Promise((r) => setTimeout(r, wait));
  }
  throw new Error(`WAIT_TIMEOUT: "${args.until}" not reached within ${timeout} ms (last probability ${last === undefined ? "unknown" : last.toFixed(2)}).`);
}

export const waitFor: Tool = {
  schema: {
    name: "browser_wait_for",
    description:
      "Wait until something is true, returning the moment it is. Code conditions: {condition: 'text_visible', value: 'Saved'} (also text_not_visible, url_contains, url_matches, network_idle) or {condition: 'element_visible', selector: '.done'} (also element_not_visible); shorthand {text: 'Saved'} works too. "
      + "Or until: a plain-language state, e.g. {until: 'the upload has finished processing', failIf: 'an error is shown', timeout: 120000}, judged by the decision model every poll. timeout is in ms (default 10000). Use this instead of fixed waits and repeated snapshots.",
    inputSchema: zodToJsonSchema(WaitForArgs),
  },
  handle: async (context, params) => {
    const validated = WaitForArgs.parse(params);
    if (validated.until) return { content: [{ type: "text", text: await waitUntil(context, validated) }] };
    if (!validated.condition && validated.time !== undefined) {
      // Playwright-style {time}: a plain settle wait.
      const payload = { time: validated.time, ...(validated.tabId !== undefined ? { tabId: validated.tabId } : {}) };
      const r = await context.sendSocketMessage("browser_wait", payload, { timeoutMs: validated.time * 1000 + 15_000 }) as { waitedMs?: number; settled?: boolean } | undefined;
      return { content: [{ type: "text", text: r?.settled ? `Page settled after ${(r.waitedMs! / 1000).toFixed(1)} s.` : `Waited ${validated.time} seconds.` }] };
    }
    if (!validated.condition) {
      throw new Error("browser_wait_for needs something to wait for: {text: 'Saved'}, {condition: 'element_visible', selector: '.done'}, {until: 'the upload finished'} or {time: 3}");
    }
    if (!CONDITIONS.has(validated.condition)) {
      throw new Error(`browser_wait_for: unknown condition "${validated.condition}". Use one of ${[...CONDITIONS].join(", ")}, or until for a plain-language state.`);
    }
    const { tabId, until: _u, failIf: _f, time: _t, ...rest } = validated;
    const payload = tabId !== undefined ? { ...rest, tabId } : rest;
    const result = await context.sendSocketMessage("browser_wait_for", payload, {
      timeoutMs: validated.timeout + 5000,
    });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  },
};

// --- browser_assert ---

const AssertCheckSchema = z.object({
  type: z.enum([
    "url_contains",
    "url_matches",
    "element_visible",
    "element_not_visible",
    "text_contains",
    "text_not_contains",
    "element_count",
    "console_no_errors",
    "title_contains",
    "setting",
    "page",
  ]).describe("Type of assertion check"),
  target: z.string().optional().describe("setting: the control in plain words or an outline ref (o12), e.g. 'Advantage+ audience'"),
  expect: z.string().optional().describe("setting: on, off, empty, or the value/option it should show. page: 'true' (default) or 'false'"),
  match: z.enum(["exact", "contains"]).optional().describe("setting: how values are compared (default exact, case-insensitive)"),
  question: z.string().optional().describe("page: a yes/no question about the page, e.g. 'Is a sign-in wall shown?'"),
  value: z.string().optional().describe("Value to check against (URL substring, regex, text, or title text)"),
  selector: z.string().optional().describe("CSS selector for element checks"),
  min: z.number().optional().describe("Minimum element count (for element_count)"),
  max: z.number().optional().describe("Maximum element count (for element_count)"),
});

const AssertArgs = z.object({
  tabId: z.number().optional().describe("Target tab ID. If omitted, uses this session's current tab (opened with new_tab or browser_navigate, or chosen with select_tab), never the user's active tab."),
  checks: z.array(AssertCheckSchema).describe("List of assertion checks to run"),
});

type CheckResult = { type: string; passed: boolean; message: string; status?: string };

async function settingChecks(context: Parameters<Tool["handle"]>[0], tabId: number | undefined, checks: z.infer<typeof AssertCheckSchema>[]): Promise<CheckResult[]> {
  const model = await readModel(context, tabId);
  const targets = checks.map((c) => ({ target: c.target ?? "", stateful: true }));
  const direct = checks.map((c) => outlineRefNumber(c.target));
  const pending = targets.filter((_, i) => direct[i] === undefined);
  const resolved = pending.length ? await resolveOnPage(context, model, pending) : [];
  let k = 0;
  return checks.map((c, i) => {
    const label = `${c.target} = ${c.expect}`;
    if (!c.target || c.expect === undefined) return { type: "setting", passed: false, status: "error", message: "setting checks need target and expect" };
    const n = direct[i];
    let r: ItemResolution;
    if (n !== undefined) {
      const e = model.elements.find((x) => x.n === n);
      r = e ? { status: "resolved", element: e, via: "code", confidence: 1 } : { status: "not_found", reason: `o${n} is not on the page (run browser_outline again)` };
    } else r = resolved[k++]!;
    if (r.status === "not_found") return { type: "setting", passed: false, status: "not_found", message: `${label}: not found (${r.reason})` };
    if (r.status === "needs_choice") return { type: "setting", passed: false, status: "needs_choice", message: `${label}: ${handBack(r)}` };
    const verdict = compareSetting(r.element, c.expect, c.match);
    const where = `o${r.element.n} ${r.element.role} "${r.element.name}"${r.via === "decider" ? ` (found by the decision model, ${r.confidence.toFixed(2)})` : ""}`;
    return verdict.pass
      ? { type: "setting", passed: true, status: "pass", message: `${label}: pass (${where} is ${verdict.actual})` }
      : verdict.reason
        ? { type: "setting", passed: false, status: "error", message: `${label}: cannot check: ${verdict.reason} (it is ${verdict.actual}) at ${where}` }
        : { type: "setting", passed: false, status: "fail", message: `${label}: FAIL, actual ${verdict.actual} at ${where}` };
  });
}

async function pageChecks(context: Parameters<Tool["handle"]>[0], tabId: number | undefined, checks: z.infer<typeof AssertCheckSchema>[]): Promise<CheckResult[]> {
  const page = await readPageText(context, tabId);
  const probabilities = await askPage(context, page, checks.map((c) => c.question ?? ""));
  return checks.map((c, i) => {
    const want = (c.expect ?? "true").toLowerCase() !== "false";
    const p = probabilities[i];
    if (!c.question) return { type: "page", passed: false, status: "error", message: "page checks need a question" };
    if (p === undefined) {
      return { type: "page", passed: false, status: "needs_judgment", message: `${c.question}: no decision model answer${context.jev ? "" : " (none configured)"}; judge it from the page text: ${page.text.slice(0, 600)}` };
    }
    const yes = p >= 0.5;
    const sure = p >= 0.7 || p <= 0.3;
    return { type: "page", passed: sure && yes === want, status: sure ? (yes === want ? "pass" : "fail") : "uncertain", message: `${c.question}: ${sure ? (yes ? "yes" : "no") : "uncertain"} (probability ${p.toFixed(2)})` };
  });
}

export const assert: Tool = {
  schema: {
    name: "browser_assert",
    description:
      "Run many checks on the current page in one call. Returns pass/fail per check and does not throw. Check types: url_contains, url_matches, element_visible, element_not_visible, text_contains, text_not_contains, element_count, console_no_errors, title_contains, setting (a control's state or value: {type:'setting', target:'Advantage+ audience', expect:'off'}; the whole page is read, including below the fold, and the state is read by code), page (a yes/no question about the page; needs a decision model, otherwise returns needs_judgment with page text). Use setting checks instead of scrolling and snapshotting to verify forms and settings.",
    inputSchema: zodToJsonSchema(AssertArgs),
  },
  handle: async (context, params) => {
    const validated = AssertArgs.parse(params);
    const { tabId, checks } = validated;
    const domChecks = checks.filter((c) => c.type !== "setting" && c.type !== "page");
    const settings = checks.filter((c) => c.type === "setting");
    const pages = checks.filter((c) => c.type === "page");
    const [dom, settingResults, pageResults] = await Promise.all([
      domChecks.length ? context.sendSocketMessage("browser_assert", { checks: domChecks, ...(tabId !== undefined ? { tabId } : {}) }) as Promise<{ passed: boolean; results: CheckResult[] }> : Promise.resolve({ passed: true, results: [] as CheckResult[] }),
      settings.length ? settingChecks(context, tabId, settings) : Promise.resolve([] as CheckResult[]),
      pages.length ? pageChecks(context, tabId, pages) : Promise.resolve([] as CheckResult[]),
    ]);
    if (settings.length === 0 && pages.length === 0) {
      return { content: [{ type: "text", text: JSON.stringify(dom, null, 2) }] };
    }
    const results = [...dom.results, ...settingResults, ...pageResults];
    const passed = results.every((r) => r.passed);
    const failed = results.filter((r) => !r.passed).length;
    const lines = [`${passed ? "All checks passed" : `${failed} of ${results.length} checks did not pass`}.`, ...results.map((r) => `${r.passed ? "PASS" : (r.status ?? "FAIL").toUpperCase()} ${r.type}: ${r.message}`)];
    return { content: [{ type: "text", text: lines.join("\n") }] };
  },
};
