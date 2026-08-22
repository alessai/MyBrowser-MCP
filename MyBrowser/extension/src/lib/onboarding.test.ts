import { describe, expect, it, vi } from 'vitest';

import { openInstallTutorial, openShortcutSettings } from './onboarding';

describe('openInstallTutorial', () => {
  it('opens the tutorial on first install', async () => {
    const createTab = vi.fn(async () => undefined);

    await expect(openInstallTutorial('install', {
      getUrl: (path) => `chrome-extension://extension-id${path}`,
      createTab,
    })).resolves.toBe(true);

    expect(createTab).toHaveBeenCalledOnce();
    expect(createTab).toHaveBeenCalledWith('chrome-extension://extension-id/tutorial.html');
  });

  it.each(['update', 'chrome_update', 'shared_module_update'])('does not reopen on %s', async (reason) => {
    const createTab = vi.fn(async () => undefined);

    await expect(openInstallTutorial(reason, {
      getUrl: (path) => `chrome-extension://extension-id${path}`,
      createTab,
    })).resolves.toBe(false);

    expect(createTab).not.toHaveBeenCalled();
  });
});

describe('openShortcutSettings', () => {
  it('opens Chrome shortcut settings when the tabs API is available', async () => {
    const openTab = vi.fn(async () => undefined);
    const copy = vi.fn(async () => undefined);

    await expect(openShortcutSettings({ openTab, copy })).resolves.toBe('opened');

    expect(openTab).toHaveBeenCalledWith('chrome://extensions/shortcuts');
    expect(copy).not.toHaveBeenCalled();
  });

  it('copies the address when shortcut settings cannot be opened', async () => {
    const copy = vi.fn(async () => undefined);

    await expect(openShortcutSettings({ copy })).resolves.toBe('copied');

    expect(copy).toHaveBeenCalledWith('chrome://extensions/shortcuts');
  });

  it('returns a manual fallback when clipboard access is unavailable', async () => {
    await expect(openShortcutSettings({
      copy: vi.fn(async () => { throw new Error('denied'); }),
    })).resolves.toBe('manual');
  });
});
