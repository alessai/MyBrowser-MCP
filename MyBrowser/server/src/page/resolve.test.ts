import { describe, expect, it, vi } from "vitest";
import type { ModelElement, PageModel } from "./model.js";

vi.mock("../jev/client.js", async (orig) => ({ ...(await orig<typeof import("../jev/client.js")>()), askMany: vi.fn() }));
const { askMany } = await import("../jev/client.js");
const { resolveByCode, resolveItems } = await import("./resolve.js");

let next = 1;
const el = (role: string, name: string, extra: Partial<ModelElement> = {}): ModelElement => ({
  n: next++, role, name, section: "", sub: "", row: "", state: "", where: "", disabled: false, selector: "", ...extra,
});
const page = (elements: ModelElement[]): PageModel => ({ host: "example.com", url: "/", title: "t", elements, truncated: false, frames: { sameOrigin: 0, crossOrigin: 0 } });
const decider = { provider: "typesafe" as const, apiKey: "k", vision: false, minConfidence: 0.7, timeoutMs: 3000 };

describe("resolver v2, code tier", () => {
  const budget = el("textbox", "Daily budget", { section: "Budget" });
  const threads = el("checkbox", "Threads", { section: "Placements" });
  const threadsLink = el("link", "Threads", { section: "Footer" });
  const model = page([budget, threads, threadsLink, el("button", "Save")]);

  it("resolves an exact name without a decision model", () => {
    expect(resolveByCode(model, { target: "Daily budget" }).done).toMatchObject({ status: "resolved", element: budget, via: "code" });
  });

  it("uses role words to separate look-alikes", () => {
    expect(resolveByCode(model, { target: "Threads checkbox" }).done).toMatchObject({ element: threads });
    expect(resolveByCode(model, { target: "Threads" }).done).toBeUndefined();
  });

  it("prefers a stateful control for settings when a link has the same name", () => {
    const nav = el("link", "Issues", { section: "Repository" });
    const box = el("checkbox", "Issues", { section: "Features" });
    const m = page([nav, box]);
    expect(resolveByCode(m, { target: "Issues" }).done).toBeUndefined();
    expect(resolveByCode(m, { target: "Issues", stateful: true }).done).toMatchObject({ element: box });
  });

  it("prefers a verified memory over code", () => {
    const memory = { threads: { role: "link", name: "Threads", section: "Footer", sub: "", hits: 2, misses: 0 } };
    expect(resolveByCode(model, { target: "Threads" }, memory).done).toMatchObject({ element: threadsLink, via: "memory" });
  });

  it("hands back candidates when there is no decision model", async () => {
    const { results } = await resolveItems(model, [{ target: "Threads" }]);
    expect(results[0]).toMatchObject({ status: "needs_choice", reason: "more than one element could match" });
    if (results[0]!.status === "needs_choice") expect(results[0]!.candidates.slice(0, 2)).toEqual(expect.arrayContaining([threads, threadsLink]));
  });
});

describe("resolver v2, decision tier", () => {
  const cta = el("combobox", "Call to action");
  const learn = el("button", "Learn more");
  const model = page([cta, learn]);

  it("sends one shared element list and acts only at the confidence floor", async () => {
    vi.mocked(askMany).mockResolvedValueOnce({
      requests: 1, failures: 0, ms: 5,
      answers: {
        q0: { type: "choice", choice: `o${cta.n}`, confidence: 0.92, probabilities: { [`o${cta.n}`]: 0.95 } },
        q1: { type: "choice", choice: `o${learn.n}`, confidence: 0.4, probabilities: { [`o${learn.n}`]: 0.6, [`o${cta.n}`]: 0.4 } },
      },
    });
    const { results } = await resolveItems(model, [{ target: "CTA" }, { target: "the more info thing" }], { decider });
    const [state, questions] = [vi.mocked(askMany).mock.calls[0]![1] as { elements: string[] }, vi.mocked(askMany).mock.calls[0]![2]];
    expect(state.elements).toHaveLength(2);
    expect(Object.values((questions.q0 as { criteria: Record<string, unknown> }).criteria)).toContain(null);
    expect(results[0]).toMatchObject({ status: "resolved", element: cta, via: "decider" });
    expect(results[1]).toMatchObject({ status: "needs_choice" });
  });

  it("falls back to hand-back when the decision model fails", async () => {
    vi.mocked(askMany).mockResolvedValueOnce({ requests: 1, failures: 1, ms: 5, answers: {} });
    const { results } = await resolveItems(model, [{ target: "CTA" }], { decider });
    expect(results[0]).toMatchObject({ status: "needs_choice", reason: "the decision model did not answer" });
  });

  it("reports a confident 'none' as not found", async () => {
    vi.mocked(askMany).mockResolvedValueOnce({ requests: 1, failures: 0, ms: 5, answers: { q0: { type: "choice", choice: "none", confidence: 0.95, probabilities: { none: 0.97 } } } });
    const { results } = await resolveItems(model, [{ target: "Dynamic creative" }], { decider });
    expect(results[0]).toMatchObject({ status: "not_found" });
  });
});
