# Run only inside the selected disposable Windows guest. Preparation never installs.
# Each phase emits an independent receipt; a failed phase is not a lifecycle PASS.
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('Prepare','InstallPrevious','ProbeRelocation','ProbeRollback','Upgrade','BeginWatch','PrepareWatch','CalibrateWatch','WatchWorker','EndWatch','StartUi','UiWaitWorker','InspectFinishUi','MarkFinishUi','VerifyFinishUi','FinishUi','LaunchInstalled','Cleanup','Status')][string]$Phase,
    [Parameter(Mandatory)][string]$WorkRoot,
    [string]$PreviousMsi, [string]$CandidateMsi,
    [string]$PreviousManifest, [string]$CandidateManifest, [string]$ProbeExe, [string]$ObserverDll,
    [string]$ExpectedPreviousMsiSha256, [string]$ExpectedCandidateMsiSha256,
    [string]$ExpectedComputerName, [string]$ExpectedUserName,
    [ValidateRange(1,65535)][int]$ExpectedSessionId = 1,
    [ValidateSet('Fresh','Upgrade')][string]$UiMode = 'Upgrade',
    [ValidateSet('Unchecked','Checked')][string]$Choice = 'Unchecked',
    [ValidateRange(0,1)][int]$ExpectedStarts = 0,
    [ValidateRange(10,600)][int]$WatchSeconds = 300,
    [ValidateSet('Console','External')][string]$ObserverMode = 'Console'
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($ObserverMode -eq 'External' -and $Phase -ne 'WatchWorker') { throw 'External mode is restricted to the process-event observer worker.' }
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
function WriteNewJson([string]$Path,$Value) {
    $destination=Scoped $Path; $temporary=Scoped ($destination+'.'+[guid]::NewGuid().ToString('N')+'.tmp')
    [IO.File]::WriteAllText($temporary,($Value|ConvertTo-Json -Depth 24)+"`r`n",$utf8)
    [IO.File]::Move($temporary,$destination) # Refuses an existing immutable receipt.
}
function Assert([bool]$Value, [string]$Message) { if (-not $Value) { throw $Message } }
function Record([string]$Name, $Value) {
    $path = PathInRun ('receipts\' + $Name + '.json')
    Assert (-not (Test-Path -LiteralPath $path)) "Receipt already exists: $Name"
    WriteJson $path $Value
}
function NewInstaller { return New-Object -ComObject WindowsInstaller.Installer }
function ReleaseCom($Object) { if ($null -ne $Object) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($Object) } }
function Cell($Record, [int]$Column) { return $Record.GetType().InvokeMember('StringData','GetProperty',$null,$Record,@($Column)) }
function SetCell($Record, [int]$Column, $Value) {
    $property = if ($Value -is [int]) { 'IntegerData' } else { 'StringData' }
    [void]$Record.GetType().InvokeMember($property,'SetProperty',$null,$Record,@($Column,$Value))
}
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
function ExecuteSql($Database, [string]$Query, $Record) {
    $view = $Database.OpenView($Query)
    try { if ($null -eq $Record) { [void]$view.Execute() } else { [void]$view.Execute($Record) } }
    finally { try { [void]$view.Close() } finally { ReleaseCom $view } }
}
function MsiIdentity([string]$Path) {
    $installer = NewInstaller; $db = $null
    try {
        $db = $installer.OpenDatabase($Path, 0); $properties = @{}
        Rows $db 'SELECT `Property`, `Value` FROM `Property`' 2 | ForEach-Object { $properties[$_.values[0]]=$_.values[1] }
        $sequence = @(Rows $db 'SELECT `Action`, `Sequence`, `Condition` FROM `InstallExecuteSequence`' 3 | ForEach-Object {
            [pscustomobject]@{action=$_.values[0];sequence=[int]$_.values[1];condition=$_.values[2]}
        })
        $components=@(Rows $db 'SELECT `ComponentId` FROM `Component`' 1 | ForEach-Object { if($_.values[0]){([guid]$_.values[0]).ToString('B').ToUpperInvariant()} } | Sort-Object -Unique)
        $exitDialog=@(Rows $db "SELECT ``Title`` FROM ``Dialog`` WHERE ``Dialog`` = 'ExitDialog'" 1)
        Assert ($exitDialog.Count -eq 1) 'MSI must contain exactly one ExitDialog title.'
        $finishTitle=[regex]::Replace([string]$exitDialog[0].values[0],'\[([A-Za-z_][A-Za-z0-9_]*)\]',{param($match) if(-not $properties.ContainsKey($match.Groups[1].Value)){throw 'Unresolved MSI dialog title property.'};[string]$properties[$match.Groups[1].Value]})
        Assert ($finishTitle -and $finishTitle -notmatch '[\[\]]') 'MSI Finish title did not resolve completely.'
        return [pscustomobject]@{path=$Path;sha256=(Hash $Path);productCode=$properties['ProductCode'];upgradeCode=$properties['UpgradeCode'];version=$properties['ProductVersion'];name=$properties['ProductName'];sequence=$sequence;components=$components;finishTitle=$finishTitle}
    } finally { ReleaseCom $db; ReleaseCom $installer }
}
function ProductState([string]$Code) {
    $installer=NewInstaller
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
    $related=@([KaigenMsiRuntimeObserver]::EnumRelatedProducts($Identity.upgradeCode))
    Assert ($related.Count -eq 1 -and $related[0] -ieq $Identity.productCode) 'Related-product registration is missing or ambiguous.'
}
function ComponentSnapshot {
    $codes=[string[]]@(@($state.previous.components)+@($state.candidate.components)|Sort-Object -Unique)
    return [KaigenMsiRuntimeObserver]::EnumComponentClients($codes,[string]$state.guest.userSid)
}
function ComponentSignature($Snapshot) {
    $lines=@(foreach($code in @($Snapshot.Keys|Sort-Object)){
        $clients=@($Snapshot[$code]); if($clients.Count -eq 0){$code+'|EMPTY';continue}
        foreach($client in $clients){$code+'|'+([string]$client.productCode).ToUpperInvariant()+'|'+$client.userSid+'|'+$client.context}
    })
    return (@($lines|Sort-Object) -join "`n")
}
function AssertComponentOwner($Snapshot,$Identity) {
    foreach($code in @($Snapshot.Keys)){
        $clients=@($Snapshot[$code])
        $expected=if($code -in @($Identity.components)){1}else{0}
        Assert ($clients.Count -eq $expected) ('Unexpected component client count: '+$code)
        foreach($client in $clients){Assert ($client.productCode -ieq $Identity.productCode -and $client.userSid -ceq $state.guest.userSid -and $client.context -eq 2) ('Wrong component owner/context: '+$code)}
    }
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
function ObservePayload($Manifest) {
    $issues=@(); $matched=0
    foreach($entry in @($Manifest.files)) {
        $path=PayloadPath ([string]$entry.path)
        if(-not(Test-Path -LiteralPath $path -PathType Leaf)){$issues+=@([pscustomobject]@{path=$entry.path;kind='missing'});continue}
        $actual=Hash $path
        if($actual -cne ([string]$entry.sha256).ToLowerInvariant()){$issues+=@([pscustomobject]@{path=$entry.path;kind='sha256-mismatch';actual=$actual;expected=$entry.sha256})}else{$matched++}
    }
    return [pscustomobject]@{expected=@($Manifest.files).Count;matched=$matched;issues=@($issues)}
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
    Assert ((Hash $state.probe.path) -ceq $state.probe.sha256) 'Probe executable changed.'
    Assert ((Hash $state.previousManifestPath) -ceq $state.previousManifestSha256) 'Previous payload manifest changed.'
    Assert ((Hash $state.candidateManifestPath) -ceq $state.candidateManifestSha256) 'Candidate payload manifest changed.'
    Assert ((Hash $state.observerDll.path) -ceq $state.observerDll.sha256) 'Native runtime observer changed.'
}
function AssertGuestIdentity([switch]$Console) {
    Assert ([Environment]::MachineName -ieq $state.guest.computer -and [Environment]::UserName -ieq $state.guest.user) 'Runtime is not the selected disposable guest/user.'
    if($Console){
        $session=(Get-Process -Id $PID).SessionId
        Assert ($session -eq $state.guest.sessionId -and $session -gt 0) 'This phase requires the selected interactive console, not SSH/service session 0.'
        Assert (@(Get-Process -Name explorer -ErrorAction SilentlyContinue | Where-Object SessionId -eq $session).Count -gt 0) 'No Explorer in the selected interactive console.'
        $token=ObserverIdentity
        Assert ($token.integritySid -eq 'S-1-16-8192' -and -not $token.administratorEnabled) 'Console phases require the selected Medium token.'
    }
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
function AssertLateWitness($Witness,$Operation) {
    Assert ($Witness['schema'] -ceq '2' -and $Witness['phase'] -ceq 'deferred-after-removeexistingproducts') 'Witness is not the explicit post-removal probe.'
    Assert ($Witness['match'] -ceq 'true' -and $Witness['actual_sha256'] -ceq $state.candidateExeSha256.ToLowerInvariant() -and $Witness['expected_sha256'] -ceq $state.candidateExeSha256.ToLowerInvariant()) 'Failure did not witness exact candidate bytes.'
    Assert ([string]::Equals([IO.Path]::GetFullPath([string]$Witness['target']),(Join-Path $state.installRoot 'Kaigen.exe'),[StringComparison]::OrdinalIgnoreCase)) 'Witness target is outside the exact installed candidate.'
    Assert ($Witness['old_product_code'] -ieq $state.previous.productCode -and $Witness['upgrade_code'] -ieq $state.previous.upgradeCode -and $Witness['old_product_state'] -ceq '-1' -and $Witness['related_query_result'] -ceq '0' -and $Witness['removal_observed'] -ceq 'true') 'Old product removal was not witnessed before failure.'
    Assert (@(([string]$Witness['related_products']).Split(';') | Where-Object { $_ -ieq $state.previous.productCode }).Count -eq 0) 'Witness still lists the old related product.'
    $probePid=0; $milliseconds=[long]0
    Assert ([int]::TryParse([string]$Witness['pid'],[ref]$probePid) -and $probePid -gt 0 -and $probePid -ne $Operation.pid) 'Witness probe PID is invalid.'
    Assert ([long]::TryParse([string]$Witness['observed_unix_ms'],[ref]$milliseconds)) 'Witness timestamp is invalid.'
    $observed=[DateTimeOffset]::FromUnixTimeMilliseconds($milliseconds).UtcDateTime
    Assert ($observed -ge (ParseObserverUtc $Operation.startedAt).AddMilliseconds(-1) -and $observed -le (ParseObserverUtc $Operation.exitedAt)) 'Witness is outside this MSI process lifetime.'
}
function ObserverIdentity {
    $process=Get-Process -Id $PID
    $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
    try {
        $groups=@(& (Join-Path $env:SystemRoot 'System32\whoami.exe') /groups /fo csv /nh)
        Assert ($LASTEXITCODE -eq 0) 'Could not read observer token integrity identity.'
        $integrity=@($groups|ConvertFrom-Csv -Header Name,Type,Sid,Attributes|Where-Object Sid -match '^S-1-16-\d+$')
        Assert ($integrity.Count -eq 1) 'Observer token integrity SID is ambiguous.'
        return [pscustomobject]@{pid=$PID;processStartedAt=$process.StartTime.ToUniversalTime().ToString('o');sessionId=$process.SessionId;userSid=$identity.User.Value;ownerSid=$identity.Owner.Value;integritySid=$integrity[0].Sid;administratorEnabled=([Security.Principal.WindowsPrincipal]::new($identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator));authenticationType=$identity.AuthenticationType}
    } finally { $identity.Dispose() }
}
function NewWatch([string]$Mode) {
    $current=PathInRun 'watch-current.json'
    if (Test-Path -LiteralPath $current) { $prior=ReadJson $current; Assert (Test-Path -LiteralPath $prior.done) 'Existing observer has not completed.' }
    $preparedBy=ObserverIdentity
    Assert ($preparedBy.sessionId -eq $state.guest.sessionId -and $preparedBy.integritySid -eq 'S-1-16-8192' -and -not $preparedBy.administratorEnabled) 'Observer metadata must be prepared in the selected Medium console.'
    $id=[guid]::NewGuid().ToString('N')
    $watch=[ordered]@{id=$id;mode=$Mode;status=$(if($Mode -eq 'External'){'AWAITING_EXTERNAL_OBSERVER'}else{'STARTING_CONSOLE_OBSERVER'});runId=$state.runId;runnerSha256=$state.runnerSha256;stateSha256=(Hash $statePath);preparedBy=$preparedBy;observer=$null;calibration=$null;events=(PathInRun ('logs\starts-'+$id+'.jsonl'));ready=(PathInRun ('logs\watch-'+$id+'.ready'));readySha256=$null;heartbeat=(PathInRun ('logs\watch-'+$id+'.heartbeat.json'));claim=(PathInRun ('logs\watch-'+$id+'.claim'));stop=(PathInRun ('logs\watch-'+$id+'.stop'));done=(PathInRun ('logs\watch-'+$id+'.done.json'));seconds=$WatchSeconds;pid=0;processStartedAt='';startedAt=[DateTime]::UtcNow.ToString('o')}
    WriteJson $current $watch
    return $watch
}
function AssertObserverBinding($Watch,$Identity,[string]$Mode) {
    Assert ($Watch.mode -eq $Mode -and $Watch.runId -eq $state.runId -and $Watch.runnerSha256 -ceq $state.runnerSha256 -and $Watch.stateSha256 -ceq (Hash $statePath)) 'Observer metadata does not match this prepared run/mode/source.'
    Assert ($Watch.preparedBy.sessionId -eq $state.guest.sessionId -and $Watch.preparedBy.integritySid -eq 'S-1-16-8192' -and -not $Watch.preparedBy.administratorEnabled -and $Watch.preparedBy.userSid -eq $Identity.userSid) 'Observer metadata is not from the selected Medium console owner.'
    if($Mode -eq 'External'){
        Assert ($Identity.sessionId -eq 0 -and $Watch.status -eq 'AWAITING_EXTERNAL_OBSERVER') 'External observer requires session 0 and an awaiting metadata cutpoint.'
    }else{
        Assert ($Identity.sessionId -eq $state.guest.sessionId -and $Watch.status -eq 'STARTING_CONSOLE_OBSERVER') 'Console observer session/status mismatch.'
    }
    Assert (-not(Test-Path -LiteralPath $Watch.ready) -and -not(Test-Path -LiteralPath $Watch.heartbeat) -and -not(Test-Path -LiteralPath $Watch.done) -and -not(Test-Path -LiteralPath $Watch.stop)) 'Observer metadata is already used or stopped.'
    foreach($path in @($Watch.events,$Watch.ready,$Watch.heartbeat,$Watch.claim,$Watch.stop,$Watch.done)){[void](Scoped $path)}
}
function ObserverStamp($Watch) {
    return [ordered]@{id=$Watch.id;mode=$Watch.mode;runId=$Watch.runId;runnerSha256=$Watch.runnerSha256;stateSha256=$Watch.stateSha256;observer=$Watch.observer}
}
function AssertObserverStamp($Watch,$Stamp) {
    foreach($field in @('id','mode','runId','runnerSha256','stateSha256')){Assert ([string]$Stamp.$field -ceq [string]$Watch.$field) ('Observer receipt binding mismatch: '+$field)}
    foreach($field in @('pid','processStartedAt','sessionId','userSid','ownerSid','integritySid','administratorEnabled','authenticationType')){Assert ([string]$Stamp.observer.$field -ceq [string]$Watch.observer.$field) ('Observer receipt identity mismatch: '+$field)}
    Assert ($Stamp.observer.pid -eq $Watch.pid -and $Stamp.observer.processStartedAt -ceq $Watch.processStartedAt) 'Observer receipt PID/creation does not match metadata.'
}
function ParseObserverUtc([string]$Value) {
    Assert ($Value -match 'Z$') 'Observer timestamp is not UTC.'
    return [datetime]::ParseExact($Value,'o',[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
}
function PublishObserverPulse($Watch,[long]$Counter,[datetime]$PreviousUtc) {
    $pulse=ObserverStamp $Watch; $pulse.counter=$Counter; $pulse.publishedAt=[DateTime]::UtcNow.ToString('o')
    Assert ((ParseObserverUtc $pulse.publishedAt) -gt $PreviousUtc.ToUniversalTime()) 'Observer UTC clock did not strictly advance.'
    WriteJson $Watch.heartbeat $pulse
    return $pulse
}
function AssertObserverPulse($Watch,$Pulse,[datetime]$Now) {
    AssertObserverStamp $Watch $Pulse
    Assert ([string]$Pulse.counter -match '^[1-9][0-9]*$') 'Observer heartbeat counter is invalid.'
    [void][long]$Pulse.counter
    $published=ParseObserverUtc $Pulse.publishedAt
    $age=($Now-$published).TotalSeconds
    Assert ($age -ge 0 -and $age -lt 10) 'Observer heartbeat is stale or future dated.'
}
function AssertObserverPulsePair($Watch,$First,$Second,[datetime]$Now,[datetime]$RequestStartedAt) {
    AssertObserverPulse $Watch $First $Now; AssertObserverPulse $Watch $Second $Now
    Assert ([long]$Second.counter -gt [long]$First.counter -and (ParseObserverUtc $Second.publishedAt) -gt (ParseObserverUtc $First.publishedAt)) 'Observer heartbeat counter/time did not strictly advance.'
    Assert ((ParseObserverUtc $Second.publishedAt) -gt $RequestStartedAt.ToUniversalTime()) 'Observer heartbeat predates this lease request.'
}
function RequireObserverLease($Watch,$Ready) {
    $requestStartedAt=[DateTime]::UtcNow
    AssertObserverStamp $Watch $Ready
    Assert ($Ready.observer.sessionId -eq 0) 'External readiness is not from the selected session 0 observer.'
    $readySha=Hash $Watch.ready
    Assert ($readySha -ceq $Watch.readySha256) 'Immutable observer readiness SHA changed.'
    Assert (-not(Test-Path -LiteralPath $Watch.done)) 'External observer already stopped.'
    $first=ReadJson $Watch.heartbeat; AssertObserverPulse $Watch $first ([DateTime]::UtcNow)
    $deadline=[DateTime]::UtcNow.AddSeconds(3); $advanced=$false; $second=$null
    while([DateTime]::UtcNow -lt $deadline){
        Start-Sleep -Milliseconds 100
        Assert (-not(Test-Path -LiteralPath $Watch.done)) 'External observer stopped during lease verification.'
        $second=ReadJson $Watch.heartbeat; AssertObserverPulse $Watch $second ([DateTime]::UtcNow)
        if([long]$second.counter -ne [long]$first.counter -or $second.publishedAt -cne $first.publishedAt){
            AssertObserverPulsePair $Watch $first $second ([DateTime]::UtcNow) $requestStartedAt; $advanced=$true; break
        }
    }
    Assert $advanced 'External observer heartbeat did not advance before the lease deadline.'
    Assert ((Hash $Watch.ready) -ceq $readySha -and -not(Test-Path -LiteralPath $Watch.done)) 'External observer ready identity changed or observer stopped.'
    return [pscustomobject]@{readySha256=$readySha;requestStartedAt=$requestStartedAt.ToString('o');firstCounter=[long]$first.counter;firstPublishedAt=$first.publishedAt;secondCounter=[long]$second.counter;secondPublishedAt=$second.publishedAt;verifiedAt=[DateTime]::UtcNow.ToString('o')}
}
function AssertObserverCompletion($Watch,$Done) {
    Assert ($Done.status -eq 'COMPLETE') 'Observer failed; zero starts cannot be inferred.'
    AssertObserverStamp $Watch $Done
    Assert ($Done.readySha256 -ceq $Watch.readySha256 -and $Done.readySha256 -ceq (Hash $Watch.ready)) 'Completed observer does not match immutable readiness.'
    Assert ($null -ne $Done.maxHeartbeatGapSeconds -and [double]$Done.maxHeartbeatGapSeconds -ge 0 -and [double]$Done.maxHeartbeatGapSeconds -le 10) 'Observer heartbeat continuity was interrupted; observation is inconclusive.'
    $stop=ReadJson $Watch.stop; AssertObserverStamp $Watch $stop
    Assert ($null -ne $Done.stopAck -and $Done.stopAck.requestSha256 -ceq (Hash $Watch.stop) -and $Done.stopAck.requestedAt -ceq $stop.requestedAt -and (ParseObserverUtc $Done.stopAck.drainedThrough) -ge (ParseObserverUtc $stop.requestedAt) -and [double]$Done.stopAck.emptyQueueSeconds -ge 2) 'Observer did not acknowledge draining the event queue after this stop boundary.'
    if($Watch.mode -eq 'External'){Assert ([long]$Done.finalCounter -ge $Watch.observedLease.secondCounter -and (ParseObserverUtc $Done.finishedAt) -ge (ParseObserverUtc $Watch.observedLease.secondPublishedAt)) 'Observer completion predates the final verified lease.'}
}
function RequireWatch([switch]$Uncalibrated) {
    $watch=ReadJson (PathInRun 'watch-current.json')
    Assert (Test-Path -LiteralPath $watch.ready) 'Launch observer is not ready.'
    Assert (-not (Test-Path -LiteralPath $watch.done)) 'Launch observer already stopped.'
    Assert ($watch.runId -eq $state.runId -and $watch.runnerSha256 -ceq $state.runnerSha256 -and $watch.stateSha256 -ceq (Hash $statePath)) 'Ready observer does not match the current run.'
    $ready=ReadJson $watch.ready
    Assert ((Hash $watch.ready) -ceq $watch.readySha256) 'Immutable observer readiness SHA changed.'
    AssertObserverStamp $watch $ready
    if($watch.mode -eq 'External'){
        $lease=RequireObserverLease $watch $ready
        $watch|Add-Member -NotePropertyName observedLease -NotePropertyValue $lease -Force
    }else{
        Assert ($watch.mode -eq 'Console') 'Unknown observer mode.'
        $process=Get-Process -Id $watch.pid -ErrorAction Stop
        Assert ($process.StartTime.ToUniversalTime().ToString('o') -eq $watch.processStartedAt) 'Observer PID was reused.'
        Assert ($process.SessionId -eq $watch.observer.sessionId) 'Observer session changed.'
    }
    if(-not $Uncalibrated){Assert ($null -ne $watch.calibration -and $watch.calibration.sessionId -eq $state.guest.sessionId -and $watch.status -eq 'CALIBRATED') 'Observer has not passed an exact-image Medium console positive control.'}
    return $watch
}
function CalibrateObserver([switch]$Final) {
    $watch=RequireWatch -Uncalibrated
    if($Final){Assert ($null -ne $watch.calibration -and $watch.status -eq 'CALIBRATED') 'Initial calibration is missing.'}
    else{Assert ($null -eq $watch.calibration) 'Observer is already calibrated.'}
    $console=ObserverIdentity
    Assert ($console.sessionId -eq $state.guest.sessionId -and $console.integritySid -eq 'S-1-16-8192' -and -not $console.administratorEnabled) 'Positive control requires the selected Medium console.'
    $canary=Start-Process -FilePath (PathInRun 'observer-canary\Kaigen.exe') -ArgumentList '--watch-canary' -WorkingDirectory $WorkRoot -WindowStyle Hidden -PassThru
    Assert ($canary.SessionId -eq $state.guest.sessionId) 'Positive control escaped the selected console.'
    Assert ($canary.WaitForExit(10000)) 'Positive control did not finish.'
    $deadline=[DateTime]::UtcNow.AddSeconds(5); $seen=@()
    do {
        $seen=@(Get-Content -LiteralPath $watch.events | ForEach-Object { $_|ConvertFrom-Json } | Where-Object { $_.pid -eq $canary.Id -and $_.path -eq (PathInRun 'observer-canary\Kaigen.exe') })
        if($seen.Count -eq 0){Start-Sleep -Milliseconds 100}
    }while($seen.Count -eq 0 -and [DateTime]::UtcNow -lt $deadline)
    Assert ($seen.Count -eq 1 -and -not $seen[0].unresolved -and $seen[0].sha256 -ceq $state.probe.sha256 -and $seen[0].sessionId -eq $state.guest.sessionId -and $seen[0].traceCreatedAt -and $seen[0].queriedProcessCreationUtc) 'Observer failed exact-image console positive control.'
    $calibration=[pscustomobject]@{pid=$canary.Id;sessionId=$canary.SessionId;sha256=$seen[0].sha256;traceCreatedAt=$seen[0].traceCreatedAt;queriedProcessCreationUtc=$seen[0].queriedProcessCreationUtc;calibratedAt=[DateTime]::UtcNow.ToString('o');consoleIdentity=$console}
    if($Final){$watch|Add-Member -NotePropertyName finalCalibration -NotePropertyValue $calibration -Force}else{$watch.calibration=$calibration}
    $watch.status='CALIBRATED'; WriteJson (PathInRun 'watch-current.json') $watch
    return $watch
}
function UiProcess($Ui) {
    $process=Get-Process -Id $Ui.pid -ErrorAction Stop
    Assert ($process.StartTime.ToUniversalTime().ToString('o') -eq $Ui.processStartedAt) 'MSI UI PID was reused.'
    Assert ($process.SessionId -eq $state.guest.sessionId) 'MSI UI process is outside the selected console session.'
    Assert ([string]::Equals($process.Path,(Join-Path $env:SystemRoot 'System32\msiexec.exe'),[StringComparison]::OrdinalIgnoreCase)) 'MSI UI PID is not the selected Windows Installer image.'
    return $process
}
function FinishControls($Ui) {
    [void](UiProcess $Ui)
    $birth=(ParseObserverUtc $Ui.processStartedAt).ToFileTimeUtc()
    return [KaigenMsiRuntimeObserver]::InspectFinish([uint32]$Ui.pid,$birth,[uint32]$state.guest.sessionId,[string]$state.candidate.finishTitle,'Launch Kaigen','&Finish')
}
function FinishSnapshot($Ui,$Controls) {
    return [ordered]@{observedAt=[DateTime]::UtcNow.ToString('o');processStartedAt=$Ui.processStartedAt;sessionId=$state.guest.sessionId;windowName=$state.candidate.finishTitle;windowProcessId=$Ui.pid;nativeWindowHandle=$Controls.dialogHwnd;checkboxHwnd=$Controls.checkboxHwnd;finishHwnd=$Controls.finishHwnd;toggleState=[int]$Controls.checkboxState;native=$Controls}
}
function MarkFinish($Ui,$Controls,[string]$Source) {
    Assert (-not $Ui.finishCutpointAt) 'Finish choice was already marked for this UI case.'
    Assert ($null -ne $Ui.initialFinishSnapshot -and $Ui.initialFinishSnapshot.toggleState -eq 0) 'Initial unchecked Finish snapshot is missing.'
    $selected=FinishSnapshot $Ui $Controls
    Assert ($selected.nativeWindowHandle -eq $Ui.initialFinishSnapshot.nativeWindowHandle -and $selected.checkboxHwnd -eq $Ui.initialFinishSnapshot.checkboxHwnd -and $selected.finishHwnd -eq $Ui.initialFinishSnapshot.finishHwnd) 'Finish controls changed after initial inspection.'
    Assert ($selected.toggleState -eq $(if($Choice -eq 'Checked'){1}else{0})) 'Actual checkbox selection does not match requested case.'
    $Ui.choice=$Choice; $Ui.selectedFinishSnapshot=$selected; $Ui.finishSource=$Source
    $Ui.finishCutpointAt=[DateTime]::UtcNow.ToString('o')
    WriteJson (PathInRun 'ui-current.json') $Ui
    return $selected
}
function VerifyUiExit($Ui,$Receipt) {
    Assert ($Ui.finishCutpointAt -and $null -ne $Ui.selectedFinishSnapshot) 'No verified Finish choice/cutpoint.'
    $deadline=[DateTime]::UtcNow.AddSeconds(60)
    while (-not(Test-Path -LiteralPath $Ui.exitReceipt) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 100 }
    Assert (Test-Path -LiteralPath $Ui.exitReceipt) 'MSI UI exit has not been observed after Finish.'
    $observed=ReadJson $Ui.exitReceipt
    Assert ($observed.status -eq 'COMPLETE' -and $observed.pid -eq $Ui.pid -and $observed.processStartedAt -eq $Ui.processStartedAt) 'Exact MSI UI process observer failed.'
    Assert ([datetime]$observed.exitedAt -ge [datetime]$Ui.finishCutpointAt) 'MSI UI exited before the marked Finish cutpoint.'
    $Receipt.exit=$observed; Assert ($observed.exitCode -in @(0,3010)) 'MSI UI returned failure.'
    AssertRegistered $state.candidate; $Receipt.payloadFiles=CheckPayload $candidatePayload
    Assert ((ProductState $state.previous.productCode) -eq -1) 'Old ProductCode remains after UI install/upgrade.'
    $Receipt.components=ComponentSnapshot; AssertComponentOwner $Receipt.components $state.candidate
    $Receipt.canaries=CheckCanaries
    $Receipt.logSha256=Hash $Ui.log
}
function PrepareTransform {
    $authoring=PathInRun 'fault-authoring.msi'; $transform=PathInRun 'fail-after-removal.mst'
    Assert (-not (Test-Path -LiteralPath $authoring) -and -not (Test-Path -LiteralPath $transform)) 'Fault authoring outputs already exist.'
    Copy-Item -LiteralPath $state.candidate.path -Destination $authoring
    $installer=NewInstaller; $db=$null; $reference=$null
    try {
        $db=$installer.OpenDatabase($authoring,1); $reference=$installer.OpenDatabase($state.candidate.path,0)
        $record=$installer.CreateRecord(2); SetCell $record 1 'KaigenRegressionRollbackProbe'
        [void]$record.GetType().InvokeMember('SetStream','InvokeMethod',$null,$record,@(2,$state.probe.path))
        ExecuteSql $db 'INSERT INTO `Binary` (`Name`,`Data`) VALUES (?,?)' $record
        $record=$installer.CreateRecord(4); SetCell $record 1 'KaigenRegressionFailAfterRemoval'
        # MSI type 2 (embedded EXE) + 1024 (deferred). Checked return, impersonated.
        SetCell $record 2 ([int]1026); SetCell $record 3 'KaigenRegressionRollbackProbe'
        SetCell $record 4 ('--post-removal "[INSTALLFOLDER]Kaigen.exe" '+(Quote $state.candidateExeSha256)+' '+(Quote (PathInRun 'fault-witness.txt'))+' '+(Quote $state.previous.productCode)+' '+(Quote $state.previous.upgradeCode))
        ExecuteSql $db 'INSERT INTO `CustomAction` (`Action`,`Type`,`Source`,`Target`) VALUES (?,?,?,?)' $record
        $installFiles=@($state.candidate.sequence | Where-Object action -eq 'InstallFiles')[0].sequence
        $finalize=@($state.candidate.sequence | Where-Object action -eq 'InstallFinalize')[0].sequence
        $execute=@($state.candidate.sequence | Where-Object action -eq 'InstallExecute')
        $remove=@($state.candidate.sequence | Where-Object action -eq 'RemoveExistingProducts')
        Assert ($execute.Count -eq 1 -and $remove.Count -eq 1 -and $remove[0].sequence -gt $execute[0].sequence -and $execute[0].sequence -gt $installFiles) 'Late rollback requires InstallExecute then RemoveExistingProducts before Finalize.'
        $sequence=$remove[0].sequence+1
        while (@($state.candidate.sequence | Where-Object sequence -eq $sequence).Count -gt 0) { $sequence++ }
        Assert ($sequence -lt $finalize) 'No post-removal/pre-finalize sequence slot for probe.'
        $record=$installer.CreateRecord(3); SetCell $record 1 'KaigenRegressionFailAfterRemoval'; SetCell $record 2 '1'; SetCell $record 3 ([int]$sequence)
        ExecuteSql $db 'INSERT INTO `InstallExecuteSequence` (`Action`,`Condition`,`Sequence`) VALUES (?,?,?)' $record
        [void]$db.Commit()
        [void]$db.GenerateTransform($reference,$transform)
        Assert ((Test-Path -LiteralPath $transform -PathType Leaf) -and (Get-Item -LiteralPath $transform).Length -gt 0) 'MSI transform generation produced no artifact.'
        [void]$db.CreateTransformSummaryInfo($reference,$transform,0,0)
    } finally { ReleaseCom $db; ReleaseCom $reference; ReleaseCom $installer }
    # The writable MSI database owns an exclusive file handle until COM release.
    return [pscustomobject]@{path=$transform;sha256=(Hash $transform);authoringSha256=(Hash $authoring);action='KaigenRegressionFailAfterRemoval';type=1026;sequence=$sequence;removeSequence=$remove[0].sequence;candidateSha256=$state.candidate.sha256}
}

$statePath=PathInRun 'state.json'
if ($Phase -eq 'Prepare') {
    Assert (-not (Test-Path -LiteralPath $statePath)) 'This disposable run is already prepared.'
    [IO.Directory]::CreateDirectory($WorkRoot) | Out-Null
    foreach($dir in @('receipts','logs','observer-canary')) { [IO.Directory]::CreateDirectory((PathInRun $dir)) | Out-Null }
    foreach($value in @($PreviousMsi,$CandidateMsi,$PreviousManifest,$CandidateManifest,$ProbeExe,$ObserverDll)) { Assert (-not [string]::IsNullOrWhiteSpace($value)) 'Prepare requires both MSIs, both manifests, prebuilt ProbeExe and ObserverDll.'; [void](Scoped $value) }
    foreach($value in @($ExpectedPreviousMsiSha256,$ExpectedCandidateMsiSha256)) { Assert ($value -match '^[A-Fa-f0-9]{64}$') 'Both expected MSI SHA256 values are required.' }
    Assert ($ExpectedComputerName -and $ExpectedUserName) 'Prepare requires explicit ExpectedComputerName and ExpectedUserName.'
    Assert ([Environment]::MachineName -ieq $ExpectedComputerName -and [Environment]::UserName -ieq $ExpectedUserName) 'Prepare is not running on the selected disposable guest/user.'
    Assert ((Hash $PreviousMsi) -ceq $ExpectedPreviousMsiSha256.ToLowerInvariant()) 'Previous MSI does not match requested artifact.'
    Assert ((Hash $CandidateMsi) -ceq $ExpectedCandidateMsiSha256.ToLowerInvariant()) 'Candidate MSI does not match requested artifact.'
    $previous=MsiIdentity (Scoped $PreviousMsi); $candidate=MsiIdentity (Scoped $CandidateMsi)
    Assert ($previous.productCode -ne $candidate.productCode -and $previous.upgradeCode -eq $candidate.upgradeCode) 'Require different ProductCodes and the same UpgradeCode.'
    $a=@($previous.version.Split('.') | Select-Object -First 3); $b=@($candidate.version.Split('.') | Select-Object -First 3)
    Assert ($a.Count -eq 3 -and $b.Count -eq 3 -and [version]($b -join '.') -gt [version]($a -join '.')) 'Candidate must increase the first three MSI version fields.'
    Assert ((ProductState $previous.productCode) -eq -1 -and (ProductState $candidate.productCode) -eq -1 -and -not (InstallFolderRegistry)) 'Prepare requires a disposable user with neither selected product installed/advertised and no Kaigen installer registry.'
    $oldManifest=ReadJson (Scoped $PreviousManifest); $newManifest=ReadJson (Scoped $CandidateManifest)
    Assert ($oldManifest.productCode -eq $previous.productCode.Trim('{}') -or $oldManifest.productCode -eq $previous.productCode) 'Previous manifest ProductCode mismatch.'
    Assert ($newManifest.productCode -eq $candidate.productCode.Trim('{}') -or $newManifest.productCode -eq $candidate.productCode) 'Candidate manifest ProductCode mismatch.'
    $oldExe=@($oldManifest.files | Where-Object path -ceq 'Kaigen.exe'); $newExe=@($newManifest.files | Where-Object path -ceq 'Kaigen.exe')
    Assert ($oldExe.Count -eq 1 -and $newExe.Count -eq 1 -and $oldExe[0].sha256 -ne $newExe[0].sha256) 'Probe requires different exact previous/candidate Kaigen.exe bytes.'
    $state=[pscustomobject][ordered]@{schema=1;runId=([guid]::NewGuid().ToString());preparedAt=[DateTime]::UtcNow.ToString('o');workRoot=$WorkRoot;installRoot=(PathInRun 'installed');runnerSha256=(Hash $PSCommandPath);guest=@{computer=$ExpectedComputerName;user=$ExpectedUserName;sessionId=$ExpectedSessionId};previous=$previous;candidate=$candidate;previousManifestPath=(Scoped $PreviousManifest);candidateManifestPath=(Scoped $CandidateManifest);previousManifestSha256=(Hash $PreviousManifest);candidateManifestSha256=(Hash $CandidateManifest);previousExeSha256=$oldExe[0].sha256;candidateExeSha256=$newExe[0].sha256;probe=@{path=(Scoped $ProbeExe);sha256=(Hash $ProbeExe)}}
    $state.guest.userSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $state|Add-Member -NotePropertyName observerDll -NotePropertyValue @{path=(Scoped $ObserverDll);sha256=(Hash $ObserverDll)}
    [void][Reflection.Assembly]::LoadFrom($state.observerDll.path)
    Assert (@([KaigenMsiRuntimeObserver]::EnumRelatedProducts($previous.upgradeCode)).Count -eq 0) 'Prepare found related product registration.'
    $initialComponents=ComponentSnapshot
    foreach($code in $initialComponents.Keys){Assert (@($initialComponents[$code]).Count -eq 0) ('Prepare found existing component clients: '+$code)}
    Assert (-not (Test-Path -LiteralPath $state.installRoot)) 'Install target already exists.'
    foreach($entry in @($oldManifest.files)+@($newManifest.files)) { [void](PayloadPath ([string]$entry.path)) }
    WriteJson $statePath $state
    $fault=PrepareTransform; WriteJson (PathInRun 'fault-transform.json') $fault
    Copy-Item -LiteralPath $state.probe.path -Destination (PathInRun 'observer-canary\Kaigen.exe')
    Record 'prepare' ([ordered]@{status='PREPARED_NOT_INSTALLED';state=$state;fault=$fault;guestUser=[Environment]::UserName;sessionId=(Get-Process -Id $PID).SessionId})
    Write-Output 'PREPARED_NOT_INSTALLED'; return
}
$state=ReadJson $statePath
Assert ($state.workRoot -ceq $WorkRoot) 'State belongs to a different run.'
Assert ((Hash $PSCommandPath) -ceq $state.runnerSha256) 'Runner changed since Prepare; create a fresh evidence run.'
AssertInputs
[void][Reflection.Assembly]::LoadFrom($state.observerDll.path)
AssertGuestIdentity -Console:($Phase -ne 'Status' -and -not ($Phase -eq 'WatchWorker' -and $ObserverMode -eq 'External'))
$previousPayload=ReadJson $state.previousManifestPath; $candidatePayload=ReadJson $state.candidateManifestPath
$receipt=[ordered]@{phase=$Phase;startedAt=[DateTime]::UtcNow.ToString('o');status='RUNNING'}
try {
    switch ($Phase) {
        'Status' { $state | ConvertTo-Json -Depth 12; return }
        'InstallPrevious' {
            [void](RequireWatch)
            Assert ((ProductState $state.previous.productCode) -eq -1 -and (ProductState $state.candidate.productCode) -eq -1 -and -not(InstallFolderRegistry) -and @([KaigenMsiRuntimeObserver]::EnumRelatedProducts($state.previous.upgradeCode)).Count -eq 0) 'Previous install requires a clean selected-product state.'
            $initialComponents=ComponentSnapshot
            foreach($code in $initialComponents.Keys){Assert (@($initialComponents[$code]).Count -eq 0) ('Previous install found existing component clients: '+$code)}
            $receipt.msi=RunMsi ('/i '+(Quote $state.previous.path)+' /qn INSTALLFOLDER='+(Quote $state.installRoot)) 'previous-install'
            Assert ($receipt.msi.exitCode -in @(0,3010)) 'Previous install failed.'
            AssertRegistered $state.previous; $receipt.payloadFiles=CheckPayload $previousPayload
            SeedCanaries; $receipt.canaries=CheckCanaries
            $receipt.components=ComponentSnapshot; AssertComponentOwner $receipt.components $state.previous
        }
        'ProbeRelocation' {
            [void](RequireWatch); AssertRegistered $state.previous; [void](CheckPayload $previousPayload); [void](CheckCanaries)
            $receipt.componentsBefore=ComponentSnapshot; AssertComponentOwner $receipt.componentsBefore $state.previous
            $otherRoot=PathInRun 'forbidden-relocation'; Assert (-not(Test-Path -LiteralPath $otherRoot)) 'Relocation negative-control destination already exists.'
            $receipt.msi=RunMsi ('/i '+(Quote $state.candidate.path)+' /qn INSTALLFOLDER='+(Quote $otherRoot)) 'candidate-relocation-refused'
            Assert ($receipt.msi.exitCode -eq 1603) 'Conflicting upgrade target was not rejected.'
            $log=[IO.File]::ReadAllText($receipt.msi.log)
            Assert ($log -match 'RejectKaigenUpgradeRelocation' -and $log -match 'Kaigen must upgrade one installed copy in its existing folder\.') 'Relocation failed without witnessing the intended producer guard.'
            AssertRegistered $state.previous; Assert ((ProductState $state.candidate.productCode) -eq -1) 'Rejected relocation registered candidate.'
            $receipt.componentsAfter=ComponentSnapshot
            Assert ((ComponentSignature $receipt.componentsBefore) -ceq (ComponentSignature $receipt.componentsAfter)) 'Rejected relocation changed component clients.'
            $receipt.payloadFiles=CheckPayload $previousPayload; $receipt.canaries=CheckCanaries
            Assert (-not(Test-Path -LiteralPath $otherRoot)) 'Rejected relocation created its alternate target.'
        }
        'ProbeRollback' {
            [void](RequireWatch); AssertRegistered $state.previous; [void](CheckPayload $previousPayload); [void](CheckCanaries)
            $receipt.componentsBefore=ComponentSnapshot; AssertComponentOwner $receipt.componentsBefore $state.previous
            $fault=ReadJson (PathInRun 'fault-transform.json'); Assert ((Hash $fault.path) -ceq $fault.sha256) 'Fault transform changed.'
            Assert (-not (Test-Path -LiteralPath (PathInRun 'fault-witness.txt'))) 'Fault witness already exists.'
            $receipt.msi=RunMsi ('/i '+(Quote $state.candidate.path)+' /qn INSTALLFOLDER='+(Quote $state.installRoot)+' TRANSFORMS='+(Quote $fault.path)) 'candidate-fault'
            $witnessPath=PathInRun 'fault-witness.txt'; Assert (Test-Path -LiteralPath $witnessPath) 'No deferred post-removal witness: late rollback remains untested.'
            $witness=@{}; [IO.File]::ReadAllLines($witnessPath) | ForEach-Object { $pair=$_.Split('=',2); Assert ($pair.Length -eq 2 -and -not $witness.ContainsKey($pair[0])) 'Malformed or duplicate witness field.'; $witness[$pair[0]]=$pair[1] }
            $receipt.witness=$witness; $receipt.witnessSha256=Hash $witnessPath
            AssertLateWitness $witness $receipt.msi
            Assert ($receipt.msi.exitCode -eq 1603) 'Injected failure did not return MSI error 1603.'
            $rawLog=[IO.File]::ReadAllText($receipt.msi.log)
            $removeEnd=[regex]::Match($rawLog,'(?m)^Action ended [^\r\n]*RemoveExistingProducts\. Return value 1\.')
            $probeExec=[regex]::Match($rawLog,'(?m)^[^\r\n]*Executing op: CustomActionSchedule\(Action=KaigenRegressionFailAfterRemoval,')
            Assert ($removeEnd.Success -and $probeExec.Success -and $probeExec.Index -gt $removeEnd.Index) 'Raw MSI log does not show completed removal before actual deferred probe execution.'
            $receipt.removalOrder=@{removeEndIndex=$removeEnd.Index;probeExecutionIndex=$probeExec.Index;logSha256=$receipt.msi.logSha256}
            $oldPaths=@($previousPayload.files | ForEach-Object path)
            $candidateOnly=@($candidatePayload.files | Where-Object { $_.path -cnotin $oldPaths -and (Test-Path -LiteralPath (PayloadPath $_.path)) } | ForEach-Object path)
            $canaryResult=[ordered]@{ok=$true;count=0;error=$null}
            try{$canaryResult.count=CheckCanaries}catch{$canaryResult.ok=$false;$canaryResult.error=$_.Exception.Message}
            $receipt.rollback=[ordered]@{previousProductState=(ProductState $state.previous.productCode);candidateProductState=(ProductState $state.candidate.productCode);previousPayload=(ObservePayload $previousPayload);candidateOnlyPresent=$candidateOnly;canaries=$canaryResult;related=@([KaigenMsiRuntimeObserver]::EnumRelatedProducts($state.previous.upgradeCode));components=(ComponentSnapshot)}
            AssertRegistered $state.previous
            Assert ($receipt.rollback.candidateProductState -eq -1) 'Candidate remains registered or advertised after rollback.'
            Assert ((ComponentSignature $receipt.componentsBefore) -ceq (ComponentSignature $receipt.rollback.components)) 'Rollback did not restore exact component client registrations.'
            Assert ($receipt.rollback.previousPayload.issues.Count -eq 0) 'Previous packaged payload was not restored by rollback.'
            Assert ($candidateOnly.Count -eq 0) 'Candidate-only payload survived rollback.'
            Assert ($canaryResult.ok) 'Rollback changed synthetic user canaries.'
        }
        'Upgrade' {
            [void](RequireWatch); AssertRegistered $state.previous; [void](CheckCanaries)
            $receipt.msi=RunMsi ('/i '+(Quote $state.candidate.path)+' /qn INSTALLFOLDER='+(Quote $state.installRoot)) 'candidate-upgrade'
            Assert ($receipt.msi.exitCode -in @(0,3010)) 'Candidate upgrade failed.'
            AssertRegistered $state.candidate; Assert ((ProductState $state.previous.productCode) -eq -1) 'Previous ProductCode survived the major upgrade.'
            $receipt.payloadFiles=CheckPayload $candidatePayload; $receipt.canaries=CheckCanaries
            $receipt.components=ComponentSnapshot; AssertComponentOwner $receipt.components $state.candidate
        }
        'BeginWatch' {
            $watch=NewWatch 'Console'
            $shell=(Get-Process -Id $PID).Path
            $arguments='-NoProfile -ExecutionPolicy Bypass -File '+(Quote $PSCommandPath)+' -Phase WatchWorker -WorkRoot '+(Quote $WorkRoot)
            $worker=Start-Process -FilePath $shell -ArgumentList $arguments -WorkingDirectory $WorkRoot -WindowStyle Hidden -PassThru
            $deadline=[DateTime]::UtcNow.AddSeconds(15)
            while (-not (Test-Path -LiteralPath $watch.ready) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 100; $worker.Refresh(); Assert (-not $worker.HasExited) 'Observer worker exited before ready.' }
            Assert (Test-Path -LiteralPath $watch.ready) 'Observer did not become ready.'
            $receipt.watch=CalibrateObserver; $receipt.positiveControlPid=$receipt.watch.calibration.pid
        }
        'PrepareWatch' {
            $receipt.watch=NewWatch 'External'
            $receipt.status='AWAITING_EXTERNAL_OBSERVER'
        }
        'CalibrateWatch' {
            $watch=ReadJson (PathInRun 'watch-current.json'); Assert ($watch.mode -eq 'External') 'CalibrateWatch requires prepared external-observer metadata.'
            $receipt.watch=CalibrateObserver; $receipt.positiveControlPid=$receipt.watch.calibration.pid
        }
        'WatchWorker' {
            $watch=ReadJson (PathInRun 'watch-current.json'); $identifier='KaigenMsiStarts-'+$watch.id
            $result=[ordered]@{status='RUNNING';startedAt=[DateTime]::UtcNow.ToString('o');events=0;readySha256=$null;finalCounter=0;maxHeartbeatGapSeconds=0;stopAck=$null}; $counter=[long]0
            $heartbeatTimer=[Diagnostics.Stopwatch]::StartNew(); $lastPulseElapsed=[double]0
            $lastPulseUtc=[datetime]::MinValue; $stopObservedElapsed=$null; $emptySinceElapsed=$null; $stopRequest=$null; $stopSha=$null
            try {
                $identity=ObserverIdentity
                AssertObserverBinding $watch $identity $ObserverMode
                $claim=[IO.File]::Open($watch.claim,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
                try { $bytes=$utf8.GetBytes([string]$PID); $claim.Write($bytes,0,$bytes.Length); $claim.Flush() } finally { $claim.Dispose() }
                Register-CimIndicationEvent -Namespace root/cimv2 -Query "SELECT * FROM Win32_ProcessStartTrace WHERE ProcessName = 'Kaigen.exe'" -SourceIdentifier $identifier | Out-Null
                $watch.pid=$identity.pid; $watch.processStartedAt=$identity.processStartedAt; $watch.observer=$identity; $watch.status='OBSERVING'
                foreach($entry in (ObserverStamp $watch).GetEnumerator()){$result[$entry.Key]=$entry.Value}
                [IO.File]::WriteAllText($watch.events,'',$utf8)
                $ready=ObserverStamp $watch; $ready.readyAt=[DateTime]::UtcNow.ToString('o'); $staging=Scoped ($watch.ready+'.pending'); WriteNewJson $staging $ready
                $result.readySha256=Hash $staging; $watch.readySha256=$result.readySha256
                WriteJson (PathInRun 'watch-current.json') $watch
                $deadline=[DateTime]::UtcNow.AddSeconds([int]$watch.seconds)
                while ([DateTime]::UtcNow -lt $deadline) {
                    Assert (@(Get-EventSubscriber -SourceIdentifier $identifier -ErrorAction Stop).Count -eq 1) 'Observer subscription is no longer registered.'
                    if($null -ne $stopObservedElapsed){Assert (($heartbeatTimer.Elapsed.TotalSeconds-$stopObservedElapsed) -lt 5) 'Observer stop drain did not complete within five seconds.'}
                    $event=Get-Event -SourceIdentifier $identifier -ErrorAction SilentlyContinue|Select-Object -First 1
                    if ($null -eq $event) {
                        # Pulses come only from the subscribed event-drain loop after its queue is empty.
                        $gap=$heartbeatTimer.Elapsed.TotalSeconds-$lastPulseElapsed
                        if($counter -eq 0 -or $gap -ge 0.5){
                            if($counter -gt 0){$result.maxHeartbeatGapSeconds=[Math]::Max($result.maxHeartbeatGapSeconds,$gap);Assert ($gap -le 10) 'Observer event-drain heartbeat was interrupted for more than ten seconds.'}
                            $counter++;$lastPulseElapsed=$heartbeatTimer.Elapsed.TotalSeconds;$pulse=PublishObserverPulse $watch $counter $lastPulseUtc;$lastPulseUtc=ParseObserverUtc $pulse.publishedAt
                            if($counter -eq 1){[IO.File]::Move($staging,$watch.ready)}
                        }
                        if(Test-Path -LiteralPath $watch.stop){
                            if($null -eq $stopObservedElapsed){
                                $stopRequest=ReadJson $watch.stop; AssertObserverStamp $watch $stopRequest
                                $requested=ParseObserverUtc $stopRequest.requestedAt
                                Assert ($requested -ge (ParseObserverUtc $ready.readyAt) -and $requested -le [DateTime]::UtcNow) 'Observer stop boundary is stale or future dated.'
                                $stopSha=Hash $watch.stop;$stopObservedElapsed=$heartbeatTimer.Elapsed.TotalSeconds;$emptySinceElapsed=$stopObservedElapsed
                            }
                            if($null -eq $emptySinceElapsed){$emptySinceElapsed=$heartbeatTimer.Elapsed.TotalSeconds}
                            $emptySeconds=$heartbeatTimer.Elapsed.TotalSeconds-$emptySinceElapsed
                            if($emptySeconds -ge 2){
                                Assert ((Hash $watch.stop) -ceq $stopSha) 'Observer stop boundary changed during drain.'
                                $result.stopAck=[ordered]@{requestSha256=$stopSha;requestedAt=$stopRequest.requestedAt;drainedThrough=[DateTime]::UtcNow.ToString('o');emptyQueueSeconds=$emptySeconds};break
                            }
                        }
                        Start-Sleep -Milliseconds 100; continue
                    }
                    $emptySinceElapsed=$null
                    $trace=$event.SourceEventArgs.NewEvent; $image=$null; $digest=$null; $reason=$null; $traceTime=$null; $creationTime=$null
                    try {
                        $traceTime=[DateTime]::FromFileTimeUtc([long]$trace.TIME_CREATED)
                        $process=Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId='+[int]$trace.ProcessID)
                        if ($process) { $creationTime=$process.CreationDate.ToUniversalTime() }
                        if ($process -and $process.ExecutablePath -and $process.Name -eq 'Kaigen.exe' -and [Math]::Abs(($creationTime-$traceTime).TotalSeconds) -lt 3) { $image=[IO.Path]::GetFullPath([string]$process.ExecutablePath); $digest=Hash $image }
                        else { $reason='Process exited or exact image could not be queried.' }
                    } catch { $reason=$_.Exception.Message }
                    $entry=[ordered]@{observedAt=[DateTime]::UtcNow.ToString('o');traceCreatedAt=$(if($null -ne $traceTime){$traceTime.ToString('o')}else{$null});queriedProcessCreationUtc=$(if($null -ne $creationTime){$creationTime.ToString('o')}else{$null});pid=[int]$trace.ProcessID;parentPid=[int]$trace.ParentProcessID;sessionId=[int]$trace.SessionID;path=$image;sha256=$digest;unresolved=$reason}
                    [IO.File]::AppendAllText($watch.events,($entry|ConvertTo-Json -Compress)+"`r`n",$utf8)
                    $result.events++; Remove-Event -EventIdentifier $event.EventIdentifier
                    Assert ([string]::IsNullOrEmpty($reason)) 'Observer could not resolve an exact Kaigen image start; observation is inconclusive.'
                }
                Assert ($null -ne $result.stopAck) 'Observer expired without acknowledging an explicit EndWatch drain.'
                $result.status='COMPLETE'
            } catch { $result.status='FAIL'; $result.error=$_.Exception.Message }
            finally { Unregister-Event -SourceIdentifier $identifier -ErrorAction SilentlyContinue; Get-Event -SourceIdentifier $identifier -ErrorAction SilentlyContinue | Remove-Event; $result.maxHeartbeatGapSeconds=[Math]::Max($result.maxHeartbeatGapSeconds,($heartbeatTimer.Elapsed.TotalSeconds-$lastPulseElapsed));$heartbeatTimer.Stop(); $result.finalCounter=$counter; $result.finishedAt=[DateTime]::UtcNow.ToString('o'); WriteNewJson $watch.done $result }
            return
        }
        'EndWatch' {
            $watch=RequireWatch
            # Includes a post-Finish/post-msiexec observation interval.
            Start-Sleep -Seconds 10
            $watch=CalibrateObserver -Final; $receipt.finalPositiveControl=$watch.finalCalibration
            if($watch.mode -eq 'External'){$watch=RequireWatch}
            $stop=ObserverStamp $watch;$stop.requestedAt=[DateTime]::UtcNow.ToString('o');WriteNewJson $watch.stop $stop
            $deadline=[DateTime]::UtcNow.AddSeconds(10)
            while (-not (Test-Path -LiteralPath $watch.done) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 100 }
            Assert (Test-Path -LiteralPath $watch.done) 'Observer did not finish.'
            $done=ReadJson $watch.done; AssertObserverCompletion $watch $done
            $events=@(Get-Content -LiteralPath $watch.events | ForEach-Object { $_|ConvertFrom-Json })
            Assert (@($events|Where-Object { $_.unresolved -or -not $_.path -or -not $_.traceCreatedAt -or -not $_.queriedProcessCreationUtc }).Count -eq 0) 'Unresolved Kaigen process start: launch result is inconclusive.'
            $target=Join-Path $state.installRoot 'Kaigen.exe'; $starts=@($events|Where-Object { [string]::Equals($_.path,$target,[StringComparison]::OrdinalIgnoreCase) })
            $receipt.starts=$starts; $receipt.eventsSha256=Hash $watch.events; $receipt.expectedStarts=$ExpectedStarts
            Assert ($starts.Count -eq $ExpectedStarts) ('Unexpected exact-image launch count: '+$starts.Count)
            if ($ExpectedStarts -eq 1) {
                Assert ($starts[0].sha256 -ceq $state.candidateExeSha256.ToLowerInvariant()) 'Started image was not exact candidate bytes.'
                $ui=ReadJson (PathInRun 'ui-current.json')
                Assert ($ui.choice -eq 'Checked' -and $ui.finishCutpointAt -and [datetime]$starts[0].traceCreatedAt -ge [datetime]$ui.finishCutpointAt -and [datetime]$starts[0].queriedProcessCreationUtc -ge [datetime]$ui.finishCutpointAt) 'Actual process start preceded the verified checked Finish cutpoint.'
                Assert ($starts[0].sessionId -eq $state.guest.sessionId) 'Checked Finish launch was outside the selected console.'
                $process=Get-Process -Id $starts[0].pid -ErrorAction Stop; $deadline=[DateTime]::UtcNow.AddSeconds(35)
                Assert ([Math]::Abs(($process.StartTime.ToUniversalTime()-(ParseObserverUtc $starts[0].queriedProcessCreationUtc)).TotalMilliseconds) -lt 1) 'Launched application PID was reused.'
                while (-not $process.HasExited -and $process.MainWindowHandle -eq 0 -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 200; $process.Refresh() }
                Assert (-not $process.HasExited -and $process.MainWindowHandle -ne 0) 'Checked Finish did not produce a real candidate window.'
                $receipt.windowHandle=$process.MainWindowHandle.ToInt64()
            }
            $receipt.observer=$done
        }
        'StartUi' {
            [void](RequireWatch)
            if ($UiMode -eq 'Upgrade') { AssertRegistered $state.previous; [void](CheckCanaries) }
            else { Assert ((ProductState $state.previous.productCode) -eq -1 -and (ProductState $state.candidate.productCode) -eq -1) 'Fresh UI install requires neither selected product installed or advertised.'; SeedCanaries; $receipt.canaries=CheckCanaries }
            $uiId=[guid]::NewGuid().ToString('N')
            $ui=[ordered]@{mode=$UiMode;startedAt=[DateTime]::UtcNow.ToString('o');pid=0;processStartedAt='';log=(PathInRun ('logs\ui-'+$UiMode+'.log'));choice=$null;finishCutpointAt=$null;finishSource=$null;finishInvokedAt=$null;initialFinishSnapshot=$null;selectedFinishSnapshot=$null;exitReady=(PathInRun ('logs\ui-exit-'+$uiId+'.ready'));exitReceipt=(PathInRun ('logs\ui-exit-'+$uiId+'.json'));exitWorkerPid=0}
            Assert (-not (Test-Path -LiteralPath $ui.log)) 'UI case log already exists; use a fresh disposable run.'
            $arguments='/i '+(Quote $state.candidate.path)+' /norestart INSTALLFOLDER='+(Quote $state.installRoot)+' /l*v '+(Quote $ui.log)
            # Visible only in the selected guest console: this phase explicitly tests MSI UI.
            $process=Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\msiexec.exe') -ArgumentList $arguments -WorkingDirectory $WorkRoot -WindowStyle Normal -PassThru
            $ui.pid=$process.Id; $ui.processStartedAt=$process.StartTime.ToUniversalTime().ToString('o'); WriteJson (PathInRun 'ui-current.json') $ui
            [void](UiProcess $ui)
            $worker=Start-Process -FilePath (Get-Process -Id $PID).Path -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -File '+(Quote $PSCommandPath)+' -Phase UiWaitWorker -WorkRoot '+(Quote $WorkRoot)) -WorkingDirectory $WorkRoot -WindowStyle Hidden -PassThru
            $ui.exitWorkerPid=$worker.Id; WriteJson (PathInRun 'ui-current.json') $ui
            $deadline=[DateTime]::UtcNow.AddSeconds(15)
            while (-not(Test-Path -LiteralPath $ui.exitReady) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 100; $worker.Refresh(); Assert (-not $worker.HasExited) 'UI exit observer stopped before ready.' }
            Assert (Test-Path -LiteralPath $ui.exitReady) 'UI exit observer did not become ready.'
            $receipt.ui=$ui; $receipt.cutpoint='Navigate actual MSI to Finish, InspectFinishUi before toggling, MarkFinishUi after VNC choice, then click Finish through VNC and VerifyFinishUi.'
        }
        'UiWaitWorker' {
            $ui=ReadJson (PathInRun 'ui-current.json'); $observed=[ordered]@{status='RUNNING';pid=$ui.pid;processStartedAt=$ui.processStartedAt;sessionId=$state.guest.sessionId;exitCode=$null;exitedAt=$null}
            try {
                $process=UiProcess $ui
                [void]$process.Handle # Retain a real process handle even if Finish closes before verification.
                [IO.File]::WriteAllText($ui.exitReady,[DateTime]::UtcNow.ToString('o'),$utf8)
                Assert ($process.WaitForExit(600000)) 'UI exit observer timed out; no process termination attempted.'
                $observed.exitCode=$process.ExitCode; $observed.exitedAt=$process.ExitTime.ToUniversalTime().ToString('o'); $observed.status='COMPLETE'
            } catch { $observed.status='FAIL'; $observed.error=$_.Exception.Message }
            WriteJson $ui.exitReceipt $observed
            return
        }
        'InspectFinishUi' {
            [void](RequireWatch); $ui=ReadJson (PathInRun 'ui-current.json')
            Assert (-not $ui.finishCutpointAt -and $null -eq $ui.initialFinishSnapshot) 'Initial Finish inspection already recorded or choice marked.'
            $controls=FinishControls $ui; $snapshot=FinishSnapshot $ui $controls
            $receipt.snapshot=$snapshot; Assert ($snapshot.toggleState -eq 0) 'Launch checkbox is not initially unchecked in actual MSI UI.'
            $ui.initialFinishSnapshot=$snapshot; WriteJson (PathInRun 'ui-current.json') $ui
            $receipt.readOnlyUi=$true
        }
        'MarkFinishUi' {
            [void](RequireWatch); $ui=ReadJson (PathInRun 'ui-current.json'); $controls=FinishControls $ui
            $receipt.snapshot=MarkFinish $ui $controls 'external-vnc-before-click'
            $receipt.cutpointAt=$ui.finishCutpointAt; $receipt.readOnlyUi=$true
        }
        'VerifyFinishUi' {
            [void](RequireWatch); $ui=ReadJson (PathInRun 'ui-current.json'); VerifyUiExit $ui $receipt
        }
        'FinishUi' {
            [void](RequireWatch); $ui=ReadJson (PathInRun 'ui-current.json'); $controls=FinishControls $ui
            Assert (-not $ui.finishCutpointAt -and $null -eq $ui.initialFinishSnapshot) 'Combined Finish requires an uninspected/unmarked UI case.'
            $initial=FinishSnapshot $ui $controls; $receipt.initialSnapshot=$initial
            Assert ($initial.toggleState -eq 0) 'Launch checkbox is not initially unchecked in actual MSI UI.'
            $ui.initialFinishSnapshot=$initial; WriteJson (PathInRun 'ui-current.json') $ui
            Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
            if ($Choice -eq 'Checked') {
                $checkbox=[Windows.Automation.AutomationElement]::FromHandle([intptr]$controls.checkboxHwnd)
                $checkbox.GetCurrentPattern([Windows.Automation.TogglePattern]::Pattern).Toggle()
            }
            $controls=FinishControls $ui
            $receipt.selectedSnapshot=MarkFinish $ui $controls 'uia-invoke'
            $ui.finishInvokedAt=[DateTime]::UtcNow.ToString('o'); WriteJson (PathInRun 'ui-current.json') $ui
            [Windows.Automation.AutomationElement]::FromHandle([intptr]$controls.finishHwnd).GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()
            VerifyUiExit $ui $receipt
        }
        'LaunchInstalled' {
            $identity=if((ProductState $state.candidate.productCode)-eq 5){$state.candidate}else{$state.previous}; AssertRegistered $identity
            $target=Join-Path $state.installRoot 'Kaigen.exe'
            $process=Start-Process -FilePath $target -WorkingDirectory $state.installRoot -WindowStyle Hidden -PassThru
            $deadline=[DateTime]::UtcNow.AddSeconds(45)
            while (-not $process.HasExited -and $process.MainWindowHandle -eq 0 -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 200; $process.Refresh() }
            Assert (-not $process.HasExited -and $process.MainWindowHandle -ne 0) 'Explicit exact-image launch did not open a real window.'
            $receipt.process=[ordered]@{pid=$process.Id;startedAt=$process.StartTime.ToUniversalTime().ToString('o');path=$process.Path;sha256=(Hash $target);windowHandle=$process.MainWindowHandle.ToInt64()}
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
            $receipt.components=ComponentSnapshot
            foreach($code in $receipt.components.Keys){Assert (@($receipt.components[$code]).Count -eq 0) ('Component clients survive cleanup: '+$code)}
            $receipt.previousFilesAbsent=CheckPayload $previousPayload -Absent; $receipt.candidateFilesAbsent=CheckPayload $candidatePayload -Absent
            if(Test-Path -LiteralPath (PathInRun 'canaries.json')){$receipt.canaries=CheckCanaries}
            $receipt.retained='Evidence and synthetic canaries retained; no recursive filesystem deletion or global process termination.'
        }
    }
    if($receipt.status -eq 'RUNNING'){$receipt.status='PASS'}
    $receipt.finishedAt=[DateTime]::UtcNow.ToString('o')
} catch {
    $receipt.status='FAIL'; $receipt.error=$_.Exception.Message; $receipt.finishedAt=[DateTime]::UtcNow.ToString('o')
    Record ($Phase+'-'+[DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfff')) $receipt
    throw
}
Record ($Phase+'-'+[DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfff')) $receipt
$receipt|ConvertTo-Json -Depth 12
