# MyBrowser Internal AI Tool Telemetry Design

**Date:** 2026-07-17
**Status:** Approved for implementation planning
**Scope:** Private internal development devices only

## 1. Purpose

MyBrowser needs enough observability to explain how an AI client uses its browser tools, where a request spends time, why an attempt failed, whether the client repeated an equivalent action, and what recovery eventually worked.

The system will trace observable behavior across:

```text
MCP client -> MyBrowser MCP server -> WebSocket hub -> extension scheduler
           -> browser tool handler -> response -> MCP client
```

It will not claim to collect or reconstruct a model's hidden chain-of-thought. MCP exposes tool requests and results, not private model reasoning. The closest safe substitutes are prior observable calls/results, client identity, optional client-supplied goal metadata, and explicit developer feedback.

## 2. Product decisions

1. Telemetry is **off by default** and enabled explicitly for internal development.
2. Telemetry is stored locally. This design adds no upload, analytics endpoint, or third-party exporter.
3. The Node MCP client process that received the MCP tool call is the only durable writer. A standalone hub never writes traces. The extension returns bounded timing/state metadata over the authenticated protocol and does not retain a telemetry database in Chrome storage.
4. Rich collection still excludes raw secrets and content. Passwords, tokens, cookies, clipboard contents, typed text, form values, uploaded file paths, evaluated code, storage values, page text, HTML, screenshots, console bodies, and network bodies must never enter telemetry memory.
5. Sanitization is tool-aware and allowlist-based. Existing generic diagnostics redaction is not strong enough for this data.
6. Telemetry must not affect authorization, routing, scheduling, recording, replay, tool results, or error semantics.
7. Repeat and mistake classifications are analytical labels, not facts. Only explicit developer feedback may label an event as a confirmed mistake.
8. The first implementation uses versioned JSONL and Node 18 APIs. It does not add a native SQLite dependency.

## 3. Goals

- Correlate one MCP call through direct and hub-proxied extension execution.
- Record client, tool, routing, queue, timing, outcome, and safe state-change metadata.
- Identify exact repeats, semantic repeats, unchanged retries, error retries, oscillating loops, stale-reference patterns, and recovery sequences.
- Preserve enough information to compare failures without retaining sensitive values.
- Support bounded retention, analysis, annotation, export, and purge on a development device.
- Make trace output deterministic and testable with privacy canaries.

## 4. Non-goals

- Hidden chain-of-thought, model activations, or private reasoning.
- Automatic prompt or conversation capture.
- Raw browser session replay.
- Raw WebSocket frame logging.
- Screenshots, page HTML, page text, console messages, request/response bodies, or cookies.
- Public telemetry, user analytics, remote ingestion, or cross-device identity.
- Training-data upload.
- A claim that a repeated call is necessarily erroneous.

## 5. Enablement and configuration

Add these CLI options in `MyBrowser/server/src/index.ts`:

```text
--trace-internal
--trace-dir <path>
--trace-retention-days <days>   default: 14
--trace-max-mb <megabytes>      default: 256
```

Rules:

- `--trace-internal` is required. The other options do not enable tracing by themselves.
- `trace-dir` defaults to `~/.mybrowser/traces`.
- Retention is clamped to 1-90 days.
- Maximum storage is clamped to 16-2048 MiB.
- Standalone hub mode validates and forwards trace metadata but never creates trace files. It requires no trace CLI configuration or HMAC key.
- When tracing is disabled, no trace files are created and protocol requests omit trace metadata.

No extension setting is needed in the first version. The authenticated server request carries a bounded trace context only when tracing is enabled.

## 6. Identity and correlation model

### 6.1 IDs

- `runId`: random identifier created once per Node process start.
- `traceId`: random identifier created for each MCP `tools/call` request.
- `callId`: root call identifier for the MCP request; equal to `traceId` in schema v1.
- `transportRequestId`: ID created by `Context.sendSocketMessageCore()`.
- `extensionRequestId`: hub-generated `hub_N` ID when a request is proxied; equal to `transportRequestId` for direct routing. The extension echoes this ID in its transient summary so the client process can observe the mapping after the hub rewrites the response request ID.
- `eventId`: random identifier for each persisted event.
- `parentEventId`: optional causal link between lifecycle events.

IDs are observational only. They must never participate in role checks, session binding, browser selection, recording ownership, or other authority decisions.

### 6.2 Session and browser pseudonyms

Session IDs, browser IDs, tab IDs, target text, selectors, and URL paths are represented with an HMAC-SHA-256 digest using a per-install key at:

```text
~/.mybrowser/trace-key
```

The key is created with exact mode `0600` inside a `0700` MyBrowser directory. It is never included in traces or exports. HMAC allows repeat correlation without making short values vulnerable to an unkeyed dictionary attack.

The raw numeric tab ID may exist transiently while routing a request, but only its HMAC pseudonym is persisted.

### 6.3 Client identity

Use `Server.getClientVersion()` to populate client name/version after MCP initialization. These fields may be absent.

`modelProvider` and `modelName` remain `null` unless an approved host adapter explicitly supplies them. MyBrowser must not infer a model from process names, prompts, or behavior.

## 7. Protocol additions

Add matching optional types to:

- `MyBrowser/server/src/protocol.ts`
- `MyBrowser/extension/src/lib/protocol.ts`

```ts
interface TraceContextV1 {
  schemaVersion: 1;
  traceId: string;
  callId: string;
}

type TelemetryErrorCategory =
  | 'TOOL_NOT_FOUND'
  | 'OWNERSHIP_DENIED'
  | 'NO_BROWSER'
  | 'TAB_CLOSED'
  | 'ELEMENT_NOT_FOUND'
  | 'REQUEST_EXPIRED'
  | 'QUEUE_OVERLOADED'
  | 'TRANSPORT_TIMEOUT'
  | 'BROWSER_DISCONNECTED'
  | 'SESSION_CLOSED'
  | 'RECORDED_STATE_FAILED'
  | 'RECORDED_TOOL_ACTION_FAILED'
  | 'WORKER_RESTARTED'
  | 'TOOL_REQUEST_FAILED'
  | 'PROTOCOL_REJECTED'
  | 'UNKNOWN_TOOL_FAILURE';

interface SafeTabStateV1 {
  loadStatus?: 'loading' | 'complete';
  active?: boolean;
  incognito?: boolean;
}

interface ExtensionTraceSummaryV1 {
  schemaVersion: 1;
  traceId: string;
  extensionRequestId: string;
  receivedToResolvedMs?: number;
  queueWaitMs?: number;
  executionMs?: number;
  responseBuildMs?: number;
  queueKind: 'tab' | 'session' | 'global' | 'none';
  resolvedTabId?: number;
  beforeTabState?: SafeTabStateV1;
  afterTabState?: SafeTabStateV1;
  tabCountBucket?: '1' | '2-5' | '6-10' | '11+';
  errorCategory?: TelemetryErrorCategory;
  stateChanged: true | false | 'unknown';
  tabChanged?: boolean;
  originChanged?: boolean;
  pathChanged?: boolean;
  loadStatusChanged?: boolean;
}
```

Extend `ToolRequestV2` with optional `trace?: TraceContextV1` and `ToolResponseV2.payload` with optional `telemetry?: ExtensionTraceSummaryV1`.

Compatibility and validation rules:

- These fields are optional and wire-compatible with existing protocol v2 peers.
- Both packages receive executable conformance tests for exact field names, bounds, and malformed values.
- Trace IDs use a strict ASCII grammar and bounded length. Suggested grammar: `^[A-Za-z0-9_-]{16,80}$`.
- Durations must be finite, non-negative, and capped at the request timeout plus a small response allowance.
- The hub validates trace metadata, forwards valid fields, and drops malformed metadata without failing the browser tool.
- The hub never accepts a trace-supplied session, browser, tab, role, timeout, or request ID.
- When rewriting `msg.id` to `hub_N`, the hub preserves the validated `traceId`/`callId` and emits a routing event mapping the two transport IDs.
- The extension echoes telemetry only for the matching trace ID.
- The client process is the sole validator of response telemetry. It validates type, size, trace ID, request ID, durations, and enums before accepting a summary. Malformed or mismatched telemetry is discarded and recorded as a bounded telemetry integrity event without retaining the rejected object.
- The client process validates `extensionRequestId`, compares it with its own `transportRequestId`, and persists only HMAC pseudonyms of both. Equality means direct routing; inequality means hub proxying.
- `resolvedTabId` is transient authenticated transport metadata. The Node process validates and HMAC-pseudonymizes it before event construction; no raw tab ID reaches an event or trace file.

No telemetry field is returned in the MCP tool result.

## 8. Instrumentation points

### 8.1 MCP ingress

In `MyBrowser/server/src/server.ts`, wrap `CallToolRequestSchema` handling with a `TelemetryManager`.

At request start:

- create `traceId`;
- read `server.getClientVersion()`;
- sanitize arguments before any trace event is created;
- compute a semantic argument fingerprint;
- classify tool category and mutability;
- emit `tool_call_started`.

At every return path, including tool-not-found and ownership denial:

- record status and stable error category;
- summarize the result without persisting result content;
- emit `tool_call_completed`.

Use `AsyncLocalStorage<ActiveTraceContext>` so tool implementations do not need a telemetry parameter and tool schemas do not change.

### 8.2 Server-to-extension transport

In `MyBrowser/server/src/context.ts`, `sendSocketMessageCore()` reads the active async trace context.

When enabled it:

- adds `trace` to the request envelope;
- emits `transport_dispatched` with the generated request ID, selected browser pseudonym, timeout, and payload byte length;
- records timeout, socket error, disconnect, shutdown cancellation, or matched response;
- validates and forwards the extension timing summary to `TelemetryManager`;
- never serializes the request payload into the transport event.

The WebSocket response listener is registered inside the active `AsyncLocalStorage` scope. It passes each validated transport summary directly to `TelemetryManager` while that scope is active; it does not store mutable telemetry on a shared context object. Tests must prove isolation when response listeners complete out of order.

Composite tools may issue multiple extension requests under one root `traceId`. Each transport request gets its own span/event relationship.

### 8.3 Hub proxy

In `MyBrowser/server/src/ws-server.ts`, the client-to-browser proxy branch:

- validates optional trace context after socket role/session authorization;
- forwards valid trace context in the constructed `ToolRequestV2`;
- preserves response telemetry unchanged while rewriting the response request ID;
- never records `forwardedPayload`, response content, or raw error strings.

The hub does not validate or log response telemetry because it cannot write the required integrity event. The client process validates after the rewrite and is the only component that can accept or persist a summary. The extension summary echoes `extensionRequestId`, allowing the client process to persist the client-to-extension request-ID mapping and infer direct versus proxied routing. Hub timeout/disconnect outcomes are observed by the client transport and categorized there.

### 8.4 Extension request lifecycle

In `MyBrowser/extension/src/entrypoints/background/index.ts`, instrument `handleToolRequest()` around existing boundaries:

- frame accepted;
- tool metadata resolved;
- session fallback loaded;
- tab resolved;
- request entered scheduler;
- scheduled work started;
- tool handler completed/failed;
- response constructed.

The offscreen document attaches a bounded internal `receivedAtEpochMs` timestamp when forwarding `_os_ws_receive` to the service worker. `receivedToResolvedMs` begins at this timestamp, so it includes offscreen-to-worker delivery and worker-wake latency. The timestamp is not part of the WebSocket protocol and is validated/clamped by the worker before use.

`RequestMeta` in `request-scheduler.ts` gains optional in-memory trace timestamps or callbacks. This metadata is not persisted by the scheduler.

The scheduler reports queue wait without changing FIFO behavior, queue caps, deadlines, cancellation, or tombstones.

The extension returns only `ExtensionTraceSummaryV1`. It must not return raw tool arguments, result values, URLs, selector text, page text, or error messages as telemetry.

Timing fields are optional. Failures before a boundary starts omit that duration rather than reporting a misleading zero. A present zero is a real measured sub-millisecond duration rounded to milliseconds.

### 8.5 Browser-state summary

State comparison must be cheap and side-effect free.

Allowed state fields:

- pseudonymous tab ID, derived by the Node process from the transient resolved tab ID;
- URL origin (scheme + host + effective port) when it is already present in a sanitized server-side tool argument;
- HMAC of a normalized pathname when it is already present in a sanitized server-side tool argument, with query and fragment removed before hashing;
- tab loading status;
- active/incognito booleans;
- tab-count bucket when already available;
- navigation, origin, path, load-status, or tab-selection change booleans known by the extension without returning the underlying values.

Do not create a MutationObserver, call `chrome.tabs.query`, take an ARIA snapshot, or read body text solely for telemetry. If no cheap signal or cached tab count exists, omit the field and set `stateChanged: 'unknown'`. Mutation counts are deferred beyond v1.

## 9. Event schema

Every JSONL line is one `TraceEventV1`:

```ts
interface TraceEventV1 {
  schemaVersion: 1;
  eventId: string;
  eventType:
    | 'run_started'
    | 'run_stopped'
    | 'tool_call_started'
    | 'tool_call_completed'
    | 'transport_dispatched'
    | 'transport_completed'
    | 'extension_summary'
    | 'trace_integrity_issue'
    | 'developer_feedback';
  timestamp: string;
  monotonicOffsetMs: number;
  runId: string;
  traceId?: string;
  callId?: string;
  parentEventId?: string;
  sessionPseudonym?: string;
  client?: {
    name?: string;
    version?: string;
    modelProvider?: string;
    modelName?: string;
  };
  tool?: {
    name: string;
    category: string;
    mutatesTab: boolean | 'unknown';
    recordable: boolean | 'unknown';
    argumentSummary: SafeArgumentSummaryV1;
    argumentFingerprint: string;
  };
  routing?: {
    browserPseudonym?: string;
    tabPseudonym?: string;
    queueKind?: 'tab' | 'session' | 'global' | 'none';
    transportRequestPseudonym?: string;
    extensionRequestPseudonym?: string;
  };
  timing?: {
    queueMs?: number;
    executionMs?: number;
    transportMs?: number;
    totalMs?: number;
  };
  outcome?: {
    status: 'success' | 'error' | 'cancelled' | 'timeout';
    errorCategory?: string;
    stateChanged?: true | false | 'unknown';
    resultKind?: string;
    resultBytes?: number;
    itemCountBucket?: string;
  };
  analysis?: {
    repeatKind?: string;
    repeatOrdinal?: number;
    priorTraceId?: string;
    confidence?: 'low' | 'medium' | 'high';
  };
  feedback?: {
    label: 'expected' | 'mistake' | 'unclear';
    category?: string;
    note?: string;
  };
}
```

`monotonicOffsetMs` is the process-local monotonic elapsed time from `run_started`. Cross-process or cross-run ordering uses `timestamp` plus correlation IDs, never monotonic offsets.

### 9.1 Safe argument summary

```ts
interface SafeArgumentSummaryV1 {
  policyVersion: 1;
  safeEnums?: Record<string, string>;
  booleans?: Record<string, boolean>;
  numbers?: Record<string, number>;
  numberBuckets?: Record<string, string>;
  url?: {
    origin?: string;
    pathHmac?: string;
    pathSegmentCount?: number;
  };
  target?: {
    mechanism?: 'ref' | 'mark' | 'selector' | 'role' | 'name' | 'text' | 'label';
    valueHmac?: string;
    valueLengthBucket?: string;
    selectorKind?: string;
    selectorSegmentCount?: number;
  };
  files?: {
    count: number;
    extensions: string[];
  };
  omittedFieldCount: number;
}
```

URL origin/path metadata, target fingerprints, selector structure, and file summaries live only inside `SafeArgumentSummaryV1`. Maps have bounded keys from the tool policy; they are not arbitrary copies of argument names.

Limits:

- Maximum serialized event: 32 KiB.
- Maximum feedback note: 500 characters after redaction.
- Unknown event fields are rejected by readers and dropped by writers.
- Objects are built with safe prototypes and bounded depth/array lengths.
- Circular values, getters, proxies, buffers, typed arrays, and unsupported objects are summarized by type and size, never stringified recursively.

## 10. Tool-aware argument policy

Create `MyBrowser/server/src/telemetry/argument-policy.ts` and tests. The policy is deny-by-default.

Every registered MCP tool must have an explicit policy entry, even when that entry persists no arguments. A release-contract test compares the registered tool names with the policy registry and fails when a new tool has no reviewed telemetry policy. This follows the central registry pattern already used for recording argument policy; tool authors may not add ad hoc serializers inside handlers.

### Persistable values

- Tool name.
- Boolean flags.
- Bounded numeric timings, counts, coordinates, dimensions, and step ranges.
- Safe enums such as action, direction, condition, role, queue, storage operation, and viewport preset.
- Target mechanism (`ref`, `mark`, `selector`, `role`, `name`, `text`, `label`) without raw target content.
- String length bucket and keyed HMAC where correlation is useful.
- URL origin and keyed normalized-path HMAC; no query or fragment.
- Selector structural features such as selector kind and segment count; no attribute values or literal text.
- File count and extension; no path or basename.
- Result type, byte length, item-count bucket, and stable error category.

### Never persist

- `typedText`, form values/keys, clipboard data, prompt text, note text before feedback sanitization.
- Passwords, OTPs, tokens, authorization headers, cookies, secrets, API keys, or storage values.
- Raw `text`, `name`, `label`, selector, element ref, filenames, local paths, or URLs beyond origin.
- JavaScript passed to `browser_eval`.
- Local/session storage values.
- Upload contents or full paths.
- Download URLs or query strings.
- Replay variable values.
- Recorded parameter values.
- Extracted page data, snapshots, screenshots, console messages, network bodies, or support-bundle contents.
- Raw error strings or stacks.

Sensitive fields are removed before creating an event object, not merely before disk write. Tests must place canaries in every string-bearing argument path and assert that canaries never appear in in-memory trace events, serialized trace lines, trace integrity issues, trace exports, or analysis output.

The telemetry sanitizer must not reuse `sanitizeForDiagnostics()` as its security boundary. Diagnostics may continue to use that function independently.

The existing server tool-failure path currently sends raw non-replay arguments to `recordIssue()`. Phase 1 must replace that diagnostic detail with `SafeArgumentSummaryV1` for every tool, whether tracing is enabled or disabled. Add diagnostics/support-bundle canary tests for this specific path. This privacy hardening changes diagnostic detail only; it must not change the MCP response or tool behavior.

If argument summarization fails on the diagnostics path, the failure handler records a generic bounded `argument_summary_unavailable` marker and the original stable failure category. It must not mask, replace, or rethrow the original tool failure.

## 11. Result and error policy

Result summaries are generated from type/shape only:

- primitive type;
- JSON byte length after a bounded safe measurement;
- array/object item-count bucket;
- known stable status fields explicitly allowlisted by tool;
- whether a matching extension summary reported a state change.

Error categories are stable allowlisted codes such as:

- `TOOL_NOT_FOUND`
- `OWNERSHIP_DENIED`
- `NO_BROWSER`
- `TAB_CLOSED`
- `ELEMENT_NOT_FOUND`
- `REQUEST_EXPIRED`
- `QUEUE_OVERLOADED`
- `TRANSPORT_TIMEOUT`
- `BROWSER_DISCONNECTED`
- `SESSION_CLOSED`
- `RECORDED_STATE_FAILED`
- `RECORDED_TOOL_ACTION_FAILED`
- `WORKER_RESTARTED`
- `TOOL_REQUEST_FAILED`
- `PROTOCOL_REJECTED`
- `UNKNOWN_TOOL_FAILURE`

Raw exception messages and stacks remain in existing redacted diagnostics, not telemetry.

Create a central `TelemetryErrorCategory` registry and code-bearing internal error/result classification instead of parsing arbitrary messages:

- Server early returns such as tool-not-found and ownership denial pass an explicit category to the trace finalizer.
- Exact protocol error codes map through an exhaustive table.
- Extension `reportToolFailure()` produces a safe category in `ExtensionTraceSummaryV1`, including recording failures.
- Offscreen `EXTENSION_WORKER_RESTARTED` maps to `WORKER_RESTARTED` even though no extension summary survives worker death.
- Known tool errors may migrate to an internal code-bearing error class while preserving their existing external response text.
- Unclassified errors become `UNKNOWN_TOOL_FAILURE`; telemetry never classifies by retaining a raw exception message.

`TOOL_REQUEST_FAILED` means an extension tool handler threw a non-protocol, non-recording error through `reportToolFailure()`. `UNKNOWN_TOOL_FAILURE` is reserved for an unclassified server-side catch or an otherwise unmapped local failure.

## 12. Storage and lifecycle

Create `MyBrowser/server/src/telemetry/jsonl-store.ts`.

File layout:

```text
~/.mybrowser/traces/
  2026-07-17/
    <runId>-<pid>.jsonl
```

Security and durability:

- MyBrowser and trace directories use exact mode `0700`.
- Trace files use exact mode `0600`.
- Use no-follow descriptor semantics; fail closed if symlink protection cannot be guaranteed.
- Each process writes a unique file; processes never append to one shared file.
- Buffer at most 64 events or one second, whichever occurs first.
- Flush on orderly shutdown. A crash may lose the final buffered second; telemetry must never delay browser shutdown to guarantee analytics durability.
- Readers tolerate one truncated final JSONL line and reject malformed interior lines.
- Rotate at 32 MiB per file.
- Prune by age and then oldest-first size until both retention bounds are satisfied.
- Run pruning at startup and at most once every five minutes.
- Pruning must only remove validated trace files under the trace root and must resist path traversal and symlink replacement.
- Writer failure disables tracing for that process, records one ordinary redacted issue, and never fails a browser tool.

`server.close()` closes normal MCP/WebSocket/context resources first, then calls `TelemetryManager.close()` in a `finally` block with a maximum two-second deadline. Flush failure is swallowed after one ordinary redacted issue and is not added to the server shutdown error aggregate. The existing 15-second exit watchdog is not extended.

Existing support bundles do not include trace files by default. A future explicit `includeTraces` option may include a separately sanitized bounded excerpt.

## 13. Repeat and mistake analysis

Create an offline analyzer so classification never blocks tool execution.

### 13.1 Semantic fingerprint

```text
HMAC(traceKey, toolName + canonicalSafeArgumentSummary + browser/tab pseudonyms)
```

The fingerprint deliberately ignores timeout jitter and other fields that do not change semantic intent.

Canonicalization uses UTF-8 JSON with recursively sorted object keys, JSON scalar encoding, preserved array order, and no insignificant whitespace. Inputs are depth/count/byte bounded before HMAC computation.

Calls that differ only in prohibited values intentionally collide because those values are absent from the safe summary. For example, two `browser_type` calls with different secret text may be classified as a semantic repeat. Reports must label this as a privacy-preserving possible collision, not proof that identical content was sent.

### 13.2 Classifiers

- `exact_repeat`: same semantic fingerprint in consecutive calls.
- `error_retry`: same fingerprint after an error.
- `unchanged_retry`: same fingerprint after success with `stateChanged=false`.
- `semantic_repeat`: same tool/target fingerprint with non-semantic argument differences.
- `oscillation`: alternating fingerprints such as A-B-A-B for at least two cycles.
- `stale_reference_repeat`: repeated stale ref/mark/tab failure.
- `timeout_retry`: repeated request after a timeout.
- `recovery_sequence`: failure followed by a different successful state-changing call within five calls.
- `possible_noop`: success with a reliable `stateChanged=false` signal.

Classifiers emit `low`, `medium`, or `high` confidence. They use terms such as `possible_noop`, not `mistake`, unless a developer supplied feedback.

### 13.3 Previous decision context

For each flagged call, analysis displays:

- prior five tool summaries and outcomes;
- previous matching fingerprint and elapsed time;
- last state-change signal;
- stable error category;
- immediate recovery calls;
- client name/version and optional model identity;
- optional approved client goal/expected-outcome summary.

This is the supported answer to “what happened before the mistake.” It is observable context, not hidden thought.

Known multi-transport root calls include automatic ARIA-snapshot navigation/back/forward flows (`browser_*` action plus `getUrl`, `getTitle`, and `browser_snapshot`), `browser_snapshot`, annotated `browser_screenshot` (`generateMarks`, screenshot, `clearMarks`), replay fallback/load plus replay, and any event operation that fans out to browsers. The writer records spans under the root call with dispatch/completion timestamps and optional causal predecessor IDs. The offline analyzer derives sequential, fallback, cleanup, sibling, or fan-out relationships; the writer does not guess them. No static list is used as an authority because future tools may also issue multiple requests. A test fixture covers sequential, cleanup-in-finally, and fan-out spans.

## 14. Developer commands

Add non-MCP CLI subcommands in a later implementation phase:

```text
mybrowser-mcp trace status
mybrowser-mcp trace list [--since <duration>]
mybrowser-mcp trace analyze [--run <id>] [--json]
mybrowser-mcp trace annotate <traceId> --label <expected|mistake|unclear> [--category <value>] [--note <text>]
mybrowser-mcp trace export [--run <id>] --output <path>
mybrowser-mcp trace purge
```

Rules:

- Commands refuse paths outside the configured trace root except an explicit export destination.
- Export never includes the HMAC key.
- Annotation notes pass hard secret redaction and length limits.
- The MCP tool list does not gain trace-management tools in v1; this avoids changing AI behavior merely because tracing is enabled.

## 15. Optional host adapter (future)

A host-specific adapter may provide:

- model provider/name;
- a short visible goal summary;
- expected outcome;
- visible assistant text immediately preceding the tool call.

Requirements:

- The adapter is separate from core MCP tracing.
- The host must explicitly expose the data; MyBrowser does not scrape process memory or transcripts.
- Free text is disabled unless a second explicit `trace-client-context` setting is enabled.
- Free text is capped and sanitized before entering a trace event.
- The adapter must label the data as client-supplied and never call it chain-of-thought.

## 16. Failure behavior

- Telemetry disabled: no files, no trace wire metadata, no extension timing work.
- Store unavailable: disable tracing for the run; continue tool execution.
- Trace directory unsafe: fail closed for tracing; continue tool execution.
- Sanitizer throws: emit no event and continue tool execution.
- Extension sends malformed/mismatched telemetry: ignore it, emit a bounded integrity issue, preserve the browser result.
- Hub strips trace metadata: tool still works; server records transport-only timings.
- Worker restart: in-flight browser request already follows existing restart failure semantics; telemetry records the stable error category if available.
- Shutdown: flush with a short bounded deadline; never extend the existing shutdown watchdog.

## 17. Tests

### Server unit tests

- Disabled mode produces no directory, event, or wire metadata.
- Argument policy allowlists safe metadata and drops unknown fields.
- Canary secrets never survive in-memory sanitization or serialization.
- Circular objects, getters, prototype keys, buffers, huge arrays, and malformed values are bounded safely.
- Result summaries contain shape/size only.
- Error mapping never stores raw error text.
- HMAC pseudonyms are stable for one install and unlinkable without the key.
- Event size/depth/count caps are enforced.
- Exact `0700`/`0600`, no-follow, path containment, rotation, retention, and torn-final-line behavior.
- Writer failures never alter tool results.
- Async trace context remains isolated across parallel MCP calls.

### Protocol and hub tests

- Cross-package conformance for trace request and response metadata.
- Direct requests preserve trace ID.
- Hub rewrites transport ID while preserving trace/call IDs.
- Hub refuses trace metadata as an authority source.
- Malformed trace metadata is dropped without failing the tool.
- Response telemetry must match the active trace.
- Hub preserves response telemetry while rewriting the response request ID; the client strips malformed or mismatched telemetry, records one bounded integrity event, and preserves the browser result.
- Parallel sessions and browsers never cross-correlate.
- Timeout, disconnect, shutdown, and late-response paths close spans once.

### Extension tests

- Queue wait excludes tab resolution and execution time.
- Execution timing covers the scheduled `work` function exactly once.
- Same-tab FIFO and cross-tab parallelism are unchanged.
- Session/tab/global/none queue kinds are reported correctly.
- Closed/expired/overloaded requests produce bounded summaries.
- Tracing never stores anything in Chrome storage.
- Worker restart and port-loss behavior are unchanged.
- Worker restart returns no extension summary, maps to `WORKER_RESTARTED`, and a subsequent success can form a recovery sequence.
- No extra snapshot, page-text read, or persistent MutationObserver is created.
- Sensitive tool arguments/results never enter extension telemetry.
- Raw `resolvedTabId` and `extensionRequestId` never appear in Node logs, diagnostics, support bundles, trace events, or exports.

### Analyzer tests

- Exact repeat, semantic repeat, error retry, unchanged retry, oscillation, stale-reference, timeout retry, possible no-op, and recovery fixtures.
- Parallel sessions are analyzed independently.
- Truncated final lines are tolerated; malformed interior records are reported.
- Only explicit feedback creates a confirmed `mistake` label.
- Analysis output contains no privacy canaries.

### Integration tests

- Two MCP sessions, two tabs, hub rewrite, and one correlated trace per call.
- Composite tool with multiple transport spans under one root call.
- Real extension result with safe timing summary and no payload leakage.
- Trace files remain within configured retention and size after synthetic load.
- Tracing-on and tracing-off tool results are byte-for-byte equivalent after removing nondeterministic request IDs.

## 18. Performance budget

- Disabled mode: one branch at ingress and no extension work.
- Enabled server sanitization/event construction target: under 2 ms p95 for ordinary calls on the development machine.
- JSONL writes are buffered and never awaited by browser tool completion.
- Extension timing uses existing clocks and lifecycle boundaries.
- No telemetry-only DOM traversal, snapshot, screenshot, layout read, or persistent observer.
- Potentially large arguments are bounded by type/length before recursive walking, canonicalization, or HMAC work.
- If the event queue reaches 1,000 pending entries, drop oldest non-terminal events, retain terminal/error events where possible, and emit one bounded `telemetry_overloaded` issue. Never apply backpressure to browser tools.

## 19. Implementation sequence

1. Server-only trace configuration, event types, tool-aware sanitizer, HMAC key, JSONL store, and MCP ingress spans.
2. Offline reader/analyzer with repeat classifiers and developer feedback annotations.
3. Optional protocol-v2 trace metadata, direct extension timing summary, and client-side direct/hub mapping from the echoed extension request ID.
4. Hub validation/forwarding and correlation tests; the hub remains storage-free.
5. CLI status/list/analyze/annotate/export/purge commands.
6. Real two-session/two-tab trace smoke and privacy-canary verification.
7. Optional host adapter for model/goal context as a separate reviewed project.

Each phase is test-first and independently shippable. Phase 1 must be useful without extension changes; later phases add timing resolution, not basic correctness.

## 20. Acceptance criteria

- Internal tracing is explicit and off by default.
- A developer can trace one MCP call across direct or hub routing by `traceId`.
- A report shows prior calls, repeats, errors, state-change signals, and recovery without claiming hidden reasoning.
- No prohibited traced-tool argument appears in event memory, files, tool-failure diagnostics, support bundles, exports, or analyzer output under canary tests.
- Trace files are private, bounded, rotatable, and safely purgeable.
- Telemetry failures cannot fail, delay, reroute, authorize, or mutate a browser tool.
- Existing server and extension suites, typechecks, builds, and production audits remain green.
- A real internal smoke demonstrates repeated-call and recovery classification across two isolated sessions.

## 21. Deferred decisions

- OpenTelemetry/OTLP export after the local schema proves useful.
- A local HTML trace viewer.
- Capturing bounded visible assistant context through specific host plugins.
- Public opt-in telemetry, which would require a separate privacy, consent, data-processing, and deletion design.
- Support-bundle trace inclusion.
