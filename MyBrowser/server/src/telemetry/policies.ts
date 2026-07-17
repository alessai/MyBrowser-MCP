export type TelemetryFieldPolicy =
  | { readonly kind: "boolean" }
  | {
      readonly kind: "number";
      readonly min: number;
      readonly max: number;
      readonly step: number;
    }
  | { readonly kind: "enum"; readonly values: readonly string[] }
  | { readonly kind: "count"; readonly max: number }
  | { readonly kind: "text_length" }
  | { readonly kind: "pseudonym"; readonly namespace: string }
  | { readonly kind: "url" }
  | { readonly kind: "shape" }
  | { readonly kind: "action_sequence"; readonly values: readonly string[] };

export interface ToolTelemetryPolicy {
  readonly fields: Readonly<Record<string, TelemetryFieldPolicy>>;
}

export interface RegisteredToolTelemetryShape {
  readonly name: string;
  readonly argumentFields: readonly string[];
}

function immutablePolicy(
  fields: Record<string, TelemetryFieldPolicy>,
): ToolTelemetryPolicy {
  for (const rule of Object.values(fields)) {
    if ("values" in rule) Object.freeze(rule.values);
    Object.freeze(rule);
  }
  Object.freeze(fields);
  return Object.freeze({ fields });
}

const boolean = (): TelemetryFieldPolicy => ({ kind: "boolean" });
const number = (min: number, max: number, step: number): TelemetryFieldPolicy => ({
  kind: "number",
  min,
  max,
  step,
});
const enumeration = (...values: string[]): TelemetryFieldPolicy => ({
  kind: "enum",
  values,
});
const count = (max = 1_024): TelemetryFieldPolicy => ({ kind: "count", max });
const textLength = (): TelemetryFieldPolicy => ({ kind: "text_length" });
const pseudonym = (namespace: string): TelemetryFieldPolicy => ({
  kind: "pseudonym",
  namespace,
});
const url = (): TelemetryFieldPolicy => ({ kind: "url" });
const shape = (): TelemetryFieldPolicy => ({ kind: "shape" });

const TAB_ID = pseudonym("tab");
const BROWSER_ID = pseudonym("browser");
const TARGET = pseudonym("target");
const ARTIFACT = pseudonym("recording_artifact");
const ANNOTATION = pseudonym("annotation");
const SHARED_KEY = pseudonym("shared_key");
const LOCK_NAME = pseudonym("lock_name");
const SESSION = pseudonym("session");
const ACTION_SEQUENCE: TelemetryFieldPolicy = {
  kind: "action_sequence",
  values: [
    "click",
    "type",
    "press_key",
    "hover",
    "select_option",
    "wait",
    "wait_for",
    "navigate",
    "snapshot",
    "screenshot",
    "scroll",
  ],
};

const targetFields = (): Record<string, TelemetryFieldPolicy> => ({
  element: TARGET,
  ref: TARGET,
  mark: TARGET,
  selector: TARGET,
  role: TARGET,
  name: TARGET,
  matchText: TARGET,
  label: TARGET,
  tabId: TAB_ID,
});

const policies = {
  browser_screenshot: immutablePolicy({ tabId: TAB_ID, annotate: boolean() }),
  browser_navigate: immutablePolicy({ url: url(), tabId: TAB_ID }),
  browser_go_back: immutablePolicy({ tabId: TAB_ID }),
  browser_go_forward: immutablePolicy({ tabId: TAB_ID }),
  browser_wait: immutablePolicy({ time: number(0, 30, 0.1), tabId: TAB_ID }),
  browser_action: immutablePolicy({
    steps: ACTION_SEQUENCE,
    tabId: TAB_ID,
    stopOnError: boolean(),
  }),
  browser_click: immutablePolicy(targetFields()),
  browser_type: immutablePolicy({
    ...targetFields(),
    text: textLength(),
    submit: boolean(),
  }),
  browser_press_key: immutablePolicy({ key: pseudonym("input_key"), tabId: TAB_ID }),
  browser_hover: immutablePolicy(targetFields()),
  browser_select_option: immutablePolicy({
    ...targetFields(),
    values: count(128),
  }),
  browser_fill_form: immutablePolicy({
    fields: count(256),
    submitAfter: boolean(),
    submitText: textLength(),
    tabId: TAB_ID,
  }),
  browser_upload: immutablePolicy({ selector: TARGET, files: count(128), tabId: TAB_ID }),
  browser_drag: immutablePolicy({
    startElement: TARGET,
    startRef: TARGET,
    startMark: TARGET,
    startSelector: TARGET,
    endElement: TARGET,
    endRef: TARGET,
    endMark: TARGET,
    endSelector: TARGET,
    tabId: TAB_ID,
  }),
  browser_wait_for: immutablePolicy({
    condition: enumeration(
      "url_contains",
      "url_matches",
      "element_visible",
      "element_not_visible",
      "text_visible",
      "text_not_visible",
      "network_idle",
    ),
    value: TARGET,
    selector: TARGET,
    timeout: number(0, 240_000, 100),
    pollInterval: number(50, 30_000, 50),
    tabId: TAB_ID,
  }),
  browser_find: immutablePolicy({
    role: TARGET,
    name: TARGET,
    text: TARGET,
    selector: TARGET,
    limit: number(1, 1_000, 1),
    tabId: TAB_ID,
  }),
  browser_extract: immutablePolicy({
    selector: TARGET,
    fields: count(256),
    limit: number(1, 10_000, 1),
    tabId: TAB_ID,
  }),
  browser_assert: immutablePolicy({ checks: count(256), tabId: TAB_ID }),
  browser_snapshot: immutablePolicy({
    viewportOnly: boolean(),
    mode: enumeration("full", "diff", "auto"),
    tabId: TAB_ID,
  }),
  list_tabs: immutablePolicy({}),
  new_tab: immutablePolicy({ url: url() }),
  close_tab: immutablePolicy({ tabId: TAB_ID }),
  select_tab: immutablePolicy({ tabId: TAB_ID }),
  browser_clipboard: immutablePolicy({
    action: enumeration("read", "write", "paste"),
    text: textLength(),
    tabId: TAB_ID,
  }),
  browser_get_console_logs: immutablePolicy({ tabId: TAB_ID }),
  browser_eval: immutablePolicy({
    code: textLength(),
    timeout: number(0, 30_000, 100),
    tabId: TAB_ID,
  }),
  browser_network: immutablePolicy({
    action: enumeration("start_capture", "stop_capture", "get_log", "clear"),
    filter: count(16),
    limit: number(1, 10_000, 1),
    tabId: TAB_ID,
  }),
  browser_events_list: immutablePolicy({ browserId: BROWSER_ID }),
  browser_on: immutablePolicy({
    event: enumeration("dialog", "beforeunload", "new_tab", "network_timeout"),
    action: enumeration("dismiss", "accept", "emit", "ignore"),
    options: count(16),
    browserId: BROWSER_ID,
  }),
  browser_off: immutablePolicy({ handlerId: pseudonym("event_handler") }),
  browser_wait_for_event: immutablePolicy({
    eventName: pseudonym("event_queue"),
    timeoutMs: number(0, 240_000, 100),
  }),
  browser_performance: immutablePolicy({
    action: enumeration("get_metrics", "get_web_vitals"),
    tabId: TAB_ID,
  }),
  browser_viewport_info: immutablePolicy({ tabId: TAB_ID }),
  browser_set_viewport: immutablePolicy({
    preset: enumeration("iphone", "ipad", "desktop"),
    orientation: enumeration("portrait", "landscape"),
    tabId: TAB_ID,
  }),
  browser_reset_viewport: immutablePolicy({ tabId: TAB_ID }),
  browser_diagnostics: immutablePolicy({
    includeLogs: boolean(),
    includeExtension: boolean(),
  }),
  browser_support_bundle: immutablePolicy({ includeExtension: boolean() }),
  browser_notes_list: immutablePolicy({
    status: enumeration("pending", "archived", "all"),
  }),
  browser_notes_get: immutablePolicy({ id: ANNOTATION }),
  browser_notes_archive: immutablePolicy({
    id: ANNOTATION,
    resolution: textLength(),
  }),
  browser_notes_delete: immutablePolicy({ id: ANNOTATION, force: boolean() }),
  browser_notes_unarchive: immutablePolicy({ id: ANNOTATION }),
  browser_record_start: immutablePolicy({ name: ARTIFACT, tabId: TAB_ID }),
  browser_record_stop: immutablePolicy({}),
  browser_record_list: immutablePolicy({}),
  browser_replay: immutablePolicy({
    name: ARTIFACT,
    variables: count(256),
    speed: number(0, 10, 0.1),
    stopOnError: boolean(),
    startFromStep: number(1, 100_000, 1),
    stopAtStep: number(1, 100_000, 1),
    tabId: TAB_ID,
  }),
  browser_learn: immutablePolicy({ pageName: pseudonym("page_model"), tabId: TAB_ID }),
  browser_site_info: immutablePolicy({ domain: pseudonym("domain"), tabId: TAB_ID }),
  browser_storage: immutablePolicy({
    action: enumeration("get", "set", "delete", "clear"),
    type: enumeration("localStorage", "sessionStorage", "cookies"),
    key: pseudonym("storage_key"),
    value: textLength(),
    domain: pseudonym("domain"),
    tabId: TAB_ID,
  }),
  browser_download: immutablePolicy({
    url: url(),
    filename: pseudonym("download_name"),
    directory: pseudonym("download_directory"),
    tabId: TAB_ID,
  }),
  browser_shared_get: immutablePolicy({ key: SHARED_KEY }),
  browser_shared_set: immutablePolicy({ key: SHARED_KEY, value: shape() }),
  browser_shared_delete: immutablePolicy({ key: SHARED_KEY }),
  browser_shared_list: immutablePolicy({}),
  browser_lock: immutablePolicy({
    name: LOCK_NAME,
    timeoutMs: number(0, 600_000, 100),
    ttlMs: number(0, 3_600_000, 1_000),
  }),
  browser_unlock: immutablePolicy({ name: LOCK_NAME }),
  browser_locks_list: immutablePolicy({}),
  list_browsers: immutablePolicy({}),
  select_browser: immutablePolicy({ browserId: BROWSER_ID }),
  set_default_browser: immutablePolicy({ browserId: BROWSER_ID }),
  get_default_browser: immutablePolicy({}),
  clear_default_browser: immutablePolicy({}),
  browser_sessions: immutablePolicy({}),
  browser_claim_tab: immutablePolicy({ tabId: TAB_ID, browserId: BROWSER_ID }),
  browser_release_tab: immutablePolicy({ tabId: TAB_ID, browserId: BROWSER_ID }),
  browser_handoff: immutablePolicy({
    tabId: TAB_ID,
    browserId: BROWSER_ID,
    toSession: SESSION,
    message: textLength(),
  }),
} satisfies Record<string, ToolTelemetryPolicy>;

export const TELEMETRY_TOOL_POLICIES: Readonly<
  Record<keyof typeof policies, ToolTelemetryPolicy>
> = Object.freeze(policies);

export function getTelemetryToolPolicy(toolName: string): ToolTelemetryPolicy | undefined {
  return Object.prototype.hasOwnProperty.call(TELEMETRY_TOOL_POLICIES, toolName)
    ? TELEMETRY_TOOL_POLICIES[toolName as keyof typeof policies]
    : undefined;
}

export function assertTelemetryPolicyCoverage(
  registeredTools: readonly (string | RegisteredToolTelemetryShape)[],
): void {
  const registeredShapes = registeredTools.map((tool) => (
    typeof tool === "string" ? { name: tool } : tool
  ));
  const registered = new Set(registeredShapes.map(({ name }) => name));
  const configured = new Set(Object.keys(TELEMETRY_TOOL_POLICIES));
  const missing = [...registered].filter((name) => !configured.has(name)).sort();
  const stale = [...configured].filter((name) => !registered.has(name)).sort();
  const fieldMismatches: string[] = [];

  for (const shape of registeredShapes) {
    if (!("argumentFields" in shape)) continue;
    const policy = getTelemetryToolPolicy(shape.name);
    if (!policy) continue;
    const schemaFields = new Set(shape.argumentFields);
    const policyFields = new Set(Object.keys(policy.fields));
    const missingFields = [...schemaFields].filter((field) => !policyFields.has(field)).sort();
    const staleFields = [...policyFields].filter((field) => !schemaFields.has(field)).sort();
    if (missingFields.length > 0) {
      fieldMismatches.push(`${shape.name} missing fields: ${missingFields.join(", ")}`);
    }
    if (staleFields.length > 0) {
      fieldMismatches.push(`${shape.name} stale fields: ${staleFields.join(", ")}`);
    }
  }

  if (missing.length === 0 && stale.length === 0 && fieldMismatches.length === 0) return;

  const details = [
    missing.length > 0 ? `missing: ${missing.join(", ")}` : "",
    stale.length > 0 ? `stale: ${stale.join(", ")}` : "",
    ...fieldMismatches,
  ].filter(Boolean).join("; ");
  throw new Error(`Telemetry policy coverage failed (${details})`);
}
