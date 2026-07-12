import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { Context } from "./context.js";
import { PROTOCOL_VERSION, WS_CLOSE } from "./protocol.js";
import { createWebSocketServer, type WsServerResult } from "./ws-server.js";

const TOKEN = "test-token";

type CloseEvent = {
  code: number;
  reason: string;
};

const servers: WsServerResult[] = [];
const sockets: WebSocket[] = [];
const fakeHubs: WebSocketServer[] = [];

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
}

function waitForMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    ws.once("message", (data) => {
      try {
        resolve(JSON.parse(data.toString()) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });
    ws.once("error", reject);
  });
}

function waitForClose(ws: WebSocket): Promise<CloseEvent> {
  return new Promise((resolve) => {
    ws.once("close", (code, reason) => {
      resolve({ code, reason: reason.toString() });
    });
  });
}

async function startHub(): Promise<WsServerResult> {
  const result = await createWebSocketServer({
    host: "127.0.0.1",
    port: 0,
    token: TOKEN,
    context: new Context(),
  });
  servers.push(result);
  expect(result.isHub).toBe(true);
  expect(result.boundPort).toBeGreaterThan(0);
  return result;
}

async function connect(result: WsServerResult): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${result.boundPort}`);
  sockets.push(ws);
  await waitForOpen(ws);
  return ws;
}

async function startFakeHub(
  onAuth: (ws: WebSocket, auth: Record<string, unknown>) => void,
): Promise<number> {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  fakeHubs.push(wss);
  await new Promise<void>((resolve, reject) => {
    wss.once("listening", resolve);
    wss.once("error", reject);
  });
  const address = wss.address();
  if (!address || typeof address === "string") throw new Error("Fake hub did not bind a port");
  wss.on("connection", (ws) => {
    sockets.push(ws);
    ws.once("message", (data) => {
      onAuth(ws, JSON.parse(data.toString()) as Record<string, unknown>);
    });
  });
  return address.port;
}

async function authenticate(
  ws: WebSocket,
  role: "client" | "extension",
): Promise<Record<string, unknown>> {
  const response = waitForMessage(ws);
  ws.send(JSON.stringify({
    type: "auth",
    token: TOKEN,
    role,
    protocolVersion: PROTOCOL_VERSION,
  }));
  return response;
}

async function callHubRpc(
  ws: WebSocket,
  id: string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const response = waitForMessage(ws);
  ws.send(JSON.stringify({ type: "hub_rpc", id, method, params }));
  return response;
}

afterEach(() => {
  for (const socket of sockets.splice(0)) {
    if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
  }
  for (const server of servers.splice(0)) server.close();
  for (const fakeHub of fakeHubs.splice(0)) fakeHub.close();
});

describe("WebSocket v2 authentication", () => {
  it("returns the actual ephemeral loopback port", async () => {
    await startHub();
  });

  it("closes an auth request missing protocolVersion with 4406", async () => {
    const server = await startHub();
    const ws = await connect(server);
    const closed = waitForClose(ws);

    ws.send(JSON.stringify({ type: "auth", token: TOKEN, role: "extension" }));

    expect((await closed).code).toBe(WS_CLOSE.versionMismatch);
  });

  it("closes an auth request missing role with 4403", async () => {
    const server = await startHub();
    const ws = await connect(server);
    const closed = waitForClose(ws);

    ws.send(JSON.stringify({ type: "auth", token: TOKEN, protocolVersion: PROTOCOL_VERSION }));

    expect((await closed).code).toBe(WS_CLOSE.forbiddenRole);
  });

  it("closes an auth request with the wrong protocol version with 4406", async () => {
    const server = await startHub();
    const ws = await connect(server);
    const closed = waitForClose(ws);

    ws.send(JSON.stringify({
      type: "auth",
      token: TOKEN,
      role: "extension",
      protocolVersion: PROTOCOL_VERSION - 1,
    }));

    expect((await closed).code).toBe(WS_CLOSE.versionMismatch);
  });

  it("closes an auth request with an invalid role with 4403", async () => {
    const server = await startHub();
    const ws = await connect(server);
    const closed = waitForClose(ws);

    ws.send(JSON.stringify({
      type: "auth",
      token: TOKEN,
      role: "admin",
      protocolVersion: PROTOCOL_VERSION,
    }));

    expect((await closed).code).toBe(WS_CLOSE.forbiddenRole);
  });

  it("returns a versioned auth result and browser ID to an extension", async () => {
    const server = await startHub();
    const ws = await connect(server);

    await expect(authenticate(ws, "extension")).resolves.toEqual({
      type: "auth",
      status: "ok",
      protocolVersion: PROTOCOL_VERSION,
      browserId: "b1",
    });
  });

  it("sends v2 client auth when connecting to an existing hub", async () => {
    let resolveAuth!: (auth: Record<string, unknown>) => void;
    const receivedAuth = new Promise<Record<string, unknown>>((resolve) => {
      resolveAuth = resolve;
    });
    const port = await startFakeHub((ws, auth) => {
      resolveAuth(auth);
      ws.send(JSON.stringify({
        type: "auth",
        status: "ok",
        protocolVersion: PROTOCOL_VERSION,
      }));
    });

    const result = await createWebSocketServer({
      host: "127.0.0.1",
      port,
      token: TOKEN,
      context: new Context(),
    });
    servers.push(result);

    await expect(receivedAuth).resolves.toEqual({
      type: "auth",
      token: TOKEN,
      role: "client",
      protocolVersion: PROTOCOL_VERSION,
    });
    expect(result.boundPort).toBe(port);
  });

  it("rejects an unversioned auth success from an existing hub", async () => {
    const port = await startFakeHub((ws) => {
      ws.send(JSON.stringify({ type: "auth", status: "ok" }));
    });

    const result = createWebSocketServer({
      host: "127.0.0.1",
      port,
      token: TOKEN,
      context: new Context(),
    }).then((connected) => {
      servers.push(connected);
      return connected;
    });

    await expect(result).rejects.toThrow("Hub auth failed");
  });

  it("sends v2 client auth again when reconnecting to a hub", async () => {
    let firstConnection: WebSocket | undefined;
    let connectionCount = 0;
    let resolveReconnectAuth!: (auth: Record<string, unknown>) => void;
    const reconnectAuth = new Promise<Record<string, unknown>>((resolve) => {
      resolveReconnectAuth = resolve;
    });
    const port = await startFakeHub((ws, auth) => {
      connectionCount += 1;
      if (connectionCount === 1) {
        firstConnection = ws;
      } else {
        resolveReconnectAuth(auth);
      }
      ws.send(JSON.stringify({
        type: "auth",
        status: "ok",
        protocolVersion: PROTOCOL_VERSION,
      }));
    });
    const result = await createWebSocketServer({
      host: "127.0.0.1",
      port,
      token: TOKEN,
      context: new Context(),
    });
    servers.push(result);

    firstConnection!.close();

    await expect(reconnectAuth).resolves.toEqual({
      type: "auth",
      token: TOKEN,
      role: "client",
      protocolVersion: PROTOCOL_VERSION,
    });
  }, 7_000);
});

describe("WebSocket connection roles and session binding", () => {
  it("rejects extension hub RPC and closes the socket with 4403", async () => {
    const server = await startHub();
    const extension = await connect(server);
    await authenticate(extension, "extension");
    const closed = waitForClose(extension);

    await expect(callHubRpc(extension, "rpc-1", "listSessions")).resolves.toEqual({
      type: "hub_rpc_result",
      id: "rpc-1",
      error: "AUTH_ROLE_VIOLATION",
    });
    expect((await closed).code).toBe(WS_CLOSE.forbiddenRole);
  });

  it("rejects extension hub RPC before validating the method", async () => {
    const server = await startHub();
    const extension = await connect(server);
    await authenticate(extension, "extension");
    const response = waitForMessage(extension);
    const closed = waitForClose(extension);

    extension.send(JSON.stringify({ type: "hub_rpc", id: "rpc-malformed" }));

    await expect(response).resolves.toEqual({
      type: "hub_rpc_result",
      id: "rpc-malformed",
      error: "AUTH_ROLE_VIOLATION",
    });
    expect((await closed).code).toBe(WS_CLOSE.forbiddenRole);
  });

  it("closes extension hub RPC without fabricating a missing correlation ID", async () => {
    const server = await startHub();
    const extension = await connect(server);
    await authenticate(extension, "extension");
    const receivedMessages: unknown[] = [];
    extension.on("message", (data) => receivedMessages.push(JSON.parse(data.toString())));
    const closed = waitForClose(extension);

    extension.send(JSON.stringify({ type: "hub_rpc", method: "listSessions" }));

    expect((await closed).code).toBe(WS_CLOSE.forbiddenRole);
    expect(receivedMessages).toEqual([]);
  });

  it.each(["", "   "])("rejects blank session ID %j without binding the socket", async (sessionId) => {
    const server = await startHub();
    const client = await connect(server);
    await authenticate(client, "client");

    await expect(callHubRpc(client, "rpc-invalid", "registerSession", { sessionId }))
      .resolves.toEqual({
        type: "hub_rpc_result",
        id: "rpc-invalid",
        error: "SESSION_IDENTITY_MISMATCH",
      });
    await expect(callHubRpc(client, "rpc-valid", "registerSession", { sessionId: "s1" }))
      .resolves.toEqual({
        type: "hub_rpc_result",
        id: "rpc-valid",
        result: { ok: true },
      });
  });

  it("keeps one immutable session owner and allows reclaim after close", async () => {
    const server = await startHub();
    const first = await connect(server);
    const second = await connect(server);
    await authenticate(first, "client");
    await authenticate(second, "client");

    await expect(callHubRpc(first, "rpc-1", "registerSession", { sessionId: "s1" }))
      .resolves.toEqual({ type: "hub_rpc_result", id: "rpc-1", result: { ok: true } });
    await expect(callHubRpc(first, "rpc-2", "registerSession", { sessionId: "s2" }))
      .resolves.toEqual({
        type: "hub_rpc_result",
        id: "rpc-2",
        error: "SESSION_IDENTITY_MISMATCH",
      });
    await expect(callHubRpc(second, "rpc-3", "registerSession", { sessionId: "s1" }))
      .resolves.toEqual({
        type: "hub_rpc_result",
        id: "rpc-3",
        error: "SESSION_IDENTITY_MISMATCH",
      });

    const firstClosed = waitForClose(first);
    first.close();
    await firstClosed;

    await expect(callHubRpc(second, "rpc-4", "registerSession", { sessionId: "s1" }))
      .resolves.toEqual({ type: "hub_rpc_result", id: "rpc-4", result: { ok: true } });
  });
});
