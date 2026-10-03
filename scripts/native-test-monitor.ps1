param(
    [Parameter(Mandatory)][string]$Program,
    [Parameter(Mandatory)][string]$ArgumentsJson,
    [Parameter(Mandatory)][string]$EvidenceRoot,
    [Parameter(Mandatory)][int]$MaxSeconds,
    [Parameter(Mandatory)][int]$MaxWorkingSetMiB,
    [Parameter(Mandatory)][int]$MaxFixtureMiB
)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class KaigenProcessMemory {
    [StructLayout(LayoutKind.Sequential)]
    public struct Counters {
        public uint cb, pageFaults;
        public UIntPtr peakWorkingSet, workingSet, quotaPeakPaged, quotaPaged, quotaPeakNonPaged, quotaNonPaged, pagefile, peakPagefile;
    }
    [DllImport("psapi.dll", SetLastError = true)]
    public static extern bool GetProcessMemoryInfo(IntPtr process, ref Counters counters, uint size);
    public static long Peak(IntPtr handle) {
        var counters = new Counters();
        counters.cb = (uint)Marshal.SizeOf<Counters>();
        if (!GetProcessMemoryInfo(handle, ref counters, counters.cb)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        return checked((long)counters.peakWorkingSet.ToUInt64());
    }
}
'@
if ($MaxSeconds -lt 1 -or $MaxWorkingSetMiB -lt 1 -or $MaxFixtureMiB -lt 1) { throw 'Invalid resource limit' }
$resolvedEvidence = (Resolve-Path -LiteralPath $EvidenceRoot).Path
$fixtureRoot = Join-Path $resolvedEvidence 'fixtures'
New-Item -ItemType Directory -Path $fixtureRoot -ErrorAction Stop | Out-Null
$startInfo = [System.Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = (Resolve-Path -LiteralPath $Program).Path
$startInfo.UseShellExecute = $false
$startInfo.CreateNoWindow = $true
$startInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
$startInfo.RedirectStandardOutput = $true
$startInfo.RedirectStandardError = $true
foreach ($argument in (ConvertFrom-Json -InputObject $ArgumentsJson)) { $startInfo.ArgumentList.Add([string]$argument) }
$startInfo.Environment['TEMP'] = $fixtureRoot
$startInfo.Environment['TMP'] = $fixtureRoot
$startInfo.Environment.Remove('KAIGEN_QTOX_LARGE_FIXTURE_OUTPUT') | Out-Null
foreach ($key in @($startInfo.Environment.Keys | Where-Object { $_ -like 'KAIGEN_PQ_FAULT_*' })) { $startInfo.Environment.Remove($key) | Out-Null }
$process = [System.Diagnostics.Process]::new()
$process.StartInfo = $startInfo
$watch = [System.Diagnostics.Stopwatch]::StartNew()
$peakWorkingSet = 0L
$peakFixtureBytes = 0L
$samples = 0
$lastDiskMs = -500L
$lastProgressMs = 0L
$violation = $null
$exitCode = $null
$stdout = ''
$stderr = ''
$nativePid = $null
$started = $false
$stdoutTask = $null
$stderrTask = $null
$loadedNativeModules = @{}
$partialFixtureSamples = 0
try {
    if (-not $process.Start()) { throw 'Native process failed to start' }
    $started = $true
    $nativePid = $process.Id
    $processHandle = $process.Handle
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    while (-not $process.HasExited) {
        $process.Refresh()
        $peakWorkingSet = [Math]::Max($peakWorkingSet, [KaigenProcessMemory]::Peak($processHandle))
        $samples++
        if ($loadedNativeModules.Count -lt 2) {
            try {
                foreach ($module in $process.Modules) {
                    if ($module.ModuleName -in @('toxcore.dll', 'pthreadVC3.dll')) {
                        $loadedNativeModules[$module.ModuleName] = @{ path = $module.FileName; sha256 = (Get-FileHash -LiteralPath $module.FileName -Algorithm SHA256).Hash }
                    }
                }
            } catch [System.InvalidOperationException] { } catch [System.ComponentModel.Win32Exception] { }
        }
        if ($watch.ElapsedMilliseconds - $lastDiskMs -ge 500) {
            $bytes = 0L
            try {
                foreach ($file in [System.IO.Directory]::EnumerateFiles($fixtureRoot, '*', [System.IO.SearchOption]::AllDirectories)) {
                    try { $bytes += [System.IO.FileInfo]::new($file).Length } catch [System.IO.FileNotFoundException] { }
                }
            } catch [System.IO.IOException] { $partialFixtureSamples++ } # A test can remove its own disposable tree during sampling.
            $peakFixtureBytes = [Math]::Max($peakFixtureBytes, $bytes)
            $lastDiskMs = $watch.ElapsedMilliseconds
        }
        if ($peakWorkingSet -gt $MaxWorkingSetMiB * 1MB) { $violation = 'working-set-limit' }
        elseif ($peakFixtureBytes -gt $MaxFixtureMiB * 1MB) { $violation = 'fixture-limit' }
        elseif ($watch.Elapsed.TotalSeconds -gt $MaxSeconds) { $violation = 'time-limit' }
        if ($violation) { $process.Kill($true); break }
        if ($watch.ElapsedMilliseconds - $lastProgressMs -ge 30000) {
            Write-Output ("native resource progress elapsedMs={0} peakWorkingSetMiB={1:N1} sampledFixtureMiB={2:N1}" -f $watch.ElapsedMilliseconds, ($peakWorkingSet / 1MB), ($peakFixtureBytes / 1MB))
            $lastProgressMs = $watch.ElapsedMilliseconds
        }
        Start-Sleep -Milliseconds 100
    }
    $process.WaitForExit()
    $process.Refresh()
    $peakWorkingSet = [Math]::Max($peakWorkingSet, [KaigenProcessMemory]::Peak($processHandle))
    $exitCode = $process.ExitCode
    $stdout = $stdoutTask.GetAwaiter().GetResult()
    $stderr = $stderrTask.GetAwaiter().GetResult()
    if (-not $violation -and $peakWorkingSet -gt $MaxWorkingSetMiB * 1MB) { $violation = 'working-set-limit' }
} catch {
    $violation = $_.Exception.Message
    if ($started -and -not $process.HasExited) { $process.Kill($true); $process.WaitForExit() }
} finally {
    $watch.Stop()
    if ($stdoutTask) { try { $stdout = $stdoutTask.GetAwaiter().GetResult() } catch { $violation = 'stdout-capture-failed' } }
    if ($stderrTask) { try { $stderr = $stderrTask.GetAwaiter().GetResult() } catch { $violation = 'stderr-capture-failed' } }
    [System.IO.File]::WriteAllText((Join-Path $resolvedEvidence 'process.stdout.log'), $stdout)
    [System.IO.File]::WriteAllText((Join-Path $resolvedEvidence 'process.stderr.log'), $stderr)
    $status = if (-not $violation -and $exitCode -eq 0) { 'PASS' } else { 'FAIL' }
    $result = [ordered]@{
        schema = 1; status = $status; processId = $nativePid; exitCode = $exitCode
        elapsedMs = $watch.ElapsedMilliseconds; peakWorkingSetBytes = $peakWorkingSet
        sampledPeakFixtureBytes = $peakFixtureBytes; workingSetSampleIntervalMs = 100
        fixtureSampleIntervalMs = 500; partialFixtureSamples = $partialFixtureSamples
        samples = $samples; violation = $violation; loadedNativeModules = @($loadedNativeModules.Values)
        limits = @{ seconds = $MaxSeconds; workingSetMiB = $MaxWorkingSetMiB; fixtureMiB = $MaxFixtureMiB }
    }
    $json = $result | ConvertTo-Json -Depth 4
    [System.IO.File]::WriteAllText((Join-Path $resolvedEvidence 'resource.json'), $json)
    Write-Output $json
    $process.Dispose()
}
if ($status -ne 'PASS') { exit 1 }
