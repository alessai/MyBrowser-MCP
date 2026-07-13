import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { Context } from "./context.js";

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
