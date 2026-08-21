# MyBrowser Windows Installer

Keep `install-mybrowser.cmd` and `install-mybrowser.ps1` in the same folder, then double-click `install-mybrowser.cmd`.

The installer:

1. Reads the latest stable GitHub release.
2. Downloads the Chrome extension ZIP.
3. Verifies its size and GitHub SHA-256 digest.
4. Rejects unsafe ZIP paths or unexpected manifests.
5. Installs to `%LOCALAPPDATA%\Alessai\MyBrowser\Extension`.
6. Opens `chrome://extensions` for the one-time **Load unpacked** approval.

Run the same CMD again to update. If Chrome is open, the installer waits up to five minutes for you to close it. It does not kill Chrome. The existing extension is replaced only after the new package passes validation, and a failed replacement restores the previous directory.

No administrator rights are required.

## Options

Pass PowerShell options through the CMD file:

```cmd
install-mybrowser.cmd -ChromeExitTimeoutSeconds 600
install-mybrowser.cmd -Force
install-mybrowser.cmd -NoLaunch
```

`-Force` reinstalls the current release. It never downgrades a newer local version.
