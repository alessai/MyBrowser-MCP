// WebSocket message protocol types shared between extension and server

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
  serverAddress?: string;
  latencyMs?: number;
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
