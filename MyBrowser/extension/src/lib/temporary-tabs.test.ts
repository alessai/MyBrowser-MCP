import { describe, expect, it, vi } from 'vitest';

import type { SessionStorageAdapter } from './session-state';
import {
  TemporaryTabManager,
  type TemporaryTabApi,
} from './temporary-tabs';

class MemoryStorage implements SessionStorageAdapter {
  readonly values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async set<T>(key: string, value: T): Promise<void> {
    this.values.set(key, structuredClone(value));
  }

  async remove(key: string): Promise<void> {
    this.values.delete(key);
  }

  async getBytesInUse(): Promise<number> {
    return JSON.stringify([...this.values]).length;
  }
}

function setup() {
  const storage = new MemoryStorage();
  let nextTabId = 1;
  const api: TemporaryTabApi = {
    create: vi.fn(async () => ({ id: nextTabId++ })),
    remove: vi.fn(async () => undefined),
  };
  const diagnostics: string[] = [];
  const manager = new TemporaryTabManager(storage, api, (code) => diagnostics.push(code));
  return { storage, api, diagnostics, manager };
}

describe('TemporaryTabManager', () => {
  it('tracks only temporary tabs created through open', async () => {
    const { manager } = setup();

    await expect(manager.open('session-a', 'https://example.com', true)).resolves.toBe(1);
    await expect(manager.open('session-a', 'about:blank', false)).resolves.toBe(2);

    await expect(manager.trackedSessionIds()).resolves.toEqual(['session-a']);
    await expect(manager.keep('session-a', 2)).resolves.toBe(false);
    await expect(manager.keep('session-a', 1)).resolves.toBe(true);
  });

  it('rolls back the created tab when persistence fails', async () => {
    const { storage, api, manager } = setup();
    storage.set = vi.fn(async () => {
      throw new Error('CANARY_STORAGE_FAILURE');
    });

    await expect(manager.open('session-a', 'https://canary.invalid', true)).rejects.toThrow(
      'TEMP_TAB_TRACK_FAILED',
    );
    expect(api.remove).toHaveBeenCalledWith(1);
  });

  it('reports only a stable code when rollback also fails', async () => {
    const { storage, api, diagnostics, manager } = setup();
    storage.set = vi.fn(async () => {
      throw new Error('CANARY_STORAGE_FAILURE');
    });
    api.remove = vi.fn(async () => {
      throw new Error('CANARY_REMOVE_FAILURE');
    });

    await expect(manager.open('session-a', 'https://canary.invalid', true)).rejects.toThrow(
      'TEMP_TAB_TRACK_FAILED',
    );
    expect(diagnostics).toEqual(['TEMP_TAB_ROLLBACK_FAILED']);
    expect(JSON.stringify(diagnostics)).not.toContain('CANARY');
  });

  it('fails before create at every registry bound', async () => {
    const { storage, api, manager } = setup();
    storage.values.set('temporary-tabs-v1', {
      version: 1,
      sessions: Object.fromEntries(Array.from({ length: 64 }, (_, index) => [
        `session-${index}`,
        { tabs: [index + 1], cleanupPending: false },
      ])),
    });

    await expect(manager.open('session-new', 'about:blank', true)).rejects.toThrow(
      'TEMP_TAB_LIMIT_REACHED',
    );
    expect(api.create).not.toHaveBeenCalled();

    storage.values.set('temporary-tabs-v1', {
      version: 1,
      sessions: { 'session-a': { tabs: Array.from({ length: 64 }, (_, index) => index + 1), cleanupPending: false } },
    });
    await expect(manager.open('session-a', 'about:blank', true)).rejects.toThrow(
      'TEMP_TAB_LIMIT_REACHED',
    );

    storage.values.set('temporary-tabs-v1', {
      version: 1,
      sessions: Object.fromEntries(Array.from({ length: 4 }, (_, session) => [
        `session-${session}`,
        { tabs: Array.from({ length: 64 }, (_, index) => session * 64 + index + 1), cleanupPending: false },
      ])),
    });
    await expect(manager.open('session-0', 'about:blank', true)).rejects.toThrow(
      'TEMP_TAB_LIMIT_REACHED',
    );
    expect(api.create).not.toHaveBeenCalled();
  });

  it('keeps only the caller session ownership', async () => {
    const { storage, diagnostics, manager } = setup();
    storage.values.set('temporary-tabs-v1', {
      version: 1,
      sessions: {
        'session-a': { tabs: [7], cleanupPending: false },
      },
    });

    await expect(manager.keep('session-b', 7)).resolves.toBe(false);
    await expect(manager.cleanupSession('session-a')).resolves.toEqual({ closed: 1, keptForRetry: 0 });
  });

  it('leaves ownership intact when keep persistence fails', async () => {
    const { storage, diagnostics, manager } = setup();
    await manager.open('session-a', 'about:blank', true);
    storage.set = vi.fn(async () => {
      throw new Error('CANARY_KEEP_FAILURE');
    });

    await expect(manager.keep('session-a', 1)).resolves.toBe(false);
    expect(diagnostics).toEqual(['TEMP_TAB_KEEP_PERSIST_FAILED']);

    storage.set = MemoryStorage.prototype.set.bind(storage);
    await expect(manager.cleanupSession('session-a')).resolves.toEqual({ closed: 1, keptForRetry: 0 });
  });

  it('marks cleanup pending before the first remove and retains transient failures', async () => {
    const { storage, api, manager } = setup();
    await manager.open('session-a', 'about:blank', true);
    let stateAtRemove: unknown;
    api.remove = vi.fn(async () => {
      stateAtRemove = structuredClone(storage.values.get('temporary-tabs-v1'));
      throw new Error('temporarily unavailable');
    });

    await expect(manager.cleanupSession('session-a')).resolves.toEqual({ closed: 0, keptForRetry: 1 });
    expect(stateAtRemove).toMatchObject({
      sessions: { 'session-a': { cleanupPending: true, tabs: [1] } },
    });

    const restarted = new TemporaryTabManager(storage, {
      create: api.create,
      remove: vi.fn(async () => undefined),
    });
    await expect(restarted.retryPendingCleanup()).resolves.toBeUndefined();
    await expect(restarted.trackedSessionIds()).resolves.toEqual([]);
  });

  it('treats the exact missing-tab error as cleaned', async () => {
    const { api, manager } = setup();
    await manager.open('session-a', 'about:blank', true);
    api.remove = vi.fn(async () => {
      throw new Error('No tab with id: 1.');
    });

    await expect(manager.cleanupSession('session-a')).resolves.toEqual({ closed: 1, keptForRetry: 0 });
    await expect(manager.trackedSessionIds()).resolves.toEqual([]);
  });

  it('serializes concurrent open, keep, and cleanup mutations', async () => {
    const { manager } = setup();

    const [first, second] = await Promise.all([
      manager.open('session-a', 'about:blank', true),
      manager.open('session-a', 'about:blank', true),
    ]);
    await Promise.all([
      manager.keep('session-a', first),
      manager.cleanupSession('session-a'),
    ]);

    await expect(manager.trackedSessionIds()).resolves.toEqual([]);
    expect(second).toBe(2);
  });

  it('reconciles removed and replaced tabs', async () => {
    const { manager } = setup();
    await manager.open('session-a', 'about:blank', true);
    await manager.replaceTab(1, 9);

    await expect(manager.keep('session-a', 1)).resolves.toBe(false);
    await expect(manager.keep('session-a', 9)).resolves.toBe(true);

    await manager.open('session-a', 'about:blank', true);
    await manager.forgetClosedTab(2);
    await expect(manager.trackedSessionIds()).resolves.toEqual([]);
  });

  it('does not move ownership onto an already-owned replacement ID', async () => {
    const { manager } = setup();
    await manager.open('session-a', 'about:blank', true);
    await manager.open('session-b', 'about:blank', true);

    await manager.replaceTab(1, 2);

    await expect(manager.keep('session-a', 1)).resolves.toBe(true);
    await expect(manager.keep('session-b', 2)).resolves.toBe(true);
  });

  it.each([
    null,
    { version: 2, sessions: {} },
    { version: 1, sessions: [] },
    { version: 1, sessions: { 'bad session': { tabs: [1], cleanupPending: false } } },
    { version: 1, sessions: { 'session-a': { tabs: [1, 1], cleanupPending: false } } },
    { version: 1, sessions: {
      'session-a': { tabs: [1], cleanupPending: false },
      'session-b': { tabs: [1], cleanupPending: false },
    } },
    { version: 1, sessions: { 'session-a': { tabs: [0], cleanupPending: false } } },
  ])('drops malformed stored state without closing tabs: %j', async (stored) => {
    const { storage, api, diagnostics, manager } = setup();
    storage.values.set('temporary-tabs-v1', stored);

    await expect(manager.cleanupSession('session-a')).resolves.toEqual({ closed: 0, keptForRetry: 0 });
    expect(api.remove).not.toHaveBeenCalled();
    expect(diagnostics).toEqual(['TEMP_TAB_STATE_INVALID']);
    expect(storage.values.has('temporary-tabs-v1')).toBe(false);
  });

  it('rejects accessor-backed state without reading the accessor', async () => {
    const { storage, api, diagnostics, manager } = setup();
    const stored = { version: 1 } as Record<string, unknown>;
    Object.defineProperty(stored, 'sessions', {
      enumerable: true,
      get() {
        throw new Error('CANARY_GETTER');
      },
    });
    storage.values.set('temporary-tabs-v1', stored);

    await expect(manager.retryPendingCleanup()).resolves.toBeUndefined();
    expect(api.remove).not.toHaveBeenCalled();
    expect(diagnostics).toEqual(['TEMP_TAB_STATE_INVALID']);
  });
});
