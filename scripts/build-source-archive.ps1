#requires -Version 7.6.5
[CmdletBinding()]
param(
    [string]$ArtifactsDir,
    [string]$GitRevision,
    [switch]$ValidateOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $false
$utf8NoBom = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $utf8NoBom
$OutputEncoding = $utf8NoBom
if ($PSVersionTable.PSVersion.ToString() -cne "7.6.5") {
    throw "Kaigen automation requires PowerShell 7.6.5 exactly; found $($PSVersionTable.PSVersion)."
}
$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
if ([string]::IsNullOrWhiteSpace($ArtifactsDir)) {
    $ArtifactsDir = Join-Path $ProjectRoot "artifacts"
} else {
    $ArtifactsDir = [IO.Path]::GetFullPath($ArtifactsDir)
}

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

$operationId = [Guid]::NewGuid().ToString('N')
$diagnosticsDir = Join-Path $ArtifactsDir 'source-archive-diagnostics'
[IO.Directory]::CreateDirectory($diagnosticsDir) | Out-Null
$diagnosticsPath = Join-Path $diagnosticsDir "$operationId.json"
$diagnostics = [ordered]@{
    schemaVersion = 1
    kind = 'kaigen-source-archive-preparation'
    operationId = $operationId
    mode = if ($ValidateOnly) { 'validation' } else { 'packaging' }
    status = 'RUNNING'
    sourceRoot = $ProjectRoot
    requestedRevision = $GitRevision
    tree = $null
    archive = $null
    operations = [Collections.Generic.List[object]]::new()
    startedAtUtc = [DateTime]::UtcNow.ToString('o')
}
$candidatePath = Join-Path $ArtifactsDir ".kaigen-source-$operationId.zip"

function Save-ArchiveDiagnostics {
    [IO.File]::WriteAllText($diagnosticsPath, ($diagnostics | ConvertTo-Json -Depth 8), $utf8NoBom)
}
Save-ArchiveDiagnostics

function Invoke-GitLines {
    param([Parameter(Mandatory)][string[]]$ArgumentList, [string]$StandardInput, [switch]$Raw)

    $startInfo = [Diagnostics.ProcessStartInfo]::new($gitCommand)
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.RedirectStandardInput = $PSBoundParameters.ContainsKey('StandardInput')
    $startInfo.StandardOutputEncoding = $utf8NoBom
    $startInfo.StandardErrorEncoding = $utf8NoBom
    if ($startInfo.RedirectStandardInput) { $startInfo.StandardInputEncoding = $utf8NoBom }
    foreach ($argument in @($gitBaseArguments) + @($ArgumentList)) {
        $startInfo.ArgumentList.Add($argument)
    }
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    $record = [ordered]@{ phase = $ArgumentList[0]; arguments = $ArgumentList; nativeExitCode = $null; stdout = ''; stderr = ''; status = 'STARTING' }
    try {
        if (-not $process.Start()) { throw 'Git process did not start.' }
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        if ($startInfo.RedirectStandardInput) {
            $process.StandardInput.Write($StandardInput)
            $process.StandardInput.Close()
        }
        $process.WaitForExit()
        $record.nativeExitCode = $process.ExitCode
        $record.stdout = $stdoutTask.GetAwaiter().GetResult()
        $record.stderr = $stderrTask.GetAwaiter().GetResult()
        $record.status = if ($record.nativeExitCode -eq 0) { 'COMPLETE' } else { 'FAILED' }
    } catch {
        $record.status = 'FAILED'
        $record.failure = $_.Exception.Message
        throw
    } finally {
        $diagnostics.operations.Add($record)
        Save-ArchiveDiagnostics
        $process.Dispose()
    }
    if ($record.nativeExitCode -ne 0) {
        throw "git $($record.phase) failed with exit $($record.nativeExitCode); original stdout/stderr: $diagnosticsPath"
    }
    if ($Raw) { return $record.stdout }
    if ($record.stdout.Length) { return $record.stdout.TrimEnd("`r", "`n") -split '\r?\n' }
}

# Existing local Cargo outputs are preserved on disk and excluded only from
# this producer's temporary source snapshot. These are exact repository paths.
$generatedCargoOutputRoots = @(
    'toxcore-rust/target', 'toxcore-rust-os/target',
    'toxcore-rust-sodium/target', 'toxcore-rust-system/target'
)

function Test-GeneratedCargoOutputPath {
    param([Parameter(Mandatory)][string]$RelativePath)

    $normalizedPath = $RelativePath.Replace('\', '/')
    foreach ($root in $generatedCargoOutputRoots) {
        if ($normalizedPath.StartsWith("$root/", [StringComparison]::Ordinal)) { return $true }
    }
    return $false
}

function Test-PublicUntrackedPath {
    param([Parameter(Mandatory)][string]$RelativePath)

    $normalizedPath = $RelativePath.Replace('\', '/')
    # Exact public source inputs for the managed component update; local service files remain excluded.
    if (@(
        'patches/windows-core-0100/manifest.json',
        'patches/windows-core-0100/README.md',
        'patches/conjure/manifest.json',
        'patches/lyrebird/pion-4.2.23-dtls-3.1.12.patch',
        'patches/conjure/utls-1.8.2-snowflake-2.15.1.patch',
        'patches/snowflake-2.15.1-transport-v5/manifest.json',
        'patches/snowflake-2.15.1-transport-v5/transport-v5.patch',
        'patches/lyrebird/manifest.json',
        'patches/lyrebird/snowflake-2.15.1.patch',
        'patches/sqlcipher/manifest.json',
        'patches/sqlcipher/sqlite-3.54.0.patch',
        'patches/sqlcipher/README.md',
        'runtime/qtox-import/provenance.json',
        'patches/tauri-cli/manifest.json',
        'patches/tauri-cli/Cargo.lock',
        'patches/tauri-cli/bundler-2.10.3.patch',
        'scripts/prepare-managed-tauri-cli.mjs',
        'runtime-manifests/vendor-inputs/kaigen-tauri-cli-2.12.3-bundler-2.10.3-inputs-2dcdb419c0bc.part01',
        'runtime-manifests/vendor-inputs/kaigen-tauri-cli-2.12.3-bundler-2.10.3-inputs-2dcdb419c0bc.part02',
        'runtime-manifests/vendor-inputs/tauri-cli-2.12.3.crate'
    ) -ccontains $normalizedPath) {
        return $true
    }
    if (@(
        'public/kaigen-notifications-sw.js', 'public/manifest.webmanifest',
        'public/kaigen-icon-192.png', 'public/kaigen-icon-512.png',
        'public/manifest-webkit.webmanifest', 'public/kaigen-brand-93740b25.webp',
        'public/kaigen-ring.ico', 'public/kaigen-ring-192.png',
        'public/kaigen-ring-512.png', 'public/kaigen-apple-touch.png'
    ) -ccontains $normalizedPath) {
        return $true
    }
    if ($normalizedPath -match '^(?:\.github/workflows|cmake|docs|icons|runtime-manifests|scripts|src|src-tauri|web)/[^/].*$') {
        return $true
    }
    return $normalizedPath -match '^(?:\.gitattributes|\.gitignore|BUILDING(?:-PLATFORMS)?\.md|LICENSE(?:\.[A-Za-z0-9._-]+)?|README\.md|package(?:-lock)?\.json|tsconfig(?:\.[A-Za-z0-9._-]+)?\.json|vite\.config\.[cm]?[jt]s)$'
}

function Get-ExportIgnoredOpenSpecPaths {
    param([string[]]$RelativePaths, [switch]$Cached)

    $candidates = @($RelativePaths | Where-Object { $_.Replace('\', '/').StartsWith('openspec/', [StringComparison]::Ordinal) })
    if (-not $candidates.Count) { return }
    # stdin avoids Windows argv limits; one exact-path batch replaces a process per local document.
    $attributeArguments = @('check-attr', '-z', '--stdin')
    if ($Cached) { $attributeArguments += '--cached' }
    $attributeArguments += 'export-ignore'
    $attributeOutput = Invoke-GitLines -ArgumentList $attributeArguments -StandardInput (($candidates -join "`0") + "`0") -Raw
    $fields = $attributeOutput.Split([char]0)
    if ($fields.Count -ne ($candidates.Count * 3 + 1)) { throw 'Incomplete export-ignore attribute response.' }
    for ($index = 0; $index -lt $candidates.Count; $index++) {
        $offset = $index * 3
        if ($fields[$offset] -cne $candidates[$index] -or $fields[$offset + 1] -cne 'export-ignore') {
            throw 'Export-ignore attribute response differs from the selected exact paths.'
        }
        if ($fields[$offset + 2] -ceq 'set') { $candidates[$index] }
    }
}

try {
if ([string]::IsNullOrWhiteSpace($GitRevision)) {
    $untrackedPaths = @(Invoke-GitLines -ArgumentList @('ls-files', '--others', '--exclude-standard'))
    $generatedUntrackedPaths = @($untrackedPaths | Where-Object { Test-GeneratedCargoOutputPath -RelativePath $_ })
    $diagnostics.generatedCargoOutputs = [ordered]@{
        excludedRoots = $generatedCargoOutputRoots
        excludedUntrackedCount = $generatedUntrackedPaths.Count
        workingTreePreserved = $true
    }
    $localOpenSpecPaths = @(Get-ExportIgnoredOpenSpecPaths -RelativePaths $untrackedPaths)
    foreach ($untrackedPath in $untrackedPaths) {
        if (Test-GeneratedCargoOutputPath -RelativePath $untrackedPath) { continue }
        if ($localOpenSpecPaths -ccontains $untrackedPath) { continue }
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
        Invoke-GitLines -ArgumentList (@('rm', '-r', '--cached', '--ignore-unmatch', '--') + $generatedCargoOutputRoots) | Out-Null
        $snapshotArguments = @('add', '-A', '--', '.') + @($generatedCargoOutputRoots | ForEach-Object { ":(top,exclude,literal)$_" })
        Invoke-GitLines -ArgumentList $snapshotArguments | Out-Null
        $cachedIgnoredPaths = @(Get-ExportIgnoredOpenSpecPaths -RelativePaths $localOpenSpecPaths -Cached)
        foreach ($localOpenSpecPath in $localOpenSpecPaths) {
            if ($cachedIgnoredPaths -cnotcontains $localOpenSpecPath) {
                throw "A local OpenSpec path is not export-ignored in the source snapshot: $localOpenSpecPath"
            }
        }
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
$localOnlyPrefixes = @(
    'continuation.local/', 'context.local/', 'openspec/', 'ci/releases/evidence/', 'site-release/',
    'outputs/', 'artifacts/', 'work/', 'profiles/', 'runtime/', 'cache/', '.cache/',
    'node_modules/', 'dist/', 'dist-web/', 'target/', 'src-tauri/target/', 'web/kaigen-webd/target/', '.git/'
) + @($generatedCargoOutputRoots | ForEach-Object { "$_/" })
# Exact tracked product inputs: dictionary licenses/data and the documented SQLCipher import runtime.
# Structural ZIP directory entries are allowed only for these inputs' ancestors; no runtime prefix is public.
$managedPublicRuntimePaths = @(
    'runtime/', 'runtime/dictionaries/', 'runtime/qtox-import/',
    'runtime/dictionaries/LICENSE-en.txt', 'runtime/dictionaries/LICENSE-ru.txt',
    'runtime/dictionaries/en-US.aff', 'runtime/dictionaries/en-US.dic',
    'runtime/dictionaries/ru-RU.aff', 'runtime/dictionaries/ru-RU.dic',
    'runtime/qtox-import/README.txt', 'runtime/qtox-import/libsqlcipher-0.dll',
    'runtime/qtox-import/provenance.json'
)
$localSecretFileNames = @("kaigen_vm_ed25519")
$diagnostics.tree = $treeish
# Export the declared tree, never current working-tree attributes. This candidate is not a release asset.
Invoke-GitLines -ArgumentList @('archive', '--format=zip', "--output=$candidatePath", $treeish) | Out-Null
if (-not (Test-Path -LiteralPath $candidatePath -PathType Leaf)) { throw 'Git archive returned no candidate file.' }
$zipHash = (Get-FileHash -LiteralPath $candidatePath -Algorithm SHA256).Hash.ToLowerInvariant()
$zip = [IO.Compression.ZipFile]::OpenRead($candidatePath)
try {
    $exportedPaths = @($zip.Entries | ForEach-Object { $_.FullName })
} finally {
    $zip.Dispose()
}
$diagnostics.archive = [ordered]@{ sha256 = $zipHash; entries = $exportedPaths.Count; forbiddenEntries = [Collections.Generic.List[string]]::new(); releaseAsset = $false }
foreach ($relativePath in $exportedPaths) {
    $normalizedPath = $relativePath.Replace('\', '/')
    $leafName = [IO.Path]::GetFileName($normalizedPath)
    $isLocalOnly = ($localOnlyPaths -contains $normalizedPath) -or
        ($leafName -eq 'AGENTS.md') -or
        ($normalizedPath -match '(^|/)(\.\.?)(/|$)|^[A-Za-z]:|^/') -or
        ($localSecretFileNames -contains $leafName) -or
        $leafName.StartsWith("credentials.local.", [StringComparison]::OrdinalIgnoreCase) -or
        $leafName.EndsWith(".credential.xml", [StringComparison]::OrdinalIgnoreCase)
    foreach ($prefix in $localOnlyPrefixes) {
        if ($normalizedPath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
            if ($prefix -ceq 'runtime/' -and $managedPublicRuntimePaths -ccontains $normalizedPath) { continue }
            $isLocalOnly = $true
            break
        }
    }
    if ($isLocalOnly) { $diagnostics.archive.forbiddenEntries.Add($relativePath) }
}
if ($diagnostics.archive.forbiddenEntries.Count) {
    throw "A local or private path was selected for the public source archive: $($diagnostics.archive.forbiddenEntries[0]); diagnostics: $diagnosticsPath"
}

if ($ValidateOnly) {
    $diagnostics.status = 'VALIDATED'
    Save-ArchiveDiagnostics
    Write-Host "Source archive inputs validated: $treeDescription; SHA-256: $zipHash; entries: $($exportedPaths.Count)"
    return
}
[IO.File]::Move($candidatePath, $zipPath, $true)
$diagnostics.archive.releaseAsset = $true
$diagnostics.status = 'PACKAGED'
Save-ArchiveDiagnostics
Write-Host "Source archive: $zipPath"
Write-Host "Source tree: $treeDescription"
Write-Host "SHA-256: $zipHash"
} catch {
    $diagnostics.status = 'FAILED'
    $diagnostics.failure = $_.Exception.Message
    Save-ArchiveDiagnostics
    throw
} finally {
    # Original native outputs and semantic outcome were saved before candidate cleanup.
    if (Test-Path -LiteralPath $candidatePath -PathType Leaf) { [IO.File]::Delete($candidatePath) }
    Write-Host "Source archive diagnostics: $diagnosticsPath"
}
