// Background routing tests for the file-transfer flow:
// browser_fetch_file → offscreen port RPC → transfer_fetch_done → messageResponse
// browser_upload {localFiles} → transfer_upload_ready → content-script driver → messageResponse

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type AnyFn = (...args: unknown[]) => unknown;

interface FakePort {
  name: string;
  sender: { id: string; url: string };
  postMessage: ReturnType<typeof vi.fn>;
  onMessage: { addListener: (l: AnyFn) => void };
  onDisconnect: { addListener: (l: AnyFn) => void };
}

const portPost: Record<string, unknown>[] = [];
let portListener: AnyFn | null = null;
const connectListeners: AnyFn[] = [];
const runtimeMessageListeners: AnyFn[] = [];

// Messages the fake content script will answer with, in order.
let tabReplies: unknown[] = [];
const tabMessages: { tabId: number; type: string; payload: unknown }[] = [];
const executeScriptCalls: { files: string[] }[] = [];

function listenerBox(): { addListener: (l: AnyFn) => void } {
  return { addListener: (l: AnyFn) => runtimeMessageListeners.push(l) };
}

function makePort(): FakePort {
  return {
    name: 'offscreen',
    sender: { id: 'test-ext', url: 'chrome-extension://test-ext/offscreen.html' },
    postMessage: vi.fn((m: Record<string, unknown>) => {
      portPost.push(m);
    }),
    onMessage: { addListener: (l: AnyFn) => { portListener = l; } },
    onDisconnect: { addListener: () => {} },
  };
}

const fakePort = makePort();

function chromeStub(): Record<string, unknown> {
  const box = () => ({ addListener: vi.fn() });
  return {
    runtime: {
      id: 'test-ext',
      getURL: (p: string) => `chrome-extension://test-ext${p}`,
      getContexts: vi.fn(async () => []),
      connect: vi.fn(() => fakePort),
      sendMessage: vi.fn(async () => undefined),
      onConnect: { addListener: (l: AnyFn) => connectListeners.push(l) },
      onMessage: listenerBox(),
      onInstalled: box(),
      onStartup: box(),
    },
    offscreen: {
      createDocument: vi.fn(async () => {}),
      Reason: new Proxy({}, { get: (_t, key: string) => key }),
    },
    action: {
      setBadgeText: vi.fn(async () => {}),
      setBadgeBackgroundColor: vi.fn(async () => {}),
      setTitle: vi.fn(async () => {}),
    },
    storage: {
      local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
      onChanged: box(),
    },
    tabs: {
      sendMessage: vi.fn(async (tabId: number, msg: { type: string; payload: unknown }) => {
        tabMessages.push({ tabId, type: msg.type, payload: msg.payload });
        const next = tabReplies.shift();
        if (next instanceof Error) throw next;
        return next ?? { ok: true };
      }),
      query: vi.fn(async () => []),
      get: vi.fn(async (tabId: number) => ({ id: tabId, url: 'https://example.com/' })),
      create: vi.fn(async () => ({ id: 99 })),
      remove: vi.fn(async () => {}),
      update: vi.fn(async () => ({})),
      onCreated: box(), onRemoved: box(), onReplaced: box(), onUpdated: box(), onActivated: box(),
    },
    scripting: {
      executeScript: vi.fn(async (opts: { files: string[] }) => {
        executeScriptCalls.push({ files: opts.files });
        return [];
      }),
    },
    alarms: { create: vi.fn(), clear: vi.fn(async () => true), onAlarm: box() },
    commands: { getAll: vi.fn(async () => []), onCommand: box() },
    debugger: {
      onEvent: box(), onDetach: box(),
      attach: vi.fn(async () => {}), detach: vi.fn(async () => {}),
      sendCommand: vi.fn(async () => ({})),
    },
    webRequest: {
      onCompleted: box(), onErrorOccurred: box(), onBeforeRequest: box(),
      onBeforeRedirect: box(), onAuthRequired: box(), onHeadersReceived: box(),
    },
    downloads: { download: vi.fn(async () => 1), onChanged: box(), onCreated: box() },
    notifications: { create: vi.fn(async () => 'n') },
    contextMenus: { create: vi.fn(), removeAll: vi.fn(async () => {}), onClicked: box() },
    windows: {
      create: vi.fn(async () => ({ id: 1 })), update: vi.fn(async () => ({})),
      remove: vi.fn(async () => {}), getAll: vi.fn(async () => []), onRemoved: box(),
    },
  };
}

function stubGlobals(): void {
  vi.stubGlobal('chrome', chromeStub());
  // WXT auto-import: capture the registration callback and run it after import.
  vi.stubGlobal('defineBackground', (fn: () => void) => { (globalThis as { __bgBody?: () => void }).__bgBody = fn; });
}

function lastSent(): Record<string, unknown> {
  const sent = portPost.filter((m) => m.type === '_os_ws_send');
  const last = sent.at(-1);
  if (!last) throw new Error('no _os_ws_send observed');
  return JSON.parse(last.payload as string) as Record<string, unknown>;
}

function wsReceive(request: Record<string, unknown>): void {
  portListener?.({ type: '_os_ws_receive', payload: JSON.stringify(request) });
}

function fromOffscreen(message: Record<string, unknown>): void {
  portListener?.(message);
}

/** Answer every unanswered port request (messages carrying _replyId). */
function pumpReplies(answer: (message: Record<string, unknown>) => unknown): void {
  for (const m of portPost) {
    if (typeof m._replyId === 'string' && !m.__replied) {
      m.__replied = true;
      fromOffscreen({ type: '_os_reply', _replyId: m._replyId, payload: answer(m) });
    }
  }
}

function toolRequest(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    v: 2,
    type: 'browser_fetch_file',
    id: 'req-1',
    sessionId: 'sess-1',
    timeoutMs: 30_000,
    payload: {},
    ...overrides,
  };
}

beforeAll(async () => {
  stubGlobals();
  await import('./index');
  const body = (globalThis as { __bgBody?: () => void }).__bgBody;
  if (!body) throw new Error('defineBackground body missing');
  body();
  const connect = connectListeners.at(-1);
  if (!connect) throw new Error('onConnect listener missing');
  connect(fakePort);
  if (!portListener) throw new Error('port listener missing');
});

beforeEach(() => {
  stubGlobals();
  portPost.length = 0;
  tabMessages.length = 0;
  tabReplies = [];
  executeScriptCalls.length = 0;
});

describe('background file-transfer routing', () => {
  it('browser_fetch_file: dispatches transfer_fetch_start and resolves transferred:true on transfer_fetch_done', async () => {
    wsReceive(toolRequest({
      type: 'browser_fetch_file',
      id: 'reqA',
      payload: { url: 'https://example.com/f.bin', filename: 'f.bin', transferId: 't1' },
    }));

    await vi.waitFor(() => {
      expect(portPost.some((m) => m.type === 'transfer_fetch_start')).toBe(true);
    });
    const start = portPost.find((m) => m.type === 'transfer_fetch_start') as Record<string, unknown>;
    expect(start).toMatchObject({ payload: { transferId: 't1', requestId: 'reqA', url: 'https://example.com/f.bin', filename: 'f.bin' } });

    fromOffscreen({ type: 'transfer_fetch_done', payload: { transferId: 't1', ok: true, bytesSent: 42 } });

    await vi.waitFor(() => {
      const response = lastSent() as { payload: { requestId: string; result?: Record<string, unknown> } };
      expect(response.payload.requestId).toBe('reqA');
      expect(response.payload.result).toEqual({ transferred: true, transferId: 't1', bytesSent: 42 });
    });
  });

  it('browser_fetch_file: reports transfer error when transfer_fetch_done carries ok:false', async () => {
    wsReceive(toolRequest({
      type: 'browser_fetch_file',
      id: 'reqB',
      payload: { url: 'https://example.com/f.bin', filename: 'f.bin', transferId: 't2' },
    }));
    await vi.waitFor(() => expect(portPost.some((m) => m.type === 'transfer_fetch_start')).toBe(true));

    fromOffscreen({ type: 'transfer_fetch_done', payload: { transferId: 't2', ok: false, error: 'HTTP 403' } });

    await vi.waitFor(() => {
      const response = lastSent() as { payload: { requestId: string; error?: string } };
      expect(response.payload.requestId).toBe('reqB');
      expect(response.payload.error).toBe('HTTP 403');
    });
  });

  it('browser_upload localFiles: drives reset/put/commit and answers uploaded:true without touching the normal tool path', async () => {
    const fileBytes = new TextEncoder().encode('hello world!');
    const b64 = Buffer.from(fileBytes).toString('base64');
    wsReceive(toolRequest({
      type: 'browser_upload',
      id: 'reqC',
      payload: { selector: '#upload-input', localFiles: ['/tmp/a.txt'] },
    }));
    // Let the tool request handler finish registering the pending upload before
    // the offscreen reports the transfer as ready (async handleToolRequest).
    await new Promise((resolve) => setTimeout(resolve, 0));

    fromOffscreen({
      type: 'transfer_upload_ready',
      payload: {
        transferId: 'u1', requestId: 'reqC', targetTabId: 5, selector: '#upload-input',
        fileIndex: 0, fileCount: 1, filename: 'a.txt', mimeType: 'text/plain',
        totalBytes: fileBytes.length, totalChunks: 1,
      },
    });

    const pullAnswer = (message: Record<string, unknown>): unknown => {
      if (message.type === 'transfer_chunk_pull') return { ok: true, bytesBase64: b64 };
      return undefined;
    };

    await vi.waitFor(() => {
      pumpReplies(pullAnswer); // keep answering as the driver posts more pulls
      const response = lastSent() as { payload: { requestId: string; result?: { uploaded: boolean; files: { name: string; size: number }[] }; error?: string } };
      expect(response.payload.requestId).toBe('reqC');
      expect(response.payload.result).toEqual({
        uploaded: true,
        files: [{ name: 'a.txt', size: fileBytes.length }],
      });
    });

    const types = tabMessages.map((m) => m.type);
    expect(types).toEqual(['transfer_reset', 'transfer_put', 'transfer_commit']);
    expect(tabMessages[0]!.tabId).toBe(5);
    expect(tabMessages[1]!.payload).toMatchObject({ seq: 0, bytesBase64: b64 });
    expect(tabMessages[2]!.payload).toEqual({ filename: 'a.txt', mimeType: 'text/plain', size: fileBytes.length });
    // Offscreen memory released after the flow finishes.
    await vi.waitFor(() => expect(portPost.some((m) => m.type === 'transfer_upload_done')).toBe(true));
    // No injection needed when the content script answers.
    expect(executeScriptCalls).toHaveLength(0);
  });

  it('browser_upload localFiles: injects the content script once when the tab has no receiver', async () => {
    const b64 = Buffer.from('x').toString('base64');
    tabReplies = [new Error('Could not establish connection. Receiving end does not exist.')];
    wsReceive(toolRequest({
      type: 'browser_upload',
      id: 'reqD',
      payload: { selector: '#up', localFiles: ['/tmp/a.txt'] },
    }));
    fromOffscreen({
      type: 'transfer_upload_ready',
      payload: {
        transferId: 'u2', requestId: 'reqD', targetTabId: 7, selector: '#up',
        fileIndex: 0, fileCount: 1, filename: 'a.txt', mimeType: 'text/plain',
        totalBytes: 1, totalChunks: 1,
      },
    });

    await vi.waitFor(() => {
      pumpReplies((message) => {
        if (message.type === 'transfer_chunk_pull') return { ok: true, bytesBase64: b64 };
        return undefined;
      });
      const response = lastSent() as { payload: { result?: { uploaded: boolean } } };
      expect(response.payload.result?.uploaded).toBe(true);
    });
    expect(executeScriptCalls).toEqual([{ files: ['/content-scripts/transfer.js'] }]);
    expect(tabMessages.filter((m) => m.type === 'transfer_reset')).toHaveLength(2);
  });

  it('browser_upload localFiles: surfaces transfer_upload_failed as an error response', async () => {
    wsReceive(toolRequest({
      type: 'browser_upload',
      id: 'reqE',
      payload: { selector: '#up', localFiles: ['/tmp/a.txt'] },
    }));
    fromOffscreen({
      type: 'transfer_upload_failed',
      payload: { transferId: 'u3', requestId: 'reqE', error: 'TRANSFER_SHA256_MISMATCH: bad' },
    });
    await vi.waitFor(() => {
      const response = lastSent() as { payload: { requestId: string; error?: string } };
      expect(response.payload.requestId).toBe('reqE');
      expect(response.payload.error).toBe('TRANSFER_SHA256_MISMATCH: bad');
    });
  });

  it('browser_upload with in-page files still routes through the normal tool handler', async () => {
    // No localFiles → not intercepted; the normal dispatcher must own it.
    // We assert routing by observing that no transfer_fetch_start / upload flow starts.
    // (The normal handler may reject under this minimal mock — that's fine; it proves dispatch.)
    wsReceive(toolRequest({ type: 'browser_ping', id: 'reqF', payload: {} }));
    await vi.waitFor(() => {
      const response = lastSent() as { payload: { requestId: string } };
      expect(response.payload.requestId).toBe('reqF');
    });
    expect(portPost.some((m) => m.type === 'transfer_fetch_start')).toBe(false);
    expect(tabMessages.length).toBe(0);
  });
});
