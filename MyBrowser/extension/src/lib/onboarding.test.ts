import { describe, expect, it, vi } from 'vitest';

import { openInstallTutorial } from './onboarding';

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
