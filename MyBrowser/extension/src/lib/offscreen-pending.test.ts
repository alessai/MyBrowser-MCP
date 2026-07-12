import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PendingToolRequests } from "./offscreen-pending";
import { ReconnectingWebSocket } from "./reconnecting-ws";

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  readonly sent: string[] = [];
  readonly closes: Array<{ code?: number; reason?: string }> = [];
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason });
    this.onclose?.({ code, reason } as CloseEvent);
  }

  open(): void {
    this.onopen?.(new Event("open"));
  }

  receive(data: unknown): void {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent);
  }
}

function toolRequest(id: string): string {
  return JSON.stringify({
    id,
    type: "browser_click",
    payload: { tabId: 7 },
    sessionId: "session-a",
    timeoutMs: 30_000,
  });
}

describe("PendingToolRequests", () => {
  it("fails each request still pending after matching responses complete", () => {
    const pending = new PendingToolRequests();
    const sent: string[] = [];

    pending.trackInbound(toolRequest("r1"));
    pending.trackInbound(toolRequest("r2"));
    pending.completeOutbound(
      JSON.stringify({ type: "messageResponse", payload: { requestId: "r1", result: "ok" } }),
    );
    pending.failAll((raw) => sent.push(raw));

    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]!)).toEqual({
      type: "messageResponse",
      payload: { requestId: "r2", error: "EXTENSION_WORKER_RESTARTED" },
    });
  });

  it("ignores malformed, control, legacy, and unmatched response messages", () => {
    const pending = new PendingToolRequests();
    const sent: string[] = [];

    pending.trackInbound("not json");
    pending.trackInbound(JSON.stringify({ type: "ping" }));
    pending.trackInbound(JSON.stringify({ id: "legacy", type: "browser_click", payload: {} }));
    pending.trackInbound(toolRequest("r1"));
    pending.completeOutbound("not json");
    pending.completeOutbound(JSON.stringify({ type: "pong" }));
    pending.completeOutbound(
      JSON.stringify({ type: "messageResponse", payload: { requestId: "other", result: "ok" } }),
    );
    pending.failAll((raw) => sent.push(raw));
    pending.failAll((raw) => sent.push(raw));

    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]!)).toEqual({
      type: "messageResponse",
      payload: { requestId: "r1", error: "EXTENSION_WORKER_RESTARTED" },
    });
  });

  it("attempts every pending failure once when a sender throws", () => {
    const pending = new PendingToolRequests();
    const attempted: string[] = [];

    pending.trackInbound(toolRequest("r1"));
    pending.trackInbound(toolRequest("r2"));
    pending.trackInbound(toolRequest("r3"));

    expect(() => pending.failAll((raw) => {
      const requestId = JSON.parse(raw).payload.requestId as string;
      attempted.push(requestId);
      if (requestId === "r1") throw new Error("socket closed");
    })).not.toThrow();
    pending.failAll((raw) => attempted.push(JSON.parse(raw).payload.requestId as string));

    expect(attempted).toEqual(["r1", "r2", "r3"]);
  });
});

describe("ReconnectingWebSocket v2 authentication", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.spyOn(Math, "random").mockReturnValue(0.5);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each([undefined, 1])(
    "latches auth success with protocolVersion %s without automatic retry",
    (protocolVersion) => {
      const onConnected = vi.fn();
      const onProtocolError = vi.fn();
      const client = new ReconnectingWebSocket();

      client.connect(
        "ws://localhost:1234",
        "secret",
        { onConnected, onProtocolError },
        "browser-a",
      );
      const first = FakeWebSocket.instances[0]!;
      first.open();

      expect(JSON.parse(first.sent[0]!)).toEqual({
        type: "auth",
        token: "secret",
        role: "extension",
        protocolVersion: 2,
        browserName: "browser-a",
      });

      first.receive({ type: "auth", status: "ok", protocolVersion });

      expect(client.getState()).not.toBe("CONNECTED");
      expect(onConnected).not.toHaveBeenCalled();
      expect(onProtocolError).toHaveBeenCalledOnce();
      expect(first.closes).toEqual([{ code: 4406, reason: "Protocol version mismatch" }]);

      vi.advanceTimersByTime(60_000);
      expect(FakeWebSocket.instances).toHaveLength(1);
    },
  );

  it("suppresses normal reconnect with unchanged settings while latched", () => {
    const client = new ReconnectingWebSocket();

    client.connect("ws://localhost:1234", "secret", undefined, "browser-a");
    const first = FakeWebSocket.instances[0]!;
    first.open();
    first.receive({ type: "auth", status: "ok", protocolVersion: 1 });

    client.connect("ws://localhost:1234", "secret", undefined, "browser-a");
    vi.advanceTimersByTime(60_000);

    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("clears the latch when connection settings change", () => {
    const onConnected = vi.fn();
    const client = new ReconnectingWebSocket();

    client.connect("ws://localhost:1234", "secret", { onConnected }, "browser-a");
    const first = FakeWebSocket.instances[0]!;
    first.open();
    first.receive({ type: "auth", status: "ok", protocolVersion: 1 });

    client.connect("ws://localhost:1234", "new-secret", { onConnected }, "browser-a");
    const second = FakeWebSocket.instances[1]!;
    second.open();
    expect(JSON.parse(second.sent[0]!)).toMatchObject({
      type: "auth",
      token: "new-secret",
      role: "extension",
      protocolVersion: 2,
    });
    second.receive({ type: "auth", status: "ok", protocolVersion: 2 });

    expect(client.getState()).toBe("CONNECTED");
    expect(onConnected).toHaveBeenCalledOnce();
    client.disconnect();
  });

  it("clears the latch when an explicit reconnect is requested", () => {
    const client = new ReconnectingWebSocket();

    client.connect("ws://localhost:1234", "secret", undefined, "browser-a");
    const first = FakeWebSocket.instances[0]!;
    first.open();
    first.receive({ type: "auth", status: "ok", protocolVersion: 1 });

    client.forceReconnect();
    const second = FakeWebSocket.instances[1]!;
    second.open();

    expect(JSON.parse(second.sent[0]!)).toMatchObject({
      type: "auth",
      token: "secret",
      role: "extension",
      protocolVersion: 2,
    });
    client.disconnect();
  });
});
