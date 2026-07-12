# MyBrowser Session Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make session identity authoritative from MCP socket to extension, isolate concurrent tab execution, and make recordings session-owned and secret-free.

**Architecture:** Protocol v2 authenticates both directions and binds each remote MCP socket to one session. The extension hydrates browser-local session state, creates one execution context per request, and schedules tab work through bounded FIFO queues. Recording state is session-owned, parameterized before execution, restart-safe in `chrome.storage.session`, and persisted through acknowledged hub messages.

**Tech Stack:** TypeScript 5.7, Node.js 18+, `ws`, WXT MV3, Chrome extension APIs, Zod, Vitest 3.2.7.

## Global Constraints

- Protocol version is exactly `2`; old peers fail closed with WebSocket close code `4406`.
- A forbidden role message closes with code `4403`.
- Server and extension are upgraded together; neither side may silently downgrade.
- The hub derives session identity from the client socket and overwrites client-supplied `sessionId` and ordinary-tool `targetBrowserId`.
- Tab queues allow at most 100 pending requests per tab and 500 total per extension worker incarnation.
- Last-tab and sanitized active-recording state use `chrome.storage.session`; executable queue closures are never persisted or replayed after worker restart.
- Active recordings allow at most 1,000 steps, 2 MiB each, and 8 MiB total across sessions.
- Protocol v2 recordings are single-tab. `browser_record_start` and `browser_replay` require `tabId`; tab-management tools are not recordable; `browser_record_stop` does not require tab ownership.
- User-entered values and sensitive URLs are parameterized before a recorded action executes. Original values never enter recording memory, storage, logs, or persistence payloads.
- Vitest is pinned to `3.2.7`, whose published engine range includes Node 18.
- Every production change follows red-green-refactor and ends with the narrow test, package typecheck, and a focused commit.

## File and responsibility map

### Server

- Create `MyBrowser/server/src/protocol.ts`: protocol constants, message types, guards, and stable error codes.
- Create `MyBrowser/server/src/protocol-conformance.test.ts`: imports both pure protocol modules and prevents version/envelope drift.
- Create `MyBrowser/server/src/session-connections.ts`: bidirectional socket/session registry.
- Create `MyBrowser/server/src/session-connections.test.ts`: duplicate, switch, close, and reconnect behavior.
- Create `MyBrowser/server/src/hub-rpc.ts`: role-aware RPC dispatch with derived session identity.
- Create `MyBrowser/server/src/hub-rpc.test.ts`: spoof and internal-method authorization tests.
- Create `MyBrowser/server/src/ws-server.test.ts`: real loopback WebSocket integration tests.
- Create `MyBrowser/server/src/state-manager.test.ts`: recording reservation and cleanup tests.
- Create `MyBrowser/server/vitest.config.ts`: Node test environment.
- Modify `MyBrowser/server/src/ws-server.ts`: v2 auth, allowlists, routing, control broadcasts, persistence acknowledgements.
- Modify `MyBrowser/server/src/context.ts`: inject trusted local session identity and separate ordinary from server-authorized browser routing.
- Modify `MyBrowser/server/src/hub-client.ts`: v2 auth and subject-free session RPC parameters.
- Modify `MyBrowser/server/src/state-manager.ts`: recording reservation leases and single cleanup broadcast.
- Modify `MyBrowser/server/src/server.ts`: recording-tool factory, ownership classification, and trusted hub-local session path.
- Modify `MyBrowser/server/src/tools/record.ts`: tab-bound start, acknowledged stop status, safe exclusive persistence.
- Modify `MyBrowser/server/src/tools/replay.ts`: required `tabId`, compatibility reporting, and no secret echo.
- Modify `MyBrowser/server/package.json` and `package-lock.json`: Vitest and `test` script.

### Extension

- Modify `MyBrowser/extension/src/lib/protocol.ts`: v2 auth, envelopes, control messages, and guards.
- Create `MyBrowser/extension/src/lib/protocol.test.ts`: runtime guard tests.
- Create `MyBrowser/extension/src/lib/offscreen-pending.ts` and `.test.ts`: track forwarded requests and fail them on worker restart.
- Create `MyBrowser/extension/src/lib/session-state.ts` and `.test.ts`: browser-local `chrome.storage.session` abstraction.
- Create `MyBrowser/extension/src/lib/request-scheduler.ts` and `.test.ts`: bounded per-tab/session FIFO queues.
- Create `MyBrowser/extension/src/lib/request-context.ts` and `.test.ts`: request-owned tab and `InputDevice` state.
- Create `MyBrowser/extension/src/lib/tool-metadata.ts` and `.test.ts`: one scope/recording classification table.
- Create `MyBrowser/extension/src/lib/recording-parameterizer.ts` and `.test.ts`: default-deny string classification and placeholders.
- Rewrite `MyBrowser/extension/src/lib/recorder.ts`; create `recorder.test.ts`: per-session manager and restart-safe storage.
- Modify `MyBrowser/extension/src/lib/replayer.ts`; create `replayer.test.ts`: complete preflight and cloned substitution.
- Modify `MyBrowser/extension/src/lib/tab-manager.ts`: stateless tab resolution.
- Modify `MyBrowser/extension/src/lib/tools.ts`: request-owned context, session recorder calls, and removal of globals.
- Modify `MyBrowser/extension/src/lib/reconnecting-ws.ts`: bidirectional version enforcement.
- Modify `MyBrowser/extension/src/entrypoints/offscreen/main.ts`: pending-request correlation and restart errors.
- Modify `MyBrowser/extension/src/entrypoints/background/index.ts`: envelope validation, hydration, context creation, scheduling, and cleanup.
- Create `MyBrowser/extension/vitest.config.ts`; modify `package.json` and `package-lock.json` for Vitest.

---

### Task 1: Install test harnesses and define protocol v2

**Files:**
- Modify: `MyBrowser/server/package.json`
- Modify: `MyBrowser/server/package-lock.json`
- Create: `MyBrowser/server/vitest.config.ts`
- Create: `MyBrowser/server/src/protocol.ts`
- Create: `MyBrowser/server/src/protocol-conformance.test.ts`
- Modify: `MyBrowser/extension/package.json`
- Modify: `MyBrowser/extension/package-lock.json`
- Create: `MyBrowser/extension/vitest.config.ts`
- Modify: `MyBrowser/extension/src/lib/protocol.ts`
- Create: `MyBrowser/extension/src/lib/protocol.test.ts`

**Interfaces:**
- Produces: `PROTOCOL_VERSION`, `WS_CLOSE`, `ProtocolErrorCode`, `AuthRequestV2`, `AuthResultV2`, `ToolRequestV2`, `ToolResponse`, `isAuthResultV2()`, and `isToolRequestV2()` in both packages.
- Consumes: no feature code; this is the foundation for every later task.

- [ ] **Step 1: Install the Node-18-compatible test runner in both packages**

Run:

```bash
cd MyBrowser/server && npm install --save-dev vitest@3.2.7
cd ../extension && npm install --save-dev vitest@3.2.7
```

Add `"test": "vitest run"` to both `scripts` objects. Create this config in both packages:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    clearMocks: true,
    restoreMocks: true,
  },
});
```

- [ ] **Step 2: Write failing protocol tests**

Use explicit imports from `vitest`. The server conformance test must assert both modules export version `2`, reject an auth result with no version, and accept this envelope:

```ts
const request = {
  id: "req-1",
  type: "browser_click",
  payload: { tabId: 7 },
  sessionId: "session-a",
  timeoutMs: 30_000,
};
expect(serverProtocol.isToolRequestV2(request)).toBe(true);
expect(extensionProtocol.isToolRequestV2(request)).toBe(true);
```

Run:

```bash
cd MyBrowser/server && npm test -- src/protocol-conformance.test.ts
cd ../extension && npm test -- src/lib/protocol.test.ts
```

Expected: FAIL because the v2 exports and guards do not exist.

- [ ] **Step 3: Implement the minimal pure protocol modules**

Both modules expose the same core contract:

```ts
export const PROTOCOL_VERSION = 2 as const;
export const WS_CLOSE = {
  unauthorized: 4001,
  invalidJson: 4003,
  forbiddenRole: 4403,
  versionMismatch: 4406,
} as const;

export type ConnectionRole = "client" | "extension";
export type ProtocolErrorCode =
  | "PROTOCOL_VERSION_MISMATCH"
  | "AUTH_ROLE_VIOLATION"
  | "SESSION_NOT_REGISTERED"
  | "SESSION_IDENTITY_MISMATCH"
  | "REQUEST_EXPIRED"
  | "QUEUE_OVERLOADED"
  | "TAB_CLOSED"
  | "RECORDING_NOT_OWNED"
  | "RECORDING_NAME_CONFLICT"
  | "RECORDING_RESERVATION_EXPIRED"
  | "RECORDING_STATE_LIMIT"
  | "RECORDING_UNSUPPORTED_MULTI_TAB"
  | "REPLAY_VARIABLES_MISSING"
  | "RECORDING_PERSISTENCE_PARTIAL"
  | "EXTENSION_WORKER_RESTARTED";

export interface ToolRequestV2 {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  sessionId: string;
  timeoutMs: number;
}
```

Implement guards with `typeof`, `Number.isFinite`, and `PROTOCOL_VERSION`; do not pull Chrome or Node-only modules into either protocol file.

- [ ] **Step 4: Run protocol tests, typechecks, and commit**

Run:

```bash
cd MyBrowser/server && npm test -- src/protocol-conformance.test.ts && npm run check
cd ../extension && npm test -- src/lib/protocol.test.ts && npm run check
git add MyBrowser/server MyBrowser/extension
git commit -m "test: establish protocol v2 contract"
```

Expected: all tests and both typechecks pass.

---

### Task 2: Enforce connection roles and immutable session binding

**Files:**
- Create: `MyBrowser/server/src/session-connections.ts`
- Create: `MyBrowser/server/src/session-connections.test.ts`
- Modify: `MyBrowser/server/src/ws-server.ts`
- Create: `MyBrowser/server/src/ws-server.test.ts`
- Modify: `MyBrowser/server/src/hub-client.ts`

**Interfaces:**
- Consumes: `AuthRequestV2`, `PROTOCOL_VERSION`, and `WS_CLOSE` from Task 1.
- Produces: `SessionConnectionRegistry<TSocket>` with `bind`, `getSession`, `unbind`, and `hasLiveSession`.

- [ ] **Step 1: Write registry and auth failure tests**

Cover these exact cases:

```ts
const registry = new SessionConnectionRegistry<object>();
const a = {};
const b = {};
expect(registry.bind(a, "s1")).toEqual({ ok: true });
expect(registry.bind(a, "s2")).toEqual({ ok: false, code: "SESSION_IDENTITY_MISMATCH" });
expect(registry.bind(b, "s1")).toEqual({ ok: false, code: "SESSION_IDENTITY_MISMATCH" });
expect(registry.unbind(a)).toBe("s1");
expect(registry.bind(b, "s1")).toEqual({ ok: true });
```

In `ws-server.test.ts`, connect with real `ws` clients on an ephemeral loopback port and assert missing version closes `4406`, missing role closes `4403`, and an extension receives an auth result with version `2` and a browser ID.

Add `boundPort: number` to `WsServerResult`. When `port: 0` is requested, read the actual port from `WebSocketServer.address()` after the listening event and return it so tests never reserve a fixed port.

Expected first run: FAIL because registry and v2 auth do not exist.

- [ ] **Step 2: Implement the bidirectional registry**

Use two maps and mutate neither on failure:

```ts
export class SessionConnectionRegistry<TSocket extends object> {
  private readonly socketToSession = new Map<TSocket, string>();
  private readonly sessionToSocket = new Map<string, TSocket>();

  bind(socket: TSocket, sessionId: string) {
    const existingSession = this.socketToSession.get(socket);
    const existingSocket = this.sessionToSocket.get(sessionId);
    if ((existingSession && existingSession !== sessionId) ||
        (existingSocket && existingSocket !== socket)) {
      return { ok: false as const, code: "SESSION_IDENTITY_MISMATCH" as const };
    }
    this.socketToSession.set(socket, sessionId);
    this.sessionToSocket.set(sessionId, socket);
    return { ok: true as const };
  }

  getSession(socket: TSocket) { return this.socketToSession.get(socket); }
  hasLiveSession(sessionId: string) { return this.sessionToSocket.has(sessionId); }
  unbind(socket: TSocket) {
    const sessionId = this.socketToSession.get(socket);
    if (!sessionId) return undefined;
    this.socketToSession.delete(socket);
    if (this.sessionToSocket.get(sessionId) === socket) this.sessionToSocket.delete(sessionId);
    return sessionId;
  }
}
```

- [ ] **Step 3: Replace boolean auth state with an immutable connection role**

In `ws-server.ts`, validate `role` and `protocolVersion` before registering a browser or acknowledging a client. Return `{ type: "auth", status: "ok", protocolVersion: 2 }`, adding `browserId` only for extensions. Remove missing-role backward compatibility.

For `hub_rpc(registerSession)`, bind the socket before `stateManager.registerSession`; on duplicate/switch failure, send `hub_rpc_result` with `SESSION_IDENTITY_MISMATCH`. On close, call `registry.unbind(ws)` and schedule cleanup only for the returned session.

In both initial and reconnect client paths in `hub-client.ts`, send:

```ts
{ type: "auth", token, role: "client", protocolVersion: PROTOCOL_VERSION }
```

Reject auth success that does not echo protocol version `2`.

- [ ] **Step 4: Run focused tests and commit**

```bash
cd MyBrowser/server
npm test -- src/session-connections.test.ts src/ws-server.test.ts
npm run check
git add src package.json package-lock.json vitest.config.ts
git commit -m "fix: bind client sockets to one session"
```

---

### Task 3: Derive RPC identity and make browser routing authoritative

**Files:**
- Create: `MyBrowser/server/src/hub-rpc.ts`
- Create: `MyBrowser/server/src/hub-rpc.test.ts`
- Modify: `MyBrowser/server/src/ws-server.ts`
- Modify: `MyBrowser/server/src/hub-client.ts`
- Modify: `MyBrowser/server/src/context.ts`

**Interfaces:**
- Consumes: socket-bound session from Task 2.
- Produces: `RpcAuthContext = { role: "client"; sessionId: string }` and `dispatchHubRpc(stateManager, auth, method, params)`.

- [ ] **Step 1: Write failing spoof and role tests**

Use a fake `IStateManager` and verify:

```ts
await dispatchHubRpc(state, { role: "client", sessionId: "actual" }, "claimTab", {
  sessionId: "spoofed",
  tabKey: "b1:7",
});
expect(state.claimTab).toHaveBeenCalledWith("actual", "b1:7");
```

Also assert `transferTab` derives `fromSessionId`, `removeSession` removes only the caller, and client attempts to call `clearEventHandlersForBrowser`, `pushEvent`, or arbitrary-session lock cleanup are rejected.

- [ ] **Step 2: Extract and rewrite RPC dispatch**

Move the switch from `ws-server.ts` into `hub-rpc.ts`. Global reads keep their existing parameters. Session-scoped cases use `auth.sessionId`, never `params.sessionId` or `params.fromSessionId`. Keep registration outside this dispatcher because an unregistered socket has no `RpcAuthContext` yet.

Define explicit internal-only names:

```ts
const INTERNAL_RPC_METHODS = new Set([
  "clearEventHandlersForBrowser",
  "pushEvent",
]);
```

Return `AUTH_ROLE_VIOLATION` for those names through client RPC. Update `HubStateManager` methods to omit subject session fields while preserving its `IStateManager` method signatures for local callers.

- [ ] **Step 3: Gate proxy traffic and overwrite routing fields**

Before proxying, require `registry.getSession(ws)` or return a `messageResponse` with `SESSION_NOT_REGISTERED`. Construct a fresh forwarded envelope instead of forwarding `msg`:

```ts
const forwarded: ToolRequestV2 = {
  id: msg.id,
  type: msg.type,
  payload: isRecord(msg.payload) ? msg.payload : {},
  sessionId: boundSessionId,
  timeoutMs: normalizedTimeoutMs,
};
browserWs.send(JSON.stringify(forwarded));
```

Resolve ordinary tools from `stateManager.resolveBrowserTarget(boundSessionId)`. Honor explicit browser routing only for the server-control message types `browser_register_handler`, `browser_unregister_handler`, and `browser_list_handlers`, after verifying the requested browser exists.

In direct hub mode, `Context.sendSocketMessageCore` adds `this.sessionId`. In client mode it may send a routing hint, but the hub always overwrites identity and ordinary-tool routing.

- [ ] **Step 4: Run tests and commit**

```bash
cd MyBrowser/server
npm test -- src/hub-rpc.test.ts src/ws-server.test.ts
npm run check
git add src
git commit -m "fix: derive hub actions from socket identity"
```

---

### Task 4: Make the offscreen bridge protocol-aware and restart-safe

**Files:**
- Create: `MyBrowser/extension/src/lib/offscreen-pending.ts`
- Create: `MyBrowser/extension/src/lib/offscreen-pending.test.ts`
- Modify: `MyBrowser/extension/src/lib/reconnecting-ws.ts`
- Modify: `MyBrowser/extension/src/entrypoints/offscreen/main.ts`

**Interfaces:**
- Consumes: protocol guards from Task 1.
- Produces: `PendingToolRequests.trackInbound(raw)`, `completeOutbound(raw)`, and `failAll(send)`.

- [ ] **Step 1: Write failing auth-downgrade and pending-request tests**

Test that an auth result without version `2` never enters `CONNECTED`. For pending requests, track two request IDs, complete one response, then assert `failAll` emits exactly one response:

```ts
expect(JSON.parse(sent[0]!)).toEqual({
  type: "messageResponse",
  payload: { requestId: "r2", error: "EXTENSION_WORKER_RESTARTED" },
});
```

- [ ] **Step 2: Implement pending correlation as a pure class**

Parse only v2 tool requests into a `Set<string>`. Remove IDs only from outbound `messageResponse` messages. `failAll` serializes one stable error response per remaining ID and clears the set before sending, making duplicate disconnect callbacks harmless.

- [ ] **Step 3: Integrate protocol checks and port failure**

`ReconnectingWebSocket` sends `protocolVersion: 2` and calls `onProtocolError` when auth success lacks version `2`; do not schedule normal reconnect against an incompatible server until settings change or the user explicitly reconnects.

In the offscreen entrypoint:

- call `trackInbound` before forwarding `_os_ws_receive` to the worker;
- call `completeOutbound` before sending `_os_ws_send` over WebSocket;
- on port disconnect, call `failAll(raw => ws.send(raw))` while connected;
- never resend the original request after reconnecting the port.

- [ ] **Step 4: Verify and commit**

```bash
cd MyBrowser/extension
npm test -- src/lib/protocol.test.ts src/lib/offscreen-pending.test.ts
npm run check
git add src
git commit -m "fix: fail in-flight tools on worker restart"
```

---

### Task 5: Add restart-safe session state and bounded tab scheduling

**Files:**
- Create: `MyBrowser/extension/src/lib/session-state.ts`
- Create: `MyBrowser/extension/src/lib/session-state.test.ts`
- Create: `MyBrowser/extension/src/lib/request-scheduler.ts`
- Create: `MyBrowser/extension/src/lib/request-scheduler.test.ts`
- Create: `MyBrowser/extension/src/lib/request-context.ts`
- Create: `MyBrowser/extension/src/lib/request-context.test.ts`
- Create: `MyBrowser/extension/src/lib/tool-metadata.ts`
- Create: `MyBrowser/extension/src/lib/tool-metadata.test.ts`
- Modify: `MyBrowser/extension/src/lib/tab-manager.ts`
- Modify: `MyBrowser/extension/src/lib/tools.ts`
- Modify: `MyBrowser/extension/src/entrypoints/background/index.ts`

**Interfaces:**
- Produces: `SessionStateStore`, `RequestScheduler`, `RequestToolContext`, and `TOOL_METADATA`.
- `RequestScheduler.runTab(tabId, meta, work)` and `runSession(sessionId, meta, work)` receive `{ requestId, sessionId, expiresAt }`; `cancelTab(tabId, code)` and `cancelSession(sessionId, code)` reject matching queued entries with stable protocol error codes.
- `SessionStateStore` exposes `getLastTab(sessionId)`, `setLastTab(sessionId, tabId)`, `clearTab(tabId)`, and `clearSession(sessionId)`.

- [ ] **Step 1: Write deterministic state and scheduler tests**

Use an in-memory storage adapter and deferred promises. Prove:

- explicit tab beats session fallback;
- invalid explicit tab rejects instead of falling back;
- two tabs start concurrently;
- same-tab request B does not start until A resolves;
- A rejection still starts B;
- the 101st pending request for one tab rejects `QUEUE_OVERLOADED`;
- `cancelTab` and `cancelSession` reject queued entries;
- expired queued work never calls its closure;
- idle queues are deleted.

- [ ] **Step 2: Implement `SessionStateStore`**

Use keys `session-tab:${sessionId}`. The adapter contract is:

```ts
export interface SessionStorageAdapter {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  remove(key: string): Promise<void>;
  getBytesInUse(keys?: string[]): Promise<number>;
}
```

The Chrome adapter wraps `chrome.storage.session`; tests use a `Map`. `getLastTab`, `setLastTab`, `clearTab`, and `clearSession` update memory and await persistence before returning.

- [ ] **Step 3: Implement the queue and request context**

Use explicit queue-entry arrays rather than promise-tail chaining so pending entries can be rejected on cleanup. Increment the global pending count only after both limits pass; decrement in one `finally` path. Running work is not force-cancelled.

`RequestToolContext` owns a fresh `InputDevice`, immutable `sessionId`, `requestId`, and `expiresAt`, plus async `setTabId`. No module-global input device or tab ID remains.

- [ ] **Step 4: Move tab resolution out of `handleTool`**

Make `resolveTabId(requestedTabId, sessionFallback)` stateless. Remove `lastUsedTabId`, `getLastUsedTabId`, and `setLastUsedTabId`. `TOOL_METADATA` declares these exact fields once per tool:

```ts
interface ToolMetadata {
  tab: "required" | "optional" | "none";
  queue: "tab" | "session" | "global" | "none";
  mutatesTab: boolean;
  recordable: boolean;
}
```

`browser_record_start` uses `tab: "required"` with `queue: "session"`; replay uses the tab queue; stop uses the session queue with no tab. This keeps recording control ordered without misclassifying start as tab-free.

The background dispatch flow becomes:

```ts
validate envelope
hydrate session state
resolve initial tab when metadata.scope === "tab"
create RequestToolContext
run through scheduler.runTab or scheduler.runSession
call handleTool
send correlated response
```

`handleTool` executes the handler and recorder hook only; it no longer resolves a tab or updates global fallback state. Await `ctx.setTabId` in `select_tab` and `new_tab`.

- [ ] **Step 5: Run isolation tests and commit**

```bash
cd MyBrowser/extension
npm test -- src/lib/session-state.test.ts src/lib/request-scheduler.test.ts src/lib/request-context.test.ts src/lib/tool-metadata.test.ts
npm run check
git add src
git commit -m "fix: isolate extension requests by session and tab"
```

---

### Task 6: Add authoritative recording reservations and acknowledged persistence

**Files:**
- Modify: `MyBrowser/server/src/state-manager.ts`
- Create: `MyBrowser/server/src/state-manager.test.ts`
- Modify: `MyBrowser/server/src/hub-client.ts`
- Modify: `MyBrowser/server/src/hub-rpc.ts`
- Modify: `MyBrowser/server/src/hub-rpc.test.ts`
- Modify: `MyBrowser/server/src/ws-server.ts`
- Modify: `MyBrowser/server/src/ws-server.test.ts`
- Modify: `MyBrowser/server/src/tools/record.ts`
- Modify: `MyBrowser/server/src/server.ts`

**Interfaces:**
- Adds to `IStateManager`: `reserveRecording`, `renewRecordingReservation`, `releaseRecordingReservation`, and `hasRecordingReservation`.
- Changes recording exports to `createRecordingTools(stateManager, getSessionId)`.

- [ ] **Step 1: Write failing reservation tests with fake timers**

Assert one owner can reserve and renew, another session receives `RECORDING_NAME_CONFLICT`, wrong-owner renewal fails, 30 minutes expires, renewal extends expiry, and `removeSession` releases all of that session's names. Assert expiry broadcasts `recording_reservation_expired` once.

- [ ] **Step 2: Implement reservation state**

Add this public shape:

```ts
export interface RecordingReservation {
  name: string;
  sessionId: string;
  expiresAt: number;
}
```

Use these exact method contracts:

```ts
reserveRecording(sessionId: string, name: string, leaseMs: number): Promise<{ ok: true; reservation: RecordingReservation } | { ok: false; owner: string }>;
renewRecordingReservation(sessionId: string, name: string, leaseMs: number): Promise<boolean>;
releaseRecordingReservation(sessionId: string, name: string): Promise<boolean>;
hasRecordingReservation(sessionId: string, name: string): Promise<boolean>;
```

Normalize names with the same exported `normalizeRecordingName()` used by filesystem persistence. Keep lease timers in `LocalStateManager`; renewal replaces the timer atomically. `HubStateManager` forwards only `{ name, leaseMs }`; hub RPC injects its authenticated session.

- [ ] **Step 3: Reserve before extension start and make persistence exclusive**

`createRecordingTools` requires `{ name, tabId }`. Reserve for `1_800_000` ms, then send `browser_record_start`; release immediately if extension start fails. `record_stop` does not require `tabId`.

Replace overwrite-by-rename with exclusive destination creation:

```ts
const fd = openSync(filePath, "wx", 0o600);
try {
  writeFileSync(fd, JSON.stringify(recording, null, 2) + "\n");
  fsyncSync(fd);
} finally {
  closeSync(fd);
}
```

Retain parent-directory permissions and reject malformed recording shapes before opening the file.

If `browser_record_stop` returns without successful server persistence, its server tool handler releases the still-active reservation after returning the sanitized payload and partial status. Successful `persistRecording` releases it in the hub after the exclusive write completes.

- [ ] **Step 4: Replace `saveRecording` with acknowledged extension-only messages**

Handle `renewRecordingReservation` and `persistRecording` only for extension-role sockets. Validate the live reservation's session and normalized name. Return `{ type: "persistRecordingResult", id, ok }`; on successful server persistence release the reservation. Wrong role, owner, or name returns a correlated redacted error and does not write.

- [ ] **Step 5: Verify and commit**

```bash
cd MyBrowser/server
npm test -- src/state-manager.test.ts src/hub-rpc.test.ts src/ws-server.test.ts
npm run check
git add src
git commit -m "fix: reserve and persist recordings safely"
```

---

### Task 7: Parameterize and isolate active recordings

**Files:**
- Create: `MyBrowser/extension/src/lib/recording-parameterizer.ts`
- Create: `MyBrowser/extension/src/lib/recording-parameterizer.test.ts`
- Rewrite: `MyBrowser/extension/src/lib/recorder.ts`
- Create: `MyBrowser/extension/src/lib/recorder.test.ts`
- Modify: `MyBrowser/extension/src/lib/tool-metadata.ts`
- Modify: `MyBrowser/extension/src/lib/tools.ts`
- Modify: `MyBrowser/extension/src/entrypoints/background/index.ts`

**Interfaces:**
- Produces: `RecordingManager.start(sessionId, name, tabId, url)`, `prepareStep`, `commitStep`, `stop`, `setReplaying`, `abortSession`, and `restoreSession`.
- Produces: `parameterizeArgs(toolName, args, state)` returning sanitized args and `RequiredVariable[]` without originals.
- Consumes: an injected `RecordingTransport.request(type, payload, timeoutMs)` implemented by background/offscreen correlation rather than direct `chrome.runtime.sendMessage` fire-and-forget calls.

- [ ] **Step 1: Write privacy and ownership tests first**

Use distinct canary values such as `SECRET_ALPHA_9271` and assert they do not appear in `JSON.stringify(manager.snapshot())`. Cover two simultaneous sessions, cross-session stop, per-session replay suppression, other-tab exclusion, deterministic placeholders, sensitive navigation URL replacement, and 1,000-step/2-MiB/8-MiB preflight rejection before the supplied action closure runs.

- [ ] **Step 2: Define exhaustive recording metadata**

For every recordable tool, classify each string-bearing argument path as `safe` or `parameterized`. Always parameterize `browser_type.text`, all fill-form values, all selected values, and a navigation URL containing username/password/query/hash. Exclude `new_tab`, `select_tab`, and `close_tab` from `recordable`.

The metadata test enumerates every recordable tool and fails if a string path has no classification. Safe structural paths include target role/name/text/selector/label, key names, viewport preset, wait condition, and assertion type; they never become variable hints.

- [ ] **Step 3: Implement parameterization without a reverse map**

Generate `{{input_1}}`, `{{form_2}}`, `{{select_3}}`, or `{{navigation_4}}`. Store only:

```ts
interface RequiredVariable {
  name: string;
  source: "text" | "form" | "select" | "navigation" | "clipboard";
  hint?: string;
}
```

Generic hints are counter-based (`text_input_1`), never DOM labels or original values. Sanitize captured page metadata to origin plus pathname.

- [ ] **Step 4: Replace recorder globals with `RecordingManager`**

Use `Map<sessionId, ActiveRecording>` and `Set<sessionId>` for replaying sessions. Persist sanitized active records under `active-recording:${sessionId}` in `chrome.storage.session`. Before invoking a recordable action, `prepareStep` parameterizes and reserves its estimated serialized size; only then run the browser action and `commitStep` timing plus sanitized URL.

Use these call shapes from `handleTool`:

```ts
const prepared = await recordings.prepareStep(sessionId, toolName, args, ctx.getTabId());
const startedAt = prepared ? Date.now() : 0;
const result = await handler(args, ctx);
if (prepared) {
  await recordings.commitStep(sessionId, prepared, {
    durationMs: Date.now() - startedAt,
    currentUrl: await currentSanitizedUrl(ctx.getTabId()),
  });
}
```

`prepareStep` returns `null` when the session is not recording, is replaying, or the action targets another tab. It throws `RECORDING_STATE_LIMIT` before the handler runs when the sanitized step would exceed a cap.

Renew the server reservation every five minutes while active. On `recording_reservation_expired` or `session_closed`, abort and delete restart state.

Add a background `requestServer` pending map keyed by correlation ID, following the existing note-save acknowledgement pattern. It sends through `_os_ws_send`, resolves only the matching `renewRecordingReservationResult` or `persistRecordingResult`, and rejects after 10 seconds or offscreen disconnect. Pass this function into `RecordingManager` through `RecordingTransport`.

- [ ] **Step 5: Add acknowledged dual-store stop behavior**

On stop, send `persistRecording` and await its correlated result. Save to `chrome.storage.local` only after the server accepts the reserved name; reject an existing local key. Return `{ extensionSaved, serverSaved, recording, error? }`. Never include original substitutions in the message or result.

- [ ] **Step 6: Run tests and commit**

```bash
cd MyBrowser/extension
npm test -- src/lib/recording-parameterizer.test.ts src/lib/recorder.test.ts src/lib/tool-metadata.test.ts
npm run check
git add src
git commit -m "fix: isolate and sanitize browser recordings"
```

---

### Task 8: Make replay single-tab, preflighted, and legacy-safe

**Files:**
- Modify: `MyBrowser/extension/src/lib/replayer.ts`
- Create: `MyBrowser/extension/src/lib/replayer.test.ts`
- Modify: `MyBrowser/extension/src/lib/tools.ts`
- Modify: `MyBrowser/server/src/tools/replay.ts`
- Modify: `MyBrowser/server/src/tools/record.ts`
- Modify: `MyBrowser/server/src/server.ts`

**Interfaces:**
- Produces: `preflightReplay(recording, variables)` returning cloned substituted steps or a stable error with no side effects.
- Requires `tabId` in server `ReplayArgs` and `RecordStartArgs`.

- [ ] **Step 1: Write failing replay preflight tests**

Assert all missing placeholders are reported together, handler call count remains zero, supplied values substitute recursively into a clone, source recording is unchanged, and any legacy `new_tab`, `select_tab`, or `close_tab` step returns `RECORDING_UNSUPPORTED_MULTI_TAB` before navigation or timing delays.

- [ ] **Step 2: Implement complete preflight**

Walk nested objects and arrays for `/\{\{([a-zA-Z0-9_]+)\}\}/g`. Compare found names with supplied variables before selecting a step range or navigating. Reject unsupported actions first. Remove the legacy original-value substitution map entirely because recordings no longer retain originals.

- [ ] **Step 3: Bind record and replay schemas to one tab**

Add `tabId: z.number().int().positive()` to `RecordStartArgs` and `ReplayArgs`; forward it in both tool payloads. Add `tabId` to replay's extension request context. Remove `browser_record_stop` from `MUTATING_TOOLS`; keep `browser_record_start` and `browser_replay` so existing ownership checks validate their required tab.

Do not print replay variable values in the server summary. Print only sorted variable names.

- [ ] **Step 4: Mark legacy recordings incompatible in list output**

When listing server and extension recordings, inspect actions and return entries shaped `{ name, compatible, reason? }`. A legacy multi-tab recording remains visible with `compatible: false` and reason `RECORDING_UNSUPPORTED_MULTI_TAB`.

- [ ] **Step 5: Verify and commit**

```bash
cd MyBrowser/extension && npm test -- src/lib/replayer.test.ts src/lib/recorder.test.ts && npm run check
cd ../server && npm test -- src/protocol-conformance.test.ts && npm run check
git add MyBrowser/extension/src MyBrowser/server/src
git commit -m "fix: preflight replay on one authorized tab"
```

---

### Task 9: Consolidate cleanup and prove the full topology

**Files:**
- Modify: `MyBrowser/server/src/state-manager.ts`
- Modify: `MyBrowser/server/src/ws-server.ts`
- Modify: `MyBrowser/server/src/ws-server.test.ts`
- Modify: `MyBrowser/extension/src/entrypoints/background/index.ts`
- Modify: `MyBrowser/extension/src/lib/events.ts`
- Modify: `MyBrowser/extension/src/lib/session-state.test.ts`
- Modify: `MyBrowser/extension/src/lib/request-scheduler.test.ts`
- Modify: `docs/superpowers/specs/2026-07-12-mybrowser-session-isolation-design.md` only if implementation reveals a factual mismatch

**Interfaces:**
- Produces: one idempotent `session_closed` extension cleanup path.
- Verifies: hub-local session, two remote clients, one extension, two tabs, spoof rejection, cleanup, and reconnect.

- [ ] **Step 1: Write the full loopback integration test**

Start the real hub on loopback with an ephemeral port, authenticate one fake extension and two v2 clients, register `session-a` and `session-b`, and assert:

- duplicate registration fails;
- unregistered proxy fails;
- forwarded envelopes contain the socket-bound session;
- supplied spoofed session/browser routing is overwritten;
- extension `hub_rpc` is closed `4403`;
- response correlation reaches only the originating client;
- disconnect/reconnect during grace preserves the session;
- grace expiry emits one `session_closed` and clears reservations, handlers, locks, and tabs.

- [ ] **Step 2: Replace duplicate handler cleanup broadcast**

Remove the session-scoped `browser_unregister_handler` broadcast from `clearEventHandlersForSession`. On final cleanup, the hub broadcasts one `session_closed` to all extension sockets. Background handling calls, in order, scheduler session cancellation, session-state removal, recorder abort, and event mirror cleanup. Every operation tolerates absent state.

- [ ] **Step 3: Run every automated gate**

```bash
cd MyBrowser/server
npm test
npm run check
npm run build
npm audit --omit=dev

cd ../extension
npm test
npm run check
npm run build
npm audit --omit=dev
```

Expected: all tests, checks, and builds pass. Record the already-known production dependency advisories separately; do not mix dependency-upgrade edits into this feature branch.

- [ ] **Step 4: Run the manual loaded-extension smoke test**

Load `MyBrowser/extension/.output/chrome-mv3` unpacked, connect it to the built server, create two MCP sessions, claim two different tabs, then force interleaving with one delayed action per tab. Verify each action and recording remains on its claimed tab. Restart the extension service worker from `chrome://extensions`, verify in-flight work fails with `EXTENSION_WORKER_RESTARTED`, then verify each session restores its own last tab and sanitized active recording.

- [ ] **Step 5: Inspect diagnostics and commit the integrated result**

Run:

```bash
git diff --check
git status --short
git diff --stat
```

Then run `aft_inspect` scoped to `MyBrowser/server/src` and `MyBrowser/extension/src`; resolve all introduced diagnostics before committing:

```bash
git add MyBrowser docs/superpowers/specs/2026-07-12-mybrowser-session-isolation-design.md
git commit -m "feat: enforce end-to-end browser session isolation"
```

---

## Final acceptance checklist

- [ ] Both packages have deterministic Vitest suites and explicit `test` scripts.
- [ ] Old peers fail closed in both directions.
- [ ] Remote sockets cannot switch, duplicate, or spoof sessions.
- [ ] Extensions cannot invoke client RPC or unguarded persistence paths.
- [ ] Ordinary client tool envelopes cannot select an arbitrary browser.
- [ ] Two concurrent tab requests use independent contexts and inputs.
- [ ] Same-tab requests are FIFO; different-tab requests overlap.
- [ ] Worker restart rejects pending work and restores only sanitized session state.
- [ ] Recording and replay require an authorized tab and never cross tabs.
- [ ] Serialized fixtures contain none of the canary secrets.
- [ ] Missing replay variables and legacy multi-tab recordings cause zero browser side effects.
- [ ] Session cleanup is one idempotent broadcast path.
- [ ] Tests, typechecks, builds, diagnostics, and manual smoke checks pass.
