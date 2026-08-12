# MyBrowser Default Routing and Temporary-Tab Cleanup Implementation Plan

> Steps use checkbox (`- [ ]`) syntax for tracking. The primary orchestrator chooses whether independent tasks benefit from parallel agents.

**Goal:** Make every unoverridden MyBrowser session route through the saved `ChromeUbunut` default, prevent task-scoped browser overrides from lingering, and reliably close only the temporary tabs that MyBrowser itself opened.

**Architecture:** Keep the persisted stable-name default as the normal routing authority. A deliberate `select_browser` remains a session override, but 30 minutes of tool inactivity, `use_default_browser`, `set_default_browser`, and the end-of-task `browser_cleanup` path clear that override. The extension owns a bounded `chrome.storage.session` registry of tabs created through `new_tab`; it closes those tabs on normal cleanup or `session_closed`, retries interrupted cleanup after MV3 worker restart, and never infers ownership of pre-existing, manual, or popup-created tabs. The hub accepts only two authenticated session-scoped internal targeted actions (`keep_tab`, `cleanup_session_tabs`) so client-mode cleanup can reach a named browser without weakening normal routing. On each auth attempt the extension reports only the bounded session IDs currently present in its registry; the hub intersects that list with the existing bounded finalized-session tombstones and returns only finalized matches for best-effort local cleanup.

**Tech Stack:** TypeScript 5.7, Node.js 18+, MCP SDK, `ws`, WXT Manifest V3, Chrome `tabs`/`storage.session`/`alarms` APIs, Vitest 3.2.7.

## Global Constraints

- The saved default browser name remains `ChromeUbunut`; browser IDs such as `b3` are ephemeral and must never be persisted as the shared default.
- Routing precedence remains explicit session override, then connected stable-name default, then the single connected browser only when no default is configured. A configured but disconnected default must fail closed even if exactly one other browser is connected.
- `select_browser` is only for a user-requested non-default browser. Its output and description must state how to return to the default.
- Explicit session browser overrides expire after 30 minutes without a tool call. `touchSession` clears an expired override before refreshing activity, so the next request routes through the default.
- `set_default_browser` must make the calling session follow the new default immediately; it must not alter other live sessions that may be doing explicit work elsewhere.
- `browser_cleanup` is the task-finalizer: close this session's tracked temporary tabs on every connected browser, then clear this session's browser override even when one browser cleanup fails.
- `browser_cleanup` must be idempotent and callable in `finally`; a clean no-op returns success.
- `new_tab` creates a temporary tab by default. `temporary: false` or a successful `keep_tab` makes it survive cleanup.
- Only tabs created by MyBrowser's `new_tab` handler may be auto-closed. Never infer ownership from URL, title, active status, opener, timing, or tab ID alone.
- Pre-existing tabs, tabs opened manually by the user, and tabs opened as page popup side effects are out of scope for automatic ownership. This is a deliberate safety boundary, not a missed heuristic.
- Temporary-tab state uses `chrome.storage.session`, not `storage.local`: it must survive MV3 worker restarts but be discarded on extension reload/update/browser restart so stale tab IDs can never close unrelated future tabs.
- A `new_tab` persistence failure must roll back by closing the newly created tab and return a stable failure. It must never report an untracked temporary tab as successfully created.
- Cleanup is idempotent. A missing/already-closed tab counts as cleaned; a transient close failure remains tracked for retry.
- Cleanup intent is persisted before attempting tab removal. The global keepalive alarm retries pending cleanup after MV3 worker restart.
- Session and tab counts are bounded before creating another temporary tab: maximum 64 tracked sessions, 64 tabs per session, and 256 tabs total.
- Session IDs and tab IDs remain extension-private control metadata. They must not be added to logs, diagnostics text, telemetry, or user-facing errors beyond existing bounded/pseudonymized fields.
- Reconnect cleanup uses the existing bounded 24-hour `FinalizedSessionRegistry`; it adds no durable hub storage or new session authority. The extension may advertise at most 64 syntactically valid tracked session IDs, and the hub returns only their finalized intersection.
- `browser_cleanup` reaches connected browsers only. A browser disconnected during explicit cleanup is recovered on reconnect only after that MCP session later finalizes; preserving live-session cleanup intent would risk closing tabs opened after the cleanup call.
- Abrupt loss of the hub process before session finalization is recorded loses its in-memory tombstone. This version does not persist raw session IDs to disk.
- Existing recording, event-handler, tab-claim, replay, and telemetry cleanup contracts must remain intact.
- No new dependency is allowed.
- Production changes follow red-green-refactor. Each task ends with focused tests, `npm run check`, and a focused commit.
- Full Vitest runs use `TMPDIR=/mnt/ssd/projects/.tmp-mybrowser` on this machine to avoid the known `/tmp` quota failure.
- No push, tag, npm publish, or extension deployment is part of implementation unless separately requested after verification.

## File and Responsibility Map

### Server

- Modify `MyBrowser/server/src/state-manager.ts` and `state-manager.test.ts`: add explicit session-browser reset, 30-minute idle expiry, and fail-closed disconnected-default resolution.
- Modify `MyBrowser/server/src/hub-client.ts`, `hub-rpc.ts`, and `hub-rpc.test.ts`: forward the reset through authenticated hub RPC without accepting caller-supplied session authority.
- Modify `MyBrowser/server/src/tools/browser.ts`: add `use_default_browser`, make `set_default_browser` reset only the calling session, remove stale pin guidance, and disclose idle expiry.
- Modify `MyBrowser/server/src/tools/tabs.ts` and add/extend `tabs.test.ts`: add `temporary` to `new_tab`, add `keep_tab`, and add the cross-browser `browser_cleanup` task-finalizer.
- Modify `MyBrowser/server/src/server.ts` and `server.test.ts`: construct the tab tools with state/context dependencies and register the new tools.
- Modify `MyBrowser/server/src/protocol.ts` and `protocol-conformance.test.ts`: strict bounded temporary-tab reconciliation fields on the authenticated handshake.
- Modify `MyBrowser/server/src/ws-server.ts` and `ws-server.test.ts`: validate auth fields in the production path, honor only the two internal targeted actions, and intersect extension-owned session IDs with bounded finalized tombstones.
- Modify `MyBrowser/server/src/telemetry/policies.ts` and `policies.test.ts`: exact allowlist coverage for every new public tool field.
- Modify `MyBrowser/server/README.md`: document routing and temporary-tab lifecycle.

### Extension

- Create `MyBrowser/extension/src/lib/temporary-tabs.ts` and `temporary-tabs.test.ts`: bounded serialized registry, rollback, keep, close, pending cleanup, replacement, and retry semantics.
- Modify `MyBrowser/extension/src/lib/request-context.ts` and `request-context.test.ts`: expose the temporary-tab manager to tab handlers without global mutable lookup.
- Modify `MyBrowser/extension/src/lib/tools.ts` and add/extend `tools.test.ts`: wire `new_tab`, `close_tab`, `keep_tab`, and internal `cleanup_session_tabs`.
- Modify `MyBrowser/extension/src/lib/tool-metadata.ts` and `tool-metadata.test.ts`: declare queueing, tab requirements, and safe state signals for the two new extension actions.
- Modify `MyBrowser/extension/src/lib/events.ts` and `session-state.test.ts`: run temporary-tab cleanup as an independent `session_closed` step.
- Modify `MyBrowser/extension/src/entrypoints/background/index.ts` and `background-privacy.test.ts`: instantiate the manager, retry pending cleanup on keepalive/startup, and reconcile `onRemoved`/`onReplaced` without leaking IDs.
- Modify `MyBrowser/extension/src/entrypoints/offscreen/main.ts` and `offscreen-pending.test.ts`: carry bounded tracked-session IDs into auth and dispatch bounded post-connect cleanup without delaying connected status.
- Modify `MyBrowser/extension/src/lib/protocol.ts` and `protocol.test.ts`: mirror the strict reconciliation frame guards; do not widen general message acceptance.
- Modify `MyBrowser/extension/src/lib/reconnecting-ws.ts` and add `reconnecting-ws.test.ts`: fetch fresh tracked-session IDs before every auth attempt and expose bounded finalized IDs after auth.

---

### Task 1: Add an Explicit Return-to-Default Routing Contract

**Files:**
- Modify: `MyBrowser/server/src/state-manager.ts`
- Modify: `MyBrowser/server/src/state-manager.test.ts`
- Modify: `MyBrowser/server/src/hub-client.ts`
- Modify: `MyBrowser/server/src/hub-rpc.ts`
- Modify: `MyBrowser/server/src/hub-rpc.test.ts`
- Modify: `MyBrowser/server/src/tools/browser.ts`
- Create: `MyBrowser/server/src/tools/browser.test.ts`
- Modify: `MyBrowser/server/src/server.ts`
- Modify: `MyBrowser/server/src/server.test.ts`
- Modify: `MyBrowser/server/src/ws-server.ts`
- Modify: `MyBrowser/server/src/ws-server.test.ts`
- Modify: `MyBrowser/server/src/telemetry/policies.ts`
- Modify: `MyBrowser/server/src/telemetry/policies.test.ts`

**Interfaces:**
- Produces: `IStateManager.clearSessionBrowser(sessionId: string): Promise<boolean>` and `SESSION_BROWSER_OVERRIDE_IDLE_MS = 1_800_000`.
- Preserves: `resolveBrowserTarget(sessionId)` precedence and all existing failure modes.
- Produces public tool: `use_default_browser` with no arguments.

- [ ] **Step 1: Write routing regressions before implementation**

Add tests proving:

```ts
await state.registerSession("session-a");
await state.selectBrowser("session-a", browserB);
expect((await state.resolveBrowserTarget("session-a"))).toMatchObject({
  ok: true,
  browserId: browserB,
  source: "session",
});

await expect(state.clearSessionBrowser("session-a")).resolves.toBe(true);
expect((await state.resolveBrowserTarget("session-a"))).toMatchObject({
  ok: true,
  browserId: browserA,
  source: "default",
});
await expect(state.clearSessionBrowser("session-a")).resolves.toBe(false);
```

Also prove that clearing `session-a` does not alter `session-b`, and that setting a new default clears only the calling tool session. With fake timers, prove `touchSession` keeps an override at `1_799_999` ms idle and clears it at exactly `1_800_000` ms before updating `lastActivity`. Prove `registerSession` performs the same check before preserving an existing override so reconnect cannot refresh a stale pin.

Add the routing regression that currently explains the user's observation:

```ts
await state.setDefaultBrowser(chromeUbuntuId);
disconnect(chromeUbuntuId);
expect(await state.resolveBrowserTarget("session-a")).toMatchObject({
  ok: false,
  reason: "default_browser_disconnected",
});
```

This must remain false even when `Mainpc` is the sole connected browser. The single-browser fallback applies only when no shared default name is configured.

- [ ] **Step 2: Run RED**

Run:

```bash
cd MyBrowser/server
TMPDIR=/mnt/ssd/projects/.tmp-mybrowser npx vitest run src/state-manager.test.ts src/hub-rpc.test.ts src/tools/browser.test.ts src/server.test.ts src/telemetry/policies.test.ts
```

Expected: FAIL because `clearSessionBrowser` and `use_default_browser` do not exist.

- [ ] **Step 3: Implement the minimal local and hub state transition**

Add exactly this interface behavior and extend `BrowserTargetResolution` with `default_browser_disconnected`:

```ts
async clearSessionBrowser(sessionId: string): Promise<boolean> {
  const session = this.sessions.get(sessionId);
  if (!session?.activeBrowserId) return false;
  delete session.activeBrowserId;
  return true;
}
```

Add hub RPC method `clearSessionBrowser` that always uses `auth.sessionId`; reject/ignore any caller-supplied `sessionId` exactly like the existing selection methods. Add the matching `HubStateManager` method.

In `touchSession`, compare `now - lastActivity` before assigning the new activity time. If an override exists and the idle duration is at least `SESSION_BROWSER_OVERRIDE_IDLE_MS`, delete it first. Avoid a timer; expiration is lazy and deterministic on the next tool call.

In `registerSession`, apply the same idle predicate before preserving `existing.activeBrowserId`; then set the new activity time. In `resolveBrowserTarget`, keep `no_browsers` first, but when a configured default has zero connected matches return `default_browser_disconnected` before the single-browser fallback. The fallback is legal only when no default name is configured.

- [ ] **Step 4: Add the user-facing routing tools and precise descriptions**

Implement `use_default_browser` by clearing the caller's session override and resolving the effective target afterward. If the configured default is disconnected, return a bounded result that says the override was cleared and routing now fails closed; do not report the clear itself as failed. Change `set_default_browser` to save the stable name and then clear only the caller's override. Update `select_browser` text to say:

```text
Use only when the user explicitly asked for a non-default browser. The override lasts until use_default_browser, browser_cleanup, or session closure.
```

Replace that draft with the final exact text:

```text
Use only when the user explicitly asked for a non-default browser. The override lasts until use_default_browser, browser_cleanup, session closure, or 30 minutes of tool inactivity.
```

Replace `set_default_browser`'s old “this session is still pinned” note with a success result stating that the caller now follows the new default. Register `use_default_browser` in `server.ts` and add `use_default_browser: immutablePolicy({})`; startup policy coverage must pass in this task's own commit.

Do not clear overrides belonging to other live sessions.

- [ ] **Step 5: Run GREEN and compiler gate**

Run:

```bash
cd MyBrowser/server
TMPDIR=/mnt/ssd/projects/.tmp-mybrowser npx vitest run src/state-manager.test.ts src/hub-rpc.test.ts src/tools/browser.test.ts src/server.test.ts src/telemetry/policies.test.ts
npm run check
```

Expected: all focused tests and TypeScript pass.

- [ ] **Step 6: Commit the routing contract**

```bash
git add MyBrowser/server/src/state-manager.ts MyBrowser/server/src/state-manager.test.ts MyBrowser/server/src/hub-client.ts MyBrowser/server/src/hub-rpc.ts MyBrowser/server/src/hub-rpc.test.ts MyBrowser/server/src/tools/browser.ts MyBrowser/server/src/tools/browser.test.ts MyBrowser/server/src/server.ts MyBrowser/server/src/server.test.ts MyBrowser/server/src/telemetry/policies.ts MyBrowser/server/src/telemetry/policies.test.ts
git commit -m "fix: enforce default browser routing"
```

---

### Task 2: Build a Fail-Safe Temporary-Tab Registry

**Files:**
- Create: `MyBrowser/extension/src/lib/temporary-tabs.ts`
- Create: `MyBrowser/extension/src/lib/temporary-tabs.test.ts`

**Interfaces:**
- Produces: `TemporaryTabManager`.
- Consumes: a `SessionStorageAdapter`-compatible storage dependency and a narrow Chrome tab API dependency.

```ts
export interface TemporaryTabApi {
  create(url: string): Promise<{ id?: number }>;
  remove(tabId: number): Promise<void>;
}

export interface TemporaryTabCleanupResult {
  closed: number;
  keptForRetry: number;
}

export class TemporaryTabManager {
  open(sessionId: string, url: string, temporary: boolean): Promise<number>;
  close(sessionId: string, tabId: number): Promise<void>;
  keep(sessionId: string, tabId: number): Promise<boolean>;
  cleanupSession(sessionId: string): Promise<TemporaryTabCleanupResult>;
  trackedSessionIds(): Promise<string[]>;
  retryPendingCleanup(): Promise<void>;
  forgetClosedTab(tabId: number): Promise<void>;
  replaceTab(removedTabId: number, addedTabId: number): Promise<void>;
}
```

- [ ] **Step 1: Write storage and ownership RED tests**

Cover all of these cases with an in-memory adapter and fake tab API:

```ts
it("tracks only temporary tabs created through open");
it("leaves temporary:false tabs untracked");
it("rolls back the created tab when persistence fails");
it("fails before create at 64 session tabs or 256 total tabs");
it("fails before create when a 65th session would be tracked");
it("keep removes only the caller session's ownership");
it("manual/already-existing tabs never enter the registry");
it("marks cleanup pending before the first remove");
it("treats a missing tab as cleaned");
it("retains transient remove failures for retry");
it("rehydrates pending cleanup after manager recreation");
it("serializes concurrent open/keep/cleanup mutations");
it("moves ownership across tabs.onReplaced");
it("drops malformed stored state without closing any tab");
```

- [ ] **Step 2: Run RED**

```bash
cd MyBrowser/extension
TMPDIR=/mnt/ssd/projects/.tmp-mybrowser npx vitest run src/lib/temporary-tabs.test.ts
```

Expected: FAIL because the module is absent.

- [ ] **Step 3: Implement one bounded versioned storage object**

Use one `chrome.storage.session` key and one serialized operation chain:

```ts
interface StoredTemporaryTabsV1 {
  version: 1;
  sessions: Record<string, {
    tabs: number[];
    cleanupPending: boolean;
  }>;
}
```

Validate plain JSON data, finite positive integer tab IDs, unique IDs, maximum 64 sessions, maximum 64 tabs per session, and 256 tabs total. Unknown version, accessor-like test doubles, malformed arrays, and over-limit data must produce an empty safe state and a stable diagnostic code; they must never trigger tab removal. Treat Chrome's exact not-found tab error as already cleaned; all other `remove` failures remain tracked.

- [ ] **Step 4: Implement rollback and idempotent cleanup**

For temporary `open`, create the tab, then persist ownership before returning. If persistence fails, call `remove(tabId)` and throw `TEMP_TAB_TRACK_FAILED`; report `TEMP_TAB_ROLLBACK_FAILED` only through the existing bounded extension issue sink if removal also fails.

For cleanup, persist `cleanupPending: true` before removals. Remove one tab at a time; consider Chrome's not-found result cleaned, retain every other failure for retry, and delete the session entry only after no tracked tabs remain. `keep` removes ownership before returning; if that persistence fails, return failure and leave the tab tracked. `close` removes ownership only for the caller session after a successful/already-missing close; `tabs.onRemoved` separately calls `forgetClosedTab` to reconcile tabs closed through other paths.

- [ ] **Step 5: Run GREEN and compiler gate**

```bash
cd MyBrowser/extension
TMPDIR=/mnt/ssd/projects/.tmp-mybrowser npx vitest run src/lib/temporary-tabs.test.ts
npm run check
```

Expected: all focused tests and TypeScript pass.

- [ ] **Step 6: Commit the registry**

```bash
git add MyBrowser/extension/src/lib/temporary-tabs.ts MyBrowser/extension/src/lib/temporary-tabs.test.ts
git commit -m "feat: track temporary browser tabs safely"
```

---

### Task 3: Wire Temporary Tabs into Extension Tool Execution

**Files:**
- Modify: `MyBrowser/extension/src/lib/request-context.ts`
- Modify: `MyBrowser/extension/src/lib/request-context.test.ts`
- Modify: `MyBrowser/extension/src/lib/tools.ts`
- Create: `MyBrowser/extension/src/lib/tools.test.ts`
- Modify: `MyBrowser/extension/src/lib/tool-metadata.ts`
- Modify: `MyBrowser/extension/src/lib/tool-metadata.test.ts`
- Modify: `MyBrowser/extension/src/entrypoints/background/index.ts`
- Modify: `MyBrowser/extension/src/lib/background-privacy.test.ts`

**Interfaces:**
- Consumes: `TemporaryTabManager` from Task 2.
- Produces extension actions: `keep_tab` and internal `cleanup_session_tabs`.
- Extends `new_tab` payload with `temporary?: boolean`, defaulting to `true`.

- [ ] **Step 1: Write handler RED tests**

Add tests proving:

```ts
await handleTool("new_tab", { url, temporary: true }, sessionAContext);
expect(temporaryTabs.open).toHaveBeenCalledWith("session-a", url, true);

await handleTool("keep_tab", { tabId: 42 }, sessionAContext);
expect(temporaryTabs.keep).toHaveBeenCalledWith("session-a", 42);

await handleTool("cleanup_session_tabs", {}, sessionAContext);
expect(temporaryTabs.cleanupSession).toHaveBeenCalledWith("session-a");
```

Also prove that `close_tab` closes through the manager so tracked state is reconciled, and canary-bearing URLs/results never enter extension diagnostics.

- [ ] **Step 2: Run RED**

```bash
cd MyBrowser/extension
TMPDIR=/mnt/ssd/projects/.tmp-mybrowser npx vitest run src/lib/request-context.test.ts src/lib/tools.test.ts src/lib/tool-metadata.test.ts src/lib/background-privacy.test.ts
```

Expected: FAIL because temporary-tab services and handlers are absent.

- [ ] **Step 3: Inject the manager through `RequestToolContext`**

Extend `RequestToolServices` with `temporaryTabs: TemporaryTabManager`; do not use a module-global singleton inside `tools.ts`. Instantiate one manager in background initialization and pass it into each request context.

- [ ] **Step 4: Replace raw tab creation/removal in handlers**

Implement:

```ts
async new_tab(args, ctx) {
  const url = typeof args.url === "string" ? args.url : "about:blank";
  const temporary = args.temporary !== false;
  const tabId = await ctx.temporaryTabs.open(ctx.sessionId, url, temporary);
  await ctx.setTabId(tabId);
  // Existing load/content-script behavior remains unchanged.
  return { tabId, temporary };
}
```

Route `close_tab`, `keep_tab`, and `cleanup_session_tabs` through the manager. A `keep_tab` call for a tab not owned by the current session returns a bounded not-owned result and does not mutate another session.

- [ ] **Step 5: Add metadata and privacy coverage**

Declare `keep_tab` as tab-optional/session-safe and `cleanup_session_tabs` as session-queued with no tab requirement. Keep queueing deterministic and ensure no raw session/tab lists are added to extension telemetry summaries.

- [ ] **Step 6: Run GREEN and compiler gate**

```bash
cd MyBrowser/extension
TMPDIR=/mnt/ssd/projects/.tmp-mybrowser npx vitest run src/lib/request-context.test.ts src/lib/tools.test.ts src/lib/tool-metadata.test.ts src/lib/background-privacy.test.ts
npm run check
```

- [ ] **Step 7: Commit extension tool integration**

```bash
git add MyBrowser/extension/src/lib/request-context.ts MyBrowser/extension/src/lib/request-context.test.ts MyBrowser/extension/src/lib/tools.ts MyBrowser/extension/src/lib/tools.test.ts MyBrowser/extension/src/lib/tool-metadata.ts MyBrowser/extension/src/lib/tool-metadata.test.ts MyBrowser/extension/src/entrypoints/background/index.ts MyBrowser/extension/src/lib/background-privacy.test.ts
git commit -m "feat: make new browser tabs temporary by default"
```

---

### Task 4: Add Public Keep and End-of-Task Cleanup Tools

**Files:**
- Modify: `MyBrowser/server/src/tools/tabs.ts`
- Create: `MyBrowser/server/src/tools/tabs.test.ts`
- Modify: `MyBrowser/server/src/server.ts`
- Modify: `MyBrowser/server/src/server.test.ts`
- Modify: `MyBrowser/server/src/telemetry/policies.ts`
- Modify: `MyBrowser/server/src/telemetry/policies.test.ts`

**Interfaces:**
- Public `new_tab({ url?: string, temporary?: boolean })`.
- Public `keep_tab({ tabId: number, browserId?: string })`.
- Public `browser_cleanup({})`: close current session's temporary tabs across all connected browsers and clear its browser override.

- [ ] **Step 1: Write direct and hub-mode RED tests**

Prove that:

```ts
await browserCleanup.handle(context, {});
expect(context.sendSocketMessageToBrowser).toHaveBeenCalledWith(
  browserA,
  "cleanup_session_tabs",
  {},
);
expect(context.sendSocketMessageToBrowser).toHaveBeenCalledWith(
  browserB,
  "cleanup_session_tabs",
  {},
);
expect(state.clearSessionBrowser).toHaveBeenCalledWith(sessionId);
```

Cover partial browser failure: cleanup returns an error summary naming only browser IDs/status, never URLs/tabs/session IDs, and still clears the session override. Cover `keep_tab` with explicit `browserId`, implicit current resolution, and cross-session no-op behavior. Assert `stateManager.releaseAllTabs(sessionId)` runs even when one browser cleanup fails. In client mode, use a real two-browser proxy topology and prove each internal targeted request reaches exactly the named browser.

- [ ] **Step 2: Run RED**

```bash
cd MyBrowser/server
TMPDIR=/mnt/ssd/projects/.tmp-mybrowser npx vitest run src/tools/tabs.test.ts src/server.test.ts src/ws-server.test.ts src/telemetry/policies.test.ts
```

- [ ] **Step 3: Refactor tab tools into a dependency-aware factory**

Create:

```ts
createTabTools({
  stateManager,
  context,
  getSessionId,
  getActiveBrowser,
})
```

Keep list/select/close behavior compatible. `new_tab` forwards `temporary` to the extension. `keep_tab` targets an explicit browser when supplied, otherwise the resolved browser. `browser_cleanup` obtains browsers from `stateManager.listBrowsers()`, attempts all connected browsers with `Promise.allSettled`, then calls `releaseAllTabs(sessionId)` and clears the session override in `finally`. Report disconnected browsers as not attempted; do not create a standing live-session cleanup intent that could later close newer tabs.

Add only `keep_tab` and `cleanup_session_tabs` to a closed hub allowlist for internal targeted routing. The hub still overwrites session authority from the authenticated client socket, validates `targetBrowserId` against a connected browser, and strips/rejects target overrides for every other ordinary tool. Do not add `keep_tab` to `MUTATING_TOOLS`: temporary ownership is extension-private and the extension registry remains the sole keep authority.

- [ ] **Step 4: Tighten user-facing tool descriptions**

Use exact behavioral guidance:

```text
new_tab: Opens a temporary tab by default. Call keep_tab to preserve it. Finish browser research with browser_cleanup.
keep_tab: Preserve one tab created by this MCP session so browser_cleanup/session closure will not close it.
browser_cleanup: Close every temporary tab this MCP session opened across connected browsers and return routing to the shared default. Call once after browser research, including failure paths.
```

- [ ] **Step 5: Add fail-closed telemetry policy coverage**

Add exact policies for `temporary`, `tabId`, and optional `browserId`. `browser_cleanup` has an empty public argument schema. Startup policy coverage must fail if any field drifts.

- [ ] **Step 6: Run GREEN and compiler gate**

```bash
cd MyBrowser/server
TMPDIR=/mnt/ssd/projects/.tmp-mybrowser npx vitest run src/tools/tabs.test.ts src/server.test.ts src/ws-server.test.ts src/telemetry/policies.test.ts
npm run check
```

- [ ] **Step 7: Commit public lifecycle tools**

```bash
git add MyBrowser/server/src/tools/tabs.ts MyBrowser/server/src/tools/tabs.test.ts MyBrowser/server/src/server.ts MyBrowser/server/src/server.test.ts MyBrowser/server/src/ws-server.ts MyBrowser/server/src/ws-server.test.ts MyBrowser/server/src/telemetry/policies.ts MyBrowser/server/src/telemetry/policies.test.ts
git commit -m "feat: add browser task cleanup tools"
```

---

### Task 5: Close Temporary Tabs on Session Finalization and Worker Restart

**Files:**
- Modify: `MyBrowser/extension/src/lib/events.ts`
- Modify: `MyBrowser/extension/src/lib/session-state.test.ts`
- Modify: `MyBrowser/extension/src/entrypoints/background/index.ts`
- Modify: `MyBrowser/extension/src/lib/background-privacy.test.ts`
- Modify: `MyBrowser/extension/src/entrypoints/offscreen/main.ts`
- Modify: `MyBrowser/extension/src/lib/offscreen-pending.test.ts`
- Modify: `MyBrowser/extension/src/lib/protocol.ts`
- Modify: `MyBrowser/extension/src/lib/protocol.test.ts`
- Modify: `MyBrowser/extension/src/lib/reconnecting-ws.ts`
- Create: `MyBrowser/extension/src/lib/reconnecting-ws.test.ts`
- Modify: `MyBrowser/server/src/protocol.ts`
- Modify: `MyBrowser/server/src/protocol-conformance.test.ts`
- Modify: `MyBrowser/server/src/ws-server.ts`
- Modify: `MyBrowser/server/src/ws-server.test.ts`

**Interfaces:**
- Extends `SessionCleanupDependencies` with `temporaryTabs.cleanupSession(sessionId)`.
- Adds `FinalizedSessionRegistry.intersect(sessionIds: readonly string[]): string[]` without changing its existing 24-hour TTL, 10,000-entry bound, or generation/finalizer-race role.
- Extends authenticated messages:

```ts
interface AuthRequestV2 {
  // Existing fields remain exact.
  temporaryTabSessionIds?: string[];
}

interface AuthResultV2 {
  // Existing fields remain exact.
  finalizedSessionIds?: string[];
}
```

- [ ] **Step 1: Write cleanup-order and retry RED tests**

Update the existing `session_closed cleanup` test to require this independent order:

```ts
[
  "scheduler.cancelSession",
  "temporaryTabs.cleanupSession",
  "sessionState.clearSession",
  "recordings.abortSession",
  "events.clearSession",
]
```

Extend `SessionCleanupFailureCode` with `SESSION_CLEANUP_TABS_FAILED`. Prove failure in temporary-tab cleanup reports only that stable code and does not skip later cleanup. Replace the existing exact order/failure assertions rather than adding a parallel test fixture. Add worker-restart coverage where pending cleanup is rehydrated and retried by the keepalive alarm.

- [ ] **Step 2: Write strict protocol and reconnect RED tests**

In the real websocket topology test:

1. Register a client session and browser, create tracked temporary-tab state, then disconnect the browser.
2. Finalize the client session.
3. Reconnect/authenticate that browser within the 24-hour tombstone window.
4. Assert the extension sends at most 64 exact-grammar session IDs already present in its local registry as an optional auth field.
5. Assert the hub returns only the finalized intersection and never reflects unknown, duplicate, malformed, overlong, accessor-backed, or 65th entries.
6. Assert the extension reports `CONNECTED`, immediately marks returned finalized sessions `cleanupPending`, attempts cleanup, and retains failures for keepalive retry without dropping browser traffic.
7. Assert a client-role auth request cannot use the extension-only field.
8. Assert active/non-finalized sessions and finalized sessions absent from that browser's registry are never returned.
9. Assert `browser_cleanup` for a still-active session does not create reconnect cleanup that can close tabs opened later.
10. Assert each automatic WebSocket retry fetches a fresh tracked-session list rather than reusing the original connect snapshot.

- [ ] **Step 3: Run RED**

```bash
cd MyBrowser/extension
TMPDIR=/mnt/ssd/projects/.tmp-mybrowser npx vitest run src/lib/session-state.test.ts src/lib/background-privacy.test.ts src/lib/offscreen-pending.test.ts src/lib/protocol.test.ts src/lib/reconnecting-ws.test.ts
cd ../server
TMPDIR=/mnt/ssd/projects/.tmp-mybrowser npx vitest run src/protocol-conformance.test.ts src/ws-server.test.ts
```

- [ ] **Step 4: Wire session cleanup and Chrome tab lifecycle events**

Call temporary-tab cleanup after cancelling queued session work and before deleting generic session state. On `chrome.tabs.onRemoved`, call `forgetClosedTab`. On `chrome.tabs.onReplaced`, call `replaceTab`. `replaceTab`, `forgetClosedTab`, explicit cleanup, and keepalive `retryPendingCleanup` must all use the manager's one serialized operation chain. On startup and every global keepalive alarm, call `retryPendingCleanup`; catch and report only stable diagnostic codes.

- [ ] **Step 5: Reconcile finalized session intent after browser auth**

Add a `beforeAuthenticate(): Promise<string[]>` callback to `ReconnectingWebSocket`. Every `onopen`, including automatic retries, invokes it with a 2-second bound before constructing extension auth; background supplies `temporaryTabs.trackedSessionIds()`. Registry-read timeout/failure sends an empty list, records one stable diagnostic, and does not disable the browser. The hub's production auth path must call strict guards, reject the extension-only field for client-role auth, require plain own data, exact session-ID grammar, uniqueness, and at most 64 entries, then intersect with `FinalizedSessionRegistry`.

Return optional `finalizedSessionIds` in the auth result so an older peer remains compatible. After `onConnected`, offscreen sends the bounded result to background. Background re-intersects it with the session IDs it advertised in that auth attempt, marks only those sessions `cleanupPending`, then attempts removal; failures stay persisted for keepalive retry and never put the WebSocket into a reconnect loop. This avoids the hub-ready/extension-not-ready message-loss window and bounds a buggy peer to extension-owned sessions. Do not accept tab IDs or cleanup state from the wire, and do not persist new hub data.

After the final ownership/generation checks accept the finalizer, add to `FinalizedSessionRegistry` before broadcasting `session_closed`, so reconnect auth can recover cleanup if the browser was offline during that broadcast. Keep the existing guards intact; after the tombstone is added the remaining cleanup is idempotent in-memory deletion/broadcast and the finalizer must not become retryable.

- [ ] **Step 6: Run GREEN and paired compiler gate**

```bash
cd MyBrowser/extension
TMPDIR=/mnt/ssd/projects/.tmp-mybrowser npx vitest run src/lib/session-state.test.ts src/lib/background-privacy.test.ts src/lib/offscreen-pending.test.ts src/lib/protocol.test.ts src/lib/reconnecting-ws.test.ts
npm run check
cd ../server
TMPDIR=/mnt/ssd/projects/.tmp-mybrowser npx vitest run src/protocol-conformance.test.ts src/ws-server.test.ts
npm run check
```

- [ ] **Step 7: Commit interruption cleanup**

```bash
git add MyBrowser/extension/src/lib/events.ts MyBrowser/extension/src/lib/session-state.test.ts MyBrowser/extension/src/entrypoints/background/index.ts MyBrowser/extension/src/lib/background-privacy.test.ts MyBrowser/extension/src/entrypoints/offscreen/main.ts MyBrowser/extension/src/lib/offscreen-pending.test.ts MyBrowser/extension/src/lib/protocol.ts MyBrowser/extension/src/lib/protocol.test.ts MyBrowser/extension/src/lib/reconnecting-ws.ts MyBrowser/extension/src/lib/reconnecting-ws.test.ts MyBrowser/server/src/protocol.ts MyBrowser/server/src/protocol-conformance.test.ts MyBrowser/server/src/ws-server.ts MyBrowser/server/src/ws-server.test.ts
git commit -m "fix: clean temporary tabs after interrupted sessions"
```

---

### Task 6: Document the Safety Boundary and Agent Operating Rule

**Files:**
- Modify: `MyBrowser/server/README.md`
- Modify: `MyBrowser/server/src/tools/browser.ts`
- Modify: `MyBrowser/server/src/tools/tabs.ts`
- Test: `MyBrowser/server/src/release-contract.test.ts`

**Interfaces:**
- No new runtime interface.
- Produces a tool-description contract visible to every MCP host, not only OpenCode.

- [ ] **Step 1: Add contract tests for user-visible guidance**

Assert that the built tool schemas communicate all three rules:

```text
Use the shared default unless the user explicitly requests another browser.
Tabs opened by new_tab are temporary unless kept.
Call browser_cleanup after browser research, including failure paths.
```

Do not put these rules only in a local OpenCode configuration file; other MCP hosts need the same behavior.

- [ ] **Step 2: Document exact lifecycle and limitations**

Document:

- routing precedence and `use_default_browser`;
- lazy 30-minute override expiry, evaluated on reconnect/next tool call rather than by a background sweep;
- `set_default_browser` resetting only the caller;
- temporary-by-default `new_tab`;
- `temporary: false`, `keep_tab`, and `browser_cleanup`;
- automatic `session_closed` cleanup and authenticated reconnect reconciliation;
- reconnect reconciliation requires a matching hub/extension pair; absence of the optional auth-result field is treated as an older compatible peer, not as an error;
- intentional exclusion of manual/pre-existing/popup-created tabs;
- browser-session-scoped temporary metadata: verify actual `storage.session` behavior across full browser restart and extension reload/update before documenting exact lifetime;
- in-memory finalized tombstones are lost on abrupt hub-process death, so tabs from a process that dies before recording finalization are not automatically closed;
- explicit `browser_cleanup` cannot reach a currently disconnected browser, and deliberately does not leave a live-session standing intent that could close tabs opened later.

- [ ] **Step 3: Run focused docs/schema verification**

```bash
cd MyBrowser/server
TMPDIR=/mnt/ssd/projects/.tmp-mybrowser npx vitest run src/release-contract.test.ts src/tools/browser.test.ts src/tools/tabs.test.ts
npm run check
```

- [ ] **Step 4: Commit documentation and schema guidance**

```bash
git add MyBrowser/server/README.md MyBrowser/server/src/tools/browser.ts MyBrowser/server/src/tools/tabs.ts MyBrowser/server/src/release-contract.test.ts
git commit -m "docs: define browser research cleanup lifecycle"
```

---

### Task 7: Run the Full Automated and Live Release Gate

**Files:**
- Verify all changed files.
- Do not modify release versions, deployed extension folders, git remotes, tags, or npm state in this task.

- [ ] **Step 1: Run diagnostics before expensive suites**

Run `aft_inspect` over `MyBrowser/server/src` and `MyBrowser/extension/src`. Resolve new diagnostics; treat the known worktree `.js` to `.ts` resolver lag as non-authoritative only when both TypeScript compilers pass.

- [ ] **Step 2: Run authoritative paired tests and builds**

```bash
mkdir -p /mnt/ssd/projects/.tmp-mybrowser
cd MyBrowser/server
TMPDIR=/mnt/ssd/projects/.tmp-mybrowser npm test
npm run check
npm run build
npm audit --registry=https://registry.npmjs.org/

cd ../extension
TMPDIR=/mnt/ssd/projects/.tmp-mybrowser npm test
npm run check
npm run build
npm audit --omit=dev --registry=https://registry.npmjs.org/
```

Expected: all tests, checks, builds, server full audit, and extension production audit pass.

- [ ] **Step 3: Run a real direct/hub topology test**

Prove with two authenticated browsers and two MCP sessions:

1. A fresh unselected session resolves `ChromeUbunut` from the saved default.
2. `select_browser` routes only that session to the second browser.
3. `use_default_browser` returns it to `ChromeUbunut`.
4. `set_default_browser` resets only the caller, not another session's deliberate override.
5. A disconnected configured default fails closed rather than selecting the other connected browser.
6. The fake-clock topology/unit boundary proves an explicit override remains at 29:59 idle and expires at 30:00 idle before the next request routes; do not wait 30 real minutes.
7. A client-mode `browser_cleanup` reaches both named browsers through the strict internal-target allowlist and still clears claims/routing if one target disconnects mid-flight.

- [ ] **Step 4: Run a loaded MV3 tab lifecycle smoke**

Against the reviewed build in the real loaded extension:

1. Record IDs of all pre-existing user tabs.
2. Create two default-temporary tabs with `new_tab`.
3. Create one `temporary: false` tab.
4. Call `keep_tab` for one temporary tab.
5. Stop/restart the MV3 worker before cleanup and verify tracked state rehydrates.
6. Call `browser_cleanup` and verify only the one still-temporary tab closes, the kept/non-temporary/pre-existing tabs remain, and routing returns to `ChromeUbunut`.
7. Create another temporary tab, terminate its MCP session, and verify `session_closed` closes it.
8. Repeat session termination while that browser is disconnected, reconnect within the tombstone window, and verify authenticated reconciliation closes only the tracked tab.
9. Run `browser_cleanup` while that browser is disconnected but keep the MCP session alive; reconnect, open a newer temporary tab, and verify no stale explicit-cleanup intent closes it. Finalize the session and verify finalization cleanup closes only then-tracked temporary tabs.
10. Confirm extension diagnostics contain stable codes only and telemetry contains no raw session/tab identifiers.

- [ ] **Step 5: Re-review the exact final diff**

Because this changes browser routing and destructive tab lifecycle, send the final implementation diff to GLM 5.2 and DeepSeek V4 Flash together, resolve P0-P2 findings, and rerun the entire gate after any change.

- [ ] **Step 6: Record completion without publishing**

Update Taskwarrior task `11839e26-7f45-409f-8f0c-725ab0ccab62` with exact test counts, builds, audits, live-smoke evidence, and residual limitations. Commit only the verified implementation. Do not push, tag, publish, or replace the user's loaded extension without a separate request.

## Acceptance Checklist

- [ ] `ChromeUbunut` is the effective target for every session without an explicit override.
- [ ] A session override is visible, reversible, scoped to that session, and cleared by `use_default_browser`, `browser_cleanup`, `set_default_browser` for the caller, 30 minutes of tool inactivity, or session finalization.
- [ ] `new_tab` is temporary by default and cannot report success if temporary ownership was not persisted.
- [ ] `temporary: false` and `keep_tab` preserve intended tabs.
- [ ] `browser_cleanup` closes only the caller's tracked temporary tabs across connected browsers and restores default routing.
- [ ] Session closure, worker restart, and short browser disconnection preserve finalized-session cleanup safely.
- [ ] Pre-existing, manual, popup-created, kept, and other-session tabs are never auto-closed.
- [ ] Browser restart/extension reload cannot use stale tab IDs to close unrelated tabs.
- [ ] Direct and hub modes enforce the same session authority and cleanup semantics.
- [ ] Diagnostics and telemetry retain existing privacy guarantees.
- [ ] Full tests, typechecks, builds, audits, topology checks, and loaded-MV3 smoke pass from the final diff.

## Explicit Non-Goals

- Inferring whether an arbitrary existing tab is “research-related.”
- Auto-owning tabs opened by page popups, `target=_blank`, scripts, or the user; safe attribution does not exist yet.
- Closing or reorganizing tabs restored after a full browser restart.
- Persisting temporary-tab ownership to disk across extension reload/update/browser restart.
- Surviving abrupt hub-process death before finalization is recorded; that requires a separate privacy-reviewed durable tombstone design.
- Closing tabs on a browser that is disconnected during explicit `browser_cleanup` while the session stays alive; finalization reconciliation handles it later without risking closure of newer live-session tabs.
- Changing the configured default away from `ChromeUbunut`.
- Pushing, publishing npm, tagging a release, or deploying the extension.
