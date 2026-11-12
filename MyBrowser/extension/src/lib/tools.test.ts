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

describe('typing target resolution', () => {
  it('never uses the text being typed to find the field', async () => {
    const { ctx } = context();
    await ctx.setTabId(555_555);
    const sendMessage = vi.fn(async (_tabId: number, message: { type: string; payload?: unknown }) => (
      message.type === 'resolveElement' ? { __error: true, message: 'stop after resolution' } : { ok: true }
    ));
    vi.stubGlobal('chrome', { tabs: { sendMessage } });

    await expect(handleTool('browser_type', { element: 'email field', name: 'Email', text: 'saif@example.com', submit: false }, ctx))
      .rejects.toThrow('stop after resolution');

    const resolveCall = sendMessage.mock.calls.find(([, message]) => message.type === 'resolveElement');
    expect(resolveCall![1].payload).toEqual({ name: 'Email' });
    vi.unstubAllGlobals();
  });
});

describe('screenshot when the browser produces no frames', () => {
  it('fails fast with the reason instead of hanging until the transport timeout', async () => {
    vi.useFakeTimers();
    const { ctx } = context();
    await ctx.setTabId(444_444);
    vi.stubGlobal('chrome', {
      debugger: {
        attach: vi.fn(async () => undefined),
        detach: vi.fn(async () => undefined),
        sendCommand: vi.fn((_target: unknown, method: string) => (
          method === 'Page.getLayoutMetrics'
            ? Promise.resolve({ cssVisualViewport: { clientWidth: 1280, clientHeight: 800 } })
            : method === 'Page.captureScreenshot'
              ? new Promise(() => undefined) // compositor never delivers a frame
              : Promise.resolve(undefined)
        )),
      },
    });
    try {
      const outcome = handleTool('browser_screenshot', {}, ctx).then(() => 'resolved', (error: Error) => error.message);
      // up to ~4 s settling after a fresh debugger attach, then the 10 s frame timeout
      await vi.advanceTimersByTimeAsync(16_000);
      await expect(outcome).resolves.toMatch(/^SCREENSHOT_NO_FRAME: .*minimized or on a hidden workspace/);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});

describe('browser_mouse screenshot coordinates', () => {
  function setup(tabId: number) {
    const { ctx } = context();
    const viewport = { clientWidth: 2048, clientHeight: 1536 };
    const clicks: Array<{ x: number; y: number; options?: unknown }> = [];
    const typed: string[] = [];
    ctx.input = {
      moveMouse: vi.fn(async () => undefined),
      click: vi.fn(async (point: { x: number; y: number }, options?: unknown) => { clicks.push({ ...point, options }); }),
      waitForTabIfNavigationStarted: vi.fn(async (_tab: number, action: () => Promise<void>) => action()),
      keyboard: { type: vi.fn(async (text: string) => { typed.push(text); }) },
    } as unknown as ToolContext['input'];
    vi.stubGlobal('chrome', {
      debugger: {
        attach: vi.fn(async () => undefined),
        detach: vi.fn(async () => undefined),
        sendCommand: vi.fn(async (_target: unknown, method: string) => (
          method === 'Page.getLayoutMetrics' ? { cssVisualViewport: viewport }
            : method === 'Page.captureScreenshot' ? { data: 'iVBORw0KGgo=' }
              : method === 'Runtime.evaluate' ? { result: { value: 'an embedded frame from https://officeapps.live.com' } }
                : undefined
        )),
      },
      scripting: { executeScript: vi.fn(async () => [{ result: true }]) },
      tabs: { sendMessage: vi.fn(async () => ({ stable: true })), get: vi.fn(async () => ({ id: tabId, status: 'complete' })) },
      runtime: { lastError: undefined },
    });
    return { ctx, viewport, clicks, typed };
  }

  it('refuses without a screenshot, maps screenshot pixels to the page, and refuses a stale one', async () => {
    const { ctx, viewport, clicks, typed } = setup(555_001);
    await ctx.setTabId(555_001);
    try {
      await expect(handleTool('browser_mouse', { action: 'click', x: 10, y: 10 }, ctx)).rejects.toThrow('NO_SCREENSHOT');
      await handleTool('browser_screenshot', {}, ctx);
      // 2048x1536 page -> 1024x768 screenshot, so screenshot pixels are doubled.
      await expect(handleTool('browser_mouse', { action: 'click', x: 100, y: 50, text: 'Hello' }, ctx))
        .resolves.toEqual({ hit: 'an embedded frame from https://officeapps.live.com' });
      expect(clicks).toEqual([{ x: 200, y: 100, options: { count: 1 } }]);
      expect(typed).toEqual(['Hello']);
      await handleTool('browser_mouse', { action: 'right_click', x: 1, y: 1 }, ctx);
      expect(clicks[1]).toEqual({ x: 2, y: 2, options: { button: 'right' } });
      await expect(handleTool('browser_mouse', { action: 'click', x: 1025, y: 10 }, ctx)).rejects.toThrow('POINT_OUTSIDE_SCREENSHOT');
      viewport.clientWidth = 1600;
      await expect(handleTool('browser_mouse', { action: 'click', x: 10, y: 10 }, ctx)).rejects.toThrow('SCREENSHOT_STALE');
      expect(clicks).toHaveLength(2);
    } finally {
      vi.unstubAllGlobals();
    }
  }, 20_000);
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

describe('2.2 settle-based waits and one-trip snapshots', () => {
  const tab = (ctx: ToolContext) => ctx.setTabId(777_001);

  it('browser_wait returns once the page is quiet instead of sleeping the full time', async () => {
    const { ctx } = context();
    await tab(ctx);
    const sendMessage = vi.fn(async () => ({ ok: true })); // waitForStableDOM resolves at once
    vi.stubGlobal('chrome', { tabs: { sendMessage }, scripting: { executeScript: vi.fn() } });
    const started = Date.now();
    const result = await handleTool('browser_wait', { time: 5 }, ctx) as { waitedMs: number; settled: boolean };
    expect(Date.now() - started).toBeLessThan(1000);
    expect(result.settled).toBe(true);
    const settle = sendMessage.mock.calls.find((c) => (c as unknown[])[1] && ((c as unknown[])[1] as { type: string }).type === 'waitForStableDOM');
    expect(((settle as unknown[])[1] as { payload: unknown }).payload).toEqual({ minStableMs: 1000, maxMutations: 0, maxWaitMs: 5000 });
    vi.unstubAllGlobals();
  });

  it('browser_wait exact:true sleeps the full time', async () => {
    const { ctx } = context();
    await tab(ctx);
    vi.stubGlobal('chrome', { tabs: { sendMessage: vi.fn(async () => ({ ok: true })) } });
    const result = await handleTool('browser_wait', { time: 0.2, exact: true }, ctx) as { waitedMs: number; settled: boolean };
    expect(result.settled).toBe(false);
    expect(result.waitedMs).toBeGreaterThanOrEqual(190);
    vi.unstubAllGlobals();
  });

  it('browser_snapshot with withPage returns URL, title and snapshot together', async () => {
    const { ctx } = context();
    await tab(ctx);
    vi.stubGlobal('chrome', {
      tabs: {
        sendMessage: vi.fn(async (_t: number, m: { type: string }) => (m.type === 'generateAriaSnapshot' ? '- button "Save"' : { ok: true })),
        get: vi.fn(async () => ({ url: 'https://x.test/', title: 'X' })),
      },
    });
    expect(await handleTool('browser_snapshot', { withPage: true }, ctx)).toEqual({ url: 'https://x.test/', title: 'X', snapshot: '- button "Save"' });
    expect(await handleTool('browser_snapshot', {}, ctx)).toBe('- button "Save"');
    vi.unstubAllGlobals();
  });

  it('browser_action wait_for splits "text_visible:Done" for servers older than 2.2', async () => {
    const { buildToolArgs } = await import('./action-sequencer');
    expect(buildToolArgs({ action: 'wait_for', condition: 'text_visible:Done' })).toMatchObject({ condition: 'text_visible', value: 'Done', selector: '' });
    expect(buildToolArgs({ action: 'wait_for', condition: 'element_visible:.ok' })).toMatchObject({ condition: 'element_visible', value: '', selector: '.ok' });
    expect(buildToolArgs({ action: 'wait_for', condition: 'text_visible', value: 'Hi' })).toMatchObject({ condition: 'text_visible', value: 'Hi' });
  });
});
