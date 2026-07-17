import { createServer as createNetServer } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { Context } from "./context.js";
import { getRecentIssues } from "./logger.js";
import { PROTOCOL_VERSION } from "./protocol.js";
import { createServerWithTools, stateManager } from "./server.js";
import type { LocalStateManager } from "./state-manager.js";
import { TelemetryManager, type TelemetrySink } from "./telemetry/manager.js";
import type { TelemetryEvent } from "./telemetry/types.js";
import { createWebSocketServer, type WsServerResult } from "./ws-server.js";

const token = "production-close-token";
const sockets: WebSocket[] = [];
const wsServers: WsServerResult[] = [];
const mcpServers: Array<{ close: () => Promise<void> }> = [];

class ServerMemoryTelemetrySink implements TelemetrySink {
  readonly events: TelemetryEvent[] = [];
  readonly close = vi.fn(async () => undefined);
  readonly flush = vi.fn(async () => undefined);

  emit(event: TelemetryEvent): void {
    this.events.push(event);
  }
}

const recording = {
  name: "Shutdown_Record",
  startedAt: 100,
  stoppedAt: 200,
  url: "https://example.test/",
  steps: [{
    action: "browser_click",
    args: { element: "Save" },
    timestamp: 110,
    durationMs: 5,
    url: "https://example.test/",
  }],
  requiredVariables: [],
};

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

async function freePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("Failed to allocate port");
  await new Promise<void>((resolve, reject) => {
    probe.close((error) => error ? reject(error) : resolve());
  });
  return address.port;
}

async function connect(port: number): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  sockets.push(ws);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  return ws;
}

function waitForMessage(ws: WebSocket): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const onMessage = (data: Buffer | string) => {
      cleanup();
      resolve(JSON.parse(data.toString()));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      ws.off("message", onMessage);
      ws.off("error", onError);
    };
    ws.on("message", onMessage);
    ws.on("error", onError);
  });
}

async function authenticate(ws: WebSocket, role: "client" | "extension") {
  const response = waitForMessage(ws);
  ws.send(JSON.stringify({ type: "auth", token, protocolVersion: PROTOCOL_VERSION, role }));
  return response;
}

async function callHubRpc(
  ws: WebSocket,
  id: string,
  method: string,
  params: Record<string, unknown> = {},
) {
  const response = waitForMessage(ws);
  ws.send(JSON.stringify({ type: "hub_rpc", id, method, params }));
  return response;
}

afterEach(async () => {
  await Promise.allSettled(mcpServers.splice(0).map((server) => server.close()));
  await Promise.allSettled(wsServers.splice(0).map((server) => server.close()));
  for (const ws of sockets.splice(0)) {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.terminate();
    }
  }
  vi.restoreAllMocks();
});

describe("production server shutdown wrapper", () => {
  it("establishes the hub barrier before a blocked persistence finalizer", async () => {
    const port = await freePort();
    const server = await createServerWithTools({
      host: "127.0.0.1",
      port,
      token,
      sessionId: "production-session",
    });
    mcpServers.push(server);
    const extension = await connect(port);
    await authenticate(extension, "extension");
    const client = await connect(port);
    await authenticate(client, "client");
    await callHubRpc(client, "register-production", "registerSession", {
      sessionId: "production-session",
    });
    const localState = stateManager as LocalStateManager;
    await localState.reserveRecording("production-session", recording.name, 1_800_000);
    const persistEntered = deferred<void>();
    const allowPersist = deferred<boolean>();
    vi.spyOn(localState, "hasRecordingReservation").mockImplementation(async () => {
      persistEntered.resolve();
      return allowPersist.promise;
    });
    extension.send(JSON.stringify({
      type: "persistRecording",
      id: "blocked-persist",
      sessionId: "production-session",
      payload: recording,
    }));
    await persistEntered.promise;

    const closing = server.close();
    const mutation = callHubRpc(client, "late-mutation", "sharedSet", {
      key: "shutdown-leak",
      value: "forbidden",
    });
    const newcomer = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    sockets.push(newcomer);
    const newcomerOutcome = await Promise.race([
      new Promise<{ reason?: string; message?: Record<string, unknown> }>((resolve) => {
        newcomer.once("open", () => {
          newcomer.send(JSON.stringify({
            type: "auth",
            token,
            protocolVersion: PROTOCOL_VERSION,
            role: "client",
          }));
        });
        newcomer.once("message", (data) => resolve({ message: JSON.parse(data.toString()) }));
        newcomer.once("close", (_code, reason) => resolve({ reason: reason.toString() }));
      }),
      new Promise<{ timedOut: true }>((resolve) => {
        setTimeout(() => resolve({ timedOut: true }), 500);
      }),
    ]);
    allowPersist.resolve(false);

    await expect(mutation).resolves.toMatchObject({ error: "SERVER_SHUTTING_DOWN" });
    expect(newcomerOutcome).toEqual({ reason: "SERVER_SHUTTING_DOWN" });
    await closing;
    expect(await localState.sharedGet("shutdown-leak")).toBeUndefined();
    expect(await localState.listSessions()).toEqual([]);
  }, 5_000);

  it("uses remote-client close as the sole unregister owner", async () => {
    const hub = await createWebSocketServer({
      host: "127.0.0.1",
      port: 0,
      token,
      context: new Context(),
    });
    wsServers.push(hub);
    const server = await createServerWithTools({
      host: "127.0.0.1",
      port: hub.boundPort,
      token,
      sessionId: "remote-production-session",
    });
    mcpServers.push(server);

    const closing = server.close();
    await expect(stateManager.sharedSet("remote-shutdown-leak", true))
      .rejects.toThrow("SERVER_SHUTTING_DOWN");
    await closing;

    expect(await hub.stateManager.sharedGet("remote-shutdown-leak")).toBeUndefined();
    expect((await hub.stateManager.listSessions()).map(({ id }) => id))
      .not.toContain("remote-production-session");
  }, 5_000);
});

describe("production server diagnostics privacy", () => {
  it("does not retain raw tool arguments on the failure path", async () => {
    const canary = "RAW_DIAGNOSTICS_CANARY_7f3d";
    const port = await freePort();
    const server = await createServerWithTools({
      host: "127.0.0.1",
      port,
      token,
      sessionId: "diagnostics-privacy-session",
    });
    mcpServers.push(server);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "diagnostics-privacy-test", version: "1.0.0" });
    await client.connect(clientTransport);

    try {
      const response = await client.callTool({
        name: "browser_eval",
        arguments: { code: canary, tabId: 77 },
      });
      expect(response.isError).toBe(true);

      const issue = [...getRecentIssues(100)].reverse().find((candidate) => (
        candidate.area === "tool_failure"
        && candidate.toolName === "browser_eval"
        && candidate.sessionId === "diagnostics-privacy-session"
      ));
      expect(issue).toBeDefined();
      expect(JSON.stringify(issue)).not.toContain(canary);
      expect(issue?.details).toMatchObject({
        arguments: {
          presence: ["code", "tabId"],
          scalar: { "code.length": "17-64" },
          counts: {},
          pseudonyms: {},
          droppedFields: 1,
          truncated: false,
        },
      });
    } finally {
      await client.close();
    }
  });
});

describe("production server root telemetry", () => {
  it("records bounded list and tool lifecycles without changing MCP results", async () => {
    const canary = "RAW_SERVER_ROOT_CANARY_91d4";
    const rawSession = "RAW_SERVER_SESSION_IDENTIFIER";
    const sink = new ServerMemoryTelemetrySink();
    let id = 0;
    const telemetry = TelemetryManager.fromSink(sink, {
      runId: "server-root-run",
      installKey: Buffer.alloc(32, 6),
      randomUUID: () => `server-event-${++id}`,
    });
    const port = await freePort();
    const server = await createServerWithTools({
      host: "127.0.0.1",
      port,
      token,
      sessionId: rawSession,
      telemetry,
    });
    mcpServers.push(server);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "root-telemetry-test", version: "2.3.4" });
    await client.connect(clientTransport);

    try {
      const tools = await client.listTools();
      expect(tools.tools.length).toBeGreaterThan(0);
      const localSuccess = await client.callTool({ name: "list_browsers", arguments: {} });
      expect(localSuccess.isError).not.toBe(true);
      vi.spyOn(stateManager, "shouldEnforceOwnership").mockResolvedValue(true);
      const ownershipDenied = await client.callTool({
        name: "browser_click",
        arguments: { element: canary },
      });
      expect(ownershipDenied.isError).toBe(true);
      const noBrowser = await client.callTool({
        name: "browser_eval",
        arguments: { code: canary, tabId: 44 },
      });
      expect(noBrowser.isError).toBe(true);
      const missing = await client.callTool({ name: "definitely_missing_tool", arguments: {} });
      expect(missing.isError).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }

    const listed = sink.events.find((event) => event.type === "tools_listed");
    expect(listed).toMatchObject({
      type: "tools_listed",
      clientName: "root-telemetry-test",
      clientVersion: "2.3.4",
      clientSupportsSampling: false,
      clientSupportsRoots: false,
      clientSupportsElicitation: false,
    });
    expect(listed).toHaveProperty("schemaDigest");

    const started = sink.events.filter((event) => event.type === "tool_started");
    const terminals = sink.events.filter((event) => (
      event.type === "tool_completed" || event.type === "tool_failed"
    ));
    expect(started.map((event) => event.toolName)).toEqual([
      "list_browsers",
      "browser_click",
      "browser_eval",
      "unknown_tool",
    ]);
    expect(terminals).toHaveLength(started.length);
    expect(terminals).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "tool_completed", toolName: "list_browsers" }),
      expect.objectContaining({
        type: "tool_failed",
        toolName: "browser_click",
        errorCategory: "ownership_denied",
      }),
      expect.objectContaining({ type: "tool_failed", toolName: "browser_eval" }),
      expect.objectContaining({
        type: "tool_failed",
        toolName: "unknown_tool",
        errorCategory: "invalid_arguments",
      }),
    ]));
    expect(sink.events.filter((event) => event.type === "run_stopped")).toHaveLength(1);
    expect(sink.close).toHaveBeenCalledTimes(1);
    const serialized = JSON.stringify(sink.events);
    expect(serialized).not.toContain(canary);
    expect(serialized).not.toContain(rawSession);
    expect(serialized).not.toContain("definitely_missing_tool");
    expect(serialized).not.toMatch(/"(?:model|provider|prompt)"/u);
  });

  it("closes an injected manager when server setup fails", async () => {
    const sink = new ServerMemoryTelemetrySink();
    const telemetry = TelemetryManager.fromSink(sink, {
      runId: "failed-setup-run",
      installKey: Buffer.alloc(32, 7),
      randomUUID: () => "failed-setup-event",
    });

    await expect(createServerWithTools({
      host: "127.0.0.1",
      port: -1,
      token,
      sessionId: "failed-setup-session",
      telemetry,
    })).rejects.toBeDefined();

    expect(sink.events.map((event) => event.type)).toEqual(["run_started", "run_stopped"]);
    expect(sink.close).toHaveBeenCalledTimes(1);
  });
});
