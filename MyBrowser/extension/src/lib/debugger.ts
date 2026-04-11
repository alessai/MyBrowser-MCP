// Chrome Debugger management: attach, detach, send CDP commands with error recovery

type Debuggee = chrome.debugger.Debuggee;

const DETACH_DELAY_MS = 3000;

type DebuggerError =
  | 'notAttached'
  | 'alreadyAttached'
  | 'otherExtension'
  | 'debuggerDetached'
  | 'unknown';

const ERROR_PATTERNS = {
  NOT_ATTACHED: 'Debugger is not attached to the tab with id',
  ALREADY_ATTACHED: 'Another debugger is already attached to the tab with id',
  OTHER_EXTENSION: 'Cannot access a chrome-extension:// URL of different extension',
  DEBUGGER_DETACHED: 'Detached while handling command.',
} as const;

function classifyError(message: string): DebuggerError {
  if (message.includes(ERROR_PATTERNS.NOT_ATTACHED)) return 'notAttached';
  if (message.includes(ERROR_PATTERNS.ALREADY_ATTACHED)) return 'alreadyAttached';
  if (message === ERROR_PATTERNS.OTHER_EXTENSION) return 'otherExtension';
  if (message === ERROR_PATTERNS.DEBUGGER_DETACHED) return 'debuggerDetached';
  return 'unknown';
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const detachTimers = new Map<number, ReturnType<typeof setTimeout>>();
const attachedTabs = new Set<number>();

/** Listeners that fire whenever a tab successfully attaches the debugger.
 *  Used by F1 to enable Page domain for dialog/beforeunload coverage on
 *  browser-wide handlers without the caller having to track attach events. */
const attachListeners: Array<(tabId: number) => void> = [];

export function onDebuggerAttached(cb: (tabId: number) => void): () => void {
  attachListeners.push(cb);
  return () => {
    const idx = attachListeners.indexOf(cb);
    if (idx >= 0) attachListeners.splice(idx, 1);
  };
}

function notifyAttached(tabId: number): void {
  for (const cb of attachListeners) {
    try {
      cb(tabId);
    } catch (e) {
      console.warn('[MyBrowser] onDebuggerAttached listener threw:', e);
    }
  }
}

export function getAttachedTabs(): number[] {
  return Array.from(attachedTabs);
}

async function doAttach(target: Debuggee, version: string): Promise<void> {
  try {
    await chrome.debugger.attach(target, version);
  } catch (e) {
    const msg = errorMessage(e);
    if (classifyError(msg) === 'alreadyAttached') return;
    throw e;
  }
}

async function doDetach(target: Debuggee): Promise<void> {
  try {
    await chrome.debugger.detach(target);
  } catch (e) {
    const msg = errorMessage(e);
    const kind = classifyError(msg);
    if (kind === 'notAttached' || kind === 'otherExtension') return;
    throw e;
  }
}

async function handleError(err: Error, target: Debuggee): Promise<void> {
  const kind = classifyError(err.message);
  if (kind === 'notAttached') {
    await doAttach(target, '1.3');
  } else if (kind === 'alreadyAttached') {
    // Already good
  } else if (kind === 'otherExtension') {
    // Can't debug chrome-extension:// pages — clean up and throw
    if (target.tabId !== undefined) attachedTabs.delete(target.tabId);
    throw err;
  } else if (kind === 'debuggerDetached') {
    if (target.tabId !== undefined) attachedTabs.delete(target.tabId);
    await doAttach(target, '1.3');
  } else {
    throw err;
  }
}

export async function ensureAttached(tabId: number): Promise<void> {
  // Cancel any pending detach
  const existing = detachTimers.get(tabId);
  if (existing) {
    clearTimeout(existing);
    detachTimers.delete(tabId);
  }

  const target: Debuggee = { tabId };
  try {
    await doAttach(target, '1.3');
    const wasAttached = attachedTabs.has(tabId);
    attachedTabs.add(tabId);
    if (!wasAttached) notifyAttached(tabId);
  } catch (e) {
    if (!(e instanceof Error)) throw e;
    const kind = classifyError(e.message);

    if (kind === 'alreadyAttached') {
      try {
        await doDetach(target);
        await doAttach(target, '1.3');
        const wasAttached = attachedTabs.has(tabId);
        attachedTabs.add(tabId);
        if (!wasAttached) notifyAttached(tabId);
      } catch {
        throw e;
      }
    } else if (kind === 'otherExtension') {
      attachedTabs.delete(tabId);
      let diag = '';
      try {
        const tab = await chrome.tabs.get(tabId);
        const targets = await chrome.debugger.getTargets();
        const related = targets.filter((t) => t.tabId === tabId);
        diag = ` | tab url=${tab.url} | targets: ${JSON.stringify(related)}`;
      } catch { /* best-effort */ }

      throw new Error(
        `${e.message} — Another Chrome extension is blocking debugger access. ` +
        `Close DevTools, disable the conflicting extension in chrome://extensions, ` +
        `and open a new tab.${diag}`,
      );
    } else {
      await handleError(e, target);
      attachedTabs.add(tabId);
    }
  }
}

export function scheduleDetach(tabId: number): void {
  const existing = detachTimers.get(tabId);
  if (existing) clearTimeout(existing);

  detachTimers.set(
    tabId,
    setTimeout(async () => {
      detachTimers.delete(tabId);
      attachedTabs.delete(tabId);
      await doDetach({ tabId });
    }, DETACH_DELAY_MS),
  );
}

export async function sendCommand<T = unknown>(
  tabId: number,
  method: string,
  params?: Record<string, unknown>,
): Promise<T | undefined> {
  const target: Debuggee = { tabId };
  try {
    return (await chrome.debugger.sendCommand(target, method, params)) as T;
  } catch (e) {
    if (!(e instanceof Error)) throw e;
    await handleError(e, target);
    if (classifyError(e.message) !== 'debuggerDetached') {
      return (await chrome.debugger.sendCommand(target, method, params)) as T;
    }
  }
}

export async function enableRuntime(tabId: number): Promise<void> {
  await ensureAttached(tabId);
  await sendCommand(tabId, 'Runtime.enable');
}

export async function enablePageDomain(tabId: number): Promise<void> {
  await ensureAttached(tabId);
  await sendCommand(tabId, 'Page.enable');
}

export async function enableNetworkDomain(tabId: number): Promise<void> {
  await ensureAttached(tabId);
  await sendCommand(tabId, 'Network.enable');
}

// Console log capture
export interface ConsoleEntry {
  type: string;
  timestamp: number;
  message: string;
}

const MAX_CONSOLE_ENTRIES = 100;
let consoleLogs: ConsoleEntry[] = [];

export function getConsoleLogs(): ConsoleEntry[] {
  return consoleLogs;
}

export function clearConsoleLogs(): void {
  consoleLogs = [];
}

function formatRemoteObject(obj: { value?: unknown; preview?: unknown; description?: string }): string {
  if (obj.value !== undefined) {
    return typeof obj.value === 'string' ? obj.value : JSON.stringify(obj.value);
  }
  if (obj.preview !== undefined) return JSON.stringify(obj.preview);
  return obj.description || JSON.stringify(obj);
}

export function startConsoleCapture(getActiveTabId: () => number | null): () => void {
  // chrome.debugger.onEvent callback signature has the third param as
  // optional `Object | undefined` in the upstream types. Accept that
  // shape and narrow to Record<string, unknown> locally.
  const listener = (
    source: Debuggee,
    method: string,
    params?: Object,
  ): void => {
    const activeTabId = getActiveTabId();
    if (source.tabId !== activeTabId) return;
    if (!params) return;

    if (method === 'Runtime.consoleAPICalled') {
      const { type, timestamp, args } = params as {
        type: string;
        timestamp: number;
        args: Array<{ value?: unknown; preview?: unknown; description?: string }>;
      };
      const message = args.map(formatRemoteObject).join(' ');
      consoleLogs.push({ type, timestamp, message });
    } else if (method === 'Runtime.exceptionThrown') {
      const { timestamp, exceptionDetails } = params as {
        timestamp: number;
        exceptionDetails: { exception?: { description?: string } };
      };
      consoleLogs.push({
        type: 'exception',
        timestamp,
        message: exceptionDetails.exception?.description || JSON.stringify(exceptionDetails),
      });
    }

    if (consoleLogs.length > MAX_CONSOLE_ENTRIES) {
      consoleLogs.shift();
    }
  };

  chrome.debugger.onEvent.addListener(listener);
  return () => chrome.debugger.onEvent.removeListener(listener);
}

// Network request capture
export interface NetworkEntry {
  requestId: string;
  url: string;
  method: string;
  resourceType: string;
  timestamp: number;
  status?: number;
  statusText?: string;
  mimeType?: string;
  responseTimestamp?: number;
  failed?: boolean;
  errorText?: string;
}

const MAX_NETWORK_ENTRIES = 200;
let networkLog: NetworkEntry[] = [];
let networkCaptureActive = false;

export function getNetworkLog(): NetworkEntry[] {
  return networkLog;
}

export function clearNetworkLog(): void {
  networkLog = [];
}

export function isNetworkCaptureActive(): boolean {
  return networkCaptureActive;
}

export function setNetworkCaptureActive(active: boolean): void {
  networkCaptureActive = active;
}

export function startNetworkCapture(getActiveTabId: () => number | null): () => void {
  const listener = (
    source: Debuggee,
    method: string,
    params?: Object,
  ): void => {
    if (!params || source.tabId === undefined) return;

    // Track pending requests for ALL attached tabs — the F1
    // network_timeout watchdog needs browser-wide coverage so a
    // browser-wide handler can fire on non-active tabs. Gating this on
    // activeTabId would silently make network_timeout tab-scoped.
    if (method === 'Network.requestWillBeSent') {
      const { requestId, request } = params as {
        requestId: string;
        request: { url: string; method: string };
      };
      trackRequestStart(source.tabId, requestId, request.url, request.method);
    } else if (
      method === 'Network.responseReceived' ||
      method === 'Network.loadingFailed' ||
      method === 'Network.loadingFinished'
    ) {
      const { requestId } = params as { requestId: string };
      trackRequestEnd(source.tabId, requestId);
    }

    // Everything below is the networkLog — only runs when the user
    // has explicitly turned on browser_network capture, AND only for
    // the user's currently active tab (existing semantic).
    if (!networkCaptureActive) return;
    const activeTabId = getActiveTabId();
    if (source.tabId !== activeTabId) return;

    if (method === 'Network.requestWillBeSent') {
      const { requestId, request, timestamp, type: resourceType } = params as {
        requestId: string;
        request: { url: string; method: string };
        timestamp: number;
        type: string;
      };
      networkLog.push({
        requestId,
        url: request.url,
        method: request.method,
        resourceType: resourceType || 'Other',
        timestamp,
      });
      if (networkLog.length > MAX_NETWORK_ENTRIES) {
        networkLog.shift();
      }
    } else if (method === 'Network.responseReceived') {
      const { requestId, response, timestamp } = params as {
        requestId: string;
        response: { status: number; statusText: string; mimeType: string };
        timestamp: number;
      };
      const entry = networkLog.find((e) => e.requestId === requestId);
      if (entry) {
        entry.status = response.status;
        entry.statusText = response.statusText;
        entry.mimeType = response.mimeType;
        entry.responseTimestamp = timestamp;
      }
    } else if (method === 'Network.loadingFailed') {
      const { requestId, errorText } = params as {
        requestId: string;
        errorText: string;
      };
      const entry = networkLog.find((e) => e.requestId === requestId);
      if (entry) {
        entry.failed = true;
        entry.errorText = errorText;
      }
    }
  };

  chrome.debugger.onEvent.addListener(listener);
  return () => chrome.debugger.onEvent.removeListener(listener);
}

// Cleanup on tab close (guarded for WXT build-time evaluation)
export function initDebuggerCleanup(): void {
  chrome.tabs.onRemoved.addListener((tabId) => {
    attachedTabs.delete(tabId);
    pendingRequestsByTab.delete(tabId);
    const timer = detachTimers.get(tabId);
    if (timer) {
      clearTimeout(timer);
      detachTimers.delete(tabId);
    }
  });
}

// ---------------------------------------------------------------------------
// F1: dialog interception via Page.javascriptDialogOpening
// ---------------------------------------------------------------------------

export interface DialogHandler {
  /** Called for each dialog event; should return the action to take, or
   *  null to leave the dialog alone (user will respond manually). */
  decide: (
    data: {
      type: string;
      message: string;
      url?: string;
      defaultPrompt?: string;
    },
    tabId: number,
  ) => { accept: boolean; promptText?: string } | null;
}

/**
 * Start listening for dialog events on attached tabs. Page domain must
 * be enabled via `enablePageDomain(tabId)` on each tab you want to
 * intercept. Returns a cleanup function that removes the CDP listener.
 */
export function startDialogCapture(handler: DialogHandler): () => void {
  const listener = (
    source: Debuggee,
    method: string,
    params?: Object,
  ): void => {
    if (method !== 'Page.javascriptDialogOpening') return;
    if (source.tabId === undefined || !params) return;

    const p = params as {
      type?: string;
      message?: string;
      url?: string;
      defaultPrompt?: string;
    };
    if (!p.type || !p.message) return;

    const decision = handler.decide(
      {
        type: p.type,
        message: p.message,
        url: p.url,
        defaultPrompt: p.defaultPrompt,
      },
      source.tabId,
    );

    if (decision === null) return; // no matching handler — leave it

    // Resolve the dialog via CDP. This unblocks the page.
    const tabId = source.tabId;
    sendCommand(tabId, 'Page.handleJavaScriptDialog', {
      accept: decision.accept,
      promptText: decision.promptText,
    }).catch((e) => {
      console.warn('[MyBrowser] Page.handleJavaScriptDialog failed:', e);
    });
  };

  chrome.debugger.onEvent.addListener(listener);
  return () => chrome.debugger.onEvent.removeListener(listener);
}

// ---------------------------------------------------------------------------
// F1: network_timeout watchdog
// ---------------------------------------------------------------------------

interface PendingRequest {
  requestId: string;
  url: string;
  method: string;
  startedAt: number;
  /** Set once the watchdog has already fired for this request, so we
   *  don't emit the same event every sweep tick. */
  fired: boolean;
}

/** Per-tab pending-request tracking, populated by the network capture
 *  listener. Purged on responseReceived / loadingFailed / loadingFinished. */
const pendingRequestsByTab = new Map<number, Map<string, PendingRequest>>();

export async function waitForNetworkIdle(
  tabId: number,
  idleMs = 500,
  timeoutMs = 10_000,
  pollIntervalMs = 100,
): Promise<void> {
  const startedAt = Date.now();
  let idleStartedAt: number | null = null;

  while (Date.now() - startedAt < timeoutMs) {
    const pendingCount = pendingRequestsByTab.get(tabId)?.size ?? 0;

    if (pendingCount === 0) {
      if (idleStartedAt === null) idleStartedAt = Date.now();
      if (Date.now() - idleStartedAt >= idleMs) return;
    } else {
      idleStartedAt = null;
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error(`Timeout after ${timeoutMs}ms waiting for network idle`);
}

function getPendingMap(tabId: number): Map<string, PendingRequest> {
  let m = pendingRequestsByTab.get(tabId);
  if (!m) {
    m = new Map();
    pendingRequestsByTab.set(tabId, m);
  }
  return m;
}

function trackRequestStart(
  tabId: number,
  requestId: string,
  url: string,
  method: string,
): void {
  getPendingMap(tabId).set(requestId, {
    requestId,
    url,
    method,
    startedAt: Date.now(),
    fired: false,
  });
}

function trackRequestEnd(tabId: number, requestId: string): void {
  pendingRequestsByTab.get(tabId)?.delete(requestId);
}

/** Hard cap on how long a pending request can stay in the tracker.
 *  If Chrome drops the loadingFinished/Failed event (known to happen
 *  on reloads and aborted downloads), we'd otherwise leak entries
 *  forever. Purge anything older than this, fired or not. */
const PENDING_REQUEST_TTL_MS = 5 * 60 * 1000;
/** Absolute cap on concurrent pending entries per tab — if this is
 *  exceeded we evict the oldest to bound memory on pathological sites. */
const MAX_PENDING_PER_TAB = 500;

/**
 * Start the per-request timeout watchdog. Caller passes a function
 * that returns the threshold FOR A GIVEN TAB (or null if no handler
 * applies to that tab), and a callback invoked per stuck request.
 *
 * Per-tab threshold resolution honors handler precedence: a tab-scoped
 * rule can override a browser-wide rule without the two blurring into
 * a global minimum.
 *
 * Each tick also sweeps expired entries (TTL) so forgotten requests
 * don't accumulate even when no network_timeout handler is active.
 * The sweep fires matched-stuck-request events BEFORE TTL eviction so
 * a threshold near the TTL still reaches the handler.
 */
export function startNetworkTimeoutWatchdog(
  getThresholdForTab: (tabId: number) => number | null,
  onStuckRequest: (
    data: {
      requestId: string;
      url: string;
      method: string;
      pendingMs: number;
    },
    tabId: number,
  ) => void,
  sweepIntervalMs = 1_000,
): () => void {
  const timer = setInterval(() => {
    const now = Date.now();

    for (const [tabId, pending] of pendingRequestsByTab) {
      // Per-tab size cap: if we're over, evict oldest.
      if (pending.size > MAX_PENDING_PER_TAB) {
        const excess = pending.size - MAX_PENDING_PER_TAB;
        const iter = pending.keys();
        for (let i = 0; i < excess; i++) {
          const key = iter.next().value;
          if (key === undefined) break;
          pending.delete(key);
        }
      }

      const threshold = getThresholdForTab(tabId);

      for (const [reqId, req] of pending) {
        const age = now - req.startedAt;

        // Fire-once per-request stuck event FIRST, so a threshold
        // that's close to (but under) the TTL still surfaces to the
        // handler before eviction.
        if (threshold !== null && !req.fired && age >= threshold) {
          req.fired = true;
          onStuckRequest(
            {
              requestId: req.requestId,
              url: req.url,
              method: req.method,
              pendingMs: age,
            },
            tabId,
          );
        }

        // Then TTL eviction — unconditional so leaks self-heal even
        // with no network_timeout handler registered.
        if (age > PENDING_REQUEST_TTL_MS) {
          pending.delete(reqId);
        }
      }
    }
  }, sweepIntervalMs);

  return () => clearInterval(timer);
}

// Export the tracking helpers so the existing network capture path can
// populate the pending map.
export { trackRequestStart, trackRequestEnd };
