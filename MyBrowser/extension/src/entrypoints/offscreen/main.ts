// Offscreen document: owns the WebSocket connection to the MCP server.
// This document persists independently of the service worker and maintains
// the WS connection 24/7.
//
// Communication with the background SW uses a persistent port (chrome.runtime.connect).
// A port connection WAKES the SW and KEEPS it alive for as long as the port is open.
// Falls back to one-shot sendMessage if the port is unavailable.

import { ReconnectingWebSocket } from '../../lib/reconnecting-ws';
import type { WsStatusResponse } from '../../lib/protocol';

const ws = new ReconnectingWebSocket();
let lastConfig: { url: string; token: string } | null = null;

// ---------------------------------------------------------------------------
// Persistent port to background SW
// ---------------------------------------------------------------------------

let port: chrome.runtime.Port | null = null;
let portRetryDelay = 200;
const PORT_MAX_RETRY_DELAY = 10_000;

function ensurePort(): chrome.runtime.Port | null {
  if (port) return port;
  try {
    port = chrome.runtime.connect({ name: 'offscreen' });
  } catch {
    schedulePortRetry();
    return null;
  }
  portRetryDelay = 200; // Reset backoff on successful connect
  port.onDisconnect.addListener(() => {
    port = null;
    schedulePortRetry();
  });
  port.onMessage.addListener(handleBackgroundMessage);
  return port;
}

function schedulePortRetry(): void {
  setTimeout(() => {
    ensurePort();
  }, portRetryDelay);
  portRetryDelay = Math.min(portRetryDelay * 2, PORT_MAX_RETRY_DELAY);
}

/**
 * Send a message to the background SW via port, falling back to sendMessage.
 */
async function postToBackground(message: Record<string, unknown>): Promise<void> {
  // Try port first
  const p = ensurePort();
  if (p) {
    try {
      p.postMessage(message);
      return;
    } catch {
      port = null;
    }
  }
  // Fallback: sendMessage (also wakes SW, just less reliably)
  try {
    await chrome.runtime.sendMessage(message);
  } catch {
    // SW truly unreachable — nothing we can do
  }
}

// ---------------------------------------------------------------------------
// Handle messages from background SW (via port)
// ---------------------------------------------------------------------------

function handleMessage(message: { type: string; payload?: unknown; _replyId?: string }, reply: (data: unknown) => void): void {
  if (message.type === '_os_ws_connect') {
    const { url, token, browserName } = message.payload as { url: string; token: string; browserName?: string };
    if (
      ws.getState() === 'CONNECTED' &&
      lastConfig?.url === url &&
      lastConfig?.token === token
    ) {
      reply({ ok: true, already: true });
      return;
    }
    connectWithConfig(url, token, browserName);
    reply({ ok: true });
    return;
  }

  if (message.type === '_os_ws_send') {
    try {
      ws.send(message.payload as string);
      reply({ ok: true });
    } catch (e) {
      reply({ ok: false, error: (e as Error).message });
    }
    return;
  }

  if (message.type === '_os_ws_status') {
    reply({ state: ws.getState() } satisfies WsStatusResponse);
    return;
  }

  if (message.type === '_os_ws_reconnect') {
    if (lastConfig) {
      connectWithConfig(lastConfig.url, lastConfig.token);
    }
    reply({ ok: true });
    return;
  }

  if (message.type === '_os_ws_disconnect') {
    ws.disconnect();
    reply({ ok: true });
    return;
  }

  if (message.type === '_os_ping') {
    reply({ alive: true, wsState: ws.getState() });
    return;
  }
}

// Port path: reply via port postMessage
function handleBackgroundMessage(message: { type: string; payload?: unknown; _replyId?: string }): void {
  const replyId = message._replyId;
  handleMessage(message, (data) => {
    if (replyId) {
      const p = ensurePort();
      if (p) {
        try { p.postMessage({ type: '_os_reply', _replyId: replyId, payload: data }); } catch { /* port died */ }
      }
    }
  });
}

// sendMessage path: reply via sendResponse
chrome.runtime.onMessage.addListener(
  (message: { type: string; payload?: unknown }, _sender, sendResponse) => {
    handleMessage(message, sendResponse);
    return false;
  },
);

// ---------------------------------------------------------------------------
// WS connection
// ---------------------------------------------------------------------------

function connectWithConfig(url: string, token: string, browserName?: string): void {
  lastConfig = { url, token };
  ws.disconnect();
  ws.connect(url, token, {
    onConnected() {
      postToBackground({ type: '_os_connected' });
    },
    onDisconnected() {
      postToBackground({ type: '_os_disconnected' });
    },
    onMessage(data: string) {
      postToBackground({ type: '_os_ws_receive', payload: data });
    },
  }, browserName);
}

// ---------------------------------------------------------------------------
// Init: open port and tell background we're ready
// ---------------------------------------------------------------------------

ensurePort();
postToBackground({ type: '_os_ready' });
