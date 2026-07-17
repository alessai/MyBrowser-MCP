import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { Context } from "./context.js";
import { TelemetryManager, type TelemetrySink } from "./telemetry/manager.js";
import type { TelemetryEvent } from "./telemetry/types.js";

class MemorySink implements TelemetrySink {
  readonly events: TelemetryEvent[] = [];
  emit(event: TelemetryEvent): void { this.events.push(event); }
  async flush(): Promise<void> {}
  async close(): Promise<void> {}
}

class FakeSocket {
  readonly OPEN = 1;
  readyState = this.OPEN;
  readonly sent: string[] = [];
  sendError?: Error;
  private readonly listeners = new Map<string, Set<(event: { data?: Buffer }) => void>>();

  addEventListener(type: string, listener: (event: { data?: Buffer }) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: { data?: Buffer }) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string): void {
    if (this.sendError) throw this.sendError;
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.dispatch("close");
  }

  dispatch(type: string, data?: unknown): void {
    const event = data === undefined
      ? {}
      : { data: Buffer.from(typeof data === "string" ? data : JSON.stringify(data)) };
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  listenerCount(): number {
    return [...this.listeners.values()].reduce((count, listeners) => count + listeners.size, 0);
  }
}

function enabledManager(sink: MemorySink): TelemetryManager {
  return TelemetryManager.fromSink(sink, {
    runId: "run-context",
    installKey: Buffer.alloc(32, 5),
  });
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

const sockets: WebSocket[] = [];
const servers: WebSocketServer[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
});

async function loopback(): Promise<{ client: WebSocket; server: WebSocket }> {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  servers.push(wss);
  await new Promise<void>((resolve) => wss.once("listening", resolve));
  const address = wss.address();
  if (!address || typeof address === "string") throw new Error("Missing loopback port");
  const accepted = new Promise<WebSocket>((resolve) => wss.once("connection", resolve));
  const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
  sockets.push(client);
  await new Promise<void>((resolve, reject) => {
    client.once("open", resolve);
    client.once("error", reject);
  });
  const server = await accepted;
  sockets.push(server);
  return { client, server };
}

describe("Context shutdown", () => {
  it("rejects pending and new extension correlations idempotently", async () => {
    const { client, server } = await loopback();
    const context = new Context();
    const browserId = context.addBrowser(server);
    const firstRequest = new Promise<void>((resolve) => client.once("message", () => resolve()));
    const pending = context.sendSocketMessageToBrowser(
      browserId,
      "browser_click",
      { tabId: 1 },
      { timeoutMs: 60_000 },
    );
    await firstRequest;

    context.beginShutdown();
    context.beginShutdown();

    await expect(pending).rejects.toThrow("SERVER_SHUTTING_DOWN");
    await expect(context.sendSocketMessageToBrowser(
      browserId,
      "browser_click",
      { tabId: 2 },
      { timeoutMs: 60_000 },
    )).rejects.toThrow("SERVER_SHUTTING_DOWN");
  });
});

describe("Context telemetry correlation", () => {
  it("keeps the disabled request envelope byte-for-byte free of trace metadata", async () => {
    const socket = new FakeSocket();
    const context = new Context();
    context.sessionId = "session-a";
    const browserId = context.addBrowser(socket as unknown as WebSocket);

    const pending = context.sendSocketMessageToBrowser(browserId, "browser_click", { tabId: 7 });
    await nextTurn();
    const request = JSON.parse(socket.sent[0]!);
    expect(request).toEqual({
      id: expect.any(String),
      type: "browser_click",
      payload: { tabId: 7 },
      sessionId: "session-a",
      timeoutMs: 30_000,
    });
    expect(request).not.toHaveProperty("trace");

    socket.dispatch("message", {
      type: "messageResponse",
      payload: { requestId: request.id, result: { ok: true } },
    });
    await expect(pending).resolves.toEqual({ ok: true });
  });

  it("does not invent a root for standalone socket calls", async () => {
    const sink = new MemorySink();
    const manager = enabledManager(sink);
    const socket = new FakeSocket();
    const context = new Context(manager);
    context.sessionId = "session-a";
    const browserId = context.addBrowser(socket as unknown as WebSocket);

    const pending = context.sendSocketMessageToBrowser(browserId, "browser_click", { tabId: 7 });
    await nextTurn();
    const request = JSON.parse(socket.sent[0]!);
    expect(request).not.toHaveProperty("trace");
    socket.dispatch("message", {
      type: "messageResponse",
      payload: { requestId: request.id, result: true },
    });
    await expect(pending).resolves.toBe(true);
    expect(sink.events.some((event) => event.type.startsWith("transport_"))).toBe(false);
    await manager.close();
  });

  it("adds one bounded trace context and one terminal transport span", async () => {
    const sink = new MemorySink();
    const manager = enabledManager(sink);
    const socket = new FakeSocket();
    const context = new Context(manager);
    context.sessionId = "session-a";
    const browserId = context.addBrowser(socket as unknown as WebSocket);

    const pending = manager.runToolCall({
      sessionId: "session-a",
      toolName: "browser_click",
      arguments: { tabId: 7, element: "Save" },
    }, () => context.sendSocketMessageToBrowser(browserId, "browser_click", { tabId: 7 }));
    await nextTurn();
    const request = JSON.parse(socket.sent[0]!);
    expect(request.trace).toEqual({
      schemaVersion: 1,
      traceId: expect.stringMatching(/^[A-Za-z0-9_-]{16,80}$/),
      rootCallId: expect.stringMatching(/^[A-Za-z0-9_-]{16,64}$/),
      transportSpanId: expect.stringMatching(/^[A-Za-z0-9_-]{16,64}$/),
    });

    socket.dispatch("message", {
      type: "messageResponse",
      payload: { requestId: request.id, result: { ok: true } },
    });
    await expect(pending).resolves.toEqual({ ok: true });

    const transports = sink.events.filter((event): event is Extract<
      TelemetryEvent,
      { type: "transport_started" | "transport_completed" | "transport_failed" }
    > => event.type.startsWith("transport_"));
    expect(transports.map((event) => event.type)).toEqual(["transport_started", "transport_completed"]);
    expect(transports[0]?.traceId).toBe(request.trace.traceId);
    expect(transports[1]?.traceId).toBe(request.trace.traceId);
    expect((transports[0] as Extract<TelemetryEvent, { type: "transport_started" }>).transportSpanId)
      .toBe((transports[1] as Extract<TelemetryEvent, { type: "transport_completed" }>).transportSpanId);
    expect(JSON.stringify(sink.events)).not.toContain("Save");
    await manager.close();
  });

  it("keeps composite and out-of-order overlapping transport spans isolated", async () => {
    const sink = new MemorySink();
    const manager = enabledManager(sink);
    const socket = new FakeSocket();
    const context = new Context(manager);
    context.sessionId = "session-a";
    const browserId = context.addBrowser(socket as unknown as WebSocket);

    const first = manager.runToolCall({
      sessionId: "session-a",
      toolName: "browser_click",
      arguments: { tabId: 1, element: "A" },
    }, () => context.sendSocketMessageToBrowser(browserId, "browser_click", { tabId: 1 }));
    const second = manager.runToolCall({
      sessionId: "session-a",
      toolName: "browser_click",
      arguments: { tabId: 2, element: "B" },
    }, () => context.sendSocketMessageToBrowser(browserId, "browser_click", { tabId: 2 }));
    await nextTurn();
    const [firstRequest, secondRequest] = socket.sent.map((message) => JSON.parse(message));
    expect(firstRequest.trace.traceId).not.toBe(secondRequest.trace.traceId);
    socket.dispatch("message", {
      type: "messageResponse",
      payload: { requestId: secondRequest.id, result: "second" },
    });
    socket.dispatch("message", {
      type: "messageResponse",
      payload: { requestId: firstRequest.id, result: "first" },
    });
    await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"]);

    const completed = sink.events.filter((event): event is Extract<TelemetryEvent, { type: "transport_completed" }> => (
      event.type === "transport_completed"
    ));
    expect(new Set(completed.map((event) => event.traceId))).toEqual(new Set([
      firstRequest.trace.traceId,
      secondRequest.trace.traceId,
    ]));

    socket.sent.splice(0);
    const composite = manager.runToolCall({
      sessionId: "session-a",
      toolName: "browser_action",
      arguments: { steps: [] },
    }, async () => {
      const left = context.sendSocketMessageToBrowser(browserId, "browser_click", { tabId: 3 });
      const right = context.sendSocketMessageToBrowser(browserId, "browser_click", { tabId: 4 });
      await nextTurn();
      const requests = socket.sent.map((message) => JSON.parse(message));
      expect(requests[0].trace.traceId).toBe(requests[1].trace.traceId);
      for (const request of requests) {
        socket.dispatch("message", {
          type: "messageResponse",
          payload: { requestId: request.id, result: true },
        });
      }
      return Promise.all([left, right]);
    });
    await expect(composite).resolves.toEqual([true, true]);
    const compositeStarts = sink.events.filter((event): event is Extract<TelemetryEvent, { type: "transport_started" }> => (
      event.type === "transport_started"
      && event.traceId === JSON.parse(socket.sent[0]!).trace.traceId
    ));
    expect(new Set(compositeStarts.map((event) => event.transportSpanId)).size).toBe(2);
    await manager.close();
  });

  it("emits exactly one failed terminal span for every transport failure path", async () => {
    const cases: Array<{
      name: string;
      expectedCategory: Extract<TelemetryEvent, { type: "transport_failed" }>["errorCategory"];
      configure?: (socket: FakeSocket) => void;
      trigger?: (socket: FakeSocket, context: Context, request: Record<string, unknown>) => Promise<void> | void;
      timeoutMs?: number;
    }> = [
      {
        name: "response error",
        expectedCategory: "extension_tool_failed",
        trigger: (socket, _context, request) => socket.dispatch("message", {
          type: "messageResponse",
          payload: { requestId: request.id, error: "RECORDED_TOOL_ACTION_FAILED" },
        }),
      },
      {
        name: "timeout",
        expectedCategory: "timeout",
        timeoutMs: 5,
        trigger: async () => new Promise((resolve) => setTimeout(resolve, 15)),
      },
      {
        name: "socket error",
        expectedCategory: "not_connected",
        trigger: (socket) => socket.dispatch("error"),
      },
      {
        name: "disconnect",
        expectedCategory: "not_connected",
        trigger: (socket) => socket.dispatch("close"),
      },
      {
        name: "shutdown cancellation",
        expectedCategory: "session_closed",
        trigger: (_socket, context) => context.beginShutdown(),
      },
      {
        name: "send throw",
        expectedCategory: "internal_failure",
        configure: (socket) => { socket.sendError = new Error("send failed"); },
      },
    ];

    for (const scenario of cases) {
      const sink = new MemorySink();
      const manager = enabledManager(sink);
      const socket = new FakeSocket();
      scenario.configure?.(socket);
      const context = new Context(manager);
      context.sessionId = "session-a";
      const browserId = context.addBrowser(socket as unknown as WebSocket);
      const observed = manager.runToolCall({
        sessionId: "session-a",
        toolName: "browser_click",
        arguments: { tabId: 1, element: "Save" },
      }, () => context.sendSocketMessageToBrowser(
        browserId,
        "browser_click",
        { tabId: 1 },
        { timeoutMs: scenario.timeoutMs ?? 1_000 },
      )).then(
        () => undefined,
        (error: unknown) => error,
      );
      await nextTurn();
      const request = socket.sent[0] ? JSON.parse(socket.sent[0]) : {};
      await scenario.trigger?.(socket, context, request);
      expect(await observed, scenario.name).toBeInstanceOf(Error);

      const transports = sink.events.filter((event) => event.type.startsWith("transport_"));
      expect(transports.map((event) => event.type), scenario.name).toEqual([
        "transport_started",
        "transport_failed",
      ]);
      expect(
        (transports[1] as Extract<TelemetryEvent, { type: "transport_failed" }>).errorCategory,
        scenario.name,
      ).toBe(scenario.expectedCategory);
      expect(socket.listenerCount(), scenario.name).toBe(0);
      await manager.close();
    }
  });

  it("fails cyclic payload serialization once without installing listeners", async () => {
    const sink = new MemorySink();
    const manager = enabledManager(sink);
    const socket = new FakeSocket();
    const context = new Context(manager);
    context.sessionId = "session-a";
    const browserId = context.addBrowser(socket as unknown as WebSocket);
    const payload: Record<string, unknown> = {};
    payload.self = payload;

    const observed = manager.runToolCall({
      sessionId: "session-a",
      toolName: "browser_click",
      arguments: { tabId: 1, element: "Save" },
    }, () => context.sendSocketMessageToBrowser(browserId, "browser_click", payload)).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(await observed).toBeInstanceOf(TypeError);
    expect(socket.listenerCount()).toBe(0);
    expect(socket.sent).toEqual([]);
    const transports = sink.events.filter((event) => event.type.startsWith("transport_"));
    expect(transports.map((event) => event.type)).toEqual(["transport_started", "transport_failed"]);
    expect((transports[1] as Extract<TelemetryEvent, { type: "transport_failed" }>).errorCategory)
      .toBe("internal_failure");
    await manager.close();
  });

  it("accepts and strips direct and hub extension summaries using pseudonyms only", async () => {
    const sink = new MemorySink();
    const manager = enabledManager(sink);
    const socket = new FakeSocket();
    const context = new Context(manager);
    context.sessionId = "session-a";
    const browserId = context.addBrowser(socket as unknown as WebSocket);

    const invoke = async (extensionRequestId: string | undefined, responseError?: string) => {
      const pending = manager.runToolCall({
        sessionId: "session-a", toolName: "browser_click",
        arguments: { tabId: 7, element: "Save" },
      }, () => context.sendSocketMessageToBrowser(browserId, "browser_click", { tabId: 7 }));
      await nextTurn();
      const request = JSON.parse(socket.sent.at(-1)!);
      const telemetry = {
        schemaVersion: 1,
        traceId: request.trace.traceId,
        transportSpanId: request.trace.transportSpanId,
        extensionRequestId: extensionRequestId ?? request.id,
        offscreenReceivedToBackgroundMs: 1,
        queueWaitMs: 2,
        handlerMs: 3,
        resolvedTabId: 7,
        stateSignals: { tabChanged: true, pathChanged: false },
        errorCategory: "extension_tool_failed",
      };
      socket.dispatch("message", {
        type: "messageResponse",
        payload: {
          requestId: request.id,
          ...(responseError ? { error: responseError } : { result: { ok: true } }),
          telemetry,
        },
      });
      return { pending, request };
    };

    const direct = await invoke(undefined);
    await expect(direct.pending).resolves.toEqual({ ok: true });
    const hub = await invoke("hub_RAW_EXTENSION_ID_CANARY");
    await expect(hub.pending).resolves.toEqual({ ok: true });
    const error = await invoke(undefined, "RAW_PAGE_ERROR_CANARY");
    await expect(error.pending).rejects.toThrow("RAW_PAGE_ERROR_CANARY");

    const summaries = sink.events.filter((event): event is Extract<
      TelemetryEvent, { type: "extension_summary" }
    > => event.type === "extension_summary");
    expect(summaries).toHaveLength(3);
    expect(summaries.map((event) => event.routeMode)).toEqual(["direct", "hub", "direct"]);
    expect(summaries[0]).toEqual(expect.objectContaining({
      offscreenReceivedToBackgroundMs: 1, queueWaitMs: 2, handlerMs: 3,
      errorCategory: "extension_tool_failed", tabChanged: true, pathChanged: false,
      resolvedTabPseudonym: expect.any(String), extensionRequestPseudonym: expect.any(String),
    }));
    expect(summaries[1]?.extensionRequestPseudonym).not.toBe("hub_RAW_EXTENSION_ID_CANARY");
    expect(summaries[0]?.resolvedTabPseudonym).not.toBe("7");
    const evidence = JSON.stringify(sink.events);
    expect(evidence).not.toContain("hub_RAW_EXTENSION_ID_CANARY");
    expect(evidence).not.toContain("RAW_PAGE_ERROR_CANARY");
    await manager.close();
  });

  it("turns malformed extension summaries into one bounded integrity event without changing results", async () => {
    const cases = [
      {
        reason: "oversized",
        telemetry: {
          schemaVersion: 1, traceId: "trace_1234567890abcdef",
          transportSpanId: "span_1234567890abcdefg", extensionRequestId: "hub_1",
          extra: `RAW_OVERSIZED_CANARY${"x".repeat(20_000)}`,
        },
      },
      {
        reason: "unsupported_version",
        telemetry: { schemaVersion: 2, marker: "RAW_VERSION_CANARY" },
      },
      {
        reason: "malformed",
        telemetry: {
          traceId: "trace_1234567890abcdef", transportSpanId: "span_1234567890abcdefg",
          extensionRequestId: "RAW_MALFORMED_CANARY",
        },
      },
      { reason: "mismatched_trace", telemetry: null },
    ] as const;

    for (const scenario of cases) {
      const sink = new MemorySink();
      const manager = enabledManager(sink);
      const socket = new FakeSocket();
      const context = new Context(manager);
      context.sessionId = "session-a";
      const browserId = context.addBrowser(socket as unknown as WebSocket);
      const pending = manager.runToolCall({
        sessionId: "session-a", toolName: "browser_click", arguments: { tabId: 1, element: "Save" },
      }, () => context.sendSocketMessageToBrowser(browserId, "browser_click", { tabId: 1 }));
      await nextTurn();
      const request = JSON.parse(socket.sent[0]!);
      const telemetry = scenario.reason === "mismatched_trace" ? {
        schemaVersion: 1,
        traceId: "different_trace_123456",
        transportSpanId: request.trace.transportSpanId,
        extensionRequestId: "hub_1",
      } : scenario.telemetry;
      socket.dispatch("message", {
        type: "messageResponse",
        payload: { requestId: request.id, result: "unchanged-result", telemetry },
      });
      await expect(pending).resolves.toBe("unchanged-result");
      const integrity = sink.events.filter((event) => event.type === "telemetry_integrity");
      expect(integrity).toEqual([expect.objectContaining({
        reason: scenario.reason, sizeBucket: expect.any(String),
      })]);
      expect(JSON.stringify(sink.events)).not.toContain("RAW_");
      await manager.close();
    }
  });
});
