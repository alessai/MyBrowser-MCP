# MyBrowser MCP

MyBrowser is a two-part browser automation setup for MCP:

1. The MCP server
2. The Chrome extension

`npm` installs only the MCP server. You still need to download and load the Chrome extension.

## Features

MyBrowser gives an MCP client a persistent, controllable Chrome browser with tools for real automation work, not just screenshots.

1. Browser control: open tabs, navigate, go back/forward, click, type, hover, press keys, drag and drop, and select dropdown options
2. Visual inspection: capture screenshots with numbered interactive markers, ARIA snapshots, and page element discovery
3. Data extraction: pull structured data from pages and read visible text or accessibility content
4. Form automation: fill forms by label and run multi-step browser actions in one request
5. Debugging tools: read console logs, run page JavaScript, inspect storage, inspect network traffic, and collect performance metrics
6. File and clipboard support: upload files, trigger downloads, and read or write clipboard text
7. Reliable waiting: wait for URL changes, text, elements, hidden elements, and network idle conditions
8. Recording and replay: record browser sessions and replay them later
9. Site memory: learn page objects and store reusable site knowledge for future runs
10. Collaboration tools: list sessions, claim tabs, hand off tabs, share state, and coordinate through locks
11. Event automation: automatically react to dialogs, beforeunload prompts, new tabs, and stuck network requests
12. Annotation workflow: save visual notes from the browser and review them later from MCP

## Why It Exists

Most browser MCPs stop at basic navigation.

MyBrowser is built for longer-running, practical workflows where an agent needs to keep a browser around, inspect state, coordinate across tabs, and recover from real browser behavior.

## Install

### 1. Install the MCP server

```bash
npm install -g @mybrowser/mcp
```

### 2. Start the server once

```bash
mybrowser-mcp --host 0.0.0.0 --port 9009
```

On first run, MyBrowser creates `~/.mybrowser/config.json` and stores the shared auth token there.

### 3. Download the Chrome extension

Download the Chrome extension zip from the latest GitHub Release.

Look for a file named like:

```text
mybrowser-extension-1.0.0-chrome.zip
```

### 4. Load the extension in Chrome

1. Unzip the downloaded file
2. Open `chrome://extensions`
3. Turn on **Developer mode**
4. Click **Load unpacked**
5. Select the unzipped extension folder

### 5. Connect the extension

Open the extension popup and enter:

1. Server address
2. Port
3. Auth token from `~/.mybrowser/config.json`
4. Optional browser name

## Important

MyBrowser will not work with only the npm package installed.

You need both:

1. The MCP server from npm
2. The Chrome extension from GitHub Releases

## What You Install

There are two install surfaces on purpose:

1. npm package: installs the MCP server binary `mybrowser-mcp`
2. GitHub Release zip: installs the Chrome extension that actually controls the browser

If you only install the npm package, the server starts but there is no browser connected.

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
