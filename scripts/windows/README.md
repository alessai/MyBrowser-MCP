# MyBrowser Windows Installer

Keep `install-mybrowser.cmd` and `install-mybrowser.ps1` in the same folder, then double-click `install-mybrowser.cmd`.

## Version 1.1.7

The CMD installer now configures same-device Windows installations automatically. It reads the MCP token and port from `%USERPROFILE%\.mybrowser\config.json`, uses `127.0.0.1`, and imports those settings when Chrome loads the extension. Version `1.1.6` required entering these values manually in the extension popup.

This behavior requires `install-mybrowser.cmd`. Installing the extension ZIP directly remains a manual setup path.

The installer:

1. Reads the latest stable GitHub release.
2. Downloads the Chrome extension ZIP.
3. Verifies its size and GitHub SHA-256 digest.
4. Rejects unsafe ZIP paths or unexpected manifests.
5. Reads `%USERPROFILE%\.mybrowser\config.json` when the MCP server is installed for the same Windows user.
6. Adds a localhost-only bootstrap without printing or copying the MCP token.
7. Installs to `%LOCALAPPDATA%\Alessai\MyBrowser\Extension`.
8. Opens `chrome://extensions` for the one-time **Load unpacked** approval.

Run the same CMD again to update. If Chrome is open, the installer waits up to five minutes for you to close it. It does not kill Chrome. The existing extension is replaced only after the new package passes validation, and a failed replacement restores the previous directory.

When double-clicked, the CMD window waits at the end so instructions and errors remain readable. Set `MYBROWSER_NO_PAUSE=1` for non-interactive use without arguments.

No administrator rights are required.

If the MCP config does not exist yet, start MyBrowser MCP once and rerun the installer, or configure the extension manually. When the local token, port, or machine name changes, rerun the CMD and the installer refreshes the configuration. The bootstrap always connects to `127.0.0.1`; it never publishes the token or sends it to GitHub.

The installed `mybrowser.local.json` contains the same local token as `%USERPROFILE%\.mybrowser\config.json`. It remains inside the current user's Local AppData directory; do not share the installed extension folder.

## Options

Pass PowerShell options through the CMD file:

```cmd
install-mybrowser.cmd -ChromeExitTimeoutSeconds 600
install-mybrowser.cmd -McpConfigPath C:\path\to\.mybrowser\config.json
install-mybrowser.cmd -Force
install-mybrowser.cmd -NoLaunch
```

`-Force` reinstalls the current release. It never downgrades a newer local version.

## Release packaging

The `Windows installer` GitHub Actions workflow tests Windows PowerShell 5.1, PowerShell 7, and the CMD entry point, then produces the `mybrowser-windows-installer` artifact. After that workflow passes, attach its ZIP to the matching release:

```powershell
gh run download <run-id> -n mybrowser-windows-installer -D dist
gh release upload v<version> dist/mybrowser-windows-installer.zip
```

Publish the release only after its extension ZIP exists and exposes a `sha256:` digest in the GitHub API.
