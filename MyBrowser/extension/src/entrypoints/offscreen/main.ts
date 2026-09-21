// Offscreen document: owns the WebSocket connection to the MCP server.
// This document persists independently of the service worker and maintains
// the WS connection 24/7.
//
// Communication with the background SW uses a persistent port (chrome.runtime.connect).
// A port connection WAKES the SW and KEEPS it alive for as long as the port is open.
// Falls back to one-shot sendMessage if the port is unavailable.

import { ReconnectingWebSocket } from '../../lib/reconnecting-ws';
import { sendToBackground } from '../../lib/messaging';
import { PendingToolRequests } from '../../lib/offscreen-pending';
import type { WsStatusResponse } from '../../lib/protocol';
import { createOffscreenToolFrame } from '../../lib/telemetry-summary';
import { createTemporaryTabReconciliationCallbacks } from '../../lib/temporary-tab-reconciliation';
import {
  ACK_WINDOW,
  CHUNK_DECODED_BYTES,
  MAX_PULL_SLICE_BYTES,
  TRANSFER_DEADLINE_MS,
  concatBytes,
  decodeBase64,
  encodeBase64,
  isTransferAck,
  isTransferBegin,
  isTransferChunk,
  sanitizeTransferFilename,
  sha256Hex,
  type TransferAckMessage,
  type TransferChunkMessage,
} from '../../lib/transfer-shared';

const ws = new ReconnectingWebSocket();
const pendingToolRequests = new PendingToolRequests();
let lastConfig: { url: string; token: string; browserName?: string } | null = null;

// ---------------------------------------------------------------------------
// Persistent port to background SW
// ---------------------------------------------------------------------------

let port: chrome.runtime.Port | null = null;
let portRetryDelay = 200;
let backgroundPortWasLost = false;
const PORT_MAX_RETRY_DELAY = 10_000;

function ensurePort(): chrome.runtime.Port | null {
  if (port) return port;
  try {
    port = chrome.runtime.connect({ name: 'offscreen' });
  } catch {
    schedulePortRetry();
    return null;
  }
  portRetryDelay = 200; // Reset backoff on successful connect
  if (backgroundPortWasLost) {
    backgroundPortWasLost = false;
    if (ws.getState() === 'CONNECTED') {
      void postToBackground({ type: '_os_disconnected' });
      ws.forceReconnect();
    }
  }
  port.onDisconnect.addListener(() => {
    try {
      if (ws.getState() === 'CONNECTED') {
        pendingToolRequests.failAll((raw) => ws.send(raw));
      }
    } finally {
      port = null;
      backgroundPortWasLost = true;
      schedulePortRetry();
    }
  });
  port.onMessage.addListener(handleBackgroundMessage);
  return port;
}

function schedulePortRetry(): void {
  setTimeout(() => {
    ensurePort();
  }, portRetryDelay);
  portRetryDelay = Math.min(portRetryDelay * 2, PORT_MAX_RETRY_DELAY);
}

/**
 * Send a message to the background SW via port, falling back to sendMessage.
 */
async function postToBackground(message: Record<string, unknown>): Promise<void> {
  // Try port first
  const p = ensurePort();
  if (p) {
    try {
      p.postMessage(message);
      return;
    } catch {
      port = null;
    }
  }
  // Fallback: sendMessage (also wakes SW, just less reliably)
  try {
    await chrome.runtime.sendMessage(message);
  } catch {
    // SW truly unreachable — nothing we can do
  }
}

// ---------------------------------------------------------------------------
// Handle messages from background SW (via port)
// ---------------------------------------------------------------------------

function handleMessage(message: { type: string; payload?: unknown; _replyId?: string }, reply: (data: unknown) => void): void {
  if (message.type === '_os_ws_connect') {
    const { url, token, browserName } = message.payload as { url: string; token: string; browserName?: string };
    if (
      ws.getState() === 'CONNECTED' &&
      lastConfig?.url === url &&
      lastConfig?.token === token &&
      lastConfig?.browserName === browserName
    ) {
      reply({ ok: true, already: true });
      return;
    }
    connectWithConfig(url, token, browserName);
    reply({ ok: true });
    return;
  }

  if (message.type === '_os_ws_send') {
    try {
      const raw = message.payload as string;
      pendingToolRequests.completeOutbound(raw);
      ws.send(raw);
      reply({ ok: true });
    } catch (e) {
      reply({ ok: false, error: (e as Error).message });
    }
    return;
  }

  if (message.type === '_os_ws_status') {
    reply({ state: ws.getState() } satisfies WsStatusResponse);
    return;
  }

  if (message.type === '_os_ws_reconnect') {
    if (lastConfig) {
      ws.forceReconnect();
    }
    reply({ ok: true });
    return;
  }

  if (message.type === '_os_ws_disconnect') {
    ws.disconnect();
    reply({ ok: true });
    return;
  }

  if (message.type === 'transfer_fetch_start') {
    void runTransferFetch((message.payload ?? {}) as Record<string, unknown>);
    reply({ ok: true });
    return;
  }

  if (message.type === 'transfer_chunk_pull') {
    reply(pullUploadSlice((message.payload ?? {}) as Record<string, unknown>));
    return;
  }

  if (message.type === 'transfer_upload_done') {
    const { transferId } = (message.payload ?? {}) as { transferId?: string };
    if (typeof transferId === 'string') uploads.delete(transferId);
    reply({ ok: true });
    return;
  }

  if (message.type === '_os_ping') {
    reply({ alive: true, wsState: ws.getState() });
    return;
  }
}

// Port path: reply via port postMessage
function handleBackgroundMessage(message: { type: string; payload?: unknown; _replyId?: string }): void {
  const replyId = message._replyId;
  handleMessage(message, (data) => {
    if (replyId) {
      const p = ensurePort();
      if (p) {
        try { p.postMessage({ type: '_os_reply', _replyId: replyId, payload: data }); } catch { /* port died */ }
      }
    }
  });
}

// sendMessage path: reply via sendResponse
chrome.runtime.onMessage.addListener(
  (message: { type: string; payload?: unknown }, _sender, sendResponse) => {
    handleMessage(message, sendResponse);
    return false;
  },
);

// ---------------------------------------------------------------------------
// WS connection
// ---------------------------------------------------------------------------

function connectWithConfig(url: string, token: string, browserName?: string): void {
  lastConfig = { url, token, browserName };
  ws.connect(url, token, {
    ...createTemporaryTabReconciliationCallbacks({
      requestSessions: () => sendToBackground('_os_temp_tab_sessions'),
      post: postToBackground,
    }),
    onDisconnected() {
      postToBackground({ type: '_os_disconnected' });
    },
    onMessage(data: string) {
      if (handleTransferFrame(data)) return;
      const traced = pendingToolRequests.trackInbound(data);
      postToBackground({
        type: '_os_ws_receive',
        payload: traced ? createOffscreenToolFrame(data) : data,
      });
    },
  }, browserName);
}

// ---------------------------------------------------------------------------
// File transfers
// ---------------------------------------------------------------------------

interface UploadEntry {
  requestId: string;
  filename: string;
  mimeType: string;
  totalBytes: number;
  totalChunks: number;
  sha256: string;
  targetTabId: number;
  selector: string;
  fileIndex: number;
  fileCount: number;
  parts: Uint8Array[];
  received: number;
  nextSeq: number;
  file: Uint8Array | null;
}

const uploads = new Map<string, UploadEntry>();
// Ack sinks for outbound fetch transfers, keyed by transferId.
const fetchAckSinks = new Map<string, (ack: TransferAckMessage) => void>();

/** Consumes transfer_* WS frames; returns true when the frame was handled here. */
function handleTransferFrame(data: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return false;
  }
  if (isTransferAck(parsed)) {
    fetchAckSinks.get(parsed.transferId)?.(parsed);
    return true;
  }
  if (isTransferBegin(parsed)) {
    if (!uploads.has(parsed.transferId)) {
      uploads.set(parsed.transferId, {
        requestId: parsed.requestId,
        filename: parsed.filename,
        mimeType: parsed.mimeType,
        totalBytes: parsed.totalBytes,
        totalChunks: parsed.totalChunks,
        sha256: parsed.sha256,
        targetTabId: parsed.targetTabId,
        selector: parsed.selector,
        fileIndex: parsed.fileIndex,
        fileCount: parsed.fileCount,
        parts: [],
        received: 0,
        nextSeq: 0,
        file: null,
      });
    }
    return true;
  }
  if (isTransferChunk(parsed)) {
    void handleUploadChunk(parsed);
    return true;
  }
  return false;
}

function sendTransferAck(ack: { transferId: string; seq: number; ok: boolean; code?: string; message?: string }): void {
  const frame = {
    type: 'transfer_ack',
    transferId: ack.transferId,
    seq: ack.seq,
    ok: ack.ok,
    ...(ack.ok ? {} : { code: ack.code ?? 'TRANSFER_FAILED', message: ack.message ?? '' }),
  };
  try {
    ws.send(JSON.stringify(frame));
  } catch {
    // WS down — the hub-side sender times out / aborts on missing acks
  }
}

function failUpload(transferId: string, entry: UploadEntry, seq: number, code: string, message: string): void {
  uploads.delete(transferId);
  sendTransferAck({ transferId, seq, ok: false, code, message });
  void postToBackground({
    type: 'transfer_upload_failed',
    payload: {
      transferId,
      requestId: entry.requestId,
      error: `${code}: ${message}`,
    },
  });
}

async function handleUploadChunk(chunk: TransferChunkMessage): Promise<void> {
  const entry = uploads.get(chunk.transferId);
  if (!entry) {
    sendTransferAck({
      transferId: chunk.transferId, seq: chunk.seq, ok: false,
      code: 'TRANSFER_UNKNOWN', message: 'No begin for transfer',
    });
    return;
  }
  if (chunk.seq !== entry.nextSeq) {
    failUpload(chunk.transferId, entry, chunk.seq, 'TRANSFER_OUT_OF_ORDER', `Expected seq ${entry.nextSeq}`);
    return;
  }
  let bytes: Uint8Array;
  try {
    bytes = decodeBase64(chunk.bytesBase64);
  } catch {
    failUpload(chunk.transferId, entry, chunk.seq, 'TRANSFER_BAD_ENCODING', 'bytesBase64 is not canonical');
    return;
  }
  if (bytes.length > CHUNK_DECODED_BYTES || entry.received + bytes.length > entry.totalBytes) {
    failUpload(chunk.transferId, entry, chunk.seq, 'TRANSFER_TOO_LARGE', 'Chunk or total size exceeds declared bounds');
    return;
  }
  entry.parts.push(bytes);
  entry.received += bytes.length;
  entry.nextSeq++;
  if (entry.nextSeq < entry.totalChunks) {
    sendTransferAck({ transferId: chunk.transferId, seq: chunk.seq, ok: true });
    return;
  }
  // Final chunk: verify sha256 + size BEFORE acking.
  const file = concatBytes(entry.parts);
  const hex = await sha256Hex(file);
  if (entry.received !== entry.totalBytes) {
    failUpload(chunk.transferId, entry, chunk.seq, 'TRANSFER_SIZE_MISMATCH', `Received ${entry.received} of ${entry.totalBytes}`);
    return;
  }
  if (hex !== entry.sha256) {
    failUpload(chunk.transferId, entry, chunk.seq, 'TRANSFER_SHA256_MISMATCH', 'Reassembled file hash mismatch');
    return;
  }
  entry.file = file;
  entry.parts = [];
  sendTransferAck({ transferId: chunk.transferId, seq: chunk.seq, ok: true });
  void postToBackground({
    type: 'transfer_upload_ready',
    payload: {
      transferId: chunk.transferId,
      requestId: entry.requestId,
      targetTabId: entry.targetTabId,
      selector: entry.selector,
      fileIndex: entry.fileIndex,
      fileCount: entry.fileCount,
      filename: entry.filename,
      mimeType: entry.mimeType,
      totalBytes: entry.totalBytes,
      totalChunks: entry.totalChunks,
    },
  });
}

function pullUploadSlice(payload: Record<string, unknown>): { ok: boolean; bytesBase64?: string; error?: string } {
  const { transferId, seq, offset, length } = payload as {
    transferId?: unknown; seq?: unknown; offset?: unknown; length?: unknown;
  };
  if (typeof transferId !== 'string' || !Number.isInteger(seq) || !Number.isInteger(offset)
    || !Number.isInteger(length) || (length as number) < 1 || (length as number) > MAX_PULL_SLICE_BYTES) {
    return { ok: false, error: 'TRANSFER_PULL_BAD_ARGS' };
  }
  const entry = uploads.get(transferId);
  if (!entry?.file) return { ok: false, error: 'TRANSFER_UNKNOWN' };
  if ((seq as number) < 0 || (seq as number) >= entry.totalChunks) return { ok: false, error: 'TRANSFER_OUT_OF_RANGE' };
  const start = (seq as number) * CHUNK_DECODED_BYTES + (offset as number);
  if (start < 0 || start >= entry.file.length) return { ok: false, error: 'TRANSFER_OUT_OF_RANGE' };
  const end = Math.min(start + (length as number), entry.file.length);
  return { ok: true, bytesBase64: encodeBase64(entry.file.subarray(start, end)) };
}

function urlBasename(url: string): string {
  try {
    const segment = new URL(url).pathname.split('/').filter(Boolean).pop() ?? '';
    return decodeURIComponent(segment);
  } catch {
    return '';
  }
}

async function runTransferFetch(request: Record<string, unknown>): Promise<void> {
  const transferId = typeof request.transferId === 'string' ? request.transferId : '';
  if (!transferId) return;
  const requestId = typeof request.requestId === 'string' ? request.requestId : '';
  const url = typeof request.url === 'string' ? request.url : '';
  const done = (ok: boolean, extra: Record<string, unknown>): void => {
    void postToBackground({ type: 'transfer_fetch_done', payload: { transferId, ok, ...extra } });
  };
  if (!url) {
    done(false, { error: 'transfer_fetch_start: missing url' });
    return;
  }
  const deadline = Date.now() + TRANSFER_DEADLINE_MS;
  try {
    const response = await fetch(url, { credentials: 'include', redirect: 'follow' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (!response.body) throw new Error('TRANSFER_NO_BODY');
    const mimeType = (response.headers.get('content-type') ?? '').split(';', 1)[0]?.trim() || 'application/octet-stream';
    const filename = sanitizeTransferFilename(
      typeof request.filename === 'string' ? request.filename : undefined,
      urlBasename(url),
    );

    // totalBytes/totalChunks must be known upfront, so buffer the streamed body.
    const parts: Uint8Array[] = [];
    let total = 0;
    const reader = response.body.getReader();
    for (;;) {
      if (Date.now() > deadline) throw new Error('TRANSFER_TIMEOUT');
      const { done: streamDone, value } = await reader.read();
      if (streamDone) break;
      if (value && value.length > 0) {
        parts.push(value);
        total += value.length;
      }
    }
    const file = concatBytes(parts);
    const sha256 = await sha256Hex(file);
    const totalChunks = Math.max(1, Math.ceil(total / CHUNK_DECODED_BYTES));

    await sendChunksWithAcks({
      transferId, requestId, file, total, totalChunks, sha256, filename, mimeType, deadline,
    });
    done(true, { bytesSent: total });
  } catch (e) {
    done(false, { error: (e as Error)?.message || 'TRANSFER_FAILED' });
  }
}

async function sendChunksWithAcks(args: {
  transferId: string;
  requestId: string;
  file: Uint8Array;
  total: number;
  totalChunks: number;
  sha256: string;
  filename: string;
  mimeType: string;
  deadline: number;
}): Promise<void> {
  const acked = new Set<number>();
  const wake = new Map<number, () => void>();
  let abortError: string | null = null;
  const sink = (ack: TransferAckMessage): void => {
    if (ack.ok) {
      acked.add(ack.seq);
      wake.get(ack.seq)?.();
      wake.delete(ack.seq);
      return;
    }
    abortError = `${ack.code ?? 'TRANSFER_REJECTED'}${ack.message ? `: ${ack.message}` : ''}`;
    for (const w of wake.values()) w();
    wake.clear();
  };
  fetchAckSinks.set(args.transferId, sink);
  try {
    let sendCursor = 0;
    let ackCursor = 0;
    while (ackCursor < args.totalChunks) {
      if (abortError) throw new Error(abortError);
      if (Date.now() > args.deadline) throw new Error('TRANSFER_TIMEOUT');
      // Keep at most ACK_WINDOW chunks in flight.
      while (sendCursor < args.totalChunks && sendCursor - ackCursor < ACK_WINDOW) {
        const seq = sendCursor++;
        const slice = args.file.subarray(
          seq * CHUNK_DECODED_BYTES,
          Math.min((seq + 1) * CHUNK_DECODED_BYTES, args.total),
        );
        const frame = {
          type: 'transfer_chunk',
          v: 2,
          transferId: args.transferId,
          requestId: args.requestId,
          seq,
          totalChunks: args.totalChunks,
          totalBytes: args.total,
          sha256: args.sha256,
          filename: args.filename,
          mimeType: args.mimeType,
          bytesBase64: encodeBase64(slice),
        };
        ws.send(JSON.stringify(frame));
      }
      if (acked.has(ackCursor)) {
        ackCursor++;
        continue;
      }
      // Wake on the matching ack OR at the deadline (loop re-checks and throws).
      const timer = setTimeout(() => wake.get(ackCursor)?.(), Math.max(1, args.deadline - Date.now()));
      await new Promise<void>((resolve) => wake.set(ackCursor, resolve));
      clearTimeout(timer);
    }
  } finally {
    fetchAckSinks.delete(args.transferId);
  }
}

// ---------------------------------------------------------------------------
// Init: open port and tell background we're ready
// ---------------------------------------------------------------------------

ensurePort();
postToBackground({ type: '_os_ready' });
