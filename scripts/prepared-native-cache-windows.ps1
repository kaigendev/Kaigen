#requires -Version 7.6.4

Set-StrictMode -Version Latest

$script:KaigenPreparedNativePolicy = 'verified-prepared-native-v2'
$script:KaigenPreparedNativeSchema = 2
$script:KaigenPreparedNativePlatform = 'windows-x64'
$script:KaigenPreparedNativeGroups = @('libsodium', 'c-toxcore', 'tor-universal')
$script:KaigenUtf8NoBom = [Text.UTF8Encoding]::new($false)

function Get-KaigenStringSha256 {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Value)

    $bytes = $script:KaigenUtf8NoBom.GetBytes($Value)
    return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
}

function Get-KaigenPowerShellRecipeSha256 {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Value)

    # Git may materialize the same PowerShell source with LF or CRLF according
    # to the target checkout. Line endings are not part of the producer
    # semantics and must not create a false prepared-native cache miss.
    $canonical = $Value.Replace("`r`n", "`n").Replace("`r", "`n")
    return Get-KaigenStringSha256 -Value $canonical
}

function Get-KaigenFileSha256 {
    param([Parameter(Mandatory)][string]$Path)

    return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path -ErrorAction Stop).Hash.ToLowerInvariant()
}

function Assert-KaigenOrdinaryDirectory {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Description
    )

    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "$Description must be an ordinary directory: $Path"
    }
    return $item
}

function Assert-KaigenOrdinaryFile {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Description
    )

    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "$Description must be an ordinary file: $Path"
    }
    return $item
}

function Assert-KaigenSafeRelativePath {
    param([Parameter(Mandatory)][string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path) -or [IO.Path]::IsPathRooted($Path) -or
        $Path.IndexOfAny([char[]]@("`r", "`n", "`t", [char]0, '|')) -ge 0) {
        throw "Unsafe prepared-cache relative path: $Path"
    }
    $normalized = $Path.Replace('\', '/')
    if ($normalized -match '(^|/)[.][.]($|/)' -or $normalized.StartsWith('./', [StringComparison]::Ordinal)) {
        throw "Unsafe prepared-cache relative path: $Path"
    }
    return $normalized
}

function Get-KaigenPreparedOutputInventory {
    param([Parameter(Mandatory)][string]$Root)

    $resolvedRoot = [IO.Path]::GetFullPath($Root).TrimEnd('\')
    Assert-KaigenOrdinaryDirectory -Path $resolvedRoot -Description 'Prepared output root' | Out-Null

    $directoryPaths = [Collections.Generic.List[string]]::new()
    $fileRows = [Collections.Generic.List[object]]::new()
    foreach ($item in Get-ChildItem -LiteralPath $resolvedRoot -Force -Recurse -ErrorAction Stop) {
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw "Prepared output contains a reparse point: $($item.FullName)"
        }
        $relative = Assert-KaigenSafeRelativePath -Path ([IO.Path]::GetRelativePath($resolvedRoot, $item.FullName))
        if ($item.PSIsContainer) {
            $directoryPaths.Add($relative)
        } else {
            $fileRows.Add([pscustomobject][ordered]@{
                path = $relative
                size = [Int64]$item.Length
                sha256 = Get-KaigenFileSha256 -Path $item.FullName
            })
        }
    }
    if ($fileRows.Count -eq 0) {
        throw "Prepared output is empty: $resolvedRoot"
    }

    $directories = @($directoryPaths | Sort-Object -CaseSensitive)
    $files = @($fileRows | Sort-Object -CaseSensitive -Property path)
    $canonical = ([pscustomobject][ordered]@{
        directories = $directories
        files = $files
    } | ConvertTo-Json -Compress -Depth 8) + "`n"
    return [pscustomobject]@{
        Directories = $directories
        Files = $files
        Canonical = $canonical
        Sha256 = Get-KaigenStringSha256 -Value $canonical
    }
}

function Get-KaigenTreeSha256 {
    param([Parameter(Mandatory)][string]$Root)

    return (Get-KaigenPreparedOutputInventory -Root $Root).Sha256
}

function Add-KaigenContractFileIdentity {
    param(
        [Parameter(Mandatory)][Collections.IDictionary]$Fields,
        [Parameter(Mandatory)][string]$Prefix,
        [Parameter(Mandatory)][string]$Path,
        [string]$RecordedName = ([IO.Path]::GetFileName($Path))
    )

    if ($Prefix -notmatch '^[a-z0-9][a-z0-9_.-]*$') {
        throw "Unsafe prepared-cache contract prefix: $Prefix"
    }
    $item = Assert-KaigenOrdinaryFile -Path $Path -Description "Prepared-cache input $Prefix"
    $Fields["$Prefix.filename"] = $RecordedName
    $Fields["$Prefix.size"] = ([Int64]$item.Length).ToString([Globalization.CultureInfo]::InvariantCulture)
    $Fields["$Prefix.sha256"] = Get-KaigenFileSha256 -Path $item.FullName
}

function Add-KaigenContractCanonicalTextIdentity {
    param(
        [Parameter(Mandatory)][Collections.IDictionary]$Fields,
        [Parameter(Mandatory)][string]$Prefix,
        [Parameter(Mandatory)][string]$Path,
        [string]$RecordedName = ([IO.Path]::GetFileName($Path))
    )

    if ($Prefix -notmatch '^[a-z0-9][a-z0-9_.-]*$') {
        throw "Unsafe prepared-cache contract prefix: $Prefix"
    }
    $item = Assert-KaigenOrdinaryFile -Path $Path -Description "Prepared-cache canonical text input $Prefix"
    $strictUtf8 = [Text.UTF8Encoding]::new($false, $true)
    $text = $strictUtf8.GetString([IO.File]::ReadAllBytes($item.FullName))
    $canonicalBytes = $script:KaigenUtf8NoBom.GetBytes($text.Replace("`r`n", "`n").Replace("`r", "`n"))
    $Fields["$Prefix.filename"] = $RecordedName
    $Fields["$Prefix.size"] = ([Int64]$canonicalBytes.Length).ToString([Globalization.CultureInfo]::InvariantCulture)
    $Fields["$Prefix.sha256"] = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($canonicalBytes)).ToLowerInvariant()
}

function ConvertTo-KaigenCanonicalContract {
    param([Parameter(Mandatory)][Collections.IDictionary]$Fields)

    $keys = [string[]]@($Fields.Keys)
    [Array]::Sort($keys, [StringComparer]::Ordinal)
    $lines = foreach ($key in $keys) {
        $value = $Fields[$key]
        if ($key -notmatch '^[a-z0-9][a-z0-9_.-]*$' -or $value -isnot [string] -or
            $value.IndexOfAny([char[]]@("`r", "`n", "`t", [char]0)) -ge 0) {
            throw "Unsafe prepared-cache contract field: $key"
        }
        "$key`t$value"
    }
    return ($lines -join "`n") + "`n"
}

function New-KaigenPreparedNativeContract {
    param(
        [Parameter(Mandatory)]
        [ValidateSet('libsodium', 'c-toxcore', 'tor-universal')]
        [string]$Group,

        [Parameter(Mandatory)][Collections.IDictionary]$Fields,
        [Parameter(Mandatory)][string[]]$RequiredOutputs
    )

    $contractFields = [ordered]@{
        schema = $script:KaigenPreparedNativeSchema.ToString([Globalization.CultureInfo]::InvariantCulture)
        policy = $script:KaigenPreparedNativePolicy
        platform = $script:KaigenPreparedNativePlatform
        group = $Group
    }
    foreach ($entry in $Fields.GetEnumerator()) {
        if ($contractFields.Contains($entry.Key)) {
            throw "Prepared-cache caller cannot replace reserved field: $($entry.Key)"
        }
        $contractFields[$entry.Key] = [string]$entry.Value
    }

    foreach ($required in @('architecture', 'abi', 'deployment_target', 'output.contract', 'recipe.sha256')) {
        if (-not $contractFields.Contains($required) -or [string]::IsNullOrWhiteSpace($contractFields[$required])) {
            throw "Prepared-cache contract is missing $required"
        }
    }
    $normalizedRequired = [Collections.Generic.List[string]]::new()
    foreach ($relative in $RequiredOutputs) {
        $normalizedRequired.Add((Assert-KaigenSafeRelativePath -Path $relative))
    }
    $requiredArray = @($normalizedRequired | Sort-Object -CaseSensitive -Unique)
    if ($requiredArray.Count -eq 0 -or $requiredArray.Count -ne $RequiredOutputs.Count) {
        throw 'Prepared-cache required outputs must be non-empty and unique.'
    }
    $contractFields['output.required'] = $requiredArray -join '|'
    $canonical = ConvertTo-KaigenCanonicalContract -Fields $contractFields
    return [pscustomobject]@{
        Group = $Group
        Fields = $contractFields
        RequiredOutputs = $requiredArray
        Canonical = $canonical
        Fingerprint = Get-KaigenStringSha256 -Value $canonical
    }
}

function Get-KaigenPreparedCacheEntryPath {
    param(
        [Parameter(Mandatory)][string]$CacheRoot,
        [Parameter(Mandatory)]$Contract
    )

    if ($Contract.Fingerprint -notmatch '^[a-f0-9]{64}$') {
        throw 'Invalid prepared-cache fingerprint.'
    }
    return [IO.Path]::GetFullPath((Join-Path $CacheRoot "schema-$($script:KaigenPreparedNativeSchema)\$($script:KaigenPreparedNativePlatform)\$($Contract.Group)\$($Contract.Fingerprint)"))
}

function Assert-KaigenPreparedFingerprintNotRevoked {
    param(
        [Parameter(Mandatory)][string]$CacheRoot,
        [Parameter(Mandatory)]$Contract
    )

    $entry = Get-KaigenPreparedCacheEntryPath -CacheRoot $CacheRoot -Contract $Contract
    $revokedRoot = Join-Path $CacheRoot "schema-$($script:KaigenPreparedNativeSchema)\revoked"
    foreach ($candidate in @(
        (Join-Path $revokedRoot $Contract.Fingerprint),
        (Join-Path $revokedRoot "$($Contract.Fingerprint).json"),
        (Join-Path $entry 'REVOKED')
    )) {
        if (Test-Path -LiteralPath $candidate) {
            throw "Prepared-cache fingerprint is revoked: $($Contract.Fingerprint)"
        }
    }
}

function Assert-KaigenPreparedOutputShape {
    param(
        [Parameter(Mandatory)]$Contract,
        [Parameter(Mandatory)][string]$Root
    )

    foreach ($relative in $Contract.RequiredOutputs) {
        $path = Join-Path $Root ($relative.Replace('/', '\'))
        Assert-KaigenOrdinaryFile -Path $path -Description "Required $($Contract.Group) output" | Out-Null
    }
}

function Get-KaigenPreparedCacheValidation {
    param(
        [Parameter(Mandatory)][string]$CacheRoot,
        [Parameter(Mandatory)]$Contract
    )

    Assert-KaigenPreparedFingerprintNotRevoked -CacheRoot $CacheRoot -Contract $Contract
    $entry = Get-KaigenPreparedCacheEntryPath -CacheRoot $CacheRoot -Contract $Contract
    Assert-KaigenOrdinaryDirectory -Path $entry -Description 'Prepared-cache entry' | Out-Null
    $names = @((Get-ChildItem -LiteralPath $entry -Force -ErrorAction Stop | Sort-Object -CaseSensitive -Property Name).Name)
    if (($names -join "`n") -cne "contract.tsv`nmanifest.json`noutputs") {
        throw "Unexpected files in prepared-cache entry: $($Contract.Fingerprint)"
    }

    $storedContract = [IO.File]::ReadAllText((Join-Path $entry 'contract.tsv'))
    if ($storedContract -cne $Contract.Canonical) {
        throw "Prepared-cache contract mismatch: $($Contract.Fingerprint)"
    }
    $outputsRoot = Join-Path $entry 'outputs'
    Assert-KaigenPreparedOutputShape -Contract $Contract -Root $outputsRoot
    $inventory = Get-KaigenPreparedOutputInventory -Root $outputsRoot
    try {
        $manifest = Get-Content -LiteralPath (Join-Path $entry 'manifest.json') -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    } catch {
        throw "Corrupt prepared-cache manifest: $($Contract.Fingerprint)"
    }
    $requiredProducerMode = [string]($Contract.Fields['producer.mode'] ?? '')
    $actualProducerMode = ''
    if ($null -ne $manifest.PSObject.Properties['provenance'] -and
        $null -ne $manifest.provenance.PSObject.Properties['mode']) {
        $actualProducerMode = [string]$manifest.provenance.mode
    }
    if ($manifest.schemaVersion -ne $script:KaigenPreparedNativeSchema -or
        $manifest.policy -cne $script:KaigenPreparedNativePolicy -or
        $manifest.platform -cne $script:KaigenPreparedNativePlatform -or
        $manifest.group -cne $Contract.Group -or
        $manifest.fingerprint -cne $Contract.Fingerprint -or
        $manifest.contractSha256 -cne $Contract.Fingerprint -or
        $manifest.outputManifestSha256 -cne $inventory.Sha256 -or
        (-not [string]::IsNullOrWhiteSpace($requiredProducerMode) -and $actualProducerMode -cne $requiredProducerMode)) {
        throw "Corrupt prepared-cache manifest or output: $($Contract.Fingerprint)"
    }
    $storedInventory = ([pscustomobject][ordered]@{
        directories = @($manifest.outputs.directories)
        files = @($manifest.outputs.files | ForEach-Object {
            [pscustomobject][ordered]@{ path = [string]$_.path; size = [Int64]$_.size; sha256 = [string]$_.sha256 }
        })
    } | ConvertTo-Json -Compress -Depth 8) + "`n"
    if ($storedInventory -cne $inventory.Canonical) {
        throw "Corrupt prepared-cache output inventory: $($Contract.Fingerprint)"
    }
    return [pscustomobject]@{
        Entry = $entry
        OutputsRoot = $outputsRoot
        OutputManifestSha256 = $inventory.Sha256
        Outputs = $inventory.Files
    }
}

function Set-KaigenTreeWritable {
    param([Parameter(Mandatory)][string]$Root)

    if (-not (Test-Path -LiteralPath $Root)) { return }
    foreach ($item in @(Get-ChildItem -LiteralPath $Root -Force -Recurse -ErrorAction SilentlyContinue) + @(Get-Item -LiteralPath $Root -Force)) {
        if (-not $item.PSIsContainer -and $item.IsReadOnly) { $item.IsReadOnly = $false }
    }
}

function Set-KaigenTreeReadOnly {
    param([Parameter(Mandatory)][string]$Root)

    foreach ($item in Get-ChildItem -LiteralPath $Root -Force -Recurse -File -ErrorAction Stop) {
        $item.IsReadOnly = $true
    }
}

function Remove-KaigenTemporaryTree {
    param([Parameter(Mandatory)][string]$Root)

    if (Test-Path -LiteralPath $Root) {
        Set-KaigenTreeWritable -Root $Root
        [IO.Directory]::Delete([IO.Path]::GetFullPath($Root), $true)
    }
}

function Publish-KaigenPreparedNativeEntry {
    param(
        [Parameter(Mandatory)][string]$CacheRoot,
        [Parameter(Mandatory)]$Contract,
        [Parameter(Mandatory)][string]$Source,
        [string]$Mode = 'compiled-miss'
    )

    Assert-KaigenPreparedFingerprintNotRevoked -CacheRoot $CacheRoot -Contract $Contract
    $requiredProducerMode = [string]($Contract.Fields['producer.mode'] ?? '')
    if (-not [string]::IsNullOrWhiteSpace($requiredProducerMode) -and $Mode -cne $requiredProducerMode) {
        throw "Prepared-cache producer provenance mismatch for $($Contract.Group): expected $requiredProducerMode, got $Mode"
    }
    Assert-KaigenOrdinaryDirectory -Path $Source -Description 'Prepared-cache producer output' | Out-Null
    Assert-KaigenPreparedOutputShape -Contract $Contract -Root $Source
    $entry = Get-KaigenPreparedCacheEntryPath -CacheRoot $CacheRoot -Contract $Contract
    if (Test-Path -LiteralPath $entry) {
        $existing = Get-KaigenPreparedCacheValidation -CacheRoot $CacheRoot -Contract $Contract
        $candidate = Get-KaigenPreparedOutputInventory -Root $Source
        if ($candidate.Canonical -cne ((Get-KaigenPreparedOutputInventory -Root $existing.OutputsRoot).Canonical)) {
            throw "Same prepared-cache fingerprint produced different outputs: $($Contract.Fingerprint)"
        }
        return [pscustomobject]@{
            CacheDisposition = 'hit'; Group = $Contract.Group; Fingerprint = $Contract.Fingerprint
            OutputManifestSha256 = $existing.OutputManifestSha256; Outputs = $existing.Outputs
            PatchSetManifestSha256 = [string]($Contract.Fields['patch.manifest.sha256'] ?? 'none')
            Status = 'active'; TombstoneIds = @()
        }
    }

    $groupRoot = Split-Path -Parent $entry
    [IO.Directory]::CreateDirectory($groupRoot) | Out-Null
    Assert-KaigenOrdinaryDirectory -Path $groupRoot -Description 'Prepared-cache group root' | Out-Null
    $stage = Join-Path $groupRoot ('.staging-{0}-{1}-{2}' -f $Contract.Fingerprint, $PID, [guid]::NewGuid().ToString('N'))
    try {
        [IO.Directory]::CreateDirectory($stage) | Out-Null
        $stageOutputs = Join-Path $stage 'outputs'
        Copy-Item -LiteralPath $Source -Destination $stageOutputs -Recurse -Force
        Assert-KaigenPreparedOutputShape -Contract $Contract -Root $stageOutputs
        $inventory = Get-KaigenPreparedOutputInventory -Root $stageOutputs
        [IO.File]::WriteAllText((Join-Path $stage 'contract.tsv'), $Contract.Canonical, $script:KaigenUtf8NoBom)
        $manifest = [pscustomobject][ordered]@{
            schemaVersion = $script:KaigenPreparedNativeSchema
            policy = $script:KaigenPreparedNativePolicy
            platform = $script:KaigenPreparedNativePlatform
            group = $Contract.Group
            fingerprint = $Contract.Fingerprint
            contractSha256 = $Contract.Fingerprint
            outputManifestSha256 = $inventory.Sha256
            outputs = [pscustomobject][ordered]@{ directories = $inventory.Directories; files = $inventory.Files }
            provenance = [pscustomobject][ordered]@{ mode = $Mode }
        }
        [IO.File]::WriteAllText((Join-Path $stage 'manifest.json'), ($manifest | ConvertTo-Json -Depth 10) + "`n", $script:KaigenUtf8NoBom)
        Set-KaigenTreeReadOnly -Root $stage
        try {
            [IO.Directory]::Move($stage, $entry)
        } catch [IO.IOException] {
            Remove-KaigenTemporaryTree -Root $stage
            $existing = Get-KaigenPreparedCacheValidation -CacheRoot $CacheRoot -Contract $Contract
            if ($inventory.Canonical -cne ((Get-KaigenPreparedOutputInventory -Root $existing.OutputsRoot).Canonical)) {
                throw "Concurrent prepared-cache output mismatch: $($Contract.Fingerprint)"
            }
            return [pscustomobject]@{
                CacheDisposition = 'hit'; Group = $Contract.Group; Fingerprint = $Contract.Fingerprint
                OutputManifestSha256 = $existing.OutputManifestSha256; Outputs = $existing.Outputs
                PatchSetManifestSha256 = [string]($Contract.Fields['patch.manifest.sha256'] ?? 'none')
                Status = 'active'; TombstoneIds = @()
            }
        }
        return [pscustomobject]@{
            CacheDisposition = 'built'; Group = $Contract.Group; Fingerprint = $Contract.Fingerprint
            OutputManifestSha256 = $inventory.Sha256; Outputs = $inventory.Files
            PatchSetManifestSha256 = [string]($Contract.Fields['patch.manifest.sha256'] ?? 'none')
            Status = 'active'; TombstoneIds = @()
        }
    } catch {
        Remove-KaigenTemporaryTree -Root $stage
        throw
    }
}

function Restore-KaigenPreparedNativeEntry {
    param(
        [Parameter(Mandatory)][string]$CacheRoot,
        [Parameter(Mandatory)]$Contract,
        [Parameter(Mandatory)][string]$Destination
    )

    Assert-KaigenPreparedFingerprintNotRevoked -CacheRoot $CacheRoot -Contract $Contract
    $entry = Get-KaigenPreparedCacheEntryPath -CacheRoot $CacheRoot -Contract $Contract
    if (-not (Test-Path -LiteralPath $entry)) {
        return [pscustomobject]@{
            CacheDisposition = 'miss'; PhysicalCacheDisposition = 'miss'; ProducerInvoked = $false
            Group = $Contract.Group; Fingerprint = $Contract.Fingerprint
        }
    }
    $validated = Get-KaigenPreparedCacheValidation -CacheRoot $CacheRoot -Contract $Contract
    $destinationFull = [IO.Path]::GetFullPath($Destination).TrimEnd('\')
    $parent = Split-Path -Parent $destinationFull
    [IO.Directory]::CreateDirectory($parent) | Out-Null
    Assert-KaigenOrdinaryDirectory -Path $parent -Description 'Prepared-cache restore parent' | Out-Null
    $stage = Join-Path $parent ('.prepared-restore-{0}-{1}-{2}' -f ([IO.Path]::GetFileName($destinationFull)), $PID, [guid]::NewGuid().ToString('N'))
    $backup = "$stage.old"
    $movedOld = $false
    try {
        Copy-Item -LiteralPath $validated.OutputsRoot -Destination $stage -Recurse -Force
        Set-KaigenTreeWritable -Root $stage
        Assert-KaigenPreparedOutputShape -Contract $Contract -Root $stage
        $copy = Get-KaigenPreparedOutputInventory -Root $stage
        if ($copy.Sha256 -cne $validated.OutputManifestSha256) {
            throw "Prepared-cache restore copy mismatch: $($Contract.Fingerprint)"
        }
        if (Test-Path -LiteralPath $destinationFull) {
            $destinationItem = Get-Item -LiteralPath $destinationFull -Force
            if (-not $destinationItem.PSIsContainer -or ($destinationItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
                throw "Prepared-cache destination is unsafe: $destinationFull"
            }
            [IO.Directory]::Move($destinationFull, $backup)
            $movedOld = $true
        }
        [IO.Directory]::Move($stage, $destinationFull)
        if ($movedOld) { Remove-KaigenTemporaryTree -Root $backup }
        return [pscustomobject]@{
            CacheDisposition = 'hit'; Group = $Contract.Group; Fingerprint = $Contract.Fingerprint
            PhysicalCacheDisposition = 'hit'; ProducerInvoked = $false
            OutputManifestSha256 = $validated.OutputManifestSha256; Outputs = $validated.Outputs
            PatchSetManifestSha256 = [string]($Contract.Fields['patch.manifest.sha256'] ?? 'none')
            Status = 'active'; TombstoneIds = @()
        }
    } catch {
        Remove-KaigenTemporaryTree -Root $stage
        if ($movedOld -and -not (Test-Path -LiteralPath $destinationFull) -and (Test-Path -LiteralPath $backup)) {
            [IO.Directory]::Move($backup, $destinationFull)
        }
        throw
    }
}

function Get-KaigenPreparedExpectationPath {
    param([Parameter(Mandatory)][string]$CacheRoot, [Parameter(Mandatory)]$Contract)
    return Join-Path $CacheRoot "schema-$($script:KaigenPreparedNativeSchema)\$($script:KaigenPreparedNativePlatform)\expected\$($Contract.Group).json"
}

function Read-KaigenPreparedExpectation {
    param([Parameter(Mandatory)][string]$CacheRoot, [Parameter(Mandatory)]$Contract)

    $path = Get-KaigenPreparedExpectationPath -CacheRoot $CacheRoot -Contract $Contract
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    Assert-KaigenOrdinaryFile -Path $path -Description 'Prepared-cache expectation' | Out-Null
    try { $value = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json -ErrorAction Stop } catch { throw "Corrupt prepared-cache expectation: $path" }
    if ($value.schemaVersion -ne $script:KaigenPreparedNativeSchema -or $value.platform -cne $script:KaigenPreparedNativePlatform -or
        $value.group -cne $Contract.Group -or $value.fingerprint -notmatch '^[a-f0-9]{64}$') {
        throw "Invalid prepared-cache expectation: $path"
    }
    return $value
}

function Write-KaigenPreparedExpectation {
    param([Parameter(Mandatory)][string]$CacheRoot, [Parameter(Mandatory)]$Contract)

    $path = Get-KaigenPreparedExpectationPath -CacheRoot $CacheRoot -Contract $Contract
    $parent = Split-Path -Parent $path
    [IO.Directory]::CreateDirectory($parent) | Out-Null
    $temporary = "$path.$PID.$([guid]::NewGuid().ToString('N')).tmp"
    $value = [pscustomobject][ordered]@{
        schemaVersion = $script:KaigenPreparedNativeSchema
        platform = $script:KaigenPreparedNativePlatform
        group = $Contract.Group
        fingerprint = $Contract.Fingerprint
    }
    [IO.File]::WriteAllText($temporary, ($value | ConvertTo-Json -Depth 4) + "`n", $script:KaigenUtf8NoBom)
    [IO.File]::Move($temporary, $path, $true)
}

function Resolve-KaigenPreparedNativeGroup {
    param(
        [Parameter(Mandatory)][string]$CacheRoot,
        [Parameter(Mandatory)]$Contract,
        [Parameter(Mandatory)][string]$Destination,
        [Parameter(Mandatory)][scriptblock]$Producer,
        [ValidateSet('auto', 'build-on-miss', 'expected-hit')][string]$Mode = 'auto',
        [string]$ProducerMode = 'compiled-miss',
        [switch]$ForceProducer
    )

    if ($ForceProducer -and $Mode -cne 'build-on-miss') {
        throw 'A forced prepared-cache producer requires explicit build-on-miss mode.'
    }
    $cacheRootFull = [IO.Path]::GetFullPath($CacheRoot).TrimEnd('\')
    if (-not (Test-Path -LiteralPath $cacheRootFull)) {
        if ($Mode -ceq 'expected-hit') {
            throw "Expected prepared-cache hit, but the cache root is missing: $cacheRootFull"
        }
        [IO.Directory]::CreateDirectory($cacheRootFull) | Out-Null
    }
    Assert-KaigenOrdinaryDirectory -Path $cacheRootFull -Description 'Prepared native cache root' | Out-Null
    $expectation = Read-KaigenPreparedExpectation -CacheRoot $cacheRootFull -Contract $Contract
    $expectedByPriorSuccess = $Mode -ceq 'auto' -and $null -ne $expectation -and $expectation.fingerprint -ceq $Contract.Fingerprint

    $restored = Restore-KaigenPreparedNativeEntry -CacheRoot $cacheRootFull -Contract $Contract -Destination $Destination
    if ($restored.CacheDisposition -ceq 'hit' -and -not $ForceProducer) {
        Write-KaigenPreparedExpectation -CacheRoot $cacheRootFull -Contract $Contract
        Write-Host "prepared-native-cache platform=$($script:KaigenPreparedNativePlatform) group=$($Contract.Group) disposition=hit fingerprint=$($Contract.Fingerprint)"
        return $restored
    }
    if ($Mode -ceq 'expected-hit' -or $expectedByPriorSuccess) {
        throw "Expected prepared-cache hit for $($Contract.Group), but fingerprint $($Contract.Fingerprint) is missing. Refusing compiler fallback."
    }
    $requiredProducerMode = [string]($Contract.Fields['producer.mode'] ?? '')
    if (-not [string]::IsNullOrWhiteSpace($requiredProducerMode) -and $ProducerMode -cne $requiredProducerMode) {
        throw "Prepared-cache producer provenance mismatch for $($Contract.Group): expected $requiredProducerMode, got $ProducerMode"
    }

    $producerParent = Split-Path -Parent ([IO.Path]::GetFullPath($Destination))
    [IO.Directory]::CreateDirectory($producerParent) | Out-Null
    $producerRoot = Join-Path $producerParent ('.prepared-producer-{0}-{1}-{2}' -f $Contract.Group, $PID, [guid]::NewGuid().ToString('N'))
    try {
        [IO.Directory]::CreateDirectory($producerRoot) | Out-Null
        # Native tools write their ordinary build log to PowerShell's success
        # stream. Keep that log visible without allowing it to contaminate the
        # resolver's single structured result object used by receipts.
        & $Producer $producerRoot | Out-Host
        $published = Publish-KaigenPreparedNativeEntry -CacheRoot $cacheRootFull -Contract $Contract -Source $producerRoot -Mode $ProducerMode
        $consumer = Restore-KaigenPreparedNativeEntry -CacheRoot $cacheRootFull -Contract $Contract -Destination $Destination
        if ($consumer.CacheDisposition -cne 'hit') { throw "Prepared-cache promotion was not resolvable: $($Contract.Fingerprint)" }
        Write-KaigenPreparedExpectation -CacheRoot $cacheRootFull -Contract $Contract
        $result = [pscustomobject]@{
            CacheDisposition = $(if ($ForceProducer) { 'built' } else { $published.CacheDisposition })
            PhysicalCacheDisposition = $published.CacheDisposition
            ProducerInvoked = $true
            Group = $Contract.Group; Fingerprint = $Contract.Fingerprint
            OutputManifestSha256 = $published.OutputManifestSha256; Outputs = $published.Outputs
            PatchSetManifestSha256 = $published.PatchSetManifestSha256
            Status = 'active'; TombstoneIds = @()
        }
        Write-Host "prepared-native-cache platform=$($script:KaigenPreparedNativePlatform) group=$($Contract.Group) disposition=$($result.CacheDisposition) physical-cache-disposition=$($result.PhysicalCacheDisposition) fingerprint=$($Contract.Fingerprint)"
        return $result
    } finally {
        Remove-KaigenTemporaryTree -Root $producerRoot
    }
}

function Write-KaigenPreparedNativeReceipt {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][object[]]$Groups,
        [AllowEmptyString()][string]$ApplicationArtifact = '',
        [AllowEmptyString()][string]$ApplicationSha256 = '',
        [bool]$ApplicationRebuilt = $true
    )

    $groupArray = @($Groups | Sort-Object -CaseSensitive -Property Group)
    $actualGroups = @($groupArray.Group | Sort-Object -CaseSensitive -Unique)
    $expectedGroups = @($script:KaigenPreparedNativeGroups | Sort-Object -CaseSensitive)
    if (($actualGroups -join '|') -cne ($expectedGroups -join '|') -or $groupArray.Count -ne $expectedGroups.Count) {
        throw 'Windows prepared-native receipt requires exactly one result for each native group.'
    }
    if ($ApplicationRebuilt -and ([string]::IsNullOrWhiteSpace($ApplicationArtifact) -or $ApplicationSha256 -notmatch '^[A-Fa-f0-9]{64}$')) {
        throw 'A rebuilt application receipt requires the artifact path and exact SHA-256.'
    }
    if (-not [string]::IsNullOrWhiteSpace($ApplicationSha256) -and $ApplicationSha256 -notmatch '^[A-Fa-f0-9]{64}$') {
        throw 'Application artifact SHA-256 is invalid.'
    }
    $receipt = [pscustomobject][ordered]@{
        schemaVersion = $script:KaigenPreparedNativeSchema
        policy = $script:KaigenPreparedNativePolicy
        platform = $script:KaigenPreparedNativePlatform
        applicationRebuilt = $ApplicationRebuilt
        applicationArtifact = $(if ([string]::IsNullOrWhiteSpace($ApplicationArtifact)) { $null } else { $ApplicationArtifact })
        applicationSha256 = $(if ([string]::IsNullOrWhiteSpace($ApplicationSha256)) { $null } else { $ApplicationSha256.ToLowerInvariant() })
        groups = @($groupArray | ForEach-Object {
            [pscustomobject][ordered]@{
                group = $_.Group
                cacheDisposition = $_.CacheDisposition
                physicalCacheDisposition = $_.PhysicalCacheDisposition
                producerInvoked = $_.ProducerInvoked
                fingerprint = $_.Fingerprint
                patchSetManifestSha256 = $_.PatchSetManifestSha256
                status = $_.Status
                tombstoneIds = @($_.TombstoneIds)
                outputManifestSha256 = $_.OutputManifestSha256
                outputs = @($_.Outputs)
            }
        })
    }
    $parent = Split-Path -Parent ([IO.Path]::GetFullPath($Path))
    [IO.Directory]::CreateDirectory($parent) | Out-Null
    [IO.File]::WriteAllText($Path, ($receipt | ConvertTo-Json -Depth 12) + "`n", $script:KaigenUtf8NoBom)
}
