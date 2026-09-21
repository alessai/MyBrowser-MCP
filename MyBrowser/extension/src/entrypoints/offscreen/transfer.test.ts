import { createHash } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { vi as vitestVi } from 'vitest';

import { CHUNK_DECODED_BYTES, encodeBase64 } from '../../lib/transfer-shared';
import { PROTOCOL_VERSION } from '../../lib/protocol';

type PortListener = (message: { type: string; payload?: unknown; _replyId?: string }) => void;

interface FakeSocket {
  url: string;
  readyState: number;
  sent: string[];
  onopen: (() => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  send(data: string): void;
  close(): void;
}

const sockets: FakeSocket[] = [];
let active: FakeSocket | null = null;
const portPost: Record<string, unknown>[] = [];
let portListener: PortListener | null = null;
const portOffscreen = {
  name: 'offscreen',
  postMessage: vitestVi.fn((message: Record<string, unknown>) => {
    portPost.push(message);
  }),
  onMessage: { addListener: vitestVi.fn((l: PortListener) => { portListener = l; }) },
  onDisconnect: { addListener: vitestVi.fn() },
};

class FakeWebSocket implements FakeSocket {
  url: string;
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(url: string) {
    this.url = url;
    sockets.push(this);
  }
  send(data: string): void {
    if (this.readyState !== 1) throw new Error('WebSocket is not connected');
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
  }
}

function fill(bytes: Uint8Array, seed: number): Uint8Array {
  let state = seed >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    bytes[i] = state & 0xff;
  }
  return bytes;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function socket(): FakeSocket {
  if (!active) throw new Error('no socket');
  return active;
}

function sentFrames(): Record<string, unknown>[] {
  return socket().sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
}

function deliver(obj: Record<string, unknown>): void {
  socket().onmessage?.({ data: JSON.stringify(obj) });
}

async function connectWs(): Promise<void> {
  portListener?.({ type: '_os_ws_connect', payload: { url: 'ws://hub:9009', token: 'tok' } });
  const s = sockets.at(-1);
  if (!s) throw new Error('no socket after connect');
  active = s;
  s.readyState = 1;
  s.onopen?.();
  await vi.waitFor(() => expect(s.sent.some((f) => JSON.parse(f).type === 'auth')).toBe(true));
  s.onmessage?.({ data: JSON.stringify({ type: 'auth', status: 'ok', protocolVersion: PROTOCOL_VERSION }) });
}

function stubGlobals(): void {
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal('chrome', {
    runtime: {
      id: 'ext-1',
      connect: vitestVi.fn(() => portOffscreen),
      sendMessage: vitestVi.fn(async () => undefined),
      onMessage: { addListener: vitestVi.fn() },
      getURL: (p: string) => `chrome-extension://ext-1${p}`,
    },
    storage: { local: { get: vitestVi.fn(async () => ({})) } },
  });
}

beforeAll(async () => {
  stubGlobals();
  await import('./main');
  await connectWs(); // one shared CONNECTED socket; tests only clear frame buffers
});

beforeEach(() => {
  stubGlobals(); // afterEach unstubs; the module looks up WebSocket/chrome at call time
  portPost.length = 0;
  portOffscreen.postMessage.mockClear();
  if (active) active.sent = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllGlobals();
});

describe('offscreen transfer_fetch_start', () => {
  it('streams chunks in order with correct metadata and finishes with bytesSent', async () => {
    const file = fill(new Uint8Array(CHUNK_DECODED_BYTES * 3 + 5), 1); // 4 chunks
    vi.stubGlobal('fetch', vitestVi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: (k: string) => (k === 'content-type' ? 'application/pdf; charset=binary' : null) },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          for (let i = 0; i < file.length; i += CHUNK_DECODED_BYTES) {
            controller.enqueue(file.subarray(i, Math.min(i + CHUNK_DECODED_BYTES, file.length)));
          }
          controller.close();
        },
      }),
    })));

    portListener?.({
      type: 'transfer_fetch_start',
      payload: { transferId: 'f1', requestId: 'req-1', url: 'https://example.com/dir/report.pdf', filename: 'report.pdf' },
    });

    await vi.waitFor(() => expect(sentFrames().filter((f) => f.type === 'transfer_chunk').length).toBe(4));
    const chunks = sentFrames().filter((f) => f.type === 'transfer_chunk');
    expect(chunks.map((c) => c.seq)).toEqual([0, 1, 2, 3]);
    for (const [i, chunk] of chunks.entries()) {
      expect(chunk).toMatchObject({
        type: 'transfer_chunk', v: 2, transferId: 'f1', requestId: 'req-1',
        totalChunks: 4, totalBytes: file.length, sha256: sha256(file),
        filename: 'report.pdf', mimeType: 'application/pdf',
      });
      const slice = file.subarray(i * CHUNK_DECODED_BYTES, Math.min((i + 1) * CHUNK_DECODED_BYTES, file.length));
      expect(chunk.bytesBase64).toBe(encodeBase64(slice));
    }

    for (let seq = 0; seq < 4; seq++) deliver({ type: 'transfer_ack', transferId: 'f1', seq, ok: true });

    await vi.waitFor(() => expect(
      portPost.some((m) => m.type === 'transfer_fetch_done' && (m.payload as { transferId?: string })?.transferId === 'f1'),
    ).toBe(true));
    expect(portPost.find((m) => m.type === 'transfer_fetch_done')).toMatchObject({
      type: 'transfer_fetch_done', payload: { transferId: 'f1', ok: true, bytesSent: file.length },
    });
  });

  it('keeps at most ACK_WINDOW chunks in flight', async () => {
    const file = fill(new Uint8Array(CHUNK_DECODED_BYTES * 10), 2); // 10 chunks
    vi.stubGlobal('fetch', vitestVi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'application/octet-stream' },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(file);
          controller.close();
        },
      }),
    })));

    portListener?.({
      type: 'transfer_fetch_start',
      payload: { transferId: 'f2', requestId: 'req-2', url: 'https://example.com/big.bin' },
    });

    await vi.waitFor(() => expect(sentFrames().filter((f) => f.type === 'transfer_chunk').length).toBe(4));
    expect(sentFrames().filter((f) => f.type === 'transfer_chunk').length).toBe(4);

    // Ack 0..3 -> 4 more chunks sent (8 total, still <= window)
    for (let seq = 0; seq < 4; seq++) deliver({ type: 'transfer_ack', transferId: 'f2', seq, ok: true });
    await vi.waitFor(() => expect(sentFrames().filter((f) => f.type === 'transfer_chunk').length).toBe(8));
    // Ack 4..7 -> final 2 chunks (10 total)
    for (let seq = 4; seq < 8; seq++) deliver({ type: 'transfer_ack', transferId: 'f2', seq, ok: true });
    await vi.waitFor(() => expect(sentFrames().filter((f) => f.type === 'transfer_chunk').length).toBe(10));
    for (let seq = 8; seq < 10; seq++) deliver({ type: 'transfer_ack', transferId: 'f2', seq, ok: true });
    await vi.waitFor(() => expect(
      portPost.some((m) => m.type === 'transfer_fetch_done' && (m.payload as { ok?: boolean })?.ok === true),
    ).toBe(true));
  });

  it('aborts on a failed ack and reports transfer_fetch_done ok:false', async () => {
    const file = fill(new Uint8Array(CHUNK_DECODED_BYTES * 2), 3);
    vi.stubGlobal('fetch', vitestVi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(file); c.close(); } }),
    })));

    portListener?.({
      type: 'transfer_fetch_start',
      payload: { transferId: 'f3', requestId: 'req-3', url: 'https://example.com/x.bin' },
    });
    await vi.waitFor(() => expect(sentFrames().filter((f) => f.type === 'transfer_chunk').length).toBe(2));
    deliver({ type: 'transfer_ack', transferId: 'f3', seq: 0, ok: false, code: 'TRANSFER_TOO_LARGE', message: 'nope' });

    await vi.waitFor(() => expect(
      portPost.some((m) => m.type === 'transfer_fetch_done' && (m.payload as { transferId?: string })?.transferId === 'f3'),
    ).toBe(true));
    expect(portPost.find((m) => m.type === 'transfer_fetch_done')).toMatchObject({
      payload: { transferId: 'f3', ok: false },
    });
    expect(String((portPost.find((m) => m.type === 'transfer_fetch_done') as { payload?: { error?: string } }).payload?.error))
      .toContain('TRANSFER_TOO_LARGE');
    // no further chunks after abort
    expect(sentFrames().filter((f) => f.type === 'transfer_chunk').length).toBe(2);
  });

  it('fails fast on a non-ok HTTP response', async () => {
    vi.stubGlobal('fetch', vitestVi.fn(async () => ({ ok: false, status: 403, headers: { get: () => null } })));
    portListener?.({
      type: 'transfer_fetch_start',
      payload: { transferId: 'f4', requestId: 'req-4', url: 'https://example.com/forbidden' },
    });
    await vi.waitFor(() => expect(
      portPost.some((m) => m.type === 'transfer_fetch_done' && (m.payload as { transferId?: string })?.transferId === 'f4'),
    ).toBe(true));
    expect(portPost.find((m) => m.type === 'transfer_fetch_done')).toMatchObject({
      payload: { transferId: 'f4', ok: false, error: 'HTTP 403' },
    });
  });

  it('propagates fetch rejection to transfer_fetch_done', async () => {
    vi.stubGlobal('fetch', vitestVi.fn(async () => {
      throw new Error('network down');
    }));
    portListener?.({
      type: 'transfer_fetch_start',
      payload: { transferId: 'f5', requestId: 'req-5', url: 'https://example.com/dead' },
    });
    await vi.waitFor(() => expect(
      portPost.some((m) => m.type === 'transfer_fetch_done' && (m.payload as { transferId?: string })?.transferId === 'f5'),
    ).toBe(true));
    expect(portPost.find((m) => m.type === 'transfer_fetch_done')).toMatchObject({
      payload: { transferId: 'f5', ok: false, error: 'network down' },
    });
  });
});

describe('offscreen upload reassembly', () => {
  function begin(id: string, totalBytes: number, totalChunks: number, sha: string): void {
    deliver({
      type: 'transfer_begin', v: 2, transferId: id, requestId: `req-${id}`, direction: 'upload',
      fileIndex: 0, fileCount: 1, filename: 'photo.jpg', mimeType: 'image/jpeg',
      totalBytes, totalChunks, sha256: sha, targetTabId: 7, selector: 'input[type=file]',
    });
  }

  function chunk(id: string, seq: number, bytes: Uint8Array): void {
    deliver({
      type: 'transfer_chunk', v: 2, transferId: id, requestId: `req-${id}`, seq,
      totalChunks: Math.max(1, Math.ceil(bytes.length / CHUNK_DECODED_BYTES)) * 0 + 2,
      totalBytes: bytes.length * 2,
      sha256: 'f'.repeat(64), filename: 'photo.jpg', mimeType: 'image/jpeg',
      bytesBase64: encodeBase64(bytes),
    });
  }

  it('acks chunks, verifies sha256, notifies transfer_upload_ready, serves chunk pulls', async () => {
    const part0 = fill(new Uint8Array(CHUNK_DECODED_BYTES), 4);
    const part1 = fill(new Uint8Array(11), 5);
    const whole = new Uint8Array([...part0, ...part1]);

    begin('u1', whole.length, 2, sha256(whole));
    deliver({
      type: 'transfer_chunk', v: 2, transferId: 'u1', requestId: 'req-u1', seq: 0,
      totalChunks: 2, totalBytes: whole.length, sha256: sha256(whole),
      filename: 'photo.jpg', mimeType: 'image/jpeg', bytesBase64: encodeBase64(part0),
    });
    await vi.waitFor(() => expect(
      sentFrames().some((f) => f.type === 'transfer_ack' && f.seq === 0 && f.ok === true),
    ).toBe(true));

    deliver({
      type: 'transfer_chunk', v: 2, transferId: 'u1', requestId: 'req-u1', seq: 1,
      totalChunks: 2, totalBytes: whole.length, sha256: sha256(whole),
      filename: 'photo.jpg', mimeType: 'image/jpeg', bytesBase64: encodeBase64(part1),
    });

    await vi.waitFor(() => expect(
      portPost.some((m) => m.type === 'transfer_upload_ready' && (m.payload as { transferId?: string })?.transferId === 'u1'),
    ).toBe(true));
    expect(portPost.find((m) => m.type === 'transfer_upload_ready')).toMatchObject({
      payload: {
        transferId: 'u1', requestId: 'req-u1', targetTabId: 7, selector: 'input[type=file]',
        fileIndex: 0, fileCount: 1, filename: 'photo.jpg', mimeType: 'image/jpeg',
        totalBytes: whole.length, totalChunks: 2,
      },
    });
    expect(sentFrames().some((f) => f.type === 'transfer_ack' && f.seq === 1 && f.ok === true)).toBe(true);

    // Pull slices: start of chunk 0, mid-chunk 1, clamped tail
    portListener?.({ type: 'transfer_chunk_pull', payload: { transferId: 'u1', seq: 0, offset: 0, length: 16 }, _replyId: 'r1' });
    portListener?.({ type: 'transfer_chunk_pull', payload: { transferId: 'u1', seq: 1, offset: 4, length: 4 }, _replyId: 'r2' });
    portListener?.({ type: 'transfer_chunk_pull', payload: { transferId: 'u1', seq: 1, offset: 8, length: 100 }, _replyId: 'r3' });

    await vi.waitFor(() => expect(portPost.filter((m) => m.type === '_os_reply').length).toBe(3));
    const replies = portPost.filter((m) => m.type === '_os_reply');
    expect(replies[0]).toMatchObject({ _replyId: 'r1' });
    expect((replies[0]!.payload as { bytesBase64: string }).bytesBase64)
      .toBe(encodeBase64(whole.subarray(0, 16)));
    expect((replies[1]!.payload as { bytesBase64: string }).bytesBase64)
      .toBe(encodeBase64(whole.subarray(CHUNK_DECODED_BYTES + 4, CHUNK_DECODED_BYTES + 8)));
    expect((replies[2]!.payload as { bytesBase64: string }).bytesBase64)
      .toBe(encodeBase64(whole.subarray(CHUNK_DECODED_BYTES + 8)));

    // Release frees the entry
    portListener?.({ type: 'transfer_upload_done', payload: { transferId: 'u1' }, _replyId: 'r4' });
    portListener?.({ type: 'transfer_chunk_pull', payload: { transferId: 'u1', seq: 0, offset: 0, length: 4 }, _replyId: 'r5' });
    await vi.waitFor(() => expect(portPost.filter((m) => m.type === '_os_reply').length).toBe(5));
    expect((portPost.find((m) => m.type === '_os_reply' && m._replyId === 'r5') as { payload: { ok: boolean } }).payload.ok)
      .toBe(false);
  });

  it('rejects out-of-order chunks and notifies transfer_upload_failed', async () => {
    begin('u2', 10, 2, sha256(new Uint8Array(10)));
    deliver({
      type: 'transfer_chunk', v: 2, transferId: 'u2', requestId: 'req-u2', seq: 1,
      totalChunks: 2, totalBytes: 10, sha256: sha256(new Uint8Array(10)),
      filename: 'photo.jpg', mimeType: 'image/jpeg', bytesBase64: encodeBase64(new Uint8Array(5)),
    });
    await vi.waitFor(() => expect(
      sentFrames().some((f) => f.type === 'transfer_ack' && f.ok === false),
    ).toBe(true));
    expect(sentFrames().find((f) => f.type === 'transfer_ack' && f.ok === false)).toMatchObject({
      transferId: 'u2', seq: 1, ok: false, code: 'TRANSFER_OUT_OF_ORDER',
    });
    await vi.waitFor(() => expect(
      portPost.some((m) => m.type === 'transfer_upload_failed' && (m.payload as { transferId?: string })?.transferId === 'u2'),
    ).toBe(true));
  });

  it('fails the transfer when the final sha256 does not match', async () => {
    const part0 = fill(new Uint8Array(CHUNK_DECODED_BYTES), 6);
    const part1 = new Uint8Array(4);
    begin('u3', part0.length + part1.length, 2, 'e'.repeat(64)); // wrong sha
    deliver({
      type: 'transfer_chunk', v: 2, transferId: 'u3', requestId: 'req-u3', seq: 0,
      totalChunks: 2, totalBytes: part0.length + part1.length, sha256: 'e'.repeat(64),
      filename: 'photo.jpg', mimeType: 'image/jpeg', bytesBase64: encodeBase64(part0),
    });
    await vi.waitFor(() => expect(
      sentFrames().some((f) => f.type === 'transfer_ack' && f.seq === 0 && f.ok === true),
    ).toBe(true));
    deliver({
      type: 'transfer_chunk', v: 2, transferId: 'u3', requestId: 'req-u3', seq: 1,
      totalChunks: 2, totalBytes: part0.length + part1.length, sha256: 'e'.repeat(64),
      filename: 'photo.jpg', mimeType: 'image/jpeg', bytesBase64: encodeBase64(part1),
    });
    await vi.waitFor(() => expect(
      portPost.some((m) => m.type === 'transfer_upload_failed' && (m.payload as { transferId?: string })?.transferId === 'u3'),
    ).toBe(true));
    const ack = sentFrames().find((f) => f.type === 'transfer_ack' && f.seq === 1 && f.ok === false);
    expect(ack).toMatchObject({ transferId: 'u3', code: 'TRANSFER_SHA256_MISMATCH' });
  });

  it('acks TRANSFER_UNKNOWN for chunks without a begin', async () => {
    deliver({
      type: 'transfer_chunk', v: 2, transferId: 'ghost', requestId: 'req-x', seq: 0,
      totalChunks: 1, totalBytes: 1, sha256: 'a'.repeat(64),
      filename: 'x.bin', mimeType: 'application/octet-stream', bytesBase64: 'AA==',
    });
    await vi.waitFor(() => expect(
      sentFrames().some((f) => f.type === 'transfer_ack' && f.transferId === 'ghost'),
    ).toBe(true));
    expect(sentFrames().find((f) => f.transferId === 'ghost')).toMatchObject({
      ok: false, code: 'TRANSFER_UNKNOWN',
    });
  });
});
