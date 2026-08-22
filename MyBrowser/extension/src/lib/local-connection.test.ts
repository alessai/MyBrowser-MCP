import { describe, expect, it } from 'vitest';

import { resolveConnectionTarget } from './local-connection';

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
