[CmdletBinding()]
param(
    [ValidatePattern('^[A-Za-z0-9._-]+$')]
    [string]$RunName = 'canonical-rebuild',
    [string]$VsDevCmd = 'C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\Common7\Tools\VsDevCmd.bat',
    [string]$ComponentCacheRoot = $env:KAIGEN_COMPONENT_CACHE_ROOT,
    [string]$ScratchRoot = (Join-Path ([IO.Path]::GetTempPath()) 'KaigenSqlcipherRebuild'),
    [switch]$AllowNetworkComponentFetch
)

# Builds an audited candidate whose reports and outputs stay under
# work/sqlcipher-rebuild. SQLCipher's Jim Tcl build helpers cannot execute from
# paths containing whitespace or non-ASCII characters, so compilation uses a
# separately guarded scratch path. Promotion to runtime/qtox-import remains a
# separate, manual production decision.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($AllowNetworkComponentFetch -and $env:KAIGEN_COMPONENT_UPDATE_SCOPE -cne 'all-managed-components') {
    throw 'Network component retrieval requires KAIGEN_COMPONENT_UPDATE_SCOPE=all-managed-components from the explicit full Kaigen component-update route.'
}

$projectRoot = Split-Path -Parent $PSScriptRoot
$workRoot = Join-Path $projectRoot 'work\sqlcipher-rebuild'
$downloadRoot = Join-Path $workRoot 'downloads'
$runRoot = Join-Path $workRoot (Join-Path 'runs' $RunName)
$resolvedScratchRoot = [IO.Path]::GetFullPath($ScratchRoot).TrimEnd('\')
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
$sourceDateEpoch = '1786744809' # SQLCipher v4.18.0 annotated tag date: 2026-08-14T22:00:09Z.
$canonicalBuildPath = 'C:\KaigenRepro\build'
$canonicalOpenSslPrefix = 'C:\KaigenRepro\openssl-3.5.7'
$deterministicPathMapFlags = '/experimental:deterministic /pathmap:' +
    $scratchRunRoot + '=' + $canonicalBuildPath
$smokeSource = Join-Path $projectRoot 'scripts\tests\sqlcipher-runtime-smoke.c'
$resolvedComponentCacheRoot = $null
if (-not [string]::IsNullOrWhiteSpace($ComponentCacheRoot)) {
    $resolvedComponentCacheRoot = [IO.Path]::GetFullPath($ComponentCacheRoot).TrimEnd('\')
    if (-not (Test-Path -LiteralPath $resolvedComponentCacheRoot -PathType Container)) {
        if ($AllowNetworkComponentFetch) {
            [IO.Directory]::CreateDirectory($resolvedComponentCacheRoot) | Out-Null
        } else {
            throw "Canonical local component cache was not found: $resolvedComponentCacheRoot"
        }
    }
}

$sources = @(
    [pscustomobject]@{
        Name = 'sqlcipher-v4.18.0.tar.gz'
        Url = 'https://github.com/sqlcipher/sqlcipher/archive/refs/tags/v4.18.0.tar.gz'
        Sha256 = '1DF02D1B346FA27FEAF2DA2CB2C0D8209E788248E461EC288718AA5D3E9643E5'
        Size = 19351009
    },
    [pscustomobject]@{
        Name = 'openssl-3.5.7.tar.gz'
        Url = 'https://github.com/openssl/openssl/releases/download/openssl-3.5.7/openssl-3.5.7.tar.gz'
        Sha256 = 'A8C0D28A529CA480F9F36CF5792E2CD21984552A3C8E4AA11A24AA31AEAC98E8'
        Size = 53153930
    },
    [pscustomobject]@{
        Name = 'strawberry-perl-5.42.3.1-64bit-portable.zip'
        Url = 'https://github.com/StrawberryPerl/Perl-Dist-Strawberry/releases/download/SP_54231_64bit/strawberry-perl-5.42.3.1-64bit-portable.zip'
        Sha256 = '6A081A811781C30ACA51DBC036AFD93092AF91E3297901F02C17043795A10690'
        Size = 304765269
    }
)

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
    $item = Get-Item -LiteralPath $Path -ErrorAction Stop
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
    & cmd.exe /d /s /c $wrapped
    if ($LASTEXITCODE -ne 0) {
        throw "Developer command failed with exit code $LASTEXITCODE. See $LogPath"
    }
}

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

$opensslSource = Join-Path $scratchRunRoot 'openssl-3.5.7'
$sqlcipherA = Join-Path $scratchRunRoot 'sqlcipher-4.18.0-a'
$sqlcipherB = Join-Path $scratchRunRoot 'sqlcipher-4.18.0-b'
$perlRoot = Join-Path $scratchRunRoot 'strawberry-perl'
$outputRoot = Join-Path $runRoot 'output'
foreach ($directory in @($opensslSource, $sqlcipherA, $sqlcipherB, $perlRoot, $outputRoot)) {
    New-Item -ItemType Directory -Path $directory | Out-Null
}

& tar.exe -xzf (Join-Path $downloadRoot 'openssl-3.5.7.tar.gz') -C $opensslSource --strip-components=1
if ($LASTEXITCODE -ne 0) { throw 'Could not extract OpenSSL source.' }
foreach ($sqlcipherSource in @($sqlcipherA, $sqlcipherB)) {
    & tar.exe -xzf (Join-Path $downloadRoot 'sqlcipher-v4.18.0.tar.gz') -C $sqlcipherSource --strip-components=1
    if ($LASTEXITCODE -ne 0) { throw 'Could not extract SQLCipher source.' }
}
Expand-Archive -LiteralPath (Join-Path $downloadRoot 'strawberry-perl-5.42.3.1-64bit-portable.zip') -DestinationPath $perlRoot

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
$opensslBuildRelative = '..\openssl-3.5.7'
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
$smokeExe = Join-Path $outputRoot 'sqlcipher_smoke.exe'
Invoke-DeveloperCommand -Command (
    'cl /nologo /W4 /WX /std:c11 /O2 /MT /Brepro /I"' + $outputRoot + '"' +
    ' "' + $smokeSource + '" /Fe:"' + $smokeExe + '"' +
    ' /link /Brepro /INCREMENTAL:NO /OPT:REF /OPT:ICF "' + (Join-Path $outputRoot 'libsqlcipher-0.lib') + '"'
) -LogPath (Join-Path $outputRoot 'smoke-compile.txt')

$smokeOutput = @(& $smokeExe $smokeData 2>&1)
$smokeExitCode = $LASTEXITCODE
$smokeLog = Join-Path $outputRoot 'smoke-run.txt'
$smokeOutput | Set-Content -LiteralPath $smokeLog -Encoding utf8
if ($smokeExitCode -ne 0) { throw 'Encrypted SQLCipher smoke test failed.' }
$smokeText = $smokeOutput -join [Environment]::NewLine
$expectedSmokeMarkers = @(
    'VERSIONS SQLCipher=4.18.0 community SQLite=3.53.4 provider=openssl provider_version=OpenSSL 3.5.7 9 Jun 2026',
    'PASS qTox/SQLCipher-4 SHA-512 wrong-key rejection',
    'PASS qTox/SQLCipher-4 SHA-512 encrypted qTox-schema round trip',
    'PASS qTox compatibility SHA-1/4096 wrong-key rejection',
    'PASS qTox compatibility SHA-1/4096 encrypted qTox-schema round trip',
    'PASS legacy SQLCipher-3 SHA-1/1024 wrong-key rejection',
    'PASS legacy SQLCipher-3 SHA-1/1024 encrypted qTox-schema round trip',
    'PASS SQLCipher runtime smoke complete'
)
foreach ($marker in $expectedSmokeMarkers) {
    if (-not $smokeText.Contains($marker)) {
        throw "SQLCipher smoke output is missing marker: $marker"
    }
}

$scratchItem = Get-Item -LiteralPath $scratchRunRoot -ErrorAction Stop
if (($scratchItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Refusing to move a reparse-point scratch directory: $scratchRunRoot"
}
Move-Item -LiteralPath $scratchRunRoot -Destination $scratchArchiveRoot

$result = [ordered]@{
    sqlcipher = '4.18.0 community'
    sqlite = '3.53.4'
    openssl = '3.5.7'
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
    productionRuntimeReplaced = $false
}
$result | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $outputRoot 'build-result.json') -Encoding utf8
$result | ConvertTo-Json -Depth 6
