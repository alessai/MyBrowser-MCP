# MyBrowser MCP

Persistent Chrome automation for Claude Code and any MCP client.

MyBrowser gives your MCP client a real, long-running Chrome browser it can control, inspect, and coordinate. It goes beyond basic navigation with screenshots, structured extraction, console and network tooling, uploads, downloads, recording, replay, and multi-session tab ownership.

Best for workflows where an agent needs to keep a browser alive, inspect real browser state, and recover from real website behavior.

Important: MyBrowser has 2 parts.

1. The MCP server
2. The Chrome extension

`npm` installs only the server. You still need the Chrome extension from GitHub Releases.

## Zero-entry local setup

The ordinary same-device setup now defaults to `127.0.0.1:9009` and connects the Chrome extension without asking you to copy an auth token. This shortcut is deliberately limited to an ordinary loopback server and a local Chrome extension connection. Standalone hubs, `--ensure-hub`, remote addresses, and MCP client-to-hub connections remain token-authenticated.

When the extension is loaded for the first time, it opens a short setup and usage guide. The guide checks connection state, provides the MCP command, walks through a first browser task, and explains page annotations with `Alt+Shift+A`.

## Fastest Setup for Claude Code

Giving this repository to an installation agent? Use [`llms.txt`](llms.txt) for the shortest safe handoff.

Add MyBrowser to Claude Code with one command:

```bash
claude mcp add mybrowser -- npx -y @alessai/mybrowser-mcp
```

Then:

1. Download `mybrowser-extension-*-chrome.zip` from `https://github.com/alessai/MyBrowser-MCP/releases/latest`
2. Unzip it, open `chrome://extensions`, enable **Developer mode**, and choose **Load unpacked**
3. Select the unzipped folder. The tutorial opens automatically; no CMD installer, token entry, or extension settings are needed for ordinary local use

## Why It Stands Out

| Capability | MyBrowser | Typical lightweight browser MCP |
| --- | --- | --- |
| Persistent browser connection | Yes | Limited |
| Screenshots with interactive markers | Yes | Sometimes |
| Console, network, storage, performance tools | Yes | Rare |
| Responsive viewport presets | Yes | Rare |
| Uploads, downloads, clipboard support | Yes | Limited |
| Persistent default browser for multi-browser setups | Yes | Rare |
| Multi-session tab ownership and locks | Yes | No |
| Event handlers for dialogs and stuck requests | Yes | Rare |
| Recording, replay, and saved site knowledge | Yes | Rare |

## Why MyBrowser

Most browser MCPs stop at simple page navigation.

MyBrowser is built for practical workflows where an agent needs to:

1. Keep a browser connected over time
2. Inspect real browser state, not just page HTML
3. Recover from prompts, dialogs, and flaky page behavior
4. Coordinate access across tabs and sessions
5. Record, replay, and reuse browser knowledge

## What It Can Do

### Control the Browser

1. Open tabs and switch between them
2. Navigate, go back, and go forward
3. Click, type, hover, drag, drop, and press keys
4. Fill forms and run multi-step browser actions

### Inspect and Extract

1. Take screenshots with numbered interactive markers
2. Capture ARIA snapshots for accessibility-aware inspection
3. Find elements by text, role, label, or selector
4. Extract structured data from the page

### Debug Real Browser Behavior

1. Read console logs
2. Run page JavaScript
3. Inspect localStorage, sessionStorage, and cookies
4. Capture network traffic and performance metrics
5. Wait for real page conditions including network idle
6. Switch between current iPhone, iPad, and desktop viewport presets for responsive QA
7. Collect redacted diagnostics and support bundles when something fails

### Handle Real Workflows

1. Upload files and trigger downloads
2. Use the clipboard
3. Record flows and replay them later
4. Learn page objects and save site knowledge
5. Save browser notes and annotations for later review

### Coordinate Multiple Agents

1. List sessions and connected browsers
2. Set a persistent default browser by browser name for multi-browser setups
3. Claim tabs and hand them off safely
4. Share state across sessions
5. Coordinate with locks
6. Register event handlers for dialogs, new tabs, beforeunload prompts, and stuck network requests

## Quick Demo

Example prompts you can give your MCP client:

1. "Open GitHub, search for BrowserMCP, and click the repository"
2. "Take a screenshot of this page and label the clickable elements"
3. "Extract the pricing cards on this page into JSON"
4. "Fill this signup form but stop before submitting"
5. "Start network capture, submit the form, and show me the XHR requests"
6. "Record this login flow so I can replay it later"

## Use Cases

1. QA and browser regression testing
2. Customer support debugging with a live browser session
3. Structured data extraction from real web apps
4. Admin and backoffice automation
5. Multi-agent browser workflows where tab ownership matters
6. Browser-assisted research with screenshots, notes, and extraction

## Install

### Claude Code one-liner

```bash
claude mcp add mybrowser -- npx -y @alessai/mybrowser-mcp
```

### Global npm install

#### 1. Install the MCP server

```bash
npm install -g @alessai/mybrowser-mcp
```

#### 2. Start the ordinary local server

```bash
mybrowser-mcp
```

On first run, MyBrowser creates `~/.mybrowser/config.json`. The ordinary loopback extension connection is automatic and does not ask for that token. The server stops with its MCP client; use the authenticated `--ensure-hub` or managed `--hub` modes only when you explicitly need a shared, independently running hub. Later `--host`, `--port`, and `--token` overrides apply only to that run.

#### 3. Optional managed Windows installation

Download `mybrowser-windows-installer.zip` from the latest release, extract it, and double-click:

```text
install-mybrowser.cmd
```

The installer downloads and verifies the latest extension, then stores it at:

```text
%LOCALAPPDATA%\Alessai\MyBrowser\Extension
```

When `%USERPROFILE%\.mybrowser\config.json` exists, the installer reads its token and port and prepares the extension for `127.0.0.1` automatically. The token is not printed or copied to the clipboard. If the config does not exist yet, start MyBrowser MCP once and rerun the installer, or enter the settings manually. If the token or port later changes, rerun `install-mybrowser.cmd`; it detects and refreshes the changed configuration.

The local bootstrap contains the same token as the MCP config and stays under the current user's Local AppData. Do not share the installed extension folder.

On the first install, Chrome opens `chrome://extensions`. Turn on **Developer mode**, click **Load unpacked**, and select the folder shown by the installer. This is the only manual installation step Chrome requires.

If MyBrowser was previously loaded from another folder, remove that unpacked copy first so Chrome does not run two copies.

For later updates, run `install-mybrowser.cmd` again. Close Chrome when prompted; the installer replaces the extension only after Chrome has fully exited, then reopens Chrome with the new version. It never force-closes Chrome.

#### 4. Direct extension installation on any platform

Download the Chrome extension zip from the latest release:

`https://github.com/alessai/MyBrowser-MCP/releases/latest`

Look for a file named like:

```text
mybrowser-extension-1.1.7-chrome.zip
```

Load the extension in Chrome:

1. Unzip the downloaded file
2. Open `chrome://extensions`
3. Turn on **Developer mode**
4. Click **Load unpacked**
5. Select the unzipped extension folder

#### 5. Follow the first-install guide

The extension opens its guide once after **Load unpacked**. For ordinary local use it already targets `127.0.0.1:9009`; do not enter a token. Open the popup's **Setup & annotation guide** link whenever you want to revisit the instructions. Use the popup settings only for an authenticated hub or remote server.

## MCP Config Example

Example MCP config using the installed binary:

```json
{
  "mcpServers": {
    "mybrowser": {
      "command": "mybrowser-mcp",
      "args": []
    }
  }
}
```

Example Claude Code command using the installed binary instead of `npx`:

```bash
claude mcp add mybrowser -- mybrowser-mcp
```

## How It Works

MyBrowser splits browser automation into two pieces:

1. The MCP server exposes tools to your client
2. The Chrome extension connects to that server and performs real browser actions

This is why you need both the npm package and the extension zip.

## Security Model

1. Fresh installs bind to `127.0.0.1`
2. Ordinary local mode accepts a blank extension token only from a loopback peer with a `chrome-extension://` WebSocket origin
3. Websites, MCP clients, wildcard listeners, explicit `--token`, `--ensure-hub`, standalone `--hub`, and remote connections still require the configured token
4. Local programs can imitate protocol headers, so do not forward or expose the ordinary tokenless listener; use an authenticated hub for remote access
5. Use `--host 0.0.0.0` only when you intentionally expose an authenticated server through a trusted network or tunnel
6. Broad browser permissions are required because MyBrowser supports real browser automation, debugging, uploads, downloads, screenshots, and inspection

For a managed remote hub, configure MCP clients with the same `--host` address as the hub. Different local addresses can own the same port independently and are intentionally not auto-discovered.

## Diagnostics and Support

MyBrowser keeps local server logs and exposes support tools for debugging setup or runtime issues.

Server logs are written to:

```text
~/.mybrowser/logs/mybrowser-mcp.log
~/.mybrowser/logs/mybrowser-mcp-errors.log
```

Useful MCP tools:

1. `browser_diagnostics` - returns redacted server, browser, session, extension, and recent failure information
2. `browser_support_bundle` - writes a redacted JSON support bundle under `~/.mybrowser/support-bundles/`
3. `browser_get_console_logs` - returns browser page console logs
4. `browser_network` - captures and inspects network requests
5. `browser_set_viewport` / `browser_reset_viewport` - applies or clears iPhone, iPad, and desktop viewport emulation
6. `list_browsers`, `select_browser`, `set_default_browser`, `get_default_browser`, `clear_default_browser` - manage multi-browser routing

The Chrome extension popup also has a **Copy diagnostics** button for quickly sharing extension-side status.

## Repo Layout

The active source code lives under `MyBrowser/`:

1. `MyBrowser/server` - npm MCP server package
2. `MyBrowser/extension` - Chrome extension source

## Development

Server:

```bash
cd MyBrowser/server
npm install
npm run build
```

Extension:

```bash
cd MyBrowser/extension
npm install
npm run build
```

### npm releases

Maintainers publish the server package by creating a matching stable GitHub release tag, such as `v1.1.7`. The paired server and extension versions must already match; the release-contract test enforces that rule. The `publish-npm.yml` workflow verifies the tag and source, packs and tests the exact npm tarball, publishes it through npm Trusted Publishing, and verifies the public registry integrity. A manual dispatch is only a recovery path for an existing release tag whose `MyBrowser/` source still matches the selected workflow ref.

The one-time npm owner setup binds `@alessai/mybrowser-mcp` to GitHub Actions with organization or user `alessai`, repository `MyBrowser-MCP`, workflow filename `publish-npm.yml`, no environment, and allowed action `npm publish`. The filename is part of the publishing identity. After that binding works, set npm publishing access to **Require two-factor authentication and disallow tokens**. GitHub then supplies a short-lived OIDC identity for this workflow; the repository stores no npm publish token and later releases require no npm browser login or OTP.
