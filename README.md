# MyBrowser MCP

Persistent Chrome automation for Claude Code and any MCP client.

MyBrowser gives your MCP client a real, long-running Chrome browser it can control, inspect, and coordinate. It goes beyond basic navigation with screenshots, structured extraction, console and network tooling, uploads, downloads, recording, replay, and multi-session tab ownership.

Best for workflows where an agent needs to keep a browser alive, inspect real browser state, and recover from real website behavior.

Important: MyBrowser has 2 parts.

1. The MCP server
2. The Chrome extension

`npm` installs only the server. You still need the Chrome extension from GitHub Releases.

## Fastest Setup for Claude Code

Add MyBrowser to Claude Code with one command:

```bash
claude mcp add mybrowser -- npx -y @alessai/mybrowser-mcp --host 0.0.0.0 --port 9009
```

Then:

1. Download the Chrome extension from `https://github.com/alessai/MyBrowser-MCP/releases/latest`
2. Load it in `chrome://extensions` using **Load unpacked**
3. Open the extension popup and enter the host, port, and auth token from `~/.mybrowser/config.json`

If `~/.mybrowser/config.json` has not been created yet, run `claude mcp get mybrowser` once to trigger the server and generate it.

## Why It Stands Out

| Capability | MyBrowser | Typical lightweight browser MCP |
| --- | --- | --- |
| Persistent browser connection | Yes | Limited |
| Screenshots with interactive markers | Yes | Sometimes |
| Console, network, storage, performance tools | Yes | Rare |
| Uploads, downloads, clipboard support | Yes | Limited |
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
6. Collect redacted diagnostics and support bundles when something fails

### Handle Real Workflows

1. Upload files and trigger downloads
2. Use the clipboard
3. Record flows and replay them later
4. Learn page objects and save site knowledge
5. Save browser notes and annotations for later review

### Coordinate Multiple Agents

1. List sessions and connected browsers
2. Claim tabs and hand them off safely
3. Share state across sessions
4. Coordinate with locks
5. Register event handlers for dialogs, new tabs, beforeunload prompts, and stuck network requests

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
claude mcp add mybrowser -- npx -y @alessai/mybrowser-mcp --host 0.0.0.0 --port 9009
```

### Global npm install

#### 1. Install the MCP server

```bash
npm install -g @alessai/mybrowser-mcp
```

#### 2. Start the server once

```bash
mybrowser-mcp --host 0.0.0.0 --port 9009
```

On first run, MyBrowser creates `~/.mybrowser/config.json` and stores the shared auth token there.

#### 3. Download the Chrome extension

Download the Chrome extension zip from the latest release:

`https://github.com/alessai/MyBrowser-MCP/releases/latest`

Look for a file named like:

```text
mybrowser-extension-1.1.1-chrome.zip
```

#### 4. Load the extension in Chrome

1. Unzip the downloaded file
2. Open `chrome://extensions`
3. Turn on **Developer mode**
4. Click **Load unpacked**
5. Select the unzipped extension folder

#### 5. Connect the extension

Open the extension popup and enter:

1. Server address
2. Port
3. Auth token from `~/.mybrowser/config.json`
4. Optional browser name

## MCP Config Example

Example MCP config using the installed binary:

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

Example Claude Code command using the installed binary instead of `npx`:

```bash
claude mcp add mybrowser -- mybrowser-mcp --host 0.0.0.0 --port 9009
```

## How It Works

MyBrowser splits browser automation into two pieces:

1. The MCP server exposes tools to your client
2. The Chrome extension connects to that server and performs real browser actions

This is why you need both the npm package and the extension zip.

## Security Model

1. The server runs on your machine or your own network
2. The extension connects only to the server address you configure
3. The server and extension share an auth token from `~/.mybrowser/config.json`
4. Broad browser permissions are required because MyBrowser supports real browser automation, debugging, uploads, downloads, screenshots, and inspection

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
