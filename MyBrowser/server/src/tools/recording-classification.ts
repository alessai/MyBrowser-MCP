export type VariableSource = "text" | "form" | "select" | "navigation" | "clipboard";
export type RecordingStringKind = "safe" | VariableSource;
export type RecordingArgumentType = "array" | "boolean" | "number" | "object" | "string";

export interface RecordingNumericConstraint {
  readonly integer: boolean;
  readonly min: number;
  readonly max: number;
}

export const SERVER_RECORDING_STRING_METADATA = {
  browser_navigate: { url: "navigation" },
  browser_go_back: {},
  browser_go_forward: {},
  browser_wait: {},
  browser_click: { element: "safe", ref: "safe", selector: "safe", role: "safe", name: "safe", matchText: "safe", label: "safe" },
  browser_type: { element: "safe", ref: "safe", selector: "safe", role: "safe", name: "safe", matchText: "safe", label: "safe", text: "text" },
  browser_hover: { element: "safe", ref: "safe", selector: "safe", role: "safe", name: "safe", matchText: "safe", label: "safe" },
  browser_press_key: { key: "safe" },
  browser_drag: { startElement: "safe", startRef: "safe", startSelector: "safe", endElement: "safe", endRef: "safe", endSelector: "safe" },
  browser_select_option: { element: "safe", ref: "safe", selector: "safe", role: "safe", name: "safe", matchText: "safe", label: "safe", "values.*": "select" },
  browser_set_viewport: { preset: "safe", orientation: "safe" },
  browser_reset_viewport: {},
  browser_fill_form: { "fields.*": "form", submitText: "safe" },
  browser_wait_for: { condition: "safe", value: "text", selector: "safe" },
  browser_assert: {
    "checks.*.type": "safe", "checks.*.value": "text", "checks.*.selector": "safe",
  },
  browser_clipboard: { action: "safe", text: "clipboard" },
} as const satisfies Readonly<Record<string, Readonly<Record<string, RecordingStringKind>>>>;

export const SERVER_RECORDING_ARGUMENT_TYPES = {
  browser_navigate: { "": "object", url: "string", tabId: "number" },
  browser_go_back: { "": "object", tabId: "number" },
  browser_go_forward: { "": "object", tabId: "number" },
  browser_wait: { "": "object", time: "number", tabId: "number" },
  browser_click: {
    "": "object", element: "string", ref: "string", selector: "string", role: "string",
    name: "string", matchText: "string", label: "string", mark: "number", tabId: "number",
  },
  browser_type: {
    "": "object", element: "string", ref: "string", selector: "string", role: "string",
    name: "string", matchText: "string", label: "string", text: "string", mark: "number",
    submit: "boolean", tabId: "number",
  },
  browser_hover: {
    "": "object", element: "string", ref: "string", selector: "string", role: "string",
    name: "string", matchText: "string", label: "string", mark: "number", tabId: "number",
  },
  browser_press_key: { "": "object", key: "string", tabId: "number" },
  browser_drag: {
    "": "object", startElement: "string", startRef: "string", startSelector: "string",
    endElement: "string", endRef: "string", endSelector: "string", startMark: "number",
    endMark: "number", tabId: "number",
  },
  browser_select_option: {
    "": "object", element: "string", ref: "string", selector: "string", role: "string",
    name: "string", matchText: "string", label: "string", values: "array", "values.*": "string",
    mark: "number", tabId: "number",
  },
  browser_set_viewport: {
    "": "object", preset: "string", orientation: "string", tabId: "number",
  },
  browser_reset_viewport: { "": "object", tabId: "number" },
  browser_fill_form: {
    "": "object", fields: "object", "fields.*": "string", submitAfter: "boolean",
    submitText: "string", tabId: "number",
  },
  browser_wait_for: {
    "": "object", condition: "string", value: "string", selector: "string", timeout: "number",
    pollInterval: "number", tabId: "number",
  },
  browser_assert: {
    "": "object", checks: "array", "checks.*": "object", "checks.*.type": "string",
    "checks.*.value": "string", "checks.*.selector": "string", "checks.*.min": "number",
    "checks.*.max": "number", tabId: "number",
  },
  browser_clipboard: { "": "object", action: "string", text: "string", tabId: "number" },
} as const satisfies Readonly<Record<string, Readonly<Record<string, RecordingArgumentType>>>>;

const TAB_ID_BOUNDS = { integer: true, min: 1, max: 2_147_483_647 } as const;
const MARK_BOUNDS = { integer: true, min: 1, max: 2_147_483_647 } as const;
const TIMER_MS_BOUNDS = { integer: false, min: 0, max: 2_147_483_647 } as const;
const WAIT_SECONDS_BOUNDS = { integer: false, min: 0, max: 2_147_483.647 } as const;
const ELEMENT_COUNT_BOUNDS = { integer: true, min: 0, max: 2_147_483_647 } as const;

export const SERVER_RECORDING_NUMERIC_BOUNDS = {
  browser_navigate: { tabId: TAB_ID_BOUNDS },
  browser_go_back: { tabId: TAB_ID_BOUNDS },
  browser_go_forward: { tabId: TAB_ID_BOUNDS },
  browser_wait: { time: WAIT_SECONDS_BOUNDS, tabId: TAB_ID_BOUNDS },
  browser_click: { mark: MARK_BOUNDS, tabId: TAB_ID_BOUNDS },
  browser_type: { mark: MARK_BOUNDS, tabId: TAB_ID_BOUNDS },
  browser_hover: { mark: MARK_BOUNDS, tabId: TAB_ID_BOUNDS },
  browser_press_key: { tabId: TAB_ID_BOUNDS },
  browser_drag: { startMark: MARK_BOUNDS, endMark: MARK_BOUNDS, tabId: TAB_ID_BOUNDS },
  browser_select_option: { mark: MARK_BOUNDS, tabId: TAB_ID_BOUNDS },
  browser_set_viewport: { tabId: TAB_ID_BOUNDS },
  browser_reset_viewport: { tabId: TAB_ID_BOUNDS },
  browser_fill_form: { tabId: TAB_ID_BOUNDS },
  browser_wait_for: {
    timeout: TIMER_MS_BOUNDS, pollInterval: TIMER_MS_BOUNDS, tabId: TAB_ID_BOUNDS,
  },
  browser_assert: {
    "checks.*.min": ELEMENT_COUNT_BOUNDS,
    "checks.*.max": ELEMENT_COUNT_BOUNDS,
    tabId: TAB_ID_BOUNDS,
  },
  browser_clipboard: { tabId: TAB_ID_BOUNDS },
} as const satisfies Readonly<
  Record<string, Readonly<Record<string, RecordingNumericConstraint>>>
>;

export interface RecordingActionClassification {
  readonly strings: Readonly<Record<string, RecordingStringKind>>;
  readonly argumentTypes: Readonly<Record<string, RecordingArgumentType>>;
  readonly numericBounds: Readonly<Record<string, RecordingNumericConstraint>>;
}

const recordableActions = Object.keys(SERVER_RECORDING_STRING_METADATA) as Array<
  keyof typeof SERVER_RECORDING_STRING_METADATA
>;

export const SERVER_RECORDING_ARGUMENT_CLASSIFICATION = Object.freeze(Object.fromEntries(
  recordableActions.map((action) => [action, Object.freeze({
    strings: SERVER_RECORDING_STRING_METADATA[action],
    argumentTypes: SERVER_RECORDING_ARGUMENT_TYPES[action],
    numericBounds: SERVER_RECORDING_NUMERIC_BOUNDS[action],
  })]),
)) as Readonly<Record<string, RecordingActionClassification>>;
