#requires -Version 7.6.5
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ReleaseLabel,
    [string]$BuildId = $env:KAIGEN_WEB_BUILD_ID,
    [string]$BackendBinary = 'web/kaigen-webd/target/release/kaigen-webd',
    [string]$ToxcoreLibrary = 'work/platform/linux/toxcore/lib/libtoxcore.so.2.24.0',
    [string]$TorBundleRoot = 'work/platform/linux/TorExpertBundle',
    [string]$SqlcipherRuntimeRoot = 'work/platform/linux/qtox-import',
    [string]$WebUiRoot = 'dist-web',
    [string]$ArtifactsDir = 'artifacts'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$utf8NoBom = [Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = $utf8NoBom
[Console]::OutputEncoding = $utf8NoBom
$OutputEncoding = $utf8NoBom
$PSNativeCommandArgumentPassing = 'Standard'
if ($PSVersionTable.PSVersion.ToString() -cne '7.6.5') { throw 'Exact PowerShell 7.6.5 is required.' }
if ($ReleaseLabel -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$') { throw 'ReleaseLabel is invalid.' }
if ($BuildId -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._-]{11,79}$') { throw 'BuildId is invalid.' }

$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if ([IO.Path]::GetFullPath((Get-Location).Path) -cne $projectRoot) { throw 'Run from the canonical source root.' }
$backend = [IO.Path]::GetFullPath((Join-Path $projectRoot $BackendBinary))
$toxcore = [IO.Path]::GetFullPath((Join-Path $projectRoot $ToxcoreLibrary))
$torBundle = [IO.Path]::GetFullPath((Join-Path $projectRoot $TorBundleRoot))
$sqlcipherRuntime = [IO.Path]::GetFullPath((Join-Path $projectRoot $SqlcipherRuntimeRoot))
$ui = [IO.Path]::GetFullPath((Join-Path $projectRoot $WebUiRoot))
$artifacts = [IO.Path]::GetFullPath((Join-Path $projectRoot $ArtifactsDir))
$installer = Join-Path $projectRoot 'web/installer/install-kaigen-web.sh'
$canonicalInstaller = Join-Path $projectRoot 'kaigenweb.sh'
$uiBuildIdentity = Join-Path $ui 'kaigen-build-id'
foreach ($required in @($backend, $toxcore, (Join-Path $ui 'index.html'), $uiBuildIdentity, $installer, $canonicalInstaller)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Required Web installer input is missing: $required" }
}
# The provider is a Linux build output, not the Windows runtime directory.
if (-not $sqlcipherRuntime.StartsWith($projectRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::Ordinal)) {
    throw 'SQLCipher runtime must be inside the source owner.'
}
$providerDirectory = $sqlcipherRuntime
while ($providerDirectory -cne $projectRoot) {
    $item = Get-Item -LiteralPath $providerDirectory -Force
    if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'SQLCipher runtime directory must be a regular directory.'
    }
    $providerDirectory = [IO.Path]::GetDirectoryName($providerDirectory)
}
foreach ($name in @('libsqlcipher.so', 'provenance.json', 'README.txt')) {
    $item = Get-Item -LiteralPath (Join-Path $sqlcipherRuntime $name) -Force
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.Length -le 0) {
        throw 'SQLCipher runtime input must be a nonempty regular file.'
    }
}
$provider = Get-Content -LiteralPath (Join-Path $sqlcipherRuntime 'provenance.json') -Raw | ConvertFrom-Json
if ($provider.schemaVersion -ne 1 -or $provider.platform -cne 'linux-x86_64-debian13') {
    throw 'SQLCipher Linux provenance is invalid.'
}
foreach ($entry in @(
    @{ Name = 'libsqlcipher.so'; Pin = $provider.runtime },
    @{ Name = 'README.txt'; Pin = $provider.readme }
)) {
    $file = Get-Item -LiteralPath (Join-Path $sqlcipherRuntime $entry.Name)
    if ($file.Length -ne $entry.Pin.size -or
        (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant() -cne $entry.Pin.sha256) {
        throw 'SQLCipher runtime provenance identity mismatch.'
    }
}
$expectedUiBuildIdentity = $utf8NoBom.GetBytes("$BuildId`n")
$actualUiBuildIdentity = [IO.File]::ReadAllBytes($uiBuildIdentity)
if (-not [Linq.Enumerable]::SequenceEqual[byte]($actualUiBuildIdentity, $expectedUiBuildIdentity)) {
    throw 'Web UI build identity does not exactly match BuildId.'
}
if (-not (Test-Path -LiteralPath $torBundle -PathType Container)) {
    throw "Required Web installer Tor bundle is missing: $torBundle"
}
foreach ($relative in @(
    'tor/tor',
    'tor/pluggable_transports/lyrebird',
    'tor/pluggable_transports/conjure-client',
    'tor/pluggable_transports/pt_config.json',
    'data/geoip',
    'data/geoip6'
)) {
    $required = Join-Path $torBundle $relative
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "Required Web installer Tor runtime file is missing: $required"
    }
}
[IO.Directory]::CreateDirectory($artifacts) | Out-Null
$staging = Join-Path $artifacts ".web-installer-$ReleaseLabel-$PID"
$archive = Join-Path $artifacts "Kaigen-Web-Debian13-Nginx-$ReleaseLabel.tar.gz"
$bootstrap = Join-Path $artifacts "Kaigen-Web-Installer-$ReleaseLabel.sh"
if (Test-Path -LiteralPath $staging) { throw 'Web installer staging directory already exists.' }
if (Test-Path -LiteralPath $archive) { throw 'Web installer archive already exists.' }
if (Test-Path -LiteralPath $bootstrap) { throw 'Web bootstrap installer already exists.' }

function Get-RelativePosixPath {
    param([Parameter(Mandatory)][string]$Base, [Parameter(Mandatory)][string]$Path)
    [IO.Path]::GetRelativePath($Base, $Path).Replace('\', '/')
}

function Test-PathWithinBase {
    param([Parameter(Mandatory)][string]$Base, [Parameter(Mandatory)][string]$Path)

    $relative = [IO.Path]::GetRelativePath($Base, $Path)
    if ([IO.Path]::IsPathRooted($relative) -or $relative -eq '.' -or $relative -eq '..') {
        return $false
    }
    foreach ($separator in @([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) | Select-Object -Unique) {
        if ($relative.StartsWith("..$separator", [StringComparison]::Ordinal)) {
            return $false
        }
    }
    return $true
}

function Resolve-KaigenNativeCommand {
    param([Parameter(Mandatory)][string]$Name)

    $command = Get-Command -Name $Name -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($null -eq $command) {
        throw "Required native command was not found: $Name"
    }
    return [IO.Path]::GetFullPath([string]$command.Source)
}

try {
    $payload = Join-Path $staging 'payload'
    $payloadBin = Join-Path $payload 'bin'
    $payloadLib = Join-Path $payload 'lib/Kaigen'
    $payloadTor = Join-Path $payload 'TorExpertBundle'
    $payloadUi = Join-Path $payload 'ui'
    $payloadSqlcipher = Join-Path $payload 'runtime/qtox-import'
    [IO.Directory]::CreateDirectory($payloadBin) | Out-Null
    [IO.Directory]::CreateDirectory($payloadLib) | Out-Null
    [IO.Directory]::CreateDirectory($payloadTor) | Out-Null
    [IO.Directory]::CreateDirectory($payloadUi) | Out-Null
    [IO.Directory]::CreateDirectory($payloadSqlcipher) | Out-Null
    foreach ($name in @('libsqlcipher.so', 'provenance.json', 'README.txt')) {
        Copy-Item -LiteralPath (Join-Path $sqlcipherRuntime $name) -Destination (Join-Path $payloadSqlcipher $name)
    }
    Copy-Item -LiteralPath $backend -Destination (Join-Path $payloadBin 'kaigen-webd')
    Copy-Item -LiteralPath $toxcore -Destination (Join-Path $payloadLib 'libtoxcore.so.2.24.0')
    foreach ($entry in @(Get-ChildItem -LiteralPath $torBundle -Force)) {
        Copy-Item -LiteralPath $entry.FullName -Destination $payloadTor -Recurse
    }
    Copy-Item -LiteralPath $installer -Destination (Join-Path $staging 'install-kaigen-web.sh')
    Copy-Item -LiteralPath (Join-Path $projectRoot 'web/installer/README.md') -Destination (Join-Path $staging 'README.md')
    foreach ($entry in @(Get-ChildItem -LiteralPath $ui -Force)) {
        Copy-Item -LiteralPath $entry.FullName -Destination $payloadUi -Recurse
    }
    if (-not $IsWindows) {
        $chmod = Resolve-KaigenNativeCommand -Name 'chmod'
        $executablePaths = @(
            (Join-Path $payloadBin 'kaigen-webd'),
            (Join-Path $payloadTor 'tor/tor'),
            (Join-Path $payloadTor 'tor/pluggable_transports/lyrebird'),
            (Join-Path $payloadTor 'tor/pluggable_transports/conjure-client'),
            (Join-Path $staging 'install-kaigen-web.sh')
        )
        & $chmod '0755' @executablePaths
        if ($LASTEXITCODE -ne 0) { throw 'chmod failed for Web installer executables.' }
    }
    [IO.File]::WriteAllText((Join-Path $staging 'release-id'), "$BuildId`n", $utf8NoBom)

    $manifestFiles = @(Get-ChildItem -LiteralPath $staging -Recurse -File | Where-Object Name -ne 'manifest.sha256' | Sort-Object FullName)
    $manifestLines = foreach ($file in $manifestFiles) {
        $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $file.FullName).Hash.ToLowerInvariant()
        $relative = Get-RelativePosixPath -Base $staging -Path $file.FullName
        if ($relative -match '(^/|(^|/)\.\.(/|$)|\\)') { throw 'Unsafe manifest path.' }
        "$hash  $relative"
    }
    [IO.File]::WriteAllText((Join-Path $staging 'manifest.sha256'), (($manifestLines -join "`n") + "`n"), $utf8NoBom)

    $tar = Resolve-KaigenNativeCommand -Name 'tar'
    & $tar '-czf' $archive '-C' $staging '.'
    if ($LASTEXITCODE -ne 0) { throw 'tar failed while building the Web installer archive.' }
    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash.ToLowerInvariant()
    # One maintained source for every release; preserve the tested Bash bytes.
    Copy-Item -LiteralPath $canonicalInstaller -Destination $bootstrap
    $installerHash = (Get-FileHash -LiteralPath $canonicalInstaller -Algorithm SHA256).Hash
    if ((Get-FileHash -LiteralPath $bootstrap -Algorithm SHA256).Hash -cne $installerHash) {
        throw 'Published Web installer differs from canonical kaigenweb.sh.'
    }
    if (-not $IsWindows) {
        & $chmod '0755' $bootstrap
        if ($LASTEXITCODE -ne 0) { throw 'chmod failed for the Web bootstrap installer.' }
    }
    "WEB_INSTALLER_BUNDLE_PASS archive=$archive sha256=$hash bootstrap=$bootstrap"
} finally {
    if (Test-Path -LiteralPath $staging) {
        $resolved = [IO.Path]::GetFullPath($staging)
        if (-not (Test-PathWithinBase -Base $artifacts -Path $resolved)) {
            throw 'Refusing to clean Web installer staging outside artifacts.'
        }
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
