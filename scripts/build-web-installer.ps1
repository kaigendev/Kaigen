#requires -Version 7.6.4
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ReleaseLabel,
    [string]$BackendBinary = 'web/kaigen-webd/target/release/kaigen-webd',
    [string]$ToxcoreLibrary = 'work/platform/linux/toxcore/lib/libtoxcore.so.2.23.0',
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
if ($PSVersionTable.PSVersion.ToString() -cne '7.6.4') { throw 'Exact PowerShell 7.6.4 is required.' }
if ($ReleaseLabel -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$') { throw 'ReleaseLabel is invalid.' }

$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if ([IO.Path]::GetFullPath((Get-Location).Path) -cne $projectRoot) { throw 'Run from the canonical source root.' }
$backend = [IO.Path]::GetFullPath((Join-Path $projectRoot $BackendBinary))
$toxcore = [IO.Path]::GetFullPath((Join-Path $projectRoot $ToxcoreLibrary))
$ui = [IO.Path]::GetFullPath((Join-Path $projectRoot $WebUiRoot))
$artifacts = [IO.Path]::GetFullPath((Join-Path $projectRoot $ArtifactsDir))
$installer = Join-Path $projectRoot 'web/installer/install-kaigen-web.sh'
foreach ($required in @($backend, $toxcore, (Join-Path $ui 'index.html'), $installer)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Required Web installer input is missing: $required" }
}
[IO.Directory]::CreateDirectory($artifacts) | Out-Null
$staging = Join-Path $artifacts ".web-installer-$ReleaseLabel-$PID"
$archive = Join-Path $artifacts "Kaigen-Web-Debian13-Nginx-$ReleaseLabel.tar.gz"
if (Test-Path -LiteralPath $staging) { throw 'Web installer staging directory already exists.' }
if (Test-Path -LiteralPath $archive) { throw 'Web installer archive already exists.' }

function Get-RelativePosixPath {
    param([Parameter(Mandatory)][string]$Base, [Parameter(Mandatory)][string]$Path)
    [IO.Path]::GetRelativePath($Base, $Path).Replace('\', '/')
}

try {
    $payload = Join-Path $staging 'payload'
    $payloadBin = Join-Path $payload 'bin'
    $payloadLib = Join-Path $payload 'lib/Kaigen'
    $payloadUi = Join-Path $payload 'ui'
    [IO.Directory]::CreateDirectory($payloadBin) | Out-Null
    [IO.Directory]::CreateDirectory($payloadLib) | Out-Null
    [IO.Directory]::CreateDirectory($payloadUi) | Out-Null
    Copy-Item -LiteralPath $backend -Destination (Join-Path $payloadBin 'kaigen-webd')
    Copy-Item -LiteralPath $toxcore -Destination (Join-Path $payloadLib 'libtoxcore.so.2.23.0')
    Copy-Item -LiteralPath $installer -Destination (Join-Path $staging 'install-kaigen-web.sh')
    Copy-Item -LiteralPath (Join-Path $projectRoot 'web/installer/README.md') -Destination (Join-Path $staging 'README.md')
    foreach ($entry in @(Get-ChildItem -LiteralPath $ui -Force)) {
        Copy-Item -LiteralPath $entry.FullName -Destination $payloadUi -Recurse
    }
    if (-not $IsWindows) {
        $chmod = (Get-Command chmod -CommandType Application -ErrorAction Stop).Source
        & $chmod '0755' (Join-Path $payloadBin 'kaigen-webd') (Join-Path $staging 'install-kaigen-web.sh')
        if ($LASTEXITCODE -ne 0) { throw 'chmod failed for Web installer executables.' }
    }
    [IO.File]::WriteAllText((Join-Path $staging 'release-id'), "$ReleaseLabel`n", $utf8NoBom)

    $manifestFiles = @(Get-ChildItem -LiteralPath $staging -Recurse -File | Where-Object Name -ne 'manifest.sha256' | Sort-Object FullName)
    $manifestLines = foreach ($file in $manifestFiles) {
        $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $file.FullName).Hash.ToLowerInvariant()
        $relative = Get-RelativePosixPath -Base $staging -Path $file.FullName
        if ($relative -match '(^/|(^|/)\.\.(/|$)|\\)') { throw 'Unsafe manifest path.' }
        "$hash  $relative"
    }
    [IO.File]::WriteAllText((Join-Path $staging 'manifest.sha256'), (($manifestLines -join "`n") + "`n"), $utf8NoBom)

    $tar = (Get-Command tar -CommandType Application -ErrorAction Stop).Source
    & $tar '-czf' $archive '-C' $staging '.'
    if ($LASTEXITCODE -ne 0) { throw 'tar failed while building the Web installer archive.' }
    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash
    "WEB_INSTALLER_BUNDLE_PASS archive=$archive sha256=$hash"
} finally {
    if (Test-Path -LiteralPath $staging) {
        $resolved = [IO.Path]::GetFullPath($staging)
        if (-not $resolved.StartsWith($artifacts.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Refusing to clean Web installer staging outside artifacts.'
        }
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
