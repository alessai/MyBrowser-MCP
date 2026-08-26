import { describe, expect, it } from 'vitest';

import { resolveConnectionTarget, resolveNavigationUrl } from './local-connection';

describe('resolveConnectionTarget', () => {
  it('uses zero-entry loopback defaults without a token', () => {
    expect(resolveConnectionTarget({
      serverAddress: '',
      serverPort: 9009,
      authToken: '',
    })).toEqual({
      url: 'ws://127.0.0.1:9009',
      token: '',
    });
  });

  it('rejects a tokenless remote target', () => {
    expect(resolveConnectionTarget({
      serverAddress: '100.64.0.1',
      serverPort: 9009,
      authToken: '',
    })).toBeNull();
  });

  it('keeps token authentication for remote targets', () => {
    expect(resolveConnectionTarget({
      serverAddress: '100.64.0.1',
      serverPort: 9009,
      authToken: 'secret',
    })).toEqual({
      url: 'ws://100.64.0.1:9009',
      token: 'secret',
    });
  });

  it('formats IPv6 loopback safely', () => {
    expect(resolveConnectionTarget({
      serverAddress: '::1',
      serverPort: 9009,
      authToken: '',
    })).toEqual({
      url: 'ws://[::1]:9009',
      token: '',
    });
  });

  it('rejects invalid ports', () => {
    expect(resolveConnectionTarget({
      serverAddress: '127.0.0.1',
      serverPort: 0,
      authToken: '',
    })).toBeNull();
  });
});

describe('resolveNavigationUrl', () => {
  it.each([
    ['http://localhost:5173/path?q=1#section', 'http://devbox.tailnet.ts.net:5173/path?q=1#section'],
    ['https://127.0.0.1:8443/', 'https://devbox.tailnet.ts.net:8443/'],
    ['http://[::1]:3000/', 'http://devbox.tailnet.ts.net:3000/'],
  ])('maps loopback URL %s to the configured remote host', (url, expected) => {
    expect(resolveNavigationUrl(url, 'devbox.tailnet.ts.net')).toBe(expected);
  });

  it('preserves loopback URLs when this browser has no remote mapping', () => {
    expect(resolveNavigationUrl('http://127.0.0.1:5173/', '')).toBe('http://127.0.0.1:5173/');
  });

  it('does not rewrite non-loopback URLs', () => {
    const url = 'https://example.com/path';
    expect(resolveNavigationUrl(url, 'devbox.tailnet.ts.net')).toBe(url);
  });

  it.each(['https://devbox.tailnet.ts.net', 'devbox.tailnet.ts.net:8080', '127.0.0.1']) (
    'fails closed for invalid local URL host %s',
    (host) => {
      expect(() => resolveNavigationUrl('http://localhost:5173/', host))
        .toThrow('LOCAL_URL_HOST_INVALID');
    },
  );
});
