// Shared constants + helpers for chunked file transfers (protocol v2).
// Chunks are canonical base64, <= CHUNK_DECODED_BYTES decoded per chunk,
// sent over the existing authenticated JSON WebSocket with an ack window.

const B64_CHUNK = 0x8000; // 32 KiB — safe btoa/atob string-arg chunk size

/** Decoded bytes per transfer_chunk (3 MiB encoded ~4 MiB — under port limits). */
export const CHUNK_DECODED_BYTES = 3 * 1024 * 1024;
/** Max unacked transfer_chunk frames a sender keeps in flight. */
export const ACK_WINDOW = 4;
/** Max decoded bytes per transfer_chunk_pull reply (keeps port messages small). */
export const MAX_PULL_SLICE_BYTES = 1024 * 1024;
/** Internal transfer deadline (hub request timeout is 300 s). */
export const TRANSFER_DEADLINE_MS = 290_000;

export const TRANSFER_FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const TRANSFER_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

// ---------------------------------------------------------------------------
// Base64 + hashing
// ---------------------------------------------------------------------------

export function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += B64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + B64_CHUNK));
  }
  return btoa(binary);
}

function isB64CharCode(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 47;
}

// Linear scan — a single regex over multi-MiB strings overflows V8's stack.
function isCanonicalBase64String(encoded: string): boolean {
  const len = encoded.length;
  if (len === 0) return true;
  if (len % 4 !== 0) return false;
  const last = encoded.charCodeAt(len - 1);
  if (last === 61 /* '=' */) {
    const secondLast = encoded.charCodeAt(len - 2);
    if (secondLast === 61) {
      if (len < 4 || !isB64CharCode(encoded.charCodeAt(len - 3))) return false;
    } else if (!isB64CharCode(secondLast)) {
      return false;
    }
  } else if (last !== 43 && last !== 47 && !isB64CharCode(last)) {
    return false;
  }
  // Padding (if any) is confined to the final group by the checks above; verify
  // no '=' appears earlier by scanning everything before the final group.
  const limit = last === 61 ? (encoded.charCodeAt(len - 2) === 61 ? len - 4 : len - 2) : len;
  for (let i = 0; i < limit; i++) {
    if (!isB64CharCode(encoded.charCodeAt(i))) return false;
  }
  return true;
}

export function decodeBase64(encoded: string): Uint8Array {
  if (!isCanonicalBase64String(encoded)) throw new Error('INVALID_BASE64');
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function isCanonicalBase64(value: unknown): value is string {
  return typeof value === 'string' && isCanonicalBase64String(value)
    && decodeBase64Length(value) <= CHUNK_DECODED_BYTES;
}

function decodeBase64Length(encoded: string): number {
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  return Math.floor(encoded.length / 4) * 3 - padding;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function concatBytes(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0]!;
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** basename + control-char strip; returns fallback when the result is not spec-valid. */
export function sanitizeTransferFilename(raw: string | undefined, fallback: string): string {
  const base = (raw ?? '').split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '');
  if (TRANSFER_FILENAME_RE.test(cleaned)) return cleaned;
  const fb = fallback.replace(/[\u0000-\u001f\u007f]/g, '');
  return TRANSFER_FILENAME_RE.test(fb) ? fb : 'download';
}

// ---------------------------------------------------------------------------
// Wire message guards (exact-key style of protocol.ts)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === allowed.length && keys.every((key) => allowed.includes(key));
}

function isInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function isBoundedText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

export interface TransferChunkMessage {
  type: 'transfer_chunk';
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

export function isTransferChunk(value: unknown): value is TransferChunkMessage {
  if (!isRecord(value)) return false;
  if (!hasExactKeys(value, [
    'type', 'v', 'transferId', 'requestId', 'seq', 'totalChunks', 'totalBytes',
    'sha256', 'filename', 'mimeType', 'bytesBase64',
  ])) return false;
  return (
    value.type === 'transfer_chunk'
    && value.v === 2
    && typeof value.transferId === 'string' && TRANSFER_ID_RE.test(value.transferId)
    && typeof value.requestId === 'string' && TRANSFER_ID_RE.test(value.requestId)
    && isInt(value.seq) && isInt(value.totalChunks) && isInt(value.totalBytes)
    && value.totalChunks >= 1
    && value.totalBytes >= 0
    && value.seq >= 0 && value.seq < value.totalChunks
    && typeof value.sha256 === 'string' && SHA256_RE.test(value.sha256)
    && typeof value.filename === 'string' && TRANSFER_FILENAME_RE.test(value.filename)
    && isBoundedText(value.mimeType, 127)
    && isCanonicalBase64(value.bytesBase64)
  );
}

export interface TransferAckMessage {
  type: 'transfer_ack';
  transferId: string;
  seq: number;
  ok: boolean;
  code?: string;
  message?: string;
}

export function isTransferAck(value: unknown): value is TransferAckMessage {
  if (!isRecord(value)) return false;
  const failure = hasExactKeys(value, ['type', 'transferId', 'seq', 'ok', 'code', 'message']);
  const success = hasExactKeys(value, ['type', 'transferId', 'seq', 'ok']);
  if (!failure && !success) return false;
  return (
    value.type === 'transfer_ack'
    && typeof value.transferId === 'string' && TRANSFER_ID_RE.test(value.transferId)
    && isInt(value.seq) && value.seq >= 0
    && typeof value.ok === 'boolean'
    && (value.ok || (typeof value.code === 'string' && value.code.length > 0 && typeof value.message === 'string'))
  );
}

export interface TransferBeginMessage {
  type: 'transfer_begin';
  v: 2;
  transferId: string;
  requestId: string;
  direction: 'upload';
  fileIndex: number;
  fileCount: number;
  filename: string;
  mimeType: string;
  totalBytes: number;
  totalChunks: number;
  sha256: string;
  targetTabId: number;
  selector: string;
}

export function isTransferBegin(value: unknown): value is TransferBeginMessage {
  if (!isRecord(value)) return false;
  if (!hasExactKeys(value, [
    'type', 'v', 'transferId', 'requestId', 'direction', 'fileIndex', 'fileCount',
    'filename', 'mimeType', 'totalBytes', 'totalChunks', 'sha256', 'targetTabId', 'selector',
  ])) return false;
  return (
    value.type === 'transfer_begin'
    && value.v === 2
    && value.direction === 'upload'
    && typeof value.transferId === 'string' && TRANSFER_ID_RE.test(value.transferId)
    && typeof value.requestId === 'string' && TRANSFER_ID_RE.test(value.requestId)
    && isInt(value.fileIndex) && isInt(value.fileCount)
    && value.fileCount >= 1
    && value.fileIndex >= 0 && value.fileIndex < value.fileCount
    && typeof value.filename === 'string' && TRANSFER_FILENAME_RE.test(value.filename)
    && isBoundedText(value.mimeType, 127)
    && isInt(value.totalChunks) && isInt(value.totalBytes)
    && value.totalChunks >= 1
    && value.totalBytes >= 0
    && typeof value.sha256 === 'string' && SHA256_RE.test(value.sha256)
    && isInt(value.targetTabId) && value.targetTabId >= 0
    && isBoundedText(value.selector, 512)
  );
}
