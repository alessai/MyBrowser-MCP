import { isBoundedSessionIdList } from './protocol';
import type { ReconnectingWsCallbacks } from './reconnecting-ws';

interface ReconciliationDependencies {
  requestSessions(): Promise<unknown>;
  post(message: Record<string, unknown>): void | Promise<void>;
}

export function createTemporaryTabReconciliationCallbacks({
  requestSessions,
  post,
}: ReconciliationDependencies): Pick<
  ReconnectingWsCallbacks,
  'beforeAuthenticate' | 'onReconciliationError' | 'onConnected'
> {
  return {
    async beforeAuthenticate() {
      const sessionIds = await requestSessions();
      if (!isBoundedSessionIdList(sessionIds)) throw new Error('TEMP_TAB_SESSION_LIST_INVALID');
      return sessionIds;
    },
    onReconciliationError() {
      void post({ type: '_os_reconciliation_error' });
    },
    onConnected(reportedSessionIds, finalizedSessionIds) {
      void post({ type: '_os_connected' });
      if (finalizedSessionIds.length > 0) {
        void post({
          type: '_os_reconcile_finalized_sessions',
          payload: { reportedSessionIds, finalizedSessionIds },
        });
      }
    },
  };
}
