import { afterEach, describe, expect, it, vi } from "vitest";
import type { Context } from "../context.js";
import type { JevConfig } from "../jev/config.js";
import { VERIFY_MARKER } from "../jev/page.js";
import { click, type } from "./input.js";

const config: JevConfig = { apiKey: "apikey_test", vision: false, minConfidence: 0.7, timeoutMs: 3000 };
const page = {
  url: "https://example.com/login",
  title: "Login",
  elements: [
    { role: "link", name: "Help", region: "nav", href: "/help", selector: "#help" },
    { role: "button", name: "Sign in", region: "form", href: "", selector: "form > button" },
  ],
};

function jevAnswer(choice: string, confidence: number) {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      model: "jev-1.13.0",
      answers: { target: { type: "choice", choice, confidence, probabilities: { [choice]: confidence } } },
    }),
  }));
}

function contextFor(firstError: Error | undefined, jev: JevConfig | undefined = config, verified: unknown = { ok: true }) {
  let attempts = 0;
  const sendSocketMessage = vi.fn(async (kind: string, payload?: unknown) => {
    if (kind === "browser_click" || kind === "browser_type") {
      attempts += 1;
      if (attempts === 1 && firstError) throw firstError;
      return undefined;
    }
    if (kind === "browser_eval") {
      return { value: String((payload as { code: string }).code).startsWith(VERIFY_MARKER) ? verified : page };
    }
    if (kind === "browser_snapshot") return "- button \"Sign in\" [ref=e1]";
    return "value";
  });
  return { context: { sendSocketMessage, jev } as unknown as Context, sendSocketMessage };
}

const actionCalls = (mock: ReturnType<typeof vi.fn>, kind: string) =>
  mock.mock.calls.filter(([k]) => k === kind).map(([, payload]) => payload as Record<string, unknown>);

afterEach(() => vi.unstubAllGlobals());

describe("Jev element-resolution fallback", () => {
  it("resolves a failed target with Jev and acts exactly once on the chosen element", async () => {
    const fetchMock = jevAnswer("e1", 0.93);
    vi.stubGlobal("fetch", fetchMock);
    const { context, sendSocketMessage } = contextFor(new Error("Empty descriptor: at least one of ref, mark, selector, role, label, text, or near must be provided."));

    const result = await click.handle(context, { element: "Sign in button", name: "Sign in", tabId: 4 });

    const clicks = actionCalls(sendSocketMessage, "browser_click");
    expect(clicks).toHaveLength(2);
    expect(clicks[1]).toEqual({ element: "Sign in button", selector: "form > button", tabId: 4 });
    expect(result.content[0]).toEqual({
      type: "text",
      text: 'Clicked "Sign in button" (resolved by Jev to button "Sign in" in form, confidence 0.93)',
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer apikey_test");
    expect(JSON.parse(String(init.body)).model).toBe("jev-1.13.0");
  });

  it("keeps the agent's non-target arguments on the retried action", async () => {
    vi.stubGlobal("fetch", jevAnswer("e1", 0.9));
    const { context, sendSocketMessage } = contextFor(new Error("No element found with text 'Sign in'."));
    await type.handle(context, { element: "sign in", matchText: "Sign in", text: "hello", submit: true });
    expect(actionCalls(sendSocketMessage, "browser_type")[1]).toEqual({
      element: "sign in", text: "hello", submit: true, selector: "form > button",
    });
  });

  it("does not consult Jev when the original target works", async () => {
    const fetchMock = jevAnswer("e1", 0.9);
    vi.stubGlobal("fetch", fetchMock);
    const { context, sendSocketMessage } = contextFor(undefined);
    await click.handle(context, { element: "Sign in", role: "button", name: "Sign in" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(actionCalls(sendSocketMessage, "browser_click")).toHaveLength(1);
  });

  it("never retries when the first action's outcome is unknown", async () => {
    const fetchMock = jevAnswer("e1", 0.99);
    vi.stubGlobal("fetch", fetchMock);
    const { context, sendSocketMessage } = contextFor(new Error("CLICK_OUTCOME_UNKNOWN"));
    await expect(click.handle(context, { element: "Sign in", name: "Sign in" })).rejects.toThrow("CLICK_OUTCOME_UNKNOWN");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(actionCalls(sendSocketMessage, "browser_click")).toHaveLength(1);
  });

  it("returns the original error when Jev is not configured", async () => {
    const { context, sendSocketMessage } = contextFor(new Error("No element found with text 'x'."), undefined);
    await expect(click.handle(context, { element: "x", matchText: "x" })).rejects.toThrow("No element found with text 'x'.");
    expect(actionCalls(sendSocketMessage, "browser_click")).toHaveLength(1);
  });

  it("fails open to the original error when TypeSafe is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    const { context, sendSocketMessage } = contextFor(new Error("No element found with text 'Sign in'."));
    await expect(click.handle(context, { element: "Sign in", matchText: "Sign in" })).rejects.toThrow("No element found with text 'Sign in'.");
    expect(actionCalls(sendSocketMessage, "browser_click")).toHaveLength(1);
  });

  it("does not act when the page changed between the read and the retry", async () => {
    vi.stubGlobal("fetch", jevAnswer("e1", 0.95));
    const { context, sendSocketMessage } = contextFor(
      new Error("No element found with text 'Sign in'."), config, { ok: false, reason: "the page URL changed" },
    );
    await expect(click.handle(context, { element: "Sign in", matchText: "Sign in" }))
      .rejects.toThrow("No element found with text 'Sign in'. Jev chose button \"Sign in\" in form but did not act: the page URL changed since the page was read.");
    expect(actionCalls(sendSocketMessage, "browser_click")).toHaveLength(1);
  });

  it("adds advice about what blocks the page when the same tab fails twice", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const questions = JSON.parse(String(init.body)).questions as Record<string, unknown>;
      const answers = questions.cause
        ? { cause: { type: "choice", choice: "login", confidence: 0.9, probabilities: { login: 0.9 } } }
        : { target: { type: "choice", choice: "none", confidence: 0.95, probabilities: { none: 0.95 } } };
      return { ok: true, status: 200, text: async () => JSON.stringify({ model: "jev-1.13.0", answers }) };
    }));
    const sendSocketMessage = vi.fn(async (kind: string) => {
      if (kind === "browser_click") throw new Error("No element found with text 'Inbox'.");
      return { value: page };
    });
    const context = { sendSocketMessage, jev: config } as unknown as Context;
    await expect(click.handle(context, { element: "Inbox", matchText: "Inbox" })).rejects.toThrow(/^No element found with text 'Inbox'\.$/);
    await expect(click.handle(context, { element: "Inbox", matchText: "Inbox" }))
      .rejects.toThrow("No element found with text 'Inbox'. Page check after repeated failures (confidence 0.90): the page seems to want a sign-in first.");
  });

  it("does not act on a low-confidence answer and says what it would have picked", async () => {
    vi.stubGlobal("fetch", jevAnswer("e1", 0.5));
    const { context, sendSocketMessage } = contextFor(new Error("No element found with text 'Login'."));
    await expect(click.handle(context, { element: "Login", matchText: "Login" }))
      .rejects.toThrow(/No element found with text 'Login'\. Jev's best guess \(probability 0\.50, answer confidence 0\.50; acts only at confidence >= 0\.7\).*form > button/);
    expect(actionCalls(sendSocketMessage, "browser_click")).toHaveLength(1);
  });
});
