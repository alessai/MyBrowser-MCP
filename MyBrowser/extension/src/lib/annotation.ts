import { sendToTab } from './messaging';
import { ensureContentScript } from './tab-manager';

export async function openAnnotationOverlay(tabId: number): Promise<void> {
  await ensureContentScript(tabId);
  await sendToTab(tabId, 'open_annotation_overlay');
}

async function assertActiveTab(tabId: number, windowId: number): Promise<void> {
  const [activeTab] = await chrome.tabs.query({ active: true, windowId });
  if (activeTab?.id !== tabId) throw new Error('ANNOTATION_TAB_CHANGED');
}

export async function captureAnnotationTab(
  tabId: number,
  windowId: number,
): Promise<string> {
  await assertActiveTab(tabId, windowId);
  const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
  await assertActiveTab(tabId, windowId);
  return dataUrl;
}
