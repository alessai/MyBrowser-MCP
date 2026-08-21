[CmdletBinding()]
param(
    [string]$InstallDirectory,
    [ValidateRange(0, 3600)]
    [int]$ChromeExitTimeoutSeconds = 300,
    [string]$McpConfigPath,
    [switch]$NoLaunch,
    [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$script:ReleaseApiUrl = 'https://api.github.com/repos/alessai/MyBrowser-MCP/releases/latest'
$script:AssetPattern = '^mybrowser-extension-(?<version>[0-9]+\.[0-9]+\.[0-9]+(?:\.[0-9]+)?)-chrome\.zip$'
$script:MaxDownloadBytes = 50MB
$script:MaxExpandedBytes = 100MB
$script:MaxArchiveEntries = 1000
$script:MaxMcpConfigBytes = 16KB

function Get-MyBrowserProperty {
    param(
        [Parameter(Mandatory = $true)][object]$InputObject,
        [Parameter(Mandatory = $true)][string]$Name
    )

    $property = $InputObject.PSObject.Properties[$Name]
    if ($null -eq $property) {
        return $null
    }
    return $property.Value
}

function ConvertFrom-MyBrowserReleaseRecord {
    param([Parameter(Mandatory = $true)][object]$Release)

    if ((Get-MyBrowserProperty $Release 'draft') -or (Get-MyBrowserProperty $Release 'prerelease')) {
        throw 'GitHub returned a draft or prerelease instead of the latest stable release.'
    }

    $releaseAssets = Get-MyBrowserProperty $Release 'assets'
    if ($null -eq $releaseAssets) {
        throw 'The latest release has no assets.'
    }

    $assets = @($releaseAssets | Where-Object {
        (Get-MyBrowserProperty $_ 'name') -is [string] -and
            (Get-MyBrowserProperty $_ 'name') -cmatch $script:AssetPattern
    })
    if ($assets.Count -ne 1) {
        throw 'The latest release must contain exactly one MyBrowser Chrome extension ZIP.'
    }

    $asset = $assets[0]
    $assetName = [string](Get-MyBrowserProperty $asset 'name')
    $match = [regex]::Match($assetName, $script:AssetPattern)
    $version = $match.Groups['version'].Value
    $tagName = [string](Get-MyBrowserProperty $Release 'tag_name')
    if ($tagName -cne "v$version") {
        throw "Release tag '$tagName' does not match extension version '$version'."
    }

    $digest = [string](Get-MyBrowserProperty $asset 'digest')
    if ($digest -notmatch '^sha256:[0-9a-fA-F]{64}$') {
        throw 'The GitHub release asset has no valid SHA-256 digest.'
    }

    $sizeValue = Get-MyBrowserProperty $asset 'size'
    $size = if ($null -eq $sizeValue) { 0 } else { [long]$sizeValue }
    if ($size -le 0 -or $size -gt $script:MaxDownloadBytes) {
        throw "The release asset size '$size' is outside the accepted range."
    }

    $assetUrlValue = [string](Get-MyBrowserProperty $asset 'browser_download_url')
    if (-not [uri]::IsWellFormedUriString($assetUrlValue, [System.UriKind]::Absolute)) {
        throw 'The release asset URL is invalid.'
    }
    $assetUrl = [uri]$assetUrlValue
    if ($assetUrl.Scheme -ne 'https' -or $assetUrl.Host -ne 'github.com') {
        throw 'The release asset URL is not an expected GitHub HTTPS URL.'
    }

    [pscustomobject]@{
        Version = $version
        Name = $assetName
        Url = $assetUrl.AbsoluteUri
        Size = $size
        Sha256 = $digest.Substring(7).ToLowerInvariant()
    }
}

function Get-MyBrowserRelease {
    $headers = @{
        Accept = 'application/vnd.github+json'
        'User-Agent' = 'MyBrowser-Windows-Installer'
        'X-GitHub-Api-Version' = '2022-11-28'
    }
    if ($env:GITHUB_TOKEN) {
        $headers.Authorization = "Bearer $env:GITHUB_TOKEN"
    }

    try {
        $release = Invoke-RestMethod -Uri $script:ReleaseApiUrl -Headers $headers -TimeoutSec 30
    }
    catch {
        throw "Could not read the latest MyBrowser GitHub release: $($_.Exception.Message)"
    }
    return ConvertFrom-MyBrowserReleaseRecord $release
}

function Assert-MyBrowserDigest {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$ExpectedSha256,
        [long]$ExpectedSize = -1
    )

    $file = Get-Item -LiteralPath $Path
    if ($ExpectedSize -ge 0 -and $file.Length -ne $ExpectedSize) {
        throw "Downloaded size '$($file.Length)' does not match GitHub size '$ExpectedSize'."
    }

    $actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $ExpectedSha256.ToLowerInvariant()) {
        throw 'Downloaded extension SHA-256 does not match GitHub release metadata.'
    }
}

function Test-SafeArchiveEntry {
    param([Parameter(Mandatory = $true)][string]$Name)

    $normalized = $Name.Replace('\', '/')
    if ($normalized.StartsWith('/') -or $normalized.Contains(':')) {
        return $false
    }

    $parts = @($normalized.Split('/') | Where-Object { $_ -ne '' })
    if ($parts.Count -eq 0) {
        return $false
    }

    foreach ($part in $parts) {
        if ($part -eq '.' -or $part -eq '..') {
            return $false
        }
        if ($part.EndsWith('.') -or $part.EndsWith(' ') -or
            $part -match '^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)') {
            return $false
        }
    }

    return $true
}

function Expand-MyBrowserArchive {
    param(
        [Parameter(Mandatory = $true)][string]$ZipPath,
        [Parameter(Mandatory = $true)][string]$Destination,
        [Parameter(Mandatory = $true)][string]$ExpectedVersion
    )

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [System.IO.Compression.ZipFile]::OpenRead($ZipPath)
    try {
        if ($archive.Entries.Count -eq 0 -or $archive.Entries.Count -gt $script:MaxArchiveEntries) {
            throw "Extension archive contains an invalid number of entries: $($archive.Entries.Count)."
        }

        $paths = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
        [long]$expandedBytes = 0
        foreach ($entry in $archive.Entries) {
            if (-not (Test-SafeArchiveEntry -Name $entry.FullName)) {
                throw "Extension archive contains an unsafe path: '$($entry.FullName)'."
            }

            $normalized = $entry.FullName.Replace('\', '/').TrimEnd('/')
            if (-not $paths.Add($normalized)) {
                throw "Extension archive contains a duplicate path: '$normalized'."
            }

            $expandedBytes += [long]$entry.Length
            if ($expandedBytes -gt $script:MaxExpandedBytes) {
                throw 'Extension archive expands beyond the accepted size.'
            }
        }
    }
    finally {
        $archive.Dispose()
    }

    New-Item -ItemType Directory -Path $Destination | Out-Null
    Expand-Archive -LiteralPath $ZipPath -DestinationPath $Destination

    $manifestPath = Join-Path $Destination 'manifest.json'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        throw 'Extension archive has no root manifest.json.'
    }

    try {
        $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    }
    catch {
        throw "Extension manifest is invalid JSON: $($_.Exception.Message)"
    }

    $manifestName = [string](Get-MyBrowserProperty $manifest 'name')
    $manifestVersion = Get-MyBrowserProperty $manifest 'manifest_version'
    if ($manifestName -ne 'MyBrowser' -or [string]$manifestVersion -ne '3') {
        throw 'Extension manifest is not the expected MyBrowser Manifest V3 package.'
    }
    $extensionVersion = [string](Get-MyBrowserProperty $manifest 'version')
    if ($extensionVersion -ne $ExpectedVersion) {
        throw "Extension manifest version '$extensionVersion' does not match release '$ExpectedVersion'."
    }

    return $manifest
}

function Get-InstalledMyBrowserVersion {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        return $null
    }
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
        throw "Install path exists but is not a directory: '$Path'."
    }

    $directory = Get-Item -LiteralPath $Path
    if (($directory.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Refusing to manage a redirected install directory: '$Path'."
    }

    $manifestPath = Join-Path $Path 'manifest.json'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        throw "Refusing to replace '$Path' because it is not a MyBrowser extension directory."
    }

    try {
        $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    }
    catch {
        throw "Refusing to replace '$Path' because its manifest is invalid."
    }
    $manifestName = [string](Get-MyBrowserProperty $manifest 'name')
    $manifestVersion = Get-MyBrowserProperty $manifest 'manifest_version'
    if ($manifestName -ne 'MyBrowser' -or [string]$manifestVersion -ne '3') {
        throw "Refusing to replace '$Path' because it is not MyBrowser Manifest V3."
    }

    $version = [string](Get-MyBrowserProperty $manifest 'version')
    if ($version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+(?:\.[0-9]+)?$') {
        throw "Installed MyBrowser manifest has an invalid version: '$version'."
    }
    return $version
}

function Read-MyBrowserMcpConfig {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        return $null
    }
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "MCP config is not a regular file: '$Path'."
    }

    $file = Get-Item -LiteralPath $Path
    if (($file.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "MCP config must not be a redirected file: '$Path'."
    }
    if ($file.Length -le 0 -or $file.Length -gt $script:MaxMcpConfigBytes) {
        throw "MCP config size is outside the accepted range: '$Path'."
    }

    try {
        $config = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    }
    catch {
        throw "MCP config is invalid JSON: '$Path'."
    }

    $tokenValue = Get-MyBrowserProperty $config 'token'
    if (($tokenValue -isnot [string]) -or
        $tokenValue.Length -eq 0 -or
        $tokenValue.Length -gt 512 -or
        $tokenValue -match '[\x00-\x1f\x7f]') {
        throw "MCP config contains an invalid token: '$Path'."
    }

    $portValue = Get-MyBrowserProperty $config 'port'
    if ($null -eq $portValue -or $portValue -is [bool] -or $portValue -is [string]) {
        throw "MCP config contains an invalid port: '$Path'."
    }
    try {
        [decimal]$numericPort = $portValue
    }
    catch {
        throw "MCP config contains an invalid port: '$Path'."
    }
    if ($numericPort -ne [decimal]::Truncate($numericPort) -or $numericPort -lt 1 -or $numericPort -gt 65535) {
        throw "MCP config contains an invalid port: '$Path'."
    }

    [pscustomobject]@{
        Token = $tokenValue
        Port = [int]$numericPort
    }
}

function Write-MyBrowserBootstrap {
    param(
        [Parameter(Mandatory = $true)][string]$Directory,
        [Parameter(Mandatory = $true)][object]$Config,
        [Parameter(Mandatory = $true)][string]$BrowserName
    )

    if ($BrowserName.Length -eq 0 -or $BrowserName.Length -gt 128 -or $BrowserName -match '[\x00-\x1f\x7f]') {
        throw 'The Windows browser name is invalid.'
    }

    $bootstrap = [ordered]@{
        schemaVersion = 1
        bootstrapId = [Guid]::NewGuid().ToString('N')
        serverAddress = '127.0.0.1'
        serverPort = $Config.Port
        authToken = $Config.Token
        browserName = $BrowserName
    }
    $json = $bootstrap | ConvertTo-Json -Compress
    $path = Join-Path $Directory 'mybrowser.local.json'
    [System.IO.File]::WriteAllText($path, $json, (New-Object System.Text.UTF8Encoding($false)))
}

function Wait-ChromeExit {
    param([ValidateRange(0, 3600)][int]$TimeoutSeconds)

    if (-not (Get-Process -Name chrome -ErrorAction SilentlyContinue)) {
        return
    }

    Write-Output ''
    Write-Output 'Close every Google Chrome window, including Beta or Canary, to continue the update.'
    Write-Output 'MyBrowser will wait; it will not force-close Chrome.'
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while (Get-Process -Name chrome -ErrorAction SilentlyContinue) {
        if ([DateTime]::UtcNow -ge $deadline) {
            throw 'Chrome is still running. Exit Chrome, including background apps, and run the installer again.'
        }
        Start-Sleep -Milliseconds 500
    }
}

function Find-ChromeExecutable {
    $registryPaths = @(
        'Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe',
        'Registry::HKEY_LOCAL_MACHINE\Software\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe'
    )
    foreach ($registryPath in $registryPaths) {
        try {
            $candidate = (Get-ItemProperty -LiteralPath $registryPath -ErrorAction Stop).'(default)'
            if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
                return $candidate
            }
        }
        catch { continue }
    }

    $candidates = @(
        $(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe' }),
        $(if ($env:ProgramFiles) { Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe' }),
        $(if (${env:ProgramFiles(x86)}) { Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe' })
    ) | Where-Object { $_ }
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return $candidate
        }
    }
    return $null
}

function Install-MyBrowserDirectory {
    param(
        [Parameter(Mandatory = $true)][string]$StagedDirectory,
        [Parameter(Mandatory = $true)][string]$TargetDirectory
    )

    $backup = "$TargetDirectory.backup-$([Guid]::NewGuid().ToString('N'))"
    try {
        if (Test-Path -LiteralPath $TargetDirectory) {
            Move-Item -LiteralPath $TargetDirectory -Destination $backup
        }
        Move-Item -LiteralPath $StagedDirectory -Destination $TargetDirectory
    }
    catch {
        $failure = $_.Exception.Message
        if (-not (Test-Path -LiteralPath $TargetDirectory) -and (Test-Path -LiteralPath $backup)) {
            try {
                Move-Item -LiteralPath $backup -Destination $TargetDirectory
                throw "Could not replace the MyBrowser extension; the previous version was restored. $failure"
            }
            catch {
                if (Test-Path -LiteralPath $backup) {
                    throw "Could not replace or restore the MyBrowser extension. The previous version remains at '$backup'. $failure"
                }
                throw
            }
        }
        if (Test-Path -LiteralPath $backup) {
            throw "Could not replace the MyBrowser extension. The previous version remains at '$backup'. $failure"
        }
        throw "Could not install the MyBrowser extension. $failure"
    }

    if (Test-Path -LiteralPath $backup) {
        try {
            Remove-Item -LiteralPath $backup -Recurse -Force
        }
        catch {
            Write-Warning "The update succeeded, but the backup could not be removed: '$backup'."
        }
    }
}

function Invoke-MyBrowserInstaller {
    param(
        [string]$TargetDirectory,
        [string]$LocalMcpConfigPath,
        [int]$ExitTimeoutSeconds,
        [bool]$SkipLaunch,
        [bool]$Reinstall
    )

    if ($PSVersionTable.PSVersion -lt [version]'5.1') {
        throw 'MyBrowser requires Windows PowerShell 5.1 or PowerShell 7.'
    }
    if (-not $TargetDirectory) {
        if (-not $env:LOCALAPPDATA) {
            throw 'LOCALAPPDATA is unavailable; pass -InstallDirectory explicitly.'
        }
        $TargetDirectory = Join-Path $env:LOCALAPPDATA 'Alessai\MyBrowser\Extension'
    }
    $TargetDirectory = [System.IO.Path]::GetFullPath($TargetDirectory)

    if (-not $LocalMcpConfigPath -and $env:USERPROFILE) {
        $LocalMcpConfigPath = Join-Path $env:USERPROFILE '.mybrowser\config.json'
    }
    $mcpConfig = if ($LocalMcpConfigPath) {
        Read-MyBrowserMcpConfig -Path ([System.IO.Path]::GetFullPath($LocalMcpConfigPath))
    }
    else {
        $null
    }

    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $release = Get-MyBrowserRelease
    $installedVersion = Get-InstalledMyBrowserVersion -Path $TargetDirectory
    if ($installedVersion) {
        $installed = [version]$installedVersion
        $latest = [version]$release.Version
        if ($installed -gt $latest) {
            Write-Output "Installed MyBrowser $installedVersion is newer than GitHub $($release.Version); nothing changed."
            return
        }
        if ($installed -eq $latest -and -not $Reinstall) {
            Write-Output "MyBrowser $installedVersion is already up to date."
            if (-not $SkipLaunch) {
                $chrome = Find-ChromeExecutable
                if ($chrome) {
                    try { Start-Process -FilePath $chrome -ArgumentList 'chrome://extensions/' }
                    catch { Write-Warning 'MyBrowser is up to date, but Chrome could not be opened.' }
                }
            }
            return
        }
    }

    $parent = Split-Path -Parent $TargetDirectory
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    $lockPath = Join-Path $parent 'installer.lock'
    $lock = $null
    try {
        $lock = [System.IO.File]::Open($lockPath, 'OpenOrCreate', 'ReadWrite', 'None')
    }
    catch {
        throw 'Another MyBrowser installer is already running.'
    }

    $work = Join-Path ([System.IO.Path]::GetTempPath()) "mybrowser-$([Guid]::NewGuid().ToString('N'))"
    $zipPath = Join-Path $work $release.Name
    $stage = Join-Path $parent ".extension-stage-$([Guid]::NewGuid().ToString('N'))"
    try {
        New-Item -ItemType Directory -Path $work | Out-Null
        Write-Output "Downloading MyBrowser $($release.Version)..."
        Invoke-WebRequest -Uri $release.Url -OutFile $zipPath -UseBasicParsing -TimeoutSec 300 -Headers @{
            'User-Agent' = 'MyBrowser-Windows-Installer'
        }
        Assert-MyBrowserDigest -Path $zipPath -ExpectedSha256 $release.Sha256 -ExpectedSize $release.Size
        Expand-MyBrowserArchive -ZipPath $zipPath -Destination $stage -ExpectedVersion $release.Version | Out-Null
        if ($mcpConfig) {
            Write-MyBrowserBootstrap -Directory $stage -Config $mcpConfig -BrowserName ([Environment]::MachineName)
        }

        if ($installedVersion) {
            Wait-ChromeExit -TimeoutSeconds $ExitTimeoutSeconds
        }
        Install-MyBrowserDirectory -StagedDirectory $stage -TargetDirectory $TargetDirectory
        Write-Output "Installed MyBrowser $($release.Version) at:"
        Write-Output $TargetDirectory
        if ($mcpConfig) {
            Write-Output 'Configured MyBrowser for the local MCP server at 127.0.0.1.'
        }
        else {
            Write-Warning 'Local MCP config was not found; configure the extension token manually after loading it.'
        }

        if (-not $SkipLaunch) {
            $chrome = Find-ChromeExecutable
            if ($chrome) {
                $pathCopied = $false
                try {
                    Set-Clipboard -Value $TargetDirectory
                    $pathCopied = $true
                }
                catch { Write-Verbose 'Could not copy the install path to the clipboard.' }
                try {
                    Start-Process -FilePath $chrome -ArgumentList 'chrome://extensions/'
                    if (-not $installedVersion) {
                        Start-Process -FilePath 'explorer.exe' -ArgumentList "`"$TargetDirectory`""
                        Write-Output ''
                        Write-Output 'First install: enable Developer mode, click Load unpacked, and select the folder above.'
                        if ($pathCopied) {
                            Write-Output 'The folder path was copied to the clipboard.'
                        }
                    }
                }
                catch {
                    Write-Warning 'MyBrowser was installed, but Chrome or File Explorer could not be opened.'
                }
            }
            else {
                Write-Warning 'Chrome was not found. Open chrome://extensions manually.'
            }
        }
    }
    finally {
        if (Test-Path -LiteralPath $stage) {
            try { Remove-Item -LiteralPath $stage -Recurse -Force }
            catch { Write-Warning "Could not remove temporary directory '$stage'." }
        }
        if (Test-Path -LiteralPath $work) {
            try { Remove-Item -LiteralPath $work -Recurse -Force }
            catch { Write-Warning "Could not remove temporary directory '$work'." }
        }
        if ($lock) {
            $lock.Dispose()
        }
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    try {
        Invoke-MyBrowserInstaller `
            -TargetDirectory $InstallDirectory `
            -LocalMcpConfigPath $McpConfigPath `
            -ExitTimeoutSeconds $ChromeExitTimeoutSeconds `
            -SkipLaunch ([bool]$NoLaunch) `
            -Reinstall ([bool]$Force)
    }
    catch {
        [Console]::Error.WriteLine("ERROR: $($_.Exception.Message)")
        exit 1
    }
}
