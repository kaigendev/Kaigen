#requires -Version 7.6.5
[CmdletBinding()]
param([string]$EvidenceDirectory)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'MSI payload boundary tests require Windows filesystem semantics.' }
$source = Join-Path $PSScriptRoot 'build-windows-msi.ps1'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($source, [ref]$tokens, [ref]$errors)
if ($errors.Count -ne 0) { throw 'MSI producer does not parse.' }
$definitions = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-MsiProgramPayload' }, $false))
if ($definitions.Count -ne 1) { throw 'Expected exactly one producer payload validator.' }
# Execute the producer's actual validator without running packaging or installation.
. ([scriptblock]::Create($definitions[0].Extent.Text))
if (-not $EvidenceDirectory) { $EvidenceDirectory = Join-Path ([IO.Path]::GetTempPath()) ('kaigen-msi-boundary-' + [guid]::NewGuid().ToString('N')) }
$EvidenceDirectory = [IO.Path]::GetFullPath($EvidenceDirectory)
if (Test-Path -LiteralPath $EvidenceDirectory) { throw 'Boundary evidence directory must be fresh.' }
[IO.Directory]::CreateDirectory($EvidenceDirectory) | Out-Null
$results = [Collections.Generic.List[object]]::new()
function New-Case([string]$Name) {
    $root = Join-Path $EvidenceDirectory $Name
    [IO.Directory]::CreateDirectory($root) | Out-Null
    [IO.File]::WriteAllText((Join-Path $root 'Kaigen.exe'), 'synthetic program')
    return $root
}
function Put-File([string]$Root, [string]$Relative) {
    $path = Join-Path $Root $Relative
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($path)) | Out-Null
    [IO.File]::WriteAllText($path, 'synthetic private canary')
    return $path
}
function Expect-Rejection([string]$Name, [string]$Root, [string]$Pattern) {
    $failure = $null
    try { $null = Get-MsiProgramPayload -Root $Root } catch { $failure = $_.Exception.Message }
    if (-not $failure -or $failure -notmatch $Pattern) { throw "Boundary case $Name failed: $failure" }
    $results.Add([pscustomobject]@{name=$Name;status='PASS';observed=$failure})
}
$valid = New-Case 'program-resources'
foreach ($relative in @('TorExpertBundle/data/geoip','TorExpertBundle/data/geoip6','TorExpertBundle/data/torrc-defaults','WebView2Runtime/v8_context_snapshot.bin','runtime/dictionaries/ru-RU.dic')) { $null = Put-File $valid $relative }
foreach ($name in @('profiles','data','downloads')) { [IO.Directory]::CreateDirectory((Join-Path $valid $name)) | Out-Null }
$payload = Get-MsiProgramPayload -Root $valid
if ($payload.Files.Count -ne 6 -or @($payload.Directories | Where-Object Name -in @('profiles','data','downloads')).Count -ne 4) { throw 'Valid resources or empty portable directories were not preserved.' }
$results.Add([pscustomobject]@{name='program-resources-and-empty-user-roots';status='PASS';files=$payload.Files.Count})
foreach ($relative in @('profiles/unknown.bin','data/session.json','downloads/document.txt','PrOfIlEs/nested/private.dat','messages/archive.bin','settings/state.json','runtime/user-state/private.bin','TorExpertBundle/data/state','TorExpertBundle/data/nested/canary','WebView2Runtime/Cache/entry.bin','WebView2Runtime/Local State','runtime/dictionaries/secret.kai','runtime/qtox-import/private.sqlite','WebView2Runtime/User Data/record.bin','WebView2Runtime/Default/record.bin','runtime/dictionaries/data/record.bin')) {
    $name = 'private-' + $results.Count
    $root = New-Case $name; $canary = Put-File $root $relative
    $before = (Get-FileHash -LiteralPath $canary -Algorithm SHA256).Hash
    Expect-Rejection $name $root 'Protected|unrecognized|runtime state|Private runtime data'
    if ((Get-FileHash -LiteralPath $canary -Algorithm SHA256).Hash -cne $before) { throw 'Boundary validation mutated a canary.' }
}
$outside = New-Case 'junction-target'; $canary = Put-File $outside 'outside-canary.bin'
$canaryHash = (Get-FileHash -LiteralPath $canary -Algorithm SHA256).Hash
$root = New-Case 'descendant-junction'
New-Item -ItemType Junction -Path (Join-Path $root 'WebView2Runtime') -Target $outside | Out-Null
Expect-Rejection 'descendant-junction' $root 'reparse point'
$alias = Join-Path $EvidenceDirectory 'ancestor-junction'
New-Item -ItemType Junction -Path $alias -Target $valid | Out-Null
Expect-Rejection 'ancestor-junction' $alias 'reparse point'
if ((Get-FileHash -LiteralPath $canary -Algorithm SHA256).Hash -cne $canaryHash) { throw 'Link validation mutated the outside canary.' }
$receipt = [ordered]@{schema=1;status='PASS';producerSha256=(Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash;cases=@($results);evidenceDirectory=$EvidenceDirectory;installationExecuted=$false}
[IO.File]::WriteAllText((Join-Path $EvidenceDirectory 'result.json'), ($receipt | ConvertTo-Json -Depth 6) + "`n", [Text.UTF8Encoding]::new($false))
Write-Output "MSI_PAYLOAD_BOUNDARY_PASS cases=$($results.Count) evidence=$EvidenceDirectory"
