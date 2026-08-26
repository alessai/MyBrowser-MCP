import { afterEach, describe, expect, it, vi } from 'vitest';

import { getStorageAll } from './storage';

afterEach(() => vi.unstubAllGlobals());

describe('local URL host defaults', () => {
  it('uses a remote server address for profiles created before the setting existed', async () => {
    vi.stubGlobal('chrome', {
      storage: { local: { get: vi.fn(async () => ({ serverAddress: '100.95.83.128' })) } },
    });

    await expect(getStorageAll()).resolves.toMatchObject({
      serverAddress: '100.95.83.128',
      localUrlHost: '100.95.83.128',
    });
  });

  it('preserves an explicit blank value for browser-local services', async () => {
    vi.stubGlobal('chrome', {
      storage: {
        local: { get: vi.fn(async () => ({ serverAddress: '100.95.83.128', localUrlHost: '' })) },
      },
    });

    await expect(getStorageAll()).resolves.toMatchObject({ localUrlHost: '' });
  });
});
