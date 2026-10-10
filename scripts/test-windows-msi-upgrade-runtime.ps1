# Run only inside the selected disposable Windows guest. Preparation never installs.
# Simple install/upgrade regression: exact program payload and preserved synthetic user files.
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('Prepare','InstallPrevious','Upgrade','Cleanup','Status')][string]$Phase,
    [Parameter(Mandatory)][string]$WorkRoot,
    [string]$PreviousMsi, [string]$CandidateMsi,
    [string]$PreviousManifest, [string]$CandidateManifest,
    [string]$ExpectedPreviousMsiSha256, [string]$ExpectedCandidateMsiSha256,
    [string]$ExpectedComputerName, [string]$ExpectedUserName
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'Windows guest runtime required.' }
$utf8 = [Text.UTF8Encoding]::new($false)
$WorkRoot = [IO.Path]::GetFullPath($WorkRoot).TrimEnd('\')
$allowed = 'C:\KaigenLab\disposable\'
if (-not $WorkRoot.StartsWith($allowed, [StringComparison]::OrdinalIgnoreCase) -or $WorkRoot.Length -le $allowed.Length) {
    throw 'WorkRoot must be a dedicated child of C:\KaigenLab\disposable.'
}
for ($cursor = $WorkRoot; $cursor; $cursor = [IO.Path]::GetDirectoryName($cursor)) {
    if ((Test-Path -LiteralPath $cursor) -and ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'Reparse points are forbidden in the disposable root ancestry.'
    }
}
function Scoped([string]$Path) {
    $absolute = [IO.Path]::GetFullPath($Path)
    if (-not $absolute.StartsWith($WorkRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw "Path escapes this disposable run: $Path" }
    for ($cursor = $absolute; $cursor.Length -gt $WorkRoot.Length; $cursor = [IO.Path]::GetDirectoryName($cursor)) {
        if ((Test-Path -LiteralPath $cursor) -and ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Reparse point inside the disposable run.' }
    }
    return $absolute
}
function PathInRun([string]$Name) { return Scoped (Join-Path $WorkRoot $Name) }
function Hash([string]$Path) { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Quote([string]$Value) {
    if ($Value.Contains('"') -or $Value.Contains("`n") -or $Value.Contains("`r")) { throw 'Invalid command argument.' }
    return '"' + $Value.TrimEnd('\') + '"'
}
function WriteJson([string]$Path, $Value) {
    $destination=Scoped $Path; $temporary=Scoped ($destination+'.'+$PID+'.tmp')
    [IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 24) + "`r`n", $utf8)
    if(Test-Path -LiteralPath $destination){
        # Windows PowerShell 5 converts a direct null string argument to an empty path.
        $replace=[IO.File].GetMethod('Replace',[type[]]@([string],[string],[string]))
        $arguments=[object[]]::new(3)
        $arguments[0]=[string]$temporary; $arguments[1]=[string]$destination; $arguments[2]=$null
        [void]$replace.Invoke($null,$arguments)
    }else{[IO.File]::Move($temporary,$destination)}
}
function ReadJson([string]$Path) { return Get-Content -LiteralPath (Scoped $Path) -Raw -Encoding UTF8 | ConvertFrom-Json }
function Assert([bool]$Value, [string]$Message) { if (-not $Value) { throw $Message } }
function Record([string]$Name, $Value) {
    $path = PathInRun ('receipts\' + $Name + '.json')
    Assert (-not (Test-Path -LiteralPath $path)) "Receipt already exists: $Name"
    WriteJson $path $Value
}
function NewInstaller { return New-Object -ComObject WindowsInstaller.Installer }
function ReleaseCom($Object) { if ($null -ne $Object) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($Object) } }
function Cell($Record, [int]$Column) { return $Record.GetType().InvokeMember('StringData','GetProperty',$null,$Record,@($Column)) }
function Rows($Database, [string]$Query, [int]$Columns) {
    $view = $Database.OpenView($Query)
    try {
        [void]$view.Execute()
        while ($null -ne ($record = $view.Fetch())) {
            $values = for ($i=1; $i -le $Columns; $i++) { Cell $record $i }
            [pscustomobject]@{ values = @($values) }
        }
    } finally { [void]$view.Close() }
}
function MsiIdentity([string]$Path) {
    $installer = NewInstaller; $db = $null
    try {
        $db = $installer.OpenDatabase($Path, 0); $properties = @{}
        Rows $db 'SELECT `Property`, `Value` FROM `Property`' 2 | ForEach-Object { $properties[$_.values[0]]=$_.values[1] }
        return [pscustomobject]@{path=$Path;sha256=(Hash $Path);productCode=$properties['ProductCode'];upgradeCode=$properties['UpgradeCode'];version=$properties['ProductVersion'];name=$properties['ProductName']}
    } finally { ReleaseCom $db; ReleaseCom $installer }
}
function ProductState([string]$Code) {
    $installer = NewInstaller
    try { return [int]$installer.GetType().InvokeMember('ProductState','GetProperty',$null,$installer,@($Code)) }
    finally { ReleaseCom $installer }
}
function InstallFolderRegistry {
    $base=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser,[Microsoft.Win32.RegistryView]::Registry64)
    $key=$null
    try { $key=$base.OpenSubKey('Software\Kaigen\Installer'); if ($null -eq $key) { return $null }; return [string]$key.GetValue('InstallFolder') }
    finally { if ($null -ne $key) { $key.Dispose() }; $base.Dispose() }
}
function AssertRegistered($Identity) {
    Assert ((ProductState $Identity.productCode) -eq 5) ('Product not installed: ' + $Identity.productCode)
    $location=InstallFolderRegistry
    Assert ($location -and [string]::Equals([IO.Path]::GetFullPath($location).TrimEnd('\'),$state.installRoot,[StringComparison]::OrdinalIgnoreCase)) 'Registered install folder is not this disposable run.'
}
function PayloadPath([string]$Relative) {
    Assert (-not [IO.Path]::IsPathRooted($Relative) -and $Relative -notmatch '(^|[\\/])\.\.([\\/]|$)' -and $Relative -notmatch ':') 'Invalid manifest relative path.'
    $path=Scoped (Join-Path $state.installRoot $Relative)
    Assert ($path.StartsWith($state.installRoot+'\',[StringComparison]::OrdinalIgnoreCase)) 'Manifest path escaped INSTALLFOLDER.'
    return $path
}
function CheckPayload($Manifest, [switch]$Absent) {
    $checked=0
    foreach($entry in @($Manifest.files)) {
        $path=PayloadPath ([string]$entry.path)
        if ($Absent) { Assert (-not (Test-Path -LiteralPath $path -PathType Leaf)) ('Packaged file remains: '+$entry.path) }
        else {
            Assert (Test-Path -LiteralPath $path -PathType Leaf) ('Missing packaged file: '+$entry.path)
            Assert ((Hash $path) -ceq ([string]$entry.sha256).ToLowerInvariant()) ('Payload SHA mismatch: '+$entry.path)
            Assert ((Get-Item -LiteralPath $path).Length -eq [long]$entry.bytes) ('Payload byte count mismatch: '+$entry.path)
        }
        $checked++
    }
    return $checked
}
function CheckCanaries {
    $canaries=ReadJson (PathInRun 'canaries.json')
    foreach($entry in @($canaries)) { Assert ((Test-Path -LiteralPath $entry.path -PathType Leaf) -and (Hash $entry.path) -ceq $entry.sha256) ('Synthetic canary changed: '+$entry.relative) }
    return @($canaries).Count
}
function SeedCanaries {
    Assert (-not (Test-Path -LiteralPath (PathInRun 'canaries.json'))) 'Canaries already seeded.'
    $canaries=foreach($relative in @('profiles\msi-regression-canary.kai','profiles\nested\sentinel.bin','data\msi-regression\history-canary.bin','downloads\msi-regression\download-canary.txt')) {
        $path=PayloadPath $relative; Assert (-not (Test-Path -LiteralPath $path)) 'Canary destination already exists.'
        [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($path)) | Out-Null
        [IO.File]::WriteAllText($path,('SYNTHETIC MSI PRESERVATION CANARY '+$state.runId+' '+$relative),$utf8)
        [pscustomobject]@{relative=$relative;path=$path;sha256=(Hash $path)}
    }
    WriteJson (PathInRun 'canaries.json') @($canaries)
}
function AssertInputs {
    Assert ((Hash $state.previous.path) -ceq $state.previous.sha256) 'Previous MSI changed.'
    Assert ((Hash $state.candidate.path) -ceq $state.candidate.sha256) 'Candidate MSI changed.'
    Assert ((Hash $state.previousManifestPath) -ceq $state.previousManifestSha256) 'Previous payload manifest changed.'
    Assert ((Hash $state.candidateManifestPath) -ceq $state.candidateManifestSha256) 'Candidate payload manifest changed.'
}
function AssertGuestIdentity {
    Assert ([Environment]::MachineName -ieq $state.guest.computer) 'Runtime is not the selected disposable guest.'
    Assert ([Environment]::UserName -ieq $state.guest.user) 'Runtime is not the selected disposable user.'
}
function RunMsi([string]$Arguments, [string]$LogName) {
    $log=PathInRun ('logs\'+$LogName+'.log')
    Assert (-not (Test-Path -LiteralPath $log)) ('MSI log already exists: '+$LogName)
    $command=$Arguments+' /norestart /l*v '+(Quote $log)
    $process=Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\msiexec.exe') -ArgumentList $command -WorkingDirectory $WorkRoot -WindowStyle Hidden -PassThru
    [void]$process.Handle
    $startedAt=$process.StartTime.ToUniversalTime().ToString('o')
    WriteJson (PathInRun 'msi-current.json') ([ordered]@{pid=$process.Id;startedAt=$startedAt;log=$log;arguments=$command})
    Assert ($process.WaitForExit(300000)) ('MSI process still active after 300 seconds; no termination attempted. PID='+$process.Id)
    return [pscustomobject]@{pid=$process.Id;startedAt=$startedAt;exitedAt=$process.ExitTime.ToUniversalTime().ToString('o');exitCode=$process.ExitCode;log=$log;logSha256=(Hash $log);arguments=$command}
}
$statePath=PathInRun 'state.json'
if ($Phase -eq 'Prepare') {
    Assert (-not (Test-Path -LiteralPath $statePath)) 'This disposable run is already prepared.'
    [IO.Directory]::CreateDirectory($WorkRoot) | Out-Null
    foreach($dir in @('receipts','logs')) { [IO.Directory]::CreateDirectory((PathInRun $dir)) | Out-Null }
    foreach($value in @($PreviousMsi,$CandidateMsi,$PreviousManifest,$CandidateManifest)) {
        Assert (-not [string]::IsNullOrWhiteSpace($value)) 'Prepare requires both MSIs and both payload manifests.'
        Assert (Test-Path -LiteralPath (Scoped $value) -PathType Leaf) 'Prepared input is missing.'
    }
    foreach($value in @($ExpectedPreviousMsiSha256,$ExpectedCandidateMsiSha256)) { Assert ($value -match '^[A-Fa-f0-9]{64}$') 'Both expected MSI SHA256 values are required.' }
    Assert ($ExpectedComputerName -and $ExpectedUserName) 'Prepare requires explicit ExpectedComputerName and ExpectedUserName.'
    Assert ([Environment]::MachineName -ieq $ExpectedComputerName -and [Environment]::UserName -ieq $ExpectedUserName) 'Prepare is not running on the selected disposable guest/user.'
    Assert ((Hash $PreviousMsi) -ceq $ExpectedPreviousMsiSha256.ToLowerInvariant()) 'Previous MSI does not match requested artifact.'
    Assert ((Hash $CandidateMsi) -ceq $ExpectedCandidateMsiSha256.ToLowerInvariant()) 'Candidate MSI does not match requested artifact.'
    $previous=MsiIdentity (Scoped $PreviousMsi); $candidate=MsiIdentity (Scoped $CandidateMsi)
    Assert ($previous.productCode -ne $candidate.productCode -and $previous.upgradeCode -eq $candidate.upgradeCode) 'Require different ProductCodes and the same UpgradeCode.'
    $a=[version]$previous.version; $b=[version]$candidate.version
    Assert ($a.Build -ge 0 -and $b.Build -ge 0 -and $b -gt $a) 'Candidate must increase the complete MSI version with at least three fields.'
    Assert ((ProductState $previous.productCode) -eq -1 -and (ProductState $candidate.productCode) -eq -1 -and -not (InstallFolderRegistry)) 'Prepare requires a disposable user with neither selected product installed/advertised and no Kaigen installer registry.'
    $oldManifest=ReadJson (Scoped $PreviousManifest); $newManifest=ReadJson (Scoped $CandidateManifest)
    Assert ($oldManifest.productCode -eq $previous.productCode.Trim('{}') -or $oldManifest.productCode -eq $previous.productCode) 'Previous manifest ProductCode mismatch.'
    Assert ($newManifest.productCode -eq $candidate.productCode.Trim('{}') -or $newManifest.productCode -eq $candidate.productCode) 'Candidate manifest ProductCode mismatch.'
    $oldExe=@($oldManifest.files | Where-Object path -ceq 'Kaigen.exe'); $newExe=@($newManifest.files | Where-Object path -ceq 'Kaigen.exe')
    Assert ($oldExe.Count -eq 1 -and $newExe.Count -eq 1 -and $oldExe[0].sha256 -ne $newExe[0].sha256) 'Runtime requires different exact previous/candidate Kaigen.exe bytes.'
    $state=[pscustomobject][ordered]@{schema=2;runId=([guid]::NewGuid().ToString());preparedAt=[DateTime]::UtcNow.ToString('o');workRoot=$WorkRoot;installRoot=(PathInRun 'installed');runnerSha256=(Hash $PSCommandPath);guest=@{computer=$ExpectedComputerName;user=$ExpectedUserName};previous=$previous;candidate=$candidate;previousManifestPath=(Scoped $PreviousManifest);candidateManifestPath=(Scoped $CandidateManifest);previousManifestSha256=(Hash $PreviousManifest);candidateManifestSha256=(Hash $CandidateManifest)}
    Assert (-not (Test-Path -LiteralPath $state.installRoot)) 'Install target already exists.'
    foreach($entry in @($oldManifest.files)+@($newManifest.files)) {
        [void](PayloadPath ([string]$entry.path))
        Assert ([string]$entry.sha256 -match '^[A-Fa-f0-9]{64}$' -and [long]$entry.bytes -ge 0) 'Invalid payload identity.'
    }
    WriteJson $statePath $state
    Record 'prepare' ([ordered]@{status='PREPARED_NOT_INSTALLED';state=$state})
    Write-Output 'PREPARED_NOT_INSTALLED'; return
}
$state=ReadJson $statePath
Assert ($state.schema -eq 2 -and $state.workRoot -ceq $WorkRoot) 'State belongs to a different run or runner schema.'
Assert ((Hash $PSCommandPath) -ceq $state.runnerSha256) 'Runner changed since Prepare; create a fresh evidence run.'
AssertInputs
AssertGuestIdentity
$previousPayload=ReadJson $state.previousManifestPath; $candidatePayload=ReadJson $state.candidateManifestPath
$receipt=[ordered]@{phase=$Phase;startedAt=[DateTime]::UtcNow.ToString('o');status='RUNNING'}
try {
    switch ($Phase) {
        'Status' { $state | ConvertTo-Json -Depth 12; return }
        'InstallPrevious' {
            Assert ((ProductState $state.previous.productCode) -eq -1 -and (ProductState $state.candidate.productCode) -eq -1 -and -not (InstallFolderRegistry)) 'Previous install requires a clean selected-product state.'
            $receipt.msi=RunMsi ('/i '+(Quote $state.previous.path)+' /qn INSTALLFOLDER='+(Quote $state.installRoot)) 'previous-install'
            Assert ($receipt.msi.exitCode -in @(0,3010)) 'Previous install failed.'
            AssertRegistered $state.previous; $receipt.payloadFiles=CheckPayload $previousPayload
            SeedCanaries; $receipt.canaries=CheckCanaries
        }
        'Upgrade' {
            AssertRegistered $state.previous; [void](CheckCanaries)
            $receipt.msi=RunMsi ('/i '+(Quote $state.candidate.path)+' /qn INSTALLFOLDER='+(Quote $state.installRoot)) 'candidate-upgrade'
            Assert ($receipt.msi.exitCode -in @(0,3010)) 'Candidate upgrade failed.'
            AssertRegistered $state.candidate; Assert ((ProductState $state.previous.productCode) -eq -1) 'Previous ProductCode survived the major upgrade.'
            $receipt.payloadFiles=CheckPayload $candidatePayload; $receipt.canaries=CheckCanaries
        }
        'Cleanup' {
            $receipt.uninstalls=@()
            foreach($identity in @($state.candidate,$state.previous)) {
                if ((ProductState $identity.productCode)-ne 5) { continue }
                AssertRegistered $identity
                $operation=RunMsi ('/x '+$identity.productCode+' /qn') ('uninstall-'+$identity.productCode.Trim('{}'))
                $receipt.uninstalls+=@($operation); Assert ($operation.exitCode -in @(0,3010)) 'Exact disposable MSI uninstall failed.'
            }
            Assert ((ProductState $state.previous.productCode)-eq -1 -and (ProductState $state.candidate.productCode)-eq -1) 'Selected products remain registered or advertised.'
            $receipt.previousFilesAbsent=CheckPayload $previousPayload -Absent; $receipt.candidateFilesAbsent=CheckPayload $candidatePayload -Absent
            if(Test-Path -LiteralPath (PathInRun 'canaries.json')){$receipt.canaries=CheckCanaries}
            $receipt.retained='Evidence and synthetic canaries retained; no recursive filesystem deletion or process termination.'
        }
    }
    $receipt.status='PASS'; $receipt.finishedAt=[DateTime]::UtcNow.ToString('o')
} catch {
    $receipt.status='FAIL'; $receipt.error=$_.Exception.Message; $receipt.finishedAt=[DateTime]::UtcNow.ToString('o')
    Record ($Phase+'-'+[DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfff')) $receipt
    throw
}
Record ($Phase+'-'+[DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfff')) $receipt
$receipt|ConvertTo-Json -Depth 12
exit 0
