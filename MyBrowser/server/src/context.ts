import type { WebSocket } from "ws";
import {
  resolveBrowserPayloadUrls,
  resolveLocalUrl,
  validateLocalUrlHost,
} from "./local-url.js";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { CONFIG_FILE } from "./auth.js";
import {
  TransferError,
  defaultTransfersRoot,
  loadTransfersConfig,
  megabytesToBytes,
  readTransfersConfig,
  type TransfersConfig,
} from "./transfers/retention.js";
import {
  MAX_CHUNK_DECODED_BYTES,
  TransferRegistry,
  newTransferId,
  type TransferChunkMessage,
} from "./transfers/registry.js";
import type { TelemetryManager } from "./telemetry/manager.js";
import type { TelemetryErrorCategory } from "./telemetry/types.js";

const MESSAGE_RESPONSE_TYPE = "messageResponse";

const noBrowserMessage =
  "No browser connected. Install the MyBrowser extension and use its first-install guide. Ordinary local setup connects automatically; hub and remote setup use the extension settings.";

function generateId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  const timestamp = Date.now().toString(36);
  const randomStr = Math.random().toString(36).substring(2, 10);
  return `${timestamp}-${randomStr}`;
}

function classifyResponseError(error: string): TelemetryErrorCategory {
  switch (error) {
    case "REQUEST_EXPIRED": return "request_expired";
    case "QUEUE_OVERLOADED": return "queue_overloaded";
    case "TAB_CLOSED": return "tab_not_found";
    case "SESSION_CLOSED": return "session_closed";
    case "EXTENSION_WORKER_RESTARTED": return "worker_restarted";
    case "No tab is connected": return "not_connected";
    default: return "extension_tool_failed";
  }
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
  readonly localUrlHost?: string;

  constructor(readonly telemetry?: TelemetryManager, localUrlHost?: string) {
    this.localUrlHost = localUrlHost === undefined ? undefined : validateLocalUrlHost(localUrlHost);
  }

  resolveNavigationUrl(url: string): string {
    return resolveLocalUrl(url, this.localUrlHost);
  }

  public sessionId: string = "";

  // Multi-browser registry
  private browsers = new Map<string, BrowserConnection>();
  private browserCounter = 0;
  private _activeBrowserId: string | null = null;

  // Client mode: single WS to the hub (tools go through hub proxy)
  private _hubWs: WebSocket | undefined;
  private _isClientMode = false;
  private _resolveTargetBrowserId: (() => Promise<string | undefined>) | undefined;
  private shuttingDown = false;
  private shutdownCancellations = new Set<() => void>();

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

  setTargetBrowserResolver(fn: () => Promise<string | undefined>): void {
    this._resolveTargetBrowserId = fn;
  }

  beginShutdown(): void {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    for (const cancel of [...this.shutdownCancellations]) cancel();
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
    // Legacy fallback only. Normal routing uses the async resolver wired
    // from server.ts: session selection → persisted default → single browser.
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

  // ---- File transfer coordination ----
  // Lazily-built download registry (direct and client modes). In hub mode the
  // ws-server owns the registry instead; this one is inert there.
  private transferState: { registry: TransferRegistry; config: TransfersConfig } | undefined;
  private readonly transferIngestSockets = new WeakSet<object>();
  // Pending transfer completions for transfer-bound tool requests whose
  // extension response arrives before reassembly finishes (hold semantics).
  private transferCompletions = new Map<string, {
    resolve: (outcome: { ok: true; result: Record<string, unknown> } | { ok: false; message: string }) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private transfersConfig: TransfersConfig | undefined;

  private getTransfersConfig(): TransfersConfig {
    if (this.transfersConfig === undefined) {
      // Throws (fail closed) when the config file carries an invalid
      // transfers section — startUploadTransfer then refuses to run.
      this.transfersConfig = readTransfersConfig(loadTransfersConfig(CONFIG_FILE));
    }
    return this.transfersConfig;
  }

  private ensureTransferState(): { registry: TransferRegistry; config: TransfersConfig } {
    if (this.transferState === undefined) {
      const config = this.getTransfersConfig();
      this.transferState = {
        registry: new TransferRegistry({ root: defaultTransfersRoot(), config }),
        config,
      };
    }
    return this.transferState;
  }

  /**
   * Attach a persistent transfer_chunk listener to a browser/hub socket so
   * download chunks are ingested even outside any single request's response
   * handler (direct and client modes; in hub mode the hub ingests instead).
   */
  private ensureTransferIngest(ws: WebSocket): void {
    if (this.transferIngestSockets.has(ws)) return;
    this.transferIngestSockets.add(ws);
    const { registry } = this.ensureTransferState();
    ws.addEventListener("message", (event: { data: unknown }) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (
        parsed === null || typeof parsed !== "object" || Array.isArray(parsed)
        || (parsed as Record<string, unknown>).type !== "transfer_chunk"
      ) {
        return;
      }
      try {
        registry.ingestChunk(parsed as TransferChunkMessage, ws);
      } catch {
        // Direct/client mode has no hub to ack through; the registry has
        // already aborted the transfer and failed the held request.
      }
    });
  }

  /** Complete a held transfer-bound request with the reassembled payload. */
  completeTransferRequest(requestId: string, result: Record<string, unknown>): void {
    const held = this.transferCompletions.get(requestId);
    if (!held) return;
    this.transferCompletions.delete(requestId);
    clearTimeout(held.timer);
    held.resolve({ ok: true, result });
  }

  /** Fail a held transfer-bound request (abort/timeout/storage failure). */
  failTransferRequest(requestId: string, message: string): void {
    const held = this.transferCompletions.get(requestId);
    if (!held) return;
    this.transferCompletions.delete(requestId);
    clearTimeout(held.timer);
    held.resolve({ ok: false, message });
  }

  // ---- Message routing ----

  /**
   * Get the WebSocket to send tool messages to.
   * - Hub mode: returns the active browser's WS
   * - Client mode: returns the hub WS (hub handles routing)
   */
  private async getTarget(): Promise<{
    ws: WebSocket;
    targetBrowserId?: string;
    telemetryBrowserId?: string;
  }> {
    const resolvedBrowserId = this._resolveTargetBrowserId
      ? await this._resolveTargetBrowserId()
      : undefined;

    if (this._isClientMode) {
      if (!this._hubWs) throw new Error(noBrowserMessage);
      return {
        ws: this._hubWs,
        targetBrowserId: resolvedBrowserId,
        telemetryBrowserId: resolvedBrowserId,
      };
    }

    const targetBrowserId = resolvedBrowserId ?? this._activeBrowserId;
    if (!targetBrowserId) throw new Error(noBrowserMessage);
    const browser = this.browsers.get(targetBrowserId);
    if (!browser) throw new Error(`Active browser "${targetBrowserId}" disconnected. Use list_browsers and select_browser.`);
    if (browser.ws.readyState !== browser.ws.OPEN) {
      this.removeBrowser(targetBrowserId);
      throw new Error(`Active browser "${targetBrowserId}" connection lost. Use list_browsers and select_browser.`);
    }
    return { ws: browser.ws, telemetryBrowserId: targetBrowserId };
  }

  async sendSocketMessage(
    type: string,
    payload: unknown,
    options: { timeoutMs: number } = { timeoutMs: 30_000 }
  ): Promise<any> {
    const target = await this.getTarget();
    return this.sendSocketMessageCore(
      target.ws,
      target.targetBrowserId,
      type,
      payload,
      options,
      target.telemetryBrowserId,
    );
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
        browserId,
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
      browserId,
    );
  }

  private holdTransferCompletion(
    requestId: string,
    timeoutMs: number,
  ): Promise<{ ok: true; result: Record<string, unknown> } | { ok: false; message: string }> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.transferCompletions.delete(requestId);
        resolve({ ok: false, message: "TRANSFER_TIMEOUT: file transfer did not complete in time" });
      }, timeoutMs);
      timer.unref?.();
      this.transferCompletions.set(requestId, { resolve, timer });
    });
  }

  private async sendSocketMessageCore(
    ws: WebSocket,
    targetBrowserId: string | undefined,
    type: string,
    payload: unknown,
    options: { timeoutMs: number },
    telemetryBrowserId: string | undefined,
  ): Promise<any> {
    if (this.shuttingDown) throw new Error("SERVER_SHUTTING_DOWN");
    const { timeoutMs } = options;
    const id = generateId();
    // Include the timeout in the envelope so a hub-mode proxy can honor
    // long-running tool calls instead of applying its default short timeout.
    // Include targetBrowserId only when set so existing clients / servers
    // that don't understand the field still parse cleanly.
    const message: Record<string, unknown> = {
      id,
      type,
      payload: resolveBrowserPayloadUrls(type, payload, this.localUrlHost),
      sessionId: this.sessionId,
      timeoutMs,
    };
    if (targetBrowserId !== undefined) {
      message.targetBrowserId = targetBrowserId;
    }
    const transport = this.telemetry?.beginTransport({
      action: type,
      browserId: telemetryBrowserId,
    });
    if (transport) message.trace = transport.trace;

    // Transfer-bound request (payload carries a transferId, e.g.
    // browser_fetch_file): register the download expectation so inbound
    // chunks are session/request-bound, ingest them on this socket, and hold
    // the caller's promise until the transfer lands.
    const payloadTransferId =
      payload !== null && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as Record<string, unknown>).transferId
        : undefined;
    const isTransferBound = typeof payloadTransferId === "string"
      && payloadTransferId.length > 0;
    const heldTransfer = isTransferBound
      ? this.holdTransferCompletion(id, timeoutMs)
      : undefined;
    if (isTransferBound && heldTransfer) {
      this.ensureTransferIngest(ws);
      const { registry } = this.ensureTransferState();
      try {
        registry.expect(
          payloadTransferId as string,
          {
            requestId: id,
            sessionId: this.sessionId,
            socket: ws,
          },
          (settlement) => {
            if (settlement.ok) {
              this.completeTransferRequest(id, { ...settlement.result });
            } else {
              this.failTransferRequest(id, `${settlement.code}: ${settlement.message}`);
            }
          },
        );
      } catch (error) {
        this.failTransferRequest(
          id,
          error instanceof Error ? error.message : "transfer rejected",
        );
      }
    }

    let serializedMessage: string;
    try {
      serializedMessage = JSON.stringify(message);
    } catch (error) {
      transport?.fail("internal_failure");
      throw error;
    }

    return new Promise((resolve, reject) => {
      const cleanup = () => {
        this.shutdownCancellations.delete(cancelForShutdown);
        ws.removeEventListener("message", messageHandler);
        ws.removeEventListener("error", errorHandler);
        ws.removeEventListener("close", closeHandler);
        clearTimeout(timeoutId);
      };

      const timeoutId = setTimeout(() => {
        cleanup();
        transport?.fail("timeout");
        reject(new Error(`WebSocket response timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      const messageHandler = (event: { data: any }) => {
        let parsed: any;
        let rawResponse: string;
        try {
          rawResponse = event.data.toString();
          parsed = JSON.parse(rawResponse);
        } catch {
          return;
        }
        if (parsed.type !== MESSAGE_RESPONSE_TYPE) return;
        if (parsed.payload?.requestId !== id) return;

        const responsePayload = parsed.payload as Record<string, unknown>;
        try {
          const telemetryDescriptor = Object.getOwnPropertyDescriptor(responsePayload, "telemetry");
          if (telemetryDescriptor && "value" in telemetryDescriptor) {
            transport?.acceptExtensionTelemetry(telemetryDescriptor.value, id, timeoutMs);
            delete responsePayload.telemetry;
          }
        } catch {
          // Optional extension telemetry cannot affect tool resolution.
        }
        const { result, error } = responsePayload as { result?: unknown; error?: string };
        const responseBytes = Buffer.byteLength(rawResponse);
        cleanup();
        if (error) {
          transport?.fail(classifyResponseError(error));
          reject(
            new Error(
              error === "No tab is connected" ? noBrowserMessage : error
            )
          );
        } else {
          transport?.complete(
            responseBytes,
            Object.prototype.hasOwnProperty.call(responsePayload, "result"),
          );
          if (heldTransfer) {
            // The extension acknowledged the fetch before reassembly
            // finished: hold the caller until the transfer settles, then
            // resolve with the reassembled payload.
            heldTransfer.then((outcome) => {
              if (outcome.ok) resolve(outcome.result);
              else reject(new Error(outcome.message));
            });
            return;
          }
          resolve(result);
        }
      };

      const errorHandler = () => {
        cleanup();
        transport?.fail("not_connected");
        reject(new Error("WebSocket error occurred"));
      };

      const closeHandler = () => {
        cleanup();
        transport?.fail("not_connected");
        reject(new Error("Browser disconnected during request"));
      };

      const cancelForShutdown = () => {
        cleanup();
        transport?.fail("session_closed");
        reject(new Error("SERVER_SHUTTING_DOWN"));
      };

      ws.addEventListener("message", messageHandler);
      ws.addEventListener("error", errorHandler);
      ws.addEventListener("close", closeHandler);
      this.shutdownCancellations.add(cancelForShutdown);

      if (ws.readyState === ws.OPEN) {
        try {
          ws.send(serializedMessage);
        } catch (error) {
          cleanup();
          transport?.fail("internal_failure");
          reject(error);
        }
      } else {
        cleanup();
        transport?.fail("not_connected");
        reject(new Error("WebSocket is not open"));
      }
    });
  }

  // ---- Upload transfers (hub/client → extension) ----

  /**
   * Upload local files to the connected browser extension for a pending
   * tool request (browser_upload with localFiles). Enforces the configured
   * per-file maxFileMb cap, computes sha256, then sends transfer_begin +
   * transfer_chunk frames over the tool socket (client mode: the hub socket,
   * which relays to the extension) honoring a ≤4-chunk ack window. The
   * extension acks each frame with transfer_ack; any ok:false aborts.
   */
  async startUploadTransfer(
    requestId: string,
    files: ReadonlyArray<{ path: string; filename?: string; mimeType?: string }>,
    target: { tabId?: number; selector: string },
    options: { timeoutMs?: number } = {},
  ): Promise<{ files: Array<{ name: string; size: number; sha256: string }> }> {
    if (typeof requestId !== "string" || requestId.length === 0) {
      throw new Error("startUploadTransfer: requestId is required");
    }
    if (!Array.isArray(files) || files.length === 0) {
      throw new Error("startUploadTransfer: at least one file is required");
    }
    if (typeof target?.selector !== "string" || target.selector.length === 0) {
      throw new Error("startUploadTransfer: target.selector is required");
    }
    const config = this.getTransfersConfig();
    const maxFileBytes = megabytesToBytes(config.maxFileMb);
    const timeoutMs = options.timeoutMs ?? 300_000;

    const { ws } = await this.getTarget();
    const prepared = files.map((file) => {
      const localPath = typeof file?.path === "string" ? file.path : "";
      if (!localPath) {
        throw new Error("startUploadTransfer: each file requires a path on the MCP server machine");
      }
      let stats;
      try {
        stats = statSync(localPath);
      } catch {
        throw new Error(`startUploadTransfer: file must exist on the MCP server machine: ${localPath}`);
      }
      if (!stats.isFile()) {
        throw new Error(`startUploadTransfer: not a regular file on the MCP server machine: ${localPath}`);
      }
      const bytes = readFileSync(localPath);
      if (bytes.length > maxFileBytes) {
        throw new Error(
          `startUploadTransfer: ${basename(localPath)} is ${bytes.length} bytes, exceeding the configured maxFileMb cap of ${config.maxFileMb} MiB`,
        );
      }
      return {
        name: typeof file.filename === "string" && file.filename.length > 0
          ? file.filename
          : basename(localPath),
        mimeType: typeof file.mimeType === "string" && file.mimeType.length > 0
          ? file.mimeType
          : "application/octet-stream",
        bytes,
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    });

    const deadline = Date.now() + timeoutMs;
    const uploaded: Array<{ name: string; size: number; sha256: string }> = [];
    for (let fileIndex = 0; fileIndex < prepared.length; fileIndex++) {
      const file = prepared[fileIndex]!;
      const chunks: string[] = [];
      for (let offset = 0; offset < file.bytes.length; offset += MAX_CHUNK_DECODED_BYTES) {
        chunks.push(file.bytes.subarray(offset, offset + MAX_CHUNK_DECODED_BYTES).toString("base64"));
      }
      const transferId = newTransferId();
      await this.runUploadHandshake(ws, {
        type: "transfer_begin",
        v: 2,
        transferId,
        requestId,
        direction: "upload",
        fileIndex,
        fileCount: prepared.length,
        filename: file.name,
        mimeType: file.mimeType,
        totalBytes: file.size,
        totalChunks: chunks.length,
        sha256: file.sha256,
        ...(target.tabId === undefined ? {} : { targetTabId: target.tabId }),
        selector: target.selector,
      }, chunks, deadline);
      uploaded.push({ name: file.name, size: file.size, sha256: file.sha256 });
    }
    return { files: uploaded };
  }

  /**
   * Send transfer_begin, await its transfer_ack, then stream chunks with at
   * most 4 in flight. The first ok:false ack (or a send error / deadline)
   * aborts with a TransferError-carrying message.
   */
  private runUploadHandshake(
    ws: WebSocket,
    begin: Record<string, unknown>,
    chunks: string[],
    deadline: number,
  ): Promise<void> {
    const transferId = begin.transferId as string;
    const requestId = begin.requestId as string;
    const transferMeta = {
      totalChunks: begin.totalChunks as number,
      totalBytes: begin.totalBytes as number,
      sha256: begin.sha256 as string,
      filename: begin.filename as string,
      mimeType: begin.mimeType as string,
    };
    return new Promise<void>((resolveHandshake, rejectHandshake) => {
      const pending = new Set<number>();
      for (let seq = 0; seq < chunks.length; seq++) pending.add(seq);
      let settled = false;
      let nextSeq = 0;
      let inFlight = 0;
      let sawBeginAck = false;

      const cleanup = () => {
        ws.removeEventListener("message", onMessage);
        clearTimeout(deadlineTimer);
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        rejectHandshake(error);
      };
      const deadlineTimer = setTimeout(() => {
        fail(new TransferError("TRANSFER_TIMEOUT", `upload ${transferId} did not complete in time`));
      }, Math.max(0, deadline - Date.now()));
      deadlineTimer.unref?.();

      const sendFrame = (frame: Record<string, unknown>) => {
        try {
          ws.send(JSON.stringify(frame));
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      };
      const sendChunk = (seq: number) => {
        inFlight += 1;
        sendFrame({
          type: "transfer_chunk",
          v: 2,
          transferId,
          requestId,
          seq,
          ...transferMeta,
          bytesBase64: chunks[seq] as string,
        });
      };
      const fillWindow = () => {
        if (settled) return;
        while (inFlight < 4 && nextSeq < chunks.length) {
          sendChunk(nextSeq);
          nextSeq += 1;
        }
      };

      const onMessage = (event: { data: unknown }) => {
        let parsed: any;
        try {
          parsed = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (parsed?.type !== "transfer_ack" || parsed.transferId !== transferId) return;
        if (parsed.ok !== true) {
          fail(new TransferError(
            "TRANSFER_REJECTED",
            typeof parsed.message === "string" && parsed.message.length > 0
              ? parsed.message
              : `upload ${transferId} rejected by the browser`,
          ));
          return;
        }
        if (!sawBeginAck) {
          sawBeginAck = true;
          fillWindow();
          if (!settled && pending.size === 0 && nextSeq >= chunks.length) {
            // Zero-chunk (empty) file: the begin ack completes it.
            settled = true;
            cleanup();
            resolveHandshake();
          }
          return;
        }
        pending.delete(parsed.seq);
        inFlight = Math.max(0, inFlight - 1);
        if (pending.size === 0 && nextSeq >= chunks.length) {
          settled = true;
          cleanup();
          resolveHandshake();
          return;
        }
        fillWindow();
      };
      ws.addEventListener("message", onMessage);
      sendFrame(begin);
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
