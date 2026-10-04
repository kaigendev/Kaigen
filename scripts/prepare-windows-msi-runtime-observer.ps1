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
$source = Join-Path $PSScriptRoot 'fixtures\windows-msi-upgrade\observer-canary.rs'
$runtimeObserverSource = Join-Path $PSScriptRoot 'fixtures\windows-msi-upgrade\runtime-observer.cs'
$runtimeObserverDll = Join-Path $out 'kaigen-msi-runtime-observer.dll'
$rustup = (Get-Command rustup.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$rustc = [string](& $rustup which rustc)
if($LASTEXITCODE -ne 0 -or -not(Test-Path -LiteralPath $rustc -PathType Leaf)){throw 'Prepared Rust compiler could not be resolved without installation.'}
$rustcVersion = @(& $rustc --version --verbose)
if($LASTEXITCODE -ne 0){throw 'Prepared Rust compiler version could not be read.'}
$binary = Join-Path $out 'kaigen-msi-observer-canary.exe'
foreach ($path in @($binary, $runtimeObserverDll, (Join-Path $out 'runtime-observer-identity.json'))) {
    if (Test-Path -LiteralPath $path) { throw "Refusing to replace existing prepared proof: $path" }
}
& $rustc --edition=2021 -C opt-level=z -C panic=abort -C strip=symbols $source -o $binary
if ($LASTEXITCODE -ne 0) { throw 'Observer canary compilation failed.' }
Add-Type -TypeDefinition ([IO.File]::ReadAllText($runtimeObserverSource)) -OutputAssembly $runtimeObserverDll -OutputType Library
$identity = [ordered]@{
    schema = 1; preparedAt = [DateTime]::UtcNow.ToString('o'); hostOnly = $true
    sourceSha256 = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash
    rustc = $rustc; rustcSha256 = (Get-FileHash -LiteralPath $rustc -Algorithm SHA256).Hash; rustcVersion=$rustcVersion
    binary = $binary; binarySha256 = (Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash
    runtimeObserverSource = $runtimeObserverSource; runtimeObserverSourceSha256 = (Get-FileHash -LiteralPath $runtimeObserverSource -Algorithm SHA256).Hash
    runtimeObserverDll = $runtimeObserverDll; runtimeObserverDllSha256 = (Get-FileHash -LiteralPath $runtimeObserverDll -Algorithm SHA256).Hash
}
[IO.File]::WriteAllText((Join-Path $out 'runtime-observer-identity.json'), ($identity | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
$identity | ConvertTo-Json -Depth 5
