import { afterEach, describe, expect, it, vi } from "vitest";
import type { Context } from "../context.js";
import type { JevConfig } from "../jev/config.js";
import { check } from "./check.js";

const config: JevConfig = { apiKey: "apikey_test", vision: false, minConfidence: 0.7, timeoutMs: 3000 };
const page = {
  url: "https://example.com/account",
  title: "Account",
  text: "Welcome back, Saif. Plan: Pro",
  elements: [{ role: "button", name: "Sign out", region: "header", href: "", selector: "#out" }],
};

function contextWith(jev: JevConfig | undefined) {
  const sendSocketMessage = vi.fn(async (kind: string) => {
    if (kind === "browser_eval") return { value: page };
    if (kind === "browser_screenshot") return "iVBORw0KGgo=";
    throw new Error(`unexpected ${kind}`);
  });
  return { context: { sendSocketMessage, jev } as unknown as Context, sendSocketMessage };
}

function respond(answer: unknown, model = "jev-1.13.0") {
  return vi.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ model, answers: { answer } }) }));
}

const sentBody = (fetchMock: ReturnType<typeof vi.fn>) =>
  JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));

afterEach(() => vi.unstubAllGlobals());

describe("browser_check", () => {
  it("answers a yes/no question with a probability", async () => {
    const fetchMock = respond({ type: "noul", noul: 0.96 });
    vi.stubGlobal("fetch", fetchMock);
    const { context } = contextWith(config);
    const result = await check.handle(context, { question: "Is the user signed in?" });
    expect((result.content[0] as { text: string }).text).toMatch(/^YES — probability of yes: 0\.96\n\(jev-1\.13\.0, \d+ms\)$/);
    const body = sentBody(fetchMock);
    expect(body.questions.answer).toEqual({ type: "noul", instructions: "Is the user signed in?" });
    expect(body.state).toMatchObject({
      visible_text: "Welcome back, Saif. Plan: Pro",
      interactive_elements: ['button "Sign out" in header'],
    });
    expect(body.assets).toBeUndefined();
  });

  it("maps a multiple-choice answer back to the agent's option text", async () => {
    const fetchMock = respond({ type: "choice", choice: "o2", confidence: 0.88, probabilities: { o1: 0.1, o2: 0.88, o3: 0.02, none: 0 } });
    vi.stubGlobal("fetch", fetchMock);
    const { context } = contextWith(config);
    const result = await check.handle(context, { question: "Which plan is active?", options: ["Free", "Pro", "Team"] });
    expect((result.content[0] as { text: string }).text)
      .toContain('Answer: "Pro" (confidence 0.88). Probabilities — Free: 0.10, Pro: 0.88, Team: 0.02, none of these: 0.00');
    expect(sentBody(fetchMock).questions.answer.criteria).toEqual({
      o1: "Free", o2: "Pro", o3: "Team", none: "None of the listed answers applies",
    });
  });

  it("can answer that none of the agent's options applies", async () => {
    vi.stubGlobal("fetch", respond({ type: "choice", choice: "none", confidence: 0.91, probabilities: { o1: 0.05, o2: 0.04, none: 0.91 } }));
    const { context } = contextWith(config);
    const result = await check.handle(context, { question: "Which plan is active?", options: ["Free", "Team"] });
    expect((result.content[0] as { text: string }).text).toMatch(/^Answer: none of the options applies \(confidence 0\.91\)/);
  });

  it("marks a low-confidence choice as uncertain", async () => {
    vi.stubGlobal("fetch", respond({ type: "choice", choice: "o1", confidence: 0.45, probabilities: { o1: 0.45, o2: 0.4, none: 0.15 } }));
    const { context } = contextWith(config);
    const result = await check.handle(context, { question: "Which plan is active?", options: ["Free", "Team"] });
    expect((result.content[0] as { text: string }).text).toMatch(/^UNCERTAIN — leaning: "Free" \(confidence 0\.45\)/);
  });

  it("refuses screenshots unless vision is enabled", async () => {
    const fetchMock = respond({ type: "noul", noul: 0.5 });
    vi.stubGlobal("fetch", fetchMock);
    const { context, sendSocketMessage } = contextWith(config);
    await expect(check.handle(context, { question: "Is the chart red?", visual: true })).rejects.toThrow(/jev\.vision/);
    expect(sendSocketMessage).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the screenshot as an image asset to the vision model when enabled", async () => {
    const fetchMock = respond({ type: "noul", noul: 0.1 }, "jev-1.14.0");
    vi.stubGlobal("fetch", fetchMock);
    const { context } = contextWith({ ...config, vision: true });
    const result = await check.handle(context, { question: "Is the chart red?", visual: true, tabId: 3 });
    expect((result.content[0] as { text: string }).text).toContain("NO — probability of yes: 0.10");
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)["TypeSafe-Danger-Zone-Images"]).toBe("true");
    const body = sentBody(fetchMock);
    expect(body.model).toBe("jev-1.14.0");
    const ref = body.state.screenshot as string;
    expect(body.assets[ref]).toEqual({ type: "image", format: "png", data_base64: "iVBORw0KGgo=" });
  });

  it("explains how to enable it when no key is configured", async () => {
    const { context } = contextWith(undefined);
    await expect(check.handle(context, { question: "Is it loaded?" })).rejects.toThrow(/jev section/);
  });
});
