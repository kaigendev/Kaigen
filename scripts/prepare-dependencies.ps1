[CmdletBinding()]
param(
    [string]$WebView2CabPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$WorkDir = Join-Path $ProjectRoot "work"
$DownloadDir = Join-Path $WorkDir "downloads"
$DependencyDir = Join-Path $WorkDir "deps"
$ToxcoreDir = Join-Path $WorkDir "toxcore-meta"
$SodiumDir = Join-Path $DependencyDir "libsodium"
$RuntimeDir = Join-Path $DependencyDir "WebView2Runtime"
$TorBundleDir = Join-Path $DependencyDir "TorExpertBundle"
$PthreadsDir = Join-Path $DependencyDir "pthreads4w-dynamic"
$QtoxRuntimeDir = Join-Path $ProjectRoot "runtime\qtox-import"
$DictionaryDir = Join-Path $ProjectRoot "runtime\dictionaries"

$ToxcoreRepository = "https://github.com/TokTok/c-toxcore.git"
$ToxcoreCommit = "1d79022fb4e56dffe0bbd075d47e00f7a0b62ab3"
$ToxcoreArchiveUrl = "https://codeload.github.com/TokTok/c-toxcore/zip/$ToxcoreCommit"
$ToxcoreArchiveSha256 = "8764EC0E15448F2F76E1E0DCAC15BBDAC959D8519BD3E274D1126C302FB56506"
$ToxcoreArchive = Join-Path $DownloadDir "c-toxcore-$ToxcoreCommit.zip"
$CmpCommit = "52bfcfa17d2eb4322da2037ad625f5575129cece"
$CmpArchiveUrl = "https://codeload.github.com/TokTok/cmp/zip/$CmpCommit"
$CmpArchiveSha256 = "281BB25882E4186187DF555775DD3CD57943ECFAFC70B5D5076BEC9DEE02672D"
$CmpArchive = Join-Path $DownloadDir "cmp-$CmpCommit.zip"
$PthreadsCommit = "44daa2441137b90477b449663abe9755b2c9a16b"
$PthreadsArchiveUrl = "https://codeload.github.com/fwbuilder/pthreads4w/zip/$PthreadsCommit"
$PthreadsArchiveSha256 = "159919A823800CB594E598D504B6C01397C0CB88DF3E3791BF529BD68FFDC67E"
$PthreadsArchive = Join-Path $DownloadDir "pthreads4w-$PthreadsCommit.zip"
$SodiumUrl = "https://download.libsodium.org/libsodium/releases/libsodium-1.0.22-msvc.zip"
$SodiumSha256 = "3E03A726FAC4BC09CB61D8F29D658EF7A5ECA0811DE59082130414F7CA2E4279"
$SodiumArchive = Join-Path $DownloadDir "libsodium-1.0.22-msvc.zip"
$WebView2Url = "https://msedge.sf.dl.delivery.mp.microsoft.com/filestreamingservice/files/3cb717d2-b86d-4160-a13e-f3860141dc7f/Microsoft.WebView2.FixedVersionRuntime.151.0.4129.59.x64.cab"
$WebView2Sha256 = "056858A027A7BF29893B6013C0EB0C6EA7E29755A20C9D043BE469D9D78657DC"
$DefaultWebView2Archive = Join-Path $DownloadDir "Microsoft.WebView2.FixedVersionRuntime.151.0.4129.59.x64.cab"
$TorBundleUrl = "https://archive.torproject.org/tor-package-archive/torbrowser/15.0.19/tor-expert-bundle-windows-x86_64-15.0.19.tar.gz"
$TorBundleSha256 = "6AC067402C7B4A3DC37887ED3754B3914B67FDC220C966190683E9CCF91ABF0F"
$TorBundleArchive = Join-Path $DownloadDir "tor-expert-bundle-windows-x86_64-15.0.19.tar.gz"

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

function Download-VerifiedFile {
    param([string]$Uri, [string]$Destination, [string]$Sha256)
    if (Test-Path -LiteralPath $Destination) {
        try {
            Assert-FileHash -Path $Destination -Expected $Sha256
            return
        } catch {
            [IO.File]::Delete([IO.Path]::GetFullPath($Destination))
        }
    }
    Write-Host "Downloading $Uri"
    Invoke-WebRequest -Uri $Uri -OutFile $Destination -UseBasicParsing
    Assert-FileHash -Path $Destination -Expected $Sha256
}

Download-VerifiedFile -Uri $ToxcoreArchiveUrl -Destination $ToxcoreArchive -Sha256 $ToxcoreArchiveSha256
if (-not (Test-Path -LiteralPath (Join-Path $ToxcoreDir "CMakeLists.txt"))) {
    if (Test-Path -LiteralPath $ToxcoreDir) {
        [IO.Directory]::Delete([IO.Path]::GetFullPath($ToxcoreDir), $true)
    }
    $toxExtract = Join-Path $WorkDir "toxcore-extract"
    if (Test-Path -LiteralPath $toxExtract) {
        [IO.Directory]::Delete([IO.Path]::GetFullPath($toxExtract), $true)
    }
    Expand-Archive -LiteralPath $ToxcoreArchive -DestinationPath $toxExtract
    $extracted = Get-ChildItem -LiteralPath $toxExtract -Directory | Select-Object -First 1
    if (-not $extracted -or -not (Test-Path -LiteralPath (Join-Path $extracted.FullName "CMakeLists.txt"))) {
        throw "The pinned c-toxcore archive has an unexpected layout."
    }
    Move-Item -LiteralPath $extracted.FullName -Destination $ToxcoreDir
    [IO.Directory]::Delete([IO.Path]::GetFullPath($toxExtract), $true)
}
$actualToxcoreCommit = $ToxcoreCommit
if (-not (Test-Path -LiteralPath (Join-Path $ToxcoreDir "third_party\cmp\cmp.c"))) {
    Download-VerifiedFile -Uri $CmpArchiveUrl -Destination $CmpArchive -Sha256 $CmpArchiveSha256
    $cmpDirectory = Join-Path $ToxcoreDir "third_party\cmp"
    if (Test-Path -LiteralPath $cmpDirectory) {
        [IO.Directory]::Delete([IO.Path]::GetFullPath($cmpDirectory), $true)
    }
    $cmpExtract = Join-Path $WorkDir "cmp-extract"
    if (Test-Path -LiteralPath $cmpExtract) {
        [IO.Directory]::Delete([IO.Path]::GetFullPath($cmpExtract), $true)
    }
    Expand-Archive -LiteralPath $CmpArchive -DestinationPath $cmpExtract
    $extractedCmp = Get-ChildItem -LiteralPath $cmpExtract -Directory | Select-Object -First 1
    if (-not $extractedCmp -or -not (Test-Path -LiteralPath (Join-Path $extractedCmp.FullName "cmp.c"))) {
        throw "The pinned cmp submodule archive has an unexpected layout."
    }
    Move-Item -LiteralPath $extractedCmp.FullName -Destination $cmpDirectory
    [IO.Directory]::Delete([IO.Path]::GetFullPath($cmpExtract), $true)
}

if (-not (Test-Path -LiteralPath (Join-Path $PthreadsDir "pthread.h"))) {
    Download-VerifiedFile -Uri $PthreadsArchiveUrl -Destination $PthreadsArchive -Sha256 $PthreadsArchiveSha256
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
if (-not (Test-Path -LiteralPath $sodiumLibrary)) {
    Download-VerifiedFile -Uri $SodiumUrl -Destination $SodiumArchive -Sha256 $SodiumSha256
    if (Test-Path -LiteralPath $SodiumDir) {
        [IO.Directory]::Delete([IO.Path]::GetFullPath($SodiumDir), $true)
    }
    Expand-Archive -LiteralPath $SodiumArchive -DestinationPath $SodiumDir
}

$runtimeExecutable = Get-ChildItem -LiteralPath $RuntimeDir -Filter "msedgewebview2.exe" -File -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $runtimeExecutable) {
    $useCustomWebView2 = -not [string]::IsNullOrWhiteSpace($WebView2CabPath)
    if ($useCustomWebView2) {
        $WebView2Archive = (Resolve-Path -LiteralPath $WebView2CabPath).Path
    } else {
        $WebView2Archive = $DefaultWebView2Archive
        Download-VerifiedFile -Uri $WebView2Url -Destination $WebView2Archive -Sha256 $WebView2Sha256
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

$torExecutable = Join-Path $TorBundleDir "tor\tor.exe"
$lyrebirdExecutable = Join-Path $TorBundleDir "tor\pluggable_transports\lyrebird.exe"
if (-not (Test-Path -LiteralPath $torExecutable) -or -not (Test-Path -LiteralPath $lyrebirdExecutable)) {
    Download-VerifiedFile -Uri $TorBundleUrl -Destination $TorBundleArchive -Sha256 $TorBundleSha256
    if (Test-Path -LiteralPath $TorBundleDir) {
        [IO.Directory]::Delete([IO.Path]::GetFullPath($TorBundleDir), $true)
    }
    [IO.Directory]::CreateDirectory($TorBundleDir) | Out-Null
    & "$env:SystemRoot\System32\tar.exe" -xzf $TorBundleArchive -C $TorBundleDir
    if ($LASTEXITCODE -ne 0) { throw "Tor Expert Bundle extraction failed with exit code $LASTEXITCODE" }
}
if (-not (Test-Path -LiteralPath $torExecutable)) { throw "tor.exe was not found below $TorBundleDir" }
if (-not (Test-Path -LiteralPath $lyrebirdExecutable)) { throw "lyrebird.exe was not found below $TorBundleDir" }

$bundledRuntimeHashes = @{
    (Join-Path $QtoxRuntimeDir "libsqlcipher-0.dll") = "CC0BC4E4C60BE3650D6B54164C85850064450BF2D141E764744EF1215D11490A"
    (Join-Path $QtoxRuntimeDir "libcrypto-3-x64.dll") = "C6E6C30347266A19BD327A69F296FA1916D501DE3D6B98FE87FA424A7446AEA4"
    (Join-Path $QtoxRuntimeDir "libssl-3-x64.dll") = "113D3D4444230BEB423E82CFC4C179CC552F031908C753BAE87946368D816089"
    (Join-Path $QtoxRuntimeDir "libgcc_s_seh-1.dll") = "5D65D8D2A5BEF8381F65E958D777EAF66077CEE6924072DDDB4AAF5179CE2FE0"
    (Join-Path $QtoxRuntimeDir "libstdc++-6.dll") = "1668967CABC4CF8AAAC687438B3A3CCAC4EB924D1A1E70482E03A7A4B473D212"
    (Join-Path $QtoxRuntimeDir "libwinpthread-1.dll") = "B9EE20D262B77AB0AACFCDB40842F1EC387B446D0A1C3C618E93E9F7A1FD5A74"
    (Join-Path $DictionaryDir "ru-RU.aff") = "38CE7D4AF78E211E9BAFE4BF7E3D6A2C420591136CB738EC6648F8FDF6524CD7"
    (Join-Path $DictionaryDir "ru-RU.dic") = "F6047416A0204ADBECF3A451B874EC8A97EE37E2CBC714466EF04D8DBCC0D6FC"
    (Join-Path $DictionaryDir "en-US.aff") = "8AE1F19D4840D957728AD90555D5A8DFF6CC5C046279C95FF0C00FC0A0136C7B"
    (Join-Path $DictionaryDir "en-US.dic") = "F0B1A234BD178BDD01875B2A392A9647F888B8FE879F79C52AAE62C2759B3647"
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
