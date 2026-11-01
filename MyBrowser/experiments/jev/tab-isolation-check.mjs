// Loaded-MV3 smoke for tab isolation: a real Chromium with the built
// extension, a MyBrowser hub, and two agents (MCP clients started from two
// different folders, like OpenCode v2 does). The user's own tab must never be
// touched; agents cannot drive each other's tabs; a restarted agent process
// from the same folder gets its tab back.
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { Client } from '../../server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../../server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';

const PORT = 9312;
const SERVER = resolve('../../server/dist/index.js');
const EXT = resolve('../../extension/.output/chrome-mv3');
const CHROME = join(homedir(), '.cache/ms-playwright/chromium-1248/chrome-linux64/chrome');
const home = mkdtempSync('/tmp/opencode/mb-iso-');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (r) => r.content.map((c) => c.text).join('\n');
const results = [];
const check = (name, ok, detail = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${String(detail).replace(/\s+/g, ' ').slice(0, 140)}` : ''}`);

const hub = spawn('node', [SERVER, '--hub', '--port', String(PORT)], { env: { ...process.env, HOME: home }, stdio: 'ignore' });
await sleep(1500);
const token = JSON.parse(readFileSync(join(home, '.mybrowser/config.json'), 'utf8')).token;

async function agent(folder) {
  mkdirSync(folder, { recursive: true });
  const client = new Client({ name: `agent-${folder.split('/').pop()}`, version: '1' });
  await client.connect(new StdioClientTransport({ command: 'node', args: [SERVER, '--port', String(PORT)], cwd: folder, env: { ...process.env, HOME: home }, stderr: 'ignore' }));
  const call = (name, args = {}) => client.callTool({ name, arguments: args }).then((r) => ({ error: r.isError === true, text: text(r) }), (e) => ({ error: true, text: String(e) }));
  return { client, call };
}
const tabIdOf = (t) => Number(/tab (\d+)/.exec(t)?.[1]);

const ctx = await chromium.launchPersistentContext(mkdtempSync('/tmp/opencode/mb-profile-'), {
  executablePath: CHROME, headless: true,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--headless=new'],
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker');
await sw.evaluate(async ({ port, token }) => {
  await chrome.storage.local.set({ serverAddress: '127.0.0.1', serverPort: port, authToken: token, browserName: 'IsoCheck' });
}, { port: PORT, token });
// The user's own tab, active in the window.
const userPage = await ctx.newPage();
await userPage.goto('https://example.org/');
await userPage.bringToFront();

const folderA = join(home, 'projects/A');
const folderB = join(home, 'projects/B');
let A = await agent(folderA);
const B = await agent(folderB);
for (let i = 0; i < 30 && !/IsoCheck/.test((await A.call('list_browsers')).text); i++) await sleep(500);

const snap = await A.call('browser_snapshot');
check('agent without a tab is refused, not given the user tab', snap.error && /NO_SESSION_TAB/.test(snap.text), snap.text);

const nav = await A.call('browser_navigate', { url: 'https://example.com/' });
const tabA = Number(/Opened new tab (\d+)/.exec(nav.text)?.[1]);
check('browser_navigate opens a tab of its own', !nav.error && tabA > 0, nav.text);
check('user tab untouched after navigate', userPage.url() === 'https://example.org/', userPage.url());

const steal = await B.call('browser_navigate', { url: 'https://example.com/?b', tabId: tabA });
check("another agent cannot drive that tab", steal.error && /another agent session/.test(steal.text), steal.text);
const navB = await B.call('new_tab', { url: 'https://example.com/?b' });
const tabB = tabIdOf(navB.text);
check('the other agent gets its own tab', tabB > 0 && tabB !== tabA, navB.text);

const tabs = await A.call('list_tabs');
const userTabId = Number(new RegExp(`\\[(\\d+)\\] Example Domain - https://example.org/`).exec(tabs.text)?.[1]);
const own = await A.call('select_tab', { tabId: userTabId });
check('an agent can still choose to work in a user tab by id', !own.error, own.text);
const blocked = await B.call('browser_snapshot', { tabId: userTabId }).then(() => B.call('browser_press_key', { key: 'End', tabId: userTabId }));
check('...and then that tab is protected from other agents', blocked.error && /another agent session/.test(blocked.text), blocked.text);
await A.call('select_tab', { tabId: tabA });

// Restart agent A (OpenCode stops idle MCP processes and starts a new one).
await A.client.close();
await sleep(1500);
A = await agent(folderA);
await sleep(500);
const after = await A.call('browser_snapshot');
check('restarted agent resumes its own tab', !after.error && /example\.com/.test(after.text), after.text);
const stillOpen = (await A.call('list_tabs')).text;
check("its tab was not closed by the restart", new RegExp(`\\[${tabA}\\]`).test(stillOpen), stillOpen);
const stealAgain = await B.call('browser_press_key', { key: 'End', tabId: tabA });
check('the resumed tab is still protected', stealAgain.error && /another agent session/.test(stealAgain.text), stealAgain.text);
check('user tab still untouched at the end', userPage.url() === 'https://example.org/' && !userPage.isClosed(), userPage.url());

console.log(results.join('\n'));
console.log(`${results.filter((r) => r.startsWith('PASS')).length}/${results.length} passed`);
await A.client.close();
await B.client.close();
await ctx.close();
hub.kill();
