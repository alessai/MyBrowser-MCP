Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. "$PSScriptRoot/install-mybrowser.ps1"

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

function Assert-Throw {
    param([scriptblock]$Action, [string]$Contains)
    try {
        & $Action
    }
    catch {
        if ($_.Exception.Message -notlike "*$Contains*") {
            throw "Expected error containing '$Contains', got '$($_.Exception.Message)'."
        }
        return
    }
    throw "Expected error containing '$Contains', but no error was thrown."
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
$root = Join-Path ([System.IO.Path]::GetTempPath()) "mybrowser-installer-test-$([Guid]::NewGuid().ToString('N'))"
try {
    New-Item -ItemType Directory -Path $root | Out-Null

    function Get-TestReleaseRecord {
        param(
            [string]$Tag = 'v1.2.3',
            [string]$Name = 'mybrowser-extension-1.2.3-chrome.zip',
            [string]$Digest = "sha256:$('a' * 64)",
            [long]$Size = 123,
            [string]$Url = 'https://github.com/alessai/MyBrowser-MCP/releases/download/v1.2.3/mybrowser-extension-1.2.3-chrome.zip',
            [bool]$Draft = $false,
            [bool]$Prerelease = $false
        )
        [pscustomobject]@{
            tag_name = $Tag
            draft = $Draft
            prerelease = $Prerelease
            assets = @([pscustomobject]@{
                name = $Name
                digest = $Digest
                size = $Size
                browser_download_url = $Url
            })
        }
    }

    $release = ConvertFrom-MyBrowserReleaseRecord (Get-TestReleaseRecord)
    Assert-True ($release.Version -eq '1.2.3') 'Valid release metadata was rejected.'
    Assert-Throw { ConvertFrom-MyBrowserReleaseRecord (Get-TestReleaseRecord -Draft $true) } 'draft or prerelease'
    Assert-Throw { ConvertFrom-MyBrowserReleaseRecord (Get-TestReleaseRecord -Prerelease $true) } 'draft or prerelease'
    Assert-Throw { ConvertFrom-MyBrowserReleaseRecord (Get-TestReleaseRecord -Tag 'v9.9.9') } 'does not match'
    Assert-Throw { ConvertFrom-MyBrowserReleaseRecord (Get-TestReleaseRecord -Digest '') } 'no valid SHA-256'
    Assert-Throw { ConvertFrom-MyBrowserReleaseRecord (Get-TestReleaseRecord -Size 0) } 'outside the accepted range'
    Assert-Throw { ConvertFrom-MyBrowserReleaseRecord (Get-TestReleaseRecord -Url 'http://github.com/file.zip') } 'not an expected GitHub HTTPS URL'
    Assert-Throw { ConvertFrom-MyBrowserReleaseRecord (Get-TestReleaseRecord -Name 'MYBROWSER-EXTENSION-1.2.3-CHROME.ZIP') } 'exactly one'
    $twoAssets = Get-TestReleaseRecord
    $twoAssets.assets += $twoAssets.assets[0]
    Assert-Throw { ConvertFrom-MyBrowserReleaseRecord $twoAssets } 'exactly one'

    foreach ($unsafePath in @(
        '/root.js',
        'C:\root.js',
        '..\escape.js',
        'a/../../escape.js',
        'file.js:stream',
        'CON',
        'assets/NUL.js',
        'assets/file.',
        'assets/file '
    )) {
        Assert-True (-not (Test-SafeArchiveEntry $unsafePath)) "Unsafe archive path was accepted: '$unsafePath'."
    }
    Assert-True (Test-SafeArchiveEntry 'assets/background.js') 'Safe archive path was rejected.'

    $source = Join-Path $root 'source'
    New-Item -ItemType Directory -Path $source | Out-Null
    '{"name":"MyBrowser","manifest_version":3,"version":"1.2.3"}' |
        Set-Content -LiteralPath (Join-Path $source 'manifest.json') -NoNewline
    'ok' | Set-Content -LiteralPath (Join-Path $source 'background.js') -NoNewline

    $validZip = Join-Path $root 'valid.zip'
    [System.IO.Compression.ZipFile]::CreateFromDirectory($source, $validZip)
    $digest = (Get-FileHash -LiteralPath $validZip -Algorithm SHA256).Hash.ToLowerInvariant()
    Assert-MyBrowserDigest -Path $validZip -ExpectedSha256 $digest -ExpectedSize (Get-Item $validZip).Length
    Assert-Throw { Assert-MyBrowserDigest -Path $validZip -ExpectedSha256 ('0' * 64) } 'SHA-256'

    $expanded = Join-Path $root 'expanded'
    $manifest = Expand-MyBrowserArchive -ZipPath $validZip -Destination $expanded -ExpectedVersion '1.2.3'
    Assert-True ([string]$manifest.name -eq 'MyBrowser') 'Valid extension did not expand.'
    Assert-Throw {
        Expand-MyBrowserArchive -ZipPath $validZip -Destination (Join-Path $root 'wrong-version') -ExpectedVersion '9.9.9'
    } 'does not match release'

    $unsafeZip = Join-Path $root 'unsafe.zip'
    $unsafe = [System.IO.Compression.ZipFile]::Open($unsafeZip, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
        $entry = $unsafe.CreateEntry('../escape.txt')
        $writer = New-Object System.IO.StreamWriter($entry.Open())
        try { $writer.Write('escape') } finally { $writer.Dispose() }
    }
    finally {
        $unsafe.Dispose()
    }
    Assert-Throw {
        Expand-MyBrowserArchive -ZipPath $unsafeZip -Destination (Join-Path $root 'unsafe') -ExpectedVersion '1.2.3'
    } 'unsafe path'

    $duplicateZip = Join-Path $root 'duplicate.zip'
    $duplicate = [System.IO.Compression.ZipFile]::Open($duplicateZip, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($name in @('manifest.json', 'assets/file.js', 'assets/FILE.js')) {
            $entry = $duplicate.CreateEntry($name)
            $writer = New-Object System.IO.StreamWriter($entry.Open())
            try {
                if ($name -eq 'manifest.json') {
                    $writer.Write('{"name":"MyBrowser","manifest_version":3,"version":"1.2.3"}')
                }
            }
            finally {
                $writer.Dispose()
            }
        }
    }
    finally {
        $duplicate.Dispose()
    }
    Assert-Throw {
        Expand-MyBrowserArchive -ZipPath $duplicateZip -Destination (Join-Path $root 'duplicate') -ExpectedVersion '1.2.3'
    } 'duplicate path'

    $target = Join-Path $root 'installed'
    $stageOne = Join-Path $root 'stage-one'
    Copy-Item -LiteralPath $source -Destination $stageOne -Recurse
    Install-MyBrowserDirectory -StagedDirectory $stageOne -TargetDirectory $target
    Assert-True ((Get-InstalledMyBrowserVersion -Path $target) -eq '1.2.3') 'First install failed.'

    $stageTwo = Join-Path $root 'stage-two'
    Copy-Item -LiteralPath $source -Destination $stageTwo -Recurse
    Install-MyBrowserDirectory -StagedDirectory $stageTwo -TargetDirectory $target
    Assert-True ((Get-InstalledMyBrowserVersion -Path $target) -eq '1.2.3') 'Update replacement failed.'
    Assert-True (@(Get-ChildItem -Path "$target.backup-*" -ErrorAction SilentlyContinue).Count -eq 0) 'Update left a backup behind.'

    Assert-Throw {
        Install-MyBrowserDirectory -StagedDirectory (Join-Path $root 'missing-stage') -TargetDirectory $target
    } 'previous version was restored'
    Assert-True ((Get-InstalledMyBrowserVersion -Path $target) -eq '1.2.3') 'Failed update did not restore the previous version.'

    $foreign = Join-Path $root 'foreign'
    New-Item -ItemType Directory -Path $foreign | Out-Null
    Assert-Throw { Get-InstalledMyBrowserVersion -Path $foreign } 'not a MyBrowser extension directory'

    $redirected = Join-Path $root 'redirected'
    $symlinkCreated = $false
    try {
        New-Item -ItemType SymbolicLink -Path $redirected -Target $target | Out-Null
        $symlinkCreated = $true
    }
    catch {
        Write-Output 'Symlink test skipped because this host cannot create one.'
    }
    if ($symlinkCreated) {
        Assert-Throw { Get-InstalledMyBrowserVersion -Path $redirected } 'redirected install directory'
    }

    $mcpConfigPath = Join-Path $root 'config.json'
    [System.IO.File]::WriteAllText(
        $mcpConfigPath,
        '{"token":"local-secret","host":"0.0.0.0","port":9010}',
        (New-Object System.Text.UTF8Encoding($false))
    )
    $mcpConfig = Read-MyBrowserMcpConfig -Path $mcpConfigPath
    Assert-True ($mcpConfig.Token -eq 'local-secret') 'MCP token was not read.'
    Assert-True ($mcpConfig.Port -eq 9010) 'MCP port was not read.'

    $bootstrapDirectory = Join-Path $root 'bootstrap'
    New-Item -ItemType Directory -Path $bootstrapDirectory | Out-Null
    Write-MyBrowserBootstrap -Directory $bootstrapDirectory -Config $mcpConfig -BrowserName 'MAINPC'
    $bootstrap = Get-Content -LiteralPath (Join-Path $bootstrapDirectory 'mybrowser.local.json') -Raw | ConvertFrom-Json
    Assert-True ($bootstrap.schemaVersion -eq 1) 'Bootstrap schema version is invalid.'
    Assert-True ($bootstrap.bootstrapId -match '^[0-9a-f]{32}$') 'Bootstrap identifier is invalid.'
    Assert-True ($bootstrap.serverAddress -eq '127.0.0.1') 'Bootstrap must use localhost.'
    Assert-True ($bootstrap.serverPort -eq 9010) 'Bootstrap port is invalid.'
    Assert-True ($bootstrap.authToken -eq 'local-secret') 'Bootstrap token is invalid.'
    Assert-True ($bootstrap.browserName -eq 'MAINPC') 'Bootstrap browser name is invalid.'

    Assert-True ($null -eq (Read-MyBrowserMcpConfig -Path (Join-Path $root 'missing-config.json'))) 'Missing MCP config must be optional.'

    $oversizedConfigPath = Join-Path $root 'oversized-config.json'
    [System.IO.File]::WriteAllText($oversizedConfigPath, ('a' * 16385), (New-Object System.Text.UTF8Encoding($false)))
    Assert-Throw { Read-MyBrowserMcpConfig -Path $oversizedConfigPath } 'MCP config size'

    $redirectedConfigPath = Join-Path $root 'redirected-config.json'
    $configSymlinkCreated = $false
    try {
        New-Item -ItemType SymbolicLink -Path $redirectedConfigPath -Target $mcpConfigPath | Out-Null
        $configSymlinkCreated = $true
    }
    catch {
        Write-Output 'MCP config symlink test skipped because this host cannot create one.'
    }
    if ($configSymlinkCreated) {
        Assert-Throw { Read-MyBrowserMcpConfig -Path $redirectedConfigPath } 'redirected file'
    }

    foreach ($invalidConfig in @(
        '{"token":"","port":9009}',
        '{"token":"secret\nvalue","port":9009}',
        ('{"token":"' + ('a' * 513) + '","port":9009}'),
        '{"token":"secret","port":0}',
        '{"token":"secret","port":65536}',
        '{"token":"secret","port":9009.5}',
        '{"token":"secret"}',
        'not-json'
    )) {
        $invalidPath = Join-Path $root ("invalid-config-$([Guid]::NewGuid().ToString('N')).json")
        [System.IO.File]::WriteAllText($invalidPath, $invalidConfig, (New-Object System.Text.UTF8Encoding($false)))
        Assert-Throw { Read-MyBrowserMcpConfig -Path $invalidPath } 'MCP config'
    }

    Assert-Throw {
        Write-MyBrowserBootstrap -Directory $bootstrapDirectory -Config $mcpConfig -BrowserName "MAIN`nPC"
    } 'browser name'

    Write-Output 'Windows installer tests passed.'
}
finally {
    if (Test-Path -LiteralPath $root) {
        Remove-Item -LiteralPath $root -Recurse -Force
    }
}
