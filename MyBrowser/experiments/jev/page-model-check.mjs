// Runs the server's Page Model v2 reader (bundled to /tmp/opencode/pm/model.mjs)
// in headless Chromium against the replica fixtures and prints what it sees:
// counts, sections, stable numbers across a re-render, and the hidden-input case.
import { pageModelCode } from '/tmp/opencode/pm/model.mjs';
import { openBrowser, fixtureUrl } from './lib.mjs';

const { browser, context } = await openBrowser();
const page = await context.newPage();
const read = (opts) => page.evaluate(pageModelCode(opts));

await page.goto(fixtureUrl('adset.html'));
const a = await read({});
const sections = [...new Set(a.elements.map((e) => e.section))];
console.log('adset: elements', a.elements.length, 'truncated', a.truncated, 'sections', sections.length);
console.log('  where:', Object.entries(a.elements.reduce((m, e) => ((m[e.where || 'view'] = (m[e.where || 'view'] || 0) + 1), m), {})));
for (const e of a.elements.slice(0, 6)) console.log('  ', `o${e.n}`, e.role, JSON.stringify(e.name), '|', e.section, '>', e.sub, '| row', JSON.stringify(e.row), '|', e.state, e.where);
const swept = await read({ sweep: true });
console.log('adset swept: elements', swept.elements.length);

// Stable numbers: read twice, then re-render one control (same role/name/section/row).
const before = new Map(swept.elements.map((e) => [`${e.role}|${e.name}|${e.section}|${e.sub}|${e.row}`, e.n]));
await page.evaluate(() => { const el = document.querySelector('input[type=checkbox]'); const copy = el.cloneNode(true); copy.removeAttribute('data-mbo'); el.replaceWith(copy); });
const again = await read({ sweep: true });
let same = 0, changed = 0;
for (const e of again.elements) { const k = `${e.role}|${e.name}|${e.section}|${e.sub}|${e.row}`; if (before.has(k)) (before.get(k) === e.n ? same++ : changed++); }
console.log('stable numbers after a re-render:', same, 'same,', changed, 'changed');

// Selector round trip: every element's selector finds exactly one node.
const bad = await page.evaluate((els) => els.filter((e) => !e.selector.includes('>>>') && document.querySelectorAll(e.selector).length !== 1).length, again.elements);
console.log('selectors not unique:', bad);

await page.goto(fixtureUrl('campaigns.html'));
const c = await read({});
console.log('campaigns: elements', c.elements.length, 'below the fold', c.elements.filter((e) => e.where === 'below').length);
await browser.close();
