import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  KaigenProcess,
  NativeCommandError,
  check,
  freeLoopbackPort,
  messagesFor,
  publicKeyFromToxId,
  safePqStatus,
  sanitizeDiagnostic,
  selectFastInitialConnectionPreset,
  sendDurably,
  setUserStatus,
  sha256File,
  waitMessageExact,
  waitPairOnline,
  waitPairPqCapable,
  waitPairPqActive,
  waitUntil,
  writeReceipt,
} from "./test-pq-two-instances.mjs";

const repository = path.resolve(import.meta.dirname, "..");
const taskRoot = path.resolve(repository, "..", "context.local", "work", "20260908-pq-forward-secrecy");
const runsRoot = path.join(taskRoot, "desktop-web-runs");
const HEX64 = /^[A-F0-9]{64}$/u;
const NONCE = /^[a-f0-9]{32}$/u;
const TLS_SPKI = /^[A-Za-z0-9+/]{43}=$/u;
const SAFE_CANDIDATE = /^[a-z0-9][a-z0-9._-]{7,127}$/u;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PROTECTED_STATES = new Set(["active", "closing", "closing_commit", "closing_ack", "closing_final"]);
const AUTH_HEADERS = Object.freeze(["x-kaigen-client-build", "x-kaigen-workspace", "x-kaigen-csrf"]);
const OWNER_RECEIPT_KEYS = Object.freeze([
  "schemaVersion", "status", "nonce", "candidateId", "action", "vmState", "routeState",
  "activeSlot", "currentTarget", "previousTarget", "serviceState", "serviceEnabled",
  "releaseManifestSha256", "publicBuildId", "readyReceiptSha256", "recovery",
  "productionContacted", "secretsIncluded",
]);
const FORMATTING_UI_CHECK_KEYS = Object.freeze([
  "noToolbar", "noFormattingWithoutSelection", "formattingGroupFirst", "exactRuEnLabels",
  "checkboxRoles", "ariaCheckedRoundTrip", "rightClickSelectionRetained", "keyboardMenuFocusedBold",
  "escapeSelectionRetained", "allFourApplied", "allFourRemoved", "outgoingSpansExact",
  "incomingSpansExact", "plaintextExact", "deliveryExact", "pqProtectionExact",
  "renderedElementsExact", "restartPersistenceExact",
]);
const EXPANDED_UI_CHECK_KEYS = Object.freeze([
  "workspaceDiskBacked", "initialContactVisible", "uiMessageDelivered", "desktopReplyVisible",
  "quoteDelivered", "reactionDelivered", "searchLocatedMessage", "unreadBatchCount", "unreadCleared",
  "historyScrollable", "scrollMoved", "scrollReturnedLatest", "fileDialogCancelled", "fileTransferCompleted",
  "fileFixtureHashBound", "fileFixtureRemoved", "profileCreated", "profileSwitched", "originalProfileRestored",
  "languageRoundTrip", "languagePersisted", "themeRoundTrip", "themePersisted", "walletCopyCount",
  "wideLayoutVerified", "compactLayoutVerified", "sizeBlockerVerified", "viewportRestored",
  "keyboardNavigationVerified", "dialogsCancelled", "geometryVerified", "settingsRestored",
  "workspaceReopened", "postReopenContactRestored", "postReopenTransportHealthy", "postReopenUiDelivery",
  "formattingNoToolbar", "formattingNoFormattingWithoutSelection", "formattingFormattingGroupFirst",
  "formattingExactRuEnLabels", "formattingCheckboxRoles", "formattingAriaCheckedRoundTrip",
  "formattingRightClickSelectionRetained", "formattingKeyboardMenuFocusedBold",
  "formattingEscapeSelectionRetained", "formattingAllFourApplied", "formattingAllFourRemoved",
  "formattingOutgoingSpansExact", "formattingIncomingSpansExact", "formattingPlaintextExact",
  "formattingDeliveryExact", "formattingPqProtectionExact", "formattingRenderedElementsExact",
  "formattingRestartPersistenceExact",
]);
const FORMATTING_SCREENSHOTS = Object.freeze([
  "native-formatting-applied.png",
  "native-formatting-removed.png",
  "native-formatting-persisted.png",
]);
const WEB_COMMANDS = new Set([
  "accept_pq_session",
  "add_tox_friend",
  "create_profile",
  "get_chat_capabilities",
  "get_file_receive_settings",
  "get_network_settings",
  "get_pq_status",
  "get_startup_state",
  "get_tox_friends",
  "get_tox_id",
  "get_tox_messages",
  "request_pq_shutdown",
  "send_tox_message",
  "set_file_receive_settings",
  "set_tox_user_status",
  "switch_profile",
]);

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function phasePolicy(phase) {
  check(["all", "expanded-ui"].includes(phase), "--phase must be all or expanded-ui");
  return Object.freeze({
    phase,
    scope: phase === "all" ? "full-desktop-web" : "expanded-ui-only",
    serviceControl: phase === "all",
    successStatus: phase === "all" ? "PASS" : "PASS_EXPANDED_UI",
  });
}

async function runTransportPhase(policy, allScenarios, uiPreparation) {
  return policy.serviceControl ? allScenarios() : uiPreparation();
}

async function selfTestPhaseIsolation() {
  assert.equal(parseArguments([]).phase, "all");
  assert.equal(parseArguments(["--phase", "expanded-ui"]).phase, "expanded-ui");
  assert.throws(() => parseArguments(["--phase", "other"]), /phase/u);
  const all = phasePolicy("all");
  const ui = phasePolicy("expanded-ui");
  assert.equal(all.successStatus, "PASS");
  assert.equal(all.serviceControl, true);
  assert.equal(ui.scope, "expanded-ui-only");
  assert.equal(ui.serviceControl, false);
  assert.equal(ui.successStatus, "PASS_EXPANDED_UI");
  assert.notEqual(ui.successStatus, "PASS", "partial receipt cannot satisfy the full PASS contract");
  const calls = [];
  await runTransportPhase(all, async () => calls.push("full-transport"), async () => assert.fail("unexpected UI preparation"));
  await runTransportPhase(ui, async () => assert.fail("expanded-ui dispatched full transport/service control"), async () => calls.push("ui-shutdown-preparation"));
  assert.deepEqual(calls, ["full-transport", "ui-shutdown-preparation"]);
}

function usage() {
  return `Usage:
  node scripts/test-pq-desktop-web.mjs --artifact-root <portable-dir> --desktop-exe-sha256 <SHA256>
    --candidate-contract <json> --candidate-contract-sha256 <SHA256>
    --web-ready-receipt <json> --web-ready-receipt-sha256 <SHA256>
    --browser-driver <canonical-verifier.mjs> --browser-driver-sha256 <SHA256>
    --ui-driver-manifest <json> --ui-driver-manifest-sha256 <SHA256>
    --chromium <exe> --chromium-sha256 <SHA256> --tls-spki <base64>
    --resolve-host <IPv4> --control-nonce <32-lowercase-hex> [options]

Options:
  --exe <Kaigen.exe>          Executable inside --artifact-root (default Kaigen.exe)
  --origin <url>              Must be https://kaigen.test (default)
  --run-root <new-dir>        New directory below ${runsRoot}
  --timeout-ms <ms>           Per recovery gate, 30000..600000 (default 180000)
  --startup-timeout-ms <ms>   Desktop/browser startup, 10000..180000 (default 60000)
  --phase <all|expanded-ui>   Default all; expanded-ui reuses an existing activation ACK without service control
  --keep-profiles             Retain disposable local roots after processes stop
  --self-test                 Check CLI, redaction, hash/URL and marker contracts only
  --help                      Show this text

The driver writes no workspace identifier/password, auth header, Tox ID, message text,
history, key or PQ fingerprint. A separate laboratory owner watches its public nonce-bound
markers and performs the exact service stop/start through the approved Web Lab route.`;
}

function parseInteger(value, minimum, maximum, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return parsed;
}

function parseArguments(argv) {
  const options = {
    artifactRoot: "", exe: "", desktopExeSha256: "",
    candidateContract: "", candidateContractSha256: "",
    webReadyReceipt: "", webReadyReceiptSha256: "",
    browserDriver: "", browserDriverSha256: "",
    uiDriverManifest: "", uiDriverManifestSha256: "",
    chromium: "", chromiumSha256: "", tlsSpki: "", resolveHost: "",
    controlNonce: "", origin: "https://kaigen.test", runRoot: "", phase: "all",
    timeoutMs: 180_000, startupTimeoutMs: 60_000,
    keepProfiles: false, selfTest: false, help: false,
  };
  const values = new Map([
    ["--artifact-root", "artifactRoot"], ["--exe", "exe"],
    ["--desktop-exe-sha256", "desktopExeSha256"],
    ["--candidate-contract", "candidateContract"],
    ["--candidate-contract-sha256", "candidateContractSha256"],
    ["--web-ready-receipt", "webReadyReceipt"],
    ["--web-ready-receipt-sha256", "webReadyReceiptSha256"],
    ["--browser-driver", "browserDriver"],
    ["--browser-driver-sha256", "browserDriverSha256"],
    ["--ui-driver-manifest", "uiDriverManifest"], ["--ui-driver-manifest-sha256", "uiDriverManifestSha256"],
    ["--chromium", "chromium"], ["--chromium-sha256", "chromiumSha256"],
    ["--tls-spki", "tlsSpki"], ["--resolve-host", "resolveHost"],
    ["--control-nonce", "controlNonce"], ["--origin", "origin"],
    ["--run-root", "runRoot"], ["--phase", "phase"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (values.has(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
      options[values.get(argument)] = value;
      index += 1;
    } else if (argument === "--timeout-ms") {
      options.timeoutMs = parseInteger(argv[++index], 30_000, 600_000, argument);
    } else if (argument === "--startup-timeout-ms") {
      options.startupTimeoutMs = parseInteger(argv[++index], 10_000, 180_000, argument);
    } else if (argument === "--keep-profiles") options.keepProfiles = true;
    else if (argument === "--self-test") options.selfTest = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  phasePolicy(options.phase);
  return options;
}

function isWithin(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function safeFailure(value, replacements = []) {
  return sanitizeDiagnostic(value, replacements)
    .replace(/[A-Za-z0-9+/]{43}=/gu, "[redacted-token]")
    .replace(/(?:#k=)[A-Za-z0-9_-]+/gu, "#k=[redacted-workspace]")
    .slice(0, 500);
}

async function ordinaryFile(file, expectedSha256, label) {
  const requested = path.resolve(file);
  const info = await lstat(requested);
  check(info.isFile() && !info.isSymbolicLink(), `${label} must be an ordinary non-symlink file`);
  const canonical = await realpath(requested);
  check(canonical === requested, `${label} path must already be canonical`);
  const actualSha256 = await sha256File(canonical);
  check(actualSha256 === expectedSha256, `${label} SHA-256 mismatch`);
  return { path: canonical, sha256: actualSha256, bytes: info.size };
}

function canonicalJsonBytes(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function readCanonicalJson(file, binding, label) {
  const text = await readFile(file, "utf8");
  check(!text.startsWith("\ufeff"), `${label} must not contain a UTF-8 BOM`);
  const value = JSON.parse(text);
  check(text === canonicalJsonBytes(value), `${label} bytes are not canonical`);
  return { value, ...binding };
}

function staticModuleSpecifiers(source, label) {
  check(!source.startsWith("\ufeff") && !source.includes("\0"), `${label} source encoding is invalid`);
  check(!/\bimport\s*\(/u.test(source) && !/\brequire\s*\(/u.test(source), `${label} may not use an unbound module loader`);
  const declaration = /(?:^|\n)\s*(?:import\s+(?:[\w*$\s{},]*?\s+from\s+)?|export\s+(?:[\w*$\s{},]*?\s+from\s+))["']([^"'\r\n]+)["']\s*;?/gu;
  const specifiers = [...source.matchAll(declaration)].map((match) => match[1]);
  const remainder = source.replace(declaration, "\n");
  check(!/(?:^|\n)\s*import\b/mu.test(remainder) && !/(?:^|\n)\s*export\s+[^\r\n]*\bfrom\b/mu.test(remainder), `${label} contains an unparsed module import`);
  return specifiers;
}

async function validateUiModuleGraph(entryPath, settingsPath, formattingPath) {
  const [entrySource, settingsSource, formattingSource] = await Promise.all([
    readFile(entryPath, "utf8"),
    readFile(settingsPath, "utf8"),
    readFile(formattingPath, "utf8"),
  ]);
  const entrySpecifiers = staticModuleSpecifiers(entrySource, "expanded UI entry module");
  const settingsSpecifiers = staticModuleSpecifiers(settingsSource, "expanded UI settings module");
  const formattingSpecifiers = staticModuleSpecifiers(formattingSource, "expanded UI formatting module");
  for (const specifier of [...entrySpecifiers, ...settingsSpecifiers, ...formattingSpecifiers]) {
    check(specifier === "./settings-ui.mjs" || specifier === "./formatting-ui.mjs" || specifier.startsWith("node:"), `expanded UI module graph contains unbound import ${specifier}`);
  }
  assert.deepEqual(entrySpecifiers.filter((specifier) => !specifier.startsWith("node:")), ["./settings-ui.mjs", "./formatting-ui.mjs"], "expanded UI entry must import the exact settings and formatting modules once in manifest order");
  assert.deepEqual(settingsSpecifiers.filter((specifier) => !specifier.startsWith("node:")), [], "expanded UI settings module may not import another local module");
  assert.deepEqual(formattingSpecifiers, [], "expanded UI formatting module may not import another module");
}

async function bindUiDriverManifest(manifestPath, expectedSha256) {
  const manifestFile = await ordinaryFile(path.resolve(manifestPath), expectedSha256, "expanded UI driver manifest");
  const uiManifest = await readCanonicalJson(manifestFile.path, manifestFile, "expanded UI driver manifest");
  assert.deepEqual(Object.keys(uiManifest.value ?? {}), ["schemaVersion", "entry", "dependencies"]);
  assert.deepEqual(Object.keys(uiManifest.value.entry ?? {}), ["name", "sha256"]);
  check(Array.isArray(uiManifest.value.dependencies) && uiManifest.value.dependencies.length === 2, "expanded UI driver manifest dependency count is invalid");
  for (const dependency of uiManifest.value.dependencies) assert.deepEqual(Object.keys(dependency ?? {}), ["name", "sha256"]);
  check(uiManifest.value.schemaVersion === 1
    && uiManifest.value.entry.name === "expanded-web-ui.mjs"
    && uiManifest.value.dependencies[0].name === "settings-ui.mjs"
    && uiManifest.value.dependencies[1].name === "formatting-ui.mjs", "expanded UI driver manifest names/order are invalid");
  check(HEX64.test(uiManifest.value.entry.sha256 ?? "") && uiManifest.value.dependencies.every((dependency) => HEX64.test(dependency.sha256 ?? "")), "expanded UI driver manifest contains an invalid module SHA-256");
  const uiRoot = path.dirname(uiManifest.path);
  const uiDriver = await ordinaryFile(path.join(uiRoot, uiManifest.value.entry.name), uiManifest.value.entry.sha256, "expanded UI entry module");
  const uiSettings = await ordinaryFile(path.join(uiRoot, uiManifest.value.dependencies[0].name), uiManifest.value.dependencies[0].sha256, "expanded UI settings module");
  const uiFormatting = await ordinaryFile(path.join(uiRoot, uiManifest.value.dependencies[1].name), uiManifest.value.dependencies[1].sha256, "expanded UI formatting module");
  await validateUiModuleGraph(uiDriver.path, uiSettings.path, uiFormatting.path);
  return { uiManifest, uiDriver, uiSettings, uiFormatting };
}

function validateReadyEnvelope(value) {
  check(value?.schemaVersion === 2 && value?.status === "ready", "Web receipt is not exact schema-v2 READY");
  check(HEX64.test(value?.package?.sha256 ?? ""), "Web READY package SHA-256 is invalid");
  check(HEX64.test(value?.package?.releaseManifestSha256 ?? ""), "Web READY release manifest SHA-256 is invalid");
}

function validateOptions(options) {
  if (options.help || options.selfTest) return;
  for (const key of [
    "artifactRoot", "desktopExeSha256", "candidateContract", "candidateContractSha256",
    "webReadyReceipt", "webReadyReceiptSha256", "browserDriver", "browserDriverSha256",
    "uiDriverManifest", "uiDriverManifestSha256",
    "chromium", "chromiumSha256", "tlsSpki", "resolveHost", "controlNonce",
  ]) check(String(options[key]).length > 0, `--${key.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)} is required`);
  for (const [value, label] of [
    [options.desktopExeSha256, "desktop executable"],
    [options.candidateContractSha256, "candidate contract"],
    [options.webReadyReceiptSha256, "Web READY receipt"],
    [options.browserDriverSha256, "browser driver"],
    [options.uiDriverManifestSha256, "expanded UI driver manifest"],
    [options.chromiumSha256, "Chromium"],
  ]) check(HEX64.test(value), `${label} SHA-256 must be uppercase hexadecimal`);
  check(options.origin === "https://kaigen.test", "Web interop origin must be exactly https://kaigen.test");
  check(isIP(options.resolveHost) === 4, "--resolve-host must be an exact IPv4 address");
  check(TLS_SPKI.test(options.tlsSpki), "--tls-spki must be one SHA-256 SPKI pin in base64");
  check(NONCE.test(options.controlNonce), "--control-nonce must contain 32 lowercase hexadecimal characters");
}

async function bindInputs(options) {
  validateOptions(options);
  const artifactRoot = await realpath(path.resolve(options.artifactRoot));
  check((await stat(artifactRoot)).isDirectory(), "artifact root is not a directory");
  const executable = await realpath(path.resolve(options.exe || path.join(artifactRoot, "Kaigen.exe")));
  check(isWithin(artifactRoot, executable), "desktop executable must be inside the declared artifact root");
  const desktop = await ordinaryFile(executable, options.desktopExeSha256, "desktop executable");
  const candidateFile = await ordinaryFile(path.resolve(options.candidateContract), options.candidateContractSha256, "candidate contract");
  const readyFile = await ordinaryFile(path.resolve(options.webReadyReceipt), options.webReadyReceiptSha256, "Web READY receipt");
  const browserDriver = await ordinaryFile(path.resolve(options.browserDriver), options.browserDriverSha256, "browser driver");
  const { uiManifest, uiDriver, uiSettings, uiFormatting } = await bindUiDriverManifest(options.uiDriverManifest, options.uiDriverManifestSha256);
  const chromium = await ordinaryFile(path.resolve(options.chromium), options.chromiumSha256, "Chromium executable");
  const candidate = await readCanonicalJson(candidateFile.path, candidateFile, "candidate contract");
  const ready = await readCanonicalJson(readyFile.path, readyFile, "Web READY receipt");
  check(candidate.value?.schemaVersion === 1 && SAFE_CANDIDATE.test(candidate.value?.buildId ?? ""), "candidate contract identity is invalid");
  check(candidate.value?.install?.origin === options.origin, "candidate contract origin mismatch");
  validateReadyEnvelope(ready.value);
  check(ready.value?.buildId === candidate.value.buildId, "Web READY candidate ID mismatch");
  check(ready.value?.contractSha256 === candidate.sha256, "Web READY contract SHA-256 mismatch");
  check(ready.value?.source?.archiveSha256 === candidate.value?.source?.archive?.sha256, "Web READY source archive mismatch");
  check(ready.value?.source?.tree === candidate.value?.source?.tree, "Web READY source tree mismatch");
  check(ready.value?.package?.releaseRestored === true && ready.value?.rollback === "PASS", "Web READY did not prove the supported rollback boundary");
  check(ready.value?.package?.previousTarget === `releases/${candidate.value.buildId}`, "verified candidate was not retained as the exact previous release");
  check(ready.value?.cleanup?.status === "PASS" && ready.value?.secretsIncluded === false, "Web READY privacy/cleanup boundary failed");
  return { artifactRoot, desktop, candidate, ready, browserDriver, uiManifest, uiDriver, uiSettings, uiFormatting, chromium };
}

class BrowserPipe {
  constructor(processHandle) {
    this.process = processHandle;
    this.input = processHandle.stdio[3];
    this.output = processHandle.stdio[4];
    this.sequence = 0;
    this.pending = new Map();
    this.listeners = new Set();
    this.buffer = Buffer.alloc(0);
    this.closed = false;
    this.output.on("data", (chunk) => this.onData(chunk));
    this.output.on("error", (error) => this.fail(error));
    processHandle.once("error", (error) => this.fail(error));
    processHandle.once("exit", () => this.fail(new Error("Chromium exited")));
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    check(this.buffer.length <= 16 * 1024 * 1024, "Chromium CDP response exceeded the bounded buffer");
    for (;;) {
      const boundary = this.buffer.indexOf(0);
      if (boundary < 0) break;
      const bytes = this.buffer.subarray(0, boundary);
      this.buffer = this.buffer.subarray(boundary + 1);
      if (!bytes.length) continue;
      const message = JSON.parse(bytes.toString("utf8"));
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(`${pending.method}: CDP command failed`));
        else pending.resolve(message.result ?? {});
      } else {
        for (const listener of this.listeners) listener(message);
      }
    }
  }

  fail(error) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  onEvent(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  send(method, params = {}, sessionId = undefined) {
    if (this.closed) return Promise.reject(new Error("Chromium CDP pipe is closed"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: CDP command timed out`));
      }, 30_000);
      this.pending.set(id, { method, resolve, reject, timer });
      this.input.write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`, "utf8", (error) => {
        if (!error) return;
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      });
    });
  }
}

async function launchBrowser(options, inputs, browserRoot, ChromiumPage) {
  await mkdir(browserRoot, { recursive: false });
  const browserArguments = [
    "--headless=new", "--remote-debugging-pipe", `--user-data-dir=${browserRoot}`,
    "--window-size=1600,1000", "--force-device-scale-factor=1", "--lang=ru-RU",
    "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
    "--disable-component-update", "--disable-default-apps", "--disable-sync", "--metrics-recording-only",
    `--ignore-certificate-errors-spki-list=${options.tlsSpki}`,
    `--host-resolver-rules=MAP kaigen.test ${options.resolveHost},EXCLUDE localhost`,
    "about:blank",
  ];
  const child = spawn(inputs.chromium.path, browserArguments, {
    stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"], windowsHide: true,
  });
  const stderr = [];
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr.push(...chunk.split(/\r?\n/u).filter(Boolean).map(() => "[chromium diagnostic redacted]"));
    if (stderr.length > 20) stderr.splice(0, stderr.length - 20);
  });
  const browser = new BrowserPipe(child);
  try {
    const version = await browser.send("Browser.getVersion");
    const target = await browser.send("Target.createTarget", { url: "about:blank" });
    const attached = await browser.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
    await Promise.all([
      browser.send("Page.enable", {}, attached.sessionId), browser.send("Runtime.enable", {}, attached.sessionId),
      browser.send("Network.enable", {}, attached.sessionId), browser.send("Log.enable", {}, attached.sessionId),
      browser.send("DOM.enable", {}, attached.sessionId),
      browser.send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false }, attached.sessionId),
    ]);
    return new ChromiumPage(browser, attached.sessionId, child, {
      product: version.product, revision: version.revision, userAgent: version.userAgent, jsVersion: version.jsVersion,
    }, stderr, options.origin);
  } catch (error) {
    try { await browser.send("Browser.close"); } catch {}
    if (child.exitCode === null) child.kill();
    throw error;
  }
}

async function navigate(page, url) {
  const result = await page.browser.send("Page.navigate", { url }, page.sessionId);
  check(!result.errorText, "browser navigation failed");
  await page.waitFor('document.readyState === "complete"', "browser document ready", 60_000);
}

function headerValue(headers, name) {
  const found = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name);
  return found ? String(found[1]) : "";
}

class WebCommandClient {
  constructor(page, candidateId) {
    this.label = "web";
    this.page = page;
    this.candidateId = candidateId;
    this.auth = null;
    this.unsubscribe = page.browser.onEvent((event) => {
      if (event.sessionId !== page.sessionId || event.method !== "Network.requestWillBeSent") return;
      let url;
      try { url = new URL(event.params?.request?.url ?? ""); } catch { return; }
      if (url.origin !== "https://kaigen.test" || !url.pathname.startsWith("/api/v1/commands/")) return;
      const headers = Object.fromEntries(AUTH_HEADERS.map((name) => [name, headerValue(event.params?.request?.headers, name)]));
      if (AUTH_HEADERS.every((name) => headers[name])) this.auth = headers;
    });
  }

  clearAuth() { this.auth = null; }

  async waitForAuth(timeoutMs) {
    return waitUntil(() => this.auth ?? undefined, timeoutMs, "real Web command authentication", 100);
  }

  async invoke(command, args = {}, timeoutMs = 30_000) {
    check(WEB_COMMANDS.has(command), `Web adapter rejected unapproved command ${command}`);
    const auth = await this.waitForAuth(timeoutMs);
    const expression = `(async () => {
      try {
        const response = await fetch(${JSON.stringify(`/api/v1/commands/${command}`)}, {
          method: "POST", credentials: "same-origin", cache: "no-store", referrerPolicy: "no-referrer",
          headers: ${JSON.stringify({ "Content-Type": "application/json", ...auth })},
          body: JSON.stringify(${JSON.stringify(args)}),
        });
        const body = await response.json().catch(() => ({}));
        return response.ok ? { ok: true, value: body } : { ok: false, code: String(body?.code || "WEB_COMMAND_FAILED") };
      } catch { return { ok: false, code: "WEB_COMMAND_UNAVAILABLE" }; }
    })()`;
    const result = await this.page.evaluate(expression);
    if (!result?.ok) throw new NativeCommandError(command, String(result?.code ?? "WEB_COMMAND_FAILED").slice(0, 80));
    return result.value;
  }

  close() { this.unsubscribe(); this.auth = null; }
}

async function readWebBackendTransport(page, candidateId) {
  // Identity is served by nginx; the readonly GET reaches kaigen-webd and returns 405.
  const observation = await page.evaluate("(" + (async (buildId) => {
    const read = async (endpoint) => {
      try {
        const response = await fetch(endpoint, {
          method: "GET", cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer",
          headers: { "X-Kaigen-Client-Build": buildId }, signal: AbortSignal.timeout(5000),
        });
        return { status: response.status, value: await response.json().catch(() => null) };
      } catch {
        return { status: null, value: null };
      }
    };
    const [identity, backend] = await Promise.all([
      read("/api/v1/build-identity"),
      read("/api/v1/commands/get_startup_state"),
    ]);
    return {
      identityHttpStatus: identity.status,
      identityMatches: identity.status === 200 && identity.value?.status === "ok" && identity.value?.buildId === buildId,
      backendHttpStatus: backend.status,
      backendMethodNotAllowed: backend.status === 405 && backend.value?.code === "METHOD_NOT_ALLOWED",
    };
  }).toString() + ")(" + JSON.stringify(candidateId) + ")");
  const classification = observation.identityHttpStatus === null || observation.backendHttpStatus === null
    ? "request-failed"
    : !observation.identityMatches
      ? "identity-unavailable-or-mismatch"
      : observation.backendMethodNotAllowed
        ? "active"
        : [502, 503, 504].includes(observation.backendHttpStatus)
          ? "upstream-unavailable"
          : "unexpected-backend-response";
  return { observedAtUtc: new Date().toISOString(), ...observation, classification };
}

async function readWebIdentity(page, candidateId) {
  const identity = await page.evaluate(`Promise.all([
    fetch("/kaigen-build-id", { cache: "no-store", credentials: "same-origin", referrerPolicy: "no-referrer" }).then(async (response) => ({ status: response.status, value: (await response.text()).trim() })),
    fetch("/api/v1/build-identity", { cache: "no-store", credentials: "same-origin", referrerPolicy: "no-referrer", headers: { "X-Kaigen-Client-Build": ${JSON.stringify(candidateId)} } }).then(async (response) => ({ status: response.status, value: await response.json() })),
  ])`);
  check(identity?.[0]?.status === 200 && identity[0].value === candidateId, "Web frontend build identity mismatch");
  check(identity?.[1]?.status === 200 && identity[1].value?.status === "ok" && identity[1].value?.buildId === candidateId, "Web backend build identity mismatch");
  return { frontend: true, backend: true };
}

async function createOwnedWorkspaceRecovery(runRoot, binding) {
  const root = path.resolve(runRoot);
  const info = await lstat(root);
  check(info.isDirectory() && !info.isSymbolicLink() && await realpath(root) === root, "workspace recovery root is unsafe");
  const privateFile = path.join(root, ".owned-web-workspace-recovery.private.json");
  let state = {
    schemaVersion: 1, ...binding, ownedRunRoot: root, controllerPid: process.pid,
    createdAtUtc: new Date().toISOString(), stage: "prepared", browser: null,
    workspaceUrl: null, workspacePassword: null, workspaceDestroyed: false, browserExitVerified: false,
  };
  const initial = await open(privateFile, "wx", 0o600);
  try { await initial.writeFile(canonicalJsonBytes(state)); await initial.sync(); }
  finally { await initial.close(); }
  const checkpoint = async (updates) => {
    state = { ...state, ...updates, updatedAtUtc: new Date().toISOString() };
    const temporary = `${privateFile}.stage-${randomBytes(8).toString("hex")}`;
    let handle;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(canonicalJsonBytes(state));
      await handle.sync();
      await handle.close(); handle = null;
      await rename(temporary, privateFile);
    } finally {
      if (handle) await handle.close();
      await rm(temporary, { force: true });
    }
  };
  return Object.freeze({
    checkpoint,
    async browserOpened(page, browserRoot, launchRequestedAtUtc) {
      check(Number.isSafeInteger(page.process?.pid) && page.process.pid > 0, "owned Chromium PID is unavailable");
      check(isWithin(root, path.resolve(browserRoot)), "workspace recovery browser root escaped the owned run");
      await checkpoint({
        browser: { pid: page.process.pid, executable: binding.chromium, userDataDir: path.resolve(browserRoot), launchRequestedAtUtc, observedAtUtc: new Date().toISOString() },
        browserExitVerified: false,
      });
    },
    async workspaceCreated(workspace) {
      const url = new URL(workspace.workspaceUrl);
      check(url.origin === binding.origin && url.pathname === "/" && !url.search && /^#k=[A-Za-z0-9_-]{40,80}$/u.test(url.hash), "workspace recovery route is invalid");
      check(/^Kw![A-Za-z0-9_-]{32}$/u.test(workspace.password), "workspace recovery password format is invalid");
      await checkpoint({ stage: "workspace-created", workspaceUrl: workspace.workspaceUrl, workspacePassword: workspace.password });
    },
    async workspaceDestroyed() {
      await checkpoint({ stage: "workspace-destroyed", workspaceDestroyed: true, workspaceUrl: null, workspacePassword: null, workspaceDestroyedAtUtc: new Date().toISOString() });
    },
  });
}


async function createWorkspaceAndProfile(page, web, options, candidateId, onWorkspaceCreated, recovery) {
  await navigate(page, options.origin);
  await page.waitFor('document.querySelector(".web-gate-card form .web-storage-choice")', "Web workspace initializer", 60_000);
  const buildIdentity = await readWebIdentity(page, candidateId);
  await page.click(".web-storage-choice button:nth-child(2)");
  const password = `Kw!${randomBytes(24).toString("base64url")}`;
  await recovery.checkpoint({ stage: "workspace-creating", workspacePassword: password });
  const passwordsSet = await page.evaluate(`(() => {
    const inputs = Array.from(document.querySelectorAll('.web-gate-card form input[type="password"]'));
    if (inputs.length !== 2) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    for (const input of inputs) { setter.call(input, ${JSON.stringify(password)}); input.dispatchEvent(new Event("input", { bubbles: true })); }
    return true;
  })()`);
  check(passwordsSet === true, "Web workspace password controls were unavailable");
  await page.waitFor('document.querySelector(".web-gate-card form .web-primary:not(:disabled)")', "enabled Web workspace creation", 10_000);
  await page.click(".web-gate-card form .web-primary");
  await page.waitFor('location.hash.startsWith("#k=")', "Web workspace fragment", 90_000);
  const workspaceUrl = await page.evaluate("location.href");
  check(typeof workspaceUrl === "string" && workspaceUrl.startsWith(`${options.origin}/#k=`), "Web workspace route was invalid");
  const workspace = { workspaceUrl, password, buildIdentity, diskBacked: false };
  await onWorkspaceCreated(workspace);
  await page.waitFor('document.querySelector(".welcome-card.create-card button")', "Web profile welcome", 90_000);
  await page.click(".welcome-card.create-card button");
  await page.waitFor('document.querySelector(".startup-form.create-flow input:not([type=checkbox])")', "Web profile form");
  await page.setValue(".startup-form.create-flow input:not([type=checkbox])", "Synthetic Desktop Web");
  await page.waitFor('document.querySelector(".startup-form.create-flow .startup-primary:not(:disabled)")', "enabled Web profile creation", 10_000);
  await page.click(".startup-form.create-flow .startup-primary");
  await page.waitFor('document.querySelector(".app-shell")', "Web profile app shell", 90_000);
  const fastPresetSelector = '[data-kaigen-ui-id="kaigen.startup.first-run-preset.element.fast-choice"]';
  await page.waitFor(`(() => {
    const button = document.querySelector(${JSON.stringify(fastPresetSelector)});
    return button instanceof HTMLButtonElement && !button.disabled && button.getBoundingClientRect().width > 0;
  })()`, "Web Fast initial connection preset", 30_000);
  await page.click(fastPresetSelector);
  await page.waitFor(`!document.querySelector('[data-kaigen-ui-id="kaigen.startup.first-run-preset.group.overlay"]')`, "applied Web Fast initial connection preset", 30_000);
  await web.waitForAuth(30_000);
  const startupAfterPreset = await web.invoke("get_startup_state");
  const activeProfile = startupAfterPreset?.profiles?.find((profile) => profile.active && profile.loaded);
  check(startupAfterPreset?.initialConnectionPresetRequired === false,
    "Web initial connection preset remained pending after the UI selection");
  check(activeProfile?.connection === "offline" && activeProfile?.userStatus === "offline",
    "Web initial connection preset unexpectedly connected the fresh profile");
  const online = await web.invoke("set_tox_user_status", { status: "online" });
  check(online === "online", "Web profile did not explicitly enter Online after the initial preset");
  const storage = await page.evaluate(`(() => document.querySelector(".web-storage span")?.textContent?.trim() ?? "")()`);
  check(storage.startsWith("На диске · ") || storage.startsWith("On disk · "), "Web workspace was not disk-backed");
  workspace.diskBacked = true;
  return workspace;
}

async function reopenWorkspace(page, web, workspace, timeoutMs, requireProfile = true) {
  web.clearAuth();
  await navigate(page, "about:blank");
  web.clearAuth();
  await navigate(page, workspace.workspaceUrl);
  await page.waitFor('document.querySelector(".web-shell") || document.querySelector(".web-gate-card form input[type=password]") || document.querySelector(".web-error")', "restored Web workspace route", timeoutMs);
  const route = await page.evaluate(`(() => ({ shell: !!document.querySelector(".web-shell"), auth: !!document.querySelector(".web-gate-card form input[type=password]"), error: !!document.querySelector(".web-error") }))()`);
  check(route && !route.error, "restored Web workspace entered an error route");
  if (route.auth) {
    await page.setValue('.web-gate-card form input[type="password"]', workspace.password);
    await page.waitFor('document.querySelector(".web-gate-card form .web-primary:not(:disabled)")', "enabled Web workspace login", 10_000);
    await page.click(".web-gate-card form .web-primary");
  }
  await page.waitFor('document.querySelector(".web-shell")', "restored Web workspace shell", timeoutMs);
  await web.waitForAuth(30_000);
  if (requireProfile) await page.waitFor('document.querySelector(".app-shell")', "restored Web profile app shell", timeoutMs);
}

async function openWorkspaceCleanupMenu(page, timeoutMs = 10_000) {
  // The service bar exists while RootApp's startup splash can still cover it.
  await page.waitFor(`(() => {
    const button = document.querySelector(".web-menu > button");
    if (!document.querySelector(".web-shell") || document.querySelector(".splash-screen")) return false;
    if (!(button instanceof HTMLButtonElement) || button.hidden || button.disabled) return false;
    const bounds = button.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return false;
    const hit = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
    return hit !== null && (hit === button || button.contains(hit));
  })()`, "reachable Web workspace cleanup menu button", timeoutMs);
  const expanded = await page.evaluate('document.querySelector(".web-menu > button")?.getAttribute("aria-expanded") === "true"');
  if (!expanded) await page.click(".web-menu > button");
  await page.waitFor('document.querySelector(".web-menu > button")?.getAttribute("aria-expanded") === "true" && document.querySelector(".web-menu nav[role=menu]")', "open Web workspace cleanup menu", timeoutMs);
}

function markerBody(nonce, candidateId, phase, status) {
  return { schemaVersion: 1, nonce, candidateId, phase, status };
}

function controlRootFromReadyPath(readyPath, candidateId, nonce) {
  const resolvedReady = path.resolve(readyPath);
  check(path.basename(resolvedReady) === "ready.json", "Web READY receipt must be the canonical ready.json artifact");
  const attemptRoot = path.dirname(resolvedReady);
  const attemptsRoot = path.dirname(attemptRoot);
  const webRoot = path.dirname(attemptsRoot);
  const buildRoot = path.dirname(webRoot);
  const artifactsRoot = path.dirname(buildRoot);
  check(path.basename(attemptsRoot) === "attempts", "Web READY receipt escaped the candidate attempts root");
  check(path.basename(webRoot) === "web", "Web READY receipt escaped the candidate Web artifact root");
  check(path.basename(buildRoot) === candidateId, "Web READY receipt path does not match the candidate ID");
  check(path.basename(artifactsRoot) === "artifacts", "Web READY receipt escaped the laboratory artifacts root");
  check(isWithin(attemptsRoot, resolvedReady), "Web READY receipt is not inside its immutable attempt");
  return path.join(webRoot, "interop", nonce);
}

async function prepareControlRoot(inputs, nonce, create = true) {
  const candidateId = inputs.candidate.value.buildId;
  const controlRoot = controlRootFromReadyPath(inputs.ready.path, candidateId, nonce);
  const buildRoot = path.dirname(path.dirname(path.dirname(controlRoot)));
  check(isWithin(buildRoot, inputs.candidate.path), "candidate contract and READY receipt do not share one build artifact root");
  if (create) await mkdir(controlRoot, { recursive: true });
  const info = await lstat(controlRoot);
  check(info.isDirectory() && !info.isSymbolicLink(), "Web interop control root must be an ordinary directory");
  check(await realpath(controlRoot) === path.resolve(controlRoot), "Web interop control root path must already be canonical");
  return controlRoot;
}

async function writeMarker(controlRoot, nonce, candidateId, phase, status = "READY", allowIdentical = false) {
  const file = path.join(controlRoot, `${phase}.json`);
  const bytes = canonicalJsonBytes(markerBody(nonce, candidateId, phase, status));
  try {
    await writeFile(file, bytes, { flag: "wx" });
  } catch (error) {
    if (!allowIdentical || error?.code !== "EEXIST") throw error;
    const existing = await readFile(file, "utf8");
    check(existing === bytes, `existing ${phase} marker differs from the exact recovery marker`);
  }
  return file;
}

function validateOwnerReceipt(value, inputs, nonce, action, expectedRecovery) {
  const candidateId = inputs.candidate.value.buildId;
  const active = action !== "stop";
  assert.deepEqual(Object.keys(value), OWNER_RECEIPT_KEYS);
  check(value.schemaVersion === 1 && value.status === "PASS", `laboratory owner ${action} receipt did not PASS`);
  check(value.nonce === nonce && value.candidateId === candidateId && value.action === action, `laboratory owner ${action} receipt identity mismatch`);
  check(value.vmState === "running" && value.routeState === (active ? "candidate-active" : "candidate-stopped"), `laboratory owner ${action} route state mismatch`);
  check(value.activeSlot === inputs.ready.value.package.testedActiveSlot, `laboratory owner ${action} active slot mismatch`);
  check(value.currentTarget === `releases/${candidateId}` && value.previousTarget === inputs.ready.value.package.baselineTarget, `laboratory owner ${action} release targets mismatch`);
  check(value.serviceState === (active ? "active" : "inactive") && value.serviceEnabled === "enabled", `laboratory owner ${action} service state mismatch`);
  check(value.releaseManifestSha256 === inputs.ready.value.package.releaseManifestSha256, `laboratory owner ${action} release manifest does not match the exact READY candidate`);
  check(value.publicBuildId === (active ? candidateId : null), `laboratory owner ${action} public build identity mismatch`);
  check(value.readyReceiptSha256 === inputs.ready.sha256, `laboratory owner ${action} READY receipt binding mismatch`);
  check(typeof value.recovery === "boolean" && (expectedRecovery === null || value.recovery === expectedRecovery), `laboratory owner ${action} recovery state mismatch`);
  check(value.productionContacted === false && value.secretsIncluded === false, `laboratory owner ${action} receipt crossed the privacy boundary`);
}

function validateOwnerReceiptBytes(text, value, action) {
  // The laboratory owner writes compact UTF-8 JSON followed by exactly one LF.
  check(text === `${JSON.stringify(value)}\n`, `laboratory owner ${action} receipt bytes are not canonical`);
}

async function waitOwnerReceipt(controlRoot, inputs, nonce, action, timeoutMs, expectedRecovery = false) {
  const names = { activate: "web-candidate-activated", stop: "web-service-stopped", start: "web-service-started" };
  const phase = names[action];
  check(phase, `unsupported laboratory owner action ${action}`);
  const file = path.join(controlRoot, `${phase}.json`);
  const parsed = await waitUntil(async () => {
    try {
      const text = await readFile(file, "utf8");
      return { text, value: JSON.parse(text) };
    }
    catch (error) { if (error?.code === "ENOENT") return undefined; throw error; }
  }, timeoutMs, `laboratory owner receipt ${phase}`, 200);
  validateOwnerReceiptBytes(parsed.text, parsed.value, action);
  const info = await lstat(file);
  check(info.isFile() && !info.isSymbolicLink() && await realpath(file) === path.resolve(file), `laboratory owner ${action} receipt is not an ordinary canonical file`);
  validateOwnerReceipt(parsed.value, inputs, nonce, action, expectedRecovery);
  return { file, value: parsed.value, sha256: await sha256File(file) };
}

function validateFormattingUiResult(value) {
  check(value && typeof value === "object" && !Array.isArray(value), "expanded Web formatting result is not an object");
  assert.deepEqual(Object.keys(value), ["schemaVersion", "status", "checks", "gestures", "messages", "screenshots"]);
  check(value.schemaVersion === 1 && value.status === "PASS", "expanded Web formatting result did not PASS");
  assert.deepEqual(Object.keys(value.checks ?? {}), FORMATTING_UI_CHECK_KEYS, "expanded Web formatting checks are missing or reordered");
  for (const name of FORMATTING_UI_CHECK_KEYS) check(value.checks[name] === true, `expanded Web formatting check ${name} did not PASS`);
  assert.deepEqual(value.gestures, {
    rightClick: "pass",
    keyboard: "pass",
    escape: "pass",
    macCtrlClick: "deferred-to-real-macos",
    actualPlatform: "win32",
  }, "expanded Web formatting gesture evidence is invalid for the actual Windows host");
  assert.deepEqual(Object.keys(value.messages ?? {}), ["count", "formattedSha256", "plainAfterRemovalSha256", "formattedSpanCount", "plainSpanCount"]);
  check(value.messages.count === 2 && value.messages.formattedSpanCount === 4 && value.messages.plainSpanCount === 0, "expanded Web formatting message/span counts are invalid");
  check(HEX64.test(value.messages.formattedSha256 ?? "") && HEX64.test(value.messages.plainAfterRemovalSha256 ?? ""), "expanded Web formatting message hashes are invalid");
  assert.deepEqual(value.screenshots, FORMATTING_SCREENSHOTS, "expanded Web formatting screenshot names/order are invalid");
}

function validateExpandedUiResult(value, candidateId) {
  check(value && typeof value === "object" && !Array.isArray(value), "expanded Web UI result is not an object");
  assert.deepEqual(Object.keys(value), ["schemaVersion", "status", "candidateId", "checks", "formatting", "screenshots", "diagnostics"]);
  check(value.schemaVersion === 1 && value.status === "PASS" && value.candidateId === candidateId, "expanded Web UI result identity/status mismatch");
  check(value.checks && typeof value.checks === "object" && !Array.isArray(value.checks), "expanded Web UI checks are invalid");
  const checks = Object.entries(value.checks);
  assert.deepEqual(Object.keys(value.checks), EXPANDED_UI_CHECK_KEYS, "expanded Web UI result omitted or reordered required coverage");
  for (const [name, result] of checks) {
    check(/^[a-z][A-Za-z0-9]{1,63}$/u.test(name), "expanded Web UI check name is unsafe");
    if (name === "unreadBatchCount") check(result === 24, "expanded Web UI unread batch coverage is incomplete");
    else if (name === "walletCopyCount") check(result === 5, "expanded Web UI wallet copy coverage is incomplete");
    else check(result === true, `expanded Web UI check ${name} did not PASS`);
  }
  validateFormattingUiResult(value.formatting);
  for (const name of FORMATTING_UI_CHECK_KEYS) {
    const expandedName = `formatting${name[0].toUpperCase()}${name.slice(1)}`;
    check(value.checks[expandedName] === value.formatting.checks[name], `expanded Web UI flattened formatting check ${expandedName} differs from its core result`);
  }
  check(Array.isArray(value.screenshots) && value.screenshots.length === 15, "expanded Web UI screenshot list is invalid");
  const names = new Set();
  for (const screenshot of value.screenshots) {
    assert.deepEqual(Object.keys(screenshot ?? {}), ["name", "sha256"]);
    check(/^[a-z0-9][a-z0-9._-]{1,94}\.png$/u.test(screenshot.name) && path.basename(screenshot.name) === screenshot.name, "expanded Web UI screenshot name is unsafe");
    check(!names.has(screenshot.name) && HEX64.test(screenshot.sha256), "expanded Web UI screenshot identity is invalid");
    names.add(screenshot.name);
  }
  for (const name of FORMATTING_SCREENSHOTS) check(names.has(name), `expanded Web UI screenshot list omitted ${name}`);
  assert.deepEqual(Object.keys(value.diagnostics ?? {}), ["consoleErrors", "pageErrors", "unexpectedHttpErrors", "networkFailures"]);
  assert.deepEqual(value.diagnostics, { consoleErrors: 0, pageErrors: 0, unexpectedHttpErrors: 0, networkFailures: 0 });
}

async function verifyExpandedUiEvidence(evidenceRoot, returned, candidateId) {
  validateExpandedUiResult(returned, candidateId);
  const rootInfo = await lstat(evidenceRoot);
  check(rootInfo.isDirectory() && !rootInfo.isSymbolicLink() && await realpath(evidenceRoot) === path.resolve(evidenceRoot), "expanded Web UI evidence root is unsafe");
  const receiptFile = path.join(evidenceRoot, "receipt.json");
  const receiptInfo = await lstat(receiptFile);
  check(receiptInfo.isFile() && !receiptInfo.isSymbolicLink() && await realpath(receiptFile) === path.resolve(receiptFile), "expanded Web UI receipt is not an ordinary canonical file");
  const receiptText = await readFile(receiptFile, "utf8");
  const receipt = JSON.parse(receiptText);
  check(receiptText === canonicalJsonBytes(receipt), "expanded Web UI receipt bytes are not canonical");
  assert.deepEqual(receipt, returned, "expanded Web UI returned result differs from its immutable receipt");
  const expectedFiles = ["receipt.json", ...returned.screenshots.map(({ name }) => name)].sort();
  const actualEntries = await readdir(evidenceRoot, { withFileTypes: true });
  check(actualEntries.every((entry) => entry.isFile() && !entry.isSymbolicLink()), "expanded Web UI evidence contains a non-file entry");
  assert.deepEqual(actualEntries.map(({ name }) => name).sort(), expectedFiles, "expanded Web UI evidence contains missing or unexpected files");
  for (const screenshot of returned.screenshots) {
    const binding = await ordinaryFile(path.join(evidenceRoot, screenshot.name), screenshot.sha256, `expanded Web UI screenshot ${screenshot.name}`);
    const bytes = await readFile(binding.path);
    check(binding.bytes >= 1_024 && bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE), `expanded Web UI screenshot ${screenshot.name} is not a nontrivial PNG`);
  }
  return { ...returned, receiptSha256: await sha256File(receiptFile) };
}

async function friendFor(client, peerPublicKey) {
  const friends = await client.invoke("get_tox_friends");
  check(Array.isArray(friends), `${client.label} returned an invalid friend list`);
  return friends.find((friend) => friend.public_key === peerPublicKey);
}

async function waitPeerOffline(client, peerPublicKey, timeoutMs, label) {
  return waitUntil(async () => {
    const friend = await friendFor(client, peerPublicKey);
    return friend?.connection === "offline" ? { authorized: friend.authorized === true, offline: true } : undefined;
  }, timeoutMs, label, 250);
}

async function waitPqStopped(desktop, web, friendNumbers, timeoutMs) {
  const statuses = await waitUntil(async () => {
    const [desktopStatus, webStatus] = await Promise.all([
      desktop.invoke("get_pq_status", { friendNumber: friendNumbers.desktopFriendNumber }),
      web.invoke("get_pq_status", { friendNumber: friendNumbers.webFriendNumber }),
    ]);
    return desktopStatus.state === "available" && webStatus.state === "available"
      ? { desktop: desktopStatus, web: webStatus } : undefined;
  }, timeoutMs, "Desktop-Web bilateral PQ shutdown", 150);
  for (const [label, value] of Object.entries(statuses)) {
    check(value.supported === true && value.protocol_version === 2 && value.auto_pending === false && !value.error, `${label} did not persist manual-only PQv2 shutdown`);
  }
  return { desktop: safePqStatus(statuses.desktop), web: safePqStatus(statuses.web) };
}

async function waitChatFormattingReady(desktop, web, friendNumbers, timeoutMs) {
  return waitUntil(async () => {
    const [desktopCapabilities, webCapabilities] = await Promise.all([
      desktop.invoke("get_chat_capabilities", { profileId: null, friendNumber: friendNumbers.desktopFriendNumber }),
      web.invoke("get_chat_capabilities", { profileId: null, friendNumber: friendNumbers.webFriendNumber }),
    ]);
    for (const [label, capabilities] of [["desktop", desktopCapabilities], ["Web", webCapabilities]]) {
      if (capabilities?.formatting === true) check(capabilities.protocolVersion === 1, `${label} formatting capability selected an invalid chat protocol version`);
    }
    return desktopCapabilities?.formatting === true && webCapabilities?.formatting === true
      ? { protocolVersion: 1, desktopFormatting: true, webFormatting: true }
      : undefined;
  }, timeoutMs, "Desktop-Web bilateral formatting capability", 100);
}

async function activatePqForExpandedUi(desktop, web, friendNumbers, timeoutMs) {
  const before = await Promise.all([
    desktop.invoke("get_pq_status", { friendNumber: friendNumbers.desktopFriendNumber }),
    web.invoke("get_pq_status", { friendNumber: friendNumbers.webFriendNumber }),
  ]);
  for (const [label, status] of [["desktop", before[0]], ["Web", before[1]]]) {
    check(status?.state === "available" && status.supported === true && status.protocol_version === 2
      && status.auto_pending === false && !status.error, `${label} was not in the durable manual-only PQv2 state before expanded UI activation; status=${JSON.stringify(safePqStatus(status))}`);
  }
  const requested = await desktop.invoke("request_pq_session", { friendNumber: friendNumbers.desktopFriendNumber });
  // PQv2 persists the request before its driver creates the outgoing handshake.
  check(requested?.protocol_version === 2 && ["accepting", "offered", "active"].includes(requested.state), `Desktop did not queue the manual PQv2 request for expanded UI; status=${JSON.stringify(safePqStatus(requested))}`);
  await waitUntil(async () => {
    const status = await web.invoke("get_pq_status", { friendNumber: friendNumbers.webFriendNumber });
    check(status?.protocol_version === 2 && !status.error, `Web selected an invalid PQ protocol while awaiting the expanded UI offer; status=${JSON.stringify(safePqStatus(status))}`);
    if (status.state !== "incoming_offer") return undefined;
    const accepted = await web.invoke("accept_pq_session", { friendNumber: friendNumbers.webFriendNumber });
    check(accepted?.protocol_version === 2 && ["accepting", "active"].includes(accepted.state), `Web did not accept the manual PQv2 offer for expanded UI; status=${JSON.stringify(safePqStatus(accepted))}`);
    return true;
  }, timeoutMs, "Web manual acceptance for expanded UI PQv2", 100);
  const active = await waitPairPqActive(desktop, web, {
    alphaFriendNumber: friendNumbers.desktopFriendNumber,
    betaFriendNumber: friendNumbers.webFriendNumber,
  }, timeoutMs);
  const capabilities = await waitChatFormattingReady(desktop, web, friendNumbers, timeoutMs);
  return { desktop: active.alpha, web: active.beta, capabilities, webAccepted: true };
}

function rowsForText(messages, text) {
  return messages.filter((message) => !message.event && message.text === text);
}

async function assertQueuedProtected(client, friendNumber, text, label) {
  const rows = rowsForText(await messagesFor(client, friendNumber), text);
  check(rows.length === 1 && rows[0].mine === true && rows[0].pq_protected === true && rows[0].delivery !== "failed", `${label} was not durably queued under the retained PQ epoch`);
  return { senderCount: 1, pqProtected: true };
}

async function assertPendingProtected(client, friendNumber, text, label) {
  const queued = await assertQueuedProtected(client, friendNumber, text, label);
  const row = rowsForText(await messagesFor(client, friendNumber), text)[0];
  check(row.delivery === "pending", `${label} was ${row.delivery}, expected a durable pending sender receipt`);
  return { ...queued, delivery: "pending" };
}

async function assertFinalHistory(desktop, web, friendNumbers, messages) {
  const [desktopRows, webRows] = await Promise.all([
    messagesFor(desktop, friendNumbers.desktopFriendNumber),
    messagesFor(web, friendNumbers.webFriendNumber),
  ]);
  for (const item of messages) {
    const desktopMatches = rowsForText(desktopRows, item.text);
    const webMatches = rowsForText(webRows, item.text);
    check(desktopMatches.length === 1 && webMatches.length === 1, `${item.label} final history count was not exactly one per side`);
    const sender = item.sender === "desktop" ? desktopMatches[0] : webMatches[0];
    const receiver = item.sender === "desktop" ? webMatches[0] : desktopMatches[0];
    check(sender.mine === true && receiver.mine === false, `${item.label} final history directions were wrong`);
    check(sender.delivery === "delivered", `${item.label} final sender receipt was ${sender.delivery}, expected delivered`);
    check(sender.pq_protected === item.pqProtected && receiver.pq_protected === item.pqProtected, `${item.label} final PQ marker mismatch`);
  }
  return { expected: messages.length, desktopExact: true, webExact: true, directionsExact: true, senderReceiptsDelivered: true, duplicates: 0 };
}

async function prepareRun(options, inputs, policy) {
  await mkdir(runsRoot, { recursive: true });
  const runId = `pq-desktop-web-${new Date().toISOString().replace(/[-:.TZ]/gu, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
  const runRoot = options.runRoot ? path.resolve(options.runRoot) : path.join(runsRoot, runId);
  check(isWithin(runsRoot, runRoot) && path.basename(runRoot).startsWith("pq-desktop-web-"), "run root escaped the dedicated Desktop-Web runs root");
  check(!existsSync(runRoot), "run root already exists");
  check(!isWithin(inputs.artifactRoot, runRoot) && !isWithin(runRoot, inputs.artifactRoot), "artifact and disposable run roots overlap");
  await mkdir(runRoot, { recursive: false });
  const instancesRoot = path.join(runRoot, "instances");
  const evidenceRoot = path.join(runRoot, "evidence");
  const controlRoot = await prepareControlRoot(inputs, options.controlNonce, policy.serviceControl);
  await Promise.all([mkdir(instancesRoot), mkdir(evidenceRoot)]);
  await writeFile(path.join(runRoot, "RUN-MARKER.json"), canonicalJsonBytes({ schemaVersion: 1, runId, controlNonce: options.controlNonce }), { flag: "wx" });
  return { runId, runRoot, instancesRoot, evidenceRoot, controlRoot, desktopRoot: path.join(instancesRoot, "desktop"), browserRoot: path.join(instancesRoot, "browser") };
}

async function cleanupLocal(paths, keepProfiles) {
  if (keepProfiles) return false;
  const marker = JSON.parse(await readFile(path.join(paths.runRoot, "RUN-MARKER.json"), "utf8"));
  check(marker.schemaVersion === 1 && marker.runId === paths.runId, "run marker mismatch; refusing local recursive cleanup");
  check(isWithin(paths.runRoot, paths.instancesRoot), "instance cleanup target escaped run root");
  const info = await lstat(paths.instancesRoot);
  check(info.isDirectory() && !info.isSymbolicLink(), "instance cleanup root was unsafe");
  await rm(paths.instancesRoot, { recursive: true, force: false, maxRetries: 5, retryDelay: 100 });
  return true;
}

async function run(options) {
  const policy = phasePolicy(options.phase);
  if (process.platform !== "win32") throw new Error("Desktop-Web full-process test requires the Windows desktop artifact host");
  const inputs = await bindInputs(options);
  const browserModule = await import(pathToFileURL(inputs.browserDriver.path).href);
  check(typeof browserModule.ChromiumPage === "function", "browser driver did not export ChromiumPage");
  const uiModule = await import(pathToFileURL(inputs.uiDriver.path).href);
  assert.deepEqual(Object.keys(uiModule), ["runExpandedWebUi"], "expanded Web UI driver must expose only runExpandedWebUi");
  check(typeof uiModule.runExpandedWebUi === "function", "expanded Web UI driver export is invalid");
  const paths = await prepareRun(options, inputs, policy);
  const candidateId = inputs.candidate.value.buildId;
  const ownerTimeoutMs = options.timeoutMs;
  const receiptPath = path.join(paths.evidenceRoot, "receipt.json");
  const receipt = {
    schemaVersion: 1, status: "RUNNING", runId: paths.runId,
    phase: policy.phase, scope: policy.scope, fullCoverage: policy.serviceControl,
    startedAt: new Date().toISOString(), completedAt: null,
    identity: {
      candidateId, candidateContractSha256: inputs.candidate.sha256,
      webReadyReceiptSha256: inputs.ready.sha256, webPackageSha256: inputs.ready.value.package.sha256,
      sourceArchiveSha256: inputs.candidate.value.source.archive.sha256, sourceTree: inputs.candidate.value.source.tree,
      desktopExeSha256: inputs.desktop.sha256, chromiumSha256: inputs.chromium.sha256,
      browserDriverSha256: inputs.browserDriver.sha256,
      uiDriverManifestSha256: inputs.uiManifest.sha256, uiDriverSha256: inputs.uiDriver.sha256,
      uiSettingsDriverSha256: inputs.uiSettings.sha256,
      uiFormattingDriverSha256: inputs.uiFormatting.sha256,
    },
    topology: {
      desktopProcesses: 1, webBrowserProcesses: 1, webBackend: "pinned-local-Web-Lab",
      syntheticProfiles: 3, interopParticipants: 2, expandedUiAdditionalProfiles: 1,
      productionContacted: false,
    },
    ownerActivationReceiptSha256: null, scenarios: [], finalHistory: null,
    workspaceDestroyed: false, localProfilesDisposed: false,
  };
  const desktop = new KaigenProcess({
    label: "desktop", executable: inputs.desktop.path, root: paths.desktopRoot,
    port: await freeLoopbackPort(), startupTimeoutMs: options.startupTimeoutMs,
  });
  let page = null;
  let web = null;
  let workspace = null;
  let recovery = null;
  let friendNumbers = null;
  let desktopToxId = "";
  let webToxId = "";
  const expected = [];
  let failure = null;
  let webStopRequested = false;
  let webStartAcknowledged = false;
  let abortEmitted = false;
  const message = (label, sender) => {
    const text = `[${paths.runId}] ${sender}:${label}`;
    expected.push({ label, sender, text, pqProtected: label !== "manual-only-after-restarts" });
    return text;
  };
  const replacements = () => [
    [workspace?.workspaceUrl, "[redacted-workspace-url]"], [workspace?.password, "[redacted-workspace-password]"],
    [desktopToxId, "[redacted-desktop-tox-id]"], [webToxId, "[redacted-web-tox-id]"],
    [paths.desktopRoot, "[redacted-desktop-root]"], [paths.browserRoot, "[redacted-browser-root]"],
  ];
  const signalOwnerRecovery = async () => {
    const abort = await writeMarker(paths.controlRoot, options.controlNonce, candidateId, "driver-abort", "FAIL", true);
    const start = await writeMarker(paths.controlRoot, options.controlNonce, candidateId, "ready-for-web-start", "READY", true);
    abortEmitted = true;
    return { abortSha256: await sha256File(abort), readyStartSha256: await sha256File(start) };
  };
  try {
    const activated = await waitOwnerReceipt(paths.controlRoot, inputs, options.controlNonce, "activate", policy.serviceControl ? ownerTimeoutMs : 1000);
    receipt.ownerActivationReceiptSha256 = activated.sha256;
    recovery = await createOwnedWorkspaceRecovery(paths.runRoot, { scope: "pq-desktop-web", runId: paths.runId, candidateId, origin: options.origin, resolveHost: options.resolveHost, tlsSpki: options.tlsSpki, chromium: inputs.chromium, browserDriver: inputs.browserDriver });
    await desktop.start();
    const desktopCreated = await desktop.invoke("create_profile", { name: "Synthetic Desktop", password: null });
    const desktopProfiles = desktopCreated?.profiles;
    check(desktopProfiles?.some((profile) => profile.active && profile.loaded), "desktop synthetic profile did not load");
    await selectFastInitialConnectionPreset(desktop, options.startupTimeoutMs);
    await setUserStatus(desktop, "online");
    const browserLaunchRequestedAtUtc = new Date().toISOString();
    page = await launchBrowser(options, inputs, paths.browserRoot, browserModule.ChromiumPage);
    await recovery.browserOpened(page, paths.browserRoot, browserLaunchRequestedAtUtc);
    web = new WebCommandClient(page, candidateId);
    workspace = await createWorkspaceAndProfile(page, web, options, candidateId, async (created) => {
      workspace = created;
      await recovery.workspaceCreated(created);
    }, recovery);
    const [desktopNetwork, webNetwork] = await Promise.all([desktop.invoke("get_network_settings"), web.invoke("get_network_settings")]);
    check(desktopNetwork?.udpEnabled === true && desktopNetwork?.localDiscoveryEnabled === true, "desktop LAN discovery was unavailable");
    check(webNetwork?.udpEnabled === true && webNetwork?.localDiscoveryEnabled === true, "Web LAN discovery was unavailable");
    [desktopToxId, webToxId] = await Promise.all([desktop.invoke("get_tox_id"), web.invoke("get_tox_id")]);
    const desktopPublicKey = publicKeyFromToxId(desktopToxId, "desktop");
    const webPublicKey = publicKeyFromToxId(webToxId, "web");
    check(desktopPublicKey !== webPublicKey, "Desktop and Web shared a Tox identity");
    const [desktopFriendNumber, webFriendNumber] = await Promise.all([
      desktop.invoke("add_tox_friend", { toxId: webToxId, message: "Synthetic Desktop-Web authorization" }),
      web.invoke("add_tox_friend", { toxId: desktopToxId, message: "Synthetic Desktop-Web authorization" }),
    ]);
    check(Number.isInteger(desktopFriendNumber) && Number.isInteger(webFriendNumber), "Desktop-Web reciprocal friendship failed");
    const online = await waitPairOnline(desktop, web, desktopPublicKey, webPublicKey, options.timeoutMs);
    const pqCapable = await waitPairPqCapable(desktop, web, online, options.timeoutMs);
    friendNumbers = { desktopFriendNumber: online.alphaFriendNumber, webFriendNumber: online.betaFriendNumber };
    receipt.scenarios.push({ name: "real-topology-and-identity", status: "PASS", exactFrontendBackendIdentity: true, diskBackedWorkspace: true, reciprocalFriendsOnline: true });

    const desktopFirst = message("online-first-desktop", "desktop");
    const webFirst = message("online-first-web", "web");
    await Promise.all([
      sendDurably(desktop, friendNumbers.desktopFriendNumber, desktopFirst, options.timeoutMs),
      sendDurably(web, friendNumbers.webFriendNumber, webFirst, options.timeoutMs),
    ]);
    const firstSendPq = await waitPairPqActive(desktop, web, {
      alphaFriendNumber: friendNumbers.desktopFriendNumber,
      betaFriendNumber: friendNumbers.webFriendNumber,
    }, options.timeoutMs);
    await Promise.all([
      waitMessageExact({ sender: desktop, receiver: web, senderFriendNumber: friendNumbers.desktopFriendNumber, receiverFriendNumber: friendNumbers.webFriendNumber, text: desktopFirst, label: "online-first-desktop", pqProtected: true, timeoutMs: options.timeoutMs }),
      waitMessageExact({ sender: web, receiver: desktop, senderFriendNumber: friendNumbers.webFriendNumber, receiverFriendNumber: friendNumbers.desktopFriendNumber, text: webFirst, label: "online-first-web", pqProtected: true, timeoutMs: options.timeoutMs }),
    ]);
    receipt.scenarios.push({
      name: "lifetime-first-send-online-auto-pq", status: "PASS", bothOnlineBeforeFirstSend: true,
      freshConnectionCapabilityObserved: true,
      capabilityBeforeFirstSend: { desktop: safePqStatus(pqCapable.alpha), web: safePqStatus(pqCapable.beta) },
      automaticPqAfterFirstSend: { desktop: firstSendPq.alpha, web: firstSendPq.beta },
      protocolVersion: 2, protectedExactDeliveries: 2,
    });

    await runTransportPhase(policy, async () => {
      const activeDesktop = message("active-desktop", "desktop");
      const activeWeb = message("active-web", "web");
      await Promise.all([
        sendDurably(desktop, friendNumbers.desktopFriendNumber, activeDesktop, options.timeoutMs),
        sendDurably(web, friendNumbers.webFriendNumber, activeWeb, options.timeoutMs),
      ]);
      await Promise.all([
        waitMessageExact({ sender: desktop, receiver: web, senderFriendNumber: friendNumbers.desktopFriendNumber, receiverFriendNumber: friendNumbers.webFriendNumber, text: activeDesktop, label: "active-desktop", pqProtected: true, timeoutMs: options.timeoutMs }),
        waitMessageExact({ sender: web, receiver: desktop, senderFriendNumber: friendNumbers.webFriendNumber, receiverFriendNumber: friendNumbers.desktopFriendNumber, text: activeWeb, label: "active-web", pqProtected: true, timeoutMs: options.timeoutMs }),
      ]);
      await reopenWorkspace(page, web, workspace, options.timeoutMs);
      await readWebIdentity(page, candidateId);
      receipt.scenarios.push({ name: "browser-document-reload-reauthentication", status: "PASS", exactDeliveries: 2, documentRecreated: true, browserTransportInterrupted: false, workspaceReauthenticated: true, candidateIdentityRetained: true });

      await desktop.hardKill();
      const webObservedDesktopOffline = await waitPeerOffline(web, desktopPublicKey, options.timeoutMs, "Web observation of real desktop peer offline");
      const webBacklog = message("old-epoch-desktop-peer-offline", "web");
      await sendDurably(web, friendNumbers.webFriendNumber, webBacklog, options.timeoutMs);
      const webPendingBeforeStop = await assertPendingProtected(web, friendNumbers.webFriendNumber, webBacklog, "old epoch desktop-offline Web backlog");
      receipt.webBackendTransport = { beforeStop: await readWebBackendTransport(page, candidateId) };
      check(receipt.webBackendTransport.beforeStop.classification === "active",
        "Web backend transport before stop was not active: " + JSON.stringify(receipt.webBackendTransport.beforeStop));
      const readyStop = await writeMarker(paths.controlRoot, options.controlNonce, candidateId, "ready-for-web-stop");
      webStopRequested = true;
      const stopped = await waitOwnerReceipt(paths.controlRoot, inputs, options.controlNonce, "stop", ownerTimeoutMs);
      await waitUntil(async () => {
        const observation = await readWebBackendTransport(page, candidateId);
        receipt.webBackendTransport.duringStop = observation;
        check(["active", "upstream-unavailable"].includes(observation.classification),
          "Web backend outage evidence is inconclusive: " + JSON.stringify(observation));
        return observation.classification === "upstream-unavailable" ? observation : undefined;
      }, options.timeoutMs, "Web backend transport outage", 250);
      await desktop.start();
      const offlineDesktopFriend = await waitUntil(async () => {
        const friend = await friendFor(desktop, webPublicKey);
        return friend?.connection === "offline" ? friend : undefined;
      }, options.timeoutMs, "desktop durable Web friend while backend was stopped", 200);
      friendNumbers.desktopFriendNumber = offlineDesktopFriend.number;
      const desktopObservedWebOffline = await waitPeerOffline(desktop, webPublicKey, options.timeoutMs, "desktop observation of real Web peer offline");
      const desktopBacklog = message("old-epoch-web-peer-offline", "desktop");
      await sendDurably(desktop, friendNumbers.desktopFriendNumber, desktopBacklog, options.timeoutMs);
      const desktopPendingBeforeRestart = await assertPendingProtected(desktop, friendNumbers.desktopFriendNumber, desktopBacklog, "old epoch Web-offline desktop backlog");
      const closing = await desktop.invoke("request_pq_shutdown", { friendNumber: friendNumbers.desktopFriendNumber });
      check(PROTECTED_STATES.has(closing.state) && closing.state !== "active", "manual shutdown did not retain the old PQ epoch while Web was offline");
      await desktop.hardKill();
      const readyStart = await writeMarker(paths.controlRoot, options.controlNonce, candidateId, "ready-for-web-start");
      const started = await waitOwnerReceipt(paths.controlRoot, inputs, options.controlNonce, "start", ownerTimeoutMs);
      webStartAcknowledged = true;
      receipt.webBackendTransport.afterStart = await readWebBackendTransport(page, candidateId);
      check(receipt.webBackendTransport.afterStart.classification === "active",
        "Web backend transport after start was not active: " + JSON.stringify(receipt.webBackendTransport.afterStart));
      await reopenWorkspace(page, web, workspace, options.timeoutMs);
      await readWebIdentity(page, candidateId);
      const restoredWebFriend = await waitUntil(() => friendFor(web, desktopPublicKey).then((value) => value ?? undefined), options.timeoutMs, "Web durable desktop friend after backend restart", 200);
      friendNumbers.webFriendNumber = restoredWebFriend.number;
      await waitPeerOffline(web, desktopPublicKey, options.timeoutMs, "Web peer remained offline before desktop recovery");
      const webPendingAfterRestart = await assertPendingProtected(web, friendNumbers.webFriendNumber, webBacklog, "Web backlog after backend restart");
      await desktop.start();
      const afterOutageOnline = await waitPairOnline(desktop, web, desktopPublicKey, webPublicKey, options.timeoutMs);
      friendNumbers = { desktopFriendNumber: afterOutageOnline.alphaFriendNumber, webFriendNumber: afterOutageOnline.betaFriendNumber };
      await Promise.all([
        waitMessageExact({ sender: desktop, receiver: web, senderFriendNumber: friendNumbers.desktopFriendNumber, receiverFriendNumber: friendNumbers.webFriendNumber, text: desktopBacklog, label: "old-epoch-web-peer-offline", pqProtected: true, timeoutMs: options.timeoutMs }),
        waitMessageExact({ sender: web, receiver: desktop, senderFriendNumber: friendNumbers.webFriendNumber, receiverFriendNumber: friendNumbers.desktopFriendNumber, text: webBacklog, label: "old-epoch-desktop-peer-offline", pqProtected: true, timeoutMs: options.timeoutMs }),
      ]);
      const stoppedPq = await waitPqStopped(desktop, web, friendNumbers, options.timeoutMs);
      receipt.scenarios.push({
        name: "real-web-backend-outage-bidirectional-old-epoch-recovery", status: "PASS", ownerCoordination: {
          readyStopSha256: await sha256File(readyStop), stoppedSha256: stopped.sha256,
          readyStartSha256: await sha256File(readyStart), startedSha256: started.sha256,
        }, webObservedDesktopOffline: webObservedDesktopOffline.offline, desktopObservedWebOffline: desktopObservedWebOffline.offline,
        webPendingBeforeServiceStop: webPendingBeforeStop.delivery === "pending",
        webPendingAfterServiceRestart: webPendingAfterRestart.delivery === "pending",
        desktopPendingBeforeProcessRestart: desktopPendingBeforeRestart.delivery === "pending",
        exactDeliveriesAfterBothProcessesRecovered: 2, bilateralShutdownAfterDrain: true, finalPq: stoppedPq,
      });

      await desktop.hardKill();
      await desktop.start();
      await reopenWorkspace(page, web, workspace, options.timeoutMs);
      const finalOnline = await waitPairOnline(desktop, web, desktopPublicKey, webPublicKey, options.timeoutMs);
      friendNumbers = { desktopFriendNumber: finalOnline.alphaFriendNumber, webFriendNumber: finalOnline.betaFriendNumber };
      const manualOnly = message("manual-only-after-restarts", "web");
      await sendDurably(web, friendNumbers.webFriendNumber, manualOnly, options.timeoutMs);
      await waitMessageExact({ sender: web, receiver: desktop, senderFriendNumber: friendNumbers.webFriendNumber, receiverFriendNumber: friendNumbers.desktopFriendNumber, text: manualOnly, label: "manual-only-after-restarts", pqProtected: false, timeoutMs: options.timeoutMs });
      const finalPq = await waitPqStopped(desktop, web, friendNumbers, options.timeoutMs);
      receipt.scenarios.push({ name: "manual-only-persists-across-desktop-and-browser-restarts", status: "PASS", automaticPqRestarted: false, ordinaryExactDelivery: true, finalPq });
    }, async () => {
      await desktop.invoke("request_pq_shutdown", { friendNumber: friendNumbers.desktopFriendNumber });
      const stopped = await waitPqStopped(desktop, web, friendNumbers, options.timeoutMs);
      receipt.uiPreparation = { status: "PASS", freshPairInitiallyActive: true, manualOnlyBeforeUi: true, stopped };
    });

    receipt.finalHistory = await assertFinalHistory(desktop, web, friendNumbers, expected);
    receipt.finalHistory.pqProtected = expected.filter((item) => item.pqProtected).length;
    receipt.finalHistory.ordinary = expected.filter((item) => !item.pqProtected).length;
    receipt.finalHistory.messageSetSha256 = createHash("sha256").update(JSON.stringify(expected.map(({ label, sender, pqProtected }) => ({ label, sender, pqProtected })))).digest("hex").toUpperCase();

    const expandedUiPq = await activatePqForExpandedUi(desktop, web, friendNumbers, options.timeoutMs);
    receipt.scenarios.push({
      name: "expanded-ui-manual-pq-reactivation", status: "PASS", requester: "desktop",
      acceptor: "web", protocolVersion: 2, chatProtocolVersion: expandedUiPq.capabilities.protocolVersion,
      bilateralFormatting: true, bilateralPqActive: true,
    });
    const restartExpandedUiPair = async () => {
      await desktop.hardKill();
      await Promise.all([
        desktop.start(),
        reopenWorkspace(page, web, workspace, options.timeoutMs),
      ]);
      await readWebIdentity(page, candidateId);
      const restored = await waitPairOnline(desktop, web, desktopPublicKey, webPublicKey, options.timeoutMs);
      friendNumbers = { desktopFriendNumber: restored.alphaFriendNumber, webFriendNumber: restored.betaFriendNumber };
      const active = await waitPairPqActive(desktop, web, {
        alphaFriendNumber: friendNumbers.desktopFriendNumber,
        betaFriendNumber: friendNumbers.webFriendNumber,
      }, options.timeoutMs);
      const capabilities = await waitChatFormattingReady(desktop, web, friendNumbers, options.timeoutMs);
      return { desktop: active.alpha, web: active.beta, capabilities };
    };
    const ensureExpandedUiFormattingReady = async () => {
      const active = await waitPairPqActive(desktop, web, {
        alphaFriendNumber: friendNumbers.desktopFriendNumber,
        betaFriendNumber: friendNumbers.webFriendNumber,
      }, options.timeoutMs);
      const capabilities = await waitChatFormattingReady(desktop, web, friendNumbers, options.timeoutMs);
      return { desktop: active.alpha, web: active.beta, capabilities };
    };

    const expandedUiRoot = path.join(paths.evidenceRoot, "expanded-ui");
    check(isWithin(paths.evidenceRoot, expandedUiRoot), "expanded Web UI evidence root escaped the run evidence root");
    await mkdir(expandedUiRoot, { recursive: false });
    const expandedUi = await uiModule.runExpandedWebUi(Object.freeze({
      page, web, desktop, candidateId, origin: options.origin, timeoutMs: options.timeoutMs,
      desktopFriendNumber: friendNumbers.desktopFriendNumber, webFriendNumber: friendNumbers.webFriendNumber,
      evidenceRoot: expandedUiRoot,
      sendDesktopDurably: (text) => sendDurably(desktop, friendNumbers.desktopFriendNumber, text, options.timeoutMs),
      getFriendNumbers: () => ({ ...friendNumbers }),
      restartPair: restartExpandedUiPair,
      ensureFormattingReady: ensureExpandedUiFormattingReady,
      actualPlatform: process.platform,
      pqProtected: true,
      reopenWeb: async () => {
        await reopenWorkspace(page, web, workspace, options.timeoutMs);
        return readWebIdentity(page, candidateId);
      },
    }));
    receipt.expandedUi = await verifyExpandedUiEvidence(expandedUiRoot, expandedUi, candidateId);

    await openWorkspaceCleanupMenu(page, 60_000);
    await page.click('.web-menu nav[role=menu] button.danger', ["Уничтожить пространство", "Destroy workspace"]);
    await page.waitFor('document.querySelector(".web-close-modal")', "Web workspace destroy confirmation");
    await page.click(".web-close-modal button.danger");
    await page.waitFor('document.querySelector(".web-success") && !location.hash', "Web workspace destruction", options.timeoutMs);
    workspace.password = "";
    workspace.workspaceUrl = "";
    receipt.workspaceDestroyed = true;
    await recovery.workspaceDestroyed();
    receipt.status = policy.successStatus;
  } catch (error) {
    failure = error;
    receipt.status = "FAIL";
    receipt.failure = { type: error?.name ?? "Error", message: safeFailure(error?.message ?? error, replacements()) };
    if (webStopRequested && !webStartAcknowledged) {
      try { receipt.ownerRecoverySignal = await signalOwnerRecovery(); }
      catch (signalError) { receipt.ownerRecoverySignalFailure = safeFailure(signalError?.message ?? signalError, replacements()); }
    }
  } finally {
    if (webStopRequested && !webStartAcknowledged) {
      try {
        if (!abortEmitted) receipt.ownerRecoverySignal = await signalOwnerRecovery();
        const recovered = await waitOwnerReceipt(paths.controlRoot, inputs, options.controlNonce, "start", ownerTimeoutMs, null);
        webStartAcknowledged = true;
        receipt.ownerRecovery = { status: "PASS", startReceiptSha256: recovered.sha256, recovery: recovered.value.recovery };
      } catch (recoveryError) {
        receipt.ownerRecovery = { status: "FAIL", message: safeFailure(recoveryError?.message ?? recoveryError, replacements()) };
      }
    }
    if (page && workspace && !receipt.workspaceDestroyed && (!webStopRequested || webStartAcknowledged)) {
      try {
        await reopenWorkspace(page, web, workspace, Math.min(options.timeoutMs, 60_000), false);
        await openWorkspaceCleanupMenu(page);
        await page.click('.web-menu nav[role=menu] button.danger', ["Уничтожить пространство", "Destroy workspace"]);
        await page.waitFor('document.querySelector(".web-close-modal")', "cleanup Web workspace confirmation", 10_000);
        await page.click(".web-close-modal button.danger");
        await page.waitFor('document.querySelector(".web-success") && !location.hash', "cleanup Web workspace destruction", 60_000);
        workspace.password = ""; workspace.workspaceUrl = "";
        receipt.workspaceDestroyed = true;
        await recovery.workspaceDestroyed();
      } catch (cleanupError) {
        receipt.workspaceCleanupFailure = safeFailure(cleanupError?.message ?? cleanupError, replacements());
        if (!failure) { failure = cleanupError; receipt.status = "FAIL"; receipt.failure = { type: cleanupError?.name ?? "Error", message: receipt.workspaceCleanupFailure }; }
      }
    } else if (page && workspace && !receipt.workspaceDestroyed) {
      receipt.workspaceCleanupDeferredForServiceRecovery = true;
    }
    web?.close();
    const ownedDesktopChild = desktop.child;
    const ownedBrowserChild = page?.process;
    const processCleanup = await Promise.allSettled([desktop.stop(), page?.close()]);
    const processCleanupFailures = processCleanup.flatMap((result, index) => result.status === "rejected"
      ? [{ component: index === 0 ? "desktop" : "chromium", message: safeFailure(result.reason?.message ?? result.reason, replacements()) }]
      : []);
    if (ownedDesktopChild && ownedDesktopChild.exitCode === null && ownedDesktopChild.signalCode === null) {
      processCleanupFailures.push({ component: "desktop", message: "owned Desktop process exit was not confirmed" });
    }
    const browserExitVerified = !ownedBrowserChild || ownedBrowserChild.exitCode !== null || ownedBrowserChild.signalCode !== null;
    if (!browserExitVerified) processCleanupFailures.push({ component: "chromium", message: "owned Chromium process exit was not confirmed" });
    if (recovery) {
      try { await recovery.checkpoint({ browserExitVerified, browserClosedAtUtc: browserExitVerified ? new Date().toISOString() : null }); }
      catch (recoveryError) { processCleanupFailures.push({ component: "workspace-recovery", message: safeFailure(recoveryError?.message ?? recoveryError, replacements()) }); }
    }
    if (processCleanupFailures.length > 0) {
      receipt.processCleanupFailures = processCleanupFailures;
      if (!failure) {
        failure = processCleanup.find((result) => result.status === "rejected")?.reason
          ?? new Error(processCleanupFailures[0].message);
        receipt.status = "FAIL";
        receipt.failure = { type: failure?.name ?? "Error", message: processCleanupFailures[0].message };
      }
    }
    if (processCleanupFailures.length === 0 && (!recovery || receipt.workspaceDestroyed)) {
      try { receipt.localProfilesDisposed = await cleanupLocal(paths, options.keepProfiles); }
      catch (cleanupError) {
        const messageText = safeFailure(cleanupError?.message ?? cleanupError, replacements());
        if (!failure) { failure = cleanupError; receipt.status = "FAIL"; receipt.failure = { type: cleanupError?.name ?? "Error", message: messageText }; }
        else receipt.localCleanupFailure = messageText;
      }
    } else {
      if (processCleanupFailures.length > 0) receipt.localCleanupDeferredForProcessExit = true;
      if (recovery && !receipt.workspaceDestroyed) receipt.localCleanupDeferredForWorkspaceRecovery = true;
    }
    receipt.completedAt = new Date().toISOString();
    await writeReceipt(receiptPath, receipt);
    try {
      if (policy.serviceControl) await writeMarker(paths.controlRoot, options.controlNonce, candidateId, "driver-finished", receipt.status, true);
    } catch (markerError) {
      const messageText = safeFailure(markerError?.message ?? markerError, replacements());
      receipt.completionMarkerFailure = messageText;
      if (!failure) {
        failure = markerError;
        receipt.status = "FAIL";
        receipt.failure = { type: markerError?.name ?? "Error", message: messageText };
      }
      receipt.completedAt = new Date().toISOString();
      await writeReceipt(receiptPath, receipt);
    }
  }
  if (failure) {
    console.error(`[pq-desktop-web] FAIL: ${receipt.failure?.message ?? "see sanitized receipt"}`);
    console.error(`[pq-desktop-web] receipt: ${receiptPath}`);
    process.exitCode = 1;
  } else {
    if (policy.serviceControl) {
      console.log(`[pq-desktop-web] PASS: ${receipt.finalHistory.expected} exact deliveries across Desktop/Web, service outage and restart`);
    } else {
      console.log("[pq-desktop-web] PASS_EXPANDED_UI: fresh pair, manual PQ activation, expanded UI and cleanup");
    }
    console.log(`[pq-desktop-web] receipt: ${receiptPath}`);
  }
}

async function selfTest(options) {
  await selfTestPhaseIsolation();
  const secretUrl = `https://kaigen.test/#k=${"S".repeat(48)}`;
  const secretPassword = `Kw!${"P".repeat(32)}`;
  const sanitized = safeFailure(`failed ${secretUrl} ${secretPassword} ${"A".repeat(64)}`, [[secretUrl, "[redacted-workspace-url]"], [secretPassword, "[redacted-password]"]]);
  assert.equal(sanitized.includes(secretUrl) || sanitized.includes(secretPassword) || sanitized.includes("A".repeat(64)), false);
  assert.equal(isWithin(runsRoot, path.join(runsRoot, "pq-desktop-web-self-test")), true);
  assert.equal(isWithin(runsRoot, runsRoot), false);
  assert.equal(isWithin(runsRoot, path.resolve(runsRoot, "..", "escape")), false);
  const readyEnvelope = { schemaVersion: 2, status: "ready", package: { sha256: "B".repeat(64), releaseManifestSha256: "C".repeat(64) } };
  validateReadyEnvelope(readyEnvelope);
  assert.throws(() => validateReadyEnvelope({ ...readyEnvelope, schemaVersion: 1 }), /schema-v2 READY/u);
  assert.throws(() => validateReadyEnvelope({ ...readyEnvelope, package: { ...readyEnvelope.package, releaseManifestSha256: "c".repeat(64) } }), /release manifest/u);
  assert.deepEqual(staticModuleSpecifiers('import assert from "node:assert/strict";\nimport { runSettings } from "./settings-ui.mjs";\nimport { runFormattingUi } from "./formatting-ui.mjs";\nexport async function runExpandedWebUi() {}\n', "synthetic UI entry"), ["node:assert/strict", "./settings-ui.mjs", "./formatting-ui.mjs"]);
  assert.throws(() => staticModuleSpecifiers('export async function run() { return import("./extra.mjs"); }', "synthetic UI entry"), /unbound module loader/u);
  assert.throws(() => validateOptions({ ...parseArguments([]), origin: "https://example.invalid", artifactRoot: "x", desktopExeSha256: "A".repeat(64), candidateContract: "x", candidateContractSha256: "B".repeat(64), webReadyReceipt: "x", webReadyReceiptSha256: "C".repeat(64), browserDriver: "x", browserDriverSha256: "D".repeat(64), uiDriverManifest: "x", uiDriverManifestSha256: "F".repeat(64), chromium: "x", chromiumSha256: "E".repeat(64), tlsSpki: `${"A".repeat(43)}=`, resolveHost: "192.168.192.128", controlNonce: "a".repeat(32) }), /origin/u);
  const base = parseArguments([
    "--artifact-root", "x", "--desktop-exe-sha256", "A".repeat(64),
    "--candidate-contract", "x", "--candidate-contract-sha256", "B".repeat(64),
    "--web-ready-receipt", "x", "--web-ready-receipt-sha256", "C".repeat(64),
    "--browser-driver", "x", "--browser-driver-sha256", "D".repeat(64),
    "--ui-driver-manifest", "x", "--ui-driver-manifest-sha256", "F".repeat(64),
    "--chromium", "x", "--chromium-sha256", "E".repeat(64),
    "--tls-spki", `${"A".repeat(43)}=`, "--resolve-host", "192.168.192.128",
    "--control-nonce", "a".repeat(32),
  ]);
  validateOptions(base);
  assert.deepEqual(Object.keys(markerBody("a".repeat(32), "candidate-id", "ready-for-web-stop", "READY")), ["schemaVersion", "nonce", "candidateId", "phase", "status"]);
  assert.deepEqual(markerBody("a".repeat(32), "candidate-id", "driver-abort", "FAIL"), { schemaVersion: 1, nonce: "a".repeat(32), candidateId: "candidate-id", phase: "driver-abort", status: "FAIL" });
  const fakeReady = path.join(runsRoot, "lab", "artifacts", "candidate-id", "web", "attempts", "attempt-1", "ready.json");
  assert.equal(controlRootFromReadyPath(fakeReady, "candidate-id", "a".repeat(32)), path.join(runsRoot, "lab", "artifacts", "candidate-id", "web", "interop", "a".repeat(32)));
  assert.throws(() => controlRootFromReadyPath(fakeReady, "different-candidate", "a".repeat(32)), /candidate ID/u);
  const ownerInputs = {
    candidate: { value: { buildId: "candidate-id" } },
    ready: { sha256: "F".repeat(64), value: { package: { testedActiveSlot: "b", baselineTarget: "releases/baseline-id", releaseManifestSha256: "E".repeat(64) } } },
  };
  const ownerStart = {
    schemaVersion: 1, status: "PASS", nonce: "a".repeat(32), candidateId: "candidate-id", action: "start",
    vmState: "running", routeState: "candidate-active", activeSlot: "b", currentTarget: "releases/candidate-id",
    previousTarget: "releases/baseline-id", serviceState: "active", serviceEnabled: "enabled",
    releaseManifestSha256: "E".repeat(64), publicBuildId: "candidate-id", readyReceiptSha256: "F".repeat(64),
    recovery: false, productionContacted: false, secretsIncluded: false,
  };
  validateOwnerReceipt(ownerStart, ownerInputs, "a".repeat(32), "start", false);
  const compactOwnerStart = `${JSON.stringify(ownerStart)}\n`;
  validateOwnerReceiptBytes(compactOwnerStart, ownerStart, "start");
  for (const invalidBytes of [canonicalJsonBytes(ownerStart), compactOwnerStart.replace(/\n$/u, "\r\n"), compactOwnerStart.trimEnd(), `${compactOwnerStart}\n`, `\ufeff${compactOwnerStart}`]) {
    assert.throws(() => validateOwnerReceiptBytes(invalidBytes, ownerStart, "start"), /receipt bytes are not canonical/u);
  }
  assert.throws(() => validateOwnerReceipt({ ...ownerStart, releaseManifestSha256: "D".repeat(64) }, ownerInputs, "a".repeat(32), "start", false), /exact READY candidate/u);
  assert.throws(() => validateOwnerReceipt({ ...ownerStart, secretsIncluded: true }, ownerInputs, "a".repeat(32), "start", false), /privacy boundary/u);
  const uiChecks = Object.fromEntries(EXPANDED_UI_CHECK_KEYS.map((name) => [name, name === "unreadBatchCount" ? 24 : name === "walletCopyCount" ? 5 : true]));
  const formattingChecks = Object.fromEntries(FORMATTING_UI_CHECK_KEYS.map((name) => [name, true]));
  const formattingResult = {
    schemaVersion: 1, status: "PASS", checks: formattingChecks,
    gestures: { rightClick: "pass", keyboard: "pass", escape: "pass", macCtrlClick: "deferred-to-real-macos", actualPlatform: "win32" },
    messages: { count: 2, formattedSha256: "A".repeat(64), plainAfterRemovalSha256: "B".repeat(64), formattedSpanCount: 4, plainSpanCount: 0 },
    screenshots: [...FORMATTING_SCREENSHOTS],
  };
  const uiScreenshotNames = [
    ...Array.from({ length: 12 }, (_, index) => `expanded-ui-${String(index + 1).padStart(2, "0")}.png`),
    ...FORMATTING_SCREENSHOTS,
  ];
  const uiResult = {
    schemaVersion: 1, status: "PASS", candidateId: "candidate-id", checks: uiChecks,
    formatting: formattingResult,
    screenshots: uiScreenshotNames.map((name) => ({ name, sha256: "E".repeat(64) })),
    diagnostics: { consoleErrors: 0, pageErrors: 0, unexpectedHttpErrors: 0, networkFailures: 0 },
  };
  validateExpandedUiResult(uiResult, "candidate-id");
  assert.throws(() => validateExpandedUiResult({ ...uiResult, checks: { ...uiChecks, themePersisted: false } }, "candidate-id"), /themePersisted/u);
  assert.equal(WEB_COMMANDS.has("send_tox_message"), true);
  assert.equal(WEB_COMMANDS.has("accept_pq_session"), true);
  assert.equal(WEB_COMMANDS.has("get_chat_capabilities"), true);
  assert.equal(WEB_COMMANDS.has("destroy_workspace"), false);
  assert.equal(typeof KaigenProcess, "function", "native harness import had no exported process helper");
  assert.equal(new NativeCommandError("send_tox_message", "PQ_SESSION_WAIT").code, "PQ_SESSION_WAIT", "shared retry error contract was unavailable");
  const requestedBrowserDriver = process.argv.includes("--browser-driver");
  if (requestedBrowserDriver) {
    check(HEX64.test(options.browserDriverSha256), "browser driver self-test requires an uppercase expected SHA-256");
    const binding = await ordinaryFile(path.resolve(options.browserDriver), options.browserDriverSha256, "browser driver self-test input");
    const imported = await import(pathToFileURL(binding.path).href);
    assert.equal(typeof imported.ChromiumPage, "function", "browser driver import did not expose ChromiumPage");
  }
  const requestedUiDriver = process.argv.includes("--ui-driver-manifest");
  if (requestedUiDriver) {
    check(HEX64.test(options.uiDriverManifestSha256), "expanded UI driver manifest self-test requires an uppercase expected SHA-256");
    const { uiDriver } = await bindUiDriverManifest(options.uiDriverManifest, options.uiDriverManifestSha256);
    const imported = await import(pathToFileURL(uiDriver.path).href);
    assert.deepEqual(Object.keys(imported), ["runExpandedWebUi"], "expanded UI driver self-test found an invalid export surface");
  }
  console.log("PQ Desktop-Web harness self-test passed (CLI, URL/path/hash/pin, marker, command allowlist, redaction, side-effect-free native helper import).\n");
}

export {
  bindInputs,
  validateExpandedUiResult,
  launchBrowser,
  WebCommandClient,
  readWebIdentity,
  createWorkspaceAndProfile,
  createOwnedWorkspaceRecovery,
  reopenWorkspace,
  openWorkspaceCleanupMenu,
  friendFor,
};

const invokedDirectly = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) console.log(usage());
  else if (options.selfTest) await selfTest(options);
  else await run(options);
}
