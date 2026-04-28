import { WebSocketServer, WebSocket } from "ws";
import { z } from "zod";
import type { Context } from "./context.js";
import { saveRecordingToFile } from "./tools/record.js";
import { saveNote, listNotes } from "./notes.js";
import { LocalStateManager, type IStateManager } from "./state-manager.js";
import { HubStateManager } from "./hub-client.js";
import { recordIssue } from "./logger.js";
import net from "node:net";

// Hard cap on incoming WS frames: notes can carry a base64 PNG, but nothing
// else this server handles is remotely this large. 32 MB covers a ~20 MB
// binary PNG with base64 overhead plus JSON envelope.
const MAX_WS_PAYLOAD_BYTES = 32 * 1024 * 1024;

// Runtime schema for saveNote payloads coming from the extension. We trust
// the connection (authenticated + isExtension) but not the shape of the data.
const SaveNotePayloadSchema = z.object({
  url: z.string().max(2000),
  title: z.string().max(500),
  note: z.string().max(4000),
  pngBase64: z.string().min(1),
  viewport: z
    .object({
      width: z.number().finite().nonnegative(),
      height: z.number().finite().nonnegative(),
      scrollX: z.number().finite(),
      scrollY: z.number().finite(),
      dpr: z.number().finite().positive(),
    })
    .optional(),
  nearestElement: z
    .object({
      ref: z.string().max(200).optional(),
      role: z.string().max(100).optional(),
      name: z.string().max(500).optional(),
      tagName: z.string().max(50).optional(),
    })
    .optional(),
});

export interface WsServerOptions {
  host: string;
  port: number;
  token: string;
  context: Context;
}

export interface WsServerResult {
  close: () => void;
  stateManager: IStateManager;
  isHub: boolean;
  /** Register a callback to be called when a client reconnects to the hub */
  onReconnect?: (cb: () => Promise<void>) => void;
}

const CLIENT_TIMEOUT_MS = 45_000;      // MCP clients: 45s inactivity → disconnect
const BROWSER_TIMEOUT_MS = 120_000;    // Browser extensions: 120s (8 missed heartbeats)
const LIVENESS_SWEEP_INTERVAL_MS = 30_000; // Hub pings all connections every 30s
const SESSION_RECONNECT_GRACE_MS = 15_000;
const CLIENT_HEARTBEAT_INTERVAL_MS = 15_000;
const CLIENT_HEARTBEAT_TIMEOUT_MS = 10_000;
const MESSAGE_RESPONSE_TYPE = "messageResponse";

/** Send without throwing if the socket is gone or buffer full. */
function safeSend(ws: WebSocket, payload: unknown): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(payload));
  } catch (e) {
    console.error("[MyBrowser MCP] ws.send failed:", e);
  }
}

/**
 * Create a WS connection to the browser extension(s).
 *
 * Strategy:
 * 1. Try to start a WS SERVER on the configured port (first instance = hub)
 * 2. If port is taken, connect as a WS CLIENT to the existing hub server
 *
 * Hub mode supports multiple browser extensions simultaneously.
 * Client processes route tools through the hub to the correct browser.
 */
export async function createWebSocketServer(
  options: WsServerOptions,
): Promise<WsServerResult> {
  const portInUse = await isPortInUse(options.port);

  if (portInUse) {
    console.error(
      `[MyBrowser MCP] Port ${options.port} already in use — connecting as client to existing hub`,
    );
    return connectAsClient(options);
  }

  return startServer(options);
}

function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(true));
    server.once("listening", () => {
      server.close(() => resolve(false));
    });
    server.listen(port);
  });
}

// =========================================================================
// Hub RPC dispatcher
// =========================================================================

function requireString(params: Record<string, unknown>, key: string): string {
  const val = params[key];
  if (typeof val !== "string") throw new Error(`${key} must be a string`);
  return val;
}

async function dispatchHubRpc(
  stateManager: LocalStateManager,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  switch (method) {
    // -- Sessions --
    case "registerSession":
      await stateManager.registerSession(
        requireString(params, "sessionId"),
        typeof params.name === "string" ? params.name : undefined,
      );
      return { ok: true };
    case "removeSession":
      await stateManager.removeSession(requireString(params, "sessionId"));
      return { ok: true };
    case "touchSession":
      await stateManager.touchSession(requireString(params, "sessionId"));
      return { ok: true };
    case "listSessions":
      return await stateManager.listSessions();

    // -- Tab ownership (composite string keys) --
    case "claimTab":
      return await stateManager.claimTab(
        requireString(params, "sessionId"),
        requireString(params, "tabKey"),
      );
    case "releaseTab":
      return await stateManager.releaseTab(
        requireString(params, "sessionId"),
        requireString(params, "tabKey"),
      );
    case "transferTab":
      return await stateManager.transferTab(
        requireString(params, "fromSessionId"),
        requireString(params, "toSessionId"),
        requireString(params, "tabKey"),
      );
    case "releaseAllTabs":
      await stateManager.releaseAllTabs(requireString(params, "sessionId"));
      return { ok: true };
    case "isTabAvailable":
      return await stateManager.isTabAvailable(
        requireString(params, "tabKey"),
        requireString(params, "sessionId"),
      );
    case "getTabOwner":
      return await stateManager.getTabOwner(requireString(params, "tabKey"));
    case "shouldEnforceOwnership":
      return await stateManager.shouldEnforceOwnership();
    case "getSessionName":
      return await stateManager.getSessionName(requireString(params, "sessionId"));

    // -- Browser targeting --
    case "selectBrowser":
      await stateManager.selectBrowser(
        requireString(params, "sessionId"),
        requireString(params, "browserId"),
      );
      return { ok: true };
    case "getSessionBrowser":
      return await stateManager.getSessionBrowser(requireString(params, "sessionId"));
    case "listBrowsers":
      return await stateManager.listBrowsers();

    // -- Shared state --
    case "sharedGet":
      return await stateManager.sharedGet(requireString(params, "key"));
    case "sharedSet":
      await stateManager.sharedSet(requireString(params, "key"), params.value);
      return { ok: true };
    case "sharedDelete":
      return await stateManager.sharedDelete(requireString(params, "key"));
    case "sharedList":
      return await stateManager.sharedList();

    // -- Annotation notes --
    case "notesList": {
      const status =
        typeof params.status === "string"
          ? (params.status as "pending" | "archived" | "all")
          : "pending";
      return await stateManager.notesList(status);
    }
    case "notesGet":
      return await stateManager.notesGet(requireString(params, "id"));
    case "notesArchive": {
      const resolution =
        typeof params.resolution === "string" ? params.resolution : undefined;
      return await stateManager.notesArchive(
        requireString(params, "id"),
        resolution,
      );
    }
    case "notesUnarchive":
      return await stateManager.notesUnarchive(requireString(params, "id"));
    case "notesDelete":
      return await stateManager.notesDelete(
        requireString(params, "id"),
        params.force === true,
      );

    // -- Event handlers (F1 browser_on) --
    case "registerEventHandler":
      return await stateManager.registerEventHandler(
        requireString(params, "sessionId"),
        requireString(params, "browserId"),
        requireString(params, "event") as
          | "dialog"
          | "beforeunload"
          | "new_tab"
          | "network_timeout",
        requireString(params, "action") as
          | "dismiss"
          | "accept"
          | "emit"
          | "ignore",
        params.options as Record<string, unknown> | undefined,
      );
    case "unregisterEventHandler":
      return await stateManager.unregisterEventHandler(
        requireString(params, "sessionId"),
        requireString(params, "handlerId"),
      );
    case "listEventHandlers":
      return await stateManager.listEventHandlers(
        requireString(params, "sessionId"),
        typeof params.browserId === "string" ? params.browserId : undefined,
      );
    case "clearEventHandlersForSession":
      await stateManager.clearEventHandlersForSession(
        requireString(params, "sessionId"),
      );
      return { ok: true };
    case "clearEventHandlersForBrowser":
      await stateManager.clearEventHandlersForBrowser(
        requireString(params, "browserId"),
      );
      return { ok: true };
    case "hasMatchingEventHandler":
      return await stateManager.hasMatchingEventHandler(
        requireString(params, "sessionId"),
        requireString(params, "browserId"),
        requireString(params, "event") as
          | "dialog"
          | "beforeunload"
          | "new_tab"
          | "network_timeout",
        requireString(params, "queueName"),
      );
    case "pushEvent":
      await stateManager.pushEvent(
        requireString(params, "sessionId"),
        requireString(params, "browserId"),
        requireString(params, "event") as
          | "dialog"
          | "beforeunload"
          | "new_tab"
          | "network_timeout",
        requireString(params, "queueName"),
        params.data,
        typeof params.tabId === "number" ? params.tabId : undefined,
      );
      return { ok: true };
    case "waitForEvent":
      return await stateManager.waitForEvent(
        requireString(params, "sessionId"),
        requireString(params, "queueName"),
        typeof params.timeoutMs === "number" ? params.timeoutMs : 30_000,
      );

    // -- F3: named mutexes --
    case "acquireLock":
      return await stateManager.acquireLock(
        requireString(params, "sessionId"),
        requireString(params, "name"),
        typeof params.timeoutMs === "number" ? params.timeoutMs : 30_000,
        typeof params.ttlMs === "number" ? params.ttlMs : undefined,
      );
    case "releaseLock":
      return await stateManager.releaseLock(
        requireString(params, "sessionId"),
        requireString(params, "name"),
      );
    case "listLocks":
      return await stateManager.listLocks();
    case "releaseLocksForSession":
      await stateManager.releaseLocksForSession(
        requireString(params, "sessionId"),
      );
      return { ok: true };

    default:
      throw new Error(`Unknown hub RPC method: ${method}`);
  }
}

// =========================================================================
// Hub mode — multi-browser support
// =========================================================================

function startServer(options: WsServerOptions): WsServerResult {
  const { host, port, token, context } = options;
  const stateManager = new LocalStateManager();

  // Wire up browser listing to context
  stateManager.setListBrowsersFn(() => context.listBrowsers());

  /**
   * Teardown for a session. Each step is independent — a failure in
   * one must not skip the others, otherwise the hub can leak state.
   * Errors are captured and re-thrown at the end so callers still see
   * the first failure, but cleanup runs to completion first.
   *
   * Note: `clearEventHandlersForSession` already broadcasts the
   * session-scoped unregister to all connected browsers via the
   * broadcaster installed above, so this cleanup path does not
   * need a separate broadcast step.
   */
  async function cleanupSession(sessionId: string): Promise<void> {
    const errors: unknown[] = [];
    const step = async (fn: () => Promise<unknown> | unknown): Promise<void> => {
      try {
        await fn();
      } catch (e) {
        errors.push(e);
      }
    };
    await step(() => stateManager.releaseAllTabs(sessionId));
    await step(() => stateManager.releaseLocksForSession(sessionId));
    await step(() => stateManager.clearEventHandlersForSession(sessionId));
    await step(() => stateManager.removeSession(sessionId));
    if (errors.length > 0) {
      throw new AggregateError(errors, `cleanupSession(${sessionId})`);
    }
  }

  // Track sessionId per MCP client WS for cleanup
  const connectionSessions = new Map<WebSocket, string>();
  // Track browserId per extension WS for cleanup
  const connectionBrowsers = new Map<WebSocket, string>();
  const pendingSessionCleanup = new Map<string, ReturnType<typeof setTimeout>>();

  function cancelSessionCleanup(sessionId: string): void {
    const timer = pendingSessionCleanup.get(sessionId);
    if (!timer) return;
    clearTimeout(timer);
    pendingSessionCleanup.delete(sessionId);
  }

  function isSessionStillConnected(sessionId: string): boolean {
    for (const connectedSessionId of connectionSessions.values()) {
      if (connectedSessionId === sessionId) return true;
    }
    return false;
  }

  function scheduleSessionCleanup(
    sessionId: string,
    delayMs = SESSION_RECONNECT_GRACE_MS,
  ): void {
    cancelSessionCleanup(sessionId);
    pendingSessionCleanup.set(
      sessionId,
      setTimeout(() => {
        pendingSessionCleanup.delete(sessionId);
        if (isSessionStillConnected(sessionId)) return;
        clientBrowserTarget.delete(sessionId);
        cleanupSession(sessionId)
          .then(() => console.error(`[MyBrowser MCP] Client session "${sessionId}" cleaned up`))
          .catch((err) => console.error("Session cleanup failed:", err));
      }, delayMs),
    );
  }

  // Wire up a raw-WS broadcaster the state manager can call during
  // session cleanup to drop extension-side handler mirrors. This
  // avoids relying on `context.activeBrowserId` which may not be set
  // for sessions that registered handlers via implicit single-browser
  // resolution.
  stateManager.setBroadcastToBrowsersFn((type, payload) => {
    const msg = JSON.stringify({
      id: `bcast_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`,
      type,
      payload,
    });
    for (const browserWs of connectionBrowsers.keys()) {
      if (browserWs.readyState !== WebSocket.OPEN) continue;
      try {
        browserWs.send(msg);
      } catch {
        /* best-effort — the browser may be mid-close */
      }
    }
  });
  // Track target browser per MCP client session for routing
  const clientBrowserTarget = new Map<string, string>();

  const wss = new WebSocketServer({
    host,
    port,
    perMessageDeflate: { threshold: 1024 },
    maxPayload: MAX_WS_PAYLOAD_BYTES,
  });

  // ----- Hub-side liveness sweep -----
  // Periodically ping all connections via WS protocol-level ping.
  // If a connection didn't respond to the previous ping, it's dead — close it.
  const awaitingPong = new Set<WebSocket>();

  const livenessSweep = setInterval(() => {
    for (const client of wss.clients) {
      if (awaitingPong.has(client)) {
        // Didn't respond to last ping — dead connection
        recordIssue({
          level: "warn",
          area: "connection",
          message: "Dead WebSocket connection detected with no pong; closing",
        });
        console.error(`[MyBrowser MCP] Dead connection detected (no pong) — closing`);
        client.terminate();
        awaitingPong.delete(client);
        continue;
      }
      if (client.readyState === WebSocket.OPEN) {
        awaitingPong.add(client);
        client.ping();
      }
    }

    // Purge stale entries from tracking maps
    for (const [ws, sessionId] of connectionSessions) {
      if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
        connectionSessions.delete(ws);
        scheduleSessionCleanup(sessionId);
      }
    }
    for (const [ws, browserId] of connectionBrowsers) {
      if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
        connectionBrowsers.delete(ws);
        if (context.getBrowser(browserId)) {
          context.removeBrowser(browserId);
        }
      }
    }
  }, LIVENESS_SWEEP_INTERVAL_MS);

  wss.on("connection", (ws: WebSocket) => {
    let authenticated = false;
    let isExtension = false;
    let activityTimer: ReturnType<typeof setTimeout>;
    let timeoutMs = CLIENT_TIMEOUT_MS; // Default to client timeout, updated on auth

    const resetActivityTimer = () => {
      clearTimeout(activityTimer);
      activityTimer = setTimeout(() => {
        ws.close(4002, `Dead connection: no activity for ${timeoutMs / 1000}s`);
      }, timeoutMs);
    };

    // Clear pong tracking on any pong received
    ws.on("pong", () => {
      awaitingPong.delete(ws);
      resetActivityTimer();
    });

    resetActivityTimer();

    ws.on("message", (data: Buffer | string) => {
      resetActivityTimer();

      let msg: any;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        ws.close(4003, "Invalid JSON");
        return;
      }

      // ---- Auth ----
      if (!authenticated) {
        if (msg.type === "auth" && msg.token === token) {
          authenticated = true;

          // Backward compat: treat as browser unless explicitly role: "client"
          const isClient = msg.role === "client";

          if (!isClient) {
            const browserId = context.addBrowser(ws, msg.browserName);
            isExtension = true;
            timeoutMs = BROWSER_TIMEOUT_MS; // Browsers get longer timeout
            resetActivityTimer(); // Reset with new timeout
            connectionBrowsers.set(ws, browserId);
            ws.send(JSON.stringify({ type: "auth", status: "ok", browserId }));
            recordIssue({
              level: "info",
              area: "extension_connect",
              message: `Browser "${msg.browserName || browserId}" connected as ${browserId}`,
              browserId,
            });
            console.error(`[MyBrowser MCP] Browser "${msg.browserName || browserId}" connected as ${browserId}`);
          } else {
            isExtension = false;
            ws.send(JSON.stringify({ type: "auth", status: "ok" }));
            console.error(`[MyBrowser MCP] MCP client connected`);
          }
        } else {
          ws.close(4001, "Unauthorized");
        }
        return;
      }

      // ---- Ping ----
      if (msg.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
        return;
      }

      // ---- Hub RPC (from MCP client processes) ----
      if (msg.type === "hub_rpc" && msg.id && msg.method) {
        // Handle selectBrowser specially to update client routing
        if (msg.method === "selectBrowser" && msg.params?.sessionId && msg.params?.browserId) {
          clientBrowserTarget.set(msg.params.sessionId as string, msg.params.browserId as string);
        }

        dispatchHubRpc(stateManager, msg.method, msg.params ?? {})
          .then((result) => {
            ws.send(JSON.stringify({ type: "hub_rpc_result", id: msg.id, result }));
          })
          .catch((err) => {
            ws.send(JSON.stringify({
              type: "hub_rpc_result",
              id: msg.id,
              error: err instanceof Error ? err.message : String(err),
            }));
          });

        // Track session registration for cleanup
        if (msg.method === "registerSession" && msg.params?.sessionId) {
          const newSessionId = msg.params.sessionId as string;
          cancelSessionCleanup(newSessionId);
          const prev = connectionSessions.get(ws);
          if (prev && prev !== newSessionId) {
            scheduleSessionCleanup(prev, 0);
          }
          connectionSessions.set(ws, newSessionId);
        }
        return;
      }

      // ---- SaveRecording from extension ----
      if (msg.type === "saveRecording" && msg.payload) {
        try {
          saveRecordingToFile(msg.payload as { name: string; [key: string]: unknown });
        } catch (e) {
          console.error("Failed to save recording:", e);
        }
        return;
      }

      // ---- EventEmitted from extension (F1 browser_on action=emit) ----
      // Extension fires an event; the hub must:
      //   1. Accept only from browser extensions (not MCP clients)
      //   2. Override browserId with the SENDING browser's id (not
      //      whatever the payload claims) so a compromised browser
      //      can't forge cross-browser emits
      //   3. Validate that a matching handler actually exists with
      //      the claimed (sessionId, event, queueName). Without this
      //      check, any browser could inject events into any
      //      session's waiter queue.
      if (msg.type === "eventEmitted" && msg.payload) {
        if (!isExtension) return;
        const p = msg.payload as {
          sessionId?: string;
          event?: "dialog" | "beforeunload" | "new_tab" | "network_timeout";
          queueName?: string;
          data?: unknown;
          tabId?: number;
        };
        // Always use the sender's actual browserId. The payload is
        // never trusted to set this — a browser can only emit events
        // for itself.
        const browserId = connectionBrowsers.get(ws);
        if (
          !browserId ||
          !p.sessionId ||
          !p.event ||
          typeof p.queueName !== "string"
        ) {
          return;
        }
        // Look up the handler state BEFORE pushing. Silent drop on
        // mismatch so probing for other sessions' queues yields
        // nothing observable to the sender.
          stateManager
            .hasMatchingEventHandler(
            p.sessionId,
            browserId,
            p.event,
            p.queueName,
          )
          .then((hasMatch) => {
            if (!hasMatch) {
              recordIssue({
                level: "warn",
                area: "event_handler",
                message: `Dropped eventEmitted with no matching handler for session=${p.sessionId} browser=${browserId} event=${p.event} queue=${p.queueName}`,
                sessionId: p.sessionId,
                browserId,
              });
              console.error(
                `[MyBrowser MCP] dropped eventEmitted: no matching handler for session=${p.sessionId} browser=${browserId} event=${p.event} queue=${p.queueName}`,
              );
              return;
            }
            return stateManager.pushEvent(
              p.sessionId!,
              browserId,
              p.event!,
              p.queueName!,
              p.data,
              typeof p.tabId === "number" ? p.tabId : undefined,
            );
          })
          .catch((e) =>
            console.error("[MyBrowser MCP] eventEmitted handler failed:", e),
          );
        return;
      }

      // ---- QueryNotesCount from extension (popup badge) ----
      // Only browser-extension connections may query note counts. Rejects
      // quietly for MCP clients so a misbehaving tool can't probe state.
      if (msg.type === "queryNotesCount" && msg.id) {
        if (!isExtension) return;
        try {
          const pending = listNotes("pending").length;
          const archived = listNotes("archived").length;
          safeSend(ws, {
            type: "queryNotesCountResult",
            id: msg.id,
            ok: true,
            pending,
            archived,
          });
        } catch (e) {
          recordIssue({
            level: "error",
            area: "notes",
            message: "queryNotesCount failed",
            details: e,
          });
          console.error("[MyBrowser MCP] queryNotesCount failed:", e);
          safeSend(ws, {
            type: "queryNotesCountResult",
            id: msg.id,
            ok: false,
            error: "query failed",
          });
        }
        return;
      }

      // ---- SaveNote from extension (draw-and-share annotation) ----
      // Extension-only: any authenticated MCP client is rejected.
      if (msg.type === "saveNote" && msg.payload) {
        if (!isExtension) return;
        try {
          const parsed = SaveNotePayloadSchema.parse(msg.payload);
          const metadata = saveNote(parsed);
          const pendingCount = listNotes("pending").length;
          if (msg.id) {
            safeSend(ws, {
              type: "saveNoteResult",
              id: msg.id,
              ok: true,
              noteId: metadata.id,
              pendingCount,
            });
          }
          console.error(
            `[MyBrowser MCP] Note saved: ${metadata.id} (${pendingCount} pending)`,
          );
        } catch (e) {
          const errMsg = e instanceof Error ? e.message : String(e);
          recordIssue({
            level: "error",
            area: "notes",
            message: `Failed to save note: ${errMsg}`,
            details: e,
          });
          console.error("[MyBrowser MCP] Failed to save note:", errMsg);
          if (msg.id) {
            // Don't leak internal error details to the client
            safeSend(ws, {
              type: "saveNoteResult",
              id: msg.id,
              ok: false,
              error:
                e instanceof z.ZodError ? "invalid payload" : "save failed",
            });
          }
        }
        return;
      }

      // ---- Tool request proxy (MCP client → browser) ----
      if (!isExtension && msg.id && msg.type) {
        // If the client specified an explicit target via
        // `targetBrowserId` (used by F1 handler push to the correct
        // browser), honor it; otherwise fall back to the session's
        // selected browser.
        const clientSessionId = connectionSessions.get(ws);
        const explicitTarget =
          typeof msg.targetBrowserId === "string"
            ? msg.targetBrowserId
            : undefined;
        let resolvedBrowserId: string | undefined =
          explicitTarget ??
          (clientSessionId
            ? clientBrowserTarget.get(clientSessionId)
            : undefined);

        if (!resolvedBrowserId) {
          // Auto-assign if exactly one browser exists
          const browsers = context.listBrowsers();
          if (browsers.length === 1) {
            resolvedBrowserId = browsers[0]!.id;
            if (clientSessionId) clientBrowserTarget.set(clientSessionId, resolvedBrowserId);
          } else {
            try {
              ws.send(JSON.stringify({
                type: MESSAGE_RESPONSE_TYPE,
                payload: {
                  requestId: msg.id,
                  error: browsers.length === 0
                    ? "No browser connected"
                    : "No browser selected for this session. Use select_browser to choose one.",
                },
              }));
            } catch { /* client gone */ }
            return;
          }
        }

        const browser = context.getBrowser(resolvedBrowserId);
        if (!browser || browser.ws.readyState !== WebSocket.OPEN) {
          recordIssue({
            level: "warn",
            area: "proxy",
            message: `Browser "${resolvedBrowserId}" is disconnected while proxying ${msg.type}`,
            browserId: resolvedBrowserId,
            toolName: typeof msg.type === "string" ? msg.type : undefined,
            sessionId: clientSessionId,
          });
          try {
            ws.send(JSON.stringify({
              type: MESSAGE_RESPONSE_TYPE,
              payload: {
                requestId: msg.id,
                error: `Browser "${resolvedBrowserId}" is disconnected. Use list_browsers and select_browser.`,
              },
            }));
          } catch { /* client gone */ }
          return;
        }

        const browserWs = browser.ws;
        browserWs.send(JSON.stringify(msg));

        // Full cleanup — removes all listeners and clears timeout
        let settled = false;
        const cleanup = () => {
          if (settled) return;
          settled = true;
          browserWs.removeListener("message", responseHandler);
          browserWs.removeListener("close", closeHandler);
          ws.removeListener("close", clientCloseHandler);
          clearTimeout(proxyTimeout);
        };

        const safeSendToClient = (data: string) => {
          try { ws.send(data); } catch { /* client gone */ }
        };

        const responseHandler = (respData: Buffer | string) => {
          let resp: any;
          try { resp = JSON.parse(respData.toString()); } catch { return; }
          if (resp.type === MESSAGE_RESPONSE_TYPE && resp.payload?.requestId === msg.id) {
            cleanup();
            safeSendToClient(JSON.stringify(resp));
          }
        };

        const closeHandler = () => {
          cleanup();
          recordIssue({
            level: "warn",
            area: "proxy",
            message: `Browser disconnected during proxied request ${msg.type}`,
            browserId: resolvedBrowserId,
            toolName: typeof msg.type === "string" ? msg.type : undefined,
            sessionId: clientSessionId,
          });
          safeSendToClient(JSON.stringify({
            type: MESSAGE_RESPONSE_TYPE,
            payload: { requestId: msg.id, error: "Browser disconnected during request" },
          }));
        };

        // Clean up if client disconnects during proxy
        const clientCloseHandler = () => { cleanup(); };
        ws.once("close", clientCloseHandler);

        // 28s timeout (shorter than client's 30s) so proxy always responds first
        const proxyTimeout = setTimeout(() => {
          cleanup();
          recordIssue({
            level: "error",
            area: "proxy",
            message: `Browser response timeout for proxied request ${msg.type}`,
            browserId: resolvedBrowserId,
            toolName: typeof msg.type === "string" ? msg.type : undefined,
            sessionId: clientSessionId,
          });
          safeSendToClient(JSON.stringify({
            type: MESSAGE_RESPONSE_TYPE,
            payload: { requestId: msg.id, error: "Browser response timeout" },
          }));
        }, 28_000);

        browserWs.on("message", responseHandler);
        browserWs.once("close", closeHandler);

        return;
      }
    });

    ws.on("close", () => {
      clearTimeout(activityTimer);

      // Clean up MCP client session
      const closedSessionId = connectionSessions.get(ws);
      if (closedSessionId) {
        connectionSessions.delete(ws);
        scheduleSessionCleanup(closedSessionId);
        console.error(
          `[MyBrowser MCP] Client session "${closedSessionId}" disconnected — waiting ${SESSION_RECONNECT_GRACE_MS / 1000}s for reconnect before cleanup`,
        );
      }

      // Clean up browser extension
      const closedBrowserId = connectionBrowsers.get(ws);
      if (closedBrowserId) {
        connectionBrowsers.delete(ws);
        context.removeBrowser(closedBrowserId);
        // F1: clear all event handlers registered against this browser.
        // Session-scoped per the design — a fresh connection starts clean.
        stateManager
          .clearEventHandlersForBrowser(closedBrowserId)
          .catch((err) =>
            console.error("Failed to clear event handlers:", err),
          );
        recordIssue({
          level: "warn",
          area: "extension_disconnect",
          message: `Browser "${closedBrowserId}" disconnected`,
          browserId: closedBrowserId,
        });
        console.error(`[MyBrowser MCP] Browser "${closedBrowserId}" disconnected`);
      }
    });

    ws.on("error", () => {
      clearTimeout(activityTimer);
      recordIssue({
        level: "error",
        area: "connection",
        message: "WebSocket error on hub connection",
      });
    });
  });

  return {
    close: () => {
      clearInterval(livenessSweep);
      for (const timer of pendingSessionCleanup.values()) {
        clearTimeout(timer);
      }
      pendingSessionCleanup.clear();
      wss.close();
    },
    stateManager,
    isHub: true,
  };
}

// =========================================================================
// Client mode
// =========================================================================

async function connectAsClient(options: WsServerOptions): Promise<WsServerResult> {
  const { host, port, token, context } = options;
  const bindHost = host === "0.0.0.0" ? "127.0.0.1" : host;
  const url = `ws://${bindHost}:${port}`;
  let ws: WebSocket | null = null;
  let closed = false;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let heartbeatTimeout: ReturnType<typeof setTimeout> | null = null;
  let heartbeatSocket: WebSocket | null = null;

  const stateManager = new HubStateManager(() => ws);
  let reconnectCb: (() => Promise<void>) | null = null;

  const clearHeartbeatTimeout = () => {
    if (heartbeatTimeout) {
      clearTimeout(heartbeatTimeout);
      heartbeatTimeout = null;
    }
  };

  const stopHeartbeat = (socket?: WebSocket) => {
    if (socket && heartbeatSocket && heartbeatSocket !== socket) return;
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    clearHeartbeatTimeout();
    heartbeatSocket = null;
  };

  const startHeartbeat = (socket: WebSocket) => {
    stopHeartbeat();
    heartbeatSocket = socket;
    heartbeatTimer = setInterval(() => {
      if (closed || heartbeatSocket !== socket) return;
      if (socket.readyState !== WebSocket.OPEN) return;
      if (heartbeatTimeout) {
        recordIssue({
          level: "warn",
          area: "connection",
          message: "Hub heartbeat response was missed; terminating stale client socket",
        });
        console.error("[MyBrowser MCP] Hub heartbeat missed — reconnecting");
        socket.terminate();
        return;
      }
      try {
        socket.send(JSON.stringify({ type: "ping" }));
        heartbeatTimeout = setTimeout(() => {
          if (closed || heartbeatSocket !== socket) return;
          recordIssue({
            level: "warn",
            area: "connection",
            message: `Hub heartbeat timed out after ${CLIENT_HEARTBEAT_TIMEOUT_MS}ms`,
          });
          console.error("[MyBrowser MCP] Hub heartbeat timeout — reconnecting");
          socket.terminate();
        }, CLIENT_HEARTBEAT_TIMEOUT_MS);
      } catch (e) {
        recordIssue({
          level: "warn",
          area: "connection",
          message: "Failed to send hub heartbeat; terminating client socket",
          details: e,
        });
        socket.terminate();
      }
    }, CLIENT_HEARTBEAT_INTERVAL_MS);
  };

  // Wait for initial connection + auth before returning
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timeout connecting to hub"));
    }, 10_000);

    ws = new WebSocket(url);

    ws.on("open", () => {
      ws!.send(JSON.stringify({ type: "auth", token, role: "client" }));
    });

    ws.on("message", (data: Buffer | string) => {
      let msg: any;
      try {
        msg = JSON.parse(data.toString());
      } catch { return; }

      if (msg.type === "auth" && msg.status === "ok") {
        console.error(`[MyBrowser MCP] Connected to hub as client`);
        context.setClientMode(ws as any);
        startHeartbeat(ws as WebSocket);
        clearTimeout(timeout);
        resolve();
        return;
      }

      if (msg.type === "pong") {
        clearHeartbeatTimeout();
        return;
      }

      if (msg.type === "auth") {
        clearTimeout(timeout);
        reject(new Error("Hub auth failed"));
        return;
      }
    });

    ws.on("close", () => {
      stopHeartbeat(ws as WebSocket);
      context.clearClientWs();
      clearTimeout(timeout);
      reject(new Error("Hub connection closed before auth"));
    });

    ws.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });

  // Set up reconnection for subsequent disconnects
  ws!.on("close", () => {
    stopHeartbeat(ws as WebSocket);
    context.clearClientWs();
    if (!closed) {
      console.error(`[MyBrowser MCP] Hub connection lost — reconnecting in 3s`);
      setTimeout(() => reconnect(), 3000);
    }
  });

  function reconnect() {
    if (closed) return;
    ws = new WebSocket(url);

    ws.on("open", () => {
      ws!.send(JSON.stringify({ type: "auth", token, role: "client" }));
    });

    ws.on("message", (data: Buffer | string) => {
      let msg: any;
      try {
        msg = JSON.parse(data.toString());
      } catch { return; }

      if (msg.type === "auth" && msg.status === "ok") {
        console.error(`[MyBrowser MCP] Reconnected to hub as client`);
        context.setClientMode(ws as any);
        startHeartbeat(ws as WebSocket);
        // Re-register session after reconnect
        if (reconnectCb) reconnectCb().catch((e) => console.error("Reconnect callback failed:", e));
        return;
      }

      if (msg.type === "pong") {
        clearHeartbeatTimeout();
        return;
      }
    });

    ws.on("close", () => {
      stopHeartbeat(ws as WebSocket);
      context.clearClientWs();
      if (!closed) {
        console.error(`[MyBrowser MCP] Hub connection lost — reconnecting in 3s`);
        setTimeout(() => reconnect(), 3000);
      }
    });

    ws.on("error", () => {
      // close event will fire
    });
  }

  return {
    close: () => {
      closed = true;
      stopHeartbeat();
      if (ws) {
        try { ws.close(); } catch { /* ignore */ }
      }
    },
    stateManager,
    isHub: false,
    onReconnect: (cb: () => Promise<void>) => { reconnectCb = cb; },
  };
}
