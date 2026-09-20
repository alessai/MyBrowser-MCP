# MyBrowser File Transfers — v1 Implementation Contract

All agents build against this spec. Do not deviate without recording the reason in your final report.

## Problem
- `browser_download`: bytes land on the BROWSER machine; MCP client can't reach them.
- `browser_upload` (`files`): paths must exist on the BROWSER machine (CDP `DOM.setFileInputFiles`).
- Fix: chunked base64 transfer over the EXISTING authenticated JSON WebSocket (extension offscreen doc ↔ hub), ≤ 4 MiB encoded chunks, sha256-verified, atomic landing on the hub for downloads, in-memory `DataTransfer` injection (zero disk) for uploads.

## Config (`~/.mybrowser/config.json`, new optional section)
```json
"transfers": { "maxFileMb": 40, "retentionDays": 7, "maxTotalMb": 2048 }
```
Defaults as shown. Validation ranges: maxFileMb 1–100, retentionDays 1–90, maxTotalMb 16–20480. Invalid → startup fails closed (follow `localUrlHost` validation pattern in `server/src/auth.ts`).

## New WS messages (protocol v2, exact-key validated, style of `server/src/protocol.ts`)

### Extension → hub (download/fetch direction)
```json
{ "type": "transfer_chunk", "v": 2, "transferId": "<uuid>", "requestId": "<orig tool request id>",
  "seq": 0, "totalChunks": 12, "totalBytes": 12345678, "sha256": "<hex, whole file>",
  "filename": "report.pdf", "mimeType": "application/pdf", "bytesBase64": "..." }
```
- `seq` 0-based, in-order (no reordering support in v1 — out-of-order ⇒ abort transfer with code `TRANSFER_OUT_OF_ORDER`).
- `bytesBase64` canonical base64 (regex `^[A-Za-z0-9+/]+={0,2}$`), decoded ≤ 3 MiB per chunk; total decoded = totalBytes.
- `filename`: server-side `basename()`-sanitized, `^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$`, no path separators. Reject otherwise (`TRANSFER_BAD_FILENAME`).
- sessionId binding: hub validates against the originating tool request's session exactly like tool responses.

### Hub → extension (acks, both directions)
```json
{ "type": "transfer_ack", "transferId": "...", "seq": 0, "ok": true }
{ "type": "transfer_ack", "transferId": "...", "seq": 0, "ok": false, "code": "TRANSFER_TOO_LARGE", "message": "..." }
```
Sender keeps ≤ 4 chunks in flight, waits for acks, aborts on `ok:false`.

### Hub → extension (upload direction)
```json
{ "type": "transfer_begin", "v": 2, "transferId": "<uuid>", "requestId": "...", "direction": "upload",
  "fileIndex": 0, "fileCount": 2, "filename": "photo.jpg", "mimeType": "image/jpeg",
  "totalBytes": 900000, "totalChunks": 1, "sha256": "<hex>",
  "targetTabId": 123, "selector": "input[type=file]" }
```
followed by `transfer_chunk` messages with the same `{transferId, requestId, seq, …}` shape as above (hub→extension). Extension acks each.

## Completion semantics (critical)
- **Fetch/download**: the HUB resolves the pending tool request when the last chunk is reassembled AND sha256 AND totalBytes verify. If the extension's normal `messageResponse` for the request arrives first, hold it until reassembly finishes (`registry.await(transferId)`), then resolve with `{ landedPath, filename, bytes, sha256, mimeType }`. On mismatch/abort/timeout: reject the pending request with a clear error and delete the partial file.
- **Upload**: extension completes the normal `messageResponse` with `{ uploaded: true, files: [...] }` after the content-script commit succeeds for every file.

## Tool: `browser_fetch_file` (new, server-side def + hub registry)
- Args: `{ url: z.string().url(), filename?: z.string().optional() }`. `timeoutMs: 300_000` (pattern: `server/src/tools/replay.ts:309`).
- Server mints `transferId` (crypto.randomUUID), derives/sanitizes filename (last URL path segment fallback), payload: `{ url, filename, transferId }`.
- Add `"browser_fetch_file"` to `URL_PAYLOAD_TYPES` in `server/src/local-url.ts` (loopback rewrite applies).
- Description MUST state: fetches THROUGH the selected browser (its cookies/network position), transfers bytes to the MCP server machine, lands under `~/.mybrowser/transfers/downloads/<sessionId>/` with provenance; for browser-local landing use `browser_download`.

## Tool: `browser_upload` (extended)
- Args: `{ selector, tabId?, files?: string[], localFiles?: string[] }` — exactly one of `files` / `localFiles` (zod refinement; violation ⇒ clear error).
- `files` (browser-local, existing CDP path): unchanged behavior.
- `localFiles` (MCP-server-local absolute paths): server stats + reads each file (reject missing/unreadable with the path and which machine it must exist on), enforces per-file `maxFileMb`, computes sha256, then initiates hub→extension transfer bound to the pending requestId; `timeoutMs: 300_000` when `localFiles` present.
- Description MUST state where each mode's paths resolve and the size cap.

## Tool: `browser_download` (fixed semantics)
- After `chrome.downloads.download`, poll `chrome.downloads.search({id})` until `state` is `complete` or `interrupted` (bounded by `ctx.signal` / request expiry; poll interval 250 ms), pass `conflictAction: 'uniquify'` and `saveAs: false` explicitly, return final absolute `filename` from the DownloadItem and `interrupted` error if failed.
- Description MUST state the file stays on the browser's machine.

## Extension architecture

### `extension/src/lib/transfer-shared.ts` (new, Agent 2)
- `CHUNK_DECODED_BYTES = 3 * 1024 * 1024`; `ACK_WINDOW = 4`.
- Chunked base64 encode/decode (reuse the 32 KB-chunk btoa pattern from `background/index.ts:812-826`).
- Type guards `isTransferChunk`, `isTransferAck`, `isTransferBegin` (mirror `protocol.ts` exact-key style).

### Offscreen (`extension/src/entrypoints/offscreen/main.ts`, Agent 2)
- Port message `{type:'transfer_fetch_start', transferId, requestId, url}` ⇒ `fetch(url, {credentials:'include'})`; on !response.ok fail via `{type:'transfer_fetch_done', transferId, ok:false, error}`; stream `response.body`, chunk-encode, send `transfer_chunk` over WS respecting ack window; finish with port message `{type:'transfer_fetch_done', transferId, ok:true, bytesSent}`. Internal deadline 290 s.
- Inbound `transfer_begin`/`transfer_chunk` (upload): accumulate per-transfer in memory (Map keyed by transferId), verify sha256+size on final chunk, then notify SW via port `{type:'transfer_upload_ready', transferId, requestId, targetTabId, selector, fileIndex, fileCount, filename, mimeType, totalBytes}`; SW pulls bytes chunk-wise via port RPC `{type:'transfer_chunk_pull', transferId, seq, offset, length}` (replies raw base64 slices ≤ 1 MiB) so no oversized port message is ever built.

### Background (`extension/src/entrypoints/background/index.ts`, Agent 2)
- `browser_fetch_file` tool request ⇒ port RPC `transfer_fetch_start` to offscreen, await `transfer_fetch_done` (290 s), return `{ transferred: true, transferId, bytesSent }` (hub performs final resolution).
- `browser_upload` request whose payload has `localFiles` ⇒ skip the normal handler; drive the upload flow: on `transfer_upload_ready` per file ⇒ `chrome.scripting.executeScript` the content script into `targetTabId` (if not present) ⇒ `tabs.sendMessage` sequence below ⇒ on all files committed, respond `{ uploaded: true, files: [...] }`; any failure ⇒ error response.
- Content-script protocol (Agent 2): `transfer_reset {selector, fileIndex, fileCount}` ⇒ `transfer_put {seq, bytesBase64}` (accumulate Uint8Array parts) ⇒ `transfer_commit {filename, mimeType, size}` ⇒ build `new File([bytes], filename, {type})`, `const dt = new DataTransfer(); dt.items.add(file); input.files = dt.files;` dispatch `input` + `change` (bubbles, cancelable) ⇒ `{ok:true, name, size}`. New file: `extension/src/entrypoints/content-scripts/transfer.ts` (registered in `wxt.config.ts` manifest content_scripts — Agent 2 owns `wxt.config.ts` for this + wss below).
- `extension/src/lib/local-connection.ts`: support explicit `wss://` hub URL override from `mybrowser.local.json` (scheme passthrough; no behavior change for existing ws://).

## Server architecture (Agent 1)
- `server/src/transfers/registry.ts` — `TransferRegistry`: `expect(transferId, meta, onComplete, onError)`; `ingestChunk(msg)` (zod-validated, session-checked); staged `.part` file under `~/.mybrowser/transfers/.tmp/`; verify sha256+totalBytes; atomic rename to landing path; per-session concurrent cap 2; per-file cap = config maxFileMb; aggregate budget via retention module.
- `server/src/transfers/landing.ts` — final path `~/.mybrowser/transfers/downloads/<sessionId>/<YYYYMMDD-HHmmss>-<filename>` (dedupe suffix if exists); server-side filename sanitizer (spec regex above); writes: mkdir 0700 recursive, `O_EXCL|O_NOFOLLOW` create 0600, ancestor-symlink check, fsync file+dir, dev/ino re-verify — copy `server/src/telemetry/writer.ts:469-561` and `server/src/tools/record.ts:647-652,675-738`. Provenance sidecar `<final>.provenance.json` written BEFORE payload (pattern `server/src/notes.ts:274-352`): `{sourceUrl, browserId, sessionId, transferId, sha256, bytes, mimeType, receivedAt}`.
- `server/src/transfers/retention.ts` — sweep at hub start + session finalize (hook alongside recording cleanup in `ws-server.ts`): delete >retentionDays old; enforce maxTotalMb by deleting oldest first; never follow symlinks (`O_NOFOLLOW` unavailable ⇒ fail closed, pattern `record.ts`).
- `ws-server.ts` — route inbound `transfer_chunk` from extension sockets to registry, emit acks; synthesize pending-request completion (both hub-proxy and standalone-server modes — the pending map used for tool proxying); relay `transfer_begin/chunk/ack` for the upload direction between client sockets and extension sockets (sessionId + requestId binding validated like tool requests).
- `server/src/context.ts` — `startUploadTransfer(requestId, files: {path, filename, mimeType}[], target: {tabId, selector})`: stat+read+sha256, enforce caps, send `transfer_begin`+chunks to the hub socket honoring ack window (this runs on the MCP-client process; in hub mode chunks relay through the hub — Agent 1 owns both sides).
- `server/src/auth.ts` — parse/validate `transfers` config section (fail-closed).
- `server/src/telemetry/policies.ts` — add `browser_fetch_file: immutablePolicy({ url: url(), filename: pseudonym("download_name") })`; add `localFiles: pseudonym("local_path")` to the `browser_upload` policy. (Startup validation blocks if a runtime tool arg lacks a policy — these entries are mandatory.)
- `server/src/tools/fetch-file.ts` (new; Agent 3 registers in `server.ts`).

## File ownership (STRICT — do not edit outside your list)
- **Agent 1 (server infra)**: `server/src/transfers/**` (new), `server/src/ws-server.ts`, `server/src/context.ts`, `server/src/auth.ts`, `server/src/telemetry/policies.ts` + tests.
- **Agent 2 (extension transport)**: `extension/src/lib/transfer-shared.ts` (new), `extension/src/lib/local-connection.ts`, `extension/src/entrypoints/offscreen/main.ts`, `extension/src/entrypoints/background/index.ts`, `extension/src/entrypoints/content-scripts/transfer.ts` (new), `extension/wxt.config.ts` + tests.
- **Agent 3 (tool surfaces)**: `server/src/tools/download.ts`, `server/src/tools/upload.ts`, `server/src/tools/fetch-file.ts` (new), `server/src/local-url.ts`, `server/src/server.ts` (tool registration ONLY), `extension/src/lib/tools.ts` (browser_download completion + upload error unmask ONLY) + tests.

## Cross-agent API stubs (compile-safe boundaries)
Agent 3's tools must compile without Agents 1–2 finished:
- `context.sendSocketMessage("browser_fetch_file", payload, { timeoutMs: 300_000 })` — existing API, no new import.
- Upload localFiles: call `context.startUploadTransfer(...)` — Agent 1 ships it; Agent 3 may import the declared signature `startUploadTransfer(requestId: string, files: Array<{path: string; filename: string; mimeType: string}>, target: {tabId?: number; selector: string}): Promise<{files: Array<{name: string; size: number; sha256: string}>, landedPath?: never}>` from `../context.js`. If absent at Agent 3's build time, Agent 3 writes the call and its test with a mocked context (tests mock context anyway).

## Verification each agent runs (cwd = MyBrowser/server or MyBrowser/extension)
`npx vitest run <your test files>` then `npx tsc --noEmit`. All green before reporting done.
