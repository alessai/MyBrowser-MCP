// Agents call MyBrowser with argument shapes learned from Playwright MCP and
// similar tools ({ms}, {expression}, {text, time}, numeric refs...). 181 of 525
// failed calls between Nov 2 and 12 2026 were only that. Each unambiguous form
// is rewritten to the canonical one here, before the tool parses its arguments,
// and the result says what was accepted so the agent learns the real name.
// Conflicting or ambiguous input is left alone and fails as before.

type Args = Record<string, unknown>;

const TARGETED = new Set(["browser_click", "browser_type", "browser_hover", "browser_select_option"]);
const REF_LIKE = /^[eo]?\d+$/;
// "#id", ".cls", "[attr]", "tag#id", "tag.cls", "tag[attr]", "tag:pseudo", "a > b".
const CSS_LIKE = /^[#.[]|^[a-z][a-z0-9-]*[#.[:]|\s>\s/i;

const WAIT_CONDITIONS = new Set(["url_contains", "url_matches", "element_visible", "element_not_visible", "text_visible", "text_not_visible", "network_idle"]);
const CONDITION_ALIASES: Record<string, string> = {
  el_exists: "element_visible",
  element_exists: "element_visible",
  exists: "element_visible",
  visible: "element_visible",
  element: "element_visible",
  selector: "element_visible",
  el_visible: "element_visible",
  hidden: "element_not_visible",
  element_hidden: "element_not_visible",
  not_visible: "element_not_visible",
  gone: "element_not_visible",
  text: "text_visible",
  text_exists: "text_visible",
  text_present: "text_visible",
  contains_text: "text_visible",
  text_gone: "text_not_visible",
  text_hidden: "text_not_visible",
  no_text: "text_not_visible",
  url: "url_contains",
  url_includes: "url_contains",
  url_regex: "url_matches",
  idle: "network_idle",
  networkidle: "network_idle",
  load: "network_idle",
  loaded: "network_idle",
};

function move(args: Args, from: string, to: string, notes: string[], transform?: (v: unknown) => unknown): void {
  if (args[from] === undefined || args[to] !== undefined) return;
  args[to] = transform ? transform(args[from]) : args[from];
  delete args[from];
  notes.push(`${from} as ${to}`);
}

function normalizeRef(args: Args, refPrefix: string, notes: string[], key = "ref"): void {
  const ref = args[key];
  if (typeof ref === "number" || (typeof ref === "string" && /^\d+$/.test(ref))) {
    args[key] = `${refPrefix}${ref}`;
    notes.push(`${key} ${ref} as "${refPrefix}${ref}" (from the last ${refPrefix === "o" ? "browser_outline" : "snapshot"})`);
  }
}

/** Splits "text_visible:Saved" style conditions and maps alias names. */
function normalizeCondition(args: Args, notes: string[], selectorKey = "selector"): void {
  if (typeof args.condition !== "string") return;
  let condition = args.condition.trim();
  const colon = condition.indexOf(":");
  if (colon > 0 && !WAIT_CONDITIONS.has(condition)) {
    const head = condition.slice(0, colon).trim();
    const rest = condition.slice(colon + 1).trim();
    const name = WAIT_CONDITIONS.has(head) ? head : CONDITION_ALIASES[head.toLowerCase()];
    if (name) {
      condition = name;
      if (name.startsWith("element_")) { if (args[selectorKey] === undefined) args[selectorKey] = rest; }
      else if (args.value === undefined) args.value = rest;
      notes.push(`condition "${args.condition}" as condition "${name}" with its value`);
    }
  }
  const alias = CONDITION_ALIASES[condition.toLowerCase()];
  if (!WAIT_CONDITIONS.has(condition) && alias) {
    notes.push(`condition "${condition}" as "${alias}"`);
    condition = alias;
  }
  args.condition = condition;
}

function normalizeTargeted(tool: string, args: Args, refPrefix: string, notes: string[]): void {
  move(args, "description", "element", notes);
  move(args, "tab_id", "tabId", notes);
  if (args.target !== undefined && args.ref === undefined && args.selector === undefined) {
    const t = String(args.target).trim();
    if (REF_LIKE.test(t)) args.ref = t;
    else if (CSS_LIKE.test(t)) args.selector = t;
    else if (args.element === undefined) args.element = t;
    else args.matchText = t;
    delete args.target;
    notes.push(`target as ${args.ref !== undefined ? "ref" : args.selector !== undefined ? "selector" : args.matchText !== undefined ? "matchText" : "element"}`);
  }
  normalizeRef(args, refPrefix, notes);
  if (tool === "browser_type") {
    move(args, "value", "text", notes);
  } else {
    // On click/hover/select `text` is not a field: it is the visible text to match.
    move(args, "text", "matchText", notes);
  }
}

function normalizeStep(step: Args, refPrefix: string, notes: string[]): Args {
  const s = { ...step };
  move(s, "type", "action", notes);
  normalizeRef(s, refPrefix, notes);
  if (s.action === "wait") {
    move(s, "ms", "time", notes, (v) => Number(v) / 1000);
    move(s, "seconds", "time", notes);
  }
  if (s.action === "type" && s.typedText === undefined && s.text !== undefined
    && [s.ref, s.selector, s.label, s.name, s.role, s.mark].some((v) => v !== undefined)) {
    // With a target given, `text` can only be the text to type.
    s.typedText = s.text;
    delete s.text;
    notes.push("type step text as typedText");
  }
  if (s.action === "wait_for") normalizeCondition(s, notes);
  return s;
}

/**
 * Returns canonical arguments for `tool` plus a short note listing what was
 * rewritten (empty when nothing was). Never throws; unknown tools pass through.
 */
export function normalizeArguments(tool: string, raw: unknown, refPrefix: "e" | "o" = "e"): { args: unknown; note: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { args: raw, note: "" };
  const args: Args = { ...(raw as Args) };
  const notes: string[] = [];
  if (TARGETED.has(tool)) normalizeTargeted(tool, args, refPrefix, notes);
  switch (tool) {
    case "browser_wait":
      move(args, "ms", "time", notes, (v) => Number(v) / 1000);
      move(args, "milliseconds", "time", notes, (v) => Number(v) / 1000);
      move(args, "seconds", "time", notes);
      move(args, "duration", "time", notes);
      break;
    case "browser_eval":
      for (const name of ["expression", "script", "js"]) move(args, name, "code", notes);
      // Playwright's browser_evaluate passes a function source: call it.
      move(args, "function", "code", notes, (v) => {
        const src = String(v).trim();
        return /^(async\s+)?(function\b|\([^)]*\)\s*=>|\w+\s*=>)/.test(src) ? `(${src})()` : src;
      });
      break;
    case "select_browser":
    case "set_default_browser":
      for (const name of ["browser_id", "browser", "id", "name", "browserName"]) move(args, name, "browserId", notes);
      break;
    case "browser_wait_for":
      move(args, "tab_id", "tabId", notes);
      if (args.condition === undefined && args.until === undefined) {
        if (args.text !== undefined) { args.condition = "text_visible"; move(args, "text", "value", notes); }
        else if (args.textGone !== undefined) { args.condition = "text_not_visible"; move(args, "textGone", "value", notes); }
        else if (args.text_gone !== undefined) { args.condition = "text_not_visible"; move(args, "text_gone", "value", notes); }
        else if (args.url !== undefined) { args.condition = "url_contains"; move(args, "url", "value", notes); }
        else if (args.selector !== undefined) { args.condition = "element_visible"; notes.push("selector as condition element_visible"); }
      }
      normalizeCondition(args, notes);
      // A condition that is neither a known name nor an alias is a description.
      if (typeof args.condition === "string" && !WAIT_CONDITIONS.has(args.condition) && args.until === undefined && /\s/.test(args.condition)) {
        args.until = args.condition;
        delete args.condition;
        notes.push("condition as until (a plain-language state)");
      }
      move(args, "ms", "timeout", notes);
      if (args.time !== undefined && (args.condition !== undefined || args.until !== undefined) && args.timeout === undefined) {
        // Playwright's time is seconds.
        args.timeout = Number(args.time) * 1000;
        delete args.time;
        notes.push("time (seconds) as timeout");
      }
      break;
    case "browser_action":
      move(args, "actions", "steps", notes);
      if (Array.isArray(args.steps)) {
        args.steps = (args.steps as unknown[]).map((step) => (step && typeof step === "object" ? normalizeStep(step as Args, refPrefix, notes) : step));
      }
      break;
    case "browser_navigate":
    case "new_tab":
      move(args, "tab_id", "tabId", notes);
      break;
    default:
      move(args, "tab_id", "tabId", notes);
  }
  const unique = [...new Set(notes)];
  return { args, note: unique.length ? `(Accepted ${unique.join("; ")}.)` : "" };
}
