/**
 * HubStateManager — remote implementation of IStateManager.
 * Sends RPC requests through the hub WebSocket connection.
 * Used by client MCP processes that connect to an existing hub.
 *
 * Uses a single permanent message listener with a pending-map pattern
 * to avoid listener accumulation under load.
 */

import type { WebSocket } from "ws";
import type {
  IStateManager,
  SessionInfo,
  BrowserInfo,
  NoteMetadata,
  NoteStatus,
  Note,
  EventHandler,
  EventName,
  HandlerAction,
  HandlerOptions,
  QueuedEvent,
  Lock,
  AcquireLockResult,
  ReleaseLockResult,
} from "./state-manager.js";

const RPC_TIMEOUT_MS = 10_000;

let rpcCounter = 0;

function generateRpcId(): string {
  return `rpc_${++rpcCounter}_${Date.now().toString(36)}`;
}

interface PendingRpc {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class HubStateManager implements IStateManager {
  private pending = new Map<string, PendingRpc>();
  private installedOn: WebSocket | null = null;

  constructor(private getWs: () => WebSocket | null) {}

  private ensureListener(): void {
    const ws = this.getWs();
    if (!ws || ws === this.installedOn) return;

    if (this.installedOn) {
      this.rejectAll("Hub WebSocket replaced");
    }

    this.installedOn = ws;

    ws.addEventListener("message", (event: { data: any }) => {
      let parsed: any;
      try {
        parsed = JSON.parse(event.data.toString());
      } catch {
        return;
      }
      if (parsed.type !== "hub_rpc_result" || !parsed.id) return;

      const entry = this.pending.get(parsed.id);
      if (!entry) return;

      clearTimeout(entry.timer);
      this.pending.delete(parsed.id);

      if (parsed.error) {
        entry.reject(new Error(parsed.error));
      } else {
        entry.resolve(parsed.result);
      }
    });

    ws.addEventListener("close", () => {
      if (this.installedOn === ws) {
        this.installedOn = null;
        this.rejectAll("Hub connection closed");
      }
    });

    ws.addEventListener("error", () => {
      // close event will follow
    });
  }

  private rejectAll(reason: string): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    this.pending.clear();
  }

  private sendRpc(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = RPC_TIMEOUT_MS,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.ensureListener();
      const ws = this.getWs();
      if (!ws || ws.readyState !== ws.OPEN) {
        reject(new Error("Not connected to hub"));
        return;
      }

      const id = generateRpcId();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Hub RPC timeout: ${method}`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      try {
        ws.send(JSON.stringify({ type: "hub_rpc", id, method, params }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  // -- Sessions --

  async registerSession(sessionId: string, name?: string): Promise<void> {
    await this.sendRpc("registerSession", { sessionId, name });
  }

  async removeSession(sessionId: string): Promise<void> {
    await this.sendRpc("removeSession", { sessionId });
  }

  async touchSession(sessionId: string): Promise<void> {
    await this.sendRpc("touchSession", { sessionId });
  }

  async listSessions(): Promise<SessionInfo[]> {
    return (await this.sendRpc("listSessions")) as SessionInfo[];
  }

  // -- Tab ownership (composite string keys) --

  async claimTab(sessionId: string, tabKey: string): Promise<{ ok: boolean; owner?: string }> {
    return (await this.sendRpc("claimTab", { sessionId, tabKey })) as { ok: boolean; owner?: string };
  }

  async releaseTab(sessionId: string, tabKey: string): Promise<boolean> {
    return (await this.sendRpc("releaseTab", { sessionId, tabKey })) as boolean;
  }

  async transferTab(fromSessionId: string, toSessionId: string, tabKey: string): Promise<boolean> {
    return (await this.sendRpc("transferTab", { fromSessionId, toSessionId, tabKey })) as boolean;
  }

  async releaseAllTabs(sessionId: string): Promise<void> {
    await this.sendRpc("releaseAllTabs", { sessionId });
  }

  async isTabAvailable(tabKey: string, sessionId: string): Promise<boolean> {
    return (await this.sendRpc("isTabAvailable", { tabKey, sessionId })) as boolean;
  }

  async getTabOwner(tabKey: string): Promise<string | undefined> {
    return (await this.sendRpc("getTabOwner", { tabKey })) as string | undefined;
  }

  async shouldEnforceOwnership(): Promise<boolean> {
    return (await this.sendRpc("shouldEnforceOwnership")) as boolean;
  }

  async getSessionName(sessionId: string): Promise<string | undefined> {
    return (await this.sendRpc("getSessionName", { sessionId })) as string | undefined;
  }

  // -- Per-session browser targeting --

  async selectBrowser(sessionId: string, browserId: string): Promise<void> {
    await this.sendRpc("selectBrowser", { sessionId, browserId });
  }

  async getSessionBrowser(sessionId: string): Promise<string | undefined> {
    return (await this.sendRpc("getSessionBrowser", { sessionId })) as string | undefined;
  }

  // -- Browser listing --

  async listBrowsers(): Promise<BrowserInfo[]> {
    return (await this.sendRpc("listBrowsers")) as BrowserInfo[];
  }

  // -- Shared state --

  async sharedGet(key: string): Promise<unknown> {
    return await this.sendRpc("sharedGet", { key });
  }

  async sharedSet(key: string, value: unknown): Promise<void> {
    await this.sendRpc("sharedSet", { key, value });
  }

  async sharedDelete(key: string): Promise<boolean> {
    return (await this.sendRpc("sharedDelete", { key })) as boolean;
  }

  async sharedList(): Promise<Array<{ key: string; type: string; preview: string }>> {
    return (await this.sendRpc("sharedList")) as Array<{ key: string; type: string; preview: string }>;
  }

  // -- Annotation notes (proxied to hub so all client processes see one inbox) --

  async notesList(status: NoteStatus | "all"): Promise<NoteMetadata[]> {
    return (await this.sendRpc("notesList", { status })) as NoteMetadata[];
  }

  async notesGet(id: string): Promise<Note | null> {
    return (await this.sendRpc("notesGet", { id })) as Note | null;
  }

  async notesArchive(
    id: string,
    resolution?: string,
  ): Promise<NoteMetadata | null> {
    return (await this.sendRpc("notesArchive", {
      id,
      resolution,
    })) as NoteMetadata | null;
  }

  async notesUnarchive(id: string): Promise<NoteMetadata | null> {
    return (await this.sendRpc("notesUnarchive", {
      id,
    })) as NoteMetadata | null;
  }

  async notesDelete(
    id: string,
    force: boolean,
  ): Promise<{ deleted: boolean; reason?: string }> {
    return (await this.sendRpc("notesDelete", { id, force })) as {
      deleted: boolean;
      reason?: string;
    };
  }

  // -- Event handlers (F1 browser_on) --

  async registerEventHandler(
    sessionId: string,
    browserId: string,
    event: EventName,
    action: HandlerAction,
    options?: HandlerOptions,
  ): Promise<EventHandler> {
    return (await this.sendRpc("registerEventHandler", {
      sessionId,
      browserId,
      event,
      action,
      options,
    })) as EventHandler;
  }

  async unregisterEventHandler(
    sessionId: string,
    handlerId: string,
  ): Promise<boolean> {
    return (await this.sendRpc("unregisterEventHandler", {
      sessionId,
      handlerId,
    })) as boolean;
  }

  async listEventHandlers(
    sessionId: string,
    browserId?: string,
  ): Promise<EventHandler[]> {
    return (await this.sendRpc("listEventHandlers", {
      sessionId,
      browserId,
    })) as EventHandler[];
  }

  async clearEventHandlersForSession(sessionId: string): Promise<void> {
    await this.sendRpc("clearEventHandlersForSession", { sessionId });
  }

  async clearEventHandlersForBrowser(browserId: string): Promise<void> {
    await this.sendRpc("clearEventHandlersForBrowser", { browserId });
  }

  async hasMatchingEventHandler(
    sessionId: string,
    browserId: string,
    event: EventName,
    queueName: string,
  ): Promise<boolean> {
    return (await this.sendRpc("hasMatchingEventHandler", {
      sessionId,
      browserId,
      event,
      queueName,
    })) as boolean;
  }

  async pushEvent(
    sessionId: string,
    browserId: string,
    event: EventName,
    queueName: string,
    data: unknown,
    tabId?: number,
  ): Promise<void> {
    await this.sendRpc("pushEvent", {
      sessionId,
      browserId,
      event,
      queueName,
      data,
      tabId,
    });
  }

  async waitForEvent(
    sessionId: string,
    queueName: string,
    timeoutMs: number,
  ): Promise<
    { ok: true; event: QueuedEvent } | { ok: false; reason: string }
  > {
    // Give the hub RPC channel a buffer beyond the wait timeout so the
    // hub can respond normally when the waiter times out there.
    return (await this.sendRpc(
      "waitForEvent",
      { sessionId, queueName, timeoutMs },
      timeoutMs + 5_000,
    )) as { ok: true; event: QueuedEvent } | { ok: false; reason: string };
  }

  // -- F3: named mutexes --

  async acquireLock(
    sessionId: string,
    name: string,
    timeoutMs: number,
    ttlMs?: number,
  ): Promise<AcquireLockResult> {
    // Same pattern as waitForEvent — the RPC timeout needs to outlast
    // the lock wait so the hub gets a chance to time out first and
    // respond normally.
    return (await this.sendRpc(
      "acquireLock",
      { sessionId, name, timeoutMs, ttlMs },
      timeoutMs + 5_000,
    )) as AcquireLockResult;
  }

  async releaseLock(
    sessionId: string,
    name: string,
  ): Promise<ReleaseLockResult> {
    return (await this.sendRpc("releaseLock", {
      sessionId,
      name,
    })) as ReleaseLockResult;
  }

  async listLocks(): Promise<Lock[]> {
    return (await this.sendRpc("listLocks")) as Lock[];
  }

  async releaseLocksForSession(sessionId: string): Promise<void> {
    await this.sendRpc("releaseLocksForSession", { sessionId });
  }
}
