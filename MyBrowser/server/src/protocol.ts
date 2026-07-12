export const PROTOCOL_VERSION = 2 as const;

export const WS_CLOSE = {
  unauthorized: 4001,
  invalidJson: 4003,
  forbiddenRole: 4403,
  versionMismatch: 4406,
} as const;

export type ConnectionRole = "client" | "extension";

export type ProtocolErrorCode =
  | "PROTOCOL_VERSION_MISMATCH"
  | "AUTH_ROLE_VIOLATION"
  | "SESSION_NOT_REGISTERED"
  | "SESSION_IDENTITY_MISMATCH"
  | "REQUEST_EXPIRED"
  | "QUEUE_OVERLOADED"
  | "TAB_CLOSED"
  | "RECORDING_NOT_OWNED"
  | "RECORDING_NAME_CONFLICT"
  | "RECORDING_RESERVATION_EXPIRED"
  | "RECORDING_STATE_LIMIT"
  | "RECORDING_UNSUPPORTED_MULTI_TAB"
  | "REPLAY_VARIABLES_MISSING"
  | "RECORDING_PERSISTENCE_PARTIAL"
  | "EXTENSION_WORKER_RESTARTED";

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

export interface ToolResponse {
  type: "messageResponse";
  payload: {
    requestId: string;
    result?: unknown;
    error?: string;
  };
}

export function isAuthResultV2(value: unknown): value is AuthResultV2 {
  if (typeof value !== "object" || value === null) return false;

  const result = value as Record<string, unknown>;
  return (
    result.type === "auth" &&
    result.status === "ok" &&
    result.protocolVersion === PROTOCOL_VERSION &&
    (result.browserId === undefined || typeof result.browserId === "string")
  );
}

export function isToolRequestV2(value: unknown): value is ToolRequestV2 {
  if (typeof value !== "object" || value === null) return false;

  const request = value as Record<string, unknown>;
  return (
    typeof request.id === "string" &&
    typeof request.type === "string" &&
    typeof request.payload === "object" &&
    request.payload !== null &&
    !Array.isArray(request.payload) &&
    typeof request.sessionId === "string" &&
    typeof request.timeoutMs === "number" &&
    Number.isFinite(request.timeoutMs)
  );
}
