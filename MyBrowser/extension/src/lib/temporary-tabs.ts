import { isValidV2SessionId } from './session-id';
import type { SessionStorageAdapter } from './session-state';

const STORAGE_KEY = 'temporary-tabs-v1';
const MAX_SESSIONS = 64;
const MAX_TABS_PER_SESSION = 64;
const MAX_TOTAL_TABS = 256;

export interface TemporaryTabApi {
  create(url: string): Promise<{ id?: number }>;
  remove(tabId: number): Promise<void>;
}

export interface TemporaryTabCleanupResult {
  closed: number;
  keptForRetry: number;
}

interface StoredSessionTabs {
  tabs: number[];
  cleanupPending: boolean;
}

interface StoredTemporaryTabsV1 {
  version: 1;
  sessions: Record<string, StoredSessionTabs>;
}

type TemporaryTabDiagnostic =
  | 'TEMP_TAB_ROLLBACK_FAILED'
  | 'TEMP_TAB_STATE_INVALID';

const emptyState = (): StoredTemporaryTabsV1 => ({
  version: 1,
  sessions: {},
});

function ownDataProperties(value: object): Record<string, PropertyDescriptor> | undefined {
  try {
    if (Object.getOwnPropertySymbols(value).length > 0) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.values(descriptors).some((descriptor) => !('value' in descriptor))) return undefined;
    return descriptors;
  } catch {
    return undefined;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function exactKeys(descriptors: Record<string, PropertyDescriptor>, keys: readonly string[]): boolean {
  const names = Object.keys(descriptors).sort();
  return names.length === keys.length && names.every((name, index) => name === [...keys].sort()[index]);
}

function parseTabArray(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const descriptors = ownDataProperties(value);
  if (!descriptors) return undefined;
  const length = descriptors.length?.value;
  if (!Number.isInteger(length) || length < 0 || length > MAX_TABS_PER_SESSION) return undefined;
  if (Object.keys(descriptors).length !== length + 1) return undefined;

  const tabs: number[] = [];
  const seen = new Set<number>();
  for (let index = 0; index < length; index += 1) {
    const tabId = descriptors[String(index)]?.value;
    if (!Number.isSafeInteger(tabId) || tabId <= 0 || seen.has(tabId)) return undefined;
    seen.add(tabId);
    tabs.push(tabId);
  }
  return tabs;
}

function parseStoredState(value: unknown): StoredTemporaryTabsV1 | undefined {
  if (!isPlainObject(value)) return undefined;
  const root = ownDataProperties(value);
  if (!root || !exactKeys(root, ['sessions', 'version']) || root.version!.value !== 1) return undefined;

  const sessionsValue = root.sessions!.value;
  if (!isPlainObject(sessionsValue)) return undefined;
  const sessionsDescriptors = ownDataProperties(sessionsValue);
  if (!sessionsDescriptors) return undefined;
  const sessionIds = Object.keys(sessionsDescriptors);
  if (sessionIds.length > MAX_SESSIONS) return undefined;

  const sessions: Record<string, StoredSessionTabs> = {};
  const allTabs = new Set<number>();
  let totalTabs = 0;
  for (const sessionId of sessionIds) {
    if (!isValidV2SessionId(sessionId)) return undefined;
    const entryValue = sessionsDescriptors[sessionId]?.value;
    if (!isPlainObject(entryValue)) return undefined;
    const entry = ownDataProperties(entryValue);
    if (!entry || !exactKeys(entry, ['cleanupPending', 'tabs'])) return undefined;
    const tabs = parseTabArray(entry.tabs!.value);
    if (!tabs || typeof entry.cleanupPending!.value !== 'boolean') return undefined;
    for (const tabId of tabs) {
      if (allTabs.has(tabId)) return undefined;
      allTabs.add(tabId);
    }
    totalTabs += tabs.length;
    if (totalTabs > MAX_TOTAL_TABS) return undefined;
    sessions[sessionId] = { tabs, cleanupPending: entry.cleanupPending!.value };
  }

  return { version: 1, sessions };
}

function isMissingTabError(error: unknown, tabId: number): boolean {
  return error instanceof Error && error.message === `No tab with id: ${tabId}.`;
}

export class TemporaryTabManager {
  private operationChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly storage: SessionStorageAdapter,
    private readonly tabs: TemporaryTabApi,
    private readonly reportDiagnostic: (code: TemporaryTabDiagnostic) => void = () => undefined,
  ) {}

  open(sessionId: string, url: string, temporary: boolean): Promise<number> {
    return this.enqueue(async () => {
      if (!temporary) return this.createTab(url);
      if (!isValidV2SessionId(sessionId)) throw new Error('INVALID_SESSION_ID');

      const state = await this.readState();
      const session = state.sessions[sessionId];
      const totalTabs = Object.values(state.sessions).reduce((total, entry) => total + entry.tabs.length, 0);
      if (
        (!session && Object.keys(state.sessions).length >= MAX_SESSIONS)
        || (session?.tabs.length ?? 0) >= MAX_TABS_PER_SESSION
        || totalTabs >= MAX_TOTAL_TABS
      ) {
        throw new Error('TEMP_TAB_LIMIT_REACHED');
      }

      const tabId = await this.createTab(url);
      const nextSession = session ?? { tabs: [], cleanupPending: false };
      state.sessions[sessionId] = {
        tabs: [...nextSession.tabs, tabId],
        cleanupPending: nextSession.cleanupPending,
      };
      try {
        await this.writeState(state);
      } catch {
        try {
          await this.tabs.remove(tabId);
        } catch (error) {
          if (!isMissingTabError(error, tabId)) this.reportDiagnostic('TEMP_TAB_ROLLBACK_FAILED');
        }
        throw new Error('TEMP_TAB_TRACK_FAILED');
      }
      return tabId;
    });
  }

  close(sessionId: string, tabId: number): Promise<void> {
    return this.enqueue(async () => {
      const state = await this.readState();
      try {
        await this.tabs.remove(tabId);
      } catch (error) {
        if (!isMissingTabError(error, tabId)) throw error;
      }
      if (this.removeOwnedTab(state, sessionId, tabId)) await this.writeState(state);
    });
  }

  keep(sessionId: string, tabId: number): Promise<boolean> {
    return this.enqueue(async () => {
      const state = await this.readState();
      const session = state.sessions[sessionId];
      if (!session || !session.tabs.includes(tabId)) return false;
      const next = structuredClone(state);
      this.removeOwnedTab(next, sessionId, tabId);
      await this.writeState(next);
      return true;
    });
  }

  cleanupSession(sessionId: string): Promise<TemporaryTabCleanupResult> {
    return this.enqueue(() => this.cleanupSessionState(sessionId));
  }

  trackedSessionIds(): Promise<string[]> {
    return this.enqueue(async () => Object.keys((await this.readState()).sessions).sort());
  }

  retryPendingCleanup(): Promise<void> {
    return this.enqueue(async () => {
      const state = await this.readState();
      for (const sessionId of Object.keys(state.sessions).sort()) {
        if (state.sessions[sessionId]?.cleanupPending) await this.cleanupSessionState(sessionId);
      }
    });
  }

  forgetClosedTab(tabId: number): Promise<void> {
    return this.enqueue(async () => {
      const state = await this.readState();
      let changed = false;
      for (const sessionId of Object.keys(state.sessions)) {
        changed = this.removeOwnedTab(state, sessionId, tabId) || changed;
      }
      if (changed) await this.writeState(state);
    });
  }

  replaceTab(removedTabId: number, addedTabId: number): Promise<void> {
    return this.enqueue(async () => {
      if (!Number.isSafeInteger(addedTabId) || addedTabId <= 0) return;
      const state = await this.readState();
      const owner = Object.values(state.sessions).find((entry) => entry.tabs.includes(removedTabId));
      if (!owner) return;
      if (Object.values(state.sessions).some((entry) => entry.tabs.includes(addedTabId))) return;
      owner.tabs = owner.tabs.map((tabId) => tabId === removedTabId ? addedTabId : tabId);
      await this.writeState(state);
    });
  }

  private async cleanupSessionState(sessionId: string): Promise<TemporaryTabCleanupResult> {
    const state = await this.readState();
    const session = state.sessions[sessionId];
    if (!session) return { closed: 0, keptForRetry: 0 };

    if (!session.cleanupPending) {
      session.cleanupPending = true;
      await this.writeState(state);
    }

    let closed = 0;
    for (const tabId of [...session.tabs]) {
      try {
        await this.tabs.remove(tabId);
        closed += 1;
      } catch (error) {
        if (!isMissingTabError(error, tabId)) continue;
        closed += 1;
      }
      this.removeOwnedTab(state, sessionId, tabId);
      await this.writeState(state);
    }

    return {
      closed,
      keptForRetry: state.sessions[sessionId]?.tabs.length ?? 0,
    };
  }

  private async createTab(url: string): Promise<number> {
    const created = await this.tabs.create(url);
    if (!Number.isSafeInteger(created.id) || (created.id ?? 0) <= 0) {
      throw new Error('TEMP_TAB_CREATE_FAILED');
    }
    return created.id as number;
  }

  private removeOwnedTab(state: StoredTemporaryTabsV1, sessionId: string, tabId: number): boolean {
    const session = state.sessions[sessionId];
    if (!session || !session.tabs.includes(tabId)) return false;
    session.tabs = session.tabs.filter((candidate) => candidate !== tabId);
    if (session.tabs.length === 0) delete state.sessions[sessionId];
    return true;
  }

  private async readState(): Promise<StoredTemporaryTabsV1> {
    const raw = await this.storage.get<unknown>(STORAGE_KEY);
    if (raw === undefined) return emptyState();
    const parsed = parseStoredState(raw);
    if (parsed) return parsed;
    this.reportDiagnostic('TEMP_TAB_STATE_INVALID');
    return emptyState();
  }

  private writeState(state: StoredTemporaryTabsV1): Promise<void> {
    return this.storage.set(STORAGE_KEY, state);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationChain.then(operation, operation);
    this.operationChain = result.then(() => undefined, () => undefined);
    return result;
  }
}
