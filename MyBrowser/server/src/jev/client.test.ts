import { describe, expect, it, vi } from "vitest";
import { askJev, askMany, type JevQuestion } from "./client.js";
import type { JevConfig } from "./config.js";

const config: JevConfig = { provider: "typesafe", apiKey: "k", vision: false, minConfidence: 0.7, timeoutMs: 3_000 };
const ok = (answers: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify({ model: "jev-1.13.0", answers, usage: { input_tokens: 42 } }) });
const fail = (status: number) => ({ ok: false, status, text: async () => "busy", headers: { get: () => null } });

describe("askJev", () => {
  it("retries a rate limit once the budget allows, then succeeds", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(fail(429)).mockResolvedValueOnce(ok({ q: { type: "noul", noul: 0.9 } }));
    const sleep = vi.fn(async () => {});
    const res = await askJev(config, { state: {}, questions: {} }, fetchImpl, sleep);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(250);
    expect(res.inputTokens).toBe(42);
  });

  it("does not retry a client error", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fail(400));
    await expect(askJev(config, { state: {}, questions: {} }, fetchImpl, async () => {})).rejects.toThrow(/JEV_HTTP_400/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("sends to a local server with its own model and no key", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({}));
    await askJev({ ...config, provider: "local", apiKey: "", url: "http://127.0.0.1:8000/v1/systemone", model: "strands" }, { state: {}, questions: {} }, fetchImpl);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:8000/v1/systemone");
    expect(JSON.parse(init.body).model).toBe("strands");
    expect(init.headers.Authorization).toBeUndefined();
  });
});

describe("askMany", () => {
  it("splits at 20 questions per request and keeps answers from the requests that worked", async () => {
    const questions: Record<string, JevQuestion> = Object.fromEntries(Array.from({ length: 45 }, (_, i) => [`q${i}`, { type: "noul", instructions: `question ${i}` }]));
    let call = 0;
    const ask = vi.fn(async (_c: JevConfig, req: { questions: Record<string, JevQuestion> }) => {
      call += 1;
      if (call === 2) throw new Error("JEV_HTTP_529");
      return { model: "m", ms: 1, answers: Object.fromEntries(Object.keys(req.questions).map((k) => [k, { type: "noul" as const, noul: 1 }])) };
    });
    const res = await askMany(config, { page: "x" }, questions, ask);
    expect(res.requests).toBe(3);
    expect(res.failures).toBe(1);
    expect(Object.keys(res.answers)).toHaveLength(25);
  });
});
