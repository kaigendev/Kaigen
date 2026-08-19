import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const projectRoot = new URL("../", import.meta.url);
const packageJson = JSON.parse(await readFile(new URL("package.json", projectRoot), "utf8"));
const portableBuild = await readFile(new URL("scripts/build-portable.ps1", projectRoot), "utf8");
const dependencyPreparation = await readFile(new URL("scripts/prepare-dependencies.ps1", projectRoot), "utf8");
const unixDependencyPreparation = await readFile(new URL("scripts/prepare-unix-dependencies.sh", projectRoot), "utf8");
const sourceArchiveBuild = await readFile(new URL("scripts/build-source-archive.ps1", projectRoot), "utf8");
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

function captureWindowsPowerShellChildExit(exitCode) {
  const childCommand = Buffer.from("Start-Sleep -Milliseconds 200; exit " + exitCode, "utf16le").toString("base64");
  const fixture = [
    "$child = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') " +
      "-ArgumentList @('-NoProfile','-EncodedCommand','" + childCommand + "') -PassThru -WindowStyle Hidden",
    "$null = $child.Handle",
    "$child.WaitForExit()",
    "$child.Refresh()",
    "[Console]::Write($child.ExitCode)",
    "$child.Dispose()",
  ].join("; ");
  return Number(execFileSync(
    process.env.SystemRoot + "\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    ["-NoProfile", "-Command", fixture],
    { encoding: "utf8" },
  ));
}

equal(packageJson.scripts?.["test:localization"], "node scripts/test-localization.mjs", "localization assertions must have a stable entry point");
equal(packageJson.scripts?.["test:app-layout"], "node scripts/test-app-layout.mjs", "app layout assertions must have a stable entry point");
equal(packageJson.scripts?.["test:contact-identity"], "node scripts/test-contact-identity.mjs", "contact identity assertions must have a stable entry point");
equal(packageJson.scripts?.["test:friend-resilience"], "node scripts/test-friend-resilience.mjs", "friend resilience assertions must have a stable entry point");
equal(packageJson.scripts?.["test:build-pipeline"], "node scripts/test-build-pipeline.mjs", "pipeline assertions must have a stable entry point");
equal(packageJson.scripts?.["test:component-inventory"], "node scripts/test-component-inventory.mjs", "component inventory assertions must have a stable entry point");
equal(packageJson.scripts?.["test:platform-runtime"], "node scripts/test-platform-runtime.mjs", "platform runtime assertions must have a stable entry point");
equal(packageJson.scripts?.["test:source-archive-privacy"], "node scripts/test-source-archive-privacy.mjs", "source-archive privacy assertions must have a stable entry point");
ok(
  /curl\s+--fail\s+--location\s+--retry\s+4\s+--retry-all-errors\s+--retry-delay\s+2/.test(unixDependencyPreparation),
  "Unix dependency downloads must retry transient TLS and connection-reset failures",
);
deepEqual(
  packageJson.scripts?.["test:frontend"]?.split(/\s*&&\s*/),
  ["npm run test:chat-navigation", "npm run test:app-layout", "npm run test:contact-identity", "npm run test:friend-resilience", "npm run test:localization", "npm run test:component-inventory", "npm run test:build-pipeline", "npm run test:platform-runtime", "npm run test:source-archive-privacy"],
  "the canonical frontend suite must run navigation, app layout, contact identity, friend resilience, localization, component inventory, pipeline, platform runtime, and source-archive privacy assertions once each",
);

const frontendCommands = commandLines.filter((line) => /^&\s+npm\.cmd\s+run\s+test:frontend\s*$/i.test(line));
const rustCommands = commandLines.filter((line) => /^&\s+cargo\s+test(?:\s|$)/i.test(line));
const tauriCommands = commandLines.filter((line) => /^&\s+npm\.cmd\s+run\s+tauri\s+--\s+build\s+--no-bundle\s*$/i.test(line));
const directFrontendBuilds = commandLines.filter((line) => /^&\s+npm\.cmd\s+run\s+build(?:\s|$)/i.test(line));
const toxcoreRetryCommands = commandLines.filter((line) => line.includes('test-toxcore-retry-cap.ps1'));
const offlineFriendRequestCommands = commandLines.filter((line) => line.includes('test-offline-friend-request-loopback.ps1'));

equal(frontendCommands.length, 1, "the portable build must run the canonical frontend suite exactly once");
equal(rustCommands.length, 1, "the portable build must run Rust tests exactly once");
ok(rustCommands[0]?.includes("--locked"), "the Rust test run must honor Cargo.lock");
ok(rustCommands[0]?.includes("--lib"), "the Rust test run must select the platform library suite");
equal(tauriCommands.length, 1, "the portable build must invoke the Tauri production build exactly once");
equal(toxcoreRetryCommands.length, 1, "the portable build must run the toxcore retry-cap regression exactly once");
equal(offlineFriendRequestCommands.length, 1, "the portable build must run the native offline friend-request loopback exactly once");

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
  dependencyPreparation.includes("[Net.SecurityProtocolType]::Tls12") &&
    dependencyPreparation.includes("Invoke-WebRequest") &&
    dependencyPreparation.includes("-TimeoutSec 300"),
  "the bounded Windows PowerShell fallback must explicitly enable TLS 1.2",
);
ok(
  dependencyPreparation.includes("[Environment]::SystemDirectory") &&
    dependencyPreparation.includes('Get-Command -Name "curl.exe"') &&
    dependencyPreparation.includes("Select-Object -First 1") &&
    dependencyPreparation.includes("$curlPath = [string]$curlCommand.Source") &&
    !dependencyPreparation.includes("& $curl.Source") &&
    ["--fail", "--location", "--retry 5", "--connect-timeout 30", "--speed-time 60", "--max-time 1800"].every((option) => dependencyPreparation.includes(option)),
  "Windows dependency downloads must resolve exactly one curl executable with bounded retry, stall, and total time limits",
);
const curlDownload = dependencyPreparation.indexOf("& $curlPath");
const failedDownloadCleanup = dependencyPreparation.indexOf("[IO.File]::Delete([IO.Path]::GetFullPath($Destination))", curlDownload);
const webRequestFallback = dependencyPreparation.indexOf("Invoke-WebRequest -Uri", failedDownloadCleanup);
const fallbackHashCheck = dependencyPreparation.indexOf("Assert-FileHash -Path $Destination -Expected $Sha256", webRequestFallback);
ok(
  curlDownload >= 0 && curlDownload < failedDownloadCleanup && failedDownloadCleanup < webRequestFallback && webRequestFallback < fallbackHashCheck,
  "both transports must discard partial data and converge on the same pinned SHA-256 check",
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
    ? [captureWindowsPowerShellChildExit(0), captureWindowsPowerShellChildExit(23)]
    : [0, 23],
  [0, 23],
  "Windows PowerShell 5 must retain and report both zero and nonzero asynchronous child exit codes",
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
  sourceArchiveBuild.includes("ls-files --cached") &&
    !sourceArchiveBuild.includes("--others") &&
    sourceArchiveBuild.includes("write-tree") &&
    sourceArchiveBuild.includes("rev-parse --verify") &&
    sourceArchiveBuild.includes("archive --format=zip"),
  "the public source archive must be created from an exact index or revision tree without untracked working-tree files",
);
ok(
  ["AGENTS.md", "docs/CHAT-BEHAVIOR.md", "docs/TESTING.md", "docs/TEST-BASELINE.md", "continuation.local/", "context.local/", "credentials.local.", "kaigen_vm_ed25519", ".credential.xml"].every((path) => sourceArchiveBuild.includes(path)),
  "the source archive must reject every local instruction path explicitly",
);
ok(
  !readme.includes("docs/CHAT-BEHAVIOR.md") && !readme.includes("docs/TESTING.md"),
  "public documentation must not link to local-only development rules",
);

const expectedAssertions = 48;
assert.equal(assertionCount, expectedAssertions, "update the declared assertion count when portable-pipeline coverage changes");
console.log(`portable build pipeline: ${assertionCount} assertions passed`);
