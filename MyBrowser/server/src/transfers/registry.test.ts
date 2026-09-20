import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_ACTIVE_TRANSFERS_PER_SESSION,
  TransferRegistry,
  type TransferChunkMessage,
  type TransferSettlement,
} from "./registry.js";
import { TransferError, type TransfersConfig } from "./retention.js";

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "mybrowser-registry-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop() as string, { recursive: true, force: true });
  }
});

const config = (overrides: Partial<TransfersConfig> = {}): TransfersConfig => ({
  maxFileMb: 40,
  retentionDays: 7,
  maxTotalMb: 2048,
  ...overrides,
});

const SOCKET_A = { name: "extension-a" };
const SOCKET_B = { name: "extension-b" };

function chunk(overrides: Partial<TransferChunkMessage>): TransferChunkMessage {
  return {
    type: "transfer_chunk",
    v: 2,
    transferId: "tf-test-0001",
    requestId: "req-1",
    seq: 0,
    totalChunks: 1,
    totalBytes: 0,
    sha256: createHash("sha256").update(Buffer.alloc(0)).digest("hex"),
    filename: "file.bin",
    mimeType: "application/octet-stream",
    bytesBase64: Buffer.from("x").toString("base64"),
    ...overrides,
  };
}

function settleAll(): { settlements: TransferSettlement[] } {
  const settlements: TransferSettlement[] = [];
  return { settlements };
}

function makeRegistry(root: string, overrides: Partial<TransfersConfig> = {}, timeoutMs = 60_000) {
  const settlements: TransferSettlement[] = [];
  const registry = new TransferRegistry({
    root,
    config: config(overrides),
    timeoutMs,
  });
  return {
    registry,
    settlements,
    expect(transferId: string, extra: Record<string, unknown> = {}, socket: unknown = SOCKET_A) {
      registry.expect(
        transferId,
        {
          requestId: "req-1",
          sessionId: "sess-1",
          socket,
          ...extra,
        },
        (settlement) => settlements.push(settlement),
      );
    },
  };
}

describe("registry happy path", () => {
  it("reassembles multi-chunk uploads, verifies sha+size, and completes", () => {
    const root = makeRoot();
    const { registry, settlements, expect: expectTransfer } = makeRegistry(root);
    const payload = Buffer.from("chunk-A|chunk-B|chunk-C");
    const sha256 = createHash("sha256").update(payload).digest("hex");
    const parts = ["chunk-A|", "chunk-B|", "chunk-C"].map((p) => p);

    expectTransfer("tf-happy-1");
    for (let seq = 0; seq < parts.length; seq++) {
      const result = registry.ingestChunk(chunk({
        transferId: "tf-happy-1",
        seq,
        totalChunks: parts.length,
        totalBytes: payload.length,
        sha256,
        bytesBase64: Buffer.from(parts[seq] as string).toString("base64"),
      }), SOCKET_A);
      expect(result.complete).toBe(seq === parts.length - 1);
    }

    expect(settlements).toHaveLength(1);
    const settlement = settlements[0] as Extract<TransferSettlement, { ok: true }>;
    expect(settlement.ok).toBe(true);
    expect(settlement.result.bytes).toBe(payload.length);
    expect(settlement.result.sha256).toBe(sha256);
    expect(settlement.result.filename).toBe("file.bin");
    expect(readFileSync(settlement.result.landedPath).equals(payload)).toBe(true);
    // Staged part file is gone after landing.
    expect(existsSync(join(root, ".tmp", "tf-happy-1.part"))).toBe(false);
  });
});

describe("registry failure paths", () => {
  it("rejects a sha mismatch and deletes the staged part file", () => {
    const root = makeRoot();
    const { registry, settlements, expect: expectTransfer } = makeRegistry(root);
    const wrongSha = createHash("sha256").update(Buffer.from("other")).digest("hex");
    expectTransfer("tf-bad-sha");
    const complete = registry.ingestChunk(chunk({
      transferId: "tf-bad-sha",
      bytesBase64: Buffer.from("actual-bytes").toString("base64"),
      sha256: wrongSha,
      totalBytes: 12,
    }), SOCKET_A);
    expect(complete.complete).toBe(true); // reassembly finished; verification failed
    expect(settlements).toHaveLength(1);
    expect(settlements[0]).toMatchObject({ ok: false, code: "TRANSFER_HASH_MISMATCH" });
    expect(existsSync(join(root, ".tmp", "tf-bad-sha.part"))).toBe(false);
  });

  it("rejects out-of-order sequences with TRANSFER_OUT_OF_ORDER", () => {
    const root = makeRoot();
    const { registry, settlements, expect: expectTransfer } = makeRegistry(root);
    const sha = createHash("sha256").update(Buffer.from("ab")).digest("hex");
    expectTransfer("tf-order-1");
    registry.ingestChunk(chunk({
      transferId: "tf-order-1",
      seq: 0,
      totalChunks: 2,
      totalBytes: 2,
      sha256: sha,
      bytesBase64: Buffer.from("a").toString("base64"),
    }), SOCKET_A);
    registry.ingestChunk(chunk({
      transferId: "tf-order-1",
      seq: 1, // in-order → completes
      totalChunks: 2,
      totalBytes: 2,
      sha256: sha,
      bytesBase64: Buffer.from("b").toString("base64"),
    }), SOCKET_A);
    expect(settlements[0]).toMatchObject({ ok: true });

    // Fresh transfer: first chunk arrives with seq 2 → out of order.
    const { registry: r2, settlements: s2, expect: expect2 } = makeRegistry(root);
    expect2("tf-order-2");
    expect(() => r2.ingestChunk(chunk({
      transferId: "tf-order-2",
      seq: 2,
      totalChunks: 3,
      totalBytes: 3,
      sha256: sha,
      bytesBase64: Buffer.from("c").toString("base64"),
    }), SOCKET_A)).toThrow(TransferError);
    expect(s2[0]).toMatchObject({ ok: false, code: "TRANSFER_OUT_OF_ORDER" });
  });

  it("rejects oversize chunks with TRANSFER_TOO_LARGE", () => {
    const root = makeRoot();
    const { registry, settlements, expect: expectTransfer } = makeRegistry(root);
    expectTransfer("tf-big-chunk");
    const big = Buffer.alloc(3 * 1024 * 1024 + 1, 0x41);
    expect(() => registry.ingestChunk(chunk({
      transferId: "tf-big-chunk",
      totalBytes: big.length,
      sha256: createHash("sha256").update(big).digest("hex"),
      bytesBase64: big.toString("base64"),
    }), SOCKET_A)).toThrow(TransferError);
    expect(settlements[0]).toMatchObject({ ok: false, code: "TRANSFER_TOO_LARGE" });
  });

  it("enforces the per-file cap (maxFileMb) with TRANSFER_TOO_LARGE", () => {
    const root = makeRoot();
    const { registry, settlements, expect: expectTransfer } = makeRegistry(root, { maxFileMb: 1 });
    expectTransfer("tf-big-file");
    expect(() => registry.ingestChunk(chunk({
      transferId: "tf-big-file",
      totalBytes: 1024 * 1024 + 1,
      sha256: createHash("sha256").update(Buffer.alloc(0)).digest("hex"),
    }), SOCKET_A)).toThrow(TransferError);
    expect(settlements[0]).toMatchObject({ ok: false, code: "TRANSFER_TOO_LARGE" });
  });

  it("rejects chunks from a different socket with TRANSFER_SESSION_MISMATCH", () => {
    const root = makeRoot();
    const { registry, settlements, expect: expectTransfer } = makeRegistry(root);
    expectTransfer("tf-socket-1");
    expect(() => registry.ingestChunk(chunk({ transferId: "tf-socket-1" }), SOCKET_B))
      .toThrow(TransferError);
    expect(settlements[0]).toMatchObject({ ok: false, code: "TRANSFER_SESSION_MISMATCH" });
  });

  it("rejects unknown transferIds and requestId mismatches", () => {
    const root = makeRoot();
    const { registry, expect: expectTransfer } = makeRegistry(root);
    expect(() => registry.ingestChunk(chunk({ transferId: "tf-ghost" }), SOCKET_A))
      .toThrow(TransferError);
    expectTransfer("tf-known");
    expect(() => registry.ingestChunk(chunk({ transferId: "tf-known", requestId: "req-other" }), SOCKET_A))
      .toThrow(TransferError);
  });

  it("rejects a bad filename with TRANSFER_BAD_FILENAME", () => {
    const root = makeRoot();
    const { registry, settlements, expect: expectTransfer } = makeRegistry(root);
    expectTransfer("tf-name-1");
    expect(() => registry.ingestChunk(chunk({ transferId: "tf-name-1", filename: "../evil.sh" }), SOCKET_A))
      .toThrow(TransferError);
    expect(settlements[0]).toMatchObject({ ok: false, code: "TRANSFER_BAD_FILENAME" });
  });
});

describe("registry concurrency cap", () => {
  it("allows 2 active transfers per session and rejects the third", () => {
    const root = makeRoot();
    const { registry, expect: expectTransfer } = makeRegistry(root);
    expectTransfer("tf-cap-1");
    expectTransfer("tf-cap-2");
    expect(() => registry.expect(
      "tf-cap-3",
      { requestId: "req-1", sessionId: "sess-1", socket: SOCKET_A },
      () => {},
    )).toThrow(TransferError);
    // A different session is unaffected.
    expect(() => registry.expect(
      "tf-cap-3",
      { requestId: "req-2", sessionId: "sess-2", socket: SOCKET_A },
      () => {},
    )).not.toThrow();
    expect(MAX_ACTIVE_TRANSFERS_PER_SESSION).toBe(2);
  });

  it("frees the slot when a transfer settles", async () => {
    const root = makeRoot();
    const { registry, expect: expectTransfer } = makeRegistry(root);
    expectTransfer("tf-slot-1");
    expectTransfer("tf-slot-2");
    registry.abort("tf-slot-1", "TRANSFER_REJECTED", "test");
    expect(() => registry.expect(
      "tf-slot-3",
      { requestId: "req-1", sessionId: "sess-1", socket: SOCKET_A },
      () => {},
    )).not.toThrow();
  });
});

describe("registry timeout + await", () => {
  it("aborts an incomplete transfer after the deadline", async () => {
    const root = makeRoot();
    const { registry, settlements, expect: expectTransfer } = makeRegistry(root, {}, 25);
    expectTransfer("tf-timeout-1");
    const awaited = registry.await("tf-timeout-1");
    await new Promise((r) => setTimeout(r, 60));
    const settlement = await awaited;
    expect(settlement).toMatchObject({ ok: false, code: "TRANSFER_TIMEOUT" });
    expect(settlements).toHaveLength(1);
    expect(existsSync(join(root, ".tmp", "tf-timeout-1.part"))).toBe(false);
  });

  it("await resolves with the completion payload for completed transfers", async () => {
    const root = makeRoot();
    const { registry, expect: expectTransfer } = makeRegistry(root);
    const payload = Buffer.from("await-me");
    const sha = createHash("sha256").update(payload).digest("hex");
    expectTransfer("tf-await-1");
    registry.ingestChunk(chunk({
      transferId: "tf-await-1",
      totalBytes: payload.length,
      sha256: sha,
      bytesBase64: payload.toString("base64"),
    }), SOCKET_A);
    const settlement = await registry.await("tf-await-1");
    expect(settlement.ok).toBe(true);
    if (settlement.ok) {
      expect(readFileSync(settlement.result.landedPath).equals(payload)).toBe(true);
    }
  });
});
