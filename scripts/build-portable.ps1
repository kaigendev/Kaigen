[CmdletBinding()]
param(
    [string]$WebView2CabPath,
    [string]$ArtifactsDir
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
if ([string]::IsNullOrWhiteSpace($ArtifactsDir)) {
    $ArtifactsDir = Join-Path $ProjectRoot "artifacts"
} else {
    $ArtifactsDir = [IO.Path]::GetFullPath($ArtifactsDir)
}

& (Join-Path $PSScriptRoot "prepare-dependencies.ps1") -WebView2CabPath $WebView2CabPath

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
$dumpbin = Join-Path $compiler.DirectoryName "dumpbin.exe"
if (-not (Test-Path -LiteralPath $dumpbin)) { throw "dumpbin.exe was not found beside the MSVC compiler." }
$toxcoreDll = Join-Path $toxBuild "toxcore.dll"
$toxcoreExports = (& $dumpbin /exports $toxcoreDll 2>&1 | Out-String)
foreach ($requiredExport in @("tox_new", "tox_iterate", "tox_self_get_address", "tox_pass_key_encrypt")) {
    if ($toxcoreExports -notmatch "(?m)\b$([regex]::Escape($requiredExport))\s*$") {
        throw "c-toxcore DLL is missing the required export $requiredExport. Refusing to create a broken portable archive."
    }
}

Push-Location $ProjectRoot
try {
    & npm.cmd ci
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed." }
    & cargo test --manifest-path "src-tauri\Cargo.toml"
    if ($LASTEXITCODE -ne 0) { throw "Rust tests failed." }
    & npm.cmd run tauri -- build --no-bundle
    if ($LASTEXITCODE -ne 0) { throw "Tauri release build failed." }
} finally {
    Pop-Location
}

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

Copy-Item -LiteralPath (Join-Path $ProjectRoot "src-tauri\target\release\tox-pq-client.exe") -Destination (Join-Path $stage "Kaigen.exe")
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
if (-not (Test-Path -LiteralPath (Join-Path $stage "runtime\dictionaries\ru-RU.dic"))) { throw "Portable spelling dictionaries were not packaged." }

$zipPath = Join-Path $ArtifactsDir "Kaigen-portable-windows-x64.zip"
Compress-Archive -LiteralPath $stage -DestinationPath $zipPath -CompressionLevel Optimal -Force
$zipHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $zipPath).Hash
Write-Host "Portable archive: $zipPath"
Write-Host "SHA-256: $zipHash"

& (Join-Path $PSScriptRoot "build-source-archive.ps1") -ArtifactsDir $ArtifactsDir
