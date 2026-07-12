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
const SESSION_TAB_INDEX_KEY = 'session-tab-index';

export class SessionStateStore {
  private readonly lastTabBySession = new Map<string, number | undefined>();
  private readonly revisionBySession = new Map<string, number>();
  private readonly persistenceByKey = new Map<string, Promise<void>>();
  private readonly cleanupByTab = new Map<number, Promise<void>>();

  constructor(private readonly storage: SessionStorageAdapter = new ChromeSessionStorageAdapter()) {}

  async getLastTab(sessionId: string): Promise<number | undefined> {
    if (this.lastTabBySession.has(sessionId)) {
      return this.lastTabBySession.get(sessionId);
    }

    const stored = await this.storage.get<unknown>(sessionTabKey(sessionId));
    if (!this.lastTabBySession.has(sessionId)) {
      this.setMemory(sessionId, typeof stored === 'number' ? stored : undefined);
    }
    const current = this.lastTabBySession.get(sessionId);
    if (current !== undefined) {
      await this.updateIndex(sessionId, true);
    }
    return current;
  }

  async setLastTab(sessionId: string, tabId: number): Promise<void> {
    this.setMemory(sessionId, tabId);
    const key = sessionTabKey(sessionId);
    await this.persist(key, async () => {
      await this.storage.set(key, tabId);
      await this.updateIndex(sessionId, true);
    });
  }

  async clearTab(tabId: number): Promise<void> {
    const existing = this.cleanupByTab.get(tabId);
    if (existing) return existing;

    const cleanup = (async () => {
      const sessionIds = await this.readIndex();
      for (const [sessionId, storedTabId] of this.lastTabBySession) {
        if (storedTabId === tabId) sessionIds.add(sessionId);
      }

      await Promise.all([...sessionIds].map((sessionId) => {
        const key = sessionTabKey(sessionId);
        const revision = this.revisionBySession.get(sessionId) ?? 0;
        return this.persist(key, async () => {
          const stored = await this.storage.get<unknown>(key);
          if (stored === tabId) {
            await this.storage.remove(key);
            if ((this.revisionBySession.get(sessionId) ?? 0) === revision) {
              this.setMemory(sessionId, undefined);
            }
            await this.updateIndex(sessionId, false);
          } else if (typeof stored !== 'number') {
            if (
              (this.revisionBySession.get(sessionId) ?? 0) === revision &&
              this.lastTabBySession.get(sessionId) === tabId
            ) {
              this.setMemory(sessionId, undefined);
            }
            await this.updateIndex(sessionId, false);
          }
        });
      }));
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
    this.setMemory(sessionId, undefined);
    const key = sessionTabKey(sessionId);
    await this.persist(key, async () => {
      await this.storage.remove(key);
      await this.updateIndex(sessionId, false);
    });
  }

  private setMemory(sessionId: string, tabId: number | undefined): void {
    this.lastTabBySession.set(sessionId, tabId);
    this.revisionBySession.set(sessionId, (this.revisionBySession.get(sessionId) ?? 0) + 1);
  }

  private async readIndex(): Promise<Set<string>> {
    let sessionIds = new Set<string>();
    await this.persist(SESSION_TAB_INDEX_KEY, async () => {
      sessionIds = this.parseIndex(await this.storage.get<unknown>(SESSION_TAB_INDEX_KEY));
    });
    return sessionIds;
  }

  private async updateIndex(sessionId: string, present: boolean): Promise<void> {
    await this.persist(SESSION_TAB_INDEX_KEY, async () => {
      const sessionIds = this.parseIndex(await this.storage.get<unknown>(SESSION_TAB_INDEX_KEY));
      const changed = present ? !sessionIds.has(sessionId) : sessionIds.has(sessionId);
      if (!changed) return;

      if (present) sessionIds.add(sessionId);
      else sessionIds.delete(sessionId);
      await this.storage.set(SESSION_TAB_INDEX_KEY, [...sessionIds].sort());
    });
  }

  private parseIndex(value: unknown): Set<string> {
    if (!Array.isArray(value)) return new Set();
    return new Set(value.filter((sessionId): sessionId is string => (
      typeof sessionId === 'string' && sessionId.length > 0
    )));
  }

  private async persist(key: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.persistenceByKey.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    this.persistenceByKey.set(key, next);
    try {
      await next;
    } finally {
      if (this.persistenceByKey.get(key) === next) {
        this.persistenceByKey.delete(key);
      }
    }
  }
}
