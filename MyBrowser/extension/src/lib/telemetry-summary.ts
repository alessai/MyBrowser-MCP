import {
  isTraceContextV1,
  type ExtensionTelemetryErrorCategory,
  type ExtensionTraceSummaryV1,
  type TraceContextV1,
} from './protocol';

const RESPONSE_ALLOWANCE_MS = 5_000;
const MAX_TIMING_MS = 86_400_000;
const REQUEST_ID = /^[A-Za-z0-9_-]{1,128}$/;

export type TelemetryStateSignal = keyof NonNullable<ExtensionTraceSummaryV1['stateSignals']>;

export interface ExtensionSummaryBuilderOptions {
  trace: TraceContextV1;
  extensionRequestId: string;
  timeoutMs: number;
  offscreenReceivedAtEpochMs?: number;
  backgroundReceivedAtEpochMs: number;
  monotonicNow?: () => number;
}

export interface ExtensionTelemetrySummaryBuilder {
  markQueueEnqueued(atEpochMs: number): void;
  markQueueStarted(atEpochMs: number): void;
  markHandlerStarted(): void;
  markHandlerFinished(): void;
  setResolvedTabId(tabId: number): void;
  markStateSignal(signal: TelemetryStateSignal): void;
  build(errorCategory?: ExtensionTelemetryErrorCategory): ExtensionTraceSummaryV1;
}

function elapsed(start: number | undefined, end: number, cap: number): number | undefined {
  if (start === undefined || !Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined;
  return Math.min(cap, end - start);
}

class SummaryBuilder implements ExtensionTelemetrySummaryBuilder {
  private readonly cap: number;
  private queueEnqueuedAt?: number;
  private queueWaitMs?: number;
  private handlerStartedAt?: number;
  private handlerMs?: number;
  private resolvedTabId?: number;
  private readonly stateSignals: Partial<Record<TelemetryStateSignal, boolean>> = {};

  constructor(
    private readonly options: ExtensionSummaryBuilderOptions,
    private readonly now: () => number,
  ) {
    const timeout = Number.isFinite(options.timeoutMs) ? Math.max(0, options.timeoutMs) : 0;
    this.cap = Math.min(MAX_TIMING_MS, timeout + RESPONSE_ALLOWANCE_MS);
  }

  markQueueEnqueued(atEpochMs: number): void {
    if (this.queueEnqueuedAt === undefined && Number.isFinite(atEpochMs)) this.queueEnqueuedAt = atEpochMs;
  }

  markQueueStarted(atEpochMs: number): void {
    if (this.queueWaitMs === undefined) this.queueWaitMs = elapsed(this.queueEnqueuedAt, atEpochMs, this.cap);
  }

  markHandlerStarted(): void {
    if (this.handlerStartedAt === undefined) this.handlerStartedAt = this.now();
  }

  markHandlerFinished(): void {
    if (this.handlerMs === undefined) this.handlerMs = elapsed(this.handlerStartedAt, this.now(), this.cap);
  }

  setResolvedTabId(tabId: number): void {
    if (Number.isInteger(tabId) && tabId >= 0 && tabId <= 2_147_483_647) this.resolvedTabId = tabId;
  }

  markStateSignal(signal: TelemetryStateSignal): void {
    this.stateSignals[signal] = true;
  }

  build(errorCategory?: ExtensionTelemetryErrorCategory): ExtensionTraceSummaryV1 {
    const stateSignals = Object.keys(this.stateSignals).length > 0
      ? Object.freeze({ ...this.stateSignals })
      : undefined;
    return Object.freeze({
      schemaVersion: 1,
      traceId: this.options.trace.traceId,
      transportSpanId: this.options.trace.transportSpanId,
      extensionRequestId: this.options.extensionRequestId,
      ...(elapsed(
        this.options.offscreenReceivedAtEpochMs,
        this.options.backgroundReceivedAtEpochMs,
        this.cap,
      ) === undefined ? {} : {
        offscreenReceivedToBackgroundMs: elapsed(
          this.options.offscreenReceivedAtEpochMs,
          this.options.backgroundReceivedAtEpochMs,
          this.cap,
        ),
      }),
      ...(this.queueWaitMs === undefined ? {} : { queueWaitMs: this.queueWaitMs }),
      ...(this.handlerMs === undefined ? {} : { handlerMs: this.handlerMs }),
      ...(this.resolvedTabId === undefined ? {} : { resolvedTabId: this.resolvedTabId }),
      ...(stateSignals === undefined ? {} : { stateSignals }),
      ...(errorCategory === undefined ? {} : { errorCategory }),
    });
  }
}

export function createExtensionTelemetrySummaryBuilder(
  options: ExtensionSummaryBuilderOptions,
): ExtensionTelemetrySummaryBuilder | undefined {
  if (!isTraceContextV1(options.trace) || !REQUEST_ID.test(options.extensionRequestId)) return undefined;
  return new SummaryBuilder(options, options.monotonicNow ?? (() => performance.now()));
}

function exactCode(error: unknown): string | undefined {
  try {
    if (typeof error === 'string') return error;
    if (typeof error !== 'object' || error === null) return undefined;
    for (const field of ['code', 'message']) {
      const descriptor = Object.getOwnPropertyDescriptor(error, field);
      if (descriptor && 'value' in descriptor && typeof descriptor.value === 'string') return descriptor.value;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function telemetryErrorCategory(error: unknown): ExtensionTelemetryErrorCategory {
  switch (exactCode(error)) {
    case 'REQUEST_EXPIRED': return 'request_expired';
    case 'QUEUE_OVERLOADED': return 'queue_overloaded';
    case 'TAB_CLOSED': return 'tab_not_found';
    case 'SESSION_CLOSED':
    case 'SESSION_FINALIZED':
    case 'SESSION_NOT_REGISTERED': return 'session_closed';
    case 'EXTENSION_WORKER_RESTARTED': return 'worker_restarted';
    case 'PROTOCOL_VERSION_MISMATCH':
    case 'AUTH_ROLE_VIOLATION': return 'authorization_denied';
    case 'INVALID_ARGUMENTS': return 'invalid_arguments';
    case 'BROWSER_NOT_FOUND': return 'browser_not_found';
    case 'NOT_CONNECTED': return 'not_connected';
    default: return 'extension_tool_failed';
  }
}

export interface OffscreenToolFrame { raw: string; receivedAtEpochMs?: number }

export function createOffscreenToolFrame(raw: string, now: () => number = Date.now): OffscreenToolFrame {
  return { raw, receivedAtEpochMs: now() };
}

function ownData(value: object, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

export function readOffscreenToolFrame(value: unknown): OffscreenToolFrame | undefined {
  if (typeof value === 'string') return { raw: value };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const raw = ownData(value, 'raw');
  if (typeof raw !== 'string') return undefined;
  const received = ownData(value, 'receivedAtEpochMs');
  return {
    raw,
    ...(typeof received === 'number' && Number.isFinite(received) ? { receivedAtEpochMs: received } : {}),
  };
}

export function attachExtensionTelemetry<T extends { requestId: string }>(
  payload: T,
  builder: ExtensionTelemetrySummaryBuilder,
  errorCategory?: ExtensionTelemetryErrorCategory,
): T & { telemetry: ExtensionTraceSummaryV1 } {
  return { ...payload, telemetry: builder.build(errorCategory) };
}
