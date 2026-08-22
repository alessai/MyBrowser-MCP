import { sendToBackground } from '../../lib/messaging';
import { openShortcutSettings } from '../../lib/onboarding';
import type { WsStatusResponse } from '../../lib/protocol';

const connectionDot = document.querySelector<HTMLElement>('#connection-dot');
const connectionLabel = document.querySelector<HTMLElement>('#connection-label');
const connectionDetail = document.querySelector<HTMLElement>('#connection-detail');

async function checkConnection(): Promise<void> {
  if (!connectionDot || !connectionLabel || !connectionDetail) return;
  if (typeof chrome === 'undefined' || !chrome.runtime?.id) {
    connectionDot.dataset.state = 'connected';
    connectionLabel.textContent = 'Preview mode';
    connectionDetail.textContent = 'The installed extension checks the MCP connection here.';
    return;
  }
  connectionDot.dataset.state = 'checking';
  connectionLabel.textContent = 'Checking connection';
  connectionDetail.textContent = 'Looking for the configured MyBrowser server.';
  try {
    const status = await sendToBackground<WsStatusResponse>('ws_status');
    if (status.state === 'CONNECTED') {
      connectionDot.dataset.state = 'connected';
      connectionLabel.textContent = 'Connected';
      connectionDetail.textContent = 'Your local browser is ready for MCP tools.';
    } else {
      connectionDot.dataset.state = 'waiting';
      connectionLabel.textContent = status.state === 'DISCONNECTED' ? 'Waiting for MCP' : 'Connecting';
      connectionDetail.textContent = 'Restart your MCP client or open Not connected? below.';
    }
  } catch {
    connectionDot.dataset.state = 'waiting';
    connectionLabel.textContent = 'Waiting for MCP';
    connectionDetail.textContent = 'Restart your MCP client or open Not connected? below.';
  }
}

for (const button of document.querySelectorAll<HTMLButtonElement>('[data-copy]')) {
  button.addEventListener('click', async () => {
    const text = button.dataset.copy;
    if (!text) return;
    await navigator.clipboard.writeText(text);
    const previous = button.textContent;
    button.textContent = 'Copied';
    window.setTimeout(() => { button.textContent = previous; }, 1_500);
  });
}

document.querySelector('#check-connection')?.addEventListener('click', () => void checkConnection());
const shortcutButton = document.querySelector<HTMLButtonElement>('#open-shortcuts');
const openShortcutTab = typeof chrome !== 'undefined' && chrome.tabs?.create
  ? (url: string) => chrome.tabs.create({ url })
  : undefined;
if (shortcutButton && !openShortcutTab) shortcutButton.textContent = 'Show shortcut settings address';

shortcutButton?.addEventListener('click', async (event) => {
  const button = event.currentTarget as HTMLButtonElement;
  const status = document.querySelector<HTMLElement>('#shortcut-result');
  const result = await openShortcutSettings({
    openTab: openShortcutTab,
    copy: (text) => navigator.clipboard.writeText(text),
  });
  if (status && result !== 'opened') {
    status.hidden = false;
    status.textContent = result === 'copied'
      ? 'Copied chrome://extensions/shortcuts - paste it in the address bar.'
      : 'Open chrome://extensions/shortcuts in the address bar.';
  }
  button.blur();
});
document.querySelector('#close-guide')?.addEventListener('click', () => window.close());

const version = document.querySelector('#version');
if (version) {
  version.textContent = typeof chrome !== 'undefined' && chrome.runtime?.getManifest
    ? `v${chrome.runtime.getManifest().version}`
    : 'preview';
}
void checkConnection();
