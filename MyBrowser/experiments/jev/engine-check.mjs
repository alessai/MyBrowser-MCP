// E1 + E2 through the real 2.0 tool handlers (browser_assert setting checks and
// browser_fill_form items), with a fake MCP context that forwards browser_eval,
// click, type and press_key to headless Chromium. Runs with and without Jev.
// Scored against data-gt; any wrong control touched or wrong verdict is a failure.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { assert, fillForm } from '/tmp/opencode/pm/tools.mjs';
import { FILL, VERIFY } from './cases.mjs';
import { openBrowser, fixtureUrl, readState, matches, gtSelector } from './lib.mjs';

const key = JSON.parse(readFileSync(join(homedir(), '.mybrowser/config.json'), 'utf8')).jev.apiKey;
const jev = { provider: 'typesafe', apiKey: key, vision: false, minConfidence: 0.7, timeoutMs: 20_000 };
const { browser, context: bctx } = await openBrowser();

function fakeContext(page, withJev) {
  return {
    jev: withJev ? jev : undefined,
    outlineSelectors: new Map(),
    async sendSocketMessage(tool, p) {
      if (tool === 'browser_eval') return { value: await page.evaluate(p.code) };
      if (tool === 'browser_click') { await page.locator(p.selector).click(); return {}; }
      if (tool === 'browser_type') { await page.locator(p.selector).fill(p.text); return {}; }
      if (tool === 'browser_press_key') { await page.keyboard.press(p.key); return {}; }
      throw new Error(`fake context: ${tool} not supported`);
    },
  };
}
const text = (r) => r.content.map((c) => c.text).join('\n');

for (const withJev of [false, true]) {
  const label = withJev ? 'with Jev' : 'without Jev';
  // ---- E1: 41 setting checks
  let page = await bctx.newPage();
  await page.goto(fixtureUrl('adset.html'));
  await page.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 500) { scrollTo(0, y); await new Promise((r) => setTimeout(r, 50)); } scrollTo(0, 0); });
  let t0 = Date.now();
  const out = text(await assert.handle(fakeContext(page, withJev), { checks: VERIFY.map((c) => ({ type: 'setting', target: c.phrase, expect: c.expect })) }));
  const lines = out.split('\n').slice(1);
  const tally = { pass: 0, fail: 0, not_found: 0, needs_choice: 0, right: 0 };
  const wrong = [];
  for (const [i, l] of lines.entries()) {
    const status = l.split(' ')[0].toLowerCase();
    tally[status] = (tally[status] ?? 0) + 1;
    const c = VERIFY[i];
    // Truth from the page itself; an absent setting (gt null) must never get a verdict.
    if (c.gt === null) { if (status === 'pass' || status === 'fail') wrong.push(l); else tally.right++; continue; }
    if (status !== 'pass' && status !== 'fail') continue;
    const truth = matches(await readState(page, gtSelector(c.gt)), c.expect);
    if ((status === 'pass') === truth) tally.right++; else wrong.push(`${l} [truth: ${truth ? 'pass' : 'fail'}]`);
  }
  console.log(`E1 ${label}: ${Date.now() - t0} ms`, tally);
  for (const w of wrong) console.log('  WRONG', w);
  await page.close();

  // ---- E2: fill 18 items
  page = await bctx.newPage();
  await page.goto(fixtureUrl('adset.html'));
  await page.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 500) { scrollTo(0, y); await new Promise((r) => setTimeout(r, 50)); } scrollTo(0, 0); });
  const snapshot = async () => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('[data-gt]')].map((el) => [el.getAttribute('data-gt'), el.type === 'checkbox' || el.type === 'radio' ? String(el.checked) : el.getAttribute('role') === 'switch' ? el.getAttribute('aria-checked') : el.value ?? el.textContent])));
  const before = await snapshot();
  t0 = Date.now();
  const fillOut = text(await fillForm.handle(fakeContext(page, withJev), { items: FILL.map((c) => ({ target: c.phrase, value: c.value })) }));
  const ms = Date.now() - t0;
  let right = 0;
  const bad = [];
  for (const c of FILL) {
    const st = await readState(page, gtSelector(c.gt));
    const want = c.expectOption ?? c.radioValue ?? c.value;
    if (matches(st, want)) right++; else bad.push(`${c.phrase}: ${JSON.stringify(st).slice(0, 80)}`);
  }
  const after = await snapshot();
  const targets = new Set(FILL.map((c) => c.gt));
  const collateral = Object.keys(after).filter((k) => !targets.has(k) && after[k] !== before[k] && !k.startsWith('adset.gender.'));
  console.log(`E2 ${label}: ${right}/${FILL.length} set correctly, ${ms} ms, collateral changes: ${collateral.length ? collateral.join(', ') : 'none'}`);
  for (const b of bad) console.log('  NOT SET', b);
  console.log(fillOut.split('\n').filter((l) => !/^(DONE|ALREADY_SET)/.test(l)).map((l) => '   | ' + l).join('\n'));
  await page.close();
}
await browser.close();
