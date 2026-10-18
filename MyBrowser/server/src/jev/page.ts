import type { Context } from "../context.js";

export interface PageElement {
  role: string;
  name: string;
  region: string;
  href: string;
  selector: string;
}

export interface PageState {
  url: string;
  title: string;
  text?: string;
  elements: PageElement[];
}

// Read-only in-page extraction of the visible, unoccluded interactive elements
// (the exact shape the Oct 2026 measurement run scored). Runs through
// browser_eval instead of browser_snapshot so it never moves the agent's
// ARIA diff baseline. Each element carries a CSS path the resolver can target.
function pageStateScript(includeText: boolean): string {
  return `(() => {
  const sel = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=radio],[role=combobox],[role=textbox],[role=searchbox],[role=switch],[role=option],[tabindex]:not([tabindex="-1"])';
  const W = innerWidth, H = innerHeight;
  const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim().slice(0, 100);
  const nameOf = (el) => {
    const lb = el.getAttribute('aria-labelledby');
    const byId = lb ? lb.split(/\\s+/).map((id) => document.getElementById(id)?.innerText || '').join(' ') : '';
    const lab = el.labels && el.labels[0] ? el.labels[0].innerText : '';
    return clean(el.getAttribute('aria-label') || byId || lab || el.innerText || el.getAttribute('placeholder') || el.getAttribute('title') || el.querySelector?.('img[alt]')?.alt || el.getAttribute('alt') || el.value || '');
  };
  const roleOf = (el) => el.getAttribute('role') || ({A:'link',BUTTON:'button',SELECT:'combobox',TEXTAREA:'textbox',SUMMARY:'button'}[el.tagName]) || (el.tagName === 'INPUT' ? ({checkbox:'checkbox',radio:'radio',submit:'button',button:'button',search:'searchbox'}[el.type] || 'textbox') : el.tagName.toLowerCase());
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
    const href = el.getAttribute('href') || '';
    out.push({ role: roleOf(el), name: nameOf(el), region: region(el), href: href.startsWith('javascript') ? '' : href.slice(0, 120), selector: cssPath(el) });
  }
  return { url: location.href, title: document.title, ${includeText ? "text: (document.body?.innerText || '').slice(0, 12000), " : ""}elements: out };
})()`;
}

export async function readPageState(
  context: Context,
  tabId: number | undefined,
  options: { includeText?: boolean } = {},
): Promise<PageState> {
  const payload: Record<string, unknown> = { code: pageStateScript(options.includeText === true), timeout: 10_000 };
  if (tabId !== undefined) payload.tabId = tabId;
  const result = await context.sendSocketMessage("browser_eval", payload) as { value?: unknown } | undefined;
  const value = result?.value as Partial<PageState> | undefined;
  if (!value || !Array.isArray(value.elements)) throw new Error("JEV_PAGE_STATE_UNAVAILABLE");
  return {
    url: String(value.url ?? ""),
    title: String(value.title ?? ""),
    ...(typeof value.text === "string" ? { text: value.text } : {}),
    elements: value.elements as PageElement[],
  };
}

export function describeElement(e: PageElement): string {
  return `${e.role} "${e.name || "(no text)"}"${e.region ? ` in ${e.region}` : ""}${e.href ? ` -> ${e.href}` : ""}`;
}
