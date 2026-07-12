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
  private operationChain: Promise<void> = Promise.resolve();

  constructor(private readonly storage: SessionStorageAdapter = new ChromeSessionStorageAdapter()) {}

  getLastTab(sessionId: string): Promise<number | undefined> {
    return this.enqueue(async () => {
      if (this.lastTabBySession.has(sessionId)) {
        return this.lastTabBySession.get(sessionId);
      }

      const stored = await this.storage.get<unknown>(sessionTabKey(sessionId));
      const tabId = typeof stored === 'number' ? stored : undefined;
      this.lastTabBySession.set(sessionId, tabId);
      if (tabId !== undefined) {
        await this.updateIndex(sessionId, true);
      }
      return tabId;
    });
  }

  setLastTab(sessionId: string, tabId: number): Promise<void> {
    return this.enqueue(async () => {
      const key = sessionTabKey(sessionId);
      this.lastTabBySession.set(sessionId, tabId);
      await this.storage.set(key, tabId);
      await this.updateIndex(sessionId, true);
    });
  }

  clearTab(tabId: number): Promise<void> {
    return this.enqueue(async () => {
      const sessionIds = await this.readIndex();
      for (const [sessionId, storedTabId] of this.lastTabBySession) {
        if (storedTabId === tabId) sessionIds.add(sessionId);
      }

      let indexChanged = false;
      for (const sessionId of sessionIds) {
        const key = sessionTabKey(sessionId);
        const stored = await this.storage.get<unknown>(key);
        if (stored === tabId) {
          await this.storage.remove(key);
          this.lastTabBySession.set(sessionId, undefined);
          sessionIds.delete(sessionId);
          indexChanged = true;
        } else if (typeof stored !== 'number') {
          if (this.lastTabBySession.get(sessionId) === tabId) {
            this.lastTabBySession.set(sessionId, undefined);
          }
          sessionIds.delete(sessionId);
          indexChanged = true;
        }
      }

      if (indexChanged) await this.writeIndex(sessionIds);
    });
  }

  clearSession(sessionId: string): Promise<void> {
    return this.enqueue(async () => {
      this.lastTabBySession.set(sessionId, undefined);
      const key = sessionTabKey(sessionId);
      await this.storage.remove(key);
      await this.updateIndex(sessionId, false);
    });
  }

  private async readIndex(): Promise<Set<string>> {
    return this.parseIndex(await this.storage.get<unknown>(SESSION_TAB_INDEX_KEY));
  }

  private async updateIndex(sessionId: string, present: boolean): Promise<void> {
    const sessionIds = await this.readIndex();
    const changed = present ? !sessionIds.has(sessionId) : sessionIds.has(sessionId);
    if (!changed) return;

    if (present) sessionIds.add(sessionId);
    else sessionIds.delete(sessionId);
    await this.writeIndex(sessionIds);
  }

  private async writeIndex(sessionIds: Set<string>): Promise<void> {
    await this.storage.set(SESSION_TAB_INDEX_KEY, [...sessionIds].sort());
  }

  private parseIndex(value: unknown): Set<string> {
    if (!Array.isArray(value)) return new Set();
    return new Set(value.filter((sessionId): sessionId is string => (
      typeof sessionId === 'string' && sessionId.length > 0
    )));
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationChain.then(operation, operation);
    this.operationChain = result.then(() => undefined, () => undefined);
    return result;
  }
}
