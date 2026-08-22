import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { Context } from "./context.js";
import { HubStateManager } from "./hub-client.js";
import { getRecentIssues } from './logger.js';
import { PROTOCOL_VERSION, WS_CLOSE } from "./protocol.js";
import { LocalStateManager, type IStateManager } from "./state-manager.js";
import * as recordingTools from "./tools/record.js";
import { createEventsTools } from "./tools/events.js";
import type { Tool } from "./tools/types.js";
import {
  createWebSocketServer,
  FinalizedSessionRegistry,
  MAX_PENDING_RECORDING_PERSISTS_PER_SESSION,
  RecordingRetryRegistry,
  type WsServerOptions,
  type WsServerResult,
} from "./ws-server.js";

const TOKEN = "test-token";

type CloseEvent = {
  code: number;
  reason: string;
};

type TestWsServerOptions = Partial<WsServerOptions> & {
  sessionReconnectGraceMs?: number;
};

const servers: WsServerResult[] = [];
const sockets: WebSocket[] = [];
const fakeHubs: WebSocketServer[] = [];
const tempDirs: string[] = [];

const validRecording = {
  name: "Checkout_Flow",
  startedAt: 100,
  stoppedAt: 200,
  url: "https://example.test/",
  steps: [{
    action: "browser_type",
    args: { element: "Account input", text: "{{input_1}}" },
    timestamp: 110,
    durationMs: 5,
    url: "https://example.test/",
  }],
  requiredVariables: [{ name: "input_1", source: "text", hint: "text_input_1" }],
};

function getRecordingApi() {
  const api = recordingTools as unknown as {
    createRecordingTools: (
      stateManager: IStateManager,
      getSessionId: () => string,
      options?: { recordingsDir?: string },
    ) => { recordStart: Tool; recordStop: Tool; recordList: Tool };
    saveRecordingToFile: (
      recording: unknown,
      recordingsDir?: string,
      fileOps?: {
        mkdirSync?: typeof mkdirSync;
        chmodSync?: typeof chmodSync;
        statSync?: typeof statSync;
        closeSync?: typeof closeSync;
        fchmodSync?: typeof fchmodSync;
        fstatSync?: typeof fstatSync;
        fsyncSync?: typeof fsyncSync;
        lstatSync?: typeof lstatSync;
        openSync?: typeof openSync;
        unlinkSync?: typeof unlinkSync;
      },
    ) => "created" | "existing-identical";
  };
  return {
    ...api,
    createRecordingTools: (
      stateManager: IStateManager,
      getSessionId: () => string,
      options?: { recordingsDir?: string },
    ) => {
      if (options?.recordingsDir) return api.createRecordingTools(stateManager, getSessionId, options);
      const base = mkdtempSync(join(tmpdir(), "mybrowser-recording-tools-"));
      tempDirs.push(base);
      return api.createRecordingTools(stateManager, getSessionId, {
        recordingsDir: join(base, "recordings"),
      });
    },
  };
}

function recordingFileOps(overrides: Record<string, unknown> = {}) {
  return {
    mkdirSync,
    chmodSync,
    statSync,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createRecordingState() {
  const reserveRecording = vi.fn().mockResolvedValue({
    ok: true,
    reservation: {
      name: "Checkout_Flow",
      sessionId: "session-a",
      expiresAt: Date.now() + 1_800_000,
    },
  });
  const releaseRecordingReservation = vi.fn().mockResolvedValue(true);
  const hasRecordingReservation = vi.fn().mockResolvedValue(true);
  return {
    reserveRecording,
    releaseRecordingReservation,
    hasRecordingReservation,
  } as unknown as IStateManager & {
    reserveRecording: typeof reserveRecording;
    releaseRecordingReservation: typeof releaseRecordingReservation;
    hasRecordingReservation: typeof hasRecordingReservation;
  };
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
}

function waitForMessage(ws: WebSocket, timeoutMs = 1_000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("message", onMessage);
      ws.off("error", onError);
      reject(new Error("Timed out waiting for WebSocket message"));
    }, timeoutMs);
    const onError = (error: Error) => {
      clearTimeout(timer);
      ws.off("message", onMessage);
      reject(error);
    };
    const onMessage = (data: RawData) => {
      clearTimeout(timer);
      ws.off("error", onError);
      try {
        resolve(JSON.parse(data.toString()) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    };
    ws.once("message", onMessage);
    ws.once("error", onError);
  });
}

function waitForMatchingMessage(
  ws: WebSocket,
  predicate: (message: Record<string, unknown>) => boolean,
  timeoutMs = 1_000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("message", onMessage);
      reject(new Error("Timed out waiting for matching WebSocket message"));
    }, timeoutMs);
    const onMessage = (data: RawData) => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      if (!predicate(message)) return;
      clearTimeout(timer);
      ws.off("message", onMessage);
      resolve(message);
    };
    ws.on("message", onMessage);
  });
}

function waitForMessages(
  ws: WebSocket,
  count: number,
  timeoutMs = 1_000,
): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    const messages: Record<string, unknown>[] = [];
    const timer = setTimeout(() => {
      ws.off("message", onMessage);
      reject(new Error(`Timed out waiting for ${count} WebSocket messages`));
    }, timeoutMs);
    const onMessage = (data: RawData) => {
      try {
        messages.push(JSON.parse(data.toString()) as Record<string, unknown>);
        if (messages.length !== count) return;
        clearTimeout(timer);
        ws.off("message", onMessage);
        resolve(messages);
      } catch (error) {
        clearTimeout(timer);
        ws.off("message", onMessage);
        reject(error);
      }
    };
    ws.on("message", onMessage);
  });
}

function waitForClose(ws: WebSocket): Promise<CloseEvent> {
  return new Promise((resolve) => {
    ws.once("close", (code, reason) => {
      resolve({ code, reason: reason.toString() });
    });
  });
}

function createMessageInbox(ws: WebSocket) {
  const messages: Record<string, unknown>[] = [];
  const waiters: Array<(message: Record<string, unknown>) => void> = [];
  ws.on("message", (data) => {
    const message = JSON.parse(data.toString()) as Record<string, unknown>;
    const waiter = waiters.shift();
    if (waiter) waiter(message);
    else messages.push(message);
  });
  return {
    all: messages,
    next(timeoutMs = 1_000): Promise<Record<string, unknown>> {
      const message = messages.shift();
      if (message) return Promise.resolve(message);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = waiters.indexOf(onMessage);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error("Timed out waiting for WebSocket inbox message"));
        }, timeoutMs);
        const onMessage = (nextMessage: Record<string, unknown>) => {
          clearTimeout(timer);
          resolve(nextMessage);
        };
        waiters.push(onMessage);
      });
    },
  };
}

async function startHub(
  recordingsDir?: string,
  recordingFileOps?: WsServerOptions["recordingFileOps"],
  recordingRetryRegistry?: RecordingRetryRegistry,
  extraOptions: TestWsServerOptions = {},
): Promise<WsServerResult> {
  const result = await createWebSocketServer({
    host: "127.0.0.1",
    port: 0,
    token: TOKEN,
    context: new Context(),
    recordingsDir,
    recordingFileOps,
    recordingRetryRegistry,
    ...extraOptions,
  } as WsServerOptions);
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

async function startClientProcess(
  server: WsServerResult,
  sessionId: string,
): Promise<{ context: Context; server: WsServerResult }> {
  const context = new Context();
  context.sessionId = sessionId;
  const clientServer = await createWebSocketServer({
    host: "127.0.0.1",
    port: server.boundPort,
    token: TOKEN,
    context,
  });
  servers.push(clientServer);
  await clientServer.stateManager.registerSession(sessionId);
  return { context, server: clientServer };
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
  extras: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const response = waitForMessage(ws);
  ws.send(JSON.stringify({
    type: "auth",
    token: TOKEN,
    role,
    protocolVersion: PROTOCOL_VERSION,
    ...extras,
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

async function sendMessageAndWait(
  ws: WebSocket,
  message: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = waitForMessage(ws);
  ws.send(JSON.stringify(message));
  return response;
}

async function setupReservedRecording(
  recordingsDir: string,
  recordingFileOps?: WsServerOptions["recordingFileOps"],
  recordingRetryRegistry?: RecordingRetryRegistry,
): Promise<{
  server: WsServerResult;
  extension: WebSocket;
  client: WebSocket;
}> {
  const server = await startHub(recordingsDir, recordingFileOps, recordingRetryRegistry);
  const extension = await connect(server);
  await authenticate(extension, "extension");
  const client = await connect(server);
  await authenticate(client, "client");
  await callHubRpc(client, "register-a", "registerSession", { sessionId: "session-a" });
  await callHubRpc(client, "reserve-a", "reserveRecording", {
    name: validRecording.name,
    leaseMs: 1_800_000,
  });
  return { server, extension, client };
}

async function persistRecordingMessage(
  extension: WebSocket,
  id: string,
  payload: unknown = validRecording,
): Promise<Record<string, unknown>> {
  const response = waitForMessage(extension);
  extension.send(JSON.stringify({
    type: "persistRecording",
    id,
    sessionId: "session-a",
    payload,
  }));
  return response;
}

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
  }
  await Promise.allSettled(servers.splice(0).map((server) => server.close()));
  await Promise.all(fakeHubs.splice(0).map((fakeHub) => new Promise<void>((resolve) => {
    fakeHub.close(() => resolve());
  })));
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("FinalizedSessionRegistry", () => {
  it("expires tombstones and bounds retained finalized IDs", () => {
    let now = 0;
    const finalized = new FinalizedSessionRegistry({
      ttlMs: 10,
      maxEntries: 2,
      now: () => now,
    });

    finalized.add("session-a");
    finalized.add("session-b");
    finalized.add("session-c");

    expect(finalized.size).toBe(2);
    expect(finalized.has("session-a")).toBe(false);
    expect(finalized.has("session-b")).toBe(true);
    expect(finalized.has("session-c")).toBe(true);

    now = 11;
    expect(finalized.has("session-b")).toBe(false);
    expect(finalized.has("session-c")).toBe(false);
    expect(finalized.size).toBe(0);
  });

  it("returns only the bounded finalized intersection", () => {
    const finalized = new FinalizedSessionRegistry({ ttlMs: 1_000, maxEntries: 3 });
    finalized.add("session-a");
    finalized.add("session-c");
    expect(finalized.intersect(["session-c", "session-b", "session-a"])).toEqual([
      "session-c", "session-a",
    ]);
  });
});

describe("recording tools and persistence", () => {
  it("rejects a whitespace-only start name before reserving or proxying", async () => {
    const state = createRecordingState();
    const sendSocketMessage = vi.fn();
    const { recordStart } = getRecordingApi().createRecordingTools(state, () => "session-a");

    await expect(recordStart.handle(
      { sendSocketMessage } as unknown as Context,
      { name: "   ", tabId: 7 },
    )).rejects.toThrow();
    expect(state.reserveRecording).not.toHaveBeenCalled();
    expect(sendSocketMessage).not.toHaveBeenCalled();
  });

  it("strictly rejects unknown recording tool and stop-result fields without echoing canaries", async () => {
    const secret = "SECRET_RECORDING_FIXED_SCHEMA_4821";

    const startState = createRecordingState();
    const startProxy = vi.fn().mockResolvedValue({ status: "recording" });
    const startTools = getRecordingApi().createRecordingTools(startState, () => "session-a");
    let startError = "";
    try {
      await startTools.recordStart.handle(
        { sendSocketMessage: startProxy } as unknown as Context,
        { name: "strict", tabId: 7, unknownStart: secret },
      );
    } catch (error) {
      startError = error instanceof Error ? error.message : String(error);
    }
    expect(startError).not.toContain(secret);
    expect(startState.reserveRecording).not.toHaveBeenCalled();
    expect(startProxy).not.toHaveBeenCalled();

    const state = createRecordingState();
    const tools = getRecordingApi().createRecordingTools(state, () => "session-a");
    await tools.recordStart.handle(
      { sendSocketMessage: vi.fn().mockResolvedValue({ status: "recording" }) } as unknown as Context,
      { name: validRecording.name, tabId: 7 },
    );
    const stopProxy = vi.fn().mockResolvedValue({
      extensionSaved: true,
      serverSaved: true,
      recording: validRecording,
      unknownResult: secret,
    });
    await expect(tools.recordStop.handle(
      { sendSocketMessage: stopProxy } as unknown as Context,
      { unknownStop: secret },
    )).rejects.not.toThrow(secret);
    expect(stopProxy).not.toHaveBeenCalled();

    const listProxy = vi.fn();
    await expect(tools.recordList.handle(
      { sendSocketMessage: listProxy } as unknown as Context,
      { unknownList: secret },
    )).rejects.not.toThrow(secret);
    expect(listProxy).not.toHaveBeenCalled();

    let resultError = "";
    try {
      await tools.recordStop.handle({ sendSocketMessage: stopProxy } as unknown as Context, {});
    } catch (error) {
      resultError = error instanceof Error ? error.message : String(error);
    }
    expect(resultError).not.toContain(secret);
    expect(resultError).not.toBe("");
  });

  it("reserves before starting and forwards the required tabId", async () => {
    const state = createRecordingState();
    const sendSocketMessage = vi.fn().mockResolvedValue({ status: "recording" });
    const context = { sendSocketMessage } as unknown as Context;
    const { recordStart } = getRecordingApi().createRecordingTools(state, () => "session-a");

    await recordStart.handle(context, { name: "Checkout Flow", tabId: 7 });

    expect(state.reserveRecording).toHaveBeenCalledWith("session-a", "Checkout_Flow", 1_800_000);
    expect(state.reserveRecording.mock.invocationCallOrder[0]).toBeLessThan(
      sendSocketMessage.mock.invocationCallOrder[0]!,
    );
    expect(sendSocketMessage).toHaveBeenCalledWith("browser_record_start", {
      name: "Checkout_Flow",
      tabId: 7,
    });
  });

  it("rejects canonical server artifacts before reservation or extension start", async () => {
    const recordingsDir = mkdtempSync(join(tmpdir(), "mybrowser-recording-conflict-"));
    tempDirs.push(recordingsDir);
    writeFileSync(join(recordingsDir, "Checkout_Flow.json"), "{}\n");
    const state = createRecordingState();
    const sendSocketMessage = vi.fn();
    const { recordStart } = getRecordingApi().createRecordingTools(
      state,
      () => "session-a",
      { recordingsDir },
    );

    await expect(recordStart.handle(
      { sendSocketMessage } as unknown as Context,
      { name: "Checkout Flow", tabId: 7 },
    )).rejects.toThrow("RECORDING_NAME_CONFLICT");

    expect(state.reserveRecording).not.toHaveBeenCalled();
    expect(state.releaseRecordingReservation).not.toHaveBeenCalled();
    expect(sendSocketMessage).not.toHaveBeenCalled();
  });

  it.each([
    [true, "LOCAL_PERSIST_FAILED"],
    [true, "LOCAL_RECORDING_CONFLICT"],
    [false, "SERVER_PERSIST_FAILED"],
  ] as const)("preserves exact stop status for serverSaved=%s error=%s", async (serverSaved, error) => {
    const state = createRecordingState();
    state.hasRecordingReservation.mockResolvedValue(!serverSaved);
    const tools = getRecordingApi().createRecordingTools(state, () => "session-a");
    await tools.recordStart.handle(
      { sendSocketMessage: vi.fn().mockResolvedValue({ status: "recording" }) } as unknown as Context,
      { name: validRecording.name, tabId: 7 },
    );
    const extensionSaved = false;

    const result = await tools.recordStop.handle({
      sendSocketMessage: vi.fn().mockResolvedValue({
        extensionSaved,
        serverSaved,
        recording: validRecording,
        error,
      }),
    } as unknown as Context, {});

    expect(result).toMatchObject({
      extensionSaved,
      serverSaved,
      recording: validRecording,
      error,
    });
  });

  it("rejects a wrong raw stop name before sanitization without releasing ownership", async () => {
    const state = createRecordingState();
    const { recordStart, recordStop } = getRecordingApi().createRecordingTools(
      state,
      () => "session-a",
    );
    await recordStart.handle(
      { sendSocketMessage: vi.fn().mockResolvedValue({ status: "recording" }) } as unknown as Context,
      { name: validRecording.name, tabId: 7 },
    );
    const secret = "SECRET_WRONG_STOP_9271";

    await expect(recordStop.handle({
      sendSocketMessage: vi.fn().mockResolvedValue({
        recording: { name: `Other_${secret}` },
      }),
    } as unknown as Context, {})).rejects.toThrow(
      "Recording result does not match the active reservation",
    );

    expect(state.hasRecordingReservation).not.toHaveBeenCalled();
    expect(state.releaseRecordingReservation).not.toHaveBeenCalled();
    try {
      await recordStop.handle({
        sendSocketMessage: vi.fn().mockResolvedValue({ recording: { name: secret } }),
      } as unknown as Context, {});
    } catch (error) {
      expect(error instanceof Error ? error.message : String(error)).not.toContain(secret);
    }
    expect(state.releaseRecordingReservation).not.toHaveBeenCalled();
  });

  it("reports a normalized name conflict without proxying start", async () => {
    const state = createRecordingState();
    state.reserveRecording = vi.fn().mockResolvedValue({ ok: false, owner: "session-b" });
    const sendSocketMessage = vi.fn();
    const context = { sendSocketMessage } as unknown as Context;
    const { recordStart } = getRecordingApi().createRecordingTools(state, () => "session-a");

    await expect(recordStart.handle(context, { name: "Checkout Flow", tabId: 7 }))
      .rejects.toThrow("RECORDING_NAME_CONFLICT");
    expect(sendSocketMessage).not.toHaveBeenCalled();
  });

  it("releases the reservation when extension start fails", async () => {
    const state = createRecordingState();
    const context = {
      sendSocketMessage: vi.fn().mockRejectedValue(new Error("extension failed")),
    } as unknown as Context;
    const { recordStart } = getRecordingApi().createRecordingTools(state, () => "session-a");

    await expect(recordStart.handle(context, { name: "Checkout Flow", tabId: 7 }))
      .rejects.toThrow("extension failed");
    expect(state.releaseRecordingReservation).toHaveBeenCalledWith("session-a", "Checkout_Flow");
  });

  it("reconciles a stale active name after ordinary reservation timer expiry", async () => {
    vi.useFakeTimers();
    try {
      const state = new LocalStateManager();
      const sendSocketMessage = vi.fn().mockResolvedValue({ status: "recording" });
      const { recordStart } = getRecordingApi().createRecordingTools(state, () => "session-a");
      await recordStart.handle(
        { sendSocketMessage } as unknown as Context,
        { name: "first", tabId: 7 },
      );

      await vi.advanceTimersByTimeAsync(1_800_000);
      await expect(recordStart.handle(
        { sendSocketMessage } as unknown as Context,
        { name: "after expiry", tabId: 8 },
      )).resolves.toMatchObject({ content: [{ text: 'Recording started: "after_expiry"' }] });
      await state.removeSession("session-a");
    } finally {
      vi.useRealTimers();
    }
  });

  it("reconciles a stale active name after removeSession cleanup", async () => {
    const state = new LocalStateManager();
    const sendSocketMessage = vi.fn().mockResolvedValue({ status: "recording" });
    const { recordStart } = getRecordingApi().createRecordingTools(state, () => "session-a");
    await recordStart.handle(
      { sendSocketMessage } as unknown as Context,
      { name: "first", tabId: 7 },
    );
    await state.removeSession("session-a");

    await expect(recordStart.handle(
      { sendSocketMessage } as unknown as Context,
      { name: "after remove", tabId: 8 },
    )).resolves.toMatchObject({ content: [{ text: 'Recording started: "after_remove"' }] });
    await state.removeSession("session-a");
  });

  it("clears a failed extension-start name after authoritative abort cleanup", async () => {
    const state = createRecordingState();
    state.releaseRecordingReservation.mockResolvedValueOnce(false);
    state.hasRecordingReservation.mockResolvedValueOnce(false);
    state.reserveRecording
      .mockResolvedValueOnce({
        ok: true,
        reservation: {
          name: "Checkout_Flow",
          sessionId: "session-a",
          expiresAt: Date.now() + 1_800_000,
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        reservation: {
          name: "after_abort",
          sessionId: "session-a",
          expiresAt: Date.now() + 1_800_000,
        },
      });
    const sendSocketMessage = vi.fn()
      .mockRejectedValueOnce(new Error("extension aborted"))
      .mockResolvedValueOnce({ status: "recording" });
    const { recordStart } = getRecordingApi().createRecordingTools(state, () => "session-a");

    await expect(recordStart.handle(
      { sendSocketMessage } as unknown as Context,
      { name: "Checkout Flow", tabId: 7 },
    )).rejects.toThrow("extension aborted");
    await expect(recordStart.handle(
      { sendSocketMessage } as unknown as Context,
      { name: "after abort", tabId: 8 },
    )).resolves.toBeDefined();
    expect(state.reserveRecording).toHaveBeenCalledTimes(2);
  });

  it("fails closed and retains the stale active name when reconciliation rejects", async () => {
    const state = createRecordingState();
    state.hasRecordingReservation.mockRejectedValue(new Error("state exposed"));
    const sendSocketMessage = vi.fn().mockResolvedValue({ status: "recording" });
    const { recordStart } = getRecordingApi().createRecordingTools(state, () => "session-a");
    await recordStart.handle(
      { sendSocketMessage } as unknown as Context,
      { name: "Checkout Flow", tabId: 7 },
    );

    await expect(recordStart.handle(
      { sendSocketMessage } as unknown as Context,
      { name: "second", tabId: 8 },
    )).rejects.toThrow("Recording reservation state unavailable");
    expect(state.reserveRecording).toHaveBeenCalledTimes(1);
    expect(sendSocketMessage).toHaveBeenCalledTimes(1);

    state.hasRecordingReservation.mockResolvedValue(false);
    state.reserveRecording.mockResolvedValue({
      ok: true,
      reservation: {
        name: "second",
        sessionId: "session-a",
        expiresAt: Date.now() + 1_800_000,
      },
    });
    await expect(recordStart.handle(
      { sendSocketMessage } as unknown as Context,
      { name: "second", tabId: 8 },
    )).resolves.toBeDefined();
  });

  it("retains a failed-start reservation after false live release and cleans it before another start", async () => {
    const state = createRecordingState();
    state.releaseRecordingReservation
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    state.hasRecordingReservation.mockResolvedValue(true);
    const sendSocketMessage = vi.fn()
      .mockRejectedValueOnce(new Error("extension start failed"))
      .mockResolvedValueOnce({ status: "recording" });
    const { recordStart } = getRecordingApi().createRecordingTools(
      state,
      () => "session-a",
    );

    await expect(recordStart.handle(
      { sendSocketMessage } as unknown as Context,
      { name: "Checkout Flow", tabId: 7 },
    )).rejects.toThrow("release failed");
    await expect(recordStart.handle(
      { sendSocketMessage } as unknown as Context,
      { name: "Another Recording", tabId: 8 },
    )).rejects.toThrow("release failed");
    expect(state.reserveRecording).toHaveBeenCalledTimes(1);
    await recordStart.handle(
      { sendSocketMessage } as unknown as Context,
      { name: "Another Recording", tabId: 8 },
    );

    expect(state.releaseRecordingReservation).toHaveBeenCalledTimes(3);
    expect(state.reserveRecording).toHaveBeenCalledTimes(2);
    expect(state.releaseRecordingReservation.mock.invocationCallOrder[2]).toBeLessThan(
      state.reserveRecording.mock.invocationCallOrder[1]!,
    );
  });

  it("retains a failed-start reservation after release rejection and cleans it before stop", async () => {
    const state = createRecordingState();
    state.releaseRecordingReservation
      .mockRejectedValueOnce(new Error("release RPC failed"))
      .mockResolvedValueOnce(true);
    const startSend = vi.fn().mockRejectedValue(new Error("extension start failed"));
    const stopSend = vi.fn().mockRejectedValue(new Error("No recording in progress"));
    const { recordStart, recordStop } = getRecordingApi().createRecordingTools(
      state,
      () => "session-a",
    );

    await expect(recordStart.handle(
      { sendSocketMessage: startSend } as unknown as Context,
      { name: "Checkout Flow", tabId: 7 },
    )).rejects.toThrow("release RPC failed");
    await expect(recordStop.handle(
      { sendSocketMessage: stopSend } as unknown as Context,
      {},
    )).rejects.toThrow("No recording in progress");

    expect(state.releaseRecordingReservation).toHaveBeenCalledTimes(2);
    expect(state.releaseRecordingReservation.mock.invocationCallOrder[1]).toBeLessThan(
      stopSend.mock.invocationCallOrder[0]!,
    );
  });

  it("serializes concurrent starts so only the first can reserve", async () => {
    const state = createRecordingState();
    const reservation = deferred<Awaited<ReturnType<IStateManager["reserveRecording"]>>>();
    state.reserveRecording.mockImplementation(() => reservation.promise);
    const sendSocketMessage = vi.fn().mockResolvedValue({ status: "recording" });
    const { recordStart } = getRecordingApi().createRecordingTools(state, () => "session-a");

    const first = recordStart.handle(
      { sendSocketMessage } as unknown as Context,
      { name: "First", tabId: 7 },
    );
    await vi.waitFor(() => expect(state.reserveRecording).toHaveBeenCalledTimes(1));
    const second = recordStart.handle(
      { sendSocketMessage } as unknown as Context,
      { name: "Second", tabId: 8 },
    );
    const secondResult = expect(second).rejects.toThrow("already active");
    await Promise.resolve();
    expect(state.reserveRecording).toHaveBeenCalledTimes(1);

    reservation.resolve({
      ok: true,
      reservation: {
        name: "First",
        sessionId: "session-a",
        expiresAt: Date.now() + 1_800_000,
      },
    });
    await first;
    await secondResult;
    expect(state.reserveRecording).toHaveBeenCalledTimes(1);
    expect(sendSocketMessage).toHaveBeenCalledTimes(1);
  });

  it("does not let stop race an in-flight start", async () => {
    const state = createRecordingState();
    const startGate = deferred<{ status: string }>();
    const startSend = vi.fn(() => startGate.promise);
    const stopSend = vi.fn().mockResolvedValue({
      extensionSaved: false,
      serverSaved: false,
      recording: validRecording,
      error: "SERVER_PERSIST_FAILED",
    });
    const { recordStart, recordStop } = getRecordingApi().createRecordingTools(
      state,
      () => "session-a",
    );

    const start = recordStart.handle(
      { sendSocketMessage: startSend } as unknown as Context,
      { name: validRecording.name, tabId: 7 },
    );
    await vi.waitFor(() => expect(startSend).toHaveBeenCalledTimes(1));
    const stop = recordStop.handle(
      { sendSocketMessage: stopSend } as unknown as Context,
      {},
    );
    await Promise.resolve();
    expect(state.releaseRecordingReservation).not.toHaveBeenCalled();
    expect(stopSend).not.toHaveBeenCalled();

    startGate.resolve({ status: "recording" });
    await start;
    await stop;
    expect(stopSend).toHaveBeenCalledTimes(1);
    expect(startSend.mock.invocationCallOrder[0]).toBeLessThan(stopSend.mock.invocationCallOrder[0]!);
  });

  it("retries failed-start release identity before the queued start reserves", async () => {
    const state = createRecordingState();
    state.releaseRecordingReservation
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    state.hasRecordingReservation.mockResolvedValue(true);
    const startGate = deferred<never>();
    const sendSocketMessage = vi.fn()
      .mockImplementationOnce(() => startGate.promise)
      .mockResolvedValueOnce({ status: "recording" });
    const { recordStart } = getRecordingApi().createRecordingTools(state, () => "session-a");

    const first = recordStart.handle(
      { sendSocketMessage } as unknown as Context,
      { name: "First", tabId: 7 },
    );
    const firstResult = expect(first).rejects.toThrow("release failed");
    await vi.waitFor(() => expect(sendSocketMessage).toHaveBeenCalledTimes(1));
    const second = recordStart.handle(
      { sendSocketMessage } as unknown as Context,
      { name: "Second", tabId: 8 },
    );
    const secondOutcome = second.then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error }),
    );
    startGate.reject(new Error("extension start failed"));

    await firstResult;
    const outcome = await secondOutcome;
    expect(outcome.error).toBeUndefined();
    expect(outcome.value).toBeDefined();
    expect(state.releaseRecordingReservation).toHaveBeenCalledTimes(2);
    expect(state.reserveRecording).toHaveBeenCalledTimes(2);
    expect(state.releaseRecordingReservation.mock.invocationCallOrder[1]).toBeLessThan(
      state.reserveRecording.mock.invocationCallOrder[1]!,
    );
  });

  it("continues the lifecycle queue after a reservation conflict rejection", async () => {
    const state = createRecordingState();
    const firstReservation = deferred<Awaited<ReturnType<IStateManager["reserveRecording"]>>>();
    state.reserveRecording
      .mockImplementationOnce(() => firstReservation.promise)
      .mockResolvedValueOnce({
        ok: true,
        reservation: {
          name: "Second",
          sessionId: "session-a",
          expiresAt: Date.now() + 1_800_000,
        },
      });
    const sendSocketMessage = vi.fn().mockResolvedValue({ status: "recording" });
    const { recordStart } = getRecordingApi().createRecordingTools(state, () => "session-a");

    const first = recordStart.handle(
      { sendSocketMessage } as unknown as Context,
      { name: "First", tabId: 7 },
    );
    const firstResult = expect(first).rejects.toThrow("RECORDING_NAME_CONFLICT");
    await vi.waitFor(() => expect(state.reserveRecording).toHaveBeenCalledTimes(1));
    const second = recordStart.handle(
      { sendSocketMessage } as unknown as Context,
      { name: "Second", tabId: 8 },
    );
    await Promise.resolve();
    expect(state.reserveRecording).toHaveBeenCalledTimes(1);

    firstReservation.resolve({ ok: false, owner: "session-other" });
    await firstResult;
    await second;
    expect(state.reserveRecording).toHaveBeenCalledTimes(2);
    expect(sendSocketMessage).toHaveBeenCalledTimes(1);
  });

  it("stops without a tab and releases a validated partial recording", async () => {
    const state = createRecordingState();
    const context = {
      sendSocketMessage: vi.fn().mockResolvedValue({
        extensionSaved: false,
        serverSaved: false,
        error: "SERVER_PERSIST_FAILED",
        recording: { ...validRecording },
      }),
    } as unknown as Context;
    const { recordStart, recordStop } = getRecordingApi().createRecordingTools(
      state,
      () => "session-a",
    );
    await recordStart.handle(
      { sendSocketMessage: vi.fn().mockResolvedValue({ status: "recording" }) } as unknown as Context,
      { name: validRecording.name, tabId: 7 },
    );

    const result = await recordStop.handle(context, {});

    expect(context.sendSocketMessage).toHaveBeenCalledWith("browser_record_stop", {});
    const [summary, payload] = result.content;
    expect(summary).toMatchObject({ type: "text" });
    if (summary?.type !== "text" || payload?.type !== "text") {
      throw new Error("Expected text recording result content");
    }
    expect(summary.text).toContain("partial");
    expect(result).toMatchObject({
      extensionSaved: false,
      serverSaved: false,
      error: "SERVER_PERSIST_FAILED",
      recording: { name: "Checkout_Flow" },
    });
    expect(state.releaseRecordingReservation).toHaveBeenCalledWith("session-a", "Checkout_Flow");
  });

  it("releases the active reservation when extension stop fails", async () => {
    const state = createRecordingState();
    const { recordStart, recordStop } = getRecordingApi().createRecordingTools(
      state,
      () => "session-a",
    );
    await recordStart.handle(
      { sendSocketMessage: vi.fn().mockResolvedValue({ status: "recording" }) } as unknown as Context,
      { name: validRecording.name, tabId: 7 },
    );

    await expect(recordStop.handle(
      { sendSocketMessage: vi.fn().mockRejectedValue(new Error("stop failed")) } as unknown as Context,
      {},
    )).rejects.toThrow("stop failed");
    expect(state.releaseRecordingReservation).toHaveBeenCalledWith("session-a", "Checkout_Flow");
  });

  it("retains a live reservation after release rejection and retries with the original stop payload", async () => {
    const localState = new LocalStateManager();
    const releaseRecordingReservation = vi.fn()
      .mockRejectedValueOnce(new Error("release RPC failed"))
      .mockImplementationOnce((sessionId: string, name: string) =>
        localState.releaseRecordingReservation(sessionId, name));
    const state = {
      reserveRecording: localState.reserveRecording.bind(localState),
      hasRecordingReservation: localState.hasRecordingReservation.bind(localState),
      releaseRecordingReservation,
    } as unknown as IStateManager;
    const { recordStart, recordStop } = getRecordingApi().createRecordingTools(
      state,
      () => "session-a",
    );
    await recordStart.handle(
      { sendSocketMessage: vi.fn().mockResolvedValue({ status: "recording" }) } as unknown as Context,
      { name: validRecording.name, tabId: 7 },
    );
    const stopContext = {
      sendSocketMessage: vi.fn()
        .mockResolvedValueOnce({
          extensionSaved: true,
          serverSaved: true,
          recording: { ...validRecording },
        })
        .mockRejectedValueOnce(new Error("No recording in progress")),
    } as unknown as Context;

    await expect(recordStop.handle(stopContext, {})).rejects.toThrow("release RPC failed");
    await expect(localState.hasRecordingReservation("session-a", validRecording.name))
      .resolves.toBe(true);

    const retried = await recordStop.handle(stopContext, {});

    expect(releaseRecordingReservation).toHaveBeenCalledTimes(2);
    await expect(localState.hasRecordingReservation("session-a", validRecording.name))
      .resolves.toBe(false);
    const [summary, payload] = retried.content;
    expect(summary?.type === "text" ? summary.text : "").toContain("partial");
    expect(payload?.type === "text" ? JSON.parse(payload.text) : null).toEqual({
      ...validRecording,
      name: "Checkout_Flow",
    });
  });

  it("retains the reservation when release returns false while it is still live", async () => {
    const state = createRecordingState();
    state.releaseRecordingReservation
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    state.hasRecordingReservation.mockResolvedValue(true);
    const { recordStart, recordStop } = getRecordingApi().createRecordingTools(
      state,
      () => "session-a",
    );
    await recordStart.handle(
      { sendSocketMessage: vi.fn().mockResolvedValue({ status: "recording" }) } as unknown as Context,
      { name: validRecording.name, tabId: 7 },
    );
    const stopContext = {
      sendSocketMessage: vi.fn()
        .mockResolvedValueOnce({
          extensionSaved: false,
          serverSaved: false,
          recording: validRecording,
          error: "SERVER_PERSIST_FAILED",
        })
        .mockRejectedValueOnce(new Error("No recording in progress")),
    } as unknown as Context;

    await expect(recordStop.handle(stopContext, {})).rejects.toThrow("release failed");
    const retried = await recordStop.handle(stopContext, {});
    const summary = retried.content[0];
    expect(summary?.type === "text" ? summary.text : "").toContain("partial");
    expect(state.releaseRecordingReservation).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["successful", true, [true]],
    ["already expired", false, [true, false]],
  ] as const)("clears retry state exactly once after a %s release", async (_label, released, liveResults) => {
    const state = createRecordingState();
    state.releaseRecordingReservation.mockResolvedValue(released);
    state.hasRecordingReservation.mockReset();
    for (const live of liveResults) state.hasRecordingReservation.mockResolvedValueOnce(live);
    const { recordStart, recordStop } = getRecordingApi().createRecordingTools(
      state,
      () => "session-a",
    );
    await recordStart.handle(
      { sendSocketMessage: vi.fn().mockResolvedValue({ status: "recording" }) } as unknown as Context,
      { name: validRecording.name, tabId: 7 },
    );
    const stopContext = {
      sendSocketMessage: vi.fn()
        .mockResolvedValueOnce({
          extensionSaved: false,
          serverSaved: false,
          recording: validRecording,
          error: "SERVER_PERSIST_FAILED",
        })
        .mockRejectedValueOnce(new Error("No recording in progress")),
    } as unknown as Context;

    const stopped = await recordStop.handle(stopContext, {});
    const summary = stopped.content[0];
    expect(summary?.type === "text" ? summary.text : "").toContain("partial");
    await expect(recordStop.handle(stopContext, {})).rejects.toThrow("No recording in progress");
    expect(state.releaseRecordingReservation).toHaveBeenCalledTimes(1);
  });

  it("releases the active reservation when the stop payload is malformed", async () => {
    const state = createRecordingState();
    const { recordStart, recordStop } = getRecordingApi().createRecordingTools(
      state,
      () => "session-a",
    );
    await recordStart.handle(
      { sendSocketMessage: vi.fn().mockResolvedValue({ status: "recording" }) } as unknown as Context,
      { name: validRecording.name, tabId: 7 },
    );

    await expect(recordStop.handle(
      { sendSocketMessage: vi.fn().mockResolvedValue({ recording: { name: validRecording.name } }) } as unknown as Context,
      {},
    )).rejects.toThrow();
    expect(state.releaseRecordingReservation).toHaveBeenCalledWith("session-a", "Checkout_Flow");
  });

  it("accepts Task 7's acknowledged stop shape without releasing again", async () => {
    const state = createRecordingState();
    state.hasRecordingReservation.mockResolvedValue(false);
    const { recordStart, recordStop } = getRecordingApi().createRecordingTools(
      state,
      () => "session-a",
    );
    await recordStart.handle(
      { sendSocketMessage: vi.fn().mockResolvedValue({ status: "recording" }) } as unknown as Context,
      { name: validRecording.name, tabId: 7 },
    );

    const result = await recordStop.handle(
      {
        sendSocketMessage: vi.fn().mockResolvedValue({
          extensionSaved: true,
          serverSaved: true,
          recording: validRecording,
        }),
      } as unknown as Context,
      {},
    );

    const summary = result.content[0];
    expect(summary?.type === "text" ? summary.text : "").toContain("acknowledged");
    expect(state.releaseRecordingReservation).not.toHaveBeenCalled();
  });

  it("validates the complete recording before creating the destination directory", () => {
    const base = mkdtempSync(join(tmpdir(), "mybrowser-recording-invalid-"));
    tempDirs.push(base);
    const recordingsDir = join(base, "recordings");

    expect(() => getRecordingApi().saveRecordingToFile({ name: "demo" }, recordingsDir)).toThrow();
    expect(() => getRecordingApi().saveRecordingToFile(
      { ...validRecording, stoppedAt: undefined },
      recordingsDir,
    )).toThrow();
    expect(() => statSync(recordingsDir)).toThrow();
  });

  it("rejects legacy reverse values and descriptive required-variable metadata", () => {
    const base = mkdtempSync(join(tmpdir(), "mybrowser-recording-metadata-"));
    tempDirs.push(base);
    const secret = "SECRET_SERVER_SCHEMA_ALPHA_1904";
    let legacyError = "";
    try {
      getRecordingApi().saveRecordingToFile({
        ...validRecording,
        variables: { account: secret },
      });
    } catch (error) {
      legacyError = error instanceof Error ? error.message : String(error);
    }
    expect(legacyError).not.toBe("");
    expect(legacyError).not.toContain(secret);

    expect(() => getRecordingApi().saveRecordingToFile({
      ...validRecording,
      requiredVariables: [{
        name: "input_1",
        source: "text",
        hint: "Password field",
        label: "Private account",
      }],
    }, join(base, "descriptive"))).toThrow();
    expect(() => getRecordingApi().saveRecordingToFile({
      ...validRecording,
      steps: [{
        ...validRecording.steps[0],
        args: { text: "{{input_2}}" },
      }],
      requiredVariables: [{ name: "input_2", source: "text", hint: "text_input_2" }],
    }, join(base, "counter"))).toThrow();
  });

  it("rejects original sensitive action values without echoing canaries", () => {
    const unsafeSteps = [
      { action: "browser_type", args: { text: "SECRET_SERVER_TYPE_4109" } },
      { action: "browser_fill_form", args: { fields: { Account: "SECRET_SERVER_FORM_5628" } } },
      { action: "browser_select_option", args: { values: ["SECRET_SERVER_SELECT_7813"] } },
      { action: "browser_navigate", args: { url: "https://user:SECRET_SERVER_URL_9337@example.test/path?token=private#hash" } },
      { action: "browser_clipboard", args: { action: "write", text: "SECRET_SERVER_CLIPBOARD_2465" } },
    ];

    for (const [index, unsafe] of unsafeSteps.entries()) {
      const base = mkdtempSync(join(tmpdir(), `mybrowser-recording-sensitive-${index}-`));
      tempDirs.push(base);
      const recordingsDir = join(base, "recordings");
      let message = "";
      try {
        getRecordingApi().saveRecordingToFile({
          ...validRecording,
          steps: [{
            ...validRecording.steps[0],
            ...unsafe,
          }],
          requiredVariables: [],
        }, recordingsDir);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).not.toBe("");
      expect(message).not.toContain("SECRET_SERVER_");
      expect(() => statSync(recordingsDir)).toThrow();
    }
  });

  it("rejects recordings beyond the step and byte caps before filesystem effects", () => {
    const base = mkdtempSync(join(tmpdir(), "mybrowser-recording-caps-"));
    tempDirs.push(base);
    const recordingsDir = join(base, "recordings");
    expect(() => getRecordingApi().saveRecordingToFile({
      ...validRecording,
      steps: Array.from({ length: 1_001 }, () => validRecording.steps[0]),
    }, recordingsDir)).toThrow();
    expect(() => getRecordingApi().saveRecordingToFile({
      ...validRecording,
      steps: [{
        ...validRecording.steps[0],
        args: { element: "x".repeat(2 * 1024 * 1024), text: "{{input_1}}" },
      }],
    }, recordingsDir)).toThrow();
    expect(() => statSync(recordingsDir)).toThrow();
  });

  it("writes exclusively with hardened modes and never overwrites", () => {
    const base = mkdtempSync(join(tmpdir(), "mybrowser-recording-exclusive-"));
    tempDirs.push(base);
    const recordingsDir = join(base, "recordings");

    getRecordingApi().saveRecordingToFile(validRecording, recordingsDir);
    const filePath = join(recordingsDir, "Checkout_Flow.json");
    const original = readFileSync(filePath, "utf8");

    expect(statSync(recordingsDir).mode & 0o777).toBe(0o700);
    expect(statSync(filePath).mode & 0o777).toBe(0o600);
    expect(original.endsWith("\n")).toBe(true);
    expect(() => getRecordingApi().saveRecordingToFile(
      { ...validRecording, url: "https://overwrite.test/" },
      recordingsDir,
    )).toThrow(/EEXIST/);
    expect(readFileSync(filePath, "utf8")).toBe(original);
  });

  it("rejects a normalized alias embedded in an existing canonical artifact", () => {
    const base = mkdtempSync(join(tmpdir(), "mybrowser-recording-alias-"));
    tempDirs.push(base);
    const recordingsDir = join(base, "recordings");
    mkdirSync(recordingsDir, { mode: 0o700 });
    const filePath = join(recordingsDir, "Checkout_Flow.json");
    const aliasContents = `${JSON.stringify({
      ...validRecording,
      name: "Checkout Flow",
    }, null, 2)}\n`;
    writeFileSync(filePath, aliasContents, { mode: 0o600 });

    expect(() => getRecordingApi().saveRecordingToFile(validRecording, recordingsDir))
      .toThrow(/EEXIST/);
    expect(readFileSync(filePath, "utf8")).toBe(aliasContents);

    writeFileSync(filePath, `${JSON.stringify(validRecording, null, 2)}\n`);
    expect(getRecordingApi().saveRecordingToFile(validRecording, recordingsDir))
      .toBe("existing-identical");
  });

  it("fsyncs and closes the recording directory for new and idempotent writes", () => {
    const base = mkdtempSync(join(tmpdir(), "mybrowser-recording-dir-sync-"));
    tempDirs.push(base);
    const recordingsDir = join(base, "recordings");
    const open = vi.fn(((path, flags, mode) => {
      return openSync(path, flags, mode);
    }) as typeof openSync);
    const fsync = vi.fn(((fd: number) => fsyncSync(fd)) as typeof fsyncSync);
    const close = vi.fn(((fd: number) => closeSync(fd)) as typeof closeSync);
    const ops = recordingFileOps({ openSync: open, fsyncSync: fsync, closeSync: close });

    expect(getRecordingApi().saveRecordingToFile(validRecording, recordingsDir, ops)).toBe("created");
    expect(getRecordingApi().saveRecordingToFile(validRecording, recordingsDir, ops))
      .toBe("existing-identical");

    const directoryOpenCalls = open.mock.calls.filter(([path]) => path === recordingsDir);
    expect(directoryOpenCalls).toHaveLength(2);
    expect(fsync).toHaveBeenCalledTimes(4);
    expect(close).toHaveBeenCalledTimes(4);
  });

  it.each(["open", "fsync", "close"] as const)(
    "fails without deleting the durable file when directory %s fails and permits retry",
    (failure) => {
      const base = mkdtempSync(join(tmpdir(), `mybrowser-recording-dir-${failure}-`));
      tempDirs.push(base);
      const recordingsDir = join(base, "recordings");
      let directoryFd: number | undefined;
      const open = ((path: Parameters<typeof openSync>[0], flags: Parameters<typeof openSync>[1], mode?: number) => {
        if (failure === "open" && path === recordingsDir) throw new Error("directory open failed");
        const fd = openSync(path, flags, mode);
        if (path === recordingsDir) directoryFd = fd;
        return fd;
      }) as typeof openSync;
      const fsync = ((fd: number) => {
        if (failure === "fsync" && fd === directoryFd) throw new Error("directory fsync failed");
        fsyncSync(fd);
      }) as typeof fsyncSync;
      const close = ((fd: number) => {
        if (failure === "close" && fd === directoryFd) {
          closeSync(fd);
          throw new Error("directory close failed");
        }
        closeSync(fd);
      }) as typeof closeSync;

      expect(() => getRecordingApi().saveRecordingToFile(
        validRecording,
        recordingsDir,
        recordingFileOps({ openSync: open, fsyncSync: fsync, closeSync: close }),
      )).toThrow("recording directory sync failed");
      expect(existsSync(join(recordingsDir, "Checkout_Flow.json"))).toBe(true);
      expect(getRecordingApi().saveRecordingToFile(validRecording, recordingsDir))
        .toBe("existing-identical");
    },
  );

  it("removes an incomplete file after initial fsync failure and allows retry", () => {
    const base = mkdtempSync(join(tmpdir(), "mybrowser-recording-new-fsync-"));
    tempDirs.push(base);
    const recordingsDir = join(base, "recordings");
    const filePath = join(recordingsDir, "Checkout_Flow.json");
    const fsync = vi.fn()
      .mockImplementationOnce(() => {
        throw new Error("injected initial fsync failure");
      })
      .mockImplementation(fsyncSync);
    const unlink = vi.fn(unlinkSync);
    const close = vi.fn(closeSync);
    const ops = recordingFileOps({
      closeSync: close,
      fsyncSync: fsync,
      unlinkSync: unlink,
    });

    expect(() => getRecordingApi().saveRecordingToFile(
      validRecording,
      recordingsDir,
      ops,
    )).toThrow("injected initial fsync failure");
    expect(existsSync(filePath)).toBe(false);
    expect(unlink).toHaveBeenCalledWith(filePath);
    expect(close.mock.invocationCallOrder[0]).toBeLessThan(unlink.mock.invocationCallOrder[0]!);

    expect(getRecordingApi().saveRecordingToFile(
      validRecording,
      recordingsDir,
      ops,
    )).toBe("created");
    expect(existsSync(filePath)).toBe(true);
  });

  it("closes and unlinks a new artifact when descriptor fchmod fails", () => {
    const base = mkdtempSync(join(tmpdir(), "mybrowser-recording-new-fchmod-"));
    tempDirs.push(base);
    const recordingsDir = join(base, "recordings");
    const filePath = join(recordingsDir, "Checkout_Flow.json");
    const close = vi.fn(closeSync);
    const unlink = vi.fn(unlinkSync);
    const fchmod = vi.fn(() => {
      throw new Error("injected fchmod failure");
    });

    expect(() => getRecordingApi().saveRecordingToFile(
      validRecording,
      recordingsDir,
      recordingFileOps({
        closeSync: close,
        fchmodSync: fchmod,
        unlinkSync: unlink,
      }),
    )).toThrow("injected fchmod failure");
    expect(fchmod).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(unlink).toHaveBeenCalledWith(filePath);
    expect(close.mock.invocationCallOrder[0]).toBeLessThan(unlink.mock.invocationCallOrder[0]!);
    expect(existsSync(filePath)).toBe(false);
  });

  it("rejects and removes a new descriptor whose hardened mode is not exactly 0600", () => {
    const base = mkdtempSync(join(tmpdir(), "mybrowser-recording-new-mode-"));
    tempDirs.push(base);
    const recordingsDir = join(base, "recordings");
    const filePath = join(recordingsDir, "Checkout_Flow.json");
    const close = vi.fn(closeSync);
    const unlink = vi.fn(unlinkSync);
    const write = vi.fn(writeFileSync);
    const fchmod = vi.fn();
    const fstat = vi.fn(((fd: number) => {
      const stats = fstatSync(fd);
      Object.defineProperty(stats, "mode", {
        value: (stats.mode & ~0o777) | 0o400,
      });
      return stats;
    }) as typeof fstatSync);

    expect(() => getRecordingApi().saveRecordingToFile(
      validRecording,
      recordingsDir,
      recordingFileOps({
        closeSync: close,
        fchmodSync: fchmod,
        fstatSync: fstat,
        unlinkSync: unlink,
        writeFileSync: write,
      }),
    )).toThrow("New recording descriptor must have exact mode 0600");
    expect(fchmod).toHaveBeenCalledTimes(1);
    expect(fstat).toHaveBeenCalledTimes(1);
    expect(write).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
    expect(unlink).toHaveBeenCalledWith(filePath);
    expect(existsSync(filePath)).toBe(false);
  });

  it("rejects an existing identical artifact whose file mode is not exactly 0600", () => {
    const base = mkdtempSync(join(tmpdir(), "mybrowser-recording-file-mode-"));
    tempDirs.push(base);
    const recordingsDir = join(base, "recordings");
    const filePath = join(recordingsDir, "Checkout_Flow.json");
    getRecordingApi().saveRecordingToFile(validRecording, recordingsDir);
    chmodSync(filePath, 0o640);

    expect(() => getRecordingApi().saveRecordingToFile(validRecording, recordingsDir))
      .toThrow("exact mode 0600");
    expect(statSync(filePath).mode & 0o777).toBe(0o640);
  });

  it("rejects symlink and non-regular existing artifact paths", () => {
    const symlinkBase = mkdtempSync(join(tmpdir(), "mybrowser-recording-symlink-"));
    const nonRegularBase = mkdtempSync(join(tmpdir(), "mybrowser-recording-nonregular-"));
    tempDirs.push(symlinkBase, nonRegularBase);

    const symlinkDir = join(symlinkBase, "recordings");
    mkdirSync(symlinkDir, { recursive: true, mode: 0o700 });
    const target = join(symlinkBase, "target.json");
    writeFileSync(target, JSON.stringify(validRecording));
    chmodSync(target, 0o600);
    symlinkSync(target, join(symlinkDir, "Checkout_Flow.json"));
    expect(() => getRecordingApi().saveRecordingToFile(validRecording, symlinkDir))
      .toThrow("regular non-symlink");

    const nonRegularDir = join(nonRegularBase, "recordings");
    mkdirSync(join(nonRegularDir, "Checkout_Flow.json"), {
      recursive: true,
      mode: 0o700,
    });
    expect(() => getRecordingApi().saveRecordingToFile(validRecording, nonRegularDir))
      .toThrow("regular non-symlink");
  });

  it("rejects pathname replacement when descriptor identity differs from lstat", () => {
    const base = mkdtempSync(join(tmpdir(), "mybrowser-recording-replaced-"));
    tempDirs.push(base);
    const recordingsDir = join(base, "recordings");
    const filePath = join(recordingsDir, "Checkout_Flow.json");
    const replacementPath = join(base, "replacement.json");
    getRecordingApi().saveRecordingToFile(validRecording, recordingsDir);
    writeFileSync(replacementPath, readFileSync(filePath));
    chmodSync(replacementPath, 0o600);
    const lstat = vi.fn(((path: Parameters<typeof lstatSync>[0]) => {
      const snapshot = lstatSync(path);
      renameSync(replacementPath, filePath);
      return snapshot;
    }) as typeof lstatSync);
    const fsync = vi.fn(fsyncSync);

    expect(() => getRecordingApi().saveRecordingToFile(
      validRecording,
      recordingsDir,
      recordingFileOps({ fsyncSync: fsync, lstatSync: lstat }),
    )).toThrow("changed between lstat and open");
    expect(fsync).not.toHaveBeenCalled();
  });

  it("rejects replacement by symlink between lstat and descriptor open", () => {
    const base = mkdtempSync(join(tmpdir(), "mybrowser-recording-replaced-symlink-"));
    tempDirs.push(base);
    const recordingsDir = join(base, "recordings");
    const filePath = join(recordingsDir, "Checkout_Flow.json");
    const targetPath = join(base, "target.json");
    getRecordingApi().saveRecordingToFile(validRecording, recordingsDir);
    writeFileSync(targetPath, readFileSync(filePath));
    chmodSync(targetPath, 0o600);
    const lstat = ((path: Parameters<typeof lstatSync>[0]) => {
      const snapshot = lstatSync(path);
      unlinkSync(filePath);
      symlinkSync(targetPath, filePath);
      return snapshot;
    }) as typeof lstatSync;
    const fsync = vi.fn(fsyncSync);

    expect(() => getRecordingApi().saveRecordingToFile(
      validRecording,
      recordingsDir,
      recordingFileOps({ fsyncSync: fsync, lstatSync: lstat }),
    )).toThrow();
    expect(fsync).not.toHaveBeenCalled();
  });

  it("rejects a descriptor whose mode changed after the lstat snapshot", () => {
    const base = mkdtempSync(join(tmpdir(), "mybrowser-recording-descriptor-mode-"));
    tempDirs.push(base);
    const recordingsDir = join(base, "recordings");
    const filePath = join(recordingsDir, "Checkout_Flow.json");
    getRecordingApi().saveRecordingToFile(validRecording, recordingsDir);
    const open = ((
      path: Parameters<typeof openSync>[0],
      flags: Parameters<typeof openSync>[1],
      mode?: number,
    ) => {
      if (flags !== "wx") chmodSync(filePath, 0o640);
      return openSync(path, flags, mode);
    }) as typeof openSync;
    const fsync = vi.fn(fsyncSync);

    expect(() => getRecordingApi().saveRecordingToFile(
      validRecording,
      recordingsDir,
      recordingFileOps({ fsyncSync: fsync, openSync: open }),
    )).toThrow("descriptor must have exact mode 0600");
    expect(fsync).not.toHaveBeenCalled();
  });

  it("rejects an identical existing artifact when descriptor fsync fails", () => {
    const base = mkdtempSync(join(tmpdir(), "mybrowser-recording-existing-fsync-"));
    tempDirs.push(base);
    const recordingsDir = join(base, "recordings");
    getRecordingApi().saveRecordingToFile(validRecording, recordingsDir);
    const fsync = vi.fn(() => {
      throw new Error("injected existing fsync failure");
    });
    const close = vi.fn(closeSync);

    expect(() => getRecordingApi().saveRecordingToFile(
      validRecording,
      recordingsDir,
      recordingFileOps({ closeSync: close, fsyncSync: fsync }),
    )).toThrow("injected existing fsync failure");
    expect(fsync).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(fsync.mock.invocationCallOrder[0]).toBeLessThan(close.mock.invocationCallOrder[0]!);
  });

  it("fsyncs and closes an identical existing artifact before durable retry succeeds", () => {
    const base = mkdtempSync(join(tmpdir(), "mybrowser-recording-existing-durable-"));
    tempDirs.push(base);
    const recordingsDir = join(base, "recordings");
    getRecordingApi().saveRecordingToFile(validRecording, recordingsDir);
    const filePath = join(recordingsDir, "Checkout_Flow.json");
    writeFileSync(filePath, JSON.stringify({
      requiredVariables: validRecording.requiredVariables,
      steps: validRecording.steps.map((step) => ({
        url: step.url,
        durationMs: step.durationMs,
        timestamp: step.timestamp,
        args: step.args,
        action: step.action,
      })),
      url: validRecording.url,
      stoppedAt: validRecording.stoppedAt,
      startedAt: validRecording.startedAt,
      name: validRecording.name,
    }));
    chmodSync(filePath, 0o600);
    const fsync = vi.fn(fsyncSync);
    const close = vi.fn(closeSync);
    const open = vi.fn(openSync);

    expect(getRecordingApi().saveRecordingToFile(
      validRecording,
      recordingsDir,
      recordingFileOps({ closeSync: close, fsyncSync: fsync, openSync: open }),
    )).toBe("existing-identical");
    expect(fsync).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(2);
    const verifiedFileFd = open.mock.results[1]?.value;
    const directoryFd = open.mock.results[2]?.value;
    expect(fsync.mock.calls.map(([fd]) => fd)).toEqual([verifiedFileFd, directoryFd]);
    expect(close.mock.calls.map(([fd]) => fd)).toEqual([verifiedFileFd, directoryFd]);
    expect(fsync.mock.invocationCallOrder[0]).toBeLessThan(close.mock.invocationCallOrder[0]!);
    expect(fsync.mock.invocationCallOrder[1]).toBeLessThan(close.mock.invocationCallOrder[1]!);
    const existingOpenFlags = open.mock.calls[1]?.[1];
    expect(typeof existingOpenFlags).toBe("number");
    if (typeof fsConstants.O_NOFOLLOW === "number") {
      expect((existingOpenFlags as number) & fsConstants.O_NOFOLLOW).toBe(fsConstants.O_NOFOLLOW);
    }
  });

  it("corrects an existing permissive recordings directory to 0700", () => {
    const base = mkdtempSync(join(tmpdir(), "mybrowser-recording-permissions-"));
    tempDirs.push(base);
    const recordingsDir = join(base, "recordings");
    chmodSync(base, 0o777);
    mkdirSync(recordingsDir, { mode: 0o777 });
    chmodSync(recordingsDir, 0o777);

    getRecordingApi().saveRecordingToFile(validRecording, recordingsDir);

    expect(statSync(base).mode & 0o777).toBe(0o700);
    expect(statSync(recordingsDir).mode & 0o777).toBe(0o700);
  });

  it("fails closed before file creation when directory chmod fails", () => {
    const base = mkdtempSync(join(tmpdir(), "mybrowser-recording-chmod-failure-"));
    tempDirs.push(base);
    const recordingsDir = join(base, "recordings");
    let chmodCalls = 0;

    expect(() => getRecordingApi().saveRecordingToFile(
      validRecording,
      recordingsDir,
      {
        mkdirSync,
        chmodSync(path, mode) {
          chmodCalls += 1;
          if (chmodCalls === 2) throw new Error("injected chmod failure");
          chmodSync(path, mode);
        },
        statSync,
      },
    )).toThrow("injected chmod failure");
    expect(existsSync(join(recordingsDir, "Checkout_Flow.json"))).toBe(false);
  });

  it("fails closed when owner directory bits are not exactly 0700", () => {
    const base = mkdtempSync(join(tmpdir(), "mybrowser-recording-wrong-owner-mode-"));
    tempDirs.push(base);
    const recordingsDir = join(base, "recordings");
    const wrongModeStat = ((path: Parameters<typeof statSync>[0]) => {
      const stats = statSync(path);
      Object.defineProperty(stats, "mode", {
        value: (stats.mode & ~0o777) | 0o600,
      });
      return stats;
    }) as typeof statSync;

    expect(() => getRecordingApi().saveRecordingToFile(
      validRecording,
      recordingsDir,
      { mkdirSync, chmodSync, statSync: wrongModeStat },
    )).toThrow("exact mode 0700");
    expect(existsSync(join(recordingsDir, "Checkout_Flow.json"))).toBe(false);
  });
});

describe("acknowledged recording reservation messages", () => {
  it("bounds unresolved canonical retry state to one payload per session and clears cleanup state", () => {
    const registry = new RecordingRetryRegistry();
    expect(registry.retain("session-a", "flow-a", "canonical-a")).toBe(true);
    expect(registry.retain("session-a", "flow-b", "canonical-b")).toBe(false);
    expect(registry.count("session-a")).toBe(1);
    expect(registry.match("session-a", "flow-a", "canonical-a")).toBe(true);
    registry.clearTerminated("session-a", "other");
    expect(registry.count("session-a")).toBe(1);
    registry.clearTerminated("session-a", "flow-a");
    expect(registry.count("session-a")).toBe(0);
    expect(registry.count()).toBe(0);
  });

  it.each([
    ["identical", validRecording],
    ["differing", { ...validRecording, url: "https://different.test/" }],
  ] as const)("serializes concurrent %s persistence through reservation release", async (
    label,
    secondPayload,
  ) => {
    const base = mkdtempSync(join(tmpdir(), `mybrowser-recording-concurrent-${label}-`));
    tempDirs.push(base);
    const retryRegistry = new RecordingRetryRegistry();
    const { server, extension } = await setupReservedRecording(
      join(base, "recordings"), undefined, retryRegistry,
    );
    const releaseGate = deferred<void>();
    const releaseOriginal = server.stateManager.releaseRecordingReservation.bind(server.stateManager);
    const release = vi.spyOn(server.stateManager, "releaseRecordingReservation")
      .mockImplementation(async (...args) => {
        await releaseGate.promise;
        return releaseOriginal(...args);
      });
    const responsesPromise = waitForMessages(extension, 2);

    extension.send(JSON.stringify({
      type: "persistRecording",
      id: "persist-first",
      sessionId: "session-a",
      payload: validRecording,
    }));
    extension.send(JSON.stringify({
      type: "persistRecording",
      id: "persist-second",
      sessionId: "session-a",
      payload: secondPayload,
    }));
    await vi.waitFor(() => expect(release).toHaveBeenCalled());
    releaseGate.resolve();

    const responses = await responsesPromise;
    expect(responses.find((response) => response.id === "persist-first")).toEqual({
      type: "persistRecordingResult",
      id: "persist-first",
      ok: true,
    });
    expect(responses.find((response) => response.id === "persist-second")).toEqual({
      type: "persistRecordingResult",
      id: "persist-second",
      ok: false,
      error: "reservation unavailable",
    });
    expect(retryRegistry.count()).toBe(0);

    const nextName = `Next_${label}`;
    await expect(server.stateManager.reserveRecording("session-a", nextName, 1_800_000))
      .resolves.toMatchObject({ ok: true, reservation: { name: nextName } });
    await expect(persistRecordingMessage(extension, `persist-next-${label}`, {
      ...validRecording,
      name: nextName,
    })).resolves.toEqual({
      type: "persistRecordingResult",
      id: `persist-next-${label}`,
      ok: true,
    });
  });

  it("bounds each session persistence FIFO and returns a correlated overflow error", async () => {
    const base = mkdtempSync(join(tmpdir(), "mybrowser-recording-persist-bound-"));
    tempDirs.push(base);
    const retryRegistry = new RecordingRetryRegistry();
    const { server, extension } = await setupReservedRecording(
      join(base, "recordings"), undefined, retryRegistry,
    );
    const hasGate = deferred<void>();
    const hasOriginal = server.stateManager.hasRecordingReservation.bind(server.stateManager);
    let firstCheck = true;
    vi.spyOn(server.stateManager, "hasRecordingReservation")
      .mockImplementation(async (...args) => {
        if (firstCheck) {
          firstCheck = false;
          await hasGate.promise;
        }
        return hasOriginal(...args);
      });
    const overflowPromise = waitForMessage(extension);

    for (let index = 1; index <= MAX_PENDING_RECORDING_PERSISTS_PER_SESSION + 1; index += 1) {
      extension.send(JSON.stringify({
        type: "persistRecording",
        id: `persist-bounded-${index}`,
        sessionId: "session-a",
        payload: validRecording,
      }));
    }
    await expect(overflowPromise).resolves.toEqual({
      type: "persistRecordingResult",
      id: `persist-bounded-${MAX_PENDING_RECORDING_PERSISTS_PER_SESSION + 1}`,
      ok: false,
      error: "persistence busy",
    });

    const queuedResponses = waitForMessages(extension, 4);
    hasGate.resolve();
    const responses = await queuedResponses;
    expect(responses.filter((response) => response.ok === true)).toHaveLength(1);
    expect(responses.filter((response) => response.error === "reservation unavailable"))
      .toHaveLength(3);
    expect(retryRegistry.count()).toBe(0);
  });

  it("continues a session persistence FIFO after an individual rejection", async () => {
    const base = mkdtempSync(join(tmpdir(), "mybrowser-recording-persist-recovery-"));
    tempDirs.push(base);
    let failFirstWrite = true;
    const retryRegistry = new RecordingRetryRegistry();
    const { extension } = await setupReservedRecording(join(base, "recordings"), {
      fchmodSync: (fd, mode) => {
        if (failFirstWrite) {
          failFirstWrite = false;
          throw new Error("first queued write failed");
        }
        fchmodSync(fd, mode);
      },
    }, retryRegistry);
    const responsesPromise = waitForMessages(extension, 2);

    for (const id of ["persist-rejected-first", "persist-after-rejection"]) {
      extension.send(JSON.stringify({
        type: "persistRecording",
        id,
        sessionId: "session-a",
        payload: validRecording,
      }));
    }

    const responses = await responsesPromise;
    expect(responses.find((response) => response.id === "persist-rejected-first")).toEqual({
      type: "persistRecordingResult",
      id: "persist-rejected-first",
      ok: false,
      error: "persistence failed",
    });
    expect(responses.find((response) => response.id === "persist-after-rejection")).toEqual({
      type: "persistRecordingResult",
      id: "persist-after-rejection",
      ok: true,
    });
    expect(retryRegistry.count()).toBe(0);
  });

  it("renews a live matching reservation with a correlated acknowledgement", async () => {
    const server = await startHub();
    const extension = await connect(server);
    await authenticate(extension, "extension");
    const client = await connect(server);
    await authenticate(client, "client");
    await callHubRpc(client, "register-a", "registerSession", { sessionId: "session-a" });
    await callHubRpc(client, "reserve-a", "reserveRecording", {
      name: "Checkout Flow",
      leaseMs: 1_800_000,
    });

    const response = waitForMessage(extension);
    extension.send(JSON.stringify({
      type: "renewRecordingReservation",
      id: "renew-a",
      sessionId: "session-a",
      name: "Checkout Flow",
    }));

    await expect(response).resolves.toEqual({
      type: "renewRecordingReservationResult",
      id: "renew-a",
      ok: true,
    });
    await expect(server.stateManager.hasRecordingReservation("session-a", "Checkout_Flow"))
      .resolves.toBe(true);
  });

  it("persists exclusively, acknowledges, then releases the reservation", async () => {
    const base = mkdtempSync(join(tmpdir(), "mybrowser-recording-ws-"));
    tempDirs.push(base);
    const recordingsDir = join(base, "recordings");
    const retryRegistry = new RecordingRetryRegistry();
    const server = await startHub(recordingsDir, undefined, retryRegistry);
    const extension = await connect(server);
    await authenticate(extension, "extension");
    const client = await connect(server);
    await authenticate(client, "client");
    await callHubRpc(client, "register-a", "registerSession", { sessionId: "session-a" });
    await callHubRpc(client, "reserve-a", "reserveRecording", {
      name: validRecording.name,
      leaseMs: 1_800_000,
    });

    const response = waitForMessage(extension);
    extension.send(JSON.stringify({
      type: "persistRecording",
      id: "persist-a",
      sessionId: "session-a",
      payload: validRecording,
    }));

    await expect(response).resolves.toEqual({
      type: "persistRecordingResult",
      id: "persist-a",
      ok: true,
    });
    expect(JSON.parse(readFileSync(join(recordingsDir, "Checkout_Flow.json"), "utf8")))
      .toMatchObject({ name: "Checkout_Flow", steps: validRecording.steps });
    await expect(server.stateManager.hasRecordingReservation("session-a", validRecording.name))
      .resolves.toBe(false);
    expect(retryRegistry.count("session-a")).toBe(0);

    const original = readFileSync(join(recordingsDir, "Checkout_Flow.json"), "utf8");
    await expect(persistRecordingMessage(extension, "persist-cleanup-retry"))
      .resolves.toEqual({
        type: "persistRecordingResult",
        id: "persist-cleanup-retry",
        ok: false,
        error: "reservation unavailable",
      });
    await expect(persistRecordingMessage(extension, "persist-cleanup-different", {
      ...validRecording,
      url: "https://different.test/",
    })).resolves.toEqual({
      type: "persistRecordingResult",
      id: "persist-cleanup-different",
      ok: false,
      error: "reservation unavailable",
    });
    expect(readFileSync(join(recordingsDir, "Checkout_Flow.json"), "utf8")).toBe(original);
  });

  it("rejects a raw embedded alias without consuming reservation or retry state", async () => {
    const base = mkdtempSync(join(tmpdir(), "mybrowser-recording-ingress-alias-"));
    tempDirs.push(base);
    const recordingsDir = join(base, "recordings");
    const retryRegistry = new RecordingRetryRegistry();
    expect(retryRegistry.retain(
      "session-a",
      validRecording.name,
      JSON.stringify(validRecording),
    )).toBe(true);
    const { server, extension } = await setupReservedRecording(
      recordingsDir,
      undefined,
      retryRegistry,
    );

    await expect(persistRecordingMessage(extension, "persist-alias", {
      ...validRecording,
      name: "Checkout Flow",
    })).resolves.toEqual({
      type: "persistRecordingResult",
      id: "persist-alias",
      ok: false,
      error: "invalid request",
    });
    await expect(server.stateManager.hasRecordingReservation(
      "session-a", validRecording.name,
    )).resolves.toBe(true);
    expect(retryRegistry.count("session-a")).toBe(1);

    await expect(persistRecordingMessage(extension, "persist-canonical"))
      .resolves.toEqual({
        type: "persistRecordingResult",
        id: "persist-canonical",
        ok: true,
      });
    await expect(server.stateManager.hasRecordingReservation(
      "session-a", validRecording.name,
    )).resolves.toBe(false);
    expect(retryRegistry.count()).toBe(0);
  });

  it("checks a wrong canonical raw name before strict sanitize or persistence", async () => {
    const base = mkdtempSync(join(tmpdir(), "mybrowser-recording-raw-owner-"));
    tempDirs.push(base);
    const recordingsDir = join(base, "recordings");
    const mkdir = vi.fn(mkdirSync);
    const { server, extension } = await setupReservedRecording(recordingsDir, {
      mkdirSync: mkdir,
    });
    const hasReservation = vi.spyOn(server.stateManager, "hasRecordingReservation");

    await expect(persistRecordingMessage(extension, "persist-wrong-owner", {
      name: "Other_Flow",
    })).resolves.toEqual({
      type: "persistRecordingResult",
      id: "persist-wrong-owner",
      ok: false,
      error: "reservation unavailable",
    });

    expect(hasReservation).toHaveBeenCalledWith("session-a", "Other_Flow");
    expect(mkdir).not.toHaveBeenCalled();
    await expect(server.stateManager.hasRecordingReservation(
      "session-a", validRecording.name,
    )).resolves.toBe(true);
  });

  it("keeps canonical retry retention at zero across many successful recordings", async () => {
    const base = mkdtempSync(join(tmpdir(), "mybrowser-recording-long-session-"));
    tempDirs.push(base);
    const recordingsDir = join(base, "recordings");
    const retryRegistry = new RecordingRetryRegistry();
    const server = await startHub(recordingsDir, undefined, retryRegistry);
    const extension = await connect(server);
    await authenticate(extension, "extension");
    const client = await connect(server);
    await authenticate(client, "client");
    await callHubRpc(client, "register-long", "registerSession", { sessionId: "session-a" });

    for (let index = 0; index < 20; index += 1) {
      const name = `long-session-${index}`;
      await callHubRpc(client, `reserve-${index}`, "reserveRecording", {
        name,
        leaseMs: 1_800_000,
      });
      await expect(persistRecordingMessage(extension, `persist-${index}`, {
        ...validRecording,
        name,
      })).resolves.toEqual({
        type: "persistRecordingResult",
        id: `persist-${index}`,
        ok: true,
      });
      expect(retryRegistry.count("session-a")).toBe(0);
    }
    expect(retryRegistry.count()).toBe(0);
  });

  it("does not release or acknowledge when new descriptor fchmod fails", async () => {
    const base = mkdtempSync(join(tmpdir(), "mybrowser-recording-ack-fchmod-"));
    tempDirs.push(base);
    const recordingsDir = join(base, "recordings");
    const { server, extension } = await setupReservedRecording(recordingsDir, {
      fchmodSync: () => {
        throw new Error("injected fchmod failure");
      },
    });
    const release = vi.spyOn(server.stateManager, "releaseRecordingReservation");

    await expect(persistRecordingMessage(extension, "persist-fchmod-failure")).resolves.toEqual({
      type: "persistRecordingResult",
      id: "persist-fchmod-failure",
      ok: false,
      error: "persistence failed",
    });
    expect(release).not.toHaveBeenCalled();
    expect(existsSync(join(recordingsDir, "Checkout_Flow.json"))).toBe(false);
    await expect(server.stateManager.hasRecordingReservation("session-a", validRecording.name))
      .resolves.toBe(true);
  });

  it("does not acknowledge or release until directory fsync succeeds", async () => {
    const base = mkdtempSync(join(tmpdir(), "mybrowser-recording-ack-dir-fsync-"));
    tempDirs.push(base);
    const recordingsDir = join(base, "recordings");
    let directoryFd: number | undefined;
    let failDirectorySync = true;
    const retryRegistry = new RecordingRetryRegistry();
    const { server, extension } = await setupReservedRecording(recordingsDir, {
      openSync: ((path, flags, mode) => {
        const fd = openSync(path, flags, mode);
        if (path === recordingsDir) directoryFd = fd;
        return fd;
      }) as typeof openSync,
      fsyncSync: ((fd: number) => {
        if (failDirectorySync && fd === directoryFd) throw new Error("directory fsync failed");
        fsyncSync(fd);
      }) as typeof fsyncSync,
    }, retryRegistry);
    const release = vi.spyOn(server.stateManager, "releaseRecordingReservation");

    await expect(persistRecordingMessage(extension, "persist-dir-fsync-failure")).resolves.toEqual({
      type: "persistRecordingResult",
      id: "persist-dir-fsync-failure",
      ok: false,
      error: "persistence failed",
    });
    expect(release).not.toHaveBeenCalled();
    expect(retryRegistry.count("session-a")).toBe(1);
    expect(existsSync(join(recordingsDir, "Checkout_Flow.json"))).toBe(true);

    failDirectorySync = false;
    await expect(persistRecordingMessage(extension, "persist-dir-fsync-retry")).resolves.toEqual({
      type: "persistRecordingResult",
      id: "persist-dir-fsync-retry",
      ok: true,
    });
    expect(release).toHaveBeenCalledTimes(1);
    expect(retryRegistry.count("session-a")).toBe(0);
  });

  it("clears retained retry state through the HubStateManager release wrapper", async () => {
    const base = mkdtempSync(join(tmpdir(), "mybrowser-recording-wrapper-release-"));
    tempDirs.push(base);
    const recordingsDir = join(base, "recordings");
    let directoryFd: number | undefined;
    let failDirectorySync = true;
    const retryRegistry = new RecordingRetryRegistry();
    const { extension, client } = await setupReservedRecording(recordingsDir, {
      openSync: ((path, flags, mode) => {
        const fd = openSync(path, flags, mode);
        if (path === recordingsDir) directoryFd = fd;
        return fd;
      }) as typeof openSync,
      fsyncSync: ((fd: number) => {
        if (failDirectorySync && fd === directoryFd) throw new Error("directory fsync failed");
        fsyncSync(fd);
      }) as typeof fsyncSync,
    }, retryRegistry);

    await expect(persistRecordingMessage(extension, "persist-wrapper-failure")).resolves.toEqual({
      type: "persistRecordingResult",
      id: "persist-wrapper-failure",
      ok: false,
      error: "persistence failed",
    });
    expect(retryRegistry.count("session-a")).toBe(1);

    const remoteState = new HubStateManager(() => client);
    await expect(remoteState.releaseRecordingReservation("ignored", validRecording.name))
      .resolves.toBe(true);
    expect(retryRegistry.count("session-a")).toBe(0);

    failDirectorySync = false;
    await expect(remoteState.reserveRecording("ignored", "Different Flow", 1_800_000))
      .resolves.toMatchObject({ ok: true, reservation: { name: "Different_Flow" } });
    await expect(persistRecordingMessage(extension, "persist-different-after-release", {
      ...validRecording,
      name: "Different_Flow",
    })).resolves.toEqual({
      type: "persistRecordingResult",
      id: "persist-different-after-release",
      ok: true,
    });
  });

  it("clears retained retry state on exact expiry and removeSession cleanup", async () => {
    const expiryBase = mkdtempSync(join(tmpdir(), "mybrowser-recording-expiry-clear-"));
    tempDirs.push(expiryBase);
    const expiryRegistry = new RecordingRetryRegistry();
    const expirySetup = await setupReservedRecording(
      join(expiryBase, "recordings"), undefined, expiryRegistry,
    );
    expect(expiryRegistry.retain(
      "session-a", validRecording.name, JSON.stringify(validRecording),
    )).toBe(true);
    const now = Date.now();
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(now + 1_800_000);
    await expect(expirySetup.server.stateManager.hasRecordingReservation(
      "session-a", validRecording.name,
    )).resolves.toBe(false);
    dateNow.mockRestore();
    expect(expiryRegistry.count("session-a")).toBe(0);

    const removalBase = mkdtempSync(join(tmpdir(), "mybrowser-recording-session-clear-"));
    tempDirs.push(removalBase);
    const removalRegistry = new RecordingRetryRegistry();
    const removalSetup = await setupReservedRecording(
      join(removalBase, "recordings"), undefined, removalRegistry,
    );
    expect(removalRegistry.retain(
      "session-a", validRecording.name, JSON.stringify(validRecording),
    )).toBe(true);
    await removalSetup.server.stateManager.removeSession("session-a");
    expect(removalRegistry.count("session-a")).toBe(0);
  });

  it("does not retain a canonical payload after a failed persist and wrapper release", async () => {
    const base = mkdtempSync(join(tmpdir(), "mybrowser-recording-recovery-"));
    tempDirs.push(base);
    const recordingsDir = join(base, "recordings");
    let failWrite = true;
    const retryRegistry = new RecordingRetryRegistry();
    const { server, extension } = await setupReservedRecording(recordingsDir, {
      fchmodSync: (fd, mode) => {
        if (failWrite) throw new Error("injected recovery failure");
        fchmodSync(fd, mode);
      },
    }, retryRegistry);

    await expect(persistRecordingMessage(extension, "persist-recovery-first")).resolves.toEqual({
      type: "persistRecordingResult",
      id: "persist-recovery-first",
      ok: false,
      error: "persistence failed",
    });
    await expect(server.stateManager.releaseRecordingReservation("session-a", validRecording.name))
      .resolves.toBe(true);
    expect(retryRegistry.count("session-a")).toBe(0);
    failWrite = false;

    await expect(persistRecordingMessage(extension, "persist-recovery-changed", {
      ...validRecording,
      url: "https://different.test/",
    })).resolves.toEqual({
      type: "persistRecordingResult",
      id: "persist-recovery-changed",
      ok: false,
      error: "reservation unavailable",
    });
    await expect(persistRecordingMessage(extension, "persist-recovery-retry")).resolves.toEqual({
      type: "persistRecordingResult",
      id: "persist-recovery-retry",
      ok: false,
      error: "reservation unavailable",
    });
    expect(existsSync(join(recordingsDir, "Checkout_Flow.json"))).toBe(false);
  });

  it("does not acknowledge false live release and retries only an identical artifact", async () => {
    const base = mkdtempSync(join(tmpdir(), "mybrowser-recording-release-live-"));
    tempDirs.push(base);
    const recordingsDir = join(base, "recordings");
    const retryRegistry = new RecordingRetryRegistry();
    let failExistingDescriptor = false;
    const { server, extension } = await setupReservedRecording(recordingsDir, {
      fstatSync: ((fd: number) => {
        if (failExistingDescriptor) throw new Error("generic descriptor failure");
        return fstatSync(fd);
      }) as typeof fstatSync,
    }, retryRegistry);
    const releaseOriginal = server.stateManager.releaseRecordingReservation.bind(server.stateManager);
    const release = vi.spyOn(server.stateManager, "releaseRecordingReservation")
      .mockResolvedValueOnce(false)
      .mockImplementation(releaseOriginal);

    await expect(persistRecordingMessage(extension, "persist-live-false")).resolves.toEqual({
      type: "persistRecordingResult",
      id: "persist-live-false",
      ok: false,
      error: "persistence failed",
    });
    expect(retryRegistry.count("session-a")).toBe(1);
    const filePath = join(recordingsDir, "Checkout_Flow.json");
    const original = readFileSync(filePath, "utf8");
    failExistingDescriptor = true;
    await expect(persistRecordingMessage(extension, "persist-identical-descriptor-failure"))
      .resolves.toEqual({
        type: "persistRecordingResult",
        id: "persist-identical-descriptor-failure",
        ok: false,
        error: "persistence failed",
      });
    expect(retryRegistry.count("session-a")).toBe(1);
    await expect(persistRecordingMessage(extension, "persist-different", {
      ...validRecording,
      url: "https://different.test/",
    })).resolves.toEqual({
      type: "persistRecordingResult",
      id: "persist-different",
      ok: false,
      error: "persistence failed",
    });
    expect(readFileSync(filePath, "utf8")).toBe(original);
    expect(release).toHaveBeenCalledTimes(1);
    expect(retryRegistry.count("session-a")).toBe(1);

    failExistingDescriptor = false;
    await expect(server.stateManager.releaseRecordingReservation("session-a", validRecording.name))
      .resolves.toBe(true);
    expect(retryRegistry.count("session-a")).toBe(0);
  });

  it("acknowledges false release only after confirming the reservation expired", async () => {
    const base = mkdtempSync(join(tmpdir(), "mybrowser-recording-release-expired-"));
    tempDirs.push(base);
    const recordingsDir = join(base, "recordings");
    const { server, extension } = await setupReservedRecording(recordingsDir);
    const release = vi.spyOn(server.stateManager, "releaseRecordingReservation")
      .mockResolvedValue(false);
    const has = vi.spyOn(server.stateManager, "hasRecordingReservation")
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    await expect(persistRecordingMessage(extension, "persist-expired")).resolves.toEqual({
      type: "persistRecordingResult",
      id: "persist-expired",
      ok: true,
    });
    expect(release).toHaveBeenCalledTimes(1);
    expect(has).toHaveBeenCalledTimes(2);

    release.mockRestore();
    has.mockRestore();
    await server.stateManager.releaseRecordingReservation("session-a", validRecording.name);
  });

  it("returns a redacted failure when reservation release rejects after persistence", async () => {
    const base = mkdtempSync(join(tmpdir(), "mybrowser-recording-release-reject-"));
    tempDirs.push(base);
    const recordingsDir = join(base, "recordings");
    const retryRegistry = new RecordingRetryRegistry();
    const { server, extension } = await setupReservedRecording(
      recordingsDir, undefined, retryRegistry,
    );
    const release = vi.spyOn(server.stateManager, "releaseRecordingReservation")
      .mockRejectedValue(new Error("state unavailable"));

    await expect(persistRecordingMessage(extension, "persist-release-reject")).resolves.toEqual({
      type: "persistRecordingResult",
      id: "persist-release-reject",
      ok: false,
      error: "persistence failed",
    });
    expect(existsSync(join(recordingsDir, "Checkout_Flow.json"))).toBe(true);
    expect(retryRegistry.count("session-a")).toBe(1);
    await expect(persistRecordingMessage(extension, "persist-release-reject-different", {
      ...validRecording,
      url: "https://different.test/",
    })).resolves.toEqual({
      type: "persistRecordingResult",
      id: "persist-release-reject-different",
      ok: false,
      error: "persistence failed",
    });
    expect(retryRegistry.count("session-a")).toBe(1);

    release.mockRestore();
    await expect(server.stateManager.hasRecordingReservation("session-a", validRecording.name))
      .resolves.toBe(true);
    await server.stateManager.releaseRecordingReservation("session-a", validRecording.name);
    expect(retryRegistry.count("session-a")).toBe(0);
  });

  it("returns a redacted correlated error for the wrong live owner without writing", async () => {
    const base = mkdtempSync(join(tmpdir(), "mybrowser-recording-owner-"));
    tempDirs.push(base);
    const recordingsDir = join(base, "recordings");
    const server = await startHub(recordingsDir);
    const extension = await connect(server);
    await authenticate(extension, "extension");
    const owner = await connect(server);
    await authenticate(owner, "client");
    await callHubRpc(owner, "register-owner", "registerSession", { sessionId: "session-a" });
    await callHubRpc(owner, "reserve-owner", "reserveRecording", {
      name: validRecording.name,
      leaseMs: 1_800_000,
    });
    const other = await connect(server);
    await authenticate(other, "client");
    await callHubRpc(other, "register-other", "registerSession", { sessionId: "session-b" });

    const response = waitForMessage(extension);
    extension.send(JSON.stringify({
      type: "persistRecording",
      id: "persist-wrong-owner",
      sessionId: "session-b",
      payload: validRecording,
    }));

    await expect(response).resolves.toEqual({
      type: "persistRecordingResult",
      id: "persist-wrong-owner",
      ok: false,
      error: "reservation unavailable",
    });
    expect(() => statSync(recordingsDir)).toThrow();
    await expect(server.stateManager.hasRecordingReservation("session-a", validRecording.name))
      .resolves.toBe(true);
  });

  it.each(["renewRecordingReservation", "persistRecording"])(
    "consumes client-role %s attempts before generic tool proxying",
    async (type) => {
      const server = await startHub();
      const extension = await connect(server);
      await authenticate(extension, "extension");
      const forwarded: Record<string, unknown>[] = [];
      extension.on("message", (data) => {
        const message = JSON.parse(data.toString()) as Record<string, unknown>;
        forwarded.push(message);
        extension.send(JSON.stringify({
          type: "messageResponse",
          payload: { requestId: message.id, result: { proxied: true } },
        }));
      });
      const client = await connect(server);
      await authenticate(client, "client");
      await callHubRpc(client, "register-client", "registerSession", { sessionId: "session-a" });

      const response = waitForMessage(client);
      client.send(JSON.stringify({
        type,
        id: `client-${type}`,
        sessionId: "session-a",
        name: "demo",
        payload: validRecording,
      }));

      await expect(response).resolves.toEqual({
        type: `${type}Result`,
        id: `client-${type}`,
        ok: false,
        error: "not authorized",
      });
      expect(forwarded).toEqual([]);
    },
  );

  it("rejects blank extension correlation, session, and name fields without writing", async () => {
    const base = mkdtempSync(join(tmpdir(), "mybrowser-recording-invalid-message-"));
    tempDirs.push(base);
    const recordingsDir = join(base, "recordings");
    const server = await startHub(recordingsDir);
    const extension = await connect(server);
    await authenticate(extension, "extension");

    const response = waitForMessage(extension);
    extension.send(JSON.stringify({
      type: "persistRecording",
      id: "invalid-persist",
      sessionId: "   ",
      payload: { ...validRecording, name: "" },
    }));

    await expect(response).resolves.toEqual({
      type: "persistRecordingResult",
      id: "invalid-persist",
      ok: false,
      error: "invalid request",
    });
    expect(() => statSync(recordingsDir)).toThrow();
  });
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

  it("retries the connection when session registration after reconnect fails", async () => {
    let firstConnection: WebSocket | undefined;
    let connectionCount = 0;
    let resolveRecovered!: () => void;
    const recovered = new Promise<void>((resolve) => { resolveRecovered = resolve; });
    const port = await startFakeHub((ws) => {
      connectionCount += 1;
      if (connectionCount === 1) firstConnection = ws;
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
      clientReconnectDelayMs: 1,
    });
    servers.push(result);
    let registrations = 0;
    result.onReconnect?.(async () => {
      registrations += 1;
      if (registrations === 1) throw new Error("SESSION_IDENTITY_MISMATCH");
      resolveRecovered();
    });

    firstConnection!.close();

    await expect(recovered).resolves.toBeUndefined();
    expect(registrations).toBe(2);
    expect(connectionCount).toBe(3);
  });
});

describe("ordinary local extension authentication", () => {
  const extensionOrigin = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

  async function connectFromOrigin(
    server: WsServerResult,
    origin: string,
  ): Promise<WebSocket> {
    const ws = new WebSocket(`ws://127.0.0.1:${server.boundPort}`, {
      headers: { Origin: origin },
    });
    sockets.push(ws);
    await waitForOpen(ws);
    return ws;
  }

  function sendBlankAuth(ws: WebSocket, role: "client" | "extension"): void {
    ws.send(JSON.stringify({
      type: "auth",
      token: "",
      role,
      protocolVersion: PROTOCOL_VERSION,
    }));
  }

  it("accepts a tokenless extension from loopback in ordinary mode", async () => {
    const server = await startHub(undefined, undefined, undefined, {
      allowLocalExtensionWithoutToken: true,
    });
    const extension = await connectFromOrigin(server, extensionOrigin);
    const response = waitForMessage(extension);

    sendBlankAuth(extension, "extension");

    await expect(response).resolves.toMatchObject({
      type: "auth",
      status: "ok",
      protocolVersion: PROTOCOL_VERSION,
    });
  });

  it.each([
    ["ordinary website", "https://example.test", "extension"],
    ["MCP client", extensionOrigin, "client"],
  ] as const)("rejects tokenless access from an %s", async (_name, origin, role) => {
    const server = await startHub(undefined, undefined, undefined, {
      allowLocalExtensionWithoutToken: true,
    });
    const socket = await connectFromOrigin(server, origin);
    const closed = waitForClose(socket);

    sendBlankAuth(socket, role);

    await expect(closed).resolves.toMatchObject({ code: WS_CLOSE.unauthorized });
  });

  it("keeps explicit standalone hubs token-protected", async () => {
    const server = await startHub(undefined, undefined, undefined, {
      allowLocalExtensionWithoutToken: true,
      requireHub: true,
    });
    const extension = await connectFromOrigin(server, extensionOrigin);
    const closed = waitForClose(extension);

    sendBlankAuth(extension, "extension");

    await expect(closed).resolves.toMatchObject({ code: WS_CLOSE.unauthorized });
  });

  it("keeps wildcard listeners token-protected", async () => {
    const server = await createWebSocketServer({
      host: "0.0.0.0",
      port: 0,
      token: TOKEN,
      context: new Context(),
      allowLocalExtensionWithoutToken: true,
    } as WsServerOptions);
    servers.push(server);
    const extension = await connectFromOrigin(server, extensionOrigin);
    const closed = waitForClose(extension);

    sendBlankAuth(extension, "extension");

    await expect(closed).resolves.toMatchObject({ code: WS_CLOSE.unauthorized });
  });
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

  it("rejects invalid v2 session IDs without binding the socket", async () => {
    const server = await startHub();
    const client = await connect(server);
    await authenticate(client, "client");

    for (const [index, sessionId] of ["", " ", "has space", "has:colon", "x".repeat(129)].entries()) {
      const id = `rpc-invalid-${index}`;
      await expect(callHubRpc(client, id, "registerSession", { sessionId })).resolves.toEqual({
        type: "hub_rpc_result",
        id,
        error: "INVALID_SESSION_ID",
      });
    }
    await expect(callHubRpc(client, "rpc-valid", "registerSession", { sessionId: "s1" }))
      .resolves.toEqual({
        type: "hub_rpc_result",
        id: "rpc-valid",
        result: { ok: true },
      });
  });

  it.each(["a", "x".repeat(128), "550e8400-e29b-41d4-a716-446655440000"])(
    "registers valid v2 session ID %j",
    async (sessionId) => {
      const server = await startHub();
      const client = await connect(server);
      await authenticate(client, "client");
      await expect(callHubRpc(client, "rpc-valid-edge", "registerSession", { sessionId }))
        .resolves.toEqual({
          type: "hub_rpc_result",
          id: "rpc-valid-edge",
          result: { ok: true },
        });
    },
  );

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

describe("real loopback session topology", () => {
  it("returns only finalized sessions reported by the authenticating extension", async () => {
    const server = await startHub(undefined, undefined, undefined, { sessionReconnectGraceMs: 1 });
    const client = await connect(server);
    await authenticate(client, "client");
    await callHubRpc(client, "register", "registerSession", { sessionId: "session-finalized" });
    client.close();
    await vi.waitFor(() => expect(server.finalizedSessionCount()).toBe(1));

    const extension = await connect(server);
    await expect(authenticate(extension, "extension", {
      temporaryTabSessionIds: ["session-live", "session-finalized"],
    })).resolves.toMatchObject({
      status: "ok",
      finalizedSessionIds: ["session-finalized"],
    });
  });

  it("routes only approved tab-lifecycle requests to the explicitly named browser", async () => {
    const server = await startHub();
    const extensionA = await connect(server);
    const browserA = (await authenticate(extensionA, "extension")).browserId as string;
    const extensionB = await connect(server);
    const browserB = (await authenticate(extensionB, "extension")).browserId as string;
    const inboxA = createMessageInbox(extensionA);
    const inboxB = createMessageInbox(extensionB);
    const client = await connect(server);
    await authenticate(client, "client");
    await callHubRpc(client, "register", "registerSession", { sessionId: "session-a" });
    const clientInbox = createMessageInbox(client);

    client.send(JSON.stringify({
      id: "cleanup-a",
      type: "cleanup_session_tabs",
      payload: { sessionId: "spoofed", raw: "CANARY" },
      targetBrowserId: browserA,
    }));
    const forwardedA = await inboxA.next();
    expect(forwardedA).toMatchObject({
      type: "cleanup_session_tabs",
      payload: {},
      sessionId: "session-a",
    });
    expect(inboxB.all).toEqual([]);
    extensionA.send(JSON.stringify({
      type: "messageResponse",
      payload: { requestId: forwardedA.id, result: { closed: 1 } },
    }));
    await expect(clientInbox.next()).resolves.toMatchObject({
      payload: { requestId: "cleanup-a", result: { closed: 1 } },
    });

    client.send(JSON.stringify({
      id: "keep-b",
      type: "keep_tab",
      payload: { tabId: 9, raw: "CANARY" },
      targetBrowserId: browserB,
    }));
    const forwardedB = await inboxB.next();
    expect(forwardedB).toMatchObject({
      type: "keep_tab",
      payload: { tabId: 9 },
      sessionId: "session-a",
    });
    expect(inboxA.all).toEqual([]);

    client.send(JSON.stringify({
      id: "invalid-keep",
      type: "keep_tab",
      payload: { tabId: 0 },
      targetBrowserId: browserB,
    }));
    await expect(clientInbox.next()).resolves.toEqual({
      type: "messageResponse",
      payload: { requestId: "invalid-keep", error: "INVALID_TOOL_PAYLOAD" },
    });
    expect(inboxB.all).toEqual([]);
  });

  it("preserves valid trace correlation through hub rewrites without trusting it for routing", async () => {
    const server = await startHub();
    const extension = await connect(server);
    const extensionAuth = await authenticate(extension, "extension");
    const browserId = extensionAuth.browserId as string;
    const extensionInbox = createMessageInbox(extension);
    const clientA = await connect(server);
    const clientB = await connect(server);
    await authenticate(clientA, "client");
    await authenticate(clientB, "client");
    await callHubRpc(clientA, "register-trace-a", "registerSession", { sessionId: "trace-session-a" });
    await callHubRpc(clientB, "register-trace-b", "registerSession", { sessionId: "trace-session-b" });
    await callHubRpc(clientA, "select-trace-a", "selectBrowser", { browserId });
    await callHubRpc(clientB, "select-trace-b", "selectBrowser", { browserId });
    const clientAInbox = createMessageInbox(clientA);
    const clientBInbox = createMessageInbox(clientB);
    const collidingTrace = {
      schemaVersion: 1,
      traceId: "trace_collision_1234567890",
      rootCallId: "root_collision_1234567890",
      transportSpanId: "span_collision_1234567890",
    };

    clientA.send(JSON.stringify({
      id: "trace-request-a",
      type: "browser_click",
      payload: { client: "a" },
      sessionId: "trace-session-b",
      targetBrowserId: "spoofed-browser",
      timeoutMs: 30_000,
      trace: collidingTrace,
    }));
    clientB.send(JSON.stringify({
      id: "trace-request-b",
      type: "browser_click",
      payload: { client: "b" },
      sessionId: "trace-session-a",
      targetBrowserId: "spoofed-browser",
      timeoutMs: 30_000,
      trace: collidingTrace,
    }));

    const forwarded = [await extensionInbox.next(), await extensionInbox.next()];
    const forwardedA = forwarded.find((message) => message.sessionId === "trace-session-a")!;
    const forwardedB = forwarded.find((message) => message.sessionId === "trace-session-b")!;
    expect(forwardedA).toMatchObject({
      type: "browser_click",
      payload: { client: "a" },
      sessionId: "trace-session-a",
      trace: collidingTrace,
    });
    expect(forwardedB).toMatchObject({
      type: "browser_click",
      payload: { client: "b" },
      sessionId: "trace-session-b",
      trace: collidingTrace,
    });
    expect(forwardedA).not.toHaveProperty("targetBrowserId");
    expect(forwardedB).not.toHaveProperty("targetBrowserId");
    expect(forwardedA.id).not.toBe(forwardedB.id);

    const validResponseTelemetry = {
      schemaVersion: 1,
      traceId: collidingTrace.traceId,
      extensionRequestId: forwardedB.id,
      queueKind: "tab",
      stateChanged: false,
    };
    const malformedResponseTelemetry = {
      raw: "RAW_RESPONSE_TELEMETRY_CANARY",
      unknown: { nested: true },
    };
    extension.send(JSON.stringify({
      type: "messageResponse",
      payload: {
        requestId: forwardedB.id,
        result: "result-b",
        telemetry: validResponseTelemetry,
      },
    }));
    await expect(clientBInbox.next()).resolves.toEqual({
      type: "messageResponse",
      payload: {
        requestId: "trace-request-b",
        result: "result-b",
        telemetry: validResponseTelemetry,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(clientAInbox.all).toEqual([]);
    extension.send(JSON.stringify({
      type: "messageResponse",
      payload: {
        requestId: forwardedA.id,
        result: "result-a",
        telemetry: malformedResponseTelemetry,
      },
    }));
    await expect(clientAInbox.next()).resolves.toEqual({
      type: "messageResponse",
      payload: {
        requestId: "trace-request-a",
        result: "result-a",
        telemetry: malformedResponseTelemetry,
      },
    });

    const malformedTrace = {
      ...collidingTrace,
      traceId: "x".repeat(65),
      raw: "RAW_REQUEST_TRACE_CANARY",
    };
    clientA.send(JSON.stringify({
      id: "malformed-trace-request",
      type: "browser_click",
      payload: { client: "a" },
      timeoutMs: 30_000,
      trace: malformedTrace,
    }));
    const malformedForward = await extensionInbox.next();
    expect(malformedForward).not.toHaveProperty("trace");
    expect(JSON.stringify(malformedForward)).not.toContain("RAW_REQUEST_TRACE_CANARY");
    extension.send(JSON.stringify({
      type: "messageResponse",
      payload: { requestId: malformedForward.id, result: true },
    }));
    await expect(clientAInbox.next()).resolves.toMatchObject({
      payload: { requestId: "malformed-trace-request", result: true },
    });

    extension.send(JSON.stringify({
      id: "extension-forbidden-trace",
      type: "browser_click",
      payload: {},
      trace: collidingTrace,
    }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(extensionInbox.all).toEqual([]);
    expect(JSON.stringify(getRecentIssues(100))).not.toContain("RAW_REQUEST_TRACE_CANARY");
    expect(JSON.stringify(getRecentIssues(100))).not.toContain("RAW_RESPONSE_TELEMETRY_CANARY");
  });

  it.each(["client", "extension"] as const)(
    "rejects old and unversioned %s peers",
    async (role) => {
      const server = await startHub();
      for (const protocolVersion of [undefined, PROTOCOL_VERSION - 1]) {
        const ws = await connect(server);
        const closed = waitForClose(ws);
        ws.send(JSON.stringify({
          type: "auth",
          token: TOKEN,
          role,
          ...(protocolVersion === undefined ? {} : { protocolVersion }),
        }));
        expect((await closed).code).toBe(WS_CLOSE.versionMismatch);
      }
    },
  );

  it("isolates two clients through reconnect and performs one final cleanup", async () => {
    const base = mkdtempSync(join(tmpdir(), "mybrowser-topology-"));
    tempDirs.push(base);
    const retryRegistry = new RecordingRetryRegistry();
    const server = await startHub(
      join(base, "recordings"),
      undefined,
      retryRegistry,
      { sessionReconnectGraceMs: 40 },
    );
    const extension = await connect(server);
    const extensionAuth = await authenticate(extension, "extension");
    const browserId = extensionAuth.browserId as string;
    const extensionInbox = createMessageInbox(extension);
    const clientA = await connect(server);
    const clientB = await connect(server);
    await authenticate(clientA, "client");
    await authenticate(clientB, "client");

    await expect(callHubRpc(clientA, "invalid", "registerSession", { sessionId: "bad id" }))
      .resolves.toMatchObject({ error: "INVALID_SESSION_ID" });
    await expect(callHubRpc(clientA, "register-a", "registerSession", { sessionId: "session-a" }))
      .resolves.toMatchObject({ result: { ok: true } });
    await expect(callHubRpc(clientB, "duplicate-a", "registerSession", { sessionId: "session-a" }))
      .resolves.toMatchObject({ error: "SESSION_IDENTITY_MISMATCH" });
    await expect(callHubRpc(clientA, "switch-a", "registerSession", { sessionId: "session-b" }))
      .resolves.toMatchObject({ error: "SESSION_IDENTITY_MISMATCH" });

    const unregisteredProxy = waitForMessage(clientB);
    clientB.send(JSON.stringify({ id: "unregistered", type: "browser_click", payload: {} }));
    await expect(unregisteredProxy).resolves.toEqual({
      type: "messageResponse",
      payload: { requestId: "unregistered", error: "SESSION_NOT_REGISTERED" },
    });
    await expect(callHubRpc(clientB, "register-b", "registerSession", { sessionId: "session-b" }))
      .resolves.toMatchObject({ result: { ok: true } });

    const forbiddenPersistence = waitForMessage(clientA);
    clientA.send(JSON.stringify({
      type: "persistRecording",
      id: "client-persist",
      sessionId: "session-a",
      payload: validRecording,
    }));
    await expect(forbiddenPersistence).resolves.toEqual({
      type: "persistRecordingResult",
      id: "client-persist",
      ok: false,
      error: "not authorized",
    });

    await callHubRpc(clientA, "select-a", "selectBrowser", { browserId });
    await callHubRpc(clientB, "select-b", "selectBrowser", { browserId });
    await callHubRpc(clientA, "claim-a", "claimTab", { tabKey: `${browserId}:11` });
    await callHubRpc(clientB, "claim-b", "claimTab", { tabKey: `${browserId}:22` });
    await callHubRpc(clientA, "lock-a", "acquireLock", {
      name: "session-a-lock",
      timeoutMs: 100,
      ttlMs: 10_000,
    });
    const handlerRegistration = await callHubRpc(clientA, "handler-a", "registerEventHandler", {
      browserId,
      event: "dialog",
      action: "dismiss",
    });
    const registeredHandler = handlerRegistration.result as Record<string, unknown>;
    const clientAInbox = createMessageInbox(clientA);
    const clientBInbox = createMessageInbox(clientB);
    clientA.send(JSON.stringify({
      id: "shared-request",
      type: "browser_click",
      payload: { client: "a" },
      sessionId: "session-b",
      targetBrowserId: "spoofed-browser",
    }));
    clientB.send(JSON.stringify({
      id: "shared-request",
      type: "browser_click",
      payload: { client: "b" },
      sessionId: "session-a",
      targetBrowserId: "spoofed-browser",
    }));
    const forwarded = [await extensionInbox.next(), await extensionInbox.next()];
    const forwardedA = forwarded.find((message) => message.sessionId === "session-a")!;
    const forwardedB = forwarded.find((message) => message.sessionId === "session-b")!;
    expect(forwardedA).toMatchObject({
      type: "browser_click",
      payload: { client: "a" },
      sessionId: "session-a",
    });
    expect(forwardedB).toMatchObject({
      type: "browser_click",
      payload: { client: "b" },
      sessionId: "session-b",
    });
    expect(forwardedA).not.toHaveProperty("targetBrowserId");
    expect(forwardedB).not.toHaveProperty("targetBrowserId");
    expect(forwardedA.id).not.toBe(forwardedB.id);

    extension.send(JSON.stringify({
      type: "messageResponse",
      payload: { requestId: forwardedA.id, result: "result-a" },
    }));
    await expect(clientAInbox.next()).resolves.toEqual({
      type: "messageResponse",
      payload: { requestId: "shared-request", result: "result-a" },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(clientBInbox.all).toEqual([]);
    extension.send(JSON.stringify({
      type: "messageResponse",
      payload: { requestId: forwardedB.id, result: "result-b" },
    }));
    await expect(clientBInbox.next()).resolves.toEqual({
      type: "messageResponse",
      payload: { requestId: "shared-request", result: "result-b" },
    });

    clientA.send(JSON.stringify({
      id: "internal-route",
      type: "browser_register_handler",
      payload: { handler: registeredHandler },
      targetBrowserId: browserId,
    }));
    const internalForward = await extensionInbox.next();
    expect(internalForward).toMatchObject({
      type: "browser_register_handler",
      sessionId: "session-a",
    });
    extension.send(JSON.stringify({
      type: "messageResponse",
      payload: { requestId: internalForward.id, result: { ok: true } },
    }));
    await expect(clientAInbox.next()).resolves.toMatchObject({
      payload: { requestId: "internal-route", result: { ok: true } },
    });

    const firstClose = waitForClose(clientA);
    clientA.close();
    await firstClose;
    const reclaimedA = await connect(server);
    await authenticate(reclaimedA, "client");
    await expect(callHubRpc(reclaimedA, "reclaim-a", "registerSession", { sessionId: "session-a" }))
      .resolves.toMatchObject({ result: { ok: true } });
    await new Promise((resolve) => setTimeout(resolve, 70));
    expect((await server.stateManager.listSessions()).map((session) => session.id))
      .toContain("session-a");
    expect(extensionInbox.all.filter((message) => message.type === "session_closed"))
      .toEqual([]);

    await callHubRpc(reclaimedA, "reserve-queue", "reserveRecording", {
      name: validRecording.name,
      leaseMs: 1_800_000,
    });
    const persistCheckStarted = deferred<void>();
    const persistCheck = deferred<boolean>();
    const reservationSpy = vi.spyOn(server.stateManager, "hasRecordingReservation")
      .mockImplementation(async () => {
        persistCheckStarted.resolve();
        return persistCheck.promise;
      });
    const releaseSpy = vi.spyOn(server.stateManager, "releaseRecordingReservation")
      .mockRejectedValueOnce(new Error("release failed"));
    extension.send(JSON.stringify({
      type: "persistRecording",
      id: "queued-persist",
      sessionId: "session-a",
      payload: validRecording,
    }));
    await persistCheckStarted.promise;
    const persistenceCount = (server as WsServerResult & {
      pendingRecordingPersistCount: (sessionId: string) => number;
    }).pendingRecordingPersistCount;
    expect(persistenceCount("session-a")).toBe(1);

    const reclaimedClose = waitForClose(reclaimedA);
    reclaimedA.close();
    await reclaimedClose;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(extensionInbox.all.filter((message) => message.type === "session_closed"))
      .toEqual([]);
    persistCheck.resolve(true);
    await expect(extensionInbox.next()).resolves.toMatchObject({
      type: "persistRecordingResult",
      id: "queued-persist",
      ok: false,
      error: "persistence failed",
    });
    reservationSpy.mockRestore();
    releaseSpy.mockRestore();
    await expect(extensionInbox.next()).resolves.toEqual({
      id: expect.any(String),
      type: "session_closed",
      payload: { sessionId: "session-a" },
    });
    await new Promise((resolve) => setTimeout(resolve, 70));

    expect(persistenceCount("session-a")).toBe(0);
    expect(retryRegistry.count("session-a")).toBe(0);
    expect((await server.stateManager.listSessions()).map((session) => session.id))
      .toEqual(["session-b"]);
    await expect(server.stateManager.getSessionBrowser("session-a")).resolves.toBeUndefined();
    await expect(server.stateManager.getTabOwner(`${browserId}:11`)).resolves.toBeUndefined();
    await expect(server.stateManager.getTabOwner(`${browserId}:22`)).resolves.toBe("session-b");
    await expect(server.stateManager.listEventHandlers("session-a")).resolves.toEqual([]);
    await expect(server.stateManager.hasRecordingReservation("session-a", validRecording.name))
      .resolves.toBe(false);
    expect((await server.stateManager.listLocks()).map((lock) => lock.name))
      .not.toContain("session-a-lock");
    expect(extensionInbox.all.filter((message) => message.type === "session_closed"))
      .toEqual([]);
    expect(extensionInbox.all.filter((message) => message.type === "browser_unregister_handler"))
      .toEqual([]);

    const extensionClosed = waitForClose(extension);
    extension.send(JSON.stringify({
      type: "hub_rpc",
      id: "extension-rpc",
      method: "listSessions",
    }));
    await expect(extensionInbox.next()).resolves.toEqual({
      type: "hub_rpc_result",
      id: "extension-rpc",
      error: "AUTH_ROLE_VIOLATION",
    });
    expect((await extensionClosed).code).toBe(WS_CLOSE.forbiddenRole);
  }, 5_000);

  it("cancels a stale finalizer when the session reconnects during persistence drain", async () => {
    const recordingsDir = mkdtempSync(join(tmpdir(), "mybrowser-drain-reconnect-"));
    tempDirs.push(recordingsDir);
    const server = await startHub(
      recordingsDir,
      undefined,
      undefined,
      { sessionReconnectGraceMs: 20 },
    );
    const extension = await connect(server);
    await authenticate(extension, "extension");
    const extensionInbox = createMessageInbox(extension);
    const client = await connect(server);
    await authenticate(client, "client");
    await callHubRpc(client, "register-a", "registerSession", { sessionId: "session-a" });
    await callHubRpc(client, "reserve-a", "reserveRecording", {
      name: validRecording.name,
      leaseMs: 1_800_000,
    });

    const persistStarted = deferred<void>();
    const allowPersist = deferred<boolean>();
    const reservationSpy = vi.spyOn(server.stateManager, "hasRecordingReservation")
      .mockImplementation(async () => {
        persistStarted.resolve();
        return allowPersist.promise;
      });
    extension.send(JSON.stringify({
      type: "persistRecording",
      id: "persist-during-reconnect",
      sessionId: "session-a",
      payload: validRecording,
    }));
    await persistStarted.promise;

    const closed = waitForClose(client);
    client.close();
    await closed;
    await new Promise((resolve) => setTimeout(resolve, 35));

    const reclaimed = await connect(server);
    await authenticate(reclaimed, "client");
    await expect(callHubRpc(
      reclaimed,
      "reclaim-a",
      "registerSession",
      { sessionId: "session-a" },
    )).resolves.toMatchObject({ result: { ok: true } });

    allowPersist.resolve(true);
    await expect(extensionInbox.next()).resolves.toMatchObject({
      type: "persistRecordingResult",
      id: "persist-during-reconnect",
    });
    reservationSpy.mockRestore();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect((await server.stateManager.listSessions()).map(({ id }) => id))
      .toContain("session-a");
    expect(extensionInbox.all.filter(({ type }) => type === "session_closed"))
      .toEqual([]);
  }, 5_000);

  it("lets the current generation finalize while a stale generation drains", async () => {
    const recordingsDir = mkdtempSync(join(tmpdir(), "mybrowser-generation-finalizers-"));
    tempDirs.push(recordingsDir);
    const server = await startHub(
      recordingsDir,
      undefined,
      undefined,
      { sessionReconnectGraceMs: 20 },
    );
    const extension = await connect(server);
    await authenticate(extension, "extension");
    const sessionClosed = waitForMatchingMessage(
      extension,
      ({ type }) => type === "session_closed",
      2_000,
    );
    const first = await connect(server);
    await authenticate(first, "client");
    await callHubRpc(first, "register-first", "registerSession", { sessionId: "session-a" });
    await callHubRpc(first, "reserve-a", "reserveRecording", {
      name: validRecording.name,
      leaseMs: 1_800_000,
    });
    const persistStarted = deferred<void>();
    const allowPersist = deferred<boolean>();
    vi.spyOn(server.stateManager, "hasRecordingReservation")
      .mockImplementation(async () => {
        persistStarted.resolve();
        return allowPersist.promise;
      });
    extension.send(JSON.stringify({
      type: "persistRecording",
      id: "persist-generation-overlap",
      sessionId: "session-a",
      payload: validRecording,
    }));
    await persistStarted.promise;
    const firstClosed = waitForClose(first);
    first.close();
    await firstClosed;
    await new Promise((resolve) => setTimeout(resolve, 35));

    const current = await connect(server);
    await authenticate(current, "client");
    await expect(callHubRpc(current, "register-current", "registerSession", {
      sessionId: "session-a",
    })).resolves.toMatchObject({ result: { ok: true } });
    const unregister = callHubRpc(current, "unregister-current", "removeSession");
    await new Promise((resolve) => setTimeout(resolve, 10));
    allowPersist.resolve(true);

    await expect(unregister).resolves.toMatchObject({ result: { ok: true } });
    await expect(sessionClosed).resolves.toMatchObject({
      type: "session_closed",
      payload: { sessionId: "session-a" },
    });
    expect((await server.stateManager.listSessions()).map(({ id }) => id))
      .not.toContain("session-a");
  }, 5_000);

  it("retains an ID within grace and rejects it after finalization", async () => {
    // Keep enough wall-clock margin for parallel-suite event-loop contention without changing the invariant.
    const server = await startHub(undefined, undefined, undefined, {
      sessionReconnectGraceMs: 300,
      finalizedSessionTtlMs: 1_000,
    });
    const first = await connect(server);
    await authenticate(first, "client");
    await expect(callHubRpc(first, "register-first", "registerSession", {
      sessionId: "session-a",
    })).resolves.toMatchObject({ result: { ok: true } });

    const firstClosed = waitForClose(first);
    first.close();
    await firstClosed;
    await new Promise((resolve) => setTimeout(resolve, 10));

    const reclaimed = await connect(server);
    await authenticate(reclaimed, "client");
    await expect(callHubRpc(reclaimed, "register-reclaimed", "registerSession", {
      sessionId: "session-a",
    })).resolves.toMatchObject({ result: { ok: true } });

    const reclaimedClosed = waitForClose(reclaimed);
    reclaimed.close();
    await reclaimedClosed;
    await new Promise((resolve) => setTimeout(resolve, 350));

    const stale = await connect(server);
    await authenticate(stale, "client");
    await expect(callHubRpc(stale, "register-stale", "registerSession", {
      sessionId: "session-a",
    })).resolves.toEqual({
      type: "hub_rpc_result",
      id: "register-stale",
      error: "SESSION_FINALIZED",
    });
  });

  it("acknowledges a production-wire handler mirror before authoritative removal", async () => {
    const server = await startHub();
    const extension = await connect(server);
    const auth = await authenticate(extension, "extension");
    const browserId = auth.browserId as string;
    const { context, server: clientServer } = await startClientProcess(server, "session-a");
    const controls: Record<string, unknown>[] = [];
    let handlerWasAuthoritativeAtUnregister = false;
    extension.on("message", async (data) => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      if (typeof message.id !== "string" || !String(message.type).startsWith("browser_")) return;
      controls.push(message);
      if (message.type === "browser_unregister_handler") {
        const payload = message.payload as { handlerId?: string };
        handlerWasAuthoritativeAtUnregister = (await server.stateManager.listEventHandlers("session-a"))
          .some(({ id }) => id === payload.handlerId);
      }
      extension.send(JSON.stringify({
        type: "messageResponse",
        payload: { requestId: message.id, result: { ok: true } },
      }));
    });
    const { browserOn, browserOff } = createEventsTools(
      clientServer.stateManager,
      () => "session-a",
      async () => browserId,
    );

    await browserOn.handle(context, {
      event: "new_tab",
      action: "ignore",
      browserId,
    });
    const [handler] = await server.stateManager.listEventHandlers("session-a");
    const result = await browserOff.handle(context, { handlerId: handler!.id });

    expect(result).not.toHaveProperty("isError");
    expect(handlerWasAuthoritativeAtUnregister).toBe(true);
    expect(await server.stateManager.listEventHandlers("session-a")).toEqual([]);
    expect(controls.filter(({ type }) => type === "browser_unregister_handler"))
      .toHaveLength(1);
  });

  it("retains authoritative handler state when mirror unregister fails", async () => {
    const server = await startHub();
    const extension = await connect(server);
    const auth = await authenticate(extension, "extension");
    const browserId = auth.browserId as string;
    const { context, server: clientServer } = await startClientProcess(server, "session-a");
    extension.on("message", (data) => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      if (typeof message.id !== "string" || !String(message.type).startsWith("browser_")) return;
      extension.send(JSON.stringify({
        type: "messageResponse",
        payload: message.type === "browser_unregister_handler"
          ? { requestId: message.id, error: "internal transport detail" }
          : { requestId: message.id, result: { ok: true } },
      }));
    });
    const { browserOn, browserOff } = createEventsTools(
      clientServer.stateManager,
      () => "session-a",
      async () => browserId,
    );

    await browserOn.handle(context, {
      event: "new_tab",
      action: "ignore",
      browserId,
    });
    const [handler] = await server.stateManager.listEventHandlers("session-a");
    const result = await browserOff.handle(context, { handlerId: handler!.id });

    expect(result).toEqual({
      content: [{ type: "text", text: "EVENT_HANDLER_MIRROR_FAILED" }],
      isError: true,
    });
    expect((await server.stateManager.listEventHandlers("session-a")).map(({ id }) => id))
      .toEqual([handler!.id]);
  });

  it.each([
    ["negative", { ok: false }],
    ["malformed", { removed: 1 }],
  ])("keeps a handler when the extension returns a %s acknowledgement", async (_label, ack) => {
    const server = await startHub();
    const extension = await connect(server);
    const auth = await authenticate(extension, "extension");
    const browserId = auth.browserId as string;
    const { context, server: clientServer } = await startClientProcess(server, "session-a");
    extension.on("message", (data) => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      if (typeof message.id !== "string" || !String(message.type).startsWith("browser_")) return;
      extension.send(JSON.stringify({
        type: "messageResponse",
        payload: { requestId: message.id, result: ack },
      }));
    });
    const { browserOn, browserOff } = createEventsTools(
      clientServer.stateManager,
      () => "session-a",
      async () => browserId,
    );
    await browserOn.handle(context, { event: "new_tab", action: "ignore", browserId });
    const [handler] = await server.stateManager.listEventHandlers("session-a");

    const result = await browserOff.handle(context, { handlerId: handler!.id });

    expect(result).toEqual({
      content: [{ type: "text", text: "EVENT_HANDLER_MIRROR_FAILED" }],
      isError: true,
    });
    expect((await server.stateManager.listEventHandlers("session-a")).map(({ id }) => id))
      .toEqual([handler!.id]);
  });

  it("clears all handler mirrors through one acknowledged v2 control request", async () => {
    const server = await startHub();
    const extension = await connect(server);
    const auth = await authenticate(extension, "extension");
    const browserId = auth.browserId as string;
    const { context, server: clientServer } = await startClientProcess(server, "session-a");
    const controls: Record<string, unknown>[] = [];
    let authoritativeCountAtClear = 0;
    extension.on("message", async (data) => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      if (typeof message.id !== "string" || !String(message.type).startsWith("browser_")) return;
      controls.push(message);
      if (message.type === "browser_unregister_handler") {
        authoritativeCountAtClear = (await server.stateManager.listEventHandlers("session-a")).length;
      }
      extension.send(JSON.stringify({
        type: "messageResponse",
        payload: { requestId: message.id, result: { ok: true } },
      }));
    });
    const { browserOn, browserOff } = createEventsTools(
      clientServer.stateManager,
      () => "session-a",
      async () => browserId,
    );
    await browserOn.handle(context, { event: "new_tab", action: "ignore", browserId });
    await browserOn.handle(context, { event: "dialog", action: "dismiss", browserId });

    const result = await browserOff.handle(context, {});
    const unregisters = controls.filter(({ type }) => type === "browser_unregister_handler");

    expect(result).not.toHaveProperty("isError");
    expect(authoritativeCountAtClear).toBe(2);
    expect(unregisters).toHaveLength(1);
    expect(unregisters[0]).toMatchObject({
      type: "browser_unregister_handler",
      sessionId: "session-a",
      timeoutMs: 5_000,
      payload: { sessionId: "session-a" },
    });
    expect(unregisters[0]?.id).toEqual(expect.any(String));
    expect(await server.stateManager.listEventHandlers("session-a")).toEqual([]);
  });

  it("keeps every authoritative handler when a bulk mirror acknowledgement is malformed", async () => {
    const server = await startHub();
    const extension = await connect(server);
    const auth = await authenticate(extension, "extension");
    const browserId = auth.browserId as string;
    const { context, server: clientServer } = await startClientProcess(server, "session-a");
    extension.on("message", (data) => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      if (typeof message.id !== "string" || !String(message.type).startsWith("browser_")) return;
      extension.send(JSON.stringify({
        type: "messageResponse",
        payload: {
          requestId: message.id,
          result: message.type === "browser_unregister_handler" ? null : { ok: true },
        },
      }));
    });
    const { browserOn, browserOff } = createEventsTools(
      clientServer.stateManager,
      () => "session-a",
      async () => browserId,
    );
    await browserOn.handle(context, { event: "new_tab", action: "ignore", browserId });
    await browserOn.handle(context, { event: "dialog", action: "dismiss", browserId });
    const handlerIds = (await server.stateManager.listEventHandlers("session-a"))
      .map(({ id }) => id);

    const result = await browserOff.handle(context, {});

    expect(result).toEqual({
      content: [{ type: "text", text: "EVENT_HANDLER_MIRROR_FAILED" }],
      isError: true,
    });
    expect((await server.stateManager.listEventHandlers("session-a")).map(({ id }) => id))
      .toEqual(handlerIds);
  });

  it("keeps all bulk records when only one of multiple browsers positively acknowledges", async () => {
    const server = await startHub();
    const extensionA = await connect(server);
    const browserA = (await authenticate(extensionA, "extension")).browserId as string;
    const extensionB = await connect(server);
    const browserB = (await authenticate(extensionB, "extension")).browserId as string;
    for (const [extension, unregisterResult] of [
      [extensionA, { ok: true }],
      [extensionB, { ok: false }],
    ] as const) {
      extension.on("message", (data) => {
        const message = JSON.parse(data.toString()) as Record<string, unknown>;
        if (typeof message.id !== "string" || !String(message.type).startsWith("browser_")) return;
        extension.send(JSON.stringify({
          type: "messageResponse",
          payload: {
            requestId: message.id,
            result: message.type === "browser_unregister_handler"
              ? unregisterResult
              : { ok: true },
          },
        }));
      });
    }
    const { context, server: clientServer } = await startClientProcess(server, "session-a");
    const { browserOn, browserOff } = createEventsTools(
      clientServer.stateManager,
      () => "session-a",
      async () => browserA,
    );
    await browserOn.handle(context, { event: "new_tab", action: "ignore", browserId: browserA });
    await browserOn.handle(context, { event: "dialog", action: "dismiss", browserId: browserB });
    const handlerIds = (await server.stateManager.listEventHandlers("session-a"))
      .map(({ id }) => id);

    const result = await browserOff.handle(context, {});

    expect(result).toEqual({
      content: [{ type: "text", text: "EVENT_HANDLER_MIRROR_FAILED" }],
      isError: true,
    });
    expect((await server.stateManager.listEventHandlers("session-a")).map(({ id }) => id))
      .toEqual(handlerIds);
  });

  it("drains in-flight persistence before explicit client unregister", async () => {
    const recordingsDir = mkdtempSync(join(tmpdir(), "mybrowser-unregister-drain-"));
    tempDirs.push(recordingsDir);
    const server = await startHub(recordingsDir);
    const extension = await connect(server);
    await authenticate(extension, "extension");
    const extensionMessages = waitForMessages(extension, 2, 2_000);
    const client = await connect(server);
    await authenticate(client, "client");
    await callHubRpc(client, "register-a", "registerSession", { sessionId: "session-a" });
    await callHubRpc(client, "reserve-a", "reserveRecording", {
      name: validRecording.name,
      leaseMs: 1_800_000,
    });

    const persistStarted = deferred<void>();
    const allowPersist = deferred<boolean>();
    vi.spyOn(server.stateManager, "hasRecordingReservation")
      .mockImplementation(async () => {
        persistStarted.resolve();
        return allowPersist.promise;
      });
    extension.send(JSON.stringify({
      type: "persistRecording",
      id: "persist-before-unregister",
      sessionId: "session-a",
      payload: validRecording,
    }));
    await persistStarted.promise;

    let unregisterSettled = false;
    const unregister = callHubRpc(client, "unregister-a", "removeSession")
      .then((result) => {
        unregisterSettled = true;
        return result;
      });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(unregisterSettled).toBe(false);

    allowPersist.resolve(true);
    await expect(unregister).resolves.toMatchObject({ result: { ok: true } });
    const messages = await extensionMessages;
    expect(messages.map(({ type }) => type)).toEqual([
      "persistRecordingResult",
      "session_closed",
    ]);
    expect((await server.stateManager.listSessions()).map(({ id }) => id))
      .not.toContain("session-a");
    expect(server.pendingRecordingPersistCount("session-a")).toBe(0);
  }, 5_000);

  it("quiesces an already-entered async mutation before the final session snapshot", async () => {
    const server = await startHub();
    const client = await connect(server);
    await authenticate(client, "client");
    await callHubRpc(client, "register-a", "registerSession", { sessionId: "session-a" });

    const reserveEntered = deferred<void>();
    const allowReserve = deferred<void>();
    const originalReserve = server.stateManager.reserveRecording.bind(server.stateManager);
    vi.spyOn(server.stateManager, "reserveRecording")
      .mockImplementation(async (...args) => {
        reserveEntered.resolve();
        await allowReserve.promise;
        return originalReserve(...args);
      });
    const removeSession = vi.spyOn(server.stateManager, "removeSession");
    client.send(JSON.stringify({
      type: "hub_rpc",
      id: "reserve-entered",
      method: "reserveRecording",
      params: { name: validRecording.name, leaseMs: 1_800_000 },
    }));
    await reserveEntered.promise;

    const closing = server.close();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const finalizedBeforeMutationSettled = removeSession.mock.calls.length > 0;
    allowReserve.resolve();
    await closing;

    const internals = server.stateManager as unknown as {
      recordingReservations: Map<string, unknown>;
      recordingReservationTimers: Map<string, unknown>;
    };
    expect(finalizedBeforeMutationSettled).toBe(false);
    expect(internals.recordingReservations.size).toBe(0);
    expect(internals.recordingReservationTimers.size).toBe(0);
    expect(await server.stateManager.listSessions()).toEqual([]);
  }, 5_000);

  it("cancels long-lived waiters and pending proxies before shutdown quiescence", async () => {
    const server = await startHub();
    const extension = await connect(server);
    const auth = await authenticate(extension, "extension");
    const browserId = auth.browserId as string;
    const clientA = await connect(server);
    await authenticate(clientA, "client");
    await callHubRpc(clientA, "register-a", "registerSession", { sessionId: "session-a" });
    const clientB = await connect(server);
    await authenticate(clientB, "client");
    await callHubRpc(clientB, "register-b", "registerSession", { sessionId: "session-b" });
    await callHubRpc(clientB, "select-b", "selectBrowser", { browserId });
    await callHubRpc(clientA, "lock-owner", "acquireLock", {
      name: "shutdown-lock",
      timeoutMs: 60_000,
      ttlMs: 60_000,
    });

    const eventResponse = waitForMatchingMessage(
      clientB,
      ({ id }) => id === "event-wait",
      2_000,
    ).catch((error) => ({ transportError: String(error) }));
    clientB.send(JSON.stringify({
      type: "hub_rpc",
      id: "event-wait",
      method: "waitForEvent",
      params: { queueName: "shutdown-events", timeoutMs: 60_000 },
    }));
    const lockResponse = waitForMatchingMessage(
      clientB,
      ({ id }) => id === "lock-wait",
      2_000,
    ).catch((error) => ({ transportError: String(error) }));
    clientB.send(JSON.stringify({
      type: "hub_rpc",
      id: "lock-wait",
      method: "acquireLock",
      params: { name: "shutdown-lock", timeoutMs: 60_000, ttlMs: 60_000 },
    }));
    const proxyRequest = waitForMatchingMessage(
      extension,
      ({ type }) => type === "browser_click",
      2_000,
    );
    const proxyResponse = waitForMatchingMessage(
      clientB,
      ({ payload }) => (payload as { requestId?: string } | undefined)?.requestId === "proxy-wait",
      2_000,
    ).catch((error) => ({ transportError: String(error) }));
    clientB.send(JSON.stringify({
      type: "browser_click",
      id: "proxy-wait",
      payload: { tabId: 1 },
      timeoutMs: 60_000,
    }));
    await proxyRequest;
    const internals = server.stateManager as unknown as {
      lockWaiters: Map<string, unknown>;
      lockTtlTimers: Map<string, unknown>;
      eventWaiters: Map<string, unknown>;
    };
    await vi.waitFor(() => {
      expect(internals.eventWaiters.size).toBe(1);
      expect(internals.lockWaiters.size).toBe(1);
    });

    const closing = server.close();
    const shutdownResults = Promise.all([
      eventResponse,
      lockResponse,
      proxyResponse,
      closing.then(() => ({ closed: true })),
    ]);
    const resolvedWithoutCallerTimeouts = await Promise.race([
      shutdownResults.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 200)),
    ]);
    if (!resolvedWithoutCallerTimeouts) {
      await server.stateManager.pushEvent(
        "session-b",
        browserId,
        "new_tab",
        "shutdown-events",
        {},
      );
      await server.stateManager.releaseLock("session-a", "shutdown-lock");
    }
    const [eventResult, lockResult, proxyResult] = await shutdownResults;

    expect(resolvedWithoutCallerTimeouts).toBe(true);
    expect(eventResult).toMatchObject({ error: "SERVER_SHUTTING_DOWN" });
    expect(lockResult).toMatchObject({ error: "SERVER_SHUTTING_DOWN" });
    expect(proxyResult).toMatchObject({
      type: "messageResponse",
      payload: { requestId: "proxy-wait", error: "SERVER_SHUTTING_DOWN" },
    });
    expect(internals.eventWaiters.size).toBe(0);
    expect(internals.lockWaiters.size).toBe(0);
    expect(internals.lockTtlTimers.size).toBe(0);
    expect(await server.stateManager.listSessions()).toEqual([]);
    expect(await server.stateManager.listLocks()).toEqual([]);
  }, 5_000);

  it("rejects every admission while shutdown drains and clears all session resources", async () => {
    const recordingsDir = mkdtempSync(join(tmpdir(), "mybrowser-shutdown-quiescence-"));
    tempDirs.push(recordingsDir);
    const server = await startHub(recordingsDir);
    const extension = await connect(server);
    await authenticate(extension, "extension");
    extension.on("message", (data) => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      if (
        typeof message.id === "string"
        && ["browser_click", "browser_list_handlers"].includes(String(message.type))
      ) {
        extension.send(JSON.stringify({
          type: "messageResponse",
          payload: { requestId: message.id, result: { shouldNotRun: true } },
        }));
      }
    });
    const clientA = await connect(server);
    await authenticate(clientA, "client");
    await callHubRpc(clientA, "register-a", "registerSession", { sessionId: "session-a" });
    const clientB = await connect(server);
    await authenticate(clientB, "client");
    await callHubRpc(clientB, "register-b", "registerSession", { sessionId: "session-b" });
    await callHubRpc(clientA, "lock-a", "acquireLock", {
      name: "lock-a",
      timeoutMs: 100,
      ttlMs: 60_000,
    });
    await callHubRpc(clientB, "lock-b", "acquireLock", {
      name: "lock-b",
      timeoutMs: 100,
      ttlMs: 60_000,
    });
    await callHubRpc(clientB, "reserve-b", "reserveRecording", {
      name: validRecording.name,
      leaseMs: 1_800_000,
    });

    const persistEntered = deferred<void>();
    const allowPersist = deferred<boolean>();
    const hasReservation = vi.spyOn(server.stateManager, "hasRecordingReservation")
      .mockImplementation(async (sessionId, name) => {
        if (sessionId !== "session-b") return false;
        persistEntered.resolve();
        await allowPersist.promise;
        return name === validRecording.name;
      });
    extension.send(JSON.stringify({
      type: "persistRecording",
      id: "persist-b",
      sessionId: "session-b",
      payload: validRecording,
    }));
    await persistEntered.promise;

    const sessionAFinalized = deferred<void>();
    const originalRemoveSession = server.stateManager.removeSession.bind(server.stateManager);
    const removeSession = vi.spyOn(server.stateManager, "removeSession")
      .mockImplementation(async (sessionId) => {
        await originalRemoveSession(sessionId);
        if (sessionId === "session-a") sessionAFinalized.resolve();
      });
    const firstClose = server.close();
    const secondClose = server.close();
    expect(secondClose).toBe(firstClose);
    await sessionAFinalized.promise;

    const rpcDuringShutdown = await callHubRpc(clientA, "late-rpc", "sharedSet", {
      key: "shutdown-leak",
      value: "mutated",
    });
    const controlDuringShutdown = await sendMessageAndWait(clientA, {
      id: "late-control",
      type: "browser_list_handlers",
      payload: {},
    });
    const toolDuringShutdown = await sendMessageAndWait(clientA, {
      id: "late-tool",
      type: "browser_click",
      payload: {},
    });

    const latePersistResult = waitForMatchingMessage(
      extension,
      ({ type, id }) => type === "persistRecordingResult" && id === "late-persist",
      2_000,
    );
    let latePersistSettled = false;
    void latePersistResult.then(() => { latePersistSettled = true; });
    extension.send(JSON.stringify({
      type: "persistRecording",
      id: "late-persist",
      sessionId: "session-b",
      payload: validRecording,
    }));

    const clientC = new WebSocket(`ws://127.0.0.1:${server.boundPort}`);
    sockets.push(clientC);
    const clientCClosed = waitForClose(clientC);
    await waitForOpen(clientC);
    clientC.send(JSON.stringify({
      type: "auth",
      token: TOKEN,
      role: "client",
      protocolVersion: PROTOCOL_VERSION,
    }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    const persistRejectedBeforeDrain = latePersistSettled;
    allowPersist.resolve(true);
    const latePersist = await latePersistResult;
    const clientCClose = await clientCClosed;
    await firstClose;
    await secondClose;
    hasReservation.mockRestore();

    expect(rpcDuringShutdown).toEqual({
      type: "hub_rpc_result",
      id: "late-rpc",
      error: "SERVER_SHUTTING_DOWN",
    });
    expect(controlDuringShutdown).toEqual({
      type: "messageResponse",
      payload: { requestId: "late-control", error: "SERVER_SHUTTING_DOWN" },
    });
    expect(toolDuringShutdown).toEqual({
      type: "messageResponse",
      payload: { requestId: "late-tool", error: "SERVER_SHUTTING_DOWN" },
    });
    expect(persistRejectedBeforeDrain).toBe(true);
    expect(latePersist).toEqual({
      type: "persistRecordingResult",
      id: "late-persist",
      ok: false,
      error: "SERVER_SHUTTING_DOWN",
    });
    expect(clientCClose).toEqual({ code: 1012, reason: "SERVER_SHUTTING_DOWN" });
    expect(await server.stateManager.sharedGet("shutdown-leak")).toBeUndefined();
    expect(await server.stateManager.listSessions()).toEqual([]);
    expect(await server.stateManager.listLocks()).toEqual([]);
    expect(await server.stateManager.hasRecordingReservation("session-b", validRecording.name))
      .toBe(false);
    expect(server.pendingRecordingPersistCount()).toBe(0);
    const internals = server.stateManager as unknown as {
      recordingReservations: Map<string, unknown>;
      recordingReservationTimers: Map<string, unknown>;
      lockTtlTimers: Map<string, unknown>;
      lockWaiters: Map<string, unknown>;
      eventWaiters: Map<string, unknown>;
    };
    expect(internals.recordingReservations.size).toBe(0);
    expect(internals.recordingReservationTimers.size).toBe(0);
    expect(internals.lockTtlTimers.size).toBe(0);
    expect(internals.lockWaiters.size).toBe(0);
    expect(internals.eventWaiters.size).toBe(0);
    expect(removeSession.mock.calls.map(([sessionId]) => sessionId).sort())
      .toEqual(["session-a", "session-b"]);
  }, 5_000);

  it("consolidates an active grace finalizer with orderly shutdown", async () => {
    const recordingsDir = mkdtempSync(join(tmpdir(), "mybrowser-shutdown-finalizer-race-"));
    tempDirs.push(recordingsDir);
    const server = await startHub(
      recordingsDir,
      undefined,
      undefined,
      { sessionReconnectGraceMs: 0 },
    );
    const extension = await connect(server);
    await authenticate(extension, "extension");
    const sessionClosed = waitForMatchingMessage(
      extension,
      ({ type }) => type === "session_closed",
      2_000,
    );
    const client = await connect(server);
    await authenticate(client, "client");
    await callHubRpc(client, "register-a", "registerSession", { sessionId: "session-a" });
    await callHubRpc(client, "reserve-a", "reserveRecording", {
      name: validRecording.name,
      leaseMs: 1_800_000,
    });
    const persistEntered = deferred<void>();
    const allowPersist = deferred<boolean>();
    vi.spyOn(server.stateManager, "hasRecordingReservation")
      .mockImplementation(async () => {
        persistEntered.resolve();
        return allowPersist.promise;
      });
    extension.send(JSON.stringify({
      type: "persistRecording",
      id: "persist-before-overlap",
      sessionId: "session-a",
      payload: validRecording,
    }));
    await persistEntered.promise;
    const removeSession = vi.spyOn(server.stateManager, "removeSession");

    const clientClosed = waitForClose(client);
    client.close();
    await clientClosed;
    await new Promise((resolve) => setTimeout(resolve, 10));
    const closing = server.close();
    allowPersist.resolve(true);
    await closing;
    await sessionClosed;

    expect(removeSession).toHaveBeenCalledTimes(1);
    expect(await server.stateManager.listSessions()).toEqual([]);
    expect(server.pendingRecordingPersistCount()).toBe(0);
  }, 5_000);

  it("uses the drain finalizer for orderly close and is idempotent", async () => {
    const recordingsDir = mkdtempSync(join(tmpdir(), "mybrowser-orderly-drain-"));
    tempDirs.push(recordingsDir);
    const server = await startHub(recordingsDir);
    const extension = await connect(server);
    await authenticate(extension, "extension");
    const extensionMessages = waitForMessages(extension, 2, 2_000);
    const client = await connect(server);
    await authenticate(client, "client");
    await callHubRpc(client, "register-a", "registerSession", { sessionId: "session-a" });
    await callHubRpc(client, "reserve-a", "reserveRecording", {
      name: validRecording.name,
      leaseMs: 1_800_000,
    });

    const persistStarted = deferred<void>();
    const allowPersist = deferred<boolean>();
    vi.spyOn(server.stateManager, "hasRecordingReservation")
      .mockImplementation(async () => {
        persistStarted.resolve();
        return allowPersist.promise;
      });
    const removeSession = vi.spyOn(server.stateManager, "removeSession");
    extension.send(JSON.stringify({
      type: "persistRecording",
      id: "persist-before-close",
      sessionId: "session-a",
      payload: validRecording,
    }));
    await persistStarted.promise;

    let closeSettled = false;
    const closing = Promise.resolve(server.close()).then(() => {
      closeSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(closeSettled).toBe(false);

    allowPersist.resolve(true);
    const messages = await extensionMessages;
    await closing;
    expect(messages.map(({ type }) => type)).toEqual([
      "persistRecordingResult",
      "session_closed",
    ]);
    expect(removeSession).toHaveBeenCalledTimes(1);
    await server.close();
    expect(removeSession).toHaveBeenCalledTimes(1);
    expect(server.pendingRecordingPersistCount()).toBe(0);
  }, 5_000);
});
