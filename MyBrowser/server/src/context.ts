import type { WebSocket } from "ws";

const MESSAGE_RESPONSE_TYPE = "messageResponse";

const noBrowserMessage =
  "No browser connected. Connect a browser by installing the MyBrowser extension and entering the server address and auth token in the extension settings.";

function generateId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  const timestamp = Date.now().toString(36);
  const randomStr = Math.random().toString(36).substring(2, 10);
  return `${timestamp}-${randomStr}`;
}

// ---------------------------------------------------------------------------
// Browser connection tracking
// ---------------------------------------------------------------------------

export interface BrowserConnection {
  id: string;
  name: string;
  ws: WebSocket;
  connectedAt: number;
}

export interface BrowserInfo {
  id: string;
  name: string;
  connectedAt: number;
}

// ---------------------------------------------------------------------------
// Context — manages browser connections and routes messages
// ---------------------------------------------------------------------------

export class Context {
  public sessionId: string = "";

  // Multi-browser registry
  private browsers = new Map<string, BrowserConnection>();
  private browserCounter = 0;
  private _activeBrowserId: string | null = null;

  // Client mode: single WS to the hub (tools go through hub proxy)
  private _hubWs: WebSocket | undefined;
  private _isClientMode = false;

  // ---- Client mode (WS to hub, not direct browsers) ----

  setClientMode(ws: WebSocket): void {
    this._isClientMode = true;
    this._hubWs = ws;
  }

  clearClientWs(): void {
    this._hubWs = undefined;
  }

  get isClientMode(): boolean {
    return this._isClientMode;
  }

  // ---- Browser registry (hub mode) ----

  addBrowser(ws: WebSocket, name?: string): string {
    const id = `b${++this.browserCounter}`;
    this.browsers.set(id, {
      id,
      name: name || id,
      ws,
      connectedAt: Date.now(),
    });
    // First browser becomes the default
    if (!this._activeBrowserId) {
      this._activeBrowserId = id;
    }
    return id;
  }

  removeBrowser(id: string): void {
    this.browsers.delete(id);
    if (this._activeBrowserId === id) {
      // If only one browser remains, auto-select it. Otherwise null out.
      if (this.browsers.size === 1) {
        this._activeBrowserId = this.browsers.keys().next().value!;
      } else {
        this._activeBrowserId = null;
      }
    }
  }

  getBrowser(id: string): BrowserConnection | undefined {
    return this.browsers.get(id);
  }

  getBrowserByWs(ws: WebSocket): BrowserConnection | undefined {
    for (const browser of this.browsers.values()) {
      if (browser.ws === ws) return browser;
    }
    return undefined;
  }

  listBrowsers(): BrowserInfo[] {
    return Array.from(this.browsers.values()).map((b) => ({
      id: b.id,
      name: b.name,
      connectedAt: b.connectedAt,
    }));
  }

  hasBrowsers(): boolean {
    return this.browsers.size > 0;
  }

  get activeBrowserId(): string | null {
    return this._activeBrowserId;
  }

  setActiveBrowser(id: string): void {
    if (!this.browsers.has(id)) {
      throw new Error(`Browser "${id}" not found. Use list_browsers to see available browsers.`);
    }
    this._activeBrowserId = id;
  }

  // ---- Message routing ----

  /**
   * Get the WebSocket to send tool messages to.
   * - Hub mode: returns the active browser's WS
   * - Client mode: returns the hub WS (hub handles routing)
   */
  private getTargetWs(): WebSocket {
    if (this._isClientMode) {
      if (!this._hubWs) throw new Error(noBrowserMessage);
      return this._hubWs;
    }

    if (!this._activeBrowserId) throw new Error(noBrowserMessage);
    const browser = this.browsers.get(this._activeBrowserId);
    if (!browser) throw new Error(`Active browser "${this._activeBrowserId}" disconnected. Use list_browsers and select_browser.`);
    if (browser.ws.readyState !== browser.ws.OPEN) {
      this.removeBrowser(this._activeBrowserId);
      throw new Error(`Active browser "${this._activeBrowserId}" connection lost. Use list_browsers and select_browser.`);
    }
    return browser.ws;
  }

  async sendSocketMessage(
    type: string,
    payload: unknown,
    options: { timeoutMs: number } = { timeoutMs: 30_000 }
  ): Promise<any> {
    return this.sendSocketMessageCore(this.getTargetWs(), undefined, type, payload, options);
  }

  /**
   * Like `sendSocketMessage` but routes to a specific browser by id
   * instead of the session's active browser. Fixes multi-browser
   * handler registration where `browser_on({browserId: "B"})` would
   * otherwise push the register message to whichever browser the
   * session happened to have active (often A).
   *
   * In hub mode: looks up the target browser directly and sends to
   *   its ws.
   * In client mode: sends to the hub via `_hubWs` but tags the
   *   envelope with `targetBrowserId` so the hub's proxy honors the
   *   override instead of using the session's selected browser.
   */
  async sendSocketMessageToBrowser(
    browserId: string,
    type: string,
    payload: unknown,
    options: { timeoutMs: number } = { timeoutMs: 30_000 },
  ): Promise<any> {
    if (this._isClientMode) {
      if (!this._hubWs) throw new Error(noBrowserMessage);
      return this.sendSocketMessageCore(
        this._hubWs,
        browserId,
        type,
        payload,
        options,
      );
    }
    const browser = this.browsers.get(browserId);
    if (!browser) {
      throw new Error(
        `Browser "${browserId}" not found. Use list_browsers to see available browsers.`,
      );
    }
    if (browser.ws.readyState !== browser.ws.OPEN) {
      throw new Error(`Browser "${browserId}" connection lost`);
    }
    return this.sendSocketMessageCore(
      browser.ws,
      undefined,
      type,
      payload,
      options,
    );
  }

  private async sendSocketMessageCore(
    ws: WebSocket,
    targetBrowserId: string | undefined,
    type: string,
    payload: unknown,
    options: { timeoutMs: number },
  ): Promise<any> {
    const { timeoutMs } = options;
    const id = generateId();
    // Include targetBrowserId only when set so existing clients /
    // servers that don't understand the field still parse cleanly.
    const message: Record<string, unknown> = { id, type, payload };
    if (targetBrowserId !== undefined) {
      message.targetBrowserId = targetBrowserId;
    }

    return new Promise((resolve, reject) => {
      const cleanup = () => {
        ws.removeEventListener("message", messageHandler);
        ws.removeEventListener("error", errorHandler);
        ws.removeEventListener("close", closeHandler);
        clearTimeout(timeoutId);
      };

      const timeoutId = setTimeout(() => {
        cleanup();
        reject(new Error(`WebSocket response timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      const messageHandler = (event: { data: any }) => {
        let parsed: any;
        try {
          parsed = JSON.parse(event.data.toString());
        } catch {
          return;
        }
        if (parsed.type !== MESSAGE_RESPONSE_TYPE) return;
        if (parsed.payload?.requestId !== id) return;

        const { result, error } = parsed.payload;
        cleanup();
        if (error) {
          reject(
            new Error(
              error === "No tab is connected" ? noBrowserMessage : error
            )
          );
        } else {
          resolve(result);
        }
      };

      const errorHandler = () => {
        cleanup();
        reject(new Error("WebSocket error occurred"));
      };

      const closeHandler = () => {
        cleanup();
        reject(new Error("Browser disconnected during request"));
      };

      ws.addEventListener("message", messageHandler);
      ws.addEventListener("error", errorHandler);
      ws.addEventListener("close", closeHandler);

      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify(message));
      } else {
        cleanup();
        reject(new Error("WebSocket is not open"));
      }
    });
  }

  async close(): Promise<void> {
    if (this._isClientMode && this._hubWs) {
      this._hubWs.close();
    }
    for (const browser of this.browsers.values()) {
      browser.ws.close();
    }
    this.browsers.clear();
  }
}
