// E1/E9 through the real server code: Page Model v2 + Resolver v2 (bundled to
// /tmp/opencode/pm/resolve.mjs) on adset.html, scored against data-gt.
// Modes: code only (no decision model) and code + Jev with one shared element
// list (null Choice descriptions). A wrong pick is the failure that matters.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pageModelCode, resolveItems } from '/tmp/opencode/pm/resolve.mjs';
import { VERIFY } from './cases.mjs';
import { openBrowser, fixtureUrl } from './lib.mjs';

const key = JSON.parse(readFileSync(join(homedir(), '.mybrowser/config.json'), 'utf8')).jev.apiKey;
const decider = { provider: 'typesafe', apiKey: key, vision: false, minConfidence: 0.7, timeoutMs: 20_000 };

const { browser, context } = await openBrowser();
const page = await context.newPage();
await page.goto(fixtureUrl('adset.html'));
const model = await page.evaluate(pageModelCode({ sweep: true }));
const gtOf = await page.evaluate((ns) => Object.fromEntries(ns.map((n) => {
  const el = document.querySelector(`[data-mbo="${n}"]`);
  const ctl = el?.tagName === 'LABEL' ? el.control : el;
  return [n, ctl?.getAttribute('data-gt') || el?.getAttribute('data-gt') || ''];
})), model.elements.map((e) => e.n));
console.log('elements', model.elements.length);

for (const mode of ['code only', 'code + jev']) {
  const t0 = Date.now();
  const { results, deciderRequests, deciderFailures } = await resolveItems(model, VERIFY.map((c) => ({ target: c.phrase })), mode === 'code only' ? {} : { decider });
  const ms = Date.now() - t0;
  const tally = { right: 0, wrong: 0, handedBack: 0, handedBackHasRight: 0, declinedRight: 0, declinedWrong: 0, viaCode: 0, viaDecider: 0 };
  const wrong = [];
  results.forEach((r, i) => {
    const gt = VERIFY[i].gt;
    if (r.status === 'resolved') {
      r.via === 'code' ? tally.viaCode++ : tally.viaDecider++;
      if (gtOf[r.element.n] === gt) tally.right++;
      else { tally.wrong++; wrong.push(`${VERIFY[i].phrase} -> o${r.element.n} ${r.element.role} "${r.element.name}" (${r.via})`); }
    } else if (r.status === 'not_found') gt === null ? tally.declinedRight++ : tally.declinedWrong++;
    else { tally.handedBack++; if (r.candidates.some((e) => gtOf[e.n] === gt)) tally.handedBackHasRight++; }
  });
  console.log(`\n${mode}: ${ms} ms, decider requests ${deciderRequests}, failures ${deciderFailures}`);
  console.log(tally);
  for (const w of wrong) console.log('  WRONG', w);
}
await browser.close();
