import { describe, expect, it, vi } from "vitest";
import { compareSetting, pickOption, wantBool } from "./engine.js";
import { fillItems } from "./fill.js";
import type { ModelElement } from "./model.js";

const el = (role: string, state: string, extra: Partial<ModelElement> = {}): ModelElement => ({
  n: 1, role, name: "x", section: "", sub: "", row: "", state, where: "", disabled: false, selector: '[data-mbo="1"]', ...extra,
});

describe("setting checks are judged by code", () => {
  it("reads on/off words", () => {
    expect(wantBool("Checked")).toBe(true);
    expect(wantBool("off")).toBe(false);
    expect(wantBool("Daily budget")).toBeUndefined();
  });

  it("compares toggles, including tri-state", () => {
    expect(compareSetting(el("switch", "on"), "on")).toEqual({ pass: true, actual: "on" });
    expect(compareSetting(el("checkbox", "mixed"), "off")).toEqual({ pass: false, actual: "mixed" });
    expect(compareSetting(el("checkbox", "on"), "Learn more").pass).toBe(false);
  });

  it("treats a selected tab as on and refuses on/off for buttons", () => {
    expect(compareSetting(el("tab", "selected"), "selected")).toEqual({ pass: true, actual: "selected" });
    expect(compareSetting(el("tab", ""), "on")).toEqual({ pass: false, actual: "not selected" });
    expect(compareSetting(el("button", "", { disabled: true }), "off")).toMatchObject({ pass: false, actual: "disabled", reason: "a button has no on/off state" });
  });

  it("compares values case-insensitively, numbers by value, and empty", () => {
    expect(compareSetting(el("combobox", "Daily budget"), "daily budget").pass).toBe(true);
    expect(compareSetting(el("spinbutton", "\"20.00\""), "20").pass).toBe(true);
    expect(compareSetting(el("textbox", "\"AED 20\""), "USD 20").pass).toBe(false);
    expect(compareSetting(el("textbox", "(empty)"), "empty").pass).toBe(true);
    expect(compareSetting(el("textbox", "\"Hook 3 - competitor price\""), "competitor", "contains").pass).toBe(true);
  });
});

describe("option picking", () => {
  const options = ["Learn more", "Sign up", "Get quote"];
  it("uses exact and unique contains matches without a decision model", async () => {
    const context = { jev: undefined } as never;
    expect(await pickOption(context, options, "sign up")).toMatchObject({ option: "Sign up", how: "exact" });
    expect(await pickOption(context, options, "quote")).toMatchObject({ option: "Get quote", how: "contains" });
    expect(await pickOption(context, options, "Get a quote")).toEqual({ how: "no clear match", candidates: options });
  });
});

describe("fill never clicks buttons, links or disabled controls", () => {
  it("blocks them and changes nothing", async () => {
    const elements = [
      el("button", "", { n: 1, name: "Publish" }),
      el("textbox", "(empty)", { n: 2, name: "Budget", disabled: true }),
    ];
    const sendSocketMessage = vi.fn(async (tool: string) => (tool === "browser_eval"
      ? { value: { host: "", url: "/", title: "t", elements, truncated: false, frames: { sameOrigin: 0, crossOrigin: 0 } } }
      : {}));
    const context = { jev: undefined, outlineSelectors: new Map(), sendSocketMessage } as never;
    const { results } = await fillItems(context, undefined, [{ target: "Publish", value: "on" }, { target: "Budget", value: "20" }], false);
    // A button is not a setting: it is handed back (or blocked when picked by ref), never clicked.
    expect(results.map((r) => r.status)).toEqual(["needs_choice", "blocked"]);
    const { results: byRef } = await fillItems(context, undefined, [{ target: "o1", value: "on" }], false);
    expect(byRef[0]!.status).toBe("blocked");
    expect(sendSocketMessage.mock.calls.every((c) => c[0] === "browser_eval")).toBe(true);
  });
});
