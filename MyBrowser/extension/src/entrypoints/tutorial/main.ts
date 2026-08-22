import { sendToBackground } from '../../lib/messaging';
import type { WsStatusResponse } from '../../lib/protocol';

const connectionDot = document.querySelector<HTMLElement>('#connection-dot');
const connectionLabel = document.querySelector<HTMLElement>('#connection-label');
const connectionDetail = document.querySelector<HTMLElement>('#connection-detail');

async function checkConnection(): Promise<void> {
  if (!connectionDot || !connectionLabel || !connectionDetail) return;
  connectionDot.dataset.state = 'checking';
  connectionLabel.textContent = 'Checking connection';
  connectionDetail.textContent = 'Looking for MyBrowser on 127.0.0.1:9009.';
  try {
    const status = await sendToBackground<WsStatusResponse>('ws_status');
    if (status.state === 'CONNECTED') {
      connectionDot.dataset.state = 'connected';
      connectionLabel.textContent = 'Connected';
      connectionDetail.textContent = 'Your local browser is ready for MCP tools.';
    } else {
      connectionDot.dataset.state = 'waiting';
      connectionLabel.textContent = status.state === 'DISCONNECTED' ? 'Waiting for MCP' : 'Connecting';
      connectionDetail.textContent = 'Add the MCP command below, then check again.';
    }
  } catch {
    connectionDot.dataset.state = 'waiting';
    connectionLabel.textContent = 'Waiting for MCP';
    connectionDetail.textContent = 'Add the MCP command below, then check again.';
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
document.querySelector('#open-shortcuts')?.addEventListener('click', () => {
  void chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});
document.querySelector('#close-guide')?.addEventListener('click', () => window.close());

const version = document.querySelector('#version');
if (version) version.textContent = `v${chrome.runtime.getManifest().version}`;
void checkConnection();
