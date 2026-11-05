// Loaded-MV3 smoke for `frame`: snapshot, click, type, select and eval inside a
// frame from another origin that starts below the fold, like an embedded form.
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { Client } from '../../server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../../server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';

const PORT = 9316;
const SERVER = resolve('../../server/dist/index.js');
const EXT = resolve('../../extension/.output/chrome-mv3');
const CHROME = join(homedir(), '.cache/ms-playwright/chromium-1248/chrome-linux64/chrome');
const home = mkdtempSync('/tmp/opencode/mb-frame-');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (r) => r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
const results = [];
const check = (name, ok, detail = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${String(detail).replace(/\s+/g, ' ').slice(0, 160)}` : ''}`);

const outer = createServer((_q, s) => { s.setHeader('content-type', 'text/html'); s.end(`<!doctype html><body>
  <h1>Checkout</h1><button id="top">Top button</button>
  <iframe id="pay" src="http://localhost:9418/form" style="border:0;width:700px;height:400px;margin-top:1400px"></iframe></body>`); }).listen(9417, '127.0.0.1');
const inner = createServer((_q, s) => { s.setHeader('content-type', 'text/html'); s.end(`<!doctype html><body>
  <label>Card holder <input id="holder"></label>
  <label>Country <select id="country"><option value="">Choose</option><option value="om">Oman</option><option value="ae">UAE</option></select></label>
  <button id="save" onclick="window.saved = (window.saved || 0) + 1; window.trusted = event.isTrusted">Save card</button>
  </body>`); }).listen(9418, '127.0.0.1');

const hub = spawn('node', [SERVER, '--hub', '--port', String(PORT)], { env: { ...process.env, HOME: home }, stdio: 'ignore' });
await sleep(1500);
const token = JSON.parse(readFileSync(join(home, '.mybrowser/config.json'), 'utf8')).token;
const ctx = await chromium.launchPersistentContext(mkdtempSync('/tmp/opencode/mb-profile-'), {
  executablePath: CHROME, headless: true, viewport: null,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--headless=new', '--window-size=1280,800'],
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker');
await sw.evaluate(async ({ port, token }) => {
  await chrome.storage.local.set({ serverAddress: '127.0.0.1', serverPort: port, authToken: token, browserName: 'FrameCheck' });
}, { port: PORT, token });

const folder = join(home, 'projects/A');
mkdirSync(folder, { recursive: true });
const client = new Client({ name: 'frame-check', version: '1' });
await client.connect(new StdioClientTransport({ command: 'node', args: [SERVER, '--port', String(PORT)], cwd: folder, env: { ...process.env, HOME: home }, stderr: 'ignore' }));
const call = (name, args = {}) => client.callTool({ name, arguments: args }).then((r) => ({ error: r.isError === true, text: text(r) }), (e) => ({ error: true, text: String(e) }));
for (let i = 0; i < 30 && !/FrameCheck/.test((await call('list_browsers')).text); i++) await sleep(500);

const nav = await call('browser_navigate', { url: 'http://127.0.0.1:9417/' });
const tabId = Number(/Opened new tab (\d+)/.exec(nav.text)?.[1]);
const page = ctx.pages().find((p) => p.url().startsWith('http://127.0.0.1:9417'));
await sleep(500);
const frame = page.frames().find((f) => f.url().startsWith('http://localhost:9418'));

const bad = await call('browser_snapshot', { tabId, frame: 'nope.example' });
check('unknown frame lists the frames', bad.error && /FRAME_NOT_FOUND.*localhost:9418\/form/.test(bad.text), bad.text);

const topSnap = await call('browser_snapshot', { tabId, mode: 'full', viewportOnly: false });
check('page snapshot does not see inside the frame', !/Save card/.test(topSnap.text) && /Top button/.test(topSnap.text));

const snap = await call('browser_snapshot', { tabId, frame: 'localhost:9418', mode: 'full', viewportOnly: false });
check('frame snapshot shows the form', /Save card/.test(snap.text) && /Card holder/.test(snap.text) && /- Frame: localhost:9418/.test(snap.text), snap.text.slice(0, 300));

const typed = await call('browser_type', { tabId, frame: 'localhost:9418', element: 'card holder field', label: 'Card holder', text: 'Saif Test', submit: false });
check('type inside the frame', !typed.error && await frame.evaluate(() => document.getElementById('holder').value) === 'Saif Test', typed.text.slice(0, 200));

const sel = await call('browser_select_option', { tabId, frame: 'localhost:9418', element: 'country', label: 'Country', values: ['om'] });
check('select inside the frame', !sel.error && await frame.evaluate(() => document.getElementById('country').value) === 'om', sel.text.slice(0, 200));

const clicked = await call('browser_click', { tabId, frame: 'localhost:9418', element: 'Save card button', role: 'button', name: 'Save card' });
const state = await frame.evaluate(() => ({ saved: window.saved, trusted: window.trusted }));
check('click inside a frame below the fold, as a real click', !clicked.error && state.saved === 1 && state.trusted === true, `${JSON.stringify(state)} | ${clicked.text.slice(0, 160)}`);

const ev = await call('browser_eval', { tabId, frame: 'localhost:9418', code: 'location.href + " " + document.getElementById("holder").value' });
check('eval inside the frame', /localhost:9418\/form Saif Test/.test(ev.text), ev.text);

const topEv = await call('browser_eval', { tabId, code: 'location.href' });
check('without frame, tools act on the page again', /127\.0\.0\.1:9417/.test(topEv.text), topEv.text);

console.log(results.join('\n'));
console.log(`${results.filter((r) => r.startsWith('PASS')).length}/${results.length} passed`);
await client.close();
await ctx.close();
hub.kill(); outer.close(); inner.close();
