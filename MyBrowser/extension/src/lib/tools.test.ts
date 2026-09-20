import { describe, expect, it, vi } from 'vitest';

import { NetworkCaptureController } from './network-capture-controller';
import type { ToolContext } from './tools';
import { evaluateConsoleNoErrors, handleTool, waitForReadyNetworkIdle } from './tools';

function context() {
  let tabId = -1;
  const temporaryTabs = {
    open: vi.fn(async () => 42),
    close: vi.fn(async () => undefined),
    keep: vi.fn(async () => true),
    cleanupSession: vi.fn(async () => ({ closed: 2, keptForRetry: 0 })),
  };
  const ctx: ToolContext = {
    sessionId: 'session-a',
    input: {} as ToolContext['input'],
    services: {
      networkCapture: new NetworkCaptureController(),
      temporaryTabs: temporaryTabs as never,
    },
    getTabId: () => tabId,
    setTabId: vi.fn(async (next) => { tabId = next; }),
    clearTab: vi.fn(async (closed) => { if (tabId === closed) tabId = -1; }),
  };
  return { ctx, temporaryTabs };
}

describe('temporary tab tool handlers', () => {
  it.each([
    [{}, true],
    [{ temporary: true }, true],
    [{ temporary: false }, false],
  ] as const)('opens tabs through the injected manager', async (args, temporary) => {
    const { ctx, temporaryTabs } = context();

    await expect(handleTool('new_tab', args, ctx)).resolves.toEqual({ tabId: 42, temporary });

    expect(temporaryTabs.open).toHaveBeenCalledWith('session-a', 'about:blank', temporary);
    expect(ctx.setTabId).toHaveBeenCalledWith(42);
  });

  it('closes through the manager and clears request state', async () => {
    const { ctx, temporaryTabs } = context();
    await ctx.setTabId(42);

    await expect(handleTool('close_tab', {}, ctx)).resolves.toBeUndefined();

    expect(temporaryTabs.close).toHaveBeenCalledWith('session-a', 42);
    expect(ctx.clearTab).toHaveBeenCalledWith(42);
  });

  it('keeps only a tab owned by the caller session', async () => {
    const { ctx, temporaryTabs } = context();

    await expect(handleTool('keep_tab', { tabId: 42 }, ctx)).resolves.toEqual({ kept: true });
    expect(temporaryTabs.keep).toHaveBeenCalledWith('session-a', 42);

    temporaryTabs.keep.mockResolvedValueOnce(false);
    await expect(handleTool('keep_tab', { tabId: 99 }, ctx)).resolves.toEqual({ kept: false });
  });

  it('cleans the caller session without requiring a tab', async () => {
    const { ctx, temporaryTabs } = context();

    await expect(handleTool('cleanup_session_tabs', {}, ctx)).resolves.toEqual({
      closed: 2,
      keptForRetry: 0,
    });
    expect(temporaryTabs.cleanupSession).toHaveBeenCalledWith('session-a');
  });

  it('maps loopback URLs before opening a remote tab', async () => {
    const { ctx, temporaryTabs } = context();
    const tab = { id: 42, status: 'complete', url: 'http://devbox.tailnet.ts.net:5173/' };
    vi.stubGlobal('chrome', {
      storage: { local: { get: vi.fn(async () => ({ localUrlHost: 'devbox.tailnet.ts.net' })) } },
      tabs: {
        get: vi.fn((_tabId, callback?: (value: typeof tab) => void) => {
          callback?.(tab);
          return Promise.resolve(tab);
        }),
        onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
        sendMessage: vi.fn(async () => ({ ok: true })),
      },
    });

    await handleTool('new_tab', { url: 'http://127.0.0.1:5173/' }, ctx);

    expect(temporaryTabs.open).toHaveBeenCalledWith(
      'session-a',
      'http://devbox.tailnet.ts.net:5173/',
      true,
    );
    vi.unstubAllGlobals();
  });
});

describe('navigation URL mapping', () => {
  it('maps loopback URLs before navigating a remote tab', async () => {
    const { ctx } = context();
    await ctx.setTabId(42);
    const get = vi.fn((_tabId, callback?: (value: chrome.tabs.Tab) => void) => {
      const tab = { id: 42, status: 'complete', url: 'https://example.com/' } as chrome.tabs.Tab;
      callback?.(tab);
      return Promise.resolve(tab);
    });
    const update = vi.fn(async () => undefined);
    vi.stubGlobal('chrome', {
      storage: { local: { get: vi.fn(async () => ({ localUrlHost: 'devbox.tailnet.ts.net' })) } },
      tabs: {
        get,
        update,
        onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
        sendMessage: vi.fn(async () => ({ ok: true })),
      },
    });

    await handleTool('browser_navigate', { url: 'http://localhost:4173/path' }, ctx);

    expect(update).toHaveBeenCalledWith(42, { url: 'http://devbox.tailnet.ts.net:4173/path' });
    vi.unstubAllGlobals();
  });
});

describe('network idle readiness', () => {
  it('waits for the current document to complete before checking quiet traffic', async () => {
    let now = 0;
    const calls: string[] = [];
    const states = ['loading', 'complete'];
    const wait = vi.fn(async () => { calls.push('idle'); });

    await expect(waitForReadyNetworkIdle(7, 1_000, 100, {
      enable: async () => { calls.push('enable'); },
      evaluate: async () => ({ result: { value: states.shift() } }),
      wait,
      now: () => now,
      sleep: async (ms) => { now += ms; },
    })).resolves.toBe(100);

    expect(calls).toEqual(['enable', 'idle']);
    expect(wait).toHaveBeenCalledWith(7, 500, 900, 100);
  });
});

describe('console assertion truthfulness', () => {
  it('fails when console capture was never enabled for the tab', () => {
    expect(evaluateConsoleNoErrors(999_999)).toEqual({
      type: 'console_no_errors',
      passed: false,
      message: 'console_no_errors: console capture is not active for this tab',
    });
  });

  it('starts capture through the console-log tool before assertions can pass', async () => {
    const { ctx } = context();
    await ctx.setTabId(888_888);
    const sendCommand = vi.fn(async () => undefined);
    vi.stubGlobal('chrome', {
      debugger: {
        attach: vi.fn(async () => undefined),
        detach: vi.fn(async () => undefined),
        sendCommand,
      },
    });

    await expect(handleTool('browser_get_console_logs', {}, ctx)).resolves.toEqual([]);
    expect(sendCommand).toHaveBeenCalledWith(
      { tabId: 888_888 },
      'Runtime.enable',
      undefined,
    );
    expect(evaluateConsoleNoErrors(888_888).passed).toBe(true);
    vi.unstubAllGlobals();
  });

  it('does not make tab selection depend on debugger availability', async () => {
    const { ctx } = context();
    vi.stubGlobal('chrome', {
      tabs: {
        update: vi.fn(async () => undefined),
        sendMessage: vi.fn(async () => ({ ok: true })),
      },
      debugger: {
        attach: vi.fn(async () => { throw new Error('debugger unavailable'); }),
      },
    });

    await expect(handleTool('select_tab', { tabId: 777_777 }, ctx)).resolves.toBeUndefined();
    expect(ctx.setTabId).toHaveBeenCalledWith(777_777);
    vi.unstubAllGlobals();
  });
});

describe('evaluation outcome boundaries', () => {
  it('does not rerun code after CDP evaluation has started', async () => {
    const { ctx } = context();
    await ctx.setTabId(666_666);
    const executeScript = vi.fn(async () => [{ result: '{}' }]);
    vi.stubGlobal('chrome', {
      debugger: {
        attach: vi.fn(async () => undefined),
        sendCommand: vi.fn(async () => { throw new Error('response lost'); }),
      },
      scripting: { executeScript },
    });

    await expect(handleTool('browser_eval', { code: 'globalThis.sideEffect = true' }, ctx))
      .rejects.toThrow('EVAL_OUTCOME_UNKNOWN');
    expect(executeScript).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe('cookie clear scoping', () => {
  function stubDebugger(cookies: Array<{ name: string; domain: string; path: string }>) {
    const sendCommand = vi.fn(async (_tabId: unknown, method: string) => {
      if (method === 'Network.getCookies') return { cookies };
      return undefined;
    });
    vi.stubGlobal('chrome', {
      debugger: {
        attach: vi.fn(async () => undefined),
        detach: vi.fn(async () => undefined),
        sendCommand,
      },
    });
    return { sendCommand };
  }

  it('deletes only matching-domain cookies when a domain is given', async () => {
    const { ctx } = context();
    await ctx.setTabId(55);
    const { sendCommand } = stubDebugger([
      { name: 'sid', domain: '.example.com', path: '/' },
      { name: 'cf_clearance', domain: '.saif.om', path: '/' },
    ]);

    await expect(
      handleTool('browser_storage', { action: 'clear', type: 'cookies', domain: 'example.com' }, ctx),
    ).resolves.toEqual({ success: true, deleted: 1 });

    expect(sendCommand).toHaveBeenCalledWith(
      { tabId: 55 },
      'Network.deleteCookies',
      { name: 'sid', domain: '.example.com', path: '/' },
    );
    expect(sendCommand).not.toHaveBeenCalledWith(expect.anything(), 'Network.clearBrowserCookies', expect.anything());
  });

  it('refuses a global cookie wipe without explicit confirmation', async () => {
    const { ctx } = context();
    await ctx.setTabId(55);
    const { sendCommand } = stubDebugger([]);

    await expect(
      handleTool('browser_storage', { action: 'clear', type: 'cookies' }, ctx),
    ).rejects.toThrow('confirmWipeAllCookies');

    expect(sendCommand).not.toHaveBeenCalledWith(expect.anything(), 'Network.clearBrowserCookies', expect.anything());
  });

  it('wipes all cookies only with explicit confirmation', async () => {
    const { ctx } = context();
    await ctx.setTabId(55);
    const { sendCommand } = stubDebugger([]);

    await expect(
      handleTool('browser_storage', { action: 'clear', type: 'cookies', confirmWipeAllCookies: true }, ctx),
    ).resolves.toEqual({ success: true });

    expect(sendCommand).toHaveBeenCalledWith({ tabId: 55 }, 'Network.clearBrowserCookies', undefined);
  });
});

describe('browser_download completion', () => {
  function stubDownloads(searchImpl: () => Array<Record<string, unknown>>) {
    const download = vi.fn(async () => 77);
    const search = vi.fn(async () => searchImpl());
    vi.stubGlobal('chrome', { downloads: { download, search } });
    return { download, search };
  }

  it('waits for completion and returns the final absolute filename', async () => {
    const { ctx } = context();
    let polls = 0;
    const { download, search } = stubDownloads(() => {
      polls += 1;
      if (polls < 3) return [{ id: 77, state: 'in_progress', filename: '', error: undefined }];
      return [{ id: 77, state: 'complete', filename: '/home/u/Downloads/report (1).pdf', error: undefined }];
    });

    const result = await handleTool('browser_download', { url: 'https://example.com/report.pdf' }, ctx);

    expect(result).toEqual({
      downloadId: 77,
      url: 'https://example.com/report.pdf',
      filename: '/home/u/Downloads/report (1).pdf',
      state: 'complete',
      directory: undefined,
    });
    expect(search).toHaveBeenCalledTimes(3);
    expect(download).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('throws with the interrupted reason', async () => {
    const { ctx } = context();
    stubDownloads(() => [{ id: 77, state: 'interrupted', filename: '', error: 'NETWORK_FAILED' }]);

    await expect(
      handleTool('browser_download', { url: 'https://example.com/report.pdf' }, ctx),
    ).rejects.toThrow('DOWNLOAD_INTERRUPTED: NETWORK_FAILED');
    vi.unstubAllGlobals();
  });

  it('pins conflictAction and saveAs explicitly', async () => {
    const { ctx } = context();
    const { download } = stubDownloads(
      () => [{ id: 77, state: 'complete', filename: '/home/u/Downloads/report.pdf', error: undefined }],
    );

    await handleTool('browser_download', { url: 'https://example.com/report.pdf', filename: 'report.pdf' }, ctx);

    expect(download).toHaveBeenCalledWith({
      url: 'https://example.com/report.pdf',
      filename: 'report.pdf',
      conflictAction: 'uniquify',
      saveAs: false,
    });
    vi.unstubAllGlobals();
  });
});

describe('browser_upload error unmasking', () => {
  it('surfaces the CDP cause instead of UPLOAD_OUTCOME_UNKNOWN alone', async () => {
    const { ctx } = context();
    await ctx.setTabId(55);
    const sendCommand = vi.fn(async (_tabId: unknown, method: string) => {
      if (method === 'DOM.getDocument') return { root: { nodeId: 5 } };
      if (method === 'DOM.querySelector') return { nodeId: 9 };
      if (method === 'DOM.setFileInputFiles') throw new Error('Another debugger is already attached to the tab');
      return undefined;
    });
    vi.stubGlobal('chrome', {
      debugger: {
        attach: vi.fn(async () => undefined),
        detach: vi.fn(async () => undefined),
        sendCommand,
      },
    });

    await expect(
      handleTool('browser_upload', { selector: '#file', files: ['/tmp/photo.jpg'] }, ctx),
    ).rejects.toThrow('UPLOAD_FAILED: Another debugger is already attached to the tab');
    expect(sendCommand).toHaveBeenCalledWith(
      { tabId: 55 },
      'DOM.setFileInputFiles',
      { nodeId: 9, files: ['/tmp/photo.jpg'] },
    );
    vi.unstubAllGlobals();
  });
});
