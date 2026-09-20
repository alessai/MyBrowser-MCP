// TransferRegistry — server-side state machine for download-direction file
// transfers (extension → hub). Expects are registered by ws-server when a
// transfer-bound tool request is proxied; chunks are ingested from the
// extension socket, staged to a hardened .part file, sha256-verified, and
// atomically landed by landing.ts.
import { createHash, randomUUID } from "node:crypto";
import { closeSync, writeSync } from "node:fs";
import {
  DEFAULT_TRANSFERS_CONFIG,
  TRANSFERS_TMP_DIR,
  TransferError,
  megabytesToBytes,
  sanitizeTransferFilename,
  type TransfersConfig,
} from "./retention.js";
import {
  discardPart,
  finalizeLanding,
  openPartFile,
  type ProvenanceRecord,
} from "./landing.js";

// Spec: decoded chunk ≤ 3 MiB; canonical base64 only.
export const MAX_CHUNK_DECODED_BYTES = 3 * 1024 * 1024;
export const MAX_ACTIVE_TRANSFERS_PER_SESSION = 2;
// Per-transfer deadline: a stalled transfer must not pin hub state forever.
export const DEFAULT_TRANSFER_TIMEOUT_MS = 300_000;

const TRANSFER_ID_RE = /^[A-Za-z0-9-]{1,64}$/u;
const SHA256_RE = /^[a-f0-9]{64}$/u;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/u; // spec canonical base64
const MAX_META_STRING = 2048;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Exact-key protocol validation, style of server/src/protocol.ts: extra or
// missing keys are protocol violations.
// Exact-key house style (cf. protocol.ts): reject any key outside the
// allowed set. Required-key presence is enforced by each message guard's
// explicit field checks, so optional fields (e.g. targetTabId) may be absent.
function hasOnlyKeys(msg: Record<string, unknown>, keys: string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(msg).every((key) => allowed.has(key));
}

function isSafeNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

export interface TransferChunkMessage {
  type: "transfer_chunk";
  v: 2;
  transferId: string;
  requestId: string;
  seq: number;
  totalChunks: number;
  totalBytes: number;
  sha256: string;
  filename: string;
  mimeType: string;
  bytesBase64: string;
}

const CHUNK_KEYS = [
  "type", "v", "transferId", "requestId", "seq", "totalChunks",
  "totalBytes", "sha256", "filename", "mimeType", "bytesBase64",
] as const;

export function isTransferChunkMessage(msg: unknown): msg is TransferChunkMessage {
  if (!isRecord(msg) || !hasOnlyKeys(msg, [...CHUNK_KEYS])) return false;
  return msg.type === "transfer_chunk"
    && msg.v === 2
    && isBoundedString(msg.transferId, 64) && TRANSFER_ID_RE.test(msg.transferId)
    && isBoundedString(msg.requestId, MAX_META_STRING)
    && isSafeNonNegativeInt(msg.seq)
    && isSafeNonNegativeInt(msg.totalChunks) && msg.totalChunks <= 1_000_000
    && isSafeNonNegativeInt(msg.totalBytes)
    && typeof msg.sha256 === "string" && SHA256_RE.test(msg.sha256)
    && typeof msg.filename === "string" && msg.filename.length > 0
    && isBoundedString(msg.mimeType, 255)
    && typeof msg.bytesBase64 === "string"
    && msg.bytesBase64.length > 0
    && msg.bytesBase64.length <= Math.ceil((MAX_CHUNK_DECODED_BYTES * 4) / 3) + 4
    && BASE64_RE.test(msg.bytesBase64);
}

export interface TransferBeginMessage {
  type: "transfer_begin";
  v: 2;
  transferId: string;
  requestId: string;
  direction: "upload";
  fileIndex: number;
  fileCount: number;
  filename: string;
  mimeType: string;
  totalBytes: number;
  totalChunks: number;
  sha256: string;
  targetTabId?: number;
  selector: string;
}

const BEGIN_KEYS = [
  "type", "v", "transferId", "requestId", "direction", "fileIndex",
  "fileCount", "filename", "mimeType", "totalBytes", "totalChunks",
  "sha256", "targetTabId", "selector",
] as const;

export function isTransferBeginMessage(msg: unknown): msg is TransferBeginMessage {
  if (!isRecord(msg) || !hasOnlyKeys(msg, [...BEGIN_KEYS])) return false;
  if (msg.type !== "transfer_begin" || msg.v !== 2) return false;
  if (msg.direction !== "upload") return false;
  if (!isBoundedString(msg.transferId, 64) || !TRANSFER_ID_RE.test(msg.transferId)) return false;
  if (!isBoundedString(msg.requestId, MAX_META_STRING)) return false;
  if (!isSafeNonNegativeInt(msg.fileIndex) || !isSafeNonNegativeInt(msg.fileCount)) return false;
  if (msg.fileCount < 1 || msg.fileIndex >= msg.fileCount) return false;
  if (typeof msg.filename !== "string" || msg.filename.length === 0) return false;
  if (!isBoundedString(msg.mimeType, 255)) return false;
  if (!isSafeNonNegativeInt(msg.totalBytes) || !isSafeNonNegativeInt(msg.totalChunks)) return false;
  if (typeof msg.totalChunks !== "number" || msg.totalChunks > 1_000_000) return false;
  if (typeof msg.sha256 !== "string" || !SHA256_RE.test(msg.sha256)) return false;
  if (!isBoundedString(msg.selector, 2048)) return false;
  if (msg.targetTabId !== undefined
    && (typeof msg.targetTabId !== "number" || !Number.isSafeInteger(msg.targetTabId) || msg.targetTabId <= 0)) {
    return false;
  }
  return true;
}

export interface TransferAckMessage {
  type: "transfer_ack";
  transferId: string;
  seq: number;
  ok: boolean;
  code?: string;
  message?: string;
}

export function isTransferAckMessage(msg: unknown): msg is TransferAckMessage {
  if (!isRecord(msg) || !hasOnlyKeys(msg, ["type", "transferId", "seq", "ok", "code", "message"])) {
    return false;
  }
  if (msg.type !== "transfer_ack") return false;
  if (!isBoundedString(msg.transferId, 64) || !TRANSFER_ID_RE.test(msg.transferId)) return false;
  if (!isSafeNonNegativeInt(msg.seq)) return false;
  if (typeof msg.ok !== "boolean") return false;
  if (msg.code !== undefined && !isBoundedString(msg.code, 64)) return false;
  if (msg.message !== undefined && !isBoundedString(msg.message, MAX_META_STRING)) return false;
  return true;
}

export function newTransferId(): string {
  return randomUUID();
}

export interface TransferExpectMeta {
  requestId: string;
  sessionId: string;
  browserId?: string;
  sourceUrl?: string;
  /** Identity of the extension socket the request was proxied to. */
  socket: unknown;
}

export interface TransferCompletionResult {
  landedPath: string;
  filename: string;
  bytes: number;
  sha256: string;
  mimeType: string;
}

export type TransferSettlement =
  | { ok: true; result: TransferCompletionResult }
  | { ok: false; code: string; message: string };

export type ProvenanceInput = Omit<ProvenanceRecord, "bytes" | "mimeType" | "sha256" | "receivedAt">;

interface RegistryEntry {
  transferId: string;
  meta: TransferExpectMeta;
  onSettled: (settlement: TransferSettlement) => void;
  filename?: string;
  mimeType?: string;
  sha256?: string;
  totalBytes?: number;
  totalChunks?: number;
  hash?: ReturnType<typeof createHash>;
  bytesWritten: number;
  nextSeq: number;
  part?: { fd: number; path: string; identity: { dev: number; ino: number } };
  receivedAt: Date;
  timer?: ReturnType<typeof setTimeout>;
  awaiters?: Array<(settlement: TransferSettlement) => void>;
}

export interface TransferRegistryOptions {
  root: string;
  config?: TransfersConfig;
  timeoutMs?: number;
}

export class TransferRegistry {
  private readonly entries = new Map<string, RegistryEntry>();
  private readonly settledResults = new Map<string, TransferSettlement>();
  private readonly root: string;
  private readonly config: TransfersConfig;
  private readonly timeoutMs: number;
  private disposed = false;

  constructor(options: TransferRegistryOptions) {
    this.root = options.root;
    this.config = options.config ?? DEFAULT_TRANSFERS_CONFIG;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TRANSFER_TIMEOUT_MS;
  }

  get maxFileBytes(): number {
    return megabytesToBytes(this.config.maxFileMb);
  }

  /**
   * Register an expected transfer for a proxied tool request. Enforces the
   * per-session concurrency cap (2). Throws TransferError when the transfer
   * cannot be accepted.
   */
  expect(
    transferId: string,
    meta: TransferExpectMeta,
    onSettled: (settlement: TransferSettlement) => void,
  ): void {
    if (this.disposed) {
      throw new TransferError("TRANSFER_REJECTED", "transfer registry is shutting down");
    }
    if (typeof transferId !== "string" || !TRANSFER_ID_RE.test(transferId)) {
      throw new TransferError("TRANSFER_REJECTED", `invalid transferId ${JSON.stringify(transferId)}`);
    }
    if (this.entries.has(transferId)) {
      throw new TransferError("TRANSFER_REJECTED", `duplicate transferId ${transferId}`);
    }
    if (!isBoundedString(meta.requestId, MAX_META_STRING) || !isBoundedString(meta.sessionId, 128)) {
      throw new TransferError("TRANSFER_REJECTED", "expect requires requestId and sessionId");
    }
    let activeForSession = 0;
    for (const entry of this.entries.values()) {
      if (entry.meta.sessionId === meta.sessionId) activeForSession += 1;
    }
    if (activeForSession >= MAX_ACTIVE_TRANSFERS_PER_SESSION) {
      throw new TransferError(
        "TRANSFER_CONCURRENCY_LIMIT",
        `session already has ${MAX_ACTIVE_TRANSFERS_PER_SESSION} active transfers`,
      );
    }
    const entry: RegistryEntry = {
      transferId,
      meta,
      onSettled,
      bytesWritten: 0,
      nextSeq: 0,
      receivedAt: new Date(),
    };
    this.entries.set(transferId, entry);
    entry.timer = setTimeout(() => {
      this.abort(transferId, "TRANSFER_TIMEOUT", "transfer did not complete in time");
    }, this.timeoutMs);
    entry.timer.unref?.();
  }

  /** True while the transfer is still open (not settled). */
  isActive(transferId: string): boolean {
    return this.entries.has(transferId);
  }

  isSettled(transferId: string): boolean {
    return !this.entries.has(transferId) && this.settledResults.has(transferId);
  }

  /**
   * Resolve when the transfer settles. Unknown transferIds settle immediately
   * as rejected so holders never wait forever.
   */
  await(transferId: string): Promise<TransferSettlement> {
    const entry = this.entries.get(transferId);
    if (!entry) {
      const settled = this.settledResults.get(transferId);
      return Promise.resolve(settled ?? {
        ok: false,
        code: "TRANSFER_REJECTED",
        message: `unknown transferId ${transferId}`,
      });
    }
    return new Promise<TransferSettlement>((resolve) => {
      entry.awaiters ??= [];
      entry.awaiters.push(resolve);
    });
  }

  /** Abort an active transfer (deletes the staged part file). No-op if settled. */
  abort(transferId: string, code: string = "TRANSFER_REJECTED", message = "transfer aborted"): void {
    const entry = this.entries.get(transferId);
    if (!entry) return;
    this.settle(entry, { ok: false, code, message });
  }

  /**
   * Ingest one validated-shape chunk from an extension socket. Throws
   * TransferError on any violation; every fatal violation aborts the
   * transfer first (v1 is strictly in-order — there is no recovery path).
   * `socket` must be the same socket the originating request was proxied to.
   */
  ingestChunk(rawMsg: unknown, socket: unknown): { complete: boolean } {
    if (!isTransferChunkMessage(rawMsg)) {
      throw new TransferError("TRANSFER_REJECTED", "malformed transfer_chunk message");
    }
    const msg = rawMsg;
    const entry = this.entries.get(msg.transferId);
    if (!entry) {
      throw new TransferError("TRANSFER_REJECTED", `unknown transferId ${msg.transferId}`);
    }
    if (entry.meta.socket !== socket) {
      this.abort(msg.transferId, "TRANSFER_SESSION_MISMATCH", "chunk arrived on a different connection than the originating request");
      throw new TransferError("TRANSFER_SESSION_MISMATCH", "chunk connection does not match the originating request");
    }
    if (msg.requestId !== entry.meta.requestId) {
      this.abort(msg.transferId, "TRANSFER_REJECTED", "chunk requestId does not match the originating request");
      throw new TransferError("TRANSFER_REJECTED", "chunk requestId does not match the originating request");
    }
    try {
      return this.ingestInto(entry, msg);
    } catch (error) {
      if (error instanceof TransferError) this.settle(entry, { ok: false, code: error.code, message: error.message });
      else this.settle(entry, { ok: false, code: "TRANSFER_STORAGE_FAILED", message: String(error) });
      throw error;
    }
  }

  private ingestInto(entry: RegistryEntry, msg: TransferChunkMessage): { complete: boolean } {
    // Transfer-level metadata rides on every chunk; bind it on the first
    // chunk and require exact consistency afterwards.
    if (entry.sha256 === undefined) {
      if (msg.seq !== 0) {
        throw new TransferError("TRANSFER_OUT_OF_ORDER", `first chunk must have seq 0 (got ${msg.seq})`);
      }
      entry.filename = sanitizeTransferFilename(msg.filename); // TRANSFER_BAD_FILENAME
      entry.mimeType = msg.mimeType;
      entry.sha256 = msg.sha256;
      entry.totalChunks = msg.totalChunks;
      entry.totalBytes = msg.totalBytes;
      entry.hash = createHash("sha256");
      if (entry.totalChunks < 1) {
        throw new TransferError("TRANSFER_REJECTED", "totalChunks must be at least 1");
      }
      if (entry.totalBytes > this.maxFileBytes) {
        throw new TransferError(
          "TRANSFER_TOO_LARGE",
          `file exceeds maxFileMb cap (${this.config.maxFileMb} MiB)`,
        );
      }
      try {
        entry.part = openPartFile(this.root, entry.transferId);
      } catch (error) {
        if (error instanceof TransferError) throw error;
        throw new TransferError("TRANSFER_STORAGE_FAILED", `cannot stage part file: ${String(error)}`);
      }
    } else {
      const consistent =
        msg.sha256 === entry.sha256
        && msg.totalChunks === entry.totalChunks
        && msg.totalBytes === entry.totalBytes
        && sanitizeTransferFilename(msg.filename) === entry.filename
        && msg.mimeType === entry.mimeType;
      if (!consistent) {
        throw new TransferError("TRANSFER_REJECTED", "chunk metadata is inconsistent with the transfer");
      }
    }

    if (msg.seq !== entry.nextSeq) {
      throw new TransferError("TRANSFER_OUT_OF_ORDER", `expected seq ${entry.nextSeq}, got ${msg.seq}`);
    }

    const chunk = Buffer.from(msg.bytesBase64, "base64");
    if (chunk.length > MAX_CHUNK_DECODED_BYTES) {
      throw new TransferError("TRANSFER_TOO_LARGE", `chunk exceeds ${MAX_CHUNK_DECODED_BYTES} decoded bytes`);
    }
    if (entry.bytesWritten + chunk.length > (entry.totalBytes as number)) {
      throw new TransferError("TRANSFER_SIZE_MISMATCH", "chunks exceed declared totalBytes");
    }

    const fd = (entry.part as NonNullable<RegistryEntry["part"]>).fd;
    writeSync(fd, chunk);
    (entry.hash as NonNullable<RegistryEntry["hash"]>).update(chunk);
    entry.bytesWritten += chunk.length;
    entry.nextSeq += 1;

    if (entry.nextSeq === entry.totalChunks) {
      this.completeTransfer(entry);
      return { complete: true };
    }
    return { complete: false };
  }

  private completeTransfer(entry: RegistryEntry): void {
    const part = entry.part!;
    const digest = (entry.hash as NonNullable<RegistryEntry["hash"]>).digest("hex");
    if (digest !== entry.sha256) {
      this.settle(entry, {
        ok: false,
        code: "TRANSFER_HASH_MISMATCH",
        message: "reassembled file does not match the declared sha256",
      });
      return;
    }
    let result: TransferCompletionResult;
    try {
      const landing = finalizeLanding(part, {
        root: this.root,
        sessionId: entry.meta.sessionId,
        filename: entry.filename as string,
        mimeType: entry.mimeType as string,
        sha256: digest,
        totalBytes: entry.totalBytes as number,
        sourceUrl: entry.meta.sourceUrl,
        browserId: entry.meta.browserId,
        transferId: entry.transferId,
        receivedAt: entry.receivedAt,
      });
      result = {
        landedPath: landing.finalPath,
        filename: entry.filename as string,
        bytes: entry.totalBytes as number,
        sha256: digest,
        mimeType: entry.mimeType as string,
      };
    } catch (error) {
      if (error instanceof TransferError) {
        this.settle(entry, { ok: false, code: error.code, message: error.message });
      } else {
        this.settle(entry, { ok: false, code: "TRANSFER_STORAGE_FAILED", message: String(error) });
      }
      return;
    }
    this.settle(entry, { ok: true, result });
  }

  private settle(entry: RegistryEntry, settlement: TransferSettlement): void {
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
    }
    this.entries.delete(entry.transferId);
    this.settledResults.set(entry.transferId, settlement);
    if (this.settledResults.size > 64) {
      const oldest = this.settledResults.keys().next().value;
      if (oldest !== undefined) this.settledResults.delete(oldest);
    }
    if (entry.part) {
      try {
        closeSync(entry.part.fd);
      } catch { /* already closed */ }
      discardPart(this.root, entry.transferId);
      entry.part = undefined;
    }
    for (const resolve of entry.awaiters ?? []) resolve(settlement);
    entry.awaiters = [];
    entry.onSettled(settlement);
  }

  /** Abort every active transfer and stop timers (hub shutdown / tests). */
  dispose(): void {
    this.disposed = true;
    for (const entry of [...this.entries.values()]) {
      this.abort(entry.transferId, "TRANSFER_REJECTED", "registry disposed");
    }
  }

  /** Directory holding staged part files (for tests). */
  get tmpDir(): string {
    return TRANSFERS_TMP_DIR;
  }
}
