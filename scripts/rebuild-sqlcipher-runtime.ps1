[CmdletBinding()]
param(
    [ValidatePattern('^[A-Za-z0-9._-]+$')]
    [string]$RunName = 'canonical-rebuild',
    [string]$VsDevCmd = 'C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\Common7\Tools\VsDevCmd.bat'
)

# Builds an audited candidate under work/sqlcipher-rebuild only. Promotion to
# runtime/qtox-import is deliberately a separate, manual production decision.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$workRoot = Join-Path $projectRoot 'work\sqlcipher-rebuild'
$downloadRoot = Join-Path $workRoot 'downloads'
$runRoot = Join-Path $workRoot (Join-Path 'runs' $RunName)
$sourceDateEpoch = '1783435834' # SQLCipher v4.17.0 annotated tag date: 2026-07-07T14:50:34Z.
$canonicalOpenSslPrefix = Join-Path $workRoot 'install\openssl-3.5.7-repro-static'
$smokeSource = Join-Path $projectRoot 'scripts\tests\sqlcipher-runtime-smoke.c'

$sources = @(
    [pscustomobject]@{
        Name = 'sqlcipher-v4.17.0.tar.gz'
        Url = 'https://github.com/sqlcipher/sqlcipher/archive/refs/tags/v4.17.0.tar.gz'
        Sha256 = '79C0E164B9C059E7487BF8F29272F601CCA5F3312CC267461F81E349962A5058'
    },
    [pscustomobject]@{
        Name = 'openssl-3.5.7.tar.gz'
        Url = 'https://github.com/openssl/openssl/releases/download/openssl-3.5.7/openssl-3.5.7.tar.gz'
        Sha256 = 'A8C0D28A529CA480F9F36CF5792E2CD21984552A3C8E4AA11A24AA31AEAC98E8'
    },
    [pscustomobject]@{
        Name = 'strawberry-perl-5.34.3.1-64bit-portable.zip'
        Url = 'https://github.com/StrawberryPerl/Perl-Dist-Strawberry/releases/download/sp5.34.3.1/strawberry-perl-5.34.3.1-64bit-portable.zip'
        Sha256 = '94D312ED536BB5BEC8D4D8A069C19CF5F275364B94BB4DD93DA1C1AA5EF7652A'
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

New-Item -ItemType Directory -Path $workRoot -Force | Out-Null
New-Item -ItemType Directory -Path $downloadRoot -Force | Out-Null
New-Item -ItemType Directory -Path $runRoot | Out-Null

foreach ($source in $sources) {
    $archive = Join-Path $downloadRoot $source.Name
    if (-not (Test-Path -LiteralPath $archive -PathType Leaf)) {
        & curl.exe --fail --location --output $archive $source.Url
        if ($LASTEXITCODE -ne 0) {
            throw "Download failed: $($source.Url)"
        }
    }
    Assert-FileHash -Path $archive -Expected $source.Sha256
}

$opensslSource = Join-Path $runRoot 'openssl-3.5.7'
$sqlcipherA = Join-Path $runRoot 'sqlcipher-4.17.0-a'
$sqlcipherB = Join-Path $runRoot 'sqlcipher-4.17.0-b'
$perlRoot = Join-Path $runRoot 'strawberry-perl'
$outputRoot = Join-Path $runRoot 'output'
foreach ($directory in @($opensslSource, $sqlcipherA, $sqlcipherB, $perlRoot, $outputRoot)) {
    New-Item -ItemType Directory -Path $directory | Out-Null
}

& tar.exe -xzf (Join-Path $downloadRoot 'openssl-3.5.7.tar.gz') -C $opensslSource --strip-components=1
if ($LASTEXITCODE -ne 0) { throw 'Could not extract OpenSSL source.' }
foreach ($sqlcipherSource in @($sqlcipherA, $sqlcipherB)) {
    & tar.exe -xzf (Join-Path $downloadRoot 'sqlcipher-v4.17.0.tar.gz') -C $sqlcipherSource --strip-components=1
    if ($LASTEXITCODE -ne 0) { throw 'Could not extract SQLCipher source.' }
}
Expand-Archive -LiteralPath (Join-Path $downloadRoot 'strawberry-perl-5.34.3.1-64bit-portable.zip') -DestinationPath $perlRoot

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
    ' && set "SOURCE_DATE_EPOCH=' + $sourceDateEpoch + '" && nmake /NOLOGO'
) -LogPath $opensslBuildLog

$cipherDefines = '-DSQLITE_HAS_CODEC -DSQLITE_TEMP_STORE=2' +
    ' -DSQLITE_EXTRA_INIT=sqlcipher_extra_init' +
    ' -DSQLITE_EXTRA_SHUTDOWN=sqlcipher_extra_shutdown' +
    ' -DSQLCIPHER_CRYPTO_OPENSSL -I' + (Join-Path $opensslSource 'include')
$sqlcipherLogs = @()
foreach ($sqlcipherSource in @($sqlcipherA, $sqlcipherB)) {
    $label = Split-Path $sqlcipherSource -Leaf
    $log = Join-Path $runRoot ($label + '-build.log')
    $sqlcipherLogs += $log
    $build = 'cd /d "' + $sqlcipherSource + '"' +
        ' && set "SOURCE_DATE_EPOCH=' + $sourceDateEpoch + '"' +
        ' && nmake /NOLOGO /f Makefile.msc TOP=. USE_AMALGAMATION=1 DYNAMIC_SHELL=1' +
        ' PLATFORM=x64 USE_CRT_DLL=0 SYMBOLS=0' +
        ' SQLITE3DLL=libsqlcipher-0.dll SQLITE3LIB=libsqlcipher-0.lib' +
        ' "TCCOPTS=/Brepro"' +
        ' "LDOPTS=/Brepro /OPT:REF /OPT:ICF /INCREMENTAL:NO"' +
        ' "OPTS=' + $cipherDefines + '"' +
        ' "LTLIBPATHS=/LIBPATH:' + $opensslSource + '"' +
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

$smokeData = Join-Path $outputRoot 'smoke-data'
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
    'VERSIONS SQLCipher=4.17.0 community SQLite=3.53.3 provider=openssl provider_version=OpenSSL 3.5.7 9 Jun 2026',
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

$result = [ordered]@{
    sqlcipher = '4.17.0 community'
    sqlite = '3.53.3'
    openssl = '3.5.7'
    sourceDateEpoch = [int64]$sourceDateEpoch
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
