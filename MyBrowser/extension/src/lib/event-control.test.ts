import { beforeEach, describe, expect, it } from 'vitest';

import {
  addHandler,
  clearHandlers,
  listHandlers,
  type EventHandler,
} from './events';
import { handleTool, type ToolContext } from './tools';

function handler(
  id: string,
  sessionId: string,
  browserId = 'browser-a',
): EventHandler {
  return {
    id,
    sessionId,
    browserId,
    event: 'new_tab',
    action: 'ignore',
    createdAt: 1,
  };
}

function context(sessionId: string): ToolContext {
  return {
    sessionId,
    input: {} as ToolContext['input'],
    services: {} as ToolContext['services'],
    getTabId: () => -1,
    setTabId: async () => undefined,
    clearTab: async () => undefined,
  };
}

describe('production event mirror controls', () => {
  beforeEach(() => clearHandlers());

  it('derives registered handler ownership from the injected request session', async () => {
    await handleTool(
      'browser_register_handler',
      { handler: handler('handler-a', 'forged-session') },
      context('session-a'),
    );

    expect(listHandlers()).toEqual([
      expect.objectContaining({ id: 'handler-a', sessionId: 'session-a' }),
    ]);
  });

  it('lists only handlers owned by the injected request session', async () => {
    addHandler(handler('handler-a', 'session-a'));
    addHandler(handler('handler-b', 'session-b'));

    await expect(handleTool(
      'browser_list_handlers',
      { sessionId: 'session-b' },
      context('session-a'),
    )).resolves.toEqual({ handlers: [handler('handler-a', 'session-a')] });
  });

  it('cannot unregister another session handler by id', async () => {
    addHandler(handler('handler-a', 'session-a'));
    addHandler(handler('handler-b', 'session-b'));

    await expect(handleTool(
      'browser_unregister_handler',
      { handlerId: 'handler-b' },
      context('session-a'),
    )).resolves.toEqual({ ok: false });
    expect(listHandlers().map(({ id }) => id)).toEqual(['handler-a', 'handler-b']);
  });

  it('applies an owned single-handler removal before acknowledging it', async () => {
    addHandler(handler('handler-a', 'session-a'));
    addHandler(handler('handler-b', 'session-b'));

    await expect(handleTool(
      'browser_unregister_handler',
      { handlerId: 'handler-a' },
      context('session-a'),
    )).resolves.toEqual({ ok: true });
    expect(listHandlers()).toEqual([handler('handler-b', 'session-b')]);
  });

  it.each([
    { clearAll: true },
    { sessionId: 'session-b' },
  ])('constrains bulk unregister $clearAll to the injected session', async (args) => {
    addHandler(handler('handler-a', 'session-a'));
    addHandler(handler('handler-b', 'session-b'));

    await expect(handleTool(
      'browser_unregister_handler',
      args,
      context('session-a'),
    )).resolves.toEqual({ ok: true, removed: 1 });
    expect(listHandlers()).toEqual([handler('handler-b', 'session-b')]);
  });
});
