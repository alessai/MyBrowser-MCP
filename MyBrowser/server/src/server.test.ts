import { createServer as createNetServer } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { Context } from "./context.js";
import { PROTOCOL_VERSION } from "./protocol.js";
import { createServerWithTools, stateManager } from "./server.js";
import type { LocalStateManager } from "./state-manager.js";
import { createWebSocketServer, type WsServerResult } from "./ws-server.js";

const token = "production-close-token";
const sockets: WebSocket[] = [];
const wsServers: WsServerResult[] = [];
const mcpServers: Array<{ close: () => Promise<void> }> = [];

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
