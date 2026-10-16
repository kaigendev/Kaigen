#requires -Version 7.6.5
[CmdletBinding()]
param(
    [string]$WebView2CabPath,
    [string]$ComponentCacheRoot = $env:KAIGEN_COMPONENT_CACHE_ROOT,
    [switch]$AllowNetworkComponentFetch,
    [switch]$PreparedNativeInputsOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$utf8NoBom = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $utf8NoBom
$OutputEncoding = $utf8NoBom
if ($PSVersionTable.PSVersion.ToString() -cne "7.6.5") {
    throw "Kaigen automation requires PowerShell 7.6.5 exactly; found $($PSVersionTable.PSVersion)."
}
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
if ($AllowNetworkComponentFetch -and $env:KAIGEN_COMPONENT_UPDATE_SCOPE -cne "all-managed-components") {
    throw "Network component retrieval requires KAIGEN_COMPONENT_UPDATE_SCOPE=all-managed-components from the explicit full Kaigen component-update route."
}

$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
& node (Join-Path $ProjectRoot "scripts\verify-source-hygiene.mjs")
if ($LASTEXITCODE -ne 0) {
    throw "Kaigen source hygiene validation failed before Windows dependency preparation."
}
$WorkDir = Join-Path $ProjectRoot "work"
$DownloadDir = Join-Path $WorkDir "downloads"
$DependencyDir = Join-Path $WorkDir "deps"
$ToxcoreDir = Join-Path $WorkDir "toxcore-meta"
$SodiumDir = Join-Path $DependencyDir "libsodium"
$RuntimeDir = Join-Path $DependencyDir "WebView2Runtime"
$TorBundleDir = Join-Path $DependencyDir "TorExpertBundle"
$TorBundleMarker = Join-Path $DependencyDir "TorExpertBundle.version"
$PthreadsDir = Join-Path $DependencyDir "pthreads4w-dynamic"
$QtoxRuntimeDir = Join-Path $ProjectRoot "runtime\qtox-import"
$DictionaryDir = Join-Path $ProjectRoot "runtime\dictionaries"
$ResolvedComponentCacheRoot = $null
if (-not [string]::IsNullOrWhiteSpace($ComponentCacheRoot)) {
    $ResolvedComponentCacheRoot = [IO.Path]::GetFullPath($ComponentCacheRoot).TrimEnd('\')
    if (-not (Test-Path -LiteralPath $ResolvedComponentCacheRoot -PathType Container)) {
        if ($AllowNetworkComponentFetch) {
            [IO.Directory]::CreateDirectory($ResolvedComponentCacheRoot) | Out-Null
        } else {
            throw "Canonical local component cache was not found: $ResolvedComponentCacheRoot"
        }
    }
}

$ToxcoreRepository = "https://github.com/kaigendev/kaigen-toxcore.git"
$ToxcoreCommit = "ec7bd2cce618ed6542fbc55b84574704eb380ef2"
$ToxcoreArchiveUrl = "https://codeload.github.com/kaigendev/kaigen-toxcore/zip/$ToxcoreCommit"
$ToxcoreArchiveSha256 = "8AEBF2E3EF3A4C1B3B4AFB367E717307EEA170E510A0DC53BF0536F57DDA003E"
$ToxcoreArchiveSize = 1405890
$ToxcoreArchive = Join-Path $DownloadDir "kaigen-toxcore-$ToxcoreCommit.zip"
$PthreadsCommit = "44daa2441137b90477b449663abe9755b2c9a16b"
$PthreadsArchiveUrl = "https://codeload.github.com/fwbuilder/pthreads4w/zip/$PthreadsCommit"
$PthreadsArchiveSha256 = "159919A823800CB594E598D504B6C01397C0CB88DF3E3791BF529BD68FFDC67E"
$PthreadsArchiveSize = 859257
$PthreadsArchive = Join-Path $DownloadDir "pthreads4w-$PthreadsCommit.zip"
$SodiumUrl = "https://download.libsodium.org/libsodium/releases/libsodium-1.0.22-stable-msvc.zip"
$SodiumSha256 = "2AEAC7E7F00BC0D980096EA8B908E66DFAD5C858D08F1CA3B980D413833303D9"
$SodiumArchiveSize = 26200815
$SodiumArchive = Join-Path $DownloadDir "libsodium-1.0.22-stable-20261016-msvc.zip"
$SodiumLibrarySha256 = "85F60A8AE08C003141F2E5E39334056693DAFAE27F18A0A26A315A3E898942D4"
$WebView2Version = "155.0.4283.45"
$WebView2Url = "https://msedge.sf.dl.delivery.mp.microsoft.com/filestreamingservice/files/01b0fbd9-6ea3-4e12-818a-a71f73f3855b/Microsoft.WebView2.FixedVersionRuntime.155.0.4283.45.x64.cab"
$WebView2Sha256 = "EC533BF1B7354D288703CF821A2D640D0130108224F93E330BB9C09FAF3F8010"
$WebView2ArchiveSize = 310544938
$DefaultWebView2Archive = Join-Path $DownloadDir "Microsoft.WebView2.FixedVersionRuntime.155.0.4283.45.x64.cab"
$TorBundleVersion = "15.0.25"
$TorBundleUrl = "https://archive.torproject.org/tor-package-archive/torbrowser/15.0.25/tor-expert-bundle-windows-x86_64-15.0.25.tar.gz"
$TorBundleSha256 = "C1988C701DE2F24F7D098D1D6D7F507B58F27740D097F29C246E0524D639B252"
$TorBundleArchiveSize = 22507599
$TorBundleArchive = Join-Path $DownloadDir "tor-expert-bundle-windows-x86_64-15.0.25.tar.gz"
$LyrebirdArchive = Join-Path $DownloadDir "lyrebird-0.9.0-kaigen-snowflake2.15.1-pion4.2.23-dtls3.1.12-windows-amd64-go1.27.2.zip"
$LyrebirdArchiveSha256 = "EEB4301DDDC79812164752866EC7430429B6187C4F26FE9544D8D3077B2603BC"
$LyrebirdArchiveSize = 14087984
$LyrebirdBinarySha256 = "C5B27929137024B816E1207A96282A5977F1AC9C2965EDDAAE385CBCE75ECBBE"
$ConjureArchive = Join-Path $DownloadDir "conjure-0090962226b82aa4a8fc38506f9b98de67d0781e-kaigen-utls1.8.2-snowflake2.15.1-windows-amd64-go1.27.2.zip"
$ConjureArchiveSha256 = "D40E862380CFBA4C147EBE26B14E119155A4D1053BD39208C1FD595DBD265CE3"
$ConjureArchiveSize = 11457565
$ConjureBinarySha256 = "E93AB23FC3CDA78DE31DEF0FCC0C47DE32F0B3831EADD7B8AFDF32D09B2C2CF9"
$GeoIpArchive = Join-Path $DownloadDir "geoip-ipfire-20261015.tar.gz"
$GeoIpArchiveSha256 = "2681A63F6C09748DF9FB1F98CEDD616698421CA50C4ABF10D16A81A1507C203B"
$GeoIpArchiveSize = 4689119
$GeoIpSha256 = "9EEFC7CBF75278DEAF70B877E41761170CFEE8FA81754BCF23EF9159262FD30F"
$GeoIp6Sha256 = "6C936FC6A1D655D92CA5B01DA9F3E8D7246CB569E35BFCDC3C8645D495E5C2F4"

foreach ($directory in @($WorkDir, $DownloadDir, $DependencyDir)) {
    [IO.Directory]::CreateDirectory($directory) | Out-Null
}

function Assert-FileHash {
    param([string]$Path, [string]$Expected)
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash
    if ($actual -ne $Expected) {
        throw "SHA-256 mismatch for $Path. Expected $Expected, got $actual."
    }
}

function Assert-FileIdentity {
    param([string]$Path, [Int64]$ExpectedSize, [string]$ExpectedSha256)
    $item = Get-Item -LiteralPath $Path -ErrorAction Stop
    if ($item.Length -ne $ExpectedSize) {
        throw "Size mismatch for $Path. Expected $ExpectedSize, got $($item.Length)."
    }
    Assert-FileHash -Path $Path -Expected $ExpectedSha256
}

function Download-VerifiedFile {
    param([string]$Uri, [string]$Destination, [string]$Sha256, [Int64]$ExpectedSize)
    if (Test-Path -LiteralPath $Destination) {
        try {
            Assert-FileIdentity -Path $Destination -ExpectedSize $ExpectedSize -ExpectedSha256 $Sha256
            return
        } catch {
            if (-not $AllowNetworkComponentFetch) {
                throw "Local component copy is invalid and network fallback is disabled: $Destination. $($_.Exception.Message)"
            }
            [IO.File]::Delete([IO.Path]::GetFullPath($Destination))
        }
    }

    $cachePath = $null
    if ($null -ne $ResolvedComponentCacheRoot) {
        $cachePath = Join-Path $ResolvedComponentCacheRoot ([IO.Path]::GetFileName($Destination))
        if (Test-Path -LiteralPath $cachePath -PathType Leaf) {
            Assert-FileIdentity -Path $cachePath -ExpectedSize $ExpectedSize -ExpectedSha256 $Sha256
            Copy-Item -LiteralPath $cachePath -Destination $Destination
            Assert-FileIdentity -Path $Destination -ExpectedSize $ExpectedSize -ExpectedSha256 $Sha256
            Write-Host "Using canonical local component: $cachePath"
            return
        }
    }

    if (-not $AllowNetworkComponentFetch) {
        $expectedCache = if ($null -eq $cachePath) { "an explicitly supplied canonical cache" } else { $cachePath }
        throw "Managed component is missing locally: $([IO.Path]::GetFileName($Destination)). Expected $expectedCache. Network fallback is disabled outside the explicit Kaigen component-update route."
    }

    Write-Host "Downloading $Uri"
    $downloaded = $false
    $curlError = $null
    $curlPath = $null
    $systemCurlPath = Join-Path ([Environment]::SystemDirectory) "curl.exe"
    if (Test-Path -LiteralPath $systemCurlPath -PathType Leaf) {
        $curlPath = [IO.Path]::GetFullPath($systemCurlPath)
    } else {
        $curlCommand = Get-Command -Name "curl.exe" -CommandType Application -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if ($null -ne $curlCommand) {
            $curlPath = [string]$curlCommand.Source
        }
    }
    if ($null -ne $curlPath) {
        & $curlPath --fail --location --retry 5 --retry-delay 2 --retry-connrefused `
            --connect-timeout 30 --speed-limit 1024 --speed-time 60 --max-time 1800 `
            --output $Destination $Uri
        if ($LASTEXITCODE -eq 0) {
            $downloaded = $true
        } else {
            $curlError = "curl.exe exit code $LASTEXITCODE"
            if (Test-Path -LiteralPath $Destination) {
                [IO.File]::Delete([IO.Path]::GetFullPath($Destination))
            }
        }
    }

    if (-not $downloaded) {
        if ($null -ne $curlError) {
            Write-Warning "$curlError; retrying through PowerShell 7.6.5."
        }
        if (Test-Path -LiteralPath $Destination) {
            [IO.File]::Delete([IO.Path]::GetFullPath($Destination))
        }
        $previousSecurityProtocol = [Net.ServicePointManager]::SecurityProtocol
        try {
            [Net.ServicePointManager]::SecurityProtocol =
                $previousSecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
            Invoke-WebRequest -Uri $Uri -OutFile $Destination -UseBasicParsing -TimeoutSec 300
            $downloaded = $true
        } catch {
            if (Test-Path -LiteralPath $Destination) {
                [IO.File]::Delete([IO.Path]::GetFullPath($Destination))
            }
            throw "Both download transports failed for $Uri. curl: $curlError; Invoke-WebRequest: $($_.Exception.Message)"
        } finally {
            [Net.ServicePointManager]::SecurityProtocol = $previousSecurityProtocol
        }
    }
    Assert-FileIdentity -Path $Destination -ExpectedSize $ExpectedSize -ExpectedSha256 $Sha256
    if ($null -ne $cachePath) {
        Copy-Item -LiteralPath $Destination -Destination $cachePath
        Assert-FileIdentity -Path $cachePath -ExpectedSize $ExpectedSize -ExpectedSha256 $Sha256
        Write-Host "Updated canonical local component cache: $cachePath"
    }
}

function Copy-VerifiedCompiledInput {
    param([string]$Destination, [string]$Sha256, [Int64]$ExpectedSize)
    if (Test-Path -LiteralPath $Destination -PathType Leaf) {
        Assert-FileIdentity -Path $Destination -ExpectedSize $ExpectedSize -ExpectedSha256 $Sha256
        return
    }
    if ($null -eq $ResolvedComponentCacheRoot) {
        throw "Compiled managed input requires an explicitly supplied canonical local component cache."
    }
    $cachePath = Join-Path $ResolvedComponentCacheRoot ([IO.Path]::GetFileName($Destination))
    if (-not (Test-Path -LiteralPath $cachePath)) {
        $vendorInput = Join-Path $ProjectRoot ("runtime-manifests/vendor-inputs/" + [IO.Path]::GetFileName($Destination))
        if (Test-Path -LiteralPath $vendorInput -PathType Leaf) {
            Assert-FileIdentity -Path $vendorInput -ExpectedSize $ExpectedSize -ExpectedSha256 $Sha256
            [IO.File]::Copy($vendorInput, $cachePath, $false)
        }
    }
    if (-not (Test-Path -LiteralPath $cachePath -PathType Leaf)) {
        throw "Compiled managed input is missing from the canonical cache: $cachePath. Rebuild it through the authorized component-update route; network fallback is unavailable."
    }
    Assert-FileIdentity -Path $cachePath -ExpectedSize $ExpectedSize -ExpectedSha256 $Sha256
    Copy-Item -LiteralPath $cachePath -Destination $Destination
    Assert-FileIdentity -Path $Destination -ExpectedSize $ExpectedSize -ExpectedSha256 $Sha256
}

Copy-VerifiedCompiledInput -Destination $LyrebirdArchive -Sha256 $LyrebirdArchiveSha256 -ExpectedSize $LyrebirdArchiveSize
Copy-VerifiedCompiledInput -Destination $ConjureArchive -Sha256 $ConjureArchiveSha256 -ExpectedSize $ConjureArchiveSize
Copy-VerifiedCompiledInput -Destination $GeoIpArchive -Sha256 $GeoIpArchiveSha256 -ExpectedSize $GeoIpArchiveSize

if ($PreparedNativeInputsOnly) {
    Download-VerifiedFile -Uri $ToxcoreArchiveUrl -Destination $ToxcoreArchive -Sha256 $ToxcoreArchiveSha256 -ExpectedSize $ToxcoreArchiveSize
    Download-VerifiedFile -Uri $PthreadsArchiveUrl -Destination $PthreadsArchive -Sha256 $PthreadsArchiveSha256 -ExpectedSize $PthreadsArchiveSize
    Download-VerifiedFile -Uri $SodiumUrl -Destination $SodiumArchive -Sha256 $SodiumSha256 -ExpectedSize $SodiumArchiveSize
    Download-VerifiedFile -Uri $TorBundleUrl -Destination $TorBundleArchive -Sha256 $TorBundleSha256 -ExpectedSize $TorBundleArchiveSize
    Write-Host 'Verified exact Windows prepared-native component inputs; no native output was materialized.'
    return
}

Download-VerifiedFile -Uri $ToxcoreArchiveUrl -Destination $ToxcoreArchive -Sha256 $ToxcoreArchiveSha256 -ExpectedSize $ToxcoreArchiveSize
# The verified source archive is extracted afresh so an older upstream tree cannot be reused.
$workRoot = [IO.Path]::GetFullPath($WorkDir).TrimEnd('\') + '\'
$sourceRoot = [IO.Path]::GetFullPath($ToxcoreDir)
if (-not $sourceRoot.StartsWith($workRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Kaigen toxcore source escaped project work."
}
if (Test-Path -LiteralPath $sourceRoot) {
    Remove-Item -LiteralPath $sourceRoot -Recurse -Force
}
$toxExtract = Join-Path $WorkDir ("kaigen-toxcore-extract-" + [guid]::NewGuid().ToString('N'))
Expand-Archive -LiteralPath $ToxcoreArchive -DestinationPath $toxExtract
$extracted = Join-Path $toxExtract "kaigen-toxcore-$ToxcoreCommit"
if (-not (Test-Path -LiteralPath (Join-Path $extracted "CMakeLists.txt") -PathType Leaf) -or
    -not (Test-Path -LiteralPath (Join-Path $extracted "third_party\cmp\cmp.c") -PathType Leaf)) {
    throw "The pinned Kaigen toxcore archive has an unexpected layout."
}
Move-Item -LiteralPath $extracted -Destination $ToxcoreDir
[IO.Directory]::Delete([IO.Path]::GetFullPath($toxExtract), $true)
$actualToxcoreCommit = $ToxcoreCommit

if (-not (Test-Path -LiteralPath (Join-Path $PthreadsDir "pthread.h"))) {
    Download-VerifiedFile -Uri $PthreadsArchiveUrl -Destination $PthreadsArchive -Sha256 $PthreadsArchiveSha256 -ExpectedSize $PthreadsArchiveSize
    if (Test-Path -LiteralPath $PthreadsDir) {
        [IO.Directory]::Delete([IO.Path]::GetFullPath($PthreadsDir), $true)
    }
    $pthreadsExtract = Join-Path $WorkDir "pthreads4w-extract"
    if (Test-Path -LiteralPath $pthreadsExtract) {
        [IO.Directory]::Delete([IO.Path]::GetFullPath($pthreadsExtract), $true)
    }
    Expand-Archive -LiteralPath $PthreadsArchive -DestinationPath $pthreadsExtract
    $extractedPthreads = Get-ChildItem -LiteralPath $pthreadsExtract -Directory | Select-Object -First 1
    if (-not $extractedPthreads -or -not (Test-Path -LiteralPath (Join-Path $extractedPthreads.FullName "pthread.h"))) {
        throw "The pinned pthreads4w archive has an unexpected layout."
    }
    Move-Item -LiteralPath $extractedPthreads.FullName -Destination $PthreadsDir
    [IO.Directory]::Delete([IO.Path]::GetFullPath($pthreadsExtract), $true)
}

$sodiumLibrary = Join-Path $SodiumDir "libsodium\x64\Release\v143\static\libsodium.lib"
if (-not (Test-Path -LiteralPath $sodiumLibrary) -or
    (Get-FileHash -Algorithm SHA256 -LiteralPath $sodiumLibrary).Hash -ne $SodiumLibrarySha256) {
    Download-VerifiedFile -Uri $SodiumUrl -Destination $SodiumArchive -Sha256 $SodiumSha256 -ExpectedSize $SodiumArchiveSize
    if (Test-Path -LiteralPath $SodiumDir) {
        [IO.Directory]::Delete([IO.Path]::GetFullPath($SodiumDir), $true)
    }
    Expand-Archive -LiteralPath $SodiumArchive -DestinationPath $SodiumDir
}
Assert-FileHash -Path $sodiumLibrary -Expected $SodiumLibrarySha256

$useCustomWebView2 = -not [string]::IsNullOrWhiteSpace($WebView2CabPath)
$runtimeExecutable = Get-ChildItem -LiteralPath $RuntimeDir -Filter "msedgewebview2.exe" -File -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
if ($runtimeExecutable -and ($useCustomWebView2 -or $runtimeExecutable.VersionInfo.ProductVersion -ne $WebView2Version)) {
    $runtimeExecutable = $null
}
if (-not $runtimeExecutable) {
    if ($useCustomWebView2) {
        $WebView2Archive = (Resolve-Path -LiteralPath $WebView2CabPath).Path
        Assert-FileIdentity -Path $WebView2Archive -ExpectedSize $WebView2ArchiveSize -ExpectedSha256 $WebView2Sha256
    } else {
        $WebView2Archive = $DefaultWebView2Archive
        Download-VerifiedFile -Uri $WebView2Url -Destination $WebView2Archive -Sha256 $WebView2Sha256 -ExpectedSize $WebView2ArchiveSize
    }
    if (Test-Path -LiteralPath $RuntimeDir) {
        [IO.Directory]::Delete([IO.Path]::GetFullPath($RuntimeDir), $true)
    }
    [IO.Directory]::CreateDirectory($RuntimeDir) | Out-Null
    & "$env:SystemRoot\System32\expand.exe" $WebView2Archive "-F:*" $RuntimeDir
    if ($LASTEXITCODE -ne 0) { throw "WebView2 CAB extraction failed with exit code $LASTEXITCODE" }
    $runtimeExecutable = Get-ChildItem -LiteralPath $RuntimeDir -Filter "msedgewebview2.exe" -File -Recurse | Select-Object -First 1
}
if (-not $runtimeExecutable) { throw "msedgewebview2.exe was not found below $RuntimeDir" }
$signature = Get-AuthenticodeSignature -LiteralPath $runtimeExecutable.FullName
if ($signature.Status -ne "Valid") {
    throw "Microsoft WebView2 signature is not valid: $($signature.Status)"
}
if (-not $useCustomWebView2 -and $runtimeExecutable.VersionInfo.ProductVersion -ne $WebView2Version) {
    throw "Microsoft WebView2 version mismatch. Expected $WebView2Version, got $($runtimeExecutable.VersionInfo.ProductVersion)."
}

$torExecutable = Join-Path $TorBundleDir "tor\tor.exe"
$lyrebirdExecutable = Join-Path $TorBundleDir "tor\pluggable_transports\lyrebird.exe"
$conjureExecutable = Join-Path $TorBundleDir "tor\pluggable_transports\conjure-client.exe"
$geoIpFile = Join-Path $TorBundleDir "data\geoip"
$geoIp6File = Join-Path $TorBundleDir "data\geoip6"
$torBundleCurrent = (Test-Path -LiteralPath $torExecutable) -and
    (Test-Path -LiteralPath $lyrebirdExecutable) -and
    (Test-Path -LiteralPath $conjureExecutable) -and
    ((Get-FileHash -Algorithm SHA256 -LiteralPath $conjureExecutable).Hash -eq $ConjureBinarySha256) -and
    (Test-Path -LiteralPath $TorBundleMarker) -and
    (([IO.File]::ReadAllText($TorBundleMarker)).Trim() -eq $TorBundleVersion) -and
    ((Get-FileHash -Algorithm SHA256 -LiteralPath $lyrebirdExecutable).Hash -eq $LyrebirdBinarySha256) -and
    (Test-Path -LiteralPath $geoIpFile) -and (Test-Path -LiteralPath $geoIp6File) -and
    ((Get-FileHash -Algorithm SHA256 -LiteralPath $geoIpFile).Hash -eq $GeoIpSha256) -and
    ((Get-FileHash -Algorithm SHA256 -LiteralPath $geoIp6File).Hash -eq $GeoIp6Sha256)
if (-not $torBundleCurrent) {
    Download-VerifiedFile -Uri $TorBundleUrl -Destination $TorBundleArchive -Sha256 $TorBundleSha256 -ExpectedSize $TorBundleArchiveSize
    if (Test-Path -LiteralPath $TorBundleDir) {
        [IO.Directory]::Delete([IO.Path]::GetFullPath($TorBundleDir), $true)
    }
    [IO.Directory]::CreateDirectory($TorBundleDir) | Out-Null
    & "$env:SystemRoot\System32\tar.exe" -xzf $TorBundleArchive -C $TorBundleDir
    if ($LASTEXITCODE -ne 0) { throw "Tor Expert Bundle extraction failed with exit code $LASTEXITCODE" }
    Expand-Archive -LiteralPath $LyrebirdArchive -DestinationPath (Join-Path $TorBundleDir "tor\pluggable_transports") -Force
    Assert-FileHash -Path $lyrebirdExecutable -Expected $LyrebirdBinarySha256
    Expand-Archive -LiteralPath $ConjureArchive -DestinationPath (Join-Path $TorBundleDir "tor\pluggable_transports") -Force
    Assert-FileHash -Path $conjureExecutable -Expected $ConjureBinarySha256
    & "$env:SystemRoot\System32\tar.exe" -xzf $GeoIpArchive -C (Join-Path $TorBundleDir "data") geoip geoip6
    if ($LASTEXITCODE -ne 0) { throw "GeoIP extraction failed with exit code $LASTEXITCODE" }
    Assert-FileHash -Path $geoIpFile -Expected $GeoIpSha256
    Assert-FileHash -Path $geoIp6File -Expected $GeoIp6Sha256
    & "$env:SystemRoot\System32\tar.exe" -xzf $GeoIpArchive -C (Join-Path $TorBundleDir "docs") LICENSE-CC-BY-SA-4.0.txt
    if ($LASTEXITCODE -ne 0) { throw "GeoIP license extraction failed with exit code $LASTEXITCODE" }
    [IO.File]::WriteAllText($TorBundleMarker, "$TorBundleVersion`n", [Text.UTF8Encoding]::new($false))
}
if (-not (Test-Path -LiteralPath $torExecutable)) { throw "tor.exe was not found below $TorBundleDir" }
if (-not (Test-Path -LiteralPath $lyrebirdExecutable)) { throw "lyrebird.exe was not found below $TorBundleDir" }

$bundledRuntimeHashes = @{
    (Join-Path $QtoxRuntimeDir "libsqlcipher-0.dll") = "91D26CAB5D2B43D39CB5BD53A865B7FBD7EC4D051A57239B06703C2C433A5D51"
    (Join-Path $DictionaryDir "ru-RU.aff") = "38CE7D4AF78E211E9BAFE4BF7E3D6A2C420591136CB738EC6648F8FDF6524CD7"
    (Join-Path $DictionaryDir "ru-RU.dic") = "F6047416A0204ADBECF3A451B874EC8A97EE37E2CBC714466EF04D8DBCC0D6FC"
    (Join-Path $DictionaryDir "en-US.aff") = "8AE1F19D4840D957728AD90555D5A8DFF6CC5C046279C95FF0C00FC0A0136C7B"
    (Join-Path $DictionaryDir "en-US.dic") = "F0B1A234BD178BDD01875B2A392A9647F888B8FE879F79C52AAE62C2759B3647"
}
$obsoleteQtoxRuntimeFiles = @(
    "libcrypto-3-x64.dll",
    "libssl-3-x64.dll",
    "libgcc_s_seh-1.dll",
    "libstdc++-6.dll",
    "libwinpthread-1.dll"
)
foreach ($name in $obsoleteQtoxRuntimeFiles) {
    $path = Join-Path $QtoxRuntimeDir $name
    if (Test-Path -LiteralPath $path) {
        throw "Obsolete qTox import dependency must not be distributed: $path"
    }
}
foreach ($entry in $bundledRuntimeHashes.GetEnumerator()) {
    if (-not (Test-Path -LiteralPath $entry.Key)) { throw "Bundled portable runtime file is missing: $($entry.Key)" }
    Assert-FileHash -Path $entry.Key -Expected $entry.Value
}

Write-Host "Dependencies are ready."
Write-Host "c-toxcore: $actualToxcoreCommit"
Write-Host "pthreads4w: $PthreadsDir"
Write-Host "libsodium: $sodiumLibrary"
Write-Host "WebView2: $($runtimeExecutable.FullName)"
Write-Host "Tor Expert Bundle: $torExecutable"
Write-Host "qTox import runtime: $QtoxRuntimeDir"
Write-Host "Hunspell dictionaries: $DictionaryDir"
