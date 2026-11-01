import type { Context } from "../context.js";

// Page Model v2: one read of every interactive element on the page, not just
// the visible part, with the section, sub-section and row text a person uses to
// tell look-alike controls apart (Nov 1 2026 experiments: 72/82 -> 80/82 picks
// with that context, 0 wrong). Runs through browser_eval, so it needs no
// extension change and never moves the agent's ARIA diff baseline.
//
// Each element gets a stable number: the page keeps a `data-mbo` attribute on
// it, and a re-rendered element with the same role, name, section and row gets
// its old number back. Tools accept the number as `ref: "o12"`.

export interface ModelElement {
  n: number;
  role: string;
  name: string;
  section: string;
  sub: string;
  row: string;
  /** Read locally; shown to the agent, never sent to a decision model. */
  state: string;
  /** "", "below", "above", "collapsed" (inside a closed <details>), "hidden-input" (clicked through its label). */
  where: string;
  disabled: boolean;
  /** Option labels for native selects (capped). */
  options?: string[];
  selector: string;
}

export interface PageModel {
  /** location.host, for site memory. */
  host: string;
  url: string;
  title: string;
  elements: ModelElement[];
  /** More elements existed than were read. */
  truncated: boolean;
  frames: { sameOrigin: number; crossOrigin: number };
}

export interface ReadOptions {
  /** Scroll the page (and its main scroll container) once so lazily rendered sections exist, then scroll back. */
  sweep?: boolean;
  max?: number;
  timeoutMs?: number;
}

// The in-page reader. Serialized with toString(), so it must not reference
// anything outside its own body.
/* c8 ignore start */
async function pageModelScript(opts: { sweep: boolean; max: number }) {
  const clean = (s: unknown, n = 100) => String(s ?? "").replace(/[\u200b-\u200d\ufeff]/g, "").replace(/\s+/g, " ").trim().slice(0, n);
  const SAFE = (href: string) => {
    if (!href) return "";
    let u: URL;
    try { u = new URL(href, location.href); } catch { return ""; }
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    const path = u.pathname.split("/").map((s) => (s.length >= 20 && /^[A-Za-z0-9_.~%-]+$/.test(s) && /[0-9]/.test(s) ? "…" : s)).join("/");
    const keys = Array.from(new Set(Array.from(u.searchParams.keys()))).slice(0, 8);
    return ((u.origin === location.origin ? "" : u.host) + path + (keys.length ? "?" + keys.map((k) => k + "=…").join("&") : "")).slice(0, 120);
  };

  if (opts.sweep) {
    const scrollers: Array<Element | Window> = [window];
    let best: Element | null = null;
    for (const el of Array.from(document.querySelectorAll("body *"))) {
      if (el.scrollHeight > el.clientHeight + 200 && el.clientHeight > 200) {
        const oy = getComputedStyle(el).overflowY;
        if ((oy === "auto" || oy === "scroll") && (!best || el.clientHeight * el.clientWidth > best.clientHeight * best.clientWidth)) best = el;
      }
    }
    if (best) scrollers.push(best);
    for (const s of scrollers) {
      const isWin = s === window;
      const box = isWin ? document.scrollingElement || document.documentElement : (s as Element);
      const start = box.scrollTop;
      const step = Math.max(300, (isWin ? innerHeight : (s as Element).clientHeight) * 0.8);
      for (let y = 0; y < box.scrollHeight && y < 40_000; y += step) {
        box.scrollTop = y;
        await new Promise((r) => setTimeout(r, 70));
      }
      box.scrollTop = start;
    }
    await new Promise((r) => setTimeout(r, 120));
  }

  const INTERACTIVE = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[contenteditable=""],[contenteditable=true],[role=button],[role=link],[role=tab],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=checkbox],[role=radio],[role=combobox],[role=textbox],[role=searchbox],[role=switch],[role=slider],[role=spinbutton],[role=option],[tabindex]:not([tabindex="-1"])';
  const roleOf = (el: Element): string => {
    const r = el.getAttribute("role");
    if (r) return r.split(/\s+/)[0]!;
    const t = el.tagName;
    if (t === "A") return "link";
    if (t === "BUTTON" || t === "SUMMARY") return "button";
    if (t === "SELECT") return "combobox";
    if (t === "TEXTAREA") return "textbox";
    if ((el as HTMLElement).isContentEditable) return "textbox";
    if (t === "INPUT") {
      const ty = (el as HTMLInputElement).type;
      return ({ checkbox: "checkbox", radio: "radio", submit: "button", button: "button", reset: "button", image: "button", search: "searchbox", range: "slider", number: "spinbutton", file: "button" } as Record<string, string>)[ty] || "textbox";
    }
    return t.toLowerCase();
  };
  const root = (el: Element) => el.getRootNode() as Document | ShadowRoot;
  const byIds = (el: Element, attr: string) => {
    const ids = el.getAttribute(attr);
    if (!ids) return "";
    const r = root(el);
    return ids.split(/\s+/).map((id) => (r.getElementById ? r.getElementById(id) : document.getElementById(id))?.textContent || "").join(" ");
  };
  const isButtonInput = (el: Element) => el.tagName === "INPUT" && /^(submit|button|reset)$/i.test((el as HTMLInputElement).type);
  // Privacy: a field's value is never used as its name (an unlabeled password box
  // would otherwise leak), and editable text is never read as a name.
  const nameOf = (el: Element): string => {
    const html = el as HTMLElement;
    const labels = (el as HTMLInputElement).labels;
    const lab = labels && labels[0] ? labels[0].innerText : "";
    const editable = html.isContentEditable || el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && !isButtonInput(el));
    const text = editable || el.tagName === "SELECT" ? "" : html.innerText;
    return clean(
      el.getAttribute("aria-label") || byIds(el, "aria-labelledby") || lab || text || el.getAttribute("placeholder")
      || el.getAttribute("title") || el.querySelector?.("img[alt]")?.getAttribute("alt") || el.getAttribute("alt")
      || (isButtonInput(el) ? (el as HTMLInputElement).value : "") || "",
    );
  };
  const stateOf = (el: Element): string => {
    const aria = (a: string) => el.getAttribute(a);
    const html = el as HTMLInputElement;
    if (el.tagName === "INPUT" && (html.type === "checkbox" || html.type === "radio")) return html.indeterminate ? "mixed" : html.checked ? "on" : "off";
    if (aria("aria-checked") !== null) return aria("aria-checked") === "mixed" ? "mixed" : aria("aria-checked") === "true" ? "on" : "off";
    if (aria("aria-pressed") !== null) return aria("aria-pressed") === "true" ? "on" : "off";
    if (el.tagName === "SELECT") {
      const s = el as HTMLSelectElement;
      return clean(Array.from(s.selectedOptions).map((o) => o.textContent).join(", "), 60);
    }
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
      if (html.type === "password") return html.value ? `(${html.value.length} characters hidden)` : "(empty)";
      if (html.type === "file") return html.files && html.files.length ? `${html.files.length} file(s)` : "";
      return html.value ? `"${clean(html.value, 60)}"` : "(empty)";
    }
    if ((el as HTMLElement).isContentEditable) return (el as HTMLElement).innerText.trim() ? `(${(el as HTMLElement).innerText.trim().length} characters)` : "(empty)";
    if (aria("aria-valuenow") !== null) return clean(aria("aria-valuetext") || aria("aria-valuenow"), 40);
    const role = aria("role");
    if (role === "combobox") return clean((el as HTMLElement).innerText || el.getAttribute("value"), 60);
    if (el.tagName === "SUMMARY") return el.parentElement?.hasAttribute("open") ? "expanded" : "collapsed";
    if (aria("aria-selected") === "true") return "selected";
    if (aria("aria-expanded") !== null) return aria("aria-expanded") === "true" ? "expanded" : "collapsed";
    return "";
  };
  const rowOf = (el: Element): string => {
    const row = el.closest('tr,li,label,[role=row],[role=listitem],[role=option],p');
    if (row && row !== el) return clean((row as HTMLElement).innerText, 80);
    // Div-built tables and lists (Meta Ads Manager): the nearest ancestor with
    // text besides the control's own, if it is still row-sized.
    const own = clean((el as HTMLElement).innerText, 200);
    let node = el.parentElement;
    // Meta nests a row's switch 10 levels below the row's first text.
    for (let depth = 0; node && depth < 14; depth++, node = node.parentElement) {
      const text = clean(node.innerText, 400);
      if (text && text !== own) return text.length <= 300 ? text.slice(0, 80) : "";
    }
    return "";
  };
  const headingLevel = (el: Element): number => {
    const m = /^H([1-6])$/.exec(el.tagName);
    if (m) return Number(m[1]);
    if (el.getAttribute("role") === "heading") return Number(el.getAttribute("aria-level")) || 2;
    return 0;
  };

  // Walk the DOM (and open shadow roots) once in document order, tracking the
  // latest headings so every control knows its section and sub-section.
  const found: Array<{ el: Element; section: string; sub: string; hosts: string[] }> = [];
  let section = "";
  let sub = "";
  let hostSeq = 0;
  let sameOrigin = 0;
  let crossOrigin = 0;
  const visit = (node: Element, hosts: string[]) => {
    // Column headers are headings to a screen reader but not sections: tracking
    // them filed every table row under the last column's title (Meta Ads Manager).
    const level = node.closest("th,thead,[role=columnheader],[role=rowheader],[role=tab]") ? 0 : headingLevel(node);
    if (level) {
      const text = clean((node as HTMLElement).innerText || node.textContent, 80);
      if (text) {
        if (level <= 2) { section = text; sub = ""; } else sub = text;
      }
    } else if (node.tagName === "LEGEND" || node.tagName === "SUMMARY") {
      const text = clean((node as HTMLElement).innerText || node.textContent, 80);
      if (text) sub = text;
    }
    if (node.tagName === "IFRAME") {
      try { if ((node as HTMLIFrameElement).contentDocument) sameOrigin += 1; else crossOrigin += 1; } catch { crossOrigin += 1; }
    }
    if (node.matches(INTERACTIVE)) {
      const dialog = node.closest('dialog,[role=dialog],[role=alertdialog]');
      const dialogName = dialog ? clean(dialog.getAttribute("aria-label") || byIds(dialog, "aria-labelledby") || dialog.querySelector("h1,h2,h3,[role=heading]")?.textContent, 80) : "";
      found.push({ el: node, section: dialogName ? `dialog: ${dialogName}` : section, sub: dialogName ? "" : sub, hosts });
    }
    const shadow = (node as HTMLElement).shadowRoot;
    if (shadow) {
      let hid = node.getAttribute("data-mboh");
      if (!hid) { hid = String(++hostSeq) + "-" + Math.random().toString(36).slice(2, 6); node.setAttribute("data-mboh", hid); }
      const inner = [...hosts, `[data-mboh="${hid}"]`];
      for (const child of Array.from(shadow.children)) visit(child, inner);
    }
    for (const child of Array.from(node.children)) visit(child, hosts);
  };
  if (document.body) visit(document.body, []);

  // Stable numbers across reads of the same document.
  const w = window as unknown as { __mbo?: { next: number; byFp: Record<string, number> } };
  const reg = (w.__mbo ||= { next: 1, byFp: {} });
  const W = innerWidth;
  const H = innerHeight;
  const out: Array<Record<string, unknown>> = [];
  const used = new Set<number>();
  const fpSeen: Record<string, number> = {};
  let truncated = false;
  for (const { el, section: sec, sub: sb, hosts } of found) {
    if (out.length >= opts.max) { truncated = true; break; }
    const html = el as HTMLElement;
    let target: Element = el;
    let where = "";
    const cs = getComputedStyle(el);
    let r = el.getBoundingClientRect();
    const collapsed = !!el.closest("details:not([open])") && el.tagName !== "SUMMARY" && !el.closest("details:not([open]) > summary");
    const tiny = r.width < 4 || r.height < 4 || Number(cs.opacity) === 0;
    if (tiny && !collapsed) {
      // A visually hidden checkbox or radio behind a styled label is clicked through the label.
      const lab = (el as HTMLInputElement).labels?.[0];
      if (lab && (el.tagName === "INPUT")) {
        const lr = lab.getBoundingClientRect();
        if (lr.width >= 4 && lr.height >= 4) { target = lab; r = lr; where = "hidden-input"; } else continue;
      } else continue;
    }
    if (!collapsed && (cs.visibility === "hidden" || cs.display === "none" || el.closest('[aria-hidden="true"],[inert]'))) continue;
    if (collapsed) where = "collapsed";
    else if (!where) where = r.bottom <= 0 ? "above" : r.top >= H ? "below" : r.right <= 0 || r.left >= W ? "off-side" : "";
    const role = roleOf(el);
    const name = nameOf(el) || (role === "link" ? SAFE(el.getAttribute("href") || "") : "");
    const row = rowOf(el);
    const base = [role, name, sec, sb, row === name ? "" : row].join("|");
    fpSeen[base] = (fpSeen[base] ?? 0) + 1;
    const fp = base + "#" + fpSeen[base];
    let n = Number(target.getAttribute("data-mbo")) || 0;
    if (!n || used.has(n)) {
      const prior = reg.byFp[fp];
      n = prior && !used.has(prior) && !document.querySelector(`[data-mbo="${prior}"]`) ? prior : reg.next++;
      target.setAttribute("data-mbo", String(n));
    }
    used.add(n);
    reg.byFp[fp] = n;
    const options = el.tagName === "SELECT" ? Array.from((el as HTMLSelectElement).options).slice(0, 40).map((o) => clean(o.textContent, 60)) : undefined;
    out.push({
      n, role, name, section: sec, sub: sb, row: row === name ? "" : row, state: stateOf(el), where,
      disabled: html.matches(":disabled") || el.getAttribute("aria-disabled") === "true",
      ...(options ? { options } : {}),
      selector: [...hosts, `[data-mbo="${n}"]`].join(" >>> "),
    });
  }
  return { host: location.host, url: SAFE(location.href), title: document.title, elements: out, truncated, frames: { sameOrigin, crossOrigin } };
}
/* c8 ignore stop */

export const PAGE_MODEL_MARKER = "/* mb-page-model */";

export function pageModelCode(options: ReadOptions = {}): string {
  const args = JSON.stringify({ sweep: options.sweep === true, max: options.max ?? 1500 });
  return `${PAGE_MODEL_MARKER}(${pageModelScript.toString()})(${args})`;
}

export async function readPageModel(context: Context, tabId: number | undefined, options: ReadOptions = {}): Promise<PageModel> {
  const timeoutMs = options.timeoutMs ?? (options.sweep ? 30_000 : 10_000);
  const payload: Record<string, unknown> = { code: pageModelCode(options), timeout: timeoutMs };
  if (tabId !== undefined) payload.tabId = tabId;
  const result = await context.sendSocketMessage("browser_eval", payload, { timeoutMs: timeoutMs + 2_000 }) as { value?: unknown; error?: unknown } | undefined;
  const value = result?.value as Partial<PageModel> | undefined;
  if (!value || !Array.isArray(value.elements)) {
    throw new Error(`PAGE_MODEL_UNAVAILABLE${typeof result?.error === "string" ? `: ${result.error}` : ""}`);
  }
  return {
    host: String(value.host ?? ""),
    url: String(value.url ?? ""),
    title: String(value.title ?? ""),
    elements: value.elements as ModelElement[],
    truncated: value.truncated === true,
    frames: value.frames ?? { sameOrigin: 0, crossOrigin: 0 },
  };
}

/** Text a decision model sees for one element: role, name and context, never the state or value. */
export function describeForDecider(e: ModelElement): string {
  const row = e.row && e.row !== e.name ? ` row "${e.row}"` : "";
  const where = e.section ? ` in section "${e.section}"${e.sub ? ` > "${e.sub}"` : ""}` : e.sub ? ` under "${e.sub}"` : "";
  return `${e.role} "${e.name || "(no text)"}"${row}${where}`;
}

/** `o12` -> the element's selector, or undefined when the ref is not an outline number. */
export function outlineRefNumber(ref: string | undefined): number | undefined {
  const m = ref ? /^o(\d+)$/.exec(ref.trim()) : null;
  return m ? Number(m[1]) : undefined;
}
