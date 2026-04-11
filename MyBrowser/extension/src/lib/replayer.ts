// Replay engine for ULTRA Phase 3.
// Executes recorded sessions with variable substitution and timing control.

import type { Recording, RecordedStep } from './recorder';
import type { ToolContext } from './tools';
import { handleTool } from './tools';
import type { StepResult } from './action-sequencer';

export type { StepResult };

export interface ReplayOptions {
  recording: Recording;
  variables?: Record<string, string>;
  speed?: number;          // 0 = as fast as possible, 1 = original timing, 2 = 2x speed
  stopOnError?: boolean;
  startFromStep?: number;  // 1-based
  stopAtStep?: number;     // 1-based
}

export interface ReplayResult {
  status: 'completed' | 'failed' | 'stopped';
  stepsCompleted: number;
  totalSteps: number;
  results: StepResult[];
  failedStep?: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// Variable substitution
// ---------------------------------------------------------------------------

/**
 * Build a substitution map from recording variables and overrides.
 * Original recording captured certain values (e.g. typed text).
 * If the recording has variables: {username: "admin"} and the replay
 * overrides with {username: "newuser"}, we substitute "admin" -> "newuser"
 * in all string args.
 */
function buildSubstitutionMap(
  recording: Recording,
  overrides?: Record<string, string>,
): Map<string, string> {
  const map = new Map<string, string>();
  if (!recording.variables || !overrides) return map;

  for (const [key, originalValue] of Object.entries(recording.variables)) {
    const newValue = overrides[key];
    if (newValue !== undefined && newValue !== originalValue) {
      map.set(originalValue, newValue);
    }
  }
  return map;
}

/**
 * Apply variable substitutions to step args.
 * Replaces exact string matches and {{variable}} patterns.
 */
function substituteArgs(
  args: Record<string, unknown>,
  substitutions: Map<string, string>,
  variables?: Record<string, string>,
): Record<string, unknown> {
  if (substitutions.size === 0 && !variables) return { ...args };

  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(args)) {
    if (typeof value === 'string') {
      let substituted = value;

      // Replace {{variable}} patterns
      if (variables) {
        substituted = substituted.replace(/\{\{(\w+)\}\}/g, (_match, varName: string) => {
          return variables[varName] ?? _match;
        });
      }

      // Replace exact value matches
      for (const [original, replacement] of substitutions) {
        if (substituted === original) {
          substituted = replacement;
        } else if (substituted.includes(original)) {
          substituted = substituted.split(original).join(replacement);
        }
      }

      result[key] = substituted;
    } else if (Array.isArray(value)) {
      result[key] = value.map((item) => {
        if (typeof item === 'string') {
          let s = item;
          if (variables) {
            s = s.replace(/\{\{(\w+)\}\}/g, (_m, varName: string) => variables[varName] ?? _m);
          }
          for (const [original, replacement] of substitutions) {
            if (s === original) { s = replacement; }
            else if (s.includes(original)) { s = s.split(original).join(replacement); }
          }
          return s;
        } else if (typeof item === 'object' && item !== null) {
          return substituteArgs(item as Record<string, unknown>, substitutions, variables);
        }
        return item;
      });
    } else if (typeof value === 'object' && value !== null) {
      result[key] = substituteArgs(
        value as Record<string, unknown>,
        substitutions,
        variables,
      );
    } else {
      result[key] = value;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Replay execution
// ---------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function replayRecording(
  options: ReplayOptions,
  ctx: ToolContext,
): Promise<ReplayResult> {
  const {
    recording,
    variables,
    speed = 0,
    stopOnError = true,
    startFromStep,
    stopAtStep,
  } = options;

  const steps = recording.steps;
  const totalSteps = steps.length;

  if (totalSteps === 0) {
    return {
      status: 'completed',
      stepsCompleted: 0,
      totalSteps: 0,
      results: [],
    };
  }

  const substitutions = buildSubstitutionMap(recording, variables);
  const results: StepResult[] = [];

  // Determine step range (1-based input, convert to 0-based)
  const startIdx = startFromStep ? Math.max(0, startFromStep - 1) : 0;
  const endIdx = stopAtStep ? Math.min(totalSteps, stopAtStep) : totalSteps;

  // If starting from a later step, navigate to the recorded URL of that step first
  if (startIdx > 0) {
    const targetStep = steps[startIdx];
    const navUrl = targetStep?.url || recording.url;
    if (navUrl && !navUrl.startsWith('about:')) {
      try {
        await handleTool('browser_navigate', { url: navUrl }, ctx);
      } catch {
        // Best-effort navigation
      }
    }
  }

  for (let i = startIdx; i < endIdx; i++) {
    const step = steps[i]!;
    const args = substituteArgs({ ...step.args }, substitutions, variables);
    const startTime = Date.now();

    let stepResult: StepResult;
    try {
      const result = await handleTool(step.action, args, ctx);
      stepResult = {
        step: i + 1,
        action: step.action,
        status: 'success',
        result: result ?? undefined,
        durationMs: Date.now() - startTime,
      };
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      stepResult = {
        step: i + 1,
        action: step.action,
        status: 'failed',
        error: errorMsg,
        durationMs: Date.now() - startTime,
      };

      results.push(stepResult);

      if (stopOnError) {
        return {
          status: 'failed',
          stepsCompleted: results.filter((r) => r.status === 'success').length,
          totalSteps,
          results,
          failedStep: i + 1,
          error: `Step ${i + 1} (${step.action}) failed: ${errorMsg}`,
        };
      }
      // Respect timing even on failure before continuing
      if (speed > 0 && i < endIdx - 1) {
        const nextStep = steps[i + 1];
        if (nextStep) {
          const gap = nextStep.timestamp - step.timestamp - step.durationMs;
          if (gap > 0) await delay(gap / speed);
        }
      }
      continue;
    }

    results.push(stepResult);

    // Respect inter-step timing
    if (speed > 0 && i < endIdx - 1) {
      const nextStep = steps[i + 1];
      if (nextStep) {
        // Gap between this step ending and next step starting
        const gap = nextStep.timestamp - step.timestamp - step.durationMs;
        if (gap > 0) await delay(gap / speed);
      }
    }
  }

  const successCount = results.filter((r) => r.status === 'success').length;
  const wasPartial = startIdx > 0 || endIdx < totalSteps;

  return {
    status: successCount === results.length
      ? (wasPartial ? 'stopped' : 'completed')
      : 'failed',
    stepsCompleted: successCount,
    totalSteps,
    results,
  };
}
