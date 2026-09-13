#requires -Version 7.6.5

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($PSVersionTable.PSVersion.ToString() -cne '7.6.5') {
    throw 'Kaigen automation requires PowerShell 7.6.5 exactly.'
}

$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
. (Join-Path $PSScriptRoot 'prepared-native-cache-windows.ps1')

function Assert-Condition {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

function Assert-ThrowsLike {
    param([scriptblock]$Action, [string]$Pattern, [string]$Message)
    try {
        & $Action
    } catch {
        if ($_.Exception.Message -match $Pattern) { return }
        throw "$Message Unexpected error: $($_.Exception.Message)"
    }
    throw $Message
}

$lfRecipe = "param()`nWrite-Output 'same recipe'`n"
$crlfRecipe = $lfRecipe.Replace("`n", "`r`n")
$crRecipe = $lfRecipe.Replace("`n", "`r")
$lfRecipeHash = Get-KaigenPowerShellRecipeSha256 -Value $lfRecipe
Assert-Condition ((Get-KaigenPowerShellRecipeSha256 -Value $crlfRecipe) -ceq $lfRecipeHash) 'CRLF changed the semantic PowerShell recipe fingerprint.'
Assert-Condition ((Get-KaigenPowerShellRecipeSha256 -Value $crRecipe) -ceq $lfRecipeHash) 'CR changed the semantic PowerShell recipe fingerprint.'

$textIdentityRoot = Join-Path ([IO.Path]::GetTempPath()) ('kaigen-prepared-native-text-' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($textIdentityRoot) | Out-Null
try {
    $lfPath = Join-Path $textIdentityRoot 'recipe-lf.cmake'
    $crlfPath = Join-Path $textIdentityRoot 'recipe-crlf.cmake'
    [IO.File]::WriteAllText($lfPath, $lfRecipe, [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText($crlfPath, $crlfRecipe, [Text.UTF8Encoding]::new($false))
    $lfFields = [ordered]@{}
    $crlfFields = [ordered]@{}
    Add-KaigenContractCanonicalTextIdentity -Fields $lfFields -Prefix 'config.fixture' -Path $lfPath -RecordedName 'recipe.cmake'
    Add-KaigenContractCanonicalTextIdentity -Fields $crlfFields -Prefix 'config.fixture' -Path $crlfPath -RecordedName 'recipe.cmake'
    Assert-Condition ($lfFields['config.fixture.size'] -ceq $crlfFields['config.fixture.size']) 'CRLF changed canonical text input size.'
    Assert-Condition ($lfFields['config.fixture.sha256'] -ceq $crlfFields['config.fixture.sha256']) 'CRLF changed canonical text input SHA-256.'
} finally {
    Remove-KaigenTemporaryTree -Root $textIdentityRoot
}

function New-FixtureContract {
    param(
        [ValidateSet('libsodium', 'c-toxcore', 'tor-universal')][string]$Group,
        [string]$Variant = 'one',
        [string]$ProducerMode = ''
    )
    $fields = [ordered]@{
        architecture = 'x86_64'
        abi = 'windows-msvc-static-crt'
        deployment_target = 'windows-10-x64'
        'output.contract' = "fixture-$Group-v2"
        'recipe.sha256' = Get-KaigenStringSha256 -Value "fixture-recipe-$Group-$Variant"
        'input.fixture.filename' = "$Group.bin"
        'input.fixture.size' = '7'
        'input.fixture.sha256' = Get-KaigenStringSha256 -Value "input-$Group-$Variant"
        'toolchain.fixture.sha256' = Get-KaigenStringSha256 -Value 'compiler-fixture-v1'
    }
    if (-not [string]::IsNullOrWhiteSpace($ProducerMode)) { $fields['producer.mode'] = $ProducerMode }
    return New-KaigenPreparedNativeContract -Group $Group -Fields $fields -RequiredOutputs @('payload.bin')
}

$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('kaigen-prepared-native-windows-' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($testRoot) | Out-Null
try {
    $cacheRoot = Join-Path $testRoot 'cache'
    $destination = Join-Path $testRoot 'resolved\c-toxcore'
    $compilerSentinel = Join-Path $testRoot 'compiler-sentinel.txt'
    $contract = New-FixtureContract -Group c-toxcore
    $producer = {
        param($outputRoot)
        $count = if (Test-Path -LiteralPath $compilerSentinel) { [int]([IO.File]::ReadAllText($compilerSentinel)) } else { 0 }
        Write-Output "fixture compiler log $($count + 1)"
        [IO.File]::WriteAllText($compilerSentinel, ([string]($count + 1)), [Text.UTF8Encoding]::new($false))
        [IO.File]::WriteAllText((Join-Path $outputRoot 'payload.bin'), 'compiled-once', [Text.UTF8Encoding]::new($false))
    }.GetNewClosure()

    $first = Resolve-KaigenPreparedNativeGroup -CacheRoot $cacheRoot -Contract $contract -Destination $destination -Producer $producer -Mode build-on-miss
    Assert-Condition ($first -is [pscustomobject] -and $first.Group -ceq 'c-toxcore' -and $first.CacheDisposition -ceq 'built') 'A noisy native producer contaminated the resolver result or was not reported as built.'
    Assert-Condition ([IO.File]::ReadAllText($compilerSentinel) -ceq '1') 'The first native resolution did not invoke the compiler sentinel exactly once.'
    Remove-KaigenTemporaryTree -Root $destination
    $second = Resolve-KaigenPreparedNativeGroup -CacheRoot $cacheRoot -Contract $contract -Destination $destination -Producer $producer -Mode expected-hit
    Assert-Condition ($second.CacheDisposition -ceq 'hit') 'The second Windows native resolution was not reported as hit.'
    Assert-Condition ([IO.File]::ReadAllText($compilerSentinel) -ceq '1') 'The cache hit invoked the compiler sentinel.'

    $forced = Resolve-KaigenPreparedNativeGroup -CacheRoot $cacheRoot -Contract $contract -Destination $destination `
        -Producer $producer -Mode build-on-miss -ForceProducer
    Assert-Condition ($forced.CacheDisposition -ceq 'built' -and $forced.PhysicalCacheDisposition -ceq 'hit' -and $forced.ProducerInvoked) 'Forced native population did not rebuild and compare against the immutable existing entry.'
    Assert-Condition ([IO.File]::ReadAllText($compilerSentinel) -ceq '2') 'Forced native population did not invoke the compiler sentinel for a preseeded fingerprint.'
    $conflictingSentinel = Join-Path $testRoot 'conflicting-producer-sentinel.txt'
    $conflictingProducer = {
        param($outputRoot)
        [IO.File]::WriteAllText($conflictingSentinel, '1')
        [IO.File]::WriteAllText((Join-Path $outputRoot 'payload.bin'), 'different-compiled-output')
    }.GetNewClosure()
    Assert-ThrowsLike {
        Resolve-KaigenPreparedNativeGroup -CacheRoot $cacheRoot -Contract $contract -Destination $destination `
            -Producer $conflictingProducer -Mode build-on-miss -ForceProducer | Out-Null
    } 'Same prepared-cache fingerprint produced different outputs' 'Forced native population overwrote or accepted conflicting immutable output.'
    Assert-Condition ([IO.File]::ReadAllText($conflictingSentinel) -ceq '1') 'The conflicting forced producer was not actually invoked.'

    $provenanceRoot = Join-Path $testRoot 'provenance-case'
    $provenanceContract = New-FixtureContract -Group c-toxcore -Variant provenance -ProducerMode compiled-miss
    $provenanceSentinel = Join-Path $provenanceRoot 'compiler.txt'
    $provenanceProducer = {
        param($outputRoot)
        [IO.File]::WriteAllText($provenanceSentinel, '1')
        [IO.File]::WriteAllText((Join-Path $outputRoot 'payload.bin'), 'provenance-fixture')
    }.GetNewClosure()
    Assert-ThrowsLike {
        Resolve-KaigenPreparedNativeGroup -CacheRoot (Join-Path $provenanceRoot 'cache') -Contract $provenanceContract `
            -Destination (Join-Path $provenanceRoot 'resolved') -Producer $provenanceProducer -Mode build-on-miss `
            -ProducerMode accepted-artifact | Out-Null
    } 'producer provenance mismatch' 'A producer with unbound provenance was allowed to seed the cache.'
    Assert-Condition (-not (Test-Path -LiteralPath $provenanceSentinel)) 'Rejected producer provenance still invoked the producer.'
    Resolve-KaigenPreparedNativeGroup -CacheRoot (Join-Path $provenanceRoot 'cache') -Contract $provenanceContract `
        -Destination (Join-Path $provenanceRoot 'resolved') -Producer $provenanceProducer -Mode build-on-miss `
        -ProducerMode compiled-miss | Out-Null
    $provenanceEntry = Get-KaigenPreparedCacheEntryPath -CacheRoot (Join-Path $provenanceRoot 'cache') -Contract $provenanceContract
    $provenanceManifestPath = Join-Path $provenanceEntry 'manifest.json'
    (Get-Item -LiteralPath $provenanceManifestPath -Force).IsReadOnly = $false
    $provenanceManifest = Get-Content -LiteralPath $provenanceManifestPath -Raw | ConvertFrom-Json
    $provenanceManifest.provenance.mode = 'accepted-artifact'
    [IO.File]::WriteAllText($provenanceManifestPath, ($provenanceManifest | ConvertTo-Json -Depth 10) + "`n")
    Assert-ThrowsLike {
        Resolve-KaigenPreparedNativeGroup -CacheRoot (Join-Path $provenanceRoot 'cache') -Contract $provenanceContract `
            -Destination (Join-Path $provenanceRoot 'resolved') -Producer $provenanceProducer -Mode expected-hit `
            -ProducerMode compiled-miss | Out-Null
    } 'Corrupt prepared-cache manifest or output' 'A cache entry with mismatched producer provenance was accepted as a hit.'

    $entry = Get-KaigenPreparedCacheEntryPath -CacheRoot $cacheRoot -Contract $contract
    $cachedPayload = Join-Path $entry 'outputs\payload.bin'
    (Get-Item -LiteralPath $cachedPayload -Force).IsReadOnly = $false
    [IO.File]::WriteAllText($cachedPayload, 'tampered', [Text.UTF8Encoding]::new($false))
    Assert-ThrowsLike {
        Resolve-KaigenPreparedNativeGroup -CacheRoot $cacheRoot -Contract $contract -Destination $destination -Producer $producer -Mode auto | Out-Null
    } 'Corrupt prepared-cache' 'A corrupted Windows native entry did not fail closed.'
    Assert-Condition ([IO.File]::ReadAllText($compilerSentinel) -ceq '2') 'Corruption triggered a compiler fallback.'

    $missingRoot = Join-Path $testRoot 'missing-case'
    $missingSentinel = Join-Path $missingRoot 'compiler.txt'
    $missingContract = New-FixtureContract -Group c-toxcore -Variant missing
    $missingProducer = {
        param($outputRoot)
        $count = if (Test-Path -LiteralPath $missingSentinel) { [int]([IO.File]::ReadAllText($missingSentinel)) } else { 0 }
        [IO.Directory]::CreateDirectory((Split-Path -Parent $missingSentinel)) | Out-Null
        [IO.File]::WriteAllText($missingSentinel, ([string]($count + 1)))
        [IO.File]::WriteAllText((Join-Path $outputRoot 'payload.bin'), 'missing-fixture')
    }.GetNewClosure()
    $missingDestination = Join-Path $missingRoot 'resolved'
    $missingFirst = Resolve-KaigenPreparedNativeGroup -CacheRoot (Join-Path $missingRoot 'cache') -Contract $missingContract -Destination $missingDestination -Producer $missingProducer -Mode auto
    $missingEntry = Get-KaigenPreparedCacheEntryPath -CacheRoot (Join-Path $missingRoot 'cache') -Contract $missingContract
    Remove-KaigenTemporaryTree -Root $missingEntry
    Assert-ThrowsLike {
        Resolve-KaigenPreparedNativeGroup -CacheRoot (Join-Path $missingRoot 'cache') -Contract $missingContract -Destination $missingDestination -Producer $missingProducer -Mode auto | Out-Null
    } 'Refusing compiler fallback' 'A seeded-but-missing Windows native entry did not fail before compilation.'
    Assert-Condition ([IO.File]::ReadAllText($missingSentinel) -ceq '1') 'A seeded cache miss invoked the compiler fallback.'

    $revokedRoot = Join-Path $testRoot 'revoked-case'
    $revokedContract = New-FixtureContract -Group c-toxcore -Variant revoked
    $revokedSentinel = Join-Path $revokedRoot 'compiler.txt'
    $revokedProducer = {
        param($outputRoot)
        $count = if (Test-Path -LiteralPath $revokedSentinel) { [int]([IO.File]::ReadAllText($revokedSentinel)) } else { 0 }
        [IO.Directory]::CreateDirectory((Split-Path -Parent $revokedSentinel)) | Out-Null
        [IO.File]::WriteAllText($revokedSentinel, ([string]($count + 1)))
        [IO.File]::WriteAllText((Join-Path $outputRoot 'payload.bin'), 'revoked-fixture')
    }.GetNewClosure()
    $revokedCache = Join-Path $revokedRoot 'cache'
    $revokedDestination = Join-Path $revokedRoot 'resolved'
    Resolve-KaigenPreparedNativeGroup -CacheRoot $revokedCache -Contract $revokedContract -Destination $revokedDestination -Producer $revokedProducer -Mode auto | Out-Null
    $tombstoneRoot = Join-Path $revokedCache 'schema-2\revoked'
    [IO.Directory]::CreateDirectory($tombstoneRoot) | Out-Null
    [IO.File]::WriteAllText((Join-Path $tombstoneRoot "$($revokedContract.Fingerprint).json"), '{"id":"fixture-revocation"}')
    Assert-ThrowsLike {
        Resolve-KaigenPreparedNativeGroup -CacheRoot $revokedCache -Contract $revokedContract -Destination $revokedDestination -Producer $revokedProducer -Mode auto | Out-Null
    } 'is revoked' 'A revoked Windows native entry was accepted or rebuilt.'
    Assert-Condition ([IO.File]::ReadAllText($revokedSentinel) -ceq '1') 'Revocation triggered a compiler fallback.'

    $freshExpectedContract = New-FixtureContract -Group c-toxcore -Variant expected
    Assert-ThrowsLike {
        Resolve-KaigenPreparedNativeGroup -CacheRoot (Join-Path $testRoot 'never-seeded') -Contract $freshExpectedContract `
            -Destination (Join-Path $testRoot 'never-resolved') -Producer $producer -Mode expected-hit | Out-Null
    } 'Expected prepared-cache hit' 'Expected-hit mode accepted an unseeded cache.'
    Assert-Condition ([IO.File]::ReadAllText($compilerSentinel) -ceq '2') 'Expected-hit mode invoked the compiler sentinel.'

    $receiptRoot = Join-Path $testRoot 'receipt-case'
    $receiptResults = [Collections.Generic.List[object]]::new()
    foreach ($group in @('libsodium', 'c-toxcore', 'tor-universal')) {
        $groupContract = New-FixtureContract -Group $group -Variant receipt
        $groupProducer = {
            param($outputRoot)
            [IO.File]::WriteAllText((Join-Path $outputRoot 'payload.bin'), "receipt-$group")
        }.GetNewClosure()
        $receiptResults.Add((Resolve-KaigenPreparedNativeGroup -CacheRoot (Join-Path $receiptRoot 'cache') -Contract $groupContract `
            -Destination (Join-Path $receiptRoot "resolved\$group") -Producer $groupProducer -Mode build-on-miss))
    }
    $appArtifact = Join-Path $receiptRoot 'Kaigen-portable-windows-x64.zip'
    [IO.File]::WriteAllText($appArtifact, 'fresh-application-artifact')
    $receiptPath = Join-Path $receiptRoot 'prepared-native-cache-windows-x64.json'
    Write-KaigenPreparedNativeReceipt -Path $receiptPath -Groups $receiptResults.ToArray() -ApplicationArtifact $appArtifact `
        -ApplicationSha256 (Get-KaigenFileSha256 -Path $appArtifact)
    $receipt = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
    Assert-Condition ($receipt.applicationRebuilt -eq $true) 'The Windows receipt did not assert a fresh application artifact.'
    Assert-Condition ($receipt.groups.Count -eq 3) 'The Windows receipt does not contain exactly three native groups.'
    Assert-Condition ((@($receipt.groups.group | Sort-Object) -join '|') -ceq 'c-toxcore|libsodium|tor-universal') 'The Windows receipt has the wrong native groups.'
    $verificationReceiptPath = Join-Path $receiptRoot 'prepared-native-cache-windows-x64-expected-hit-verification.json'
    Write-KaigenPreparedNativeReceipt -Path $verificationReceiptPath -Groups $receiptResults.ToArray() -ApplicationRebuilt $false
    $verificationReceipt = Get-Content -LiteralPath $verificationReceiptPath -Raw | ConvertFrom-Json
    Assert-Condition ($verificationReceipt.applicationRebuilt -eq $false -and $null -eq $verificationReceipt.applicationArtifact) 'Resolver-only receipt falsely claims an application rebuild.'

    $portableBuild = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'build-portable.ps1'))
    Assert-Condition (-not $portableBuild.Contains('$reuseToxcoreBuild')) 'The weak UI-acceptance path-exists c-toxcore shortcut still exists.'
    Assert-Condition (-not $portableBuild.Contains('path-verified c-toxcore build cache')) 'The weak UI cache claim still exists.'
    foreach ($group in @('libsodium', 'c-toxcore', 'tor-universal')) {
        Assert-Condition ($portableBuild.Contains("New-KaigenPreparedNativeContract -Group $group")) "Windows build does not resolve the $group native group."
    }
    Assert-Condition ($portableBuild.Contains("libsodium-msvc-x64-release-static-consumer-v3") -and
        $portableBuild.Contains("extract-copy-headers-and-x64-release-v143-static-only") -and
        $portableBuild.Contains("`$expandedRoot = Join-Path `$OutputRoot '_expanded-upstream'") -and
        $portableBuild.Contains("Prepared libsodium output contains files outside the exact headers/static-library contract") -and
        -not $portableBuild.Contains("Expand-Archive -LiteralPath `$sodiumArchive -DestinationPath `$OutputRoot")) 'Windows libsodium cache does not enforce its minimal headers/x64 Release static output contract.'
    $libsodiumProducerMatch = [regex]::Match($portableBuild, '(?s)function Invoke-KaigenWindowsLibsodiumProducer \{(?<body>.*?)\r?\n\}\r?\n\r?\nfunction Install-KaigenWindowsLibsodiumLinkerSymbols')
    Assert-Condition ($libsodiumProducerMatch.Success -and
        -not $libsodiumProducerMatch.Groups['body'].Value.Contains('libsodium.pdb')) 'The immutable libsodium producer/output contract was widened with linker-only PDB staging.'
    $libsodiumSymbolsMatch = [regex]::Match($portableBuild, '(?s)function Install-KaigenWindowsLibsodiumLinkerSymbols \{(?<body>.*?)\r?\n\}\r?\n\r?\nfunction Invoke-KaigenWindowsTorProducer')
    Assert-Condition ($libsodiumSymbolsMatch.Success -and
        $libsodiumSymbolsMatch.Groups['body'].Value.Contains("'libsodium/x64/Release/v143/static/libsodium.pdb'") -and
        $libsodiumSymbolsMatch.Groups['body'].Value.Contains('233472L') -and
        $libsodiumSymbolsMatch.Groups['body'].Value.Contains("'32FC876A6DBF795CC8487D9CC753AFFBEB7829258CF65920B1AA1E53677EAFE2'") -and
        $libsodiumSymbolsMatch.Groups['body'].Value.Contains("Join-Path `$LibraryDirectory 'libsodium.pdb'") -and
        $libsodiumSymbolsMatch.Groups['body'].Value.Contains("Join-Path `$CargoTarget 'debug\deps\libsodium.pdb'") -and
        $libsodiumSymbolsMatch.Groups['body'].Value.Contains("Join-Path `$CargoTarget 'release\deps\libsodium.pdb'") -and
        $libsodiumSymbolsMatch.Groups['body'].Value.Contains('[IO.File]::Move($atomicStage, $destination, $true)')) 'Windows consumer staging does not validate and atomically install the exact pinned libsodium PDB in all linker search locations.'
    $libsodiumResolveIndex = $portableBuild.IndexOf('$libsodiumResult = Resolve-KaigenPreparedNativeGroup', [StringComparison]::Ordinal)
    $libsodiumSymbolsIndex = $portableBuild.IndexOf('Install-KaigenWindowsLibsodiumLinkerSymbols -ArchivePath $sodiumArchive', [StringComparison]::Ordinal)
    $toxDependencyIndex = $portableBuild.IndexOf("`$toxFields['dependency.libsodium.fingerprint']", [StringComparison]::Ordinal)
    Assert-Condition ($libsodiumResolveIndex -ge 0 -and $libsodiumResolveIndex -lt $libsodiumSymbolsIndex -and $libsodiumSymbolsIndex -lt $toxDependencyIndex) 'libsodium linker symbols are not staged after the cache hit and before c-toxcore/Cargo consumption.'
    Assert-Condition (-not $portableBuild.Contains('/IGNORE:4099') -and -not $portableBuild.Contains('/IGNORE')) 'Windows build suppresses linker diagnostics instead of supplying the pinned symbols.'
    Assert-Condition ($portableBuild.Contains("'XLIBS=/Brepro'") -and
        $portableBuild.Contains("'-DCMAKE_SHARED_LINKER_FLAGS=/Brepro'")) 'Windows prepared native DLL producers do not enforce deterministic MSVC linking.'
    Assert-Condition ($portableBuild.Contains('work\prepared-native-producer\windows-x64\c-toxcore') -and
        $portableBuild.Contains('FileShare]::None') -and
        $portableBuild.Contains('stable c-toxcore producer workspace lock') -and
        -not $portableBuild.Contains("'.toxcore-work-' + [guid]::NewGuid()")) 'Windows c-toxcore producer workspace is not stable and concurrency-safe.'
    Assert-Condition ($portableBuild.Contains("[ValidateSet('auto', 'build-on-miss', 'expected-hit')]")) 'Windows build has no explicit expected-hit mode.'
    Assert-Condition ($portableBuild.Contains("{ 'expected-hit' } else { `$env:KAIGEN_PREPARED_NATIVE_CACHE_MODE }")) 'Ordinary Windows builds do not default to fail-fast expected-hit mode.'
    Assert-Condition ($portableBuild.Contains('Accepted-output prepared-native bootstrap is disabled: no producer receipt binds') -and
        -not $portableBuild.Contains('Invoke-KaigenAcceptedWindowsToxcoreProducer')) 'Unproven accepted Windows outputs can still be relabelled as a current prepared-cache entry.'
    Assert-Condition (-not $portableBuild.Contains('tox_version_major() > 0')) 'The removed accepted-output bootstrap left its invalid 0.x version assumption behind.'
    Assert-Condition ($portableBuild.Contains('$PopulatePreparedNativeCacheOnly') -and
        $portableBuild.Contains("-Producer `${function:Invoke-KaigenWindowsToxcoreProducer}") -and
        $portableBuild.Contains('-ForceProducer:$PopulatePreparedNativeCacheOnly') -and
        $portableBuild.Contains("{ 'native-only-populate' } else { 'expected-hit-verification' }")) 'Windows has no explicit fresh native-only cache population route.'
    $normalProducerMatch = [regex]::Match($portableBuild, '(?s)function Invoke-KaigenWindowsToxcoreProducer \{(?<body>.*?)\r?\n\}\r?\n\r?\nfunction New-KaigenWindowsBaseContractFields')
    Assert-Condition ($normalProducerMatch.Success -and
        $normalProducerMatch.Groups['body'].Value.Contains("Assert-KaigenWindowsToxcoreExports -Library (Join-Path `$OutputRoot 'toxcore.dll')") -and
        $normalProducerMatch.Groups['body'].Value.Contains('Assert-KaigenWindowsToxcoreImportRuntime -OutputRoot $OutputRoot')) 'The c-toxcore producer can publish before its export/link/load/runtime gates.'
    Assert-Condition (-not $portableBuild.Contains('tox_version_major() > 0') -and
        $portableBuild.Contains('tox_version_major() == 0 && tox_version_minor() == 2 && tox_version_patch() == 23')) 'The native producer does not runtime-check exact pinned c-toxcore 0.2.23.'
    foreach ($identity in @(
        "'component.toxcore.version'] = '0.2.23'",
        "'component.toxcore.commit'] = '1d79022fb4e56dffe0bbd075d47e00f7a0b62ab3'",
        "'producer.mode'] = 'compiled-miss'"
    )) {
        Assert-Condition ($portableBuild.Contains($identity)) "The current c-toxcore contract is missing identity: $identity"
    }
    Assert-Condition (-not $portableBuild.Contains("Join-Path `$OutputRoot 'pthreadVC3.lib'")) 'The unshipped pthreadVC3.lib is still promoted as a reusable output.'
    $toxOutputContract = [regex]::Match($portableBuild, '(?s)\$toxContract = New-KaigenPreparedNativeContract -Group c-toxcore .*?-RequiredOutputs @\((?<outputs>.*?)\r?\n\)')
    Assert-Condition ($toxOutputContract.Success -and
        $toxOutputContract.Groups['outputs'].Value.Contains("'toxcore.dll', 'toxcore.lib', 'pthreadVC3.dll'") -and
        -not $toxOutputContract.Groups['outputs'].Value.Contains('pthreadVC3.lib')) 'The Windows c-toxcore cache contract does not expose the exact runtime/import-library output set.'
    Assert-Condition ($portableBuild.Contains('$VerifyPreparedNativeCacheOnly') -and
        $portableBuild.Contains('$PopulatePreparedNativeCacheOnly -or $VerifyPreparedNativeCacheOnly') -and
        $portableBuild.Contains('completed without rebuilding the Kaigen application')) 'Windows has no native-only populate/expected-hit receipt route before the application build.'
    Assert-Condition ($portableBuild.Contains('& (Join-Path $PSScriptRoot "test-prepared-native-cache-windows.ps1")')) 'The full Windows candidate route does not run the prepared-cache regression.'
    $tauriBuildNeedle = '& npm.cmd run tauri -- build --no-bundle'
    Assert-Condition (($portableBuild.Split($tauriBuildNeedle).Count - 1) -eq 1) 'The final Kaigen application build must appear exactly once.'
    Assert-Condition ($portableBuild.IndexOf('Resolve-KaigenPreparedNativeGroup', [StringComparison]::Ordinal) -lt $portableBuild.IndexOf($tauriBuildNeedle, [StringComparison]::Ordinal)) 'Kaigen is not rebuilt after native cache resolution.'
    Assert-Condition ($portableBuild.LastIndexOf('Write-KaigenPreparedNativeReceipt', [StringComparison]::Ordinal) -gt $portableBuild.IndexOf($tauriBuildNeedle, [StringComparison]::Ordinal)) 'The ordinary-build cache receipt is written before the fresh Kaigen artifact exists.'

    $dependencyPreparation = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'prepare-dependencies.ps1'))
    Assert-Condition ($dependencyPreparation.Contains('[switch]$PreparedNativeInputsOnly')) 'Windows dependency preparation has no inputs-only cache admission.'

    Write-Host 'PASS Windows prepared-native cache: built -> hit, compiler sentinel, corruption, missing, revocation, receipt, fresh-app ordering'
} finally {
    $temporaryRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    $resolvedTestRoot = [IO.Path]::GetFullPath($testRoot)
    if (-not $resolvedTestRoot.StartsWith($temporaryRoot, [StringComparison]::OrdinalIgnoreCase) -or
        [IO.Path]::GetFileName($resolvedTestRoot) -notmatch '^kaigen-prepared-native-windows-[a-f0-9]{32}$') {
        throw "Refusing to clean unsafe Windows prepared-cache fixture: $resolvedTestRoot"
    }
    Remove-KaigenTemporaryTree -Root $resolvedTestRoot
}
