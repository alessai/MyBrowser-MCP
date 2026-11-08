// Loaded-MV3 smoke for a hub restart while an agent is working: a real
// Chromium with the built extension, a hub, and one agent. After the hub is
// stopped (SIGTERM, like systemctl restart) and started again, the same agent
// process must keep working in its tab without reloading the extension.
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { Client } from '../../server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../../server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';

const PORT = 9313;
const SERVER = resolve('../../server/dist/index.js');
const EXT = resolve('../../extension/.output/chrome-mv3');
const CHROME = join(homedir(), '.cache/ms-playwright/chromium-1248/chrome-linux64/chrome');
const home = mkdtempSync('/tmp/opencode/mb-hubrestart-');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (r) => r.content.map((c) => c.text).join('\n');
const results = [];
const check = (name, ok, detail = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${String(detail).replace(/\s+/g, ' ').slice(0, 160)}` : ''}`);

const startHub = () => spawn('node', [SERVER, '--hub', '--port', String(PORT)], { env: { ...process.env, HOME: home }, stdio: 'ignore' });
const stopHub = (p) => new Promise((r) => { p.once('exit', r); p.kill('SIGTERM'); });
let hub = startHub();
await sleep(1500);
const token = JSON.parse(readFileSync(join(home, '.mybrowser/config.json'), 'utf8')).token;

const folder = join(home, 'projects/A');
mkdirSync(folder, { recursive: true });
const client = new Client({ name: 'agent-a', version: '1' });
await client.connect(new StdioClientTransport({ command: 'node', args: [SERVER, '--port', String(PORT)], cwd: folder, env: { ...process.env, HOME: home }, stderr: 'ignore' }));
const call = (name, args = {}) => client.callTool({ name, arguments: args }).then((r) => ({ error: r.isError === true, text: text(r) }), (e) => ({ error: true, text: String(e) }));

const ctx = await chromium.launchPersistentContext(mkdtempSync('/tmp/opencode/mb-profile-'), {
  executablePath: CHROME, headless: true,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--headless=new'],
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker');
await sw.evaluate(async ({ port, token }) => {
  await chrome.storage.local.set({ serverAddress: '127.0.0.1', serverPort: port, authToken: token, browserName: 'RestartCheck' });
}, { port: PORT, token });
const connected = async () => /RestartCheck/.test((await call('list_browsers')).text);
for (let i = 0; i < 30 && !(await connected()); i++) await sleep(500);

const nav = await call('browser_navigate', { url: 'https://example.com/' });
const tab = Number(/Opened new tab (\d+)/.exec(nav.text)?.[1]);
check('agent opens its tab before the restart', !nav.error && tab > 0, nav.text);

for (let round = 1; round <= 2; round++) {
  await stopHub(hub);
  hub = startHub();
  let ok = false;
  for (let i = 0; i < 40 && !ok; i++) { await sleep(500); ok = await connected(); }
  check(`restart ${round}: browser and agent reconnect`, ok);
  const snap = await call('browser_snapshot');
  check(`restart ${round}: same agent keeps working in its tab (no SESSION_CLOSED)`, !snap.error && /example\.com/.test(snap.text), snap.text);
  const tabs = (await call('list_tabs')).text;
  check(`restart ${round}: its tab is still open`, new RegExp(`\\[${tab}\\]`).test(tabs), tabs);
}

console.log(results.join('\n'));
console.log(`${results.filter((r) => r.startsWith('PASS')).length}/${results.length} passed`);
await client.close();
await ctx.close();
await stopHub(hub);
