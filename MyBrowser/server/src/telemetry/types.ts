export const TELEMETRY_SCHEMA_VERSION = 1 as const;

export const TELEMETRY_EVENT_TYPES = [
  "run_started",
  "run_stopped",
  "tools_listed",
  "tool_started",
  "tool_completed",
  "tool_failed",
  "transport_started",
  "transport_completed",
  "transport_failed",
  "extension_summary",
  "telemetry_integrity",
  "feedback",
  "writer_health",
] as const;

export type TelemetryEventType = (typeof TELEMETRY_EVENT_TYPES)[number];

export type TelemetryErrorCategory =
  | "invalid_arguments"
  | "authorization_denied"
  | "ownership_denied"
  | "not_connected"
  | "browser_not_found"
  | "tab_not_found"
  | "element_not_found"
  | "timeout"
  | "request_expired"
  | "queue_overloaded"
  | "session_closed"
  | "worker_restarted"
  | "protocol_error"
  | "extension_tool_failed"
  | "tool_request_failed"
  | "storage_failure"
  | "internal_failure"
  | "unknown";

export type TelemetryOutcomeStatus =
  | "success"
  | "error"
  | "timeout"
  | "cancelled"
  | "unknown";

export interface TelemetryConfig {
  enabled: boolean;
  directory: string;
  retentionMs: number;
  maxTotalBytes: number;
  maxFileBytes: number;
  maxEventBytes: number;
}

declare const sanitizedArgumentSummaryBrand: unique symbol;

export interface SanitizedArgumentSummary {
  readonly scalar: Readonly<Record<string, boolean | number | string>>;
  readonly presence: readonly string[];
  readonly counts: Readonly<Record<string, number>>;
  readonly pseudonyms: Readonly<Record<string, string>>;
  readonly droppedFields: number;
  readonly truncated: boolean;
  readonly [sanitizedArgumentSummaryBrand]: true;
}

export interface TelemetryEventBase {
  schemaVersion: typeof TELEMETRY_SCHEMA_VERSION;
  eventId: string;
  runId: string;
  type: TelemetryEventType;
  timestamp: string;
  monotonicOffsetMs: number;
}

export interface CorrelatedEventBase extends TelemetryEventBase {
  sessionPseudonym: string;
  traceId: string;
  rootCallId: string;
}

export interface RunStartedEvent extends TelemetryEventBase {
  type: "run_started";
  processRole: "client";
}

export interface RunStoppedEvent extends TelemetryEventBase {
  type: "run_stopped";
  reason: "shutdown" | "stdin_closed" | "signal" | "unknown";
  droppedEvents: number;
}

export interface ToolsListedEvent extends TelemetryEventBase {
  type: "tools_listed";
  clientName?: string;
  clientVersion?: string;
  toolCount: number;
  schemaDigest: string;
}

export interface ToolStartedEvent extends CorrelatedEventBase {
  type: "tool_started";
  toolName: string;
  arguments?: SanitizedArgumentSummary;
}

export interface ToolCompletedEvent extends CorrelatedEventBase {
  type: "tool_completed";
  toolName: string;
  durationMs: number;
  status: "success";
  stateChanged?: boolean;
}

export interface ToolFailedEvent extends CorrelatedEventBase {
  type: "tool_failed";
  toolName: string;
  durationMs: number;
  status: Exclude<TelemetryOutcomeStatus, "success">;
  errorCategory: TelemetryErrorCategory;
}

export interface TransportStartedEvent extends CorrelatedEventBase {
  type: "transport_started";
  transportSpanId: string;
  action: string;
  browserPseudonym?: string;
}

export interface TransportCompletedEvent extends CorrelatedEventBase {
  type: "transport_completed";
  transportSpanId: string;
  durationMs: number;
  responseSizeBucket: string;
  resultPresent: boolean;
}

export interface TransportFailedEvent extends CorrelatedEventBase {
  type: "transport_failed";
  transportSpanId: string;
  durationMs: number;
  errorCategory: TelemetryErrorCategory;
}

export interface ExtensionSummaryEvent extends CorrelatedEventBase {
  type: "extension_summary";
  transportSpanId: string;
  routeMode: "direct" | "hub";
  extensionRequestPseudonym: string;
  resolvedTabPseudonym?: string;
  offscreenReceivedToBackgroundMs?: number;
  queueWaitMs?: number;
  handlerMs?: number;
  responseSerializeMs?: number;
  errorCategory?: TelemetryErrorCategory;
}

export interface TelemetryIntegrityEvent extends CorrelatedEventBase {
  type: "telemetry_integrity";
  transportSpanId: string;
  reason: "malformed" | "oversized" | "mismatched_trace" | "unsupported_version";
  sizeBucket: string;
}

export interface FeedbackEvent extends TelemetryEventBase {
  type: "feedback";
  targetRunId: string;
  targetCallId: string;
  label: "mistake" | "expected" | "unclear";
  notePseudonym?: string;
}

export interface WriterHealthEvent extends TelemetryEventBase {
  type: "writer_health";
  state: "dropping" | "disabled" | "recovered";
  reason: "queue_full" | "event_oversized" | "filesystem" | "serialization";
  droppedEvents: number;
}

export type TelemetryEvent =
  | RunStartedEvent
  | RunStoppedEvent
  | ToolsListedEvent
  | ToolStartedEvent
  | ToolCompletedEvent
  | ToolFailedEvent
  | TransportStartedEvent
  | TransportCompletedEvent
  | TransportFailedEvent
  | ExtensionSummaryEvent
  | TelemetryIntegrityEvent
  | FeedbackEvent
  | WriterHealthEvent;
