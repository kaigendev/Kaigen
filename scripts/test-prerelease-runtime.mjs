import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import * as pqHarness from "./test-pq-two-instances.mjs";
import { validateExpandedUiResult } from "./test-pq-desktop-web.mjs";
import { validateGate as validateQtoxGate } from "./test-qtox-release-gate.mjs";

const execFileAsync = promisify(execFile);
const sourceRoot = path.resolve(import.meta.dirname, "..");
const mainRoot = path.dirname(sourceRoot);
const SHA = /^[A-F0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const BUILD = /^release-\d+\.\d+\.\d+-[a-f0-9]{12}-[a-f0-9]{12}$/u;
const PHASES = ["preflight", "windows", "verify-all"];
const STAGES = ["normal", "offline-first", "entropy", "formatting", "about", "fault"];
const FAULT_STAGES = ["offer", "accept", "finish", "ready", "commit", "done", "data", "ack", "close", "close_ready", "close_commit", "close_ack"];
const ROTATION_STAGES = ["refresh", "offer", "accept", "finish", "ready", "commit", "done", "data", "ack", "retire"];
const NORMAL_MESSAGE_LABELS = [
  "cross-first-alpha", "cross-first-beta", "queued-burst-alpha-1", "queued-burst-alpha-2",
  "queued-burst-alpha-3", "queued-burst-alpha-4", "active-alpha", "active-beta", "sender-restart-pending",
  "receiver-absent-pending", "old-epoch-backlog", "manual-only-plain",
];
const ROTATION_MESSAGE_SUFFIXES = ["old-ciphertext", "refresh-trigger", "new-alpha", "new-beta"];
const FAULT_MESSAGE_LABELS = [
  ...NORMAL_MESSAGE_LABELS, ...FAULT_STAGES.map((stage) => "fault-" + stage),
  ...ROTATION_STAGES.flatMap((stage) => ROTATION_MESSAGE_SUFFIXES.map((suffix) => `rotation-${stage}-${suffix}`)),
];
const NORMAL_SCENARIOS = [
  "online-crossed-first-send-auto-pq-and-ui-responsiveness",
  "active-pq-bidirectional-message-ratchets",
  "sender-hard-restart-with-pending-pq-ciphertext",
  "receiver-process-absent-while-pq-ciphertext-pending",
  "old-epoch-backlog-drains-before-bilateral-shutdown",
  "manual-shutdown-survives-restart-without-auto-pq",
];
const FORMATTING_CHECKS = [
  "noToolbar", "noFormattingWithoutSelection", "formattingGroupFirst", "exactRuEnLabels", "checkboxRoles",
  "ariaCheckedRoundTrip", "rightClickSelectionRetained", "keyboardMenuFocusedBold", "escapeSelectionRetained",
  "allFourApplied", "allFourRemoved", "outgoingSpansExact", "incomingSpansExact", "plaintextExact", "deliveryExact",
  "pqProtectionExact", "renderedElementsExact", "restartPersistenceExact",
];
const SCRIPT_PATHS = [
  "scripts/test-prerelease-runtime.mjs", "scripts/test-pq-two-instances.mjs", "scripts/test-pq-native-entropy.mjs",
  "scripts/test-pq-desktop-web.mjs", "scripts/test-qtox-release-gate.mjs",
];
const TASK_PATHS = [
  "verify-native-formatting.mjs", "verify-native-about.mjs", "build-pq-fault-artifact.ps1",
  "desktop-web-ui/formatting-ui.mjs", "desktop-web-ui/expanded-web-ui.mjs",
  "desktop-web-ui/settings-ui.mjs", "desktop-web-ui/driver-manifest.json",
];
const TOOL_PATHS = ["context.local/tools/Invoke-KaigenWindowsFinish.ps1", "context.local/tools/Invoke-KaigenVerifiedWindowsFinish.ps1", "context.local/tools/windows-finish-receipt.mjs", "context.local/tools/ui-layout-history.mjs"];
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function check(value, message) { if (!value) throw new Error(message); }
function createNativeRunId() { return "pq-two-instances-" + randomUUID().replaceAll("-", ""); }
function samePath(a, b) { return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase(); }
function inside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}
async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex").toUpperCase();
}
async function observedFile(file, label) {
  check(typeof file === "string" && inside(mainRoot, file), label + " is outside the main project");
  const resolved = path.resolve(file);
  const info = await lstat(resolved);
  check(info.isFile() && !info.isSymbolicLink() && samePath(await realpath(resolved), resolved), label + " is not an ordinary canonical file");
  const digest = await sha256(resolved);
  return { path: resolved, sha256: digest, bytes: info.size };
}
async function ordinaryFile(file, expectedHash, label) {
  check(SHA.test(expectedHash), label + " requires an explicit SHA-256 binding");
  const binding = await observedFile(file, label);
  check(binding.sha256 === expectedHash, label + " SHA-256 mismatch");
  return binding;
}
function requireBinding(binding, label) {
  check(binding && typeof binding === "object" && typeof binding.path === "string" && SHA.test(binding.sha256), label + " requires an explicit path and SHA-256 binding");
  return binding;
}
async function parseJsonFile(file, label) {
  check(file.bytes > 0 && file.bytes <= 8 * 1024 * 1024, label + " has an invalid JSON size");
  return { ...file, value: JSON.parse(await readFile(file.path, "utf8")) };
}
async function jsonFile(binding, label) {
  requireBinding(binding, label);
  return parseJsonFile(await ordinaryFile(binding.path, binding.sha256, label), label);
}
async function newReceipt(file, label) {
  // Only newly emitted receipts are observed without a prior digest; their enclosing report freezes it.
  return parseJsonFile(await observedFile(file, label), label);
}
async function exists(file) {
  try { await lstat(file); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}
async function newJson(file, value) {
  check(typeof file === "string" && inside(mainRoot, file), "output is outside the main project");
  const parent = path.dirname(path.resolve(file));
  check((await lstat(parent)).isDirectory() && samePath(await realpath(parent), parent), "output parent is not an ordinary canonical directory");
  await writeFile(file, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
}
function date(value, label) {
  const number = Date.parse(value);
  check(Number.isFinite(number), label + " timestamp is invalid");
  return number;
}
function candidateIdentity(value) {
  check(value && COMMIT.test(value.commit) && COMMIT.test(value.tree) && BUILD.test(value.buildId), "candidate identity is incomplete");
  check(SHA.test(value.sourceArchiveSha256), "candidate source archive hash is invalid");
  check(value.buildId.endsWith(value.tree.slice(0, 12) + "-" + value.sourceArchiveSha256.slice(0, 12).toLowerCase()), "candidate build ID does not bind its tree and source archive");
  date(value.frozenAtUtc, "candidate freeze");
  return {
    commit: value.commit, tree: value.tree, buildId: value.buildId,
    sourceArchiveSha256: value.sourceArchiveSha256, frozenAtUtc: value.frozenAtUtc,
  };
}
async function assertSource(identity) {
  const args = ["-c", "safe.directory=" + sourceRoot.replaceAll("\\", "/"), "-C", sourceRoot];
  const run = async (tail) => (await execFileAsync("git", [...args, ...tail], { maxBuffer: 1024 * 1024, windowsHide: true })).stdout.trim();
  check(await run(["rev-parse", "HEAD"]) === identity.commit, "current source HEAD changed from the frozen candidate");
  check(await run(["rev-parse", "HEAD^{tree}"]) === identity.tree, "current source tree changed from the frozen candidate");
  check(await run(["status", "--porcelain"]) === "", "runtime gate requires the clean frozen candidate");
}
async function bindExactFiles(bindings, expectedPaths, root, label) {
  check(Array.isArray(bindings), label + " manifest is missing");
  bindings.forEach((entry) => requireBinding(entry, label));
  assert.deepEqual(bindings.map((entry) => entry.path).sort(), [...expectedPaths].sort(), label + " manifest has missing or extra paths");
  return Promise.all(bindings.map((entry) => ordinaryFile(path.join(root, entry.path), entry.sha256, label + " " + entry.path)));
}
async function loadInputs(options) {
  const contract = await jsonFile({ path: options.contract, sha256: options.contractSha256 }, "runtime contract");
  const value = contract.value;
  check(value.schemaVersion === 1 && value.scope === "kaigen-prerelease-runtime" && value.status === "FROZEN", "runtime contract is not explicitly frozen");
  const identity = candidateIdentity(value.candidate);
  const [candidate, build] = await Promise.all([
    jsonFile(value.candidateIdentity, "candidate freeze identity"),
    jsonFile(value.buildContract, "candidate build contract"),
  ]);
  check(candidate.value.commit === identity.commit && candidate.value.tree === identity.tree && candidate.value.worktreeClean === true
    && candidate.value.frozenAtUtc === identity.frozenAtUtc, "candidate freeze identity mismatch");
  check(build.value.head === identity.commit && build.value.tree === identity.tree && build.value.buildId === identity.buildId
    && build.value.archiveSha256 === identity.sourceArchiveSha256 && build.value.privacyForbiddenMatches === 0, "candidate build contract mismatch");
  check(/^[a-f0-9]{32}$/u.test(build.value.windowsTransactionId), "Windows transaction identity is missing");
  const archive = await ordinaryFile(build.value.archive, identity.sourceArchiveSha256, "immutable source archive");
  check(inside(path.join(mainRoot, "outputs", identity.buildId, "snapshot"), archive.path), "source snapshot path is not owned by its build");
  const taskRoot = path.dirname(candidate.path);
  check(inside(path.join(mainRoot, "context.local", "work"), candidate.path), "candidate identity is outside the task work root");
  const bound = (await Promise.all([
    bindExactFiles(value.sourceScripts, SCRIPT_PATHS, sourceRoot, "source script"),
    bindExactFiles(value.taskChecks, TASK_PATHS, taskRoot, "task driver"),
    bindExactFiles(value.ownerTools, TOOL_PATHS, mainRoot, "owner tool"),
  ])).flat();
  for (const expected of value.taskChecks) {
    const entry = candidate.value.taskChecks?.find((item) => samePath(item.path, path.join(taskRoot, expected.path)));
    check(entry?.sha256 === expected.sha256, "task driver is not bound by the frozen candidate identity");
  }
  for (const name of ["qtoxRuntimeManifestSha256", "qtoxExecutableSha256"]) {
    check(SHA.test(value[name]) && value[name] === candidate.value[name], "qTox runtime input is not bound by the frozen candidate");
  }
  assert.deepEqual(pqHarness.PQ_FAULT_STAGES, FAULT_STAGES, "fault driver stage contract drifted");
  assert.deepEqual(pqHarness.PQ_ROTATION_FAULT_STAGES, ROTATION_STAGES, "rotation driver stage contract drifted");
  await assertSource(identity);
  const artifactsDir = path.join(mainRoot, "outputs", identity.buildId, "windows", "artifacts");
  if (options.transactionId) check(options.transactionId === build.value.windowsTransactionId, "wrapper transaction differs from the frozen contract");
  if (options.artifactsDir) check(samePath(options.artifactsDir, artifactsDir), "wrapper artifact path differs from the frozen contract");
  return { contract, identity, candidate, build, taskRoot, bound, artifactsDir, shippingRoot: path.join(artifactsDir, "Kaigen-portable") };
}
async function recheckInputs(inputs) {
  await assertSource(inputs.identity);
  for (const binding of [inputs.contract, inputs.candidate, inputs.build, ...inputs.bound]) await ordinaryFile(binding.path, binding.sha256, "frozen input");
}
async function zipExecutableSha256(archive) {
  // The path is a child-only environment value, never interpolated into PowerShell code.
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.IO.Compression.FileSystem",
    "$zip = [IO.Compression.ZipFile]::OpenRead($env:KAIGEN_RUNTIME_GATE_ARCHIVE)",
    "try {",
    "  $entries = @($zip.Entries | Where-Object { $_.FullName.Replace('\\', '/') -ceq 'Kaigen-portable/Kaigen.exe' })",
    "  if ($entries.Count -ne 1) { throw 'Shipping archive must contain one exact Kaigen executable' }",
    "  $stream = $entries[0].Open()",
    "  try { [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($stream)) } finally { $stream.Dispose() }",
    "} finally { $zip.Dispose() }",
  ].join("\n");
  const result = await execFileAsync("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
    env: { ...process.env, KAIGEN_RUNTIME_GATE_ARCHIVE: archive }, windowsHide: true, maxBuffer: 1024 * 1024,
  });
  const digest = result.stdout.trim();
  check(SHA.test(digest), "shipping ZIP executable hash was unavailable");
  return digest;
}
function validateWindowsSourceTree(value, current) {
  check(value?.sha256 === current.hash && value.count === current.count && Number.isInteger(current.count) && current.count > 0,
    "Windows finish receipt differs from the independently computed current production source tree");
}
async function windowsInputs(inputs, receipt) {
  const value = receipt.value;
  check(value.status === "PASS" && value.operation === "main-change" && value.validationProfile === "full"
    && value.transactionId === inputs.build.value.windowsTransactionId, "Windows receipt is not the exact full main-change PASS");
  check(date(value.createdAt, "Windows finish") >= date(inputs.identity.frozenAtUtc, "candidate freeze"), "Windows finish receipt predates the candidate");
  const [{ validateWindowsFinishReceipt }, { buildSourceTree }] = await Promise.all([
    import(pathToFileURL(path.join(mainRoot, "context.local/tools/windows-finish-receipt.mjs")).href),
    import(pathToFileURL(path.join(mainRoot, "context.local/tools/ui-layout-history.mjs")).href),
  ]);
  const currentSourceTree = await buildSourceTree();
  validateWindowsSourceTree(value.sourceTree, currentSourceTree);
  await validateWindowsFinishReceipt(receipt.path, {
    operation: "main-change", transactionId: inputs.build.value.windowsTransactionId, sourceTreeHash: currentSourceTree.hash,
  });
  const archive = await ordinaryFile(value.archive?.path, value.archive?.sha256?.toUpperCase(), "shipping Windows archive");
  check(samePath(archive.path, path.join(inputs.artifactsDir, "Kaigen-portable-windows-x64.zip")), "Windows archive belongs to another build");
  const executable = await ordinaryFile(path.join(inputs.shippingRoot, "Kaigen.exe"), await zipExecutableSha256(archive.path), "shipping executable bound to ZIP");
  return { receipt, archive, executable };
}
function scenario(value, name, status = "pass") {
  const entries = value.scenarios?.filter((entry) => entry.name === name);
  check(entries?.length === 1 && entries[0].status === status, "required actual scenario missing or failed: " + name);
  return entries[0];
}
function validateFreshReceipt(value, expected) {
  check(value.schemaVersion === 1 && value.runId === expected.runId, "native receipt run identity mismatch");
  check(date(value.startedAt, "native start") >= date(expected.startedAt, "stage start")
    && date(value.completedAt, "native completion") >= date(value.startedAt, "native start"), "native receipt is stale or incomplete");
  check(value.profilesDisposed === true && !value.failure && !value.processCleanupFailures?.length, "native receipt lacks successful disposable cleanup");
  const executable = value.artifact?.sha256 ?? value.identity?.executableSha256 ?? value.executableSha256;
  check(executable === expected.executableSha256, "native receipt executable mismatch");
}
function validateNativeReceipt(stage, value, expected) {
  validateFreshReceipt(value, expected);
  if (stage !== "formatting") check(value.processCleanup?.capturedOwnedProcesses === (stage === "about" ? 1 : 2)
    && value.processCleanup.allExited === true && value.processCleanup.stopFailures === 0, "native receipt lacks exact owned process cleanup");
  if (["normal", "offline-first", "fault"].includes(stage)) {
    check(value.status === "pass" && value.expectedPqProtocolVersion === 2, "two-instance runtime did not pass PQ v2");
    check(value.firstSendMode === (stage === "offline-first" ? "offline-ordinary" : "online-automatic-pq"), "two-instance first-send mode mismatch");
    check(value.faultStages?.requested === (stage === "fault"), "shipping and feature runtime modes were confused");
    const final = scenario(value, "final-no-loss-no-duplicates-readback");
    const messageCount = stage === "offline-first" ? 4 : stage === "fault" ? 64 : 12;
    check(final.expectedMessages === messageCount && final.exactSenderRows === messageCount && final.exactReceiverRows === messageCount, "final exact message readback count is incomplete");
    check(Array.isArray(final.delivered) && final.delivered.length === final.expectedMessages, "final per-message evidence is incomplete");
    const labels = new Set();
    for (const row of final.delivered) {
      check(typeof row.label === "string" && row.label.length > 0 && !labels.has(row.label), "final readback labels were missing or duplicated");
      labels.add(row.label);
      check(row.senderCount === 1 && row.receiverCount === 1 && row.senderDelivery === "delivered"
        && typeof row.pqProtected === "boolean", "final per-message delivery or protection evidence failed");
      if (stage === "offline-first") check(row.pqProtected === false, "offline-first ordinary message was incorrectly protected");
      else check(row.pqProtected === (row.label !== "manual-only-plain"), "final per-message protection differs from the exact manual-only policy");
    }
    if (stage === "offline-first") {
      scenario(value, "offline-first-ordinary-queues-survive-restart-and-late-capability");
    } else {
      check(labels.has("manual-only-plain"), "final readback omitted the required manual-only ordinary delivery");
      NORMAL_SCENARIOS.forEach((name) => scenario(value, name));
    }
    if (stage === "fault") {
      assert.deepEqual([...labels].sort(), [...FAULT_MESSAGE_LABELS].sort(), "fault final message label inventory mismatch");
      check(value.faultStages.feature === "pq-fault-tests" && value.faultStages.exactBarrierContract === true, "fault artifact feature evidence is missing");
      assert.deepEqual(value.faultStages.supportedStages, FAULT_STAGES, "fault support inventory mismatch");
      assert.deepEqual(value.faultStages.completedStages, FAULT_STAGES, "fault completion inventory mismatch");
      for (const stageName of FAULT_STAGES) {
        const name = stageName === "ack" ? "exact-v2-ack-after-receive-suppression-process-restart" : "exact-v2-" + stageName + "-suppression-process-restart";
        const row = scenario(value, name);
        check(row.processCut?.exactArmedPidExited === true, "exact fault process exit evidence is missing");
        check(row.barrier?.triggered === true && row.barrier.suppressedBeforeTransport === true
          && row.barrier.blocksPeerV2UntilProcessExit === true, "exact fault barrier evidence is missing");
      }
      check(value.rotationFaults?.requested === true && value.rotationFaults.inPlace === true, "in-place rotation evidence is missing");
      assert.deepEqual(value.rotationFaults.supportedStages, ROTATION_STAGES, "rotation support inventory mismatch");
      assert.deepEqual(value.rotationFaults.completedStages, ROTATION_STAGES, "rotation completion inventory mismatch");
      for (const stageName of ROTATION_STAGES) {
        const row = scenario(value, "exact-v2-rotation-" + stageName + "-suppression-process-restart");
        for (const key of ["inPlace", "oldEpochRetained", "oldCiphertextQueuedWhileOnline", "oldCiphertextUnchanged", "newEpochActivated", "bothPeersOnlineAtActivation", "oldEpochRetired", "oldCiphertextDelivered"])
          check(row[key] === true, "rotation " + stageName + " lacks " + key);
        check(SHA.test(row.oldCiphertextSha256), "rotation lacks the held original ciphertext hash");
        check(["alpha", "beta"].includes(row.coordinator) && row.oldCiphertextSender === row.coordinator
          && row.oldCiphertextReceiver === (row.coordinator === "alpha" ? "beta" : "alpha"), "rotation sender/receiver roles mismatch");
        const target = ["offer", "finish", "commit", "data", "retire"].includes(stageName) ? row.oldCiphertextSender : row.oldCiphertextReceiver;
        check(row.stage === stageName && row.barrier?.stage === stageName && row.processCut?.armedProcess === target,
          "rotation cut stage or process role mismatch");
        const trigger = row.refreshTrigger;
        const triggerLabel = "rotation-" + stageName + "-refresh-trigger";
        check(trigger?.label === triggerLabel && trigger.sender === row.oldCiphertextReceiver && trigger.receiver === row.oldCiphertextSender
          && trigger.bothPeersOffline === true && trigger.requestedOnNonCoordinator === true && trigger.deliveredBeforeOldRelease === true,
          "rotation lacks the distinct offline refresh trigger before old ciphertext release");
        check(trigger.queued?.label === triggerLabel && trigger.queued.senderCount === 1 && trigger.queued.pqProtected === true
          && trigger.queued.delivery === "pending", "rotation refresh trigger was not durably pending while offline");
        check(Array.isArray(row.delivered) && row.delivered.length === 4, "rotation requires four exact protected deliveries");
        assert.deepEqual(row.delivered.map((message) => message.label).sort(),
          ROTATION_MESSAGE_SUFFIXES.map((suffix) => `rotation-${stageName}-${suffix}`).sort(), "rotation delivery label inventory mismatch");
        for (const message of row.delivered) assert.deepEqual(message, final.delivered.find((item) => item.label === message.label),
          "rotation delivery differs from final exact history readback");
        assert.deepEqual(trigger.delivered, row.delivered.find((message) => message.label === triggerLabel),
          "rotation refresh trigger delivery/ACK evidence mismatch");
        check(row.receivedBeforeAckCut === (stageName === "ack"), "rotation ACK cut lacks prior durable incoming plaintext");
        check(row.processCut?.exactArmedPidExited === true, "rotation did not prove exact armed process exit");
        check(row.manualStartInvoked === false && row.activationRetainedEpochs?.alpha === 2 && row.activationRetainedEpochs?.beta === 2,
          "rotation was substituted by manual re-establishment or dropped the active old epoch");
        check(row.barrier?.triggered === true && row.barrier.suppressedBeforeTransport === true
          && row.barrier.blocksPeerV2UntilProcessExit === true && row.barrier.rotationParentMatched === true,
          "exact rotation barrier evidence is missing");
      }
    }
  } else if (stage === "entropy") {
    check(value.status === "pass" && value.driver === "pq-native-entropy-v1" && value.expectedPqProtocolVersion === 2, "real native entropy did not pass");
    check(value.setup?.processes === 2 && value.setup.isolatedPortableRoots === true, "native entropy lacked two isolated real processes");
    check(value.entropyChoices?.alpha?.choice === "additional-pointer-noise" && value.entropyChoices?.beta?.choice === "system-only"
      && value.entropyChoices.beta.explicitUiAction === true, "both real native entropy choices were not exercised");
    check(value.entropyChoices.alpha.pointerPaths?.mousePointerPathObserved === true
      && value.entropyChoices.alpha.pointerPaths?.touchPointerPathObserved === true, "native entropy pointer paths were not exercised");
    for (const [label, length] of [["alpha", 32], ["beta", 0]]) {
      const command = value.entropyChoices[label].command;
      check(command?.calls === 1 && command.extraNoiseLength === length && command.byteShape === true
        && command.expectedContact === true && command.ipcDispatched === true && command.nativeResponseReceived === true,
        "native entropy IPC evidence is incomplete for " + label);
    }
    check(value.delivery?.lifetimeFirstMessages === 2 && value.delivery.exactNoDuplicates === true, "entropy run lacks exact protected deliveries");
    assert.deepEqual(value.delivery.rows?.map((row) => row.label).sort(), ["alpha-lifetime-first-message", "beta-lifetime-first-message"], "entropy exact bidirectional delivery rows are missing");
    for (const row of value.delivery.rows) check(row.senderCount === 1 && row.receiverCount === 1
      && row.senderDelivery === "delivered" && row.pqProtected === true, "entropy exact protected delivery evidence failed");
  } else if (stage === "formatting") {
    check(value.status === "PASS" && value.topology?.nativeProcesses === 2 && value.topology.productionContacted === false, "native formatting topology/status mismatch");
    for (const key of FORMATTING_CHECKS) check(value.formatting?.checks?.[key] === true, "native formatting lacks " + key);
    check(value.formatting?.status === "PASS" && value.uiChecks?.status === "PASS" && value.uiChecks.reactions?.status === "PASS"
      && value.contextMenuUi?.status === "PASS", "native formatting/context-menu UI did not pass");
    check(value.bootstrapFocus?.status === "PASS" && value.uiChecks.bootstrapVisibility?.alpha?.focused === true
      && value.uiChecks.bootstrapVisibility?.beta?.focused === false, "native focus precondition was not maintained");
    check(value.focusTrace?.removed === true && !value.focusTrace.captureFailed, "passive focus trace was not removed cleanly");
  } else if (stage === "about") {
    check(value.status === "passed" && value.versions?.matchedCount === 18 && value.versions.expectedCount === 18
      && value.versions.commitPrefixesMatched === 2, "native About component inventory did not pass");
    check(value.wallets?.matchedCount === 5 && value.wallets.expectedCount === 5 && value.wallets.exactOrderAndAddresses === true
      && value.wallets.copyButtonsPresent === true, "native About wallet check did not pass");
  } else check(false, "unknown native runtime stage");
}
function nativeScreenshots(stage, receipt) {
  check(Array.isArray(receipt.screenshots) && receipt.screenshots.length > 0, "actual screenshot evidence is missing");
  if (stage !== "formatting") return receipt.screenshots;
  check(Array.isArray(receipt.contextMenuUi?.screenshots) && receipt.contextMenuUi.screenshots.length > 0, "native context-menu screenshots are missing");
  return [...receipt.screenshots, ...receipt.contextMenuUi.screenshots];
}
async function screenshotFiles(receipt, entries = receipt.value.screenshots, expectedBindings) {
  check(Array.isArray(entries) && entries.length > 0, "actual screenshot evidence is missing");
  const names = entries.map((item) => typeof item === "string" ? item : item?.name ?? item?.file);
  check(new Set(names).size === names.length, "screenshot inventory contains duplicate names");
  if (expectedBindings !== undefined) {
    check(Array.isArray(expectedBindings), "enclosing screenshot bindings are missing");
    assert.deepEqual(expectedBindings.map((binding) => binding.name), names, "enclosing screenshot inventory mismatch");
  }
  const bindings = [];
  for (const [index, item] of entries.entries()) {
    const name = names[index];
    check(typeof name === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*\.png$/u.test(name), "screenshot path is unsafe");
    const file = path.join(path.dirname(receipt.path), name);
    const expected = expectedBindings?.[index];
    if (expected) {
      check(SHA.test(expected.sha256), "enclosing screenshot requires an explicit SHA-256 binding");
      if (typeof item !== "string") check(item.sha256 === expected.sha256, "receipt and enclosing screenshot hashes differ");
    }
    const binding = expected ? await ordinaryFile(file, expected.sha256, "runtime screenshot")
      : typeof item === "string" ? await observedFile(file, "new runtime screenshot")
      : await ordinaryFile(file, item.sha256, "runtime screenshot");
    const bytes = await readFile(binding.path);
    check(bytes.length >= 1024 && bytes.subarray(0, PNG.length).equals(PNG), "runtime screenshot is not a nontrivial PNG");
    bindings.push({ name, sha256: binding.sha256, bytes: binding.bytes });
  }
  return bindings;
}
async function child(executable, args, cwd) {
  await new Promise((resolve, reject) => {
    const process = spawn(executable, args, { cwd, stdio: "inherit", windowsHide: true, shell: false });
    process.once("error", reject);
    process.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error("runtime child failed: " + path.basename(executable) + " exit=" + code + " signal=" + signal)));
  });
}
function validateFaultArtifact(value, inputs, shipping) {
  check(value.schemaVersion === 1 && value.buildId === inputs.identity.buildId && value.commit === inputs.identity.commit
    && value.tree === inputs.identity.tree && value.sourceSha256 === inputs.identity.sourceArchiveSha256, "fault artifact candidate identity mismatch");
  check(value.artifactKind === "disposable-pq-fault-tests" && value.feature === "pq-fault-tests"
    && value.shippingUnchanged === true && value.sourceClean === true, "fault artifact is not the separate validated feature build");
  check(value.shippingExeSha256 === shipping.executable.sha256 && SHA.test(value.featureExeSha256)
    && value.featureExeSha256 !== value.shippingExeSha256, "shipping and fault executable hashes were confused");
}
async function faultArtifact(inputs, shipping, buildIfMissing, expectedReceipt) {
  const file = path.join(path.dirname(inputs.artifactsDir), "pq-fault-artifact.json");
  if (!await exists(file)) {
    check(buildIfMissing, "dedicated fault artifact receipt is missing");
    await recheckInputs(inputs);
    await child("pwsh", ["-NoLogo", "-NoProfile", "-File", path.join(inputs.taskRoot, "build-pq-fault-artifact.ps1"),
      "-ShippingArtifactRoot", inputs.shippingRoot, "-ExpectedCommit", inputs.identity.commit, "-BuildId", inputs.identity.buildId], mainRoot);
  }
  const receipt = buildIfMissing ? await newReceipt(file, "new fault artifact receipt") : await jsonFile(expectedReceipt, "fault artifact receipt");
  check(samePath(receipt.path, file), "fault artifact receipt escaped the exact build root");
  validateFaultArtifact(receipt.value, inputs, shipping);
  const root = path.join(path.dirname(inputs.artifactsDir), "pq-fault-portable");
  check(samePath(receipt.value.featureRoot, root), "fault artifact escaped the exact build root");
  const executable = await ordinaryFile(path.join(root, "Kaigen.exe"), receipt.value.featureExeSha256, "fault feature executable");
  await ordinaryFile(shipping.executable.path, shipping.executable.sha256, "unchanged shipping executable");
  return { receipt, executable, root };
}
function runtimeIdentity(inputs, shipping) {
  return { ...inputs.identity, runtimeContractSha256: inputs.contract.sha256, windowsArchiveSha256: shipping.archive.sha256, shippingExeSha256: shipping.executable.sha256 };
}
function stageDriver(inputs, stage) {
  return stage === "entropy" ? path.join(sourceRoot, "scripts/test-pq-native-entropy.mjs")
    : stage === "formatting" ? path.join(inputs.taskRoot, "verify-native-formatting.mjs")
    : stage === "about" ? path.join(inputs.taskRoot, "verify-native-about.mjs")
    : path.join(sourceRoot, "scripts/test-pq-two-instances.mjs");
}
function boundHash(inputs, file) {
  const binding = inputs.bound.find((entry) => samePath(entry.path, file));
  check(binding, "runtime stage driver is outside the frozen file manifest");
  return binding.sha256;
}
function validateFormattingGraph(inputs, receipt) {
  check(receipt.identity?.driverSha256 === boundHash(inputs, path.join(inputs.taskRoot, "verify-native-formatting.mjs"))
    && receipt.identity?.helperSha256 === boundHash(inputs, path.join(sourceRoot, "scripts/test-pq-two-instances.mjs"))
    && receipt.identity?.formattingCoreSha256 === boundHash(inputs, path.join(inputs.taskRoot, "desktop-web-ui/formatting-ui.mjs")),
    "native formatting receipt used another driver graph");
}
function validateWebGraph(inputs, receipt) {
  const modules = {
    uiDriverManifestSha256: "driver-manifest.json", uiDriverSha256: "expanded-web-ui.mjs",
    uiSettingsDriverSha256: "settings-ui.mjs", uiFormattingDriverSha256: "formatting-ui.mjs",
  };
  for (const [field, name] of Object.entries(modules)) check(receipt.identity?.[field]
    === boundHash(inputs, path.join(inputs.taskRoot, "desktop-web-ui", name)), "Desktop-Web receipt used another frozen UI driver graph: " + field);
}
function validateDesktopWebEvidence(web) {
  for (const name of ["real-topology-and-identity", "lifetime-first-send-online-auto-pq",
    "browser-document-reload-reauthentication", "real-web-backend-outage-bidirectional-old-epoch-recovery",
    "manual-only-persists-across-desktop-and-browser-restarts", "expanded-ui-manual-pq-reactivation"]) scenario(web, name, "PASS");
  const final = web.finalHistory;
  check(final?.expected === 7 && final.pqProtected === 6 && final.ordinary === 1 && final.duplicates === 0
    && final.desktopExact === true && final.webExact === true && final.directionsExact === true
    && final.senderReceiptsDelivered === true && SHA.test(final.messageSetSha256), "Desktop-Web final exact delivery history is incomplete");
  const outage = scenario(web, "real-web-backend-outage-bidirectional-old-epoch-recovery", "PASS");
  for (const key of ["webObservedDesktopOffline", "desktopObservedWebOffline", "webPendingBeforeServiceStop",
    "webPendingAfterServiceRestart", "desktopPendingBeforeProcessRestart", "bilateralShutdownAfterDrain"])
    check(outage[key] === true, "Desktop-Web real outage lacks " + key);
  check(outage.exactDeliveriesAfterBothProcessesRecovered === 2, "Desktop-Web outage did not recover both exact old-epoch deliveries");
  for (const key of ["readyStopSha256", "stoppedSha256", "readyStartSha256", "startedSha256"])
    check(SHA.test(outage.ownerCoordination?.[key]), "Desktop-Web outage lacks the owner coordination binding " + key);
}
async function runWindows(inputs, options) {
  check(process.platform === "win32", "actual Windows runtime gate requires Windows");
  check(!await exists(options.output), "refusing to overwrite a runtime gate output");
  const shipping = await windowsInputs(inputs, await newReceipt(options.windowsReceipt, "new Windows finish receipt"));
  const report = {
    schemaVersion: 1, scope: "kaigen-prerelease-runtime", phase: "windows", status: "RUNNING",
    identity: runtimeIdentity(inputs, shipping), startedAt: new Date().toISOString(), completedAt: null,
    windowsReceipt: { path: shipping.receipt.path, sha256: shipping.receipt.sha256 },
    stages: [], faultArtifact: null, coverage: "windows-native-runtime", fullPlatformReleaseGate: false,
  };
  let failure;
  let activeStage;
  try {
    for (const stage of STAGES) {
      await recheckInputs(inputs);
      const fault = stage === "fault" ? await faultArtifact(inputs, shipping, true) : null;
      if (fault) report.faultArtifact = { path: fault.receipt.path, sha256: fault.receipt.sha256 };
      const root = fault?.root ?? inputs.shippingRoot;
      const executable = fault?.executable ?? shipping.executable;
      const driver = stageDriver(inputs, stage);
      const runId = createNativeRunId();
      const runRoot = path.join(inputs.taskRoot, "two-instance-runs", runId);
      check(!await exists(runRoot), "native stage requires a fresh disposable root");
      pqHarness.requireWebViewPathBudget(path.join(runRoot, "instances", "alpha"));
      const args = [driver, "--artifact-root", root, "--run-root", runRoot];
      if (stage === "offline-first") args.push("--offline-first-ordinary");
      if (stage === "fault") args.push("--fault-stages");
      const startedAt = new Date().toISOString();
      activeStage = { stage, runId, runRoot };
      console.log("[prerelease-runtime] actual native stage " + stage);
      await child(process.execPath, args, mainRoot);
      const leaf = stage === "entropy" ? "native-entropy-receipt.json" : stage === "about" ? "native-about-receipt.json" : "receipt.json";
      const receipt = await newReceipt(path.join(runRoot, "evidence", leaf), stage + " new actual receipt");
      const expected = { runId, startedAt, executableSha256: executable.sha256 };
      validateNativeReceipt(stage, receipt.value, expected);
      if (stage === "formatting") validateFormattingGraph(inputs, receipt.value);
      const screenshots = await screenshotFiles(receipt, nativeScreenshots(stage, receipt.value));
      await recheckInputs(inputs);
      await ordinaryFile(executable.path, executable.sha256, "unchanged stage executable");
      report.stages.push({ stage, status: "PASS", ...expected, driverSha256: boundHash(inputs, driver), receipt: { path: receipt.path, sha256: receipt.sha256 }, screenshots });
      activeStage = null;
    }
    await ordinaryFile(shipping.archive.path, shipping.archive.sha256, "unchanged shipping archive");
    report.status = "PASS";
  } catch (error) {
    failure = error;
    report.status = "FAIL";
    report.failure = { stage: STAGES[report.stages.length] ?? "final", activeStage, message: "Required actual runtime stage or immutable evidence validation failed; inspect the stage receipt and command output." };
  } finally {
    report.completedAt = new Date().toISOString();
    await newJson(options.output, report);
  }
  if (failure) throw failure;
  return report;
}
async function verifyWindowsReport(inputs, binding, shipping) {
  const report = await jsonFile(binding, "Windows runtime report");
  const value = report.value;
  check(value.schemaVersion === 1 && value.scope === "kaigen-prerelease-runtime" && value.phase === "windows"
    && value.status === "PASS" && value.fullPlatformReleaseGate === false, "Windows-only runtime report is missing or not the exact phase");
  assert.deepEqual(value.identity, runtimeIdentity(inputs, shipping), "Windows runtime report candidate/artifact identity mismatch");
  check(value.windowsReceipt?.sha256 === shipping.receipt.sha256 && samePath(value.windowsReceipt.path, shipping.receipt.path), "Windows runtime report references another finish receipt");
  check(date(value.startedAt, "Windows runtime start") >= date(shipping.receipt.value.createdAt, "Windows finish"), "Windows runtime report predates the fresh build");
  check(date(value.completedAt, "Windows runtime completion") >= date(value.startedAt, "Windows runtime start"), "Windows runtime report is incomplete");
  assert.deepEqual(value.stages?.map((entry) => entry.stage), STAGES, "Windows runtime report omitted or duplicated a required stage");
  const fault = await faultArtifact(inputs, shipping, false, value.faultArtifact);
  check(value.faultArtifact?.sha256 === fault.receipt.sha256 && samePath(value.faultArtifact.path, fault.receipt.path), "Windows runtime report fault artifact mismatch");
  const runIds = new Set();
  for (const entry of value.stages) {
    check(entry.status === "PASS" && !runIds.has(entry.runId), "native stage failed or reused another run");
    check(date(entry.startedAt, "native stage start") >= date(value.startedAt, "Windows runtime start"), "native stage predates the current runtime run");
    check(entry.driverSha256 === boundHash(inputs, stageDriver(inputs, entry.stage)), "native stage driver hash mismatch");
    runIds.add(entry.runId);
    const receipt = await jsonFile(entry.receipt, entry.stage + " actual receipt");
    check(inside(path.join(inputs.taskRoot, "two-instance-runs", entry.runId, "evidence"), receipt.path), "native receipt escaped its exact run root");
    const expectedHash = entry.stage === "fault" ? fault.executable.sha256 : shipping.executable.sha256;
    check(entry.executableSha256 === expectedHash, "native stage used another artifact");
    validateNativeReceipt(entry.stage, receipt.value, entry);
    check(date(receipt.value.completedAt, "native completion") <= date(value.completedAt, "Windows runtime completion"), "native receipt completed after its enclosing report");
    if (entry.stage === "formatting") validateFormattingGraph(inputs, receipt.value);
    check(Array.isArray(entry.screenshots) && entry.screenshots.length > 0, "native report omitted its frozen screenshot bindings");
    await screenshotFiles(receipt, nativeScreenshots(entry.stage, receipt.value), entry.screenshots);
  }
  return report;
}
async function verifyAll(inputs, options) {
  const manifest = await jsonFile({ path: options.evidenceManifest, sha256: options.evidenceManifestSha256 }, "runtime evidence manifest");
  check(manifest.value.schemaVersion === 1 && manifest.value.scope === "kaigen-prerelease-runtime-evidence", "runtime evidence manifest scope mismatch");
  assert.deepEqual(manifest.value.candidate, inputs.identity, "runtime evidence manifest candidate mismatch");
  const windowsEnvelope = await jsonFile(manifest.value.windows, "Windows runtime report");
  const shipping = await windowsInputs(inputs, await jsonFile(windowsEnvelope.value.windowsReceipt, "Windows finish receipt"));
  const windows = await verifyWindowsReport(inputs, manifest.value.windows, shipping);
  const [webCandidate, webReady, desktopWeb] = await Promise.all([
    jsonFile(manifest.value.webCandidate, "imported Web candidate contract"),
    jsonFile(manifest.value.webReady, "imported Web READY receipt"),
    jsonFile(manifest.value.desktopWeb, "actual Desktop-Web receipt"),
  ]);
  check(webCandidate.value.buildId === inputs.identity.buildId && webCandidate.value.source?.tree === inputs.identity.tree
    && webCandidate.value.source?.archive?.sha256 === inputs.identity.sourceArchiveSha256, "Web candidate source differs from the frozen candidate");
  check(webReady.value.schemaVersion === 2 && webReady.value.status === "ready" && webReady.value.buildId === inputs.identity.buildId
    && SHA.test(webReady.value.package?.sha256) && webReady.value.contractSha256 === webCandidate.sha256
    && webReady.value.source?.archiveSha256 === inputs.identity.sourceArchiveSha256, "Web READY is not the exact candidate package proof");
  const web = desktopWeb.value;
  check(web.status === "PASS" && web.identity?.candidateId === inputs.identity.buildId
    && web.identity.sourceTree === inputs.identity.tree && web.identity.sourceArchiveSha256 === inputs.identity.sourceArchiveSha256
    && web.identity.desktopExeSha256 === shipping.executable.sha256 && web.identity.webPackageSha256 === webReady.value.package.sha256
    && web.identity.candidateContractSha256 === webCandidate.sha256 && web.identity.webReadyReceiptSha256 === webReady.sha256, "Desktop-Web receipt has another candidate/artifact identity");
  check(date(web.startedAt, "Desktop-Web start") >= date(inputs.identity.frozenAtUtc, "candidate freeze")
    && date(web.completedAt, "Desktop-Web completion") >= date(web.startedAt, "Desktop-Web start"), "Desktop-Web receipt is stale or incomplete");
  check(web.workspaceDestroyed === true && web.localProfilesDisposed === true && web.topology?.productionContacted === false
    && !web.failure && !web.processCleanupFailures?.length, "Desktop-Web receipt lacks successful disposable cleanup");
  validateWebGraph(inputs, web);
  validateDesktopWebEvidence(web);
  const expanded = await jsonFile({ path: path.join(path.dirname(desktopWeb.path), "expanded-ui", "receipt.json"), sha256: web.expandedUi?.receiptSha256 }, "actual expanded Web UI receipt");
  validateExpandedUiResult(expanded.value, inputs.identity.buildId);
  const { receiptSha256, ...embeddedExpanded } = web.expandedUi;
  assert.deepEqual(embeddedExpanded, expanded.value, "embedded and standalone expanded Web UI evidence differ");
  await screenshotFiles(expanded);
  await Promise.all([jsonFile(manifest.value.qtox?.desktop, "Desktop qTox receipt"), jsonFile(manifest.value.qtox?.web, "Web qTox receipt")]);
  const qtox = await validateQtoxGate({
    desktopReceipt: manifest.value.qtox?.desktop?.path, desktopReceiptSha256: manifest.value.qtox?.desktop?.sha256,
    webReceipt: manifest.value.qtox?.web?.path, webReceiptSha256: manifest.value.qtox?.web?.sha256,
    kaigenCommit: inputs.identity.commit, sourceTree: inputs.identity.tree, buildId: inputs.identity.buildId,
    desktopArtifactSha256: shipping.executable.sha256, webArtifactSha256: webReady.value.package.sha256,
    qtoxRuntimeManifestSha256: inputs.contract.value.qtoxRuntimeManifestSha256,
    qtoxExecutableSha256: inputs.contract.value.qtoxExecutableSha256,
  });
  await recheckInputs(inputs);
  const report = {
    schemaVersion: 1, scope: "kaigen-prerelease-runtime", phase: "verify-all", status: "PASS",
    identity: runtimeIdentity(inputs, shipping), evidenceManifestSha256: manifest.sha256,
    windowsRuntimeReceiptSha256: windows.sha256, desktopWebReceiptSha256: desktopWeb.sha256,
    expandedWebUiReceiptSha256: expanded.sha256, qtox,
    coverage: "required-windows-web-runtime", fullPlatformReleaseGate: false, completedAt: new Date().toISOString(),
  };
  await newJson(options.output, report);
  return report;
}
function parseArguments(argv) {
  const result = {};
  const keys = new Map([
    ["--phase", "phase"], ["--contract", "contract"], ["--contract-sha256", "contractSha256"],
    ["--windows-receipt", "windowsReceipt"], ["--output", "output"],
    ["--evidence-manifest", "evidenceManifest"], ["--evidence-manifest-sha256", "evidenceManifestSha256"],
    ["--transaction-id", "transactionId"], ["--artifacts-dir", "artifactsDir"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--self-test") result.selfTest = true;
    else if (item === "--help") result.help = true;
    else {
      const key = keys.get(item);
      check(key && result[key] === undefined && argv[index + 1] && !argv[index + 1].startsWith("--"), "unknown, duplicate or incomplete option");
      result[key] = argv[++index];
    }
  }
  if (result.selfTest || result.help) {
    check(Object.keys(result).length === 1, "self-test/help cannot be combined with runtime arguments");
    return result;
  }
  check(PHASES.includes(result.phase) && result.contract && SHA.test(result.contractSha256), "an explicit phase and hash-bound frozen contract are required");
  if (result.phase !== "preflight") check(result.output, "runtime output path is required");
  if (result.phase === "windows") check(result.windowsReceipt, "fresh Windows finish receipt is required");
  if (result.phase === "verify-all") check(result.evidenceManifest && SHA.test(result.evidenceManifestSha256), "hash-bound complete evidence manifest is required");
  return result;
}
async function selfTest() {
  const freshRunIds = STAGES.map(() => createNativeRunId());
  assert.equal(new Set(freshRunIds).size, STAGES.length);
  for (const runId of freshRunIds) assert.match(runId, /^pq-two-instances-[0-9a-f]{32}$/u);
  assert.throws(() => parseArguments(["--phase", "windows", "--contract", "draft.json", "--contract-sha256", "A".repeat(64)]), /output/u);
  assert.throws(() => parseArguments(["--phase", "verify-all", "--contract", "candidate.json", "--contract-sha256", "A".repeat(64), "--output", "out.json"]), /complete evidence/u);
  const expected = { runId: "fresh-run", startedAt: "2026-09-09T00:00:00.000Z", executableSha256: "A".repeat(64) };
  const offline = {
    schemaVersion: 1, status: "pass", runId: expected.runId, startedAt: expected.startedAt, completedAt: "2026-09-09T00:01:00.000Z",
    profilesDisposed: true, failure: null, artifact: { sha256: expected.executableSha256 }, expectedPqProtocolVersion: 2,
    processCleanup: { capturedOwnedProcesses: 2, allExited: true, stopFailures: 0 },
    firstSendMode: "offline-ordinary", faultStages: { requested: false },
    scenarios: [
      { name: "offline-first-ordinary-queues-survive-restart-and-late-capability", status: "pass" },
      { name: "final-no-loss-no-duplicates-readback", status: "pass", expectedMessages: 4, exactSenderRows: 4, exactReceiverRows: 4,
        delivered: Array.from({ length: 4 }, (_, index) => ({ label: "ordinary-" + index, senderCount: 1, receiverCount: 1, senderDelivery: "delivered", pqProtected: false })) },
    ],
  };
  validateNativeReceipt("offline-first", offline, expected);
  const reject = (mutate, pattern) => {
    const value = structuredClone(offline);
    mutate(value);
    assert.throws(() => validateNativeReceipt("offline-first", value, expected), pattern);
  };
  reject((value) => { value.artifact.sha256 = "B".repeat(64); }, /executable/u);
  reject((value) => { value.startedAt = "2026-09-08T23:59:59.000Z"; }, /stale/u);
  reject((value) => { value.runId = "old-run"; }, /run identity/u);
  reject((value) => { value.firstSendMode = "online-automatic-pq"; }, /mode/u);
  reject((value) => { value.faultStages.requested = true; }, /modes/u);
  reject((value) => { value.profilesDisposed = false; }, /cleanup/u);
  reject((value) => { delete value.processCleanup; }, /cleanup/u);
  reject((value) => { value.processCleanup.allExited = false; }, /cleanup/u);
  reject((value) => { value.processCleanup.capturedOwnedProcesses = 1; }, /cleanup/u);
  reject((value) => { value.processCleanup.stopFailures = 1; }, /cleanup/u);
  reject((value) => { value.scenarios.pop(); }, /scenario/u);
  reject((value) => { value.scenarios[1].exactReceiverRows = 3; }, /readback/u);
  reject((value) => { value.scenarios[1].delivered[0].senderDelivery = "pending"; }, /per-message/u);
  reject((value) => { value.scenarios[1].delivered[0].pqProtected = true; }, /ordinary/u);
  reject((value) => { value.scenarios.push(value.scenarios[0]); }, /scenario/u);
  const normal = structuredClone(offline);
  normal.firstSendMode = "online-automatic-pq";
  normal.scenarios = NORMAL_SCENARIOS.map((name) => ({ name, status: "pass" }));
  normal.scenarios.push({ name: "final-no-loss-no-duplicates-readback", status: "pass", expectedMessages: 12, exactSenderRows: 12, exactReceiverRows: 12,
    delivered: Array.from({ length: 12 }, (_, index) => ({ label: index === 11 ? "manual-only-plain" : "protected-" + index,
      senderCount: 1, receiverCount: 1, senderDelivery: "delivered", pqProtected: index !== 11 })) });
  validateNativeReceipt("normal", normal, expected);
  const rejectNative = (stage, fixture, mutate, pattern) => {
    const value = structuredClone(fixture);
    mutate(value);
    assert.throws(() => validateNativeReceipt(stage, value, expected), pattern);
  };
  rejectNative("normal", normal, (value) => {
    const final = value.scenarios.at(-1);
    final.expectedMessages = final.exactSenderRows = final.exactReceiverRows = 1;
    final.delivered = [{ label: "any-plain", senderCount: 1, receiverCount: 1, senderDelivery: "delivered", pqProtected: false }];
  }, /readback count/u);
  rejectNative("normal", normal, (value) => { value.scenarios.at(-1).delivered[0].pqProtected = false; }, /protection/u);
  rejectNative("normal", normal, (value) => { value.scenarios.at(-1).delivered.at(-1).pqProtected = true; }, /protection/u);
  rejectNative("normal", normal, (value) => { Object.assign(value.scenarios.at(-1).delivered.at(-1), { label: "other", pqProtected: true }); }, /manual-only/u);
  const fault = structuredClone(offline);
  fault.firstSendMode = "online-automatic-pq";
  fault.faultStages = { requested: true, feature: "pq-fault-tests", exactBarrierContract: true, supportedStages: [...FAULT_STAGES], completedStages: [...FAULT_STAGES] };
  fault.scenarios = FAULT_STAGES.map((stage) => ({
    name: stage === "ack" ? "exact-v2-ack-after-receive-suppression-process-restart" : "exact-v2-" + stage + "-suppression-process-restart",
    status: "pass", processCut: { exactArmedPidExited: true }, barrier: { triggered: true, suppressedBeforeTransport: true, blocksPeerV2UntilProcessExit: true },
  }));
  fault.scenarios.push(...NORMAL_SCENARIOS.map((name) => ({ name, status: "pass" })));
  assert.equal(FAULT_MESSAGE_LABELS.length, 64);
  assert.equal(new Set(FAULT_MESSAGE_LABELS).size, 64);
  const protectedDelivery = (label) => ({ label, senderCount: 1, receiverCount: 1, senderDelivery: "delivered", pqProtected: true });
  fault.scenarios.push({ name: "final-no-loss-no-duplicates-readback", status: "pass", expectedMessages: 64, exactSenderRows: 64, exactReceiverRows: 64,
    delivered: FAULT_MESSAGE_LABELS.map((label) => ({ ...protectedDelivery(label), pqProtected: label !== "manual-only-plain" })) });
  assert.throws(() => validateNativeReceipt("fault", fault, expected), /in-place rotation/u);
  fault.rotationFaults = { requested: true, inPlace: true, supportedStages: [...ROTATION_STAGES], completedStages: [...ROTATION_STAGES] };
  fault.scenarios.push(...ROTATION_STAGES.map((stage, index) => {
    const coordinator = index % 2 === 0 ? "alpha" : "beta";
    const peer = coordinator === "alpha" ? "beta" : "alpha";
    const triggerLabel = `rotation-${stage}-refresh-trigger`;
    return {
      name: "exact-v2-rotation-" + stage + "-suppression-process-restart", status: "pass", stage, inPlace: true,
      oldEpochRetained: true, oldCiphertextQueuedWhileOnline: true, oldCiphertextSha256: "C".repeat(64),
      oldCiphertextUnchanged: true, newEpochActivated: true, bothPeersOnlineAtActivation: true,
      oldEpochRetired: true, oldCiphertextDelivered: true, receivedBeforeAckCut: stage === "ack",
      coordinator, oldCiphertextSender: coordinator, oldCiphertextReceiver: peer,
      processCut: { exactArmedPidExited: true, armedProcess: ["offer", "finish", "commit", "data", "retire"].includes(stage) ? coordinator : peer },
      refreshTrigger: { label: triggerLabel, sender: peer, receiver: coordinator, bothPeersOffline: true,
        requestedOnNonCoordinator: true, deliveredBeforeOldRelease: true,
        queued: { label: triggerLabel, senderCount: 1, pqProtected: true, delivery: "pending" }, delivered: protectedDelivery(triggerLabel) },
      delivered: ROTATION_MESSAGE_SUFFIXES.map((suffix) => protectedDelivery(`rotation-${stage}-${suffix}`)),
      manualStartInvoked: false, activationRetainedEpochs: { alpha: 2, beta: 2 },
      barrier: { stage, triggered: true, suppressedBeforeTransport: true, blocksPeerV2UntilProcessExit: true, rotationParentMatched: true },
    };
  }));
  validateNativeReceipt("fault", fault, expected);
  const finalFault = (value) => scenario(value, "final-no-loss-no-duplicates-readback");
  rejectNative("fault", fault, (value) => { finalFault(value).delivered[0].pqProtected = false; }, /protection/u);
  rejectNative("fault", fault, (value) => { finalFault(value).delivered.find((row) => row.label === "manual-only-plain").pqProtected = true; }, /protection/u);
  for (const stageName of ROTATION_STAGES) {
    const rotation = (value) => scenario(value, "exact-v2-rotation-" + stageName + "-suppression-process-restart");
    rejectNative("fault", fault, (value) => { rotation(value).oldCiphertextQueuedWhileOnline = false; }, /oldCiphertextQueuedWhileOnline/u);
    rejectNative("fault", fault, (value) => { delete rotation(value).oldCiphertextSha256; }, /ciphertext hash/u);
    rejectNative("fault", fault, (value) => { rotation(value).oldCiphertextDelivered = false; }, /oldCiphertextDelivered/u);
    rejectNative("fault", fault, (value) => { rotation(value).oldCiphertextReceiver = rotation(value).oldCiphertextSender; }, /roles mismatch/u);
    rejectNative("fault", fault, (value) => { const row = rotation(value); row.processCut.armedProcess = row.processCut.armedProcess === "alpha" ? "beta" : "alpha"; }, /process role/u);
    rejectNative("fault", fault, (value) => { rotation(value).refreshTrigger.sender = rotation(value).oldCiphertextSender; }, /distinct offline refresh/u);
    rejectNative("fault", fault, (value) => { rotation(value).refreshTrigger.deliveredBeforeOldRelease = false; }, /distinct offline refresh/u);
    rejectNative("fault", fault, (value) => { rotation(value).refreshTrigger.queued.delivery = "delivered"; }, /pending while offline/u);
    rejectNative("fault", fault, (value) => { rotation(value).refreshTrigger.delivered.senderDelivery = "pending"; }, /delivery\/ACK evidence/u);
    rejectNative("fault", fault, (value) => { rotation(value).delivered.pop(); }, /four exact protected deliveries/u);
    rejectNative("fault", fault, (value) => { rotation(value).delivered[0].receiverCount = 2; }, /final exact history/u);
    rejectNative("fault", fault, (value) => { rotation(value).receivedBeforeAckCut = stageName !== "ack"; }, /ACK cut/u);
    for (const suffix of ROTATION_MESSAGE_SUFFIXES) rejectNative("fault", fault, (value) => {
      finalFault(value).delivered.find((row) => row.label === `rotation-${stageName}-${suffix}`).label = "unrelated-protected-row";
    }, /final message label inventory/u);
  }
  const identity = { commit: "1".repeat(40), tree: "2".repeat(40), buildId: "release-0.2.6-" + "2".repeat(12) + "-" + "a".repeat(12), sourceArchiveSha256: "A".repeat(64), frozenAtUtc: expected.startedAt };
  assert.deepEqual(candidateIdentity(identity), identity);
  assert.throws(() => candidateIdentity({ ...identity, tree: "3".repeat(40) }), /build ID/u);
  assert.throws(() => candidateIdentity({ ...identity, sourceArchiveSha256: "B".repeat(64) }), /build ID/u);
  assert.throws(() => validateFaultArtifact({ schemaVersion: 1, buildId: identity.buildId, commit: identity.commit, tree: identity.tree,
    sourceSha256: identity.sourceArchiveSha256, artifactKind: "disposable-pq-fault-tests", feature: "pq-fault-tests", shippingUnchanged: true,
    sourceClean: true, shippingExeSha256: "A".repeat(64), featureExeSha256: "A".repeat(64) }, { identity }, { executable: { sha256: "A".repeat(64) } }), /confused/u);
  const entropy = { ...structuredClone(offline), driver: "pq-native-entropy-v1", setup: { processes: 2, isolatedPortableRoots: true },
    entropyChoices: {
      alpha: { choice: "additional-pointer-noise", pointerPaths: { mousePointerPathObserved: true, touchPointerPathObserved: true }, command: { calls: 1, extraNoiseLength: 32, byteShape: true, expectedContact: true, ipcDispatched: true, nativeResponseReceived: true } },
      beta: { choice: "system-only", explicitUiAction: true, command: { calls: 1, extraNoiseLength: 0, byteShape: true, expectedContact: true, ipcDispatched: true, nativeResponseReceived: true } },
    }, delivery: { lifetimeFirstMessages: 2, exactNoDuplicates: true, rows: ["alpha", "beta"].map((peer) => ({ label: peer + "-lifetime-first-message", senderCount: 1, receiverCount: 1, senderDelivery: "delivered", pqProtected: true })) } };
  validateNativeReceipt("entropy", entropy, expected);
  rejectNative("entropy", entropy, (value) => { value.delivery.rows = []; }, /delivery rows/u);
  rejectNative("entropy", entropy, (value) => { value.delivery.rows[1] = value.delivery.rows[0]; }, /delivery rows/u);
  rejectNative("entropy", entropy, (value) => { value.delivery.rows[0].pqProtected = false; }, /protected delivery/u);
  rejectNative("entropy", entropy, (value) => { value.delivery.rows[0].senderDelivery = "pending"; }, /protected delivery/u);
  const sourceTree = { hash: "a".repeat(64), count: 42 };
  validateWindowsSourceTree({ sha256: sourceTree.hash, count: 42 }, sourceTree);
  assert.throws(() => validateWindowsSourceTree({ sha256: "b".repeat(64), count: 42 }, sourceTree), /independently/u);
  assert.throws(() => validateWindowsSourceTree({ sha256: sourceTree.hash, count: 41 }, sourceTree), /independently/u);
  for (const label of ["Windows report", "Desktop-Web receipt", "native leaf receipt", "frozen contract"])
    await assert.rejects(() => jsonFile({ path: "missing.json" }, label), /explicit path and SHA-256/u);
  for (const label of ["source script", "owner tool"])
    await assert.rejects(() => bindExactFiles([{ path: "missing.mjs" }], ["missing.mjs"], mainRoot, label), /explicit path and SHA-256/u);
  const web = {
    finalHistory: { expected: 7, pqProtected: 6, ordinary: 1, duplicates: 0, desktopExact: true, webExact: true,
      directionsExact: true, senderReceiptsDelivered: true, messageSetSha256: "A".repeat(64) },
    scenarios: ["real-topology-and-identity", "lifetime-first-send-online-auto-pq", "browser-document-reload-reauthentication",
      "manual-only-persists-across-desktop-and-browser-restarts", "expanded-ui-manual-pq-reactivation"].map((name) => ({ name, status: "PASS" })),
  };
  web.scenarios.push({ name: "real-web-backend-outage-bidirectional-old-epoch-recovery", status: "PASS", webObservedDesktopOffline: true,
    desktopObservedWebOffline: true, webPendingBeforeServiceStop: true, webPendingAfterServiceRestart: true,
    desktopPendingBeforeProcessRestart: true, bilateralShutdownAfterDrain: true, exactDeliveriesAfterBothProcessesRecovered: 2,
    ownerCoordination: { readyStopSha256: "A".repeat(64), stoppedSha256: "B".repeat(64), readyStartSha256: "C".repeat(64), startedSha256: "D".repeat(64) } });
  validateDesktopWebEvidence(web);
  const rejectWeb = (mutate, pattern) => {
    const value = structuredClone(web);
    mutate(value);
    assert.throws(() => validateDesktopWebEvidence(value), pattern);
  };
  rejectWeb((value) => { value.finalHistory = null; }, /history/u);
  for (const [key, incorrect] of Object.entries({ expected: 6, pqProtected: 5, ordinary: 2, duplicates: 1,
    desktopExact: false, webExact: false, directionsExact: false, senderReceiptsDelivered: false, messageSetSha256: undefined }))
    rejectWeb((value) => { value.finalHistory[key] = incorrect; }, /history/u);
  for (const key of ["webObservedDesktopOffline", "desktopObservedWebOffline", "webPendingBeforeServiceStop",
    "webPendingAfterServiceRestart", "desktopPendingBeforeProcessRestart", "bilateralShutdownAfterDrain"])
    rejectWeb((value) => { value.scenarios.at(-1)[key] = false; }, /outage/u);
  rejectWeb((value) => { value.scenarios.at(-1).exactDeliveriesAfterBothProcessesRecovered = 1; }, /recover/u);
  for (const key of ["readyStopSha256", "stoppedSha256", "readyStartSha256", "startedSha256"])
    rejectWeb((value) => { delete value.scenarios.at(-1).ownerCoordination[key]; }, /coordination/u);
  const taskRoot = path.join(mainRoot, "context.local/work/self-test-graph");
  const graph = { uiDriverManifestSha256: "driver-manifest.json", uiDriverSha256: "expanded-web-ui.mjs",
    uiSettingsDriverSha256: "settings-ui.mjs", uiFormattingDriverSha256: "formatting-ui.mjs" };
  const inputs = { taskRoot, bound: Object.values(graph).map((name, index) => ({ path: path.join(taskRoot, "desktop-web-ui", name), sha256: String(index).repeat(64) })) };
  web.identity = Object.fromEntries(Object.keys(graph).map((field, index) => [field, inputs.bound[index].sha256]));
  validateWebGraph(inputs, web);
  for (const field of Object.keys(graph)) assert.throws(() => validateWebGraph(inputs, { identity: { ...web.identity, [field]: "F".repeat(64) } }), /frozen UI driver graph/u);
  const tempRoot = await mkdtemp(path.join(mainRoot, "context.local/work/prerelease-runtime-selftest-"));
  try {
    const screenshot = path.join(tempRoot, "actual-native-schema.png");
    const bytes = Buffer.alloc(1024);
    PNG.copy(bytes);
    await writeFile(screenshot, bytes, { flag: "wx" });
    const receipt = { path: path.join(tempRoot, "receipt.json"), value: { screenshots: ["actual-native-schema.png"] } };
    const bindings = await screenshotFiles(receipt);
    check(bindings.length === 1 && SHA.test(bindings[0].sha256), "native string screenshot was not bound in the enclosing report");
    await screenshotFiles(receipt, receipt.value.screenshots, bindings);
    await assert.rejects(() => screenshotFiles(receipt, receipt.value.screenshots, [{ name: bindings[0].name }]), /explicit SHA-256/u);
    await assert.rejects(() => screenshotFiles(receipt, receipt.value.screenshots, []), /inventory/u);
    bytes[1023] = 1;
    await writeFile(screenshot, bytes);
    await assert.rejects(() => screenshotFiles(receipt, receipt.value.screenshots, bindings), /SHA-256 mismatch/u);
  } finally {
    check(inside(path.join(mainRoot, "context.local/work"), tempRoot) && samePath(await realpath(tempRoot), tempRoot)
      && path.basename(tempRoot).startsWith("prerelease-runtime-selftest-"), "self-test cleanup target escaped its owned temporary root");
    await rm(tempRoot, { recursive: true });
  }
  console.log("Prerelease runtime self-test PASS: receipt freshness, mode/count/protection, exact process cleanup, mandatory hashes, screenshot tampering, independent source identity, frozen Web driver graph and real outage/history guards. No apps were launched.");
}
const invokedDirectly = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) console.log("Usage: node scripts/test-prerelease-runtime.mjs --phase preflight|windows|verify-all --contract <frozen.json> --contract-sha256 <SHA256> [--windows-receipt <json>] [--evidence-manifest <json> --evidence-manifest-sha256 <SHA256>] [--output <new.json>]\n--self-test performs negative contract checks without launching apps.");
  else if (options.selfTest) await selfTest();
  else {
    const inputs = await loadInputs(options);
    if (options.phase === "preflight") console.log("PRERELEASE_RUNTIME_PREFLIGHT_PASS: frozen inputs only; no runtime gate executed.");
    else {
      const report = options.phase === "windows" ? await runWindows(inputs, options) : await verifyAll(inputs, options);
      console.log("PRERELEASE_RUNTIME_" + options.phase.toUpperCase().replaceAll("-", "_") + "_PASS scope=" + report.coverage);
    }
  }
}
export { parseArguments, validateNativeReceipt, validateFaultArtifact, validateDesktopWebEvidence, validateWebGraph, validateWindowsSourceTree };
