import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { Context } from "./context.js";
import { HubStateManager } from "./hub-client.js";
import { dispatchHubRpc, type RpcAuthContext } from "./hub-rpc.js";
import { PROTOCOL_VERSION } from "./protocol.js";
import type { IStateManager } from "./state-manager.js";
import { createWebSocketServer, type WsServerResult } from "./ws-server.js";

const AUTH: RpcAuthContext = { role: "client", sessionId: "actual" };
const TOKEN = "test-token";
const servers: WsServerResult[] = [];
const sockets: WebSocket[] = [];

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

async function startHub(context = new Context()): Promise<WsServerResult> {
  const server = await createWebSocketServer({
    host: "127.0.0.1",
    port: 0,
    token: TOKEN,
    context,
  });
  servers.push(server);
  return server;
}

async function connect(server: WsServerResult): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${server.boundPort}`);
  sockets.push(ws);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  return ws;
}

async function authenticate(ws: WebSocket, role: "client" | "extension") {
  const response = waitForMessage(ws);
  ws.send(JSON.stringify({
    type: "auth",
    token: TOKEN,
    role,
    protocolVersion: PROTOCOL_VERSION,
  }));
  return await response;
}

function sendAndWait(ws: WebSocket, message: Record<string, unknown>) {
  const response = waitForMessage(ws);
  ws.send(JSON.stringify(message));
  return response;
}

function captureAndRespondToBrowser(ws: WebSocket) {
  const messages: Array<Record<string, unknown>> = [];
  ws.on("message", (data) => {
    const message = JSON.parse(data.toString()) as Record<string, unknown>;
    messages.push(message);
    if (typeof message.id === "string") {
      ws.send(JSON.stringify({
        type: "messageResponse",
        payload: { requestId: message.id, result: { leaked: true } },
      }));
    }
  });
  return messages;
}

function waitForTurn(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 25));
}

async function registerSession(ws: WebSocket, sessionId: string) {
  return await sendAndWait(ws, {
    type: "hub_rpc",
    id: `register-${sessionId}`,
    method: "registerSession",
    params: { sessionId },
  });
}

afterEach(() => {
  for (const socket of sockets.splice(0)) {
    if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
  }
  for (const server of servers.splice(0)) server.close();
});

function createState() {
  return {
    claimTab: vi.fn().mockResolvedValue({ ok: true }),
    transferTab: vi.fn().mockResolvedValue(true),
    removeSession: vi.fn().mockResolvedValue(undefined),
    clearEventHandlersForBrowser: vi.fn().mockResolvedValue(undefined),
    pushEvent: vi.fn().mockResolvedValue(undefined),
    releaseLocksForSession: vi.fn().mockResolvedValue(undefined),
  } as unknown as IStateManager;
}

function createRpcHarness() {
  const sent: Array<Record<string, unknown>> = [];
  const listeners = new Map<string, Array<(event: { data: string }) => void>>();
  const ws = {
    OPEN: 1,
    readyState: 1,
    addEventListener(type: string, listener: (event: { data: string }) => void) {
      const registered = listeners.get(type) ?? [];
      registered.push(listener);
      listeners.set(type, registered);
    },
    send(data: string) {
      const request = JSON.parse(data) as Record<string, unknown>;
      sent.push(request);
      queueMicrotask(() => {
        for (const listener of listeners.get("message") ?? []) {
          listener({
            data: JSON.stringify({
              type: "hub_rpc_result",
              id: request.id,
              result: undefined,
            }),
          });
        }
      });
    },
  } as unknown as WebSocket;

  return { state: new HubStateManager(() => ws), sent };
}

describe("dispatchHubRpc", () => {
  it("derives claimTab identity from the authenticated session", async () => {
    const state = createState();

    await dispatchHubRpc(state, AUTH, "claimTab", {
      sessionId: "spoofed",
      tabKey: "b1:7",
    });

    expect(state.claimTab).toHaveBeenCalledWith("actual", "b1:7");
  });

  it("derives transferTab source identity from the authenticated session", async () => {
    const state = createState();

    await dispatchHubRpc(state, AUTH, "transferTab", {
      fromSessionId: "spoofed",
      toSessionId: "target",
      tabKey: "b1:7",
    });

    expect(state.transferTab).toHaveBeenCalledWith("actual", "target", "b1:7");
  });

  it("removes only the authenticated session", async () => {
    const state = createState();

    await dispatchHubRpc(state, AUTH, "removeSession", {
      sessionId: "spoofed",
    });

    expect(state.removeSession).toHaveBeenCalledWith("actual");
  });

  it("cannot clean up another session's locks", async () => {
    const state = createState();

    await dispatchHubRpc(state, AUTH, "releaseLocksForSession", {
      sessionId: "spoofed",
    });

    expect(state.releaseLocksForSession).toHaveBeenCalledWith("actual");
  });

  it.each(["clearEventHandlersForBrowser", "pushEvent"])(
    "rejects internal-only client RPC %s without mutating state",
    async (method) => {
      const state = createState();

      await expect(dispatchHubRpc(state, AUTH, method, {})).rejects.toThrow(
        "AUTH_ROLE_VIOLATION",
      );

      expect(state.clearEventHandlersForBrowser).not.toHaveBeenCalled();
      expect(state.pushEvent).not.toHaveBeenCalled();
    },
  );

  it("defaults unknown RPC methods to denial without mutating state", async () => {
    const state = createState();

    await expect(
      dispatchHubRpc(state, AUTH, "unknownMethod", { sessionId: "spoofed" }),
    ).rejects.toThrow("AUTH_ROLE_VIOLATION");

    expect(state.claimTab).not.toHaveBeenCalled();
    expect(state.transferTab).not.toHaveBeenCalled();
    expect(state.removeSession).not.toHaveBeenCalled();
    expect(state.releaseLocksForSession).not.toHaveBeenCalled();
  });
});

describe("HubStateManager subject identity", () => {
  it.each([
    ["removeSession", (state: HubStateManager) => state.removeSession("local"), {}],
    ["touchSession", (state: HubStateManager) => state.touchSession("local"), {}],
    ["claimTab", (state: HubStateManager) => state.claimTab("local", "b1:7"), { tabKey: "b1:7" }],
    ["releaseTab", (state: HubStateManager) => state.releaseTab("local", "b1:7"), { tabKey: "b1:7" }],
    [
      "transferTab",
      (state: HubStateManager) => state.transferTab("local", "target", "b1:7"),
      { toSessionId: "target", tabKey: "b1:7" },
    ],
    ["releaseAllTabs", (state: HubStateManager) => state.releaseAllTabs("local"), {}],
    [
      "isTabAvailable",
      (state: HubStateManager) => state.isTabAvailable("b1:7", "local"),
      { tabKey: "b1:7" },
    ],
    [
      "selectBrowser",
      (state: HubStateManager) => state.selectBrowser("local", "b1"),
      { browserId: "b1" },
    ],
    ["getSessionBrowser", (state: HubStateManager) => state.getSessionBrowser("local"), {}],
    ["resolveBrowserTarget", (state: HubStateManager) => state.resolveBrowserTarget("local"), {}],
    [
      "registerEventHandler",
      (state: HubStateManager) =>
        state.registerEventHandler("local", "b1", "dialog", "dismiss"),
      { browserId: "b1", event: "dialog", action: "dismiss" },
    ],
    [
      "unregisterEventHandler",
      (state: HubStateManager) => state.unregisterEventHandler("local", "handler-1"),
      { handlerId: "handler-1" },
    ],
    [
      "listEventHandlers",
      (state: HubStateManager) => state.listEventHandlers("local", "b1"),
      { browserId: "b1" },
    ],
    [
      "clearEventHandlersForSession",
      (state: HubStateManager) => state.clearEventHandlersForSession("local"),
      {},
    ],
    [
      "hasMatchingEventHandler",
      (state: HubStateManager) =>
        state.hasMatchingEventHandler("local", "b1", "dialog", "queue"),
      { browserId: "b1", event: "dialog", queueName: "queue" },
    ],
    [
      "pushEvent",
      (state: HubStateManager) =>
        state.pushEvent("local", "b1", "dialog", "queue", { ok: true }, 7),
      {
        browserId: "b1",
        event: "dialog",
        queueName: "queue",
        data: { ok: true },
        tabId: 7,
      },
    ],
    [
      "waitForEvent",
      (state: HubStateManager) => state.waitForEvent("local", "queue", 50),
      { queueName: "queue", timeoutMs: 50 },
    ],
    [
      "acquireLock",
      (state: HubStateManager) => state.acquireLock("local", "lock", 50, 100),
      { name: "lock", timeoutMs: 50, ttlMs: 100 },
    ],
    [
      "releaseLock",
      (state: HubStateManager) => state.releaseLock("local", "lock"),
      { name: "lock" },
    ],
    [
      "releaseLocksForSession",
      (state: HubStateManager) => state.releaseLocksForSession("local"),
      {},
    ],
  ] as const)("omits subject IDs from %s wire params", async (method, invoke, params) => {
    const { state, sent } = createRpcHarness();

    await invoke(state);

    expect(sent).toHaveLength(1);
    const request = sent[0]!;
    expect(request).toMatchObject({ type: "hub_rpc", method, params });
    expect(request.params).not.toHaveProperty("sessionId");
    expect(request.params).not.toHaveProperty("fromSessionId");
  });
});

describe("authenticated hub routing", () => {
  it("rejects non-registration RPC before a client binds a session", async () => {
    const server = await startHub();
    const client = await connect(server);
    await authenticate(client, "client");

    await expect(sendAndWait(client, {
      type: "hub_rpc",
      id: "rpc-unregistered",
      method: "listSessions",
      params: {},
    })).resolves.toEqual({
      type: "hub_rpc_result",
      id: "rpc-unregistered",
      error: "SESSION_NOT_REGISTERED",
    });
  });

  it("rejects tool proxy traffic before a client binds a session", async () => {
    const server = await startHub();
    const client = await connect(server);
    await authenticate(client, "client");

    await expect(sendAndWait(client, {
      id: "tool-unregistered",
      type: "browser_screenshot",
      payload: {},
      sessionId: "spoofed",
      timeoutMs: 30_000,
    })).resolves.toEqual({
      type: "messageResponse",
      payload: {
        requestId: "tool-unregistered",
        error: "SESSION_NOT_REGISTERED",
      },
    });
  });

  it.each([
    ["missing method", { type: "hub_rpc", id: "rpc-missing-method", params: {} }],
    ["empty method", { type: "hub_rpc", id: "rpc-empty-method", method: "", params: {} }],
  ])("default-denies a client RPC with %s before browser routing", async (_label, frame) => {
    const server = await startHub();
    const browser = await connect(server);
    await authenticate(browser, "extension");
    const client = await connect(server);
    await authenticate(client, "client");
    await registerSession(client, "actual");
    const sessionsBefore = await server.stateManager.listSessions();
    const browserMessages = captureAndRespondToBrowser(browser);

    await expect(sendAndWait(client, frame)).resolves.toEqual({
      type: "hub_rpc_result",
      id: frame.id,
      error: "AUTH_ROLE_VIOLATION",
    });
    await waitForTurn();

    expect(browserMessages).toEqual([]);
    expect(await server.stateManager.listSessions()).toEqual(sessionsBefore);
    await expect(sendAndWait(client, {
      type: "hub_rpc",
      id: `valid-after-${frame.id}`,
      method: "listSessions",
      params: {},
    })).resolves.toMatchObject({
      type: "hub_rpc_result",
      id: `valid-after-${frame.id}`,
      result: [{ id: "actual" }],
    });
  });

  it("consumes a client RPC with no correlation ID without routing or mutation", async () => {
    const server = await startHub();
    const browser = await connect(server);
    await authenticate(browser, "extension");
    const client = await connect(server);
    await authenticate(client, "client");
    await registerSession(client, "actual");
    const sessionsBefore = await server.stateManager.listSessions();
    const browserMessages = captureAndRespondToBrowser(browser);
    const clientMessages: Array<Record<string, unknown>> = [];
    client.on("message", (data) => {
      clientMessages.push(JSON.parse(data.toString()) as Record<string, unknown>);
    });

    client.send(JSON.stringify({
      type: "hub_rpc",
      method: "listSessions",
      params: {},
    }));
    await waitForTurn();

    expect(browserMessages).toEqual([]);
    expect(clientMessages).toEqual([]);
    expect(await server.stateManager.listSessions()).toEqual(sessionsBefore);
    await expect(sendAndWait(client, {
      type: "hub_rpc",
      id: "valid-after-missing-id",
      method: "listSessions",
      params: {},
    })).resolves.toMatchObject({
      type: "hub_rpc_result",
      id: "valid-after-missing-id",
      result: [{ id: "actual" }],
    });
  });

  it("overwrites ordinary tool identity and explicit browser routing", async () => {
    const server = await startHub();
    const browserA = await connect(server);
    const browserB = await connect(server);
    const browserAId = (await authenticate(browserA, "extension")).browserId;
    const browserBId = (await authenticate(browserB, "extension")).browserId;
    const client = await connect(server);
    await authenticate(client, "client");
    await registerSession(client, "actual");
    await sendAndWait(client, {
      type: "hub_rpc",
      id: "select-browser",
      method: "selectBrowser",
      params: { sessionId: "spoofed", browserId: browserBId },
    });

    const routedRequest = Promise.race([
      waitForMessage(browserA).then((message) => ({ browser: browserA, message })),
      waitForMessage(browserB).then((message) => ({ browser: browserB, message })),
    ]);
    const clientResponse = waitForMessage(client);
    client.send(JSON.stringify({
      id: "tool-ordinary",
      type: "browser_screenshot",
      payload: { tabId: 7 },
      sessionId: "spoofed",
      timeoutMs: 8_000,
      targetBrowserId: browserAId,
      ignored: true,
    }));

    const routed = await routedRequest;
    routed.browser.send(JSON.stringify({
      type: "messageResponse",
      payload: { requestId: "tool-ordinary", result: { ok: true } },
    }));
    await expect(clientResponse).resolves.toEqual({
      type: "messageResponse",
      payload: { requestId: "tool-ordinary", result: { ok: true } },
    });
    expect(routed.browser).toBe(browserB);
    expect(routed.message).toEqual({
      id: "tool-ordinary",
      type: "browser_screenshot",
      payload: { tabId: 7 },
      sessionId: "actual",
      timeoutMs: 8_000,
    });
  });

  it("honors validated explicit routing only for server-control tools", async () => {
    const server = await startHub();
    const browserA = await connect(server);
    const browserB = await connect(server);
    await authenticate(browserA, "extension");
    const browserBId = (await authenticate(browserB, "extension")).browserId;
    const client = await connect(server);
    await authenticate(client, "client");
    await registerSession(client, "actual");

    const browserRequest = waitForMessage(browserB);
    const clientResponse = waitForMessage(client);
    client.send(JSON.stringify({
      id: "tool-control",
      type: "browser_register_handler",
      payload: { handler: "handler-1" },
      sessionId: "spoofed",
      timeoutMs: 8_000,
      targetBrowserId: browserBId,
    }));

    const forwarded = await browserRequest;
    browserB.send(JSON.stringify({
      type: "messageResponse",
      payload: { requestId: "tool-control", result: { ok: true } },
    }));
    await clientResponse;
    expect(forwarded).toEqual({
      id: "tool-control",
      type: "browser_register_handler",
      payload: { handler: "handler-1" },
      sessionId: "actual",
      timeoutMs: 8_000,
    });
  });

  it("adds the trusted local session to direct hub tool envelopes", async () => {
    const context = new Context();
    context.sessionId = "trusted-local";
    const server = await startHub(context);
    const browser = await connect(server);
    await authenticate(browser, "extension");

    const browserRequest = waitForMessage(browser);
    const result = context.sendSocketMessage(
      "browser_screenshot",
      { tabId: 7 },
      { timeoutMs: 8_000 },
    );

    const forwarded = await browserRequest;
    browser.send(JSON.stringify({
      type: "messageResponse",
      payload: { requestId: forwarded.id, result: { ok: true } },
    }));
    await expect(result).resolves.toEqual({ ok: true });
    expect(forwarded).toEqual({
      id: expect.any(String),
      type: "browser_screenshot",
      payload: { tabId: 7 },
      sessionId: "trusted-local",
      timeoutMs: 8_000,
    });
  });
});
