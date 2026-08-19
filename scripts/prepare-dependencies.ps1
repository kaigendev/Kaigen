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
$TorBundleMarker = Join-Path $DependencyDir "TorExpertBundle.version"
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
$WebView2Version = "151.0.4129.93"
$WebView2Url = "https://msedge.sf.dl.delivery.mp.microsoft.com/filestreamingservice/files/1424552f-1033-46d3-a1ea-26c879f4262b/Microsoft.WebView2.FixedVersionRuntime.151.0.4129.93.x64.cab"
$WebView2Sha256 = "1CB7106545F5AEE92EE16496347A0E775A351CB5A3816D072F04323695899BDE"
$DefaultWebView2Archive = Join-Path $DownloadDir "Microsoft.WebView2.FixedVersionRuntime.151.0.4129.93.x64.cab"
$TorBundleVersion = "15.0.20"
$TorBundleUrl = "https://archive.torproject.org/tor-package-archive/torbrowser/15.0.20/tor-expert-bundle-windows-x86_64-15.0.20.tar.gz"
$TorBundleSha256 = "D59BFF934E3AD876E1623E24AE60C19AEEA56F50178093B9F86FBA230639F949"
$TorBundleArchive = Join-Path $DownloadDir "tor-expert-bundle-windows-x86_64-15.0.20.tar.gz"

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
    $downloaded = $false
    $curlError = $null
    $curl = Get-Command -Name "curl.exe" -CommandType Application -ErrorAction SilentlyContinue
    if ($null -ne $curl) {
        & $curl.Source --fail --location --retry 5 --retry-delay 2 --retry-connrefused `
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
            Write-Warning "$curlError; retrying through Windows PowerShell."
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
    Assert-FileHash -Path $Destination -Expected $Sha256
}

function Apply-KaigenToxcoreRetryCap {
    param([string]$SourceDirectory)
    $headerPath = Join-Path $SourceDirectory "toxcore\Messenger.h"
    $sourcePath = Join-Path $SourceDirectory "toxcore\Messenger.c"
    $encoding = [Text.UTF8Encoding]::new($false)
    $header = [IO.File]::ReadAllText($headerPath)
    if (-not $header.Contains("#define FRIENDREQUEST_TIMEOUT_MAX 60")) {
        $marker = "#define FRIENDREQUEST_TIMEOUT 5"
        if (-not $header.Contains($marker)) {
            throw "The pinned c-toxcore friend-request timeout declaration changed; review the Kaigen retry-cap patch."
        }
        $header = $header.Replace(
            $marker,
            "$marker`n/** Kaigen keeps offline authorisation retries responsive. */`n#define FRIENDREQUEST_TIMEOUT_MAX 60"
        )
        [IO.File]::WriteAllText($headerPath, $header, $encoding)
    }

    $source = [IO.File]::ReadAllText($sourcePath)
    $patched = "f->friendrequest_timeout =`n            min_u32(f->friendrequest_timeout * 2, FRIENDREQUEST_TIMEOUT_MAX);"
    if (-not $source.Contains($patched)) {
        $marker = "f->friendrequest_timeout *= 2;"
        if (-not $source.Contains($marker)) {
            throw "The pinned c-toxcore friend-request retry implementation changed; review the Kaigen retry-cap patch."
        }
        $source = $source.Replace($marker, $patched)
        [IO.File]::WriteAllText($sourcePath, $source, $encoding)
    }
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
Apply-KaigenToxcoreRetryCap -SourceDirectory $ToxcoreDir
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

$useCustomWebView2 = -not [string]::IsNullOrWhiteSpace($WebView2CabPath)
$runtimeExecutable = Get-ChildItem -LiteralPath $RuntimeDir -Filter "msedgewebview2.exe" -File -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
if ($runtimeExecutable -and ($useCustomWebView2 -or $runtimeExecutable.VersionInfo.ProductVersion -ne $WebView2Version)) {
    $runtimeExecutable = $null
}
if (-not $runtimeExecutable) {
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
if (-not $useCustomWebView2 -and $runtimeExecutable.VersionInfo.ProductVersion -ne $WebView2Version) {
    throw "Microsoft WebView2 version mismatch. Expected $WebView2Version, got $($runtimeExecutable.VersionInfo.ProductVersion)."
}

$torExecutable = Join-Path $TorBundleDir "tor\tor.exe"
$lyrebirdExecutable = Join-Path $TorBundleDir "tor\pluggable_transports\lyrebird.exe"
$torBundleCurrent = (Test-Path -LiteralPath $torExecutable) -and
    (Test-Path -LiteralPath $lyrebirdExecutable) -and
    (Test-Path -LiteralPath $TorBundleMarker) -and
    (([IO.File]::ReadAllText($TorBundleMarker)).Trim() -eq $TorBundleVersion)
if (-not $torBundleCurrent) {
    Download-VerifiedFile -Uri $TorBundleUrl -Destination $TorBundleArchive -Sha256 $TorBundleSha256
    if (Test-Path -LiteralPath $TorBundleDir) {
        [IO.Directory]::Delete([IO.Path]::GetFullPath($TorBundleDir), $true)
    }
    [IO.Directory]::CreateDirectory($TorBundleDir) | Out-Null
    & "$env:SystemRoot\System32\tar.exe" -xzf $TorBundleArchive -C $TorBundleDir
    if ($LASTEXITCODE -ne 0) { throw "Tor Expert Bundle extraction failed with exit code $LASTEXITCODE" }
    [IO.File]::WriteAllText($TorBundleMarker, "$TorBundleVersion`n", [Text.UTF8Encoding]::new($false))
}
if (-not (Test-Path -LiteralPath $torExecutable)) { throw "tor.exe was not found below $TorBundleDir" }
if (-not (Test-Path -LiteralPath $lyrebirdExecutable)) { throw "lyrebird.exe was not found below $TorBundleDir" }

$bundledRuntimeHashes = @{
    (Join-Path $QtoxRuntimeDir "libsqlcipher-0.dll") = "CD045C07BF315B192ED98FCB655D08F9E8FB6D936456F52EBFC213DD219AF703"
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
