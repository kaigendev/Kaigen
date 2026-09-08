import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SCRIPT_ROOT = path.resolve(import.meta.dirname);
const DEFAULT_QTOX_FIXTURE = path.join(SCRIPT_ROOT, "fixtures", "qtox-v1.18.5-windows.json");
const QTOX_FIXTURE_SHA256 = "90615F51EEB1FBAAB29743348E18EF54820DD7BB4914661A0EABA94A40C69C5E";
const QTOX_INSTALLER_SHA256 = "D947E5CC1042B2AD72600A1E2B9952D1E5B0691930D619F4347DBB1085D76F09";
const QTOX_PORTABLE_SIDECAR_SHA256 = "0D7433A2D651CD582BA1B9E4CA6DAEFFD8421DAB8C154BAD7638BDF46784AB83";
const HEX40 = /^[a-f0-9]{40}$/u;
const HEX64 = /^[A-F0-9]{64}$/u;
const INSTANCE_TOKEN = /^[a-f0-9]{32}$/u;
const SAFE_BUILD_ID = /^[a-z0-9][a-z0-9._-]{7,127}$/u;
const SAFE_SCREENSHOT = /^[a-z0-9][a-z0-9._-]{1,94}\.png$/u;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const SCREENSHOTS = Object.freeze([
  "01-qtox-initial-chat.png",
  "02-kaigen-no-formatting.png",
  "03-kaigen-legacy-chat.png",
  "04-qtox-post-restart.png",
]);
const CHECK_KEYS = Object.freeze([
  "identityBound",
  "friendshipBidirectional",
  "textBidirectional",
  "fileBidirectional",
  "quotesBidirectional",
  "firstSendImmediateOrdinary",
  "unsupportedWithoutPqPrompt",
  "noAdvancedFormatting",
  "noControlTextLeaks",
  "restartReadback",
  "evidenceFilesBound",
]);
const RECEIPT_KEYS = Object.freeze([
  "schemaVersion", "status", "scope", "target", "identity", "environment", "checks", "evidence",
]);
const IDENTITY_KEYS = Object.freeze([
  "kaigenCommit", "sourceTree", "buildId", "artifactKind", "artifactSha256",
  "qtoxFixtureSha256", "qtoxVersion", "qtoxPlatform", "qtoxInstallerSha256",
]);
const ENVIRONMENT_KEYS = Object.freeze(["syntheticOnly", "launcher", "productionContacted", "secretsIncluded"]);
const LAUNCHER_KEYS = Object.freeze([
  "instanceToken", "programDirectoryCopied", "portableSidecarPrecreated", "disposableProfileRoot",
  "immutableRuntimeLaunched", "sidecarSha256", "runtimeManifestSha256", "executableSha256",
]);
const EVIDENCE_KEYS = Object.freeze([
  "friendship", "messages", "files", "quotes", "compatibility", "reconnect", "screenshots",
]);
const FRIENDSHIP_KEYS = Object.freeze(["qtoxPublicKeyMatched", "kaigenPublicKeyMatched", "onlineBeforeTraffic"]);
const MESSAGE_KEYS = Object.freeze([
  "count", "directions", "kaigenRows", "qtoxRows", "expectedTranscriptSha256",
  "kaigenTranscriptSha256", "qtoxTranscriptSha256", "exactPlaintext", "exactOnce",
  "unexpectedRows", "controlTextLeaks",
]);
const FILE_KEYS = Object.freeze([
  "directions", "count", "fixtureSha256", "qtoxReceivedSha256", "kaigenReceivedSha256",
  "exactBytes", "outsideRoots", "orphanPending",
]);
const QUOTE_KEYS = Object.freeze([
  "directions", "count", "expectedTranscriptSha256", "kaigenTranscriptSha256",
  "qtoxTranscriptSha256", "legacyPrefixExact", "legacyAuthorEmpty", "structuredQuoteWireUsed",
]);
const COMPATIBILITY_KEYS = Object.freeze([
  "chatCapabilities", "pqPre", "pqAfterFirstSend", "pqAfterReconnect", "pqPromptVisible",
  "formattingGroupVisible", "entropyPanelVisible", "protocolRowsPlain", "formattingSpansSent", "qtoxVisibleControlTextLeaks",
]);
const CAPABILITY_KEYS = Object.freeze([
  "protocolVersion", "stableMessageIds", "reactions", "quotes", "formatting",
]);
const PQ_KEYS = Object.freeze([
  "supported", "state", "identity_waiting", "auto_pending", "protocol_version", "peer_fingerprint", "error",
]);
const RECONNECT_KEYS = Object.freeze([
  "qtoxRestarted", "kaigenRestarted", "friendReboundByPublicKey", "onlineRestored",
  "historyPersisted", "postRestartDirections",
]);
const SCREENSHOT_KEYS = Object.freeze(["name", "sha256"]);

const EXPECTED_FIXTURE = Object.freeze({
  schemaVersion: 1,
  scope: "release-compatibility-test-only",
  name: "qTox",
  version: "1.18.5",
  platform: "windows-x86_64",
  releaseUrl: "https://github.com/TokTok/qTox/releases/tag/v1.18.5",
  releaseId: 332048632,
  assetId: 436520133,
  fileName: "setup-qtox-x86_64-release.exe",
  url: "https://github.com/TokTok/qTox/releases/download/v1.18.5/setup-qtox-x86_64-release.exe",
  bytes: 21352913,
  sha256: QTOX_INSTALLER_SHA256,
  digestSource: "GitHub release asset digest from the official TokTok/qTox v1.18.5 release",
  archiveFormat: "NSIS",
  bundledInKaigen: false,
  networkFallbackAllowed: false,
});

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

async function sha256File(file) {
  return sha256Bytes(await readFile(file));
}

function assertKeys(value, keys, label) {
  check(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  assert.deepEqual(Object.keys(value), keys, `${label} keys/order changed`);
}

async function ordinaryFile(file, expectedSha256, label) {
  check(HEX64.test(expectedSha256), `${label} expected SHA-256 must be uppercase hexadecimal`);
  const resolved = path.resolve(file);
  const info = await lstat(resolved);
  check(info.isFile() && !info.isSymbolicLink(), `${label} is not an ordinary file`);
  check(await realpath(resolved) === resolved, `${label} path is not canonical`);
  const actualSha256 = await sha256File(resolved);
  check(actualSha256 === expectedSha256, `${label} SHA-256 mismatch`);
  return { path: resolved, sha256: actualSha256, bytes: info.size };
}

async function canonicalJsonFile(file, expectedSha256, label) {
  const binding = await ordinaryFile(file, expectedSha256, label);
  const text = await readFile(binding.path, "utf8");
  const value = JSON.parse(text);
  check(text === canonicalJson(value), `${label} bytes are not canonical JSON`);
  return { ...binding, value };
}

async function validatePinnedFixture(file = DEFAULT_QTOX_FIXTURE) {
  const fixture = await canonicalJsonFile(file, QTOX_FIXTURE_SHA256, "qTox 1.18.5 fixture");
  assert.deepEqual(fixture.value, EXPECTED_FIXTURE, "qTox fixture identity differs from the official pinned release asset");
  return fixture;
}

function unavailablePqStatus(value, label) {
  assertKeys(value, PQ_KEYS, label);
  assert.deepEqual(value, {
    supported: false,
    state: "unavailable",
    identity_waiting: false,
    auto_pending: false,
    protocol_version: 2,
    peer_fingerprint: null,
    error: null,
  }, `${label} was not the durable unsupported/manual-only state`);
}

function validateCompatibility(value) {
  assertKeys(value, COMPATIBILITY_KEYS, "qTox compatibility evidence");
  assertKeys(value.chatCapabilities, CAPABILITY_KEYS, "qTox chat capability observation");
  assert.deepEqual(value.chatCapabilities, {
    protocolVersion: null,
    stableMessageIds: false,
    reactions: false,
    quotes: false,
    formatting: false,
  }, "qTox contact exposed negotiated Kaigen chat capabilities");
  unavailablePqStatus(value.pqPre, "qTox PQ status before first send");
  unavailablePqStatus(value.pqAfterFirstSend, "qTox PQ status after immediate first send");
  unavailablePqStatus(value.pqAfterReconnect, "qTox PQ status after reconnect");
  check(value.pqPromptVisible === false, "unsupported qTox contact opened a PQ decision prompt");
  check(value.formattingGroupVisible === false, "advanced formatting was visible for qTox");
  check(value.entropyPanelVisible === false, "unsupported qTox contact opened the PQ entropy collector");
  check(value.protocolRowsPlain === true && value.formattingSpansSent === 0, "qTox rows retained negotiated protocol or formatting metadata");
  check(value.qtoxVisibleControlTextLeaks === 0, "qTox transcript exposed a Kaigen service/control message");
}

function validateReceiptValue(value, expected) {
  assertKeys(value, RECEIPT_KEYS, `${expected.target} qTox receipt`);
  check(value.schemaVersion === 1 && value.status === "PASS" && value.scope === "qtox-interop", `${expected.target} qTox receipt did not PASS the exact scope`);
  check(value.target === expected.target, `${expected.target} qTox receipt target mismatch`);

  assertKeys(value.identity, IDENTITY_KEYS, `${expected.target} qTox identity`);
  assert.deepEqual(value.identity, {
    kaigenCommit: expected.kaigenCommit,
    sourceTree: expected.sourceTree,
    buildId: expected.buildId,
    artifactKind: expected.artifactKind,
    artifactSha256: expected.artifactSha256,
    qtoxFixtureSha256: QTOX_FIXTURE_SHA256,
    qtoxVersion: EXPECTED_FIXTURE.version,
    qtoxPlatform: EXPECTED_FIXTURE.platform,
    qtoxInstallerSha256: QTOX_INSTALLER_SHA256,
  }, `${expected.target} qTox receipt identity mismatch`);

  assertKeys(value.environment, ENVIRONMENT_KEYS, `${expected.target} qTox environment`);
  check(value.environment.syntheticOnly === true && value.environment.productionContacted === false && value.environment.secretsIncluded === false, `${expected.target} qTox receipt crossed the disposable/privacy boundary`);
  assertKeys(value.environment.launcher, LAUNCHER_KEYS, `${expected.target} qTox launcher evidence`);
  check(INSTANCE_TOKEN.test(value.environment.launcher.instanceToken ?? ""), `${expected.target} qTox launcher instance token is invalid`);
  assert.deepEqual({
    programDirectoryCopied: value.environment.launcher.programDirectoryCopied,
    portableSidecarPrecreated: value.environment.launcher.portableSidecarPrecreated,
    disposableProfileRoot: value.environment.launcher.disposableProfileRoot,
    immutableRuntimeLaunched: value.environment.launcher.immutableRuntimeLaunched,
    sidecarSha256: value.environment.launcher.sidecarSha256,
    runtimeManifestSha256: value.environment.launcher.runtimeManifestSha256,
    executableSha256: value.environment.launcher.executableSha256,
  }, {
    programDirectoryCopied: true,
    portableSidecarPrecreated: true,
    disposableProfileRoot: true,
    immutableRuntimeLaunched: false,
    sidecarSha256: QTOX_PORTABLE_SIDECAR_SHA256,
    runtimeManifestSha256: expected.qtoxRuntimeManifestSha256,
    executableSha256: expected.qtoxExecutableSha256,
  }, `${expected.target} qTox launcher did not prove an exact isolated runtime copy`);

  assertKeys(value.checks, CHECK_KEYS, `${expected.target} qTox checks`);
  for (const name of CHECK_KEYS) check(value.checks[name] === true, `${expected.target} qTox check ${name} did not PASS`);

  assertKeys(value.evidence, EVIDENCE_KEYS, `${expected.target} qTox evidence`);
  assertKeys(value.evidence.friendship, FRIENDSHIP_KEYS, `${expected.target} qTox friendship evidence`);
  for (const name of FRIENDSHIP_KEYS) check(value.evidence.friendship[name] === true, `${expected.target} qTox friendship evidence ${name} failed`);

  const messages = value.evidence.messages;
  assertKeys(messages, MESSAGE_KEYS, `${expected.target} qTox message evidence`);
  check(messages.count === 6 && messages.directions === 2 && messages.kaigenRows === 6 && messages.qtoxRows === 6, `${expected.target} qTox message coverage was incomplete`);
  for (const name of ["expectedTranscriptSha256", "kaigenTranscriptSha256", "qtoxTranscriptSha256"]) check(HEX64.test(messages[name] ?? ""), `${expected.target} qTox message transcript hash was invalid`);
  check(messages.expectedTranscriptSha256 === messages.kaigenTranscriptSha256 && messages.expectedTranscriptSha256 === messages.qtoxTranscriptSha256, `${expected.target} qTox message transcripts differed`);
  check(messages.exactPlaintext === true && messages.exactOnce === true && messages.unexpectedRows === 0 && messages.controlTextLeaks === 0, `${expected.target} qTox message transcript was not exact and clean`);

  const files = value.evidence.files;
  assertKeys(files, FILE_KEYS, `${expected.target} qTox file evidence`);
  for (const name of ["fixtureSha256", "qtoxReceivedSha256", "kaigenReceivedSha256"]) check(HEX64.test(files[name] ?? ""), `${expected.target} qTox file hash was invalid`);
  check(files.directions === 2 && files.count === 2 && files.fixtureSha256 === files.qtoxReceivedSha256 && files.fixtureSha256 === files.kaigenReceivedSha256, `${expected.target} qTox bidirectional file content differed`);
  check(files.exactBytes === true && files.outsideRoots === false && files.orphanPending === 0, `${expected.target} qTox file completion/bounds were invalid`);

  const quotes = value.evidence.quotes;
  assertKeys(quotes, QUOTE_KEYS, `${expected.target} qTox quote evidence`);
  for (const name of ["expectedTranscriptSha256", "kaigenTranscriptSha256", "qtoxTranscriptSha256"]) check(HEX64.test(quotes[name] ?? ""), `${expected.target} qTox quote transcript hash was invalid`);
  check(quotes.directions === 2 && quotes.count === 2 && quotes.expectedTranscriptSha256 === quotes.kaigenTranscriptSha256 && quotes.expectedTranscriptSha256 === quotes.qtoxTranscriptSha256, `${expected.target} qTox legacy quote transcripts differed`);
  check(quotes.legacyPrefixExact === true && quotes.legacyAuthorEmpty === true && quotes.structuredQuoteWireUsed === false, `${expected.target} qTox quote compatibility boundary was invalid`);

  validateCompatibility(value.evidence.compatibility);

  const reconnect = value.evidence.reconnect;
  assertKeys(reconnect, RECONNECT_KEYS, `${expected.target} qTox reconnect evidence`);
  for (const name of RECONNECT_KEYS.slice(0, 5)) check(reconnect[name] === true, `${expected.target} qTox reconnect evidence ${name} failed`);
  check(reconnect.postRestartDirections === 2, `${expected.target} qTox post-restart direction coverage was incomplete`);

  check(Array.isArray(value.evidence.screenshots) && value.evidence.screenshots.length === SCREENSHOTS.length, `${expected.target} qTox screenshot coverage was incomplete`);
  assert.deepEqual(value.evidence.screenshots.map((entry) => entry?.name), SCREENSHOTS, `${expected.target} qTox screenshot names/order changed`);
  for (const screenshot of value.evidence.screenshots) {
    assertKeys(screenshot, SCREENSHOT_KEYS, `${expected.target} qTox screenshot`);
    check(SAFE_SCREENSHOT.test(screenshot.name) && path.basename(screenshot.name) === screenshot.name && HEX64.test(screenshot.sha256 ?? ""), `${expected.target} qTox screenshot identity was invalid`);
  }
}

async function validateScreenshotFiles(receiptFile, receipt, target) {
  const root = path.dirname(receiptFile);
  for (const screenshot of receipt.evidence.screenshots) {
    const file = path.join(root, screenshot.name);
    const binding = await ordinaryFile(file, screenshot.sha256, `${target} qTox screenshot ${screenshot.name}`);
    const bytes = await readFile(binding.path);
    check(binding.bytes >= 1_024 && bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE), `${target} qTox screenshot ${screenshot.name} is not a nontrivial PNG`);
  }
}

async function validateReceiptFile(file, expectedSha256, expected) {
  const receipt = await canonicalJsonFile(file, expectedSha256, `${expected.target} qTox receipt`);
  validateReceiptValue(receipt.value, expected);
  await validateScreenshotFiles(receipt.path, receipt.value, expected.target);
  return receipt;
}

function validateOptions(options) {
  if (options.help || options.selfTest) return;
  for (const name of [
    "desktopReceipt", "desktopReceiptSha256", "webReceipt", "webReceiptSha256",
    "kaigenCommit", "sourceTree", "buildId", "desktopArtifactSha256", "webArtifactSha256",
    "qtoxRuntimeManifestSha256", "qtoxExecutableSha256",
  ]) check(typeof options[name] === "string" && options[name].length > 0, `--${name.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)} is required`);
  check(HEX40.test(options.kaigenCommit), "Kaigen commit must be 40 lowercase hexadecimal characters");
  check(HEX40.test(options.sourceTree), "Kaigen source tree must be 40 lowercase hexadecimal characters");
  check(SAFE_BUILD_ID.test(options.buildId), "Kaigen build ID is invalid");
  for (const [value, label] of [
    [options.desktopReceiptSha256, "Desktop qTox receipt"],
    [options.webReceiptSha256, "Web qTox receipt"],
    [options.desktopArtifactSha256, "Desktop artifact"],
    [options.webArtifactSha256, "Web artifact"],
    [options.qtoxRuntimeManifestSha256, "qTox runtime manifest"],
    [options.qtoxExecutableSha256, "qTox executable"],
  ]) check(HEX64.test(value), `${label} SHA-256 must be uppercase hexadecimal`);
  check(options.desktopArtifactSha256 !== options.webArtifactSha256, "Desktop and Web artifacts unexpectedly shared one SHA-256");
}

async function validateGate(options) {
  validateOptions(options);
  const fixture = await validatePinnedFixture(options.qtoxFixture || DEFAULT_QTOX_FIXTURE);
  const common = {
    kaigenCommit: options.kaigenCommit,
    sourceTree: options.sourceTree,
    buildId: options.buildId,
    qtoxRuntimeManifestSha256: options.qtoxRuntimeManifestSha256,
    qtoxExecutableSha256: options.qtoxExecutableSha256,
  };
  const [desktop, web] = await Promise.all([
    validateReceiptFile(options.desktopReceipt, options.desktopReceiptSha256, {
      ...common,
      target: "desktop",
      artifactKind: "windows-portable",
      artifactSha256: options.desktopArtifactSha256,
    }),
    validateReceiptFile(options.webReceipt, options.webReceiptSha256, {
      ...common,
      target: "web",
      artifactKind: "web-lab-package",
      artifactSha256: options.webArtifactSha256,
    }),
  ]);
  check(desktop.path !== web.path, "Desktop and Web qTox gates reused one receipt file");
  check(desktop.value.environment.launcher.instanceToken !== web.value.environment.launcher.instanceToken, "Desktop and Web qTox gates reused one launcher instance token");
  return {
    schemaVersion: 1,
    status: "PASS",
    scope: "qtox-release-gate",
    identity: {
      kaigenCommit: options.kaigenCommit,
      sourceTree: options.sourceTree,
      buildId: options.buildId,
      qtoxFixtureSha256: fixture.sha256,
      qtoxInstallerSha256: QTOX_INSTALLER_SHA256,
      qtoxRuntimeManifestSha256: options.qtoxRuntimeManifestSha256,
      qtoxExecutableSha256: options.qtoxExecutableSha256,
    },
    targets: [
      { target: "desktop", artifactSha256: options.desktopArtifactSha256, receiptSha256: desktop.sha256, checks: CHECK_KEYS.length, screenshots: SCREENSHOTS.length },
      { target: "web", artifactSha256: options.webArtifactSha256, receiptSha256: web.sha256, checks: CHECK_KEYS.length, screenshots: SCREENSHOTS.length },
    ],
    productionContacted: false,
    secretsIncluded: false,
  };
}

function parseArguments(argv) {
  const options = {
    desktopReceipt: "", desktopReceiptSha256: "", webReceipt: "", webReceiptSha256: "",
    kaigenCommit: "", sourceTree: "", buildId: "", desktopArtifactSha256: "", webArtifactSha256: "",
    qtoxRuntimeManifestSha256: "", qtoxExecutableSha256: "",
    qtoxFixture: DEFAULT_QTOX_FIXTURE, output: "", selfTest: false, help: false,
  };
  const values = new Map([
    ["--desktop-receipt", "desktopReceipt"],
    ["--desktop-receipt-sha256", "desktopReceiptSha256"],
    ["--web-receipt", "webReceipt"],
    ["--web-receipt-sha256", "webReceiptSha256"],
    ["--kaigen-commit", "kaigenCommit"],
    ["--source-tree", "sourceTree"],
    ["--build-id", "buildId"],
    ["--desktop-artifact-sha256", "desktopArtifactSha256"],
    ["--web-artifact-sha256", "webArtifactSha256"],
    ["--qtox-runtime-manifest-sha256", "qtoxRuntimeManifestSha256"],
    ["--qtox-executable-sha256", "qtoxExecutableSha256"],
    ["--qtox-fixture", "qtoxFixture"],
    ["--output", "output"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--self-test") options.selfTest = true;
    else if (argument === "--help") options.help = true;
    else {
      const name = values.get(argument);
      check(name, `unknown argument ${argument}`);
      const value = argv[index + 1];
      check(value && !value.startsWith("--"), `${argument} requires a value`);
      options[name] = value;
      index += 1;
    }
  }
  check(!(options.selfTest && options.help), "--self-test and --help cannot be combined");
  return options;
}

function usage() {
  return `Usage:
  node scripts/test-qtox-release-gate.mjs --desktop-receipt <json> --desktop-receipt-sha256 <SHA256>
    --web-receipt <json> --web-receipt-sha256 <SHA256>
    --kaigen-commit <40-lowercase-hex> --source-tree <40-lowercase-hex> --build-id <id>
    --desktop-artifact-sha256 <SHA256> --web-artifact-sha256 <SHA256>
    --qtox-runtime-manifest-sha256 <SHA256> --qtox-executable-sha256 <SHA256> [--output <new-json>]

  --qtox-fixture <json>  Override the path only; bytes must still match the built-in official pin.
  --self-test            Validate the fixture and fail-closed receipt contract without launching apps.
  --help                 Show this text.`;
}

function samplePq(state, autoPending) {
  return {
    supported: false,
    state,
    identity_waiting: false,
    auto_pending: autoPending,
    protocol_version: 2,
    peer_fingerprint: null,
    error: null,
  };
}

function sampleReceipt(target, expected, screenshotHashes) {
  const transcript = "A".repeat(64);
  const quoteTranscript = "B".repeat(64);
  const fileFixture = "C".repeat(64);
  return {
    schemaVersion: 1,
    status: "PASS",
    scope: "qtox-interop",
    target,
    identity: {
      kaigenCommit: expected.kaigenCommit,
      sourceTree: expected.sourceTree,
      buildId: expected.buildId,
      artifactKind: target === "desktop" ? "windows-portable" : "web-lab-package",
      artifactSha256: target === "desktop" ? expected.desktopArtifactSha256 : expected.webArtifactSha256,
      qtoxFixtureSha256: QTOX_FIXTURE_SHA256,
      qtoxVersion: "1.18.5",
      qtoxPlatform: "windows-x86_64",
      qtoxInstallerSha256: QTOX_INSTALLER_SHA256,
    },
    environment: {
      syntheticOnly: true,
      launcher: {
        instanceToken: target === "desktop" ? "1".repeat(32) : "2".repeat(32),
        programDirectoryCopied: true,
        portableSidecarPrecreated: true,
        disposableProfileRoot: true,
        immutableRuntimeLaunched: false,
        sidecarSha256: QTOX_PORTABLE_SIDECAR_SHA256,
        runtimeManifestSha256: expected.qtoxRuntimeManifestSha256,
        executableSha256: expected.qtoxExecutableSha256,
      },
      productionContacted: false,
      secretsIncluded: false,
    },
    checks: Object.fromEntries(CHECK_KEYS.map((name) => [name, true])),
    evidence: {
      friendship: { qtoxPublicKeyMatched: true, kaigenPublicKeyMatched: true, onlineBeforeTraffic: true },
      messages: {
        count: 6, directions: 2, kaigenRows: 6, qtoxRows: 6,
        expectedTranscriptSha256: transcript, kaigenTranscriptSha256: transcript, qtoxTranscriptSha256: transcript,
        exactPlaintext: true, exactOnce: true, unexpectedRows: 0, controlTextLeaks: 0,
      },
      files: {
        directions: 2, count: 2, fixtureSha256: fileFixture,
        qtoxReceivedSha256: fileFixture, kaigenReceivedSha256: fileFixture,
        exactBytes: true, outsideRoots: false, orphanPending: 0,
      },
      quotes: {
        directions: 2, count: 2, expectedTranscriptSha256: quoteTranscript,
        kaigenTranscriptSha256: quoteTranscript, qtoxTranscriptSha256: quoteTranscript,
        legacyPrefixExact: true, legacyAuthorEmpty: true, structuredQuoteWireUsed: false,
      },
      compatibility: {
        chatCapabilities: { protocolVersion: null, stableMessageIds: false, reactions: false, quotes: false, formatting: false },
        pqPre: samplePq("unavailable", false),
        pqAfterFirstSend: samplePq("unavailable", false),
        pqAfterReconnect: samplePq("unavailable", false),
        pqPromptVisible: false,
        formattingGroupVisible: false,
        entropyPanelVisible: false,
        protocolRowsPlain: true,
        formattingSpansSent: 0,
        qtoxVisibleControlTextLeaks: 0,
      },
      reconnect: {
        qtoxRestarted: true, kaigenRestarted: true, friendReboundByPublicKey: true,
        onlineRestored: true, historyPersisted: true, postRestartDirections: 2,
      },
      screenshots: SCREENSHOTS.map((name) => ({ name, sha256: screenshotHashes[name] })),
    },
  };
}

async function selfTest() {
  await validatePinnedFixture();
  const root = await mkdtemp(path.join(tmpdir(), "kaigen-qtox-release-gate-"));
  try {
    const expected = {
      kaigenCommit: "a".repeat(40),
      sourceTree: "b".repeat(40),
      buildId: "release-qtox-self-test",
      desktopArtifactSha256: "D".repeat(64),
      webArtifactSha256: "E".repeat(64),
      qtoxRuntimeManifestSha256: "F".repeat(64),
      qtoxExecutableSha256: "9".repeat(64),
    };
    const png = Buffer.concat([PNG_SIGNATURE, Buffer.alloc(1_016, 0)]);
    const screenshotHashes = {};
    for (const target of ["desktop", "web"]) {
      const targetRoot = path.join(root, target);
      await mkdir(targetRoot);
      for (const name of SCREENSHOTS) {
        const bytes = Buffer.concat([png, Buffer.from(`${target}:${name}`)]);
        await writeFile(path.join(targetRoot, name), bytes, { flag: "wx" });
        screenshotHashes[`${target}:${name}`] = sha256Bytes(bytes);
      }
    }
    const buildReceipt = async (target, mutate = (value) => value, name = "receipt.json") => {
      const hashes = Object.fromEntries(SCREENSHOTS.map((screenshot) => [screenshot, screenshotHashes[`${target}:${screenshot}`]]));
      const value = mutate(sampleReceipt(target, expected, hashes));
      const file = path.join(root, target, name);
      await writeFile(file, canonicalJson(value), { flag: "wx" });
      return { file, sha256: await sha256File(file), value };
    };
    const desktop = await buildReceipt("desktop");
    const web = await buildReceipt("web");
    const options = {
      ...expected,
      desktopReceipt: desktop.file,
      desktopReceiptSha256: desktop.sha256,
      webReceipt: web.file,
      webReceiptSha256: web.sha256,
      qtoxFixture: DEFAULT_QTOX_FIXTURE,
      output: "",
      selfTest: false,
      help: false,
    };
    const passed = await validateGate(options);
    assert.equal(passed.status, "PASS");
    assert.deepEqual(passed.targets.map(({ target }) => target), ["desktop", "web"]);

    await assert.rejects(() => validateGate({ ...options, webReceipt: path.join(root, "missing.json") }), /ENOENT|no such file/u);
    const bare = await buildReceipt("web", () => ({ schemaVersion: 1, status: "PASS" }), "bare.json");
    await assert.rejects(() => validateGate({ ...options, webReceipt: bare.file, webReceiptSha256: bare.sha256 }), /keys\/order/u);
    const wrongTarget = await buildReceipt("web", (value) => ({ ...value, target: "desktop" }), "wrong-target.json");
    await assert.rejects(() => validateGate({ ...options, webReceipt: wrongTarget.file, webReceiptSha256: wrongTarget.sha256 }), /target mismatch/u);
    const wrongIdentity = await buildReceipt("web", (value) => ({ ...value, identity: { ...value.identity, kaigenCommit: "c".repeat(40) } }), "wrong-identity.json");
    await assert.rejects(() => validateGate({ ...options, webReceipt: wrongIdentity.file, webReceiptSha256: wrongIdentity.sha256 }), /identity mismatch/u);
    const wrongPin = await buildReceipt("web", (value) => ({ ...value, identity: { ...value.identity, qtoxInstallerSha256: "F".repeat(64) } }), "wrong-pin.json");
    await assert.rejects(() => validateGate({ ...options, webReceipt: wrongPin.file, webReceiptSha256: wrongPin.sha256 }), /identity mismatch/u);
    const unsafeRuntime = await buildReceipt("web", (value) => ({ ...value, environment: { ...value.environment, launcher: { ...value.environment.launcher, programDirectoryCopied: false } } }), "unsafe-runtime.json");
    await assert.rejects(() => validateGate({ ...options, webReceipt: unsafeRuntime.file, webReceiptSha256: unsafeRuntime.sha256 }), /isolated runtime copy/u);
    const reusedInstance = await buildReceipt("web", (value) => ({ ...value, environment: { ...value.environment, launcher: { ...value.environment.launcher, instanceToken: "1".repeat(32) } } }), "reused-instance.json");
    await assert.rejects(() => validateGate({ ...options, webReceipt: reusedInstance.file, webReceiptSha256: reusedInstance.sha256 }), /reused one launcher instance token/u);
    const formattingLeak = await buildReceipt("web", (value) => ({ ...value, evidence: { ...value.evidence, compatibility: { ...value.evidence.compatibility, formattingGroupVisible: true } } }), "formatting-leak.json");
    await assert.rejects(() => validateGate({ ...options, webReceipt: formattingLeak.file, webReceiptSha256: formattingLeak.sha256 }), /advanced formatting/u);
    const transcriptMismatch = await buildReceipt("web", (value) => ({ ...value, evidence: { ...value.evidence, messages: { ...value.evidence.messages, qtoxTranscriptSha256: "F".repeat(64) } } }), "transcript-mismatch.json");
    await assert.rejects(() => validateGate({ ...options, webReceipt: transcriptMismatch.file, webReceiptSha256: transcriptMismatch.sha256 }), /transcripts differed/u);
    const staleArtifact = { ...options, webArtifactSha256: "F".repeat(64) };
    await assert.rejects(() => validateGate(staleArtifact), /identity mismatch/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  console.log("qTox release gate fixture/self-test passed (official pin, dual target identity, protocol invariants, evidence hashes, fail-closed mutations).\n");
}

async function writeOutput(file, value) {
  if (!file) {
    process.stdout.write(canonicalJson(value));
    return;
  }
  const output = path.resolve(file);
  const parent = path.dirname(output);
  const parentInfo = await stat(parent);
  check(parentInfo.isDirectory() && await realpath(parent) === parent, "qTox gate output parent is not an ordinary canonical directory");
  await writeFile(output, canonicalJson(value), { flag: "wx" });
}

const invokedDirectly = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) console.log(usage());
  else if (options.selfTest) await selfTest();
  else await writeOutput(options.output, await validateGate(options));
}

export { validateGate };
