// browser_fill_form v2: set many controls from one list. Each item is found
// with Resolver v2 and set with code through the existing actions (click,
// type) or, for native selects, by option label in the page. Buttons and links
// are never clicked here, so a fill can't submit, pay, delete or publish.
// Values are typed only from what the caller passed and never sent to a
// decision model; only option labels are, when an option has to be picked
// by meaning ("landing page views" -> "Maximise number of landing page views").

import type { Context } from "../context.js";
import { compareSetting, handBack, isToggle, learn, pickOption, readModel, resolveOnPage, wantBool } from "./engine.js";
import { outlineRefNumber, type ModelElement, type PageModel } from "./model.js";
import type { ItemResolution } from "./resolve.js";

export interface FillItem { target: string; value: string }

export interface FillResult {
  target: string;
  status: "done" | "already_set" | "mismatch" | "not_found" | "needs_choice" | "blocked" | "error";
  detail: string;
}

const NEVER_CLICK = new Set(["button", "link", "menuitem", "tab"]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function withTab(tabId: number | undefined, payload: Record<string, unknown>): Record<string, unknown> {
  return tabId !== undefined ? { ...payload, tabId } : payload;
}

/** Selects a native <select> option by its label, in the page (the extension's select matches values only). */
async function selectByLabel(context: Context, tabId: number | undefined, selector: string, label: string): Promise<void> {
  const code = `(() => {
    const parts = ${JSON.stringify(selector)}.split(' >>> ');
    let root = document, el = null;
    for (const [i, p] of parts.entries()) { el = root.querySelector(p); if (!el) break; if (i < parts.length - 1) root = el.shadowRoot; if (!root) { el = null; break; } }
    if (!(el instanceof HTMLSelectElement)) return { ok: false, reason: 'not a select' };
    const want = ${JSON.stringify(label)}.replace(/\\s+/g, ' ').trim();
    const opt = Array.from(el.options).find((o) => (o.textContent || '').replace(/\\s+/g, ' ').trim() === want);
    if (!opt) return { ok: false, reason: 'option not found' };
    el.value = opt.value; opt.selected = true;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true };
  })()`;
  const res = await context.sendSocketMessage("browser_eval", withTab(tabId, { code, timeout: 5000 }), { timeoutMs: 7000 }) as { value?: { ok?: boolean; reason?: string } } | undefined;
  if (res?.value?.ok !== true) throw new Error(`could not select "${label}": ${res?.value?.reason ?? "unknown"}`);
}

const click = (context: Context, tabId: number | undefined, e: ModelElement, element: string) =>
  context.sendSocketMessage("browser_click", withTab(tabId, { element, selector: e.selector }));

/** Custom (non-native) dropdowns: open, read the options that appeared, pick one, click it. */
async function setCustomCombobox(context: Context, tabId: number | undefined, e: ModelElement, value: string): Promise<{ picked?: string; detail: string; candidates?: string[] }> {
  await click(context, tabId, e, `open ${e.name || "dropdown"}`);
  await sleep(400);
  let model = await readModel(context, tabId);
  let options = model.elements.filter((x) => (x.role === "option" || x.role === "menuitemradio" || x.role === "menuitem") && x.where !== "collapsed");
  const editable = e.state === "(empty)" || e.state.startsWith("\"");
  if (options.length === 0 && editable) {
    // Search-as-you-type: type the value, then look for options again.
    await context.sendSocketMessage("browser_type", withTab(tabId, { element: e.name || "search", selector: e.selector, text: value, submit: false }));
    await sleep(700);
    model = await readModel(context, tabId);
    options = model.elements.filter((x) => x.role === "option" || x.role === "menuitemradio" || x.role === "menuitem");
    // A plain text field marked as a combobox: the typed value is the answer.
    if (options.length === 0) return { picked: value, detail: "typed (no options appeared)" };
  }
  if (options.length === 0) {
    await context.sendSocketMessage("browser_press_key", withTab(tabId, { key: "Escape" })).catch(() => undefined);
    return { detail: "the dropdown showed no options" };
  }
  const pick = await pickOption(context, options.map((o) => o.name), value);
  const chosen = pick.option !== undefined ? options.find((o) => o.name === pick.option) : undefined;
  if (!chosen) {
    await context.sendSocketMessage("browser_press_key", withTab(tabId, { key: "Escape" })).catch(() => undefined);
    return { detail: `no option clearly matches (${pick.how})`, candidates: pick.candidates };
  }
  await click(context, tabId, chosen, `option ${chosen.name}`);
  return { picked: chosen.name, detail: `picked "${chosen.name}" (${pick.how})` };
}

export async function fillItems(context: Context, tabId: number | undefined, items: FillItem[], dryRun: boolean): Promise<{ results: FillResult[]; sideEffects: string[] }> {
  const before = await readModel(context, tabId);
  const direct = items.map((i) => outlineRefNumber(i.target));
  const pending = items.filter((_, i) => direct[i] === undefined).map((i) => ({ target: i.target }));
  const resolved = pending.length ? await resolveOnPage(context, before, pending) : [];
  let k = 0;
  const resolutions: ItemResolution[] = items.map((_, i) => {
    const n = direct[i];
    if (n === undefined) return resolved[k++]!;
    const e = before.elements.find((x) => x.n === n);
    return e ? { status: "resolved", element: e, via: "code", confidence: 1 } : { status: "not_found", reason: `o${n} is not on the page` };
  });

  const results: FillResult[] = [];
  const touched = new Map<number, { item: FillItem; expected: string; index: number }>();
  for (const [index, item] of items.entries()) {
    let r = resolutions[index]!;
    // "Gender: Women": the target names a radio group and the value names the option.
    const groupOf = (e: ModelElement) => before.elements.filter((x) => x.role === "radio" && x.section === e.section && x.sub === e.sub);
    const seed = r.status === "resolved" ? r.element : r.status === "needs_choice" && r.candidates[0]?.role === "radio" ? r.candidates[0] : undefined;
    if (seed?.role === "radio" && wantBool(item.value) === undefined) {
      const group = groupOf(seed);
      const pick = await pickOption(context, group.map((g) => g.name), item.value);
      const chosen = group.find((g) => g.name === pick.option);
      if (!chosen) { results.push({ target: item.target, status: "needs_choice", detail: `radio group: ${pick.how}; options: ${group.map((g) => `o${g.n} "${g.name}"`).join(" | ")}` }); continue; }
      r = { status: "resolved", element: chosen, via: r.status === "resolved" ? r.via : "code", confidence: 1 };
      item.value = "on";
    }
    if (r.status === "not_found") { results.push({ target: item.target, status: "not_found", detail: r.reason }); continue; }
    if (r.status === "needs_choice") { results.push({ target: item.target, status: "needs_choice", detail: handBack(r) }); continue; }
    const e = r.element;
    const found = `o${e.n} ${e.role} "${e.name}"${r.via === "decider" ? ` (decision model, ${r.confidence.toFixed(2)})` : ""}`;
    if (NEVER_CLICK.has(e.role)) { results.push({ target: item.target, status: "blocked", detail: `${found} is not a field; fill never clicks buttons or links` }); continue; }
    if (e.disabled) { results.push({ target: item.target, status: "blocked", detail: `${found} is disabled` }); continue; }
    if (e.where === "collapsed") { results.push({ target: item.target, status: "blocked", detail: `${found} is inside a collapsed section; expand it first` }); continue; }
    try {
      if (isToggle(e)) {
        const want = wantBool(item.value);
        if (want === undefined) { results.push({ target: item.target, status: "error", detail: `${found} is a ${e.role}; use on or off` }); continue; }
        if (e.state === (want ? "on" : "off")) { results.push({ target: item.target, status: "already_set", detail: `${found} is already ${e.state}` }); continue; }
        if (e.role === "radio" && !want) { results.push({ target: item.target, status: "error", detail: `${found}: a radio is turned off by choosing another option` }); continue; }
        if (!dryRun) await click(context, tabId, e, item.target);
        touched.set(e.n, { item, expected: want ? "on" : "off", index: results.length });
        results.push({ target: item.target, status: "done", detail: `${dryRun ? "would set" : "set"} ${found} ${want ? "on" : "off"}` });
      } else if (e.options) {
        const pick = await pickOption(context, e.options, item.value);
        if (pick.option === undefined) { results.push({ target: item.target, status: "needs_choice", detail: `${found}: ${pick.how}; options: ${pick.candidates?.join(" | ")}` }); continue; }
        if (compareSetting(e, pick.option).pass) { results.push({ target: item.target, status: "already_set", detail: `${found} is already "${pick.option}"` }); continue; }
        if (!dryRun) await selectByLabel(context, tabId, e.selector, pick.option);
        touched.set(e.n, { item, expected: pick.option, index: results.length });
        results.push({ target: item.target, status: "done", detail: `${dryRun ? "would select" : "selected"} "${pick.option}" in ${found} (${pick.how})` });
      } else if (e.role === "combobox") {
        if (compareSetting(e, item.value, "contains").pass) { results.push({ target: item.target, status: "already_set", detail: `${found} already shows "${e.state}"` }); continue; }
        if (dryRun) { results.push({ target: item.target, status: "done", detail: `would open ${found} and pick "${item.value}"` }); continue; }
        const set = await setCustomCombobox(context, tabId, e, item.value);
        if (!set.picked) { results.push({ target: item.target, status: "needs_choice", detail: `${found}: ${set.detail}${set.candidates ? `; options: ${set.candidates.join(" | ")}` : ""}` }); continue; }
        touched.set(e.n, { item, expected: set.picked, index: results.length });
        results.push({ target: item.target, status: "done", detail: `${found}: ${set.detail}` });
      } else {
        if (compareSetting(e, item.value).pass) { results.push({ target: item.target, status: "already_set", detail: `${found} already has that value` }); continue; }
        if (!dryRun) await context.sendSocketMessage("browser_type", withTab(tabId, { element: item.target, selector: e.selector, text: item.value, submit: false }));
        touched.set(e.n, { item, expected: item.value, index: results.length });
        results.push({ target: item.target, status: "done", detail: `${dryRun ? "would type into" : "typed into"} ${found}` });
      }
    } catch (error) {
      results.push({ target: item.target, status: "error", detail: `${found}: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  if (dryRun || touched.size === 0) return { results, sideEffects: [] };

  // Verify by reading the page again, and list anything else that changed.
  await sleep(300);
  const after: PageModel = await readModel(context, tabId);
  const byN = new Map(after.elements.map((e) => [e.n, e]));
  for (const [n, t] of touched) {
    const now = byN.get(n);
    const res = results[t.index]!;
    const target = resolutions[items.indexOf(t.item)];
    if (!now) { res.status = "mismatch"; res.detail += "; the control is gone after the change, check the page"; continue; }
    const verdict = compareSetting(now, t.expected, now.role === "combobox" && !now.options ? "contains" : "exact");
    if (verdict.pass) {
      res.detail += "; verified";
      if (target?.status === "resolved" && direct[items.indexOf(t.item)] === undefined) learn(after, t.item.target, now, true);
    } else {
      res.status = "mismatch";
      res.detail += `; but it now shows ${verdict.actual}`;
      if (target?.status === "resolved" && target.via === "memory") learn(after, t.item.target, now, false);
    }
  }
  const beforeByN = new Map(before.elements.map((e) => [e.n, e]));
  // Choosing a radio turns its siblings off; that is the intended change, not a side effect.
  const groups = new Set([...touched.keys()].map((n) => beforeByN.get(n)).filter((e) => e?.role === "radio").map((e) => `${e!.section}|${e!.sub}`));
  const sideEffects = after.elements
    .filter((e) => !touched.has(e.n) && beforeByN.has(e.n) && beforeByN.get(e.n)!.state !== e.state && e.role !== "textbox")
    .filter((e) => !(e.role === "radio" && groups.has(`${e.section}|${e.sub}`)))
    .slice(0, 10)
    .map((e) => `o${e.n} ${e.role} "${e.name}": ${beforeByN.get(e.n)!.state || "(none)"} -> ${e.state || "(none)"}`);
  return { results, sideEffects };
}
