// Session recording engine for ULTRA Phase 3.
// Captures user-facing tool calls as replayable steps.

export interface RecordedStep {
  action: string;
  args: Record<string, unknown>;
  timestamp: number;
  durationMs: number;
  url: string;
  result?: unknown;
}

export interface Recording {
  name: string;
  startedAt: number;
  stoppedAt?: number;
  url: string;
  steps: RecordedStep[];
  variables?: Record<string, string>;
}

// IMPORTANT: This set defines all user-facing tools that should be captured in recordings.
// When adding new browser automation tools to tools.ts, add their names here too.
// browser_action is excluded because its sub-steps are recorded individually.
// Observation-only tools (screenshot, snapshot, find) are excluded to avoid replay bloat.
const RECORDABLE_TOOLS = new Set([
  'browser_navigate',
  'browser_go_back',
  'browser_go_forward',
  'browser_wait',
  'browser_click',
  'browser_type',
  'browser_hover',
  'browser_press_key',
  'browser_drag',
  'browser_select_option',
  'browser_fill_form',
  'browser_wait_for',
  'browser_select_option',
  'new_tab',
  'close_tab',
  'select_tab',
]);

let activeRecording: Recording | null = null;
let replaying = false;

export function isRecording(): boolean {
  return activeRecording !== null;
}

export function setReplaying(val: boolean): void {
  replaying = val;
}

export function startRecording(name: string, startUrl: string): void {
  if (activeRecording) {
    throw new Error(`Already recording "${activeRecording.name}". Stop it first.`);
  }
  activeRecording = {
    name,
    startedAt: Date.now(),
    url: startUrl,
    steps: [],
  };
}

export function stopRecording(): Recording {
  if (!activeRecording) {
    throw new Error('No recording in progress.');
  }
  activeRecording.stoppedAt = Date.now();
  const recording = activeRecording;
  activeRecording = null;
  return recording;
}

export function shouldRecord(toolName: string): boolean {
  return activeRecording !== null && !replaying && RECORDABLE_TOOLS.has(toolName);
}

export function pushStep(step: RecordedStep): void {
  if (!activeRecording) return;
  activeRecording.steps.push(step);
}

// Persistence helpers using chrome.storage.local

const STORAGE_PREFIX = 'recording:';

export async function saveRecordingToStorage(recording: Recording): Promise<void> {
  const key = `${STORAGE_PREFIX}${recording.name}`;
  await chrome.storage.local.set({ [key]: recording });
}

export async function loadRecordingFromStorage(name: string): Promise<Recording | null> {
  const key = `${STORAGE_PREFIX}${name}`;
  const result = await chrome.storage.local.get(key);
  return (result[key] as Recording) ?? null;
}

export async function listRecordingsFromStorage(): Promise<string[]> {
  const all = await chrome.storage.local.get(null);
  return Object.keys(all)
    .filter((k) => k.startsWith(STORAGE_PREFIX))
    .map((k) => k.slice(STORAGE_PREFIX.length));
}

export async function deleteRecordingFromStorage(name: string): Promise<void> {
  const key = `${STORAGE_PREFIX}${name}`;
  await chrome.storage.local.remove(key);
}
