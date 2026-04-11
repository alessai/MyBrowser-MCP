# @mybrowser/mcp

MCP server for MyBrowser browser automation.

Important: installing this npm package is only half of the setup. You also need the MyBrowser Chrome extension.

## Features

This package exposes a browser MCP with support for:

1. Navigation, tabs, clicks, typing, hover, drag and drop, and keyboard input
2. Screenshots with interactive markers and ARIA snapshots
3. Structured extraction, element search, and form filling
4. Console logs, page eval, storage inspection, network capture, and performance metrics
5. Uploads, downloads, clipboard access, and waiting for real page conditions
6. Record and replay flows
7. Shared state, tab ownership, session coordination, and locks for multi-agent use
8. Event handlers for dialogs, new tabs, beforeunload prompts, and stuck requests
9. Saved browser notes and page knowledge

## Install

```bash
npm install -g @mybrowser/mcp
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

After installing the npm package, download the Chrome extension from the GitHub Releases page.

The npm package is the server. The release zip is the browser side.

Then:

1. Unzip the extension
2. Open `chrome://extensions`
3. Enable **Developer mode**
4. Click **Load unpacked**
5. Select the unzipped folder
6. Enter the server address, port, and auth token in the extension popup

## Repository

GitHub: `https://github.com/alessai/MyBrowser-MCP`
