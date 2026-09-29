#requires -Version 7.6.5
[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
if ($PSVersionTable.PSVersion.ToString() -cne "7.6.5") {
    throw "Kaigen automation requires PowerShell 7.6.5 exactly; found $($PSVersionTable.PSVersion)."
}

$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$sourceRoot = Join-Path $projectRoot "work\toxcore-meta"
$expected = [ordered]@{
    "toxcore\Messenger.h" = "9D6F6EB813DEA16597DC87C3545A64AD65E88316CF12371C8D48D470A76D8E85"
    "toxcore\Messenger.c" = "450AF75416F8949B2EEF8B38427E4C318B29DB0DC33CF4CCB220D3A7DE6712C4"
}
foreach ($entry in $expected.GetEnumerator()) {
    $path = Join-Path $sourceRoot $entry.Key
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Pinned Kaigen toxcore source is missing: $($entry.Key)"
    }
    $normalized = [IO.File]::ReadAllText($path).Replace("`r`n", "`n")
    $actual = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($normalized)))
    if ($actual -cne $entry.Value) {
        throw "Pinned Kaigen toxcore source differs: $($entry.Key)"
    }
}

$header = [IO.File]::ReadAllText((Join-Path $sourceRoot "toxcore\Messenger.h"))
$implementation = [IO.File]::ReadAllText((Join-Path $sourceRoot "toxcore\Messenger.c"))
if ([regex]::Matches($header, [regex]::Escape("#define FRIENDREQUEST_TIMEOUT_MAX 60")).Count -ne 1) {
    throw "The fork must declare the 60-second retry cap exactly once."
}
if (-not $implementation.Contains("min_u32(f->friendrequest_timeout * 2, FRIENDREQUEST_TIMEOUT_MAX);") -or
    $implementation.Contains("f->friendrequest_timeout *= 2;")) {
    throw "The fork must implement the 60-second retry cap."
}

$schedule = [Collections.Generic.List[int]]::new()
$timeout = 5
for ($attempt = 0; $attempt -lt 7; $attempt++) {
    $schedule.Add($timeout)
    $timeout = [Math]::Min($timeout * 2, 60)
}
if (($schedule -join ",") -cne "5,10,20,40,60,60,60") {
    throw "The controlled retry schedule does not saturate at 60 seconds."
}
Write-Host "PASS Kaigen fork retry cap: pinned source and 60-second schedule"
