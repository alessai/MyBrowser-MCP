import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('background temporary-tab lifecycle wiring', () => {
  it('handles reconciliation on both persistent-port and sendMessage paths', () => {
    const source = readFileSync(
      new URL('../entrypoints/background/index.ts', import.meta.url),
      'utf8',
    );

    expect(source.match(/msg\.type === '_os_reconcile_finalized_sessions'/g)).toHaveLength(1);
    expect(source).toContain("addMessageHandler('_os_reconcile_finalized_sessions'");
    expect(source).toContain('retryTemporaryTabCleanup: () => temporaryTabs.retryPendingCleanup()');
  });
});
