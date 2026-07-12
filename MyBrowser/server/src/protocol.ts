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
  "SESSION_IDENTITY_MISMATCH",
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
}

export interface ToolResponseV2 {
  type: "messageResponse";
  payload: {
    requestId: string;
    result?: unknown;
    error?: string;
  };
}

export type ToolResponse = ToolResponseV2;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
    Number.isFinite(value.timeoutMs)
  );
}

export function isToolResponseV2(value: unknown): value is ToolResponseV2 {
  if (!isRecord(value) || value.type !== "messageResponse" || !isRecord(value.payload)) {
    return false;
  }

  return (
    typeof value.payload.requestId === "string" &&
    (value.payload.error === undefined || typeof value.payload.error === "string")
  );
}
