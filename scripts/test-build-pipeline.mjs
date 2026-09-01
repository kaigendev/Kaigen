import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const projectRoot = new URL("../", import.meta.url);
const packageJson = JSON.parse(await readFile(new URL("package.json", projectRoot), "utf8"));
const portableBuild = await readFile(new URL("scripts/build-portable.ps1", projectRoot), "utf8");
const dependencyPreparation = await readFile(new URL("scripts/prepare-dependencies.ps1", projectRoot), "utf8");
const unixDependencyPreparation = await readFile(new URL("scripts/prepare-unix-dependencies.sh", projectRoot), "utf8");
const sqlcipherRebuild = await readFile(new URL("scripts/rebuild-sqlcipher-runtime.ps1", projectRoot), "utf8");
const sqlcipherSmokeSource = await readFile(new URL("scripts/tests/sqlcipher-runtime-smoke.c", projectRoot), "utf8");
const sourceArchiveBuild = await readFile(new URL("scripts/build-source-archive.ps1", projectRoot), "utf8");
const webInstallerBuild = await readFile(new URL("scripts/build-web-installer.ps1", projectRoot), "utf8");
const windowsMsiBuild = await readFile(new URL("scripts/build-windows-msi.ps1", projectRoot), "utf8");
const automationEntryPoint = await readFile(new URL("scripts/Invoke-KaigenAutomation.ps1", projectRoot), "utf8");
const sourceArchivePrivacyTest = await readFile(new URL("scripts/test-source-archive-privacy.mjs", projectRoot), "utf8");
const windowsBuildWorkflow = await readFile(new URL(".github/workflows/build-windows.yml", projectRoot), "utf8");
const unixBuildWorkflow = await readFile(new URL(".github/workflows/build-unix.yml", projectRoot), "utf8");
const tauriConfig = JSON.parse(await readFile(new URL("src-tauri/tauri.conf.json", projectRoot), "utf8"));
const gitignore = await readFile(new URL(".gitignore", projectRoot), "utf8");
const gitattributes = await readFile(new URL(".gitattributes", projectRoot), "utf8");
const readme = await readFile(new URL("README.md", projectRoot), "utf8");
const cargoManifest = await readFile(new URL("src-tauri/Cargo.toml", projectRoot), "utf8");
const cargoLock = await readFile(new URL("src-tauri/Cargo.lock", projectRoot), "utf8");
const offlineLoopbackHarness = await readFile(new URL("scripts/test-offline-friend-request-loopback.ps1", projectRoot), "utf8");
const offlineLoopbackSource = await readFile(new URL("scripts/tests/offline-friend-request-loopback.c", projectRoot), "utf8");
const cargoAttributeOutput = execFileSync(
  "git",
  ["-c", "safe.directory=*", "-C", fileURLToPath(projectRoot), "check-attr", "eol", "--", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock"],
  { encoding: "utf8" },
);
const commandLines = portableBuild.split(/\r?\n/).map((line) => line.trim());

let assertionCount = 0;
function equal(actual, expected, message) {
  assert.equal(actual, expected, message);
  assertionCount += 1;
}
function deepEqual(actual, expected, message) {
  assert.deepEqual(actual, expected, message);
  assertionCount += 1;
}
function ok(value, message) {
  assert.ok(value, message);
  assertionCount += 1;
}

function trackedByteManifest(trackedPaths, fileBytes) {
  return new Map(
    trackedPaths
      .filter((trackedPath) => trackedPath !== "src-tauri/gen/schemas" && !trackedPath.startsWith("src-tauri/gen/schemas/"))
      .map((trackedPath) => [trackedPath, fileBytes.get(trackedPath) ?? "<missing>"]),
  );
}

function changedTrackedPaths(before, after) {
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((trackedPath) => before.get(trackedPath) !== after.get(trackedPath))
    .sort();
}

function parseNetstatUdpRows(output, processId) {
  return output
    .split(/\r?\n/u)
    .map((line) => line.trim().split(/\s+/u))
    .filter((fields) => fields.length >= 4 && fields[0].toUpperCase() === "UDP" && Number(fields.at(-1)) === processId)
    .map((fields) => {
      const endpoint = fields[1].match(/^(?<address>\[[^\]]+\]|[^:]+):(?<port>\d+)$/u);
      assert.ok(endpoint?.groups, "unparseable netstat fixture endpoint: " + fields[1]);
      return {
        localAddress: endpoint.groups.address.replace(/^\[|\]$/gu, ""),
        localPort: Number(endpoint.groups.port),
      };
    });
}

function areExpectedLoopbackEndpoints(endpoints) {
  return endpoints.length > 0 &&
    endpoints.every(({ localAddress, localPort }) =>
      localAddress === "127.0.0.1" && localPort >= 38400 && localPort <= 38431);
}

function capturePowerShell7ChildExit(exitCode) {
  const childCommand = Buffer.from("Start-Sleep -Milliseconds 200; exit " + exitCode, "utf16le").toString("base64");
  const fixture = [
    "$child = Start-Process -FilePath (Join-Path $PSHOME 'pwsh.exe') " +
      "-ArgumentList @('-NoProfile','-EncodedCommand','" + childCommand + "') -PassThru -WindowStyle Hidden",
    "$null = $child.Handle",
    "$child.WaitForExit()",
    "$child.Refresh()",
    "[Console]::Write($child.ExitCode)",
    "$child.Dispose()",
  ].join("; ");
  return Number(execFileSync(
    "pwsh.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", fixture],
    { encoding: "utf8" },
  ));
}

equal(packageJson.scripts?.["test:localization"], "node scripts/test-localization.mjs", "localization assertions must have a stable entry point");
equal(packageJson.scripts?.["test:app-layout"], "node scripts/test-app-layout.mjs", "app layout assertions must have a stable entry point");
equal(packageJson.scripts?.["test:contact-identity"], "node scripts/test-contact-identity.mjs", "contact identity assertions must have a stable entry point");
equal(packageJson.scripts?.["test:friend-resilience"], "node scripts/test-friend-resilience.mjs", "friend resilience assertions must have a stable entry point");
equal(packageJson.scripts?.["test:status-message"], "node scripts/test-status-message.mjs", "empty status assertions must have a stable entry point");
equal(packageJson.scripts?.["test:build-pipeline"], "node scripts/test-build-pipeline.mjs", "pipeline assertions must have a stable entry point");
equal(packageJson.scripts?.["test:component-inventory"], "node scripts/test-component-inventory.mjs", "component inventory assertions must have a stable entry point");
equal(packageJson.scripts?.["test:source-hygiene"], "node scripts/test-source-hygiene.mjs", "source hygiene assertions must have a stable entry point");
equal(packageJson.scripts?.["test:product-boundaries"], "node scripts/test-product-boundaries.mjs", "product boundary assertions must have a stable entry point");
equal(packageJson.scripts?.["test:platform-runtime"], "node scripts/test-platform-runtime.mjs", "platform runtime assertions must have a stable entry point");
equal(packageJson.scripts?.["test:browser-runtime"], "node scripts/test-browser-runtime.mjs", "browser runtime assertions must have a stable entry point");
equal(packageJson.scripts?.["test:web-content-security"], "node scripts/test-web-content-security.mjs", "Web content security assertions must have a stable entry point");
equal(packageJson.scripts?.["test:built-content-security"], "node scripts/test-built-content-security.mjs", "built content security assertions must have a stable entry point");
equal(packageJson.scripts?.["test:source-archive-privacy"], "node scripts/test-source-archive-privacy.mjs", "source-archive privacy assertions must have a stable entry point");
ok(
  automationEntryPoint.startsWith("#requires -Version 7.6.4") &&
    automationEntryPoint.includes("[Console]::OutputEncoding = $utf8NoBom") &&
    automationEntryPoint.includes("$OutputEncoding = $utf8NoBom") &&
    automationEntryPoint.includes("$PSVersionTable.PSVersion.ToString() -cne '7.6.4'") &&
    automationEntryPoint.includes("& $FilePath @ArgumentList") &&
    automationEntryPoint.includes("'debian-build'") &&
    automationEntryPoint.includes("'macos-build'") &&
    automationEntryPoint.includes("Resolve-KaigenNativeCommand -Name 'bash'"),
  "the canonical automation entry point must pin PowerShell 7.6.4, force UTF-8 and delegate Unix builds through argument-array native runners",
);
ok(
  /'web-gates' \{[\s\S]*?@\('run', 'build'\)[\s\S]*?@\('run', 'build:web'\)[\s\S]*?@\('run', 'test:built-content-security'\)[\s\S]*?@\('run', 'test:product-bundles'\)/u.test(automationEntryPoint),
  "the clean-checkout Web gate must build both desktop and Web bundles, inspect their emitted HTML, and then compare product boundaries",
);
ok(
  [portableBuild, dependencyPreparation, sqlcipherRebuild, sourceArchiveBuild, windowsMsiBuild, offlineLoopbackHarness]
    .every((script) => script.startsWith("#requires -Version 7.6.4") &&
      script.includes("[Console]::OutputEncoding = $utf8NoBom") &&
      script.includes("$OutputEncoding = $utf8NoBom")),
  "first-party Windows build and native-test scripts must fail closed outside pinned UTF-8 PowerShell 7.6.4",
);
ok(
  portableBuild.includes("$devCommand = 'call \"' + $vsDevCmd + '\" -arch=x64 -host_arch=x64 >nul && set'") &&
    portableBuild.includes("work\\cmd-staging") &&
    portableBuild.includes("[Text.Encoding]::ASCII") &&
    portableBuild.includes("& $cmdExecutable /d /s /c $devCommandFile") &&
    portableBuild.includes("[IO.File]::Delete($devCommandFile)"),
  "the pinned PowerShell 7 Windows build must cross the required batch boundary through bounded ASCII staging with exact cleanup",
);
ok(
  sourceArchivePrivacyTest.includes('const powershell = "pwsh";') &&
    !sourceArchivePrivacyTest.includes('"powershell.exe"'),
  "source-archive fixtures must use PowerShell 7 on every platform",
);
ok(
  /PowerShell\s+--version 7\.6\.4/u.test(windowsBuildWorkflow) &&
    windowsBuildWorkflow.includes('"${{ runner.temp }}\\kaigen-pwsh\\pwsh.exe"') &&
    windowsBuildWorkflow.includes('echo ${{ runner.temp }}\\kaigen-pwsh>>"%GITHUB_PATH%"') &&
    /-NoLogo -NoProfile -NonInteractive\s+-File scripts\\Invoke-KaigenAutomation\.ps1/u.test(windowsBuildWorkflow) &&
    /Invoke-KaigenAutomation\.ps1\s+-Task windows-portable/u.test(windowsBuildWorkflow) &&
    windowsBuildWorkflow.includes("shell: cmd") &&
    !windowsBuildWorkflow.includes("shell: powershell"),
  "Windows CI must install pinned PowerShell 7.6.4 and run through the canonical entry point without Windows PowerShell 5",
);
ok(
  windowsMsiBuild.includes('"Kaigen.exe"') &&
    windowsMsiBuild.includes('$ReleaseLabel = $manifestVersion') &&
    !windowsMsiBuild.includes('[string]$ReleaseLabel = "web.RC2"') &&
    windowsMsiBuild.includes("(?:[+](?<build>\\d+))?") &&
    windowsMsiBuild.includes('$Matches.ContainsKey("build")') &&
    windowsMsiBuild.includes('"WebView2Runtime\\msedgewebview2.exe"') &&
    windowsMsiBuild.includes('$_.Extension -in @(".tox", ".kai")') &&
    windowsMsiBuild.includes('$_.Name -in @("profiles.json", "proxy-settings.json", "tor-settings.json")') &&
    windowsMsiBuild.includes('<MediaTemplate EmbedCab="yes" CompressionLevel="high" />') &&
    windowsMsiBuild.includes('<Property Id="WIXUI_INSTALLDIR" Value="INSTALLFOLDER" />') &&
    windowsMsiBuild.includes('<Property Id="INSTALLFOLDER">') &&
    windowsMsiBuild.includes('Name="InstallFolder" Type="raw" Win64="yes"') &&
    !windowsMsiBuild.includes('<Property Id="ARPNOMODIFY"') &&
    windowsMsiBuild.includes('<UIRef Id="WixUI_InstallDir" />') &&
    windowsMsiBuild.includes('<RegistryValue Root="HKCU" Key="Software\\Kaigen\\Installer\\Files"') &&
    windowsMsiBuild.includes('<RegistryValue Root="HKCU" Key="Software\\Kaigen\\Installer\\Folders"') &&
    windowsMsiBuild.includes('Name="InstallFolder" Type="string" Value="[INSTALLFOLDER]" KeyPath="yes"') &&
    windowsMsiBuild.includes('<RemoveFolder Id="{0}" On="uninstall" />') &&
    windowsMsiBuild.includes('"System32\\msiexec.exe"') &&
    windowsMsiBuild.includes('INSTALLFOLDER=$quotedInstallRoot') &&
    windowsMsiBuild.includes('$uninstallArguments = "/x $quotedMsi /qn /norestart') &&
    !windowsMsiBuild.includes('1605, 3010') &&
    windowsMsiBuild.includes('Disposable MSI uninstall left packaged files behind') &&
    windowsMsiBuild.includes('Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName') &&
    windowsMsiBuild.includes('$candlePath = if ($candle -is [IO.FileInfo])') &&
    windowsMsiBuild.includes('$wixBin = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($candlePath))') &&
    !windowsMsiBuild.includes('$candle.Directory.FullName'),
  "the MSI builder must package only a privacy-checked portable tree into a high-compression embedded CAB and verify a user-selected install directory byte-for-byte",
);
ok(
  /-File scripts\\build-windows-msi\.ps1\s+-PortableRoot artifacts\\Kaigen-portable\s+-ArtifactsDir artifacts/u.test(windowsBuildWorkflow) &&
    windowsBuildWorkflow.includes("name: Kaigen-installer-windows-x64") &&
    windowsBuildWorkflow.includes("artifacts/Kaigen-installer-windows-x64.msi") &&
    windowsBuildWorkflow.includes("artifacts/Kaigen-installer-windows-x64.manifest.json"),
  "Windows CI must build, install-test, and publish the MSI beside the portable ZIP",
);
ok(
  windowsBuildWorkflow.includes("name: Kaigen-source-github") &&
    windowsBuildWorkflow.includes("path: artifacts/Kaigen-source-github.zip"),
  "Windows CI must publish the public source archive produced from the same immutable release tree",
);
ok(
  unixBuildWorkflow.includes("web-debian13-nginx:") &&
    unixBuildWorkflow.includes("KAIGEN_RELEASE_LABEL: 0.2.3") &&
    unixBuildWorkflow.includes("./scripts/prepare-unix-dependencies.sh linux") &&
    unixBuildWorkflow.includes("-Task web-gates") &&
    unixBuildWorkflow.includes("-Task web-installer-tests") &&
    unixBuildWorkflow.includes("cargo test --locked --manifest-path web/kaigen-webd/Cargo.toml") &&
    unixBuildWorkflow.includes("-Task web-installer-bundle") &&
    unixBuildWorkflow.includes('echo "$RUNNER_TEMP/kaigen-pwsh" >> "$GITHUB_PATH"') &&
    unixBuildWorkflow.includes("sha256sum -c manifest.sha256") &&
    unixBuildWorkflow.includes('test -x "$staging/payload/TorExpertBundle/tor/tor"') &&
    unixBuildWorkflow.includes('test -x "$staging/payload/TorExpertBundle/tor/pluggable_transports/lyrebird"') &&
    unixBuildWorkflow.includes("name: Kaigen-Web-Debian13-Nginx-0.2.3"),
  "Unix CI must build, test, integrity-check, and publish the Web release bundle",
);
ok(
  webInstallerBuild.includes("[string]$TorBundleRoot = 'work/platform/linux/TorExpertBundle'") &&
    webInstallerBuild.includes("'tor/pluggable_transports/lyrebird'") &&
    webInstallerBuild.includes("'tor/pluggable_transports/pt_config.json'") &&
    webInstallerBuild.includes("Copy-Item -LiteralPath $entry.FullName -Destination $payloadTor -Recurse"),
  "the Web installer bundle must carry the pinned Tor runtime and obfs4 transport beside kaigen-webd",
);
ok(
  unixDependencyPreparation.includes('component_cache_root="${KAIGEN_COMPONENT_CACHE_ROOT:-}"') &&
    unixDependencyPreparation.includes('allow_network_component_fetch="${KAIGEN_ALLOW_NETWORK_COMPONENT_FETCH:-0}"') &&
    unixDependencyPreparation.includes("KAIGEN_COMPONENT_UPDATE_SCOPE:-} != all-managed-components") &&
    unixDependencyPreparation.indexOf('if [[ "$allow_network_component_fetch" != 1 ]]') < unixDependencyPreparation.indexOf("curl --fail --location") &&
    unixDependencyPreparation.includes("assert_file_identity") &&
    unixDependencyPreparation.includes("Network fallback is disabled outside the explicit Kaigen component-update route"),
  "ordinary Unix dependency preparation must be canonical-cache-only with update-gated network retrieval",
);
ok(
  unixDependencyPreparation.includes("git -C \"$1\" add --all") &&
    unixDependencyPreparation.includes("git -C \"$1\" ls-files --stage -z") &&
    unixDependencyPreparation.includes("100755|120000)") &&
    unixDependencyPreparation.includes('git -C "$1" update-index --cacheinfo "100644,$object,$path"') &&
    unixDependencyPreparation.indexOf('git -C "$1" add --all') <
      unixDependencyPreparation.indexOf('git -C "$1" update-index --cacheinfo "100644,$object,$path"') &&
    unixDependencyPreparation.indexOf('git -C "$1" update-index --cacheinfo "100644,$object,$path"') <
      unixDependencyPreparation.indexOf('git -C "$1" write-tree'),
  "Unix c-toxcore tree checks must normalize archive-only executable and symlink modes in the ephemeral index",
);
deepEqual(
  packageJson.scripts?.["test:frontend"]?.split(/\s*&&\s*/),
  ["npm run test:chat-navigation", "npm run test:app-layout", "npm run test:contact-identity", "npm run test:friend-resilience", "npm run test:localization", "npm run test:status-message", "npm run test:component-inventory", "npm run test:source-hygiene", "npm run test:product-boundaries", "npm run test:build-pipeline", "npm run test:platform-runtime", "npm run test:browser-runtime", "npm run test:web-content-security", "npm run test:resource-bounds", "npm run test:web-installer", "npm run test:source-archive-privacy"],
  "the canonical frontend suite must run navigation, app layout, contact identity, friend resilience, localization, empty status, component inventory, source hygiene, product boundaries, pipeline, platform runtime, browser runtime, Web content security, resource bounds, Web installer, and source-archive privacy assertions once each",
);

const frontendCommands = commandLines.filter((line) => /^&\s+npm\.cmd\s+run\s+test:frontend\s*$/i.test(line));
const rustCommands = commandLines.filter((line) => /^&\s+cargo\s+test(?:\s|$)/i.test(line));
const tauriCommands = commandLines.filter((line) => /^&\s+npm\.cmd\s+run\s+tauri\s+--\s+build\s+--no-bundle\s*$/i.test(line));
const builtContentSecurityCommands = commandLines.filter((line) => /^&\s+npm\.cmd\s+run\s+test:built-content-security\s+--\s+dist\s*$/i.test(line));
const directFrontendBuilds = commandLines.filter((line) => /^&\s+npm\.cmd\s+run\s+build(?:\s|$)/i.test(line));
const toxcoreRetryCommands = commandLines.filter((line) => line.includes('test-toxcore-retry-cap.ps1'));
const offlineFriendRequestCommands = commandLines.filter((line) => line.includes('test-offline-friend-request-loopback.ps1'));

equal(frontendCommands.length, 1, "the portable build must run the canonical frontend suite exactly once");
equal(rustCommands.length, 1, "the portable build must run Rust tests exactly once");
ok(rustCommands[0]?.includes("--locked"), "the Rust test run must honor Cargo.lock");
ok(rustCommands[0]?.includes("--lib"), "the Rust test run must select the platform library suite");
equal(tauriCommands.length, 1, "the portable build must invoke the Tauri production build exactly once");
equal(builtContentSecurityCommands.length, 1, "the portable build must inspect emitted desktop and Web HTML exactly once");
equal(toxcoreRetryCommands.length, 1, "the portable build must run the toxcore retry-cap regression exactly once");
equal(offlineFriendRequestCommands.length, 1, "the portable build must run the native offline friend-request loopback exactly once");
const asciiReentryOffset = portableBuild.indexOf("if ($ProjectRoot -match '[^\\x00-\\x7F]')");
const trackedByteBaselineOffset = portableBuild.indexOf("$trackedWorktreeBeforeBuild = Get-TrackedWorktreeByteManifest");
ok(
  asciiReentryOffset >= 0 &&
    asciiReentryOffset < trackedByteBaselineOffset &&
    portableBuild.includes('KAIGEN_WINDOWS_BUILD_ASCII_REENTRY') &&
    portableBuild.includes("& $substPath $asciiAliasDrive $ProjectRoot") &&
    portableBuild.includes("Get-FileHash -Algorithm SHA256 -LiteralPath $aliasedScript") &&
    portableBuild.includes("& $aliasedScript @PSBoundParameters") &&
    portableBuild.includes("& $substPath $asciiAliasDrive /D"),
  "the Windows build must re-enter non-ASCII checkouts through a verified temporary ASCII alias before deriving native paths",
);
const rustPathRemapOffset = portableBuild.indexOf("$env:CARGO_ENCODED_RUSTFLAGS = $rustPathRemapFlags -join [char]0x1F");
const kaigenBinaryPrivacyGuardOffset = portableBuild.indexOf("Assert-BinaryDoesNotContainBuildHostPath -Path $kaigenExecutable");
ok(
  portableBuild.includes("[Environment+SpecialFolder]::UserProfile") &&
    portableBuild.includes("$userProfile = $env:USERPROFILE") &&
    portableBuild.includes("[IO.Path]::IsPathRooted($resolvedUserProfile)") &&
    portableBuild.includes("Test-Path -LiteralPath $resolvedUserProfile -PathType Container") &&
    portableBuild.includes("--remap-path-prefix=$ProjectRoot=C:\\KaigenRepro\\source") &&
    portableBuild.includes("--remap-path-prefix=$resolvedUserProfile=C:\\KaigenRepro\\user") &&
    portableBuild.includes("Inherited Rust flags are not allowed in the reproducible portable build") &&
    rustPathRemapOffset >= 0 &&
    rustPathRemapOffset < portableBuild.indexOf(rustCommands[0]) &&
    portableBuild.includes("Built binary contains a private build-host path marker") &&
    kaigenBinaryPrivacyGuardOffset > portableBuild.indexOf(tauriCommands[0]),
  "the Windows build must remap Rust source paths and reject a Kaigen binary that exposes its build-host user profile",
);

const frontendIndex = commandLines.indexOf(frontendCommands[0]);
const rustIndex = commandLines.indexOf(rustCommands[0]);
const tauriIndex = commandLines.indexOf(tauriCommands[0]);
const toxcoreExportCheckIndex = commandLines.findIndex((line) => line.includes("c-toxcore DLL is missing the required export"));
const toxcoreRetryIndex = commandLines.indexOf(toxcoreRetryCommands[0]);
const offlineFriendRequestIndex = commandLines.indexOf(offlineFriendRequestCommands[0]);
ok(
  toxcoreExportCheckIndex >= 0 &&
    toxcoreExportCheckIndex < toxcoreRetryIndex &&
    toxcoreExportCheckIndex < offlineFriendRequestIndex &&
    toxcoreRetryIndex < frontendIndex &&
    offlineFriendRequestIndex < frontendIndex,
  "native toxcore regressions must run after the built-DLL export check and before frontend, Rust, and Tauri",
);
ok(frontendIndex < rustIndex, "frontend assertions must finish before Rust tests begin");
ok(rustIndex < tauriIndex, "all regression tests must finish before the Tauri build begins");
equal(directFrontendBuilds.length, 0, "the portable script must not duplicate Tauri's frontend production build");
equal(tauriConfig.build?.beforeBuildCommand, "npm run build", "Tauri must remain the single owner of the frontend production build");
ok(
  dependencyPreparation.includes("[switch]$AllowNetworkComponentFetch") &&
    dependencyPreparation.indexOf("if (-not $AllowNetworkComponentFetch)") < dependencyPreparation.indexOf('Write-Host "Downloading $Uri"') &&
    dependencyPreparation.includes("[Net.SecurityProtocolType]::Tls12") &&
    dependencyPreparation.includes("Invoke-WebRequest") &&
    dependencyPreparation.includes("-TimeoutSec 300"),
  "network retrieval must be opt-in to component update before the bounded TLS 1.2 fallback",
);
ok(
  portableBuild.includes('[string]$ComponentCacheRoot = $env:KAIGEN_COMPONENT_CACHE_ROOT') &&
    portableBuild.includes('$env:NPM_CONFIG_OFFLINE = "true"') &&
    portableBuild.includes('$env:CARGO_NET_OFFLINE = "true"') &&
    portableBuild.includes("& npm.cmd ci --offline") &&
    dependencyPreparation.includes("Assert-FileIdentity") &&
    dependencyPreparation.includes("Using canonical local component") &&
    dependencyPreparation.includes("Network fallback is disabled outside the explicit Kaigen component-update route") &&
    dependencyPreparation.includes('KAIGEN_COMPONENT_UPDATE_SCOPE -cne "all-managed-components"') &&
    sqlcipherRebuild.includes("[switch]$AllowNetworkComponentFetch") &&
    sqlcipherRebuild.includes("KAIGEN_COMPONENT_UPDATE_SCOPE -cne 'all-managed-components'") &&
    sqlcipherRebuild.includes("has no reviewed exact size pin") &&
    sqlcipherRebuild.includes("Assert-FileIdentity") &&
    sqlcipherRebuild.includes("Using canonical local component") &&
    sqlcipherRebuild.indexOf("if (-not $AllowNetworkComponentFetch)") < sqlcipherRebuild.indexOf("& curl.exe") &&
    dependencyPreparation.includes("[Environment]::SystemDirectory") &&
    dependencyPreparation.includes('Get-Command -Name "curl.exe"') &&
    dependencyPreparation.includes("Select-Object -First 1") &&
    dependencyPreparation.includes("$curlPath = [string]$curlCommand.Source") &&
    !dependencyPreparation.includes("& $curl.Source") &&
    ["--fail", "--location", "--retry 5", "--connect-timeout 30", "--speed-time 60", "--max-time 1800"].every((option) => dependencyPreparation.includes(option)),
  "ordinary Windows builds must be local-only while explicit component-update downloads remain bounded",
);
ok(
  sqlcipherRebuild.includes("[string]$ScratchRoot = (Join-Path ([IO.Path]::GetTempPath()) 'KaigenSqlcipherRebuild')") &&
    sqlcipherRebuild.includes("$scratchRunRoot = Join-Path $resolvedScratchRoot 'canonical-build'") &&
    sqlcipherRebuild.includes("$scratchArchiveRoot = Join-Path $resolvedScratchRoot ('archive-' + $RunName)") &&
    sqlcipherRebuild.includes("$scratchParent -cne $resolvedScratchRoot -or $archiveParent -cne $resolvedScratchRoot") &&
    sqlcipherRebuild.includes("[IO.FileAttributes]::ReparsePoint") &&
    sqlcipherRebuild.includes("Move-Item -LiteralPath $scratchRunRoot -Destination $scratchArchiveRoot") &&
    sqlcipherRebuild.includes("SQLCipher scratch root must be an ASCII path without whitespace") &&
    sqlcipherRebuild.includes("$canonicalBuildPath = 'C:\\KaigenRepro\\build'") &&
    sqlcipherRebuild.includes("$deterministicPathMapFlags = '/experimental:deterministic /pathmap:'") &&
    sqlcipherRebuild.includes("$scratchRunRoot + '=' + $canonicalBuildPath") &&
    sqlcipherRebuild.includes("' && set \"CFLAGS=/W3 /wd4090 /nologo /O2 /Brepro\"'") &&
    sqlcipherRebuild.includes("' && set \"CL=' + $deterministicPathMapFlags + '\" && nmake /NOLOGO'") &&
    sqlcipherRebuild.includes("$opensslBuildRelative = '..\\openssl-3.5.7'") &&
    sqlcipherRebuild.includes("' \"TCCOPTS=/Brepro /I' + (Join-Path $opensslBuildRelative 'include') + '\"'") &&
    sqlcipherRebuild.includes("' \"LTLIBPATHS=/LIBPATH:' + $opensslBuildRelative + '\"'") &&
    sqlcipherRebuild.includes("$smokeData = Join-Path $scratchRunRoot 'smoke-data'") &&
    sqlcipherSmokeSource.includes('strncmp(cipher.value, "4.18.0", 6)') &&
    sqlcipherSmokeSource.includes('strcmp(sqlite3_libversion(), "3.53.4")') &&
    !sqlcipherRebuild.includes("(Join-Path $opensslSource 'include')"),
  "SQLCipher compilation and compiler-only OpenSSL paths must avoid whitespace and non-ASCII build-tool failures",
);
const curlDownload = dependencyPreparation.indexOf("& $curlPath");
const failedDownloadCleanup = dependencyPreparation.indexOf("[IO.File]::Delete([IO.Path]::GetFullPath($Destination))", curlDownload);
const webRequestFallback = dependencyPreparation.indexOf("Invoke-WebRequest -Uri", failedDownloadCleanup);
const fallbackHashCheck = dependencyPreparation.indexOf("Assert-FileIdentity -Path $Destination -ExpectedSize $ExpectedSize -ExpectedSha256 $Sha256", webRequestFallback);
ok(
  curlDownload >= 0 && curlDownload < failedDownloadCleanup && failedDownloadCleanup < webRequestFallback && webRequestFallback < fallbackHashCheck,
  "both update-only transports must discard partial data and converge on the same pinned size and SHA-256 check",
);
ok(
  packageJson.scripts?.["test:frontend"]?.includes("npm run test:source-hygiene") &&
    dependencyPreparation.indexOf("verify-source-hygiene.mjs") >= 0 &&
    dependencyPreparation.indexOf("verify-source-hygiene.mjs") < dependencyPreparation.indexOf("$WorkDir =") &&
    unixDependencyPreparation.indexOf("verify-source-hygiene.mjs") >= 0 &&
    unixDependencyPreparation.indexOf("verify-source-hygiene.mjs") < unixDependencyPreparation.indexOf("work_root="),
  "Windows, Unix, and the frontend baseline must reject legacy c-toxcore patch-series copies before build work",
);
ok(
  portableBuild.includes("CMAKE_HOME_DIRECTORY:INTERNAL") && portableBuild.includes("CMAKE_CACHEFILE_DIR:INTERNAL"),
  "the portable build must detect a CMake cache copied from another project path",
);
const relocatedCacheScopeGuard = portableBuild.indexOf("Refusing to discard a relocated CMake cache outside the project build directory");
const relocatedCacheDelete = portableBuild.indexOf("[IO.Directory]::Delete($toxBuild, $true)");
const toxcoreConfigure = portableBuild.indexOf("& $cmake -S $toxSource -B $toxBuild");
ok(relocatedCacheScopeGuard >= 0 && relocatedCacheScopeGuard < relocatedCacheDelete, "relocated cache deletion must be scoped to the project build directory");
ok(relocatedCacheDelete > relocatedCacheScopeGuard && relocatedCacheDelete < toxcoreConfigure, "a relocated CMake cache must be discarded before toxcore configuration");
ok(portableBuild.includes('.kaigen-project-root') && portableBuild.includes('$recordedProjectRoot -ne $ProjectRoot'), "the portable build must detect a Cargo target copied from another project path");
const relocatedCargoScopeGuard = portableBuild.indexOf("Refusing to discard a relocated Cargo target outside the project src-tauri directory");
const relocatedCargoDelete = portableBuild.indexOf("[IO.Directory]::Delete($cargoTarget, $true)");
const rustCommandOffset = portableBuild.indexOf(rustCommands[0]);
ok(relocatedCargoScopeGuard >= 0 && relocatedCargoScopeGuard < relocatedCargoDelete, "relocated Cargo target deletion must be scoped to project src-tauri");
ok(relocatedCargoDelete > relocatedCargoScopeGuard && relocatedCargoDelete < rustCommandOffset, "a relocated Cargo target must be discarded before Rust tests");
ok(
  portableBuild.includes("ls-files --cached --full-name") &&
    portableBuild.includes("Get-FileHash -Algorithm SHA256") &&
    portableBuild.includes('"<missing>"') &&
    portableBuild.includes('StartsWith("src-tauri/gen/schemas/"') &&
    !portableBuild.includes('StartsWith("src-tauri/gen/"') &&
    portableBuild.includes("Assert-TrackedWorktreeByteManifestUnchanged"),
  "the Windows build must hash the current bytes of every tracked path without comparing to HEAD",
);
const trackedBaselineOffset = portableBuild.indexOf("$trackedWorktreeBeforeBuild = Get-TrackedWorktreeByteManifest");
const dependencyPreparationOffset = portableBuild.indexOf('& (Join-Path $PSScriptRoot "prepare-dependencies.ps1")');
const postCompilationGuardOffset = portableBuild.indexOf("$trackedWorktreeAfterCompilation = Get-TrackedWorktreeByteManifest");
const stageCreationOffset = portableBuild.indexOf("[IO.Directory]::CreateDirectory($ArtifactsDir)");
const sourceArchiveOffset = portableBuild.lastIndexOf('& (Join-Path $PSScriptRoot "build-source-archive.ps1")');
const finalTrackedGuardOffset = portableBuild.lastIndexOf("Assert-TrackedWorktreeByteManifestUnchanged");
const tauriCommandOffset = portableBuild.indexOf(tauriCommands[0]);
ok(
  trackedBaselineOffset >= 0 &&
    trackedBaselineOffset < dependencyPreparationOffset &&
    tauriCommandOffset >= 0 &&
    tauriCommandOffset < postCompilationGuardOffset &&
    postCompilationGuardOffset < stageCreationOffset &&
    sourceArchiveOffset < finalTrackedGuardOffset,
  "tracked-byte guards must run before build work, before portable staging, and again after source packaging",
);
ok(
  portableBuild.includes('$webViewRuntimeExecutables = @(Get-ChildItem -LiteralPath $webViewRuntimeCache -Filter "msedgewebview2.exe" -File -Recurse)') &&
    portableBuild.includes("$webViewRuntimeSource = $webViewRuntimeExecutables[0].Directory.FullName") &&
    portableBuild.includes("foreach ($entry in Get-ChildItem -LiteralPath $webViewRuntimeSource -Force)") &&
    !portableBuild.includes('Copy-Item -LiteralPath (Join-Path $ProjectRoot "work\\deps\\WebView2Runtime") -Destination (Join-Path $stage "WebView2Runtime") -Recurse') &&
    portableBuild.includes('"KAIGEN_MAX_RELATIVE_PATH_UTF16.txt"') &&
    portableBuild.includes("$webViewRuntimeMaximumFullPathLength -ge 260") &&
    portableBuild.includes('Join-Path $stage "WebView2Runtime\\msedgewebview2.exe"'),
  "the Windows package must flatten the pinned WebView2 runtime and fail before publishing a MAX_PATH-unsafe layout",
);

const trackedFixturePaths = [
  "src/already-dirty.ts",
  "README.md",
  "src-tauri/gen/schemas/desktop-schema.json",
  "src-tauri/gen/android/app/src/main.rs",
];
const dirtyBaselineBytes = new Map([
  ["src/already-dirty.ts", "dirty-before-build"],
  ["README.md", "stable"],
  ["src-tauri/gen/schemas/desktop-schema.json", "generated-before-build"],
  ["src-tauri/gen/android/app/src/main.rs", "mobile-source"],
]);
const generatedOnlyBytes = new Map(dirtyBaselineBytes);
generatedOnlyBytes.set("node_modules/generated.js", "ignored");
generatedOnlyBytes.set("artifacts/Kaigen.zip", "generated-output");
generatedOnlyBytes.set("src-tauri/gen/schemas/desktop-schema.json", "regenerated-during-build");
const mutatedDirtyBytes = new Map(generatedOnlyBytes);
mutatedDirtyBytes.set("src/already-dirty.ts", "dirty-mutated-during-build");
const mutatedMobileSourceBytes = new Map(generatedOnlyBytes);
mutatedMobileSourceBytes.set("src-tauri/gen/android/app/src/main.rs", "mobile-source-mutated-during-build");
deepEqual(
  {
    preExistingDirtyWithGeneratedOutputAndSchemas: changedTrackedPaths(
      trackedByteManifest(trackedFixturePaths, dirtyBaselineBytes),
      trackedByteManifest(trackedFixturePaths, generatedOnlyBytes),
    ),
    mutatedPreExistingDirtyFile: changedTrackedPaths(
      trackedByteManifest(trackedFixturePaths, dirtyBaselineBytes),
      trackedByteManifest(trackedFixturePaths, mutatedDirtyBytes),
    ),
    mutatedMobileSourceFile: changedTrackedPaths(
      trackedByteManifest(trackedFixturePaths, dirtyBaselineBytes),
      trackedByteManifest(trackedFixturePaths, mutatedMobileSourceBytes),
    ),
  },
  {
    preExistingDirtyWithGeneratedOutputAndSchemas: [],
    mutatedPreExistingDirtyFile: ["src/already-dirty.ts"],
    mutatedMobileSourceFile: ["src-tauri/gen/android/app/src/main.rs"],
  },
  "the byte-manifest fixture must allow exact generated schemas but reject dirty tracked and neighboring mobile-source mutations",
);

const cargoPaths = ["src-tauri/Cargo.toml", "src-tauri/Cargo.lock"];
const cargoMaterializedBytes = new Map([
  [cargoPaths[0], cargoManifest],
  [cargoPaths[1], cargoLock],
]);
const cargoAfterTauriNormalization = new Map(
  [...cargoMaterializedBytes].map(([sourcePath, sourceBytes]) => [sourcePath, sourceBytes.replace(/\r\n/gu, "\n")]),
);
deepEqual(
  {
    declaredRules: ["*.toml text eol=lf", "Cargo.lock text eol=lf"].filter((rule) => gitattributes.includes(rule)),
    checkAttr: cargoAttributeOutput.trim().split(/\r?\n/u),
    materializedWithCarriageReturns: [...cargoMaterializedBytes].filter(([, sourceBytes]) => sourceBytes.includes("\r")).map(([sourcePath]) => sourcePath),
    driftAfterTauriLfNormalization: changedTrackedPaths(
      trackedByteManifest(cargoPaths, cargoMaterializedBytes),
      trackedByteManifest(cargoPaths, cargoAfterTauriNormalization),
    ),
  },
  {
    declaredRules: ["*.toml text eol=lf", "Cargo.lock text eol=lf"],
    checkAttr: ["src-tauri/Cargo.toml: eol: lf", "src-tauri/Cargo.lock: eol: lf"],
    materializedWithCarriageReturns: [],
    driftAfterTauriLfNormalization: [],
  },
  "Cargo-owned source files must materialize as LF and remain byte-stable across Tauri normalization",
);

ok(
  offlineLoopbackHarness.includes("[Environment+SpecialFolder]::LocalApplicationData") &&
    offlineLoopbackHarness.includes('"test-harness"') &&
    offlineLoopbackHarness.includes('"offline-friend-request-loopback.exe"') &&
    offlineLoopbackHarness.includes('"offline-friend-request-loopback.obj"') &&
    offlineLoopbackHarness.includes('"toxcore.dll"') &&
    offlineLoopbackHarness.includes('"pthreadVC3.dll"') &&
    !offlineLoopbackHarness.includes("[guid]::NewGuid") &&
    !offlineLoopbackHarness.includes("GetTempPath"),
  "the native offline loopback harness must reuse one deterministic LocalAppData program path",
);
ok(
  offlineLoopbackHarness.includes('"Global\\KaigenOfflineFriendRequestLoopbackHarness"') &&
    offlineLoopbackHarness.includes("$mutex.WaitOne(0)") &&
    offlineLoopbackHarness.includes("Another offline friend-request loopback harness is already compiling or running"),
  "the native offline loopback harness must fail closed on machine-wide concurrent use",
);
ok(
  offlineLoopbackHarness.includes("[IO.FileAttributes]::ReparsePoint") &&
    offlineLoopbackHarness.includes("Assert-HarnessDirectoriesAreNotReparsePoints") &&
    offlineLoopbackHarness.includes("Refusing a reparse-point loopback harness directory"),
  "the stable harness directory and artifacts must reject reparse points",
);
ok(
  offlineLoopbackHarness.includes('"offline-friend-request-loopback-build.cmd"') &&
    offlineLoopbackHarness.includes("$batchPath -match '[^\\x00-\\x7F]'") &&
    offlineLoopbackHarness.includes("[Text.Encoding]::ASCII") &&
    offlineLoopbackHarness.includes("& $env:ComSpec /d /s /c $compileCommandFile") &&
    offlineLoopbackHarness.includes("Remove-HarnessFile -Path $compileCommandFile"),
  "the native loopback compiler must cross the required batch boundary through bounded ASCII staging with exact cleanup",
);
ok(
    offlineLoopbackHarness.includes("Start-Process -FilePath $executable") &&
    offlineLoopbackHarness.includes("-NoNewWindow -PassThru") &&
    offlineLoopbackHarness.includes("$null = $childProcess.Handle") &&
    offlineLoopbackHarness.includes("$childProcess.WaitForExit(250)") &&
    offlineLoopbackHarness.includes("$childProcess.Refresh()") &&
    offlineLoopbackHarness.includes("$childExitCode -is [int]") &&
    offlineLoopbackHarness.includes("Stop-Process -InputObject $childProcess -Force") &&
    offlineLoopbackHarness.includes("$childProcess.WaitForExit(10000)") &&
    offlineLoopbackHarness.includes("$primaryError = $_") &&
    offlineLoopbackHarness.includes("$PSCmdlet.ThrowTerminatingError($primaryError)"),
  "the native child must be bounded, terminated and reaped without masking its primary error",
);
deepEqual(
  process.platform === "win32"
    ? [capturePowerShell7ChildExit(0), capturePowerShell7ChildExit(23)]
    : [0, 23],
  [0, 23],
  "PowerShell 7.6.4 must retain and report both zero and nonzero asynchronous child exit codes",
);
ok(
  offlineLoopbackHarness.includes("$udpPortFrom = 38400") &&
    offlineLoopbackHarness.includes("$udpPortTo = 38431") &&
    offlineLoopbackHarness.includes('"System32\\netstat.exe"') &&
    offlineLoopbackHarness.includes("& $netstat -ano -p udp") &&
    offlineLoopbackHarness.includes("$rowProcessId -ne $ProcessId") &&
    offlineLoopbackHarness.includes("'^(?<address>\\[[^\\]]+\\]|[^:]+):(?<port>\\d+)$'") &&
    offlineLoopbackHarness.includes("Get-NetUDPEndpoint -OwningProcess $ProcessId -ErrorAction Stop") &&
    offlineLoopbackHarness.includes("# netstat remains the unprivileged source of truth.") &&
    offlineLoopbackHarness.includes('$localAddress -ne "127.0.0.1"') &&
    offlineLoopbackSource.includes("#define LOOPBACK_PORT_FROM 38400") &&
    offlineLoopbackSource.includes("#define LOOPBACK_PORT_TO 38431") &&
    offlineLoopbackSource.includes("tox_options_set_start_port(options, LOOPBACK_PORT_FROM)") &&
    offlineLoopbackSource.includes("tox_options_set_end_port(options, LOOPBACK_PORT_TO)") &&
    offlineLoopbackSource.includes("port < LOOPBACK_PORT_FROM || port > LOOPBACK_PORT_TO"),
  "the runner and all native Tox instances must enforce and observe the fixed UDP loopback range",
);
deepEqual(
  parseNetstatUdpRows(
    [
      "Proto  Local Address          Foreign Address        PID",
      " UDP    127.0.0.1:38400        *:*                    4242",
      " UDP    [::1]:38401            *:*                    4242",
      " UDP    0.0.0.0:39999          *:*                    5151",
    ].join("\r\n"),
    4242,
  ),
  [
    { localAddress: "127.0.0.1", localPort: 38400 },
    { localAddress: "::1", localPort: 38401 },
  ],
  "the unprivileged netstat parser must handle whitespace and bracketed IPv6 while selecting the exact PID",
);
ok(
  areExpectedLoopbackEndpoints([{ localAddress: "127.0.0.1", localPort: 38431 }]) &&
    !areExpectedLoopbackEndpoints([{ localAddress: "0.0.0.0", localPort: 38400 }]) &&
    !areExpectedLoopbackEndpoints([{ localAddress: "127.0.0.1", localPort: 39999 }]) &&
    !areExpectedLoopbackEndpoints([{ localAddress: "::1", localPort: 38400 }]),
  "endpoint validation must reject wildcard, out-of-range and IPv6 rows owned by the native child",
);
ok(
  offlineLoopbackSource.includes('#include "toxcore/net.h"') &&
    offlineLoopbackSource.includes("loopback_network_funcs = *loopback_base_network->funcs") &&
    offlineLoopbackSource.includes("loopback_network_funcs.bind = loopback_bind") &&
    offlineLoopbackSource.includes("!net_family_is_ipv4(addr->ip.family)") &&
    offlineLoopbackSource.includes("loopback_addr.ip.family = net_family_ipv4()") &&
    offlineLoopbackSource.includes("loopback_addr.ip.ip.v4 = net_get_ip4_loopback()") &&
    offlineLoopbackSource.includes("system->ns = &loopback_network"),
  "the native fixture must replace only the bind callback and force every UDP socket to IPv4 loopback",
);

deepEqual(
  gitignore.split(/\r?\n/).filter((line) => ["/AGENTS.md", "/docs/CHAT-BEHAVIOR.md", "/docs/TESTING.md", "/docs/TEST-BASELINE.md", "/continuation.local/", "/context.local/", "**/credentials.local.*", "**/*.credential.xml", "**/kaigen_vm_ed25519"].includes(line)),
  ["/AGENTS.md", "/docs/CHAT-BEHAVIOR.md", "/docs/TESTING.md", "/docs/TEST-BASELINE.md", "/continuation.local/", "/context.local/", "**/credentials.local.*", "**/*.credential.xml", "**/kaigen_vm_ed25519"],
  "local development instructions must remain ignored",
);
ok(
  sourceArchiveBuild.includes("GIT_INDEX_FILE") &&
    sourceArchiveBuild.includes("ls-files', '--others', '--exclude-standard") &&
    sourceArchiveBuild.includes("read-tree', 'HEAD") &&
    sourceArchiveBuild.includes("add', '-A', '--', '.'") &&
    sourceArchiveBuild.includes("ls-files', '--cached") &&
    sourceArchiveBuild.includes("write-tree") &&
    sourceArchiveBuild.includes("rev-parse', '--verify") &&
    sourceArchiveBuild.includes("archive --format=zip"),
  "the public source archive must use an isolated temporary index to bind allowlisted working-tree bytes without mutating the real index, while retaining exact-revision support",
);
ok(
  [sourceArchiveBuild, webInstallerBuild].every(
    (script) =>
      script.includes("[IO.Path]::GetRelativePath($Base, $Path)") &&
      script.includes("[IO.Path]::DirectorySeparatorChar") &&
      script.includes("[IO.Path]::AltDirectorySeparatorChar") &&
      script.includes("Select-Object -First 1") &&
      !script.includes("TrimEnd('\\') + '\\'"),
  ),
  "cross-platform release scripts must validate child paths with native separators instead of a Windows-only prefix",
);
ok(
  ["AGENTS.md", "docs/CHAT-BEHAVIOR.md", "docs/TESTING.md", "docs/TEST-BASELINE.md", "continuation.local/", "context.local/", "credentials.local.", "kaigen_vm_ed25519", ".credential.xml"].every((path) => sourceArchiveBuild.includes(path)),
  "the source archive must reject every local instruction path explicitly",
);
ok(
  !readme.includes("docs/CHAT-BEHAVIOR.md") && !readme.includes("docs/TESTING.md"),
  "public documentation must not link to local-only development rules",
);

const expectedAssertions = 74;
assert.equal(assertionCount, expectedAssertions, "update the declared assertion count when portable-pipeline coverage changes");
console.log(`portable build pipeline: ${assertionCount} assertions passed`);
