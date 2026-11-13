import { createServer as createNetServer } from "node:net";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import { Context } from "./context.js";
import { PROTOCOL_VERSION } from "./protocol.js";
import { createServerWithTools, OPENCODE_SESSION_META, type MyBrowserMcpServer } from "./server.js";
import { createWebSocketServer, type WsServerResult } from "./ws-server.js";

// One MyBrowser process serving many OpenCode sessions (OpenCode `pool: true`):
// every calling session gets its own hub session, so tabs and state never mix.

const TOKEN = "pool-test-token";
const sockets: WebSocket[] = [];
const hubs: WsServerResult[] = [];
const servers: MyBrowserMcpServer[] = [];
const clients: Client[] = [];

afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((c) => c.close()));
  await Promise.allSettled(servers.splice(0).map((s) => s.close()));
  await Promise.allSettled(hubs.splice(0).map((h) => h.close()));
  for (const ws of sockets.splice(0)) ws.terminate();
});

async function freePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("no port");
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return address.port;
}

/** A fake browser that answers every tool request and records which hub session sent it. */
async function fakeBrowser(port: number) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const seen: Array<{ type: string; sessionId?: string; tabId?: number }> = [];
  const authed = new Promise<void>((resolve) => {
    socket.on("message", (data) => {
      const msg = JSON.parse(data.toString()) as { type?: string; id?: string; status?: string; payload?: Record<string, unknown> };
      if (msg.type === "auth") {
        resolve();
        return;
      }
      if (!msg.id || !msg.type) return;
      seen.push({ type: msg.type, sessionId: (msg as { sessionId?: string }).sessionId, tabId: msg.payload?.tabId as number | undefined });
      const result = msg.type === "getUrl" ? "https://example.test/" : msg.type === "getTitle" ? "Example" : msg.type === "browser_eval" ? { value: 42 } : true;
      const reply = () => socket.send(JSON.stringify({ type: "messageResponse", payload: { requestId: msg.id, result } }));
      // "slow" code stands for a long browser flow: answered after 1.5 s.
      if (msg.payload?.code === "slow") setTimeout(reply, 1_500);
      else reply();
    });
  });
  socket.send(JSON.stringify({ type: "auth", token: TOKEN, protocolVersion: PROTOCOL_VERSION, role: "extension", browserName: "pool-browser" }));
  await authed;
  return seen;
}

async function modernClient(server: MyBrowserMcpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "pool-test", version: "1.0.0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  clients.push(client);
  await client.connect(clientTransport);
  return client;
}

const text = (result: unknown) => ((result as { content?: Array<{ text?: string }> }).content ?? []).map((c) => c.text ?? "").join("\n");
const as = (session: string | undefined) => (session ? { _meta: { [OPENCODE_SESSION_META]: session } } : {});

describe("one process, many OpenCode sessions", () => {
  it("answers server/discover and keeps the 2025 initialize handshake working", async () => {
    const port = await freePort();
    const hub = await createWebSocketServer({ host: "127.0.0.1", port, token: TOKEN, context: new Context() });
    hubs.push(hub);
    const server = await createServerWithTools({ host: "127.0.0.1", port, token: TOKEN });
    servers.push(server);

    const modern = await modernClient(server);
    expect(modern.getServerVersion()?.name).toBe("MyBrowser MCP");
    expect((await modern.listTools()).tools.map((t) => t.name)).toContain("browser_navigate");

    const [legacyTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const legacy = new Client({ name: "legacy-test", version: "1.0.0" });
    clients.push(legacy);
    await legacy.connect(legacyTransport);
    expect((await legacy.listTools()).tools.length).toBe((await modern.listTools()).tools.length);
  });

  it("gives each calling session its own browser session, tabs and routing", async () => {
    const port = await freePort();
    const hub = await createWebSocketServer({ host: "127.0.0.1", port, token: TOKEN, context: new Context() });
    hubs.push(hub);
    const seen = await fakeBrowser(port);
    const server = await createServerWithTools({ host: "127.0.0.1", port, token: TOKEN, sessionName: "pool" });
    servers.push(server);
    const client = await modernClient(server);
    const browserId = (await hub.stateManager.listBrowsers())[0]!.id;
    const call = (session: string | undefined, name: string, args: Record<string, unknown>) =>
      client.callTool({ name, arguments: args, ...as(session) });

    // Each session picks the browser for itself; one session's choice is not another's.
    for (const session of ["ses_alpha", "ses_bravo"]) {
      expect(text(await call(session, "select_browser", { browserId }))).toContain("for this session");
    }
    expect(server.sessionCount()).toBe(2);
    const listed = await hub.stateManager.listSessions();
    const named = listed.filter((s) => s.name?.startsWith("pool OpenCode "));
    expect(named.map((s) => s.name).sort()).toEqual(["pool OpenCode es_alpha", "pool OpenCode es_bravo"]);

    // Session alpha takes tab 7 by acting on it; bravo and the default session are refused.
    expect((await call("ses_alpha", "browser_eval", { code: "1", tabId: 7 })).isError).not.toBe(true);
    const refused = await call("ses_bravo", "browser_eval", { code: "1", tabId: 7 });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain("in use by another agent session (\"pool OpenCode es_alpha\")");
    expect((await call("ses_bravo", "browser_eval", { code: "1", tabId: 8 })).isError).not.toBe(true);
    expect((await call("ses_alpha", "browser_eval", { code: "2", tabId: 7 })).isError).not.toBe(true);

    // The browser saw two different hub sessions, never the default one, for these calls.
    const evals = seen.filter((m) => m.type === "browser_eval");
    const alphaSession = evals.find((m) => m.tabId === 7)!.sessionId;
    const bravoSession = evals.find((m) => m.tabId === 8)!.sessionId;
    expect(alphaSession).toBeTruthy();
    expect(bravoSession).toBeTruthy();
    expect(alphaSession).not.toBe(bravoSession);
    expect([alphaSession, bravoSession]).not.toContain(server.sessionId);
    expect(evals.filter((m) => m.tabId === 7).every((m) => m.sessionId === alphaSession)).toBe(true);

    // Concurrent first calls from one new session create one runtime, not two.
    await Promise.all([call("ses_charlie", "list_browsers", {}), call("ses_charlie", "list_browsers", {})]);
    expect(server.sessionCount()).toBe(3);
  });

  it("does not make other sessions wait behind a slow call", async () => {
    const port = await freePort();
    const hub = await createWebSocketServer({ host: "127.0.0.1", port, token: TOKEN, context: new Context() });
    hubs.push(hub);
    await fakeBrowser(port);
    const browserId = (await hub.stateManager.listBrowsers())[0]!.id;
    const server = await createServerWithTools({ host: "127.0.0.1", port, token: TOKEN });
    servers.push(server);
    const client = await modernClient(server);
    for (const session of ["ses_slow", "ses_fast"]) {
      await client.callTool({ name: "select_browser", arguments: { browserId }, ...as(session) });
    }

    const order: string[] = [];
    const slow = client.callTool({ name: "browser_eval", arguments: { code: "slow", tabId: 31 }, ...as("ses_slow") }).then(() => order.push("slow"));
    const started = Date.now();
    await client.callTool({ name: "browser_eval", arguments: { code: "1", tabId: 32 }, ...as("ses_fast") });
    order.push("fast");
    expect(Date.now() - started).toBeLessThan(1_000);
    await slow;
    expect(order).toEqual(["fast", "slow"]);
  });

  it("parks a session's tabs on close and hands them back to the same session in the next process", async () => {
    const port = await freePort();
    const hub = await createWebSocketServer({ host: "127.0.0.1", port, token: TOKEN, context: new Context() });
    hubs.push(hub);
    await fakeBrowser(port);
    const browserId = (await hub.stateManager.listBrowsers())[0]!.id;

    const first = await createServerWithTools({ host: "127.0.0.1", port, token: TOKEN });
    servers.push(first);
    const firstClient = await modernClient(first);
    await firstClient.callTool({ name: "select_browser", arguments: { browserId }, ...as("ses_resume") });
    await firstClient.callTool({ name: "browser_eval", arguments: { code: "1", tabId: 21 }, ...as("ses_resume") });
    const before = (await hub.stateManager.listSessions()).find((s) => s.name?.endsWith("s_resume"))!.id;
    await first.close();

    // A pooled process restart: the same OpenCode session gets its hub session (and tab 21) back.
    const second = await createServerWithTools({ host: "127.0.0.1", port, token: TOKEN });
    servers.push(second);
    const secondClient = await modernClient(second);
    await secondClient.callTool({ name: "select_browser", arguments: { browserId }, ...as("ses_resume") });
    expect((await secondClient.callTool({ name: "browser_eval", arguments: { code: "1", tabId: 21 }, ...as("ses_resume") })).isError).not.toBe(true);
    expect((await hub.stateManager.listSessions()).map((s) => s.id)).toContain(before);
    // Another session still cannot take it.
    await secondClient.callTool({ name: "select_browser", arguments: { browserId }, ...as("ses_other") });
    expect((await secondClient.callTool({ name: "browser_eval", arguments: { code: "1", tabId: 21 }, ...as("ses_other") })).isError).toBe(true);
  });
});
