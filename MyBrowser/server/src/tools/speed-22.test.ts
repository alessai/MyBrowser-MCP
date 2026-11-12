import { describe, expect, it, vi } from "vitest";
import type { ModelElement, PageModel } from "../page/model.js";
import { rememberOutline } from "../page/refs.js";
import { captureAriaSnapshot } from "../utils/aria-snapshot.js";
import { action } from "./action.js";
import { browserEval, withHelpers } from "./eval.js";
import { click } from "./input.js";
import { wait } from "./navigation.js";
import { waitFor } from "./waitfor.js";

const el = (n: number, role: string, name: string, extra: Partial<ModelElement> = {}): ModelElement => ({
  n, role, name, section: "", sub: "", row: "", state: "", where: "", disabled: false, selector: `[data-mbo="${n}"]`, ...extra,
});
const model = (elements: ModelElement[]): PageModel => ({ host: "", url: "https://x.test/", title: "X", elements, truncated: false, frames: { sameOrigin: 0, crossOrigin: 0 } });

function fakeContext(elements: ModelElement[], onTool?: (tool: string, payload: Record<string, unknown>) => unknown) {
  const sendSocketMessage = vi.fn(async (tool: string, payload: Record<string, unknown> = {}) => {
    const custom = onTool?.(tool, payload);
    if (custom !== undefined) return custom;
    if (tool === "browser_eval") return { value: model(elements) };
    if (tool === "browser_snapshot") return { url: "https://x.test/", title: "X", snapshot: "- button \"Save\" [ref=e1]" };
    return undefined;
  });
  const context = { jev: undefined, outlineSelectors: new Map(), lastRefPrefix: "e", sendSocketMessage } as never;
  return { context, sendSocketMessage };
}
const calls = (mock: ReturnType<typeof vi.fn>, tool: string) => mock.mock.calls.filter(([t]) => t === tool).map(([, p]) => p as Record<string, unknown>);

describe("2.2: clicking by description", () => {
  it("finds the element on the page model by code and clicks its selector once", async () => {
    const { context, sendSocketMessage } = fakeContext([el(1, "link", "Help"), el(2, "button", "Publish")]);
    const result = await click.handle(context, { element: "Publish" });
    expect(calls(sendSocketMessage, "browser_click")).toEqual([{ element: "Publish", selector: '[data-mbo="2"]' }]);
    expect((result.content[0] as { text: string }).text).toBe('Clicked "Publish" (found o2 button "Publish")');
  });

  it("hands back candidates instead of guessing, and clicks nothing", async () => {
    const { context, sendSocketMessage } = fakeContext([el(1, "button", "Save draft"), el(2, "button", "Save and publish")]);
    await expect(click.handle(context, { element: "Save" })).rejects.toThrow(/ambiguous|No element found/);
    expect(calls(sendSocketMessage, "browser_click")).toHaveLength(0);
  });

  it("refuses an outline ref in a collapsed section, naming the control that opens it", async () => {
    const { context, sendSocketMessage } = fakeContext([]);
    rememberOutline(context, undefined, model([
      el(3, "button", "Advanced", { section: "Settings", state: "collapsed" }),
      el(4, "checkbox", "Beta features", { section: "Settings", where: "collapsed" }),
    ]));
    await expect(click.handle(context, { ref: "o4" })).rejects.toThrow(/collapsed section.*click o3/);
    expect(calls(sendSocketMessage, "browser_click")).toHaveLength(0);
  });

  it("uses an outline read without tabId for a later call that names the tab", async () => {
    const { context, sendSocketMessage } = fakeContext([]);
    rememberOutline(context, undefined, model([el(5, "button", "Go", { selector: "my-app >>> button" })]));
    await click.handle(context, { ref: "o5", tabId: 9 });
    expect(calls(sendSocketMessage, "browser_click")[0]).toMatchObject({ selector: "my-app >>> button", tabId: 9 });
  });

  it("finds a re-rendered outline element again by role, name and section", async () => {
    let first = true;
    const { context, sendSocketMessage } = fakeContext([el(9, "button", "Go")], (tool) => {
      if (tool === "browser_click" && first) { first = false; throw new Error("No visible element found for selector [data-mbo=\"5\"]"); }
      return undefined;
    });
    rememberOutline(context, undefined, model([el(5, "button", "Go")]));
    const result = await click.handle(context, { ref: "o5" });
    expect(calls(sendSocketMessage, "browser_click").map((p) => p.selector)).toEqual(['[data-mbo="5"]', '[data-mbo="9"]']);
    expect((result.content[0] as { text: string }).text).toContain("re-rendered; found again as o9");
  });
});

describe("2.2: batches understand outline refs", () => {
  it("rewrites o-refs in browser_action steps to selectors", async () => {
    const { context, sendSocketMessage } = fakeContext([], (tool) => (tool === "browser_action"
      ? { status: "completed", stepsCompleted: 1, totalSteps: 1, results: [{ step: 1, action: "click", status: "success", durationMs: 5 }] }
      : undefined));
    rememberOutline(context, undefined, model([el(7, "button", "Next")]));
    await action.handle(context, { steps: [{ action: "click", ref: "o7" }, { action: "click", ref: "e2" }] });
    expect(calls(sendSocketMessage, "browser_action")[0]!.steps).toEqual([
      { action: "click", selector: '[data-mbo="7"]' },
      { action: "click", ref: "e2" },
    ]);
  });
});

describe("2.2: fewer round trips and waits", () => {
  it("reads URL, title and snapshot in one call, with a fallback for older extensions", async () => {
    const one = fakeContext([]);
    await captureAriaSnapshot(one.context);
    expect(one.sendSocketMessage.mock.calls.map(([t]) => t)).toEqual(["browser_snapshot"]);

    const old = fakeContext([], (tool) => (tool === "browser_snapshot" ? "- button" : tool === "getUrl" ? "https://old/" : tool === "getTitle" ? "Old" : undefined));
    const r = await captureAriaSnapshot(old.context);
    expect(old.sendSocketMessage.mock.calls.map(([t]) => t)).toEqual(["browser_snapshot", "getUrl", "getTitle"]);
    expect((r.content[0] as { text: string }).text).toContain("https://old/");
  });

  it("reports an early settle and accepts a Playwright-style wait_for {time}", async () => {
    const { context, sendSocketMessage } = fakeContext([], (tool) => (tool === "browser_wait" ? { waitedMs: 1200, settled: true } : undefined));
    const r = await wait.handle(context, { time: 5 });
    expect((r.content[0] as { text: string }).text).toBe("Page settled after 1.2 s (waited up to 5 s).");
    await waitFor.handle(context, { time: 2 });
    expect(calls(sendSocketMessage, "browser_wait")[1]).toEqual({ time: 2 });
  });
});

describe("2.2: eval helpers", () => {
  it("adds the read-only helpers only when the code uses them", () => {
    expect(withHelpers("document.title")).toBe("document.title");
    expect(withHelpers("mb.rows('table')")).toContain("var __mb");
    // The helpers must be valid JavaScript and read the page.
    const src = withHelpers("mb.count('p')");
    const fakeDocument = { querySelectorAll: () => [1, 2, 3] };
    expect(new Function("document", `return eval(${JSON.stringify(src)})`)(fakeDocument)).toBe(3);
  });

  it("gives waiting code a longer timeout", async () => {
    const { context, sendSocketMessage } = fakeContext([], () => ({ value: 1 }));
    await browserEval.handle(context, { code: "mb.waitFor('.done')" });
    expect(calls(sendSocketMessage, "browser_eval")[0]!.timeout).toBe(15_000);
  });
});

describe("2.2 review fixes", () => {
  it("a description click does not make bare ref numbers mean outline numbers", async () => {
    const { context } = fakeContext([el(2, "button", "Publish")]);
    await click.handle(context, { element: "Publish" });
    expect((context as { lastRefPrefix: string }).lastRefPrefix).toBe("e");
  });

  it("a failed expect check never turns a done action into an error", async () => {
    const { context } = fakeContext([], (tool, payload) => {
      if (tool === "browser_eval" && String(payload.code).includes("innerText")) throw new Error("Frame was detached");
      return undefined;
    });
    const r = await click.handle(context, { selector: "#pay", expect: "Paid" });
    expect((r.content[0] as { text: string }).text).toMatch(/^Clicked "#pay"\nExpect "Paid": not checked \(the action was done/);
  }, 10_000);
});

describe("2.2: expect on actions", () => {
  it("confirms by exact text without a decision model", async () => {
    const { context } = fakeContext([], (tool, payload) => (tool === "browser_eval" && String(payload.code).includes("innerText")
      ? { value: { title: "X", url: "https://x.test/", text: "Your changes were Saved." } }
      : undefined));
    const r = await click.handle(context, { selector: "#save", expect: "saved" });
    expect((r.content[0] as { text: string }).text).toContain('Expect "saved": confirmed (the text is on the page).');
  });
});
