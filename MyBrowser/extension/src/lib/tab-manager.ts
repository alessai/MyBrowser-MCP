// Tab management: resolve active tab, inject content scripts, track last used tab

export interface TabInfo {
  tabId: number;
  title: string;
  url: string;
  active: boolean;
  windowId: number;
}

let lastUsedTabId: number | null = null;

export function getLastUsedTabId(): number | null {
  return lastUsedTabId;
}

export function setLastUsedTabId(tabId: number): void {
  lastUsedTabId = tabId;
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

export async function resolveTabId(requestedTabId?: number): Promise<number> {
  // Priority: explicit → lastUsed → active tab
  if (requestedTabId !== undefined) {
    lastUsedTabId = requestedTabId;
    return requestedTabId;
  }
  if (lastUsedTabId !== null) {
    // Verify the tab still exists
    try {
      await chrome.tabs.get(lastUsedTabId);
      return lastUsedTabId;
    } catch {
      lastUsedTabId = null;
    }
  }
  // Fall back to active tab
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (activeTab?.id !== undefined) {
    lastUsedTabId = activeTab.id;
    return activeTab.id;
  }
  throw new Error('No active tab found');
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

// Clear lastUsedTabId when tab is removed (called from background init)
export function initTabCleanup(): void {
  chrome.tabs.onRemoved.addListener((tabId) => {
    if (lastUsedTabId === tabId) {
      lastUsedTabId = null;
    }
  });
}
