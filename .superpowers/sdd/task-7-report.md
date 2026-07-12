# Task 7 Report: Parameterize and Isolate Active Recordings

## Status

Implemented and verified. Active recordings are isolated by authenticated session and bound tab, sensitive values are replaced with deterministic placeholders before entering recording state, and no reverse-value map remains.

## Implementation

- Added exhaustive per-tool recording string metadata. Tab creation, selection, and closure remain non-recordable.
- Added deterministic parameterization for typed text, form values, selected values, sensitive navigation URLs, wait values, and clipboard writes.
- Added strict `RequiredVariable` metadata containing only `name`, `source`, and a generic counter hint.
- Replaced global recording/replay state with a session-keyed `RecordingManager`, tab binding, per-session replay suppression, prepared-step reservations, and sanitized snapshots.
- Enforced 1,000 steps, 2 MiB per recording, and 8 MiB aggregate before handlers run, including worst-case serialized URL and commit overhead.
- Persisted strict sanitized active state plus per-session marker keys in `chrome.storage.session`; added five-minute `chrome.alarms` renewal, restart restoration, atomic expiry cleanup, and `session_closed` cleanup.
- Added a correlated recording request broker that accepts only the expected result type and request ID, times out after 10 seconds, rejects on port disconnect, ignores unrelated responses, and never replays requests.
- Made stop persist to the server first, then perform a value-free local collision check and exclusive local write. Partial server/local failures return sanitized status and recording data.
- Integrated prepare-before-handler and commit-after-success in the authenticated background request path. Failed handlers discard prepared state and expose only generic errors while recording.
- Removed legacy reverse-value storage and exact-original replay substitution. `replayer.ts` received the minimum Task 8-adjacent change needed to compile and substitute explicit placeholders without retaining originals.
- Hardened the server recording schema with strict generic variable metadata, recordable-action validation, sensitive-field placeholder validation, URL sanitization, step/byte caps, and rejection of legacy `variables` maps and step results.
- Local recording collision/list operations use `getBytesInUse` and `getKeys`, so legacy stored values are not deserialized merely to inspect keys. Unsafe recordings are deleted when explicitly loaded.

## TDD And Privacy Coverage

- Unique canaries cover type, form, select, navigation, clipboard, transport errors, storage errors, handler errors, restart state, snapshots, every test storage write, transport request, stop result, and thrown error string.
- RED/GREEN cycles covered parameterization, metadata exhaustiveness, session/tab isolation, replay suppression, failed-step discard, preflight limits, worst-case UTF-8 metadata, restart renewal, persisted-index isolation, expiry/session closure, correlated transport, stop ordering/collisions/partial failures, strict completed-state validation, server schema rejection, and failed-start rollback.
- Production scans found no canary literals and no legacy `recording.variables`, original-value map, verbatim argument clone, or whole-local-storage recording listing path.

## Verification

- Extension: `npm test` (11 files, 100 tests passed).
- Extension: `npm run check` passed.
- Extension: `npm run build` passed.
- Server: `npm test` (5 files, 131 tests passed).
- Server: `npm run check` passed.
- Server: `npm run build` passed.
- Repository: `git diff --check` passed.

## Self-Review

- Verified prepare occurs before browser handlers and cap failures cannot run browser actions.
- Verified commit stores no handler result and cannot exceed its preflight reservation.
- Verified cross-session stop does not read or erase another persisted active session.
- Verified server-first stop ordering and no local overwrite on collision.
- Verified restart cleanup handles both nested `session_closed` and `recording_reservation_expired` broadcasts.
- Verified dependency errors are reduced to generic codes and canaries do not appear in outputs.

## Residual Scope

- Task 8 remains responsible for broader legacy replay compatibility. Task 7 intentionally removes reverse-value substitution and supports only explicit placeholder substitution going forward.

## Review Findings Follow-Up

All five accepted Task 7 review findings were fixed in a separate follow-up change.

### Default-Deny Server Validation

- Exported action-specific server string classifications and finite non-string structural paths.
- Added a cross-package conformance test that derives extension metadata from `TOOL_METADATA` and compares every recordable action/path with the server mirrors.
- Recursively rejects unclassified string values, unknown object keys, empty unknown containers, nested extras, and type-mismatched paths before filesystem operations.
- Dynamic `fields` keys, including dotted labels, are the only dynamic structural keys; all form values remain placeholders.
- Added per-action top-level, nested, key, and sensitive-value canaries plus a no-disk-operation probe.
- Preserved the approved URL residual: ordinary HTTP(S) origin+pathname metadata remains; credentials, query, or hash require one full-URL placeholder.

### In-Flight And Log Privacy

- `PreparedStep.beganUnderRecording` survives session expiry/closure and forces the stable `RECORDED_TOOL_ACTION_FAILED` response even if manager state was already aborted.
- Background tool diagnostics never receive request payloads, stacks, or arbitrary handler messages; they contain request ID, tool type, stable category, and a recorded flag only.
- Added a deferred prepare/abort/reject canary test scanning response, diagnostics, console calls, all storage writes, and manager snapshot.
- Malformed WS frames now log only `INVALID_JSON` and byte length. A malformed secret-bearing frame test scans console and diagnostic sinks.

### Local Persistence And Cleanup

- Removed the legacy `saveRecording` handler and standalone completed-recording writer. The manager operation chain is the sole completed-recording writer.
- Completed recording and SHA-256 sidecar are written together. Exact sanitized content is idempotent; partial markers, legacy values, or differing content are collisions and never overwritten.
- Added concurrent same-name stop coverage proving serialized no-overwrite behavior.
- A stable stopped snapshot is persisted before server persistence and reused by every retry.
- Server persistence accepts post-release retries only for the same live session and an existing byte-equivalent sanitized artifact; differing content remains rejected.
- Active memory is deleted only after one atomic snapshot/marker removal succeeds. Cleanup failures return `ACTIVE_STATE_CLEANUP_FAILED` with exact save statuses and preserve retry state; alarm clearing is best-effort afterward.
- Added atomic removal failure, worker restart, identical local/server retry, no-resurrection, and partial server/local failure coverage.

### Follow-Up Verification

- Extension focused RED tests reproduced metadata drift, abort-after-prepare leakage, malformed-frame leakage, concurrent collision, and cleanup exceptions before implementation.
- Extension final: `npm test` passed, 12 files and 107 tests.
- Extension final: `npm run check` passed.
- Extension final: `npm run build` passed.
- Server focused RED tests reproduced default-allow argument persistence and post-release retry rejection before implementation.
- Server final: `npm test` passed, 6 files and 136 tests.
- Server final: `npm run check` passed.
- Server final: `npm run build` passed.
- Canary scan: all `SECRET_`/`CANARY_` matches are confined to test files.
- Legacy/privacy scan: no reverse map, standalone completed writer, raw-frame log, request-payload diagnostic, or verbatim argument clone remains.
- Repository: `git diff --check` passed.

## Final Review Findings Follow-Up

All three subsequent Task 7 findings were fixed in a separate follow-up change.

### HTTP(S)-Only URL Residual

- Explicit navigation retains origin plus pathname only for valid `http:` and `https:` URLs.
- Credentials, query, hash, `chrome:`, `about:`, `file:`, `data:`, `javascript:`, and custom schemes produce one full navigation placeholder.
- Passive current-page metadata retains only HTTP(S) origin plus pathname; every other scheme becomes an empty string and never creates a variable.
- Server validation mirrors the distinction between passive empty metadata and explicit navigation, where empty and non-HTTP(S) values are rejected unless represented by a navigation placeholder.
- Added extension and server regressions for HTTP, HTTPS, Chrome, about, file, data, JavaScript, and custom schemes.

### Strict Recording Shapes

- `RecordingSchema`, `RecordedStepSchema`, and `RequiredVariableSchema` are strict while dynamic action arguments remain governed by the recursive action-specific validator.
- Secret-bearing unknown fields at recording, step, and required-variable levels reject rather than strip.
- Direct sanitization and persistence probes confirm fixed-shape rejection occurs before filesystem operations.

### Atomic Restart-Safe Cleanup

- Replaced the shared active-session index with `active-recording-index:${sessionId}` marker keys.
- Active snapshots and markers persist together through one `setMany` call and are removed together through one `removeMany` call.
- Restore and renewal enumerate marker keys; concurrent sessions remain isolated and one session's stop cannot orphan another.
- A failed atomic removal retains snapshot, marker, and in-memory state; a restarted worker restores the stopped snapshot and retries server/local persistence and cleanup idempotently.
- Alarm clearing is best-effort after successful state removal; stale alarms enumerate no markers and cannot resurrect a recording.
- Legacy shared-index values are never read. Migration discovers active snapshot names from storage keys, writes per-session markers before deleting the legacy key, validates each snapshot, and atomically removes unsafe snapshot/marker pairs.
- Added remove failure, worker restart, retry stop, concurrent marker enumeration, migration ordering, abort cleanup, stale-alarm, and no-orphan coverage.

### Final Follow-Up Verification

- Extension RED: 2 URL-policy failures and 5 shared-index/cleanup failures reproduced before implementation.
- Extension focused GREEN: parameterizer and recorder suites passed, 34 tests.
- Extension final: `npm test` passed, 12 files and 110 tests.
- Extension final: `npm run check` passed.
- Extension final: `npm run build` passed.
- Server RED: non-HTTP residual acceptance and top-level unknown-field stripping reproduced before implementation.
- Server focused GREEN: recording privacy suite passed, 7 tests.
- Server final: `npm test` passed, 6 files and 138 tests.
- Server final: `npm run check` passed.
- Server final: `npm run build` passed.
- Canary scan: all `SECRET_` and `CANARY_` matches remain confined to test files.
- Lifecycle/privacy scan: no shared-index value read, split active snapshot/marker cleanup, or non-HTTP residual allowlist remains.
- Repository: `git diff --check` passed.
