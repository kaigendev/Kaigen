[CmdletBinding()]
param(
    [string]$ArtifactsDir,
    [string]$GitRevision
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

$artifactsRoot = [IO.Path]::GetFullPath($ArtifactsDir).TrimEnd('\') + '\'
$zipPath = [IO.Path]::GetFullPath((Join-Path $ArtifactsDir "Kaigen-source-github.zip"))
if (-not $zipPath.StartsWith($artifactsRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to create the source archive outside artifacts: $zipPath"
}

$gitCommand = Get-Command git.exe -ErrorAction SilentlyContinue
if (-not $gitCommand) { $gitCommand = Get-Command git -ErrorAction SilentlyContinue }
if (-not $gitCommand) { throw "git was not found; a source archive must be selected from an exact Git tree." }

if ([string]::IsNullOrWhiteSpace($GitRevision)) {
    $sourceRelativePaths = @(& $gitCommand.Source -C $ProjectRoot ls-files --cached)
    if ($LASTEXITCODE -ne 0) { throw "git ls-files failed while selecting the index tree." }
    $treeish = [string](& $gitCommand.Source -C $ProjectRoot write-tree)
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($treeish)) {
        throw "git write-tree failed; the source archive requires a valid index tree."
    }
    $treeish = $treeish.Trim()
    $treeDescription = "index tree $treeish"
} else {
    $treeish = [string](& $gitCommand.Source -C $ProjectRoot rev-parse --verify "$GitRevision`^{tree}")
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($treeish)) {
        throw "Git revision does not resolve to a tree: $GitRevision"
    }
    $treeish = $treeish.Trim()
    $sourceRelativePaths = @(& $gitCommand.Source -C $ProjectRoot ls-tree -r --name-only $treeish)
    if ($LASTEXITCODE -ne 0) { throw "git ls-tree failed while selecting revision $GitRevision." }
    $treeDescription = "revision $GitRevision (tree $treeish)"
}

$localOnlyPaths = @(
    "AGENTS.md",
    "docs/CHAT-BEHAVIOR.md",
    "docs/TESTING.md",
    "docs/TEST-BASELINE.md"
)
$localOnlyPrefixes = @("continuation.local/", "context.local/")
$localSecretFileNames = @("kaigen_vm_ed25519")
foreach ($relativePath in $sourceRelativePaths) {
    $normalizedPath = $relativePath.Replace('\', '/')
    $leafName = [IO.Path]::GetFileName($normalizedPath)
    $isLocalOnly = ($localOnlyPaths -contains $normalizedPath) -or
        ($localSecretFileNames -contains $leafName) -or
        $leafName.StartsWith("credentials.local.", [StringComparison]::OrdinalIgnoreCase) -or
        $leafName.EndsWith(".credential.xml", [StringComparison]::OrdinalIgnoreCase)
    foreach ($prefix in $localOnlyPrefixes) {
        if ($normalizedPath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
            $isLocalOnly = $true
            break
        }
    }
    if ($isLocalOnly) { throw "A local or private path was selected for the public source archive: $relativePath" }
}

if (Test-Path -LiteralPath $zipPath) { [IO.File]::Delete($zipPath) }
& $gitCommand.Source -C $ProjectRoot archive --format=zip "--output=$zipPath" $treeish
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $zipPath -PathType Leaf)) {
    throw "git archive failed for $treeDescription."
}
$sha256 = [Security.Cryptography.SHA256]::Create()
$zipStream = [IO.File]::OpenRead($zipPath)
try {
    $zipHash = [BitConverter]::ToString($sha256.ComputeHash($zipStream)).Replace("-", "")
} finally {
    $zipStream.Dispose()
    $sha256.Dispose()
}
Write-Host "Source archive: $zipPath"
Write-Host "Source tree: $treeDescription"
Write-Host "SHA-256: $zipHash"
