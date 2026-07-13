// Replayer: preflighted, single-tab playback with runtime-only substitutions.

import type { RecordedStep, Recording, ReplayToken } from './recorder';
import type { ToolContext } from './tools';
import { handleTool } from './tools';
import type { StepResult } from './action-sequencer';
import { isRecordableToolName, type ToolName } from './tool-metadata';
import { parameterizeArgs } from './recording-parameterizer';

export type { StepResult };

const MAX_CHROME_TAB_ID = 2_147_483_647;
const PLACEHOLDER = /\{\{([a-zA-Z0-9_]+)\}\}/g;
const UNSUPPORTED_TAB_ACTIONS = new Set([
  'new_tab',
  'select_tab',
  'close_tab',
  'browser_new_tab',
  'browser_select_tab',
  'browser_close_tab',
]);

export interface ReplayOptions {
  recording: Recording;
  tabId: number;
  variables?: Record<string, string>;
  speed?: number;          // 0 = as fast as possible, 1 = original timing, 2 = 2x speed
  stopOnError?: boolean;
  startFromStep?: number;  // 1-based
  stopAtStep?: number;     // 1-based
  beginReplay?: () => ReplayToken;
  endReplay?: (token: ReplayToken) => void;
}

export interface ReplayResult {
  status: 'completed' | 'failed' | 'stopped';
  stepsCompleted: number;
  totalSteps: number;
  results: StepResult[];
  failedStep?: number;
  error?: string;
}

function invalidRecording(): never {
  throw new Error('RECORDING_INVALID');
}

function isSafeContainer(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return Array.isArray(value)
    ? prototype === Array.prototype
    : prototype === Object.prototype || prototype === null;
}

function runtimeVariables(variables: Record<string, string> | undefined): Map<string, string> {
  const result = new Map<string, string>();
  if (variables === undefined) return result;
  if (typeof variables !== 'object'
    || variables === null
    || Array.isArray(variables)
    || !isSafeContainer(variables)) {
    invalidRecording();
  }
  if (Object.getOwnPropertySymbols(variables)
    .some((symbol) => Object.getOwnPropertyDescriptor(variables, symbol)?.enumerable)) {
    invalidRecording();
  }
  for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(variables))) {
    if (!descriptor.enumerable) continue;
    if (!('value' in descriptor) || typeof descriptor.value !== 'string') invalidRecording();
    result.set(name, descriptor.value);
  }
  return result;
}

function substituteString(
  value: string,
  variables: ReadonlyMap<string, string>,
): string {
  PLACEHOLDER.lastIndex = 0;
  const residue = value.replace(PLACEHOLDER, '');
  if (residue.includes('{{') || residue.includes('}}')) invalidRecording();
  PLACEHOLDER.lastIndex = 0;
  return value.replace(PLACEHOLDER, (_placeholder, name: string) => {
    const supplied = variables.get(name);
    if (supplied === undefined && !variables.has(name)) invalidRecording();
    return supplied ?? '';
  });
}

function collectPlaceholders(
  value: unknown,
  names: Set<string>,
  active = new WeakSet<object>(),
): void {
  if (typeof value === 'string') {
    PLACEHOLDER.lastIndex = 0;
    const residue = value.replace(PLACEHOLDER, '');
    if (residue.includes('{{') || residue.includes('}}')) invalidRecording();
    PLACEHOLDER.lastIndex = 0;
    for (const match of value.matchAll(PLACEHOLDER)) names.add(match[1]!);
    return;
  }
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalidRecording();
    return;
  }
  if (typeof value !== 'object' || !isSafeContainer(value) || active.has(value)) {
    invalidRecording();
  }
  if (Object.getOwnPropertySymbols(value)
    .some((symbol) => Object.getOwnPropertyDescriptor(value, symbol)?.enumerable)) {
    invalidRecording();
  }
  active.add(value);
  try {
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
      if (!descriptor.enumerable) continue;
      if (!('value' in descriptor)) invalidRecording();
      collectPlaceholders(descriptor.value, names, active);
    }
  } finally {
    active.delete(value);
  }
}

function validateLiteralActions(recording: unknown): void {
  if (typeof recording !== 'object' || recording === null || Array.isArray(recording)) {
    invalidRecording();
  }
  const stepsDescriptor = Object.getOwnPropertyDescriptor(recording, 'steps');
  if (!stepsDescriptor || !('value' in stepsDescriptor) || !Array.isArray(stepsDescriptor.value)) {
    invalidRecording();
  }
  let malformed = false;
  let unsupported = false;
  for (let index = 0; index < stepsDescriptor.value.length; index += 1) {
    const stepDescriptor = Object.getOwnPropertyDescriptor(stepsDescriptor.value, String(index));
    if (!stepDescriptor || !('value' in stepDescriptor)
      || typeof stepDescriptor.value !== 'object'
      || stepDescriptor.value === null
      || Array.isArray(stepDescriptor.value)) {
      malformed = true;
      continue;
    }
    const actionDescriptor = Object.getOwnPropertyDescriptor(stepDescriptor.value, 'action');
    if (!actionDescriptor || !('value' in actionDescriptor) || typeof actionDescriptor.value !== 'string') {
      malformed = true;
      continue;
    }
    if (UNSUPPORTED_TAB_ACTIONS.has(actionDescriptor.value)) unsupported = true;
    else if (!isRecordableToolName(actionDescriptor.value)) malformed = true;
  }
  if (unsupported) throw new Error('RECORDING_UNSUPPORTED_MULTI_TAB');
  if (malformed) invalidRecording();
}

function cloneReplayValue(
  value: unknown,
  variables: ReadonlyMap<string, string>,
  substituteStrings: boolean,
  active = new WeakSet<object>(),
): unknown {
  if (typeof value === 'string') return substituteStrings ? substituteString(value, variables) : value;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalidRecording();
    return value;
  }
  if (typeof value !== 'object' || !isSafeContainer(value) || active.has(value)) {
    invalidRecording();
  }
  if (Object.getOwnPropertySymbols(value)
    .some((symbol) => Object.getOwnPropertyDescriptor(value, symbol)?.enumerable)) {
    invalidRecording();
  }

  active.add(value);
  try {
    const clone: unknown[] | Record<string, unknown> = Array.isArray(value)
      ? []
      : Object.create(null) as Record<string, unknown>;
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (!descriptor.enumerable) continue;
      if (!('value' in descriptor)) invalidRecording();
      Object.defineProperty(clone, key, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: cloneReplayValue(descriptor.value, variables, substituteStrings, active),
      });
    }
    return clone;
  } finally {
    active.delete(value);
  }
}

function validateReplayStepArguments(steps: RecordedStep[]): void {
  for (const step of steps) {
    try {
      parameterizeArgs(step.action as ToolName, step.args, { nextVariable: 1 });
    } catch {
      invalidRecording();
    }
  }
}

function cloneReplayStep(
  step: RecordedStep,
  variables: ReadonlyMap<string, string>,
): RecordedStep {
  const clone = Object.create(null) as Record<string, unknown>;
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(step))) {
    if (!descriptor.enumerable) continue;
    if (!('value' in descriptor)) invalidRecording();
    Object.defineProperty(clone, key, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: cloneReplayValue(descriptor.value, variables, key === 'args'),
    });
  }
  return clone as unknown as RecordedStep;
}

function validatePreparedSteps(value: unknown): asserts value is RecordedStep[] {
  if (!Array.isArray(value)) invalidRecording();
  for (const candidate of value) {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
      invalidRecording();
    }
    const step = candidate as Record<string, unknown>;
    if (!isRecordableToolName(step.action)
      || typeof step.args !== 'object'
      || step.args === null
      || Array.isArray(step.args)
      || typeof step.timestamp !== 'number'
      || !Number.isFinite(step.timestamp)
      || typeof step.durationMs !== 'number'
      || !Number.isFinite(step.durationMs)
      || step.durationMs < 0
      || typeof step.url !== 'string') {
      invalidRecording();
    }
  }
}

/**
 * Reject incompatible recordings, collect step-argument placeholders, then
 * return substituted step clones. Source data and runtime variables are untouched.
 */
export function preflightReplay(
  recording: Recording,
  variables?: Record<string, string>,
): RecordedStep[] {
  try {
    validateLiteralActions(recording);
    validatePreparedSteps(recording.steps);
    validateReplayStepArguments(recording.steps);
    const supplied = runtimeVariables(variables);
    const placeholders = new Set<string>();
    for (const step of recording.steps) collectPlaceholders(step.args, placeholders);
    const missing = [...placeholders].filter((name) => !supplied.has(name)).sort();
    if (missing.length > 0) {
      throw new Error(`REPLAY_VARIABLES_MISSING: ${missing.join(',')}`);
    }
    const steps = recording.steps.map((step) => cloneReplayStep(step, supplied));
    validatePreparedSteps(steps);
    return steps;
  } catch (error) {
    if (error instanceof Error && (
      error.message === 'RECORDING_UNSUPPORTED_MULTI_TAB'
      || error.message === 'RECORDING_INVALID'
      || error.message.startsWith('REPLAY_VARIABLES_MISSING: ')
    )) throw error;
    return invalidRecording();
  }
}

function validateStepRange(
  totalSteps: number,
  startFromStep: number | undefined,
  stopAtStep: number | undefined,
): { startIdx: number; endIdx: number } {
  if (startFromStep !== undefined && (
    !Number.isSafeInteger(startFromStep) || startFromStep < 1 || startFromStep > totalSteps
  )) throw new Error('REPLAY_START_STEP_OUT_OF_BOUNDS');
  if (stopAtStep !== undefined && (
    !Number.isSafeInteger(stopAtStep) || stopAtStep < 1 || stopAtStep > totalSteps
  )) throw new Error('REPLAY_STOP_STEP_OUT_OF_BOUNDS');
  if (startFromStep !== undefined && stopAtStep !== undefined && startFromStep > stopAtStep) {
    throw new Error('REPLAY_STEP_RANGE_INVALID');
  }
  return {
    startIdx: startFromStep === undefined ? 0 : startFromStep - 1,
    endIdx: stopAtStep ?? totalSteps,
  };
}

function ensureReplayActive(ctx: ToolContext): void {
  if (ctx.expiresAt !== undefined && ctx.expiresAt <= Date.now()) {
    throw new Error('REPLAY_CANCELLED');
  }
}

async function delay(ms: number, ctx: ToolContext): Promise<void> {
  if (!Number.isFinite(ms) || ms < 0) throw new Error('REPLAY_TIMING_FAILED');
  const remaining = (ctx.expiresAt ?? Number.POSITIVE_INFINITY) - Date.now();
  if (remaining <= 0 || ms >= remaining) throw new Error('REPLAY_CANCELLED');
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
  ensureReplayActive(ctx);
}

function authorizeStep(step: RecordedStep, tabId: number): Record<string, unknown> {
  Object.defineProperty(step.args, 'tabId', {
    configurable: true,
    enumerable: true,
    writable: true,
    value: tabId,
  });
  return step.args;
}

export async function replayRecording(
  options: ReplayOptions,
  ctx: ToolContext,
): Promise<ReplayResult> {
  const steps = preflightReplay(options.recording, options.variables);
  const totalSteps = steps.length;
  const { startIdx, endIdx } = validateStepRange(
    totalSteps,
    options.startFromStep,
    options.stopAtStep,
  );
  if (!Number.isSafeInteger(options.tabId)
    || options.tabId < 1
    || options.tabId > MAX_CHROME_TAB_ID
    || options.tabId !== ctx.getTabId()) {
    throw new Error('REPLAY_TAB_INVALID');
  }
  const speed = options.speed ?? 0;
  if (!Number.isFinite(speed) || speed < 0 || (options.stopOnError !== undefined
    && typeof options.stopOnError !== 'boolean')) {
    throw new Error('REPLAY_OPTIONS_INVALID');
  }
  const stopOnError = options.stopOnError ?? true;

  if ((options.beginReplay === undefined) !== (options.endReplay === undefined)) {
    throw new Error('REPLAY_OPTIONS_INVALID');
  }
  const results: StepResult[] = [];
  let replayToken: ReplayToken | undefined;
  try {
    replayToken = options.beginReplay?.();
    ensureReplayActive(ctx);

    if (startIdx > 0) {
      const targetStep = steps[startIdx];
      const navUrl = targetStep?.url;
      if (navUrl && !navUrl.startsWith('about:')) {
        try {
          await handleTool('browser_navigate', { url: navUrl, tabId: options.tabId }, ctx);
        } catch {
          ensureReplayActive(ctx);
        }
      }
    }

    for (let i = startIdx; i < endIdx; i++) {
      ensureReplayActive(ctx);
      const currentStep = steps[i]!;
      const args = authorizeStep(currentStep, options.tabId);
      const startedAt = Date.now();

      try {
        await handleTool(currentStep.action, args, ctx);
        results.push({
          step: i + 1,
          action: currentStep.action,
          status: 'success',
          durationMs: Date.now() - startedAt,
        });
      } catch {
        const failed: StepResult = {
          step: i + 1,
          action: currentStep.action,
          status: 'failed',
          error: 'REPLAY_STEP_FAILED',
          durationMs: Date.now() - startedAt,
        };
        results.push(failed);
        if (stopOnError) {
          return {
            status: 'failed',
            stepsCompleted: results.filter((result) => result.status === 'success').length,
            totalSteps,
            results,
            failedStep: i + 1,
            error: 'REPLAY_STEP_FAILED',
          };
        }
      }

      if (speed > 0 && i < endIdx - 1) {
        const nextStep = steps[i + 1]!;
        const gap = nextStep.timestamp - currentStep.timestamp - currentStep.durationMs;
        if (gap > 0) await delay(gap / speed, ctx);
      }
    }

    const successCount = results.filter((result) => result.status === 'success').length;
    const wasPartial = startIdx > 0 || endIdx < totalSteps;
    return {
      status: successCount === results.length
        ? (wasPartial ? 'stopped' : 'completed')
        : 'failed',
      stepsCompleted: successCount,
      totalSteps,
      results,
    };
  } finally {
    if (replayToken !== undefined) options.endReplay?.(replayToken);
  }
}
