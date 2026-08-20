[CmdletBinding()]
param(
    [string]$WebView2CabPath,
    [string]$ComponentCacheRoot = $env:KAIGEN_COMPONENT_CACHE_ROOT,
    [string]$ArtifactsDir,
    [switch]$UiAcceptance
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))

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
$env:NPM_CONFIG_OFFLINE = "true"
$env:CARGO_NET_OFFLINE = "true"
$userProfile = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
if ([string]::IsNullOrWhiteSpace($userProfile)) {
    throw "The Windows user profile path is unavailable; private Rust source paths cannot be remapped safely."
}
$resolvedUserProfile = [IO.Path]::GetFullPath($userProfile).TrimEnd('\')
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

    $gitCommand = Get-Command git.exe -ErrorAction SilentlyContinue
    if (-not $gitCommand) { $gitCommand = Get-Command git -ErrorAction SilentlyContinue }
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

& (Join-Path $PSScriptRoot "prepare-dependencies.ps1") -WebView2CabPath $WebView2CabPath -ComponentCacheRoot $ComponentCacheRoot

$vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
if (-not (Test-Path -LiteralPath $vswhere)) {
    throw "vswhere.exe was not found. Install Microsoft C++ Build Tools with Desktop development with C++."
}
$vsInstall = (& $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath).Trim()
if ([string]::IsNullOrWhiteSpace($vsInstall)) { throw "Microsoft C++ Build Tools were not found." }
$vsDevCmd = Join-Path $vsInstall "Common7\Tools\VsDevCmd.bat"
$devCommand = '"' + $vsDevCmd + '" -arch=x64 -host_arch=x64 >nul && set'
$environmentLines = & cmd.exe /d /s /c $devCommand
if ($LASTEXITCODE -ne 0) { throw "Could not initialise the Visual Studio build environment." }
foreach ($line in $environmentLines) {
    $separator = $line.IndexOf('=')
    if ($separator -gt 0) {
        Set-Item -LiteralPath ("Env:\" + $line.Substring(0, $separator)) -Value $line.Substring($separator + 1)
    }
}

$cmakeCommand = Get-Command cmake.exe -ErrorAction SilentlyContinue
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

$pthreadsSource = Join-Path $ProjectRoot "work\deps\pthreads4w-dynamic"
$pthreadsLibrary = Join-Path $pthreadsSource "pthreadVC3.lib"
$pthreadsRuntime = Join-Path $pthreadsSource "pthreadVC3.dll"
if (-not (Test-Path -LiteralPath $pthreadsLibrary) -or -not (Test-Path -LiteralPath $pthreadsRuntime)) {
    foreach ($name in @("pthread.obj", "pthreadVC3.dll", "pthreadVC3.lib", "pthreadVC3.exp", "pthreadVC3.ilk", "pthreadVC3.pdb", "version.res")) {
        $partialOutput = Join-Path $pthreadsSource $name
        if (Test-Path -LiteralPath $partialOutput) { [IO.File]::Delete($partialOutput) }
    }
    Push-Location $pthreadsSource
    try {
        & (Join-Path $compiler.DirectoryName "nmake.exe") /f Makefile /E /nologo `
            "XCFLAGS=/MT" `
            "EHFLAGS=/I. /DHAVE_CONFIG_H /W3 /O2 /Ob2 /D__PTW32_BUILD_INLINED" `
            "CLEANUP=__PTW32_CLEANUP_C" `
            pthreadVC3.dll
        if ($LASTEXITCODE -ne 0) { throw "Portable pthreads4w build failed." }
    } finally {
        Pop-Location
    }
}
if (-not (Test-Path -LiteralPath $pthreadsLibrary) -or -not (Test-Path -LiteralPath $pthreadsRuntime)) {
    throw "Portable pthreads4w library was not produced."
}

$toxSource = Join-Path $ProjectRoot "work\toxcore-meta"
$toxBuild = Join-Path $ProjectRoot "work\build\toxcore-native-windows"
$sodiumConfig = Join-Path $ProjectRoot "cmake\libsodium"
$pkgConfigStub = Join-Path $PSScriptRoot "pkg-config-stub.cmd"
$toxCache = Join-Path $toxBuild "CMakeCache.txt"
if (Test-Path -LiteralPath $toxCache) {
    $cacheText = [IO.File]::ReadAllText($toxCache)
    $cachedSourceMatch = [regex]::Match($cacheText, "(?m)^CMAKE_HOME_DIRECTORY:INTERNAL=(?<path>.+?)\r?$")
    $cachedBuildMatch = [regex]::Match($cacheText, "(?m)^CMAKE_CACHEFILE_DIR:INTERNAL=(?<path>.+?)\r?$")
    $normalizeCMakePath = {
        param([string]$Path)
        (($Path.Trim() -replace '\\', '/') -replace '/+$', '').ToLowerInvariant()
    }
    $sourceMoved = -not $cachedSourceMatch.Success -or (& $normalizeCMakePath $cachedSourceMatch.Groups['path'].Value) -ne (& $normalizeCMakePath $toxSource)
    $buildMoved = -not $cachedBuildMatch.Success -or (& $normalizeCMakePath $cachedBuildMatch.Groups['path'].Value) -ne (& $normalizeCMakePath $toxBuild)
    if ($sourceMoved -or $buildMoved) {
        $allowedBuildRoot = [IO.Path]::GetFullPath((Join-Path $ProjectRoot "work\build")).TrimEnd('\') + '\'
        $toxBuild = [IO.Path]::GetFullPath($toxBuild)
        if (-not $toxBuild.StartsWith($allowedBuildRoot, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Refusing to discard a relocated CMake cache outside the project build directory: $toxBuild"
        }
        Write-Host "Discarding a relocated c-toxcore CMake cache: $toxBuild"
        [IO.Directory]::Delete($toxBuild, $true)
    }
}
$toxcoreDll = Join-Path $toxBuild "toxcore.dll"
$reuseToxcoreBuild = $UiAcceptance `
    -and (Test-Path -LiteralPath $toxCache -PathType Leaf) `
    -and (Test-Path -LiteralPath $toxcoreDll -PathType Leaf)
if ($reuseToxcoreBuild) {
    Write-Host "UI acceptance: reusing the path-verified c-toxcore build cache; required DLL exports are checked below."
} else {
    & $cmake -S $toxSource -B $toxBuild -G Ninja `
        "-DCMAKE_MAKE_PROGRAM=$ninja" `
        "-DCMAKE_C_COMPILER=$($compiler.FullName)" `
        "-DCMAKE_CXX_COMPILER=$($compiler.FullName)" `
        "-DCMAKE_RC_COMPILER=$($resourceCompiler.FullName.Replace('\', '/'))" `
        "-DCMAKE_MT=$($manifestTool.FullName.Replace('\', '/'))" `
        -DCMAKE_BUILD_TYPE=Release `
        -DCMAKE_WINDOWS_EXPORT_ALL_SYMBOLS=ON `
        -DMSVC_STATIC_SODIUM=ON `
        -DBUILD_TOXAV=OFF `
        -DBOOTSTRAP_DAEMON=OFF `
        -DAUTOTEST=OFF `
        "-Dlibsodium_DIR=$sodiumConfig" `
        "-Dpthreads_DIR=$(Join-Path $ProjectRoot 'cmake\pthreads4w')" `
        "-DPTHREADS4W_ROOT=$pthreadsSource" `
        "-DPKG_CONFIG_EXECUTABLE=$pkgConfigStub"
    if ($LASTEXITCODE -ne 0) { throw "c-toxcore CMake configuration failed." }
    & $cmake --build $toxBuild --config Release --target toxcore_shared
    if ($LASTEXITCODE -ne 0) { throw "c-toxcore build failed." }
}
$dumpbin = Join-Path $compiler.DirectoryName "dumpbin.exe"
if (-not (Test-Path -LiteralPath $dumpbin)) { throw "dumpbin.exe was not found beside the MSVC compiler." }
$toxcoreExports = (& $dumpbin /exports $toxcoreDll 2>&1 | Out-String)
foreach ($requiredExport in @("tox_new", "tox_iterate", "tox_self_get_address", "tox_pass_key_encrypt")) {
    if ($toxcoreExports -notmatch "(?m)\b$([regex]::Escape($requiredExport))\s*$") {
        throw "c-toxcore DLL is missing the required export $requiredExport. Refusing to create a broken portable archive."
    }
}

# These regressions deliberately use disposable fixtures and in-memory
# savedata. They belong to the full candidate gate; a visual-only acceptance
# reuses the same freshly verified exports and defers unrelated native suites.
if ($UiAcceptance) {
    Write-Host "UI acceptance: native retry-cap and offline loopback suites deferred to the next full candidate gate."
} else {
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
Copy-Item -LiteralPath (Join-Path $ProjectRoot "work\deps\WebView2Runtime") -Destination (Join-Path $stage "WebView2Runtime") -Recurse
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

if ($UiAcceptance) {
    Write-Host "UI acceptance: source archive deferred to the next full candidate gate."
} else {
    & (Join-Path $PSScriptRoot "build-source-archive.ps1") -ArtifactsDir $ArtifactsDir
}

$trackedWorktreeAfterBuild = Get-TrackedWorktreeByteManifest -Root $ProjectRoot
Assert-TrackedWorktreeByteManifestUnchanged -Before $trackedWorktreeBeforeBuild -After $trackedWorktreeAfterBuild
