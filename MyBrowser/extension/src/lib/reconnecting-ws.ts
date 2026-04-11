// ReconnectingWebSocket with auth, heartbeat, and exponential backoff

import type { AuthMessage, PingMessage } from './protocol';

export type WsState = 'DISCONNECTED' | 'CONNECTING' | 'AUTHENTICATING' | 'CONNECTED';

export interface ReconnectingWsCallbacks {
  onConnected?: () => void;
  onDisconnected?: () => void;
  onMessage?: (data: string) => void;
}

const INITIAL_DELAY_MS = 1000;
const BACKOFF_FACTOR = 2;
const MAX_DELAY_MS = 30_000;
const JITTER = 0.2;
const HEARTBEAT_INTERVAL_MS = 15_000;
const PONG_TIMEOUT_MS = 5_000;
const AUTH_TIMEOUT_MS = 10_000;

export class ReconnectingWebSocket {
  private ws: WebSocket | null = null;
  private state: WsState = 'DISCONNECTED';
  private url = '';
  private token = '';
  private browserName = '';
  private retryDelay = INITIAL_DELAY_MS;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private authTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalClose = false;
  private callbacks: ReconnectingWsCallbacks = {};

  getState(): WsState {
    return this.state;
  }

  connect(url: string, token: string, callbacks?: ReconnectingWsCallbacks, browserName?: string): void {
    this.url = url;
    this.token = token;
    this.browserName = browserName || '';
    if (callbacks) this.callbacks = callbacks;
    this.intentionalClose = false;
    this.retryDelay = INITIAL_DELAY_MS;
    this.doConnect();
  }

  disconnect(): void {
    this.intentionalClose = true;
    this.cleanup();
    this.setState('DISCONNECTED');
  }

  send(data: string): void {
    if (this.state !== 'CONNECTED' || !this.ws) {
      throw new Error('WebSocket is not connected');
    }
    this.ws.send(data);
  }

  forceReconnect(): void {
    this.cleanup();
    this.retryDelay = INITIAL_DELAY_MS;
    this.doConnect();
  }

  private setState(s: WsState): void {
    this.state = s;
  }

  private doConnect(): void {
    this.cleanup();
    this.setState('CONNECTING');
    try {
      this.ws = new WebSocket(this.url);
    } catch {
      this.scheduleRetry();
      return;
    }

    this.ws.onopen = () => {
      this.setState('AUTHENTICATING');
      const auth: AuthMessage = {
        type: 'auth',
        token: this.token,
        role: 'extension',
        browserName: this.browserName || undefined,
      };
      this.ws!.send(JSON.stringify(auth));
      // Start auth timeout — if server doesn't confirm within AUTH_TIMEOUT_MS, reconnect
      this.authTimer = setTimeout(() => {
        this.cleanup();
        this.setState('DISCONNECTED');
        this.callbacks.onDisconnected?.();
        this.scheduleRetry();
      }, AUTH_TIMEOUT_MS);
    };

    this.ws.onmessage = (event: MessageEvent) => {
      const raw = typeof event.data === 'string' ? event.data : '';
      try {
        const parsed = JSON.parse(raw);

        // Handle auth confirmation from server
        if (parsed.type === 'auth') {
          if (this.authTimer) {
            clearTimeout(this.authTimer);
            this.authTimer = null;
          }
          if (parsed.status === 'ok' && this.state === 'AUTHENTICATING') {
            this.setState('CONNECTED');
            this.retryDelay = INITIAL_DELAY_MS;
            this.startHeartbeat();
            this.callbacks.onConnected?.();
          }
          // Don't pass auth messages through to onMessage
          return;
        }

        // Handle pong
        if (parsed.type === 'pong') {
          this.clearPongTimer();
          return;
        }
      } catch {
        // not JSON, pass through
      }

      // Only forward messages when fully connected
      if (this.state === 'CONNECTED') {
        this.callbacks.onMessage?.(raw);
      }
    };

    this.ws.onclose = () => {
      if (this.authTimer) {
        clearTimeout(this.authTimer);
        this.authTimer = null;
      }
      this.stopHeartbeat();
      const wasConnected = this.state === 'CONNECTED' || this.state === 'AUTHENTICATING';
      this.setState('DISCONNECTED');
      if (wasConnected) {
        this.callbacks.onDisconnected?.();
      }
      if (!this.intentionalClose) {
        this.scheduleRetry();
      }
    };

    this.ws.onerror = () => {
      // onclose will fire after onerror
    };
  }

  private cleanup(): void {
    this.stopHeartbeat();
    this.clearRetryTimer();
    if (this.authTimer) {
      clearTimeout(this.authTimer);
      this.authTimer = null;
    }
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
  }

  private scheduleRetry(): void {
    this.clearRetryTimer();
    const jitter = 1 + (Math.random() * 2 - 1) * JITTER;
    const delay = Math.min(this.retryDelay * jitter, MAX_DELAY_MS);
    this.retryTimer = setTimeout(() => {
      this.retryDelay = Math.min(this.retryDelay * BACKOFF_FACTOR, MAX_DELAY_MS);
      this.doConnect();
    }, delay);
  }

  private clearRetryTimer(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.state !== 'CONNECTED' || !this.ws) return;
      const ping: PingMessage = { type: 'ping' };
      try {
        this.ws.send(JSON.stringify(ping));
      } catch {
        return;
      }
      this.pongTimer = setTimeout(() => {
        // No pong received — fire onDisconnected before cleanup
        this.setState('DISCONNECTED');
        this.callbacks.onDisconnected?.();
        this.cleanup();
        this.scheduleRetry();
      }, PONG_TIMEOUT_MS);
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.clearPongTimer();
  }

  private clearPongTimer(): void {
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }
}
