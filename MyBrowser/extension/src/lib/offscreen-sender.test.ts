import { describe, expect, it } from 'vitest';

import { isTrustedOffscreenSender } from './offscreen-sender';

describe('offscreen sender authorization', () => {
  const extensionId = 'extension-id';
  const offscreenUrl = 'chrome-extension://extension-id/offscreen.html';

  it('accepts only the extension-owned offscreen document', () => {
    expect(isTrustedOffscreenSender({ id: extensionId, url: offscreenUrl }, extensionId, offscreenUrl))
      .toBe(true);
    expect(isTrustedOffscreenSender({
      id: extensionId,
      url: 'https://example.com',
      tab: { id: 7 },
    }, extensionId, offscreenUrl)).toBe(false);
    expect(isTrustedOffscreenSender({
      id: extensionId,
      url: 'chrome-extension://extension-id/popup.html',
    }, extensionId, offscreenUrl)).toBe(false);
    expect(isTrustedOffscreenSender({ id: 'other', url: offscreenUrl }, extensionId, offscreenUrl))
      .toBe(false);
  });
});
