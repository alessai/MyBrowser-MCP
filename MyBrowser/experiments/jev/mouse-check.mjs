// Loaded-MV3 smoke for browser_mouse: a page that embeds a frame from another
// origin (like PowerPoint for the web) with a canvas and a text box. The agent
// only has screenshot pixels; clicks, typing and drags must land inside the frame.
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { Client } from '../../server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../../server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';

const PORT = 9313;
const SERVER = resolve('../../server/dist/index.js');
const EXT = resolve('../../extension/.output/chrome-mv3');
const CHROME = join(homedir(), '.cache/ms-playwright/chromium-1248/chrome-linux64/chrome');
const home = mkdtempSync('/tmp/opencode/mb-mouse-');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (r) => r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
const results = [];
const check = (name, ok, detail = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${String(detail).replace(/\s+/g, ' ').slice(0, 150)}` : ''}`);

// Outer page on 127.0.0.1, editor frame on localhost: different origins.
const outer = createServer((_q, s) => { s.setHeader('content-type', 'text/html'); s.end(`<!doctype html><body style="margin:0">
  <h1 style="margin:10px;font:20px sans-serif">Deck</h1>
  <iframe id="ed" src="http://localhost:9415/" style="border:0;width:900px;height:500px;margin-left:120px"></iframe></body>`); }).listen(9414, '127.0.0.1');
const inner = createServer((_q, s) => { s.setHeader('content-type', 'text/html'); s.end(`<!doctype html><body style="margin:0;background:#eee">
  <canvas id="c" width="400" height="300" style="position:absolute;left:20px;top:20px;background:#fff"></canvas>
  <div id="box" style="position:absolute;left:500px;top:40px;width:300px;height:80px;background:#fff;outline:1px solid #999"></div>
  <script>
    window.events = [];
    const c = document.getElementById('c');
    c.addEventListener('click', (e) => window.events.push('canvas-click ' + e.offsetX + ',' + e.offsetY));
    c.addEventListener('dblclick', () => window.events.push('canvas-dblclick'));
    c.addEventListener('contextmenu', (e) => { e.preventDefault(); window.events.push('canvas-rightclick'); });
    let down; c.addEventListener('mousedown', (e) => { down = [e.offsetX, e.offsetY]; });
    c.addEventListener('mouseup', (e) => { if (down && (Math.abs(e.offsetX - down[0]) > 50)) window.events.push('canvas-drag ' + down + ' -> ' + e.offsetX + ',' + e.offsetY); });
    // A slide-editor style text box: becomes editable when clicked.
    const box = document.getElementById('box');
    box.addEventListener('click', () => { box.contentEditable = 'true'; box.focus(); });
  </script></body>`); }).listen(9415, '127.0.0.1');

const hub = spawn('node', [SERVER, '--hub', '--port', String(PORT)], { env: { ...process.env, HOME: home }, stdio: 'ignore' });
await sleep(1500);
const token = JSON.parse(readFileSync(join(home, '.mybrowser/config.json'), 'utf8')).token;

const ctx = await chromium.launchPersistentContext(mkdtempSync('/tmp/opencode/mb-profile-'), {
  // No Playwright viewport emulation: a real browser has none, and it fights the extension's own debugger session.
  executablePath: CHROME, headless: true, viewport: null,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--headless=new', '--window-size=1280,800'],
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker');
await sw.evaluate(async ({ port, token }) => {
  await chrome.storage.local.set({ serverAddress: '127.0.0.1', serverPort: port, authToken: token, browserName: 'MouseCheck' });
}, { port: PORT, token });

const folder = join(home, 'projects/A');
mkdirSync(folder, { recursive: true });
const client = new Client({ name: 'mouse-check', version: '1' });
await client.connect(new StdioClientTransport({ command: 'node', args: [SERVER, '--port', String(PORT)], cwd: folder, env: { ...process.env, HOME: home }, stderr: 'ignore' }));
const call = (name, args = {}) => client.callTool({ name, arguments: args }).then((r) => ({ error: r.isError === true, text: text(r), image: r.content.find((c) => c.type === 'image') }), (e) => ({ error: true, text: String(e) }));
for (let i = 0; i < 30 && !/MouseCheck/.test((await call('list_browsers')).text); i++) await sleep(500);

const nav = await call('browser_navigate', { url: 'http://127.0.0.1:9414/' });
const tabId = Number(/Opened new tab (\d+)/.exec(nav.text)?.[1]);
const page = ctx.pages().find((p) => p.url().startsWith('http://127.0.0.1:9414'));
const frame = page.frames().find((f) => f.url().startsWith('http://localhost:9415'));

const before = await call('browser_mouse', { tabId, action: 'click', x: 10, y: 10 });
check('refuses before a screenshot', before.error && /NO_SCREENSHOT/.test(before.text), before.text);

if (process.env.DIAG) {
  for (let i = 0; i < 4; i++) {
    const s = await call('browser_screenshot', { tabId, annotate: false });
    const b = Buffer.from(s.image.data, 'base64');
    console.log('diag shot', b.readUInt32BE(16), b.readUInt32BE(20), 'innerHeight', await page.evaluate(() => innerHeight));
    await sleep(1500);
  }
}
const shot = await call('browser_screenshot', { tabId, annotate: false });
const png = Buffer.from(shot.image.data, 'base64');
const shotW = png.readUInt32BE(16), shotH = png.readUInt32BE(20);
const scale = shotW / await page.evaluate(() => innerWidth);
check('screenshot is scaled down', shotW < 1280, `${shotW}x${shotH}`);

// Ground truth positions in page pixels, converted to screenshot pixels as an agent reading the image would.
const frameBox = await page.locator('#ed').boundingBox();
const at = (fx, fy) => ({ x: Math.round((frameBox.x + fx) * scale), y: Math.round((frameBox.y + fy) * scale) });
const events = () => frame.evaluate(() => window.events.slice());

const c1 = await call('browser_mouse', { tabId, action: 'click', ...at(20 + 100, 20 + 50) });
const e1 = await events();
check('click lands inside a frame from another site', /canvas-click (9\d|10\d|11\d),(4\d|5\d|6\d)/.test(e1.join()), `${e1.join()} | ${c1.text}`);
check('result says what was under the point', /embedded frame from http:\/\/localhost:9415/.test(c1.text), c1.text);

const d = await call('browser_mouse', { tabId, action: 'double_click', ...at(200, 150) });
const r = await call('browser_mouse', { tabId, action: 'right_click', ...at(200, 150) });
const e2 = await events();
check('double-click and right-click', e2.includes('canvas-dblclick') && e2.includes('canvas-rightclick'), `${e2.join()} | ${d.text} | ${r.text}`);

const from = at(60, 160), to = at(360, 160);
await call('browser_mouse', { tabId, action: 'drag', x: from.x, y: from.y, toX: to.x, toY: to.y });
const e3 = await events();
check('drag inside the frame', e3.some((e) => e.startsWith('canvas-drag')), e3.join());

const t = await call('browser_mouse', { tabId, action: 'click', ...at(650, 80), text: 'Hello from MyBrowser' });
const typed = await frame.evaluate(() => document.getElementById('box').innerText);
check('click a text box and type into it', typed === 'Hello from MyBrowser', `${typed} | ${t.text}`);

const cdp = await page.context().newCDPSession(page);
const { windowId } = await cdp.send('Browser.getWindowForTarget');
await cdp.send('Browser.setWindowBounds', { windowId, bounds: { width: 1000, height: 700 } });
await sleep(500);
const stale = await call('browser_mouse', { tabId, action: 'click', ...at(20, 20) });
check('refuses after the window is resized', stale.error && /SCREENSHOT_STALE/.test(stale.text), stale.text);

console.log(results.join('\n'));
console.log(`${results.filter((r) => r.startsWith('PASS')).length}/${results.length} passed`);
await client.close();
await ctx.close();
hub.kill(); outer.close(); inner.close();
