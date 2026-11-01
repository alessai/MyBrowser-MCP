// Optional decision layer (TypeSafe Jev, or any server speaking the same
// System One API). Off unless ~/.mybrowser/config.json carries a `jev` section;
// an invalid section fails closed at startup like `transfers` and `localUrlHost`.
// Every tool works without it: unclear items go back to the agent instead.

export interface JevConfig {
  /** "typesafe" (default) or "local": any /v1/systemone server, e.g. Strands Decider. */
  provider?: "typesafe" | "local";
  /** Required for typesafe; optional bearer token for a local server. */
  apiKey: string;
  /** Endpoint override; required for provider "local". */
  url?: string;
  /** Model override; defaults to the pinned TypeSafe version. */
  model?: string;
  /** Allow screenshots to be sent for visual checks. */
  vision: boolean;
  /** List browser_run (the decision-model autopilot). Off by default. */
  autopilot?: boolean;
  /** Minimum Choice confidence before the server acts on an answer. */
  minConfidence: number;
  timeoutMs: number;
}

const DEFAULTS = { vision: false, minConfidence: 0.7, timeoutMs: 3_000 } as const;
const ALLOWED = new Set(["provider", "apiKey", "url", "model", "vision", "autopilot", "minConfidence", "timeoutMs"]);
const EXAMPLE = '{ "apiKey": "apikey_...", "vision": false, "minConfidence": 0.7, "timeoutMs": 3000 }';

export function readJevConfig(raw: unknown): JevConfig | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`Invalid jev config: expected an object like ${EXAMPLE}`);
  }
  const value = raw as Record<string, unknown>;
  for (const key of Object.keys(value)) {
    if (!ALLOWED.has(key)) throw new Error(`Invalid jev config: unknown key "${key}" (allowed: ${[...ALLOWED].join(", ")})`);
  }
  const provider = value.provider ?? "typesafe";
  if (provider !== "typesafe" && provider !== "local") {
    throw new Error('Invalid jev config: "provider" must be "typesafe" or "local"');
  }
  if (value.url !== undefined) {
    let parsed: URL;
    try { parsed = new URL(String(value.url)); } catch { throw new Error('Invalid jev config: "url" must be an http(s) URL'); }
    if (typeof value.url !== "string" || !/^https?:$/.test(parsed.protocol)) throw new Error('Invalid jev config: "url" must be an http(s) URL');
  }
  if (provider === "local" && value.url === undefined) {
    throw new Error('Invalid jev config: provider "local" needs "url", e.g. "http://127.0.0.1:8000/v1/systemone"');
  }
  const apiKey = value.apiKey ?? "";
  if (typeof apiKey !== "string" || (provider === "typesafe" && apiKey.trim().length === 0)) {
    throw new Error('Invalid jev config: "apiKey" must be a non-empty string');
  }
  if (value.model !== undefined && (typeof value.model !== "string" || value.model.trim() === "")) {
    throw new Error('Invalid jev config: "model" must be a non-empty string');
  }
  if (value.vision !== undefined && typeof value.vision !== "boolean") {
    throw new Error('Invalid jev config: "vision" must be true or false');
  }
  if (value.autopilot !== undefined && typeof value.autopilot !== "boolean") {
    throw new Error('Invalid jev config: "autopilot" must be true or false');
  }
  const minConfidence = value.minConfidence ?? DEFAULTS.minConfidence;
  if (typeof minConfidence !== "number" || !(minConfidence >= 0.5 && minConfidence <= 0.99)) {
    throw new Error('Invalid jev config: "minConfidence" must be a number between 0.5 and 0.99');
  }
  const timeoutMs = value.timeoutMs ?? DEFAULTS.timeoutMs;
  if (!Number.isInteger(timeoutMs) || (timeoutMs as number) < 500 || (timeoutMs as number) > 30_000) {
    throw new Error('Invalid jev config: "timeoutMs" must be an integer between 500 and 30000');
  }
  return {
    provider,
    apiKey: apiKey.trim(),
    ...(value.url !== undefined ? { url: value.url as string } : {}),
    ...(value.model !== undefined ? { model: (value.model as string).trim() } : {}),
    vision: (value.vision as boolean | undefined) ?? DEFAULTS.vision,
    ...(value.autopilot === true ? { autopilot: true } : {}),
    minConfidence,
    timeoutMs: timeoutMs as number,
  };
}
