import { WebSocketServer, WebSocket } from "ws";
import { z } from "zod";
import type { Context } from "./context.js";
import { RECORDING_RESERVATION_LEASE_MS, isRecordingDirectorySyncError, type RecordingFileOps, sanitizeRecording, saveRecordingToFile } from './tools/record.js';
import { saveNote, listNotes } from "./notes.js";
import { LocalStateManager, normalizeRecordingName, type IStateManager } from "./state-manager.js";
import { HubStateManager } from "./hub-client.js";
import { recordIssue } from "./logger.js";
import {
  PROTOCOL_VERSION,
  WS_CLOSE,
  isAuthRequestV2,
  isAuthResultV2,
  isTraceContextV1,
  type AuthRequestV2,
  type ConnectionRole,
  type ToolRequestV2,
} from "./protocol.js";
import { SessionConnectionRegistry } from "./session-connections.js";
import { isValidV2SessionId } from "./session-id.js";
import { dispatchHubRpc } from "./hub-rpc.js";

// Hard cap on incoming WS frames: notes can carry a base64 PNG, but nothing
// else this server handles is remotely this large. 32 MB covers a ~20 MB
// binary PNG with base64 overhead plus JSON envelope.
const MAX_WS_PAYLOAD_BYTES = 32 * 1024 * 1024;

// Runtime schema for saveNote payloads coming from the extension. We trust
// the authenticated extension role, but not the shape of the data.
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
  recordingsDir?: string;
  recordingFileOps?: Partial<RecordingFileOps>;
  recordingRetryRegistry?: RecordingRetryRegistry;
  sessionReconnectGraceMs?: number;
  finalizedSessionTtlMs?: number;
  finalizedSessionLimit?: number;
  clientReconnectDelayMs?: number;
  requireHub?: boolean;
  clientOnly?: boolean;
  onHubUnavailable?: () => void;
}

interface RecordingRetryPayload {
  readonly name: string;
  readonly canonical: string;
}

export const MAX_UNRESOLVED_RECORDING_RETRIES_PER_SESSION = 1;
export const MAX_PENDING_RECORDING_PERSISTS_PER_SESSION = 4;
export const FINALIZED_SESSION_TTL_MS = 24 * 60 * 60_000;
export const MAX_FINALIZED_SESSION_TOMBSTONES = 10_000;

export class FinalizedSessionRegistry {
  private readonly entries = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: { ttlMs: number; maxEntries: number; now?: () => number }) {
    this.ttlMs = Math.max(1, options.ttlMs);
    this.maxEntries = Math.max(1, options.maxEntries);
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    this.pruneExpired();
    return this.entries.size;
  }

  add(sessionId: string): void {
    this.pruneExpired();
    this.entries.delete(sessionId);
    this.entries.set(sessionId, this.now() + this.ttlMs);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  has(sessionId: string): boolean {
    this.pruneExpired();
    return this.entries.has(sessionId);
  }

  intersect(sessionIds: readonly string[]): string[] {
    this.pruneExpired();
    return sessionIds.filter((sessionId) => this.entries.has(sessionId));
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const [sessionId, expiresAt] of this.entries) {
      if (expiresAt <= now) this.entries.delete(sessionId);
    }
  }
}

interface RecordingPersistQueue {
  tail: Promise<void>;
  pending: number;
}

export class RecordingRetryRegistry {
  private readonly bySession = new Map<string, RecordingRetryPayload>();

  canRetain(sessionId: string, name: string, canonical: string): boolean {
    const existing = this.bySession.get(sessionId);
    if (existing) return existing.name === name && existing.canonical === canonical;
    return MAX_UNRESOLVED_RECORDING_RETRIES_PER_SESSION > 0;
  }

  retain(sessionId: string, name: string, canonical: string): boolean {
    if (!this.canRetain(sessionId, name, canonical)) return false;
    this.bySession.set(sessionId, { name, canonical });
    return true;
  }

  match(sessionId: string, name: string, canonical: string): boolean {
    const existing = this.bySession.get(sessionId);
    return existing?.name === name && existing.canonical === canonical;
  }

  clearTerminated(sessionId: string, name: string): void {
    if (this.bySession.get(sessionId)?.name === name) this.bySession.delete(sessionId);
  }

  count(sessionId?: string): number {
    return sessionId === undefined ? this.bySession.size : Number(this.bySession.has(sessionId));
  }

  clearSession(sessionId: string): void {
    this.bySession.delete(sessionId);
  }
}

export interface WsServerResult {
  beginShutdown: () => void;
  close: () => Promise<void>;
  stateManager: IStateManager;
  isHub: boolean;
  boundPort: number;
  pendingRecordingPersistCount: (sessionId?: string) => number;
  finalizedSessionCount: () => number;
  /** Register a callback to be called when a client reconnects to the hub */
  onReconnect?: (cb: () => Promise<void>) => void;
}

const CLIENT_TIMEOUT_MS = 45_000;      // MCP clients: 45s inactivity → disconnect
const BROWSER_TIMEOUT_MS = 120_000;    // Browser extensions: 120s (8 missed heartbeats)
const LIVENESS_SWEEP_INTERVAL_MS = 30_000; // Hub pings all connections every 30s
const SESSION_RECONNECT_GRACE_MS = 15_000;
const CLIENT_HEARTBEAT_INTERVAL_MS = 15_000;
const CLIENT_HEARTBEAT_TIMEOUT_MS = 10_000;
const DEFAULT_PROXY_TIMEOUT_MS = 29_000;
const MAX_PROXY_TIMEOUT_MS = 10 * 60_000;
const MESSAGE_RESPONSE_TYPE = "messageResponse";
const EVENT_MIRROR_CONTROL_TYPES = new Set([
  "browser_register_handler",
  "browser_unregister_handler",
  "browser_list_handlers",
]);
const TARGETED_TAB_LIFECYCLE_TYPES = new Set(["keep_tab", "cleanup_session_tabs"]);
const RECORDING_CONTROL_TYPES = new Set([
  "renewRecordingReservation",
  "persistRecording",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Send without throwing if the socket is gone or buffer full. */
function safeSend(ws: WebSocket, payload: unknown): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(payload));
  } catch {
    console.error("[MyBrowser MCP] WS_SEND_FAILED");
  }
}

function sendClientAuth(ws: WebSocket, token: string): void {
  const auth: AuthRequestV2 = {
    type: "auth",
    token,
    role: "client",
    protocolVersion: PROTOCOL_VERSION,
  };
  ws.send(JSON.stringify(auth));
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
  if (options.requireHub && options.clientOnly) {
    throw new Error("Hub startup cannot require both hub and client mode");
  }
  if (options.clientOnly) return connectAsClient(options);
  try {
    return await startServer(options);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    if (options.requireHub) {
      throw new Error(
        `Cannot start standalone hub on ${options.host}:${options.port}; the address is already in use`,
        { cause: error },
      );
    }
    console.error(
      `[MyBrowser MCP] Port ${options.port} already in use — connecting as client to existing hub`,
    );
    return connectAsClient(options);
  }
}

// =========================================================================
// Hub mode — multi-browser support
// =========================================================================

async function startServer(options: WsServerOptions): Promise<WsServerResult> {
  const { host, port, token, context } = options;
  const stateManager = new LocalStateManager();
  const recordingRetryRegistry = options.recordingRetryRegistry ?? new RecordingRetryRegistry();
  const recordingPersistQueues = new Map<string, RecordingPersistQueue>();
  const sessionFinalizations = new Map<string, Promise<boolean>>();
  const destructiveFinalizerOwners = new Map<string, number>();
  const sessionReconnectGraceMs = options.sessionReconnectGraceMs
    ?? SESSION_RECONNECT_GRACE_MS;
  const finalizedSessions = new FinalizedSessionRegistry({
    ttlMs: options.finalizedSessionTtlMs ?? FINALIZED_SESSION_TTL_MS,
    maxEntries: options.finalizedSessionLimit ?? MAX_FINALIZED_SESSION_TOMBSTONES,
  });
  stateManager.onRecordingReservationTerminated(({ sessionId, name }) => {
    recordingRetryRegistry.clearTerminated(sessionId, name);
  });

  function enqueueRecordingPersist<T>(
    sessionId: string,
    operation: () => Promise<T>,
  ): Promise<T> | undefined {
    let queue = recordingPersistQueues.get(sessionId);
    if (!queue) {
      queue = { tail: Promise.resolve(), pending: 0 };
      recordingPersistQueues.set(sessionId, queue);
    }
    if (queue.pending >= MAX_PENDING_RECORDING_PERSISTS_PER_SESSION) return undefined;
    queue.pending += 1;
    const currentQueue = queue;
    const result = queue.tail.then(operation, operation);
    queue.tail = result.then(() => undefined, () => undefined);
    void result.then(
      () => finishRecordingPersist(sessionId, currentQueue),
      () => finishRecordingPersist(sessionId, currentQueue),
    );
    return result;
  }

  function finishRecordingPersist(sessionId: string, queue: RecordingPersistQueue): void {
    queue.pending -= 1;
    if (queue.pending === 0 && recordingPersistQueues.get(sessionId) === queue) {
      recordingPersistQueues.delete(sessionId);
    }
  }

  function pendingRecordingPersistCount(sessionId?: string): number {
    if (sessionId !== undefined) return recordingPersistQueues.get(sessionId)?.pending ?? 0;
    let count = 0;
    for (const queue of recordingPersistQueues.values()) count += queue.pending;
    return count;
  }

  async function drainRecordingPersists(sessionId: string): Promise<void> {
    const queue = recordingPersistQueues.get(sessionId);
    if (!queue) return;
    await queue.tail;
    if (queue.pending === 0 && recordingPersistQueues.get(sessionId) === queue) {
      recordingPersistQueues.delete(sessionId);
    }
  }

  // Wire up browser listing to context
  stateManager.setListBrowsersFn(() => context.listBrowsers());

  /**
   * Teardown for a session. Each step is independent — a failure in
   * one must not skip the others, otherwise the hub can leak state.
   * Errors are captured and re-thrown at the end so callers still see
   * the first failure, but cleanup runs to completion first.
   *
   * `removeSession` is the single extension notification point and
   * broadcasts `session_closed` only after all hub-owned state is gone.
   */
  function finalizeSession(
    sessionId: string,
    expectedGeneration?: number,
    allowConnectedGeneration = false,
  ): Promise<boolean> {
    const generation = expectedGeneration ?? sessionGenerations.get(sessionId) ?? 0;
    const finalizationKey = `${sessionId}\0${generation}`;
    const activeFinalization = sessionFinalizations.get(finalizationKey);
    if (activeFinalization) return activeFinalization;
    if (finalizedSessions.has(sessionId)) return Promise.resolve(false);
    const finalization = runSessionFinalizer(
      sessionId,
      generation,
      expectedGeneration !== undefined || sessionGenerations.has(sessionId),
      allowConnectedGeneration || expectedGeneration === undefined,
    );
    sessionFinalizations.set(finalizationKey, finalization);
    const forget = () => {
      if (sessionFinalizations.get(finalizationKey) === finalization) {
        sessionFinalizations.delete(finalizationKey);
      }
    };
    void finalization.then(forget, forget);
    return finalization;
  }

  async function runSessionFinalizer(
    sessionId: string,
    generation: number,
    generationAware: boolean,
    allowConnectedGeneration = false,
  ): Promise<boolean> {
    cancelSessionCleanup(sessionId);
    const errors: unknown[] = [];
    const step = async (fn: () => Promise<unknown> | unknown): Promise<void> => {
      try {
        await fn();
      } catch (e) {
        errors.push(e);
      }
    };
    await step(() => drainRecordingPersists(sessionId));
    const ownsGeneration = (): boolean => !generationAware || (
      sessionGenerations.get(sessionId) === generation
      && (allowConnectedGeneration || !connectionSessions.hasLiveSession(sessionId))
    );
    if (!ownsGeneration()) return false;
    const destructiveOwner = destructiveFinalizerOwners.get(sessionId);
    if (destructiveOwner !== undefined && destructiveOwner !== generation) return false;
    destructiveFinalizerOwners.set(sessionId, generation);
    try {
      for (const destructiveStep of [
        () => stateManager.releaseAllTabs(sessionId),
        () => stateManager.releaseLocksForSession(sessionId),
        () => stateManager.clearEventHandlersForSession(
          sessionId,
          { notifyExtension: false },
        ),
      ]) {
        if (!ownsGeneration()) return false;
        await step(destructiveStep);
      }
      recordingRetryRegistry.clearSession(sessionId);
      if (generationAware && sessionGenerations.get(sessionId) !== generation) return false;
      sessionGenerations.delete(sessionId);
      finalizedSessions.add(sessionId);
      await step(() => stateManager.removeSession(sessionId));
      if (errors.length > 0) {
        throw new AggregateError(errors, `finalizeSession(${sessionId})`);
      }
      return true;
    } finally {
      if (destructiveFinalizerOwners.get(sessionId) === generation) {
        destructiveFinalizerOwners.delete(sessionId);
      }
    }
  }

  const connectionSessions = new SessionConnectionRegistry<WebSocket>();
  // Track browserId per extension WS for cleanup
  const connectionBrowsers = new Map<WebSocket, string>();
  const pendingSessionCleanup = new Map<string, ReturnType<typeof setTimeout>>();
  const sessionGenerations = new Map<string, number>();
  const pendingProxyCancellations = new Set<() => void>();
  let shuttingDown = false;
  let proxyRequestSequence = 0;

  function cancelSessionCleanup(sessionId: string): void {
    const timer = pendingSessionCleanup.get(sessionId);
    if (!timer) return;
    clearTimeout(timer);
    pendingSessionCleanup.delete(sessionId);
  }

  function isSessionStillConnected(sessionId: string): boolean {
    return connectionSessions.hasLiveSession(sessionId);
  }

  function scheduleSessionCleanup(
    sessionId: string,
    delayMs = sessionReconnectGraceMs,
  ): void {
    cancelSessionCleanup(sessionId);
    const expectedGeneration = sessionGenerations.get(sessionId) ?? 0;
    pendingSessionCleanup.set(
      sessionId,
      setTimeout(() => {
        pendingSessionCleanup.delete(sessionId);
        if (isSessionStillConnected(sessionId)) return;
        finalizeSession(sessionId, expectedGeneration)
          .then((cleaned) => {
            if (cleaned) {
              console.error(`[MyBrowser MCP] Client session "${sessionId}" cleaned up`);
            }
          })
          .catch(() => console.error("[MyBrowser MCP] SESSION_CLEANUP_FAILED"));
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
  const wss = new WebSocketServer({
    host,
    port,
    perMessageDeflate: { threshold: 1024 },
    maxPayload: MAX_WS_PAYLOAD_BYTES,
  });
  await new Promise<void>((resolve, reject) => {
    const onListening = () => {
      wss.off("error", onError);
      resolve();
    };
    const onError = (error: Error) => {
      wss.off("listening", onListening);
      reject(error);
    };
    wss.once("listening", onListening);
    wss.once("error", onError);
  });
  const address = wss.address();
  if (!address || typeof address === "string") {
    wss.close();
    throw new Error("WebSocket server did not bind a TCP port");
  }
  const boundPort = address.port;

  // ----- Hub-side liveness sweep -----
  // Periodically ping all connections via WS protocol-level ping.
  // If a connection didn't respond to the previous ping, it's dead — close it.
  const awaitingPong = new Set<WebSocket>();
  const inFlightMessageHandlers = new Set<Promise<void>>();

  function rejectMessageDuringShutdown(
    ws: WebSocket,
    data: Buffer | string,
    connectionRole: ConnectionRole | undefined,
  ): void {
    let msg: Record<string, unknown>;
    try {
      const parsed = JSON.parse(data.toString());
      if (!isRecord(parsed)) throw new Error("invalid message");
      msg = parsed;
    } catch {
      ws.close(1012, "SERVER_SHUTTING_DOWN");
      return;
    }
    if (!connectionRole || msg.type === "auth") {
      ws.close(1012, "SERVER_SHUTTING_DOWN");
      return;
    }
    if (typeof msg.id !== "string" || msg.id.length === 0) return;
    if (msg.type === "hub_rpc") {
      safeSend(ws, {
        type: "hub_rpc_result",
        id: msg.id,
        error: "SERVER_SHUTTING_DOWN",
      });
      return;
    }
    if (RECORDING_CONTROL_TYPES.has(String(msg.type))) {
      safeSend(ws, {
        type: `${String(msg.type)}Result`,
        id: msg.id,
        ok: false,
        error: "SERVER_SHUTTING_DOWN",
      });
      return;
    }
    safeSend(ws, {
      type: MESSAGE_RESPONSE_TYPE,
      payload: {
        requestId: msg.id,
        error: "SERVER_SHUTTING_DOWN",
      },
    });
  }

  function beginShutdown(): void {
    if (shuttingDown) return;
    shuttingDown = true;
    context.beginShutdown();
    stateManager.cancelPendingForShutdown();
    for (const cancel of [...pendingProxyCancellations]) cancel();
  }

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
    for (const ws of wss.clients) {
      if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
        const sessionId = connectionSessions.unbind(ws);
        if (sessionId) scheduleSessionCleanup(sessionId);
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
    if (shuttingDown) {
      ws.close(1012, "SERVER_SHUTTING_DOWN");
      return;
    }
    let connectionRole: ConnectionRole | undefined;
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

    const handleMessage = async (data: Buffer | string): Promise<void> => {
      resetActivityTimer();

      let msg: any;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        ws.close(4003, "Invalid JSON");
        return;
      }

      // ---- Auth ----
      if (!connectionRole) {
        if (msg.type !== "auth") {
          ws.close(WS_CLOSE.unauthorized, "Unauthorized");
          return;
        }
        if (msg.protocolVersion !== PROTOCOL_VERSION) {
          ws.close(WS_CLOSE.versionMismatch, "Protocol version mismatch");
          return;
        }
        if (msg.role !== "client" && msg.role !== "extension") {
          ws.close(WS_CLOSE.forbiddenRole, "Forbidden role");
          return;
        }
        if (msg.token !== token) {
          ws.close(WS_CLOSE.unauthorized, "Unauthorized");
          return;
        }

        if (!isAuthRequestV2(msg)) {
          ws.close(WS_CLOSE.unauthorized, "Invalid auth request");
          return;
        }
        const authRequest = msg;
        connectionRole = authRequest.role;

        if (connectionRole === "extension") {
          const browserId = context.addBrowser(ws, authRequest.browserName);
          timeoutMs = BROWSER_TIMEOUT_MS; // Browsers get longer timeout
          resetActivityTimer(); // Reset with new timeout
          connectionBrowsers.set(ws, browserId);
          const finalizedSessionIds = finalizedSessions.intersect(
            authRequest.temporaryTabSessionIds ?? [],
          );
          ws.send(JSON.stringify({
            type: "auth",
            status: "ok",
            protocolVersion: PROTOCOL_VERSION,
            browserId,
            ...(authRequest.temporaryTabSessionIds === undefined
              ? {}
              : { finalizedSessionIds }),
          }));
          recordIssue({
            level: "info",
            area: "extension_connect",
            message: `Browser "${authRequest.browserName || browserId}" connected as ${browserId}`,
            browserId,
          });
          console.error(`[MyBrowser MCP] Browser "${authRequest.browserName || browserId}" connected as ${browserId}`);
        } else {
          ws.send(JSON.stringify({
            type: "auth",
            status: "ok",
            protocolVersion: PROTOCOL_VERSION,
          }));
          console.error(`[MyBrowser MCP] MCP client connected`);
        }
        return;
      }

      if (msg.type === "hub_rpc" && connectionRole === "extension") {
        if (typeof msg.id === "string" && msg.id.length > 0) {
          safeSend(ws, {
            type: "hub_rpc_result",
            id: msg.id,
            error: "AUTH_ROLE_VIOLATION",
          });
        }
        ws.close(WS_CLOSE.forbiddenRole, "Forbidden role");
        return;
      }

      if (RECORDING_CONTROL_TYPES.has(msg.type) && connectionRole !== "extension") {
        if (typeof msg.id === "string" && msg.id.trim().length > 0) {
          safeSend(ws, {
            type: `${msg.type}Result`,
            id: msg.id,
            ok: false,
            error: "not authorized",
          });
        }
        return;
      }

      // ---- Ping ----
      if (msg.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
        return;
      }

      // ---- Hub RPC (from MCP client processes) ----
      if (msg.type === "hub_rpc") {
        const hasUsableId = typeof msg.id === "string" && msg.id.length > 0;
        if (!hasUsableId || typeof msg.method !== "string" || msg.method.length === 0) {
          if (hasUsableId) {
            safeSend(ws, {
              type: "hub_rpc_result",
              id: msg.id,
              error: "AUTH_ROLE_VIOLATION",
            });
          }
          return;
        }

        if (msg.method === "registerSession") {
          const sessionId = msg.params?.sessionId;
          if (!isValidV2SessionId(sessionId)) {
            safeSend(ws, {
              type: "hub_rpc_result",
              id: msg.id,
              error: "INVALID_SESSION_ID",
            });
            return;
          }
          if (
            finalizedSessions.has(sessionId)
            || destructiveFinalizerOwners.has(sessionId)
          ) {
            safeSend(ws, {
              type: "hub_rpc_result",
              id: msg.id,
              error: "SESSION_FINALIZED",
            });
            return;
          }
          const alreadyBound = connectionSessions.getSession(ws) === sessionId;
          const binding = connectionSessions.bind(ws, sessionId);
          if (!binding.ok) {
            safeSend(ws, {
              type: "hub_rpc_result",
              id: msg.id,
              error: binding.code,
            });
            return;
          }
          if (!alreadyBound) {
            sessionGenerations.set(
              sessionId,
              (sessionGenerations.get(sessionId) ?? 0) + 1,
            );
          }
          cancelSessionCleanup(sessionId);

          try {
            await stateManager.registerSession(
              sessionId,
              typeof msg.params?.name === "string" ? msg.params.name : undefined,
            );
            safeSend(ws, {
              type: "hub_rpc_result",
              id: msg.id,
              result: { ok: true },
            });
          } catch (err) {
            safeSend(ws, {
              type: "hub_rpc_result",
              id: msg.id,
              error: err instanceof Error ? err.message : String(err),
            });
          }
          return;
        }

        const sessionId = connectionSessions.getSession(ws);
        if (!sessionId) {
          safeSend(ws, {
            type: "hub_rpc_result",
            id: msg.id,
            error: "SESSION_NOT_REGISTERED",
          });
          return;
        }

        if (msg.method === "removeSession") {
          const expectedGeneration = sessionGenerations.get(sessionId) ?? 0;
          try {
            const finalized = await finalizeSession(
              sessionId,
              expectedGeneration,
              true,
            );
            if (!finalized) {
              safeSend(ws, {
                type: "hub_rpc_result",
                id: msg.id,
                error: "SESSION_IDENTITY_MISMATCH",
              });
              return;
            }
            connectionSessions.unbind(ws);
            safeSend(ws, {
              type: "hub_rpc_result",
              id: msg.id,
              result: { ok: true },
            });
          } catch {
            safeSend(ws, {
              type: "hub_rpc_result",
              id: msg.id,
              error: "SESSION_CLEANUP_FAILED",
            });
          }
          return;
        }

        try {
          const result = await dispatchHubRpc(
            stateManager,
            { role: "client", sessionId },
            msg.method,
            isRecord(msg.params) ? msg.params : {},
          );
          safeSend(ws, { type: "hub_rpc_result", id: msg.id, result });
        } catch (err) {
          safeSend(ws, {
            type: "hub_rpc_result",
            id: msg.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }

        return;
      }

      // ---- Recording reservation control from extension ----
      if (msg.type === "renewRecordingReservation") {
        const hasUsableId = typeof msg.id === "string" && msg.id.trim().length > 0;
        if (!hasUsableId) return;
        const sessionId = typeof msg.sessionId === "string" ? msg.sessionId : "";
        const name = typeof msg.name === "string" ? msg.name : "";
        if (sessionId.trim().length === 0 || name.trim().length === 0) {
          safeSend(ws, {
            type: "renewRecordingReservationResult",
            id: msg.id,
            ok: false,
            error: "invalid request",
          });
          return;
        }

        if (!connectionSessions.hasLiveSession(sessionId)) {
          safeSend(ws, {
            type: "renewRecordingReservationResult",
            id: msg.id,
            ok: false,
            error: "reservation unavailable",
          });
          return;
        }

        try {
          const ok = await stateManager.renewRecordingReservation(
            sessionId,
            name,
            RECORDING_RESERVATION_LEASE_MS,
          );
          safeSend(ws, {
            type: "renewRecordingReservationResult",
            id: msg.id,
            ok,
            ...(ok ? {} : { error: "reservation unavailable" }),
          });
        } catch {
          safeSend(ws, {
            type: "renewRecordingReservationResult",
            id: msg.id,
            ok: false,
            error: "invalid request",
          });
        }
        return;
      }

      if (msg.type === "persistRecording") {
        const hasUsableId = typeof msg.id === "string" && msg.id.trim().length > 0;
        if (!hasUsableId) return;
        const sessionId = typeof msg.sessionId === "string" ? msg.sessionId : "";
        if (sessionId.trim().length === 0 || !isRecord(msg.payload)) {
          safeSend(ws, {
            type: "persistRecordingResult",
            id: msg.id,
            ok: false,
            error: "invalid request",
          });
          return;
        }

        const rawRecordingName = msg.payload.name;
        try {
          if (typeof rawRecordingName !== "string"
            || normalizeRecordingName(rawRecordingName) !== rawRecordingName) {
            throw new Error("Invalid recording name");
          }
        } catch {
          safeSend(ws, {
            type: "persistRecordingResult",
            id: msg.id,
            ok: false,
            error: "invalid request",
          });
          return;
        }

        if (!connectionSessions.hasLiveSession(sessionId)) {
          safeSend(ws, {
            type: "persistRecordingResult",
            id: msg.id,
            ok: false,
            error: "reservation unavailable",
          });
          return;
        }

        const persistence = enqueueRecordingPersist(sessionId, async () => {
          if (!connectionSessions.hasLiveSession(sessionId)) {
            safeSend(ws, {
              type: "persistRecordingResult",
              id: msg.id,
              ok: false,
              error: "reservation unavailable",
            });
            return;
          }
          const hasReservation = await stateManager.hasRecordingReservation(
            sessionId,
            rawRecordingName,
          );
          if (!hasReservation) {
            safeSend(ws, {
              type: "persistRecordingResult",
              id: msg.id,
              ok: false,
              error: "reservation unavailable",
            });
            return;
          }

          let recording;
          try {
            recording = sanitizeRecording(msg.payload);
            if (recording.name !== rawRecordingName) throw new Error("Invalid recording name");
          } catch {
            safeSend(ws, {
              type: "persistRecordingResult",
              id: msg.id,
              ok: false,
              error: "invalid request",
            });
            return;
          }
          const canonicalRecording = JSON.stringify(recording);

          if (!recordingRetryRegistry.canRetain(sessionId, recording.name, canonicalRecording)) {
            throw new Error("Recording recovery payload changed");
          }
          try {
            saveRecordingToFile(recording, options.recordingsDir, options.recordingFileOps);
            recordingRetryRegistry.retain(sessionId, recording.name, canonicalRecording);
            const released = await stateManager.releaseRecordingReservation(
              sessionId,
              recording.name,
            );
            if (!released) {
              const stillLive = await stateManager.hasRecordingReservation(
                sessionId,
                recording.name,
              );
              if (stillLive) throw new Error("Recording reservation release failed");
            }
          } catch (error) {
            if (isRecordingDirectorySyncError(error)) {
              recordingRetryRegistry.retain(sessionId, recording.name, canonicalRecording);
            }
            throw error;
          }
          safeSend(ws, {
            type: "persistRecordingResult",
            id: msg.id,
            ok: true,
          });
        });
        if (!persistence) {
          safeSend(ws, {
            type: "persistRecordingResult",
            id: msg.id,
            ok: false,
            error: "persistence busy",
          });
          return;
        }
        void persistence.catch(() => {
          safeSend(ws, {
            type: "persistRecordingResult",
            id: msg.id,
            ok: false,
            error: "persistence failed",
          });
        });
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
        if (connectionRole !== "extension") return;
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
        try {
          const hasMatch = await stateManager.hasMatchingEventHandler(
            p.sessionId,
            browserId,
            p.event,
            p.queueName,
          );
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
          await stateManager.pushEvent(
            p.sessionId,
            browserId,
            p.event,
            p.queueName,
            p.data,
            typeof p.tabId === "number" ? p.tabId : undefined,
          );
        } catch {
          console.error("[MyBrowser MCP] EVENT_HANDLER_FAILED");
        }
        return;
      }

      // ---- QueryNotesCount from extension (popup badge) ----
      // Only browser-extension connections may query note counts. Rejects
      // quietly for MCP clients so a misbehaving tool can't probe state.
      if (msg.type === "queryNotesCount" && msg.id) {
        if (connectionRole !== "extension") return;
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
          console.error("[MyBrowser MCP] QUERY_NOTES_COUNT_FAILED");
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
        if (connectionRole !== "extension") return;
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
          console.error("[MyBrowser MCP] SAVE_NOTE_FAILED");
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
      if (connectionRole === "client" && msg.id && msg.type) {
        const clientSessionId = connectionSessions.getSession(ws);
        if (!clientSessionId) {
          safeSend(ws, {
            type: MESSAGE_RESPONSE_TYPE,
            payload: {
              requestId: msg.id,
              error: "SESSION_NOT_REGISTERED",
            },
          });
          return;
        }
        let forwardedPayload = isRecord(msg.payload) ? msg.payload : {};
        let resolvedBrowserId: string | undefined;
        if (TARGETED_TAB_LIFECYCLE_TYPES.has(msg.type)) {
          const requestedBrowserId = typeof msg.targetBrowserId === "string"
            ? msg.targetBrowserId
            : undefined;
          if (!requestedBrowserId) {
            safeSend(ws, {
              type: MESSAGE_RESPONSE_TYPE,
              payload: { requestId: msg.id, error: "AUTH_ROLE_VIOLATION" },
            });
            return;
          }
          if (
            msg.type === "keep_tab"
            && (
              typeof forwardedPayload.tabId !== "number"
              || !Number.isSafeInteger(forwardedPayload.tabId)
              || forwardedPayload.tabId <= 0
            )
          ) {
            safeSend(ws, {
              type: MESSAGE_RESPONSE_TYPE,
              payload: { requestId: msg.id, error: "INVALID_TOOL_PAYLOAD" },
            });
            return;
          }
          resolvedBrowserId = requestedBrowserId;
          forwardedPayload = msg.type === "keep_tab"
            ? { tabId: forwardedPayload.tabId }
            : {};
        } else if (EVENT_MIRROR_CONTROL_TYPES.has(msg.type)) {
          const ownHandlers = await stateManager.listEventHandlers(clientSessionId);
          if (msg.type === "browser_register_handler") {
            const rawHandler = isRecord(forwardedPayload.handler)
              ? forwardedPayload.handler
              : undefined;
            const handler = ownHandlers.find((candidate) => candidate.id === rawHandler?.id);
            if (!handler) {
              safeSend(ws, {
                type: MESSAGE_RESPONSE_TYPE,
                payload: { requestId: msg.id, error: "AUTH_ROLE_VIOLATION" },
              });
              return;
            }
            resolvedBrowserId = handler.browserId;
            forwardedPayload = { handler };
          } else if (
            msg.type === "browser_unregister_handler"
            && typeof forwardedPayload.handlerId === "string"
          ) {
            const handler = ownHandlers.find(
              (candidate) => candidate.id === forwardedPayload.handlerId,
            );
            if (!handler) {
              safeSend(ws, {
                type: MESSAGE_RESPONSE_TYPE,
                payload: { requestId: msg.id, error: "AUTH_ROLE_VIOLATION" },
              });
              return;
            }
            resolvedBrowserId = handler.browserId;
            forwardedPayload = { handlerId: handler.id };
          } else {
            const requestedBrowserId = typeof msg.targetBrowserId === "string"
              ? msg.targetBrowserId
              : undefined;
            if (
              msg.type === "browser_unregister_handler"
              && requestedBrowserId !== undefined
              && ownHandlers.some(({ browserId }) => browserId === requestedBrowserId)
            ) {
              resolvedBrowserId = requestedBrowserId;
            } else {
              const resolution = await stateManager.resolveBrowserTarget(clientSessionId);
              if (!resolution.ok) {
                safeSend(ws, {
                  type: MESSAGE_RESPONSE_TYPE,
                  payload: { requestId: msg.id, error: resolution.message },
                });
                return;
              }
              resolvedBrowserId = resolution.browserId;
            }
            forwardedPayload = { sessionId: clientSessionId };
          }
        } else {
          const resolution = await stateManager.resolveBrowserTarget(clientSessionId);
          if (!resolution.ok) {
            try {
              ws.send(JSON.stringify({
                type: MESSAGE_RESPONSE_TYPE,
                payload: {
                  requestId: msg.id,
                  error: resolution.message,
                },
              }));
            } catch { /* client gone */ }
            return;
          }
          resolvedBrowserId = resolution.browserId;
        }

        if (resolvedBrowserId === undefined) {
          safeSend(ws, {
            type: MESSAGE_RESPONSE_TYPE,
            payload: { requestId: msg.id, error: "No browser connected" },
          });
          return;
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
        if (shuttingDown) {
          safeSend(ws, {
            type: MESSAGE_RESPONSE_TYPE,
            payload: { requestId: msg.id, error: "SERVER_SHUTTING_DOWN" },
          });
          return;
        }

        const browserWs = browser.ws;
        const requestedTimeoutMs =
          typeof msg.timeoutMs === "number" && Number.isFinite(msg.timeoutMs)
            ? msg.timeoutMs
            : DEFAULT_PROXY_TIMEOUT_MS + 1_000;
        const normalizedTimeoutMs = Math.min(
          Math.max(requestedTimeoutMs, 1_000),
          MAX_PROXY_TIMEOUT_MS,
        );
        const extensionRequestId = `hub_${++proxyRequestSequence}`;
        const forwarded: ToolRequestV2 = {
          id: extensionRequestId,
          type: msg.type,
          payload: forwardedPayload,
          sessionId: clientSessionId,
          timeoutMs: normalizedTimeoutMs,
          ...(isTraceContextV1(msg.trace) ? { trace: msg.trace } : {}),
        };
        browserWs.send(JSON.stringify(forwarded));

        // Full cleanup — removes all listeners and clears timeout
        let settled = false;
        const cleanup = () => {
          if (settled) return;
          settled = true;
          pendingProxyCancellations.delete(cancelForShutdown);
          browserWs.removeListener("message", responseHandler);
          browserWs.removeListener("close", closeHandler);
          ws.removeListener("close", clientCloseHandler);
          clearTimeout(proxyTimeout);
        };

        const safeSendToClient = (data: string) => {
          try { ws.send(data); } catch { /* client gone */ }
        };

        const cancelForShutdown = () => {
          cleanup();
          safeSendToClient(JSON.stringify({
            type: MESSAGE_RESPONSE_TYPE,
            payload: { requestId: msg.id, error: "SERVER_SHUTTING_DOWN" },
          }));
        };
        pendingProxyCancellations.add(cancelForShutdown);

        const responseHandler = (respData: Buffer | string) => {
          let resp: any;
          try { resp = JSON.parse(respData.toString()); } catch { return; }
          if (
            resp.type === MESSAGE_RESPONSE_TYPE
            && resp.payload?.requestId === extensionRequestId
          ) {
            cleanup();
            safeSendToClient(JSON.stringify({
              ...resp,
              payload: {
                ...resp.payload,
                requestId: msg.id,
              },
            }));
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

        const proxyTimeoutMs = Math.min(
          Math.max(
            normalizedTimeoutMs - 1_000,
            1_000,
          ),
          MAX_PROXY_TIMEOUT_MS,
        );

        // Timeout slightly before the client-side request timeout so the
        // hub can return a clear proxy error instead of letting the client
        // hit its generic WebSocket response timeout. Long-running tools
        // pass their larger timeout through the message envelope.
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
        }, proxyTimeoutMs);

        browserWs.on("message", responseHandler);
        browserWs.once("close", closeHandler);

        return;
      }
    };

    ws.on("message", (data: Buffer | string) => {
      if (shuttingDown) {
        rejectMessageDuringShutdown(ws, data, connectionRole);
        return;
      }
      const task = handleMessage(data);
      inFlightMessageHandlers.add(task);
      void task
        .catch(() => console.error("[MyBrowser MCP] MESSAGE_HANDLER_FAILED"))
        .finally(() => inFlightMessageHandlers.delete(task));
    });

    ws.on("close", () => {
      clearTimeout(activityTimer);

      // Clean up MCP client session
      const closedSessionId = connectionSessions.unbind(ws);
      if (closedSessionId && !shuttingDown) {
        scheduleSessionCleanup(closedSessionId);
        console.error(
          `[MyBrowser MCP] Client session "${closedSessionId}" disconnected — waiting ${sessionReconnectGraceMs / 1000}s for reconnect before cleanup`,
        );
      }

      // Clean up browser extension
      const closedBrowserId = connectionBrowsers.get(ws);
      if (closedBrowserId) {
        connectionBrowsers.delete(ws);
        context.removeBrowser(closedBrowserId);
        // F1: clear all event handlers registered against this browser.
        // Session-scoped per the design — a fresh connection starts clean.
        if (!shuttingDown) {
          stateManager
            .clearEventHandlersForBrowser(closedBrowserId)
            .catch(() =>
              console.error("[MyBrowser MCP] CLEAR_EVENT_HANDLERS_FAILED"),
            );
        }
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

  let shutdownPromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    beginShutdown();
    shutdownPromise = (async () => {
      const errors: unknown[] = [];
      clearInterval(livenessSweep);
      for (const timer of pendingSessionCleanup.values()) {
        clearTimeout(timer);
      }
      pendingSessionCleanup.clear();
      while (inFlightMessageHandlers.size > 0 || sessionFinalizations.size > 0) {
        await Promise.allSettled([
          ...inFlightMessageHandlers,
          ...sessionFinalizations.values(),
        ]);
      }
      try {
        const sessions = await stateManager.listSessions();
        for (const { id } of sessions) {
          try {
            await finalizeSession(id);
          } catch (error) {
            errors.push(error);
          }
        }
      } catch (error) {
        errors.push(error);
      }
      for (const client of wss.clients) {
        client.close(1001, "Server shutdown");
      }
      await new Promise<void>((resolve) => {
        const forceClose = setTimeout(() => {
          for (const client of wss.clients) client.terminate();
        }, 1_000);
        forceClose.unref();
        wss.close(() => {
          clearTimeout(forceClose);
          resolve();
        });
      });
      awaitingPong.clear();
      connectionBrowsers.clear();
      if (errors.length > 0) {
        throw new AggregateError(errors, "Hub shutdown cleanup failed");
      }
    })();
    return shutdownPromise;
  };

  return {
    beginShutdown,
    close,
    stateManager,
    isHub: true,
    boundPort,
    pendingRecordingPersistCount,
    finalizedSessionCount: () => finalizedSessions.size,
  };
}

// =========================================================================
// Client mode
// =========================================================================

async function connectAsClient(options: WsServerOptions): Promise<WsServerResult> {
  const { host, port, token, context } = options;
  const clientReconnectDelayMs = options.clientReconnectDelayMs ?? 3_000;
  const bindHost = host === "0.0.0.0" ? "127.0.0.1" : host;
  const urlHost = bindHost.includes(":") ? `[${bindHost}]` : bindHost;
  const url = `ws://${urlHost}:${port}`;
  let ws: WebSocket | null = null;
  let closed = false;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let heartbeatTimeout: ReturnType<typeof setTimeout> | null = null;
  let heartbeatSocket: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let closePromise: Promise<void> | undefined;
  let shutdownStarted = false;

  const notifyHubUnavailable = () => {
    try {
      options.onHubUnavailable?.();
    } catch {
      console.error("[MyBrowser MCP] HUB_RECOVERY_FAILED");
    }
  };

  const stateManager = new HubStateManager(() => ws);
  let reconnectCb: (() => Promise<void>) | null = null;

  const scheduleReconnect = () => {
    if (closed || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      reconnect();
    }, clientReconnectDelayMs);
  };

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

  const beginShutdown = () => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    closed = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    stopHeartbeat();
    context.beginShutdown();
    stateManager.beginShutdown();
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
      sendClientAuth(ws as WebSocket, token);
    });

    ws.on("message", (data: Buffer | string) => {
      let msg: any;
      try {
        msg = JSON.parse(data.toString());
      } catch { return; }

      if (isAuthResultV2(msg)) {
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
        if (msg.status === "ok") {
          (ws as WebSocket).close(WS_CLOSE.versionMismatch, "Protocol version mismatch");
        }
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
      notifyHubUnavailable();
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
      scheduleReconnect();
    }
  });

  function reconnect() {
    if (closed) return;
    ws = new WebSocket(url);

    ws.on("open", () => {
      sendClientAuth(ws as WebSocket, token);
    });

    ws.on("message", (data: Buffer | string) => {
      let msg: any;
      try {
        msg = JSON.parse(data.toString());
      } catch { return; }

      if (isAuthResultV2(msg)) {
        console.error(`[MyBrowser MCP] Reconnected to hub as client`);
        context.setClientMode(ws as any);
        startHeartbeat(ws as WebSocket);
        // Re-register session after reconnect
        if (reconnectCb) reconnectCb().catch(() => {
          console.error("[MyBrowser MCP] RECONNECT_CALLBACK_FAILED");
          // Re-enter the normal reconnect loop. The old hub-side session
          // binding may still be inside its liveness/grace window.
          if (ws?.readyState === WebSocket.OPEN) ws.terminate();
        });
        return;
      }

      if (msg.type === "auth" && msg.status === "ok") {
        (ws as WebSocket).close(WS_CLOSE.versionMismatch, "Protocol version mismatch");
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
        scheduleReconnect();
      }
    });

    ws.on("error", () => {
      notifyHubUnavailable();
      // close event will fire
    });
  }

  return {
    beginShutdown,
    close: () => {
      if (closePromise) return closePromise;
      beginShutdown();
      closePromise = (async () => {
        const errors: unknown[] = [];
        try {
          await stateManager.removeSessionForShutdown(context.sessionId);
        } catch (error) {
          errors.push(error);
        }
        await new Promise<void>((resolve) => {
          if (!ws || ws.readyState === WebSocket.CLOSED) {
            resolve();
            return;
          }
          const forceClose = setTimeout(() => ws?.terminate(), 1_000);
          forceClose.unref();
          ws.once("close", () => {
            clearTimeout(forceClose);
            resolve();
          });
          try { ws.close(); } catch { resolve(); }
        });
        if (errors.length > 0) {
          throw new AggregateError(errors, "Client shutdown failed");
        }
      })();
      return closePromise;
    },
    stateManager,
    isHub: false,
    boundPort: port,
    pendingRecordingPersistCount: () => 0,
    finalizedSessionCount: () => 0,
    onReconnect: (cb: () => Promise<void>) => { reconnectCb = cb; },
  };
}
