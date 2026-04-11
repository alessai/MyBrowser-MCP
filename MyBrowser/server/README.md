# @mybrowser/mcp

MCP server for MyBrowser browser automation.

Important: installing this npm package is only half of the setup. You also need the MyBrowser Chrome extension.

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

Then:

1. Unzip the extension
2. Open `chrome://extensions`
3. Enable **Developer mode**
4. Click **Load unpacked**
5. Select the unzipped folder
6. Enter the server address, port, and auth token in the extension popup

## Repository

GitHub: `https://github.com/alessai/MyBrowser-MCP`
