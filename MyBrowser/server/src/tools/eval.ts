import { z } from "zod";
import { zodToJsonSchema } from "../utils/json-schema.js";
import { FRAME_DESCRIPTION } from "../utils/aria-snapshot.js";
import type { Tool } from "./types.js";

const EvalArgs = z.object({
  tabId: z.number().optional().describe("Target tab ID. If omitted, uses this session's current tab (opened with new_tab or browser_navigate, or chosen with select_tab), never the user's active tab."),
  // Optional in the published schema so {expression} / {function} reach the
  // server and are rewritten (tools/arg-aliases.ts); required in practice.
  code: z.string().optional().describe("JavaScript to run in the page (required). The value of the last expression is returned; promises are awaited. E.g. \"document.title\" or \"mb.rows('table')\"."),
  timeout: z.number().optional().describe("Timeout in milliseconds (default 5000; 15000 when the code uses mb.waitFor or mb.sleep)"),
  frame: z.string().optional().describe(`${FRAME_DESCRIPTION} Inside a frame the code runs as a page script, so pages that forbid eval refuse it.`),
});

// Read-only helpers, defined only when the code mentions `mb.` and only if the
// page has no `mb` of its own (then they stay reachable as __mb). They never
// click or type: mutating actions go through the tools, which check targets.
/* c8 ignore start */
const HELPERS = `var __mb = (typeof __mb !== "undefined" && __mb && __mb.__mybrowser) ? __mb : {
  __mybrowser: true,
  q: (s, root) => (root || document).querySelector(s),
  qa: (s, root) => Array.from((root || document).querySelectorAll(s)),
  text: (s) => { const el = s ? document.querySelector(s) : document.body; return el ? el.innerText.replace(/[ \\t]+\\n/g, "\\n").replace(/\\n{3,}/g, "\\n\\n").trim() : null; },
  texts: (s) => Array.from(document.querySelectorAll(s)).map((e) => e.innerText.trim()),
  attr: (s, name) => Array.from(document.querySelectorAll(s)).map((e) => e.getAttribute(name)),
  count: (s) => document.querySelectorAll(s).length,
  rows: (s) => { const t = document.querySelector(s || "table"); if (!t) return []; return Array.from(t.querySelectorAll("tr")).map((r) => Array.from(r.querySelectorAll("th,td")).map((c) => c.innerText.trim())); },
  links: (s) => Array.from(document.querySelectorAll(s || "a[href]")).map((a) => ({ text: a.innerText.trim(), href: a.href })),
  visible: (s) => { const e = document.querySelector(s); if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== "hidden"; },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  waitFor: async (test, ms) => {
    const limit = ms || 10000; const t0 = Date.now();
    const check = typeof test === "function" ? test
      : /^[#.[]|^[a-z][a-z0-9-]*[#.[:]|\\s>\\s/i.test(test) ? () => document.querySelector(test)
      : () => (document.body && document.body.innerText.includes(test)) || null;
    for (;;) {
      const v = await check();
      if (v) return v;
      if (Date.now() - t0 > limit) throw new Error("mb.waitFor timed out after " + limit + " ms");
      await new Promise((r) => setTimeout(r, 200));
    }
  },
};
if (typeof mb === "undefined" || (mb && mb.__mybrowser)) { var mb = __mb; }
`;
/* c8 ignore stop */

const USES_HELPERS = /\bmb\.\w/;
const WAITS = /\bmb\.(waitFor|sleep)\b/;

/** Prepends the helpers when the code uses them; otherwise the code is sent unchanged. */
export function withHelpers(code: string): string {
  return USES_HELPERS.test(code) ? `${HELPERS}\n${code}` : code;
}

export const browserEval: Tool = {
  schema: {
    name: "browser_eval",
    description:
      "Run JavaScript in the page (CDP Runtime.evaluate) and return the value of the last expression; promises are awaited. "
      + "Read-only helpers are available as mb: mb.text(sel?), mb.texts(sel), mb.rows(tableSel?) -> [[cell...]], mb.links(sel?), mb.attr(sel, name), "
      + "mb.count(sel), mb.visible(sel), mb.q/qa(sel), mb.waitFor(selectorOrTextOrFn, ms?) and mb.sleep(ms). "
      + "Use one call for a whole loop (e.g. read every page of a list) instead of one call per step. "
      + "To click or type, use the tools so targets are checked. E.g. {code: \"mb.rows('table.results')\"}.",
    inputSchema: zodToJsonSchema(EvalArgs),
  },
  handle: async (context, params) => {
    const validated = EvalArgs.parse(params);
    if (!validated.code) throw new Error("browser_eval needs code, e.g. {code: \"document.title\"}");
    const { tabId, code, ...rest } = validated;
    const timeout = rest.timeout ?? (WAITS.test(code) ? 15_000 : 5_000);
    const payload: Record<string, unknown> = { ...rest, code: withHelpers(code), timeout, ...(tabId !== undefined ? { tabId } : {}) };
    const result = await context.sendSocketMessage("browser_eval", payload, { timeoutMs: Math.max(30_000, timeout + 10_000) });
    return {
      content: [
        {
          type: "text",
          text: typeof result === "string" ? result : JSON.stringify(result, null, 2),
        },
      ],
    };
  },
};
