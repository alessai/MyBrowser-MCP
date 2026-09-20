import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  CHUNK_DECODED_BYTES,
  concatBytes,
  decodeBase64,
  encodeBase64,
  isCanonicalBase64,
  isTransferAck,
  isTransferBegin,
  isTransferChunk,
  sanitizeTransferFilename,
  sha256Hex,
} from './transfer-shared';

/** Deterministic pseudo-random fill (LCG) so multi-MiB buffers are cheap and stable. */
function fill(bytes: Uint8Array, seed: number): Uint8Array {
  let state = seed >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    bytes[i] = state & 0xff;
  }
  return bytes;
}

describe('base64 encode/decode', () => {
  it('roundtrips a multi-MiB buffer', () => {
    const bytes = fill(new Uint8Array(5 * 1024 * 1024 + 123), 0xC0FFEE);
    const decoded = decodeBase64(encodeBase64(bytes));
    expect(decoded.length).toBe(bytes.length);
    expect(Buffer.from(decoded).equals(Buffer.from(bytes))).toBe(true);
  });

  it('roundtrips an exact 3 MiB chunk and a remainder chunk', () => {
    const bytes = fill(new Uint8Array(CHUNK_DECODED_BYTES + 1000), 42);
    const first = bytes.subarray(0, CHUNK_DECODED_BYTES);
    const rest = bytes.subarray(CHUNK_DECODED_BYTES);
    expect(rest.length).toBe(1000);

    const firstDecoded = decodeBase64(encodeBase64(first));
    const restDecoded = decodeBase64(encodeBase64(rest));
    expect(Buffer.from(firstDecoded).equals(Buffer.from(first))).toBe(true);
    expect(Buffer.from(restDecoded).equals(Buffer.from(rest))).toBe(true);
  });

  it('roundtrips empty input', () => {
    expect(decodeBase64(encodeBase64(new Uint8Array(0)).length ? encodeBase64(new Uint8Array(0)) : '')).toHaveLength(0);
    expect(encodeBase64(new Uint8Array(0))).toBe('');
  });

  it('rejects non-canonical base64 on decode', () => {
    expect(() => decodeBase64('ab=c')).toThrow('INVALID_BASE64'); // '=' mid-string
    expect(() => decodeBase64('a')).toThrow('INVALID_BASE64'); // bad length
    expect(() => decodeBase64('ab!c')).toThrow('INVALID_BASE64'); // bad alphabet
    expect(() => decodeBase64('QQ==extra')).toThrow('INVALID_BASE64'); // padding not final
  });

  it('isCanonicalBase64 accepts valid, rejects oversized/invalid', () => {
    expect(isCanonicalBase64(encodeBase64(new Uint8Array(16)))).toBe(true);
    expect(isCanonicalBase64('')).toBe(true); // 0-byte final chunk
    expect(isCanonicalBase64('ab=c')).toBe(false);
    expect(isCanonicalBase64(encodeBase64(new Uint8Array(CHUNK_DECODED_BYTES + 1)))).toBe(false);
    expect(isCanonicalBase64(42)).toBe(false);
  });

  it('concatBytes rejoins chunk parts', () => {
    const bytes = fill(new Uint8Array(CHUNK_DECODED_BYTES + 7), 7);
    const joined = concatBytes([bytes.subarray(0, CHUNK_DECODED_BYTES), bytes.subarray(CHUNK_DECODED_BYTES)]);
    expect(Buffer.from(joined).equals(Buffer.from(bytes))).toBe(true);
  });
});

describe('sha256Hex', () => {
  it('matches node:crypto sha256', async () => {
    const bytes = fill(new Uint8Array(1000), 99);
    await expect(sha256Hex(bytes)).resolves.toBe(createHash('sha256').update(bytes).digest('hex'));
    await expect(sha256Hex(new Uint8Array(0))).resolves.toBe(
      createHash('sha256').digest('hex'),
    );
  });
});

describe('sanitizeTransferFilename', () => {
  it('accepts spec-valid names', () => {
    expect(sanitizeTransferFilename('report.pdf', 'download')).toBe('report.pdf');
  });

  it('strips path components', () => {
    expect(sanitizeTransferFilename('../../etc/passwd', 'download')).toBe('passwd');
    expect(sanitizeTransferFilename('C:\\evil\\file.txt', 'download')).toBe('file.txt');
  });

  it('falls back when the name is invalid', () => {
    expect(sanitizeTransferFilename('weird:name!.pdf', 'fallback.bin')).toBe('fallback.bin');
    expect(sanitizeTransferFilename(undefined, 'fallback.bin')).toBe('fallback.bin');
    expect(sanitizeTransferFilename('', 'download')).toBe('download');
  });

  it('falls back to download when nothing is valid', () => {
    expect(sanitizeTransferFilename('no good', '')).toBe('download');
  });
});

const validChunk = {
  type: 'transfer_chunk',
  v: 2,
  transferId: '11111111-1111-4111-8111-111111111111',
  requestId: 'req-1',
  seq: 0,
  totalChunks: 12,
  totalBytes: 12345678,
  sha256: 'a'.repeat(64),
  filename: 'report.pdf',
  mimeType: 'application/pdf',
  bytesBase64: 'AAAA',
};

describe('isTransferChunk', () => {
  it('accepts a valid chunk', () => {
    expect(isTransferChunk(validChunk)).toBe(true);
  });

  it('rejects extra keys', () => {
    expect(isTransferChunk({ ...validChunk, extra: 1 })).toBe(false);
  });

  it.each([
    ['missing key', () => {
      const { seq: _seq, ...rest } = validChunk;
      return rest;
    }],
    ['wrong type', () => ({ ...validChunk, type: 'transfer_ack' })],
    ['wrong version', () => ({ ...validChunk, v: 1 })],
    ['bad sha256 (uppercase)', () => ({ ...validChunk, sha256: 'A'.repeat(64) })],
    ['bad sha256 (short)', () => ({ ...validChunk, sha256: 'abcd' })],
    ['filename with separator', () => ({ ...validChunk, filename: '../passwd' })],
    ['seq out of range', () => ({ ...validChunk, seq: 12 })],
    ['seq negative', () => ({ ...validChunk, seq: -1 })],
    ['totalChunks zero', () => ({ ...validChunk, seq: 0, totalChunks: 0 })],
    ['negative totalBytes', () => ({ ...validChunk, totalBytes: -1 })],
    ['non-canonical base64', () => ({ ...validChunk, bytesBase64: 'ab=c' })],
    ['oversized base64', () => ({ ...validChunk, bytesBase64: encodeBase64(new Uint8Array(CHUNK_DECODED_BYTES + 1)) })],
    ['empty mimeType', () => ({ ...validChunk, mimeType: '' })],
    ['fractional seq', () => ({ ...validChunk, seq: 0.5 })],
  ])('rejects %s', (_name, build) => {
    expect(isTransferChunk(build())).toBe(false);
  });
});

describe('isTransferAck', () => {
  it('accepts success shape', () => {
    expect(isTransferAck({ type: 'transfer_ack', transferId: 't-1', seq: 3, ok: true })).toBe(true);
  });

  it('accepts failure shape with code and message', () => {
    expect(isTransferAck({
      type: 'transfer_ack', transferId: 't-1', seq: 0, ok: false,
      code: 'TRANSFER_TOO_LARGE', message: 'nope',
    })).toBe(true);
  });

  it('rejects failure shape without code/message', () => {
    expect(isTransferAck({ type: 'transfer_ack', transferId: 't-1', seq: 0, ok: false })).toBe(false);
  });

  it('rejects extra keys and bad fields', () => {
    expect(isTransferAck({ type: 'transfer_ack', transferId: 't-1', seq: 0, ok: true, extra: 1 })).toBe(false);
    expect(isTransferAck({ type: 'transfer_ack', transferId: 't-1', seq: -1, ok: true })).toBe(false);
    expect(isTransferAck({ type: 'transfer_ack', transferId: 't-1', seq: 0, ok: 'yes' })).toBe(false);
  });
});

const validBegin = {
  type: 'transfer_begin',
  v: 2,
  transferId: '22222222-2222-4222-8222-222222222222',
  requestId: 'req-2',
  direction: 'upload',
  fileIndex: 0,
  fileCount: 2,
  filename: 'photo.jpg',
  mimeType: 'image/jpeg',
  totalBytes: 900000,
  totalChunks: 1,
  sha256: 'b'.repeat(64),
  targetTabId: 123,
  selector: 'input[type=file]',
};

describe('isTransferBegin', () => {
  it('accepts a valid begin', () => {
    expect(isTransferBegin(validBegin)).toBe(true);
  });

  it('rejects extra keys', () => {
    expect(isTransferBegin({ ...validBegin, junk: true })).toBe(false);
  });

  it.each([
    ['wrong direction', () => ({ ...validBegin, direction: 'download' })],
    ['fileIndex out of range', () => ({ ...validBegin, fileIndex: 2 })],
    ['fileCount zero', () => ({ ...validBegin, fileIndex: 0, fileCount: 0 })],
    ['negative tab id', () => ({ ...validBegin, targetTabId: -1 })],
    ['empty selector', () => ({ ...validBegin, selector: '' })],
    ['bad sha256', () => ({ ...validBegin, sha256: 'xyz' })],
    ['zero totalChunks', () => ({ ...validBegin, totalChunks: 0 })],
  ])('rejects %s', (_name, build) => {
    expect(isTransferBegin(build())).toBe(false);
  });
});
