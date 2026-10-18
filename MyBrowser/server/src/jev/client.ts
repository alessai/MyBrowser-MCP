import type { JevConfig } from "./config.js";

const API_URL = "https://api.typesafe.ai/v1/systemone";
// Pinned: TypeSafe documents confidence thresholds as version-specific. The
// 0.7 default was measured against these exact versions.
export const TEXT_MODEL = "jev-1.13.0";
export const VISION_MODEL = "jev-1.14.0";

export type JevQuestion =
  | { type: "noul"; instructions: string }
  | { type: "choice"; instructions: string; criteria: Record<string, string> };

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
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Pick<Response, "ok" | "status" | "text">>;

export async function askJev(
  config: JevConfig,
  request: JevRequest,
  fetchImpl: FetchLike = fetch,
): Promise<JevResponse> {
  if (request.image && !config.vision) throw new Error("JEV_VISION_DISABLED");
  const body = {
    model: request.image ? VISION_MODEL : TEXT_MODEL,
    state: request.state,
    questions: request.questions,
    ...(request.image
      ? { assets: { [request.image.ref]: { type: "image", format: "png", data_base64: request.image.base64 } } }
      : {}),
  };
  const started = Date.now();
  const res = await fetchImpl(API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
      ...(request.image ? { "TypeSafe-Danger-Zone-Images": "true" } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`JEV_HTTP_${res.status}: ${text.slice(0, 200)}`);
  const parsed = JSON.parse(text) as { model?: unknown; answers?: unknown };
  if (typeof parsed.model !== "string" || typeof parsed.answers !== "object" || parsed.answers === null) {
    throw new Error("JEV_BAD_RESPONSE");
  }
  return { model: parsed.model, answers: parsed.answers as Record<string, JevAnswer>, ms: Date.now() - started };
}
