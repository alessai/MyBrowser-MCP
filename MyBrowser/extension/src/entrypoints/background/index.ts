// Background service worker: ties together all extension modules.
// The SW may sleep after ~30s of inactivity (MV3). The offscreen doc
// keeps the WS connection alive independently and communicates via a
// persistent port (chrome.runtime.connect) which wakes the SW on demand.

import { addMessageHandler, sendToTab } from '../../lib/messaging';
import { InputDevice } from '../../lib/input-device';
import { handleTool, type ToolContext } from '../../lib/tools';
import { resolveTabId, injectIntoAllTabs, setLastUsedTabId, initTabCleanup } from '../../lib/tab-manager';
import {
  enableRuntime,
  enablePageDomain,
  enableNetworkDomain,
  ensureAttached,
  startConsoleCapture,
  startNetworkCapture,
  clearConsoleLogs,
  initDebuggerCleanup,
  startDialogCapture,
  startNetworkTimeoutWatchdog,
  onDebuggerAttached,
} from '../../lib/debugger';
import {
  dispatchDialog,
  dispatchNewTab,
  dispatchNetworkTimeout,
  getNetworkTimeoutThresholdForTab,
  listHandlers,
} from '../../lib/events';
import { getStorageAll } from '../../lib/storage';
import type { ToolRequest, ToolResponse, WsStatusResponse } from '../../lib/protocol';

export default defineBackground(() => {
  // =====================================================================
  // Badge indicator
  // =====================================================================

  type BadgeState = 'connected' | 'connecting' | 'disconnected';

  function setBadge(state: BadgeState): void {
    const config: Record<BadgeState, { text: string; color: string; title: string }> = {
      connected:    { text: '',   color: '#22c55e', title: 'MyBrowser — Connected' },
      connecting:   { text: '...', color: '#eab308', title: 'MyBrowser — Connecting...' },
      disconnected: { text: '!',  color: '#ef4444', title: 'MyBrowser — Disconnected' },
    };
    const { text, color, title } = config[state];
    chrome.action.setBadgeText({ text });
    chrome.action.setBadgeBackgroundColor({ color });
    chrome.action.setTitle({ title });
  }

  // Start as disconnected
  setBadge('disconnected');

  // =====================================================================
  // Offscreen document management
  // =====================================================================

  const OFFSCREEN_PATH = '/offscreen.html';

  async function ensureOffscreen(): Promise<void> {
    // getContexts is Chrome 116+. The @types/chrome typing has drifted:
    // the filter uses a ContextType enum value, and the return type is
    // declared as `Promise<ExtensionContext[]> & void` (a compiler bug
    // in the upstream typings). Call it with the enum and widen the
    // result locally so `.length` works.
    const contexts = (await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    })) as unknown as chrome.runtime.ExtensionContext[];
    if (contexts.length > 0) return;

    try {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_PATH,
        reasons: [chrome.offscreen.Reason.WEB_RTC as never],
        justification: 'Persistent WebSocket connection to MCP server',
      });
    } catch (e) {
      if (
        e instanceof Error &&
        (e.message.includes('already exists') || e.message.includes('single offscreen'))
      ) return;
      throw e;
    }
  }

  // =====================================================================
  // Offscreen ↔ Background: persistent port
  // =====================================================================

  let offscreenPort: chrome.runtime.Port | null = null;

  /** Pending reply callbacks for request/response over port */
  const pendingReplies = new Map<string, (data: unknown) => void>();
  let replyCounter = 0;

  /** Pending saveNote WS acks, keyed by our request id */
  interface SaveNoteAck {
    ok: boolean;
    noteId?: string;
    pendingCount?: number;
    error?: string;
  }
  const pendingNoteSaves = new Map<string, (ack: SaveNoteAck) => void>();
  let noteSaveCounter = 0;

  /** Pending notes-count query results */
  interface NotesCountAck {
    ok: boolean;
    pending?: number;
    archived?: number;
    error?: string;
  }
  const pendingNotesCountQueries = new Map<
    string,
    (ack: NotesCountAck) => void
  >();
  let notesCountCounter = 0;

  function sendToOffscreen(message: Record<string, unknown>): boolean {
    if (!offscreenPort) return false;
    try {
      offscreenPort.postMessage(message);
      return true;
    } catch {
      offscreenPort = null;
      return false;
    }
  }

  /** Send a message to offscreen and await a reply (port only) */
  function requestFromOffscreen(message: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve) => {
      if (!offscreenPort) {
        resolve(undefined);
        return;
      }
      const replyId = `r${++replyCounter}`;
      pendingReplies.set(replyId, resolve);
      if (!sendToOffscreen({ ...message, _replyId: replyId })) {
        pendingReplies.delete(replyId);
        resolve(undefined);
        return;
      }
      setTimeout(() => {
        if (pendingReplies.delete(replyId)) resolve(undefined);
      }, 10_000);
    });
  }

  /** Send a command to the offscreen doc, preferring port, falling back to sendMessage.
   *  Returns true on a best-effort successful dispatch, false on outright failure.
   *  Note: "true" means the message was queued; it does NOT guarantee the WS write
   *  succeeded. Call askOffscreen() when you need a positive ack from the WS layer.
   */
  async function tellOffscreen(message: Record<string, unknown>): Promise<boolean> {
    if (sendToOffscreen(message)) return true;
    try {
      await chrome.runtime.sendMessage(message);
      return true;
    } catch {
      // Offscreen not available
      return false;
    }
  }

  /** Query the offscreen doc, preferring port, falling back to sendMessage */
  async function askOffscreen(message: Record<string, unknown>): Promise<unknown> {
    if (offscreenPort) {
      return requestFromOffscreen(message);
    }
    try {
      return await chrome.runtime.sendMessage(message);
    } catch {
      return undefined;
    }
  }

  // =====================================================================
  // Handle tool requests from offscreen (WS → offscreen → here)
  // =====================================================================

  async function handleToolRequest(raw: string): Promise<void> {
    let request: ToolRequest;
    try {
      request = JSON.parse(raw);
    } catch {
      console.warn('Failed to parse WS message:', raw);
      return;
    }

    // Intercept non-tool WS messages before they hit the tool dispatcher.
    const anyMsg = request as unknown as {
      type?: string;
      id?: string;
      ok?: boolean;
      noteId?: string;
      pendingCount?: number;
      pending?: number;
      archived?: number;
      error?: string;
    };
    if (anyMsg.type === 'saveNoteResult' && anyMsg.id) {
      const cb = pendingNoteSaves.get(anyMsg.id);
      if (cb) {
        pendingNoteSaves.delete(anyMsg.id);
        cb({
          ok: !!anyMsg.ok,
          noteId: anyMsg.noteId,
          pendingCount: anyMsg.pendingCount,
          error: anyMsg.error,
        });
      }
      return;
    }
    if (anyMsg.type === 'queryNotesCountResult' && anyMsg.id) {
      const cb = pendingNotesCountQueries.get(anyMsg.id);
      if (cb) {
        pendingNotesCountQueries.delete(anyMsg.id);
        cb({
          ok: !!anyMsg.ok,
          pending: anyMsg.pending,
          archived: anyMsg.archived,
          error: anyMsg.error,
        });
      }
      return;
    }

    if (currentTabId < 0) {
      try {
        const tabId = await resolveTabId();
        setTabId(tabId);
      } catch {}
    }

    let response: ToolResponse;
    try {
      const result = await handleTool(request.type, request.payload ?? {}, toolCtx);
      response = {
        type: 'messageResponse',
        payload: { requestId: request.id, result },
      };
    } catch (e) {
      response = {
        type: 'messageResponse',
        payload: {
          requestId: request.id,
          error: e instanceof Error ? e.message : String(e),
        },
      };
    }

    await tellOffscreen({
      type: '_os_ws_send',
      payload: JSON.stringify(response),
    });
  }

  // =====================================================================
  // Port connection handler
  // =====================================================================

  chrome.runtime.onConnect.addListener((p) => {
    if (p.name !== 'offscreen') return;
    offscreenPort = p;

    p.onMessage.addListener((msg: { type: string; payload?: unknown; _replyId?: string }) => {
      // Handle reply from offscreen (response to our request)
      if (msg.type === '_os_reply' && msg._replyId) {
        const cb = pendingReplies.get(msg._replyId);
        if (cb) {
          pendingReplies.delete(msg._replyId);
          cb(msg.payload);
        }
        return;
      }

      if (msg.type === '_os_ready') {
        connectOffscreen().catch(() => {});
        return;
      }

      if (msg.type === '_os_connected') {
        setBadge('connected');
        if (currentTabId > 0) {
          enableRuntime(currentTabId).catch(() => {});
        }
        return;
      }

      if (msg.type === '_os_disconnected') {
        setBadge('disconnected');
        return;
      }

      if (msg.type === '_os_ws_receive') {
        handleToolRequest(msg.payload as string).catch((e) =>
          console.error('Tool request handler error:', e)
        );
        return;
      }
    });

    p.onDisconnect.addListener(() => {
      if (offscreenPort === p) offscreenPort = null;
    });
  });

  // =====================================================================
  // sendMessage fallback (used when port isn't established yet)
  // =====================================================================

  addMessageHandler('_os_ready', async () => {
    await connectOffscreen();
  });

  addMessageHandler('_os_connected', async () => {
    setBadge('connected');
    if (currentTabId > 0) {
      try { await enableRuntime(currentTabId); } catch {}
    }
  });

  addMessageHandler('_os_disconnected', async () => {
    setBadge('disconnected');
  });

  addMessageHandler('_os_ws_receive', async (payload) => {
    await handleToolRequest(payload as string);
  });

  // =====================================================================
  // Offscreen connection management
  // =====================================================================

  async function connectOffscreen(): Promise<void> {
    const { serverAddress, serverPort, authToken, browserName } = await getStorageAll();
    if (!serverPort || !authToken) {
      setBadge('disconnected');
      return;
    }
    setBadge('connecting');
    const host = serverAddress || 'localhost';
    const url = `ws://${host}:${serverPort}`;
    await tellOffscreen({
      type: '_os_ws_connect',
      payload: { url, token: authToken, browserName: browserName || undefined },
    });
  }

  async function ensureAlive(): Promise<void> {
    await ensureOffscreen();

    const resp = await askOffscreen({ type: '_os_ping' }) as
      { alive?: boolean; wsState?: string } | undefined;

    if (resp?.alive) {
      if (resp.wsState === 'CONNECTED') {
        setBadge('connected');
      } else if (resp.wsState === 'CONNECTING' || resp.wsState === 'AUTHENTICATING') {
        setBadge('connecting');
      } else {
        setBadge('disconnected');
        await connectOffscreen();
      }
    } else {
      // Offscreen not responding — recreate and connect
      setBadge('disconnected');
      await ensureOffscreen();
      await connectOffscreen();
    }
  }

  // =====================================================================
  // State
  // =====================================================================

  const currentInput = new InputDevice(-1);
  let currentTabId = -1;

  function getTabId(): number {
    return currentTabId;
  }

  function setTabId(tabId: number): void {
    currentTabId = tabId;
    currentInput.updateTabId(tabId);
    setLastUsedTabId(tabId);
  }

  const toolCtx: ToolContext = {
    input: currentInput,
    getTabId,
    setTabId,
  };

  // =====================================================================
  // Init cleanup listeners
  // =====================================================================

  initDebuggerCleanup();
  initTabCleanup();

  // =====================================================================
  // Popup → Background messages
  // =====================================================================

  addMessageHandler('ws_status', async () => {
    const resp = await askOffscreen({ type: '_os_ws_status' });
    return resp ?? { state: 'DISCONNECTED' } satisfies WsStatusResponse;
  });

  addMessageHandler('ws_reconnect', async () => {
    setBadge('connecting');
    await connectOffscreen();
    return { ok: true };
  });

  addMessageHandler('select_tab', async (payload) => {
    const { tabId } = payload as { tabId: number };
    setTabId(tabId);
    try { await enableRuntime(tabId); } catch {}
    clearConsoleLogs();
  });

  addMessageHandler('ping', async () => 'pong');

  // =====================================================================
  // Annotation popup info: hotkey binding + pending note count
  // =====================================================================

  async function queryNotesCountOverWs(): Promise<NotesCountAck> {
    const id = `c${++notesCountCounter}_${Date.now().toString(36)}`;
    const msg = { type: 'queryNotesCount', id };
    return new Promise<NotesCountAck>((resolve) => {
      const timer = setTimeout(() => {
        pendingNotesCountQueries.delete(id);
        resolve({ ok: false, error: 'Timeout' });
      }, 5_000);
      pendingNotesCountQueries.set(id, (ack) => {
        clearTimeout(timer);
        resolve(ack);
      });
      askOffscreen({
        type: '_os_ws_send',
        payload: JSON.stringify(msg),
      })
        .then((sendResult) => {
          const r = sendResult as { ok?: boolean; error?: string } | undefined;
          if (r && r.ok === false) {
            clearTimeout(timer);
            pendingNotesCountQueries.delete(id);
            resolve({ ok: false, error: r.error || 'WebSocket send failed' });
          } else if (r === undefined) {
            clearTimeout(timer);
            pendingNotesCountQueries.delete(id);
            resolve({ ok: false, error: 'Offscreen unreachable' });
          }
        })
        .catch((e) => {
          clearTimeout(timer);
          pendingNotesCountQueries.delete(id);
          resolve({ ok: false, error: e instanceof Error ? e.message : String(e) });
        });
    });
  }

  addMessageHandler('get_annotation_info', async () => {
    let hotkey: string | null = null;
    try {
      const commands = await chrome.commands.getAll();
      const cmd = commands.find((c) => c.name === 'open_annotation');
      hotkey = cmd?.shortcut && cmd.shortcut.length > 0 ? cmd.shortcut : null;
    } catch {
      hotkey = null;
    }
    const ack = await queryNotesCountOverWs();
    return {
      hotkey,
      pending: ack.ok ? (ack.pending ?? 0) : null,
      archived: ack.ok ? (ack.archived ?? 0) : null,
      error: ack.ok ? null : ack.error ?? 'Unknown error',
    };
  });

  // =====================================================================
  // Annotation notes — capture + upload
  // =====================================================================

  interface AnnotationSavePayload {
    url: string;
    title: string;
    note: string;
    metadata: {
      viewport: {
        width: number;
        height: number;
        scrollX: number;
        scrollY: number;
        dpr: number;
      };
      boundingBox?: { x: number; y: number; w: number; h: number };
      nearestElement?: {
        ref?: string;
        role?: string;
        name?: string;
        tagName?: string;
      };
    };
  }

  /** Decode a data URL into an ImageBitmap. */
  async function dataUrlToBitmap(dataUrl: string): Promise<ImageBitmap> {
    const res = await fetch(dataUrl);
    const blob = await res.blob();
    return await createImageBitmap(blob);
  }

  /** Convert an OffscreenCanvas to base64 PNG. */
  async function canvasToBase64Png(canvas: OffscreenCanvas): Promise<string> {
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    const buf = await blob.arrayBuffer();
    // btoa works on binary strings; build one from bytes
    const bytes = new Uint8Array(buf);
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(
        null,
        Array.from(bytes.subarray(i, i + chunkSize)),
      );
    }
    return btoa(binary);
  }

  /**
   * Capture the visible viewport of the active tab as base64 PNG.
   * On high-DPR displays the raw capture can exceed 8 MB — if the image
   * is wider than 2 × viewport.width, downsample before returning.
   */
  async function captureViewportPng(
    windowId: number | undefined,
    viewportWidth: number,
    viewportHeight: number,
  ): Promise<string> {
    const dataUrl = await chrome.tabs.captureVisibleTab(
      windowId ?? chrome.windows.WINDOW_ID_CURRENT,
      { format: 'png' },
    );
    const comma = dataUrl.indexOf(',');
    if (comma < 0) throw new Error('Invalid capture data URL');

    const maxWidth = Math.round(viewportWidth * 2);
    const maxHeight = Math.round(viewportHeight * 2);

    let bitmap: ImageBitmap;
    try {
      bitmap = await dataUrlToBitmap(dataUrl);
    } catch {
      // Decode failed — fall back to returning the raw base64
      return dataUrl.slice(comma + 1);
    }

    if (bitmap.width <= maxWidth && bitmap.height <= maxHeight) {
      bitmap.close?.();
      return dataUrl.slice(comma + 1);
    }

    const scale = Math.min(maxWidth / bitmap.width, maxHeight / bitmap.height);
    const targetW = Math.round(bitmap.width * scale);
    const targetH = Math.round(bitmap.height * scale);

    try {
      const canvas = new OffscreenCanvas(targetW, targetH);
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        bitmap.close?.();
        return dataUrl.slice(comma + 1);
      }
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bitmap, 0, 0, targetW, targetH);
      bitmap.close?.();
      return await canvasToBase64Png(canvas);
    } catch (e) {
      console.error('[MyBrowser] Downsample failed, using raw capture:', e);
      return dataUrl.slice(comma + 1);
    }
  }

  /** Send a saveNote WS message and await the server ack.
   *  Uses askOffscreen so we learn immediately if the WS layer failed to
   *  dispatch the message, instead of waiting the full 15 s timeout.
   */
  async function sendSaveNoteOverWs(
    payload: Record<string, unknown>,
  ): Promise<SaveNoteAck> {
    const id = `n${++noteSaveCounter}_${Date.now().toString(36)}`;
    const msg = { type: 'saveNote', id, payload };

    return new Promise<SaveNoteAck>((resolve) => {
      const timer = setTimeout(() => {
        pendingNoteSaves.delete(id);
        resolve({ ok: false, error: 'Timeout waiting for server ack' });
      }, 15_000);
      pendingNoteSaves.set(id, (ack) => {
        clearTimeout(timer);
        resolve(ack);
      });

      // Ask offscreen to send — it returns {ok: boolean, error?: string}
      // synchronously from the WS layer's perspective.
      askOffscreen({
        type: '_os_ws_send',
        payload: JSON.stringify(msg),
      })
        .then((sendResult) => {
          const r = sendResult as { ok?: boolean; error?: string } | undefined;
          if (r && r.ok === false) {
            clearTimeout(timer);
            pendingNoteSaves.delete(id);
            resolve({
              ok: false,
              error: r.error || 'WebSocket send failed',
            });
          }
          // If r.ok === true we wait for the server ack via the pending map.
          // If r is undefined (offscreen unreachable), we also short-circuit.
          if (r === undefined) {
            clearTimeout(timer);
            pendingNoteSaves.delete(id);
            resolve({ ok: false, error: 'Offscreen unreachable' });
          }
        })
        .catch((e) => {
          clearTimeout(timer);
          pendingNoteSaves.delete(id);
          resolve({
            ok: false,
            error: e instanceof Error ? e.message : String(e),
          });
        });
    });
  }

  addMessageHandler('annotation_save', async (payload, sender) => {
    const p = payload as AnnotationSavePayload;
    const tabId = sender.tab?.id;
    const windowId = sender.tab?.windowId;
    if (tabId === undefined) {
      throw new Error('annotation_save: missing sender tab');
    }
    try {
      // Capture viewport — overlay canvas strokes are baked in because the
      // canvas is real DOM; overlay UI was hidden by the content script
      // (but the canvas itself is still visible). We do NOT tear down the
      // overlay here: if the save fails, the content script will restore
      // the UI so the user can retry without losing their drawing.
      const pngBase64 = await captureViewportPng(
        windowId,
        p.metadata.viewport.width,
        p.metadata.viewport.height,
      );

      // Send to server and await positive ack. If the WS is down we short-
      // circuit via askOffscreen inside sendSaveNoteOverWs.
      const ack = await sendSaveNoteOverWs({
        url: p.url,
        title: p.title,
        note: p.note,
        pngBase64,
        viewport: p.metadata.viewport,
        nearestElement: p.metadata.nearestElement,
      });

      if (!ack.ok) {
        console.error('[MyBrowser] saveNote failed:', ack.error);
        // Leave the overlay intact; content script will restore the UI.
        return { ok: false, error: ack.error };
      }
      return { ok: true, noteId: ack.noteId, pendingCount: ack.pendingCount ?? 0 };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[MyBrowser] annotation_save error:', msg);
      // Don't tear down the overlay on error — content script will restore it.
      return { ok: false, error: msg };
    }
  });

  // =====================================================================
  // Hotkey command — opens annotation overlay on the active tab
  // =====================================================================

  const UNSUPPORTED_URL_PREFIXES = [
    'chrome:',
    'chrome-extension:',
    'edge:',
    'about:',
    'view-source:',
  ];

  function isUnsupportedAnnotationUrl(url: string | undefined): boolean {
    if (!url) return true;
    const lower = url.toLowerCase();
    if (UNSUPPORTED_URL_PREFIXES.some((p) => lower.startsWith(p))) return true;
    if (lower.endsWith('.pdf')) return true;
    return false;
  }

  chrome.commands.onCommand.addListener(async (command) => {
    if (command !== 'open_annotation') return;
    try {
      const [tab] = await chrome.tabs.query({
        active: true,
        lastFocusedWindow: true,
      });
      if (!tab?.id) return;
      if (isUnsupportedAnnotationUrl(tab.url)) {
        console.error('[MyBrowser] annotation: unsupported page', tab.url);
        return;
      }
      await sendToTab(tab.id, 'open_annotation_overlay');
    } catch (e) {
      console.error('[MyBrowser] open_annotation command failed:', e);
    }
  });

  // =====================================================================
  // Lifecycle — always-on, survive hours of inactivity
  // =====================================================================

  ensureAlive().catch((e) => console.error('Init failed:', e));

  chrome.runtime.onInstalled.addListener(async () => {
    await ensureAlive();
    await injectIntoAllTabs();
  });

  chrome.runtime.onStartup.addListener(async () => {
    await ensureAlive();
  });

  // Alarm every 25 seconds to:
  // 1. Keep the SW from being terminated (MV3 kills SW after ~30s idle)
  // 2. Verify offscreen doc is alive and WS is connected
  // 3. Recreate offscreen + reconnect if anything died
  chrome.alarms.create('keepalive', { periodInMinutes: 25 / 60 });
  chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === 'keepalive') {
      await ensureAlive();
    }
  });

  // Re-connect when user updates settings
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.serverAddress || changes.serverPort || changes.authToken || changes.browserName) {
      setBadge('connecting');
      connectOffscreen();
    }
  });

  startConsoleCapture(() => (currentTabId > 0 ? currentTabId : null));
  startNetworkCapture(() => (currentTabId > 0 ? currentTabId : null));

  // F1: dialog interception + new_tab + network_timeout watchdog
  startDialogCapture({
    decide: (data, tabId) => {
      const result = dispatchDialog(data, tabId);
      return result.execute.dialog ?? null;
    },
  });

  // Helpers: does any browser-wide handler of the given kind exist?
  function hasBrowserWideDialogHandler(): boolean {
    return listHandlers().some(
      (h) =>
        (h.event === 'dialog' || h.event === 'beforeunload') &&
        h.options?.tabId === undefined,
    );
  }
  function hasBrowserWideNetworkTimeoutHandler(): boolean {
    return listHandlers().some(
      (h) => h.event === 'network_timeout' && h.options?.tabId === undefined,
    );
  }

  // When a tab gets attached (first tool call against it), enable the
  // CDP domains for any browser-wide handlers that are active so the
  // tab is covered from that moment on.
  onDebuggerAttached((tabId) => {
    if (hasBrowserWideDialogHandler()) {
      enablePageDomain(tabId).catch(() => { /* best-effort */ });
    }
    if (hasBrowserWideNetworkTimeoutHandler()) {
      enableNetworkDomain(tabId).catch(() => { /* best-effort */ });
    }
  });

  chrome.tabs.onCreated.addListener(async (tab) => {
    if (tab.id === undefined) return;

    // Best-effort eager attach + domain enable for brand-new tabs.
    //
    // KNOWN GAP: this path is racy by nature. ensureAttached +
    // Page.enable / Network.enable are all async, so a page script
    // that opens a dialog OR kicks off a network request in its very
    // first microtask can beat us to it. Affects BOTH:
    //   - browser-wide dialog handlers (first dialog on a popup)
    //   - browser-wide network_timeout handlers (earliest requests
    //     on a popup don't populate pendingRequestsByTab)
    // The onDebuggerAttached hook above covers tabs that get attached
    // later via a user-triggered tool call, but the first moments of
    // a brand-new popup tab remain a documented best-effort gap.
    const needPage = hasBrowserWideDialogHandler();
    const needNetwork = hasBrowserWideNetworkTimeoutHandler();
    if (needPage || needNetwork) {
      try {
        await ensureAttached(tab.id);
        if (needPage) await enablePageDomain(tab.id);
        if (needNetwork) await enableNetworkDomain(tab.id);
      } catch { /* tab may not be attachable (chrome://, etc.) */ }
    }

    const result = dispatchNewTab({
      tabId: tab.id,
      openerTabId: tab.openerTabId,
      url: tab.pendingUrl ?? tab.url,
    });
    if (result.execute.closeNewTab) {
      chrome.tabs.remove(tab.id).catch(() => { /* already gone */ });
    }
  });

  startNetworkTimeoutWatchdog(
    (tabId) => getNetworkTimeoutThresholdForTab(tabId),
    (data, tabId) => {
      dispatchNetworkTimeout(data, tabId);
    },
  );

  console.log('MyBrowser service worker started');
});
