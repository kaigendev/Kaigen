#requires -Version 7.6.4
[CmdletBinding()]
param(
    [string]$ArtifactsDir,
    [string]$GitRevision
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$utf8NoBom = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $utf8NoBom
$OutputEncoding = $utf8NoBom
if ($PSVersionTable.PSVersion.ToString() -cne "7.6.4") {
    throw "Kaigen automation requires PowerShell 7.6.4 exactly; found $($PSVersionTable.PSVersion)."
}
$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
if ([string]::IsNullOrWhiteSpace($ArtifactsDir)) {
    $ArtifactsDir = Join-Path $ProjectRoot "artifacts"
} else {
    $ArtifactsDir = [IO.Path]::GetFullPath($ArtifactsDir)
}
[IO.Directory]::CreateDirectory($ArtifactsDir) | Out-Null

function Test-PathWithinBase {
    param([Parameter(Mandatory)][string]$Base, [Parameter(Mandatory)][string]$Path)

    $relative = [IO.Path]::GetRelativePath($Base, $Path)
    if ([IO.Path]::IsPathRooted($relative) -or $relative -eq '.' -or $relative -eq '..') {
        return $false
    }
    foreach ($separator in @([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) | Select-Object -Unique) {
        if ($relative.StartsWith("..$separator", [StringComparison]::Ordinal)) {
            return $false
        }
    }
    return $true
}

function Resolve-KaigenNativeCommand {
    param([Parameter(Mandatory)][string[]]$Names)

    foreach ($name in $Names) {
        $command = Get-Command -Name $name -CommandType Application -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if ($null -ne $command) {
            return [IO.Path]::GetFullPath([string]$command.Source)
        }
    }
    throw "Required native command was not found: $($Names -join ', ')"
}

$zipPath = [IO.Path]::GetFullPath((Join-Path $ArtifactsDir "Kaigen-source-github.zip"))
if (-not (Test-PathWithinBase -Base $ArtifactsDir -Path $zipPath)) {
    throw "Refusing to create the source archive outside artifacts: $zipPath"
}

$gitCommand = Resolve-KaigenNativeCommand -Names @('git.exe', 'git')

$gitSafeProjectRoot = $ProjectRoot.Replace('\', '/')
$gitBaseArguments = @(
    '-c', "safe.directory=$gitSafeProjectRoot",
    '-c', 'core.safecrlf=false',
    '-C', $ProjectRoot
)

function Invoke-GitLines {
    param([Parameter(Mandatory)][string[]]$ArgumentList)

    $output = @(& $gitCommand @gitBaseArguments @ArgumentList)
    if ($LASTEXITCODE -ne 0) {
        throw "git failed while creating the source archive: $($ArgumentList -join ' ')"
    }
    return $output
}

function Test-PublicUntrackedPath {
    param([Parameter(Mandatory)][string]$RelativePath)

    $normalizedPath = $RelativePath.Replace('\', '/')
    if ($normalizedPath -match '^(?:\.github/workflows|cmake|docs|icons|runtime-manifests|scripts|src|src-tauri|web)/[^/].*$') {
        return $true
    }
    return $normalizedPath -match '^(?:\.gitattributes|\.gitignore|BUILDING(?:-PLATFORMS)?\.md|LICENSE(?:\.[A-Za-z0-9._-]+)?|README\.md|package(?:-lock)?\.json|tsconfig(?:\.[A-Za-z0-9._-]+)?\.json|vite\.config\.[cm]?[jt]s)$'
}

if ([string]::IsNullOrWhiteSpace($GitRevision)) {
    $untrackedPaths = @(Invoke-GitLines -ArgumentList @('ls-files', '--others', '--exclude-standard'))
    foreach ($untrackedPath in $untrackedPaths) {
        if (-not (Test-PublicUntrackedPath -RelativePath $untrackedPath)) {
            throw "An untracked path is outside the public source allowlist: $untrackedPath"
        }
    }

    $temporaryIndexParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd(
        [char[]]@([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
    )
    $temporaryIndex = [IO.Path]::Combine($temporaryIndexParent, "kaigen-source-$([IO.Path]::GetRandomFileName()).index")
    if ([IO.Path]::GetDirectoryName($temporaryIndex) -cne $temporaryIndexParent -or
        [IO.Path]::GetFileName($temporaryIndex) -notmatch '^kaigen-source-[A-Za-z0-9.]+[.]index$') {
        throw "Refusing an unsafe temporary Git index path: $temporaryIndex"
    }
    $previousGitIndexPresent = Test-Path -LiteralPath 'Env:\GIT_INDEX_FILE'
    $previousGitIndexFile = if ($previousGitIndexPresent) { $env:GIT_INDEX_FILE } else { $null }
    try {
        $env:GIT_INDEX_FILE = $temporaryIndex
        Invoke-GitLines -ArgumentList @('read-tree', 'HEAD') | Out-Null
        Invoke-GitLines -ArgumentList @('add', '-A', '--', '.') | Out-Null
        $sourceRelativePaths = @(Invoke-GitLines -ArgumentList @('ls-files', '--cached'))
        $treeLines = @(Invoke-GitLines -ArgumentList @('write-tree'))
        $treeish = if ($treeLines.Count -eq 1) { [string]$treeLines[0] } else { '' }
    } finally {
        if ($previousGitIndexPresent) {
            $env:GIT_INDEX_FILE = $previousGitIndexFile
        } else {
            Remove-Item -LiteralPath 'Env:\GIT_INDEX_FILE' -ErrorAction SilentlyContinue
        }
        if (Test-Path -LiteralPath $temporaryIndex -PathType Leaf) {
            [IO.File]::Delete($temporaryIndex)
        }
    }
    if ([string]::IsNullOrWhiteSpace($treeish) -or $treeish -notmatch '^[a-f0-9]{40,64}$') {
        throw "git write-tree failed; the source archive requires a valid working-tree snapshot."
    }
    $treeish = $treeish.Trim()
    $treeDescription = "working-tree snapshot $treeish"
} else {
    $treeLines = @(Invoke-GitLines -ArgumentList @('rev-parse', '--verify', "$GitRevision`^{tree}"))
    $treeish = if ($treeLines.Count -eq 1) { [string]$treeLines[0] } else { '' }
    if ([string]::IsNullOrWhiteSpace($treeish)) {
        throw "Git revision does not resolve to a tree: $GitRevision"
    }
    $treeish = $treeish.Trim()
    $sourceRelativePaths = @(Invoke-GitLines -ArgumentList @('ls-tree', '-r', '--name-only', $treeish))
    $treeDescription = "revision $GitRevision (tree $treeish)"
}

$localOnlyPaths = @(
    "AGENTS.md",
    "docs/CHAT-BEHAVIOR.md",
    "docs/TESTING.md",
    "docs/TEST-BASELINE.md"
)
$localOnlyPrefixes = @("continuation.local/", "context.local/")
$localSecretFileNames = @("kaigen_vm_ed25519")
foreach ($relativePath in $sourceRelativePaths) {
    $normalizedPath = $relativePath.Replace('\', '/')
    $leafName = [IO.Path]::GetFileName($normalizedPath)
    $isLocalOnly = ($localOnlyPaths -contains $normalizedPath) -or
        ($localSecretFileNames -contains $leafName) -or
        $leafName.StartsWith("credentials.local.", [StringComparison]::OrdinalIgnoreCase) -or
        $leafName.EndsWith(".credential.xml", [StringComparison]::OrdinalIgnoreCase)
    foreach ($prefix in $localOnlyPrefixes) {
        if ($normalizedPath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
            $isLocalOnly = $true
            break
        }
    }
    if ($isLocalOnly) { throw "A local or private path was selected for the public source archive: $relativePath" }
}

if (Test-Path -LiteralPath $zipPath) { [IO.File]::Delete($zipPath) }
& $gitCommand @gitBaseArguments archive --format=zip "--output=$zipPath" $treeish
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $zipPath -PathType Leaf)) {
    throw "git archive failed for $treeDescription."
}
$sha256 = [Security.Cryptography.SHA256]::Create()
$zipStream = [IO.File]::OpenRead($zipPath)
try {
    $zipHash = [BitConverter]::ToString($sha256.ComputeHash($zipStream)).Replace("-", "")
} finally {
    $zipStream.Dispose()
    $sha256.Dispose()
}
Write-Host "Source archive: $zipPath"
Write-Host "Source tree: $treeDescription"
Write-Host "SHA-256: $zipHash"
