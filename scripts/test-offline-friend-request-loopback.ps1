[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$source = Join-Path $PSScriptRoot "tests\offline-friend-request-loopback.c"
$toxSource = Join-Path $repository "work\toxcore-meta"
$toxBuild = Join-Path $repository "work\build\toxcore-native-windows"
$pthreadsBuild = Join-Path $repository "work\deps\pthreads4w-dynamic"
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"

foreach ($required in @(
    $source,
    (Join-Path $toxSource "toxcore\Messenger.h"),
    (Join-Path $toxSource "toxcore\tox.h"),
    (Join-Path $toxSource "toxcore\tox_private.h"),
    (Join-Path $toxSource "toxcore\tox_struct.h"),
    (Join-Path $toxBuild "toxcore.lib"),
    (Join-Path $toxBuild "toxcore.dll"),
    (Join-Path $pthreadsBuild "pthread.h"),
    (Join-Path $pthreadsBuild "pthreadVC3.dll"),
    $vswhere
)) {
    if (-not (Test-Path -LiteralPath $required)) {
        throw "Required local test input is missing: $required"
    }
}

$visualStudio = (& $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath | Select-Object -First 1)
if (-not $visualStudio) {
    throw "A Visual Studio C++ toolchain is required for the local toxcore loopback regression."
}
$developerShell = Join-Path $visualStudio "Common7\Tools\VsDevCmd.bat"
if (-not (Test-Path -LiteralPath $developerShell)) {
    throw "Visual Studio developer shell was not found: $developerShell"
}

$localApplicationData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
if ([string]::IsNullOrWhiteSpace($localApplicationData)) {
    throw "Local application data is unavailable for the stable loopback harness path."
}
$localApplicationData = [IO.Path]::GetFullPath($localApplicationData).TrimEnd('\')
$harnessRoot = [IO.Path]::GetFullPath((Join-Path $localApplicationData "Kaigen"))
$harnessDirectory = [IO.Path]::GetFullPath((Join-Path $harnessRoot "test-harness"))
$localApplicationDataPrefix = $localApplicationData + '\'
if (-not $harnessDirectory.StartsWith($localApplicationDataPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to place the loopback harness outside local application data: $harnessDirectory"
}

$executable = Join-Path $harnessDirectory "offline-friend-request-loopback.exe"
$object = Join-Path $harnessDirectory "offline-friend-request-loopback.obj"
$harnessToxcore = Join-Path $harnessDirectory "toxcore.dll"
$harnessPthreads = Join-Path $harnessDirectory "pthreadVC3.dll"
$harnessFiles = @($executable, $object, $harnessToxcore, $harnessPthreads)
$harnessPrefix = $harnessDirectory.TrimEnd('\') + '\'
foreach ($harnessFile in $harnessFiles) {
    $resolvedHarnessFile = [IO.Path]::GetFullPath($harnessFile)
    if (-not $resolvedHarnessFile.StartsWith($harnessPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing an unsafe loopback harness artifact path: $resolvedHarnessFile"
    }
}

function Assert-HarnessDirectoriesAreNotReparsePoints {
    foreach ($directory in @($harnessRoot, $harnessDirectory)) {
        if (-not (Test-Path -LiteralPath $directory)) {
            continue
        }
        $item = Get-Item -LiteralPath $directory -Force
        if (-not $item.PSIsContainer) {
            throw "The stable loopback harness directory path is not a directory: $directory"
        }
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Refusing a reparse-point loopback harness directory: $directory"
        }
    }
}

function Remove-HarnessFile {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        return
    }
    $item = Get-Item -LiteralPath $Path -Force
    if ($item.PSIsContainer -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
        throw "Refusing to remove an unsafe loopback harness artifact: $Path"
    }
    [IO.File]::Delete([IO.Path]::GetFullPath($Path))
}

function Get-HarnessUdpEndpoints {
    param([Parameter(Mandatory = $true)][int]$ProcessId)

    $netstat = Join-Path $env:SystemRoot "System32\netstat.exe"
    if (-not (Test-Path -LiteralPath $netstat)) {
        throw "Windows netstat was not found: $netstat"
    }
    $netstatOutput = @(& $netstat -ano -p udp 2>&1)
    if ($LASTEXITCODE -ne 0) {
        throw "netstat failed while inspecting the native loopback harness: $($netstatOutput -join ' ')"
    }

    $endpoints = [Collections.Generic.List[object]]::new()
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($line in $netstatOutput) {
        $fields = ([string]$line).Trim() -split '\s+'
        if ($fields.Count -lt 4 -or $fields[0] -ine "UDP") {
            continue
        }
        $rowProcessId = 0
        if (-not [int]::TryParse($fields[-1], [ref]$rowProcessId) -or $rowProcessId -ne $ProcessId) {
            continue
        }
        $endpointMatch = [regex]::Match($fields[1], '^(?<address>\[[^\]]+\]|[^:]+):(?<port>\d+)$')
        if (-not $endpointMatch.Success) {
            throw ("netstat returned an unparseable UDP endpoint for process {0}: {1}" -f $ProcessId, $fields[1])
        }
        $address = $endpointMatch.Groups["address"].Value
        if ($address.StartsWith("[", [StringComparison]::Ordinal) -and $address.EndsWith("]", [StringComparison]::Ordinal)) {
            $address = $address.Substring(1, $address.Length - 2)
        }
        $port = [int]$endpointMatch.Groups["port"].Value
        $key = "{0}:{1}" -f $address, $port
        if ($seen.Add($key)) {
            [void]$endpoints.Add([pscustomobject]@{ LocalAddress = $address; LocalPort = $port })
        }
    }

    if ($null -ne (Get-Command Get-NetUDPEndpoint -ErrorAction SilentlyContinue)) {
        try {
            foreach ($endpoint in @(Get-NetUDPEndpoint -OwningProcess $ProcessId -ErrorAction Stop)) {
                $address = [string]$endpoint.LocalAddress
                $port = [int]$endpoint.LocalPort
                $key = "{0}:{1}" -f $address, $port
                if ($seen.Add($key)) {
                    [void]$endpoints.Add([pscustomobject]@{ LocalAddress = $address; LocalPort = $port })
                }
            }
        } catch {
            # netstat remains the unprivileged source of truth.
        }
    }
    return $endpoints
}

$mutexName = "Global\KaigenOfflineFriendRequestLoopbackHarness"
$mutex = [Threading.Mutex]::new($false, $mutexName)
$mutexAcquired = $false
$childProcess = $null
$primaryError = $null
$cleanupErrors = [Collections.Generic.List[string]]::new()
$udpPortFrom = 38400
$udpPortTo = 38431
$nativeDeadlineSeconds = 120

try {
    try {
        $mutexAcquired = $mutex.WaitOne(0)
    } catch [Threading.AbandonedMutexException] {
        $mutexAcquired = $true
    }
    if (-not $mutexAcquired) {
        throw "Another offline friend-request loopback harness is already compiling or running."
    }

    [IO.Directory]::CreateDirectory($harnessDirectory) | Out-Null
    Assert-HarnessDirectoriesAreNotReparsePoints
    foreach ($harnessFile in $harnessFiles) {
        Remove-HarnessFile -Path $harnessFile
    }

    $compile = '"{0}" -no_logo -arch=x64 -host_arch=x64 && cl.exe /nologo /W4 /WX /std:c11 /MD /I"{1}" /I"{6}" /Fo"{5}" "{2}" /link /LIBPATH:"{3}" toxcore.lib /OUT:"{4}"' -f $developerShell, $toxSource, $source, $toxBuild, $executable, $object, $pthreadsBuild
    & $env:ComSpec /d /s /c $compile
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $executable)) {
        throw "The offline friend-request loopback harness did not compile."
    }

    Copy-Item -LiteralPath (Join-Path $toxBuild "toxcore.dll") -Destination $harnessToxcore
    Copy-Item -LiteralPath (Join-Path $pthreadsBuild "pthreadVC3.dll") -Destination $harnessPthreads

    Write-Host "Stable native harness path: $executable"
    Write-Host "Expected loopback UDP endpoints: 127.0.0.1:$udpPortFrom-$udpPortTo"
    $childProcess = Start-Process -FilePath $executable -WorkingDirectory $harnessDirectory -NoNewWindow -PassThru
    $null = $childProcess.Handle
    $deadline = [DateTime]::UtcNow.AddSeconds($nativeDeadlineSeconds)
    $observedPorts = [Collections.Generic.HashSet[int]]::new()
    while (-not $childProcess.WaitForExit(250)) {
        $endpoints = @(Get-HarnessUdpEndpoints -ProcessId $childProcess.Id)
        foreach ($endpoint in $endpoints) {
            $localAddress = [string]$endpoint.LocalAddress
            $localPort = [int]$endpoint.LocalPort
            if ($localAddress -ne "127.0.0.1" -or $localPort -lt $udpPortFrom -or $localPort -gt $udpPortTo) {
                throw ("The native loopback harness opened an unexpected UDP endpoint: {0}:{1}." -f $localAddress, $localPort)
            }
            [void]$observedPorts.Add($localPort)
        }
        if ([DateTime]::UtcNow -ge $deadline) {
            throw "The offline friend-request loopback regression exceeded the $nativeDeadlineSeconds-second deadline."
        }
    }
    $childProcess.WaitForExit()
    $childProcess.Refresh()
    $childExitCode = $childProcess.ExitCode
    if ($observedPorts.Count -eq 0) {
        throw "The native loopback harness exited without an observable UDP endpoint."
    }
    if ($null -eq $childExitCode -or -not ($childExitCode -is [int])) {
        throw "Windows did not provide an integer exit code for the native loopback harness child."
    }
    if ($childExitCode -ne 0) {
        throw "The offline friend-request loopback regression failed with exit code $childExitCode."
    }
    Write-Host ("Verified native harness UDP ports: " + (($observedPorts | Sort-Object) -join ", "))
} catch {
    $primaryError = $_
} finally {
    $childExited = $null -eq $childProcess
    if ($null -ne $childProcess) {
        try {
            if (-not $childProcess.HasExited) {
                Stop-Process -InputObject $childProcess -Force -ErrorAction Stop
            }
        } catch {
            [void]$cleanupErrors.Add("child termination: $($_.Exception.Message)")
        }
        try {
            if (-not $childProcess.WaitForExit(10000)) {
                throw "The native loopback harness child did not exit during cleanup."
            }
            $childExited = $true
        } catch {
            [void]$cleanupErrors.Add("child wait: $($_.Exception.Message)")
        } finally {
            $childProcess.Dispose()
        }
    }

    if ($mutexAcquired -and $childExited) {
        try {
            Assert-HarnessDirectoriesAreNotReparsePoints
            foreach ($harnessFile in $harnessFiles) {
                Remove-HarnessFile -Path $harnessFile
            }
        } catch {
            [void]$cleanupErrors.Add("artifact cleanup: $($_.Exception.Message)")
        }
    } elseif ($mutexAcquired) {
        [void]$cleanupErrors.Add("artifact cleanup skipped because the exact native child exit was not confirmed")
    }
    if ($mutexAcquired) {
        try {
            $mutex.ReleaseMutex()
        } catch {
            [void]$cleanupErrors.Add("mutex release: $($_.Exception.Message)")
        }
    }
    try {
        $mutex.Dispose()
    } catch {
        [void]$cleanupErrors.Add("mutex disposal: $($_.Exception.Message)")
    }
}

if ($null -ne $primaryError) {
    if ($cleanupErrors.Count -gt 0) {
        Write-Warning ("Additional loopback harness cleanup errors: " + ($cleanupErrors -join "; "))
    }
    $PSCmdlet.ThrowTerminatingError($primaryError)
}
if ($cleanupErrors.Count -gt 0) {
    throw "The offline friend-request loopback regression passed, but cleanup failed: $($cleanupErrors -join '; ')"
}
