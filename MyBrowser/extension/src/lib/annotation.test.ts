import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./messaging', () => ({ sendToTab: vi.fn() }));
vi.mock('./tab-manager', () => ({ ensureContentScript: vi.fn() }));

import { captureAnnotationTab, openAnnotationOverlay } from './annotation';
import { sendToTab } from './messaging';
import { ensureContentScript } from './tab-manager';

describe('annotation tab safety', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('chrome', {
      tabs: {
        captureVisibleTab: vi.fn().mockResolvedValue('data:image/png;base64,abc'),
        query: vi.fn(),
      },
    });
  });

  it('repairs a stale content script before opening the overlay', async () => {
    await openAnnotationOverlay(7);

    expect(ensureContentScript).toHaveBeenCalledWith(7);
    expect(sendToTab).toHaveBeenCalledWith(7, 'open_annotation_overlay');
    expect(vi.mocked(ensureContentScript).mock.invocationCallOrder[0]!).toBeLessThan(
      vi.mocked(sendToTab).mock.invocationCallOrder[0]!,
    );
  });

  it('rejects a capture when another tab becomes active', async () => {
    vi.mocked(chrome.tabs.query)
      .mockResolvedValueOnce([{ id: 7 }] as chrome.tabs.Tab[])
      .mockResolvedValueOnce([{ id: 8 }] as chrome.tabs.Tab[]);

    await expect(captureAnnotationTab(7, 3)).rejects.toThrow('ANNOTATION_TAB_CHANGED');
  });

  it('captures only while the sender tab remains active', async () => {
    vi.mocked(chrome.tabs.query).mockResolvedValue([{ id: 7 }] as chrome.tabs.Tab[]);

    await expect(captureAnnotationTab(7, 3)).resolves.toBe('data:image/png;base64,abc');
    expect(chrome.tabs.captureVisibleTab).toHaveBeenCalledWith(3, { format: 'png' });
  });
});
