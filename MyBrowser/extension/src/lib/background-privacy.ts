import { recordExtensionIssue } from './diagnostics';
import { isRecordedActionFailure } from './recorder';

export interface ToolFailureMetadata {
  requestId: string;
  toolType: string;
}

export function parseInboundWsFrame(raw: unknown):
  | { ok: true; value: unknown }
  | { ok: false } {
  if (typeof raw === 'string') {
    try {
      return { ok: true, value: JSON.parse(raw) as unknown };
    } catch {
      // The frame and parser exception can both contain user input.
    }
  }

  const byteLength = typeof raw === 'string'
    ? new TextEncoder().encode(raw).byteLength
    : 0;
  recordExtensionIssue('ws_message', 'INVALID_JSON', { byteLength }, 'warn');
  console.warn('[MyBrowser] INVALID_JSON', { byteLength });
  return { ok: false };
}

export function reportToolFailure(
  error: unknown,
  metadata: ToolFailureMetadata,
): { responseError: string; category: string; recorded: boolean } {
  const recorded = isRecordedActionFailure(error);
  const category = recorded ? 'RECORDED_TOOL_ACTION_FAILED' : 'TOOL_REQUEST_FAILED';
  recordExtensionIssue('tool_failure', category, {
    requestId: metadata.requestId,
    toolType: metadata.toolType,
    category,
    recorded,
  });
  return {
    responseError: recorded
      ? 'RECORDED_TOOL_ACTION_FAILED'
      : error instanceof Error ? error.message : String(error),
    category,
    recorded,
  };
}
