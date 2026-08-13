[CmdletBinding()]
param(
    [string]$ArtifactsDir
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
if ([string]::IsNullOrWhiteSpace($ArtifactsDir)) {
    $ArtifactsDir = Join-Path $ProjectRoot "artifacts"
} else {
    $ArtifactsDir = [IO.Path]::GetFullPath($ArtifactsDir)
}
[IO.Directory]::CreateDirectory($ArtifactsDir) | Out-Null

$stage = [IO.Path]::GetFullPath((Join-Path $ArtifactsDir "Kaigen-source"))
$artifactsRoot = [IO.Path]::GetFullPath($ArtifactsDir).TrimEnd('\') + '\'
if (-not $stage.StartsWith($artifactsRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to create source staging outside artifacts: $stage"
}
if (Test-Path -LiteralPath $stage) { [IO.Directory]::Delete($stage, $true) }
[IO.Directory]::CreateDirectory($stage) | Out-Null

$sourceFiles = @(
    Get-ChildItem -LiteralPath $ProjectRoot -File -Force | Where-Object { $_.Extension -notin @(".zip", ".tox", ".db") }
)
$sourceDirectories = @(
    ".github", ".vscode", "cmake", "docs", "packaging", "public", "runtime", "scripts", "src",
    "src-tauri\capabilities", "src-tauri\gen", "src-tauri\icons", "src-tauri\src",
    "vendor\mlkem-native-1.3.0"
)
foreach ($relativeDirectory in $sourceDirectories) {
    $directory = Join-Path $ProjectRoot $relativeDirectory
    if (Test-Path -LiteralPath $directory) {
        $sourceFiles += Get-ChildItem -LiteralPath $directory -File -Recurse -Force
    }
}
$sourceFiles += Get-ChildItem -LiteralPath (Join-Path $ProjectRoot "src-tauri") -File -Force

foreach ($file in $sourceFiles) {
    $relative = $file.FullName.Substring($ProjectRoot.Length + 1)
    $destination = Join-Path $stage $relative
    [IO.Directory]::CreateDirectory((Split-Path -Parent $destination)) | Out-Null
    Copy-Item -LiteralPath $file.FullName -Destination $destination
}

$zipPath = Join-Path $ArtifactsDir "Kaigen-source-github.zip"
Compress-Archive -LiteralPath $stage -DestinationPath $zipPath -CompressionLevel Optimal -Force
$zipHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $zipPath).Hash
Write-Host "Source archive: $zipPath"
Write-Host "SHA-256: $zipHash"
