# @alessai/mybrowser-mcp

Persistent Chrome automation for MCP.

This package is the server side of MyBrowser. It gives an MCP client access to a real browser with navigation, screenshots, extraction, console and network tooling, uploads, downloads, recording, replay, and multi-session coordination.

Important: installing this npm package is only half of the setup. You also need the MyBrowser Chrome extension.

## Highlights

1. Browser control: tabs, navigation, clicks, typing, forms, hover, drag and drop, and keyboard input
2. Inspection: screenshots with interactive markers, ARIA snapshots, element search, and structured extraction
3. Debugging: console logs, page eval, storage inspection, network capture, and performance metrics
4. Workflow tools: uploads, downloads, clipboard support, waits, recording, replay, and saved site knowledge
5. Coordination: shared state, tab ownership, session management, locks, and event handlers

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
6. Enter the server address, port, and auth token in the extension popup

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

## Repository

GitHub: `https://github.com/alessai/MyBrowser-MCP`
