#requires -Version 7.6.5
[CmdletBinding()]
param(
    [string]$WebView2CabPath,
    [string]$ComponentCacheRoot = $env:KAIGEN_COMPONENT_CACHE_ROOT,
    [string]$PreparedNativeCacheRoot = $env:KAIGEN_PREPARED_NATIVE_CACHE_ROOT,
    [ValidateSet('auto', 'build-on-miss', 'expected-hit')]
    [string]$PreparedNativeCacheMode = $(if ([string]::IsNullOrWhiteSpace($env:KAIGEN_PREPARED_NATIVE_CACHE_MODE)) { 'expected-hit' } else { $env:KAIGEN_PREPARED_NATIVE_CACHE_MODE }),
    [switch]$BootstrapPreparedNativeCache,
    [switch]$PopulatePreparedNativeCacheOnly,
    [switch]$VerifyPreparedNativeCacheOnly,
    [string]$AcceptedPortableArchive,
    [string]$AcceptedPortableSha256,
    [string]$ArtifactsDir,
    [switch]$UiAcceptance
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$utf8NoBom = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $utf8NoBom
$OutputEncoding = $utf8NoBom
if ($PSVersionTable.PSVersion.ToString() -cne "7.6.5") {
    throw "Kaigen automation requires PowerShell 7.6.5 exactly; found $($PSVersionTable.PSVersion)."
}
$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
if ([string]::IsNullOrWhiteSpace($PreparedNativeCacheRoot)) {
    $PreparedNativeCacheRoot = [IO.Path]::GetFullPath((Join-Path $ProjectRoot '..\local-data\prepared-native-cache'))
    $PSBoundParameters['PreparedNativeCacheRoot'] = $PreparedNativeCacheRoot
} else {
    $PreparedNativeCacheRoot = [IO.Path]::GetFullPath($PreparedNativeCacheRoot)
    $PSBoundParameters['PreparedNativeCacheRoot'] = $PreparedNativeCacheRoot
}
if (@($BootstrapPreparedNativeCache, $PopulatePreparedNativeCacheOnly, $VerifyPreparedNativeCacheOnly).Where({ $_ }).Count -gt 1) {
    throw 'Prepared-native bootstrap, populate-only, and verify-only modes are mutually exclusive.'
}
if ($BootstrapPreparedNativeCache) {
    throw 'Accepted-output prepared-native bootstrap is disabled: no producer receipt binds the accepted Windows DLL/import-library bytes to the exact source tree and patch chain. Use -PopulatePreparedNativeCacheOnly for a fresh native-only build.'
}
if (-not [string]::IsNullOrWhiteSpace($AcceptedPortableArchive) -or
    -not [string]::IsNullOrWhiteSpace($AcceptedPortableSha256)) {
    throw 'Accepted portable identity cannot seed prepared-native cache without an exact producer receipt.'
}
if ($PopulatePreparedNativeCacheOnly -and $PreparedNativeCacheMode -cne 'build-on-miss') {
    throw 'Prepared-native populate-only mode requires -PreparedNativeCacheMode build-on-miss.'
}
if ($VerifyPreparedNativeCacheOnly -and $PreparedNativeCacheMode -cne 'expected-hit') {
    throw 'Prepared-native verify-only mode requires -PreparedNativeCacheMode expected-hit.'
}

# MSVC link.exe reads CMake/Ninja response files using the active Windows code
# page. A non-ASCII checkout path can therefore be corrupted even though
# PowerShell, CMake and Ninja handled it correctly. Re-enter this exact script
# through a temporary ASCII drive alias before any dependency or build path is
# derived. The outer invocation owns and always removes the alias.
$asciiReentryVariable = "KAIGEN_WINDOWS_BUILD_ASCII_REENTRY"
if ($ProjectRoot -match '[^\x00-\x7F]') {
    if ([Environment]::GetEnvironmentVariable($asciiReentryVariable, "Process") -ceq "1") {
        throw "Windows portable build still has a non-ASCII project path after ASCII re-entry: $ProjectRoot"
    }

    $substPath = Join-Path $env:SystemRoot "System32\subst.exe"
    if (-not (Test-Path -LiteralPath $substPath -PathType Leaf)) {
        throw "subst.exe is required to create the temporary ASCII Windows build alias."
    }
    $asciiAliasDrive = $null
    foreach ($codePoint in 90..68) {
        $candidateDrive = "{0}:" -f [char]$codePoint
        if (-not (Test-Path -LiteralPath ("{0}\" -f $candidateDrive))) {
            $asciiAliasDrive = $candidateDrive
            break
        }
    }
    if ($null -eq $asciiAliasDrive) {
        throw "No free drive letter is available for the temporary ASCII Windows build alias."
    }

    & $substPath $asciiAliasDrive $ProjectRoot
    if ($LASTEXITCODE -ne 0) {
        throw "Could not create the temporary ASCII Windows build alias $asciiAliasDrive for $ProjectRoot."
    }
    $aliasedScript = Join-Path ("{0}\" -f $asciiAliasDrive) "scripts\build-portable.ps1"
    $canonicalScript = Join-Path $PSScriptRoot "build-portable.ps1"
    $previousAsciiReentryValue = [Environment]::GetEnvironmentVariable($asciiReentryVariable, "Process")
    $aliasCleanupExitCode = 0
    try {
        if (-not (Test-Path -LiteralPath $aliasedScript -PathType Leaf)) {
            throw "The temporary ASCII Windows build alias has no portable build script."
        }
        $canonicalScriptHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $canonicalScript).Hash
        $aliasedScriptHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $aliasedScript).Hash
        if ($canonicalScriptHash -cne $aliasedScriptHash) {
            throw "The temporary ASCII Windows build alias does not resolve to the exact portable build script."
        }

        [Environment]::SetEnvironmentVariable($asciiReentryVariable, "1", "Process")
        Write-Host "Using temporary ASCII build alias $asciiAliasDrive for the Windows portable build."
        & $aliasedScript @PSBoundParameters
    } finally {
        [Environment]::SetEnvironmentVariable($asciiReentryVariable, $previousAsciiReentryValue, "Process")
        & $substPath $asciiAliasDrive /D
        $aliasCleanupExitCode = $LASTEXITCODE
        if ($aliasCleanupExitCode -ne 0) {
            Write-Warning "Could not remove temporary ASCII Windows build alias $asciiAliasDrive."
        }
    }
    if ($aliasCleanupExitCode -ne 0) {
        throw "The temporary ASCII Windows build alias $asciiAliasDrive could not be removed."
    }
    return
}

$validationProfile = if ($UiAcceptance) { "ui-acceptance" } else { "full" }
Write-Host "Windows validation profile: $validationProfile"
Write-Host "Managed component mode: canonical local copies only (network disabled)"
Write-Host "Prepared native cache mode: $PreparedNativeCacheMode"
$env:NPM_CONFIG_OFFLINE = "true"
$env:CARGO_NET_OFFLINE = "true"
$userProfile = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
if ([string]::IsNullOrWhiteSpace($userProfile) -and
    -not [string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
    $userProfile = $env:USERPROFILE
}
if ([string]::IsNullOrWhiteSpace($userProfile)) {
    throw "The Windows user profile path is unavailable; private Rust source paths cannot be remapped safely."
}
$resolvedUserProfile = [IO.Path]::GetFullPath($userProfile).TrimEnd('\')
if (-not [IO.Path]::IsPathRooted($resolvedUserProfile) -or
    -not (Test-Path -LiteralPath $resolvedUserProfile -PathType Container)) {
    throw "The Windows user profile path is invalid; private Rust source paths cannot be remapped safely."
}
if (-not [string]::IsNullOrWhiteSpace($env:RUSTFLAGS) -or
    -not [string]::IsNullOrWhiteSpace($env:CARGO_ENCODED_RUSTFLAGS)) {
    throw "Inherited Rust flags are not allowed in the reproducible portable build."
}
$rustPathRemapFlags = @(
    "--remap-path-prefix=$ProjectRoot=C:\KaigenRepro\source",
    "--remap-path-prefix=$resolvedUserProfile=C:\KaigenRepro\user"
)
$env:CARGO_ENCODED_RUSTFLAGS = $rustPathRemapFlags -join [char]0x1F
if ([string]::IsNullOrWhiteSpace($ArtifactsDir)) {
    $ArtifactsDir = Join-Path $ProjectRoot "artifacts"
} else {
    $ArtifactsDir = [IO.Path]::GetFullPath($ArtifactsDir)
}

function Get-TrackedWorktreeByteManifest {
    param([Parameter(Mandatory)][string]$Root)

    $gitCommand = Get-Command git.exe -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if (-not $gitCommand) {
        $gitCommand = Get-Command git -CommandType Application -ErrorAction SilentlyContinue |
            Select-Object -First 1
    }
    if (-not $gitCommand) { throw "git is required to guard the tracked Windows source tree." }
    $trackedPaths = @(& $gitCommand.Source -C $Root ls-files --cached --full-name)
    if ($LASTEXITCODE -ne 0) { throw "Could not enumerate tracked Windows source files." }

    $manifest = @{}
    foreach ($relativePath in $trackedPaths) {
        if ([string]::IsNullOrEmpty($relativePath)) { continue }
        $normalizedPath = $relativePath.Replace('\', '/')
        if ($normalizedPath -eq "src-tauri/gen/schemas" -or $normalizedPath.StartsWith("src-tauri/gen/schemas/", [StringComparison]::Ordinal)) {
            continue
        }
        $fullPath = Join-Path $Root $relativePath
        $manifest[$normalizedPath] = if (Test-Path -LiteralPath $fullPath -PathType Leaf) {
            (Get-FileHash -Algorithm SHA256 -LiteralPath $fullPath).Hash
        } else {
            "<missing>"
        }
    }
    return ,$manifest
}

function Assert-TrackedWorktreeByteManifestUnchanged {
    param(
        [Parameter(Mandatory)][hashtable]$Before,
        [Parameter(Mandatory)][hashtable]$After
    )

    $changed = New-Object Collections.Generic.List[string]
    foreach ($relativePath in $Before.Keys) {
        if (-not $After.ContainsKey($relativePath) -or $Before[$relativePath] -cne $After[$relativePath]) {
            $changed.Add($relativePath)
        }
    }
    foreach ($relativePath in $After.Keys) {
        if (-not $Before.ContainsKey($relativePath)) { $changed.Add($relativePath) }
    }
    if ($changed.Count -ne 0) {
        $changed.Sort()
        throw "Tracked worktree files changed during the portable build: $($changed -join ', ')"
    }
}

function Assert-BinaryDoesNotContainBuildHostPath {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string[]]$ForbiddenMarkers
    )

    $bytes = [IO.File]::ReadAllBytes($Path)
    $ascii = [Text.Encoding]::ASCII.GetString($bytes)
    $utf16 = [Text.Encoding]::Unicode.GetString($bytes)
    foreach ($marker in $ForbiddenMarkers) {
        if ($ascii.IndexOf($marker, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
            $utf16.IndexOf($marker, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
            throw "Built binary contains a private build-host path marker: $marker"
        }
    }
}

$trackedWorktreeBeforeBuild = Get-TrackedWorktreeByteManifest -Root $ProjectRoot

$preparedNativeCacheScript = Join-Path $PSScriptRoot 'prepared-native-cache-windows.ps1'
if (-not (Test-Path -LiteralPath $preparedNativeCacheScript -PathType Leaf) -or
    ((Get-Item -LiteralPath $preparedNativeCacheScript -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw "Windows prepared-native cache implementation is missing or unsafe: $preparedNativeCacheScript"
}
. $preparedNativeCacheScript

$cargoTarget = [IO.Path]::GetFullPath((Join-Path $ProjectRoot "src-tauri\target"))
$cargoTargetMarker = Join-Path $cargoTarget ".kaigen-project-root"
$recordedProjectRoot = if (Test-Path -LiteralPath $cargoTargetMarker) { [IO.File]::ReadAllText($cargoTargetMarker).Trim() } else { "" }
if ((Test-Path -LiteralPath $cargoTarget) -and $recordedProjectRoot -ne $ProjectRoot) {
    $allowedTauriRoot = [IO.Path]::GetFullPath((Join-Path $ProjectRoot "src-tauri")).TrimEnd('\') + '\'
    if (-not $cargoTarget.StartsWith($allowedTauriRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to discard a relocated Cargo target outside the project src-tauri directory: $cargoTarget"
    }
    Write-Host "Discarding a relocated Cargo/Tauri target: $cargoTarget"
    [IO.Directory]::Delete($cargoTarget, $true)
}
[IO.Directory]::CreateDirectory($cargoTarget) | Out-Null
[IO.File]::WriteAllText($cargoTargetMarker, $ProjectRoot, [Text.UTF8Encoding]::new($false))

& (Join-Path $PSScriptRoot "prepare-dependencies.ps1") -WebView2CabPath $WebView2CabPath -ComponentCacheRoot $ComponentCacheRoot -PreparedNativeInputsOnly

$vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
if (-not (Test-Path -LiteralPath $vswhere)) {
    throw "vswhere.exe was not found. Install Microsoft C++ Build Tools with Desktop development with C++."
}
$vsInstall = (& $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath).Trim()
if ([string]::IsNullOrWhiteSpace($vsInstall)) { throw "Microsoft C++ Build Tools were not found." }
$vsDevCmd = Join-Path $vsInstall "Common7\Tools\VsDevCmd.bat"
$devCommand = 'call "' + $vsDevCmd + '" -arch=x64 -host_arch=x64 >nul && set'
$cmdStageRoot = [IO.Path]::GetFullPath((Join-Path $ProjectRoot "work\cmd-staging"))
if ($cmdStageRoot -match '[^\x00-\x7F]' -or $vsDevCmd -match '[^\x00-\x7F]') {
    throw "Visual Studio batch initialisation requires the verified ASCII build staging path."
}
[IO.Directory]::CreateDirectory($cmdStageRoot) | Out-Null
$devCommandFile = Join-Path $cmdStageRoot ("vsdevcmd-environment-{0}.cmd" -f [guid]::NewGuid().ToString('N'))
$cmdStagePrefix = $cmdStageRoot.TrimEnd('\') + '\'
if (-not $devCommandFile.StartsWith($cmdStagePrefix, [StringComparison]::OrdinalIgnoreCase) -or
    [IO.Path]::GetFileName($devCommandFile) -notmatch '^vsdevcmd-environment-[a-f0-9]{32}[.]cmd$') {
    throw "Refusing an unsafe Visual Studio command staging path."
}
$cmdExecutable = Join-Path $env:SystemRoot "System32\cmd.exe"
try {
    [IO.File]::WriteAllLines(
        $devCommandFile,
        @('@echo off', $devCommand, 'if errorlevel 1 exit /b %errorlevel%'),
        [Text.Encoding]::ASCII
    )
    $environmentLines = & $cmdExecutable /d /s /c $devCommandFile
    $devCommandExitCode = $LASTEXITCODE
} finally {
    if (Test-Path -LiteralPath $devCommandFile -PathType Leaf) {
        [IO.File]::Delete($devCommandFile)
    }
}
if ($devCommandExitCode -ne 0) { throw "Could not initialise the Visual Studio build environment." }
foreach ($line in $environmentLines) {
    $separator = $line.IndexOf('=')
    if ($separator -gt 0) {
        Set-Item -LiteralPath ("Env:\" + $line.Substring(0, $separator)) -Value $line.Substring($separator + 1)
    }
}

$cmakeCommand = Get-Command cmake.exe -CommandType Application -ErrorAction SilentlyContinue |
    Select-Object -First 1
if ($cmakeCommand) {
    $cmake = $cmakeCommand.Source
} else {
    $cmake = Join-Path $vsInstall "Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe"
}
if (-not (Test-Path -LiteralPath $cmake)) { throw "cmake.exe was not found." }
$ninja = Join-Path $vsInstall "Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja\ninja.exe"
if (-not (Test-Path -LiteralPath $ninja)) { throw "Visual Studio Ninja was not found." }
$compiler = Get-ChildItem -Path (Join-Path $vsInstall "VC\Tools\MSVC\*\bin\Hostx64\x64\cl.exe") -File | Sort-Object FullName -Descending | Select-Object -First 1
if (-not $compiler) { throw "The x64 MSVC compiler was not found." }
$windowsSdkBin = "${env:ProgramFiles(x86)}\Windows Kits\10\bin"
$resourceCompiler = Get-ChildItem -Path (Join-Path $windowsSdkBin "*\x64\rc.exe") -File | Sort-Object FullName -Descending | Select-Object -First 1
$manifestTool = Get-ChildItem -Path (Join-Path $windowsSdkBin "*\x64\mt.exe") -File | Sort-Object FullName -Descending | Select-Object -First 1
if (-not $resourceCompiler -or -not $manifestTool) { throw "Windows SDK x64 rc.exe/mt.exe were not found." }
$env:RC = $resourceCompiler.FullName.Replace('\', '/')
$msvcRoot = Split-Path (Split-Path (Split-Path $compiler.DirectoryName -Parent) -Parent) -Parent
$sdkVersion = Split-Path $resourceCompiler.Directory.Parent.FullName -Leaf
$sdkIncludeRoot = Join-Path "${env:ProgramFiles(x86)}\Windows Kits\10\Include" $sdkVersion
$nativeIncludes = @(
    (Join-Path $msvcRoot "include"),
    (Join-Path $sdkIncludeRoot "ucrt"),
    (Join-Path $sdkIncludeRoot "shared"),
    (Join-Path $sdkIncludeRoot "um"),
    (Join-Path $sdkIncludeRoot "winrt"),
    (Join-Path $sdkIncludeRoot "cppwinrt")
)
$env:INCLUDE = ($nativeIncludes -join ";") + $(if ($env:INCLUDE) { ";$env:INCLUDE" } else { "" })
$sdkLibraryRoot = Join-Path "${env:ProgramFiles(x86)}\Windows Kits\10\Lib" $sdkVersion
$nativeLibraries = @(
    (Join-Path $msvcRoot "lib\x64"),
    (Join-Path $sdkLibraryRoot "ucrt\x64"),
    (Join-Path $sdkLibraryRoot "um\x64")
)
$env:LIB = ($nativeLibraries -join ";") + $(if ($env:LIB) { ";$env:LIB" } else { "" })
$toolDirectories = @(
    $compiler.DirectoryName,
    $resourceCompiler.DirectoryName,
    (Split-Path -Parent $ninja),
    (Split-Path -Parent $cmake)
)
$env:Path = ($toolDirectories -join ";") + ";" + $env:Path

$downloadDir = Join-Path $ProjectRoot 'work\downloads'
$toxArchive = Join-Path $downloadDir 'c-toxcore-1d79022fb4e56dffe0bbd075d47e00f7a0b62ab3.zip'
$cmpArchive = Join-Path $downloadDir 'cmp-52bfcfa17d2eb4322da2037ad625f5575129cece.zip'
$pthreadsArchive = Join-Path $downloadDir 'pthreads4w-44daa2441137b90477b449663abe9755b2c9a16b.zip'
$sodiumArchive = Join-Path $downloadDir 'libsodium-1.0.22-msvc.zip'
$torArchive = Join-Path $downloadDir 'tor-expert-bundle-windows-x86_64-15.0.20.tar.gz'
$sodiumDirectory = Join-Path $ProjectRoot 'work\deps\libsodium'
$torBundleDirectory = Join-Path $ProjectRoot 'work\deps\TorExpertBundle'
$torBundleMarker = Join-Path $ProjectRoot 'work\deps\TorExpertBundle.version'
$pthreadsSource = Join-Path $ProjectRoot 'work\deps\pthreads4w-dynamic'
$toxSource = Join-Path $ProjectRoot 'work\toxcore-meta'
$toxBuild = [IO.Path]::GetFullPath((Join-Path $ProjectRoot 'work\build\toxcore-native-windows'))
$sodiumConfig = Join-Path $ProjectRoot 'cmake\libsodium'
$pthreadsConfig = Join-Path $ProjectRoot 'cmake\pthreads4w\pthreadsConfig.cmake'
$pkgConfigStub = Join-Path $PSScriptRoot 'pkg-config-stub.cmd'
$preparedResolveRoot = Join-Path $ProjectRoot 'work\prepared-native-resolved\windows-x64'
$preparedNativeResults = [Collections.Generic.List[object]]::new()
$systemTar = Join-Path $env:SystemRoot 'System32\tar.exe'
$nmake = Join-Path $compiler.DirectoryName 'nmake.exe'
$linker = Join-Path $compiler.DirectoryName 'link.exe'
$dumpbin = Join-Path $compiler.DirectoryName 'dumpbin.exe'
foreach ($requiredTool in @($systemTar, $nmake, $linker, $dumpbin, $cmake, $ninja, $resourceCompiler.FullName, $manifestTool.FullName)) {
    Assert-KaigenOrdinaryFile -Path $requiredTool -Description 'Windows native toolchain input' | Out-Null
}

$pthreadsNmakeArguments = @(
    '/f', 'Makefile', '/E', '/nologo', 'XCFLAGS=/MT',
    'EHFLAGS=/I. /DHAVE_CONFIG_H /W3 /O2 /Ob2 /D__PTW32_BUILD_INLINED',
    'CLEANUP=__PTW32_CLEANUP_C', 'XLIBS=/Brepro', 'pthreadVC3.dll'
)
$toxcoreCMakeOptions = @(
    '-DCMAKE_BUILD_TYPE=Release', '-DCMAKE_WINDOWS_EXPORT_ALL_SYMBOLS=ON',
    '-DCMAKE_SHARED_LINKER_FLAGS=/Brepro',
    '-DMSVC_STATIC_SODIUM=ON', '-DBUILD_TOXAV=OFF', '-DBOOTSTRAP_DAEMON=OFF',
    '-DAUTOTEST=OFF'
)

function Invoke-KaigenWindowsLibsodiumProducer {
    param([Parameter(Mandatory)][string]$OutputRoot)

    $expandedRoot = Join-Path $OutputRoot '_expanded-upstream'
    $preparedPrefix = Join-Path $OutputRoot 'libsodium'
    try {
        Expand-Archive -LiteralPath $sodiumArchive -DestinationPath $expandedRoot
        $upstreamPrefix = Join-Path $expandedRoot 'libsodium'
        $upstreamInclude = Join-Path $upstreamPrefix 'include'
        $upstreamLibrary = Join-Path $upstreamPrefix 'x64\Release\v143\static\libsodium.lib'
        Assert-KaigenOrdinaryFile -Path (Join-Path $upstreamInclude 'sodium.h') -Description 'Upstream libsodium header' | Out-Null
        Assert-KaigenOrdinaryFile -Path $upstreamLibrary -Description 'Upstream libsodium x64 Release static library' | Out-Null
        New-Item -ItemType Directory -Path $preparedPrefix -Force | Out-Null
        Copy-Item -LiteralPath $upstreamInclude -Destination $preparedPrefix -Recurse
        $preparedLibraryDirectory = Join-Path $preparedPrefix 'x64\Release\v143\static'
        New-Item -ItemType Directory -Path $preparedLibraryDirectory -Force | Out-Null
        Copy-Item -LiteralPath $upstreamLibrary -Destination (Join-Path $preparedLibraryDirectory 'libsodium.lib')
    } finally {
        if (Test-Path -LiteralPath $expandedRoot) {
            Remove-Item -LiteralPath $expandedRoot -Recurse -Force
        }
    }
    Assert-KaigenOrdinaryFile -Path (Join-Path $preparedPrefix 'x64\Release\v143\static\libsodium.lib') -Description 'Prepared libsodium library' | Out-Null
    Assert-KaigenOrdinaryFile -Path (Join-Path $preparedPrefix 'include\sodium.h') -Description 'Prepared libsodium header' | Out-Null
    $unexpectedOutputs = @(Get-ChildItem -LiteralPath $preparedPrefix -File -Recurse | Where-Object {
        $relative = [IO.Path]::GetRelativePath($preparedPrefix, $_.FullName).Replace('\', '/')
        -not ($relative.StartsWith('include/', [StringComparison]::Ordinal) -or
            $relative -ceq 'x64/Release/v143/static/libsodium.lib')
    })
    if ($unexpectedOutputs.Count -ne 0) {
        throw "Prepared libsodium output contains files outside the exact headers/static-library contract."
    }
}

function Invoke-KaigenWindowsTorProducer {
    param([Parameter(Mandatory)][string]$OutputRoot)

    & $systemTar -xzf $torArchive -C $OutputRoot
    if ($LASTEXITCODE -ne 0) { throw "Tor Expert Bundle preparation failed with exit code $LASTEXITCODE" }
    Assert-KaigenOrdinaryFile -Path (Join-Path $OutputRoot 'tor\tor.exe') -Description 'Prepared Tor runtime' | Out-Null
    Assert-KaigenOrdinaryFile -Path (Join-Path $OutputRoot 'tor\pluggable_transports\lyrebird.exe') -Description 'Prepared Tor transport' | Out-Null
    Assert-KaigenOrdinaryFile -Path (Join-Path $OutputRoot 'tor\pluggable_transports\conjure-client.exe') -Description 'Prepared Tor transport' | Out-Null
}

function Assert-KaigenWindowsToxcoreExports {
    param([Parameter(Mandatory)][string]$Library)

    Assert-KaigenOrdinaryFile -Path $Library -Description 'Prepared c-toxcore DLL' | Out-Null
    $exports = (& $dumpbin /exports $Library 2>&1 | Out-String)
    if ($LASTEXITCODE -ne 0) {
        throw "Could not inspect c-toxcore DLL exports: $Library"
    }
    foreach ($requiredExport in @('tox_new', 'tox_iterate', 'tox_self_get_address', 'tox_pass_key_encrypt')) {
        if ($exports -notmatch "(?m)\b$([regex]::Escape($requiredExport))\s*$") {
            throw "c-toxcore DLL is missing the required export $requiredExport. Refusing to publish or package it."
        }
    }
}

function Assert-KaigenWindowsToxcoreImportRuntime {
    param([Parameter(Mandatory)][string]$OutputRoot)

    $probeRoot = Join-Path (Split-Path -Parent $OutputRoot) ('.toxcore-import-runtime-probe-' + [guid]::NewGuid().ToString('N'))
    try {
        [IO.Directory]::CreateDirectory($probeRoot) | Out-Null
        foreach ($name in @('toxcore.dll', 'toxcore.lib', 'pthreadVC3.dll')) {
            Copy-Item -LiteralPath (Join-Path $OutputRoot $name) -Destination (Join-Path $probeRoot $name)
        }
        $probeSource = Join-Path $probeRoot 'probe.c'
        $probeObject = Join-Path $probeRoot 'probe.obj'
        $probeExecutable = Join-Path $probeRoot 'probe.exe'
        $probeProgram = @'
#include <stdint.h>
__declspec(dllimport) uint32_t __cdecl tox_version_major(void);
__declspec(dllimport) uint32_t __cdecl tox_version_minor(void);
__declspec(dllimport) uint32_t __cdecl tox_version_patch(void);
int main(void) {
    return tox_version_major() == 0 && tox_version_minor() == 2 && tox_version_patch() == 23 ? 0 : 97;
}
'@
        [IO.File]::WriteAllText($probeSource, $probeProgram, [Text.UTF8Encoding]::new($false))
        $probeCompiler = [string]$compiler.FullName
        & $probeCompiler '/nologo' '/W4' '/WX' '/MT' $probeSource "/Fo$probeObject" "/Fe$probeExecutable" `
            '/link' "/LIBPATH:$probeRoot" 'toxcore.lib'
        if ($LASTEXITCODE -ne 0) { throw 'Fresh Windows toxcore import-library link probe failed.' }

        $probeProcess = [Diagnostics.Process]::new()
        try {
            $probeProcess.StartInfo.FileName = $probeExecutable
            $probeProcess.StartInfo.WorkingDirectory = $probeRoot
            $probeProcess.StartInfo.UseShellExecute = $false
            $probeProcess.StartInfo.CreateNoWindow = $true
            if (-not $probeProcess.Start()) { throw 'Fresh Windows toxcore runtime probe could not be started.' }
            if (-not $probeProcess.WaitForExit(15000)) {
                $probeProcess.Kill($true)
                $probeProcess.WaitForExit()
                throw 'Fresh Windows toxcore runtime probe timed out.'
            }
            if ($probeProcess.ExitCode -ne 0) {
                throw "Fresh Windows toxcore runtime probe rejected pinned version 0.2.23 with exit code $($probeProcess.ExitCode)."
            }
        } finally {
            $probeProcess.Dispose()
        }
    } finally {
        Remove-KaigenTemporaryTree -Root $probeRoot
    }
}

function Invoke-KaigenWindowsToxcoreProducer {
    param([Parameter(Mandatory)][string]$OutputRoot)

    if ([string]::IsNullOrWhiteSpace($script:KaigenToxProducerWorkRoot)) {
        throw 'The stable c-toxcore producer workspace was not initialized.'
    }
    $producerWork = [IO.Path]::GetFullPath($script:KaigenToxProducerWorkRoot)
    $allowedProducerRoot = [IO.Path]::GetFullPath((Join-Path $ProjectRoot 'work\prepared-native-producer\windows-x64\c-toxcore')).TrimEnd('\') + '\'
    if (-not $producerWork.StartsWith($allowedProducerRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing an unsafe c-toxcore producer workspace: $producerWork"
    }
    [IO.Directory]::CreateDirectory((Split-Path -Parent $producerWork)) | Out-Null
    $producerLock = $null
    for ($attempt = 0; $attempt -lt 120 -and $null -eq $producerLock; $attempt += 1) {
        try {
            $producerLock = [IO.File]::Open("$producerWork.lock", [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
        } catch [IO.IOException] {
            if ($attempt -eq 119) { throw 'Timed out waiting for the stable c-toxcore producer workspace lock.' }
            Start-Sleep -Milliseconds 250
        }
    }
    try {
        Remove-KaigenTemporaryTree -Root $producerWork
        [IO.Directory]::CreateDirectory($producerWork) | Out-Null
        $pthreadExtract = Join-Path $producerWork 'pthreads-source'
        Expand-Archive -LiteralPath $pthreadsArchive -DestinationPath $pthreadExtract
        $pthreadCandidates = @(Get-ChildItem -LiteralPath $pthreadExtract -Directory -Force)
        if ($pthreadCandidates.Count -ne 1 -or -not (Test-Path -LiteralPath (Join-Path $pthreadCandidates[0].FullName 'pthread.h') -PathType Leaf)) {
            throw 'The pinned pthreads4w archive has an unexpected producer layout.'
        }
        $freshPthreads = $pthreadCandidates[0].FullName
        Push-Location $freshPthreads
        try {
            & $nmake @pthreadsNmakeArguments
            if ($LASTEXITCODE -ne 0) { throw 'Portable pthreads4w prepared-cache build failed.' }
        } finally {
            Pop-Location
        }

        $freshToxBuild = Join-Path $producerWork 'toxcore-build'
        & $cmake -S $toxSource -B $freshToxBuild -G Ninja `
            "-DCMAKE_MAKE_PROGRAM=$ninja" `
            "-DCMAKE_C_COMPILER=$($compiler.FullName)" `
            "-DCMAKE_CXX_COMPILER=$($compiler.FullName)" `
            "-DCMAKE_RC_COMPILER=$($resourceCompiler.FullName.Replace('\', '/'))" `
            "-DCMAKE_MT=$($manifestTool.FullName.Replace('\', '/'))" `
            @toxcoreCMakeOptions `
            "-Dlibsodium_DIR=$sodiumConfig" `
            "-Dpthreads_DIR=$(Split-Path -Parent $pthreadsConfig)" `
            "-DPTHREADS4W_ROOT=$freshPthreads" `
            "-DPKG_CONFIG_EXECUTABLE=$pkgConfigStub"
        if ($LASTEXITCODE -ne 0) { throw 'c-toxcore prepared-cache CMake configuration failed.' }
        & $cmake --build $freshToxBuild --config Release --target toxcore_shared
        if ($LASTEXITCODE -ne 0) { throw 'c-toxcore prepared-cache build failed.' }

        foreach ($mapping in @(
            @((Join-Path $freshToxBuild 'toxcore.dll'), (Join-Path $OutputRoot 'toxcore.dll')),
            @((Join-Path $freshToxBuild 'toxcore.lib'), (Join-Path $OutputRoot 'toxcore.lib')),
            @((Join-Path $freshPthreads 'pthreadVC3.dll'), (Join-Path $OutputRoot 'pthreadVC3.dll'))
        )) {
            Assert-KaigenOrdinaryFile -Path $mapping[0] -Description 'Fresh Windows native producer output' | Out-Null
            Copy-Item -LiteralPath $mapping[0] -Destination $mapping[1]
        }
        Assert-KaigenWindowsToxcoreExports -Library (Join-Path $OutputRoot 'toxcore.dll')
        Assert-KaigenWindowsToxcoreImportRuntime -OutputRoot $OutputRoot
    } finally {
        Remove-KaigenTemporaryTree -Root $producerWork
        if ($null -ne $producerLock) { $producerLock.Dispose() }
    }
}

function New-KaigenWindowsBaseContractFields {
    param([Parameter(Mandatory)][string]$OutputContract, [Parameter(Mandatory)][string]$RecipeSha256)

    $fields = [ordered]@{
        architecture = 'x86_64'
        abi = 'windows-msvc-static-crt'
        deployment_target = 'windows-10-x64'
        'output.contract' = $OutputContract
        'recipe.sha256' = $RecipeSha256
        'toolchain.powershell.version' = $PSVersionTable.PSVersion.ToString()
        'toolchain.msvc.version' = (Split-Path $msvcRoot -Leaf)
        'toolchain.windows_sdk.version' = $sdkVersion
    }
    return $fields
}

function Add-KaigenWindowsCompilerContract {
    param([Parameter(Mandatory)][Collections.IDictionary]$Fields)

    foreach ($tool in @(
        @('toolchain.cl', $compiler.FullName), @('toolchain.link', $linker),
        @('toolchain.nmake', $nmake), @('toolchain.dumpbin', $dumpbin),
        @('toolchain.cmake', $cmake), @('toolchain.ninja', $ninja),
        @('toolchain.rc', $resourceCompiler.FullName), @('toolchain.mt', $manifestTool.FullName)
    )) {
        Add-KaigenContractFileIdentity -Fields $Fields -Prefix $tool[0] -Path $tool[1]
    }
    foreach ($sysrootFile in @(
        @('toolchain.sysroot.windows_h', (Join-Path $sdkIncludeRoot 'um\Windows.h')),
        @('toolchain.sysroot.corecrt_h', (Join-Path $sdkIncludeRoot 'ucrt\corecrt.h')),
        @('toolchain.sysroot.ucrt_lib', (Join-Path $sdkLibraryRoot 'ucrt\x64\ucrt.lib')),
        @('toolchain.sysroot.kernel32_lib', (Join-Path $sdkLibraryRoot 'um\x64\kernel32.lib'))
    )) {
        Add-KaigenContractFileIdentity -Fields $Fields -Prefix $sysrootFile[0] -Path $sysrootFile[1]
    }
}

$libsodiumRecipeSha = Get-KaigenPowerShellRecipeSha256 -Value ((Get-Command Invoke-KaigenWindowsLibsodiumProducer).Definition)
$libsodiumFields = New-KaigenWindowsBaseContractFields -OutputContract 'libsodium-msvc-x64-release-static-consumer-v3' -RecipeSha256 $libsodiumRecipeSha
Add-KaigenContractFileIdentity -Fields $libsodiumFields -Prefix 'input.libsodium' -Path $sodiumArchive
$libsodiumFields['transform'] = 'extract-copy-headers-and-x64-release-v143-static-only'
$libsodiumContract = New-KaigenPreparedNativeContract -Group libsodium -Fields $libsodiumFields -RequiredOutputs @(
    'libsodium/x64/Release/v143/static/libsodium.lib', 'libsodium/include/sodium.h'
)
$libsodiumResult = Resolve-KaigenPreparedNativeGroup -CacheRoot $PreparedNativeCacheRoot -Contract $libsodiumContract `
    -Destination $sodiumDirectory -Producer ${function:Invoke-KaigenWindowsLibsodiumProducer} -Mode $PreparedNativeCacheMode `
    -ProducerMode 'deterministic-materialization-miss'
$preparedNativeResults.Add($libsodiumResult)

$torRecipeSha = Get-KaigenPowerShellRecipeSha256 -Value ((Get-Command Invoke-KaigenWindowsTorProducer).Definition)
$torFields = New-KaigenWindowsBaseContractFields -OutputContract 'tor-expert-bundle-windows-x64-v2' -RecipeSha256 $torRecipeSha
Add-KaigenContractFileIdentity -Fields $torFields -Prefix 'input.tor.x86_64' -Path $torArchive
Add-KaigenContractFileIdentity -Fields $torFields -Prefix 'toolchain.tar' -Path $systemTar
$torFields['transform'] = 'verified-extract-windows-runtime'
$torContract = New-KaigenPreparedNativeContract -Group tor-universal -Fields $torFields -RequiredOutputs @(
    'tor/tor.exe', 'tor/pluggable_transports/lyrebird.exe', 'tor/pluggable_transports/conjure-client.exe'
)
$torResult = Resolve-KaigenPreparedNativeGroup -CacheRoot $PreparedNativeCacheRoot -Contract $torContract `
    -Destination $torBundleDirectory -Producer ${function:Invoke-KaigenWindowsTorProducer} -Mode $PreparedNativeCacheMode `
    -ProducerMode 'deterministic-materialization-miss'
$preparedNativeResults.Add($torResult)
[IO.File]::WriteAllText($torBundleMarker, "15.0.20`n", [Text.UTF8Encoding]::new($false))

# Materialize and verify only the remaining source/runtime inputs. Restored
# libsodium and Tor directories already satisfy their exact prepared contracts;
# this step never compiles c-toxcore or pthreads4w.
& (Join-Path $PSScriptRoot 'prepare-dependencies.ps1') -WebView2CabPath $WebView2CabPath -ComponentCacheRoot $ComponentCacheRoot

$patchManifestPath = Join-Path $ProjectRoot 'patches\c-toxcore\security-v4\patch-manifest.json'
$patchManifest = Get-Content -LiteralPath $patchManifestPath -Raw | ConvertFrom-Json
$toxRecipe = ((Get-Command Invoke-KaigenWindowsToxcoreProducer).Definition) + "`n" + ($pthreadsNmakeArguments -join "`n") + "`n" + ($toxcoreCMakeOptions -join "`n")
$toxFields = New-KaigenWindowsBaseContractFields -OutputContract 'toxcore-dll-importlib-pthreads-runtime-v2' `
    -RecipeSha256 (Get-KaigenPowerShellRecipeSha256 -Value $toxRecipe)
Add-KaigenWindowsCompilerContract -Fields $toxFields
$toxFields['component.toxcore.version'] = '0.2.23'
$toxFields['component.toxcore.commit'] = '1d79022fb4e56dffe0bbd075d47e00f7a0b62ab3'
Add-KaigenContractFileIdentity -Fields $toxFields -Prefix 'input.toxcore' -Path $toxArchive
Add-KaigenContractFileIdentity -Fields $toxFields -Prefix 'input.cmp' -Path $cmpArchive
Add-KaigenContractFileIdentity -Fields $toxFields -Prefix 'input.pthreads4w' -Path $pthreadsArchive
Add-KaigenContractFileIdentity -Fields $toxFields -Prefix 'input.libsodium' -Path $sodiumArchive
Add-KaigenContractFileIdentity -Fields $toxFields -Prefix 'patch.manifest' -Path $patchManifestPath
Add-KaigenContractCanonicalTextIdentity -Fields $toxFields -Prefix 'config.libsodium' -Path (Join-Path $sodiumConfig 'libsodiumConfig.cmake')
Add-KaigenContractCanonicalTextIdentity -Fields $toxFields -Prefix 'config.pthreads' -Path $pthreadsConfig
Add-KaigenContractCanonicalTextIdentity -Fields $toxFields -Prefix 'config.pkg_stub' -Path $pkgConfigStub
$toxFields['patch.series.tree.sha256'] = Get-KaigenTreeSha256 -Root (Join-Path $ProjectRoot 'patches\c-toxcore')
$toxFields['patch.series'] = [string]$patchManifest.series
$toxFields['patch.count'] = ([int]$patchManifest.patches.Count).ToString([Globalization.CultureInfo]::InvariantCulture)
$toxFields['source.materialized_base_tree'] = [string]$patchManifest.applicationBase.materializedBaseline.tree
$toxFields['source.result_tree'] = [string]$patchManifest.candidate.headTree
$toxFields['dependency.libsodium.fingerprint'] = $libsodiumResult.Fingerprint
$toxFields['dependency.libsodium.output_manifest.sha256'] = $libsodiumResult.OutputManifestSha256
$toxFields['flags.cmake'] = $toxcoreCMakeOptions -join ';'
$toxFields['flags.pthreads4w'] = $pthreadsNmakeArguments -join ';'
$toxFields['producer.mode'] = 'compiled-miss'
$toxContract = New-KaigenPreparedNativeContract -Group c-toxcore -Fields $toxFields -RequiredOutputs @(
    'toxcore.dll', 'toxcore.lib', 'pthreadVC3.dll'
)
$script:KaigenToxProducerWorkRoot = Join-Path $ProjectRoot "work\prepared-native-producer\windows-x64\c-toxcore\$($toxContract.Fingerprint)"
$toxResolved = Join-Path $preparedResolveRoot 'c-toxcore'
$toxResult = Resolve-KaigenPreparedNativeGroup -CacheRoot $PreparedNativeCacheRoot -Contract $toxContract `
    -Destination $toxResolved -Producer ${function:Invoke-KaigenWindowsToxcoreProducer} `
    -Mode $PreparedNativeCacheMode -ProducerMode 'compiled-miss' -ForceProducer:$PopulatePreparedNativeCacheOnly
$preparedNativeResults.Add($toxResult)

$allowedBuildRoot = [IO.Path]::GetFullPath((Join-Path $ProjectRoot 'work\build')).TrimEnd('\') + '\'
if (-not $toxBuild.StartsWith($allowedBuildRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to replace Windows c-toxcore output outside the project build directory: $toxBuild"
}
if (Test-Path -LiteralPath $toxBuild) { [IO.Directory]::Delete($toxBuild, $true) }
[IO.Directory]::CreateDirectory($toxBuild) | Out-Null
Copy-Item -LiteralPath (Join-Path $toxResolved 'toxcore.dll') -Destination (Join-Path $toxBuild 'toxcore.dll')
Copy-Item -LiteralPath (Join-Path $toxResolved 'toxcore.lib') -Destination (Join-Path $toxBuild 'toxcore.lib')
$pthreadsRuntime = Join-Path $pthreadsSource 'pthreadVC3.dll'
if (Test-Path -LiteralPath $pthreadsRuntime) {
    (Get-Item -LiteralPath $pthreadsRuntime -Force).IsReadOnly = $false
    [IO.File]::Delete($pthreadsRuntime)
}
Copy-Item -LiteralPath (Join-Path $toxResolved 'pthreadVC3.dll') -Destination $pthreadsRuntime
$toxcoreDll = Join-Path $toxBuild 'toxcore.dll'
$toxcoreLibrary = Join-Path $toxBuild 'toxcore.lib'
foreach ($preparedFile in @($pthreadsRuntime, $toxcoreDll, $toxcoreLibrary)) {
    Assert-KaigenOrdinaryFile -Path $preparedFile -Description 'Resolved Windows prepared-native output' | Out-Null
}

Assert-KaigenWindowsToxcoreExports -Library $toxcoreDll

if ($PopulatePreparedNativeCacheOnly -or $VerifyPreparedNativeCacheOnly) {
    [IO.Directory]::CreateDirectory($ArtifactsDir) | Out-Null
    $operation = if ($PopulatePreparedNativeCacheOnly) { 'native-only-populate' } else { 'expected-hit-verification' }
    $receiptPath = Join-Path $ArtifactsDir "prepared-native-cache-windows-x64-$operation.json"
    Write-KaigenPreparedNativeReceipt -Path $receiptPath -Groups $preparedNativeResults.ToArray() -ApplicationRebuilt $false
    $trackedWorktreeAfterCacheOperation = Get-TrackedWorktreeByteManifest -Root $ProjectRoot
    Assert-TrackedWorktreeByteManifestUnchanged -Before $trackedWorktreeBeforeBuild -After $trackedWorktreeAfterCacheOperation
    Write-Host "Prepared native $operation completed without rebuilding the Kaigen application."
    Write-Host "Prepared native receipt: $receiptPath"
    return
}

# These regressions deliberately use disposable fixtures and in-memory
# savedata. They belong to the full candidate gate; a visual-only acceptance
# reuses the same freshly verified exports and defers unrelated native suites.
if ($UiAcceptance) {
    Write-Host "UI acceptance: native retry-cap and offline loopback suites deferred to the next full candidate gate."
} else {
    & (Join-Path $PSScriptRoot "test-prepared-native-cache-windows.ps1")
    & (Join-Path $PSScriptRoot "test-toxcore-retry-cap.ps1")
    & (Join-Path $PSScriptRoot "test-offline-friend-request-loopback.ps1")
}

Push-Location $ProjectRoot
try {
    $packageLockHash = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $ProjectRoot "package-lock.json")).Hash.ToLowerInvariant()
    $dependencyMarker = Join-Path $ProjectRoot "node_modules\.kaigen-package-lock.sha256"
    $dependencyCacheCurrent = (Test-Path -LiteralPath $dependencyMarker -PathType Leaf) `
        -and ([IO.File]::ReadAllText($dependencyMarker).Trim().ToLowerInvariant() -ceq $packageLockHash) `
        -and (Test-Path -LiteralPath (Join-Path $ProjectRoot "node_modules\.bin\tauri.cmd") -PathType Leaf)
    if (-not $UiAcceptance -or -not $dependencyCacheCurrent) {
        & npm.cmd ci --offline
        if ($LASTEXITCODE -ne 0) { throw "npm ci failed." }
        [IO.File]::WriteAllText($dependencyMarker, "$packageLockHash`n", [Text.UTF8Encoding]::new($false))
    } else {
        Write-Host "UI acceptance: reusing dependency cache verified against package-lock.json."
    }
    if ($UiAcceptance) {
        & npm.cmd run test:app-layout
        if ($LASTEXITCODE -ne 0) { throw "UI layout regression tests failed." }
        & npm.cmd run test:localization
        if ($LASTEXITCODE -ne 0) { throw "UI localization regression tests failed." }
        & git diff --check
        if ($LASTEXITCODE -ne 0) { throw "git diff --check failed." }
        Write-Host "UI acceptance: full frontend, Rust, and native component suites deferred to the next full candidate gate."
    } else {
        & npm.cmd run test:frontend
        if ($LASTEXITCODE -ne 0) { throw "Frontend regression tests failed." }
        & cargo test --locked --manifest-path "src-tauri\Cargo.toml" --lib
        if ($LASTEXITCODE -ne 0) { throw "Rust tests failed." }
    }
    & npm.cmd run tauri -- build --no-bundle
    if ($LASTEXITCODE -ne 0) { throw "Tauri release build failed." }
    & npm.cmd run test:built-content-security -- dist
    if ($LASTEXITCODE -ne 0) { throw "Built content security regression tests failed." }
} finally {
    Pop-Location
}

$kaigenExecutable = Join-Path $ProjectRoot "src-tauri\target\release\Kaigen.exe"
Assert-BinaryDoesNotContainBuildHostPath -Path $kaigenExecutable -ForbiddenMarkers @(
    $resolvedUserProfile,
    $resolvedUserProfile.Replace('\', '/')
)

$trackedWorktreeAfterCompilation = Get-TrackedWorktreeByteManifest -Root $ProjectRoot
Assert-TrackedWorktreeByteManifestUnchanged -Before $trackedWorktreeBeforeBuild -After $trackedWorktreeAfterCompilation

[IO.Directory]::CreateDirectory($ArtifactsDir) | Out-Null
$stage = [IO.Path]::GetFullPath((Join-Path $ArtifactsDir "Kaigen-portable"))
$artifactsRoot = [IO.Path]::GetFullPath($ArtifactsDir).TrimEnd('\') + '\'
if (-not $stage.StartsWith($artifactsRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to create staging outside artifacts: $stage"
}
if (Test-Path -LiteralPath $stage) { [IO.Directory]::Delete($stage, $true) }
[IO.Directory]::CreateDirectory($stage) | Out-Null
[IO.Directory]::CreateDirectory((Join-Path $stage "data")) | Out-Null
[IO.Directory]::CreateDirectory((Join-Path $stage "downloads")) | Out-Null

Copy-Item -LiteralPath $kaigenExecutable -Destination (Join-Path $stage "Kaigen.exe")
Copy-Item -LiteralPath (Join-Path $toxBuild "toxcore.dll") -Destination (Join-Path $stage "toxcore.dll")
Copy-Item -LiteralPath $pthreadsRuntime -Destination (Join-Path $stage "pthreadVC3.dll")
$webViewRuntimeCache = Join-Path $ProjectRoot "work\deps\WebView2Runtime"
$webViewRuntimeExecutables = @(Get-ChildItem -LiteralPath $webViewRuntimeCache -Filter "msedgewebview2.exe" -File -Recurse)
if ($webViewRuntimeExecutables.Count -ne 1) {
    throw "Expected exactly one msedgewebview2.exe in the pinned WebView2 runtime cache; found $($webViewRuntimeExecutables.Count)."
}
$webViewRuntimeSource = $webViewRuntimeExecutables[0].Directory.FullName
$webViewRuntimeStage = Join-Path $stage "WebView2Runtime"
[IO.Directory]::CreateDirectory($webViewRuntimeStage) | Out-Null
foreach ($entry in Get-ChildItem -LiteralPath $webViewRuntimeSource -Force) {
    Copy-Item -LiteralPath $entry.FullName -Destination $webViewRuntimeStage -Recurse -Force
}
$packagedWebViewExecutable = Join-Path $webViewRuntimeStage "msedgewebview2.exe"
if (-not (Test-Path -LiteralPath $packagedWebViewExecutable -PathType Leaf)) {
    throw "The portable WebView2 runtime must be packaged directly under WebView2Runtime."
}
$nestedWebViewExecutables = @(
    Get-ChildItem -LiteralPath $webViewRuntimeStage -Filter "msedgewebview2.exe" -File -Recurse |
        Where-Object { $_.FullName -cne $packagedWebViewExecutable }
)
if ($nestedWebViewExecutables.Count -gt 0) {
    throw "A nested WebView2 runtime executable was packaged: $($nestedWebViewExecutables[0].FullName)"
}
$webViewRuntimeFiles = @(Get-ChildItem -LiteralPath $webViewRuntimeStage -File -Force -Recurse)
if ($webViewRuntimeFiles.Count -eq 0) {
    throw "The portable WebView2 runtime is empty."
}
$webViewRuntimePrefixLength = $webViewRuntimeStage.Length + 1
$webViewRuntimeMaximumRelativePathLength = (
    $webViewRuntimeFiles |
        ForEach-Object { $_.FullName.Length - $webViewRuntimePrefixLength } |
        Measure-Object -Maximum
).Maximum
$webViewRuntimeMaximumFullPathLength = $webViewRuntimeStage.Length + 1 + $webViewRuntimeMaximumRelativePathLength
if ($webViewRuntimeMaximumFullPathLength -ge 260) {
    throw "The packaged WebView2 runtime exceeds the Windows MAX_PATH budget ($webViewRuntimeMaximumFullPathLength UTF-16 units). Use a shorter artifacts path."
}
[IO.File]::WriteAllText(
    (Join-Path $webViewRuntimeStage "KAIGEN_MAX_RELATIVE_PATH_UTF16.txt"),
    "$webViewRuntimeMaximumRelativePathLength`n",
    $utf8NoBom
)
Copy-Item -LiteralPath (Join-Path $ProjectRoot "work\deps\TorExpertBundle") -Destination (Join-Path $stage "TorExpertBundle") -Recurse
Copy-Item -LiteralPath (Join-Path $ProjectRoot "runtime") -Destination (Join-Path $stage "runtime") -Recurse
Copy-Item -LiteralPath (Join-Path $ProjectRoot "packaging\PORTABLE.txt") -Destination (Join-Path $stage "PORTABLE.txt")
Copy-Item -LiteralPath (Join-Path $ProjectRoot "POST_QUANTUM.txt") -Destination (Join-Path $stage "POST_QUANTUM.txt")
Copy-Item -LiteralPath (Join-Path $ProjectRoot "THIRD_PARTY_NOTICES.md") -Destination (Join-Path $stage "THIRD_PARTY_NOTICES.md")
Copy-Item -LiteralPath (Join-Path $ProjectRoot "README.md") -Destination (Join-Path $stage "README.md")

$packagedProfiles = @(Get-ChildItem -LiteralPath $stage -Recurse -File -Filter "*.tox")
if ($packagedProfiles.Count -gt 0) { throw "A private Tox profile must not be packaged: $($packagedProfiles[0].FullName)" }
if (Test-Path -LiteralPath (Join-Path $stage "libsodium.dll")) { throw "The obsolete dynamic libsodium DLL must not be packaged." }
if (-not (Test-Path -LiteralPath (Join-Path $stage "pthreadVC3.dll"))) { throw "The portable pthreads4w runtime was not packaged." }
if (-not (Test-Path -LiteralPath (Join-Path $stage "WebView2Runtime\msedgewebview2.exe"))) { throw "The flattened portable WebView2 runtime was not packaged." }
if (-not (Test-Path -LiteralPath (Join-Path $stage "TorExpertBundle\tor\tor.exe"))) { throw "Portable Tor runtime was not packaged." }
if (-not (Test-Path -LiteralPath (Join-Path $stage "TorExpertBundle\tor\pluggable_transports\lyrebird.exe"))) { throw "Portable Tor transports were not packaged." }
if (-not (Test-Path -LiteralPath (Join-Path $stage "POST_QUANTUM.txt"))) { throw "The post-quantum protocol description was not packaged." }
if (-not (Test-Path -LiteralPath (Join-Path $stage "runtime\qtox-import\libsqlcipher-0.dll"))) { throw "The qTox SQLCipher import runtime was not packaged." }
$obsoleteQtoxRuntime = @(
    "libcrypto-3-x64.dll",
    "libssl-3-x64.dll",
    "libgcc_s_seh-1.dll",
    "libstdc++-6.dll",
    "libwinpthread-1.dll"
)
foreach ($name in $obsoleteQtoxRuntime) {
    $packaged = Join-Path $stage ("runtime\qtox-import\" + $name)
    if (Test-Path -LiteralPath $packaged) {
        throw "Obsolete qTox import dependency was packaged: $name"
    }
}
if (-not (Test-Path -LiteralPath (Join-Path $stage "runtime\dictionaries\ru-RU.dic"))) { throw "Portable spelling dictionaries were not packaged." }

$zipPath = Join-Path $ArtifactsDir "Kaigen-portable-windows-x64.zip"
$compressionLevel = if ($UiAcceptance) { "Fastest" } else { "Optimal" }
Compress-Archive -LiteralPath $stage -DestinationPath $zipPath -CompressionLevel $compressionLevel -Force
$zipHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $zipPath).Hash
Write-Host "Portable archive: $zipPath"
Write-Host "SHA-256: $zipHash"
$preparedNativeReceipt = Join-Path $ArtifactsDir 'prepared-native-cache-windows-x64.json'
Write-KaigenPreparedNativeReceipt -Path $preparedNativeReceipt -Groups $preparedNativeResults.ToArray() `
    -ApplicationArtifact $zipPath -ApplicationSha256 $zipHash
Write-Host "Prepared native receipt: $preparedNativeReceipt"

if ($UiAcceptance) {
    Write-Host "UI acceptance: source archive deferred to the next full candidate gate."
} else {
    & (Join-Path $PSScriptRoot "build-source-archive.ps1") -ArtifactsDir $ArtifactsDir
}

$trackedWorktreeAfterBuild = Get-TrackedWorktreeByteManifest -Root $ProjectRoot
Assert-TrackedWorktreeByteManifestUnchanged -Before $trackedWorktreeBeforeBuild -After $trackedWorktreeAfterBuild
