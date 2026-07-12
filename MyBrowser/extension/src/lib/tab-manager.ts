// Tab management: resolve active tabs and inject content scripts.

export interface TabInfo {
  tabId: number;
  title: string;
  url: string;
  active: boolean;
  windowId: number;
}

function isInjectableUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    if (!parsed.protocol.startsWith('http')) return false;
    if (parsed.host === 'chromewebstore.google.com') return false;
    return true;
  } catch {
    return false;
  }
}

export async function resolveTabId(
  requestedTabId?: number,
  sessionFallback?: number,
): Promise<number> {
  if (requestedTabId !== undefined) {
    try {
      await chrome.tabs.get(requestedTabId);
      return requestedTabId;
    } catch {
      throw new Error('TAB_CLOSED');
    }
  }

  if (sessionFallback !== undefined) {
    try {
      await chrome.tabs.get(sessionFallback);
      return sessionFallback;
    } catch {}
  }

  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (activeTab?.id !== undefined) {
    return activeTab.id;
  }
  throw new Error('TAB_CLOSED');
}

export async function listTabs(): Promise<TabInfo[]> {
  const tabs = await chrome.tabs.query({});
  return tabs
    .filter((t) => t.id !== undefined)
    .map((t) => ({
      tabId: t.id!,
      title: t.title || '',
      url: t.url || '',
      active: t.active ?? false,
      windowId: t.windowId ?? -1,
    }));
}

export async function ensureContentScript(tabId: number): Promise<void> {
  try {
    // Try pinging the content script with a short timeout
    await Promise.race([
      chrome.tabs.sendMessage(tabId, { type: 'ping' }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('ping timeout')), 2000),
      ),
    ]);
  } catch {
    // Content script not responding or timed out, re-inject
    const tab = await chrome.tabs.get(tabId);
    if (!isInjectableUrl(tab.url)) {
      throw new Error(`Cannot inject content script into ${tab.url}`);
    }
    await injectContentScript(tabId);
    // Wait briefly for the injected script to initialize
    await new Promise((r) => setTimeout(r, 500));
  }
}

export async function injectContentScript(tabId: number): Promise<void> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content-scripts/content.js'],
      injectImmediately: true,
    });
  } catch (e) {
    console.warn(`Unable to inject tab ${tabId}: ${(e as Error).message}`);
  }
}

export async function injectIntoAllTabs(): Promise<void> {
  const tabs = await chrome.tabs.query({});
  await Promise.all(
    tabs.map((t) => {
      if (t.id === undefined || !isInjectableUrl(t.url)) return;
      return injectContentScript(t.id);
    }),
  );
}
