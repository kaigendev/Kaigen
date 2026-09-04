#requires -Version 7.6.4
[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$utf8NoBom = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $utf8NoBom
$OutputEncoding = $utf8NoBom
if ($PSVersionTable.PSVersion.ToString() -cne "7.6.4") {
    throw "Kaigen automation requires PowerShell 7.6.4 exactly; found $($PSVersionTable.PSVersion)."
}
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$preparationScript = Join-Path $PSScriptRoot "prepare-dependencies.ps1"
$tokens = $null
$parseErrors = $null
$scriptAst = [Management.Automation.Language.Parser]::ParseFile($preparationScript, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -ne 0) { throw "Could not parse the Windows dependency preparation script." }
$functionDefinitions = @($scriptAst.FindAll({
    param($node)
    $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
        $node.Name -ceq 'Apply-KaigenToxcoreRetryCap'
}, $true))
if ($functionDefinitions.Count -ne 1) {
    throw "Could not isolate exactly one Apply-KaigenToxcoreRetryCap function from the Windows dependency preparation script."
}
$functionSource = $functionDefinitions[0].Extent.Text
. ([ScriptBlock]::Create($functionSource))

function Assert-Condition {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) {
        throw $Message
    }
}

function New-ToxcoreFixture {
    param(
        [string]$Path,
        [string]$HeaderLine = "#define FRIENDREQUEST_TIMEOUT 5",
        [string]$RetryLine = "        f->friendrequest_timeout *= 2;"
    )
    $toxcore = Join-Path $Path "toxcore"
    [IO.Directory]::CreateDirectory($toxcore) | Out-Null
    [IO.File]::WriteAllText((Join-Path $toxcore "Messenger.h"), "before`n$HeaderLine`nafter`n", [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $toxcore "Messenger.c"), "before`n$RetryLine`nafter`n", [Text.UTF8Encoding]::new($false))
}

function Assert-Throws {
    param([scriptblock]$Action, [string]$Message)
    $thrown = $false
    try {
        & $Action
    } catch {
        $thrown = $true
    }
    Assert-Condition $thrown $Message
}

function Get-FriendRequestRetrySchedule {
    param(
        [int]$Attempts,
        [int]$MaximumSeconds = 0
    )
    $timeout = 5
    $schedule = [Collections.Generic.List[int]]::new()
    for ($attempt = 0; $attempt -lt $Attempts; $attempt++) {
        $schedule.Add($timeout)
        $timeout *= 2
        if ($MaximumSeconds -gt 0 -and $timeout -gt $MaximumSeconds) {
            $timeout = $MaximumSeconds
        }
    }
    return $schedule.ToArray()
}

$temporaryRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$temporary = Join-Path $temporaryRoot ("Kaigen-toxcore-retry-cap-" + [guid]::NewGuid().ToString("N"))
[IO.Directory]::CreateDirectory($temporary) | Out-Null

try {
    $valid = Join-Path $temporary "valid"
    New-ToxcoreFixture -Path $valid
    Apply-KaigenToxcoreRetryCap -SourceDirectory $valid
    $header = [IO.File]::ReadAllText((Join-Path $valid "toxcore\Messenger.h"))
    $implementation = [IO.File]::ReadAllText((Join-Path $valid "toxcore\Messenger.c"))
    Assert-Condition ([regex]::Matches($header, [regex]::Escape("#define FRIENDREQUEST_TIMEOUT_MAX 60")).Count -eq 1) "The cap declaration must be inserted exactly once."
    Assert-Condition ($implementation.Contains("min_u32(f->friendrequest_timeout * 2, FRIENDREQUEST_TIMEOUT_MAX);")) "The retry must use a saturating 60-second cap."
    Assert-Condition (-not $implementation.Contains("f->friendrequest_timeout *= 2;")) "The unbounded retry must be removed."

    $headerAfterFirstRun = $header
    $implementationAfterFirstRun = $implementation
    Apply-KaigenToxcoreRetryCap -SourceDirectory $valid
    Assert-Condition ([IO.File]::ReadAllText((Join-Path $valid "toxcore\Messenger.h")) -ceq $headerAfterFirstRun) "The header patch must be idempotent."
    Assert-Condition ([IO.File]::ReadAllText((Join-Path $valid "toxcore\Messenger.c")) -ceq $implementationAfterFirstRun) "The implementation patch must be idempotent."

    $cappedSchedule = Get-FriendRequestRetrySchedule -Attempts 7 -MaximumSeconds 60
    $uncappedSchedule = Get-FriendRequestRetrySchedule -Attempts 7
    Assert-Condition (($cappedSchedule -join ",") -ceq "5,10,20,40,60,60,60") "The controlled capped model must saturate at 60 seconds."
    Assert-Condition (($uncappedSchedule -join ",") -ceq "5,10,20,40,80,160,320") "The controlled unbounded model must retain exponential growth."
    Assert-Condition ($cappedSchedule[4] -le 60) "A recipient restored after four failed intervals must be retried within the 60-second recovery budget."
    Assert-Condition ($uncappedSchedule[4] -gt 60) "The same recovery budget must fail without the retry cap."

    $changedHeader = Join-Path $temporary "changed-header"
    New-ToxcoreFixture -Path $changedHeader -HeaderLine "#define FRIENDREQUEST_TIMEOUT 6"
    Assert-Throws { Apply-KaigenToxcoreRetryCap -SourceDirectory $changedHeader } "A changed upstream timeout declaration must fail closed."

    $changedImplementation = Join-Path $temporary "changed-implementation"
    New-ToxcoreFixture -Path $changedImplementation -HeaderLine "#define FRIENDREQUEST_TIMEOUT_MAX 60" -RetryLine "        retry_friend_request_later(f);"
    Assert-Throws { Apply-KaigenToxcoreRetryCap -SourceDirectory $changedImplementation } "A changed upstream retry implementation must fail closed."

    Write-Host "PASS toxcore retry-cap transformation (60 seconds, idempotent, fail-closed)"
    Write-Host "PASS controlled recovery model: capped=$($cappedSchedule -join '->') vs unbounded=$($uncappedSchedule -join '->')"
} finally {
    $resolvedTemporary = [IO.Path]::GetFullPath($temporary)
    if ($resolvedTemporary.StartsWith($temporaryRoot, [StringComparison]::OrdinalIgnoreCase) -and
        [IO.Path]::GetFileName($resolvedTemporary).StartsWith("Kaigen-toxcore-retry-cap-", [StringComparison]::Ordinal)) {
        Remove-Item -LiteralPath $resolvedTemporary -Recurse -Force -ErrorAction SilentlyContinue
    }
}
