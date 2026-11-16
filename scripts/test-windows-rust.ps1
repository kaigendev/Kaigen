#requires -Version 7.6
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateSet('desktop', 'web-core', 'web-daemon')]
    [string]$Suite,
    [ValidatePattern('^[A-Za-z0-9_][A-Za-z0-9_:-]*$')]
    [string]$Filter,
    [ValidateRange(1, 32)]
    [int]$TestThreads = 4,
    [switch]$PqFaultTests,
    [switch]$Ignored,
    [switch]$NoCapture,
    [switch]$CompileOnly,
    [string]$CompileManifestPath,
    [switch]$Release
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
if (!$IsWindows -or (rustc --print host-tuple) -cne 'x86_64-pc-windows-msvc') {
    throw 'These tests require the x64 MSVC Rust toolchain on Windows.'
}
if ($env:RUSTFLAGS -or $env:CARGO_ENCODED_RUSTFLAGS -or $env:CARGO_BUILD_TARGET) {
    throw 'Run the Windows test entry point without inherited Rust flags or a Cargo cross target.'
}
if ($PqFaultTests -and $Suite -eq 'web-daemon') {
    throw 'The PQ fault-test feature belongs to Desktop and Web Core.'
}
if ($CompileOnly -and (!$CompileManifestPath -or $Filter -or $Ignored -or $NoCapture)) {
    throw 'CompileOnly requires a fresh CompileManifestPath and cannot select runtime filters or flags.'
}
if (!$CompileOnly -and ($CompileManifestPath -or $Release)) {
    throw 'CompileManifestPath and Release are available only with CompileOnly.'
}

$root = Split-Path -Parent $PSScriptRoot
$crate = if ($Suite -eq 'web-daemon') { 'web/kaigen-webd' } else { 'src-tauri' }
$target = Join-Path $root "$crate/target"
$manifest = Join-Path $root "$crate/Cargo.toml"
$pthreadsRuntime = Join-Path $root 'work/deps/pthreads4w-dynamic/pthreadVC3.dll'
if (!(Test-Path -LiteralPath $pthreadsRuntime -PathType Leaf)) {
    throw 'Prepare the pinned pthreads4w runtime with the Windows portable build entry point before native tests.'
}
$profile = if ($Release) { 'release' } else { 'debug' }
$compileManifest = if ($CompileOnly) { [IO.Path]::GetFullPath($CompileManifestPath, $root) }
if ($CompileOnly -and (Test-Path -LiteralPath $compileManifest)) {
    throw 'CompileManifestPath must not overwrite an existing result.'
}
$artifactDirectory = if ($CompileOnly) { $compileManifest + '.artifacts' }
if ($CompileOnly -and (Test-Path -LiteralPath $artifactDirectory)) {
    throw 'The compile artifact directory must be fresh.'
}
function Get-CompileSourceInputs {
    $files = @('scripts/test-windows-rust.ps1', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock', 'src-tauri/build.rs') |
        ForEach-Object { Join-Path $root $_ }
    $files += Get-ChildItem -LiteralPath (Join-Path $root 'src-tauri/src') -Filter '*.rs' -File -Recurse |
        Select-Object -ExpandProperty FullName
    if ($Suite -eq 'web-daemon') {
        $files += @('web/kaigen-webd/Cargo.toml', 'web/kaigen-webd/Cargo.lock', 'web/kaigen-webd/tests/local_apple_web_push_provider.mjs') |
            ForEach-Object { Join-Path $root $_ }
        $files += Get-ChildItem -LiteralPath (Join-Path $root 'web/kaigen-webd/src') -Filter '*.rs' -File -Recurse |
            Select-Object -ExpandProperty FullName
    }
    foreach ($relative in @('.cargo/config', '.cargo/config.toml', 'rust-toolchain', 'rust-toolchain.toml', 'src-tauri/.cargo/config', 'src-tauri/.cargo/config.toml')) {
        $candidate = Join-Path $root $relative
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { $files += $candidate }
    }
    @($files | Sort-Object -Unique | ForEach-Object {
        [ordered]@{ path = [IO.Path]::GetRelativePath($root, $_).Replace('\', '/'); sha256 = (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash }
    })
}
$compileInputs = if ($CompileOnly) { @(Get-CompileSourceInputs) }
$sodium = if ($env:KAIGEN_LIBSODIUM_LIB_DIR) {
    [IO.Path]::GetFullPath($env:KAIGEN_LIBSODIUM_LIB_DIR, $root)
} else {
    Join-Path $root 'work/deps/libsodium/libsodium/x64/Release/v143/static'
}
$library = Join-Path $sodium 'libsodium.lib'
$symbols = Join-Path $sodium 'libsodium.pdb'
$libraryHash = '85F60A8AE08C003141F2E5E39334056693DAFAE27F18A0A26A315A3E898942D4'
$symbolsHash = '728E470B95C708DD93BCC5FDC54F1372B013A876CB37165C1287BEE7012C542B'
if (!(Test-Path -LiteralPath $library -PathType Leaf) -or
    !(Test-Path -LiteralPath $symbols -PathType Leaf) -or
    (Get-FileHash -LiteralPath $library).Hash -cne $libraryHash -or
    (Get-FileHash -LiteralPath $symbols).Hash -cne $symbolsHash) {
    throw 'Prepare the pinned Windows libsodium archive and matching PDB with the Windows portable build entry point.'
}

# MSVC locates this PDB beside the libsodium objects extracted into the test link directory.
$deps = Join-Path $target "$profile/deps"
[IO.Directory]::CreateDirectory($deps) | Out-Null
$destination = Join-Path $deps 'libsodium.pdb'
if (!(Test-Path -LiteralPath $destination -PathType Leaf) -or
    (Get-FileHash -LiteralPath $destination).Hash -cne $symbolsHash) {
    $temporary = Join-Path $deps ('.libsodium-pdb-' + [guid]::NewGuid().ToString('N') + '.tmp')
    try {
        [IO.File]::Copy($symbols, $temporary)
        if ((Get-FileHash -LiteralPath $temporary).Hash -cne $symbolsHash) {
            throw 'The staged PDB differs from the pinned Windows symbols.'
        }
        [IO.File]::Move($temporary, $destination, $true)
    } finally {
        if (Test-Path -LiteralPath $temporary) { [IO.File]::Delete($temporary) }
    }
}

$cargoArgs = @('test', '--offline', '--locked', '--color', 'never', '--manifest-path', $manifest, '--target-dir', $target)
switch ($Suite) {
    'desktop' { $cargoArgs += '--lib' }
    'web-core' { $cargoArgs += @('--lib', '--no-default-features', '--features', 'web-core') }
    'web-daemon' { $cargoArgs += @('--bin', 'kaigen-webd') }
}
if ($PqFaultTests) { $cargoArgs += @('--features', 'pq-fault-tests') }
if ($CompileOnly) {
    if ($Release) { $cargoArgs += '--release' }
    $cargoArgs += @('--no-run', '--message-format=json')
} else {
    if ($Filter) { $cargoArgs += $Filter }
    $cargoArgs += @('--', "--test-threads=$TestThreads")
    if ($Ignored) { $cargoArgs += '--ignored' }
    if ($NoCapture) { $cargoArgs += '--nocapture' }
}

$previousPath = $env:PATH
$previousSodium = $env:KAIGEN_LIBSODIUM_LIB_DIR
$warningCount = 0
$compilerArtifacts = [Collections.Generic.List[object]]::new()
Push-Location $root
try {
    # The pinned native archive uses /MT, so use the same CRT for the Rust test executable.
    $env:CARGO_ENCODED_RUSTFLAGS = @('-C', 'target-feature=+crt-static') -join [char]31
    if ($previousSodium) { $env:KAIGEN_LIBSODIUM_LIB_DIR = $sodium }
    $env:PATH = (Join-Path $root 'work/build/toxcore-native-windows') + [IO.Path]::PathSeparator +
        [IO.Path]::GetDirectoryName($pthreadsRuntime) + [IO.Path]::PathSeparator + $previousPath
    & cargo @cargoArgs 2>&1 | ForEach-Object {
        $line = $_.ToString()
        if ($line -match '^\s*warning(?:\[[^\]]+\])?:|\bwarning LNK\d{4}:') { $warningCount++ }
        if ($CompileOnly -and $line.StartsWith('{')) {
            $message = $line | ConvertFrom-Json -ErrorAction Stop
            if ($message.reason -eq 'compiler-message' -and $message.message.level -eq 'warning') { $warningCount++ }
            if ($message.reason -eq 'compiler-artifact' -and $message.profile.test -and $message.executable) {
                $compilerArtifacts.Add($message)
            }
        }
        $line
    }
    if ($LASTEXITCODE -ne 0) { throw "Cargo test failed with exit code $LASTEXITCODE." }
    if ($warningCount) { throw "Windows test build emitted $warningCount warning diagnostics." }
    if ($CompileOnly) {
        $expectedTarget = if ($Suite -eq 'web-daemon') { 'kaigen-webd' } else { 'tauri_app_lib' }
        $selected = @($compilerArtifacts | Where-Object { $_.target.name -ceq $expectedTarget })
        if ($selected.Count -ne 1) { throw 'CompileOnly requires exactly one matching native test executable.' }
        if (($compileInputs | ConvertTo-Json -Depth 4 -Compress) -cne (@(Get-CompileSourceInputs) | ConvertTo-Json -Depth 4 -Compress)) {
            throw 'Rust test source inputs changed during compilation.'
        }
        $executable = [IO.Path]::GetFullPath($selected[0].executable)
        [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($compileManifest)) | Out-Null
        [IO.Directory]::CreateDirectory($artifactDirectory) | Out-Null
        $payloadFiles = @($executable, $pthreadsRuntime)
        $testSymbols = [IO.Path]::ChangeExtension($executable, '.pdb')
        if (Test-Path -LiteralPath $testSymbols -PathType Leaf) { $payloadFiles += $testSymbols }
        $payloadFiles += @(Get-ChildItem -LiteralPath (Join-Path $root 'work/build/toxcore-native-windows') -Filter '*.dll' -File |
            Select-Object -ExpandProperty FullName)
        $payload = @($payloadFiles | Sort-Object -Unique | ForEach-Object {
            $copy = Join-Path $artifactDirectory ([IO.Path]::GetFileName($_))
            [IO.File]::Copy($_, $copy, $false)
            $originalHash = (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash
            $copiedHash = (Get-FileHash -LiteralPath $copy -Algorithm SHA256).Hash
            if ($originalHash -cne $copiedHash) { throw 'Native test artifact snapshot differs from its compiler output.' }
            [ordered]@{ source = $_; file = [IO.Path]::GetFileName($copy); sha256 = $copiedHash; bytes = (Get-Item -LiteralPath $copy).Length }
        })
        $record = [ordered]@{
            schema = 1; kind = 'kaigen-windows-native-test-compile'; runtimeExecuted = $false
            suite = $Suite; pqFaultTests = [bool]$PqFaultTests; profile = $profile; sourceOwner = $root
            manifestDirectory = [IO.Path]::GetDirectoryName($manifest); cargoArguments = $cargoArgs
            compilerManifestPath = $selected[0].manifest_path; compilerFeatures = @($selected[0].features); compilerProfile = $selected[0].profile
            cargoLauncher = (Get-Command cargo -ErrorAction Stop).Source
            rustcLauncher = (Get-Command rustc -ErrorAction Stop).Source; explicitRustc = $env:RUSTC
            encodedRustFlags = $env:CARGO_ENCODED_RUSTFLAGS; sodiumLibrarySha256 = $libraryHash; sodiumPdbSha256 = $symbolsHash
            sourceInputs = $compileInputs; artifactDirectory = $artifactDirectory
            executableFile = [IO.Path]::GetFileName($executable); payload = $payload
            boundary = 'Compile-only snapshot; no test discovery or execution. Selected Rust/manifests/config inputs exclude task documents. Payload DLLs are candidates, not a verified loaded-library or complete native dependency closure. Compile-time fixture paths must be resolved in the guest.'
        }
        $stream = [IO.File]::Open($compileManifest, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
        try {
            $data = [Text.UTF8Encoding]::new($false).GetBytes(($record | ConvertTo-Json -Depth 8) + "`n")
            $stream.Write($data, 0, $data.Length)
        } finally { $stream.Dispose() }
        "NATIVE_TEST_COMPILE_ONLY_MANIFEST=$compileManifest"
    }
} finally {
    $env:CARGO_ENCODED_RUSTFLAGS = $null
    $env:KAIGEN_LIBSODIUM_LIB_DIR = $previousSodium
    $env:PATH = $previousPath
    Pop-Location
}
