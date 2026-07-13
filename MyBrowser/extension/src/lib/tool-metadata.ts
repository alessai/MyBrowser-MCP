interface ToolMetadataBase {
  tab: 'required' | 'optional' | 'none';
  queue: 'tab' | 'session' | 'global' | 'none';
  mutatesTab: boolean;
}

export type RecordingStringKind = 'safe' | 'text' | 'form' | 'select' | 'navigation' | 'clipboard';

export type ToolMetadata = ToolMetadataBase & (
  | { recordable: true; recordingStrings: Readonly<Record<string, RecordingStringKind>> }
  | { recordable: false; recordingStrings?: never }
);

export const TOOL_METADATA = {
  browser_navigate: { tab: 'required', queue: 'tab', mutatesTab: true, recordable: true, recordingStrings: { url: 'navigation' } },
  browser_go_back: { tab: 'required', queue: 'tab', mutatesTab: true, recordable: true, recordingStrings: {} },
  browser_go_forward: { tab: 'required', queue: 'tab', mutatesTab: true, recordable: true, recordingStrings: {} },
  browser_wait: { tab: 'optional', queue: 'none', mutatesTab: false, recordable: true, recordingStrings: {} },
  browser_snapshot: { tab: 'required', queue: 'tab', mutatesTab: false, recordable: false },
  browser_click: { tab: 'required', queue: 'tab', mutatesTab: true, recordable: true, recordingStrings: { element: 'safe', ref: 'safe', selector: 'safe', role: 'safe', name: 'safe', matchText: 'safe', label: 'safe' } },
  browser_type: { tab: 'required', queue: 'tab', mutatesTab: true, recordable: true, recordingStrings: { element: 'safe', ref: 'safe', selector: 'safe', role: 'safe', name: 'safe', matchText: 'safe', label: 'safe', text: 'text' } },
  browser_hover: { tab: 'required', queue: 'tab', mutatesTab: true, recordable: true, recordingStrings: { element: 'safe', ref: 'safe', selector: 'safe', role: 'safe', name: 'safe', matchText: 'safe', label: 'safe' } },
  browser_press_key: { tab: 'required', queue: 'tab', mutatesTab: true, recordable: true, recordingStrings: { key: 'safe' } },
  browser_drag: { tab: 'required', queue: 'tab', mutatesTab: true, recordable: true, recordingStrings: { startElement: 'safe', startRef: 'safe', startSelector: 'safe', endElement: 'safe', endRef: 'safe', endSelector: 'safe' } },
  browser_select_option: { tab: 'required', queue: 'tab', mutatesTab: true, recordable: true, recordingStrings: { element: 'safe', ref: 'safe', selector: 'safe', role: 'safe', name: 'safe', matchText: 'safe', label: 'safe', 'values.*': 'select' } },
  browser_screenshot: { tab: 'required', queue: 'tab', mutatesTab: false, recordable: false },
  browser_get_console_logs: { tab: 'optional', queue: 'none', mutatesTab: false, recordable: false },
  browser_set_viewport: { tab: 'required', queue: 'tab', mutatesTab: true, recordable: true, recordingStrings: { preset: 'safe', orientation: 'safe' } },
  browser_reset_viewport: { tab: 'required', queue: 'tab', mutatesTab: true, recordable: true, recordingStrings: {} },
  browser_viewport_info: { tab: 'required', queue: 'tab', mutatesTab: false, recordable: false },
  browser_diagnostics: { tab: 'optional', queue: 'none', mutatesTab: false, recordable: false },
  generateMarks: { tab: 'required', queue: 'tab', mutatesTab: false, recordable: false },
  clearMarks: { tab: 'required', queue: 'tab', mutatesTab: false, recordable: false },
  browser_extract: { tab: 'required', queue: 'tab', mutatesTab: false, recordable: false },
  browser_fill_form: { tab: 'required', queue: 'tab', mutatesTab: true, recordable: true, recordingStrings: { 'fields.*': 'form', submitText: 'safe' } },
  browser_find: { tab: 'required', queue: 'tab', mutatesTab: false, recordable: false },
  browser_action: { tab: 'required', queue: 'tab', mutatesTab: true, recordable: false },
  browser_wait_for: { tab: 'required', queue: 'tab', mutatesTab: false, recordable: true, recordingStrings: { condition: 'safe', value: 'text', selector: 'safe' } },
  browser_assert: {
    tab: 'required', queue: 'tab', mutatesTab: false, recordable: true,
    recordingStrings: {
      'checks.*.type': 'safe', 'checks.*.value': 'text', 'checks.*.selector': 'safe',
    },
  },
  list_tabs: { tab: 'none', queue: 'none', mutatesTab: false, recordable: false },
  select_tab: { tab: 'required', queue: 'tab', mutatesTab: true, recordable: false },
  new_tab: { tab: 'none', queue: 'global', mutatesTab: true, recordable: false },
  close_tab: { tab: 'required', queue: 'tab', mutatesTab: true, recordable: false },
  browser_record_start: { tab: 'required', queue: 'session', mutatesTab: false, recordable: false },
  browser_record_stop: { tab: 'none', queue: 'session', mutatesTab: false, recordable: false },
  browser_record_list: { tab: 'none', queue: 'none', mutatesTab: false, recordable: false },
  loadRecording: { tab: 'none', queue: 'none', mutatesTab: false, recordable: false },
  browser_replay: { tab: 'required', queue: 'tab', mutatesTab: true, recordable: false },
  generatePageModel: { tab: 'required', queue: 'tab', mutatesTab: false, recordable: false },
  browser_eval: { tab: 'required', queue: 'tab', mutatesTab: true, recordable: false },
  browser_storage: { tab: 'required', queue: 'tab', mutatesTab: true, recordable: false },
  browser_network: { tab: 'required', queue: 'global', mutatesTab: false, recordable: false },
  browser_performance: { tab: 'required', queue: 'tab', mutatesTab: false, recordable: false },
  browser_upload: { tab: 'required', queue: 'tab', mutatesTab: true, recordable: false },
  browser_download: { tab: 'optional', queue: 'none', mutatesTab: false, recordable: false },
  browser_clipboard: { tab: 'required', queue: 'tab', mutatesTab: true, recordable: true, recordingStrings: { action: 'safe', text: 'clipboard' } },
  getUrl: { tab: 'required', queue: 'tab', mutatesTab: false, recordable: false },
  getTitle: { tab: 'required', queue: 'tab', mutatesTab: false, recordable: false },
  browser_register_handler: { tab: 'optional', queue: 'global', mutatesTab: false, recordable: false },
  browser_unregister_handler: { tab: 'none', queue: 'global', mutatesTab: false, recordable: false },
  browser_list_handlers: { tab: 'none', queue: 'none', mutatesTab: false, recordable: false },
} as const satisfies Record<string, ToolMetadata>;

export function isRecordableToolName(value: unknown): value is keyof typeof TOOL_METADATA {
  if (typeof value !== 'string') return false;
  const metadata = TOOL_METADATA[value as keyof typeof TOOL_METADATA];
  return metadata?.recordable === true;
}

export type RecordingArgumentType = 'array' | 'boolean' | 'number' | 'object' | 'string';

export const RECORDING_ARGUMENT_TYPES = {
  browser_navigate: { '': 'object', url: 'string', tabId: 'number' },
  browser_go_back: { '': 'object', tabId: 'number' },
  browser_go_forward: { '': 'object', tabId: 'number' },
  browser_wait: { '': 'object', time: 'number', tabId: 'number' },
  browser_click: {
    '': 'object', element: 'string', ref: 'string', selector: 'string', role: 'string',
    name: 'string', matchText: 'string', label: 'string', mark: 'number', tabId: 'number',
  },
  browser_type: {
    '': 'object', element: 'string', ref: 'string', selector: 'string', role: 'string',
    name: 'string', matchText: 'string', label: 'string', text: 'string', mark: 'number',
    submit: 'boolean', tabId: 'number',
  },
  browser_hover: {
    '': 'object', element: 'string', ref: 'string', selector: 'string', role: 'string',
    name: 'string', matchText: 'string', label: 'string', mark: 'number', tabId: 'number',
  },
  browser_press_key: { '': 'object', key: 'string', tabId: 'number' },
  browser_drag: {
    '': 'object', startElement: 'string', startRef: 'string', startSelector: 'string',
    endElement: 'string', endRef: 'string', endSelector: 'string', startMark: 'number',
    endMark: 'number', tabId: 'number',
  },
  browser_select_option: {
    '': 'object', element: 'string', ref: 'string', selector: 'string', role: 'string',
    name: 'string', matchText: 'string', label: 'string', values: 'array', 'values.*': 'string',
    mark: 'number', tabId: 'number',
  },
  browser_set_viewport: {
    '': 'object', preset: 'string', orientation: 'string', tabId: 'number',
  },
  browser_reset_viewport: { '': 'object', tabId: 'number' },
  browser_fill_form: {
    '': 'object', fields: 'object', 'fields.*': 'string', submitAfter: 'boolean',
    submitText: 'string', tabId: 'number',
  },
  browser_wait_for: {
    '': 'object', condition: 'string', value: 'string', selector: 'string', timeout: 'number',
    pollInterval: 'number', tabId: 'number',
  },
  browser_assert: {
    '': 'object', checks: 'array', 'checks.*': 'object', 'checks.*.type': 'string',
    'checks.*.value': 'string', 'checks.*.selector': 'string', 'checks.*.min': 'number',
    'checks.*.max': 'number', tabId: 'number',
  },
  browser_clipboard: { '': 'object', action: 'string', text: 'string', tabId: 'number' },
} as const satisfies Readonly<Record<string, Readonly<Record<string, RecordingArgumentType>>>>;

export interface RecordingNumericConstraint {
  readonly integer: boolean;
  readonly min: number;
  readonly max: number;
}

const TAB_ID_BOUNDS = { integer: true, min: 1, max: 2_147_483_647 } as const;
const MARK_BOUNDS = { integer: true, min: 1, max: 2_147_483_647 } as const;
const TIMER_MS_BOUNDS = { integer: false, min: 0, max: 2_147_483_647 } as const;
const WAIT_SECONDS_BOUNDS = { integer: false, min: 0, max: 2_147_483.647 } as const;
const ELEMENT_COUNT_BOUNDS = { integer: true, min: 0, max: 2_147_483_647 } as const;

export const RECORDING_NUMERIC_BOUNDS = {
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
    'checks.*.min': ELEMENT_COUNT_BOUNDS,
    'checks.*.max': ELEMENT_COUNT_BOUNDS,
    tabId: TAB_ID_BOUNDS,
  },
  browser_clipboard: { tabId: TAB_ID_BOUNDS },
} as const satisfies Readonly<
  Record<string, Readonly<Record<string, RecordingNumericConstraint>>>
>;

export type ToolName = keyof typeof TOOL_METADATA;
