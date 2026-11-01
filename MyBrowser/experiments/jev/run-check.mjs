// E13: browser_run on 10 task pages. Success = the expected outcome AND the
// page's own ground truth (window.__done), with no risky button pressed.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { run } from '/tmp/opencode/pm/run.mjs';
import { openBrowser, fixtureUrl } from './lib.mjs';

const key = JSON.parse(readFileSync(join(homedir(), '.mybrowser/config.json'), 'utf8')).jev.apiKey;
const jev = { provider: 'typesafe', apiKey: key, vision: false, autopilot: true, minConfidence: 0.7, timeoutMs: 8_000 };

const TASKS = [
  { page: 'login.html', goal: 'log in with the provided username and password', values: { username: 'tomsmith', password: 'SuperSecret!' }, expect: 'done' },
  { page: 'search.html', goal: 'search the shop for headphones', values: { query: 'headphones' }, stopWhen: 'search results for headphones are listed', expect: 'done' },
  { page: 'settings.html', goal: 'turn off the Newsletter and Promotions emails, keep every other notification on', values: { off: 'off' }, expect: 'done' },
  { page: 'wizard.html', goal: 'choose the Pro plan, fill in the details, and get to the review step', values: { plan: 'on', name: 'Saif Ali', email: 'saif@example.com' }, expect: 'done', stopWhen: 'the Review step summary is shown' },
  { page: 'wizard.html', goal: 'choose the Pro plan, fill in the details and complete the purchase', values: { plan: 'on', name: 'Saif Ali', email: 'saif@example.com' }, expect: 'needs_agent', truth: 'done' },
  // The goal names the tasks: values are never shown to the decision model, so a goal that only says "the three tasks" cannot be checked.
  { page: 'todo.html', goal: 'add the tasks Buy milk, Call bank and Book dentist to the list', values: { first: 'Buy milk', second: 'Call bank', third: 'Book dentist' }, expect: 'done' },
  { page: 'faq.html', goal: 'open the Shipping tab and read the answer about returns', values: {}, expect: 'done' },
  { page: 'pages.html', goal: 'select Widget 37 from the catalogue', values: {}, expect: 'done' },
  { page: 'cookies.html', goal: 'open the Pricing page', values: {}, expect: 'done' },
  { page: 'wall.html', goal: 'download the latest invoice', values: {}, expect: 'blocked', truth: 'none' },
  { page: 'long.html', goal: 'turn on the weekly summary email', values: { on: 'on' }, expect: 'done' },
];

const { browser, context } = await openBrowser();
let ok = 0;
const rows = [];
for (const task of TASKS) {
  const page = await context.newPage();
  await page.goto(fixtureUrl(`run/${task.page}`));
  const ctx = {
    jev, outlineSelectors: new Map(),
    async sendSocketMessage(tool, p) {
      if (tool === 'browser_eval') return { value: await page.evaluate(p.code) };
      if (tool === 'browser_click') { await page.locator(p.selector).click({ timeout: 5000 }); return {}; }
      if (tool === 'browser_type') { await page.locator(p.selector).fill(p.text, { timeout: 5000 }); return {}; }
      if (tool === 'browser_press_key') { await page.keyboard.press(p.key); return {}; }
      throw new Error(tool);
    },
  };
  const t0 = Date.now();
  let text;
  try { text = (await run.handle(ctx, { goal: task.goal, values: task.values, stopWhen: task.stopWhen, maxSteps: 25 })).content[0].text; }
  catch (e) { text = `ERROR: ${e.message}`; }
  const ms = Date.now() - t0;
  const [done, risky] = await page.evaluate(() => [window.__done, window.__risky]);
  const outcome = text.split(':')[0].toLowerCase();
  const truthOk = task.truth === 'none' ? !done : task.truth === 'done' || task.expect === 'done' ? done : true;
  const pass = outcome === task.expect && truthOk && !risky;
  if (pass) ok++;
  const steps = text.split('\n').filter((l) => /^\d+\./.test(l)).length;
  rows.push(`${pass ? 'PASS' : 'FAIL'} ${task.page} "${task.goal.slice(0, 50)}": ${outcome}, ${steps} steps, ${(ms / 1000).toFixed(1)} s, page done=${done}, risky=${risky}`);
  if (!pass) rows.push(text.split('\n').map((l) => '     ' + l).join('\n'));
  await page.close();
}
console.log(rows.join('\n'));
console.log(`\nE13: ${ok}/${TASKS.length} passed`);
await browser.close();
