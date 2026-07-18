# @alessai/mybrowser-mcp

Persistent Chrome automation for Claude Code and any MCP client.

This package is the server side of MyBrowser. It gives an MCP client access to a real browser with navigation, screenshots, extraction, console and network tooling, uploads, downloads, recording, replay, and multi-session coordination.

Important: installing this npm package is only half of the setup. You also need the MyBrowser Chrome extension.

## Fastest Setup for Claude Code

```bash
claude mcp add mybrowser -- npx -y @alessai/mybrowser-mcp --host 0.0.0.0 --port 9009
```

Then install the Chrome extension from:

`https://github.com/alessai/MyBrowser-MCP/releases/latest`

If `~/.mybrowser/config.json` has not been created yet, run `claude mcp get mybrowser` once to trigger the server and generate it.

## Highlights

1. Browser control: tabs, navigation, clicks, typing, forms, hover, drag and drop, and keyboard input
2. Inspection: screenshots with interactive markers, ARIA snapshots, element search, and structured extraction
3. Debugging: console logs, page eval, storage inspection, network capture, performance metrics, and responsive viewport presets
4. Diagnostics: persistent server logs, redacted diagnostics, support bundles, and extension-side copy diagnostics
5. Workflow tools: uploads, downloads, clipboard support, waits, recording, replay, and saved site knowledge
6. Coordination: shared state, persistent default browser selection, tab ownership, session management, locks, and event handlers

## Install

```bash
npm install -g @alessai/mybrowser-mcp
```

## Start

```bash
mybrowser-mcp --host 0.0.0.0 --port 9009
```

On first run, MyBrowser writes its config to:

```text
~/.mybrowser/config.json
```

That file contains the shared auth token the Chrome extension needs.

## Chrome Extension Required

After installing the npm package, download the Chrome extension from the GitHub Releases page:

`https://github.com/alessai/MyBrowser-MCP/releases/latest`

Then:

1. Unzip the extension
2. Open `chrome://extensions`
3. Enable **Developer mode**
4. Click **Load unpacked**
5. Select the unzipped folder
6. Enter the server address, port, auth token, and an optional stable browser name in the extension popup

## MCP Config Example

```json
{
  "mcpServers": {
    "mybrowser": {
      "command": "mybrowser-mcp",
      "args": ["--host", "0.0.0.0", "--port", "9009"]
    }
  }
}
```

## Diagnostics

Server logs are written to:

```text
~/.mybrowser/logs/mybrowser-mcp.log
~/.mybrowser/logs/mybrowser-mcp-errors.log
```

Useful support tools:

1. `browser_diagnostics` - returns redacted server, browser, session, extension, and recent failure information
2. `browser_support_bundle` - writes a redacted support bundle under `~/.mybrowser/support-bundles/`
3. `browser_get_console_logs` - returns browser page console logs
4. `browser_network` - captures and inspects network requests
5. `browser_set_viewport` / `browser_reset_viewport` - applies or clears iPhone, iPad, and desktop viewport emulation
6. `list_browsers`, `select_browser`, `set_default_browser`, `get_default_browser`, `clear_default_browser` - manage multi-browser routing

## Optional Internal Tool Telemetry

Internal telemetry is an opt-in, local development aid for diagnosing repeated tool calls, retries, loops, no-op actions, and recovery behavior. It is **off by default**. MyBrowser does not enable it from an environment variable or send it over the network.

Enable it explicitly when starting an MCP client process:

```bash
mybrowser-mcp --trace-internal --host 0.0.0.0 --port 9009
```

Optional storage controls:

```bash
mybrowser-mcp \
  --trace-internal \
  --trace-dir ~/.mybrowser/traces \
  --trace-retention-days 14 \
  --trace-max-mb 256 \
  --host 0.0.0.0 \
  --port 9009
```

- Default trace directory: `~/.mybrowser/traces`
- Install pseudonymization key: `~/.mybrowser/trace-key`
- Retention range: 1–90 days; default 14 days
- Storage range: 16–2048 MiB; default 256 MiB
- Directories and files are created with private `0700` and `0600` permissions and fail closed on unsafe symlinks or file identities.
- Each MCP client process writes its own append-only JSONL run. A standalone hub does not write telemetry.

Stored events are deliberately narrow: tool names, safe argument presence/count/length summaries, keyed pseudonyms, correlation IDs, bounded durations and size buckets, stable outcome categories, queue/handler timing, and boolean state-change signals. Analyzer results can classify exact or semantic repeats, unchanged retries, error/timeout retries, oscillation, stale references, no-op actions, and recoveries.

MyBrowser does **not** store prompts, model chain-of-thought, typed or form values, passwords, tokens, cookies, clipboard data, page HTML, screenshots, raw URLs/paths, uploaded file paths, raw results, or free-form extension errors. Model identity is unavailable unless a host supplies it explicitly, and is not inferred. Trace files are not included in normal diagnostics or support bundles.

Inspect traces with local-only commands; these commands do not start the MCP server or connect to a hub:

```bash
mybrowser-mcp trace list --json
mybrowser-mcp trace analyze --json
mybrowser-mcp trace analyze --run <run-id>
mybrowser-mcp trace annotate --run <run-id> --call <call-id> --label mistake --note "short local note"
mybrowser-mcp trace export --run <run-id> --out ./mybrowser-trace-export.jsonl
mybrowser-mcp trace purge --older-than-days 14
```

Annotations store the label and, when safe, only an HMAC pseudonym of the optional note. Exports pass through the same closed runtime schema as persisted events and refuse to overwrite an existing output file. Treat even sanitized exports as private development artifacts.

For development, the reproducible disabled-path overhead check is:

```bash
npx --no-install vite-node benchmarks/disabled-telemetry.ts
```

The benchmark compares the real disabled `TelemetryManager.runToolCall()` path against the same representative operation in the same process and fails above 5% median overhead.

If you already installed the package globally, the equivalent Claude Code command is:

```bash
claude mcp add mybrowser -- mybrowser-mcp --host 0.0.0.0 --port 9009
```

## Repository

GitHub: `https://github.com/alessai/MyBrowser-MCP`
