import { describe, expect, it, vi } from 'vitest';

import { createTemporaryTabReconciliationCallbacks } from './temporary-tab-reconciliation';

describe('temporary-tab reconciliation callbacks', () => {
  it('collects sessions and posts the exact accepted reconciliation payload', async () => {
    const post = vi.fn();
    const callbacks = createTemporaryTabReconciliationCallbacks({
      requestSessions: async () => ['session-a', 'session-b'],
      post,
    });

    await expect(callbacks.beforeAuthenticate!()).resolves.toEqual(['session-a', 'session-b']);
    callbacks.onConnected!(['session-a', 'session-b'], ['session-b']);

    expect(post).toHaveBeenNthCalledWith(1, { type: '_os_connected' });
    expect(post).toHaveBeenNthCalledWith(2, {
      type: '_os_reconcile_finalized_sessions',
      payload: {
        reportedSessionIds: ['session-a', 'session-b'],
        finalizedSessionIds: ['session-b'],
      },
    });
  });

  it('rejects an error envelope or malformed list so the caller records one diagnostic', async () => {
    const callbacks = createTemporaryTabReconciliationCallbacks({
      requestSessions: async () => ({ __error: true, message: 'storage unavailable' }),
      post: vi.fn(),
    });

    await expect(callbacks.beforeAuthenticate!()).rejects.toThrow('TEMP_TAB_SESSION_LIST_INVALID');
  });

  it('posts the stable collection diagnostic and skips empty reconciliation', () => {
    const post = vi.fn();
    const callbacks = createTemporaryTabReconciliationCallbacks({
      requestSessions: async () => [],
      post,
    });

    callbacks.onReconciliationError!();
    callbacks.onConnected!([], []);

    expect(post).toHaveBeenNthCalledWith(1, { type: '_os_reconciliation_error' });
    expect(post).toHaveBeenNthCalledWith(2, { type: '_os_connected' });
    expect(post).toHaveBeenCalledTimes(2);
  });
});
