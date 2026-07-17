import { createHmac } from "node:crypto";

import {
  getTelemetryToolPolicy,
  type TelemetryFieldPolicy,
  type ToolTelemetryPolicy,
} from "./policies.js";
import type { SanitizedArgumentSummary } from "./types.js";

const MAX_PSEUDONYM_INPUT = 4_096;
const MAX_URL_INPUT = 8_192;
const MAX_ACTIONS = 32;
const HMAC_LENGTH = 22;

interface MutableSummary {
  presence: string[];
  scalar: Record<string, boolean | number | string>;
  counts: Record<string, number>;
  pseudonyms: Record<string, string>;
  droppedFields: number;
  truncated: boolean;
}

export interface SanitizedToolArguments {
  readonly summary: SanitizedArgumentSummary;
  readonly fingerprint: string;
}

export interface SanitizerFailureMarker {
  readonly sanitizer: "failed";
  readonly dropped: true;
}

const SANITIZER_FAILURE_MARKER: SanitizerFailureMarker = Object.freeze({
  sanitizer: "failed",
  dropped: true,
});

function readOwnDataField(source: unknown, field: string): { present: boolean; value?: unknown } {
  if (typeof source !== "object" || source === null) {
    return { present: false };
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(source, field);
    if (!descriptor || !("value" in descriptor)) return { present: false };
    return { present: true, value: descriptor.value };
  } catch {
    return { present: false };
  }
}

export function pseudonymizeTelemetryValue(key: Buffer, namespace: string, value: string): string {
  return createHmac("sha256", key)
    .update(namespace, "utf8")
    .update("\0", "utf8")
    .update(value, "utf8")
    .digest("base64url")
    .slice(0, HMAC_LENGTH);
}

function pseudonymInput(value: unknown): string | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : undefined;
  if (typeof value !== "string" || value.length > MAX_PSEUDONYM_INPUT) return undefined;
  return value;
}

function lengthBucket(length: number): string {
  if (length === 0) return "0";
  if (length <= 16) return "1-16";
  if (length <= 64) return "17-64";
  if (length <= 256) return "65-256";
  if (length <= 1_024) return "257-1024";
  if (length <= 4_096) return "1025-4096";
  return "4097+";
}

function safeCollectionCount(
  value: unknown,
  max: number,
): { count: number; truncated: boolean } | undefined {
  try {
    if (Array.isArray(value)) {
      return { count: Math.min(value.length, max), truncated: value.length > max };
    }
    if (typeof value === "object" && value !== null) {
      const length = Reflect.ownKeys(value).length;
      return { count: Math.min(length, max), truncated: length > max };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function safeShape(value: unknown): string {
  if (value === null) return "null";
  try {
    if (Array.isArray(value)) return "array";
  } catch {
    return "unknown";
  }
  switch (typeof value) {
    case "boolean":
    case "number":
    case "string":
      return typeof value;
    case "object":
      return "object";
    default:
      return "unknown";
  }
}

function summarizeActionSequence(
  field: string,
  value: unknown,
  allowedValues: readonly string[],
  summary: MutableSummary,
): boolean {
  if (!Array.isArray(value)) return false;
  const count = Math.min(value.length, 1_024);
  summary.counts[field] = count;
  if (value.length > MAX_ACTIONS || value.length > 1_024) summary.truncated = true;

  const allowed = new Set(allowedValues);
  const actions: string[] = [];
  for (let index = 0; index < Math.min(value.length, MAX_ACTIONS); index += 1) {
    const action = readOwnDataField(value[index], "action");
    actions.push(typeof action.value === "string" && allowed.has(action.value) ? action.value : "other");
  }
  summary.scalar[`${field}.kinds`] = actions.join(",");
  return true;
}

function applyFieldPolicy(
  field: string,
  rule: TelemetryFieldPolicy,
  value: unknown,
  summary: MutableSummary,
  hmacKey?: Buffer,
): boolean {
  switch (rule.kind) {
    case "boolean":
      if (typeof value !== "boolean") return false;
      summary.scalar[field] = value;
      return true;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) return false;
      if (value < rule.min || value > rule.max) summary.truncated = true;
      summary.scalar[field] = Math.round(
        Math.min(rule.max, Math.max(rule.min, value)) / rule.step,
      ) * rule.step;
      return true;
    case "enum":
      summary.scalar[field] =
        typeof value === "string" && rule.values.includes(value) ? value : "other";
      return true;
    case "count": {
      const result = safeCollectionCount(value, rule.max);
      if (!result) return false;
      summary.counts[field] = result.count;
      if (result.truncated) summary.truncated = true;
      return true;
    }
    case "text_length":
      if (typeof value !== "string") return false;
      summary.scalar[`${field}.length`] = lengthBucket(value.length);
      if (value.length > MAX_PSEUDONYM_INPUT) summary.truncated = true;
      return true;
    case "pseudonym": {
      if (!hmacKey) return false;
      const input = pseudonymInput(value);
      if (input === undefined) {
        if (typeof value === "string" && value.length > MAX_PSEUDONYM_INPUT) {
          summary.truncated = true;
        }
        return false;
      }
      summary.pseudonyms[field] = pseudonymizeTelemetryValue(hmacKey, rule.namespace, input);
      return true;
    }
    case "url": {
      if (typeof value !== "string") return false;
      if (value.length > MAX_URL_INPUT) {
        summary.truncated = true;
        return false;
      }
      try {
        const parsed = new URL(value);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
        summary.scalar[`${field}.origin`] = parsed.origin;
        if (hmacKey) {
          summary.pseudonyms[`${field}.path`] = pseudonymizeTelemetryValue(hmacKey, "url_path", parsed.pathname);
        }
        return true;
      } catch {
        summary.scalar[`${field}.kind`] = "invalid";
        return true;
      }
    }
    case "shape":
      summary.scalar[`${field}.shape`] = safeShape(value);
      return true;
    case "action_sequence":
      return summarizeActionSequence(field, value, rule.values, summary);
  }
}

function freezeSummary(summary: MutableSummary): SanitizedArgumentSummary {
  summary.presence.sort();
  Object.freeze(summary.presence);
  Object.freeze(summary.scalar);
  Object.freeze(summary.counts);
  Object.freeze(summary.pseudonyms);
  return Object.freeze(summary) as unknown as SanitizedArgumentSummary;
}

function sanitizeWithPolicy(
  policy: ToolTelemetryPolicy,
  args: unknown,
  hmacKey?: Buffer,
): SanitizedArgumentSummary {
  const summary: MutableSummary = {
    presence: [],
    scalar: {},
    counts: {},
    pseudonyms: {},
    droppedFields: 0,
    truncated: false,
  };

  for (const [field, rule] of Object.entries(policy.fields)) {
    const read = readOwnDataField(args, field);
    if (!read.present) continue;
    summary.presence.push(field);
    try {
      if (!applyFieldPolicy(field, rule, read.value, summary, hmacKey)) {
        summary.droppedFields += 1;
      }
    } catch {
      // A hostile field is omitted; policy-controlled presence remains safe.
      summary.droppedFields += 1;
    }
  }

  return freezeSummary(summary);
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalize(record[key])}`
  )).join(",")}}`;
}

export function summarizeToolArguments(
  toolName: string,
  args: unknown,
  hmacKey: Buffer,
): SanitizedToolArguments {
  const policy = getTelemetryToolPolicy(toolName);
  if (!policy) throw new Error(`Telemetry policy missing for ${toolName}`);
  const summary = sanitizeWithPolicy(policy, args, hmacKey);
  const fingerprint = pseudonymizeTelemetryValue(
    hmacKey,
    "tool_arguments",
    `${toolName}\0${canonicalize(summary)}`,
  );
  return Object.freeze({ summary, fingerprint });
}

export function summarizeUnknownToolArguments(hmacKey: Buffer): SanitizedToolArguments {
  const summary = freezeSummary({
    presence: [], scalar: {}, counts: {}, pseudonyms: {}, droppedFields: 0, truncated: false,
  });
  const fingerprint = pseudonymizeTelemetryValue(
    hmacKey,
    "tool_arguments",
    `unknown_tool\0${canonicalize(summary)}`,
  );
  return Object.freeze({ summary, fingerprint });
}

export function summarizeFailedToolArguments(hmacKey: Buffer): SanitizedToolArguments {
  const summary = freezeSummary({
    presence: [], scalar: {}, counts: {}, pseudonyms: {}, droppedFields: 1, truncated: false,
  });
  const fingerprint = pseudonymizeTelemetryValue(
    hmacKey,
    "tool_arguments",
    `sanitizer_failed_tool\0${canonicalize(summary)}`,
  );
  return Object.freeze({ summary, fingerprint });
}

export function summarizeDiagnosticsArguments(
  toolName: string,
  args: unknown,
): SanitizedArgumentSummary | SanitizerFailureMarker {
  try {
    const policy = getTelemetryToolPolicy(toolName);
    if (!policy) return freezeSummary({
      presence: [], scalar: {}, counts: {}, pseudonyms: {}, droppedFields: 0, truncated: false,
    });
    return sanitizeWithPolicy(policy, args);
  } catch {
    return SANITIZER_FAILURE_MARKER;
  }
}
