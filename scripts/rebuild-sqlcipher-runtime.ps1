#requires -Version 7.6.5
[CmdletBinding()]
param(
    [ValidatePattern('^[A-Za-z0-9._-]+$')]
    [string]$RunName = 'canonical-rebuild',
    [string]$VsDevCmd = 'C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\Common7\Tools\VsDevCmd.bat',
    [string]$ComponentCacheRoot = $env:KAIGEN_COMPONENT_CACHE_ROOT,
    [string]$ScratchRoot = (Join-Path ([IO.Path]::GetTempPath()) 'KaigenSqlcipherRebuild'),
    [string]$PatchManifest = 'patches/sqlcipher/manifest.json',
    [switch]$AllowNetworkComponentFetch
)

# Builds an audited candidate whose reports and outputs stay under
# work/sqlcipher-rebuild. SQLCipher's Jim Tcl build helpers cannot execute from
# paths containing whitespace or non-ASCII characters, so compilation uses a
# separately guarded scratch path. Promotion to runtime/qtox-import remains a
# separate, manual production decision.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$utf8NoBom = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $utf8NoBom
$OutputEncoding = $utf8NoBom
if ($PSVersionTable.PSVersion.ToString() -cne '7.6.5') {
    throw "Kaigen automation requires PowerShell 7.6.5 exactly; found $($PSVersionTable.PSVersion)."
}
if ($AllowNetworkComponentFetch -and ($env:KAIGEN_COMPONENT_UPDATE_SCOPE -cne 'all-managed-components' -or $env:KAIGEN_ALLOW_NETWORK_COMPONENT_FETCH -cne '1')) {
    throw 'Network component retrieval requires KAIGEN_COMPONENT_UPDATE_SCOPE=all-managed-components from the explicit full Kaigen component-update route.'
}

$projectRoot = Split-Path -Parent $PSScriptRoot
foreach ($name in @('CL', '_CL_', 'LINK', 'CFLAGS', 'CPPFLAGS', 'LDFLAGS')) {
    if (-not [string]::IsNullOrEmpty([Environment]::GetEnvironmentVariable($name))) {
        throw "Ambient compiler override is forbidden: $name"
    }
}
function Assert-PlainPath {
    param([string]$Path)
    $absolute = [IO.Path]::GetFullPath($Path)
    $cursor = $absolute
    while (-not [string]::IsNullOrEmpty($cursor)) {
        $entry = Get-Item -LiteralPath $cursor -Force -ErrorAction SilentlyContinue
        if ($null -ne $entry -and ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Reparse path is forbidden: $cursor"
        }
        $parent = [IO.Path]::GetDirectoryName($cursor)
        if ($parent -eq $cursor) { break }
        $cursor = $parent
    }
    return $absolute
}
function Assert-RelativeTreePath {
    param([string]$Path)
    if ([string]::IsNullOrEmpty($Path) -or $Path -match '[\\:\t\r\n]' -or $Path.StartsWith('/') -or
        @($Path.Split('/') | Where-Object { $_ -in @('', '.', '..', '.git') }).Count -gt 0) {
        throw "Unsafe relative tree path: $Path"
    }
}
function Resolve-SourcePatchPath {
    param([string]$Path)
    Assert-RelativeTreePath $Path
    if (-not $Path.StartsWith('patches/sqlcipher/', [StringComparison]::Ordinal)) { throw 'Only source-owned patches/sqlcipher inputs are accepted.' }
    $resolved = Assert-PlainPath (Join-Path $projectRoot $Path)
    $patchRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot 'patches/sqlcipher')).TrimEnd('\') + '\'
    if (-not $resolved.StartsWith($patchRoot, [StringComparison]::OrdinalIgnoreCase) -or
        -not (Test-Path -LiteralPath $resolved -PathType Leaf)) { throw "Patch input is outside its source owner or missing: $Path" }
    return $resolved
}
function Get-TreeIdentity {
    param([string]$Root)
    $absolute = Assert-PlainPath $Root
    $pending = [Collections.Generic.Stack[string]]::new()
    $pending.Push($absolute)
    $files = [Collections.Generic.Dictionary[string,object]]::new([StringComparer]::Ordinal)
    while ($pending.Count -gt 0) {
        foreach ($item in Get-ChildItem -LiteralPath $pending.Pop() -Force) {
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Reparse tree entry: $($item.FullName)" }
            $relative = [IO.Path]::GetRelativePath($absolute, $item.FullName).Replace('\','/')
            Assert-RelativeTreePath $relative
            if ($item.PSIsContainer) { $pending.Push($item.FullName); continue }
            $files.Add($relative, [ordered]@{ size = $item.Length; sha256 = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant() })
        }
    }
    $names = [string[]]@($files.Keys)
    [Array]::Sort($names, [StringComparer]::Ordinal)
    $lines = [Text.StringBuilder]::new()
    foreach ($name in $names) { [void]$lines.Append($files[$name].sha256).Append([char]9).Append($files[$name].size).Append([char]9).Append($name).Append([char]10) }
    $digest = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($lines.ToString()))).ToLowerInvariant()
    return [pscustomobject]@{ sha256 = $digest; files = $files }
}
function Assert-TouchedFiles {
    param($Identity, [string]$Side, $Entries)
    foreach ($entry in $Entries) {
        Assert-RelativeTreePath $entry.path
        $expected = $entry.$Side
        if ($null -eq $expected) {
            if ($Identity.files.ContainsKey($entry.path)) { throw "Expected absent $Side patch entry: $($entry.path)" }
        } elseif (-not $Identity.files.ContainsKey($entry.path) -or $Identity.files[$entry.path].size -ne $expected.size -or $Identity.files[$entry.path].sha256 -cne $expected.sha256.ToLowerInvariant()) {
            throw "Patch $Side identity mismatch: $($entry.path)"
        }
    }
}
$patchManifestPath = Resolve-SourcePatchPath $PatchManifest
$patchSpec = Get-Content -LiteralPath $patchManifestPath -Raw | ConvertFrom-Json
if ($patchSpec.schemaVersion -ne 1 -or $patchSpec.materializedTree.algorithm -cne 'sha256-file-size-path-lines-v1' -or
    $patchSpec.versions.sqlcipher -cne '4.19.0' -or $patchSpec.versions.sqlite -cne '3.54.0' -or $patchSpec.versions.openssl -cne '4.0.3' -or
    $patchSpec.baseSource.name -cne 'sqlcipher-v4.19.0.tar.gz' -or $patchSpec.baseSource.size -ne 19356184 -or
    $patchSpec.baseSource.sha256 -ine '7075F96CBABE45B4ECFC2E6B1745A625F856F695B0827A5506CE9ED85B906AA0' -or
    $patchSpec.baseSource.url -cne 'https://github.com/sqlcipher/sqlcipher/archive/refs/tags/v4.19.0.tar.gz' -or
    $patchSpec.upstreamSQLite.name -cne 'sqlite-src-3540000.zip' -or $patchSpec.upstreamSQLite.url -cne 'https://www.sqlite.org/2026/sqlite-src-3540000.zip') { throw 'Reviewed patch manifest base/version/algorithm mismatch.' }
foreach ($digest in @($patchSpec.patch.sha256, $patchSpec.upstreamSQLite.sha256, $patchSpec.materializedTree.beforeSha256, $patchSpec.materializedTree.afterSha256)) {
    if ($digest -notmatch '^[a-fA-F0-9]{64}$') { throw 'Exact SHA-256 pin missing from patch manifest.' }
}
if ($patchSpec.patch.size -le 0 -or $patchSpec.upstreamSQLite.size -le 0 -or @($patchSpec.touchedFiles).Count -eq 0) { throw 'Reviewed patch/source size or touched entries missing.' }
$touchedNames = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach ($entry in $patchSpec.touchedFiles) { Assert-RelativeTreePath $entry.path; if (-not $touchedNames.Add($entry.path)) { throw 'Duplicate patch entry.' } }
$fullPatchPath = Resolve-SourcePatchPath $patchSpec.patch.path
$baselineDllName = 'sqlcipher-runtime-4.19.0-sqlite-3.53.4-openssl-4.0.3-msvc-x64.dll'
$baselineDllSha256 = 'C0E63E5CFD59B5DE49798104056D1783B4BFCFBF6E8A365DAF38986528182FB2'
$baselineDllSize = 4849664
$manifestSha256 = (Get-FileHash -LiteralPath $patchManifestPath).Hash
$recipeSha256 = (Get-FileHash -LiteralPath $PSCommandPath).Hash
$workRoot = Join-Path $projectRoot 'work\sqlcipher-rebuild'
$downloadRoot = Join-Path $workRoot 'downloads'
$runRoot = Join-Path $workRoot (Join-Path 'runs' $RunName)
[void](Assert-PlainPath $workRoot)
$resolvedScratchRoot = (Assert-PlainPath $ScratchRoot).TrimEnd('\')
$scratchRunRoot = Join-Path $resolvedScratchRoot 'canonical-build'
$scratchArchiveRoot = Join-Path $resolvedScratchRoot ('archive-' + $RunName)
if ($resolvedScratchRoot -match '\s' -or $resolvedScratchRoot -notmatch '^[\x20-\x7E]+$') {
    throw "SQLCipher scratch root must be an ASCII path without whitespace: $resolvedScratchRoot"
}
$scratchParent = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($scratchRunRoot))
$archiveParent = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($scratchArchiveRoot))
if ($scratchParent -cne $resolvedScratchRoot -or $archiveParent -cne $resolvedScratchRoot) {
    throw 'SQLCipher scratch source and archive must be direct children of the guarded scratch root.'
}
$sourceDateEpoch = '1788706303' # SQLCipher v4.19.0 annotated tag date: 2026-09-06T14:51:43Z.
$canonicalBuildPath = 'C:\KaigenRepro\build'
$canonicalOpenSslPrefix = 'C:\KaigenRepro\openssl-4.0.3'
$deterministicPathMapFlags = '/experimental:deterministic /pathmap:' +
    $scratchRunRoot + '=' + $canonicalBuildPath
$smokeSource = Join-Path $projectRoot 'scripts\tests\sqlcipher-runtime-smoke.c'
$smokeSourceSha256 = (Get-FileHash -LiteralPath $smokeSource).Hash
$resolvedComponentCacheRoot = $null
if (-not [string]::IsNullOrWhiteSpace($ComponentCacheRoot)) {
    $resolvedComponentCacheRoot = (Assert-PlainPath $ComponentCacheRoot).TrimEnd('\')
    if (-not (Test-Path -LiteralPath $resolvedComponentCacheRoot -PathType Container)) {
        if ($AllowNetworkComponentFetch) {
            [IO.Directory]::CreateDirectory($resolvedComponentCacheRoot) | Out-Null
        } else {
            throw "Canonical local component cache was not found: $resolvedComponentCacheRoot"
        }
    }
}

if ($null -eq $resolvedComponentCacheRoot) { throw 'An explicit immutable component cache is required for the baseline producer DLL.' }
$baselineDll = Assert-PlainPath (Join-Path $resolvedComponentCacheRoot $baselineDllName)

$sources = @(
    [pscustomobject]@{
        Name = 'sqlcipher-v4.19.0.tar.gz'
        Url = 'https://github.com/sqlcipher/sqlcipher/archive/refs/tags/v4.19.0.tar.gz'
        Sha256 = '7075F96CBABE45B4ECFC2E6B1745A625F856F695B0827A5506CE9ED85B906AA0'
        Size = 19356184
    },
    [pscustomobject]@{
        Name = 'openssl-4.0.3.tar.gz'
        Url = 'https://github.com/openssl/openssl/releases/download/openssl-4.0.3/openssl-4.0.3.tar.gz'
        Sha256 = '325B5C806167C13B40B1FFEADFE0248197C00ECCC4CF123EC1E28D2D2FD216D9'
        Size = 55235667
    },
    [pscustomobject]@{
        Name = 'strawberry-perl-5.42.3.1-64bit-portable.zip'
        Url = 'https://github.com/StrawberryPerl/Perl-Dist-Strawberry/releases/download/SP_54231_64bit/strawberry-perl-5.42.3.1-64bit-portable.zip'
        Sha256 = '6A081A811781C30ACA51DBC036AFD93092AF91E3297901F02C17043795A10690'
        Size = 304765269
    }
)

$sources += [pscustomobject]@{ Name = $patchSpec.upstreamSQLite.name; Url = $patchSpec.upstreamSQLite.url; Sha256 = $patchSpec.upstreamSQLite.sha256; Size = $patchSpec.upstreamSQLite.size }

function Assert-FileHash {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Expected
    )
    $observed = (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash
    if ($observed -ne $Expected) {
        throw "SHA256 mismatch for $Path. Expected $Expected, observed $observed."
    }
}

function Assert-FileIdentity {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][int64]$ExpectedSize,
        [Parameter(Mandatory)][string]$ExpectedSha256
    )
    [void](Assert-PlainPath $Path)
    $item = Get-Item -LiteralPath $Path -ErrorAction Stop
    if ($item.PSIsContainer) { throw 'Expected ordinary input file.' }
    if ($item.Length -ne $ExpectedSize) {
        throw "Size mismatch for $Path. Expected $ExpectedSize, observed $($item.Length)."
    }
    Assert-FileHash -Path $Path -Expected $ExpectedSha256
}

function Invoke-DeveloperCommand {
    param(
        [Parameter(Mandatory)][string]$Command,
        [Parameter(Mandatory)][string]$LogPath
    )
    $wrapped = 'call "' + $VsDevCmd + '" -arch=x64 -host_arch=x64 >NUL && ' +
        $Command + ' > "' + $LogPath + '" 2>&1'
    & cmd.exe /d /v:off /s /c $wrapped
    if ($LASTEXITCODE -ne 0) {
        throw "Developer command failed with exit code $LASTEXITCODE. See $LogPath"
    }
}

Assert-FileIdentity -Path $fullPatchPath -ExpectedSize $patchSpec.patch.size -ExpectedSha256 $patchSpec.patch.sha256
$patchText = Get-Content -LiteralPath $fullPatchPath -Raw
if ($patchText -match '(?m)^(?:new file mode|deleted file mode|old mode|new mode) (?:120000|160000)\s*$' -or
    $patchText -match '(?m)^index [0-9a-f]+\.\.[0-9a-f]+ (?:120000|160000)\s*$') { throw 'Symlink or submodule patch mode is forbidden.' }
Assert-FileIdentity -Path $baselineDll -ExpectedSize $baselineDllSize -ExpectedSha256 $baselineDllSha256

if (-not (Test-Path -LiteralPath $VsDevCmd -PathType Leaf)) {
    throw "VsDevCmd.bat was not found: $VsDevCmd"
}
if (-not (Test-Path -LiteralPath $smokeSource -PathType Leaf)) {
    throw "SQLCipher smoke source was not found: $smokeSource"
}
if (Test-Path -LiteralPath $runRoot) {
    throw "Run directory already exists; refusing to overwrite it: $runRoot"
}
if (Test-Path -LiteralPath $scratchRunRoot) {
    throw "Scratch run directory already exists; refusing to overwrite it: $scratchRunRoot"
}
if (Test-Path -LiteralPath $scratchArchiveRoot) {
    throw "Scratch archive directory already exists; refusing to overwrite it: $scratchArchiveRoot"
}

New-Item -ItemType Directory -Path $workRoot -Force | Out-Null
New-Item -ItemType Directory -Path $downloadRoot -Force | Out-Null
New-Item -ItemType Directory -Path $runRoot | Out-Null
New-Item -ItemType Directory -Path $scratchRunRoot -Force | Out-Null

foreach ($source in $sources) {
    if ($null -eq $source.Size -or [int64]$source.Size -le 0) {
        throw "Managed component $($source.Name) has no reviewed exact size pin; run only the explicit full Kaigen component-update route before rebuilding SQLCipher."
    }
    $archive = Join-Path $downloadRoot $source.Name
    if (-not (Test-Path -LiteralPath $archive -PathType Leaf)) {
        $cachePath = if ($null -eq $resolvedComponentCacheRoot) { $null } else { Join-Path $resolvedComponentCacheRoot $source.Name }
        if ($null -ne $cachePath -and (Test-Path -LiteralPath $cachePath -PathType Leaf)) {
            Assert-FileIdentity -Path $cachePath -ExpectedSize $source.Size -ExpectedSha256 $source.Sha256
            Copy-Item -LiteralPath $cachePath -Destination $archive
            Assert-FileIdentity -Path $archive -ExpectedSize $source.Size -ExpectedSha256 $source.Sha256
            Write-Host "Using canonical local component: $cachePath"
            continue
        }
        if (-not $AllowNetworkComponentFetch) {
            $expectedCache = if ($null -eq $cachePath) { 'an explicitly supplied canonical cache' } else { $cachePath }
            throw "Managed component is missing locally: $($source.Name). Expected $expectedCache. Network fallback is disabled outside the explicit Kaigen component-update route."
        }
        & curl.exe --fail --location --output $archive $source.Url
        if ($LASTEXITCODE -ne 0) {
            throw "Download failed: $($source.Url)"
        }
        Assert-FileIdentity -Path $archive -ExpectedSize $source.Size -ExpectedSha256 $source.Sha256
        if ($null -ne $cachePath) {
            Copy-Item -LiteralPath $archive -Destination $cachePath
            Assert-FileIdentity -Path $cachePath -ExpectedSize $source.Size -ExpectedSha256 $source.Sha256
            Write-Host "Updated canonical local component cache: $cachePath"
        }
    }
    Assert-FileIdentity -Path $archive -ExpectedSize $source.Size -ExpectedSha256 $source.Sha256
}

$opensslSource = Join-Path $scratchRunRoot 'openssl-4.0.3'
$sqlcipherA = Join-Path $scratchRunRoot 'sqlcipher-4.19.0-a'
$sqlcipherB = Join-Path $scratchRunRoot 'sqlcipher-4.19.0-b'
$perlRoot = Join-Path $scratchRunRoot 'strawberry-perl'
$outputRoot = Join-Path $runRoot 'output'
foreach ($directory in @($opensslSource, $sqlcipherA, $sqlcipherB, $perlRoot, $outputRoot)) {
    New-Item -ItemType Directory -Path $directory | Out-Null
}

& tar.exe -xzf (Join-Path $downloadRoot 'openssl-4.0.3.tar.gz') -C $opensslSource --strip-components=1
if ($LASTEXITCODE -ne 0) { throw 'Could not extract OpenSSL source.' }
foreach ($sqlcipherSource in @($sqlcipherA, $sqlcipherB)) {
    & tar.exe -xzf (Join-Path $downloadRoot 'sqlcipher-v4.19.0.tar.gz') -C $sqlcipherSource --strip-components=1
    if ($LASTEXITCODE -ne 0) { throw 'Could not extract SQLCipher source.' }
}
Expand-Archive -LiteralPath (Join-Path $downloadRoot 'strawberry-perl-5.42.3.1-64bit-portable.zip') -DestinationPath $perlRoot

$sourceTreeProofs = @()
foreach ($sqlcipherSource in @($sqlcipherA, $sqlcipherB)) {
    $before = Get-TreeIdentity $sqlcipherSource
    if ($before.sha256 -cne $patchSpec.materializedTree.beforeSha256.ToLowerInvariant()) { throw 'Full base SQLCipher tree identity mismatch.' }
    Assert-TouchedFiles $before 'before' $patchSpec.touchedFiles
    & git -c core.autocrlf=false -c core.eol=lf -C $sqlcipherSource apply --check --whitespace=nowarn -- $fullPatchPath
    if ($LASTEXITCODE -ne 0) { throw 'Reviewed full patch failed apply --check; source preserved.' }
    & git -c core.autocrlf=false -c core.eol=lf -C $sqlcipherSource apply --whitespace=nowarn -- $fullPatchPath
    if ($LASTEXITCODE -ne 0) { throw 'Reviewed full patch application failed; source preserved.' }
    $after = Get-TreeIdentity $sqlcipherSource
    if ($after.sha256 -cne $patchSpec.materializedTree.afterSha256.ToLowerInvariant()) { throw 'Full patched SQLCipher tree identity mismatch.' }
    Assert-TouchedFiles $after 'after' $patchSpec.touchedFiles
    $changed = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($name in $before.files.Keys) { [void]$changed.Add($name) }
    foreach ($name in $after.files.Keys) { [void]$changed.Add($name) }
    foreach ($name in $changed) {
        $different = -not $before.files.ContainsKey($name) -or -not $after.files.ContainsKey($name) -or
            $before.files[$name].sha256 -cne $after.files[$name].sha256 -or $before.files[$name].size -ne $after.files[$name].size
        if ($different -and -not $touchedNames.Contains($name)) { throw "Unreviewed patch entry changed: $name" }
    }
    $sourceTreeProofs += [ordered]@{ extraction = Split-Path $sqlcipherSource -Leaf; beforeSha256 = $before.sha256; afterSha256 = $after.sha256; touchedFiles = $patchSpec.touchedFiles }
}
$sourceTreeProofs | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $runRoot 'source-tree-proof.json') -Encoding utf8
$toolchainLog = Join-Path $runRoot 'toolchain-identity.txt'
$toolchainCommand = Join-Path $runRoot 'toolchain-identity.cmd'
# This separate batch is parsed only after VsDevCmd has set its environment.
# Delayed expansion is not enabled; paths containing exclamation marks remain literal.
$toolchainBatch = [string]::Join([Environment]::NewLine, @(
    '@echo off',
    'for %%T in (cl.exe) do @echo CL=%%~$PATH:T',
    'for %%T in (link.exe) do @echo LINK=%%~$PATH:T',
    'for %%T in (nmake.exe) do @echo NMAKE=%%~$PATH:T',
    'echo SDK_ROOT=%WindowsSdkDir%',
    'echo SDK_VERSION=%WindowsSDKVersion%',
    'echo VC_VERSION=%VCToolsVersion%'
))
[IO.File]::WriteAllText($toolchainCommand, $toolchainBatch + [Environment]::NewLine, [Text.Encoding]::ASCII)
Invoke-DeveloperCommand -Command ('call "' + $toolchainCommand + '"') -LogPath $toolchainLog
$toolchainText = Get-Content -LiteralPath $toolchainLog -Raw
$toolchain = [ordered]@{}
foreach ($label in @('CL','LINK','NMAKE')) {
    $binary = [regex]::Match($toolchainText, '(?m)^' + $label + '=(.+)$').Groups[1].Value.Trim()
    if ([string]::IsNullOrWhiteSpace($binary)) { throw "Missing developer tool identity: $label" }
    [void](Assert-PlainPath $binary)
    $toolchain[$label] = [ordered]@{ path = $binary; version = (Get-Item -LiteralPath $binary).VersionInfo.FileVersion; sha256 = (Get-FileHash -LiteralPath $binary).Hash }
}
$sdkRoot = [regex]::Match($toolchainText, '(?m)^SDK_ROOT=(.+)$').Groups[1].Value.Trim()
$sdkVersion = [regex]::Match($toolchainText, '(?m)^SDK_VERSION=(.+)$').Groups[1].Value.Trim().TrimEnd('\')
$vcVersion = [regex]::Match($toolchainText, '(?m)^VC_VERSION=(.+)$').Groups[1].Value.Trim()
if ([string]::IsNullOrEmpty($sdkRoot) -or $sdkVersion -notmatch '^\d+\.\d+\.\d+\.\d+$' -or [string]::IsNullOrEmpty($vcVersion)) { throw 'SDK/VC toolchain identity missing.' }
$toolchain.SDK = [ordered]@{ root = $sdkRoot; version = $sdkVersion; vcVersion = $vcVersion; files = @() }
foreach ($relative in @("Include/$sdkVersion/ucrt/corecrt.h", "Include/$sdkVersion/um/Windows.h", "Lib/$sdkVersion/ucrt/x64/libucrt.lib", "Lib/$sdkVersion/um/x64/kernel32.lib", "Lib/$sdkVersion/um/x64/crypt32.lib", "Lib/$sdkVersion/um/x64/ws2_32.lib", "Lib/$sdkVersion/um/x64/advapi32.lib", "Lib/$sdkVersion/um/x64/user32.lib")) {
    $sdkFile = Assert-PlainPath (Join-Path $sdkRoot $relative)
    $toolchain.SDK.files += [ordered]@{ path = $relative; size = (Get-Item -LiteralPath $sdkFile).Length; sha256 = (Get-FileHash -LiteralPath $sdkFile).Hash }
}
$toolchain | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $runRoot 'toolchain-identity.json') -Encoding utf8

$perl = Join-Path $perlRoot 'perl\bin\perl.exe'
$opensslConfigureLog = Join-Path $runRoot 'openssl-configure.log'
$opensslBuildLog = Join-Path $runRoot 'openssl-build.log'
$configure = 'cd /d "' + $opensslSource + '"' +
    ' && set "LC_ALL=C" && set "LC_CTYPE=C" && set "LANG=C"' +
    ' && set "SOURCE_DATE_EPOCH=' + $sourceDateEpoch + '"' +
    ' && set "CFLAGS=/W3 /wd4090 /nologo /O2 /Brepro"' +
    ' && set "ARFLAGS=/nologo /Brepro"' +
    ' && set "LDFLAGS=/nologo /Brepro /OPT:REF /OPT:ICF /INCREMENTAL:NO"' +
    ' && "' + $perl + '" Configure VC-WIN64A no-shared no-module no-tests no-asm' +
    ' --prefix="' + $canonicalOpenSslPrefix + '"' +
    ' --openssldir="' + (Join-Path $canonicalOpenSslPrefix 'ssl') + '"'
Invoke-DeveloperCommand -Command $configure -LogPath $opensslConfigureLog
Invoke-DeveloperCommand -Command (
    'cd /d "' + $opensslSource + '"' +
    ' && set "LC_ALL=C" && set "LC_CTYPE=C" && set "LANG=C"' +
    ' && set "SOURCE_DATE_EPOCH=' + $sourceDateEpoch + '"' +
    ' && set "CL=' + $deterministicPathMapFlags + '" && nmake /NOLOGO'
) -LogPath $opensslBuildLog

$cipherDefines = '-DSQLITE_HAS_CODEC -DSQLITE_TEMP_STORE=2' +
    ' -DSQLITE_EXTRA_INIT=sqlcipher_extra_init' +
    ' -DSQLITE_EXTRA_SHUTDOWN=sqlcipher_extra_shutdown' +
    ' -DSQLCIPHER_CRYPTO_OPENSSL'
$opensslBuildRelative = '..\openssl-4.0.3'
$sqlcipherLogs = @()
foreach ($sqlcipherSource in @($sqlcipherA, $sqlcipherB)) {
    $label = Split-Path $sqlcipherSource -Leaf
    $log = Join-Path $runRoot ($label + '-build.log')
    $sqlcipherLogs += $log
    $build = 'cd /d "' + $sqlcipherSource + '"' +
        ' && set "SOURCE_DATE_EPOCH=' + $sourceDateEpoch + '"' +
        ' && set "CL=' + $deterministicPathMapFlags + '"' +
        ' && nmake /NOLOGO /f Makefile.msc TOP=. USE_AMALGAMATION=1 DYNAMIC_SHELL=1' +
        ' PLATFORM=x64 USE_CRT_DLL=0 SYMBOLS=0' +
        ' SQLITE3DLL=libsqlcipher-0.dll SQLITE3LIB=libsqlcipher-0.lib' +
        ' "TCCOPTS=/Brepro /I' + (Join-Path $opensslBuildRelative 'include') + '"' +
        ' "LDOPTS=/Brepro /OPT:REF /OPT:ICF /INCREMENTAL:NO"' +
        ' "OPTS=' + $cipherDefines + '"' +
        ' "LTLIBPATHS=/LIBPATH:' + $opensslBuildRelative + '"' +
        ' "LTLIBS=libcrypto.lib crypt32.lib ws2_32.lib advapi32.lib user32.lib"' +
        ' libsqlcipher-0.dll'
    Invoke-DeveloperCommand -Command $build -LogPath $log
}

$dllA = Join-Path $sqlcipherA 'libsqlcipher-0.dll'
$dllB = Join-Path $sqlcipherB 'libsqlcipher-0.dll'
$libA = Join-Path $sqlcipherA 'libsqlcipher-0.lib'
$libB = Join-Path $sqlcipherB 'libsqlcipher-0.lib'
$dllHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $dllA).Hash
$repeatDllHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $dllB).Hash
$libHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $libA).Hash
$repeatLibHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $libB).Hash
if ($dllHash -ne $repeatDllHash -or $libHash -ne $repeatLibHash) {
    throw 'The two independent SQLCipher builds are not byte-identical.'
}

Copy-Item -LiteralPath $dllA -Destination (Join-Path $outputRoot 'libsqlcipher-0.dll')
Copy-Item -LiteralPath $libA -Destination (Join-Path $outputRoot 'libsqlcipher-0.lib')
Copy-Item -LiteralPath (Join-Path $sqlcipherA 'sqlite3.h') -Destination (Join-Path $outputRoot 'sqlite3.h')

$outputDll = Join-Path $outputRoot 'libsqlcipher-0.dll'
$dependents = Join-Path $outputRoot 'dumpbin-dependents.txt'
$exports = Join-Path $outputRoot 'dumpbin-exports.txt'
$headers = Join-Path $outputRoot 'dumpbin-headers.txt'
Invoke-DeveloperCommand -Command (
    'dumpbin /NOLOGO /DEPENDENTS "' + $outputDll + '" > "' + $dependents + '"' +
    ' && dumpbin /NOLOGO /EXPORTS "' + $outputDll + '" > "' + $exports + '"' +
    ' && dumpbin /NOLOGO /HEADERS "' + $outputDll + '"'
) -LogPath $headers

$dependencyText = Get-Content -LiteralPath $dependents -Raw
$expectedDependencies = @(
    'ADVAPI32.DLL', 'CRYPT32.DLL', 'KERNEL32.DLL', 'USER32.DLL', 'WS2_32.DLL'
)
$observedDependencies = @(
    [regex]::Matches($dependencyText, '(?im)^\s+([A-Z0-9_.-]+\.dll)\s*$') |
        ForEach-Object { $_.Groups[1].Value.ToUpperInvariant() }
) | Sort-Object -Unique
$dependencyDifference = @(Compare-Object -ReferenceObject $expectedDependencies -DifferenceObject $observedDependencies)
if ($dependencyDifference.Count -ne 0) {
    $observed = $observedDependencies -join ', '
    throw "Unexpected DLL dependency set: $observed"
}
$requiredExports = @(
    'sqlite3_open_v2', 'sqlite3_close', 'sqlite3_exec', 'sqlite3_prepare_v2',
    'sqlite3_step', 'sqlite3_finalize', 'sqlite3_column_int64', 'sqlite3_column_text',
    'sqlite3_column_blob', 'sqlite3_column_bytes', 'sqlite3_column_type', 'sqlite3_errmsg'
)
$exportText = Get-Content -LiteralPath $exports -Raw
foreach ($requiredExport in $requiredExports) {
    if ($exportText -notmatch ('(?m)\b' + [regex]::Escape($requiredExport) + '\b')) {
        throw "Missing required export: $requiredExport"
    }
}
$namedExportCount = [regex]::Matches(
    $exportText,
    '(?m)^\s+[0-9A-F]+\s+[0-9A-F]+\s+[0-9A-F]+\s+([A-Za-z_][A-Za-z0-9_]*)\s*$'
).Count

$smokeData = Join-Path $scratchRunRoot 'smoke-data'
New-Item -ItemType Directory -Path $smokeData | Out-Null
$producerRoot = Join-Path $outputRoot 'baseline-producer'
$readerRoot = Join-Path $outputRoot 'candidate-reader'
New-Item -ItemType Directory -Path $producerRoot, $readerRoot | Out-Null
foreach ($smokeRoot in @($producerRoot, $readerRoot)) {
    $smokeExe = Join-Path $smokeRoot 'sqlcipher_smoke.exe'
    $smokeObject = Join-Path $smokeRoot 'sqlcipher-runtime-smoke.obj'
    Invoke-DeveloperCommand -Command (
        'cl /nologo /W4 /WX /std:c11 /O2 /MT /Brepro /I"' + $outputRoot + '"' +
        ' "' + $smokeSource + '" /Fo:"' + $smokeObject + '" /Fe:"' + $smokeExe + '"' +
        ' /link /Brepro /INCREMENTAL:NO /OPT:REF /OPT:ICF "' + (Join-Path $outputRoot 'libsqlcipher-0.lib') + '"'
    ) -LogPath (Join-Path $smokeRoot 'smoke-compile.txt')
}
Copy-Item -LiteralPath $baselineDll -Destination (Join-Path $producerRoot 'libsqlcipher-0.dll')
Copy-Item -LiteralPath $outputDll -Destination (Join-Path $readerRoot 'libsqlcipher-0.dll')
$fixtureNames = @('qtox-v4-sha512.db', 'qtox-sha1-4096.db', 'qtox-v3-sha1-1024.db')
foreach ($name in $fixtureNames) { if (Test-Path -LiteralPath (Join-Path $smokeData $name)) { throw 'New synthetic fixture path already exists.' } }
function Invoke-ExistingSmoke {
    param([string]$Directory, [string]$Mode, [string]$ExpectedSqlite, [string]$DllSha256)
    $runtime = Join-Path $Directory 'libsqlcipher-0.dll'
    Assert-FileHash -Path $runtime -Expected $DllSha256
    $executable = Join-Path $Directory 'sqlcipher_smoke.exe'
    $observed = @(& $executable $smokeData $Mode $ExpectedSqlite 2>&1)
    $nativeExit = $LASTEXITCODE
    $smokeLog = Join-Path $Directory 'smoke-run.txt'
    $observed | Set-Content -LiteralPath $smokeLog -Encoding utf8
    Assert-FileHash -Path $runtime -Expected $DllSha256
    if ($nativeExit -ne 0) { throw "Existing SQLCipher smoke failed ($Mode exit $nativeExit); fixtures and log retained: $smokeLog" }
    $text = $observed -join [Environment]::NewLine
    $runtimeReported = [regex]::Match($text, '(?m)^RUNTIME_DLL (.+)$').Groups[1].Value.Trim()
    if (-not [string]::Equals($runtimeReported, [IO.Path]::GetFullPath($runtime), [StringComparison]::OrdinalIgnoreCase)) { throw 'Smoke loaded a DLL outside its isolated executable directory.' }
    $markers = @(
        "VERSIONS SQLCipher=4.19.0 community SQLite=$ExpectedSqlite provider=openssl provider_version=OpenSSL 4.0.3 29 Sep 2026",
        'PASS qTox/SQLCipher-4 SHA-512 wrong-key rejection',
        'PASS qTox/SQLCipher-4 SHA-512 encrypted qTox-schema round trip',
        'PASS qTox compatibility SHA-1/4096 wrong-key rejection',
        'PASS qTox compatibility SHA-1/4096 encrypted qTox-schema round trip',
        'PASS legacy SQLCipher-3 SHA-1/1024 wrong-key rejection',
        'PASS legacy SQLCipher-3 SHA-1/1024 encrypted qTox-schema round trip',
        'PASS SQLCipher runtime smoke complete'
    )
    foreach ($marker in $markers) { if (-not $text.Contains($marker)) { throw "Existing smoke marker missing: $marker" } }
    foreach ($label in @('qTox/SQLCipher-4 SHA-512','qTox compatibility SHA-1/4096','legacy SQLCipher-3 SHA-1/1024')) {
        if (-not $text.Contains("HEALTH OK $label")) { throw 'Correct-key SQLCipher health evidence missing.' }
    }
    return [ordered]@{ mode = $Mode; sqlite = $ExpectedSqlite; nativeExit = $nativeExit; dllSha256 = $DllSha256; executableSha256 = (Get-FileHash -LiteralPath $executable).Hash; log = $smokeLog; logSha256 = (Get-FileHash -LiteralPath $smokeLog).Hash }
}
$producerSmoke = Invoke-ExistingSmoke $producerRoot 'create-and-verify' '3.53.4' $baselineDllSha256
$fixturesBefore = Get-TreeIdentity $smokeData
if ($fixturesBefore.files.Count -ne 3) { throw 'Unexpected fixture or sidecar file after old producer.' }
foreach ($name in $fixtureNames) { if (-not $fixturesBefore.files.ContainsKey($name)) { throw 'Expected synthetic fixture missing.' } }
$fixtureManifestBefore = [ordered]@{ algorithm = 'sha256-file-size-path-lines-v1'; treeSha256 = $fixturesBefore.sha256; files = $fixturesBefore.files }
$fixtureManifestBefore | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $outputRoot 'fixtures-before-reader.json') -Encoding utf8
$readerFailure = $null
try { $readerSmoke = Invoke-ExistingSmoke $readerRoot 'verify-existing' $patchSpec.versions.sqlite $dllHash }
catch { $readerFailure = $_; $_ | Out-String | Set-Content -LiteralPath (Join-Path $outputRoot 'reader-failure.txt') -Encoding utf8 }
$fixturesAfter = Get-TreeIdentity $smokeData
$fixtureManifestAfter = [ordered]@{ algorithm = 'sha256-file-size-path-lines-v1'; treeSha256 = $fixturesAfter.sha256; files = $fixturesAfter.files }
$fixtureManifestAfter | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $outputRoot 'fixtures-after-reader.json') -Encoding utf8
if ($fixturesBefore.sha256 -cne $fixturesAfter.sha256) { throw 'Candidate reader changed the baseline fixture bytes or sidecars; all files preserved.' }
if ($null -ne $readerFailure) { throw $readerFailure }
Assert-FileHash -Path $patchManifestPath -Expected $manifestSha256
Assert-FileIdentity -Path $fullPatchPath -ExpectedSize $patchSpec.patch.size -ExpectedSha256 $patchSpec.patch.sha256
Assert-FileHash -Path $PSCommandPath -Expected $recipeSha256
Assert-FileHash -Path $smokeSource -Expected $smokeSourceSha256
foreach ($source in $sources) { Assert-FileIdentity -Path (Join-Path $downloadRoot $source.Name) -ExpectedSize $source.Size -ExpectedSha256 $source.Sha256 }
$smokeLog = $readerSmoke.log

$opensslStaticLibrarySha256 = (Get-FileHash -LiteralPath (Join-Path $opensslSource 'libcrypto.lib')).Hash
$baselineProducerRuntime = [ordered]@{ name = $baselineDllName; size = $baselineDllSize; sha256 = $baselineDllSha256 }
Assert-FileIdentity -Path $baselineDll -ExpectedSize $baselineDllSize -ExpectedSha256 $baselineDllSha256
$scratchItem = Get-Item -LiteralPath $scratchRunRoot -ErrorAction Stop
if (($scratchItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Refusing to move a reparse-point scratch directory: $scratchRunRoot"
}
Move-Item -LiteralPath $scratchRunRoot -Destination $scratchArchiveRoot

$result = [ordered]@{
    sqlcipher = '4.19.0 community'
    sqlite = $patchSpec.versions.sqlite
    openssl = '4.0.3'
    sourceDateEpoch = [int64]$sourceDateEpoch
    compilerScratchPath = $scratchRunRoot
    preservedScratchRoot = $scratchArchiveRoot
    canonicalCompilerPath = $canonicalBuildPath
    dll = [ordered]@{
        path = $outputDll
        bytes = (Get-Item -LiteralPath $outputDll).Length
        sha256 = $dllHash
        repeatSha256 = $repeatDllHash
        byteIdentical = $true
    }
    importLibrarySha256 = $libHash
    dependencies = $observedDependencies
    namedExportCount = $namedExportCount
    requiredExports = $requiredExports
    smokeLog = $smokeLog
    verificationScope = 'Same three baseline-DLL-produced synthetic codec fixtures read by candidate DLL; no real qTox profile claim'
    baselineProducer = $producerSmoke
    candidateReader = $readerSmoke
    fixtureManifestBefore = $fixtureManifestBefore
    fixtureManifestAfter = $fixtureManifestAfter
    reviewedManifest = [ordered]@{ path = $PatchManifest; sha256 = $manifestSha256 }
    sources = $sources
    upstreamSQLite = $patchSpec.upstreamSQLite
    vsDevCmdSha256 = (Get-FileHash -LiteralPath $VsDevCmd).Hash
    opensslStaticLibrarySha256 = $opensslStaticLibrarySha256
    baselineProducerRuntime = $baselineProducerRuntime
    fullPatch = $patchSpec.patch
    sourceTrees = $sourceTreeProofs
    recipeSha256 = $recipeSha256
    smokeSourceSha256 = $smokeSourceSha256
    toolchain = $toolchain
    effectiveFlags = [ordered]@{ pathMap = $deterministicPathMapFlags; patchApply = 'git -c core.autocrlf=false -c core.eol=lf apply'; openssl = 'VC-WIN64A no-shared no-module no-tests no-asm'; opensslCFlags = '/W3 /wd4090 /nologo /O2 /Brepro'; opensslARFlags = '/nologo /Brepro'; ldFlags = '/Brepro /OPT:REF /OPT:ICF /INCREMENTAL:NO'; sqlcipher = 'Makefile.msc TOP=. USE_AMALGAMATION=1 DYNAMIC_SHELL=1 PLATFORM=x64 USE_CRT_DLL=0 SYMBOLS=0'; defines = $cipherDefines; smoke = '/W4 /WX /std:c11 /O2 /MT /Brepro'; runtimeLinkInputs = 'libcrypto.lib crypt32.lib ws2_32.lib advapi32.lib user32.lib' }
    headerSha256 = (Get-FileHash -LiteralPath (Join-Path $outputRoot 'sqlite3.h')).Hash
    productionRuntimeReplaced = $false
}
$fingerprintPayload = [ordered]@{ manifest = $result.reviewedManifest; sources = $sources; upstream = $result.upstreamSQLite; vsDevCmd = $result.vsDevCmdSha256; opensslStaticLibrary = $result.opensslStaticLibrarySha256; patch = $result.fullPatch; trees = $sourceTreeProofs; recipe = $result.recipeSha256; smoke = $result.smokeSourceSha256; toolchain = $toolchain; flags = $result.effectiveFlags; dll = $dllHash; importLibrary = $libHash; header = $result.headerSha256; baselineRuntime = $baselineProducerRuntime }
$result.inputOutputFingerprint = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes(($fingerprintPayload | ConvertTo-Json -Depth 15 -Compress)))).ToLowerInvariant()
$result | ConvertTo-Json -Depth 15 | Set-Content -LiteralPath (Join-Path $outputRoot 'build-result.json') -Encoding utf8
$result | ConvertTo-Json -Depth 15
