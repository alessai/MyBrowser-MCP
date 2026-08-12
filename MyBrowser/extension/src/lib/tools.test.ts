import { describe, expect, it, vi } from 'vitest';

import { NetworkCaptureController } from './network-capture-controller';
import type { ToolContext } from './tools';
import { handleTool } from './tools';

function context() {
  let tabId = -1;
  const temporaryTabs = {
    open: vi.fn(async () => 42),
    close: vi.fn(async () => undefined),
    keep: vi.fn(async () => true),
    cleanupSession: vi.fn(async () => ({ closed: 2, keptForRetry: 0 })),
  };
  const ctx: ToolContext = {
    sessionId: 'session-a',
    input: {} as ToolContext['input'],
    services: {
      networkCapture: new NetworkCaptureController(),
      temporaryTabs: temporaryTabs as never,
    },
    getTabId: () => tabId,
    setTabId: vi.fn(async (next) => { tabId = next; }),
    clearTab: vi.fn(async (closed) => { if (tabId === closed) tabId = -1; }),
  };
  return { ctx, temporaryTabs };
}

describe('temporary tab tool handlers', () => {
  it.each([
    [{}, true],
    [{ temporary: true }, true],
    [{ temporary: false }, false],
  ] as const)('opens tabs through the injected manager', async (args, temporary) => {
    const { ctx, temporaryTabs } = context();

    await expect(handleTool('new_tab', args, ctx)).resolves.toEqual({ tabId: 42, temporary });

    expect(temporaryTabs.open).toHaveBeenCalledWith('session-a', 'about:blank', temporary);
    expect(ctx.setTabId).toHaveBeenCalledWith(42);
  });

  it('closes through the manager and clears request state', async () => {
    const { ctx, temporaryTabs } = context();
    await ctx.setTabId(42);

    await expect(handleTool('close_tab', {}, ctx)).resolves.toBeUndefined();

    expect(temporaryTabs.close).toHaveBeenCalledWith('session-a', 42);
    expect(ctx.clearTab).toHaveBeenCalledWith(42);
  });

  it('keeps only a tab owned by the caller session', async () => {
    const { ctx, temporaryTabs } = context();

    await expect(handleTool('keep_tab', { tabId: 42 }, ctx)).resolves.toEqual({ kept: true });
    expect(temporaryTabs.keep).toHaveBeenCalledWith('session-a', 42);

    temporaryTabs.keep.mockResolvedValueOnce(false);
    await expect(handleTool('keep_tab', { tabId: 99 }, ctx)).resolves.toEqual({ kept: false });
  });

  it('cleans the caller session without requiring a tab', async () => {
    const { ctx, temporaryTabs } = context();

    await expect(handleTool('cleanup_session_tabs', {}, ctx)).resolves.toEqual({
      closed: 2,
      keptForRetry: 0,
    });
    expect(temporaryTabs.cleanupSession).toHaveBeenCalledWith('session-a');
  });
});
