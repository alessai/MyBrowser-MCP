// Content-script side of cross-machine file uploads (isolated world, shared
// DOM): receives file bytes from the background SW and injects them into a
// file input via DataTransfer — zero disk, no page-context execution needed.

import { decodeBase64 } from './transfer-shared';

interface TransferState {
  selector: string;
  fileIndex: number;
  fileCount: number;
  element: HTMLInputElement | null;
  parts: Uint8Array[];
  bytes: number;
}

let state: TransferState | null = null;

function resolveFileInput(selector: string): HTMLInputElement | null {
  const el = document.querySelector(selector);
  if (!el || (el as HTMLInputElement).type !== 'file') return null;
  return el as HTMLInputElement;
}

export function resetTransferState(): void {
  state = null;
}

export function handleTransferReset(payload: {
  selector?: unknown;
  fileIndex?: unknown;
  fileCount?: unknown;
}): { ok: boolean; error?: string } {
  if (typeof payload.selector !== 'string' || !payload.selector) {
    return { ok: false, error: 'transfer_reset: missing selector' };
  }
  if (typeof payload.fileIndex !== 'number' || typeof payload.fileCount !== 'number') {
    return { ok: false, error: 'transfer_reset: bad indices' };
  }
  const element = resolveFileInput(payload.selector);
  if (!element) return { ok: false, error: `transfer_reset: no file input matches ${payload.selector}` };
  state = {
    selector: payload.selector,
    fileIndex: payload.fileIndex,
    fileCount: payload.fileCount,
    element,
    parts: [],
    bytes: 0,
  };
  return { ok: true };
}

export function handleTransferPut(payload: {
  seq?: unknown;
  bytesBase64?: unknown;
}): { ok: boolean; seq?: number; error?: string } {
  if (!state) return { ok: false, error: 'transfer_put: no active transfer' };
  if (typeof payload.seq !== 'number' || typeof payload.bytesBase64 !== 'string') {
    return { ok: false, error: 'transfer_put: bad payload' };
  }
  let bytes: Uint8Array;
  try {
    bytes = decodeBase64(payload.bytesBase64);
  } catch {
    return { ok: false, error: 'transfer_put: invalid base64' };
  }
  state.parts.push(bytes);
  state.bytes += bytes.length;
  return { ok: true, seq: payload.seq };
}

export function handleTransferCommit(payload: {
  filename?: unknown;
  mimeType?: unknown;
  size?: unknown;
}): { ok: boolean; name?: string; size?: number; error?: string } {
  if (!state) return { ok: false, error: 'transfer_commit: no active transfer' };
  if (typeof payload.filename !== 'string' || !payload.filename || typeof payload.size !== 'number') {
    return { ok: false, error: 'transfer_commit: bad payload' };
  }
  if (state.bytes !== payload.size) {
    return { ok: false, error: `transfer_commit: size mismatch (${state.bytes} != ${payload.size})` };
  }
  const element = state.element?.isConnected ? state.element : resolveFileInput(state.selector);
  if (!element) return { ok: false, error: 'transfer_commit: file input disappeared' };
  const mimeType = typeof payload.mimeType === 'string' ? payload.mimeType : '';
  const file = new File(state.parts as BlobPart[], payload.filename, { type: mimeType });
  if (file.size !== payload.size) {
    return { ok: false, error: 'transfer_commit: constructed file size mismatch' };
  }
  const dt = new DataTransfer();
  dt.items.add(file);
  element.files = dt.files;
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
  const result = { ok: true as const, name: file.name, size: file.size };
  state = null;
  return result;
}
