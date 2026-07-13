import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { Tool } from "./types.js";
import {
  loadRecordingFromFile,
  sanitizeRecording,
  type SanitizedRecording,
} from "./record.js";

const MAX_CHROME_TAB_ID = 2_147_483_647;
const PLACEHOLDER = /\{\{([a-zA-Z0-9_]+)\}\}/g;
const UNSUPPORTED_TAB_ACTIONS = new Set([
  "new_tab",
  "select_tab",
  "close_tab",
  "browser_new_tab",
  "browser_select_tab",
  "browser_close_tab",
]);

const ReplayArgs = z.object({
  name: z.string().trim().min(1).describe("Name of the recording to replay"),
  tabId: z.number().int().min(1).max(MAX_CHROME_TAB_ID)
    .describe("Authorized tab where the recording will replay"),
  variables: z
    .record(z.string())
    .optional()
    .describe("Variable overrides for parameterized replay"),
  speed: z
    .number()
    .finite()
    .nonnegative()
    .optional()
    .default(0)
    .describe(
      "Replay speed multiplier. 0 = fastest, 1 = original timing, 2 = 2x speed",
    ),
  stopOnError: z.boolean().optional().default(true),
  startFromStep: z
    .number()
    .optional()
    .describe("Start replay from this step number (1-based, for debugging)"),
  stopAtStep: z
    .number()
    .optional()
    .describe(
      "Stop replay at this step number (for time-travel debugging)",
    ),
}).strict();

function isSafeContainer(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return Array.isArray(value)
    ? prototype === Array.prototype
    : prototype === Object.prototype || prototype === null;
}

function hasUnsupportedAction(value: unknown, active = new WeakSet<object>()): boolean {
  if (typeof value !== "object" || value === null || active.has(value)) return false;
  active.add(value);
  try {
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (!descriptor.enumerable || !("value" in descriptor)) continue;
      if (key === "action"
        && typeof descriptor.value === "string"
        && UNSUPPORTED_TAB_ACTIONS.has(descriptor.value)) return true;
      if (hasUnsupportedAction(descriptor.value, active)) return true;
    }
    return false;
  } finally {
    active.delete(value);
  }
}

function collectPlaceholders(
  value: unknown,
  names: Set<string>,
  active = new WeakSet<object>(),
): void {
  if (typeof value === "string") {
    PLACEHOLDER.lastIndex = 0;
    const residue = value.replace(PLACEHOLDER, "");
    if (residue.includes("{{") || residue.includes("}}")) throw new Error("RECORDING_INVALID");
    PLACEHOLDER.lastIndex = 0;
    for (const match of value.matchAll(PLACEHOLDER)) names.add(match[1]!);
    return;
  }
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("RECORDING_INVALID");
    return;
  }
  if (typeof value !== "object" || !isSafeContainer(value) || active.has(value)) {
    throw new Error("RECORDING_INVALID");
  }
  if (Object.getOwnPropertySymbols(value)
    .some((symbol) => Object.getOwnPropertyDescriptor(value, symbol)?.enumerable)) {
    throw new Error("RECORDING_INVALID");
  }
  active.add(value);
  try {
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
      if (!descriptor.enumerable) continue;
      if (!("value" in descriptor)) throw new Error("RECORDING_INVALID");
      collectPlaceholders(descriptor.value, names, active);
    }
  } finally {
    active.delete(value);
  }
}

function validateStepRange(
  totalSteps: number,
  startFromStep: number | undefined,
  stopAtStep: number | undefined,
): void {
  if (startFromStep !== undefined && (
    !Number.isSafeInteger(startFromStep) || startFromStep < 1 || startFromStep > totalSteps
  )) throw new Error("REPLAY_START_STEP_OUT_OF_BOUNDS");
  if (stopAtStep !== undefined && (
    !Number.isSafeInteger(stopAtStep) || stopAtStep < 1 || stopAtStep > totalSteps
  )) throw new Error("REPLAY_STOP_STEP_OUT_OF_BOUNDS");
  if (startFromStep !== undefined && stopAtStep !== undefined && startFromStep > stopAtStep) {
    throw new Error("REPLAY_STEP_RANGE_INVALID");
  }
}

function preflightServerReplay(
  recording: unknown,
  variables: Readonly<Record<string, string>> | undefined,
  startFromStep: number | undefined,
  stopAtStep: number | undefined,
): SanitizedRecording {
  try {
    if (hasUnsupportedAction(recording)) {
      throw new Error("RECORDING_UNSUPPORTED_MULTI_TAB");
    }
    const placeholders = new Set<string>();
    collectPlaceholders(recording, placeholders);
    const supplied = new Set(Object.keys(variables ?? {}));
    const missing = [...placeholders].filter((name) => !supplied.has(name)).sort();
    if (missing.length > 0) throw new Error(`REPLAY_VARIABLES_MISSING: ${missing.join(",")}`);
    let sanitized: SanitizedRecording;
    try {
      sanitized = sanitizeRecording(recording);
    } catch {
      throw new Error("RECORDING_INVALID");
    }
    validateStepRange(sanitized.steps.length, startFromStep, stopAtStep);
    return sanitized;
  } catch (error) {
    if (error instanceof Error && (
      error.message === "RECORDING_UNSUPPORTED_MULTI_TAB"
      || error.message === "RECORDING_INVALID"
      || error.message === "REPLAY_START_STEP_OUT_OF_BOUNDS"
      || error.message === "REPLAY_STOP_STEP_OUT_OF_BOUNDS"
      || error.message === "REPLAY_STEP_RANGE_INVALID"
      || error.message.startsWith("REPLAY_VARIABLES_MISSING: ")
    )) throw error;
    throw new Error("RECORDING_INVALID");
  }
}

export function redactReplayArguments(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) return {};
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const result: Record<string, unknown> = {};
    for (const name of [
      "name",
      "tabId",
      "speed",
      "stopOnError",
      "startFromStep",
      "stopAtStep",
    ]) {
      const descriptor = descriptors[name];
      if (descriptor && "value" in descriptor
        && ["string", "number", "boolean"].includes(typeof descriptor.value)) {
        result[name] = descriptor.value;
      }
    }
    const variables = descriptors.variables;
    if (variables && "value" in variables
      && typeof variables.value === "object" && variables.value !== null) {
      result.variableNames = Object.keys(variables.value).sort();
    }
    return result;
  } catch {
    return {};
  }
}

function sanitizeReplayResult(value: unknown, recording: SanitizedRecording): {
  status: "completed" | "failed" | "stopped";
  stepsCompleted: number;
  totalSteps: number;
  results: Array<Record<string, unknown>>;
  failedStep?: number;
  error?: string;
} {
  try {
    const parsed = z.object({
      status: z.enum(["completed", "failed", "stopped"]),
      stepsCompleted: z.number().int().nonnegative(),
      totalSteps: z.literal(recording.steps.length),
      results: z.array(z.unknown()),
      failedStep: z.number().int().positive().max(recording.steps.length).optional(),
      error: z.unknown().optional(),
    }).parse(value);
    const stepResult = z.object({
      step: z.number().int().positive().max(recording.steps.length),
      status: z.enum(["success", "failed"]),
      durationMs: z.number().finite().nonnegative().optional(),
    });
    const results = parsed.results.map((entry) => {
      const candidate = stepResult.safeParse(entry);
      if (!candidate.success) return { status: "failed" };
      const action = recording.steps[candidate.data.step - 1]!.action;
      return {
        step: candidate.data.step,
        action,
        status: candidate.data.status,
        ...(candidate.data.durationMs === undefined
          ? {}
          : { durationMs: candidate.data.durationMs }),
        ...(candidate.data.status === "failed" ? { error: "REPLAY_STEP_FAILED" } : {}),
      };
    });
    return {
      status: parsed.status,
      stepsCompleted: parsed.stepsCompleted,
      totalSteps: parsed.totalSteps,
      results,
      ...(parsed.failedStep === undefined ? {} : { failedStep: parsed.failedStep }),
      ...(parsed.error === undefined ? {} : { error: "REPLAY_FAILED" }),
    };
  } catch {
    throw new Error("REPLAY_FAILED");
  }
}

export const replay: Tool = {
  schema: {
    name: "browser_replay",
    description:
      "Replay a previously recorded browser session on one authorized tab. Supports runtime variables, speed control, and step ranges.",
    inputSchema: zodToJsonSchema(ReplayArgs),
  },
  handle: async (context, params) => {
    const args = ReplayArgs.parse(params);

    let recording = loadRecordingFromFile(args.name);
    if (!recording) {
      try {
        recording = await context.sendSocketMessage("loadRecording", { name: args.name });
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (message.includes("RECORDING_UNSUPPORTED_MULTI_TAB")) {
          throw new Error("RECORDING_UNSUPPORTED_MULTI_TAB");
        }
        if (message.includes("RECORDING_INVALID")) throw new Error("RECORDING_INVALID");
        return {
          content: [{
            type: "text" as const,
            text: `Recording "${args.name}" not found on server or in extension storage.`,
          }],
          isError: true,
        };
      }
    }

    const sanitized = preflightServerReplay(
      recording,
      args.variables,
      args.startFromStep,
      args.stopAtStep,
    );
    let rawResult: unknown;
    try {
      rawResult = await context.sendSocketMessage(
        "browser_replay",
        {
          recording: sanitized,
          tabId: args.tabId,
          variables: args.variables,
          speed: args.speed,
          stopOnError: args.stopOnError,
          startFromStep: args.startFromStep,
          stopAtStep: args.stopAtStep,
        },
        { timeoutMs: 300_000 },
      );
    } catch {
      throw new Error("REPLAY_FAILED");
    }
    const result = sanitizeReplayResult(rawResult, sanitized);

    const summary = [
      `Replay "${args.name}": ${result.status}`,
      `Steps: ${result.stepsCompleted}/${result.totalSteps} completed`,
    ];
    if (result.error) summary.push(`Error: ${result.error}`);
    const variableNames = Object.keys(args.variables ?? {}).sort();
    if (variableNames.length > 0) summary.push(`Variables: ${variableNames.join(", ")}`);

    return {
      content: [
        { type: "text" as const, text: summary.join("\n") },
        { type: "text" as const, text: JSON.stringify(result.results, null, 2) },
      ],
    };
  },
};
