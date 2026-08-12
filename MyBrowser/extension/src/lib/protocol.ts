// WebSocket message protocol types shared between extension and server

import { isValidV2SessionId } from './session-id';

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
  'SESSION_CLOSED',
  'SESSION_FINALIZED',
  'SESSION_IDENTITY_MISMATCH',
  'SERVER_SHUTTING_DOWN',
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

export const EXTENSION_TELEMETRY_ERROR_CATEGORIES = [
  'invalid_arguments', 'authorization_denied', 'ownership_denied',
  'browser_not_found', 'not_connected', 'timeout', 'request_expired',
  'queue_overloaded', 'tab_not_found', 'session_closed', 'worker_restarted',
  'extension_tool_failed', 'unknown',
] as const;

export type ExtensionTelemetryErrorCategory =
  (typeof EXTENSION_TELEMETRY_ERROR_CATEGORIES)[number];

export interface TraceContextV1 {
  schemaVersion: 1;
  traceId: string;
  rootCallId: string;
  transportSpanId: string;
}

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

export interface AuthRequestV2 {
  type: 'auth';
  token: string;
  role: ConnectionRole;
  protocolVersion: typeof PROTOCOL_VERSION;
  browserName?: string;
  temporaryTabSessionIds?: string[];
}

export interface AuthResultV2 {
  type: 'auth';
  status: 'ok';
  protocolVersion: typeof PROTOCOL_VERSION;
  browserId?: string;
  finalizedSessionIds?: string[];
}

export interface ToolRequestV2 {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  sessionId: string;
  timeoutMs: number;
  trace?: TraceContextV1;
}

export interface ToolResponseV2 {
  type: 'messageResponse';
  payload: {
    requestId: string;
    result?: unknown;
    error?: string;
    telemetry?: ExtensionTraceSummaryV1;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const TRACE_ID = /^[A-Za-z0-9_-]{16,64}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_EXTENSION_TIMING_MS = 86_400_000;

function hasExactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length <= allowed.length && keys.every((key) => allowed.includes(key));
}

const MAX_RECONCILIATION_SESSIONS = 64;

export function isBoundedSessionIdList(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length > MAX_RECONCILIATION_SESSIONS) return false;
  const seen = new Set<string>();
  return value.every((sessionId) => {
    if (!isValidV2SessionId(sessionId) || seen.has(sessionId)) return false;
    seen.add(sessionId);
    return true;
  });
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function validTiming(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
    && value >= 0 && value <= MAX_EXTENSION_TIMING_MS;
}

export function isTraceContextV1(value: unknown): value is TraceContextV1 {
  if (!isRecord(value) || !hasExactKeys(value, [
    'schemaVersion', 'traceId', 'rootCallId', 'transportSpanId',
  ])) return false;
  return value.schemaVersion === 1
    && typeof value.traceId === 'string' && TRACE_ID.test(value.traceId)
    && typeof value.rootCallId === 'string' && TRACE_ID.test(value.rootCallId)
    && typeof value.transportSpanId === 'string' && TRACE_ID.test(value.transportSpanId);
}

function isStateSignals(value: unknown): value is NonNullable<ExtensionTraceSummaryV1['stateSignals']> {
  if (!isRecord(value) || !hasExactKeys(value, [
    'tabChanged', 'originChanged', 'pathChanged', 'loadStatusChanged',
  ])) return false;
  return ['tabChanged', 'originChanged', 'pathChanged', 'loadStatusChanged']
    .every((key) => !hasOwn(value, key) || typeof value[key] === 'boolean');
}

export function isExtensionTraceSummaryV1(value: unknown): value is ExtensionTraceSummaryV1 {
  if (!isRecord(value) || !hasExactKeys(value, [
    'schemaVersion', 'traceId', 'transportSpanId', 'extensionRequestId',
    'offscreenReceivedToBackgroundMs', 'queueWaitMs', 'handlerMs',
    'responseSerializeMs', 'resolvedTabId', 'stateSignals', 'errorCategory',
  ])) return false;
  if (value.schemaVersion !== 1
    || typeof value.traceId !== 'string' || !TRACE_ID.test(value.traceId)
    || typeof value.transportSpanId !== 'string' || !TRACE_ID.test(value.transportSpanId)
    || typeof value.extensionRequestId !== 'string' || !REQUEST_ID.test(value.extensionRequestId)) {
    return false;
  }
  for (const key of [
    'offscreenReceivedToBackgroundMs', 'queueWaitMs', 'handlerMs', 'responseSerializeMs',
  ]) {
    if (hasOwn(value, key) && !validTiming(value[key])) return false;
  }
  if (hasOwn(value, 'resolvedTabId') && (
    typeof value.resolvedTabId !== 'number' || !Number.isInteger(value.resolvedTabId)
    || value.resolvedTabId < 0 || value.resolvedTabId > 2_147_483_647
  )) return false;
  if (hasOwn(value, 'stateSignals') && !isStateSignals(value.stateSignals)) return false;
  if (hasOwn(value, 'errorCategory') && !EXTENSION_TELEMETRY_ERROR_CATEGORIES.some(
    (category) => category === value.errorCategory,
  )) return false;
  return true;
}

export function isAuthRequestV2(value: unknown): value is AuthRequestV2 {
  if (!isRecord(value)) return false;
  if (!hasExactKeys(value, [
    'type', 'token', 'role', 'protocolVersion', 'browserName', 'temporaryTabSessionIds',
  ])) return false;
  return (
    value.type === 'auth' &&
    typeof value.token === 'string' &&
    CONNECTION_ROLES.some((role) => role === value.role) &&
    value.protocolVersion === PROTOCOL_VERSION &&
    (value.browserName === undefined || typeof value.browserName === 'string') &&
    (value.temporaryTabSessionIds === undefined || (
      value.role === 'extension' && isBoundedSessionIdList(value.temporaryTabSessionIds)
    ))
  );
}

export function isAuthResultV2(value: unknown): value is AuthResultV2 {
  if (!isRecord(value)) return false;
  if (!hasExactKeys(value, [
    'type', 'status', 'protocolVersion', 'browserId', 'finalizedSessionIds',
  ])) return false;
  return (
    value.type === 'auth' &&
    value.status === 'ok' &&
    value.protocolVersion === PROTOCOL_VERSION &&
    (value.browserId === undefined || typeof value.browserId === 'string') &&
    (value.finalizedSessionIds === undefined || isBoundedSessionIdList(value.finalizedSessionIds))
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
    Number.isFinite(value.timeoutMs) &&
    (!hasOwn(value, 'trace') || isTraceContextV1(value.trace))
  );
}

export function isToolResponseV2(value: unknown): value is ToolResponseV2 {
  if (!isRecord(value) || value.type !== 'messageResponse' || !isRecord(value.payload)) {
    return false;
  }

  return (
    typeof value.payload.requestId === 'string' &&
    (value.payload.error === undefined || typeof value.payload.error === 'string') &&
    (!hasOwn(value.payload, 'telemetry') || isExtensionTraceSummaryV1(value.payload.telemetry))
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
