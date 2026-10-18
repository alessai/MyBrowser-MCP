import { afterEach, describe, expect, it, vi } from "vitest";
import type { Context } from "../context.js";
import type { JevConfig } from "../jev/config.js";
import { check, STATE_PRESET } from "./check.js";

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
  return respondAll({ q1: answer }, model);
}

function respondAll(answers: Record<string, unknown>, model = "jev-1.13.0") {
  return vi.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ model, answers }) }));
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
    expect(body.questions).toEqual({ q1: { type: "noul", instructions: "Is the user signed in?" } });
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
    expect(sentBody(fetchMock).questions.q1.criteria).toEqual({
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
    await expect(check.handle(context, { question: "Is it loaded?" })).rejects.toThrow(/mybrowser-mcp jev set-key/);
  });

  it("answers several questions and the state preset in one request", async () => {
    const fetchMock = respondAll({
      q1: { type: "noul", noul: 0.97 },
      q2: { type: "choice", choice: "o1", confidence: 0.9, probabilities: { o1: 0.9, o2: 0.1, none: 0 } },
      q3: { type: "noul", noul: 0.91 },
      q4: { type: "noul", noul: 0.02 },
      q5: { type: "noul", noul: 0.01 },
      q6: { type: "noul", noul: 0.03 },
      q7: { type: "noul", noul: 0.5 },
    });
    vi.stubGlobal("fetch", fetchMock);
    const { context, sendSocketMessage } = contextWith(config);
    const result = await check.handle(context, {
      checks: [{ question: "Is the user signed in?" }, { question: "Which plan?", options: ["Pro", "Free"] }],
      preset: "state",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sendSocketMessage).toHaveBeenCalledTimes(1);
    expect(Object.keys(sentBody(fetchMock).questions)).toEqual(["q1", "q2", "q3", "q4", "q5", "q6", "q7"]);
    expect(sentBody(fetchMock).questions.q3.instructions).toBe(STATE_PRESET[0]!.question);
    expect((result.content[0] as { text: string }).text).toMatch(new RegExp([
      "^1\\. Is the user signed in\\? — YES — probability of yes: 0\\.97",
      '2\\. Which plan\\? — Answer: "Pro" \\(confidence 0\\.90\\)\\. Probabilities — Pro: 0\\.90, Free: 0\\.10, none of these: 0\\.00',
      "3\\. Popup or overlay covering the page — YES — probability of yes: 0\\.91",
      "4\\. Sign-in wall — NO — probability of yes: 0\\.02",
      "5\\. CAPTCHA or human check — NO — probability of yes: 0\\.01",
      "6\\. Error message — NO — probability of yes: 0\\.03",
      "7\\. Still loading — UNCERTAIN — probability of yes: 0\\.50",
      "\\(jev-1\\.13\\.0, \\d+ms\\)$",
    ].join("\n")));
  });

  it("rejects a call with nothing to ask, or options without a question", async () => {
    const { context } = contextWith(config);
    await expect(check.handle(context, {})).rejects.toThrow(/question, checks, or a preset/);
    await expect(check.handle(context, { preset: "state", options: ["a", "b"] })).rejects.toThrow(/options needs a question/);
  });
});
