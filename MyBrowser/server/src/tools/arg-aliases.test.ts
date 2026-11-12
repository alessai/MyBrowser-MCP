import { describe, expect, it } from "vitest";
import { normalizeArguments } from "./arg-aliases.js";

const n = (tool: string, args: unknown, prefix: "e" | "o" = "e") => normalizeArguments(tool, args, prefix);

describe("argument aliases", () => {
  it("rewrites the shapes seen in failed calls", () => {
    expect(n("browser_wait", { ms: 6000 }).args).toEqual({ time: 6 });
    expect(n("browser_wait", { seconds: 2 }).args).toEqual({ time: 2 });
    expect(n("browser_eval", { expression: "document.title" }).args).toEqual({ code: "document.title" });
    expect(n("browser_eval", { function: "() => document.title" }).args).toEqual({ code: "(() => document.title)()" });
    expect(n("select_browser", { browser: "b3" }).args).toEqual({ browserId: "b3" });
    expect(n("browser_click", { ref: 44 }).args).toEqual({ ref: "e44" });
    expect(n("browser_click", { ref: "12" }, "o").args).toEqual({ ref: "o12" });
  });

  it("maps Playwright-style browser_wait_for shapes", () => {
    expect(n("browser_wait_for", { text: "Saved" }).args).toEqual({ condition: "text_visible", value: "Saved" });
    expect(n("browser_wait_for", { textGone: "Loading" }).args).toEqual({ condition: "text_not_visible", value: "Loading" });
    expect(n("browser_wait_for", { condition: "el_exists", selector: ".done" }).args).toEqual({ condition: "element_visible", selector: ".done" });
    expect(n("browser_wait_for", { condition: "text_visible:Apple" }).args).toEqual({ condition: "text_visible", value: "Apple" });
    expect(n("browser_wait_for", { condition: "the results have loaded" }).args).toEqual({ until: "the results have loaded" });
    expect(n("browser_wait_for", { text: "Saved", time: 5 }).args).toEqual({ condition: "text_visible", value: "Saved", timeout: 5000 });
    // A lone time is a plain wait; the tool handles it.
    expect(n("browser_wait_for", { time: 3 }).args).toEqual({ time: 3 });
  });

  it("sorts target into ref, selector or description", () => {
    expect(n("browser_click", { target: "o7" }).args).toEqual({ ref: "o7" });
    expect(n("browser_click", { target: "#save" }).args).toEqual({ selector: "#save" });
    expect(n("browser_click", { target: "button.primary" }).args).toEqual({ selector: "button.primary" });
    expect(n("browser_click", { target: "the Save button" }).args).toEqual({ element: "the Save button" });
  });

  it("keeps click text as text to match, type text as text to type", () => {
    expect(n("browser_click", { text: "Save" }).args).toEqual({ matchText: "Save" });
    expect(n("browser_type", { ref: "e3", text: "hi" }).args).toEqual({ ref: "e3", text: "hi" });
    expect(n("browser_type", { ref: "e3", value: "hi" }).args).toEqual({ ref: "e3", text: "hi" });
  });

  it("normalizes browser_action steps", () => {
    const { args } = n("browser_action", { steps: [
      { action: "wait", ms: 500 },
      { action: "type", ref: "e2", text: "hello" },
      { action: "wait_for", condition: "text_visible:Done" },
    ] });
    expect(args).toEqual({ steps: [
      { action: "wait", time: 0.5 },
      { action: "type", ref: "e2", typedText: "hello" },
      { action: "wait_for", condition: "text_visible", value: "Done" },
    ] });
  });

  it("never overrides a canonical field and says what it accepted", () => {
    expect(n("browser_wait", { time: 2, ms: 9000 }).args).toEqual({ time: 2, ms: 9000 });
    expect(n("browser_wait", { time: 2 }).note).toBe("");
    expect(n("browser_wait", { ms: 2000 }).note).toBe("(Accepted ms as time.)");
    expect(n("unknown_tool", "raw").args).toBe("raw");
  });
});
