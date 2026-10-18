// Optional TypeSafe Jev decision layer. Off unless ~/.mybrowser/config.json
// carries a `jev` section with an API key; an invalid section fails closed at
// startup like `transfers` and `localUrlHost`.

export interface JevConfig {
  apiKey: string;
  /** Allow screenshots to be sent to TypeSafe for visual checks. */
  vision: boolean;
  /** Minimum Choice confidence before the server acts on Jev's answer. */
  minConfidence: number;
  timeoutMs: number;
}

const DEFAULTS = { vision: false, minConfidence: 0.7, timeoutMs: 3_000 } as const;
const ALLOWED = new Set(["apiKey", "vision", "minConfidence", "timeoutMs"]);
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
  if (typeof value.apiKey !== "string" || value.apiKey.trim().length === 0) {
    throw new Error('Invalid jev config: "apiKey" must be a non-empty string');
  }
  if (value.vision !== undefined && typeof value.vision !== "boolean") {
    throw new Error('Invalid jev config: "vision" must be true or false');
  }
  const minConfidence = value.minConfidence ?? DEFAULTS.minConfidence;
  if (typeof minConfidence !== "number" || !(minConfidence >= 0.5 && minConfidence <= 0.99)) {
    throw new Error('Invalid jev config: "minConfidence" must be a number between 0.5 and 0.99');
  }
  const timeoutMs = value.timeoutMs ?? DEFAULTS.timeoutMs;
  if (!Number.isInteger(timeoutMs) || (timeoutMs as number) < 500 || (timeoutMs as number) > 10_000) {
    throw new Error('Invalid jev config: "timeoutMs" must be an integer between 500 and 10000');
  }
  return {
    apiKey: value.apiKey.trim(),
    vision: value.vision ?? DEFAULTS.vision,
    minConfidence,
    timeoutMs: timeoutMs as number,
  };
}
