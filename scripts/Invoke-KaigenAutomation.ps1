#requires -Version 7.6.5
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateSet(
        'automation-tests',
        'frontend-tests',
        'web-gates',
        'web-installer-tests',
        'web-installer-bundle',
        'windows-portable',
        'debian-build',
        'macos-build',
        'source-archive',
        'ci-windows-prime'
    )]
    [string]$Task,
    [string]$ComponentCacheRoot = $env:KAIGEN_COMPONENT_CACHE_ROOT,
    [string]$ArtifactsDir,
    [string]$ReleaseLabel,
    [switch]$UiAcceptance
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$utf8NoBom = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $utf8NoBom
$OutputEncoding = $utf8NoBom
if ($PSVersionTable.PSVersion.ToString() -cne '7.6.5') {
    throw "Kaigen automation requires PowerShell 7.6.5 exactly; found $($PSVersionTable.PSVersion)."
}

$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if ([IO.Path]::GetFullPath((Get-Location).Path) -cne $projectRoot) {
    throw "Run Kaigen automation from the canonical source root: $projectRoot"
}

function Resolve-KaigenNativeCommand {
    param([Parameter(Mandatory)][string]$Name)

    $command = Get-Command -Name $Name -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($null -eq $command) {
        throw "Required native command was not found: $Name"
    }
    return [IO.Path]::GetFullPath([string]$command.Source)
}

function Invoke-KaigenNativeCommand {
    param(
        [Parameter(Mandatory)][string]$FilePath,
        [Parameter()][string[]]$ArgumentList = @()
    )

    & $FilePath @ArgumentList
    if ($LASTEXITCODE -ne 0) {
        throw "Native command failed with exit code ${LASTEXITCODE}: $FilePath"
    }
}

function Invoke-KaigenNpm {
    param([Parameter(Mandatory)][string[]]$ArgumentList)

    $npmName = if ($IsWindows) { 'npm.cmd' } else { 'npm' }
    $npm = Resolve-KaigenNativeCommand -Name $npmName
    Invoke-KaigenNativeCommand -FilePath $npm -ArgumentList $ArgumentList
}

function Invoke-KaigenNode {
    param([Parameter(Mandatory)][string[]]$ArgumentList)

    $node = Resolve-KaigenNativeCommand -Name $(if ($IsWindows) { 'node.exe' } else { 'node' })
    Invoke-KaigenNativeCommand -FilePath $node -ArgumentList $ArgumentList
}

switch ($Task) {
    'automation-tests' {
        Invoke-KaigenNode -ArgumentList @('scripts/test-build-pipeline.mjs')
        Invoke-KaigenNode -ArgumentList @('scripts/test-source-archive-privacy.mjs')
    }
    'frontend-tests' {
        Invoke-KaigenNpm -ArgumentList @('run', 'test:frontend')
    }
    'web-gates' {
        Invoke-KaigenNpm -ArgumentList @('run', 'build')
        Invoke-KaigenNpm -ArgumentList @('run', 'build:web')
        Invoke-KaigenNpm -ArgumentList @('run', 'test:built-content-security')
        Invoke-KaigenNpm -ArgumentList @('run', 'test:browser-runtime')
        Invoke-KaigenNpm -ArgumentList @('run', 'test:product-boundaries')
        Invoke-KaigenNpm -ArgumentList @('run', 'test:product-bundles')
    }
    'web-installer-tests' {
        Invoke-KaigenNode -ArgumentList @('scripts/test-web-installer.mjs')
    }
    'web-installer-bundle' {
        if ($IsWindows -or $IsMacOS) { throw 'web-installer-bundle must run on Debian 13.' }
        if ([string]::IsNullOrWhiteSpace($ReleaseLabel)) { throw 'web-installer-bundle requires ReleaseLabel.' }
        Invoke-KaigenNpm -ArgumentList @('run', 'build:web')
        $cargo = Resolve-KaigenNativeCommand -Name 'cargo'
        Invoke-KaigenNativeCommand -FilePath $cargo -ArgumentList @(
            'build', '--release', '--locked', '--manifest-path',
            (Join-Path $projectRoot 'web/kaigen-webd/Cargo.toml')
        )
        $arguments = @{ ReleaseLabel = $ReleaseLabel }
        if (-not [string]::IsNullOrWhiteSpace($ArtifactsDir)) { $arguments.ArtifactsDir = $ArtifactsDir }
        & (Join-Path $PSScriptRoot 'build-web-installer.ps1') @arguments
    }
    'windows-portable' {
        if (-not $IsWindows) { throw 'windows-portable must run on Windows.' }
        $arguments = @{}
        if (-not [string]::IsNullOrWhiteSpace($ComponentCacheRoot)) { $arguments.ComponentCacheRoot = $ComponentCacheRoot }
        if (-not [string]::IsNullOrWhiteSpace($ArtifactsDir)) { $arguments.ArtifactsDir = $ArtifactsDir }
        if ($UiAcceptance) { $arguments.UiAcceptance = $true }
        & (Join-Path $PSScriptRoot 'build-portable.ps1') @arguments
    }
    'debian-build' {
        if ($IsWindows -or $IsMacOS) { throw 'debian-build must run inside the Debian build environment.' }
        $bash = Resolve-KaigenNativeCommand -Name 'bash'
        Invoke-KaigenNativeCommand -FilePath $bash -ArgumentList @((Join-Path $PSScriptRoot 'build-appimage.sh'))
    }
    'macos-build' {
        if (-not $IsMacOS) { throw 'macos-build must run inside the macOS build environment.' }
        $bash = Resolve-KaigenNativeCommand -Name 'bash'
        Invoke-KaigenNativeCommand -FilePath $bash -ArgumentList @((Join-Path $PSScriptRoot 'build-macos.sh'))
    }
    'source-archive' {
        $arguments = @{}
        if (-not [string]::IsNullOrWhiteSpace($ArtifactsDir)) { $arguments.ArtifactsDir = $ArtifactsDir }
        & (Join-Path $PSScriptRoot 'build-source-archive.ps1') @arguments
    }
    'ci-windows-prime' {
        if (-not $IsWindows) { throw 'ci-windows-prime must run on Windows.' }
        if ($env:GITHUB_ACTIONS -cne 'true') { throw 'ci-windows-prime is restricted to GitHub Actions.' }
        if ($env:KAIGEN_COMPONENT_UPDATE_SCOPE -cne 'all-managed-components') {
            throw 'ci-windows-prime requires the step-scoped all-managed-components marker.'
        }
        if ([string]::IsNullOrWhiteSpace($ComponentCacheRoot)) {
            throw 'ci-windows-prime requires an explicit component cache root.'
        }
        & (Join-Path $PSScriptRoot 'prepare-dependencies.ps1') `
            -ComponentCacheRoot $ComponentCacheRoot `
            -AllowNetworkComponentFetch
        Invoke-KaigenNpm -ArgumentList @('ci')
        $cargo = Resolve-KaigenNativeCommand -Name 'cargo.exe'
        Invoke-KaigenNativeCommand -FilePath $cargo -ArgumentList @(
            'fetch',
            '--locked',
            '--manifest-path',
            (Join-Path $projectRoot 'src-tauri/Cargo.toml')
        )
    }
}
