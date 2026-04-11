/**
 * StateManager — unified async interface for session management and shared state.
 *
 * Tab IDs are composite strings: "browserId:tabId" (e.g. "b1:1234").
 * This prevents collisions when multiple browsers are connected.
 */

import {
  saveNote as localSaveNote,
  listNotes as localListNotes,
  getNote as localGetNote,
  archiveNote as localArchiveNote,
  unarchiveNote as localUnarchiveNote,
  deleteNote as localDeleteNote,
  type NoteMetadata,
  type NoteStatus,
  type Note,
  type SaveNoteInput,
} from "./notes.js";

export type { NoteMetadata, NoteStatus, Note, SaveNoteInput } from "./notes.js";

// ---- Lock types (F3 browser_lock) ----

export interface Lock {
  name: string;
  /** sessionId of the current owner. */
  owner: string;
  acquiredAt: number;
  /** Absolute ms timestamp at which the lock auto-releases, or
   *  undefined for no TTL. */
  expiresAt?: number;
}

export type AcquireLockResult =
  | { acquired: true; lock: Lock }
  | { acquired: false; reason: string; owner?: string; expiresAt?: number };

export type ReleaseLockResult =
  | { released: true }
  | { released: false; reason: string };

// ---- Event handler types (F1 browser_on) ----

export type EventName = "dialog" | "beforeunload" | "new_tab" | "network_timeout";
export type HandlerAction = "dismiss" | "accept" | "emit" | "ignore";

export interface HandlerOptions {
  /** For accept on prompt dialogs — the text to type before accepting. */
  promptText?: string;
  /** For network_timeout — milliseconds before a pending request is considered stuck. */
  thresholdMs?: number;
  /** For action=emit — event queue name to push into. */
  eventName?: string;
  /** Scope the handler to a specific tab (optional — default is browser-wide). */
  tabId?: number;
}

export interface EventHandler {
  id: string;
  /** Session that installed this handler. Used to scope list/clear/
   *  unregister ops so one session can't manipulate another's
   *  handlers, and to clean up on session disconnect. */
  sessionId: string;
  browserId: string;
  event: EventName;
  action: HandlerAction;
  options?: HandlerOptions;
  createdAt: number;
}

export interface QueuedEvent {
  event: EventName;
  queueName: string;
  /** Owning session — events are emitted into a per-session namespace
   *  so two sessions using the same queueName don't collide or steal
   *  each other's events. */
  sessionId: string;
  browserId: string;
  tabId?: number;
  data: unknown;
  receivedAt: number;
}

// ---- Types ----

export interface SessionInfo {
  id: string;
  name: string;
  ownedTabs: string[];  // composite "browserId:tabId" keys
  activeBrowserId?: string;
  lastActivity: number;
}

export interface BrowserInfo {
  id: string;
  name: string;
  connectedAt: number;
}

// ---- Composite tab key helpers ----

export function makeTabKey(browserId: string, tabId: number): string {
  return `${browserId}:${tabId}`;
}

export function parseTabKey(key: string): { browserId: string; tabId: number } | null {
  const idx = key.indexOf(":");
  if (idx < 0) return null;
  const browserId = key.slice(0, idx);
  const tabId = Number(key.slice(idx + 1));
  if (!Number.isFinite(tabId)) return null;
  return { browserId, tabId };
}

// ---- Interface ----

export interface IStateManager {
  // Session management
  registerSession(sessionId: string, name?: string): Promise<void>;
  removeSession(sessionId: string): Promise<void>;
  touchSession(sessionId: string): Promise<void>;
  listSessions(): Promise<SessionInfo[]>;

  // Tab ownership (uses composite "browserId:tabId" keys)
  claimTab(sessionId: string, tabKey: string): Promise<{ ok: boolean; owner?: string }>;
  releaseTab(sessionId: string, tabKey: string): Promise<boolean>;
  transferTab(fromSessionId: string, toSessionId: string, tabKey: string): Promise<boolean>;
  releaseAllTabs(sessionId: string): Promise<void>;
  isTabAvailable(tabKey: string, sessionId: string): Promise<boolean>;
  getTabOwner(tabKey: string): Promise<string | undefined>;
  shouldEnforceOwnership(): Promise<boolean>;
  getSessionName(sessionId: string): Promise<string | undefined>;

  // Per-session browser targeting
  selectBrowser(sessionId: string, browserId: string): Promise<void>;
  getSessionBrowser(sessionId: string): Promise<string | undefined>;

  // Browser registry (hub delegates to context)
  listBrowsers(): Promise<BrowserInfo[]>;

  // Shared state
  sharedGet(key: string): Promise<unknown>;
  sharedSet(key: string, value: unknown): Promise<void>;
  sharedDelete(key: string): Promise<boolean>;
  sharedList(): Promise<Array<{ key: string; type: string; preview: string }>>;

  // Annotation notes (hub-backed so client-mode processes see the same inbox)
  notesList(status: NoteStatus | "all"): Promise<NoteMetadata[]>;
  notesGet(id: string): Promise<Note | null>;
  notesArchive(id: string, resolution?: string): Promise<NoteMetadata | null>;
  notesUnarchive(id: string): Promise<NoteMetadata | null>;
  notesDelete(
    id: string,
    force: boolean,
  ): Promise<{ deleted: boolean; reason?: string }>;

  // Event handlers (F1 browser_on — session-scoped autonomous reactions)
  registerEventHandler(
    sessionId: string,
    browserId: string,
    event: EventName,
    action: HandlerAction,
    options?: HandlerOptions,
  ): Promise<EventHandler>;
  unregisterEventHandler(
    sessionId: string,
    handlerId: string,
  ): Promise<boolean>;
  listEventHandlers(
    sessionId: string,
    browserId?: string,
  ): Promise<EventHandler[]>;
  clearEventHandlersForSession(sessionId: string): Promise<void>;
  clearEventHandlersForBrowser(browserId: string): Promise<void>;
  /** Check whether a handler exists matching the given scope. Used
   *  by ws-server.ts to validate eventEmitted payloads against
   *  registered handlers before routing into a session's queue. */
  hasMatchingEventHandler(
    sessionId: string,
    browserId: string,
    event: EventName,
    queueName: string,
  ): Promise<boolean>;

  // Event queue (for action=emit + browser_wait_for_event). Queues are
  // namespaced by sessionId so two sessions can reuse queueName strings
  // without colliding or stealing each other's events.
  pushEvent(
    sessionId: string,
    browserId: string,
    event: EventName,
    queueName: string,
    data: unknown,
    tabId?: number,
  ): Promise<void>;
  waitForEvent(
    sessionId: string,
    queueName: string,
    timeoutMs: number,
  ): Promise<{ ok: true; event: QueuedEvent } | { ok: false; reason: string }>;

  // Named mutexes (F3 browser_lock — non-reentrant, FIFO waiter queue,
  // optional TTL, auto-released on session end).
  acquireLock(
    sessionId: string,
    name: string,
    timeoutMs: number,
    ttlMs?: number,
  ): Promise<AcquireLockResult>;
  releaseLock(sessionId: string, name: string): Promise<ReleaseLockResult>;
  listLocks(): Promise<Lock[]>;
  releaseLocksForSession(sessionId: string): Promise<void>;
}

// ---- Local implementation (used by hub) ----

export class LocalStateManager implements IStateManager {
  private sessions = new Map<string, {
    id: string;
    name: string;
    ownedTabs: Set<string>;  // composite keys
    activeBrowserId?: string;
    lastActivity: number;
  }>();

  private store = new Map<string, unknown>();

  // F1: event handler registry + event queue + pending waiters
  private eventHandlers = new Map<string, EventHandler>();
  private eventQueue = new Map<string, QueuedEvent[]>();
  private eventWaiters = new Map<
    string,
    Array<{
      resolve: (v: { ok: true; event: QueuedEvent }) => void;
      timer: ReturnType<typeof setTimeout>;
    }>
  >();
  private handlerIdCounter = 0;

  // F3: named lock registry + FIFO waiter queues + TTL auto-release timers
  private locks = new Map<string, Lock>();
  private lockWaiters = new Map<
    string,
    Array<{
      sessionId: string;
      ttlMs: number | undefined;
      resolve: (v: AcquireLockResult) => void;
      timer: ReturnType<typeof setTimeout>;
    }>
  >();
  private lockTtlTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // Browser listing is delegated to the context — set by ws-server
  private _listBrowsersFn: () => BrowserInfo[] = () => [];

  setListBrowsersFn(fn: () => BrowserInfo[]): void {
    this._listBrowsersFn = fn;
  }

  /** Optional broadcaster set by the hub's ws-server. Called as part
   *  of `clearEventHandlersForSession` so the extension's local
   *  handler mirror gets a scoped cleanup message regardless of
   *  whether the caller came via hub_rpc or direct method call. */
  private _broadcastToBrowsersFn: (
    type: string,
    payload: unknown,
  ) => void = () => {};

  setBroadcastToBrowsersFn(
    fn: (type: string, payload: unknown) => void,
  ): void {
    this._broadcastToBrowsersFn = fn;
  }

  // -- Sessions --

  async registerSession(sessionId: string, name?: string): Promise<void> {
    const existing = this.sessions.get(sessionId);
    this.sessions.set(sessionId, {
      id: sessionId,
      name: name ?? existing?.name ?? sessionId,
      ownedTabs: existing?.ownedTabs ?? new Set(),
      activeBrowserId: existing?.activeBrowserId,
      lastActivity: Date.now(),
    });
  }

  async removeSession(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }

  async touchSession(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (s) s.lastActivity = Date.now();
  }

  async listSessions(): Promise<SessionInfo[]> {
    return Array.from(this.sessions.values()).map((s) => ({
      id: s.id,
      name: s.name,
      ownedTabs: Array.from(s.ownedTabs),
      activeBrowserId: s.activeBrowserId,
      lastActivity: s.lastActivity,
    }));
  }

  // -- Tab ownership --

  async claimTab(sessionId: string, tabKey: string): Promise<{ ok: boolean; owner?: string }> {
    // Inlined owner check — no await, atomic within one microtask
    let currentOwner: string | undefined;
    for (const session of this.sessions.values()) {
      if (session.ownedTabs.has(tabKey)) { currentOwner = session.id; break; }
    }
    if (currentOwner && currentOwner !== sessionId) {
      return { ok: false, owner: currentOwner };
    }
    const session = this.sessions.get(sessionId);
    if (!session) return { ok: false };
    session.ownedTabs.add(tabKey);
    return { ok: true };
  }

  async releaseTab(sessionId: string, tabKey: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    return session.ownedTabs.delete(tabKey);
  }

  async transferTab(fromSessionId: string, toSessionId: string, tabKey: string): Promise<boolean> {
    const from = this.sessions.get(fromSessionId);
    const to = this.sessions.get(toSessionId);
    if (!from || !to) return false;
    if (!from.ownedTabs.has(tabKey)) return false;
    from.ownedTabs.delete(tabKey);
    to.ownedTabs.add(tabKey);
    return true;
  }

  async releaseAllTabs(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) session.ownedTabs.clear();
  }

  async isTabAvailable(tabKey: string, sessionId: string): Promise<boolean> {
    // Inlined — no await for atomicity
    let owner: string | undefined;
    for (const session of this.sessions.values()) {
      if (session.ownedTabs.has(tabKey)) { owner = session.id; break; }
    }
    return owner === undefined || owner === sessionId;
  }

  async getTabOwner(tabKey: string): Promise<string | undefined> {
    for (const session of this.sessions.values()) {
      if (session.ownedTabs.has(tabKey)) return session.id;
    }
    return undefined;
  }

  async shouldEnforceOwnership(): Promise<boolean> {
    if (this.sessions.size <= 1) return false;
    for (const session of this.sessions.values()) {
      if (session.ownedTabs.size > 0) return true;
    }
    return false;
  }

  async getSessionName(sessionId: string): Promise<string | undefined> {
    return this.sessions.get(sessionId)?.name;
  }

  // -- Per-session browser targeting --

  async selectBrowser(sessionId: string, browserId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session "${sessionId}" not found`);
    // Validate browser exists
    const browsers = this._listBrowsersFn();
    if (!browsers.some((b) => b.id === browserId)) {
      throw new Error(`Browser "${browserId}" not found. Use list_browsers to see available browsers.`);
    }
    session.activeBrowserId = browserId;
  }

  async getSessionBrowser(sessionId: string): Promise<string | undefined> {
    return this.sessions.get(sessionId)?.activeBrowserId;
  }

  // -- Browser listing (delegated to context) --

  async listBrowsers(): Promise<BrowserInfo[]> {
    return this._listBrowsersFn();
  }

  // -- Shared state --

  async sharedGet(key: string): Promise<unknown> {
    return this.store.get(key);
  }

  async sharedSet(key: string, value: unknown): Promise<void> {
    this.store.set(key, value);
  }

  async sharedDelete(key: string): Promise<boolean> {
    return this.store.delete(key);
  }

  async sharedList(): Promise<Array<{ key: string; type: string; preview: string }>> {
    const entries: Array<{ key: string; type: string; preview: string }> = [];
    for (const [key, value] of this.store) {
      const type = Array.isArray(value) ? "array" : typeof value;
      let preview: string;
      try {
        const str = JSON.stringify(value);
        preview = str.length > 100 ? str.slice(0, 100) + "..." : str;
      } catch {
        preview = String(value).slice(0, 100);
      }
      entries.push({ key, type, preview });
    }
    return entries;
  }

  // -- Annotation notes (local fs) --

  async notesList(status: NoteStatus | "all"): Promise<NoteMetadata[]> {
    return localListNotes(status);
  }

  async notesGet(id: string): Promise<Note | null> {
    return localGetNote(id);
  }

  async notesArchive(
    id: string,
    resolution?: string,
  ): Promise<NoteMetadata | null> {
    return localArchiveNote(id, resolution);
  }

  async notesUnarchive(id: string): Promise<NoteMetadata | null> {
    return localUnarchiveNote(id);
  }

  async notesDelete(
    id: string,
    force: boolean,
  ): Promise<{ deleted: boolean; reason?: string }> {
    return localDeleteNote(id, force);
  }

  /** Direct write path used only by the WS saveNote handler (hub-local). */
  async notesSave(input: SaveNoteInput): Promise<NoteMetadata> {
    return localSaveNote(input);
  }

  // -- Event handlers (F1 browser_on) --

  /** Composite queue key so two sessions can reuse names independently. */
  private eventQueueKey(sessionId: string, queueName: string): string {
    return `${sessionId}::${queueName}`;
  }

  async registerEventHandler(
    sessionId: string,
    browserId: string,
    event: EventName,
    action: HandlerAction,
    options?: HandlerOptions,
  ): Promise<EventHandler> {
    const id = `evh_${++this.handlerIdCounter}_${Date.now().toString(36)}`;
    const handler: EventHandler = {
      id,
      sessionId,
      browserId,
      event,
      action,
      options,
      createdAt: Date.now(),
    };
    this.eventHandlers.set(id, handler);
    return handler;
  }

  async unregisterEventHandler(
    sessionId: string,
    handlerId: string,
  ): Promise<boolean> {
    const h = this.eventHandlers.get(handlerId);
    if (!h) return false;
    // Ownership check: only the installing session can remove its
    // handlers via this path. Session-cleanup uses
    // clearEventHandlersForSession directly.
    if (h.sessionId !== sessionId) return false;
    return this.eventHandlers.delete(handlerId);
  }

  async listEventHandlers(
    sessionId: string,
    browserId?: string,
  ): Promise<EventHandler[]> {
    const out: EventHandler[] = [];
    for (const h of this.eventHandlers.values()) {
      if (h.sessionId !== sessionId) continue;
      if (browserId && h.browserId !== browserId) continue;
      out.push(h);
    }
    return out;
  }

  async clearEventHandlersForSession(sessionId: string): Promise<void> {
    // Drop handlers installed by this session.
    let droppedAny = false;
    for (const [id, h] of this.eventHandlers) {
      if (h.sessionId === sessionId) {
        this.eventHandlers.delete(id);
        droppedAny = true;
      }
    }
    // Tell every connected browser to drop its local handler mirror
    // for this session. The broadcaster is set by ws-server and
    // iterates raw browser WS connections; it doesn't depend on
    // context.activeBrowserId, so it works even for sessions that
    // registered handlers via implicit single-browser resolution.
    // Fire-and-forget; errors are already swallowed by the broadcaster.
    if (droppedAny) {
      try {
        this._broadcastToBrowsersFn("browser_unregister_handler", {
          sessionId,
        });
      } catch {
        /* best-effort */
      }
    }
    // Drain any event queues and waiters belonging to this session so
    // stale emits from the extension don't leak memory after a
    // disconnected session.
    for (const key of Array.from(this.eventQueue.keys())) {
      if (key.startsWith(`${sessionId}::`)) this.eventQueue.delete(key);
    }
    for (const key of Array.from(this.eventWaiters.keys())) {
      if (!key.startsWith(`${sessionId}::`)) continue;
      const waiters = this.eventWaiters.get(key);
      if (waiters) {
        for (const w of waiters) {
          clearTimeout(w.timer);
          // The stored resolver is typed for the ok:true shape because
          // that's the normal delivery path. Here we need to unblock
          // the promise with an ok:false shape — go through `unknown`
          // to satisfy TS's variance check. Unreachable in practice
          // because the session installing the waiter is the one
          // ending, but we still resolve so no promise dangles.
          try {
            (
              w.resolve as unknown as (v: {
                ok: false;
                reason: string;
              }) => void
            )({ ok: false, reason: "session ended" });
          } catch {
            /* ignore */
          }
        }
      }
      this.eventWaiters.delete(key);
    }
  }

  async clearEventHandlersForBrowser(browserId: string): Promise<void> {
    // Browser disconnect: all handlers for that browser are dead even
    // if their owning session is still alive (it will just fail to
    // dispatch until a new browser is selected).
    for (const [id, h] of this.eventHandlers) {
      if (h.browserId === browserId) this.eventHandlers.delete(id);
    }
  }

  async hasMatchingEventHandler(
    sessionId: string,
    browserId: string,
    event: EventName,
    queueName: string,
  ): Promise<boolean> {
    // Must find a handler that:
    //   1. belongs to the claimed session
    //   2. is registered against the browser the emit came from
    //   3. matches the event kind
    //   4. is an emit handler AND its queueName matches
    // Anything less lets a compromised extension push arbitrary events
    // into another session's waiter queue.
    for (const h of this.eventHandlers.values()) {
      if (h.sessionId !== sessionId) continue;
      if (h.browserId !== browserId) continue;
      if (h.event !== event) continue;
      if (h.action !== "emit") continue;
      if (h.options?.eventName !== queueName) continue;
      return true;
    }
    return false;
  }

  // -- Event queue (for action=emit + browser_wait_for_event) --

  async pushEvent(
    sessionId: string,
    browserId: string,
    event: EventName,
    queueName: string,
    data: unknown,
    tabId?: number,
  ): Promise<void> {
    const queued: QueuedEvent = {
      event,
      queueName,
      sessionId,
      browserId,
      tabId,
      data,
      receivedAt: Date.now(),
    };
    const key = this.eventQueueKey(sessionId, queueName);

    // Deliver directly to a waiter if one is pending — promise-based, no polling.
    const waiters = this.eventWaiters.get(key);
    if (waiters && waiters.length > 0) {
      const waiter = waiters.shift()!;
      clearTimeout(waiter.timer);
      if (waiters.length === 0) this.eventWaiters.delete(key);
      waiter.resolve({ ok: true, event: queued });
      return;
    }
    // Otherwise, buffer until a consumer arrives.
    const buf = this.eventQueue.get(key);
    if (buf) {
      // Bound buffer size so a runaway emit (e.g. network_timeout on a
      // misbehaving site) can't grow unbounded. 1000 events per
      // session/queue should be more than enough for any realistic
      // workflow; older entries are evicted FIFO.
      if (buf.length >= 1000) buf.shift();
      buf.push(queued);
    } else {
      this.eventQueue.set(key, [queued]);
    }
  }

  async waitForEvent(
    sessionId: string,
    queueName: string,
    timeoutMs: number,
  ): Promise<
    { ok: true; event: QueuedEvent } | { ok: false; reason: string }
  > {
    const key = this.eventQueueKey(sessionId, queueName);

    // If the queue already has an event, return it immediately.
    const buf = this.eventQueue.get(key);
    if (buf && buf.length > 0) {
      const next = buf.shift()!;
      if (buf.length === 0) this.eventQueue.delete(key);
      return { ok: true, event: next };
    }
    // Otherwise, install a promise-based waiter.
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const list = this.eventWaiters.get(key);
        if (list) {
          const idx = list.findIndex((w) => w.resolve === resolve);
          if (idx >= 0) list.splice(idx, 1);
          if (list.length === 0) this.eventWaiters.delete(key);
        }
        resolve({ ok: false, reason: "timeout" });
      }, timeoutMs);

      const list = this.eventWaiters.get(key);
      const entry = { resolve, timer };
      if (list) {
        list.push(entry);
      } else {
        this.eventWaiters.set(key, [entry]);
      }
    });
  }

  // -- F3: named mutexes --

  /** Grant ownership of `name` to `sessionId`, record the Lock, and
   *  arm a TTL timer if one was requested. Clears any previous TTL
   *  timer for the same name AND removes the map entry so
   *  `lockTtlTimers` stays in sync with the actual lock state. */
  private grantLock(
    name: string,
    sessionId: string,
    ttlMs: number | undefined,
  ): Lock {
    const existingTimer = this.lockTtlTimers.get(name);
    if (existingTimer) {
      clearTimeout(existingTimer);
      this.lockTtlTimers.delete(name);
    }

    const now = Date.now();
    const lock: Lock = {
      name,
      owner: sessionId,
      acquiredAt: now,
      expiresAt: ttlMs !== undefined ? now + ttlMs : undefined,
    };
    this.locks.set(name, lock);

    if (ttlMs !== undefined) {
      const timer = setTimeout(() => {
        // Only auto-release if the lock is still the one we armed for.
        // A re-grant or manual release would have replaced the entry.
        const current = this.locks.get(name);
        if (current !== lock) return;
        this.lockTtlTimers.delete(name);
        this.passLockToNextWaiter(name);
      }, ttlMs);
      this.lockTtlTimers.set(name, timer);
    }
    return lock;
  }

  /** Called when the current holder releases or the TTL fires.
   *  Hands the lock to the next waiter if one exists, otherwise
   *  clears the lock entirely. */
  private passLockToNextWaiter(name: string): void {
    const waiters = this.lockWaiters.get(name);
    if (waiters && waiters.length > 0) {
      const next = waiters.shift()!;
      if (waiters.length === 0) this.lockWaiters.delete(name);
      clearTimeout(next.timer);
      const lock = this.grantLock(name, next.sessionId, next.ttlMs);
      next.resolve({ acquired: true, lock });
      return;
    }
    this.locks.delete(name);
    const ttlTimer = this.lockTtlTimers.get(name);
    if (ttlTimer) {
      clearTimeout(ttlTimer);
      this.lockTtlTimers.delete(name);
    }
  }

  /** If the current lock on `name` has a past expiresAt, force-release
   *  it (passing to next waiter if any). Returns true if reclaimed. */
  private reclaimIfExpired(name: string): boolean {
    const existing = this.locks.get(name);
    if (!existing) return false;
    if (existing.expiresAt === undefined) return false;
    if (existing.expiresAt > Date.now()) return false;
    // Expired — release it through the same path the TTL timer would use.
    this.passLockToNextWaiter(name);
    return true;
  }

  async acquireLock(
    sessionId: string,
    name: string,
    timeoutMs: number,
    ttlMs?: number,
  ): Promise<AcquireLockResult> {
    // Lazy-reclaim any expired lock FIRST so the FIFO waiter queue
    // sees the correct state. Without this, a fresh acquire could
    // jump ahead of an already-queued waiter when the TTL has lapsed
    // but the timer hasn't fired yet.
    this.reclaimIfExpired(name);

    const existing = this.locks.get(name);

    if (existing) {
      // Non-reentrant: a session that already holds the lock cannot
      // re-acquire it. Return an actionable error instead of blocking
      // on itself — hides accidental double-acquire bugs either way,
      // but an immediate error is clearer for LLM-driven callers.
      if (existing.owner === sessionId) {
        return {
          acquired: false,
          reason: "already held by this session",
          owner: sessionId,
          expiresAt: existing.expiresAt,
        };
      }

      // Held by another session — install a FIFO waiter with timeout.
      return new Promise<AcquireLockResult>((resolve) => {
        const timer = setTimeout(() => {
          const list = this.lockWaiters.get(name);
          if (list) {
            const idx = list.findIndex((w) => w.resolve === resolve);
            if (idx >= 0) list.splice(idx, 1);
            if (list.length === 0) this.lockWaiters.delete(name);
          }
          const current = this.locks.get(name);
          resolve({
            acquired: false,
            reason: "timeout",
            owner: current?.owner,
            expiresAt: current?.expiresAt,
          });
        }, timeoutMs);

        const entry = { sessionId, ttlMs, resolve, timer };
        const list = this.lockWaiters.get(name);
        if (list) {
          list.push(entry);
        } else {
          this.lockWaiters.set(name, [entry]);
        }
      });
    }

    // Invariant: if there's no lock, there shouldn't be waiters either
    // (passLockToNextWaiter always consumes from the queue when
    // releasing). If we ever see waiters without a lock, that's a bug
    // somewhere else in this file — but we must STILL not let a fresh
    // caller jump the queue. Promote the first stray waiter to be the
    // new owner, then queue the current caller behind any remaining.
    const stragglers = this.lockWaiters.get(name);
    if (stragglers && stragglers.length > 0) {
      console.error(
        `[MyBrowser MCP] lock invariant violated: "${name}" has ${stragglers.length} waiter(s) but no owner — promoting first waiter`,
      );
      this.passLockToNextWaiter(name);
      // Recurse so the caller goes through the normal "held by
      // another session" branch. One-level recursion only — the
      // invariant check will not trigger again because a lock now
      // exists.
      return this.acquireLock(sessionId, name, timeoutMs, ttlMs);
    }

    // Free — grant immediately.
    const lock = this.grantLock(name, sessionId, ttlMs);
    return { acquired: true, lock };
  }

  async releaseLock(
    sessionId: string,
    name: string,
  ): Promise<ReleaseLockResult> {
    const existing = this.locks.get(name);
    if (!existing) return { released: false, reason: "not held" };
    if (existing.owner !== sessionId) {
      return {
        released: false,
        reason: "caller is not the owner",
      };
    }
    // Pop the next waiter (if any) and grant — otherwise the lock
    // goes fully idle.
    this.passLockToNextWaiter(name);
    return { released: true };
  }

  async listLocks(): Promise<Lock[]> {
    // Reap any lazily-expired locks BEFORE returning the list so
    // callers see an accurate "currently held" view. Reclaim may
    // promote a waiter, so list order can change during this call.
    for (const name of Array.from(this.locks.keys())) {
      this.reclaimIfExpired(name);
    }
    return Array.from(this.locks.values());
  }

  async releaseLocksForSession(sessionId: string): Promise<void> {
    // Release any locks this session currently holds.
    for (const [name, lock] of this.locks) {
      if (lock.owner === sessionId) {
        this.passLockToNextWaiter(name);
      }
    }
    // Also drop any waiters from this session (so they don't get
    // granted a lock for a session that no longer exists).
    for (const [name, waiters] of this.lockWaiters) {
      const filtered = waiters.filter((w) => {
        if (w.sessionId === sessionId) {
          clearTimeout(w.timer);
          w.resolve({
            acquired: false,
            reason: "session ended",
          });
          return false;
        }
        return true;
      });
      if (filtered.length === 0) {
        this.lockWaiters.delete(name);
      } else if (filtered.length !== waiters.length) {
        this.lockWaiters.set(name, filtered);
      }
    }
  }
}
