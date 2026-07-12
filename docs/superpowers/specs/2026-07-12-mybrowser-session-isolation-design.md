# MyBrowser Session Isolation Design

**Date:** 2026-07-12  
**Status:** Approved for implementation planning  
**Scope:** MyBrowser MCP server and Chrome extension  
**Target protocol:** v2

## Purpose

MyBrowser currently presents multi-session ownership controls at the MCP layer while the extension still executes requests through shared mutable state. Concurrent requests can switch one another's target tab, hub RPC callers can act as another session, and the recorder can mix and expose actions from unrelated sessions.

This design makes session identity authoritative from the MCP socket through the hub and into the extension. It also isolates request tab state, serializes work per tab, and prevents recordings from persisting user-entered values.

## Goals

1. A request can act only as the session bound to its MCP client socket.
2. Concurrent requests cannot change one another's target tab or input device.
3. Requests for different tabs can execute concurrently, while requests for one tab execute in FIFO order.
4. Multiple sessions can record simultaneously without mixing steps.
5. Typed text and form values never enter persisted recording data.
6. Incompatible server and extension versions fail closed with an actionable upgrade error.
7. The behavior is covered by deterministic unit and WebSocket integration tests.

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

Successful authentication returns:

```ts
type AuthResult = {
  type: "auth";
  status: "ok";
  protocolVersion: 2;
  browserId?: string;
};
```

Missing or incompatible versions return an error containing the supported version and then close the socket with application close code `4406`. There is no v1 compatibility mode.

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

## Hub authorization

The WebSocket handler tracks an explicit role after authentication and dispatches messages through role-specific allowlists.

### Extension role

Extensions may send only:

- tool responses;
- heartbeat messages;
- validated browser events;
- note persistence/count messages already supported by the extension flow;
- recording persistence messages with request IDs.

An extension cannot invoke `hub_rpc` or proxy a tool request.

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

Role violations return a structured, redacted authorization error. Repeated violations or an extension attempt to invoke client RPC close the socket.

## Extension request isolation

### Session tab state

Replace the global `currentTabId` with:

```ts
const lastTabBySession = new Map<string, number>();
```

A new request resolves its initial tab once, in this order:

1. an explicit valid `payload.tabId`;
2. the session's valid last tab;
3. the currently active injectable Chrome tab.

An explicitly requested invalid tab fails; it does not silently fall back. If a stored last tab is gone, that entry is removed before resolving an active tab.

`select_tab` and `new_tab` update only the calling session's last-tab entry. Closing a tab clears every session entry that references it.

### Request-owned context

Each tool request creates a context containing:

- immutable `sessionId` and request ID;
- request-local current tab state;
- an `InputDevice` owned by that request;
- the local expiry time;
- controlled methods for updating the request's tab and the session's last-tab entry.

Changing a context's tab updates only that request and its session fallback. No `InputDevice` is shared between requests.

### Per-tab scheduler

All tab-targeted public requests enter a FIFO queue keyed by browser-local tab ID. Different tab queues run independently. A compound action acquires one tab queue for the entire sequence, and nested action steps reuse the existing lease instead of deadlocking.

Replay does not hold a global lease. It schedules each recorded step against that step's resolved tab, allowing unrelated tabs to continue while preserving FIFO ordering on affected tabs.

Tools without a tab are handled as follows:

- session recording start/stop use a FIFO queue keyed by session ID;
- shared recording persistence and name reservation use hub-side atomic operations;
- browser-global tab creation/listing and diagnostics use small dedicated queues only where mutation requires ordering;
- read-only operations that touch no tab state run directly.

The scheduler has fixed bounds:

- at most 100 pending requests per tab;
- at most 500 pending scheduled requests in one extension instance.

Requests beyond those limits fail with an overload error. A request that expires before it starts is rejected without invoking its handler. One failed request cannot poison the queue behind it. Idle queues are deleted.

Tab closure rejects queued work for that tab. Every queued entry retains its session ID, so final session cleanup also rejects that session's pending entries in tab queues before removing the session's fallback tab and active recording.

## Recording isolation and privacy

### Active ownership

Active recording state becomes:

```ts
const activeRecordings = new Map<string, ActiveRecording>();
```

The key is the authenticated session ID. A session can start, append to, and stop only its own recording. Different sessions may record concurrently.

The server reserves a normalized recording name for the session before recording begins. Existing completed names or names reserved by another session fail clearly. Reservations are released after successful stop, failed start, or final session cleanup. Persistence never silently overwrites another artifact.

### Input parameterization

Values are parameterized before a step enters recording memory. The following values are replaced:

- `browser_type.text`;
- every `browser_fill_form.fields` value;
- `browser_select_option.values`;
- future recordable clipboard or direct-input values;
- navigation URL credentials, query strings, and fragments.

Placeholders use deterministic names within one recording, for example `{{input_1}}` and `{{form_email_2}}`. Repeated use of the same source field in one step may reuse its placeholder, but original values are never retained in a reverse lookup table.

Recording metadata stores only:

```ts
type RequiredVariable = {
  name: string;
  source: "text" | "form" | "select" | "navigation" | "clipboard";
  hint?: string;
};
```

`hint` may contain only non-sensitive structural metadata such as a field label or action type. It is never derived from the original user-entered value.

Captured current-page URLs keep only origin and pathname. Credentials, query strings, and fragments are removed.

### Replay validation

Before replay executes any handler, it scans all placeholders and verifies that the caller supplied every required variable. Missing variables return a complete list and perform no browser side effects.

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
- rejects remaining session-queued work;
- discards the unfinished active recording;
- removes local event-handler mirrors for that session.

Cleanup is idempotent. Receiving the same control message twice has no additional effect.

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
- `REPLAY_VARIABLES_MISSING`;
- `RECORDING_PERSISTENCE_PARTIAL`.

Client-facing messages remain actionable, while logs and diagnostics omit tokens, typed values, form values, replay substitutions, and full sensitive URLs.

## Test strategy

Both packages gain a TypeScript-capable unit test runner. Browser-dependent modules use narrow adapters so scheduler, context, recorder, parameterizer, and protocol behavior can be tested without loading Chrome.

### Server unit and WebSocket integration tests

Tests cover:

- protocol v1 and missing-version rejection;
- extension `hub_rpc` rejection;
- proxy rejection before session registration;
- immutable socket-to-session binding;
- duplicate live-session registration rejection;
- reconnect reclaim during grace;
- session ID overwrite before extension forwarding;
- source identity derivation during tab transfer;
- extension and client message allowlists;
- recording name reservation and cleanup;
- persistence acknowledgement and collision behavior.

Integration tests run a real hub on an ephemeral loopback port with two fake clients and one fake extension. They assert forwarded envelopes, response correlation, authorization failures, and cleanup messages.

### Extension unit tests

Tests cover:

- explicit, session-fallback, and active-tab resolution;
- invalid explicit tab failure;
- independent contexts and `InputDevice` instances;
- simultaneous requests targeting different tabs;
- FIFO execution for one tab;
- compound-action lease reuse;
- queue continuation after failure;
- queue expiry, overload, tab closure, and idle cleanup;
- simultaneous recordings for two sessions;
- cross-session stop rejection;
- complete parameterization of typed, form, select, and sensitive URL values;
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
6. a loaded-extension smoke test demonstrates two MCP sessions operating on two tabs without target crossover;
7. serialized recording fixtures contain none of the supplied test secrets;
8. the working tree contains only intended source, test, lockfile, and documentation changes.

## Rollout

1. Add protocol constants, discriminated message types, and failing protocol authorization tests.
2. Enforce socket roles and session binding in the hub.
3. Add the extension request context and scheduler behind protocol v2.
4. Replace global recording state and add parameterization.
5. Add persistence acknowledgements and session cleanup broadcasts.
6. Run integration and loaded-extension smoke tests.
7. Continue with the remaining release-blocking workstreams before changing package versions or publishing.

## Acceptance criteria

- A two-tab concurrency test cannot reproduce target crossover.
- A client or extension cannot invoke session-scoped behavior as another session.
- Same-tab operations are FIFO; different tabs remain concurrent.
- Two sessions can record at once without sharing steps or control.
- No original typed or form value appears anywhere in a stopped recording.
- Replay with missing variables performs zero browser actions.
- Protocol v1 peers receive a clear coordinated-upgrade error.
- All automated and manual verification gates pass.
