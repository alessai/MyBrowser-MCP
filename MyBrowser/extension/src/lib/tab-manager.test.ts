import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ensureContentScript, injectIntoAllTabs } from './tab-manager';

describe('content-script recovery', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal('chrome', {
      tabs: {
        get: vi.fn().mockResolvedValue({ url: 'https://example.com' }),
        query: vi.fn().mockResolvedValue([]),
        sendMessage: vi.fn().mockRejectedValue(new Error('no receiver')),
      },
      scripting: {
        executeScript: vi.fn(),
      },
    });
  });

  it('propagates an explicit reinjection failure', async () => {
    vi.mocked(chrome.scripting.executeScript).mockRejectedValue(new Error('injection denied'));

    await expect(ensureContentScript(7)).rejects.toThrow('injection denied');
  });

  it('keeps startup bulk injection best-effort', async () => {
    vi.mocked(chrome.tabs.query).mockResolvedValue([
      { id: 7, url: 'https://example.com' } as chrome.tabs.Tab,
    ]);
    vi.mocked(chrome.scripting.executeScript).mockRejectedValue(new Error('injection denied'));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(injectIntoAllTabs()).resolves.toBeUndefined();
  });
});
