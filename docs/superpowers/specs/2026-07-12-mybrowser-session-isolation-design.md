# MyBrowser Session Isolation Design

**Date:** 2026-07-12  
**Status:** Approved for implementation planning  
**Scope:** MyBrowser MCP server and Chrome extension  
**Target protocol:** v2

## Purpose

MyBrowser currently presents multi-session ownership controls at the MCP layer while the extension still executes requests through shared mutable state. Concurrent requests can switch one another's target tab, hub RPC callers can act as another session, and the recorder can mix and expose actions from unrelated sessions.

This design makes session identity authoritative from the MCP socket through the hub and into the extension. It also isolates request tab state, serializes work per tab, and prevents recordings from persisting user-entered values.

The extension has two runtimes: the persistent offscreen document owns the WebSocket, while the MV3 background service worker executes tools through a `chrome.runtime.Port`. Protocol validation begins in the offscreen runtime; session state and scheduling live in the background runtime, with restart-safe state persisted to `chrome.storage.session`.

## Goals

1. A request can act only as the session bound to its MCP client socket.
2. Concurrent requests cannot change one another's target tab or input device.
3. Requests for different tabs can execute concurrently, while requests for one tab execute in FIFO order.
4. Multiple sessions can record simultaneously without mixing steps.
5. Typed text and form values never enter persisted recording data.
6. Incompatible server and extension versions fail closed with an actionable upgrade error.
7. The behavior is covered by deterministic unit and WebSocket integration tests.
8. A background service-worker restart cannot silently redirect a session to another session's last-used tab or leak secrets from an unfinished recording.

## Non-goals

This implementation does not include:

- dependency vulnerability upgrades;
- navigation timeout and content-script lifecycle fixes;
- general compound-action schema or timeout cleanup;
- ARIA snapshot performance work;
- TLS or deployment-network changes;
- final package or extension version publication.

Those remain separate release-blocking workstreams.

## Chosen approach

Use protocol-enforced isolation rather than a global extension queue or server-only serialization.

Protocol v2 carries a hub-controlled session identity to the extension. The extension creates request-owned execution state and schedules tab work through per-tab queues. Active recordings are keyed by session. This is a coordinated upgrade: protocol v1 peers are rejected rather than allowed to run with weaker isolation.

## Wire protocol v2

### Shared constant

The server and extension each expose a `PROTOCOL_VERSION = 2` constant from their protocol module. Tests assert that authentication and tool-envelope fixtures use that value.

### Authentication

Client and extension sockets authenticate with:

```ts
type AuthRequest = {
  type: "auth";
  token: string;
  role: "client" | "extension";
  protocolVersion: 2;
  browserName?: string;
};
```

Successful extension authentication returns:

```ts
type AuthResult = {
  type: "auth";
  status: "ok";
  protocolVersion: 2;
  browserId: string;
};
```

Successful client authentication returns the same shape without `browserId`. Missing `role` is rejected; the current behavior that treats a missing role as an extension is removed.

The server rejects missing or incompatible versions with an error containing the supported version and then closes the socket with application close code `4406`. The extension also requires `protocolVersion: 2` in the auth result, so a new extension connecting to an old server fails closed instead of silently downgrading. There is no v1 compatibility mode in either direction. The user-facing error says that both the MCP server and extension must be upgraded together.

### Session registration

An authenticated client socket must call `registerSession` once before proxying tools or invoking session-scoped RPC methods.

The hub records the resulting immutable connection state:

```ts
type ClientConnection = {
  role: "client";
  sessionId: string;
};
```

Rules:

- a socket cannot switch to a different session after registration;
- a session already bound to a live socket cannot be registered by another socket;
- a reconnect may reclaim the same session after the prior socket closes and while the existing reconnect grace period is active;
- unregistered clients may only authenticate and register a session.

The hub maintains both `socketToSession` and `sessionToSocket` indexes. Registration by a second live socket, or an attempt by one socket to switch sessions, returns `SESSION_IDENTITY_MISMATCH` without mutating either index.

The hub process's own MCP session is the one exception to socket binding. It is registered directly against `LocalStateManager` in the trusted hub process. Socket registration, duplicate-socket rejection, and protocol-auth tests apply to client-mode MCP processes and extensions; hub-local tool envelopes still carry the hub session ID.

### Tool envelopes

In direct hub mode, the local MCP context adds its registered session ID before sending a tool request to an extension. In client mode, the client sends no authoritative session field; the hub looks up the socket-bound session and overwrites any supplied value before forwarding.

The extension receives:

```ts
type ToolRequestV2 = {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  sessionId: string;
  timeoutMs: number;
};
```

The extension computes a local expiry time when it receives the request. A relative timeout is used instead of an absolute timestamp so remote machines do not depend on synchronized clocks.

The offscreen document validates the authenticated protocol version and forwards the v2 envelope unchanged over its runtime port. The background service worker validates the envelope schema, hydrates `SessionStateStore`, resolves the request's initial tab, creates a request-owned context, and then enters the scheduler. Invalid envelopes are rejected before any Chrome API is called.

The server and extension keep their build-local protocol constants and discriminated message types because they publish independently. `MyBrowser/server/src/protocol-conformance.test.ts` imports both pure protocol modules, exercises both auth directions, and fails when their protocol constants or envelope shapes drift.

## Hub authorization

The WebSocket handler tracks an explicit role after authentication and dispatches messages through role-specific allowlists.

### Extension role

Extensions may send only:

- tool responses;
- heartbeat messages;
- validated browser events;
- note persistence/count messages already supported by the extension flow;
- `renewRecordingReservation` messages carrying the bound session and reserved name;
- `persistRecording` messages with request IDs.

The new extension messages have explicit schemas:

```ts
type RenewRecordingReservation = {
  type: "renewRecordingReservation";
  id: string;
  sessionId: string;
  name: string;
};

type PersistRecording = {
  type: "persistRecording";
  id: string;
  sessionId: string;
  payload: Recording;
};
```

The hub accepts either message only when the named reservation exists and is owned by the supplied live session. It returns a correlated success or redacted error response.

An extension cannot invoke `hub_rpc` or proxy a tool request. The current unguarded `saveRecording` path is removed rather than retrofitted; its replacement is extension-only and always returns a correlated persistence result.

### Client role

Clients may send:

- session registration;
- approved hub RPC methods;
- proxied tool requests after registration;
- heartbeat messages.

### Session-scoped RPC

RPC dispatch receives an authorization context rather than raw parameters alone:

```ts
type RpcAuthContext = {
  role: "client";
  sessionId: string;
};
```

The hub derives the acting session for session-scoped methods. Wire parameters no longer control the subject session for:

- touching or removing a session;
- claiming, releasing, or releasing all tabs;
- selecting and resolving a browser;
- registering, listing, unregistering, or clearing event handlers;
- waiting for events;
- acquiring, releasing, or cleaning up locks.

Tab transfer derives `fromSessionId` from the authenticated socket and accepts only a target session ID. Global authenticated reads, shared-state operations, note operations, browser listing/default selection, and lock listing remain available to registered MCP clients. Internal cleanup RPCs are not exposed as arbitrary client operations.

For ordinary proxied tool requests, the hub ignores and overwrites client-supplied `targetBrowserId`. Browser routing comes from the bound session's selected browser, persisted default, or exactly-one-browser fallback. Explicit browser routing remains available only through server-owned APIs that validate the requested browser, such as event-handler registration.

Internal-only operations include removing arbitrary sessions, clearing another session's handlers, releasing another session's locks, and browser-disconnect cleanup. They are invoked directly by hub lifecycle code, not exposed through client-selected RPC subjects.

An authenticated but unregistered client receives `SESSION_NOT_REGISTERED` for any hub RPC other than registration and for every tool proxy attempt. A forbidden role message returns a structured, redacted `AUTH_ROLE_VIOLATION` response when correlation is possible and immediately closes the socket with application close code `4403`; there is no untestable repeated-violation threshold.

Server-side tab ownership remains the authorization layer that decides whether session S may mutate tab T. Extension-side queues are the concurrency layer that orders work already authorized for T. Neither replaces the other.

## Extension request isolation

### Session tab state

Replace the global `currentTabId` with:

```ts
const lastTabBySession = new Map<string, number>();
```

This map is browser-local because each extension instance represents one Chrome browser. A session routed to another browser uses that extension's independent map. Browser IDs remain ephemeral across extension WebSocket reconnects; a stale server-side browser selection falls back through the existing target-resolution policy.

The separate module-global `lastUsedTabId` in `tab-manager.ts` is also removed. `resolveTabId` accepts session state explicitly, and `handleTool` no longer performs an unconditional global `setLastUsedTabId` update.

A new request resolves its initial tab once, in this order:

1. an explicit valid `payload.tabId`;
2. the session's valid last tab;
3. the currently active injectable Chrome tab.

An explicitly requested invalid tab fails; it does not silently fall back. If a stored last tab is gone, that entry is removed before resolving an active tab.

`select_tab` and `new_tab` update only the calling session's last-tab entry. Closing a tab clears every session entry that references it.

`lastTabBySession` is backed by a small `SessionStateStore` that writes through to `chrome.storage.session`. The background service worker hydrates the calling session's state before resolving each request, so worker restart does not fall back to another session's prior tab.

### Request-owned context

Each tool request creates a context containing:

- immutable `sessionId` and request ID;
- request-local current tab state;
- an `InputDevice` owned by that request;
- the local expiry time;
- controlled methods for updating the request's tab and the session's last-tab entry.

Changing a context's tab updates only that request and its session fallback. No `InputDevice` is shared between requests.

### Per-tab scheduler

The scheduler wraps public request dispatch in the background service worker after the request's initial tab has been resolved. It does not wrap every internal `handleTool` call independently.

All tab-targeted public requests enter a FIFO queue keyed by browser-local tab ID. Different tab queues run independently. A compound action acquires one tab queue for the entire sequence and receives an opaque lease token through its request context; nested action steps reuse that lease instead of re-entering the queue.

Protocol v2 recordings are single-tab. `browser_replay` requires an initial `tabId`, passes the existing server ownership check for that tab, and holds the same tab lease for its full sequence. `new_tab`, `select_tab`, and `close_tab` are no longer recordable. Secure multi-tab recordings require a future design with logical tab aliases and ownership checks for every transition.

Tools without a tab are handled as follows:

- session recording start/stop use a FIFO queue keyed by session ID;
- shared recording persistence and name reservation use hub-side atomic operations;
- browser-global tab creation/listing and diagnostics use small dedicated queues only where mutation requires ordering;
- read-only operations that touch no tab state run directly.

Session recording-control queues and tab queues do not infer order between requests issued concurrently. A caller must await successful `browser_record_start` before issuing actions it expects to record, and await its actions before calling `browser_record_stop`.

The scheduler has fixed bounds:

- at most 100 pending requests per tab;
- at most 500 pending scheduled requests in one extension instance.

Requests beyond those limits fail with an overload error. A request that expires before it starts is rejected without invoking its handler. One failed request cannot poison the queue behind it. Idle queues are deleted.

Tab closure rejects queued work for that tab. Every queued entry retains its session ID, so final session cleanup also rejects that session's pending entries in tab queues before removing the session's fallback tab and active recording.

Queue closures live only in the MV3 background service worker and are not persisted. The offscreen runtime tracks each tool request ID forwarded to the worker until it sees the correlated response. If the port disconnects, it sends a `messageResponse` carrying `EXTENSION_WORKER_RESTARTED` back to the hub over the WebSocket for each pending ID and never replays them automatically. The new worker starts with empty queues and rehydrates only session tab and sanitized recording state. FIFO and queue-bound guarantees apply within one worker incarnation.

Extension tool classifications move to one metadata table consumed by the scheduler and recorder instead of separate `NO_TAB_TOOLS` and `RECORDABLE_TOOLS` decisions. Server ownership metadata remains server-side, and a cross-package contract test checks that shared mutating tool names have compatible tab requirements.

## Recording isolation and privacy

### Active ownership

Active recording state becomes:

```ts
const activeRecordings = new Map<string, ActiveRecording>();
```

The key is the authenticated session ID. A session can start, append to, and stop only its own recording. Different sessions may record concurrently.

The current global `replaying` boolean becomes a `Set<sessionId>`. Recording suppression applies only while the same session is replaying.

Sanitized active recording state writes through to `chrome.storage.session` after start and each appended step. A restarted background worker hydrates it before handling the session's next recording command. No original input value is ever included in this restart state. Active recordings are capped at 1,000 steps and 2 MiB each, with an 8 MiB aggregate cap across sessions. A would-be recorded action that exceeds a cap is rejected with `RECORDING_STATE_LIMIT` before its browser side effect begins.

The server reserves a normalized recording name for the session before recording begins. Existing completed names or names reserved by another session fail clearly. Reservation acquire and release are acknowledged hub operations, not fire-and-forget messages. A reservation uses a 30-minute lease renewed every five minutes while recording; expiry causes the hub to broadcast `recording_reservation_expired` for that session and name, and the extension aborts the matching active recording, deletes its `chrome.storage.session` entry, and refuses an unreserved stop. Reservations are released after successful stop, failed start, lease expiry, or final session cleanup. Persistence never silently overwrites another artifact.

### Input parameterization

Values are parameterized before a step enters recording memory. Parameterization is default-deny: every string-valued argument of a recordable tool is parameterized unless tool metadata explicitly classifies that field as safe structural input. At minimum, the following values are always replaced:

- `browser_type.text`;
- every `browser_fill_form.fields` value;
- `browser_select_option.values`;
- future recordable clipboard or direct-input values;
- an explicit navigation URL when it contains credentials, a query string, or a fragment.

Placeholders use deterministic names within one recording, for example `{{input_1}}` and `{{form_email_2}}`. Repeated use of the same source field in one step may reuse its placeholder, but original values are never retained in a reverse lookup table.

Recording metadata stores only:

```ts
type RequiredVariable = {
  name: string;
  source: "text" | "form" | "select" | "navigation" | "clipboard";
  hint?: string;
};
```

`hint` uses generic descriptors such as `text_input_1` or `select_2`. It is not derived from the user-entered value, DOM label text, field name, URL path segment, or selector.

For query-dependent navigation, the full explicit URL becomes one required replay variable; the recording does not retain a stripped URL that would replay incorrectly. Captured current-page metadata keeps only origin and pathname. Credentials, query strings, and fragments are removed. Origin and pathname remain accepted residual metadata exposure in the shared library; authenticated users should not treat recording names or visited paths as secret storage.

### Replay validation

Before replay executes any handler, it scans all placeholders and verifies that the caller supplied every required variable. Missing variables return a complete list and perform no browser side effects.

Replay preflight also rejects any legacy recording containing `new_tab`, `select_tab`, or `close_tab` with `RECORDING_UNSUPPORTED_MULTI_TAB` and performs no browser side effects. Legacy multi-tab recordings remain visible in list results with `compatible: false`; protocol v2 does not replay them until a future secure multi-tab design exists.

Substitution operates on a cloned step. Supplied values are not written back into the recording, diagnostics, or persistence payload.

### Completed recording access

Completed recordings contain placeholders only and enter the shared recording library. Any authenticated MCP session may list and replay them by name. Active recording control remains private to the owning session.

### Persistence acknowledgement

Recording persistence uses request/response messages with correlation IDs. The extension waits for the hub's filesystem acknowledgement instead of treating a fire-and-forget send as success.

`browser_record_stop` reports the state of both stores:

- extension storage saved;
- server filesystem saved;
- partial persistence with a redacted error.

The sanitized recording is returned even when one store fails so the caller can recover it manually. A server file is created atomically and never replaces an existing recording with the same reserved name.

The hub reservation is the authoritative collision guard for both stores. Extension storage checks for an existing key and uses the active reservation before writing; the server uses exclusive destination creation rather than temp-file rename over an existing path.

## Cleanup and reconnect behavior

The existing reconnect grace period remains authoritative. A brief client disconnect retains session ownership, queued state, and an active recording so reconnect can continue safely.

When grace expires, the hub performs final cleanup and broadcasts:

```ts
type SessionClosed = {
  type: "session_closed";
  sessionId: string;
};
```

Each extension then:

- deletes `lastTabBySession[sessionId]`;
- deletes the session's `chrome.storage.session` state;
- rejects remaining session-queued work;
- discards the unfinished active recording;
- removes local event-handler mirrors for that session.

`session_closed` becomes the single extension-side session-cleanup trigger and supersedes the current session-scoped `browser_unregister_handler` broadcast. Handler teardown is one sub-action of session cleanup rather than a second parallel broadcast.

Cleanup is idempotent. Receiving the same control message twice has no additional effect. Extension WebSocket reconnect is separate from MCP-session reconnect: the extension receives a new ephemeral browser ID, while stale session browser selections are cleared by existing hub target resolution.

## Error handling

Errors use stable categories suitable for tests and diagnostics:

- `PROTOCOL_VERSION_MISMATCH`;
- `AUTH_ROLE_VIOLATION`;
- `SESSION_NOT_REGISTERED`;
- `SESSION_IDENTITY_MISMATCH`;
- `REQUEST_EXPIRED`;
- `QUEUE_OVERLOADED`;
- `TAB_CLOSED`;
- `RECORDING_NOT_OWNED`;
- `RECORDING_NAME_CONFLICT`;
- `RECORDING_RESERVATION_EXPIRED`;
- `RECORDING_STATE_LIMIT`;
- `RECORDING_UNSUPPORTED_MULTI_TAB`;
- `REPLAY_VARIABLES_MISSING`;
- `RECORDING_PERSISTENCE_PARTIAL`;
- `EXTENSION_WORKER_RESTARTED`.

Client-facing messages remain actionable, while logs and diagnostics omit tokens, typed values, form values, replay substitutions, and full sensitive URLs.

## Test strategy

Both packages gain Vitest and explicit `test` scripts before production behavior changes. Browser-dependent modules use narrow `ChromeTabsAdapter`, `SessionStorageAdapter`, clock, and transport interfaces so scheduler, context, recorder, parameterizer, and protocol behavior can be tested without loading Chrome. Concurrency tests use deferred promises and a fake clock to force exact interleavings rather than relying on timing or a negative "could not reproduce" assertion.

### Server unit and WebSocket integration tests

Tests cover:

- protocol v1 and missing-version rejection;
- new-extension rejection of an old auth result with no protocol version;
- extension `hub_rpc` rejection;
- client rejection from the extension-only persistence path;
- proxy rejection before session registration;
- immutable socket-to-session binding;
- duplicate live-session registration rejection;
- reconnect reclaim during grace;
- session ID overwrite before extension forwarding;
- client `targetBrowserId` overwrite during ordinary tool proxying;
- source identity derivation during tab transfer;
- the trusted hub-local session envelope;
- extension and client message allowlists;
- recording name reservation, renewal, expiry, and cleanup;
- rejection of reservation renewal/persistence from the wrong role, session, or name;
- persistence acknowledgement and collision behavior.

Integration tests run a real hub on an ephemeral loopback port with two fake clients and one fake extension. They assert forwarded envelopes, response correlation, authorization failures, and cleanup messages.

### Extension unit tests

Tests cover:

- explicit, session-fallback, and active-tab resolution;
- invalid explicit tab failure;
- removal of both global tab fallbacks;
- independent contexts and `InputDevice` instances;
- simultaneous requests targeting different tabs;
- FIFO execution for one tab;
- compound-action lease reuse;
- full-replay lease reuse on one required tab;
- queue continuation after failure;
- queue expiry, overload, tab closure, and idle cleanup;
- offscreen rejection of pending requests when the worker port disconnects;
- state rehydration after a simulated worker restart;
- simultaneous recordings for two sessions;
- cross-session stop rejection;
- per-session replay suppression;
- exclusion of new/select/close-tab from recordings;
- incompatible marking and side-effect-free rejection of legacy multi-tab recordings;
- complete parameterization of typed, form, select, and sensitive URL values;
- a canary secret test for every recordable tool, which fails when a string field lacks an explicit safe or parameterized classification;
- per-recording and aggregate restart-state limits before browser side effects;
- absence of original values in serialized output;
- replay preflight failure before any handler call;
- final session cleanup and idempotence.

### Verification gates

The implementation is complete only when:

1. server tests pass;
2. extension tests pass;
3. both TypeScript checks pass;
4. both production builds pass;
5. the real WebSocket integration suite passes;
6. a manual, out-of-CI loaded-extension smoke test demonstrates two MCP sessions operating on two tabs without target crossover;
7. serialized recording fixtures contain none of the supplied test secrets;
8. the working tree contains only intended source, test, lockfile, and documentation changes.

## Rollout

1. Add Vitest, deterministic adapters, and failing protocol authorization tests to both packages.
2. Add protocol constants and discriminated message types; make both peers reject an incompatible auth result.
3. Enforce socket roles, bidirectional session indexes, server-owned routing, and session binding in the hub.
4. Add the extension request context, restart-safe session store, offscreen pending-request tracking, and scheduler behind protocol v2.
5. Replace global recording/replay state, restrict recordings to one tab, and add default-deny parameterization.
6. Add reservation leases, persistence acknowledgements, and the consolidated session cleanup broadcast.
7. Run deterministic integration tests and the manual loaded-extension smoke test.
8. Continue with the remaining release-blocking workstreams before changing package versions or publishing.

## Acceptance criteria

- A two-tab concurrency test cannot reproduce target crossover.
- A client or extension cannot invoke session-scoped behavior as another session.
- Same-tab operations are FIFO within one worker incarnation; different tabs remain concurrent.
- Two sessions can record at once without sharing steps or control.
- No original typed or form value appears anywhere in a stopped recording.
- Replay with missing variables performs zero browser actions.
- Replay requires one authorized tab and cannot execute recorded tab-management transitions.
- A simulated worker restart rehydrates session tab and sanitized active-recording state while rejecting unacknowledged in-flight work.
- Protocol v1 peers and v2 peers connected to an old server receive a clear coordinated-upgrade error.
- All automated and manual verification gates pass.
