# Host-only preparation. Copy resulting binaries to the disposable guest; never compile there.
[CmdletBinding()]
param([Parameter(Mandatory)][string]$OutputDirectory)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'Windows host preparation required.' }
$out = [IO.Path]::GetFullPath($OutputDirectory)
if($out.StartsWith('C:\KaigenLab\disposable\',[StringComparison]::OrdinalIgnoreCase)){throw 'Prepare binaries on the host, not in a disposable guest run.'}
if ([IO.Path]::GetPathRoot($out) -eq ($out.TrimEnd('\') + '\')) { throw 'OutputDirectory cannot be a volume root.' }
[IO.Directory]::CreateDirectory($out) | Out-Null
$source = Join-Path $PSScriptRoot 'fixtures\windows-msi-upgrade\rollback-probe.rs'
$runtimeObserverSource = Join-Path $PSScriptRoot 'fixtures\windows-msi-upgrade\runtime-observer.cs'
$runtimeObserverDll = Join-Path $out 'kaigen-msi-runtime-observer.dll'
$rustup = (Get-Command rustup.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$rustc = [string](& $rustup which rustc)
if($LASTEXITCODE -ne 0 -or -not(Test-Path -LiteralPath $rustc -PathType Leaf)){throw 'Prepared Rust compiler could not be resolved without installation.'}
$rustcVersion = @(& $rustc --version --verbose)
if($LASTEXITCODE -ne 0){throw 'Prepared Rust compiler version could not be read.'}
$binary = Join-Path $out 'kaigen-msi-rollback-probe.exe'
$test = Join-Path $out 'kaigen-msi-rollback-probe-tests.exe'
foreach ($path in @($binary, $test, $runtimeObserverDll, (Join-Path $out 'probe-identity.json'))) {
    if (Test-Path -LiteralPath $path) { throw "Refusing to replace existing prepared proof: $path" }
}
& $rustc --edition=2021 --test $source -o $test
if ($LASTEXITCODE -ne 0) { throw 'Probe test compilation failed.' }
$testStdout=Join-Path $out 'probe-tests.stdout.log'; $testStderr=Join-Path $out 'probe-tests.stderr.log'
$testProcess=Start-Process -FilePath $test -ArgumentList '--nocapture' -WorkingDirectory $out -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput $testStdout -RedirectStandardError $testStderr
if ($testProcess.ExitCode -ne 0) { throw 'Probe SHA256 known-vector validation failed.' }
& $rustc --edition=2021 -C opt-level=z -C panic=abort -C strip=symbols $source -o $binary
if ($LASTEXITCODE -ne 0) { throw 'Probe compilation failed.' }
Add-Type -TypeDefinition ([IO.File]::ReadAllText($runtimeObserverSource)) -OutputAssembly $runtimeObserverDll -OutputType Library
$identity = [ordered]@{
    schema = 1; preparedAt = [DateTime]::UtcNow.ToString('o'); hostOnly = $true
    sourceSha256 = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash
    rustc = $rustc; rustcSha256 = (Get-FileHash -LiteralPath $rustc -Algorithm SHA256).Hash; rustcVersion=$rustcVersion
    binary = $binary; binarySha256 = (Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash
    testsSha256 = (Get-FileHash -LiteralPath $test -Algorithm SHA256).Hash
    testsExitCode=$testProcess.ExitCode; testsStdoutSha256=(Get-FileHash -LiteralPath $testStdout -Algorithm SHA256).Hash
    knownVectorTest = 'PASS: SHA256 empty, abc, one-million-a; post-removal absent product state and completed unrelated-product enumeration predicates'
    runtimeObserverSource = $runtimeObserverSource; runtimeObserverSourceSha256 = (Get-FileHash -LiteralPath $runtimeObserverSource -Algorithm SHA256).Hash
    runtimeObserverDll = $runtimeObserverDll; runtimeObserverDllSha256 = (Get-FileHash -LiteralPath $runtimeObserverDll -Algorithm SHA256).Hash
}
[IO.File]::WriteAllText((Join-Path $out 'probe-identity.json'), ($identity | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
$identity | ConvertTo-Json -Depth 5
