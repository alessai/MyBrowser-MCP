import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { isDeepStrictEqual } from "node:util";
import {
  normalizeRecordingName,
  RECORDING_RESERVATION_LEASE_MS,
  type IStateManager,
} from "../state-manager.js";
import type { Tool } from "./types.js";

const RECORDINGS_DIR = join(homedir(), ".mybrowser", "recordings");
export { RECORDING_RESERVATION_LEASE_MS } from "../state-manager.js";

export interface RecordingFileOps {
  mkdirSync: typeof mkdirSync;
  chmodSync: typeof chmodSync;
  statSync: typeof statSync;
  lstatSync: typeof lstatSync;
  openSync: typeof openSync;
  readFileSync: typeof readFileSync;
  writeFileSync: typeof writeFileSync;
  fchmodSync: typeof fchmodSync;
  fstatSync: typeof fstatSync;
  fsyncSync: typeof fsyncSync;
  closeSync: typeof closeSync;
  unlinkSync: typeof unlinkSync;
}

const RECORDING_FILE_OPS: RecordingFileOps = {
  mkdirSync,
  chmodSync,
  statSync,
  lstatSync,
  openSync,
  readFileSync,
  writeFileSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  closeSync,
  unlinkSync,
};

function ensurePrivateDirectory(
  path: string,
  ops: RecordingFileOps = RECORDING_FILE_OPS,
): void {
  ops.mkdirSync(path, { recursive: true, mode: 0o700 });
  ops.chmodSync(path, 0o700);
  const stats = ops.statSync(path);
  if (!stats.isDirectory()) {
    throw new Error(`Private recording path is not a directory: ${path}`);
  }
  if ((stats.mode & 0o777) !== 0o700) {
    throw new Error(`Private recording directory must have exact mode 0700: ${path}`);
  }
}

function ensureRecordingsDir(
  recordingsDir = RECORDINGS_DIR,
  ops: RecordingFileOps = RECORDING_FILE_OPS,
): void {
  ensurePrivateDirectory(dirname(recordingsDir), ops);
  ensurePrivateDirectory(recordingsDir, ops);
}

// --- MCP Tools ---

const RecordStartArgs = z.object({
  name: z.string().trim().min(1).describe("Name for this recording session (e.g. 'checkout_flow')"),
  tabId: z.number().int().min(1).max(2_147_483_647).describe("Tab where recording starts"),
}).strict();

const RecordStopArgs = z.object({}).strict();

const RecordListArgs = z.object({}).strict();

export const MAX_RECORDING_STEPS = 1_000;
const MAX_RECORDING_BYTES = 2 * 1024 * 1024;
export const MAX_RECORDING_TIMESTAMP_MS = 8_640_000_000_000_000;
export const MAX_RECORDED_DURATION_MS = 2_147_483_647;
export const MAX_REQUIRED_VARIABLES = 100_000;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneExactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneExactValue);
  if (!isPlainRecord(value)) return value;
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of Object.getOwnPropertyNames(value)) {
    Object.defineProperty(result, key, {
      value: cloneExactValue(value[key]),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return result;
}

const ExactArgsSchema = z.custom<Record<string, unknown>>(isPlainRecord, {
  message: "Expected a plain argument object",
});

const RequiredVariableSchema = z.object({
  name: z.string().regex(/^(input|form|select|navigation|clipboard)_\d+$/),
  source: z.enum(["text", "form", "select", "navigation", "clipboard"]),
  hint: z.string().regex(/^(text|form|select|navigation|clipboard)_input_\d+$/).optional(),
}).strict().superRefine((variable, context) => {
  const match = /^(input|form|select|navigation|clipboard)_(\d+)$/.exec(variable.name);
  if (!match) return;
  const expectedSource = match[1] === "input" ? "text" : match[1];
  if (variable.source !== expectedSource
    || (variable.hint !== undefined && variable.hint !== `${expectedSource}_input_${match[2]}`)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid generic variable metadata" });
  }
});

const RecordedStepSchema = z.object({
  action: z.string().min(1),
  args: ExactArgsSchema,
  timestamp: z.number().int().nonnegative().max(MAX_RECORDING_TIMESTAMP_MS),
  durationMs: z.number().finite().nonnegative().max(MAX_RECORDED_DURATION_MS),
  url: z.string(),
}).strict();

export const RecordingSchema = z.object({
  name: z.string().min(1),
  startedAt: z.number().int().nonnegative().max(MAX_RECORDING_TIMESTAMP_MS),
  stoppedAt: z.number().int().nonnegative().max(MAX_RECORDING_TIMESTAMP_MS),
  url: z.string(),
  steps: z.array(RecordedStepSchema).max(MAX_RECORDING_STEPS),
  requiredVariables: z.array(RequiredVariableSchema).max(MAX_REQUIRED_VARIABLES),
}).strict();

export type SanitizedRecording = z.infer<typeof RecordingSchema>;

type VariableSource = "text" | "form" | "select" | "navigation" | "clipboard";

type RecordingStringKind = "safe" | VariableSource;
type RecordingArgumentType = "array" | "boolean" | "number" | "object" | "string";

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

const RECORDABLE_ACTIONS = new Set(Object.keys(SERVER_RECORDING_STRING_METADATA));

function isSanitizedHttpUrl(value: string): boolean {
  if (value.length > 8_192) return false;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) return false;
    return (url.protocol === "http:" || url.protocol === "https:")
      && `${url.origin}${url.pathname}` === value;
  } catch {
    return false;
  }
}

function isSanitizedPageUrl(value: string): boolean {
  return value === "" || isSanitizedHttpUrl(value);
}

function validatePlaceholder(
  value: unknown,
  source: VariableSource,
  variables: ReadonlyMap<string, VariableSource>,
  used: Set<string>,
): boolean {
  if (typeof value !== "string") return false;
  const match = /^\{\{((input|form|select|navigation|clipboard)_\d+)\}\}$/.exec(value);
  if (!match) return false;
  const actualSource = match[2] === "input" ? "text" : match[2];
  if (actualSource !== source || variables.get(match[1]!) !== source) return false;
  if (used.has(match[1]!)) return false;
  used.add(match[1]!);
  return true;
}

function wildcardPath(path: string): string {
  return path.replace(/\.\d+(?=\.|$)/g, ".*").replace(/^(fields)\.[^.]+$/, "$1.*");
}

function matchesArgumentType(value: unknown, type: RecordingArgumentType): boolean {
  if (type === "string") return typeof value === "string";
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "boolean") return typeof value === "boolean";
  if (type === "array") return Array.isArray(value);
  return isPlainRecord(value);
}

function validateArgumentValues(
  value: unknown,
  path: string,
  classifications: Readonly<Record<string, RecordingStringKind>>,
  argumentTypes: Readonly<Record<string, RecordingArgumentType>>,
  numericBounds: Readonly<Record<string, RecordingNumericConstraint>>,
  variables: ReadonlyMap<string, VariableSource>,
  used: Set<string>,
): boolean {
  const normalizedPath = wildcardPath(path);
  const expectedType = argumentTypes[path] ?? argumentTypes[normalizedPath];
  if (!expectedType || !matchesArgumentType(value, expectedType)) return false;
  if (typeof value === "number") {
    const bounds = numericBounds[path] ?? numericBounds[normalizedPath];
    if (!bounds
      || value < bounds.min
      || value > bounds.max
      || (bounds.integer && !Number.isSafeInteger(value))) return false;
  }
  if (typeof value === "string") {
    const kind = classifications[path] ?? classifications[normalizedPath];
    if (!kind) return false;
    if (kind === "safe") return true;
    if (kind === "navigation" && isSanitizedHttpUrl(value)) return true;
    return validatePlaceholder(value, kind, variables, used);
  }
  if (Array.isArray(value)) {
    return value.every((entry, index) => validateArgumentValues(
      entry,
      path ? `${path}.${index}` : `${index}`,
      classifications,
      argumentTypes,
      numericBounds,
      variables,
      used,
    ));
  }
  if (isPlainRecord(value)) {
    return Object.entries(value).every(([key, entry]) => {
      const childPath = path === "fields" ? "fields.*" : path ? `${path}.${key}` : key;
      return validateArgumentValues(
        entry, childPath, classifications, argumentTypes, numericBounds, variables, used,
      );
    });
  }
  return true;
}

function hasSanitizedActionData(recording: SanitizedRecording): boolean {
  if (!isSanitizedPageUrl(recording.url)) return false;
  if (!recording.requiredVariables.every((variable, index) => {
    const match = /_(\d+)$/.exec(variable.name);
    return match !== null && Number(match[1]) === index + 1;
  })) return false;
  const variables = new Map<string, VariableSource>(
    recording.requiredVariables.map((variable) => [variable.name, variable.source]),
  );
  if (variables.size !== recording.requiredVariables.length) return false;
  const used = new Set<string>();

  for (const step of recording.steps) {
    if (!RECORDABLE_ACTIONS.has(step.action) || !isSanitizedPageUrl(step.url)) return false;
    const args = step.args;
    const classifications = SERVER_RECORDING_STRING_METADATA[
      step.action as keyof typeof SERVER_RECORDING_STRING_METADATA
    ];
    const argumentTypes = SERVER_RECORDING_ARGUMENT_TYPES[
      step.action as keyof typeof SERVER_RECORDING_ARGUMENT_TYPES
    ];
    const numericBounds = SERVER_RECORDING_NUMERIC_BOUNDS[
      step.action as keyof typeof SERVER_RECORDING_NUMERIC_BOUNDS
    ];
    if (!validateArgumentValues(
      args, "", classifications, argumentTypes, numericBounds, variables, used,
    )) return false;
    if (step.action === "browser_type" && typeof args.text !== "string") return false;
    if (step.action === "browser_fill_form") {
      if (typeof args.fields !== "object" || args.fields === null || Array.isArray(args.fields)) return false;
      if (!Object.values(args.fields).every((value) => typeof value === "string")) return false;
    }
    if (step.action === "browser_select_option") {
      if (!Array.isArray(args.values) || !args.values.every((value) => typeof value === "string")) return false;
    }
    if (step.action === "browser_navigate") {
      const url = args.url;
      if (typeof url !== "string") return false;
      if (!isSanitizedHttpUrl(url) && !/^\{\{navigation_\d+\}\}$/.test(url)) return false;
    }
  }

  return used.size === variables.size
    && [...variables.keys()].every((name) => used.has(name));
}

export function sanitizeRecording(recording: unknown): SanitizedRecording {
  if (typeof recording === "object" && recording !== null && "variables" in recording) {
    throw new Error("Legacy recording variables are not accepted");
  }
  if (Buffer.byteLength(JSON.stringify(recording), "utf8") > MAX_RECORDING_BYTES) {
    throw new Error("Recording exceeds the byte limit");
  }
  const exactInput = cloneExactValue(recording);
  const exactSteps = isPlainRecord(exactInput) && Array.isArray(exactInput.steps)
    ? exactInput.steps
    : [];
  const schemaInput = isPlainRecord(exactInput)
    ? {
        ...exactInput,
        steps: exactSteps.map((step) => (
          isPlainRecord(step) ? { ...step, args: {} } : step
        )),
      }
    : exactInput;
  const schemaResult = RecordingSchema.parse(schemaInput);
  const parsed: SanitizedRecording = {
    ...schemaResult,
    steps: schemaResult.steps.map((step, index) => ({
      ...step,
      args: isPlainRecord(exactSteps[index]) && isPlainRecord(exactSteps[index].args)
        ? exactSteps[index].args
        : step.args,
    })),
  };
  if (!hasSanitizedActionData(parsed)) {
    throw new Error("Recording contains unsanitized action data");
  }
  if (normalizeRecordingName(parsed.name) !== parsed.name) {
    throw new Error("Invalid recording name");
  }
  return parsed;
}

const RecordStopResultSchema = z.object({
  extensionSaved: z.boolean(),
  serverSaved: z.boolean(),
  recording: z.unknown(),
  error: z.enum([
    "SERVER_PERSIST_FAILED",
    "LOCAL_RECORDING_CONFLICT",
    "LOCAL_PERSIST_FAILED",
    "ACTIVE_STATE_PERSIST_FAILED",
    "ACTIVE_STATE_CLEANUP_FAILED",
  ]).optional(),
}).strict();

export function sanitizeRecordStopResult(value: unknown): z.infer<typeof RecordStopResultSchema> & {
  recording: SanitizedRecording;
} {
  const parsed = RecordStopResultSchema.parse(value);
  return { ...parsed, recording: sanitizeRecording(parsed.recording) };
}

export function createRecordingTools(
  stateManager: IStateManager,
  getSessionId: () => string,
  options: { recordingsDir?: string } = {},
): { recordStart: Tool; recordStop: Tool; recordList: Tool } {
  let activeRecordingName: string | undefined;
  let failedStartCleanupPending = false;
  let pendingStop: {
    result: ReturnType<typeof sanitizeRecordStopResult>;
    serverPersisted: boolean;
  } | undefined;
  let lifecycleTail: Promise<void> = Promise.resolve();

  const runLifecycleOperation = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = lifecycleTail.then(operation);
    lifecycleTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const releaseActiveRecording = async (): Promise<void> => {
    const name = activeRecordingName;
    if (!name) return;

    const released = await stateManager.releaseRecordingReservation(getSessionId(), name);
    if (released) {
      if (activeRecordingName === name) {
        activeRecordingName = undefined;
        failedStartCleanupPending = false;
      }
      return;
    }

    const stillLive = await stateManager.hasRecordingReservation(getSessionId(), name);
    if (stillLive) throw new Error("Recording reservation release failed");
    if (activeRecordingName === name) {
      activeRecordingName = undefined;
      failedStartCleanupPending = false;
    }
  };

  const finishPendingStop = () => {
    if (!pendingStop) throw new Error("No completed recording is pending cleanup");
    const { result, serverPersisted } = pendingStop;
    const { recording } = result;
    const persistenceStatus = serverPersisted
      ? "Server persistence acknowledged."
      : "Server persistence partial: no durable write was acknowledged.";
    const durationMs = Math.max(0, recording.stoppedAt - recording.startedAt);
    pendingStop = undefined;

    return {
      extensionSaved: result.extensionSaved,
      serverSaved: result.serverSaved,
      recording,
      ...(result.error ? { error: result.error } : {}),
      content: [
        {
          type: "text" as const,
          text: `Recording "${recording.name}" stopped. ${recording.steps.length} steps captured over ${Math.round(durationMs / 1000)}s. ${persistenceStatus}`,
        },
        {
          type: "text" as const,
          text: JSON.stringify(recording, null, 2),
        },
      ],
    };
  };

  const recordStart: Tool = {
    schema: {
      name: "browser_record_start",
      description:
        "Start recording browser actions. All subsequent browser tool calls will be captured as replayable steps until recording is stopped.",
      inputSchema: zodToJsonSchema(RecordStartArgs),
    },
    handle: async (context, params) => {
      const { name, tabId } = RecordStartArgs.parse(params);
      return runLifecycleOperation(async () => {
        const sessionId = getSessionId();
        if (failedStartCleanupPending) await releaseActiveRecording();
        if (activeRecordingName) {
          const currentName = activeRecordingName;
          let stillLive: boolean;
          try {
            stillLive = await stateManager.hasRecordingReservation(sessionId, currentName);
          } catch {
            throw new Error("Recording reservation state unavailable");
          }
          if (stillLive) {
            throw new Error("A recording reservation is already active for this session");
          }
          if (activeRecordingName === currentName) {
            activeRecordingName = undefined;
            failedStartCleanupPending = false;
          }
        }
        const canonicalName = normalizeRecordingName(name);
        const recordingsDir = options.recordingsDir ?? RECORDINGS_DIR;
        if (existsSync(join(recordingsDir, `${canonicalName}.json`))) {
          throw new Error("RECORDING_NAME_CONFLICT: completed recording already exists");
        }
        const reserved = await stateManager.reserveRecording(
          sessionId,
          canonicalName,
          RECORDING_RESERVATION_LEASE_MS,
        );
        if (!reserved.ok) {
          throw new Error(`RECORDING_NAME_CONFLICT: recording name is reserved by session ${reserved.owner}`);
        }
        activeRecordingName = reserved.reservation.name;
        failedStartCleanupPending = true;

        try {
          await context.sendSocketMessage("browser_record_start", {
            name: reserved.reservation.name,
            tabId,
          });
          failedStartCleanupPending = false;
        } catch (error) {
          await releaseActiveRecording();
          throw error;
        }
        return {
          content: [{ type: "text" as const, text: `Recording started: "${reserved.reservation.name}"` }],
        };
      });
    },
  };

  const recordStop: Tool = {
    schema: {
      name: "browser_record_stop",
      description:
        "Stop the current recording session. Returns the recorded steps and reports whether server persistence completed.",
      inputSchema: zodToJsonSchema(RecordStopArgs),
    },
    handle: async (context, params) => {
      RecordStopArgs.parse(params);
      return runLifecycleOperation(async () => {
        if (failedStartCleanupPending) await releaseActiveRecording();
        const sessionId = getSessionId();
        let rawResult: unknown;
        try {
          rawResult = await context.sendSocketMessage("browser_record_stop", {});
        } catch (error) {
          await releaseActiveRecording();
          if (pendingStop) return finishPendingStop();
          throw error;
        }

        if (pendingStop) {
          await releaseActiveRecording();
          return finishPendingStop();
        }

        const rawRecordingName = isPlainRecord(rawResult)
          && isPlainRecord(rawResult.recording)
          && typeof rawResult.recording.name === "string"
          ? rawResult.recording.name
          : undefined;
        if (activeRecordingName && rawRecordingName !== activeRecordingName) {
          throw new Error("Recording result does not match the active reservation");
        }

        try {
          const result = sanitizeRecordStopResult(rawResult);
          const recording = result.recording;
          if (activeRecordingName && recording.name !== activeRecordingName) {
            throw new Error("Recording result does not match the active reservation");
          }

          pendingStop = { result, serverPersisted: false };
          const reservationStillActive = activeRecordingName
            ? await stateManager.hasRecordingReservation(sessionId, activeRecordingName)
            : false;
          pendingStop.serverPersisted = result.serverSaved === true && !reservationStillActive;
          if (reservationStillActive) {
            await releaseActiveRecording();
          } else {
            activeRecordingName = undefined;
          }

          return finishPendingStop();
        } catch (error) {
          if (!pendingStop) await releaseActiveRecording();
          throw error;
        }
      });
    },
  };

  const recordList: Tool = {
    schema: {
      name: "browser_record_list",
      description:
        "List all saved recordings from both extension storage and server filesystem.",
      inputSchema: zodToJsonSchema(RecordListArgs),
    },
    handle: async (context, params) => {
      RecordListArgs.parse(params);
      let extensionRecordings: string[] = [];
      try {
        const extResult = (await context.sendSocketMessage("browser_record_list", {})) as {
          recordings: string[];
        };
        extensionRecordings = extResult.recordings;
      } catch {
        // Extension may not be connected.
      }

      let serverRecordings: string[] = [];
      try {
        ensureRecordingsDir();
        serverRecordings = readdirSync(RECORDINGS_DIR)
          .filter((file) => file.endsWith(".json"))
          .map((file) => file.replace(/\.json$/, ""));
      } catch {
        // Directory may not exist yet.
      }

      const allNames = [...new Set([...extensionRecordings, ...serverRecordings])].sort();
      return {
        content: [{
          type: "text",
          text: allNames.length > 0
            ? `Saved recordings (${allNames.length}):\n${allNames.map((name) => `  - ${name}`).join("\n")}`
            : "No recordings found.",
        }],
      };
    },
  };

  return { recordStart, recordStop, recordList };
}

// --- Server-side persistence (called via acknowledged WS message, not MCP) ---

export class RecordingDirectorySyncError extends Error {
  constructor() {
    super("recording directory sync failed");
    this.name = "RecordingDirectorySyncError";
  }
}

export function isRecordingDirectorySyncError(error: unknown): error is RecordingDirectorySyncError {
  return error instanceof RecordingDirectorySyncError;
}

function syncRecordingDirectory(recordingsDir: string, ops: RecordingFileOps): void {
  let fd: number | undefined;
  let failed = false;
  try {
    const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
    fd = ops.openSync(recordingsDir, fsConstants.O_RDONLY | noFollow);
    ops.fsyncSync(fd);
  } catch {
    failed = true;
  } finally {
    if (fd !== undefined) {
      try {
        ops.closeSync(fd);
      } catch {
        failed = true;
      }
    }
  }
  if (failed) throw new RecordingDirectorySyncError();
}

function verifyExistingRecording(
  sanitized: SanitizedRecording,
  filePath: string,
  ops: RecordingFileOps,
  mismatchError: unknown,
): void {
  const stats = ops.lstatSync(filePath);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`Existing recording artifact must be a regular non-symlink file: ${filePath}`);
  }
  if ((stats.mode & 0o777) !== 0o600) {
    throw new Error(`Existing recording artifact must have exact mode 0600: ${filePath}`);
  }

  const noFollow = typeof fsConstants.O_NOFOLLOW === "number"
    ? fsConstants.O_NOFOLLOW
    : 0;
  const existingFd = ops.openSync(filePath, fsConstants.O_RDONLY | noFollow);
  let verificationFailure: unknown;
  try {
    const descriptorStats = ops.fstatSync(existingFd);
    if (!descriptorStats.isFile()) {
      throw new Error(`Existing recording descriptor must be a regular file: ${filePath}`);
    }
    if ((descriptorStats.mode & 0o777) !== 0o600) {
      throw new Error(`Existing recording descriptor must have exact mode 0600: ${filePath}`);
    }
    if (descriptorStats.dev !== stats.dev || descriptorStats.ino !== stats.ino) {
      throw new Error(`Existing recording artifact changed between lstat and open: ${filePath}`);
    }
    const parsedExisting: unknown = JSON.parse(ops.readFileSync(existingFd, "utf-8"));
    if (!isPlainRecord(parsedExisting) || parsedExisting.name !== sanitized.name) {
      throw mismatchError;
    }
    const existing = sanitizeRecording(parsedExisting);
    if (!isDeepStrictEqual(existing, sanitized)) throw mismatchError;
    ops.fsyncSync(existingFd);
  } catch (verificationError) {
    verificationFailure = verificationError;
  }
  try {
    ops.closeSync(existingFd);
  } catch (closeError) {
    verificationFailure ??= closeError;
  }
  if (verificationFailure) throw verificationFailure;
}

export function saveRecordingToFile(
  recording: unknown,
  recordingsDir = RECORDINGS_DIR,
  fileOps: Partial<RecordingFileOps> = {},
): "created" | "existing-identical" {
  const sanitized = sanitizeRecording(recording);
  const ops = { ...RECORDING_FILE_OPS, ...fileOps };
  ensureRecordingsDir(recordingsDir, ops);
  const filePath = join(recordingsDir, `${normalizeRecordingName(sanitized.name)}.json`);
  let fd: number;
  try {
    fd = ops.openSync(filePath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    verifyExistingRecording(sanitized, filePath, ops, error);
    syncRecordingDirectory(recordingsDir, ops);
    return "existing-identical";
  }

  let persistenceFailure: unknown;
  try {
    ops.fchmodSync(fd, 0o600);
    const descriptorStats = ops.fstatSync(fd);
    if (!descriptorStats.isFile()) {
      throw new Error(`New recording descriptor must be a regular file: ${filePath}`);
    }
    if ((descriptorStats.mode & 0o777) !== 0o600) {
      throw new Error(`New recording descriptor must have exact mode 0600: ${filePath}`);
    }
    ops.writeFileSync(fd, JSON.stringify(sanitized, null, 2) + "\n");
    ops.fsyncSync(fd);
  } catch (writeError) {
    persistenceFailure = writeError;
  }
  try {
    ops.closeSync(fd);
  } catch (closeError) {
    persistenceFailure ??= closeError;
  }
  if (persistenceFailure) {
    try {
      ops.unlinkSync(filePath);
    } catch {
      // Best effort: preserve the original persistence failure.
    }
    throw persistenceFailure;
  }
  syncRecordingDirectory(recordingsDir, ops);
  return "created";
}

export function loadRecordingFromFile(name: string): unknown | null {
  const filePath = join(RECORDINGS_DIR, `${normalizeRecordingName(name)}.json`);
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null; // Corrupt file
  }
}
