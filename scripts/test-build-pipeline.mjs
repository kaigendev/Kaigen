import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { runCiVerificationTests } from "./test-ci-incremental-verification.mjs";
import {
  assertMatchingInputs,
  descriptor,
  inputBytes,
  rustSummary,
  validateCommand,
  validateDeclaredChanges,
  validatePlan,
  validateReleaseMetadata,
  validateResultHeader,
} from "./incremental-windows-verification.mjs";

const projectRoot = new URL("../", import.meta.url);
const powershellPin = (await readFile(new URL("scripts/powershell-version.txt", projectRoot), "utf8")).trim();
assert.equal(powershellPin, "7.6.5", "the canonical PowerShell version must match the accepted toolchain migration");
const packageJson = JSON.parse(await readFile(new URL("package.json", projectRoot), "utf8"));
const portableBuild = await readFile(new URL("scripts/build-portable.ps1", projectRoot), "utf8");
const dependencyPreparation = await readFile(new URL("scripts/prepare-dependencies.ps1", projectRoot), "utf8");
const unixDependencyPreparation = await readFile(new URL("scripts/prepare-unix-dependencies.sh", projectRoot), "utf8");
const sqlcipherRebuild = await readFile(new URL("scripts/rebuild-sqlcipher-runtime.ps1", projectRoot), "utf8");
const sqlcipherSmokeSource = await readFile(new URL("scripts/tests/sqlcipher-runtime-smoke.c", projectRoot), "utf8");
const sourceArchiveBuild = await readFile(new URL("scripts/build-source-archive.ps1", projectRoot), "utf8");
const webInstallerBuild = await readFile(new URL("scripts/build-web-installer.ps1", projectRoot), "utf8");
const webBootstrapInstaller = await readFile(new URL("web/installer/install-kaigen-web-from-github.sh", projectRoot), "utf8");
const windowsMsiBuild = await readFile(new URL("scripts/build-windows-msi.ps1", projectRoot), "utf8");
const windowsUpdateShutdown = await readFile(new URL("packaging/windows/kaigen-update-shutdown.rs", projectRoot), "utf8");
const automationEntryPoint = await readFile(new URL("scripts/Invoke-KaigenAutomation.ps1", projectRoot), "utf8");
const sourceArchivePrivacyTest = await readFile(new URL("scripts/test-source-archive-privacy.mjs", projectRoot), "utf8");
const standaloneTypeScriptLoader = await readFile(new URL("scripts/import-standalone-typescript.mjs", projectRoot), "utf8");
const browserRuntimeTest = await readFile(new URL("scripts/test-browser-runtime.mjs", projectRoot), "utf8");
const webRendererTest = await readFile(new URL("scripts/test-web-renderer-contract.mjs", projectRoot), "utf8");
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
function rejectsValue(operation, expected, message) {
  assert.throws(operation, expected, message);
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

function extractMsiRelaunchShutdownBlock(source) {
  const lines = source.split(/\r?\n/u);
  const start = lines.findIndex((line) =>
    line.trim() === "# Window close follows close-to-tray; reuse the exact-path update shutdown instead."
  );
  assert.notEqual(start, -1, "the MSI relaunch shutdown block must have its close-to-tray boundary marker");
  const block = lines.slice(start, start + 8);
  assert.equal(block.at(-1)?.trim(), "}", "the extracted MSI relaunch shutdown block must be complete");
  return block.join("\n");
}

const expectedMsiRelaunchShutdownFixture = {
  powershellVersion: "7.6.5",
  results: [
    { name: "success", passed: true, waitCalls: 1, waitTimeout: 30000, waitedPid: 7301, capturedExactPath: true, nativeExitGuard: false, processAliveGuard: false, errorPresent: false },
    { name: "native-exit", passed: false, waitCalls: 0, waitTimeout: 0, waitedPid: 0, capturedExactPath: true, nativeExitGuard: true, processAliveGuard: false, errorPresent: true },
    { name: "same-pid-alive", passed: false, waitCalls: 1, waitTimeout: 30000, waitedPid: 7301, capturedExactPath: true, nativeExitGuard: false, processAliveGuard: true, errorPresent: true },
    { name: "helper-throw", passed: false, waitCalls: 0, waitTimeout: 0, waitedPid: 0, capturedExactPath: true, nativeExitGuard: false, processAliveGuard: false, errorPresent: true },
    { name: "helper-missing", passed: false, waitCalls: 0, waitTimeout: 0, waitedPid: 0, capturedExactPath: false, nativeExitGuard: false, processAliveGuard: false, errorPresent: true },
  ],
};

function captureMsiRelaunchShutdownFixture(shutdownBlock) {
  const fixture = `
$ErrorActionPreference = 'Stop'
function Invoke-FixtureShutdownHelper {
    param([string]$Path)
    $script:CapturedHelperArgument = $Path
    if ($script:FixtureHelperThrows) { throw 'fixture helper throw' }
    $global:LASTEXITCODE = $script:FixtureHelperExit
}
$installedExecutable = 'C:\\Fixture root\\Путь с пробелами\\Kaigen.exe'
$cases = @(
    [pscustomobject]@{ Name = 'success'; Helper = 'Invoke-FixtureShutdownHelper'; ExitCode = 0; HelperThrows = $false; WaitResult = $true },
    [pscustomobject]@{ Name = 'native-exit'; Helper = 'Invoke-FixtureShutdownHelper'; ExitCode = 23; HelperThrows = $false; WaitResult = $true },
    [pscustomobject]@{ Name = 'same-pid-alive'; Helper = 'Invoke-FixtureShutdownHelper'; ExitCode = 0; HelperThrows = $false; WaitResult = $false },
    [pscustomobject]@{ Name = 'helper-throw'; Helper = 'Invoke-FixtureShutdownHelper'; ExitCode = 0; HelperThrows = $true; WaitResult = $true },
    [pscustomobject]@{ Name = 'helper-missing'; Helper = 'Missing-Fixture-Shutdown-Helper'; ExitCode = 0; HelperThrows = $false; WaitResult = $true }
)
$results = foreach ($case in $cases) {
    $script:FixtureHelperExit = $case.ExitCode
    $script:FixtureHelperThrows = $case.HelperThrows
    $script:CapturedHelperArgument = $null
    $global:LASTEXITCODE = 99
    $shutdownHelperPath = $case.Helper
    $restartedProcess = [pscustomobject]@{
        Id = 7301
        WaitCalls = 0
        WaitTimeout = 0
        WaitedPid = 0
        WaitResult = $case.WaitResult
    }
    $restartedProcess | Add-Member -MemberType ScriptMethod -Name WaitForExit -Value {
        param([int]$Milliseconds)
        $this.WaitCalls = [int]$this.WaitCalls + 1
        $this.WaitTimeout = $Milliseconds
        $this.WaitedPid = $this.Id
        return [bool]$this.WaitResult
    }
    $errorRecord = $null
    try {
${shutdownBlock}
    } catch {
        $errorRecord = $_
    }
    $errorMessage = if ($null -eq $errorRecord) { '' } else { [string]$errorRecord.Exception.Message }
    [pscustomobject]@{
        name = $case.Name
        passed = $null -eq $errorRecord
        waitCalls = $restartedProcess.WaitCalls
        waitTimeout = $restartedProcess.WaitTimeout
        waitedPid = $restartedProcess.WaitedPid
        capturedExactPath = $script:CapturedHelperArgument -ceq $installedExecutable
        nativeExitGuard = $errorMessage -ceq 'Relaunched disposable Kaigen shutdown helper failed with exit code 23.'
        processAliveGuard = $errorMessage -ceq 'Relaunched disposable Kaigen process did not close gracefully after the MSI update test.'
        errorPresent = $null -ne $errorRecord
    }
}
[pscustomobject]@{
    powershellVersion = $PSVersionTable.PSVersion.ToString()
    results = @($results)
} | ConvertTo-Json -Depth 4 -Compress
`;
  return JSON.parse(execFileSync(
    "pwsh.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(fixture, "utf16le").toString("base64")],
    { encoding: "utf8" },
  ));
}

const msiRelaunchShutdownBlock = extractMsiRelaunchShutdownBlock(windowsMsiBuild);

equal(packageJson.scripts?.["test:localization"], "node scripts/test-localization.mjs", "localization assertions must have a stable entry point");
equal(packageJson.scripts?.["test:app-layout"], "node scripts/test-app-layout.mjs", "app layout assertions must have a stable entry point");
equal(packageJson.scripts?.["test:ui-interaction-state"], "node scripts/test-ui-interaction-state.mjs", "UI interaction-state assertions must have a stable entry point");
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
  [browserRuntimeTest, webRendererTest].every((script) =>
    script.includes('from "./import-standalone-typescript.mjs"') &&
    !/from\s+["'][^"']+\.tsx?["']/u.test(script)) &&
    standaloneTypeScriptLoader.includes('"--ignoreConfig"') &&
    standaloneTypeScriptLoader.includes("node_modules/typescript/bin/tsc"),
  "Node 20 Web builders must compile standalone TypeScript test modules with the lock-pinned compiler instead of importing .ts directly",
);
ok(
  automationEntryPoint.startsWith("#requires -Version 7.6.5") &&
    automationEntryPoint.includes("[Console]::OutputEncoding = $utf8NoBom") &&
    automationEntryPoint.includes("$OutputEncoding = $utf8NoBom") &&
    automationEntryPoint.includes("$PSVersionTable.PSVersion.ToString() -cne '7.6.5'") &&
    automationEntryPoint.includes("& $FilePath @ArgumentList") &&
    automationEntryPoint.includes("'debian-build'") &&
    automationEntryPoint.includes("'macos-build'") &&
    automationEntryPoint.includes("Resolve-KaigenNativeCommand -Name 'bash'"),
  "the canonical automation entry point must pin PowerShell 7.6.5, force UTF-8 and delegate Unix builds through argument-array native runners",
);
ok(
  /'web-gates' \{[\s\S]*?@\('run', 'build'\)[\s\S]*?@\('run', 'build:web'\)[\s\S]*?@\('run', 'test:built-content-security'\)[\s\S]*?@\('run', 'test:product-bundles'\)/u.test(automationEntryPoint),
  "the clean-checkout Web gate must build both desktop and Web bundles, inspect their emitted HTML, and then compare product boundaries",
);
ok(
  [portableBuild, dependencyPreparation, sqlcipherRebuild, sourceArchiveBuild, windowsMsiBuild, offlineLoopbackHarness]
    .every((script) => script.startsWith("#requires -Version 7.6.5") &&
      script.includes("[Console]::OutputEncoding = $utf8NoBom") &&
      script.includes("$OutputEncoding = $utf8NoBom")),
  "first-party Windows build and native-test scripts must fail closed outside pinned UTF-8 PowerShell 7.6.5",
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
  /PowerShell\s+--version 7\.6\.5/u.test(windowsBuildWorkflow) &&
    windowsBuildWorkflow.includes('"${{ runner.temp }}\\kaigen-pwsh\\pwsh.exe"') &&
    windowsBuildWorkflow.includes('echo ${{ runner.temp }}\\kaigen-pwsh>>"%GITHUB_PATH%"') &&
    /-NoLogo -NoProfile -NonInteractive\s+-File scripts\\Invoke-KaigenAutomation\.ps1/u.test(windowsBuildWorkflow) &&
    /Invoke-KaigenAutomation\.ps1\s+-Task windows-portable/u.test(windowsBuildWorkflow) &&
    windowsBuildWorkflow.includes("shell: cmd") &&
    !windowsBuildWorkflow.includes("shell: powershell"),
  "Windows CI must install pinned PowerShell 7.6.5 and run through the canonical entry point without Windows PowerShell 5",
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
    windowsMsiBuild.includes('& $candlePath -nologo -arch x64 -ext $utilExtension') &&
    !windowsMsiBuild.includes('$candle.Directory.FullName'),
  "the MSI builder must package only a privacy-checked portable tree into a high-compression embedded CAB and verify a user-selected install directory byte-for-byte",
);
ok(
  windowsMsiBuild.includes('$shutdownHelperSource = Join-Path $projectRoot "packaging\\windows\\kaigen-update-shutdown.rs"') &&
    windowsMsiBuild.includes('"-C", "panic=abort"') &&
    windowsMsiBuild.includes('Id="KaigenUpdateShutdownHelper"') &&
    windowsMsiBuild.includes('Id="ShutdownKaigenBeforeUpdate"') &&
    windowsMsiBuild.includes('ExeCommand="&quot;[INSTALLFOLDER]Kaigen.exe&quot;"') &&
    windowsMsiBuild.includes('<Custom Action="ShutdownKaigenBeforeUpdate" After="CostFinalize">1</Custom>') &&
    windowsMsiBuild.includes('gracefulShutdown = "exact-path-named-event-with-event-loop-fallback"') &&
    windowsMsiBuild.includes('gracefulShutdownHelperSha256 = $shutdownHelperSha256') &&
    windowsUpdateShutdown.includes('QueryFullProcessImageNameW') &&
    windowsUpdateShutdown.includes('ProcessIdToSessionId') &&
    windowsUpdateShutdown.includes('normalized_path(Path::new(path)) == target') &&
    windowsUpdateShutdown.includes('Local\\\\Kaigen.UpdateShutdown.{process_id}') &&
    windowsUpdateShutdown.includes('PostMessageW(*window, WM_CLOSE, 0, 0)') &&
    windowsUpdateShutdown.includes('PostThreadMessageW(thread_id, WM_QUIT, 0, 0)') &&
    windowsUpdateShutdown.includes('wait_for_exit(process.handle.0, 60_000)') &&
    !/TerminateProcess|PROCESS_TERMINATE|taskkill|Stop-Process/iu.test(windowsUpdateShutdown) &&
    !windowsMsiBuild.includes('TerminateProcess=') &&
    windowsMsiBuild.includes('Id="LaunchKaigenAfterInstall"') &&
    windowsMsiBuild.includes('MSI update did not gracefully finish the running Kaigen process') &&
    windowsMsiBuild.includes('The exact installed Kaigen executable did not open a real window after an explicit launch') &&
    !/signtool|certificate store|codesign/iu.test(windowsBuildWorkflow),
  "the unsigned Windows MSI must gracefully stop Kaigen without forced termination, replace the selected install directory, and functionally test a later explicit launch",
);
ok(
  windowsMsiBuild.includes('<Property Id="WIXUI_EXITDIALOGOPTIONALCHECKBOXTEXT" Value="Launch Kaigen" />') &&
    !windowsMsiBuild.includes('<Property Id="WIXUI_EXITDIALOGOPTIONALCHECKBOX"') &&
    !windowsMsiBuild.includes('KAIGEN_RELAUNCH') &&
    windowsMsiBuild.includes('<Publish Dialog="ExitDialog" Control="Finish" Event="DoAction" Value="LaunchKaigenAfterInstall" Order="1">WIXUI_EXITDIALOGOPTIONALCHECKBOX = 1 AND NOT Installed AND NOT REMOVE~="ALL"</Publish>') &&
    !windowsMsiBuild.includes('<Custom Action="LaunchKaigenAfterInstall"') &&
    windowsMsiBuild.includes('<Property Id="MSIDISABLERMRESTART" Value="1" />') &&
    windowsMsiBuild.includes("'test-windows-msi-launch-policy.ps1') -MsiPath $msiPath"),
  "the MSI must offer an unchecked Finish checkbox and validate the compiled UI condition, with no execute-sequence or Restart Manager autolaunch",
);
equal(
  windowsMsiBuild.match(/Assert-NoInstalledKaigenProcess -Executable \$installedExecutable/gu)?.length,
  2,
  "the real silent install and running-app update must both verify that the exact installed executable stays closed without an opt-out property",
);
ok(
  /& \$shutdownHelperPath \$installedExecutable \| Out-Null\n\s*if \(\$LASTEXITCODE -ne 0\)/u.test(msiRelaunchShutdownBlock) &&
    msiRelaunchShutdownBlock.includes("$restartedProcess.WaitForExit(30000)") &&
    !/CloseMainWindow|Stop-Process|taskkill|TerminateProcess|set_close_to_tray|closeToTray/iu.test(msiRelaunchShutdownBlock),
  "the relaunched MSI process must use the exact-path shutdown helper, check its native exit and wait for the selected process without changing tray preferences or forcing exit",
);
deepEqual(
  process.platform === "win32"
    ? captureMsiRelaunchShutdownFixture(msiRelaunchShutdownBlock)
    : expectedMsiRelaunchShutdownFixture,
  expectedMsiRelaunchShutdownFixture,
  "the extracted MSI relaunch shutdown block must preserve its exact Unicode argument and fail closed on helper or selected-process failures",
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
    unixBuildWorkflow.includes(`KAIGEN_RELEASE_LABEL: ${packageJson.version}`) &&
    unixBuildWorkflow.includes("./scripts/prepare-unix-dependencies.sh linux") &&
    unixBuildWorkflow.includes("-Task web-gates") &&
    unixBuildWorkflow.includes("-Task web-installer-tests") &&
    unixBuildWorkflow.includes("ci-incremental-verification.mjs run-tests --platform web") &&
    unixBuildWorkflow.includes("-Task web-installer-bundle") &&
    unixBuildWorkflow.includes('echo "$RUNNER_TEMP/kaigen-pwsh" >> "$GITHUB_PATH"') &&
    unixBuildWorkflow.includes("sha256sum -c manifest.sha256") &&
    unixBuildWorkflow.includes('test -x "$staging/payload/TorExpertBundle/tor/tor"') &&
    unixBuildWorkflow.includes('test -x "$staging/payload/TorExpertBundle/tor/pluggable_transports/lyrebird"') &&
    unixBuildWorkflow.includes(`name: Kaigen-Web-Debian13-Nginx-${packageJson.version}`) &&
    unixBuildWorkflow.includes(`artifacts/Kaigen-Web-Installer-${packageJson.version}.sh`),
  "Unix CI must build, test, integrity-check, and publish the Web release bundle",
);
ok(
  webBootstrapInstaller.includes("REPOSITORY='kaigendev/Kaigen'") &&
    webBootstrapInstaller.includes("RELEASE_LABEL='__KAIGEN_RELEASE_LABEL__'") &&
    webBootstrapInstaller.includes("BUNDLE_SHA256='__KAIGEN_WEB_BUNDLE_SHA256__'") &&
    webBootstrapInstaller.includes("curl --fail --location --proto '=https' --tlsv1.2 --retry 3 --retry-all-errors") &&
    webBootstrapInstaller.includes('[[ "$ACTUAL_SHA256" == "$BUNDLE_SHA256" ]]') &&
    webBootstrapInstaller.includes('[[ "$(tr -d \'\\r\\n\' < "$EXTRACT_ROOT/release-id")" == "$BUILD_ID" ]]') &&
    webBootstrapInstaller.includes("(cd \"$EXTRACT_ROOT\" && sha256sum -c manifest.sha256)") &&
    webBootstrapInstaller.includes('"$INSTALLER" "$ACTION" --bundle "$EXTRACT_ROOT" "$@"') &&
    webInstallerBuild.includes('"Kaigen-Web-Installer-$ReleaseLabel.sh"') &&
    webInstallerBuild.includes("Web bootstrap template placeholders are missing or ambiguous.") &&
    unixBuildWorkflow.includes(`artifacts/Kaigen-Web-Installer-${packageJson.version}.sh`),
  "the standalone Web bootstrap must be published outside the archive and download only the exact release bundle with a build-pinned SHA-256 before delegating install/update mode",
);
ok(
  webInstallerBuild.includes("[string]$TorBundleRoot = 'work/platform/linux/TorExpertBundle'") &&
    webInstallerBuild.includes("'tor/pluggable_transports/lyrebird'") &&
    webInstallerBuild.includes("'tor/pluggable_transports/pt_config.json'") &&
    webInstallerBuild.includes("Copy-Item -LiteralPath $entry.FullName -Destination $payloadTor -Recurse"),
  "the Web installer bundle must carry the pinned Tor runtime and obfs4 transport beside kaigen-webd",
);
ok(
  webInstallerBuild.includes("$uiBuildIdentity = Join-Path $ui 'kaigen-build-id'") &&
    webInstallerBuild.includes("[IO.File]::ReadAllBytes($uiBuildIdentity)") &&
    webInstallerBuild.includes("[Linq.Enumerable]::SequenceEqual[byte]") &&
    webInstallerBuild.includes("Web UI build identity does not exactly match BuildId.") &&
    unixBuildWorkflow.includes(`KAIGEN_WEB_BUILD_ID: kaigen-${packageJson.version}`),
  "the Web installer packager must reject missing or byte-mismatched UI build identity before creating an artifact",
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
  ["npm run test:chat-navigation", "npm run test:chat-geometry-runtime", "npm run test:chat-enhancements", "npm run test:pq-entropy", "npm run test:chat-view-state", "npm run test:chat-notifications", "npm run test:chat-notification-queue", "npm run test:chat-reaction-notices", "npm run test:background-transfers", "npm run test:transfer-preview-registry", "npm run test:file-receive-settings", "npm run test:chat-file-batch", "npm run test:desktop-file-routing", "npm run test:app-layout", "npm run test:ui-identity", "npm run test:ui-interaction-state", "npm run test:theme-system", "npm run test:profile-switcher", "npm run test:contact-identity", "npm run test:contact-list-order", "npm run test:friend-resilience", "npm run test:localization", "npm run test:status-message", "npm run test:component-inventory", "npm run test:source-hygiene", "npm run test:product-boundaries", "npm run test:build-pipeline", "npm run test:prepared-native-cache", "npm run test:platform-runtime", "npm run test:browser-runtime", "npm run test:web-transfer-pump", "npm run test:web-renderer-contract", "npm run test:web-content-security", "npm run test:resource-bounds", "npm run test:web-installer", "npm run test:source-archive-privacy"],
  "the canonical frontend suite must run every chat, chat geometry runtime, reaction notice, background transfer and preview-registry gate, plus receive policy, five-file batch admission, native desktop routing, layout, UI identity, interaction-state, themes, profile switching, contact identity and ordering, friend resilience, localization, status, component inventory, source hygiene, product boundaries, pipeline, prepared cache, platform and browser runtimes, the Web transfer pump, Web renderer and security, resource bounds, installer, and source-archive privacy assertions once each",
);

const frontendCommands = commandLines.filter((line) => /^&\s+npm\.cmd\s+run\s+test:frontend\s*$/i.test(line));
const rustCommands = commandLines.filter((line) => /^&\s+cargo\s+test(?:\s|$)/i.test(line));
const tauriCommands = commandLines.filter((line) => /^&\s+npm\.cmd\s+run\s+tauri\s+--\s+build\s+--no-bundle\s*$/i.test(line));
const builtContentSecurityCommands = commandLines.filter((line) => /^&\s+npm\.cmd\s+run\s+test:built-content-security\s+--\s+dist\s*$/i.test(line));
const directFrontendBuilds = commandLines.filter((line) => /^&\s+npm\.cmd\s+run\s+build(?:\s|$)/i.test(line));
const toxcoreRetryCommands = commandLines.filter((line) => line.includes('test-toxcore-retry-cap.ps1'));
const offlineFriendRequestCommands = commandLines.filter((line) => line.includes('test-offline-friend-request-loopback.ps1'));

equal(frontendCommands.length, 1, "the full-profile portable build must retain one canonical frontend suite invocation");
equal(rustCommands.length, 1, "the full-profile portable build must retain one Rust suite invocation");
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
  !portableBuild.includes("$reuseToxcoreBuild") &&
    !portableBuild.includes("path-verified c-toxcore build cache") &&
    !portableBuild.includes("CMAKE_HOME_DIRECTORY:INTERNAL"),
  "the portable build must not treat a path, CMake marker, or UI-acceptance shortcut as a native cache hit",
);
ok(
  ["libsodium", "c-toxcore", "tor-universal"].every((group) => portableBuild.includes(`New-KaigenPreparedNativeContract -Group ${group}`)) &&
    portableBuild.includes("'expected-hit'") && portableBuild.includes("Resolve-KaigenPreparedNativeGroup") &&
    portableBuild.includes('test-prepared-native-cache-windows.ps1'),
  "Windows must resolve exactly three manifest-bound native groups with an expected-hit mode",
);
const preparedOutputScopeGuard = portableBuild.indexOf("Refusing to replace Windows c-toxcore output outside the project build directory");
const preparedOutputDelete = portableBuild.indexOf("[IO.Directory]::Delete($toxBuild, $true)");
const freshToxcoreConfigure = portableBuild.indexOf("& $cmake -S $toxSource -B $freshToxBuild");
ok(
  freshToxcoreConfigure >= 0 && preparedOutputScopeGuard > freshToxcoreConfigure && preparedOutputScopeGuard < preparedOutputDelete,
  "c-toxcore must compile in fresh producer staging before the resolved output atomically replaces the scoped project build directory",
);
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
const stageCreationOffset = portableBuild.lastIndexOf("[IO.Directory]::CreateDirectory($ArtifactsDir)");
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
  "PowerShell 7.6.5 must retain and report both zero and nonzero asynchronous child exit codes",
);
ok(
  offlineLoopbackHarness.includes("$udpPortFrom = 38400") &&
    offlineLoopbackHarness.includes("$udpPortTo = 38431") &&
    offlineLoopbackHarness.includes('"System32\\netstat.exe"') &&
    offlineLoopbackHarness.includes("& $netstat -ano -p udp") &&
    offlineLoopbackHarness.includes("$rowProcessId -ne $ProcessId") &&
    offlineLoopbackHarness.includes("'^(?<address>\\[[^\\]]+\\]|[^:]+):(?<port>\\d+)$'") &&
    offlineLoopbackHarness.includes('$localAddress -ne "127.0.0.1"') &&
    offlineLoopbackSource.includes("#define LOOPBACK_PORT_FROM 38400") &&
    offlineLoopbackSource.includes("#define LOOPBACK_PORT_TO 38431") &&
    offlineLoopbackSource.includes("tox_options_set_start_port(options, LOOPBACK_PORT_FROM)") &&
    offlineLoopbackSource.includes("tox_options_set_end_port(options, LOOPBACK_PORT_TO)") &&
    offlineLoopbackSource.includes("port < LOOPBACK_PORT_FROM || port > LOOPBACK_PORT_TO"),
  "the runner and all native Tox instances must enforce and observe the fixed UDP loopback range",
);
ok(
  !offlineLoopbackHarness.includes("Get-NetUDPEndpoint") &&
    !offlineLoopbackHarness.includes("Get-CimInstance") &&
    !offlineLoopbackHarness.includes("CimSession"),
  "the native loopback endpoint poll must remain independent of PowerShell CIM cmdletization",
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

const incrementalCatalog = new Set(["test:chat-geometry-runtime", "test:pq-entropy"]);
deepEqual(
  descriptor("frontend:chat-geometry-runtime", incrementalCatalog, "menus-only").args,
  ["run", "test:chat-geometry-runtime", "--", "--menus-only"],
  "incremental menu checks must use the approved focused variant",
);
deepEqual(
  descriptor("frontend:pq-entropy", incrementalCatalog, "runtime").args,
  ["run", "test:pq-entropy", "--", "--runtime"],
  "incremental PQ recovery checks must support their existing DOM runtime variant",
);
rejectsValue(() => descriptor("frontend:pq-entropy", incrementalCatalog, "--runtime & echo unsafe"), /unapproved check variant/, "the plan cannot supply arbitrary shell arguments");
rejectsValue(() => descriptor("frontend:not-in-catalog", incrementalCatalog), /unapproved frontend check/, "frontend commands must belong to the canonical catalog");
rejectsValue(() => descriptor("rust:pq::tests;whoami", incrementalCatalog), /unapproved Rust check/, "Rust filters cannot introduce commands or options");
ok(descriptor("rust:chat_history_store::tests", incrementalCatalog).args.includes("chat_history_store::tests"), "unchanged named Rust families must be individually reusable");
ok(descriptor("rust:chat_history_store::", incrementalCatalog).args.includes("chat_history_store::"), "a whole Rust namespace must support a trailing path separator");
ok(descriptor("rust:pq::v2::tests::", incrementalCatalog).args.includes("pq::v2::tests::"), "nested Rust namespaces must support a trailing path separator");
rejectsValue(() => descriptor("rust:pq:::tests", incrementalCatalog), /unapproved Rust check/, "malformed Rust path separators must fail");
deepEqual(descriptor("driver:pq-two-instances", incrementalCatalog).args, ["scripts/test-pq-two-instances.mjs", "--self-test"], "the native scenario driver has one approved non-runtime self-test");
rejectsValue(() => descriptor("driver:pq-two-instances", incrementalCatalog, "--keep-open"), /unapproved check variant/, "driver checks cannot start an uncontrolled native runtime");
const webRustCheck = { id: "rust:web_core::tests::web_file_bridge_", variant: "web-core" };
const webRustCommand = descriptor(webRustCheck.id, incrementalCatalog, webRustCheck.variant);
ok(webRustCommand.args.includes("--no-default-features") && webRustCommand.args.includes("web-core"), "Web Rust evidence must name its actual feature configuration");
validateCommand({ program: webRustCommand.program, args: webRustCommand.args }, webRustCheck, incrementalCatalog);
assertionCount += 1;
rejectsValue(() => validateCommand({ program: "cargo", args: ["test", "--locked", "--manifest-path", "src-tauri/Cargo.toml", "--lib"] }, webRustCheck, incrementalCatalog), /does not cover/, "a desktop baseline cannot cover Web feature tests");
rejectsValue(() => validateCommand({ program: "node", args: ["scripts/test-pq-two-instances.mjs", "--keep-open"] }, { id: "driver:pq-two-instances" }, incrementalCatalog), /approved self-test/, "native runtime commands cannot impersonate the driver self-test");
equal(inputBytes(Buffer.from("one\r\ntwo\r\nthree\n"), [2, 2]).toString(), "two\n", "line-scoped evidence must normalize CRLF consistently");
rejectsValue(() => inputBytes(Buffer.from("one\n"), [1, 2]), /range exceeds file/, "out-of-range evidence must fail");
rejectsValue(() => rustSummary("test result: ok. 0 passed; 0 failed; 40 filtered out;", "rust:pq::tests"), /no passing tests/, "zero selected Rust tests cannot produce passing evidence");
rejectsValue(() => rustSummary("test pq::tests::case ... ok\ntest result: FAILED. 1 passed; 1 failed;", "rust:pq::tests"), /successful test summary/, "failed Rust output must fail even if another test passed");
rejectsValue(() => rustSummary("test other::tests::case ... ok\ntest result: ok. 1 passed; 0 failed;", "rust:pq::tests"), /no passing test for/, "a successful unrelated family cannot cover a requested Rust filter");
rustSummary("test pq::tests::case ... ok\ntest result: ok. 1 passed; 0 failed;", "rust:pq::tests");
assertionCount += 1;
rustSummary("build\tBuild portable archive\t2026-09-10T18:42:21.2361265Z test pq::tests::case ... ok\nbuild\tBuild portable archive\t2026-09-10T18:42:21.2361265Z test result: ok. 1 passed; 0 failed;", "rust:pq::tests");
assertionCount += 1;
const historicalNativeCommand = { program: "pwsh", args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", "scripts\\Invoke-KaigenAutomation.ps1", "-Task", "windows-portable"] };
ok(validateCommand(historicalNativeCommand, { id: "native:retry-cap" }, incrementalCatalog), "the exact historical CI wrapper command must retain its native proof path");
rejectsValue(() => validateCommand({ ...historicalNativeCommand, args: [...historicalNativeCommand.args, "-UiAcceptance"] }, { id: "native:retry-cap" }, incrementalCatalog), /does not match/, "a wrapper mode that omits native tests cannot supply native evidence");
const resultHeader = {
  schemaVersion: 1, kind: "kaigen-incremental-check-result", checkId: "rust:pq::tests", status: "PASS",
  source: {}, inputs: [], command: {}, exitCode: 0, output: {}, startedAt: "", completedAt: "",
};
rejectsValue(() => validateResultHeader({ ...resultHeader, status: "FAIL" }, resultHeader.checkId), /not PASS/, "a failed result cannot be relabelled as reused PASS");
rejectsValue(() => validateResultHeader({ ...resultHeader, exitCode: 1 }, resultHeader.checkId), /not PASS/, "a nonzero recorded command must fail");
const { output: omittedOutput, ...incompleteResult } = resultHeader;
rejectsValue(() => validateResultHeader(incompleteResult, resultHeader.checkId), /missing output/, "completed evidence must identify the original output");
rejectsValue(() => assertMatchingInputs([{ id: "crypto", kind: "git", sha256: "a".repeat(64) }], [{ id: "crypto", kind: "git", sha256: "b".repeat(64) }], resultHeader.checkId), /inputs do not match candidate/, "changed evidence inputs cannot be reused");
const changedPath = { path: "src/App.tsx", beforeBlob: "a".repeat(40), beforeMode: "100644", afterBlob: "b".repeat(40), afterMode: "100644" };
const declaredPath = { ...changedPath, checkIds: ["frontend:pq-entropy"], reason: "Recovery action changed" };
const coveredIds = new Set(declaredPath.checkIds);
rejectsValue(() => validateDeclaredChanges([], [changedPath], coveredIds), /complete exact/, "the plan cannot omit a changed tracked file");
rejectsValue(() => validateDeclaredChanges([{ ...declaredPath, checkIds: [] }], [changedPath], coveredIds), /incomplete check coverage/, "changed files need named check coverage");
rejectsValue(() => validateDeclaredChanges([{ ...declaredPath, afterBlob: "c".repeat(40) }], [changedPath], coveredIds), /complete exact/, "the plan must bind exact changed Git blobs");
validateDeclaredChanges([declaredPath], [changedPath], coveredIds);
assertionCount += 1;
const oldMetadata = "KAIGEN_RELEASE_LABEL: 0.2.7\nKAIGEN_WEB_BUILD_ID: kaigen-0.2.7\nname: Kaigen-Web-Debian13-Nginx-0.2.7\nartifacts/Kaigen-Web-Debian13-Nginx-0.2.7.tar.gz\nartifacts/Kaigen-Web-Installer-0.2.7.sh\n";
const newMetadata = oldMetadata.replaceAll("0.2.7", "0.2.8");
validateReleaseMetadata(oldMetadata, newMetadata, "0.2.7", "0.2.8");
assertionCount += 1;
rejectsValue(() => validateReleaseMetadata(oldMetadata, `${newMetadata}run: unexpected\n`, "0.2.7", "0.2.8"), /beyond the five version labels/, "release metadata equivalence cannot hide workflow command changes");
rejectsValue(() => validateReleaseMetadata(oldMetadata, oldMetadata, "0.2.7", "0.2.8"), /beyond the five version labels/, "release metadata equivalence must apply every required version label");
await assert.rejects(
  validatePlan({ planPath: fileURLToPath(new URL("scripts/incremental-windows-verification.mjs", projectRoot)), planSha256: "0".repeat(64), projectRoot: fileURLToPath(projectRoot) }),
  /file hash changed/,
  "a stale plan hash must fail before any execution",
);
assertionCount += 1;
await assert.rejects(
  validatePlan({ planPath: fileURLToPath(new URL("scripts/__missing_incremental_evidence__.json", projectRoot)), planSha256: "0".repeat(64), projectRoot: fileURLToPath(projectRoot) }),
  /ENOENT/,
  "missing plan evidence cannot be accepted",
);
assertionCount += 1;
ok(
  portableBuild.includes('[string]$VerificationPlanPath') &&
    portableBuild.includes('[string]$VerificationPlanSha256') &&
    portableBuild.includes('[string]$VerificationReferenceRoot') &&
    portableBuild.includes("'incremental-windows-verification.mjs') validate @incrementalArguments") &&
    portableBuild.includes("'incremental-windows-verification.mjs') run-native @incrementalArguments") &&
    portableBuild.includes("'incremental-windows-verification.mjs') run-tests @incrementalArguments") &&
    portableBuild.includes("'incremental-windows-verification.mjs') finalize @incrementalArguments --archive $zipPath"),
  "the portable build must validate a hash-bound plan, run its two stages, and bind final archive evidence",
);

const expectedAssertions = 122;
assert.equal(assertionCount, expectedAssertions, "update the declared assertion count when portable-pipeline coverage changes");
await runCiVerificationTests();
console.log(`portable build pipeline: ${assertionCount} assertions passed`);
