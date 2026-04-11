// Compound action sequencer for ULTRA Phase 2.
// Runs in the BACKGROUND (service worker) and orchestrates by delegating
// to existing tool handlers via handleTool — no duplicate implementations.

import type { ToolContext } from './tools';
import { handleTool } from './tools';

export interface ActionStep {
  action: 'click' | 'type' | 'navigate' | 'wait' | 'wait_for' | 'press_key' | 'snapshot' | 'screenshot' | 'select_option' | 'scroll' | 'extract' | 'assert';
  // Element targeting (any combination)
  ref?: string;
  mark?: number;
  selector?: string;
  role?: string;
  name?: string;
  text?: string;
  label?: string;
  // Action-specific params
  url?: string;
  typedText?: string;
  submit?: boolean;
  key?: string;
  time?: number;
  // wait_for params
  condition?: string;    // e.g. 'url_contains', 'element_visible'
  value?: string;        // condition value
  timeout?: number;      // seconds
  pollInterval?: number; // milliseconds
  // select_option
  values?: string[];
  // scroll
  direction?: 'down' | 'up';
  amount?: number;
  // extract
  extractSelector?: string;
  extractFields?: Record<string, string>;
  // assert
  checks?: AssertCheck[];
}

export interface AssertCheck {
  type: string;
  value?: string;
  selector?: string;
  min?: number;
  max?: number;
}

export interface StepResult {
  step: number;
  action: string;
  status: 'success' | 'failed';
  result?: unknown;
  error?: string;
  durationMs: number;
}

export interface ActionResult {
  status: 'completed' | 'failed';
  stepsCompleted: number;
  totalSteps: number;
  results: StepResult[];
  finalSnapshot?: string;
  error?: string;
}

/**
 * Build args for handleTool from a step definition.
 */
function buildToolArgs(step: ActionStep): Record<string, unknown> {
  const args: Record<string, unknown> = {};

  // Element targeting
  if (step.ref) args.ref = step.ref;
  if (step.mark !== undefined) args.mark = step.mark;
  if (step.selector) args.selector = step.selector;
  if (step.role) args.role = step.role;
  if (step.name) args.name = step.name;
  if (step.label) args.label = step.label;

  switch (step.action) {
    case 'click':
      if (step.text) args.matchText = step.text;
      args.element = step.text || step.name || step.label || step.ref || 'element';
      break;

    case 'type':
      args.text = step.typedText ?? '';
      if (step.text) args.matchText = step.text;
      if (step.submit !== undefined) args.submit = step.submit;
      args.element = step.text || step.name || step.label || step.ref || 'field';
      break;

    case 'navigate':
      args.url = step.url ?? '';
      break;

    case 'wait':
      args.time = step.time ?? 1;
      break;

    case 'press_key':
      args.key = step.key ?? '';
      break;

    case 'snapshot':
      args.viewportOnly = true;
      break;

    case 'select_option':
      if (step.text) args.matchText = step.text;
      args.values = step.values ?? [];
      args.element = step.text || step.name || step.label || step.ref || 'dropdown';
      break;

    case 'extract':
      args.selector = step.extractSelector ?? step.selector ?? '';
      args.fields = step.extractFields ?? {};
      break;

    case 'wait_for':
      args.condition = step.condition ?? '';
      args.value = step.value ?? '';
      args.selector = step.selector ?? '';
      // Convert seconds to milliseconds for the handler
      args.timeout = (step.timeout ?? 10) * 1000;
      args.pollInterval = step.pollInterval ?? 500;
      break;

    case 'assert':
      args.checks = step.checks ?? [];
      break;

    case 'screenshot':
      break;

    case 'scroll':
      // Handled specially
      break;
  }

  return args;
}

/**
 * Map step action to tool handler name.
 */
function getToolName(action: string): string | null {
  const map: Record<string, string> = {
    click: 'browser_click',
    type: 'browser_type',
    navigate: 'browser_navigate',
    wait: 'browser_wait',
    wait_for: 'browser_wait_for',
    assert: 'browser_assert',
    press_key: 'browser_press_key',
    snapshot: 'browser_snapshot',
    screenshot: 'browser_screenshot',
    select_option: 'browser_select_option',
    extract: 'browser_extract',
  };
  return map[action] ?? null;
}

/**
 * Execute scroll via keyboard.
 */
async function executeScroll(step: ActionStep, ctx: ToolContext): Promise<unknown> {
  const direction = step.direction ?? 'down';
  const key = direction === 'down' ? 'PageDown' : 'PageUp';
  const amount = step.amount ?? 300;
  const presses = Math.max(1, Math.round(amount / 300));
  for (let i = 0; i < presses; i++) {
    await handleTool('browser_press_key', { key }, ctx);
  }
  return { scrolled: direction, amount };
}

/**
 * Execute a single step by delegating to existing tool handlers.
 * No duplicate wait_for/assert logic — uses the same handlers as standalone tools.
 */
async function executeStep(step: ActionStep, ctx: ToolContext): Promise<unknown> {
  if (step.action === 'scroll') return executeScroll(step, ctx);

  const toolName = getToolName(step.action);
  if (!toolName) throw new Error(`Unsupported action: ${step.action}`);

  const args = buildToolArgs(step);

  // For assert: the handler returns structured results, doesn't throw.
  // We check if assertions passed and throw if not (to stop the sequence).
  if (step.action === 'assert') {
    const result = await handleTool(toolName, args, ctx) as { passed: boolean; results: unknown[] };
    if (!result.passed) {
      throw new Error(`Assertion failed: ${JSON.stringify(result.results)}`);
    }
    return result;
  }

  return handleTool(toolName, args, ctx);
}

/**
 * Run a sequence of action steps.
 */
export async function runActionSequence(
  steps: ActionStep[],
  ctx: ToolContext,
  options: { stopOnError?: boolean } = {},
): Promise<ActionResult> {
  const { stopOnError = true } = options;
  const results: StepResult[] = [];
  let lastSnapshotResult: string | undefined;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const startTime = Date.now();
    let stepResult: StepResult;

    try {
      const result = await executeStep(step, ctx);

      if (step.action === 'snapshot' && typeof result === 'string') {
        lastSnapshotResult = result;
      }

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
          totalSteps: steps.length,
          results,
          error: `Step ${i + 1} (${step.action}) failed: ${errorMsg}`,
        };
      }
      continue;
    }

    results.push(stepResult);
  }

  const successCount = results.filter((r) => r.status === 'success').length;

  return {
    status: successCount === steps.length ? 'completed' : 'failed',
    stepsCompleted: successCount,
    totalSteps: steps.length,
    results,
    finalSnapshot: lastSnapshotResult,
  };
}
