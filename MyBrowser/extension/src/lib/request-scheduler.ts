import type { ProtocolErrorCode } from './protocol';

import {
  MAX_SESSION_TOMBSTONES,
  SESSION_TOMBSTONE_TTL_MS,
  SessionTombstones,
} from './session-tombstones';

export interface RequestMeta {
  requestId: string;
  sessionId: string;
  expiresAt: number;
  onStart?: (startedAt: number) => void;
}

interface QueueEntry {
  meta: RequestMeta;
  work: (signal: AbortSignal) => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface WorkQueue {
  running: boolean;
  entries: QueueEntry[];
}

export interface RequestSchedulerOptions {
  maxPendingPerTab?: number;
  maxPendingGlobal?: number;
  now?: () => number;
}

export type RequestQueueKind = 'tab' | 'session' | 'global' | 'none';

export class RequestScheduler {
  private readonly tabQueues = new Map<number, WorkQueue>();
  private readonly sessionQueues = new Map<string, WorkQueue>();
  private readonly globalQueues = new Map<string, WorkQueue>();
  private readonly closedSessions = new SessionTombstones({
    ttlMs: SESSION_TOMBSTONE_TTL_MS,
    maxEntries: MAX_SESSION_TOMBSTONES,
  });
  private readonly maxPendingPerTab: number;
  private readonly maxPendingGlobal: number;
  private readonly now: () => number;
  private globalPending = 0;

  constructor(options: RequestSchedulerOptions = {}) {
    this.maxPendingPerTab = options.maxPendingPerTab ?? 100;
    this.maxPendingGlobal = options.maxPendingGlobal ?? 500;
    this.now = options.now ?? Date.now;
  }

  get queueCount(): number {
    return this.tabQueues.size + this.sessionQueues.size + this.globalQueues.size;
  }

  get pendingCount(): number {
    return this.globalPending;
  }

  runTab<T>(tabId: number, meta: RequestMeta, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return this.enqueue(this.tabQueues, tabId, this.maxPendingPerTab, meta, work);
  }

  runSession<T>(sessionId: string, meta: RequestMeta, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return this.enqueue(this.sessionQueues, sessionId, Number.POSITIVE_INFINITY, meta, work);
  }

  runGlobal<T>(meta: RequestMeta, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return this.enqueue(this.globalQueues, 'global', Number.POSITIVE_INFINITY, meta, work);
  }

  async runUnqueued<T>(meta: RequestMeta, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.closedSessions.has(meta.sessionId)) throw new Error('SESSION_CLOSED');
    const startedAt = this.now();
    try { meta.onStart?.(startedAt); } catch { /* telemetry callbacks are inert */ }
    if (meta.expiresAt <= startedAt) throw new Error('REQUEST_EXPIRED');
    return this.runWithDeadline(meta, startedAt, work);
  }

  cancelTab(tabId: number, code: ProtocolErrorCode): void {
    const queue = this.tabQueues.get(tabId);
    if (queue) this.rejectQueued(queue, () => true, code);
  }

  cancelSession(sessionId: string, code: ProtocolErrorCode): void {
    if (code === 'SESSION_CLOSED') this.closedSessions.add(sessionId);
    const matches = (entry: QueueEntry): boolean => entry.meta.sessionId === sessionId;
    for (const queue of this.tabQueues.values()) this.rejectQueued(queue, matches, code);
    for (const queue of this.sessionQueues.values()) this.rejectQueued(queue, matches, code);
    for (const queue of this.globalQueues.values()) this.rejectQueued(queue, matches, code);
  }

  private enqueue<K, T>(
    queues: Map<K, WorkQueue>,
    key: K,
    maxPendingForQueue: number,
    meta: RequestMeta,
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (this.closedSessions.has(meta.sessionId)) {
      return Promise.reject(new Error('SESSION_CLOSED'));
    }
    let queue = queues.get(key);
    if (!queue) {
      queue = { running: false, entries: [] };
      queues.set(key, queue);
    }

    if (queue.running && (
      queue.entries.length >= maxPendingForQueue ||
      this.globalPending >= this.maxPendingGlobal
    )) {
      return Promise.reject(new Error('QUEUE_OVERLOADED'));
    }

    const promise = new Promise<T>((resolve, reject) => {
      const entry: QueueEntry = {
        meta,
        work,
        resolve: resolve as (value: unknown) => void,
        reject,
      };

      if (queue!.running) {
        queue!.entries.push(entry);
        this.globalPending += 1;
        return;
      }

      queue!.running = true;
      this.execute(queues, key, queue!, entry);
    });

    return promise;
  }

  private async execute<K>(
    queues: Map<K, WorkQueue>,
    key: K,
    queue: WorkQueue,
    entry: QueueEntry,
  ): Promise<void> {
    try {
      const startedAt = this.now();
      try { entry.meta.onStart?.(startedAt); } catch { /* telemetry callbacks are inert */ }
      if (entry.meta.expiresAt <= startedAt) {
        throw new Error('REQUEST_EXPIRED');
      }
      entry.resolve(await this.runWithDeadline(entry.meta, startedAt, entry.work));
    } catch (error) {
      entry.reject(error instanceof Error ? error : new Error(String(error)));
    } finally {
      const next = queue.entries.shift();
      if (next) {
        this.globalPending -= 1;
        void this.execute(queues, key, queue, next);
      } else {
        queue.running = false;
        queues.delete(key);
      }
    }
  }

  private async runWithDeadline<T>(
    meta: RequestMeta,
    startedAt: number,
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    const operation = work(controller.signal);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('REQUEST_EXPIRED'));
      }, Math.max(0, meta.expiresAt - startedAt));
    });
    try {
      return await Promise.race([operation, expired]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private rejectQueued(
    queue: WorkQueue,
    matches: (entry: QueueEntry) => boolean,
    code: ProtocolErrorCode,
  ): void {
    const retained: QueueEntry[] = [];
    for (const entry of queue.entries) {
      if (matches(entry)) {
        this.globalPending -= 1;
        entry.reject(new Error(code));
      } else {
        retained.push(entry);
      }
    }
    queue.entries = retained;
  }
}

export function dispatchScheduledRequest<T>(
  scheduler: RequestScheduler,
  queue: RequestQueueKind,
  tabId: number,
  meta: RequestMeta,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  switch (queue) {
    case 'tab':
      return scheduler.runTab(tabId, meta, work);
    case 'session':
      return scheduler.runSession(meta.sessionId, meta, work);
    case 'global':
      return scheduler.runGlobal(meta, work);
    case 'none':
      return scheduler.runUnqueued(meta, work);
  }
}
