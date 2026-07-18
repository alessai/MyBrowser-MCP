# MyBrowser Internal Tool Telemetry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `executing-plans` for inline execution. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add opt-in, local telemetry that explains how AI clients use MyBrowser, where calls fail or repeat, and what recovery works, without collecting prompts, secrets, raw browser content, or hidden chain-of-thought.

**Architecture:** The MCP client process is the sole durable writer. It creates root tool spans in `Server`, child transport spans in `Context`, and persists only tool-aware summaries to bounded JSONL. Optional protocol-v2 trace context survives hub request-ID rewriting; the extension echoes timing, its request ID, a transient resolved tab ID, bounded state-change signals, and a safe failure category. The hub validates request trace shape but remains storage-free. Offline commands classify repeats, loops, no-ops, failures, and recoveries.

**Tech stack:** TypeScript 5.7, Node.js 18+, MCP SDK, `ws`, Commander, WXT MV3, Chrome extension APIs, Vitest 3.2.7, Node `crypto`/`fs`/`AsyncLocalStorage`.

**Approved design:** `docs/superpowers/specs/2026-07-17-mybrowser-internal-tool-telemetry-design.md`

## Global constraints

- Telemetry is disabled unless `--trace-internal` is explicit. There is no environment-variable enablement path.
- Disabled mode creates no trace directory, key, file, protocol trace field, or extension work.
- The hub never writes telemetry and never receives the install HMAC key.
- No raw prompt, hidden reasoning, typed/form/clipboard/storage value, cookie, token, password, page HTML/text, console content, screenshot, download/upload path, eval code/result, or unrestricted tool result may enter a persisted event.
- Tool arguments use a per-tool allowlist. Missing policy coverage fails closed before server startup completes.
- Pseudonyms use HMAC-SHA-256 with a private per-install key, never a plain hash.
- Every string/collection is bounded before canonicalization or HMAC; objects are traversed as plain data without invoking getters.
- Trace metadata is optional protocol-v2 metadata. It never changes authorization, routing, ownership, scheduling, retries, or tool results.
- IDs are scoped by `(runId, sessionPseudonym, traceId)` and validated with strict grammar/length bounds.
- Extension response telemetry is validated only by the client writer. The hub preserves it unchanged while rewriting only authoritative routing/request fields.
- JSONL storage uses exact directory mode `0700`, file/key mode `0600`, no-follow opens, per-process files, rotation, retention, and a hard aggregate cap.
- Writer backpressure never delays browser work. The queue is bounded and drops oldest non-terminal events while retaining a counter.
- Shutdown attempts a final telemetry flush for at most two seconds inside the existing 15-second watchdog.
- Existing MCP error text remains compatible. Telemetry error categories are a separate stable enum.
- Production changes follow red-green-refactor. Each task ends with focused tests, typecheck, and a focused commit.
- Full Vitest runs use `TMPDIR=/mnt/ssd/projects/.tmp-mybrowser` on this machine to avoid the known `/tmp` quota failure.

## File and responsibility map

### Server

- Create `MyBrowser/server/src/telemetry/types.ts`: versioned event, trace, summary, outcome, and error-category types.
- Create `MyBrowser/server/src/telemetry/config.ts` and `.test.ts`: CLI configuration, approved clamping, hub suppression, and disabled defaults.
- Create `MyBrowser/server/src/telemetry/policies.ts` and `.test.ts`: complete per-tool allowlist registry and coverage assertion.
- Create `MyBrowser/server/src/telemetry/sanitize.ts` and `.test.ts`: bounded traversal, canonicalization, redaction, HMAC pseudonyms, and safe diagnostics summary.
- Create `MyBrowser/server/src/telemetry/writer.ts` and `.test.ts`: exact private modes, JSONL append, buffering, rotation, retention, and cap enforcement.
- Create `MyBrowser/server/src/telemetry/manager.ts` and `.test.ts`: root context, child spans, lifecycle events, integrity events, and bounded close.
- Create `MyBrowser/server/src/telemetry/analyzer.ts` and `.test.ts`: repeat/loop/no-op/failure/recovery classification.
- Create `MyBrowser/server/src/telemetry/commands.ts` and `.test.ts`: local list/analyze/annotate/export/purge commands.
- Modify `MyBrowser/server/src/index.ts`: opt-in trace options and `trace` subcommands.
- Modify `MyBrowser/server/src/server.ts` and `.test.ts`: root call/list-tools events, policy coverage, diagnostics hardening, and close integration.
- Modify `MyBrowser/server/src/context.ts` and `.test.ts`: transport spans, optional trace envelope, extension-summary validation, and response stripping.
- Modify `MyBrowser/server/src/protocol.ts`, `protocol-conformance.test.ts`, and `ws-server.test.ts`: optional trace/summary contract and hub behavior.
- Modify `MyBrowser/server/src/ws-server.ts`: validate request trace metadata and preserve response telemetry while rewriting the request ID.
- Modify `MyBrowser/server/src/logger.ts` only if needed to expose a safe diagnostics sink; never pass raw trace arguments.
- Modify `MyBrowser/server/README.md`: internal trace enablement, retention, analysis, and purge instructions.

### Extension

- Modify `MyBrowser/extension/src/lib/protocol.ts` and `.test.ts`: shared optional trace context, safe summary, and strict guards.
- Modify `MyBrowser/extension/src/entrypoints/offscreen/main.ts` and `src/lib/offscreen-pending.test.ts`: record a bounded receive timestamp and preserve trace context.
- Modify `MyBrowser/extension/src/lib/request-scheduler.ts` and `.test.ts`: optional work-start callback using the injected clock.
- Create `MyBrowser/extension/src/lib/telemetry-summary.ts` and `.test.ts`: bounded timing/state/failure summary with no durable storage.
- Modify `MyBrowser/extension/src/entrypoints/background/index.ts`: construct and attach the summary on success and failure.
- Modify `MyBrowser/extension/src/lib/background-privacy.test.ts`: assert canaries never reach responses or console diagnostics.
- Modify `MyBrowser/extension/src/lib/tool-metadata.ts` and `.test.ts` only to expose safe queue/tool classification needed by summaries.

---

### Task 1: Define opt-in configuration and event contracts

**Files:**
- Create: `MyBrowser/server/src/telemetry/types.ts`
- Create: `MyBrowser/server/src/telemetry/config.ts`
- Create: `MyBrowser/server/src/telemetry/config.test.ts`
- Create: `MyBrowser/server/src/telemetry/startup-error.ts`
- Create: `MyBrowser/server/src/telemetry/startup-error.test.ts`
- Modify: `MyBrowser/server/src/index.ts`
- Modify: `MyBrowser/server/src/server.ts`

**Produces:**

```ts
export interface TelemetryConfig {
  enabled: boolean;
  directory: string;
  keyPath: string;
  retentionMs: number;
  maxTotalBytes: number;
  maxFileBytes: number;
  maxEventBytes: number;
}

export type TelemetryErrorCategory =
  | "invalid_arguments" | "authorization_denied" | "ownership_denied"
  | "not_connected" | "browser_not_found" | "tab_not_found"
  | "element_not_found" | "timeout" | "request_expired"
  | "queue_overloaded" | "session_closed" | "worker_restarted"
  | "protocol_error" | "extension_tool_failed" | "tool_request_failed"
  | "storage_failure" | "internal_failure" | "unknown";
```

- [ ] **Step 1: Write failing config tests**

Cover defaults, explicit CLI enablement, clamped bounds, path expansion, hub suppression, and disabled no-side-effect semantics:

```ts
const config = parseTelemetryConfig(
  { traceInternal: true, traceRetentionDays: 7, traceMaxMb: 64 },
  "/home/test",
);
expect(config).toMatchObject({
  enabled: true,
  directory: "/home/test/.mybrowser/traces",
  retentionMs: 7 * 86_400_000,
  maxTotalBytes: 64 * 1024 * 1024,
});
```

Run:

```bash
cd MyBrowser/server
npm test -- src/telemetry/config.test.ts
```

Expected: FAIL because telemetry configuration/types do not exist.

- [ ] **Step 2: Implement pure configuration parsing**

Defaults: disabled, 14 days, 256 MiB aggregate, 32 MiB/file, 16 KiB/event, `~/.mybrowser/traces`. Clamp finite retention values to 1–90 days and finite storage values to 16–2048 MiB. Reject non-finite/unsafe values with a stable configuration error. Parsing must not touch the filesystem.

- [ ] **Step 3: Add CLI options without changing normal startup**

Add:

```text
--trace-internal
--trace-dir <path>
--trace-retention-days <days>
--trace-max-mb <megabytes>
```

Extend `ServerOptions` with `telemetryConfig?: TelemetryConfig`, pass the parsed config to `createServerWithTools` only for MCP stdio mode, and leave it inert until Task 3/4 create the manager. Standalone `--hub` receives no telemetry config even if trace flags are supplied. Do not initialize a writer in `index.ts`. Use Commander's async parse path with a bounded, control-normalized startup error formatter; preserve `--version`, stdio startup, and existing options.

- [x] **Step 4: Verify and commit**

```bash
cd MyBrowser/server
npm test -- src/telemetry/config.test.ts src/telemetry/types.test.ts src/telemetry/startup-error.test.ts src/release-contract.test.ts
npm run check
git -C ../.. add MyBrowser/server/src/telemetry MyBrowser/server/src/index.ts MyBrowser/server/src/server.ts
git commit -m "feat: define private telemetry contract"
```

---

### Task 2: Add fail-closed tool policies and privacy sanitizer

**Files:**
- Create: `MyBrowser/server/src/telemetry/policies.ts`
- Create: `MyBrowser/server/src/telemetry/policies.test.ts`
- Create: `MyBrowser/server/src/telemetry/sanitize.ts`
- Create: `MyBrowser/server/src/telemetry/sanitize.test.ts`
- Modify: `MyBrowser/server/src/server.ts`
- Modify: `MyBrowser/server/src/server.test.ts`

**Produces:**

```ts
export interface SafeArgumentSummary {
  scalar: Record<string, boolean | number | string>;
  presence: string[];
  counts: Record<string, number>;
  pseudonyms: Record<string, string>;
  droppedFields: number;
  truncated: boolean;
}

export function summarizeToolArguments(
  toolName: string,
  args: unknown,
  key: Uint8Array,
): SafeArgumentSummary;
```

- [ ] **Step 1: Write the canary matrix and policy coverage tests**

Use distinct canaries in sensitive fields for type/form/action/replay, clipboard, storage/cookies, eval, upload/download, console, screenshot, notes, shared state, and unknown nested keys. Assert none appear in `JSON.stringify(summary)`, errors, or diagnostics. Test arrays above bounds, deep objects, accessors, `__proto__`, invalid UTF-16, huge strings, and non-plain objects.

Policy tests must prove:

```ts
expect(() => assertTelemetryPolicyCoverage([
  "browser_click",
  "brand_new_tool_without_policy",
])).toThrow("TELEMETRY_POLICY_MISSING");
```

Run:

```bash
cd MyBrowser/server
npm test -- src/telemetry/policies.test.ts src/telemetry/sanitize.test.ts
```

Expected: FAIL because registry and sanitizer do not exist.

- [ ] **Step 2: Implement bounded traversal and canonical HMAC inputs**

- Walk only own enumerable data properties using descriptors; never invoke getters.
- Bound depth, keys/object, collection length, per-string bytes, and total canonical bytes before HMAC.
- Canonicalize sorted UTF-8 keys, explicit scalar type tags, preserved array order, and no Unicode normalization.
- Store exact allowlisted enums/booleans/bounded numbers; HMAC selectors, tab/session/browser IDs, recording names, lock names, origins, and normalized paths where policy permits.
- Use domain-separated inputs such as `tool-arg:v1:<tool>:<field>:<canonical>`.
- Treat selector names/labels/text as high-cardinality pseudonyms, not exact strings.
- Unknown tools and fields produce shape-only `{}`/presence summaries and increment `droppedFields`.

- [ ] **Step 3: Cover every current tool explicitly and assert at startup**

Group policies by privacy behavior but list every constructed tool name. After `tools` is assembled in `createServerWithTools`, call `assertTelemetryPolicyCoverage(tools.map(tool => tool.schema.name))` before MCP handlers are registered. This runs even when telemetry is off so a future unclassified tool cannot silently ship.

- [ ] **Step 4: Harden the existing diagnostics failure path**

Replace `details.arguments` in `server.ts` with a diagnostics-mode safe summary. Diagnostics mode must not create/load the install telemetry key when tracing is disabled; it may keep bounded booleans/counts and must replace pseudonymizable values with category markers. If sanitization itself throws, record only `{ sanitizer: "failed", dropped: true }`. Keep the external MCP error text unchanged.

Add an integration regression in `server.test.ts` that drives a failing tool with canaries and inspects `recordIssue`; no raw argument canary may appear.

- [ ] **Step 5: Verify and commit**

```bash
cd MyBrowser/server
npm test -- src/telemetry/policies.test.ts src/telemetry/sanitize.test.ts src/server.test.ts
npm run check
git -C ../.. add MyBrowser/server/src/telemetry MyBrowser/server/src/server.ts MyBrowser/server/src/server.test.ts
git commit -m "feat: sanitize private tool traces"
```

---

### Task 3: Build the bounded private JSONL writer

**Files:**
- Create: `MyBrowser/server/src/telemetry/writer.ts`
- Create: `MyBrowser/server/src/telemetry/writer.test.ts`
- Create: `MyBrowser/server/src/telemetry/manager.ts`
- Create: `MyBrowser/server/src/telemetry/manager.test.ts`

**Produces:**

```ts
export interface TelemetrySink {
  emit(event: TelemetryEvent): void;
  flush(): Promise<void>;
  close(deadlineMs?: number): Promise<void>;
}

export class TelemetryManager {
  static disabled(): TelemetryManager;
  emit(event: TelemetryEvent): void;
  flush(): Promise<void>;
  close(deadlineMs?: number): Promise<void>;
}
```

- [ ] **Step 1: Write failing filesystem and backpressure tests**

Use temporary directories and injected clock/random/file operations. Cover:

- exact directory `0700` and file/key `0600` after adversarial umask;
- symlink directory, key, active file, and rotated-file rejection;
- fail closed when no-follow semantics are unavailable;
- one process/run writes only its own file;
- line-per-event JSONL and tolerance of one truncated final line;
- flush at 64 events or one second;
- rotate at 32 MiB or UTC day boundary;
- prune older than retention and oldest-first above aggregate cap;
- retain at least 24 hours unless the hard cap requires pruning;
- queue overflow drops oldest non-terminal events, never throws into tool flow, and records a bounded dropped count;
- write/fsync/close errors disable the writer and surface one ordinary sanitized diagnostic.

Run:

```bash
cd MyBrowser/server
npm test -- src/telemetry/writer.test.ts src/telemetry/manager.test.ts
```

Expected: FAIL because writer and manager do not exist.

- [ ] **Step 2: Implement safe directory/key initialization**

Reuse the recording persistence security posture: no-follow open, descriptor identity/type/mode verification, explicit `fchmod`, private directory verification, and no pathname-check-then-open TOCTOU. Generate one 32-byte HMAC key at the fixed per-install `~/.mybrowser/trace-key` path only when tracing is enabled; publish a fully written temporary inode atomically so concurrent first starts cannot observe a partial key. A disabled manager has no timers, files, keys, or filesystem calls.

- [ ] **Step 3: Implement buffered JSONL and retention**

Serialize an already-sanitized event at most once. Reject events larger than `maxEventBytes` and emit only a bounded drop counter. Use a bounded in-memory queue; writer promises are not awaited by tool calls. Run pruning at startup, after rotation, and at a bounded periodic interval. Readers ignore only one malformed final line and reject malformed interior lines.

- [ ] **Step 4: Implement manager lifecycle and bounded close**

The manager owns `runId`, install key access, writer, monotonic/wall clock references, and safe ordinary diagnostics. `close(2_000)` races final drain against a timer, cleans timers/listeners, and resolves without changing server shutdown success.

- [ ] **Step 5: Verify and commit**

```bash
cd MyBrowser/server
npm test -- src/telemetry/writer.test.ts src/telemetry/manager.test.ts
npm run check
git -C ../.. add MyBrowser/server/src/telemetry
git commit -m "feat: persist bounded private traces"
```

---

### Task 4: Instrument MCP root calls and server lifecycle

**Files:**
- Modify: `MyBrowser/server/src/telemetry/manager.ts`
- Modify: `MyBrowser/server/src/telemetry/manager.test.ts`
- Modify: `MyBrowser/server/src/server.ts`
- Modify: `MyBrowser/server/src/server.test.ts`
- Modify: `MyBrowser/server/src/context.ts`

**Produces:**

```ts
export interface RootToolContext {
  runId: string;
  traceId: string;
  rootCallId: string;
  sessionPseudonym: string;
  toolName: string;
  startedMonoMs: number;
}

runToolCall<T>(input: RootToolInput, operation: () => Promise<T>): Promise<T>;
currentRoot(): RootToolContext | undefined;
```

- [ ] **Step 1: Write failing root-span tests**

Inject a memory sink and deterministic IDs/clocks. Assert:

- disabled mode emits nothing and preserves exact tool output/errors;
- `tools_listed`, `tool_started`, and exactly one `tool_completed`/`tool_failed` event;
- unknown tools and all early returns (missing tab, ownership denial, no browser) still close the root span;
- client name/version comes from `server.getClientVersion()` only when available;
- model/provider/prompt fields are absent;
- nested async work sees the root through `AsyncLocalStorage`;
- timer/listener cleanup and two-second close behavior are idempotent.

Run:

```bash
cd MyBrowser/server
npm test -- src/telemetry/manager.test.ts src/server.test.ts
```

Expected: FAIL because tool handlers are not wrapped and lifecycle events are absent.

- [ ] **Step 2: Create the manager before `Context` and inject it**

Use the existing `ServerOptions.telemetryConfig` and add `telemetry?: TelemetryManager` for tests. Production builds a manager from config; tests may inject a memory sink. Construct `Context` with the manager. Existing `new Context()` remains a disabled-compatible default.

- [ ] **Step 3: Refactor one root wrapper around the entire tool path**

Move the body of `CallToolRequestSchema` handling into the `runToolCall` closure immediately after extracting name/arguments. Do not duplicate finish calls in branches. Map explicit outcomes without parsing arbitrary error strings:

- missing tool/invalid args → `invalid_arguments`;
- ownership branches → `ownership_denied`;
- browser resolution → `browser_not_found`/`not_connected`;
- known protocol codes → their stable telemetry category;
- unmapped local throw → `unknown`;
- extension generic failure remains `extension_tool_failed` once summaries arrive.

The MCP response and diagnostic text remain unchanged.

- [ ] **Step 4: Add list-tools and shutdown integration**

Record only client name/version, capability booleans, tool count, and schema-version digest for `ListTools`; never serialize tool descriptions. Call `telemetry.close(2_000)` in a `finally` after existing server/context close steps so telemetry cannot block the 15-second watchdog or change the aggregated shutdown error.

- [ ] **Step 5: Verify and commit**

```bash
cd MyBrowser/server
npm test -- src/telemetry/manager.test.ts src/server.test.ts src/context.test.ts
npm run check
git -C ../.. add MyBrowser/server/src/context.ts MyBrowser/server/src/server.ts MyBrowser/server/src/server.test.ts MyBrowser/server/src/telemetry docs/superpowers/plans/2026-07-17-mybrowser-internal-tool-telemetry.md
git commit -m "feat: trace MCP tool lifecycles"
```

---

### Task 5: Add root-to-transport correlation in `Context`

**Files:**
- Modify: `MyBrowser/server/src/protocol.ts`
- Modify: `MyBrowser/server/src/context.ts`
- Modify: `MyBrowser/server/src/context.test.ts`
- Modify: `MyBrowser/server/src/protocol-conformance.test.ts`
- Modify: `MyBrowser/server/src/telemetry/manager.ts`
- Modify: `MyBrowser/server/src/telemetry/manager.test.ts`

**Produces:**

```ts
export interface TraceContextV1 {
  schemaVersion: 1;
  traceId: string;
  rootCallId: string;
  transportSpanId: string;
}
```

- [ ] **Step 1: Write failing context correlation tests**

Using the existing real loopback helper in `context.test.ts`, assert:

- tracing off sends the byte-for-byte legacy request shape;
- tracing on adds only valid optional `trace` metadata;
- root and child IDs correlate across async tool code;
- each `sendSocketMessageCore()` call under a composite root gets a distinct sibling `transportSpanId`;
- child spans retain start/end chronology but do not invent a linear parent chain;
- timeout, socket close, send failure, and shutdown create one terminal transport event;
- standalone calls outside a root omit trace metadata rather than inventing a root.

Run:

```bash
cd MyBrowser/server
npm test -- src/context.test.ts src/protocol-conformance.test.ts src/telemetry/manager.test.ts
```

Expected: FAIL because envelopes contain no trace metadata and `Context` cannot observe the current root.

- [ ] **Step 2: Add pure strict trace guards to both protocol contracts**

For now update the server protocol and conformance fixtures; the extension module is updated in Task 7. Bound IDs to 64 ASCII characters with a stable grammar. Trace metadata is optional, and invalid trace metadata makes the request guard fail. It is inert for authorization/routing.

- [ ] **Step 3: Inject transport spans without changing tool APIs**

`Context` reads the current root from the injected manager inside `sendSocketMessageCore`. Tool handlers continue calling `context.sendSocketMessage(...)` unchanged. Use the ALS bridge test to prove context survives tool handler → `Context` → pending response promise.

- [ ] **Step 4: Record transport totals only**

Persist transport start/end/duration, safe route target pseudonyms, timeout class, response byte bucket, and result-presence booleans. Do not summarize response content here. Queue/extension timings arrive later and must be absent rather than zero until available.

- [ ] **Step 5: Verify and commit**

```bash
cd MyBrowser/server
npm test -- src/context.test.ts src/protocol-conformance.test.ts src/telemetry/manager.test.ts
npm run check
git -C ../.. add MyBrowser/server/src/context.ts MyBrowser/server/src/context.test.ts MyBrowser/server/src/protocol.ts MyBrowser/server/src/protocol-conformance.test.ts MyBrowser/server/src/telemetry
git commit -m "feat: correlate tool transport spans"
```

---

### Task 6: Preserve correlation through the storage-free hub

**Files:**
- Modify: `MyBrowser/server/src/protocol.ts`
- Modify: `MyBrowser/server/src/ws-server.ts`
- Modify: `MyBrowser/server/src/ws-server.test.ts`
- Modify: `MyBrowser/server/src/protocol-conformance.test.ts`

**Produces:** authenticated-session-scoped trace forwarding without hub storage or key sharing.

- [ ] **Step 1: Write failing real-WebSocket hub tests**

Extend the existing fake extension/two-client harness. Prove:

- a valid client trace survives `client request ID → hub_N → extension` unchanged;
- the hub still overwrites `sessionId` and target browser routing;
- malformed/oversized request trace metadata is rejected or omitted before forwarding with no raw log;
- trace ID collisions in different authenticated sessions cannot cross-correlate;
- a valid response `telemetry` object is preserved unchanged while `requestId` is rewritten back;
- malformed response telemetry is also preserved for the client writer to classify, never logged by the hub, and never used for routing;
- extension role cannot send ordinary client requests or `hub_rpc` regardless of trace fields;
- tracing metadata never changes timeout, cleanup, reconnect, or session finalization.

Run:

```bash
cd MyBrowser/server
npm test -- src/ws-server.test.ts src/protocol-conformance.test.ts
```

Expected: FAIL because the hub currently has no trace-aware request validation/correlation assertions.

- [ ] **Step 2: Validate request trace shape at the authenticated hub boundary**

Validate grammar/size only after role/session authentication. Treat metadata as scoped to that socket session and inert for authority. Preserve valid metadata while creating the extension request. Never derive routing from trace IDs.

- [ ] **Step 3: Keep the hub storage-free on responses**

When forwarding `messageResponse`, rewrite only the authoritative request ID/routing fields. Do not parse, normalize, log, or persist extension telemetry. The MCP client process in Task 8 performs the bounded response validation and emits any integrity event.

- [ ] **Step 4: Verify and commit**

```bash
cd MyBrowser/server
npm test -- src/ws-server.test.ts src/protocol-conformance.test.ts src/session-connections.test.ts src/hub-rpc.test.ts
npm run check
git -C ../.. add MyBrowser/server/src/protocol.ts MyBrowser/server/src/protocol-conformance.test.ts MyBrowser/server/src/ws-server.ts MyBrowser/server/src/ws-server.test.ts
git commit -m "feat: preserve traces through hub routing"
```

---

### Task 7: Emit privacy-safe extension timing summaries

**Files:**
- Modify: `MyBrowser/extension/src/lib/protocol.ts`
- Modify: `MyBrowser/extension/src/lib/protocol.test.ts`
- Modify: `MyBrowser/extension/src/entrypoints/offscreen/main.ts`
- Modify: `MyBrowser/extension/src/lib/offscreen-pending.test.ts`
- Modify: `MyBrowser/extension/src/lib/request-scheduler.ts`
- Modify: `MyBrowser/extension/src/lib/request-scheduler.test.ts`
- Create: `MyBrowser/extension/src/lib/telemetry-summary.ts`
- Create: `MyBrowser/extension/src/lib/telemetry-summary.test.ts`
- Modify: `MyBrowser/extension/src/entrypoints/background/index.ts`
- Modify: `MyBrowser/extension/src/lib/background-privacy.test.ts`
- Modify: `MyBrowser/extension/src/lib/tool-metadata.ts`
- Modify: `MyBrowser/extension/src/lib/tool-metadata.test.ts`
- Modify: `MyBrowser/server/src/protocol.ts`
- Modify: `MyBrowser/server/src/protocol-conformance.test.ts`

**Produces:**

```ts
export interface ExtensionTraceSummaryV1 {
  schemaVersion: 1;
  traceId: string;
  transportSpanId: string;
  extensionRequestId: string;
  offscreenReceivedToBackgroundMs?: number;
  queueWaitMs?: number;
  handlerMs?: number;
  responseSerializeMs?: number;
  resolvedTabId?: number; // transient; client HMACs before persistence
  stateSignals?: {
    tabChanged?: boolean;
    originChanged?: boolean;
    pathChanged?: boolean;
    loadStatusChanged?: boolean;
  };
  errorCategory?: TelemetryErrorCategory;
}
```

- [ ] **Step 1: Write failing cross-package protocol and privacy tests**

Update both pure protocol modules and tests together. Assert strict optional trace/summary guards, unknown field rejection within telemetry objects, finite non-negative bounded timings, valid IDs, safe enums, and no result-content field.

In extension privacy tests put canaries in typed text, form values, clipboard/storage/eval payloads, page result, error message, and console logs. Assert neither `ExtensionTraceSummaryV1` nor extension console output contains them.

Run:

```bash
cd MyBrowser/extension
npm test -- src/lib/protocol.test.ts src/lib/telemetry-summary.test.ts src/lib/background-privacy.test.ts
cd ../server
npm test -- src/protocol-conformance.test.ts
```

Expected: FAIL because trace/summary types and builder do not exist.

- [ ] **Step 2: Timestamp offscreen receipt without extra browser work**

When an authenticated tool frame is accepted, attach `receivedAtEpochMs` to the internal offscreen→worker port message. This field is not durable and is not part of external authorization. Use `Date.now()` only for cross-context elapsed time, clamp negative/jumping durations, and omit impossible measurements. No page query, content-script injection, or Chrome storage write is allowed.

- [ ] **Step 3: Add an optional scheduler start callback**

Extend internal `RequestMeta` with an optional callback invoked once immediately before expiry check/work execution using the injected `now()` clock. It must work for tab/session/global/unqueued paths, never be persisted, and never affect queue ordering or failure. Background derives queue wait from that callback; overload/rejection before start leaves it absent.

- [ ] **Step 4: Build the summary on success and failure**

Only create a builder when a valid trace context exists. Use injected clocks in unit tests. Echo trace IDs and the current extension request ID. Include a transient resolved numeric tab ID only when normal request resolution already produced it. Include only state-change booleans already known from the handler/result path; do not add `chrome.tabs.query()` or DOM observers.

Error categories come from a central exact-code mapper:

- protocol/queue/session/restart constants map directly;
- known extension tool failures use explicit safe categories;
- generic extension catch → `extension_tool_failed`;
- no parsing of arbitrary free-form page/error text.

Early failures may omit unavailable timings. Never encode unknown as zero. Attach summary to both success and error `messageResponse` payloads.

- [ ] **Step 5: Verify no MV3 lifecycle regression and commit**

```bash
cd MyBrowser/extension
TMPDIR=/mnt/ssd/projects/.tmp-mybrowser npm test -- src/lib/protocol.test.ts src/lib/offscreen-pending.test.ts src/lib/request-scheduler.test.ts src/lib/telemetry-summary.test.ts src/lib/background-privacy.test.ts src/lib/tool-metadata.test.ts
npm run check
npm run build
cd ../server
npm test -- src/protocol-conformance.test.ts
npm run check
git -C ../.. add MyBrowser/extension/src MyBrowser/server/src/protocol.ts MyBrowser/server/src/protocol-conformance.test.ts
git commit -m "feat: report safe extension trace summaries"
```

---

### Task 8: Validate extension summaries at the sole writer

**Files:**
- Modify: `MyBrowser/server/src/context.ts`
- Modify: `MyBrowser/server/src/context.test.ts`
- Modify: `MyBrowser/server/src/telemetry/manager.ts`
- Modify: `MyBrowser/server/src/telemetry/manager.test.ts`
- Modify: `MyBrowser/server/src/ws-server.test.ts`

**Produces:** client-side summary validation, route-mode inference, pseudonymization, and telemetry stripping before tool results resolve.

- [ ] **Step 1: Write failing direct and hub integration tests**

Cover:

- direct mode: extension request ID equals transport request ID;
- hub mode: extension request ID differs but trace/root/transport IDs join;
- client derives route mode and persists only an HMAC pseudonym of the extension request ID and resolved tab ID;
- extension generic category remains distinct from server `unknown`;
- malformed, oversized, mismatched, or wrong-trace summary creates one `telemetry_integrity` event with reason/byte bucket only;
- no raw numeric tab ID, malformed payload, or error text reaches JSONL or diagnostics;
- summary is stripped before resolving the tool promise;
- missing summary is allowed and leaves fields absent;
- hub-preserved malformed telemetry is handled identically to direct mode.

Run:

```bash
cd MyBrowser/server
npm test -- src/context.test.ts src/telemetry/manager.test.ts src/protocol-conformance.test.ts src/ws-server.test.ts
```

Expected: FAIL because `Context` currently ignores extension telemetry.

- [ ] **Step 2: Add a bounded client-side validator**

Before traversing, reject telemetry above its byte/shape bounds. Validate exact schema/IDs against the pending request. On failure, emit only:

```ts
{ type: "telemetry_integrity", reason: SAFE_ENUM, sizeBucket: SAFE_BUCKET }
```

Never pass the malformed object to the writer or `recordIssue`. On success, immediately HMAC raw IDs, calculate route mode, and discard raw values.

- [ ] **Step 3: Merge safe timings into the transport terminal event**

Keep root duration and total transport duration monotonic. Treat offscreen wall-clock deltas as separate bounded fields and never subtract unrelated clocks. Preserve missing/unknown values as absent. Summary processing cannot change pending-request resolution.

- [ ] **Step 4: Run conformance and commit**

```bash
cd MyBrowser/server
npm test -- src/context.test.ts src/telemetry/manager.test.ts src/protocol-conformance.test.ts src/ws-server.test.ts
npm run check
cd ../extension
npm test -- src/lib/protocol.test.ts src/lib/telemetry-summary.test.ts
npm run check
git -C ../.. add MyBrowser/server/src
git commit -m "feat: join extension telemetry at client"
```

---

### Task 9: Add offline repeat, loop, no-op, and recovery analysis

**Files:**
- Create: `MyBrowser/server/src/telemetry/analyzer.ts`
- Create: `MyBrowser/server/src/telemetry/analyzer.test.ts`
- Create: `MyBrowser/server/src/telemetry/commands.ts`
- Create: `MyBrowser/server/src/telemetry/commands.test.ts`
- Modify: `MyBrowser/server/src/index.ts`
- Modify: `MyBrowser/server/package.json` only if a non-flaky benchmark script is added

**Produces:** local `trace list`, `trace analyze`, `trace annotate`, `trace export`, and `trace purge` commands. These read already-sanitized JSONL; they never contact the network.

- [x] **Step 1: Write failing deterministic classifier tests**

Use synthetic versioned events and assert:

- `exact_repeat`: same semantic fingerprint consecutively;
- `unchanged_repeat`: same fingerprint with equivalent safe post-state/no-change signal;
- `error_retry`: failed call followed by same fingerprint;
- `semantic_repeat`: same tool and target pseudonyms with a different privacy-safe fingerprint;
- `timeout_retry`: same fingerprint after a timeout;
- `oscillation`: `A → B → A → B` over at least two cycles;
- `stale_reference_repeat`: known stale tab/element failure plus repeated pseudonym;
- `recovery`: failed call followed within five calls by a different successful state-changing call;
- `possible_noop`: success with a reliable no-change signal;
- user feedback overrides a suspected automatic label but never rewrites source events;
- concurrent siblings use monotonic start/end order, not request-ID order;
- truncated final line is ignored; malformed interior line, unknown schema version, and cross-session/run collisions are reported safely;
- output contains counts/pseudonyms only and never raw canaries.

Run:

```bash
cd MyBrowser/server
npm test -- src/telemetry/analyzer.test.ts src/telemetry/commands.test.ts
```

Expected: FAIL because analyzer/commands do not exist.

- [x] **Step 2: Implement streaming analysis**

Process files line-by-line with bounded memory. Partition by `(runId, sessionPseudonym, traceId)`. Keep only the bounded window needed for loop/recovery classification. Automatic labels are `suspected` unless backed by explicit error/no-change/user feedback. Emit machine-readable JSON and a concise human table.

- [x] **Step 3: Register side-effect-free CLI subcommands**

Move command construction into a testable `registerTraceCommands(program, deps)` without importing `index.ts` in tests. Preserve the existing root server action and `--version` behavior.

Commands:

```text
mybrowser-mcp trace list
mybrowser-mcp trace analyze [--run <id>] [--json]
mybrowser-mcp trace annotate --run <id> --call <id> --label <mistake|expected|unclear> [--note <text>]
mybrowser-mcp trace export --run <id> --out <file>
mybrowser-mcp trace purge [--older-than-days <n>]
```

Rules:

- `annotate` writes a separate private feedback JSONL event/file; it never mutates source traces. Notes are bounded and pass a dedicated secret redactor; sanitizer failure omits the note.
- `export` includes only already-sanitized versioned events and creates the output `0600` with no-follow semantics.
- `purge` rejects symlinks, stays inside the configured trace directory, requires the explicit command, and reports counts without raw paths.
- No subcommand initializes the WebSocket hub, extension, or MCP stdio server.

- [ ] **Step 4: Verify and commit**

```bash
cd MyBrowser/server
npm test -- src/telemetry/analyzer.test.ts src/telemetry/commands.test.ts src/telemetry/writer.test.ts
npm run check
npm run build
node dist/index.js trace --help
git -C ../.. add MyBrowser/server/src/telemetry MyBrowser/server/src/index.ts MyBrowser/server/package.json
git commit -m "feat: analyze private tool traces"
```

---

### Task 10: Prove privacy, disabled-mode equivalence, and real topology

**Files:**
- Create: `MyBrowser/server/src/telemetry/integration.test.ts`
- Modify: `MyBrowser/server/src/server.test.ts`
- Modify: `MyBrowser/server/src/ws-server.test.ts`
- Modify: `MyBrowser/extension/src/lib/background-privacy.test.ts`
- Modify: `MyBrowser/server/README.md`
- Modify: `README.md` only for a short internal/developer link if appropriate

- [ ] **Step 1: Write the end-to-end canary topology test**

Start a real loopback hub, one fake extension, and two MCP-side clients/sessions. Execute direct and hub-routed success, failure, exact repeat, oscillation, composite tool calls, queue wait, session close, and malformed extension telemetry. Assert:

- one client-process file per run;
- no hub trace file/key;
- direct/hub correlations join correctly;
- sessions with colliding trace IDs stay separate;
- extension restart/missing summary leaves safe incomplete spans;
- analyzer produces expected suspected/confirmed classifications;
- no canary appears in JSONL, persistent logs, support-bundle diagnostics, extension console captures, CLI output, or exported trace.

Run:

```bash
cd MyBrowser/server
TMPDIR=/mnt/ssd/projects/.tmp-mybrowser npm test -- src/telemetry/integration.test.ts src/server.test.ts src/ws-server.test.ts
```

Expected: FAIL until all integration hooks and privacy edges are connected.

- [ ] **Step 2: Prove disabled-mode equivalence and bounded overhead**

With tracing off:

- compare representative request/response JSON to the pre-feature fixtures;
- assert zero trace fields, filesystem calls, key generation, timers, and extension summary builders;
- run concurrency/FIFO/restart tests unchanged.

With tracing on, use deterministic fake sinks for CI and a separate non-gating local benchmark. Target median server overhead below 2 ms/call excluding filesystem flush, zero added Chrome/page queries, and no measurable queue-order change. Report benchmark values; do not add flaky wall-clock thresholds to the normal suite.

- [ ] **Step 3: Document internal operation**

Document:

- explicit `--trace-internal` enablement and absence of an environment-variable enablement path;
- exact data collected and prohibited;
- local path, modes, defaults, rotation, retention, and cap;
- `trace list/analyze/annotate/export/purge` examples;
- no prompt/chain-of-thought/model identity guarantee;
- optional client metadata adapter is not included;
- support bundles exclude traces unless a future separately reviewed opt-in is added.

- [ ] **Step 4: Run authoritative automated gates**

```bash
cd MyBrowser/server
TMPDIR=/mnt/ssd/projects/.tmp-mybrowser npm test
npm run check
npm run build
npm audit --registry=https://registry.npmjs.org

cd ../extension
TMPDIR=/mnt/ssd/projects/.tmp-mybrowser npm test
npm run check
npm run build
npm audit --omit=dev --registry=https://registry.npmjs.org
```

Run `aft_inspect` scoped to `MyBrowser/server/src` and `MyBrowser/extension/src`. Resolve every introduced diagnostic. Confirm the only untracked root artifact remains the pre-existing `.cortexkit/` directory.

- [ ] **Step 5: Run the loaded-extension smoke**

With the reviewed MV3 build loaded:

1. telemetry off: execute representative calls and prove no trace artifacts;
2. telemetry on: two sessions/tabs, different-tab overlap, same-tab FIFO, one safe failure/retry, and one composite call;
3. stop/restart only the MV3 worker during a sub-30-second request and confirm tool semantics remain `EXTENSION_WORKER_RESTARTED` while the trace safely records a missing/incomplete extension summary;
4. run `trace analyze` and inspect the JSONL for canaries;
5. disable tracing again and verify no new events.

- [ ] **Step 6: Request final focused review and commit**

Review the entire telemetry diff for privacy, protocol integrity, MV3 lifecycle, file safety, and disabled-mode equivalence. Fix substantive findings and rerun the affected/full gates.

```bash
cd /mnt/ssd/projects/MCPProjects/BrowserMCP
git add MyBrowser/server MyBrowser/extension README.md
git commit -m "feat: add private AI tool telemetry"
```

Do not publish npm, create a GitHub release/tag, upload traces, or enable telemetry by default as part of this plan.

## Final acceptance checklist

- [ ] Telemetry is opt-in and disabled mode has no filesystem/protocol/extension side effects.
- [ ] Every registered tool has an explicit allowlist policy; unknown tools/fields fail closed.
- [ ] Privacy canaries never appear in trace JSONL, diagnostics, logs, extension console capture, CLI output, support bundles, or exports.
- [ ] The client MCP process is the only durable writer; hub and extension remain storage-free.
- [ ] Direct and hub request-ID rewriting correlate without sharing HMAC keys or weakening session authority.
- [ ] Extension timings are bounded/optional and never encode unknown as zero.
- [ ] Root/transport/composite spans have deterministic parent/sibling semantics.
- [ ] Repeat, loop, no-op, error-retry, stale-reference, recovery, and manual-feedback analysis is deterministic.
- [ ] Private modes, symlink defenses, rotation, retention, aggregate cap, backpressure, and shutdown flush pass adversarial tests.
- [ ] Existing MCP output/error text, scheduler FIFO, MV3 restart behavior, recording privacy, and session isolation remain unchanged.
- [ ] Server/extension full tests, typechecks, builds, audits, diagnostics, and loaded-extension smoke pass.
- [ ] Documentation states that hidden chain-of-thought is unavailable and optional client context is future work.
