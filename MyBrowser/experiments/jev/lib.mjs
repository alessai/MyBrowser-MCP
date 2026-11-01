// Shared harness for the Jev experiments: headless Chromium, the page
// extraction (product-identical "product" mode plus the candidate "rich" mode),
// the Jev client, and DOM state reading for scoring. Ground truth (data-gt) is
// read for scoring only and is never sent to Jev.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const HERE = dirname(fileURLToPath(import.meta.url));
export const MODEL = 'jev-1.13.0'; // same pinned model as the product
export const MIN_CONFIDENCE = 0.7; // product default
const CHROME = join(homedir(), '.cache/ms-playwright/chromium-1248/chrome-linux64/chrome');

export function fixtureUrl(name, query = '') {
  return pathToFileURL(join(HERE, 'fixtures', name)).href + query;
}

export async function openBrowser() {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  return { browser, context };
}

// ---------------------------------------------------------------- extraction
// mode: 'viewport' = exactly what the product reads today (visible, unoccluded,
// in the viewport); 'full' = every rendered element on the page.
// context: 'product' = role/name/near-if-unnamed/region (product describeElement);
// 'rich' = adds the section heading, sub-heading/legend and row text always.
const EXTRACT = ({ mode }) => {
  const sel = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=radio],[role=combobox],[role=textbox],[role=searchbox],[role=switch],[role=option],[tabindex]:not([tabindex="-1"])';
  const W = innerWidth, H = innerHeight;
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim().slice(0, 100);
  const nameOf = (el) => {
    const lb = el.getAttribute('aria-labelledby');
    const byId = lb ? lb.split(/\s+/).map((id) => document.getElementById(id)?.innerText || '').join(' ') : '';
    const lab = el.labels && el.labels[0] ? el.labels[0].innerText : '';
    const text = el.isContentEditable || el.tagName === 'TEXTAREA' ? '' : el.innerText;
    const valueName = el.tagName === 'INPUT' && /^(submit|button|reset)$/i.test(el.type) ? el.value : '';
    return clean(el.getAttribute('aria-label') || byId || lab || text || el.getAttribute('placeholder') || el.getAttribute('title') || el.querySelector?.('img[alt]')?.alt || el.getAttribute('alt') || valueName || '');
  };
  const roleOf = (el) => el.getAttribute('role') || ({ A: 'link', BUTTON: 'button', SELECT: 'combobox', TEXTAREA: 'textbox', SUMMARY: 'button' }[el.tagName]) || (el.tagName === 'INPUT' ? ({ checkbox: 'checkbox', radio: 'radio', submit: 'button', button: 'button', search: 'searchbox' }[el.type] || 'textbox') : el.tagName.toLowerCase());
  const nearOf = (el) => { const row = el.closest('tr,li,label,p,fieldset'); return row ? clean(row.innerText).slice(0, 60) : ''; };
  // Row text: the nearest row-like container, else the parent if it is short (a
  // whole section's text as "row" made Jev less sure, measured on run 1).
  const rowOf = (el) => {
    const row = el.closest('tr,li,label,p,.row');
    if (row) return clean(row.innerText).slice(0, 80);
    const t = clean(el.parentElement?.innerText);
    return t.length <= 80 ? t : '';
  };
  const region = (el) => { const r = el.closest('nav,header,footer,aside,main,dialog,[role=navigation],[role=banner],[role=contentinfo],[role=search],[role=dialog],form,table'); return r ? (r.getAttribute('role') || r.tagName.toLowerCase()) : ''; };
  const sectionOf = (el) => {
    const s = el.closest('section,[role=region],dialog,[role=dialog]');
    if (!s) return { section: '', sub: '' };
    const h = s.querySelector('h1,h2');
    const legend = el.closest('fieldset')?.querySelector('legend')?.innerText;
    let sub = legend || el.closest('details')?.querySelector('summary')?.innerText || '';
    if (!sub) for (const h3 of s.querySelectorAll('h3')) if (h3.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) sub = h3.innerText;
    return { section: clean(h?.innerText), sub: clean(sub) };
  };
  const unique = (s) => { try { return document.querySelectorAll(s).length === 1; } catch { return false; } };
  const cssPath = (el) => {
    const parts = [];
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      if (n.id && unique('#' + CSS.escape(n.id))) { parts.unshift('#' + CSS.escape(n.id)); break; }
      const tag = n.tagName.toLowerCase();
      const parent = n.parentElement;
      if (!parent) { parts.unshift(tag); break; }
      const same = Array.from(parent.children).filter((c) => c.tagName === n.tagName);
      parts.unshift(same.length > 1 ? tag + ':nth-of-type(' + (same.indexOf(n) + 1) + ')' : tag);
    }
    return parts.join(' > ');
  };
  const out = []; const seen = new Set();
  for (const el of document.querySelectorAll(sel)) {
    if (seen.has(el) || out.length >= 2000) continue; seen.add(el);
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) continue;
    if (mode === 'viewport' && (r.bottom <= 0 || r.right <= 0 || r.top >= H || r.left >= W)) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) continue;
    if (mode === 'viewport') {
      const top = document.elementFromPoint(Math.min(W - 1, Math.max(0, r.left + r.width / 2)), Math.min(H - 1, Math.max(0, r.top + r.height / 2)));
      if (top && top !== el && !el.contains(top) && !top.contains(el)) continue;
    }
    const name = nameOf(el);
    const near = name ? '' : nearOf(el);
    out.push({ role: roleOf(el), name, near, region: region(el), href: el.getAttribute('href') || '', selector: cssPath(el), row: rowOf(el), ...sectionOf(el), rowText: clean(el.closest('tr')?.innerText).slice(0, 100), visible: el.checkVisibility ? el.checkVisibility({ contentVisibilityAuto: true, visibilityProperty: true }) : true, gt: el.getAttribute('data-gt') || '' });
  }
  return { title: document.title, url: location.pathname.split('/').pop(), elements: out };
};

export async function extract(page, mode) {
  return page.evaluate(EXTRACT, { mode });
}

export function describe(e, context) {
  if (context === 'product') {
    return `${e.role} "${e.name || '(no text)'}"${e.near ? ` near "${e.near}"` : ''}${e.region ? ` in ${e.region}` : ''}${e.href ? ` -> ${e.href}` : ''}`;
  }
  const row = e.row && e.row !== e.name ? ` row "${e.row}"` : '';
  const where = e.section ? ` in section "${e.section}"${e.sub ? ` > "${e.sub}"` : ''}` : (e.region ? ` in ${e.region}` : '');
  return `${e.role} "${e.name || '(no text)'}"${row}${where}${e.href ? ` -> ${e.href}` : ''}`;
}

// Scrolls through the page so lazily rendered sections exist, then returns to the top.
export async function sweep(page) {
  const h = await page.evaluate(() => document.documentElement.scrollHeight);
  for (let y = 0; y < h; y += 600) {
    await page.evaluate((v) => scrollTo(0, v), y);
    await page.waitForTimeout(60);
  }
  await page.evaluate(() => scrollTo(0, 0));
  await page.waitForTimeout(100);
}

// ---------------------------------------------------------------- Jev
const KEY = JSON.parse(readFileSync(join(homedir(), '.mybrowser/config.json'), 'utf8')).jev?.apiKey;
if (!KEY) throw new Error('No jev.apiKey in ~/.mybrowser/config.json');
export const calls = []; // { ms, questions, bytes, inputTokens }

export async function askJev(state, questions) {
  const body = JSON.stringify({ model: MODEL, state, questions });
  for (let attempt = 0; ; attempt++) {
    const t0 = Date.now();
    const res = await fetch('https://api.typesafe.ai/v1/systemone', {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    const ms = Date.now() - t0;
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      continue;
    }
    if (!res.ok) throw new Error(`JEV_HTTP_${res.status}: ${text.slice(0, 200)}`);
    const parsed = JSON.parse(text);
    calls.push({ ms, questions: Object.keys(questions).length, bytes: body.length, inputTokens: parsed.usage?.input_tokens ?? null });
    return { answers: parsed.answers, ms };
  }
}

// One Choice question per intent over a shared element list; batched.
export async function mapIntents(pageState, intents, { context, instructions, batch = 8 }) {
  const els = pageState.elements.slice(0, 254); // Choice allows 255 including "none"
  const criteria = Object.fromEntries(els.map((e, i) => [`e${i}`, describe(e, context)]));
  criteria.none = 'No element on the page matches';
  const state = { page: { title: pageState.title, url: pageState.url }, elements: Object.values(criteria).slice(0, -1) };
  const results = [];
  for (let i = 0; i < intents.length; i += batch) {
    const chunk = intents.slice(i, i + batch);
    const questions = Object.fromEntries(chunk.map((intent, j) => [`q${j}`, { type: 'choice', instructions: instructions(intent), criteria }]));
    const { answers, ms } = await askJev(state, questions);
    chunk.forEach((intent, j) => {
      const a = answers[`q${j}`];
      const el = a && a.choice !== 'none' ? els[Number(a.choice.slice(1))] : undefined;
      results.push({ intent, element: el, confidence: a?.confidence ?? 0, choice: a?.choice, ms, batchSize: chunk.length });
    });
  }
  return { results, optionCount: els.length, truncated: pageState.elements.length > els.length };
}

// ---------------------------------------------------------------- DOM state
export async function readState(page, selector) {
  return page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return { missing: true };
    if (el.getAttribute('role') === 'switch') return { on: el.getAttribute('aria-checked') === 'true' };
    if (el.type === 'checkbox' || el.type === 'radio') return el.indeterminate ? { mixed: true } : { on: el.checked };
    if (el.tagName === 'SELECT') return { value: el.selectedOptions[0]?.textContent.trim() ?? '', options: [...el.options].map((o) => o.textContent.trim()) };
    return { value: el.value };
  }, selector);
}

export function matches(state, expect) {
  if (state.missing) return false;
  if (expect === 'on') return state.on === true;
  if (expect === 'off') return state.on === false;
  const norm = (s) => String(s ?? '').trim().toLowerCase();
  return norm(state.value) === norm(expect);
}

export const gtSelector = (gt) => `[data-gt="${gt}"]`;
export const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : 'n/a');
export const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
