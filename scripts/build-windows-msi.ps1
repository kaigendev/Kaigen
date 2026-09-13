#requires -Version 7.6.5
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$PortableRoot,

    [string]$ArtifactsDir,
    [string]$ProductVersion,
    [string]$ReleaseLabel,
    [switch]$GenerateOnly,
    [switch]$SkipInstallTest
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$utf8NoBom = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $utf8NoBom
$OutputEncoding = $utf8NoBom
if ($PSVersionTable.PSVersion.ToString() -cne "7.6.5") {
    throw "Kaigen automation requires PowerShell 7.6.5 exactly; found $($PSVersionTable.PSVersion)."
}

$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$manifest = Get-Content -LiteralPath (Join-Path $projectRoot "src-tauri\tauri.conf.json") -Raw | ConvertFrom-Json
$manifestVersion = [string]$manifest.version
if ([string]::IsNullOrWhiteSpace($ReleaseLabel)) {
    $ReleaseLabel = $manifestVersion
}
$portableRoot = [IO.Path]::GetFullPath($PortableRoot).TrimEnd('\')
if (-not (Test-Path -LiteralPath $portableRoot -PathType Container)) {
    throw "Portable payload directory does not exist: $portableRoot"
}
if ([string]::IsNullOrWhiteSpace($ArtifactsDir)) {
    $ArtifactsDir = Split-Path -Parent $portableRoot
}
$artifactsDir = [IO.Path]::GetFullPath($ArtifactsDir).TrimEnd('\')
[IO.Directory]::CreateDirectory($artifactsDir) | Out-Null

foreach ($required in @(
    "Kaigen.exe",
    "toxcore.dll",
    "pthreadVC3.dll",
    "PORTABLE.txt",
    "WebView2Runtime\msedgewebview2.exe",
    "TorExpertBundle\tor\tor.exe",
    "TorExpertBundle\tor\pluggable_transports\lyrebird.exe",
    "runtime\dictionaries\ru-RU.dic",
    "runtime\qtox-import\libsqlcipher-0.dll"
)) {
    if (-not (Test-Path -LiteralPath (Join-Path $portableRoot $required) -PathType Leaf)) {
        throw "MSI payload is missing required portable file: $required"
    }
}

$privatePayload = @(Get-ChildItem -LiteralPath $portableRoot -Recurse -File -Force | Where-Object {
    $_.Extension -in @(".tox", ".kai") -or
    $_.Name -in @("profiles.json", "proxy-settings.json", "tor-settings.json")
})
if ($privatePayload.Count -gt 0) {
    throw "Private runtime data must not be packaged in MSI: $($privatePayload[0].FullName)"
}

if ([string]::IsNullOrWhiteSpace($ProductVersion)) {
    if ($manifestVersion -notmatch '^(?<major>\d+)[.](?<minor>\d+)[.](?<patch>\d+)(?:[+](?<build>\d+))?$') {
        throw "Tauri version cannot be converted to an MSI ProductVersion: $manifestVersion"
    }
    $build = if ($Matches.ContainsKey("build")) { [string]$Matches["build"] } else { "0" }
    $ProductVersion = "$($Matches.major).$($Matches.minor).$($Matches.patch).$build"
}
if ($ProductVersion -notmatch '^\d{1,3}[.]\d{1,3}[.]\d{1,5}[.]\d{1,5}$') {
    throw "MSI ProductVersion must use major.minor.patch.build: $ProductVersion"
}
$versionParts = @($ProductVersion.Split('.') | ForEach-Object { [int]$_ })
if ($versionParts[0] -gt 255 -or $versionParts[1] -gt 255 -or $versionParts[2] -gt 65535 -or $versionParts[3] -gt 65535) {
    throw "MSI ProductVersion fields exceed Windows Installer limits: $ProductVersion"
}

function Get-StableHex {
    param([Parameter(Mandatory)][string]$Value)
    $bytes = [Text.Encoding]::UTF8.GetBytes($Value)
    $hash = [Security.Cryptography.SHA256]::HashData($bytes)
    return [Convert]::ToHexString($hash).ToLowerInvariant()
}

function Get-WixId {
    param(
        [Parameter(Mandatory)][string]$Prefix,
        [Parameter(Mandatory)][string]$Value
    )
    return "${Prefix}_$((Get-StableHex -Value $Value).Substring(0, 30))"
}

function Get-StableGuid {
    param([Parameter(Mandatory)][string]$Value)
    $bytes = [Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($Value))[0..15]
    $bytes[6] = ($bytes[6] -band 0x0F) -bor 0x50
    $bytes[8] = ($bytes[8] -band 0x3F) -bor 0x80
    return ([Guid]::new([byte[]]$bytes)).ToString().ToUpperInvariant()
}

function ConvertTo-WixXml {
    param([AllowEmptyString()][string]$Value)
    return [Security.SecurityElement]::Escape($Value)
}

function ConvertTo-Rtf {
    param([Parameter(Mandatory)][string]$Text)
    $builder = [Text.StringBuilder]::new()
    [void]$builder.Append('{\rtf1\ansi\deff0{\fonttbl{\f0 Segoe UI;}}\fs18 ')
    foreach ($character in $Text.ToCharArray()) {
        $code = [int]$character
        switch ($code) {
            10 { [void]$builder.Append("\par`n"); continue }
            13 { continue }
            9 { [void]$builder.Append('\tab '); continue }
            92 { [void]$builder.Append('\\'); continue }
            123 { [void]$builder.Append('\{'); continue }
            125 { [void]$builder.Append('\}'); continue }
        }
        if ($code -ge 32 -and $code -le 126) {
            [void]$builder.Append($character)
        } else {
            $signed = if ($code -gt 32767) { $code - 65536 } else { $code }
            [void]$builder.Append(('\u{0}?' -f $signed))
        }
    }
    [void]$builder.Append('}')
    return $builder.ToString()
}

$files = @(Get-ChildItem -LiteralPath $portableRoot -Recurse -File -Force | Sort-Object FullName)
if ($files.Count -eq 0) {
    throw "Portable payload is empty."
}

$payloadEntries = foreach ($file in $files) {
    $relativePath = [IO.Path]::GetRelativePath($portableRoot, $file.FullName).Replace('\', '/')
    [pscustomobject]@{
        RelativePath = $relativePath
        FullPath = $file.FullName
        Directory = [IO.Path]::GetDirectoryName($relativePath).Replace('\', '/')
        Bytes = $file.Length
        Sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $file.FullName).Hash.ToLowerInvariant()
    }
}
$mainExecutable = @($payloadEntries | Where-Object RelativePath -CEQ 'Kaigen.exe')
if ($mainExecutable.Count -ne 1) {
    throw 'MSI payload must contain exactly one root Kaigen.exe.'
}
$mainExecutableFileId = Get-WixId -Prefix 'F' -Value $mainExecutable[0].RelativePath

$directories = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
[void]$directories.Add("")
foreach ($entry in $payloadEntries) {
    $current = $entry.Directory
    while (-not [string]::IsNullOrEmpty($current)) {
        [void]$directories.Add($current)
        $current = [IO.Path]::GetDirectoryName($current).Replace('\', '/')
    }
}
foreach ($directory in Get-ChildItem -LiteralPath $portableRoot -Recurse -Directory -Force) {
    [void]$directories.Add([IO.Path]::GetRelativePath($portableRoot, $directory.FullName).Replace('\', '/'))
}

$directoryIds = @{"" = "INSTALLFOLDER"}
foreach ($directory in @($directories | Where-Object { $_ } | Sort-Object { ($_ -split '/').Count }, { $_ })) {
    $directoryIds[$directory] = Get-WixId -Prefix "D" -Value $directory
}

$directoryChildren = @{}
foreach ($directory in @($directories | Where-Object { $_ })) {
    $parent = [IO.Path]::GetDirectoryName($directory).Replace('\', '/')
    if (-not $directoryChildren.ContainsKey($parent)) {
        $directoryChildren[$parent] = [Collections.Generic.List[string]]::new()
    }
    $directoryChildren[$parent].Add($directory)
}

function Add-WixDirectoryTree {
    param(
        [Parameter(Mandatory)][Collections.Generic.List[string]]$Lines,
        [Parameter(Mandatory)][AllowEmptyString()][string]$RelativeDirectory,
        [Parameter(Mandatory)][int]$Indent
    )
    if (-not $directoryChildren.ContainsKey($RelativeDirectory)) { return }
    foreach ($child in @($directoryChildren[$RelativeDirectory] | Sort-Object)) {
        $name = [IO.Path]::GetFileName($child)
        $padding = ' ' * $Indent
        $Lines.Add(('{0}<Directory Id="{1}" Name="{2}">' -f $padding, $directoryIds[$child], (ConvertTo-WixXml $name)))
        Add-WixDirectoryTree -Lines $Lines -RelativeDirectory $child -Indent ($Indent + 2)
        $Lines.Add("$padding</Directory>")
    }
}

$msiWork = [IO.Path]::GetFullPath((Join-Path $artifactsDir "msi-work"))
$artifactsPrefix = $artifactsDir.TrimEnd('\') + '\'
if (-not $msiWork.StartsWith($artifactsPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing MSI staging outside the artifacts directory: $msiWork"
}
if (Test-Path -LiteralPath $msiWork) {
    [IO.Directory]::Delete($msiWork, $true)
}
[IO.Directory]::CreateDirectory($msiWork) | Out-Null

$shutdownHelperSource = Join-Path $projectRoot "packaging\windows\kaigen-update-shutdown.rs"
if (-not (Test-Path -LiteralPath $shutdownHelperSource -PathType Leaf)) {
    throw "The MSI graceful-shutdown helper source is missing: $shutdownHelperSource"
}
$rustc = Get-Command rustc.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $rustc) {
    throw "rustc.exe is required to build the embedded MSI graceful-shutdown helper."
}
$rustcPath = if ($rustc -is [IO.FileInfo]) { $rustc.FullName } else { [string]$rustc.Source }
$shutdownHelperPath = Join-Path $msiWork "kaigen-update-shutdown.exe"
$shutdownHelperArguments = @(
    "--edition=2021",
    "-C", "opt-level=z",
    "-C", "panic=abort",
    "-C", "strip=symbols",
    "-o", $shutdownHelperPath,
    $shutdownHelperSource
)
& $rustcPath @shutdownHelperArguments
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $shutdownHelperPath -PathType Leaf)) {
    throw "Could not compile the embedded MSI graceful-shutdown helper."
}
$shutdownHelperSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $shutdownHelperPath).Hash.ToLowerInvariant()

$licenseText = Get-Content -LiteralPath (Join-Path $projectRoot "LICENSE") -Raw
$licenseRtf = Join-Path $msiWork "LICENSE.rtf"
[IO.File]::WriteAllText($licenseRtf, (ConvertTo-Rtf -Text $licenseText), [Text.Encoding]::ASCII)

$productCode = Get-StableGuid -Value "kaigen-msi-product:${ProductVersion}:${ReleaseLabel}:x64"
$upgradeCode = "BB5A9D83-8FB2-5590-BC3C-22F34E77946E"
$iconPath = [IO.Path]::GetFullPath((Join-Path $projectRoot "src-tauri\icons\icon.ico"))
$wxs = [Collections.Generic.List[string]]::new()
$wxs.Add('<?xml version="1.0" encoding="utf-8"?>')
$wxs.Add('<Wix xmlns="http://schemas.microsoft.com/wix/2006/wi" xmlns:util="http://schemas.microsoft.com/wix/UtilExtension">')
$wxs.Add(('  <Product Id="{0}" Name="Kaigen {1} - {2}" Language="1033" Version="{1}" Manufacturer="Kaigen" UpgradeCode="{3}">' -f $productCode, $ProductVersion, (ConvertTo-WixXml $ReleaseLabel), $upgradeCode))
$wxs.Add('    <Package InstallerVersion="500" Compressed="yes" InstallScope="perUser" InstallPrivileges="limited" Platform="x64" Description="Kaigen portable payload installer" />')
$wxs.Add('    <MajorUpgrade AllowSameVersionUpgrades="yes" DowngradeErrorMessage="A newer Kaigen version is already installed." />')
$wxs.Add('    <MediaTemplate EmbedCab="yes" CompressionLevel="high" />')
$wxs.Add('    <Property Id="WIXUI_INSTALLDIR" Value="INSTALLFOLDER" />')
$wxs.Add('    <Property Id="INSTALLFOLDER">')
$wxs.Add('      <RegistrySearch Id="InstallFolderSearch" Root="HKCU" Key="Software\Kaigen\Installer" Name="InstallFolder" Type="raw" Win64="yes" />')
$wxs.Add('    </Property>')
$wxs.Add('    <Property Id="ARPNOREPAIR" Value="1" />')
$wxs.Add('    <Property Id="MSIINSTALLPERUSER" Value="1" />')
$wxs.Add('    <Property Id="MSIDISABLERMRESTART" Value="1" />')
$wxs.Add('    <Property Id="WIXUI_EXITDIALOGOPTIONALCHECKBOXTEXT" Value="Launch Kaigen" />')
$wxs.Add('    <Property Id="ARPPRODUCTICON" Value="KaigenIcon" />')
$wxs.Add(('    <Icon Id="KaigenIcon" SourceFile="{0}" />' -f (ConvertTo-WixXml $iconPath)))
$wxs.Add('    <Directory Id="TARGETDIR" Name="SourceDir">')
$wxs.Add('      <Directory Id="LocalAppDataFolder">')
$wxs.Add('        <Directory Id="INSTALLFOLDER" Name="Kaigen">')
Add-WixDirectoryTree -Lines $wxs -RelativeDirectory "" -Indent 10
$wxs.Add('        </Directory>')
$wxs.Add('      </Directory>')
$wxs.Add('    </Directory>')
$wxs.Add('    <Feature Id="ProductFeature" Title="Kaigen" Level="1" Absent="disallow">')
$wxs.Add('      <ComponentGroupRef Id="KaigenPayload" />')
$wxs.Add('    </Feature>')
$wxs.Add('    <UIRef Id="WixUI_InstallDir" />')
$wxs.Add(('    <WixVariable Id="WixUILicenseRtf" Value="{0}" />' -f (ConvertTo-WixXml $licenseRtf)))
$wxs.Add(('    <Binary Id="KaigenUpdateShutdownHelper" SourceFile="{0}" />' -f (ConvertTo-WixXml $shutdownHelperPath)))
$wxs.Add('    <CustomAction Id="ShutdownKaigenBeforeUpdate" BinaryKey="KaigenUpdateShutdownHelper" ExeCommand="&quot;[INSTALLFOLDER]Kaigen.exe&quot;" Execute="immediate" Impersonate="yes" Return="check" />')
$wxs.Add(('    <CustomAction Id="LaunchKaigenAfterInstall" FileKey="{0}" ExeCommand="" Execute="immediate" Impersonate="yes" Return="asyncNoWait" />' -f $mainExecutableFileId))
$wxs.Add('    <UI>')
# Leave the optional checkbox property unset: launch requires an explicit choice
# on the successful finish page, for both first installs and major upgrades.
$wxs.Add('      <Publish Dialog="ExitDialog" Control="Finish" Event="DoAction" Value="LaunchKaigenAfterInstall" Order="1">WIXUI_EXITDIALOGOPTIONALCHECKBOX = 1 AND NOT Installed AND NOT REMOVE~="ALL"</Publish>')
$wxs.Add('    </UI>')
$wxs.Add('    <InstallExecuteSequence>')
$wxs.Add('      <Custom Action="ShutdownKaigenBeforeUpdate" After="CostFinalize">1</Custom>')
$wxs.Add('    </InstallExecuteSequence>')
$wxs.Add('  </Product>')

$componentIds = [Collections.Generic.List[string]]::new()
foreach ($directory in @($directories | Sort-Object { ($_ -split '/').Count }, { $_ })) {
    $directFiles = @($payloadEntries | Where-Object { $_.Directory -ceq $directory })
    $wxs.Add('  <Fragment>')
    $wxs.Add(('    <DirectoryRef Id="{0}">' -f $directoryIds[$directory]))
    foreach ($entry in $directFiles) {
        $componentId = Get-WixId -Prefix "C" -Value $entry.RelativePath
        $fileId = Get-WixId -Prefix "F" -Value $entry.RelativePath
        $componentGuid = Get-StableGuid -Value "kaigen-msi-component:$($entry.RelativePath)"
        $registryName = Get-WixId -Prefix "file" -Value $entry.RelativePath
        $componentIds.Add($componentId)
        $wxs.Add(('      <Component Id="{0}" Guid="{1}" Win64="yes">' -f $componentId, $componentGuid))
        $wxs.Add(('        <File Id="{0}" Source="{1}" Vital="yes" />' -f $fileId, (ConvertTo-WixXml $entry.FullPath)))
        $wxs.Add(('        <RegistryValue Root="HKCU" Key="Software\Kaigen\Installer\Files" Name="{0}" Type="integer" Value="1" KeyPath="yes" />' -f $registryName))
        $wxs.Add('      </Component>')
    }
    $directoryIdentity = if ($directory) { $directory } else { "<install-root>" }
    $directoryComponentId = Get-WixId -Prefix "CDIR" -Value $directoryIdentity
    $directoryComponentGuid = Get-StableGuid -Value "kaigen-msi-directory:$directoryIdentity"
    $removeFolderId = Get-WixId -Prefix "RF" -Value $directoryIdentity
    $componentIds.Add($directoryComponentId)
    $wxs.Add(('      <Component Id="{0}" Guid="{1}" Win64="yes">' -f $directoryComponentId, $directoryComponentGuid))
    $wxs.Add('        <CreateFolder />')
    $wxs.Add(('        <RemoveFolder Id="{0}" On="uninstall" />' -f $removeFolderId))
    if ([string]::IsNullOrEmpty($directory)) {
        # Persist the selected public directory property. File components use
        # registry key paths for ICE38 compliance, so Windows Installer cannot
        # otherwise recover a command-line/UI-selected location for uninstall.
        $wxs.Add('        <RegistryValue Root="HKCU" Key="Software\Kaigen\Installer" Name="InstallFolder" Type="string" Value="[INSTALLFOLDER]" KeyPath="yes" />')
    } else {
        $directoryRegistryName = Get-WixId -Prefix "folder" -Value $directoryIdentity
        $wxs.Add(('        <RegistryValue Root="HKCU" Key="Software\Kaigen\Installer\Folders" Name="{0}" Type="integer" Value="1" KeyPath="yes" />' -f $directoryRegistryName))
    }
    $wxs.Add('      </Component>')
    $wxs.Add('    </DirectoryRef>')
    $wxs.Add('  </Fragment>')
}
$wxs.Add('  <Fragment>')
$wxs.Add('    <ComponentGroup Id="KaigenPayload">')
foreach ($componentId in $componentIds) {
    $wxs.Add(('      <ComponentRef Id="{0}" />' -f $componentId))
}
$wxs.Add('    </ComponentGroup>')
$wxs.Add('  </Fragment>')
$wxs.Add('</Wix>')

$wxsPath = Join-Path $msiWork "Kaigen.wxs"
[IO.File]::WriteAllLines($wxsPath, $wxs, $utf8NoBom)
[xml](Get-Content -LiteralPath $wxsPath -Raw) | Out-Null

$manifestPath = Join-Path $artifactsDir "Kaigen-installer-windows-x64.manifest.json"
$manifestObject = [ordered]@{
    schema = 1
    productVersion = $ProductVersion
    releaseLabel = $ReleaseLabel
    productCode = $productCode
    upgradeCode = $upgradeCode
    compression = "embedded-cab-high"
    installDirectoryProperty = "INSTALLFOLDER"
    gracefulShutdown = "exact-path-named-event-with-event-loop-fallback"
    gracefulShutdownTimeoutSeconds = 60
    gracefulShutdownHelperSha256 = $shutdownHelperSha256
    forceTermination = $false
    launchPolicy = "finish-dialog-opt-in"
    launchCheckboxProperty = "WIXUI_EXITDIALOGOPTIONALCHECKBOX"
    launchCheckboxDefault = $false
    silentLaunch = $false
    restartManagerRelaunch = $false
    payloadFileCount = $payloadEntries.Count
    payloadBytes = ($payloadEntries | Measure-Object -Property Bytes -Sum).Sum
    files = @($payloadEntries | ForEach-Object {
        [ordered]@{
            path = $_.RelativePath
            bytes = $_.Bytes
            sha256 = $_.Sha256
        }
    })
}
[IO.File]::WriteAllText($manifestPath, ($manifestObject | ConvertTo-Json -Depth 6) + "`n", $utf8NoBom)

if ($GenerateOnly) {
    Write-Host "MSI_WXS_GENERATION_PASS version=$ProductVersion files=$($payloadEntries.Count) wxs=$wxsPath manifest=$manifestPath"
    return
}

$candle = Get-Command candle.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $candle) {
    $wixRoots = @(Get-ChildItem -LiteralPath "${env:ProgramFiles(x86)}" -Directory -Filter "WiX Toolset v3*" -ErrorAction SilentlyContinue | Sort-Object Name -Descending)
    foreach ($root in $wixRoots) {
        $candidate = Join-Path $root.FullName "bin\candle.exe"
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            $candle = Get-Item -LiteralPath $candidate
            break
        }
    }
}
if (-not $candle) {
    throw "WiX Toolset 3 candle.exe is not available. MSI generation stops without downloading build components."
}
$candlePath = if ($candle -is [IO.FileInfo]) { $candle.FullName } else { [string]$candle.Source }
if ([string]::IsNullOrWhiteSpace($candlePath) -or -not (Test-Path -LiteralPath $candlePath -PathType Leaf)) {
    throw "WiX Toolset 3 candle.exe resolved to an invalid path."
}
$wixBin = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($candlePath))
$lightPath = Join-Path $wixBin "light.exe"
$uiExtension = Join-Path $wixBin "WixUIExtension.dll"
$utilExtension = Join-Path $wixBin "WixUtilExtension.dll"
if (-not (Test-Path -LiteralPath $lightPath -PathType Leaf) -or
    -not (Test-Path -LiteralPath $uiExtension -PathType Leaf) -or
    -not (Test-Path -LiteralPath $utilExtension -PathType Leaf)) {
    throw "WiX Toolset 3 light.exe, WixUIExtension.dll, or WixUtilExtension.dll is missing beside candle.exe."
}

$wixObject = Join-Path $msiWork "Kaigen.wixobj"
& $candlePath -nologo -arch x64 -ext $utilExtension -out $wixObject $wxsPath
if ($LASTEXITCODE -ne 0) { throw "WiX candle.exe failed." }
$msiPath = Join-Path $artifactsDir "Kaigen-installer-windows-x64.msi"
& $lightPath -nologo -ext $uiExtension -ext $utilExtension -cultures:en-us -out $msiPath $wixObject
if ($LASTEXITCODE -ne 0) { throw "WiX light.exe failed." }

$header = [byte[]]::new(8)
$stream = [IO.File]::OpenRead($msiPath)
try {
    if ($stream.Read($header, 0, $header.Length) -ne $header.Length) {
        throw "MSI output is truncated."
    }
} finally {
    $stream.Dispose()
}
if ([Convert]::ToHexString($header) -cne "D0CF11E0A1B11AE1") {
    throw "MSI output does not have the Compound File Binary header."
}

& (Join-Path $PSScriptRoot 'test-windows-msi-launch-policy.ps1') -MsiPath $msiPath

function Write-MsiLifecycleDiagnostics {
    param([Parameter(Mandatory)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return }
    Write-Host "MSI_LIFECYCLE_DIAGNOSTICS_BEGIN log=$Path"
    Select-String -LiteralPath $Path -Pattern @(
        "ShutdownKaigenBeforeUpdate",
        "KaigenUpdateShutdownHelper",
        "Kaigen.exe",
        "InstallValidate",
        "InstallFiles",
        "LaunchKaigenAfterInstall",
        "Return value 3"
    ) | Select-Object -Last 160 | ForEach-Object { Write-Host $_.Line }
    Write-Host "MSI_LIFECYCLE_DIAGNOSTICS_END"
}

function Assert-NoInstalledKaigenProcess {
    param([Parameter(Mandatory)][string]$Executable)
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    do {
        $unexpected = @(Get-Process -Name Kaigen -ErrorAction SilentlyContinue | Where-Object {
            try {
                [string]::Equals([IO.Path]::GetFullPath($_.Path), [IO.Path]::GetFullPath($Executable), [StringComparison]::OrdinalIgnoreCase)
            } catch { $false }
        })
        if ($unexpected.Count -gt 0) {
            throw 'MSI launched the installed Kaigen executable without a Finish-dialog choice.'
        }
        Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $deadline)
}

if (-not $SkipInstallTest) {
    if (Test-Path -LiteralPath 'HKCU:\Software\Kaigen\Installer') {
        throw 'Disposable MSI lifecycle validation requires a user account without an existing Kaigen MSI installation.'
    }
    $installRoot = Join-Path $msiWork "installed-payload"
    $installLog = Join-Path $msiWork "install.log"
    $uninstallLog = Join-Path $msiWork "uninstall.log"
    $quotedMsi = '"' + $msiPath + '"'
    $quotedInstallRoot = '"' + $installRoot + '"'
    $quotedInstallLog = '"' + $installLog + '"'
    $installArguments = "/i $quotedMsi /qn /norestart INSTALLFOLDER=$quotedInstallRoot /l*v $quotedInstallLog"
    $install = Start-Process -FilePath (Join-Path $env:SystemRoot "System32\msiexec.exe") -ArgumentList $installArguments -Wait -PassThru -WindowStyle Hidden
    if ($install.ExitCode -notin @(0, 3010)) {
        throw "Disposable MSI install failed with exit code $($install.ExitCode)."
    }
    try {
        $installedEntries = @(Get-ChildItem -LiteralPath $installRoot -Recurse -File -Force | Sort-Object FullName | ForEach-Object {
            [pscustomobject]@{
                RelativePath = [IO.Path]::GetRelativePath($installRoot, $_.FullName).Replace('\', '/')
                Bytes = $_.Length
                Sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash.ToLowerInvariant()
            }
        })
        if ($installedEntries.Count -ne $payloadEntries.Count) {
            throw "MSI installed $($installedEntries.Count) files; expected $($payloadEntries.Count)."
        }
        for ($index = 0; $index -lt $payloadEntries.Count; $index++) {
            $expected = $payloadEntries[$index]
            $actual = $installedEntries[$index]
            if ($actual.RelativePath -cne $expected.RelativePath -or $actual.Bytes -ne $expected.Bytes -or $actual.Sha256 -cne $expected.Sha256) {
                throw "MSI payload mismatch at $($expected.RelativePath)."
            }
        }

        $installedExecutable = Join-Path $installRoot 'Kaigen.exe'
        Assert-NoInstalledKaigenProcess -Executable $installedExecutable
        $originalProcess = Start-Process -FilePath $installedExecutable -WorkingDirectory $installRoot -PassThru -WindowStyle Hidden
        $launchDeadline = [DateTime]::UtcNow.AddSeconds(45)
        do {
            Start-Sleep -Milliseconds 250
            $originalProcess.Refresh()
        } while (-not $originalProcess.HasExited -and $originalProcess.MainWindowHandle -eq 0 -and [DateTime]::UtcNow -lt $launchDeadline)
        if ($originalProcess.HasExited -or $originalProcess.MainWindowHandle -eq 0) {
            throw 'Disposable MSI update test could not start a real Kaigen window.'
        }

        $repairLog = Join-Path $msiWork 'repair.log'
        $quotedRepairLog = '"' + $repairLog + '"'
        $repairArguments = "/i $quotedMsi /qn /norestart REINSTALL=ALL REINSTALLMODE=vomus INSTALLFOLDER=$quotedInstallRoot /l*v $quotedRepairLog"
        $repair = Start-Process -FilePath (Join-Path $env:SystemRoot "System32\msiexec.exe") -ArgumentList $repairArguments -Wait -PassThru -WindowStyle Hidden
        if ($repair.ExitCode -notin @(0, 3010)) {
            Write-MsiLifecycleDiagnostics -Path $repairLog
            throw "Disposable MSI update failed with exit code $($repair.ExitCode)."
        }
        $originalProcess.Refresh()
        if (-not $originalProcess.HasExited) {
            Write-MsiLifecycleDiagnostics -Path $repairLog
            throw 'MSI update did not gracefully finish the running Kaigen process.'
        }

        Assert-NoInstalledKaigenProcess -Executable $installedExecutable

        # A later explicit launch must still open the exact updated executable.
        $restartedProcess = Start-Process -FilePath $installedExecutable -WorkingDirectory $installRoot -PassThru -WindowStyle Hidden
        $relaunchDeadline = [DateTime]::UtcNow.AddSeconds(45)
        do {
            Start-Sleep -Milliseconds 250
            $restartedProcess.Refresh()
        } while (-not $restartedProcess.HasExited -and $restartedProcess.MainWindowHandle -eq 0 -and [DateTime]::UtcNow -lt $relaunchDeadline)
        if ($restartedProcess.HasExited -or $restartedProcess.MainWindowHandle -eq 0) {
            throw 'The exact installed Kaigen executable did not open a real window after an explicit launch.'
        }
        # Window close follows close-to-tray; reuse the exact-path update shutdown instead.
        & $shutdownHelperPath $installedExecutable | Out-Null
        if ($LASTEXITCODE -ne 0) {
            throw "Relaunched disposable Kaigen shutdown helper failed with exit code $LASTEXITCODE."
        }
        if (-not $restartedProcess.WaitForExit(30000)) {
            throw 'Relaunched disposable Kaigen process did not close gracefully after the MSI update test.'
        }
    } finally {
        $quotedUninstallLog = '"' + $uninstallLog + '"'
        # Couple validation to the exact package emitted by this build.
        $uninstallArguments = "/x $quotedMsi /qn /norestart /l*v $quotedUninstallLog"
        $uninstall = Start-Process -FilePath (Join-Path $env:SystemRoot "System32\msiexec.exe") -ArgumentList $uninstallArguments -Wait -PassThru -WindowStyle Hidden
        if ($uninstall.ExitCode -notin @(0, 3010)) {
            throw "Disposable MSI uninstall failed with exit code $($uninstall.ExitCode)."
        }
    }
    $remainingPackagedFiles = @($payloadEntries | Where-Object {
        Test-Path -LiteralPath (Join-Path $installRoot $_.RelativePath) -PathType Leaf
    })
    if ($remainingPackagedFiles.Count -gt 0) {
        if (Test-Path -LiteralPath $uninstallLog -PathType Leaf) {
            Write-Host "MSI_UNINSTALL_DIAGNOSTICS_BEGIN exitCode=$($uninstall.ExitCode)"
            Get-Content -LiteralPath $uninstallLog -Tail 160 | ForEach-Object { Write-Host $_ }
            Write-Host "MSI_UNINSTALL_DIAGNOSTICS_END"
        }
        throw "Disposable MSI uninstall left packaged files behind: $($remainingPackagedFiles[0].RelativePath)"
    }
}

$msiHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $msiPath).Hash
$msiBytes = (Get-Item -LiteralPath $msiPath).Length
$lifecycleStatus = if ($SkipInstallTest) { 'not-run' } else { 'verified' }
Write-Host "MSI_INSTALLER_PASS path=$msiPath sha256=$msiHash bytes=$msiBytes version=$ProductVersion files=$($payloadEntries.Count) compression=embedded-cab-high installProperty=INSTALLFOLDER launchPolicy=finish-dialog-opt-in checkboxDefault=unchecked launchPolicyValidation=verified silentNoLaunch=$lifecycleStatus gracefulShutdown=$lifecycleStatus manualLaunch=$lifecycleStatus windowsSigning=unsigned"
