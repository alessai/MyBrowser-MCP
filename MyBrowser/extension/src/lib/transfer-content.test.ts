import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { encodeBase64 } from '../lib/transfer-shared';
import {
  handleTransferCommit,
  handleTransferPut,
  handleTransferReset,
} from './transfer-content';

interface FakeInputElement {
  type: string;
  files: unknown;
  isConnected: boolean;
  dispatchEvent: ReturnType<typeof vi.fn>;
}

let fakeInput: FakeInputElement;
let fakeFileList: unknown;

class FakeDataTransfer {
  items = {
    add: vi.fn((file: File) => {
      fakeFileList = [file];
    }),
  };
  get files() {
    return fakeFileList;
  }
}

beforeEach(() => {
  fakeInput = {
    type: 'file',
    files: null,
    isConnected: true,
    dispatchEvent: vi.fn(),
  };
  fakeFileList = [];
  vi.stubGlobal('document', {
    querySelector: vi.fn((selector: string) => (selector === '#upload' ? fakeInput : null)),
  });
  vi.stubGlobal('DataTransfer', FakeDataTransfer);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function reset(payload: { selector?: string; fileIndex?: number; fileCount?: number }) {
  return handleTransferReset({ selector: '#upload', fileIndex: 0, fileCount: 1, ...payload });
}

describe('transfer content script', () => {
  it('reset resolves the file input and starts a transfer', () => {
    expect(reset({})).toEqual({ ok: true });
    expect(vi.mocked(document.querySelector)).toHaveBeenCalledWith('#upload');
  });

  it('reset rejects a missing or non-file element', () => {
    expect(reset({ selector: '#nope' })).toMatchObject({ ok: false });
    const div = { type: 'text' };
    vi.mocked(document.querySelector).mockReturnValueOnce(div as never);
    expect(reset({})).toMatchObject({ ok: false });
    expect(reset({ selector: '' })).toMatchObject({ ok: false });
  });

  it('full reset/put/commit sequence injects a File and fires input + change', async () => {
    const part0 = new Uint8Array([1, 2, 3, 4]);
    const part1 = new Uint8Array([5, 6, 7]);
    expect(reset({})).toEqual({ ok: true });
    expect(handleTransferPut({ seq: 0, bytesBase64: encodeBase64(part0) })).toEqual({ ok: true, seq: 0 });
    expect(handleTransferPut({ seq: 1, bytesBase64: encodeBase64(part1) })).toEqual({ ok: true, seq: 1 });

    const result = handleTransferCommit({ filename: 'photo.jpg', mimeType: 'image/jpeg', size: 7 });
    expect(result).toEqual({ ok: true, name: 'photo.jpg', size: 7 });

    const file = (fakeFileList as File[])[0]!;
    expect(file.name).toBe('photo.jpg');
    expect(file.type).toBe('image/jpeg');
    expect(file.size).toBe(7);
    expect(Array.from(new Uint8Array(await file.arrayBuffer()))).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(fakeInput.files).toBe(fakeFileList);
    expect(fakeInput.dispatchEvent).toHaveBeenCalledTimes(2);
    const calls = fakeInput.dispatchEvent.mock.calls.map((c) => c[0] as Event);
    const inputEvent = calls[0]!;
    const changeEvent = calls[1]!;
    expect(inputEvent.type).toBe('input');
    expect(inputEvent.bubbles).toBe(true);
    expect(changeEvent.type).toBe('change');
    expect(changeEvent.bubbles).toBe(true);
    expect(changeEvent.cancelable).toBe(true);
  });

  it('commit fails on size mismatch and keeps state usable after reset', () => {
    reset({});
    handleTransferPut({ seq: 0, bytesBase64: encodeBase64(new Uint8Array(3)) });
    expect(handleTransferCommit({ filename: 'a.bin', mimeType: '', size: 9 })).toMatchObject({ ok: false });
    // state still active — a matching commit succeeds
    expect(handleTransferCommit({ filename: 'a.bin', mimeType: '', size: 3 })).toEqual({
      ok: true, name: 'a.bin', size: 3,
    });
  });

  it('rejects put/commit without reset and put with invalid base64', () => {
    expect(handleTransferPut({ seq: 0, bytesBase64: 'AAAA' })).toMatchObject({ ok: false });
    expect(handleTransferCommit({ filename: 'x', mimeType: '', size: 0 })).toMatchObject({ ok: false });
    reset({});
    expect(handleTransferPut({ seq: 0, bytesBase64: 'not+base64!' })).toMatchObject({ ok: false });
  });

  it('commit re-resolves the input when the original element was detached', () => {
    reset({});
    handleTransferPut({ seq: 0, bytesBase64: encodeBase64(new Uint8Array([9])) });
    fakeInput.isConnected = false;
    const replacement = { ...fakeInput, dispatchEvent: vi.fn(), files: null };
    vi.mocked(document.querySelector).mockReturnValueOnce(replacement as never);
    const result = handleTransferCommit({ filename: 'r.bin', mimeType: '', size: 1 });
    expect(result).toEqual({ ok: true, name: 'r.bin', size: 1 });
    expect(replacement.dispatchEvent).toHaveBeenCalledTimes(2);
  });
});
