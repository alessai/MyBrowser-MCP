import { describe, expect, it, vi } from "vitest";
import type { JevAnswer } from "../jev/client.js";
import type { ModelElement } from "./model.js";

vi.mock("../jev/client.js", async (orig) => ({ ...(await orig<typeof import("../jev/client.js")>()), askMany: vi.fn() }));
const { askMany } = await import("../jev/client.js");
const { runGoal } = await import("./run.js");

const el = (n: number, role: string, name: string): ModelElement => ({ n, role, name, section: "", sub: "", row: "", state: "", where: "", disabled: false, selector: `[data-mbo="${n}"]` });
const decider = { provider: "typesafe" as const, apiKey: "k", vision: false, autopilot: true, minConfidence: 0.7, timeoutMs: 3000 };

function harness(elements: ModelElement[], text = "page") {
  const clicks: string[] = [];
  const sendSocketMessage = vi.fn(async (tool: string, p: { code?: string; selector?: string }) => {
    if (tool === "browser_eval") {
      return p.code?.includes("mb-page-model")
        ? { value: { host: "x", url: "/", title: "t", elements, truncated: false, frames: { sameOrigin: 0, crossOrigin: 0 } } }
        : { value: { title: "t", url: "/", text } };
    }
    if (tool === "browser_click") clicks.push(p.selector!);
    return {};
  });
  return { context: { jev: decider, outlineSelectors: new Map(), sendSocketMessage } as never, clicks };
}
const choice = (choice: string, confidence: number, probabilities: Record<string, number> = { [choice]: confidence }): JevAnswer => ({ type: "choice", choice, confidence, probabilities });
const answer = (answers: Record<string, JevAnswer>) => ({ answers, requests: 1, failures: 0, ms: 1 });
const base = { values: {}, allow: ["click", "type", "select", "scroll", "wait"] as const, maxSteps: 10, allowIrreversible: false };

describe("browser_run safety", () => {
  it("never clicks a risky control on its own", async () => {
    const { context, clicks } = harness([el(1, "button", "Place order and pay $49")]);
    vi.mocked(askMany).mockResolvedValue(answer({ op: choice("click", 0.99), click: choice("o1", 0.99), goal_met: { type: "noul", noul: 0.1 } }));
    const r = await runGoal(context, { ...base, allow: [...base.allow], goal: "buy it" });
    expect(r.outcome).toBe("needs_agent");
    expect(r.reason).toMatch(/may pay, send, submit or delete/);
    expect(clicks).toEqual([]);
  });

  it("calls a run done only when the step and the goal check agree", async () => {
    const { context } = harness([el(1, "button", "Next")]);
    vi.mocked(askMany).mockResolvedValueOnce(answer({ op: choice("done", 0.95), goal_met: { type: "noul", noul: 0.4 } }));
    expect((await runGoal(context, { ...base, allow: [...base.allow], goal: "g" })).outcome).toBe("needs_agent");
    vi.mocked(askMany).mockResolvedValueOnce(answer({ op: choice("done", 0.95), goal_met: { type: "noul", noul: 0.9 } }));
    expect((await runGoal(context, { ...base, allow: [...base.allow], goal: "g" })).outcome).toBe("done");
  });

  it("stops instead of repeating a click that changed nothing", async () => {
    const { context, clicks } = harness([el(1, "button", "Refresh")]);
    vi.mocked(askMany).mockResolvedValue(answer({ op: choice("click", 0.95), click: choice("o1", 0.95), goal_met: { type: "noul", noul: 0.1 } }));
    const r = await runGoal(context, { ...base, allow: [...base.allow], goal: "g" });
    expect(clicks).toHaveLength(1);
    expect(r.outcome).toBe("needs_agent");
    expect(r.reason).toMatch(/changed nothing last time/);
  });

  it("hands back when the decision model fails", async () => {
    const { context } = harness([el(1, "button", "Next")]);
    vi.mocked(askMany).mockResolvedValueOnce({ answers: {}, requests: 1, failures: 1, ms: 1 });
    expect((await runGoal(context, { ...base, allow: [...base.allow], goal: "g" })).outcome).toBe("needs_agent");
  });
});
