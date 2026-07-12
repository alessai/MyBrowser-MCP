export interface ToolMetadata {
  tab: 'required' | 'optional' | 'none';
  queue: 'tab' | 'session' | 'global' | 'none';
  mutatesTab: boolean;
  recordable: boolean;
}

export const TOOL_METADATA = {
  browser_navigate: { tab: 'required', queue: 'tab', mutatesTab: true, recordable: true },
  browser_go_back: { tab: 'required', queue: 'tab', mutatesTab: true, recordable: true },
  browser_go_forward: { tab: 'required', queue: 'tab', mutatesTab: true, recordable: true },
  browser_wait: { tab: 'optional', queue: 'none', mutatesTab: false, recordable: true },
  browser_snapshot: { tab: 'required', queue: 'tab', mutatesTab: false, recordable: false },
  browser_click: { tab: 'required', queue: 'tab', mutatesTab: true, recordable: true },
  browser_type: { tab: 'required', queue: 'tab', mutatesTab: true, recordable: true },
  browser_hover: { tab: 'required', queue: 'tab', mutatesTab: true, recordable: true },
  browser_press_key: { tab: 'required', queue: 'tab', mutatesTab: true, recordable: true },
  browser_drag: { tab: 'required', queue: 'tab', mutatesTab: true, recordable: true },
  browser_select_option: { tab: 'required', queue: 'tab', mutatesTab: true, recordable: true },
  browser_screenshot: { tab: 'required', queue: 'tab', mutatesTab: false, recordable: false },
  browser_get_console_logs: { tab: 'optional', queue: 'none', mutatesTab: false, recordable: false },
  browser_set_viewport: { tab: 'required', queue: 'tab', mutatesTab: true, recordable: true },
  browser_reset_viewport: { tab: 'required', queue: 'tab', mutatesTab: true, recordable: true },
  browser_viewport_info: { tab: 'required', queue: 'tab', mutatesTab: false, recordable: false },
  browser_diagnostics: { tab: 'optional', queue: 'none', mutatesTab: false, recordable: false },
  generateMarks: { tab: 'required', queue: 'tab', mutatesTab: false, recordable: false },
  clearMarks: { tab: 'required', queue: 'tab', mutatesTab: false, recordable: false },
  browser_extract: { tab: 'required', queue: 'tab', mutatesTab: false, recordable: false },
  browser_fill_form: { tab: 'required', queue: 'tab', mutatesTab: true, recordable: true },
  browser_find: { tab: 'required', queue: 'tab', mutatesTab: false, recordable: false },
  browser_action: { tab: 'required', queue: 'tab', mutatesTab: true, recordable: false },
  browser_wait_for: { tab: 'required', queue: 'tab', mutatesTab: false, recordable: true },
  browser_assert: { tab: 'required', queue: 'tab', mutatesTab: false, recordable: false },
  list_tabs: { tab: 'none', queue: 'none', mutatesTab: false, recordable: false },
  select_tab: { tab: 'required', queue: 'tab', mutatesTab: true, recordable: true },
  new_tab: { tab: 'none', queue: 'global', mutatesTab: true, recordable: true },
  close_tab: { tab: 'required', queue: 'tab', mutatesTab: true, recordable: true },
  browser_record_start: { tab: 'required', queue: 'session', mutatesTab: false, recordable: false },
  browser_record_stop: { tab: 'none', queue: 'session', mutatesTab: false, recordable: false },
  browser_record_list: { tab: 'none', queue: 'none', mutatesTab: false, recordable: false },
  saveRecording: { tab: 'none', queue: 'global', mutatesTab: false, recordable: false },
  loadRecording: { tab: 'none', queue: 'none', mutatesTab: false, recordable: false },
  browser_replay: { tab: 'required', queue: 'tab', mutatesTab: true, recordable: false },
  generatePageModel: { tab: 'required', queue: 'tab', mutatesTab: false, recordable: false },
  browser_eval: { tab: 'required', queue: 'tab', mutatesTab: true, recordable: false },
  browser_storage: { tab: 'required', queue: 'tab', mutatesTab: true, recordable: false },
  browser_network: { tab: 'required', queue: 'global', mutatesTab: false, recordable: false },
  browser_performance: { tab: 'required', queue: 'tab', mutatesTab: false, recordable: false },
  browser_upload: { tab: 'required', queue: 'tab', mutatesTab: true, recordable: false },
  browser_download: { tab: 'optional', queue: 'none', mutatesTab: false, recordable: false },
  browser_clipboard: { tab: 'required', queue: 'tab', mutatesTab: true, recordable: false },
  getUrl: { tab: 'required', queue: 'tab', mutatesTab: false, recordable: false },
  getTitle: { tab: 'required', queue: 'tab', mutatesTab: false, recordable: false },
  browser_register_handler: { tab: 'optional', queue: 'global', mutatesTab: false, recordable: false },
  browser_unregister_handler: { tab: 'none', queue: 'global', mutatesTab: false, recordable: false },
  browser_list_handlers: { tab: 'none', queue: 'none', mutatesTab: false, recordable: false },
} as const satisfies Record<string, ToolMetadata>;

export type ToolName = keyof typeof TOOL_METADATA;
