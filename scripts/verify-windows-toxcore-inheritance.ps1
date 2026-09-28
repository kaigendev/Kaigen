param(
    [Parameter(Mandatory)][string]$OutputRoot,
    [Parameter(Mandatory)][string]$ProbeWorkRoot,
    [Parameter(Mandatory)][string]$Rustc,
    [Parameter(Mandatory)][string]$ReceiptPath,
    [switch]$ReuseValidReceipt
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Assert-OrdinaryPath([string]$Path, [bool]$Directory = $false) {
    $full = [IO.Path]::GetFullPath($Path)
    $item = Get-Item -LiteralPath $full -Force
    if ($item.PSIsContainer -ne $Directory) { throw 'INHERITANCE_PATH_KIND' }
    for ($current = $item; $null -ne $current; $current = $current.Parent) {
        if (($current.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'INHERITANCE_REPARSE_PATH' }
        if ($current -is [IO.FileInfo]) { $current = $current.Directory; if ($null -eq $current) { break } }
        if (($current.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'INHERITANCE_REPARSE_PARENT' }
    }
    return $full
}
function Invoke-BoundedProcess([string]$File, [string[]]$Arguments, [int]$Timeout) {
    $process = [Diagnostics.Process]::new()
    try {
        $process.StartInfo.FileName = $File
        $process.StartInfo.WorkingDirectory = $ProbeWorkRoot
        $process.StartInfo.UseShellExecute = $false
        $process.StartInfo.CreateNoWindow = $true
        $process.StartInfo.RedirectStandardOutput = $true
        $process.StartInfo.RedirectStandardError = $true
        foreach ($argument in $Arguments) { $process.StartInfo.ArgumentList.Add($argument) }
        if (-not $process.Start()) { throw 'INHERITANCE_PROCESS_START' }
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($Timeout)) {
            $process.Kill($true)
            if (-not $process.WaitForExit(5000)) { throw 'INHERITANCE_PROCESS_CLEANUP' }
            throw 'INHERITANCE_PROCESS_TIMEOUT'
        }
        $null = $stdout.GetAwaiter().GetResult()
        $null = $stderr.GetAwaiter().GetResult()
        if ($process.ExitCode -ne 0) { throw "INHERITANCE_PROCESS_REJECTED_$($process.ExitCode)" }
    } finally { $process.Dispose() }
}

function Assert-InheritanceReport($report, [string]$dllSha, [string]$pthreadSha) {
if ($report.schemaVersion -ne 1 -or $report.kind -cne 'kaigen-windows-toxcore-inheritance-producer-gate' -or
    $report.status -cne 'PASS' -or $report.classification -cne 'NOT_REPRODUCED' -or
    $report.childExitVerified -ne $true -or $report.artifactHashesVerified -ne $true -or
    $report.artifactFilesFreshlyHashed -ne 2 -or $report.parentPid -le 0 -or $report.childPid -le 0 -or $report.parentPid -eq $report.childPid -or
    $report.parentStart100ns -cnotmatch '^[1-9][0-9]+$' -or $report.childStart100ns -cnotmatch '^[1-9][0-9]+$' -or
    $report.toxcoreSha256 -cne $dllSha -or $report.pthreadSha256 -cne $pthreadSha -or
    $report.probeExeSha256 -cnotmatch '^[a-f0-9]{64}$' -or
    $report.udpEnabled -ne $true -or $report.ipv6Enabled -ne $false -or $report.localDiscoveryEnabled -ne $false -or
    $report.toxIterateCalled -ne $false -or $report.bootstrapCalled -ne $false -or $report.peersAdded -ne $false -or
    $report.watchdogGateClosed -ne $false -or $report.profileDataRead -ne $false -or
    $report.payloadTrafficGeneratedByProbe -ne $false -or $report.endpointAddressesOrPortsExported -ne $false) { throw 'INHERITANCE_REPORT_IDENTITY' }
$phases = @('control-tox-created-no-child', 'control-one-second-after-tox-kill', 'tox-created-before-child',
    'child-alive-before-tox-kill', 'immediate-after-tox-kill', 'one-second-after-tox-kill', 'one-second-after-child-exit')
if ($report.samples.Count -ne $phases.Count) { throw 'INHERITANCE_PHASE_COUNT' }
for ($index = 0; $index -lt $phases.Count; $index++) {
    $sample = $report.samples[$index]
    if ($sample.phase -cne $phases[$index]) { throw 'INHERITANCE_PHASE_ORDER' }
    if ($index -in @(0, 2, 3)) {
        if ($sample.sameEndpointCount -lt 1) { throw 'INHERITANCE_CONTROL_ENDPOINT_MISSING' }
    } elseif ($sample.sameEndpointCount -ne 0 -or $sample.parentOwnedUdpCount -ne 0 -or $sample.childOwnedUdpCount -ne 0) { throw 'INHERITANCE_ENDPOINT_RETAINED' }
    if ($sample.sameEndpointPresent -ne ($sample.sameEndpointCount -gt 0)) { throw 'INHERITANCE_ENDPOINT_BOOLEAN' }
    if ($sample.childAlive -ne ($index -in @(3, 4, 5))) { throw 'INHERITANCE_CHILD_WITNESS' }
}
}

$OutputRoot = Assert-OrdinaryPath $OutputRoot $true
$Rustc = Assert-OrdinaryPath $Rustc
$probeParent = Assert-OrdinaryPath (Split-Path -Parent $ProbeWorkRoot) $true
$ProbeWorkRoot = [IO.Path]::GetFullPath($ProbeWorkRoot)
if ((Split-Path -Leaf $ProbeWorkRoot) -cne 'inheritance-probe' -or
    [IO.Path]::GetFullPath((Split-Path -Parent $ProbeWorkRoot)) -cne $probeParent -or
    (Test-Path -LiteralPath $ProbeWorkRoot)) { throw 'INHERITANCE_WORK_ROOT' }
$source = Assert-OrdinaryPath (Join-Path $PSScriptRoot 'fixtures\toxcore-socket-inheritance.rs')
$dll = Assert-OrdinaryPath (Join-Path $OutputRoot 'toxcore.dll')
$pthread = Assert-OrdinaryPath (Join-Path $OutputRoot 'pthreadVC3.dll')
$dllSha = (Get-FileHash -LiteralPath $dll -Algorithm SHA256).Hash.ToLowerInvariant()
$pthreadSha = (Get-FileHash -LiteralPath $pthread -Algorithm SHA256).Hash.ToLowerInvariant()
$destination = [IO.Path]::GetFullPath($ReceiptPath)
$null = Assert-OrdinaryPath (Split-Path -Parent $destination) $true
$sourceSha = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant()
$runnerSha = (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant()
$rustcSha = (Get-FileHash -LiteralPath $Rustc -Algorithm SHA256).Hash.ToLowerInvariant()
if ($ReuseValidReceipt) {
    $retainedPath = Assert-OrdinaryPath (Join-Path $OutputRoot 'toxcore-socket-inheritance.json')
    $retained = Get-Content -LiteralPath $retainedPath -Raw | ConvertFrom-Json
    Assert-InheritanceReport $retained $dllSha $pthreadSha
    if ($retained.producerValidation.sourceSha256 -ceq $sourceSha -and
        $retained.producerValidation.runnerSha256 -ceq $runnerSha -and
        $retained.producerValidation.rustcSha256 -ceq $rustcSha) {
        Write-Host 'WINDOWS_TOXCORE_INHERITANCE_RETAINED_PASS'
        return
    }
}
if (Test-Path -LiteralPath $destination) {
    if (-not $ReuseValidReceipt) { throw 'INHERITANCE_RECEIPT_EXISTS' }
    $null = Assert-OrdinaryPath $destination
    $previous = Get-Content -LiteralPath $destination -Raw | ConvertFrom-Json
    Assert-InheritanceReport $previous $dllSha $pthreadSha
    if ($previous.producerValidation.sourceSha256 -cne $sourceSha -or
        $previous.producerValidation.runnerSha256 -cne $runnerSha -or
        $previous.producerValidation.rustcSha256 -cne $rustcSha) { throw 'INHERITANCE_PREVIOUS_VALIDATION_PIN' }
    Write-Host 'WINDOWS_TOXCORE_INHERITANCE_REVALIDATED_REUSE_PASS'
    return
}
[IO.Directory]::CreateDirectory($ProbeWorkRoot) | Out-Null
$exe = Join-Path $ProbeWorkRoot 'socket-inheritance-probe.exe'
Invoke-BoundedProcess $Rustc @('--edition=2021', '-C', 'opt-level=1', $source, '-o', $exe) 30000
Invoke-BoundedProcess $exe @('--run', $OutputRoot, $dllSha, $pthreadSha) 35000
$reports = @(Get-ChildItem -LiteralPath $ProbeWorkRoot -File -Filter 'inheritance-receipt-*.json')
if ($reports.Count -ne 1 -or @(Get-ChildItem -LiteralPath $ProbeWorkRoot -File -Filter '*.timeout.json').Count -ne 0) { throw 'INHERITANCE_REPORT_COUNT' }
$report = Get-Content -LiteralPath $reports[0].FullName -Raw | ConvertFrom-Json
Assert-InheritanceReport $report $dllSha $pthreadSha
if ($report.probeExeSha256 -cne (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant()) { throw 'INHERITANCE_EXE_PIN' }
if ((Get-FileHash -LiteralPath $dll -Algorithm SHA256).Hash.ToLowerInvariant() -cne $dllSha -or
    (Get-FileHash -LiteralPath $pthread -Algorithm SHA256).Hash.ToLowerInvariant() -cne $pthreadSha) { throw 'INHERITANCE_ARTIFACT_CHANGED' }
$report | Add-Member -NotePropertyName producerValidation -NotePropertyValue ([ordered]@{
    sourceSha256 = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant()
    runnerSha256 = (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant()
    rustcSha256 = (Get-FileHash -LiteralPath $Rustc -Algorithm SHA256).Hash.ToLowerInvariant()
    rawReportSha256 = (Get-FileHash -LiteralPath $reports[0].FullName -Algorithm SHA256).Hash.ToLowerInvariant()
})
$bytes = [Text.UTF8Encoding]::new($false).GetBytes(($report | ConvertTo-Json -Depth 12) + "`n")
$stream = [IO.File]::Open($destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
Write-Host 'WINDOWS_TOXCORE_INHERITANCE_PRODUCER_PASS'
