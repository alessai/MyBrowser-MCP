# MyBrowser MCP

MyBrowser is a two-part browser automation setup for MCP:

1. The MCP server
2. The Chrome extension

`npm` installs only the MCP server. You still need to download and load the Chrome extension.

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
