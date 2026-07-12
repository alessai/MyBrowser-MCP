export interface SessionStorageAdapter {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  remove(key: string): Promise<void>;
  getBytesInUse(keys?: string[]): Promise<number>;
}

export class ChromeSessionStorageAdapter implements SessionStorageAdapter {
  async get<T>(key: string): Promise<T | undefined> {
    const values = await chrome.storage.session.get(key);
    return values[key] as T | undefined;
  }

  async set<T>(key: string, value: T): Promise<void> {
    await chrome.storage.session.set({ [key]: value });
  }

  async remove(key: string): Promise<void> {
    await chrome.storage.session.remove(key);
  }

  async getBytesInUse(keys?: string[]): Promise<number> {
    return chrome.storage.session.getBytesInUse(keys);
  }
}

const sessionTabKey = (sessionId: string): string => `session-tab:${sessionId}`;

export class SessionStateStore {
  private readonly lastTabBySession = new Map<string, number | undefined>();
  private readonly persistenceBySession = new Map<string, Promise<void>>();
  private readonly cleanupByTab = new Map<number, Promise<void>>();

  constructor(private readonly storage: SessionStorageAdapter = new ChromeSessionStorageAdapter()) {}

  async getLastTab(sessionId: string): Promise<number | undefined> {
    if (this.lastTabBySession.has(sessionId)) {
      return this.lastTabBySession.get(sessionId);
    }

    const stored = await this.storage.get<unknown>(sessionTabKey(sessionId));
    if (!this.lastTabBySession.has(sessionId)) {
      this.lastTabBySession.set(sessionId, typeof stored === 'number' ? stored : undefined);
    }
    return this.lastTabBySession.get(sessionId);
  }

  async setLastTab(sessionId: string, tabId: number): Promise<void> {
    this.lastTabBySession.set(sessionId, tabId);
    await this.persist(sessionId, () => this.storage.set(sessionTabKey(sessionId), tabId));
  }

  async clearTab(tabId: number): Promise<void> {
    const existing = this.cleanupByTab.get(tabId);
    if (existing) return existing;

    const cleanup = (async () => {
      const removals: Promise<void>[] = [];
      for (const [sessionId, storedTabId] of this.lastTabBySession) {
        if (storedTabId !== tabId) continue;
        this.lastTabBySession.set(sessionId, undefined);
        removals.push(this.persist(sessionId, () => this.storage.remove(sessionTabKey(sessionId))));
      }
      await Promise.all(removals);
    })();
    this.cleanupByTab.set(tabId, cleanup);
    try {
      await cleanup;
    } finally {
      if (this.cleanupByTab.get(tabId) === cleanup) {
        this.cleanupByTab.delete(tabId);
      }
    }
  }

  async clearSession(sessionId: string): Promise<void> {
    this.lastTabBySession.set(sessionId, undefined);
    await this.persist(sessionId, () => this.storage.remove(sessionTabKey(sessionId)));
  }

  private async persist(sessionId: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.persistenceBySession.get(sessionId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    this.persistenceBySession.set(sessionId, next);
    try {
      await next;
    } finally {
      if (this.persistenceBySession.get(sessionId) === next) {
        this.persistenceBySession.delete(sessionId);
      }
    }
  }
}
