// Tool handlers for browser automation (ULTRA Phase 1)

import { InputDevice } from './input-device';
import {
  resolveTabId,
  setLastUsedTabId,
  listTabs as listTabsImpl,
  ensureContentScript,
} from './tab-manager';
import { sendToTab } from './messaging';
import {
  ensureAttached,
  sendCommand,
  getConsoleLogs,
  clearConsoleLogs,
  enableRuntime,
  enablePageDomain,
  enableNetworkDomain,
  getAttachedTabs,
  getNetworkLog,
  clearNetworkLog,
  isNetworkCaptureActive,
  setNetworkCaptureActive,
  type NetworkEntry,
} from './debugger';
import {
  addHandler,
  removeHandler,
  clearHandlers,
  listHandlers,
  type EventHandler,
} from './events';
import { runActionSequence, type ActionStep } from './action-sequencer';
import {
  isRecording,
  startRecording,
  stopRecording,
  shouldRecord,
  pushStep,
  setReplaying,
  saveRecordingToStorage,
  loadRecordingFromStorage,
  listRecordingsFromStorage,
  type Recording,
} from './recorder';
import { replayRecording, type ReplayOptions } from './replayer';

const STABLE_DOM_TIMEOUT_MS = 2000;
const STABLE_DOM_MIN_MS = 500;
const SCREENSHOT_MAX_WIDTH = 1024;
const SCREENSHOT_MAX_HEIGHT = 768;
const AFTER_ACTION_DELAY_MS = 500;

// --- Shared helpers ---

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForStableDOM(tabId: number): Promise<void> {
  try {
    // Race against a hard timeout to prevent hanging when content script dies (e.g. after navigation)
    await Promise.race([
      sendToTab(tabId, 'waitForStableDOM', {
        minStableMs: STABLE_DOM_MIN_MS,
        maxMutations: 0,
        maxWaitMs: STABLE_DOM_TIMEOUT_MS,
      }),
      delay(STABLE_DOM_TIMEOUT_MS + 500), // Hard cap: always resolve within timeout + 500ms
    ]);
  } catch {
    // Content script may be gone (page navigated) or not support this; ignore
  }
}

/**
 * Resolve an element target to a CSS selector.
 * Supports: ref, mark, selector, role+name, text, label (NL targeting).
 * Falls back to legacy ref-only if only `ref` is provided.
 */
async function resolveTarget(
  tabId: number,
  args: Record<string, unknown>,
): Promise<string> {
  // Build descriptor from all possible targeting params
  const descriptor: Record<string, unknown> = {};
  if (args.ref) descriptor.ref = args.ref;
  if (args.mark !== undefined) descriptor.mark = args.mark;
  if (args.selector) descriptor.selector = args.selector;
  if (args.role) descriptor.role = args.role;
  if (args.name) descriptor.name = args.name;
  if (args.text) descriptor.text = args.text;
  if (args.matchText) descriptor.text = args.matchText;
  if (args.label) descriptor.label = args.label;
  if (args.placeholder) descriptor.placeholder = args.placeholder;
  if (args.near) descriptor.near = args.near;

  // If only ref is provided, use legacy path for backwards compat
  if (Object.keys(descriptor).length === 1 && descriptor.ref) {
    return sendToTab<string>(tabId, 'getSelectorForAriaRef', { ariaRef: descriptor.ref });
  }

  // If no targeting params at all, error
  if (Object.keys(descriptor).length === 0) {
    throw new Error('No element targeting params provided. Use ref, mark, selector, role, name, text, or label.');
  }

  // Use the NL resolver
  return sendToTab<string>(tabId, 'resolveElement', descriptor);
}

async function resolveTargetCoords(
  tabId: number,
  args: Record<string, unknown>,
  options?: { clickable?: boolean },
): Promise<{ x: number; y: number }> {
  const selector = await resolveTarget(tabId, args);
  await sendToTab(tabId, 'scrollIntoView', { selector });
  const coords = await sendToTab<{ x: number; y: number } | null>(tabId, 'getElementCoordinates', {
    selector,
    options,
  });
  if (!coords) throw new Error('No coordinates found for element');
  return coords;
}

async function scrollIntoView(tabId: number, selector: string): Promise<void> {
  await sendToTab(tabId, 'scrollIntoView', { selector });
}

function waitForTabLoad(tabId: number, timeoutMs = 30000): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    }, timeoutMs);
    const onUpdated = (id: number, info: chrome.tabs.TabChangeInfo) => {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId, (tab) => {
      if (tab?.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
    });
  });
}

// --- Screenshot helpers ---

function stripDataUrlPrefix(dataUrl: string): string {
  return dataUrl.replace(/^data:image\/[^;]+;base64,/, '');
}

async function captureScreenshot(tabId: number): Promise<string> {
  // Always use CDP for consistent sizing — capture at reduced scale to avoid
  // multi-MB images that timeout during WS transfer. This skips the content
  // script resize roundtrip entirely.
  await ensureAttached(tabId);
  const metrics = await sendCommand<{
    cssVisualViewport: { clientWidth: number; clientHeight: number };
  }>(tabId, 'Page.getLayoutMetrics');

  const { clientWidth, clientHeight } = metrics!.cssVisualViewport;

  // Calculate scale to fit within max dimensions
  const scaleX = SCREENSHOT_MAX_WIDTH / clientWidth;
  const scaleY = SCREENSHOT_MAX_HEIGHT / clientHeight;
  const scale = Math.min(scaleX, scaleY, 1); // Never upscale

  const result = await sendCommand<{ data: string }>(tabId, 'Page.captureScreenshot', {
    format: 'png',
    clip: {
      x: 0,
      y: 0,
      width: Math.ceil(clientWidth),
      height: Math.ceil(clientHeight),
      scale,
    },
    captureBeyondViewport: true,
  });

  return `data:image/png;base64,${result!.data}`;
}

// --- Helper: send a message to the server via WS (fire-and-forget) ---

async function sendToServer(type: string, payload: unknown): Promise<void> {
  try {
    const msg = JSON.stringify({ type, payload });
    await chrome.runtime.sendMessage({ type: '_os_ws_send', payload: msg });
  } catch {
    // Server unreachable — recording still saved locally
  }
}

// --- Tool context ---

export interface ToolContext {
  input: InputDevice;
  getTabId: () => number;
  setTabId: (tabId: number) => void;
}

type ToolHandler = (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;

// --- Tool handlers ---

const handlers: Record<string, ToolHandler> = {
  // === Navigation ===

  async browser_navigate(args, ctx) {
    const url = args.url as string;
    const tabId = ctx.getTabId();
    const tab = await chrome.tabs.get(tabId);
    if (tab.url === url) {
      await chrome.tabs.reload(tabId);
    } else {
      await chrome.tabs.update(tabId, { url });
    }
    await waitForTabLoad(tabId);
    try { await ensureContentScript(tabId); } catch { /* may be non-http */ }
  },

  async browser_go_back(_args, ctx) {
    const tabId = ctx.getTabId();
    await chrome.tabs.goBack(tabId);
    await waitForTabLoad(tabId);
    try { await ensureContentScript(tabId); } catch {}
  },

  async browser_go_forward(_args, ctx) {
    const tabId = ctx.getTabId();
    await chrome.tabs.goForward(tabId);
    await waitForTabLoad(tabId);
    try { await ensureContentScript(tabId); } catch {}
  },

  async browser_wait(args) {
    const time = (args.time as number) || 1;
    await delay(time * 1000);
  },

  // === Snapshot (ULTRA: viewport-only + stable IDs) ===

  async browser_snapshot(args, ctx) {
    const tabId = ctx.getTabId();
    await ensureContentScript(tabId);
    const viewportOnly = args.viewportOnly !== undefined ? args.viewportOnly : true;
    const mode = (args.mode as 'full' | 'diff' | 'auto' | undefined) ?? 'auto';
    return sendToTab(tabId, 'generateAriaSnapshot', { viewportOnly, mode });
  },

  // === Input (ULTRA: NL targeting via resolveTarget) ===

  async browser_click(args, ctx) {
    const tabId = ctx.getTabId();
    await ensureContentScript(tabId);
    const selector = await resolveTarget(tabId, args);
    // Try CDP click first, fall back to content script DOM events
    try {
      await scrollIntoView(tabId, selector);
      const coords = await sendToTab<{ x: number; y: number } | null>(tabId, 'getElementCoordinates', {
        selector, options: { clickable: true },
      });
      if (!coords) throw new Error('No coordinates');
      await ctx.input.moveMouse(coords);
      await delay(200);
      await ctx.input.waitForTabIfNavigationStarted(tabId, async () => {
        await ctx.input.click(coords);
        await delay(500);
      });
    } catch {
      // CDP failed — use content script click
      await sendToTab(tabId, 'cs_click', { selector });
      await delay(500);
    }
    try { await ensureContentScript(tabId); } catch {}
    await waitForStableDOM(tabId);
  },

  async browser_type(args, ctx) {
    const typedText = args.text as string;
    const submit = args.submit as boolean | undefined;
    const tabId = ctx.getTabId();
    await ensureContentScript(tabId);
    const selector = await resolveTarget(tabId, args);
    // Try CDP type first, fall back to content script
    try {
      await scrollIntoView(tabId, selector);
      await ctx.input.type(typedText, selector);
      if (submit) {
        await ctx.input.waitForTabIfNavigationStarted(tabId, async () => {
          await ctx.input.pressKey('Enter');
          await delay(AFTER_ACTION_DELAY_MS);
        });
        try { await ensureContentScript(tabId); } catch {}
      }
    } catch {
      // CDP failed — use content script type
      await sendToTab(tabId, 'cs_type', { selector, text: typedText, submit });
      if (submit) {
        await delay(1000);
        try { await ensureContentScript(tabId); } catch {}
      }
    }
    await waitForStableDOM(tabId);
  },

  async browser_hover(args, ctx) {
    const tabId = ctx.getTabId();
    await ensureContentScript(tabId);
    const selector = await resolveTarget(tabId, args);
    // Try CDP hover first, fall back to content script
    try {
      await scrollIntoView(tabId, selector);
      const coords = await sendToTab<{ x: number; y: number } | null>(tabId, 'getElementCoordinates', {
        selector,
      });
      if (!coords) throw new Error('No coordinates');
      await ctx.input.moveMouse(coords);
    } catch {
      // CDP failed — use content script hover
      await sendToTab(tabId, 'cs_hover', { selector });
    }
    await delay(AFTER_ACTION_DELAY_MS);
    await waitForStableDOM(tabId);
  },

  async browser_press_key(args, ctx) {
    const key = args.key as string;
    const tabId = ctx.getTabId();
    await ensureContentScript(tabId);
    try {
      if (key === 'Enter') {
        await ctx.input.waitForTabIfNavigationStarted(tabId, async () => {
          await ctx.input.pressKey(key);
          await delay(AFTER_ACTION_DELAY_MS);
        });
      } else {
        await ctx.input.pressKey(key);
        if (key === 'PageDown') await delay(AFTER_ACTION_DELAY_MS);
      }
    } catch {
      // CDP failed — use content script
      await sendToTab(tabId, 'cs_press_key', { key });
      await delay(AFTER_ACTION_DELAY_MS);
    }
    await waitForStableDOM(tabId);
  },

  async browser_drag(args, ctx) {
    const tabId = ctx.getTabId();
    await ensureContentScript(tabId);
    // Resolve start element
    const startArgs: Record<string, unknown> = {};
    if (args.startRef) startArgs.ref = args.startRef;
    if (args.startMark) startArgs.mark = args.startMark;
    if (args.startSelector) startArgs.selector = args.startSelector;
    if (!startArgs.ref && !startArgs.mark && !startArgs.selector) {
      throw new Error('Drag requires startRef, startMark, or startSelector');
    }
    const startSelector = await resolveTarget(tabId, startArgs);
    // Resolve end element
    const endArgs: Record<string, unknown> = {};
    if (args.endRef) endArgs.ref = args.endRef;
    if (args.endMark) endArgs.mark = args.endMark;
    if (args.endSelector) endArgs.selector = args.endSelector;
    if (!endArgs.ref && !endArgs.mark && !endArgs.selector) {
      throw new Error('Drag requires endRef, endMark, or endSelector');
    }
    const endSelector = await resolveTarget(tabId, endArgs);

    await scrollIntoView(tabId, startSelector);
    const startCoords = await sendToTab<{ x: number; y: number }>(tabId, 'getElementCoordinates', {
      selector: startSelector, options: { clickable: true },
    });
    const endCoords = await sendToTab<{ x: number; y: number }>(tabId, 'getElementCoordinates', {
      selector: endSelector,
    });
    if (!startCoords || !endCoords) throw new Error('Could not get coordinates for drag elements');
    try {
      await ctx.input.moveMouse(startCoords);
      await delay(AFTER_ACTION_DELAY_MS);
      await ctx.input.dragAndDrop(startCoords, endCoords);
    } catch {
      throw new Error('Drag requires Chrome debugger access which is currently unavailable. Close Chrome DevTools and any conflicting extensions, then retry.');
    }
    await waitForStableDOM(tabId);
  },

  async browser_select_option(args, ctx) {
    const values = args.values as string[];
    const tabId = ctx.getTabId();
    await ensureContentScript(tabId);
    const selector = await resolveTarget(tabId, args);
    await sendToTab(tabId, 'selectOption', { selector, values, selectMethod: 'value' });
    await waitForStableDOM(tabId);
  },

  // === Media ===

  async browser_screenshot(_args, ctx) {
    const tabId = ctx.getTabId();
    const dataUrl = await captureScreenshot(tabId);
    return stripDataUrlPrefix(dataUrl);
  },

  async browser_get_console_logs() {
    return getConsoleLogs();
  },

  // === ULTRA: SoM (Set-of-Marks) ===

  async generateMarks(_args, ctx) {
    const tabId = ctx.getTabId();
    await ensureContentScript(tabId);
    return sendToTab(tabId, 'generateMarks');
  },

  async clearMarks(_args, ctx) {
    const tabId = ctx.getTabId();
    try {
      await sendToTab(tabId, 'clearMarks');
    } catch { /* may fail if content script gone */ }
  },

  // === ULTRA: Data extraction ===

  async browser_extract(args, ctx) {
    const tabId = ctx.getTabId();
    await ensureContentScript(tabId);
    return sendToTab(tabId, 'browser_extract', {
      selector: args.selector,
      fields: args.fields,
      limit: args.limit ?? 10,
    });
  },

  // === ULTRA: Form filling ===

  async browser_fill_form(args, ctx) {
    const tabId = ctx.getTabId();
    await ensureContentScript(tabId);
    return sendToTab(tabId, 'browser_fill_form', {
      fields: args.fields,
      submitAfter: args.submitAfter ?? false,
      submitText: args.submitText,
    });
  },

  // === ULTRA: Element search ===

  async browser_find(args, ctx) {
    const tabId = ctx.getTabId();
    await ensureContentScript(tabId);
    return sendToTab(tabId, 'browser_find', {
      role: args.role,
      name: args.name,
      text: args.text,
      selector: args.selector,
      limit: args.limit ?? 10,
    });
  },

  // === ULTRA Phase 2: Compound action sequencer ===

  async browser_action(args, ctx) {
    const steps = args.steps as ActionStep[];
    const stopOnError = (args.stopOnError as boolean) ?? true;
    return runActionSequence(steps, ctx, { stopOnError });
  },

  // === ULTRA Phase 2: Conditional waiting ===

  async browser_wait_for(args, ctx) {
    const tabId = ctx.getTabId();
    await ensureContentScript(tabId);
    const condition = args.condition as string;
    const timeout = (args.timeout as number) || 10000;
    const pollInterval = (args.pollInterval as number) || 500;

    // For network_idle, use DOM stability heuristic in background
    if (condition === 'network_idle') {
      const start = Date.now();
      try {
        await sendToTab(tabId, 'waitForStableDOM', {
          minStableMs: 500,
          maxMutations: 0,
          maxWaitMs: timeout,
        });
        return { met: true, waitedMs: Date.now() - start };
      } catch {
        throw new Error(`Timeout after ${timeout}ms waiting for network_idle`);
      }
    }

    return sendToTab(tabId, 'browser_wait_for', {
      condition,
      value: args.value,
      selector: args.selector,
      timeout,
      pollInterval,
    });
  },

  // === ULTRA Phase 2: Assertions ===

  async browser_assert(args, ctx) {
    const tabId = ctx.getTabId();
    await ensureContentScript(tabId);
    const checks = args.checks as Array<{
      type: string;
      value?: string;
      selector?: string;
      min?: number;
      max?: number;
    }>;

    // Separate console_no_errors checks (handled in background) from DOM checks
    const hasConsoleCheck = checks.some((c) => c.type === 'console_no_errors');
    const domChecks = checks.filter((c) => c.type !== 'console_no_errors');

    // Run DOM checks in content script
    let result: { passed: boolean; results: Array<{ type: string; passed: boolean; message: string }> };
    if (domChecks.length > 0) {
      result = await sendToTab<{ passed: boolean; results: Array<{ type: string; passed: boolean; message: string }> }>(
        tabId, 'browser_assert', { checks: domChecks },
      );
    } else {
      result = { passed: true, results: [] };
    }

    // Handle console_no_errors in background (logs are captured at background level)
    if (hasConsoleCheck) {
      const logs = getConsoleLogs();
      const errorLogs = logs.filter((l) => l.type === 'error' || l.type === 'exception');
      const consolePassed = errorLogs.length === 0;
      result.results.push({
        type: 'console_no_errors',
        passed: consolePassed,
        message: consolePassed
          ? 'console_no_errors: no errors in console'
          : `console_no_errors: ${errorLogs.length} error(s) found — ${errorLogs.slice(0, 3).map((l) => l.message).join('; ')}`,
      });
      if (!consolePassed) result.passed = false;
    }

    return result;
  },

  // === Tab management ===

  async list_tabs() {
    return listTabsImpl();
  },

  async select_tab(args, ctx) {
    const tabId = args.tabId as number;
    await chrome.tabs.update(tabId, { active: true });
    ctx.setTabId(tabId);
    setLastUsedTabId(tabId);
    await ensureContentScript(tabId);
  },

  async new_tab(args, ctx) {
    const url = (args.url as string) || 'about:blank';
    const tab = await chrome.tabs.create({ url });
    if (tab.id === undefined) throw new Error('Failed to create tab');
    ctx.setTabId(tab.id);
    setLastUsedTabId(tab.id);
    if (url !== 'about:blank') {
      await waitForTabLoad(tab.id);
      try { await ensureContentScript(tab.id); } catch {}
    }
    return { tabId: tab.id };
  },

  async close_tab(args, ctx) {
    const tabId = (args.tabId as number) ?? ctx.getTabId();
    await chrome.tabs.remove(tabId);
  },

  // === ULTRA Phase 3: Session recording ===

  async browser_record_start(args, ctx) {
    const name = args.name as string;
    if (!name) throw new Error('Recording name is required.');
    const tabId = ctx.getTabId();
    let startUrl = '';
    try {
      const tab = await chrome.tabs.get(tabId);
      startUrl = tab.url || '';
    } catch { /* no tab yet */ }
    startRecording(name, startUrl);
    return { status: 'recording', name };
  },

  async browser_record_stop(_args, ctx) {
    const recording = stopRecording();
    // Save to chrome.storage.local
    await saveRecordingToStorage(recording);
    // Also send to server for filesystem persistence
    await sendToServer('saveRecording', recording);
    return {
      name: recording.name,
      steps: recording.steps.length,
      durationMs: (recording.stoppedAt ?? Date.now()) - recording.startedAt,
      recording,
    };
  },

  async browser_record_list() {
    const names = await listRecordingsFromStorage();
    return { recordings: names };
  },

  async saveRecording(args) {
    // Persist a recording to chrome.storage.local (called from server via WS)
    const recording = args as unknown as Recording;
    if (!recording.name) throw new Error('Recording must have a name.');
    await saveRecordingToStorage(recording);
    return { saved: true, name: recording.name };
  },

  async loadRecording(args) {
    const name = args.name as string;
    if (!name) throw new Error('Recording name is required.');
    const recording = await loadRecordingFromStorage(name);
    if (!recording) throw new Error(`Recording "${name}" not found.`);
    return recording;
  },

  // === ULTRA Phase 3: Session replay ===

  async browser_replay(args, ctx) {
    const recording = args.recording as Recording;
    if (!Array.isArray(recording?.steps)) throw new Error('Invalid recording: steps must be an array.');
    for (const step of recording.steps) {
      if (!step.action || typeof step.action !== 'string')
        throw new Error('Invalid recording: each step must have an action string.');
    }

    const options: ReplayOptions = {
      recording,
      variables: args.variables as Record<string, string> | undefined,
      speed: args.speed as number | undefined,
      stopOnError: args.stopOnError as boolean | undefined,
      startFromStep: args.startFromStep as number | undefined,
      stopAtStep: args.stopAtStep as number | undefined,
    };

    setReplaying(true);
    try {
      return await replayRecording(options, ctx);
    } finally {
      setReplaying(false);
    }
  },

  // === ULTRA Phase 3: Page Object Model generation ===

  async generatePageModel(_args, ctx) {
    const tabId = ctx.getTabId();
    await ensureContentScript(tabId);
    return sendToTab(tabId, 'generatePageModel', {});
  },

  // === ULTRA Phase 5: JavaScript evaluation ===

  async browser_eval(args, ctx) {
    const code = args.code as string;
    const timeout = (args.timeout as number) || 5000;
    const tabId = ctx.getTabId();
    // Try CDP first, fall back to content script eval
    try {
      await ensureAttached(tabId);
      const result = await sendCommand<{
        result: { type: string; value?: unknown; description?: string; className?: string };
        exceptionDetails?: { exception?: { description?: string }; text?: string };
      }>(tabId, 'Runtime.evaluate', {
        expression: code,
        returnByValue: true,
        awaitPromise: true,
        timeout,
      });
      if (result?.exceptionDetails) {
        const desc =
          result.exceptionDetails.exception?.description ||
          result.exceptionDetails.text ||
          'Unknown evaluation error';
        return { error: desc };
      }
      const r = result?.result;
      if (!r) return { value: undefined };
      if (r.type === 'undefined') return { value: undefined };
      if (r.value !== undefined) return { value: r.value };
      return { value: r.description || String(r) };
    } catch {
      // CDP failed — fall back to content script eval
      await ensureContentScript(tabId);
      // Wrap code to return JSON-serializable result
      const wrappedCode = `try { JSON.stringify(eval(${JSON.stringify(code)})) } catch(e) { JSON.stringify({__error: e.message}) }`;
      const raw = await sendToTab<string>(tabId, 'cs_eval', { code: wrappedCode });
      try {
        const parsed = JSON.parse(raw);
        if (parsed?.__error) return { error: parsed.__error };
        return { value: parsed };
      } catch {
        return { value: raw };
      }
    }
  },

  // === ULTRA Phase 5: Storage inspection ===

  async browser_storage(args, ctx) {
    const action = args.action as string;
    const storageType = args.type as string;
    const key = args.key as string | undefined;
    const value = args.value as string | undefined;
    const domain = args.domain as string | undefined;
    const tabId = ctx.getTabId();
    try {
      await ensureAttached(tabId);
    } catch (e) {
      // For localStorage/sessionStorage, try content script fallback
      if (storageType !== 'cookies') {
        await ensureContentScript(tabId);
        const st = storageType === 'sessionStorage' ? 'sessionStorage' : 'localStorage';
        if (action === 'get' && key) {
          const val = await sendToTab<string | null>(tabId, 'cs_eval', { code: `${st}.getItem(${JSON.stringify(key)})` });
          return { value: val };
        }
        if (action === 'set' && key) {
          await sendToTab(tabId, 'cs_eval', { code: `${st}.setItem(${JSON.stringify(key)}, ${JSON.stringify(value || '')})` });
          return { success: true };
        }
        if (action === 'delete' && key) {
          await sendToTab(tabId, 'cs_eval', { code: `${st}.removeItem(${JSON.stringify(key)})` });
          return { success: true };
        }
        if (action === 'clear') {
          await sendToTab(tabId, 'cs_eval', { code: `${st}.clear()` });
          return { success: true };
        }
      }
      throw new Error('Storage (cookies) requires Chrome debugger access which is currently unavailable.');
    }

    // --- Cookies via CDP Network.getCookies ---
    if (storageType === 'cookies') {
      if (action === 'get') {
        const cookieResult = await sendCommand<{ cookies: unknown[] }>(tabId, 'Network.getCookies');
        let cookies = cookieResult?.cookies || [];
        if (domain) {
          cookies = (cookies as Array<{ domain?: string }>).filter(
            (c) => c.domain === domain || c.domain === `.${domain}`,
          );
        }
        return { cookies };
      }
      if (action === 'set') {
        if (!key) throw new Error('Cookie name (key) is required for set action');
        const cookieVal = value || '';
        const cookieExpr = `document.cookie = ${JSON.stringify(`${key}=${cookieVal}`)}`;
        await sendCommand(tabId, 'Runtime.evaluate', {
          expression: cookieExpr,
          returnByValue: true,
        });
        return { success: true };
      }
      if (action === 'delete') {
        if (!key) throw new Error('Cookie name (key) is required for delete action');
        // Use CDP for reliable deletion (handles HttpOnly, all paths/domains)
        const allCookies = (await sendCommand<{ cookies: Array<{ name: string; domain: string; path: string }> }>(tabId, 'Network.getCookies'))?.cookies || [];
        const matching = allCookies.filter((c) => c.name === key);
        for (const cookie of matching) {
          await sendCommand(tabId, 'Network.deleteCookies', {
            name: key, domain: cookie.domain, path: cookie.path,
          });
        }
        return { success: true, deleted: matching.length };
      }
      if (action === 'clear') {
        await sendCommand(tabId, 'Network.clearBrowserCookies');
        return { success: true };
      }
      throw new Error(`Unknown action "${action}" for cookies`);
    }

    // --- localStorage / sessionStorage via Runtime.evaluate ---
    const st = storageType === 'sessionStorage' ? 'sessionStorage' : 'localStorage';

    if (action === 'get') {
      if (key) {
        const expr = `${st}.getItem(${JSON.stringify(key)})`;
        const r = await sendCommand<{ result: { value?: unknown } }>(tabId, 'Runtime.evaluate', {
          expression: expr,
          returnByValue: true,
        });
        return { value: r?.result?.value ?? null };
      }
      const expr = `JSON.stringify(Object.fromEntries(Object.keys(${st}).map(k => [k, ${st}.getItem(k)])))`;
      const r = await sendCommand<{ result: { value?: unknown } }>(tabId, 'Runtime.evaluate', {
        expression: expr,
        returnByValue: true,
      });
      const raw = r?.result?.value;
      return { entries: typeof raw === 'string' ? JSON.parse(raw) : raw ?? {} };
    }

    if (action === 'set') {
      if (!key) throw new Error('Key is required for set action');
      const expr = `${st}.setItem(${JSON.stringify(key)}, ${JSON.stringify(value || '')})`;
      await sendCommand(tabId, 'Runtime.evaluate', {
        expression: expr,
        returnByValue: true,
      });
      return { success: true };
    }

    if (action === 'delete') {
      if (!key) throw new Error('Key is required for delete action');
      const expr = `${st}.removeItem(${JSON.stringify(key)})`;
      await sendCommand(tabId, 'Runtime.evaluate', {
        expression: expr,
        returnByValue: true,
      });
      return { success: true };
    }

    if (action === 'clear') {
      const expr = `${st}.clear()`;
      await sendCommand(tabId, 'Runtime.evaluate', {
        expression: expr,
        returnByValue: true,
      });
      return { success: true };
    }

    throw new Error(`Unknown action "${action}" for ${storageType}`);
  },

  // === ULTRA Phase 5: Network capture ===

  async browser_network(args, ctx) {
    const action = args.action as string;
    const tabId = ctx.getTabId();

    if (action === 'start_capture') {
      try {
        await ensureAttached(tabId);
      } catch {
        throw new Error('Network capture requires Chrome debugger access which is currently unavailable. Close DevTools and conflicting extensions, then retry.');
      }
      await sendCommand(tabId, 'Network.enable');
      setNetworkCaptureActive(true);
      return { status: 'capturing', message: 'Network capture started.' };
    }

    if (action === 'stop_capture') {
      await ensureAttached(tabId);
      await sendCommand(tabId, 'Network.disable').catch(() => {});
      setNetworkCaptureActive(false);
      return { status: 'stopped', message: 'Network capture stopped.' };
    }

    if (action === 'clear') {
      clearNetworkLog();
      return { status: 'cleared' };
    }

    if (action === 'get_log') {
      let entries = getNetworkLog();
      const filter = args.filter as {
        url?: string;
        method?: string;
        statusMin?: number;
        statusMax?: number;
        resourceType?: string;
      } | undefined;

      if (filter) {
        if (filter.url) {
          const urlFilter = filter.url;
          entries = entries.filter((e) => e.url.includes(urlFilter));
        }
        if (filter.method) {
          const methodFilter = filter.method.toUpperCase();
          entries = entries.filter((e) => e.method.toUpperCase() === methodFilter);
        }
        if (filter.statusMin !== undefined) {
          entries = entries.filter((e) => e.status !== undefined && e.status >= filter.statusMin!);
        }
        if (filter.statusMax !== undefined) {
          entries = entries.filter((e) => e.status !== undefined && e.status <= filter.statusMax!);
        }
        if (filter.resourceType) {
          const rtFilter = filter.resourceType.toLowerCase();
          entries = entries.filter((e) => e.resourceType.toLowerCase() === rtFilter);
        }
      }

      const limit = (args.limit as number) || 50;
      entries = entries.slice(-limit);

      return {
        count: entries.length,
        totalCaptured: getNetworkLog().length,
        capturing: isNetworkCaptureActive(),
        entries,
      };
    }

    throw new Error(`Unknown browser_network action: ${action}`);
  },

  // === ULTRA Phase 5: Performance metrics ===

  async browser_performance(args, ctx) {
    const action = args.action as string;
    const tabId = ctx.getTabId();

    if (action === 'get_metrics') {
      await ensureAttached(tabId);
      await sendCommand(tabId, 'Performance.enable');
      try {
        const result = await sendCommand<{ metrics: Array<{ name: string; value: number }> }>(
          tabId,
          'Performance.getMetrics',
        );
        const metrics: Record<string, number> = {};
        if (result?.metrics) {
          for (const m of result.metrics) {
            metrics[m.name] = m.value;
          }
        }
        return metrics;
      } finally {
        await sendCommand(tabId, 'Performance.disable').catch(() => {});
      }
    }

    if (action === 'get_web_vitals') {
      await ensureAttached(tabId);
      await enableRuntime(tabId);
      const expression = `
        (function() {
          var result = {};
          try {
            var entries = performance.getEntriesByType('largest-contentful-paint');
            if (entries.length > 0) result.LCP = entries[entries.length - 1].startTime;
          } catch(e) {}
          try {
            var fidEntries = performance.getEntriesByType('first-input');
            if (fidEntries.length > 0) result.FID = fidEntries[0].processingStart - fidEntries[0].startTime;
          } catch(e) {}
          try {
            var clsEntries = performance.getEntriesByType('layout-shift');
            var cls = 0;
            clsEntries.forEach(function(e) { if (!e.hadRecentInput) cls += e.value; });
            result.CLS = cls;
          } catch(e) {}
          try {
            var nav = performance.getEntriesByType('navigation');
            if (nav.length > 0) {
              var n = nav[0];
              result.TTFB = n.responseStart - n.requestStart;
              result.DOMContentLoaded = n.domContentLoadedEventEnd - n.startTime;
              result.Load = n.loadEventEnd - n.startTime;
            }
          } catch(e) {}
          return JSON.stringify(result);
        })()
      `;
      const evalResult = await sendCommand<{ result: { value?: string } }>(
        tabId,
        'Runtime.evaluate',
        { expression, returnByValue: true },
      );
      const raw = evalResult?.result?.value;
      return raw ? JSON.parse(raw) : {};
    }

    throw new Error(`Unknown browser_performance action: ${action}`);
  },

  // === ULTRA: File upload via CDP ===

  async browser_upload(args, ctx) {
    const selector = args.selector as string;
    const files = args.files as string[];
    const tabId = ctx.getTabId();

    // Use CDP to set files on the input element
    try {
      await ensureAttached(tabId);
      // First, find the DOM node for the file input
      const docResult = await sendCommand<{ root: { nodeId: number } }>(tabId, 'DOM.getDocument');
      if (!docResult?.root) throw new Error('Failed to get document root');

      const queryResult = await sendCommand<{ nodeId: number }>(tabId, 'DOM.querySelector', {
        nodeId: docResult.root.nodeId,
        selector,
      });
      if (!queryResult?.nodeId) throw new Error(`File input not found: ${selector}`);

      await sendCommand(tabId, 'DOM.setFileInputFiles', {
        nodeId: queryResult.nodeId,
        files,
      });

      return { uploaded: true, files, selector };
    } catch (cdpError) {
      // Fallback: try via content script (limited — only works for some cases)
      await ensureContentScript(tabId);
      await sendToTab(tabId, 'cs_click', { selector });
      throw new Error(
        `File upload via CDP failed: ${cdpError instanceof Error ? cdpError.message : cdpError}. ` +
        `Note: File upload requires Chrome debugger access. If LastPass is enabled, disable it. ` +
        `The file input was clicked as a fallback — you may need to manually select files.`,
      );
    }
  },

  // === ULTRA: File download via chrome.downloads ===

  async browser_download(args, ctx) {
    const url = args.url as string | undefined;
    const filename = args.filename as string | undefined;

    if (!url) {
      // Download current page
      const tabId = ctx.getTabId();
      const tab = await chrome.tabs.get(tabId);
      const pageUrl = tab.url || '';
      if (!pageUrl.startsWith('http')) throw new Error('Cannot download non-HTTP page');

      const downloadId = await chrome.downloads.download({
        url: pageUrl,
        filename: filename || undefined,
      });
      return { downloadId, url: pageUrl, filename };
    }

    const downloadId = await chrome.downloads.download({
      url,
      filename: filename || undefined,
    });
    return { downloadId, url, filename };
  },

  // === ULTRA: Clipboard read/write/paste ===

  async browser_clipboard(args, ctx) {
    const action = args.action as string;
    const text = args.text as string | undefined;
    const tabId = ctx.getTabId();

    if (action === 'write') {
      if (!text) throw new Error('Text is required for clipboard write');
      // Use CDP to write to clipboard
      try {
        await ensureAttached(tabId);
        // Copy text by evaluating in page context
        await sendCommand(tabId, 'Runtime.evaluate', {
          expression: `navigator.clipboard.writeText(${JSON.stringify(text)})`,
          awaitPromise: true,
          returnByValue: true,
        });
        return { success: true, action: 'write', text };
      } catch {
        // Fallback: use content script
        await ensureContentScript(tabId);
        await sendToTab(tabId, 'cs_eval', {
          code: `navigator.clipboard.writeText(${JSON.stringify(text)}).then(() => 'ok').catch(e => e.message)`,
        });
        return { success: true, action: 'write', text };
      }
    }

    if (action === 'read') {
      try {
        await ensureAttached(tabId);
        const result = await sendCommand<{ result: { value?: string } }>(tabId, 'Runtime.evaluate', {
          expression: 'navigator.clipboard.readText()',
          awaitPromise: true,
          returnByValue: true,
        });
        return { success: true, action: 'read', text: result?.result?.value || '' };
      } catch {
        await ensureContentScript(tabId);
        const clipText = await sendToTab<string>(tabId, 'cs_eval', {
          code: `navigator.clipboard.readText().then(t => t).catch(() => '')`,
        });
        return { success: true, action: 'read', text: clipText || '' };
      }
    }

    if (action === 'paste') {
      // Simulate Ctrl+V
      try {
        await ensureAttached(tabId);
        await sendCommand(tabId, 'Input.dispatchKeyEvent', {
          type: 'keyDown',
          modifiers: 2, // Control
          key: 'v',
          code: 'KeyV',
          windowsVirtualKeyCode: 86,
          commands: ['paste'],
        });
        await sendCommand(tabId, 'Input.dispatchKeyEvent', {
          type: 'keyUp',
          modifiers: 2,
          key: 'v',
          code: 'KeyV',
          windowsVirtualKeyCode: 86,
        });
        return { success: true, action: 'paste' };
      } catch {
        // Fallback: dispatch paste event via content script
        await ensureContentScript(tabId);
        await sendToTab(tabId, 'cs_press_key', { key: 'v' });
        return { success: true, action: 'paste', note: 'Used content-script fallback — Ctrl modifier may not be applied' };
      }
    }

    throw new Error(`Unknown clipboard action: ${action}`);
  },

  // === Helpers called by server's captureAriaSnapshot ===

  async getUrl(_args, ctx) {
    const tabId = ctx.getTabId();
    const tab = await chrome.tabs.get(tabId);
    return tab.url || '';
  },

  async getTitle(_args, ctx) {
    const tabId = ctx.getTabId();
    const tab = await chrome.tabs.get(tabId);
    return tab.title || '';
  },

  // === F1: event handler mirror (receives push from hub) ===
  // The authoritative handler registry lives on the hub; the extension
  // caches it locally so dialog/new_tab/network_timeout dispatch is
  // synchronous. These tool handlers are called via sendSocketMessage
  // from server-side browser_on / browser_off.

  async browser_register_handler(args, ctx) {
    const handler = args.handler as EventHandler;
    if (!handler || typeof handler !== 'object') {
      throw new Error('browser_register_handler: missing handler');
    }
    addHandler(handler);

    // Enable the CDP domain needed for this event type on every tab we
    // need to cover. `dialog`/`beforeunload` need Page; `network_timeout`
    // needs Network. Same tab-scoped vs browser-wide dispatch in both.
    const needsPage =
      handler.event === 'dialog' || handler.event === 'beforeunload';
    const needsNetwork = handler.event === 'network_timeout';

    if (needsPage || needsNetwork) {
      const enable = async (tabId: number): Promise<void> => {
        if (needsPage) {
          try { await enablePageDomain(tabId); } catch { /* best-effort */ }
        }
        if (needsNetwork) {
          try { await enableNetworkDomain(tabId); } catch { /* best-effort */ }
        }
      };

      const scopedTab = handler.options?.tabId;
      if (scopedTab !== undefined) {
        await enable(scopedTab);
      } else {
        // Browser-wide — cover every currently-attached tab.
        const current = ctx.getTabId();
        if (current > 0) await enable(current);
        for (const tabId of getAttachedTabs()) {
          if (tabId === current) continue;
          await enable(tabId);
        }
      }
    }

    return { ok: true, handlerId: handler.id };
  },

  async browser_unregister_handler(args, _ctx) {
    // Three dispatch shapes (server pushes whichever is relevant):
    //   { handlerId }           — remove one specific handler
    //   { sessionId }           — remove every handler installed by a session
    //   { clearAll: true }      — legacy, remove everything locally (kept for
    //                              now so stale server builds still work)
    if (args.clearAll === true) {
      clearHandlers();
      return { ok: true, cleared: 'all' };
    }
    if (typeof args.sessionId === 'string') {
      const sid = args.sessionId;
      const before = listHandlers().length;
      // Remove any handler whose sessionId matches.
      for (const h of listHandlers()) {
        if (h.sessionId === sid) removeHandler(h.id);
      }
      const after = listHandlers().length;
      return { ok: true, removed: before - after };
    }
    const handlerId = args.handlerId as string;
    if (!handlerId) {
      throw new Error('browser_unregister_handler: missing handlerId or sessionId');
    }
    const removed = removeHandler(handlerId);
    return { ok: removed };
  },

  async browser_list_handlers(_args, _ctx) {
    return { handlers: listHandlers() };
  },
};

export async function handleTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  const handler = handlers[name];
  if (!handler) throw new Error(`Unknown tool: ${name}`);

  const NO_TAB_TOOLS = ['list_tabs', 'browser_get_console_logs', 'browser_wait', 'browser_record_list', 'browser_record_start', 'browser_record_stop'];
  if (!NO_TAB_TOOLS.includes(name)) {
    const requestedTab = args.tabId as number | undefined;
    if (requestedTab !== undefined) {
      ctx.setTabId(requestedTab);
    }
    let tabId = ctx.getTabId();
    if (tabId > 0) {
      try {
        await chrome.tabs.get(tabId);
      } catch {
        tabId = -1;
      }
    }
    if (tabId < 0) {
      const freshId = await resolveTabId();
      ctx.setTabId(freshId);
    }
    setLastUsedTabId(ctx.getTabId());
  }

  // Capture timing + URL for recording
  const recordThis = shouldRecord(name);
  const startTime = recordThis ? Date.now() : 0;

  const result = await handler(args, ctx);

  // Push step to active recording if applicable
  if (recordThis) {
    // Deep clone args to prevent mutation
    const recordedArgs: Record<string, unknown> = JSON.parse(JSON.stringify(args));
    // Resolve refs to stable CSS selectors for replay portability
    if (recordedArgs.ref && ctx.getTabId() > 0) {
      try {
        const selector = await resolveTarget(ctx.getTabId(), recordedArgs);
        recordedArgs.selector = selector;
        delete recordedArgs.ref;
        delete recordedArgs.mark;
      } catch { /* keep original args */ }
    }
    let url = '';
    try {
      const tab = await chrome.tabs.get(ctx.getTabId());
      url = tab.url || '';
    } catch { /* tab may be gone after close_tab */ }
    pushStep({
      action: name,
      args: recordedArgs,
      timestamp: startTime,
      durationMs: Date.now() - startTime,
      url,
    });
  }

  return result;
}
