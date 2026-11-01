import type { JevConfig } from "./config.js";

const API_URL = "https://api.typesafe.ai/v1/systemone";
// Pinned: TypeSafe documents confidence thresholds as version-specific. The
// 0.7 default was measured against these exact versions.
export const TEXT_MODEL = "jev-1.13.0";
export const VISION_MODEL = "jev-1.14.0";

export type JevQuestion =
  | { type: "noul"; instructions: string }
  // A null description means the option's text is already in the state (one
  // shared element list instead of a copy per question; TypeSafe line-search recipe).
  | { type: "choice"; instructions: string; criteria: Record<string, string | null> };

export type JevAnswer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> };

export interface JevRequest {
  state: unknown;
  questions: Record<string, JevQuestion>;
  /** PNG screenshot (base64). Requires config.vision and switches to the vision model. */
  image?: { ref: string; base64: string };
}

export interface JevResponse {
  model: string;
  answers: Record<string, JevAnswer>;
  ms: number;
  inputTokens?: number;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Pick<Response, "ok" | "status" | "text"> & { headers?: Pick<Headers, "get"> }>;

// 429 (rate limit), 529 (overloaded) and 5xx are worth one more try when the
// time budget allows; everything else is final.
const RETRYABLE = (status: number) => status === 429 || status >= 500;
const MAX_ATTEMPTS = 3;

function modelFor(config: JevConfig, image: boolean): string {
  if (config.model) return config.model;
  return image ? VISION_MODEL : TEXT_MODEL;
}

export async function askJev(
  config: JevConfig,
  request: JevRequest,
  fetchImpl: FetchLike = fetch,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<JevResponse> {
  if (request.image && !config.vision) throw new Error("JEV_VISION_DISABLED");
  const body = JSON.stringify({
    model: modelFor(config, request.image !== undefined),
    state: request.state,
    questions: request.questions,
    ...(request.image
      ? { assets: { [request.image.ref]: { type: "image", format: "png", data_base64: request.image.base64 } } }
      : {}),
  });
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
    ...(request.image ? { "TypeSafe-Danger-Zone-Images": "true" } : {}),
  };
  const started = Date.now();
  const deadline = started + config.timeoutMs;
  for (let attempt = 1; ; attempt++) {
    const left = deadline - Date.now();
    if (left <= 0) throw new Error("JEV_DEADLINE");
    const res = await fetchImpl(config.url ?? API_URL, { method: "POST", headers, body, signal: AbortSignal.timeout(left) });
    const text = await res.text();
    if (!res.ok) {
      const retryAfter = Number(res.headers?.get("retry-after")) * 1000;
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 250 * 2 ** (attempt - 1);
      if (RETRYABLE(res.status) && attempt < MAX_ATTEMPTS && Date.now() + wait < deadline - 200) {
        await sleep(wait);
        continue;
      }
      throw new Error(`JEV_HTTP_${res.status}: ${text.slice(0, 200)}`);
    }
    const parsed = JSON.parse(text) as { model?: unknown; answers?: unknown; usage?: { input_tokens?: unknown } };
    if (typeof parsed.model !== "string" || typeof parsed.answers !== "object" || parsed.answers === null) {
      throw new Error("JEV_BAD_RESPONSE");
    }
    const inputTokens = typeof parsed.usage?.input_tokens === "number" ? parsed.usage.input_tokens : undefined;
    return {
      model: parsed.model,
      answers: parsed.answers as Record<string, JevAnswer>,
      ms: Date.now() - started,
      ...(inputTokens !== undefined ? { inputTokens } : {}),
    };
  }
}

// TypeSafe counts state + one question against 32k and the whole request
// against 64k tokens. Text runs about 3.5 characters per token; staying well
// under both keeps a batch from being rejected (a 41-question batch with the
// element list repeated per question was, Nov 1 2026).
const REQUEST_TOKEN_BUDGET = 40_000;
const MAX_QUESTIONS_PER_REQUEST = 20;
const PARALLEL_REQUESTS = 4;
const tokens = (value: unknown) => Math.ceil(JSON.stringify(value).length / 3.5);

/**
 * Asks many questions about one state, split into as few requests as the
 * limits allow and run up to 4 at a time. Answers for a failed request are
 * missing rather than thrown, so callers treat them as "no decider answer".
 */
export async function askMany(
  config: JevConfig,
  state: unknown,
  questions: Record<string, JevQuestion>,
  ask: typeof askJev = askJev,
): Promise<{ answers: Record<string, JevAnswer>; requests: number; failures: number; ms: number }> {
  const stateTokens = tokens(state);
  const batches: Array<Record<string, JevQuestion>> = [];
  let current: Record<string, JevQuestion> = {};
  let currentTokens = stateTokens;
  for (const [id, question] of Object.entries(questions)) {
    const size = tokens(question);
    if (Object.keys(current).length > 0 && (currentTokens + size > REQUEST_TOKEN_BUDGET || Object.keys(current).length >= MAX_QUESTIONS_PER_REQUEST)) {
      batches.push(current);
      current = {};
      currentTokens = stateTokens;
    }
    current[id] = question;
    currentTokens += size;
  }
  if (Object.keys(current).length > 0) batches.push(current);

  const answers: Record<string, JevAnswer> = {};
  let failures = 0;
  const started = Date.now();
  for (let i = 0; i < batches.length; i += PARALLEL_REQUESTS) {
    const results = await Promise.allSettled(batches.slice(i, i + PARALLEL_REQUESTS).map((batch) => ask(config, { state, questions: batch })));
    for (const result of results) {
      if (result.status === "fulfilled") Object.assign(answers, result.value.answers);
      else failures += 1;
    }
  }
  return { answers, requests: batches.length, failures, ms: Date.now() - started };
}
