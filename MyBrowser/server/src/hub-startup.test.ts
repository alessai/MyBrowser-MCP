import { createServer } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import { Context } from "./context.js";
import {
  createWebSocketServer,
  type WsServerResult,
} from "./ws-server.js";

const TOKEN = "test-token";
const servers: WsServerResult[] = [];

function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const reservation = createServer();
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", () => {
      const address = reservation.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to reserve test port"));
        return;
      }
      reservation.close(() => resolve(address.port));
    });
  });
}

afterEach(async () => {
  await Promise.allSettled(servers.splice(0).map((server) => server.close()));
});

describe("hub startup ownership", () => {
  it("requires standalone hub mode to own the listener", async () => {
    const owner = await createWebSocketServer({
      host: "127.0.0.1",
      port: 0,
      token: TOKEN,
      context: new Context(),
    });
    servers.push(owner);

    await expect(createWebSocketServer({
      host: "127.0.0.1",
      port: owner.boundPort,
      token: TOKEN,
      context: new Context(),
      requireHub: true,
    })).rejects.toThrow(`Cannot start standalone hub on 127.0.0.1:${owner.boundPort}`);
  });

  it("keeps explicit client mode from becoming the hub", async () => {
    const port = await reservePort();
    const onHubUnavailable = vi.fn();

    await expect(createWebSocketServer({
      host: "127.0.0.1",
      port,
      token: TOKEN,
      context: new Context(),
      clientOnly: true,
      onHubUnavailable,
    })).rejects.toThrow();
    expect(onHubUnavailable).toHaveBeenCalledOnce();
  });

  it("elects exactly one hub when clients start concurrently", async () => {
    const port = await reservePort();
    const results = await Promise.all(Array.from({ length: 6 }, () => createWebSocketServer({
      host: "127.0.0.1",
      port,
      token: TOKEN,
      context: new Context(),
    })));
    servers.push(...results);

    expect(results.filter((result) => result.isHub)).toHaveLength(1);
    expect(results.filter((result) => !result.isHub)).toHaveLength(5);
  });

  it("notifies local recovery after a client loses its hub", async () => {
    const owner = await createWebSocketServer({
      host: "127.0.0.1",
      port: 0,
      token: TOKEN,
      context: new Context(),
    });
    servers.push(owner);
    const onHubUnavailable = vi.fn();
    const client = await createWebSocketServer({
      host: "127.0.0.1",
      port: owner.boundPort,
      token: TOKEN,
      context: new Context(),
      clientOnly: true,
      clientReconnectDelayMs: 10,
      onHubUnavailable,
    });
    servers.push(client);

    await owner.close();
    servers.splice(servers.indexOf(owner), 1);
    await vi.waitFor(() => expect(onHubUnavailable).toHaveBeenCalled(), { timeout: 1_000 });
  });
});
