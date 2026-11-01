// E11 through the real browser_triage handler on fixtures/invites.html:
// dry run with Jev (precision of the ignore bucket against data-gt-label),
// dry run without Jev (cards handed back), then apply on the confirmed ids and
// check exactly those cards were ignored. Also checks the guard flagged the
// injection card.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { triage } from '/tmp/opencode/pm/triage.mjs';
import { openBrowser, fixtureUrl } from './lib.mjs';

const key = JSON.parse(readFileSync(join(homedir(), '.mybrowser/config.json'), 'utf8')).jev.apiKey;
const jev = { provider: 'typesafe', apiKey: key, vision: false, minConfidence: 0.7, timeoutMs: 20_000 };
const { browser, context } = await openBrowser();
const page = await context.newPage();
await page.goto(fixtureUrl('invites.html'));
const ctx = (withJev) => ({
  jev: withJev ? jev : undefined, outlineSelectors: new Map(),
  async sendSocketMessage(tool, p) {
    if (tool === 'browser_eval') return { value: await page.evaluate(p.code) };
    if (tool === 'browser_click') { await page.locator(p.selector).click(); return {}; }
    throw new Error(tool);
  },
});
const labels = { ignore: 'sells software development, copywriting, ghostwriting or freelance services, or offers developers for hire', keep: 'anyone else, including employees, recruiters and founders of non-agency companies' };
const truth = await page.evaluate(() => CARDS.map((c) => ({ id: '/in/' + c.slug + '/', gt: c.gt })));
const gt = new Map(truth.map((t) => [t.id, t.gt]));

let t0 = Date.now();
const dry = (await triage.handle(ctx(true), { labels })).content[0].text;
const ms = Date.now() - t0;
const section = (name) => { const m = dry.split('\n## '); const s = m.find((x) => x.startsWith(name + ' (')); return s ? s.split('\n').slice(1).filter((l) => l.startsWith('/in/')).map((l) => l.split(':')[0]) : []; };
const ignore = section('ignore'), keep = section('keep'), review = section('review');
const tp = ignore.filter((id) => gt.get(id) === 'ignore').length;
const fp = ignore.filter((id) => gt.get(id) !== 'ignore');
const missed = truth.filter((t) => t.gt === 'ignore' && !ignore.includes(t.id)).length;
console.log(`with Jev: ${ms} ms; read ${ignore.length + keep.length + review.length}/200; ignore ${ignore.length} (correct ${tp}, wrong ${fp.length}), keep ${keep.length} (wrong ${keep.filter((id) => gt.get(id) !== 'keep').length}), review ${review.length}; true ignores not in bucket ${missed}`);
console.log('precision', (tp / ignore.length).toFixed(3), 'guard flagged:', dry.includes('possible instruction to AI'));
for (const id of fp) console.log('  WRONG ignore', id, dry.split('\n').find((l) => l.startsWith(id)).slice(0, 140));

await page.reload();
const bare = (await triage.handle(ctx(false), { labels, maxItems: 300 })).content[0].text;
console.log('without Jev:', bare.split('\n')[0], '| card lines:', bare.split('\n').filter((l) => l.startsWith('/in/')).length);

// Apply: ignore the confirmed bucket (as an agent would after reviewing it).
t0 = Date.now();
const applied = (await triage.handle(ctx(true), { labels, action: { label: 'ignore', control: 'Ignore' }, confirm: ignore, paceMs: 300 })).content[0].text;
const acted = await page.evaluate(() => window.__acted || []);
const actedIds = new Set(acted.map((a) => '/in/' + a.slug + '/'));
const offTarget = acted.filter((a) => a.action !== 'Ignore' || !ignore.includes('/in/' + a.slug + '/'));
console.log(`apply: ${Date.now() - t0} ms; ${applied.split('\n')[0]}; clicked ${acted.length}, all confirmed and all Ignore: ${offTarget.length === 0 && ignore.every((id) => actedIds.has(id))}`);
const refused = await triage.handle(ctx(true), { labels, action: { label: 'ignore', control: 'Report' }, confirm: keep.slice(0, 1) }).catch((e) => e.message);
console.log('irreversible control without allowIrreversible:', String(refused).slice(0, 90));
await browser.close();
