# ULTRA MyBrowser MCP — Implementation Plan

## Vision
An AI-native browser runtime with eyes, memory, reflexes, and teamwork.

## 4 Layers

### Layer 1: PERCEPTION
- Set-of-Marks (SoM) visual grounding — numbered boxes on screenshots, compact label map
- Live incremental DOM model — every response includes "what changed"
- Structured data extraction (`browser_extract`)
- Viewport-only snapshots (5K vs 168K)

### Layer 2: ACTION
- Intent commands (`browser_do`) — template engine + POM + compound execution
- Compound action sequences (`browser_action`)
- Natural language element targeting (role+name, label, text, proximity)
- Smart form filling (`browser_fill_form`)
- Event-driven reactions (`browser_on`) — handles dialogs, CAPTCHAs, timeouts autonomously
- Conditional waiting (`browser_wait_for`)
- Assertions (`browser_assert`)

### Layer 3: MEMORY
- Auto Page Object Models — browser learns sites on first visit
- Session recording & parameterized replay
- Site knowledge graph with quirks database
- Time-travel debugging

### Layer 4: COLLABORATION
- Hub server: single extension, multiple concurrent MCP sessions
- Tab-level ownership isolation
- Tab handoff between agents
- Shared state store for inter-agent data
- Critical section locking

---

## Current State (audited 2026-04-10)

Legend: ✅ shipped · 🚧 partial · ❌ missing

### Phase 1: PERCEPTION — 🚧 mostly shipped (4/6)

| # | Deliverable | Status | Evidence |
|---|---|---|---|
| 1 | Set-of-Marks engine | ✅ | `extension/src/lib/set-of-marks.ts` (306 lines, 10-color palette, 60-char name truncation at :265) |
| 2 | Viewport-only snapshot mode | ✅ | `server/src/tools/snapshot.ts:8` (default `true`); prune/collapse at `extension/src/lib/aria-snapshot.ts:1382-1391` |
| 3 | Stable element IDs across snapshots | ✅ | `data-mb-id` attrs at `extension/src/lib/aria-snapshot.ts:1268`; resolution at `element-resolver.ts:181-199` |
| 4 | Natural-language element resolver | ✅ | `element-resolver.ts:403-443` — 7 fallback strategies (ref, mark, selector, role+name, label, text, proximity) |
| 5 | Model-aware response truncation | 🚧 | Fixed 30K char cap at `server/src/utils/aria-snapshot.ts:3` — not dynamic by model or remaining context |
| 6 | Live incremental DOM diff ("what changed") | ❌ | No diff/delta/mutation tracking in snapshot pipeline |

### Phase 2: ACTION — 🚧 5/6 shipped

| # | Deliverable | Status | Evidence |
|---|---|---|---|
| 7 | `browser_action` compound sequencer | ✅ | `server/src/tools/action.ts:72-155`; `extension/src/lib/action-sequencer.ts` (12 action types, auto DOM-stabilize) |
| 8 | `browser_fill_form` with label association | ✅ | `server/src/tools/form.ts:19-51`; 5-strategy label matching at `extension/src/entrypoints/content/index.ts:530-737` |
| 9 | `browser_wait_for` conditional waiting | ✅ | `server/src/tools/waitfor.ts:24-47`; 7 conditions at `content/index.ts:369-424` (url, element, text, network_idle) |
| 10 | `browser_assert` assertion engine | ✅ | `waitfor.ts:74-95`; 9 check types at `content/index.ts:429-526` |
| 11 | `browser_extract` structured extraction | ✅ | `server/src/tools/extract.ts:14-34`; field syntax (`self`, `@attr`, nested CSS) at `content/index.ts:741-765` |
| 12 | `browser_do` intent/template engine | ❌ | No `tools/do.ts`; not registered. `browser_action` covers compound flow but no POM-backed NL intent layer |

### Phase 3: MEMORY — ✅ complete (5/5)

| # | Deliverable | Status | Evidence |
|---|---|---|---|
| 13 | Auto POM generation | ✅ | `server/src/tools/learn.ts:24-103`; page walker at `content/index.ts:769-857`; persisted via `site-knowledge.ts:119` |
| 14 | Session recording engine | ✅ | `server/src/tools/record.ts:24-67`; state machine at `extension/src/lib/recorder.ts:45-85`; atomic write at `record.ts:125-143` |
| 15 | Parameterized replay | ✅ | `server/src/tools/replay.ts:32-111`; `{{var}}` + exact-match substitution at `replayer.ts:40-119`, recursive through arrays/objects |
| 16 | Site knowledge persistence | ✅ | `~/.mybrowser/sites/{domain}.json` file-backed with atomic writes at `site-knowledge.ts:50-73` |
| 17 | Time-travel debugging | ✅ | `startFromStep`/`stopAtStep` at `replay.ts:24-29`, enforced at `replayer.ts:157-172` |

### Phase 4: COLLABORATION — 🚧 4/6 shipped

| # | Deliverable | Status | Evidence |
|---|---|---|---|
| 18 | Hub server (multi-client) | ✅ | `server/src/ws-server.ts:28-51` — auto-elects hub via port binding; subsequent processes connect as WS clients |
| 19 | Session manager + tab ownership | ✅* | `state-manager.ts:74-242` (`ownedTabs: Set<string>` per session); enforced at `server.ts:193-223`. *Gated on `MUTATING_TOOLS` membership AND `shouldEnforceOwnership()` (multi-session mode only) — intentional single-session fast path |
| 20 | `browser_handoff` atomic transfer | ✅ | `tools/collaborate.ts:27-79`; atomic remove+add at `state-manager.ts:152-153` |
| 21 | Shared state store (hub-global) | ✅ | `state-manager.ts:213-241`; `browser_shared_get/set/delete/list` via `collaborate.ts:156` |
| 22 | `browser_lock` / `browser_unlock` | ❌ | Not implemented. `collaborate.ts:156` returns only `{handoff, sharedGet, sharedSet, sharedDelete, sharedList}` |
| 23 | `mybrowser-client` stdio↔TCP bridge | ⚠️ superseded | Architecture converged on embedding stdio+WS client in the same MCP process (`server/src/index.ts:66` + `connectAsClient()`). Plan goal achieved without a separate bin |

### Phase 5: DEBUGGING — 🚧 4/5 shipped

| # | Deliverable | Status | Evidence |
|---|---|---|---|
| 24 | `browser_eval` JS execution | ✅ | `server/src/tools/eval.ts:11-32`; CDP `Runtime.evaluate` with content-script fallback at `extension/src/lib/tools.ts:666-708` |
| 25 | `browser_network` capture | ✅ | `network.ts:23-39`; CDP `Network.*` events at `extension/src/lib/debugger.ts:383-438`, 200-entry buffer, URL/method/status/resourceType filters |
| 26 | `browser_performance` metrics | ✅ | `performance.ts:15-31`; CDP `Performance.getMetrics` + real Web Vitals (LCP/FID/CLS/TTFB) at `tools.ts:916-982` |
| 27 | `browser_storage` | ✅ | `storage.ts:14-35`; all three stores (local/session/cookies) CRUD at `tools.ts:712-838` |
| 28 | `browser_on` autonomous reactions | ❌ | Not implemented. No event subscription mechanism for dialogs, CAPTCHAs, or timeouts |

---

## Outstanding Work

Ordered by impact on daily use:

### 1. `browser_do` — intent + POM + template engine
- **Have:** `browser_action` sequencer, `browser_learn` POM persistence, site-knowledge store
- **Missing:** the glue layer that maps a natural-language goal (`"log in as admin"`) to a stored POM flow with parameter binding
- **Blocks:** any workflow where the agent should reuse a previously-learned flow without hand-assembling the `browser_action` payload

### 2. `browser_on` — event-driven autonomous reactions
- **Missing:** extension→server event subscription; default handlers for JS `alert`/`confirm`/`prompt`, `beforeunload`, CAPTCHA/Cloudflare interstitials, navigation timeouts
- **Blocks:** long-running unattended flows — any modal currently stalls the agent

### 3. Live DOM diff / "what changed"
- **Missing:** snapshot pipeline has no previous-state comparison; every response re-sends the full viewport tree
- **Blocks:** token efficiency on multi-step flows where >90% of DOM is unchanged between calls

### 4. `browser_lock` / `browser_unlock`
- **Have:** tab-level ownership already gives most isolation
- **Missing:** named mutex primitive for non-tab critical sections (two agents sharing a tab but serializing writes)
- **Blocks:** only multi-agent coordination — lower priority today

### 5. Model-aware response truncation
- **Have:** static 30K char cap
- **Missing:** ceiling derived from remaining context budget and active model
- **Blocks:** nothing urgent — wastes tokens under Haiku, over-truncates under Opus

---

## Tool Inventory

**Shipped (34 tools):**
Navigation: `browser_navigate`, `browser_go_back`, `browser_go_forward`, `browser_wait`, `browser_wait_for`
Input: `browser_click`, `browser_type`, `browser_hover`, `browser_press_key`, `browser_drag`, `browser_select_option`
Perception: `browser_snapshot`, `browser_screenshot`, `browser_extract`, `browser_find`
Action: `browser_fill_form`, `browser_action`, `browser_assert`
Memory: `browser_learn`, `browser_site_info`, `browser_record_start`, `browser_record_stop`, `browser_record_list`, `browser_replay`
Collab: `browser_claim_tab`, `browser_release_tab`, `browser_sessions`, `browser_handoff`, `browser_shared_get`, `browser_shared_set`, `browser_shared_delete`, `browser_shared_list`
Debug: `browser_eval`, `browser_storage`, `browser_network`, `browser_performance`, `get_console_logs`
Tabs: `list_tabs`, `select_tab`, `new_tab`, `close_tab`, `list_browsers`, `select_browser`
Files: `browser_upload`, `browser_download`, `browser_clipboard`

**Planned, not implemented (3):** `browser_do`, `browser_on`, `browser_lock`/`browser_unlock`

## Model Cascade (aspirational)
- OPUS (5%): Explore, record, build POMs, debug complex
- SONNET (20%): Interactive, adapt flows, orchestrate
- HAIKU (75%): Replay, cron, health checks, bulk testing via SoM
