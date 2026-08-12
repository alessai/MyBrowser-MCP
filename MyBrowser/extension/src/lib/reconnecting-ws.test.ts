import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ReconnectingWebSocket } from './reconnecting-ws';

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];

  constructor(_url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void { this.sent.push(data); }
  close(): void { /* test-controlled */ }
  open(): void { this.onopen?.(); }
  receive(value: unknown): void { this.onmessage?.({ data: JSON.stringify(value) }); }
}

describe('ReconnectingWebSocket temporary-tab reconciliation', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('fetches fresh tracked sessions for every auth attempt and returns the accepted intersection', async () => {
    const beforeAuthenticate = vi.fn()
      .mockResolvedValueOnce(['session-a'])
      .mockResolvedValueOnce(['session-b']);
    const onConnected = vi.fn();
    const client = new ReconnectingWebSocket();
    client.connect('ws://localhost:1234', 'secret', { beforeAuthenticate, onConnected }, 'browser-a');

    const first = FakeWebSocket.instances[0]!;
    first.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(JSON.parse(first.sent[0]!)).toMatchObject({ temporaryTabSessionIds: ['session-a'] });
    first.receive({
      type: 'auth', status: 'ok', protocolVersion: 2,
      browserId: 'browser-a', finalizedSessionIds: ['session-a'],
    });
    expect(onConnected).toHaveBeenCalledWith(['session-a'], ['session-a']);

    first.onclose?.();
    await vi.advanceTimersByTimeAsync(1_000);
    const second = FakeWebSocket.instances[1]!;
    second.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(JSON.parse(second.sent[0]!)).toMatchObject({ temporaryTabSessionIds: ['session-b'] });
    expect(beforeAuthenticate).toHaveBeenCalledTimes(2);
    client.disconnect();
  });

  it('authenticates with an empty list when collection exceeds two seconds', async () => {
    const client = new ReconnectingWebSocket();
    client.connect('ws://localhost:1234', 'secret', {
      beforeAuthenticate: () => new Promise(() => undefined),
    });
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(JSON.parse(socket.sent[0]!)).toMatchObject({ temporaryTabSessionIds: [] });
    client.disconnect();
  });

  it('does not let a stale collection authenticate a replacement socket', async () => {
    let resolveFirst!: (sessions: string[]) => void;
    const beforeAuthenticate = vi.fn()
      .mockImplementationOnce(() => new Promise<string[]>((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce(['session-b']);
    const client = new ReconnectingWebSocket();
    client.connect('ws://localhost:1234', 'secret', { beforeAuthenticate });
    const first = FakeWebSocket.instances[0]!;
    first.open();

    client.forceReconnect();
    const second = FakeWebSocket.instances[1]!;
    second.open();
    await vi.advanceTimersByTimeAsync(0);
    resolveFirst(['session-a']);
    await vi.advanceTimersByTimeAsync(0);

    expect(first.sent).toEqual([]);
    expect(JSON.parse(second.sent[0]!)).toMatchObject({ temporaryTabSessionIds: ['session-b'] });
    client.disconnect();
  });
});
