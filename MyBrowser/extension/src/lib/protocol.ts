// WebSocket message protocol types shared between extension and server

export const PROTOCOL_VERSION = 2 as const;

export const WS_CLOSE = {
  unauthorized: 4001,
  invalidJson: 4003,
  forbiddenRole: 4403,
  versionMismatch: 4406,
} as const;

export const CONNECTION_ROLES = ['client', 'extension'] as const;

export type ConnectionRole = (typeof CONNECTION_ROLES)[number];

export const PROTOCOL_ERROR_CODES = [
  'PROTOCOL_VERSION_MISMATCH',
  'AUTH_ROLE_VIOLATION',
  'SESSION_NOT_REGISTERED',
  'SESSION_IDENTITY_MISMATCH',
  'INVALID_SESSION_ID',
  'REQUEST_EXPIRED',
  'QUEUE_OVERLOADED',
  'TAB_CLOSED',
  'RECORDING_NOT_OWNED',
  'RECORDING_NAME_CONFLICT',
  'RECORDING_RESERVATION_EXPIRED',
  'RECORDING_STATE_LIMIT',
  'RECORDING_UNSUPPORTED_MULTI_TAB',
  'REPLAY_VARIABLES_MISSING',
  'RECORDING_PERSISTENCE_PARTIAL',
  'EXTENSION_WORKER_RESTARTED',
] as const;

export type ProtocolErrorCode = (typeof PROTOCOL_ERROR_CODES)[number];

export interface AuthRequestV2 {
  type: 'auth';
  token: string;
  role: ConnectionRole;
  protocolVersion: typeof PROTOCOL_VERSION;
  browserName?: string;
}

export interface AuthResultV2 {
  type: 'auth';
  status: 'ok';
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
  type: 'messageResponse';
  payload: {
    requestId: string;
    result?: unknown;
    error?: string;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isAuthRequestV2(value: unknown): value is AuthRequestV2 {
  if (!isRecord(value)) return false;

  return (
    value.type === 'auth' &&
    typeof value.token === 'string' &&
    CONNECTION_ROLES.some((role) => role === value.role) &&
    value.protocolVersion === PROTOCOL_VERSION &&
    (value.browserName === undefined || typeof value.browserName === 'string')
  );
}

export function isAuthResultV2(value: unknown): value is AuthResultV2 {
  if (!isRecord(value)) return false;

  return (
    value.type === 'auth' &&
    value.status === 'ok' &&
    value.protocolVersion === PROTOCOL_VERSION &&
    (value.browserId === undefined || typeof value.browserId === 'string')
  );
}

export function isToolRequestV2(value: unknown): value is ToolRequestV2 {
  if (!isRecord(value)) return false;

  return (
    typeof value.id === 'string' &&
    typeof value.type === 'string' &&
    isRecord(value.payload) &&
    typeof value.sessionId === 'string' &&
    typeof value.timeoutMs === 'number' &&
    Number.isFinite(value.timeoutMs)
  );
}

export function isToolResponseV2(value: unknown): value is ToolResponseV2 {
  if (!isRecord(value) || value.type !== 'messageResponse' || !isRecord(value.payload)) {
    return false;
  }

  return (
    typeof value.payload.requestId === 'string' &&
    (value.payload.error === undefined || typeof value.payload.error === 'string')
  );
}

// --- Auth ---
export interface AuthMessage {
  type: 'auth';
  token: string;
  role?: 'extension';
  browserName?: string;
}

// --- Heartbeat ---
export interface PingMessage {
  type: 'ping';
}

export interface PongMessage {
  type: 'pong';
}

// --- Tool request/response (server -> extension -> server) ---
export interface ToolRequest {
  id: string;
  type: string;
  payload: Record<string, unknown>;
}

export interface ToolResponse {
  type: 'messageResponse';
  payload: {
    requestId: string;
    result?: unknown;
    error?: string;
  };
}

// --- Offscreen <-> Service Worker messages ---
export interface WsSendMessage {
  type: 'ws_send';
  payload: string; // JSON-stringified WS message
}

export interface WsReceiveMessage {
  type: 'ws_receive';
  payload: string; // JSON-stringified WS message
}

export interface WsStatusRequest {
  type: 'ws_status';
}

export interface WsStatusResponse {
  state: 'DISCONNECTED' | 'CONNECTING' | 'AUTHENTICATING' | 'CONNECTED';
}

export interface WsReconnectMessage {
  type: 'ws_reconnect';
}

// --- Content script messages ---
export interface ContentMessage<T = unknown> {
  type: string;
  payload: T;
}

export interface ContentResponse<T = unknown> {
  result?: T;
  error?: string;
}

// Generate unique IDs
export function generateId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  const timestamp = Date.now().toString(36);
  const randomStr = Math.random().toString(36).substring(2, 10);
  return `${timestamp}-${randomStr}`;
}
