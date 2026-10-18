import { afterEach, describe, expect, it, vi } from "vitest";
import type { Context } from "../context.js";
import type { JevConfig } from "./config.js";
import type { JevRequest, JevResponse } from "./client.js";
import { VERIFY_MARKER } from "./page.js";
import { isTargetResolutionError, resolveTargetWithJev } from "./resolve.js";

const config: JevConfig = { apiKey: "k", vision: false, minConfidence: 0.7, timeoutMs: 3000 };
const page = {
  url: "https://github.com/alessai/MyBrowser-MCP",
  title: "MyBrowser-MCP",
  elements: [
    { role: "link", name: "Issues", region: "nav", href: "/alessai/MyBrowser-MCP/issues", selector: "#issues-tab" },
    { role: "button", name: "Star alessai/MyBrowser-MCP", region: "header", href: "", selector: "div > button:nth-of-type(3)" },
  ],
};

function contextWith(value: unknown = page, verified: unknown = { ok: true }) {
  const sendSocketMessage = vi.fn(async (_kind: string, payload: { code: string }) => (
    { value: payload.code.startsWith(VERIFY_MARKER) ? verified : value }
  ));
  return { context: { sendSocketMessage } as unknown as Context, sendSocketMessage };
}

afterEach(() => vi.restoreAllMocks());

function answering(choice: string, confidence: number, probabilities: Record<string, number> = {}) {
  return vi.fn(async (_config: JevConfig, _request: JevRequest): Promise<JevResponse> => ({
    model: "jev-1.13.0", ms: 300,
    answers: { target: { type: "choice", choice, confidence, probabilities } },
  }));
}

describe("isTargetResolutionError", () => {
  it.each([
    "Empty descriptor: at least one of ref, mark, selector, role, label, text, or near must be provided.",
    "No element targeting params provided. Use ref, mark, selector, role, name, text, or label.",
    "No element found matching {role: 'button', name: 'Sign in'}.",
    "No element found with text 'Sign in'.",
    "No form element found with label matching {label: 'Email'}.",
    "No visible element found for selector '#gone'.",
    "Error: Element with ref 'e42' not found or not visible. Please regenerate an aria snapshot and use a current ref.",
  ])("treats a pre-action resolver failure as retryable: %s", (message) => {
    expect(isTargetResolutionError(new Error(message))).toBe(true);
  });

  it.each(["CLICK_OUTCOME_UNKNOWN", "Browser response timeout", "TYPE_OUTCOME_UNKNOWN"])(
    "never retries an action whose outcome is unknown: %s",
    (message) => {
      expect(isTargetResolutionError(new Error(message))).toBe(false);
    },
  );
});

describe("resolveTargetWithJev", () => {
  it("returns the chosen element's selector when Jev is confident", async () => {
    const { context, sendSocketMessage } = contextWith();
    const ask = answering("e1", 0.93);
    const result = await resolveTargetWithJev(context, config, { element: "star this repository" }, 7, ask);
    expect(result).toEqual({
      kind: "resolved",
      selector: "div > button:nth-of-type(3)",
      description: 'button "Star alessai/MyBrowser-MCP" in header',
      confidence: 0.93,
    });
    expect(sendSocketMessage).toHaveBeenCalledWith("browser_eval", expect.objectContaining({ tabId: 7 }), { timeoutMs: 3000 });
    const request = ask.mock.calls[0]![1];
    const question = request.questions.target!;
    expect(question.type).toBe("choice");
    expect(question.instructions).toContain("star this repository");
    expect((question as { criteria: Record<string, string> }).criteria).toMatchObject({
      e0: 'link "Issues" in nav -> /alessai/MyBrowser-MCP/issues',
      none: expect.any(String),
    });
  });

  it("frames the agent's failed literal hints as a failed search, not a requirement", async () => {
    const { context } = contextWith();
    const ask = answering("e0", 0.9);
    await resolveTargetWithJev(context, config, { element: "the issues tab", role: "tab", matchText: "Bugs" }, undefined, ask);
    expect(ask.mock.calls[0]![1].questions.target!.instructions).toContain(
      '"the issues tab. The agent also searched for role tab, text "Bugs", which did not match any element exactly"',
    );
  });

  it("does not act below the confidence threshold but hands back its best guess", async () => {
    const { context } = contextWith();
    const result = await resolveTargetWithJev(
      context, config, { element: "issues", name: "Issue tracker" }, undefined,
      answering("e0", 0.55, { e0: 0.55, e1: 0.1, none: 0.35 }),
    );
    expect(result.kind).toBe("unresolved");
    expect(result.kind === "unresolved" && result.hint).toContain('link "Issues" in nav');
    expect(result.kind === "unresolved" && result.hint).toContain("#issues-tab");
  });

  it("reports nothing when Jev says no element matches", async () => {
    const { context } = contextWith();
    const result = await resolveTargetWithJev(
      context, config, { element: "add to cart" }, undefined,
      answering("none", 0.97, { none: 0.97, e0: 0.02, e1: 0.01 }),
    );
    expect(result).toEqual({ kind: "unresolved" });
  });

  it("describes unnamed fields by their row text", async () => {
    const elements = [
      { role: "textbox", name: "", near: "username:", region: "form", href: "", selector: "#u" },
      { role: "textbox", name: "", near: "password:", region: "form", href: "", selector: "#p" },
    ];
    const { context } = contextWith({ ...page, elements });
    const ask = answering("e1", 0.9);
    const result = await resolveTargetWithJev(context, config, { element: "the password box" }, undefined, ask);
    const criteria = (ask.mock.calls[0]![1].questions.target as { criteria: Record<string, string> }).criteria;
    expect(criteria.e0).toBe('textbox "(no text)" near "username:" in form');
    expect(result).toMatchObject({ kind: "resolved", selector: "#p" });
  });

  it("does not act when the chosen element changed after the page was read", async () => {
    const { context, sendSocketMessage } = contextWith(page, { ok: false, reason: "a different element is now at that position" });
    const result = await resolveTargetWithJev(context, config, { element: "star this repository" }, 7, answering("e1", 0.95));
    expect(result).toEqual({
      kind: "unresolved",
      hint: 'Jev chose button "Star alessai/MyBrowser-MCP" in header but did not act: a different element is now at that position since the page was read.',
    });
    const verify = sendSocketMessage.mock.calls.find(([, payload]) => payload.code.startsWith(VERIFY_MARKER));
    expect(verify![1].code).toContain(JSON.stringify("div > button:nth-of-type(3)"));
    expect(verify![1].code).toContain(JSON.stringify("Star alessai/MyBrowser-MCP"));
  });

  it("bounds the whole fallback by jev.timeoutMs", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const sendSocketMessage = vi.fn(async (_kind: string, payload: { code: string }, _options?: { timeoutMs: number }) => {
      if (payload.code.startsWith(VERIFY_MARKER)) return { value: { ok: true } };
      now += 1_000; // the page read takes 1s of the 3s budget
      return { value: page };
    });
    const context = { sendSocketMessage } as unknown as Context;
    const ask = answering("e1", 0.93);
    await resolveTargetWithJev(context, config, { element: "star" }, undefined, ask);
    expect(sendSocketMessage.mock.calls[0]![1]).toMatchObject({ timeout: 3000 });
    expect(sendSocketMessage.mock.calls[0]![2]).toEqual({ timeoutMs: 3000 });
    expect(ask.mock.calls[0]![0].timeoutMs).toBe(2000);

    now += 5_000; // the next fallback's page read alone exceeds the budget
    sendSocketMessage.mockImplementation(async () => { now += 3_000; return { value: page }; });
    await expect(resolveTargetWithJev(context, config, { element: "star" }, undefined, ask)).rejects.toThrow("JEV_DEADLINE");
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("caps very large pages at the Choice option limit", async () => {
    const elements = Array.from({ length: 400 }, (_, i) => ({ role: "link", name: `Item ${i}`, region: "", href: "", selector: `#i${i}` }));
    elements[350] = { role: "button", name: "Checkout now", region: "", href: "", selector: "#checkout" };
    const { context } = contextWith({ ...page, elements });
    const ask = answering("e0", 0.9);
    await resolveTargetWithJev(context, config, { element: "the checkout button" }, undefined, ask);
    const criteria = (ask.mock.calls[0]![1].questions.target as { criteria: Record<string, string> }).criteria;
    expect(Object.keys(criteria)).toHaveLength(255);
    expect(Object.values(criteria)).toContain('button "Checkout now"');
  });
});
