import { beforeEach, describe, expect, it, vi } from 'vitest';

import { InputDevice, waitForTabLoad } from './input-device';

describe('input navigation lifecycle', () => {
  const updatedListeners = new Set<(...args: unknown[]) => void>();
  const removedListeners = new Set<(...args: unknown[]) => void>();
  const navigationListeners = new Set<(...args: unknown[]) => void>();

  beforeEach(() => {
    vi.useFakeTimers();
    updatedListeners.clear();
    removedListeners.clear();
    navigationListeners.clear();
    vi.stubGlobal('chrome', {
      tabs: {
        get: vi.fn().mockResolvedValue({ status: 'loading' }),
        onUpdated: {
          addListener: (listener: (...args: unknown[]) => void) => updatedListeners.add(listener),
          removeListener: (listener: (...args: unknown[]) => void) => updatedListeners.delete(listener),
        },
        onRemoved: {
          addListener: (listener: (...args: unknown[]) => void) => removedListeners.add(listener),
          removeListener: (listener: (...args: unknown[]) => void) => removedListeners.delete(listener),
        },
      },
      webNavigation: {
        onBeforeNavigate: {
          addListener: (listener: (...args: unknown[]) => void) => navigationListeners.add(listener),
          removeListener: (listener: (...args: unknown[]) => void) => navigationListeners.delete(listener),
        },
      },
    });
  });

  it('rejects and removes listeners when the tab closes', async () => {
    const result = waitForTabLoad(7, 1_000);
    for (const listener of removedListeners) listener(7);

    await expect(result).rejects.toThrow('TAB_CLOSED');
    expect(updatedListeners.size).toBe(0);
    expect(removedListeners.size).toBe(0);
  });

  it('rejects and removes listeners when loading times out', async () => {
    const result = waitForTabLoad(7, 1_000);
    const rejection = expect(result).rejects.toThrow('TAB_LOAD_TIMEOUT');
    await vi.advanceTimersByTimeAsync(1_001);

    await rejection;
    expect(updatedListeners.size).toBe(0);
    expect(removedListeners.size).toBe(0);
  });

  it('removes the navigation listener when the action fails', async () => {
    const device = new InputDevice(7);

    await expect(device.waitForTabIfNavigationStarted(7, async () => {
      throw new Error('action failed');
    })).rejects.toThrow('action failed');
    expect(navigationListeners.size).toBe(0);
  });

  it('stops before a browser side effect after its request is aborted', async () => {
    const controller = new AbortController();
    const device = new InputDevice(7, controller.signal);
    controller.abort();

    await expect(device.click({ x: 1, y: 1 })).rejects.toMatchObject({ name: 'AbortError' });
  });
});
