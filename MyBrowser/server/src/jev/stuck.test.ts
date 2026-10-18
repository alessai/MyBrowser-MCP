import { describe, expect, it, vi } from "vitest";
import type { Context } from "../context.js";
import type { JevRequest, JevResponse } from "./client.js";
import type { JevConfig } from "./config.js";
import { diagnoseRepeatedFailure, noteTargetedSuccess } from "./stuck.js";

const config: JevConfig = { apiKey: "k", vision: false, minConfidence: 0.7, timeoutMs: 3000 };
const page = {
  url: "/news",
  title: "News",
  text: "We use cookies. Accept all",
  elements: [{ role: "button", name: "Accept all", region: "dialog", href: "", selector: "#accept" }],
};

function setup(choice = "overlay", confidence = 0.88) {
  let clock = 1_000_000;
  const sendSocketMessage = vi.fn(async () => ({ value: page }));
  const context = { sendSocketMessage } as unknown as Context;
  const ask = vi.fn(async (_c: JevConfig, _r: JevRequest): Promise<JevResponse> => ({
    model: "jev-1.13.0", ms: 300, answers: { cause: { type: "choice", choice, confidence, probabilities: { [choice]: confidence } } },
  }));
  const diagnose = (tabId?: number) => diagnoseRepeatedFailure(context, config, tabId, ask, () => clock);
  return { context, ask, sendSocketMessage, diagnose, advance: (ms: number) => { clock += ms; } };
}

describe("diagnoseRepeatedFailure", () => {
  it("stays silent on a first failure and reads nothing", async () => {
    const { diagnose, ask, sendSocketMessage } = setup();
    expect(await diagnose(5)).toBeUndefined();
    expect(sendSocketMessage).not.toHaveBeenCalled();
    expect(ask).not.toHaveBeenCalled();
  });

  it("explains what blocks the page when the same tab fails again", async () => {
    const { diagnose, ask, advance } = setup();
    await diagnose(5);
    advance(10_000);
    expect(await diagnose(5)).toBe(
      "Page check after repeated failures (confidence 0.88): a popup, dialog, or cookie banner seems to be covering the page; deal with it first.",
    );
    const request = ask.mock.calls[0]![1];
    expect(request.state).toMatchObject({ visible_text: "We use cookies. Accept all", interactive_elements: ['button "Accept all" in dialog'] });
    expect(Object.keys((request.questions.cause as { criteria: Record<string, string> }).criteria))
      .toEqual(["overlay", "login", "captcha", "loading", "error", "none"]);
  });

  it("does not link failures on different tabs, far apart, or with a success between them", async () => {
    const { context, diagnose, advance, ask } = setup();
    await diagnose(5);
    expect(await diagnose(6)).toBeUndefined();
    advance(121_000);
    expect(await diagnose(5)).toBeUndefined();
    noteTargetedSuccess(context, 5);
    expect(await diagnose(5)).toBeUndefined();
    expect(ask).not.toHaveBeenCalled();
  });

  it("does not say the target is missing when the fallback just offered a candidate", async () => {
    const { context, ask } = setup("none", 0.95);
    let clock = 0;
    const run = (hadCandidate: boolean) => diagnoseRepeatedFailure(context, config, 1, ask, () => (clock += 1000), { hadCandidate });
    await run(true);
    expect(await run(true)).toBeUndefined();
    expect(await run(false)).toMatch(/target is probably not on it/);
  });

  it("says nothing when Jev is unsure or unreachable", async () => {
    const unsure = setup("overlay", 0.4);
    await unsure.diagnose();
    expect(await unsure.diagnose()).toBeUndefined();

    const down = setup();
    down.ask.mockRejectedValue(new Error("JEV_HTTP_503"));
    await down.diagnose();
    expect(await down.diagnose()).toBeUndefined();
  });
});
