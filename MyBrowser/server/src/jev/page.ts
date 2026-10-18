import type { Context } from "../context.js";

export interface PageElement {
  role: string;
  name: string;
  region: string;
  href: string;
  selector: string;
  /** Row/container text for unnamed elements, e.g. an unlabeled input's "username:" cell. */
  near?: string;
}

export interface PageState {
  url: string;
  title: string;
  text?: string;
  elements: PageElement[];
}

// In-page helpers shared by the page read and the pre-action verify, so both
// compute an element's role and name identically. Plain JS, evaluated in the tab.
//
// Privacy: an element's name never falls back to a field's value except for
// button-like inputs (an unlabeled password box would otherwise send the
// password), editable text is never used as a name, and URLs keep only their
// path and query keys, with long opaque path segments (magic-link tokens) masked.
export const SAFE_HREF_JS = `(href, base) => {
  if (!href) return '';
  let u; try { u = new URL(href, base); } catch { return ''; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
  let sameOrigin = false; try { sameOrigin = u.origin === new URL(base).origin; } catch {}
  const path = u.pathname.split('/').map((s) => (s.length >= 20 && /^[A-Za-z0-9_.~%-]+$/.test(s) && /[0-9]/.test(s) ? '…' : s)).join('/');
  const keys = Array.from(new Set(Array.from(u.searchParams.keys()))).slice(0, 8);
  return ((sameOrigin ? '' : u.host) + path + (keys.length ? '?' + keys.map((k) => k + '=…').join('&') : '')).slice(0, 120);
}`;

export const VALUE_NAME_JS = `(el) => (el.tagName === 'INPUT' && /^(submit|button|reset)$/i.test(el.type) ? el.value : '')`;

const HELPERS_JS = `
  const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim().slice(0, 100);
  const safeHref = ${SAFE_HREF_JS};
  const safeUrl = (href) => safeHref(href, 'https://invalid.invalid/');
  const valueName = ${VALUE_NAME_JS};
  const nameOf = (el) => {
    const lb = el.getAttribute('aria-labelledby');
    const byId = lb ? lb.split(/\\s+/).map((id) => document.getElementById(id)?.innerText || '').join(' ') : '';
    const lab = el.labels && el.labels[0] ? el.labels[0].innerText : '';
    const text = el.isContentEditable || el.tagName === 'TEXTAREA' ? '' : el.innerText;
    return clean(el.getAttribute('aria-label') || byId || lab || text || el.getAttribute('placeholder') || el.getAttribute('title') || el.querySelector?.('img[alt]')?.alt || el.getAttribute('alt') || valueName(el) || '');
  };
  const roleOf = (el) => el.getAttribute('role') || ({A:'link',BUTTON:'button',SELECT:'combobox',TEXTAREA:'textbox',SUMMARY:'button'}[el.tagName]) || (el.tagName === 'INPUT' ? ({checkbox:'checkbox',radio:'radio',submit:'button',button:'button',search:'searchbox'}[el.type] || 'textbox') : el.tagName.toLowerCase());
  const nearOf = (el) => { const row = el.closest('tr,li,label,p,fieldset'); return row ? clean(row.innerText).slice(0, 60) : ''; };
`;

// Read-only in-page extraction of the visible, unoccluded interactive elements
// (the exact shape the Oct 2026 measurement run scored). Runs through
// browser_eval instead of browser_snapshot so it never moves the agent's
// ARIA diff baseline. Each element carries a CSS path the resolver can target.
function pageStateScript(includeText: boolean): string {
  return `(() => {
  const sel = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=radio],[role=combobox],[role=textbox],[role=searchbox],[role=switch],[role=option],[tabindex]:not([tabindex="-1"])';
  const W = innerWidth, H = innerHeight;
  ${HELPERS_JS}
  const region = (el) => { const r = el.closest('nav,header,footer,aside,main,dialog,[role=navigation],[role=banner],[role=contentinfo],[role=search],[role=dialog],form,table'); return r ? (r.getAttribute('role') || r.tagName.toLowerCase()) : ''; };
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
    if (seen.has(el) || out.length >= 400) continue; seen.add(el);
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4 || r.bottom <= 0 || r.right <= 0 || r.top >= H || r.left >= W) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) continue;
    const top = document.elementFromPoint(Math.min(W - 1, Math.max(0, r.left + r.width / 2)), Math.min(H - 1, Math.max(0, r.top + r.height / 2)));
    if (top && top !== el && !el.contains(top) && !top.contains(el)) continue;
    const name = nameOf(el);
    const near = name ? '' : nearOf(el);
    out.push({ role: roleOf(el), name, region: region(el), href: safeHref(el.getAttribute('href') || '', location.href), selector: cssPath(el), ...(near ? { near } : {}) });
  }
  return { url: safeUrl(location.href), title: document.title, ${includeText ? "text: (document.body?.innerText || '').slice(0, 12000), " : ""}elements: out };
})()`;
}

// Re-checks, right before acting, that the selector still points at the element
// Jev chose: the page read happened up to timeoutMs earlier and the selector is
// positional, so a re-render could otherwise redirect the action.
export const VERIFY_MARKER = "/* jev-verify */";

function verifyScript(expectedUrl: string, element: PageElement): string {
  const json = JSON.stringify;
  return `${VERIFY_MARKER}(() => {
  ${HELPERS_JS}
  if (safeUrl(location.href) !== ${json(expectedUrl)}) return { ok: false, reason: 'the page URL changed' };
  let els; try { els = document.querySelectorAll(${json(element.selector)}); } catch { return { ok: false, reason: 'the selector is invalid' }; }
  if (els.length !== 1) return { ok: false, reason: 'the selector now matches ' + els.length + ' elements' };
  const el = els[0];
  if (roleOf(el) !== ${json(element.role)} || nameOf(el) !== ${json(element.name)}${element.near ? ` || nearOf(el) !== ${json(element.near)}` : ""}) return { ok: false, reason: 'a different element is now at that position' };
  const r = el.getBoundingClientRect();
  if (r.width < 4 || r.height < 4) return { ok: false, reason: 'the element is no longer visible' };
  return { ok: true };
})()`;
}

function evalPayload(code: string, tabId: number | undefined, timeoutMs: number): Record<string, unknown> {
  const payload: Record<string, unknown> = { code, timeout: timeoutMs };
  if (tabId !== undefined) payload.tabId = tabId;
  return payload;
}

export async function readPageState(
  context: Context,
  tabId: number | undefined,
  options: { includeText?: boolean; timeoutMs?: number } = {},
): Promise<PageState> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const result = await context.sendSocketMessage(
    "browser_eval", evalPayload(pageStateScript(options.includeText === true), tabId, timeoutMs), { timeoutMs },
  ) as { value?: unknown } | undefined;
  const value = result?.value as Partial<PageState> | undefined;
  if (!value || !Array.isArray(value.elements)) throw new Error("JEV_PAGE_STATE_UNAVAILABLE");
  return {
    url: String(value.url ?? ""),
    title: String(value.title ?? ""),
    ...(typeof value.text === "string" ? { text: value.text } : {}),
    elements: value.elements as PageElement[],
  };
}

export async function verifyElement(
  context: Context,
  tabId: number | undefined,
  expectedUrl: string,
  element: PageElement,
  timeoutMs: number,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const result = await context.sendSocketMessage(
    "browser_eval", evalPayload(verifyScript(expectedUrl, element), tabId, timeoutMs), { timeoutMs },
  ) as { value?: { ok?: unknown; reason?: unknown } } | undefined;
  if (result?.value?.ok === true) return { ok: true };
  return { ok: false, reason: typeof result?.value?.reason === "string" ? result.value.reason : "the element could not be re-checked" };
}

export function describeElement(e: PageElement): string {
  return `${e.role} "${e.name || "(no text)"}"${e.near ? ` near "${e.near}"` : ""}${e.region ? ` in ${e.region}` : ""}${e.href ? ` -> ${e.href}` : ""}`;
}
