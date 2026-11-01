// Loaded-MV3 smoke for the popup "Agent access" switch: a real Chromium with
// the built extension, a fresh MyBrowser server on a spare port, an MCP client
// over stdio. Checks: connected -> switch off (disconnects, tools fail, stays
// off after a service-worker restart) -> switch on (reconnects).
import { mkdtempSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { Client } from '../../server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../../server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';

const PORT = 9311;
const EXT = resolve('../../extension/.output/chrome-mv3');
const CHROME = join(homedir(), '.cache/ms-playwright/chromium-1248/chrome-linux64/chrome');
const home = mkdtempSync('/tmp/opencode/mb-access-');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (r) => r.content.map((c) => c.text).join('\n');

const mcp = new Client({ name: 'access-check', version: '1' });
await mcp.connect(new StdioClientTransport({ command: 'node', args: [resolve('../../server/dist/index.js'), '--port', String(PORT)], env: { ...process.env, HOME: home }, stderr: 'ignore' }));
const browsers = async () => text(await mcp.callTool({ name: 'list_browsers', arguments: {} }));
const waitFor = async (pred, label, ms = 15000) => {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) { last = await browsers(); if (pred(last)) return last; await sleep(500); }
  throw new Error(`timeout waiting for ${label}; last: ${last}`);
};

const ctx = await chromium.launchPersistentContext(mkdtempSync('/tmp/opencode/mb-profile-'), {
  executablePath: CHROME, headless: true,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--headless=new'],
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker');
const extId = new URL(sw.url()).host;
await sw.evaluate(async (port) => { await chrome.storage.local.set({ serverAddress: '127.0.0.1', serverPort: port, browserName: 'AccessCheck' }); }, PORT);

const results = [];
const check = (name, ok, detail = '') => { results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`); };

check('connects while access is on', /AccessCheck/.test(await waitFor((t) => /AccessCheck/.test(t), 'connect')));

const popup = await ctx.newPage();
await popup.goto(`chrome-extension://${extId}/popup.html`);
const sw1 = popup.getByRole('switch', { name: 'Agent access' });
check('switch starts on', (await sw1.getAttribute('aria-checked')) === 'true');
await sw1.click();
await popup.getByText('Access off', { exact: true }).waitFor({ timeout: 5000 });
check('popup shows Access off', true);
check('browser disconnects from the server', !/AccessCheck/.test(await waitFor((t) => !/AccessCheck/.test(t), 'disconnect')));
const nav = await mcp.callTool({ name: 'browser_navigate', arguments: { url: 'https://example.com/' } }).then(text, (e) => `error: ${e.message}`);
check('tools fail while off', /not connected|No browser|disconnected|error/i.test(nav), nav.slice(0, 120));
const badge = await sw.evaluate(() => chrome.action.getBadgeText({}));
check('badge says OFF', badge === 'OFF', badge);

// Stays off across a keepalive / service-worker restart path.
await sw.evaluate(() => chrome.storage.local.get('accessEnabled')).then((v) => check('choice is persisted', v.accessEnabled === false));
// The 30 s keepalive alarm reconnects a dropped socket; it must not while access is off.
await sleep(36000);
check('stays disconnected through a keepalive cycle', !/AccessCheck/.test(await browsers()));

await popup.reload();
const sw2 = popup.getByRole('switch', { name: 'Agent access' });
check('switch remembers off after reopening the popup', (await sw2.getAttribute('aria-checked')) === 'false');
await sw2.click();
check('reconnects when switched back on', /AccessCheck/.test(await waitFor((t) => /AccessCheck/.test(t), 'reconnect')));
const nav2 = await mcp.callTool({ name: 'browser_navigate', arguments: { url: 'https://example.com/' } }).then(text, (e) => `error: ${e.message}`);
check('tools work again', /example\.com|Example Domain/i.test(nav2), nav2.slice(0, 80));

console.log(results.join('\n'));
console.log(`${results.filter((r) => r.startsWith('PASS')).length}/${results.length} passed`);
await ctx.close();
await mcp.close();
