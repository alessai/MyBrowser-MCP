import { createServer as createNetServer } from "node:net";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import { PROTOCOL_VERSION } from "../protocol.js";
import { createServerWithTools } from "../server.js";
import { analyzeTraceDirectory, exportTraces } from "./commands.js";
import { TelemetryManager } from "./manager.js";
import type { TelemetryConfig, TelemetryEvent } from "./types.js";

const TOKEN = "task-10-telemetry-token";
const RETRY_CANARY = "RAW_RETRY_SECRET_4179";
const MALFORMED_CANARY = "RAW_MALFORMED_SECRET_8152";
const MISSING_CANARY = "RAW_MISSING_SECRET_3264";
const SESSION_CANARY_A = "RAW_SESSION_SECRET_A_9831";
const SESSION_CANARY_B = "RAW_SESSION_SECRET_B_7510";

const sockets: WebSocket[] = [];
const servers: Array<{ close: () => Promise<void> }> = [];
const clients: Client[] = [];
const roots: string[] = [];

async function freePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("Failed to allocate a loopback port");
  await new Promise<void>((resolve, reject) => {
    probe.close((error) => error ? reject(error) : resolve());
  });
  return address.port;
}

function waitForMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const onMessage = (data: WebSocket.RawData) => {
      cleanup();
      resolve(JSON.parse(data.toString()) as Record<string, unknown>);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      socket.off("message", onMessage);
      socket.off("error", onError);
    };
    socket.on("message", onMessage);
    socket.on("error", onError);
  });
}

async function connectExtension(port: number): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const auth = waitForMessage(socket);
  socket.send(JSON.stringify({
    type: "auth",
    token: TOKEN,
    protocolVersion: PROTOCOL_VERSION,
    role: "extension",
    browserName: "task-10-browser",
  }));
  await expect(auth).resolves.toMatchObject({ type: "auth", status: "ok" });
  return socket;
}

function installFakeExtension(socket: WebSocket): void {
  const failedElements = new Set<string>();
  socket.on("message", (data) => {
    const request = JSON.parse(data.toString()) as {
      id?: string;
      type?: string;
      payload?: Record<string, unknown>;
      trace?: { traceId: string; transportSpanId: string };
    };
    if (!request.id || !request.type) return;

    const element = typeof request.payload?.element === "string" ? request.payload.element : "";
    if (request.type === "browser_click" && element === RETRY_CANARY && !failedElements.has(element)) {
      failedElements.add(element);
      socket.send(JSON.stringify({
        type: "messageResponse",
        payload: { requestId: request.id, error: "EXTENSION_WORKER_RESTARTED" },
      }));
      return;
    }

    const result = request.type === "getUrl"
      ? "https://example.test/safe"
      : request.type === "getTitle"
        ? "Safe page"
        : request.type === "browser_snapshot"
          ? "button Save"
          : true;
    const telemetry = request.trace ? {
      schemaVersion: 1,
      traceId: request.trace.traceId,
      transportSpanId: request.trace.transportSpanId,
      extensionRequestId: request.id,
      offscreenReceivedToBackgroundMs: 1,
      queueWaitMs: 2,
      handlerMs: 3,
      resolvedTabId: 11,
      stateSignals: {
        tabChanged: request.type === "browser_click" && element === "Recovery control",
        pathChanged: false,
      },
    } : undefined;
    const responseTelemetry = request.type === "browser_click" && element === MALFORMED_CANARY
      ? { raw: MALFORMED_CANARY }
      : request.type === "browser_click" && element === MISSING_CANARY
        ? undefined
        : telemetry;
    socket.send(JSON.stringify({
      type: "messageResponse",
      payload: {
        requestId: request.id,
        result,
        ...(responseTelemetry === undefined ? {} : { telemetry: responseTelemetry }),
      },
    }));
  });
}

function telemetryConfig(root: string): TelemetryConfig {
  return {
    enabled: true,
    directory: join(root, "traces"),
    keyPath: join(root, "trace-key"),
    retentionMs: 7 * 24 * 60 * 60 * 1_000,
    maxTotalBytes: 16 * 1024 * 1024,
    maxFileBytes: 4 * 1024 * 1024,
    maxEventBytes: 16 * 1024,
  };
}

function deterministicIds(owner: "a" | "b"): () => string {
  let sequence = 0;
  return () => {
    sequence += 1;
    if (sequence === 3) return "trace_collision_1234567890";
    return `${owner}_${String(sequence).padStart(24, "0")}`;
  };
}

function deterministicClock(): () => number {
  let current = 0;
  return () => ++current;
}

async function connectMcp(server: { connect: (transport: InMemoryTransport) => Promise<void> }, name: string) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name, version: "1.0.0" });
  clients.push(client);
  await client.connect(clientTransport);
  return client;
}

async function click(client: Client, element: string) {
  return client.callTool({
    name: "browser_click",
    arguments: { tabId: 11, element },
  });
}

function readEvents(directory: string): { files: string[]; events: TelemetryEvent[]; text: string } {
  const files = readdirSync(directory).filter((name) => name.startsWith("trace-") && name.endsWith(".jsonl"));
  const text = files.map((name) => readFileSync(join(directory, name), "utf8")).join("");
  const events = text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as TelemetryEvent);
  return { files, events, text };
}

afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((client) => client.close()));
  await Promise.allSettled(servers.splice(0).reverse().map((server) => server.close()));
  for (const socket of sockets.splice(0)) {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.terminate();
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("internal telemetry real topology", () => {
  it("keeps two client writers correlated, private, and analyzable through one storage-free hub", async () => {
    const consoleErrors: unknown[][] = [];
    vi.spyOn(console, "error").mockImplementation((...args) => { consoleErrors.push(args); });
    const root = mkdtempSync(join(tmpdir(), "mybrowser-telemetry-topology-"));
    roots.push(root);
    const config = telemetryConfig(root);
    writeFileSync(config.keyPath, Buffer.alloc(32, 9), { mode: 0o600 });
    chmodSync(config.keyPath, 0o600);
    const now = Date.parse("2026-07-18T00:00:00.000Z");
    const managerA = TelemetryManager.create(config, {
      now: () => now,
      monotonicNow: deterministicClock(),
      randomUUID: deterministicIds("a"),
    });
    const managerB = TelemetryManager.create(config, {
      now: () => now,
      monotonicNow: deterministicClock(),
      randomUUID: deterministicIds("b"),
    });
    const port = await freePort();
    const serverA = await createServerWithTools({
      host: "127.0.0.1",
      port,
      token: TOKEN,
      sessionId: SESSION_CANARY_A,
      telemetry: managerA,
    });
    servers.push(serverA);
    const extension = await connectExtension(port);
    installFakeExtension(extension);
    const serverB = await createServerWithTools({
      host: "127.0.0.1",
      port,
      token: TOKEN,
      sessionId: SESSION_CANARY_B,
      telemetry: managerB,
    });
    servers.push(serverB);
    const clientA = await connectMcp(serverA, "task-10-client-a");
    const clientB = await connectMcp(serverB, "task-10-client-b");

    const [failed, firstB] = await Promise.all([
      click(clientA, RETRY_CANARY),
      click(clientB, "Second session control"),
    ]);
    expect(failed.isError).toBe(true);
    expect(firstB.isError).not.toBe(true);
    expect((await click(clientA, RETRY_CANARY)).isError).not.toBe(true);
    expect((await click(clientA, "Recovery control")).isError).not.toBe(true);
    for (const element of ["Oscillation A", "Oscillation B", "Oscillation A", "Oscillation B"]) {
      expect((await click(clientA, element)).isError).not.toBe(true);
    }
    expect((await click(clientA, MALFORMED_CANARY)).isError).not.toBe(true);
    expect((await click(clientA, MISSING_CANARY)).isError).not.toBe(true);
    expect((await click(clientB, "Second session control")).isError).not.toBe(true);
    const diagnostics = await clientA.callTool({
      name: "browser_diagnostics",
      arguments: { includeLogs: false, includeExtension: false },
    });
    expect(diagnostics.isError).not.toBe(true);

    await clientB.close();
    clients.splice(clients.indexOf(clientB), 1);
    await serverB.close();
    servers.splice(servers.indexOf(serverB), 1);
    await clientA.close();
    clients.splice(clients.indexOf(clientA), 1);
    await serverA.close();
    servers.splice(servers.indexOf(serverA), 1);

    const persisted = readEvents(config.directory);
    expect(persisted.files).toHaveLength(2);
    expect(persisted.events.filter((event) => event.type === "run_started")).toHaveLength(2);
    expect(persisted.events.filter((event) => event.type === "run_stopped")).toHaveLength(2);
    expect(persisted.text).not.toContain("\n\n");
    const toolStarts = persisted.events.filter((event) => event.type === "tool_started");
    const toolTerminals = persisted.events.filter((event) => (
      event.type === "tool_completed" || event.type === "tool_failed"
    ));
    const transportStarts = persisted.events.filter((event) => event.type === "transport_started");
    const transportTerminals = persisted.events.filter((event) => (
      event.type === "transport_completed" || event.type === "transport_failed"
    ));
    expect(toolTerminals).toHaveLength(toolStarts.length);
    expect(transportTerminals).toHaveLength(transportStarts.length);
    const summaries = persisted.events.filter((event): event is Extract<
      TelemetryEvent,
      { type: "extension_summary" }
    > => event.type === "extension_summary");
    expect(new Set(summaries.map((event) => event.routeMode))).toEqual(new Set(["direct", "hub"]));
    for (const summary of summaries) {
      expect(summary).not.toHaveProperty("resolvedTabId");
      expect(summary.resolvedTabPseudonym).toMatch(/^[A-Za-z0-9_-]{22}$/);
    }
    expect(persisted.events).toContainEqual(expect.objectContaining({
      type: "transport_failed",
      errorCategory: "worker_restarted",
    }));
    expect(persisted.events).toContainEqual(expect.objectContaining({
      type: "telemetry_integrity",
      reason: "malformed",
    }));
    expect(new Set(toolStarts.map((event) => event.traceId)).size).toBeLessThan(toolStarts.length);

    const report = await analyzeTraceDirectory(config);
    expect(report.counts.error_retry).toBeGreaterThanOrEqual(1);
    expect(report.counts.oscillation).toBeGreaterThanOrEqual(1);
    expect(report.counts.recovery).toBeGreaterThanOrEqual(1);
    expect(report.counts.unchanged_repeat).toBeGreaterThanOrEqual(1);
    expect(report.counts.possible_noop).toBeGreaterThanOrEqual(1);
    expect(report.diagnostics.crossPartitionCollisions).toBeGreaterThanOrEqual(1);
    expect(report.diagnostics.rejectedEvents).toBe(0);

    const exportedPath = join(root, "safe-export.jsonl");
    expect(await exportTraces(config, { output: exportedPath })).toBe(persisted.events.length);
    const traceEvidence = [
      persisted.text,
      JSON.stringify(report),
      readFileSync(exportedPath, "utf8"),
    ].join("\n");
    for (const canary of [
      RETRY_CANARY,
      MALFORMED_CANARY,
      MISSING_CANARY,
      SESSION_CANARY_A,
      SESSION_CANARY_B,
    ]) expect(traceEvidence).not.toContain(canary);
    const diagnosticsEvidence = JSON.stringify(diagnostics);
    for (const argumentCanary of [RETRY_CANARY, MALFORMED_CANARY, MISSING_CANARY]) {
      expect(diagnosticsEvidence).not.toContain(argumentCanary);
      expect(JSON.stringify(consoleErrors)).not.toContain(argumentCanary);
    }
  }, 20_000);
});
