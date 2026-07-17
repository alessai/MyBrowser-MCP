export const PROTOCOL_VERSION = 2 as const;

export const WS_CLOSE = {
  unauthorized: 4001,
  invalidJson: 4003,
  forbiddenRole: 4403,
  versionMismatch: 4406,
} as const;

export const CONNECTION_ROLES = ["client", "extension"] as const;

export type ConnectionRole = (typeof CONNECTION_ROLES)[number];

export const PROTOCOL_ERROR_CODES = [
  "PROTOCOL_VERSION_MISMATCH",
  "AUTH_ROLE_VIOLATION",
  "SESSION_NOT_REGISTERED",
  "SESSION_CLOSED",
  "SESSION_FINALIZED",
  "SESSION_IDENTITY_MISMATCH",
  "SERVER_SHUTTING_DOWN",
  "INVALID_SESSION_ID",
  "REQUEST_EXPIRED",
  "QUEUE_OVERLOADED",
  "TAB_CLOSED",
  "RECORDING_NOT_OWNED",
  "RECORDING_NAME_CONFLICT",
  "RECORDING_RESERVATION_EXPIRED",
  "RECORDING_STATE_LIMIT",
  "RECORDING_UNSUPPORTED_MULTI_TAB",
  "REPLAY_VARIABLES_MISSING",
  "RECORDING_PERSISTENCE_PARTIAL",
  "EXTENSION_WORKER_RESTARTED",
] as const;

export type ProtocolErrorCode = (typeof PROTOCOL_ERROR_CODES)[number];

export interface AuthRequestV2 {
  type: "auth";
  token: string;
  role: ConnectionRole;
  protocolVersion: typeof PROTOCOL_VERSION;
  browserName?: string;
}

export interface AuthResultV2 {
  type: "auth";
  status: "ok";
  protocolVersion: typeof PROTOCOL_VERSION;
  browserId?: string;
}

export interface ToolRequestV2 {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  sessionId: string;
  timeoutMs: number;
  trace?: TraceContextV1;
}

export interface TraceContextV1 {
  schemaVersion: 1;
  traceId: string;
  rootCallId: string;
  transportSpanId: string;
}

export const EXTENSION_TELEMETRY_ERROR_CATEGORIES = [
  "invalid_arguments", "authorization_denied", "ownership_denied",
  "browser_not_found", "not_connected", "timeout", "request_expired",
  "queue_overloaded", "tab_not_found", "session_closed", "worker_restarted",
  "extension_tool_failed", "unknown",
] as const;

export type ExtensionTelemetryErrorCategory =
  (typeof EXTENSION_TELEMETRY_ERROR_CATEGORIES)[number];

export interface ExtensionTraceSummaryV1 {
  schemaVersion: 1;
  traceId: string;
  transportSpanId: string;
  extensionRequestId: string;
  offscreenReceivedToBackgroundMs?: number;
  queueWaitMs?: number;
  handlerMs?: number;
  responseSerializeMs?: number;
  resolvedTabId?: number;
  stateSignals?: {
    tabChanged?: boolean;
    originChanged?: boolean;
    pathChanged?: boolean;
    loadStatusChanged?: boolean;
  };
  errorCategory?: ExtensionTelemetryErrorCategory;
}

export interface ToolResponseV2 {
  type: "messageResponse";
  payload: {
    requestId: string;
    result?: unknown;
    error?: string;
    telemetry?: ExtensionTraceSummaryV1;
  };
}

export type ToolResponse = ToolResponseV2;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const TRACE_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const TRACE_FIELDS = new Set(["schemaVersion", "traceId", "rootCallId", "transportSpanId"]);

function ownDataValue(record: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

export function isTraceContextV1(value: unknown): value is TraceContextV1 {
  if (!isRecord(value)) return false;
  try {
    const keys = Reflect.ownKeys(value);
    if (keys.length !== TRACE_FIELDS.size || keys.some((key) => typeof key !== "string" || !TRACE_FIELDS.has(key))) {
      return false;
    }
    const schemaVersion = ownDataValue(value, "schemaVersion");
    const traceId = ownDataValue(value, "traceId");
    const rootCallId = ownDataValue(value, "rootCallId");
    const transportSpanId = ownDataValue(value, "transportSpanId");
    return schemaVersion === 1
      && typeof traceId === "string"
      && TRACE_ID_PATTERN.test(traceId)
      && typeof rootCallId === "string"
      && TRACE_ID_PATTERN.test(rootCallId)
      && typeof transportSpanId === "string"
      && TRACE_ID_PATTERN.test(transportSpanId);
  } catch {
    return false;
  }
}

const EXTENSION_REQUEST_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_EXTENSION_TIMING_MS = 86_400_000;

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length <= allowed.length && keys.every((key) => allowed.includes(key));
}

function validTiming(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
    && value >= 0 && value <= MAX_EXTENSION_TIMING_MS;
}

function isStateSignals(value: unknown): boolean {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "tabChanged", "originChanged", "pathChanged", "loadStatusChanged",
  ])) return false;
  return ["tabChanged", "originChanged", "pathChanged", "loadStatusChanged"]
    .every((key) => !hasOwn(value, key) || typeof value[key] === "boolean");
}

export function isExtensionTraceSummaryV1(value: unknown): value is ExtensionTraceSummaryV1 {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "schemaVersion", "traceId", "transportSpanId", "extensionRequestId",
    "offscreenReceivedToBackgroundMs", "queueWaitMs", "handlerMs",
    "responseSerializeMs", "resolvedTabId", "stateSignals", "errorCategory",
  ])) return false;
  if (value.schemaVersion !== 1
    || typeof value.traceId !== "string" || !TRACE_ID_PATTERN.test(value.traceId)
    || typeof value.transportSpanId !== "string" || !TRACE_ID_PATTERN.test(value.transportSpanId)
    || typeof value.extensionRequestId !== "string" || !EXTENSION_REQUEST_ID.test(value.extensionRequestId)) {
    return false;
  }
  for (const key of [
    "offscreenReceivedToBackgroundMs", "queueWaitMs", "handlerMs", "responseSerializeMs",
  ]) if (hasOwn(value, key) && !validTiming(value[key])) return false;
  if (hasOwn(value, "resolvedTabId") && (
    typeof value.resolvedTabId !== "number" || !Number.isInteger(value.resolvedTabId)
    || value.resolvedTabId < 0 || value.resolvedTabId > 2_147_483_647
  )) return false;
  if (hasOwn(value, "stateSignals") && !isStateSignals(value.stateSignals)) return false;
  if (hasOwn(value, "errorCategory") && !EXTENSION_TELEMETRY_ERROR_CATEGORIES.some(
    (category) => category === value.errorCategory,
  )) return false;
  return true;
}

export function isAuthRequestV2(value: unknown): value is AuthRequestV2 {
  if (!isRecord(value)) return false;

  return (
    value.type === "auth" &&
    typeof value.token === "string" &&
    CONNECTION_ROLES.some((role) => role === value.role) &&
    value.protocolVersion === PROTOCOL_VERSION &&
    (value.browserName === undefined || typeof value.browserName === "string")
  );
}

export function isAuthResultV2(value: unknown): value is AuthResultV2 {
  if (!isRecord(value)) return false;

  return (
    value.type === "auth" &&
    value.status === "ok" &&
    value.protocolVersion === PROTOCOL_VERSION &&
    (value.browserId === undefined || typeof value.browserId === "string")
  );
}

export function isToolRequestV2(value: unknown): value is ToolRequestV2 {
  if (!isRecord(value)) return false;

  return (
    typeof value.id === "string" &&
    typeof value.type === "string" &&
    isRecord(value.payload) &&
    typeof value.sessionId === "string" &&
    typeof value.timeoutMs === "number" &&
    Number.isFinite(value.timeoutMs) &&
    (value.trace === undefined || isTraceContextV1(value.trace))
  );
}

export function isToolResponseV2(value: unknown): value is ToolResponseV2 {
  if (!isRecord(value) || value.type !== "messageResponse" || !isRecord(value.payload)) {
    return false;
  }

  return (
    typeof value.payload.requestId === "string" &&
    (value.payload.error === undefined || typeof value.payload.error === "string") &&
    (!hasOwn(value.payload, "telemetry") || isExtensionTraceSummaryV1(value.payload.telemetry))
  );
}
