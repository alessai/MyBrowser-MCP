export const SESSION_TOMBSTONE_TTL_MS = 24 * 60 * 60_000;
export const MAX_SESSION_TOMBSTONES = 10_000;

export class SessionTombstones {
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

  private pruneExpired(): void {
    const now = this.now();
    for (const [sessionId, expiresAt] of this.entries) {
      if (expiresAt <= now) this.entries.delete(sessionId);
    }
  }
}
