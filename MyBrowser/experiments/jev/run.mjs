// Runs the Jev experiments against local fixtures in headless Chromium.
// Usage: node run.mjs [E1 E2 E3 E3b E4]   (default: all). Writes results/<exp>.json.
import { mkdirSync, writeFileSync } from 'node:fs';
import {
  openBrowser, fixtureUrl, extract, describe, sweep, askJev, mapIntents, calls,
  readState, matches, gtSelector, MIN_CONFIDENCE, median,
} from './lib.mjs';
import { VERIFY, FILL, OFFSCREEN, TABLE, WAIT, WAIT_RUNS } from './cases.mjs';

const only = new Set(process.argv.slice(2));
const want = (e) => only.size === 0 || only.has(e);
mkdirSync(new URL('./results/', import.meta.url), { recursive: true });
const save = (name, data) => writeFileSync(new URL(`./results/${name}.json`, import.meta.url), JSON.stringify(data, null, 2));
const { browser, context } = await openBrowser();
const fresh = async (fixture, query) => {
  const page = await context.newPage();
  await page.goto(fixtureUrl(fixture, query));
  await page.waitForTimeout(150);
  return page;
};
const confident = (r) => r.element && r.confidence >= MIN_CONFIDENCE;
const settingQ = (phrase) => `Which page control shows or sets this setting: "${phrase}"? Choose none if no control on the page is for this setting.`;
const targetQ = (phrase) => `Which page element best matches this target: "${phrase}"? Choose none if no element matches.`; // product wording

// ------------------------------------------------------------------ E1 verify
if (want('E1')) {
  const configs = [
    { id: 'A', label: 'whole page, product descriptions', context: 'product', sweep: false },
    { id: 'B', label: 'whole page, + section and row context', context: 'rich', sweep: false },
    { id: 'C', label: 'B + scroll sweep first (renders lazy sections)', context: 'rich', sweep: true },
  ];
  const out = [];
  for (const cfg of configs) {
    for (let rep = 0; rep < 2; rep++) {
      const page = await fresh('adset.html');
      if (cfg.sweep) await sweep(page);
      const state = await extract(page, 'full');
      const t0 = Date.now();
      const { results, optionCount } = await mapIntents(state, VERIFY.map((c) => c.phrase), { context: cfg.context, instructions: settingQ, batch: 8 });
      const wall = Date.now() - t0;
      const cases = [];
      for (const [i, c] of VERIFY.entries()) {
        const r = results[i];
        // Controls in the closed <details> still exist and can be read (run 1
        // showed the whole-page read includes them), so they count as present
        // for verifying; `collapsed` records that acting on them needs expanding first.
        const present = c.gt && (!c.lazy || cfg.sweep);
        const picked = confident(r) ? r.element.gt : null;
        let outcome;
        if (present) outcome = picked === c.gt ? 'right' : picked ? 'wrong' : 'declined';
        else outcome = picked ? 'wrong' : 'right';
        let verdict = null, truth = null;
        if (present) truth = matches(await readState(page, gtSelector(c.gt)), c.expect);
        if (picked) verdict = matches(await readState(page, r.element.selector), c.expect);
        cases.push({ phrase: c.phrase, gt: c.gt, present: !!present, collapsed: r.element ? !r.element.visible : null, picked, picked_desc: r.element ? describe(r.element, cfg.context) : null, confidence: r.confidence, outcome, verdict, truth });
      }
      out.push({ config: cfg, rep, optionCount, wallMs: wall, requests: Math.ceil(VERIFY.length / 8), cases });
      await page.close();
      const n = (o) => cases.filter((x) => x.outcome === o).length;
      console.log(`E1 ${cfg.id} rep${rep}: right ${n('right')} wrong ${n('wrong')} declined ${n('declined')} / ${cases.length}  (${optionCount} options, ${wall} ms)`);
    }
  }
  // Batch size vs latency (config B).
  const page = await fresh('adset.html');
  const state = await extract(page, 'full');
  const latency = [];
  // Large batches hit TypeSafe's request token limit (max_tokens_exceeded): record where.
  for (const batch of [1, 8, 10, 12, 16, 20, VERIFY.length]) {
    const t0 = Date.now();
    try {
      await mapIntents(state, VERIFY.slice(0, Math.max(batch, 8)).map((c) => c.phrase), { context: 'rich', instructions: settingQ, batch });
      latency.push({ batch, questions: Math.max(batch, 8), wallMs: Date.now() - t0, inputTokens: calls.at(-1)?.inputTokens });
    } catch (e) {
      latency.push({ batch, questions: Math.max(batch, 8), error: String(e.message).slice(0, 80) });
    }
  }
  await page.close();
  console.log('E1 latency', latency);
  save('E1', { runs: out, latency });
}

// ------------------------------------------------------------------ E2 fill
if (want('E2')) {
  const runs = [];
  for (let rep = 0; rep < 2; rep++) {
    const page = await fresh('adset.html');
    const callsBefore = calls.length;
    const t0 = Date.now();
    await sweep(page);
    const allGt = await page.evaluate(() => [...document.querySelectorAll('[data-gt]')].map((e) => e.getAttribute('data-gt')));
    const before = Object.fromEntries(await Promise.all(allGt.map(async (g) => [g, JSON.stringify(await readState(page, gtSelector(g)))])));
    const state = await extract(page, 'full');
    const { results } = await mapIntents(state, FILL.map((f) => `${f.phrase}" to "${f.value}`), {
      context: 'rich', batch: 9,
      instructions: (x) => `Which page control should be changed to set "${x}"? Choose none if no control on the page is for this setting.`,
    });
    const steps = [];
    for (const [i, f] of FILL.entries()) {
      const r = results[i];
      const step = { phrase: f.phrase, value: f.value, gt: f.gt, picked: confident(r) ? r.element.gt : null, confidence: r.confidence };
      if (step.picked) {
        const sel = r.element.selector;
        const s = await readState(page, sel);
        try {
          if ('on' in s) {
            const want = (f.radioValue ?? f.value) === 'on';
            if (r.element.role === 'switch') { if (s.on !== want) await page.click(sel); } else await page.setChecked(sel, want);
          } else if (s.options) {
            const exact = s.options.find((o) => o.toLowerCase() === f.value.toLowerCase());
            let label = exact;
            if (!label) {
              const criteria = Object.fromEntries(s.options.map((o, k) => [`o${k}`, o]));
              criteria.none = 'None of the options fits';
              const { answers } = await askJev({ control: describe(r.element, 'rich'), options: s.options }, { opt: { type: 'choice', instructions: `Which option of this dropdown means "${f.value}"? Choose none if no option fits.`, criteria } });
              const a = answers.opt;
              if (a && a.choice !== 'none' && a.confidence >= MIN_CONFIDENCE) label = s.options[Number(a.choice.slice(1))];
              step.optionConfidence = a?.confidence;
            }
            if (label) await page.selectOption(sel, { label }); else step.error = 'no matching option';
          } else {
            await page.fill(sel, f.value);
          }
        } catch (e) { step.error = String(e.message).slice(0, 120); }
      }
      const expected = f.expectOption ?? f.radioValue ?? f.value;
      step.done = matches(await readState(page, gtSelector(f.gt)), expected);
      steps.push(step);
    }
    const intended = new Set(FILL.map((f) => f.gt));
    const radioSiblings = new Set(['adset.gender.all', 'adset.gender.men']); // selecting Women unchecks these by design
    const after = Object.fromEntries(await Promise.all(allGt.map(async (g) => [g, JSON.stringify(await readState(page, gtSelector(g)))])));
    const collateral = allGt.filter((g) => !intended.has(g) && !radioSiblings.has(g) && before[g] !== after[g]);
    runs.push({ rep, wallMs: Date.now() - t0, jevCalls: calls.length - callsBefore, steps, collateral });
    console.log(`E2 rep${rep}: done ${steps.filter((s) => s.done).length}/${steps.length}, collateral ${collateral.length}, ${calls.length - callsBefore} Jev calls, ${Date.now() - t0} ms`);
    await page.close();
  }
  save('E2', { runs });
}

// ------------------------------------------------------------------ E3 off-screen
if (want('E3')) {
  const configs = [
    { id: 'P', label: 'viewport only, product descriptions (today)', mode: 'viewport', context: 'product' },
    { id: 'F', label: 'whole page, product descriptions', mode: 'full', context: 'product' },
    { id: 'R', label: 'whole page, + section and row context', mode: 'full', context: 'rich' },
  ];
  const out = [];
  for (const cfg of configs) {
    const page = await fresh('adset.html');
    const state = await extract(page, cfg.mode);
    const { results, optionCount } = await mapIntents(state, OFFSCREEN.map((c) => c.phrase), { context: cfg.context, instructions: targetQ, batch: 6 });
    const cases = OFFSCREEN.map((c, i) => {
      const r = results[i];
      const el = confident(r) ? r.element : null;
      const ok = el && (c.gt ? el.gt === c.gt : el.name.startsWith('Advantage+ creative enhancements'));
      return { phrase: c.phrase, gt: c.gt, picked: el ? (el.gt || el.name) : null, confidence: r.confidence, outcome: ok ? 'right' : el ? 'wrong' : 'declined' };
    });
    out.push({ config: cfg, optionCount, cases });
    const n = (o) => cases.filter((x) => x.outcome === o).length;
    console.log(`E3 ${cfg.id}: right ${n('right')} wrong ${n('wrong')} declined ${n('declined')} / ${cases.length} (${optionCount} options)`);
    await page.close();
  }
  save('E3', { runs: out });
}

// ------------------------------------------------------------------ E3b big table
if (want('E3b')) {
  const page = await fresh('campaigns.html');
  const viewport = await extract(page, 'viewport');
  const full = await extract(page, 'full');
  // Product's lexical pre-filter (resolve.ts capCandidates), per intent.
  const cap = (els, intent, context) => {
    if (els.length <= 254) return els;
    const words = new Set(intent.toLowerCase().split(/\W+/).filter((w) => w.length > 2));
    const score = (e) => describe(e, context).toLowerCase().split(/\W+/).filter((w) => words.has(w)).length;
    const keep = new Set(els.map((e, i) => ({ i, s: score(e) })).sort((a, b) => b.s - a.s).slice(0, 254).map((x) => x.i));
    return els.filter((_, i) => keep.has(i));
  };
  const single = async (els, intent, context) => {
    const r = (await mapIntents({ title: full.title, url: full.url, elements: els }, [intent], { context, instructions: targetQ, batch: 1 })).results[0];
    return r;
  };
  const configs = {
    P: { label: 'viewport only, product descriptions (today)', run: (c) => single(viewport.elements, c.phrase, 'product') },
    F: { label: 'whole page + product pre-filter, product descriptions', run: (c) => single(cap(full.elements, c.phrase, 'product'), c.phrase, 'product') },
    R: { label: 'whole page + product pre-filter, row context', run: (c) => single(cap(full.elements, c.phrase, 'rich'), c.phrase, 'rich') },
    T: {
      label: 'two steps: pick the row, then the control in it',
      run: async (c) => {
        const rows = [...new Set(full.elements.map((e) => e.rowText).filter(Boolean))];
        const pickRow = (await mapIntents({ title: full.title, url: full.url, elements: rows.map((t) => ({ role: 'row', name: t })) }, [c.phrase], {
          context: 'product', batch: 1, instructions: (p) => `Which table row is the target in: "${p}"? Choose none if no row matches.`,
        })).results[0];
        if (!confident(pickRow)) return { element: null, confidence: pickRow.confidence };
        const inRow = full.elements.filter((e) => e.rowText === pickRow.element.name);
        return single(inRow, c.phrase, 'rich');
      },
    },
  };
  const out = [];
  for (const [id, cfg] of Object.entries(configs)) {
    const cases = [];
    for (const c of TABLE) {
      const t0 = Date.now();
      const r = await cfg.run(c);
      const el = confident(r) ? r.element : null;
      cases.push({ phrase: c.phrase, gt: c.gt, picked: el?.gt ?? null, confidence: r.confidence, ms: Date.now() - t0, outcome: el ? (el.gt === c.gt ? 'right' : 'wrong') : 'declined' });
    }
    out.push({ id, label: cfg.label, cases });
    const n = (o) => cases.filter((x) => x.outcome === o).length;
    console.log(`E3b ${id}: right ${n('right')} wrong ${n('wrong')} declined ${n('declined')} / ${cases.length}`);
  }
  save('E3b', { elements: { viewport: viewport.elements.length, full: full.elements.length }, runs: out });
  await page.close();
}

// ------------------------------------------------------------------ E4 wait
if (want('E4')) {
  const runs = [];
  for (const done of WAIT_RUNS) {
    const page = await fresh('upload.html', `?done=${done}`);
    const truth = await page.evaluate(() => window.__truth);
    const polls = [];
    for (;;) {
      const tPoll = Date.now();
      const snap = await page.evaluate(() => ({ t: performance.now(), text: document.body.innerText.slice(0, 4000), title: document.title }));
      if (snap.t > truth.previewAt + 4000) break;
      const questions = Object.fromEntries(WAIT.map((w) => [w.key, { type: 'noul', instructions: w.question }]));
      const { answers, ms } = await askJev({ page: { title: snap.title }, text: snap.text }, questions);
      polls.push({ t: Math.round(snap.t), ms, p: Object.fromEntries(WAIT.map((w) => [w.key, answers[w.key]?.noul ?? null])) });
      const wait = 500 - (Date.now() - tPoll);
      if (wait > 0) await page.waitForTimeout(wait);
    }
    const score = (w, consecutive) => {
      const at = truth[w.truth];
      let hit = null, early = 0;
      for (let i = 0; i < polls.length; i++) {
        const okNow = polls[i].p[w.key] >= MIN_CONFIDENCE && (consecutive < 2 || (i > 0 && polls[i - 1].p[w.key] >= MIN_CONFIDENCE));
        if (!okNow) continue;
        if (at === null || polls[i].t < at) { early++; continue; }
        if (hit === null) hit = polls[i].t - at;
      }
      return { delayMs: hit, falseEarly: early };
    };
    const summary = Object.fromEntries(WAIT.map((w) => [w.key, { one: score(w, 1), two: score(w, 2) }]));
    runs.push({ done, truth, polls, summary });
    console.log(`E4 done=${done}:`, JSON.stringify(summary));
    await page.close();
  }
  save('E4', { runs, pollMsMedian: median(runs.flatMap((r) => r.polls.map((p) => p.ms))) });
}

await browser.close();
save(`calls-${Date.now()}`, { calls, total: calls.length, medianMs: median(calls.map((c) => c.ms)) });
console.log(`Jev calls ${calls.length}, median ${median(calls.map((c) => c.ms))} ms`);
