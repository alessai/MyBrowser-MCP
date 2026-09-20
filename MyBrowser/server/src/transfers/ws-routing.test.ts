import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createWebSocketServer, type WsServerOptions, type WsServerResult } from "../ws-server.js";
import { Context } from "../context.js";
import { PROTOCOL_VERSION } from "../protocol.js";
import { DEFAULT_TRANSFERS_CONFIG } from "./retention.js";

const TOKEN = "test-token-transfer-ws";
const roots: string[] = [];
const servers: WsServerResult[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.close().catch(() => {});
  }
  for (const socket of sockets.splice(0)) {
    if (socket.readyState === WebSocket.OPEN) socket.close();
  }
  while (roots.length > 0) {
    rmSync(roots.pop() as string, { recursive: true, force: true });
  }
});

function makeTransfersDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mybrowser-ws-transfers-"));
  roots.push(dir);
  return dir;
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

async function startHub(): Promise<{ server: WsServerResult; transfersDir: string }> {
  const transfersDir = makeTransfersDir();
  const result = await createWebSocketServer({
    host: "127.0.0.1",
    port: 0,
    token: TOKEN,
    context: new Context(),
    transfersDir,
  } as WsServerOptions);
  servers.push(result);
  return { server: result, transfersDir };
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

async function authenticate(ws: WebSocket, role: "client" | "extension"): Promise<Record<string, unknown>> {
  const response = createMessageInbox(ws).next();
  ws.send(JSON.stringify({ type: "auth", token: TOKEN, role, protocolVersion: PROTOCOL_VERSION }));
  return response;
}

async function callHubRpc(
  ws: WebSocket,
  id: string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const response = createMessageInbox(ws).next();
  ws.send(JSON.stringify({ type: "hub_rpc", id, method, params }));
  return response;
}

interface Fixture {
  server: WsServerResult;
  transfersDir: string;
  extension: WebSocket;
  extensionInbox: ReturnType<typeof createMessageInbox>;
  browserId: string;
  client: WebSocket;
  clientInbox: ReturnType<typeof createMessageInbox>;
}

async function setup(): Promise<Fixture> {
  const { server, transfersDir } = await startHub();
  const extension = await connect(server);
  const extensionAuth = await authenticate(extension, "extension");
  const browserId = extensionAuth.browserId as string;
  const extensionInbox = createMessageInbox(extension);
  const client = await connect(server);
  await authenticate(client, "client");
  await callHubRpc(client, "reg-1", "registerSession", { sessionId: "sess-ws-1" });
  await callHubRpc(client, "sel-1", "selectBrowser", { browserId });
  const clientInbox = createMessageInbox(client);
  return { server, transfersDir, extension, extensionInbox, browserId, client, clientInbox };
}

function makeChunk(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "transfer_chunk",
    v: 2,
    transferId: "tf-ws-1",
    requestId: "hub_1",
    seq: 0,
    totalChunks: 1,
    totalBytes: 0,
    sha256: createHash("sha256").update(Buffer.alloc(0)).digest("hex"),
    filename: "download.bin",
    mimeType: "application/octet-stream",
    bytesBase64: Buffer.from("x").toString("base64"),
    ...overrides,
  };
}

const FETCH_PAYLOAD = {
  url: "https://example.com/files/download.bin",
  filename: "download.bin",
  transferId: "tf-ws-1",
};

describe("download direction (extension → registry → client completion)", () => {
  it("acks chunks, lands the file, and resolves the pending request with the landed payload", async () => {
    const fx = await setup();
    fx.client.send(JSON.stringify({
      id: "client-req-1",
      type: "browser_fetch_file",
      payload: FETCH_PAYLOAD,
      sessionId: "sess-ws-1",
      timeoutMs: 30_000,
    }));
    const forwarded = await fx.extensionInbox.next();
    expect(forwarded).toMatchObject({
      type: "browser_fetch_file",
      payload: FETCH_PAYLOAD,
      sessionId: "sess-ws-1",
    });
    const hubRequestId = forwarded.id as string;

    const payload = Buffer.from("ws-download-body");
    fx.extension.send(JSON.stringify(makeChunk({
      requestId: hubRequestId,
      totalBytes: payload.length,
      sha256: createHash("sha256").update(payload).digest("hex"),
      bytesBase64: payload.toString("base64"),
    })));

    // Per-chunk ack goes back to the extension socket.
    await expect(fx.extensionInbox.next()).resolves.toMatchObject({
      type: "transfer_ack",
      transferId: "tf-ws-1",
      seq: 0,
      ok: true,
    });

    // The pending tool request completes with the spec'd landed payload.
    const response = await fx.clientInbox.next();
    expect(response.type).toBe("messageResponse");
    const result = (response.payload as Record<string, unknown>).result as Record<string, unknown>;
    expect(result).toMatchObject({
      filename: "download.bin",
      bytes: payload.length,
      sha256: createHash("sha256").update(payload).digest("hex"),
      mimeType: "application/octet-stream",
    });
    expect(typeof result.landedPath).toBe("string");
    expect(readFileSync(result.landedPath as string).equals(payload)).toBe(true);
    expect((result.landedPath as string).startsWith(join(fx.transfersDir, "downloads", "sess-ws-1"))).toBe(true);
  });

  it("holds the extension response until the transfer lands, then completes via the registry", async () => {
    const fx = await setup();
    fx.client.send(JSON.stringify({
      id: "client-req-hold",
      type: "browser_fetch_file",
      payload: FETCH_PAYLOAD,
      sessionId: "sess-ws-1",
      timeoutMs: 30_000,
    }));
    const forwarded = await fx.extensionInbox.next();
    const hubRequestId = forwarded.id as string;

    const part1 = Buffer.from("first;");
    const part2 = Buffer.from("second");
    const all = Buffer.concat([part1, part2]);
    fx.extension.send(JSON.stringify(makeChunk({
      requestId: hubRequestId,
      seq: 0,
      totalChunks: 2,
      totalBytes: all.length,
      sha256: createHash("sha256").update(all).digest("hex"),
      bytesBase64: part1.toString("base64"),
    })));
    await fx.extensionInbox.next(); // ack seq 0

    // Extension responds early — the hub must HOLD it until reassembly ends.
    fx.extension.send(JSON.stringify({
      type: "messageResponse",
      payload: { requestId: hubRequestId, result: "premature-extension-result" },
    }));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(fx.clientInbox.all).toEqual([]);

    fx.extension.send(JSON.stringify(makeChunk({
      requestId: hubRequestId,
      seq: 1,
      totalChunks: 2,
      totalBytes: all.length,
      sha256: createHash("sha256").update(all).digest("hex"),
      bytesBase64: part2.toString("base64"),
    })));

    const response = await fx.clientInbox.next();
    const result = (response.payload as Record<string, unknown>).result as Record<string, unknown>;
    expect(result.bytes).toBe(all.length);
    expect(readFileSync(result.landedPath as string).equals(all)).toBe(true);
  });

  it("rejects a chunk from a different extension socket with TRANSFER_SESSION_MISMATCH", async () => {
    const fx = await setup();
    fx.client.send(JSON.stringify({
      id: "client-req-sock",
      type: "browser_fetch_file",
      payload: FETCH_PAYLOAD,
      sessionId: "sess-ws-1",
      timeoutMs: 30_000,
    }));
    const forwarded = await fx.extensionInbox.next();

    // A second extension (different browser/connection) tries to inject.
    const rogue = await connect(fx.server);
    await authenticate(rogue, "extension");
    const rogueInbox = createMessageInbox(rogue);
    const payload = Buffer.from("hijack");
    rogue.send(JSON.stringify(makeChunk({
      requestId: forwarded.id as string,
      totalBytes: payload.length,
      sha256: createHash("sha256").update(payload).digest("hex"),
      bytesBase64: payload.toString("base64"),
    })));
    await expect(rogueInbox.next()).resolves.toMatchObject({
      type: "transfer_ack",
      transferId: "tf-ws-1",
      ok: false,
      code: "TRANSFER_SESSION_MISMATCH",
    });
  });

  it("rejects a malformed chunk with TRANSFER_REJECTED", async () => {
    const fx = await setup();
    fx.client.send(JSON.stringify({
      id: "client-req-bad",
      type: "browser_fetch_file",
      payload: FETCH_PAYLOAD,
      sessionId: "sess-ws-1",
      timeoutMs: 30_000,
    }));
    await fx.extensionInbox.next();
    fx.extension.send(JSON.stringify({ type: "transfer_chunk", transferId: "tf-ws-1", garbage: true }));
    await expect(fx.extensionInbox.next()).resolves.toMatchObject({
      type: "transfer_ack",
      ok: false,
      code: "TRANSFER_REJECTED",
    });
  });

  it("rejects an unknown transferId with TRANSFER_REJECTED", async () => {
    const fx = await setup();
    const payload = Buffer.from("ghost");
    fx.extension.send(JSON.stringify(makeChunk({
      transferId: "tf-never-expected",
      totalBytes: payload.length,
      sha256: createHash("sha256").update(payload).digest("hex"),
      bytesBase64: payload.toString("base64"),
    })));
    await expect(fx.extensionInbox.next()).resolves.toMatchObject({
      type: "transfer_ack",
      ok: false,
      code: "TRANSFER_REJECTED",
    });
  });
});

describe("upload direction (client → extension relay)", () => {
  const BEGIN = {
    type: "transfer_begin",
    v: 2,
    transferId: "tf-up-1",
    requestId: "client-upload-1",
    direction: "upload",
    fileIndex: 0,
    fileCount: 1,
    filename: "upload.bin",
    mimeType: "text/plain",
    totalBytes: 5,
    totalChunks: 1,
    sha256: createHash("sha256").update(Buffer.from("hello")).digest("hex"),
    selector: "#file-input",
  };

  it("relays begin+chunk to the extension and the ack back to the client", async () => {
    const fx = await setup();
    fx.client.send(JSON.stringify(BEGIN));
    await expect(fx.extensionInbox.next()).resolves.toMatchObject({
      type: "transfer_begin",
      transferId: "tf-up-1",
      filename: "upload.bin",
      sessionId: "sess-ws-1",
    });
    fx.client.send(JSON.stringify(makeChunk({
      transferId: "tf-up-1",
      requestId: "client-upload-1",
      totalBytes: 5,
      sha256: BEGIN.sha256,
      bytesBase64: Buffer.from("hello").toString("base64"),
    })));
    await expect(fx.extensionInbox.next()).resolves.toMatchObject({
      type: "transfer_chunk",
      transferId: "tf-up-1",
      seq: 0,
      bytesBase64: Buffer.from("hello").toString("base64"),
    });

    // Extension acks → relayed to the originating client socket only.
    fx.extension.send(JSON.stringify({
      type: "transfer_ack",
      transferId: "tf-up-1",
      seq: 0,
      ok: true,
    }));
    await expect(fx.clientInbox.next()).resolves.toMatchObject({
      type: "transfer_ack",
      transferId: "tf-up-1",
      seq: 0,
      ok: true,
    });
  });

  it("enforces client↔transfer binding: another session cannot inject chunks", async () => {
    const fx = await setup();
    fx.client.send(JSON.stringify(BEGIN));
    await fx.extensionInbox.next();

    const other = await connect(fx.server);
    await authenticate(other, "client");
    await callHubRpc(other, "reg-2", "registerSession", { sessionId: "sess-ws-2" });
    await callHubRpc(other, "sel-2", "selectBrowser", { browserId: fx.browserId });
    const otherInbox = createMessageInbox(other);
    other.send(JSON.stringify(makeChunk({
      transferId: "tf-up-1", // owned by sess-ws-1
      requestId: "client-upload-1",
      totalBytes: 5,
      sha256: BEGIN.sha256,
    })));
    await expect(otherInbox.next()).resolves.toMatchObject({
      type: "transfer_ack",
      ok: false,
      code: "TRANSFER_REJECTED",
    });
  });

  it("rejects upload chunks whose requestId does not match the begin", async () => {
    const fx = await setup();
    fx.client.send(JSON.stringify(BEGIN));
    await fx.extensionInbox.next();
    fx.client.send(JSON.stringify(makeChunk({
      transferId: "tf-up-1",
      requestId: "client-upload-OTHER",
      totalBytes: 5,
      sha256: BEGIN.sha256,
    })));
    await expect(fx.clientInbox.next()).resolves.toMatchObject({
      type: "transfer_ack",
      ok: false,
      code: "TRANSFER_REJECTED",
    });
  });

  it("rejects an oversized upload file at the begin with TRANSFER_TOO_LARGE", async () => {
    const fx = await setup();
    fx.client.send(JSON.stringify({
      ...BEGIN,
      totalBytes: (DEFAULT_TRANSFERS_CONFIG.maxFileMb * 1024 * 1024) + 1,
      sha256: createHash("sha256").update(Buffer.alloc(0)).digest("hex"),
    }));
    await expect(fx.clientInbox.next()).resolves.toMatchObject({
      type: "transfer_ack",
      transferId: "tf-up-1",
      ok: false,
      code: "TRANSFER_TOO_LARGE",
    });
  });

  it("rejects an ack from the extension for an unknown transfer (never relayed)", async () => {
    const fx = await setup();
    fx.client.send(JSON.stringify(BEGIN));
    await fx.extensionInbox.next();
    // Ack for a transferId no client ever registered → dropped, no crash.
    fx.extension.send(JSON.stringify({
      type: "transfer_ack",
      transferId: "tf-up-GHOST",
      seq: 0,
      ok: true,
    }));
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(fx.clientInbox.all).toEqual([]);
  });
});
