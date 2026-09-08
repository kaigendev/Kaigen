import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  access,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  publicKeyFromToxId,
  sanitizeDiagnostic,
  sha256File,
  waitUntil,
} from "./test-pq-two-instances.mjs";

const HEX40_LOWER = /^[0-9a-f]{40}$/u;
const HEX64 = /^[0-9A-F]{64}$/u;
const SAFE_BUILD_ID = /^[a-z0-9][a-z0-9._-]{7,127}$/u;
const SAFE_RUN_ID = /^[a-z0-9][a-z0-9-]{7,63}$/u;
const SAFE_INSTANCE_TOKEN = /^[0-9a-f]{32}$/u;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const QTOX_FIXTURE_SHA256 = "90615F51EEB1FBAAB29743348E18EF54820DD7BB4914661A0EABA94A40C69C5E";
const QTOX_INSTALLER_SHA256 = "D947E5CC1042B2AD72600A1E2B9952D1E5B0691930D619F4347DBB1085D76F09";
const QTOX_VERSION = "1.18.5";
const QTOX_PLATFORM = "windows-x86_64";
const QTOX_PORTABLE_INI = "[Advanced]\nmakeToxPortable=true\n";
const FIXTURE_BYTES = 64 * 1024;
const FIRST_SEND_MAX_MS = 5_000;
const ALLOWED_TARGETS = new Set(["desktop", "web"]);
const SCREENSHOT_NAMES = Object.freeze([
  "01-qtox-initial-chat.png",
  "02-kaigen-no-formatting.png",
  "03-kaigen-legacy-chat.png",
  "04-qtox-post-restart.png",
]);
const EXPECTED_CAPABILITIES = Object.freeze({
  protocolVersion: null,
  stableMessageIds: false,
  reactions: false,
  quotes: false,
  formatting: false,
});
const EXPECTED_UNAVAILABLE_PQ = Object.freeze({
  supported: false,
  state: "unavailable",
  identity_waiting: false,
  auto_pending: false,
  protocol_version: 2,
  peer_fingerprint: null,
  error: null,
});
const RECEIPT_CHECKS = Object.freeze([
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
const PIN_PATH = fileURLToPath(new URL("./fixtures/qtox-v1.18.5-windows.json", import.meta.url));
const RUNS_ROOT = fileURLToPath(new URL(
  "../../local-data/compatibility-runs/qtox/",
  import.meta.url,
));

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function canonicalJsonBytes(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

function sha256Text(value) {
  return sha256Bytes(Buffer.from(value, "utf8"));
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function requireWithin(parent, candidate, label) {
  check(isWithin(path.resolve(parent), path.resolve(candidate)), `${label} escaped its owned root`);
}

async function ordinaryFile(file, label, minimumBytes = 1) {
  const resolved = path.resolve(file);
  const info = await lstat(resolved);
  check(info.isFile() && !info.isSymbolicLink(), `${label} is not an ordinary file`);
  check(await realpath(resolved) === resolved, `${label} is not canonical`);
  check(info.size >= minimumBytes, `${label} is unexpectedly small`);
  return { path: resolved, bytes: info.size, mtimeMs: info.mtimeMs };
}

async function ordinaryDirectory(directory, label) {
  const resolved = path.resolve(directory);
  const info = await lstat(resolved);
  check(info.isDirectory() && !info.isSymbolicLink(), `${label} is not an ordinary directory`);
  check(await realpath(resolved) === resolved, `${label} is not canonical`);
  return resolved;
}

function validateIdentity(target, identity) {
  check(identity && typeof identity === "object" && !Array.isArray(identity), "qTox interop build identity is unavailable");
  assert.deepEqual(Object.keys(identity), ["kaigenCommit", "sourceTree", "buildId", "artifactKind", "artifactSha256"]);
  check(HEX40_LOWER.test(identity.kaigenCommit), "qTox interop commit identity is invalid");
  check(HEX40_LOWER.test(identity.sourceTree), "qTox interop source-tree identity is invalid");
  check(SAFE_BUILD_ID.test(identity.buildId), "qTox interop build ID is invalid");
  check(identity.artifactKind === (target === "desktop" ? "windows-portable" : "web-lab-package"), "qTox interop artifact kind is invalid");
  check(HEX64.test(identity.artifactSha256), "qTox interop artifact hash is invalid");
}

function validateAdapter(adapter) {
  check(adapter && typeof adapter === "object" && !Array.isArray(adapter), "qTox interop Kaigen adapter is unavailable");
  for (const name of ["start", "invoke", "restart", "sendFile", "readReceivedFile", "instanceToken"]) {
    check(typeof adapter[name] === "function", `qTox interop Kaigen adapter ${name} is unavailable`);
  }
  const ui = adapter.ui;
  check(ui && typeof ui === "object" && !Array.isArray(ui), "qTox interop Kaigen UI adapter is unavailable");
  for (const name of ["evaluate", "setValue", "setSelection", "contextClick", "keyPress", "waitFor", "capture", "ensureChat"]) {
    check(typeof ui[name] === "function", `qTox interop Kaigen UI adapter ${name} is unavailable`);
  }
}

async function validatePin() {
  const binding = await ordinaryFile(PIN_PATH, "qTox release fixture", 256);
  check(await sha256File(binding.path) === QTOX_FIXTURE_SHA256, "qTox release fixture hash changed");
  const value = JSON.parse(await readFile(binding.path, "utf8"));
  assert.deepEqual(Object.keys(value), [
    "schemaVersion", "scope", "name", "version", "platform", "releaseUrl", "releaseId", "assetId",
    "fileName", "url", "bytes", "sha256", "digestSource", "archiveFormat", "bundledInKaigen", "networkFallbackAllowed",
  ]);
  check(value.schemaVersion === 1 && value.scope === "release-compatibility-test-only", "qTox release fixture contract changed");
  check(value.name === "qTox" && value.version === QTOX_VERSION && value.platform === QTOX_PLATFORM, "qTox release fixture identity changed");
  check(value.sha256 === QTOX_INSTALLER_SHA256 && value.archiveFormat === "NSIS", "qTox release fixture artifact changed");
  check(value.bundledInKaigen === false && value.networkFallbackAllowed === false, "qTox release fixture boundary changed");
  return value;
}

function projectPqStatus(status) {
  const projected = {
    supported: status?.supported === true,
    state: typeof status?.state === "string" ? status.state : "missing",
    identity_waiting: status?.identity_waiting === true,
    auto_pending: status?.auto_pending === true,
    protocol_version: Number(status?.protocol_version ?? 0),
    peer_fingerprint: status?.peer_fingerprint == null || status.peer_fingerprint === "" ? null : "present",
    error: status?.error == null || status.error === "" ? null : sanitizeDiagnostic(String(status.error)),
  };
  return projected;
}

function assertUnavailablePq(status, label) {
  const projected = projectPqStatus(status);
  assert.deepEqual(projected, EXPECTED_UNAVAILABLE_PQ, `${label} selected an unexpected PQ state`);
  return projected;
}

function assertCapabilities(value, label) {
  assert.deepEqual(value, EXPECTED_CAPABILITIES, `${label} advertised Kaigen-only chat capabilities to qTox`);
  return { ...EXPECTED_CAPABILITIES };
}

function adapterInstanceToken(adapter, label) {
  return Promise.resolve(adapter.instanceToken()).then((value) => {
    check(typeof value === "string" && SAFE_INSTANCE_TOKEN.test(value), `${label} instance token is invalid`);
    return value;
  });
}

function normalizeBytes(value, label) {
  check(value instanceof Uint8Array || Buffer.isBuffer(value), `${label} did not return bytes`);
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

function normalizeTextValue(value, label) {
  if (typeof value === "string") return value.replaceAll("\0", "");
  const bytes = normalizeBytes(value, label);
  return bytes.toString("utf8").replaceAll("\0", "");
}

function normalizeKey(value, label) {
  const bytes = normalizeBytes(value, label);
  check(bytes.length === 32, `${label} did not contain a 32-byte public key`);
  return bytes.toString("hex").toUpperCase();
}

function parseLegacyQuote(value) {
  const normalized = value.replace(/\r\n?/gu, "\n");
  const lines = normalized.split("\n");
  const quoted = lines.findIndex((line) => !line.startsWith("> "));
  if (quoted <= 0 || quoted >= lines.length) return null;
  const body = lines.slice(quoted).join("\n");
  if (!body.trim()) return null;
  return {
    quoteText: lines.slice(0, quoted).map((line) => line.slice(2)).join("\n"),
    body,
  };
}

function messageSemantic(direction, kind, body, quoteText = null) {
  return {
    direction,
    kind,
    bodySha256: sha256Text(body),
    quoteTextSha256: quoteText === null ? null : sha256Text(quoteText),
  };
}

function semanticHash(rows) {
  return sha256Text(JSON.stringify(rows));
}

function messageRows(history) {
  check(Array.isArray(history), "Kaigen returned an invalid qTox chat history");
  return history.filter((row) => !row?.event && !row?.attachment);
}

function fileRows(history) {
  check(Array.isArray(history), "Kaigen returned an invalid qTox chat history");
  return history.filter((row) => !row?.event && row?.attachment);
}

function rowsWithText(history, text, mine) {
  return messageRows(history).filter((row) => row.text === text && row.mine === mine);
}

function assertPlainProtocolRow(row, label) {
  check(row && typeof row === "object", `${label} row is unavailable`);
  check(row.protocol_version == null, `${label} unexpectedly used the Kaigen chat protocol`);
  check(row.pq_protected === false, `${label} unexpectedly used PQ protection`);
  check(row.formatting == null || Array.isArray(row.formatting) && row.formatting.length === 0, `${label} unexpectedly carried formatting spans`);
}

function assertLegacyQuoteRow(row, expectedQuote, label) {
  const quote = row?.quote;
  check(quote && typeof quote === "object" && !Array.isArray(quote), `${label} did not expose parsed quote metadata`);
  check(quote.messageId == null, `${label} fabricated a legacy message ID`);
  check(quote.author === "", `${label} fabricated a legacy quote author`);
  check(quote.text === expectedQuote && quote.legacy === true, `${label} changed the legacy quote body`);
}

async function historyFor(adapter, friendNumber) {
  const rows = await adapter.invoke("get_tox_messages", { profileId: null, friendNumber, limit: 1_000 });
  check(Array.isArray(rows), "Kaigen returned an invalid qTox chat history");
  return rows;
}

async function friendFor(adapter, publicKey) {
  const friends = await adapter.invoke("get_tox_friends");
  check(Array.isArray(friends), "Kaigen returned an invalid qTox friend list");
  return friends.find((friend) => friend?.public_key === publicKey);
}

async function waitFriendOnline(adapter, publicKey, timeoutMs, label) {
  return waitUntil(async () => {
    const friend = await friendFor(adapter, publicKey);
    if (!friend || friend.authorized !== true || friend.connection !== "online") return undefined;
    check(Number.isInteger(friend.number) && friend.number >= 0, `${label} friend number is invalid`);
    return friend;
  }, timeoutMs, label, 200);
}

async function waitExactTextRow(adapter, friendNumber, text, mine, timeoutMs, label, predicate = () => true) {
  return waitUntil(async () => {
    const matches = rowsWithText(await historyFor(adapter, friendNumber), text, mine);
    check(matches.length <= 1, `${label} appeared more than once in Kaigen history`);
    return matches.length === 1 && predicate(matches[0]) ? matches[0] : undefined;
  }, timeoutMs, label, 150);
}

async function waitExactFileRow(adapter, friendNumber, name, mine, timeoutMs, label, requireComplete = true) {
  return waitUntil(async () => {
    const matches = fileRows(await historyFor(adapter, friendNumber))
      .filter((row) => row.mine === mine && row.attachment?.name === name);
    check(matches.length <= 1, `${label} appeared more than once in Kaigen history`);
    if (matches.length !== 1) return undefined;
    const attachment = matches[0].attachment;
    const complete = attachment.completed === true
      && attachment.transfer_state === "complete"
      && attachment.size === FIXTURE_BYTES
      && attachment.transferred === FIXTURE_BYTES;
    return !requireComplete || complete ? matches[0] : undefined;
  }, timeoutMs, label, 200);
}

async function sendPlainOnce(adapter, friendNumber, text, quote) {
  const result = await adapter.invoke("send_tox_message", {
    profileId: null,
    friendNumber,
    text,
    operationId: randomUUID(),
    quote,
    formatting: [],
  });
  check(result && typeof result.messageId === "string" && result.messageId.length > 0, "Kaigen returned an invalid qTox send result");
  check(result.delivery !== "failed", "Kaigen returned a terminal qTox send failure");
  return result;
}

async function validatePng(file, label) {
  const binding = await ordinaryFile(file, label, 1_024);
  const bytes = await readFile(binding.path);
  check(bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE), `${label} is not a PNG`);
  return { name: path.basename(binding.path), sha256: sha256Bytes(bytes) };
}

async function readQtoxDatabase(historyPath) {
  const binding = await ordinaryFile(historyPath, "qTox history database", 512);
  const header = Buffer.alloc(16);
  const source = await readFile(binding.path);
  source.copy(header, 0, 0, 16);
  check(header.equals(Buffer.from("SQLite format 3\0", "binary")), "qTox passwordless history is not a plain SQLite database");
  const walPath = `${binding.path}-wal`;
  const walSize = await stat(walPath).then((value) => value.size).catch((error) => {
    if (error?.code === "ENOENT") return 0;
    throw error;
  });
  check(walSize === 0, "qTox history still has an uncheckpointed WAL; stop qTox cleanly before finalization");

  const database = new DatabaseSync(binding.path, { readOnly: true, allowExtension: false });
  try {
    database.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;");
    const integrity = database.prepare("PRAGMA quick_check;").all();
    check(integrity.length === 1 && integrity[0]?.quick_check === "ok", "qTox history failed SQLite quick_check");
    const required = {
      history: ["id", "message_type", "timestamp", "chat_id"],
      chats: ["id", "uuid"],
      text_messages: ["id", "sender_alias", "message"],
      file_transfers: ["id", "sender_alias", "file_name", "file_path", "file_size", "direction", "file_state"],
      aliases: ["id", "owner"],
      authors: ["id", "public_key"],
      faux_offline_pending: ["id", "required_extensions"],
      broken_messages: ["id", "reason"],
    };
    for (const [table, columns] of Object.entries(required)) {
      const found = database.prepare(`PRAGMA table_info(${table});`).all().map((row) => row.name);
      for (const column of columns) check(found.includes(column), `qTox history schema lacks ${table}.${column}`);
    }
    const rows = database.prepare(`
      SELECT history.id AS source_id,
             history.timestamp AS timestamp_ms,
             history.message_type AS message_type,
             chats.uuid AS chat_key,
             authors.public_key AS sender_key,
             text_messages.message AS message,
             file_transfers.file_name AS file_name,
             file_transfers.file_path AS file_path,
             file_transfers.file_size AS file_size,
             file_transfers.direction AS direction,
             file_transfers.file_state AS file_state
      FROM history
      JOIN chats ON history.chat_id=chats.id
      LEFT JOIN text_messages ON history.id=text_messages.id
      LEFT JOIN file_transfers ON history.id=file_transfers.id
      LEFT JOIN aliases ON text_messages.sender_alias=aliases.id OR file_transfers.sender_alias=aliases.id
      LEFT JOIN authors ON aliases.owner=authors.id
      WHERE history.message_type IN ('T','F')
      ORDER BY history.timestamp, history.id;
    `).all();
    const pendingCount = Number(database.prepare("SELECT COUNT(*) AS count FROM faux_offline_pending;").get()?.count);
    const brokenCount = Number(database.prepare("SELECT COUNT(*) AS count FROM broken_messages;").get()?.count);
    check(Number.isSafeInteger(pendingCount) && Number.isSafeInteger(brokenCount), "qTox pending/broken row counts are invalid");
    return { rows, pendingCount, brokenCount };
  } finally {
    database.close();
  }
}

function validateReceipt(receipt) {
  assert.deepEqual(Object.keys(receipt), ["schemaVersion", "status", "scope", "target", "identity", "environment", "checks", "evidence"]);
  check(receipt.schemaVersion === 1 && receipt.status === "PASS" && receipt.scope === "qtox-interop", "qTox interop receipt header is invalid");
  check(ALLOWED_TARGETS.has(receipt.target), "qTox interop receipt target is invalid");
  assert.deepEqual(Object.keys(receipt.identity), [
    "kaigenCommit", "sourceTree", "buildId", "artifactKind", "artifactSha256", "qtoxFixtureSha256",
    "qtoxVersion", "qtoxPlatform", "qtoxInstallerSha256",
  ]);
  validateIdentity(receipt.target, {
    kaigenCommit: receipt.identity.kaigenCommit,
    sourceTree: receipt.identity.sourceTree,
    buildId: receipt.identity.buildId,
    artifactKind: receipt.identity.artifactKind,
    artifactSha256: receipt.identity.artifactSha256,
  });
  check(receipt.identity.qtoxFixtureSha256 === QTOX_FIXTURE_SHA256
    && receipt.identity.qtoxVersion === QTOX_VERSION
    && receipt.identity.qtoxPlatform === QTOX_PLATFORM
    && receipt.identity.qtoxInstallerSha256 === QTOX_INSTALLER_SHA256, "qTox interop receipt fixture identity is invalid");
  assert.deepEqual(Object.keys(receipt.environment), ["syntheticOnly", "launcher", "productionContacted", "secretsIncluded"]);
  assert.deepEqual(Object.keys(receipt.environment.launcher), [
    "instanceToken", "programDirectoryCopied", "portableSidecarPrecreated", "disposableProfileRoot",
    "immutableRuntimeLaunched", "sidecarSha256", "runtimeManifestSha256", "executableSha256",
  ]);
  check(SAFE_INSTANCE_TOKEN.test(receipt.environment.launcher.instanceToken), "qTox launcher instance token is invalid");
  assert.deepEqual(receipt.environment, {
    syntheticOnly: true,
    launcher: {
      instanceToken: receipt.environment.launcher.instanceToken,
      programDirectoryCopied: true,
      portableSidecarPrecreated: true,
      disposableProfileRoot: true,
      immutableRuntimeLaunched: false,
      sidecarSha256: "0D7433A2D651CD582BA1B9E4CA6DAEFFD8421DAB8C154BAD7638BDF46784AB83",
      runtimeManifestSha256: receipt.environment.launcher.runtimeManifestSha256,
      executableSha256: receipt.environment.launcher.executableSha256,
    },
    productionContacted: false,
    secretsIncluded: false,
  });
  check(HEX64.test(receipt.environment.launcher.runtimeManifestSha256)
    && HEX64.test(receipt.environment.launcher.executableSha256), "qTox launcher artifact hashes are invalid");
  assert.deepEqual(Object.keys(receipt.checks), RECEIPT_CHECKS);
  check(Object.values(receipt.checks).every((value) => value === true), "qTox interop receipt contains an incomplete check");
  assert.deepEqual(Object.keys(receipt.evidence), ["friendship", "messages", "files", "quotes", "compatibility", "reconnect", "screenshots"]);
  assert.deepEqual(Object.keys(receipt.evidence.friendship), ["qtoxPublicKeyMatched", "kaigenPublicKeyMatched", "onlineBeforeTraffic"]);
  assert.deepEqual(Object.keys(receipt.evidence.messages), [
    "count", "directions", "kaigenRows", "qtoxRows", "expectedTranscriptSha256", "kaigenTranscriptSha256",
    "qtoxTranscriptSha256", "exactPlaintext", "exactOnce", "unexpectedRows", "controlTextLeaks",
  ]);
  assert.deepEqual(Object.keys(receipt.evidence.files), [
    "directions", "count", "fixtureSha256", "qtoxReceivedSha256", "kaigenReceivedSha256", "exactBytes",
    "outsideRoots", "orphanPending",
  ]);
  assert.deepEqual(Object.keys(receipt.evidence.quotes), [
    "directions", "count", "expectedTranscriptSha256", "kaigenTranscriptSha256", "qtoxTranscriptSha256",
    "legacyPrefixExact", "legacyAuthorEmpty", "structuredQuoteWireUsed",
  ]);
  assert.deepEqual(Object.keys(receipt.evidence.compatibility), [
    "chatCapabilities", "pqPre", "pqAfterFirstSend", "pqAfterReconnect", "pqPromptVisible",
    "formattingGroupVisible", "entropyPanelVisible", "protocolRowsPlain", "formattingSpansSent", "qtoxVisibleControlTextLeaks",
  ]);
  assert.deepEqual(Object.keys(receipt.evidence.reconnect), [
    "qtoxRestarted", "kaigenRestarted", "friendReboundByPublicKey", "onlineRestored", "historyPersisted", "postRestartDirections",
  ]);
  check(receipt.evidence.messages.count === 6 && receipt.evidence.messages.directions === 2, "qTox interop message coverage is invalid");
  check(receipt.evidence.messages.kaigenRows === 6 && receipt.evidence.messages.qtoxRows === 6, "qTox interop message row coverage is invalid");
  check(receipt.evidence.messages.exactPlaintext === true && receipt.evidence.messages.exactOnce === true
    && receipt.evidence.messages.unexpectedRows === 0 && receipt.evidence.messages.controlTextLeaks === 0, "qTox interop contains unexpected text rows");
  check(receipt.evidence.files.directions === 2 && receipt.evidence.files.count === 2 && receipt.evidence.files.orphanPending === 0, "qTox interop file coverage is invalid");
  check(receipt.evidence.quotes.directions === 2 && receipt.evidence.quotes.count === 2, "qTox interop quote coverage is invalid");
  const messageHashes = [receipt.evidence.messages.expectedTranscriptSha256, receipt.evidence.messages.kaigenTranscriptSha256, receipt.evidence.messages.qtoxTranscriptSha256];
  check(messageHashes.every((value) => HEX64.test(value)) && new Set(messageHashes).size === 1, "qTox interop message transcript hashes differ");
  const quoteHashes = [receipt.evidence.quotes.expectedTranscriptSha256, receipt.evidence.quotes.kaigenTranscriptSha256, receipt.evidence.quotes.qtoxTranscriptSha256];
  check(quoteHashes.every((value) => HEX64.test(value)) && new Set(quoteHashes).size === 1, "qTox interop quote transcript hashes differ");
  check(receipt.evidence.files.fixtureSha256 === receipt.evidence.files.qtoxReceivedSha256
    && receipt.evidence.files.fixtureSha256 === receipt.evidence.files.kaigenReceivedSha256
    && HEX64.test(receipt.evidence.files.fixtureSha256), "qTox interop file hashes differ");
  assert.deepEqual(receipt.evidence.compatibility.chatCapabilities, EXPECTED_CAPABILITIES);
  assert.deepEqual(receipt.evidence.compatibility.pqPre, EXPECTED_UNAVAILABLE_PQ);
  assert.deepEqual(receipt.evidence.compatibility.pqAfterFirstSend, EXPECTED_UNAVAILABLE_PQ);
  assert.deepEqual(receipt.evidence.compatibility.pqAfterReconnect, EXPECTED_UNAVAILABLE_PQ);
  check(receipt.evidence.compatibility.pqPromptVisible === false
    && receipt.evidence.compatibility.formattingGroupVisible === false
    && receipt.evidence.compatibility.entropyPanelVisible === false
    && receipt.evidence.compatibility.protocolRowsPlain === true
    && receipt.evidence.compatibility.formattingSpansSent === 0
    && receipt.evidence.compatibility.qtoxVisibleControlTextLeaks === 0, "qTox interop compatibility evidence is invalid");
  check(receipt.evidence.quotes.legacyPrefixExact === true
    && receipt.evidence.quotes.legacyAuthorEmpty === true
    && receipt.evidence.quotes.structuredQuoteWireUsed === false, "qTox interop quote compatibility evidence is invalid");
  check(receipt.evidence.files.exactBytes === true && receipt.evidence.files.outsideRoots === false, "qTox interop file boundary evidence is invalid");
  check(Object.values(receipt.evidence.friendship).every((value) => value === true), "qTox interop friendship evidence is invalid");
  check(Object.entries(receipt.evidence.reconnect).every(([key, value]) => key === "postRestartDirections" ? value === 2 : value === true), "qTox interop reconnect evidence is invalid");
  check(Array.isArray(receipt.evidence.screenshots) && receipt.evidence.screenshots.length === SCREENSHOT_NAMES.length, "qTox interop screenshot coverage is invalid");
  assert.deepEqual(receipt.evidence.screenshots.map((entry) => entry.name), SCREENSHOT_NAMES);
  for (const screenshot of receipt.evidence.screenshots) assert.deepEqual(Object.keys(screenshot), ["name", "sha256"]);
  check(receipt.evidence.screenshots.every((entry) => HEX64.test(entry.sha256)), "qTox interop screenshot hash is invalid");
  return receipt;
}

class QtoxInteropSession {
  constructor(config, paths, pin, fixture) {
    this.target = config.target;
    this.identity = { ...config.identity };
    this.runId = config.runId;
    this.timeoutMs = config.timeoutMs;
    this.adapter = config.kaigen;
    this.paths = paths;
    this.pin = pin;
    this.fixture = fixture;
    this.stage = "prepared";
    this.qtox = null;
    this.kaigenToxId = null;
    this.kaigenPublicKey = null;
    this.qtoxPublicKey = null;
    this.friendNumber = null;
    this.originalFileSettings = null;
    this.fileSettingsChanged = false;
    this.kaigenInstanceBefore = null;
    this.kaigenInstanceAfter = null;
    this.qtoxInstanceBefore = null;
    this.qtoxInstanceAfter = null;
    this.qtoxLauncher = null;
    this.compatibility = null;
  }

  actionPlan() {
    return Object.freeze({
      qtoxProgramRoot: this.paths.qtoxProgramRoot,
      qtoxProfileRoot: this.paths.qtoxProfileRoot,
      qtoxDownloadRoot: this.paths.qtoxDownloadRoot,
      qtoxPortableIniPath: path.join(this.paths.qtoxProgramRoot, "qtox.ini"),
      qtoxPortableIniBytes: QTOX_PORTABLE_INI,
      qtoxPortableIniSha256: sha256Text(QTOX_PORTABLE_INI),
      kaigenProfileRoot: this.paths.kaigenProfileRoot,
      kaigenReceiveRoot: this.paths.kaigenReceiveRoot,
      qtoxProfileName: `Kaigen qTox ${this.target} ${this.fixture.caseToken}`,
      kaigenToQtoxText: this.fixture.kaigenToQtoxText,
      qtoxToKaigenText: this.fixture.qtoxToKaigenText,
      qtoxQuoteBody: this.fixture.qtoxQuoteBody,
      kaigenQuoteBody: this.fixture.kaigenQuoteBody,
      kaigenPostRestartText: this.fixture.kaigenPostRestartText,
      qtoxPostRestartText: this.fixture.qtoxPostRestartText,
      qtoxOutboundFile: this.fixture.qtoxOutboundPath,
      qtoxOutboundFileName: this.fixture.qtoxOutboundName,
      kaigenOutboundFileName: this.fixture.kaigenOutboundName,
    });
  }

  getLaunchPlan() {
    check(this.stage === "prepared", "qTox launch plan is available only before profile binding");
    return this.actionPlan();
  }

  async runPhase(name, expectedStage, nextStage, operation) {
    check(this.stage === expectedStage, `${name} expected ${expectedStage}, found ${this.stage}`);
    try {
      const result = await operation();
      this.stage = nextStage;
      return result;
    } catch (error) {
      this.stage = "failed";
      await this.writeFailure(name, error).catch(() => {});
      throw error;
    }
  }

  async writeFailure(phase, error) {
    const replacements = [
      this.paths.runRoot,
      this.kaigenToxId,
      this.qtox?.toxId,
      this.kaigenPublicKey,
      this.qtoxPublicKey,
      ...Object.values(this.fixture).filter((value) => typeof value === "string"),
    ].filter(Boolean);
    let message = sanitizeDiagnostic(error instanceof Error ? error.message : String(error));
    for (const replacement of replacements) message = message.replaceAll(replacement, "<synthetic>");
    const value = {
      schemaVersion: 1,
      status: "FAIL",
      scope: "qtox-interop",
      target: this.target,
      phase,
      message: message.slice(0, 240),
      productionContacted: false,
      secretsIncluded: false,
    };
    const file = path.join(this.paths.evidenceRoot, "qtox-interop-failure.json");
    await writeFile(file, canonicalJsonBytes(value), { encoding: "utf8", flag: "wx" });
  }

  async bindQtox(binding) {
    return this.runPhase("bindQtox", "prepared", "bound", async () => {
      check(binding && typeof binding === "object" && !Array.isArray(binding), "qTox binding is unavailable");
      assert.deepEqual(Object.keys(binding), [
        "toxId", "profilePath", "historyPath", "instanceToken", "executablePath", "runtimeManifestPath",
      ]);
      const { toxId, profilePath, historyPath, instanceToken, executablePath, runtimeManifestPath } = binding;
      check(typeof toxId === "string", "qTox UI did not provide a Tox ID");
      const qtoxPublicKey = publicKeyFromToxId(toxId, "qTox UI");
      check(typeof instanceToken === "string" && SAFE_INSTANCE_TOKEN.test(instanceToken), "qTox UI instance token is invalid");
      const profile = await ordinaryFile(profilePath, "new qTox profile", 128);
      const history = await ordinaryFile(historyPath, "new qTox history", 512);
      requireWithin(this.paths.qtoxProfileRoot, profile.path, "qTox profile");
      requireWithin(this.paths.qtoxProfileRoot, history.path, "qTox history");
      check(path.extname(profile.path).toLowerCase() === ".tox", "qTox profile extension is invalid");
      check(path.extname(history.path).toLowerCase() === ".db", "qTox history extension is invalid");
      check(path.basename(profile.path, ".tox").toLowerCase() === path.basename(history.path, ".db").toLowerCase(), "qTox profile/history names do not match");
      check(profile.mtimeMs >= this.paths.createdAt && history.mtimeMs >= this.paths.createdAt, "qTox profile/history predates this disposable run");
      const material = (await readdir(this.paths.qtoxProfileRoot, { recursive: true, withFileTypes: true }))
        .filter((entry) => entry.isFile() && /\.(?:tox|db)$/iu.test(entry.name));
      check(material.filter((entry) => entry.name.toLowerCase().endsWith(".tox")).length === 1, "qTox profile root contains another profile");
      check(material.filter((entry) => entry.name.toLowerCase().endsWith(".db")).length === 1, "qTox profile root contains another history database");
      const portableIni = await ordinaryFile(path.join(this.paths.qtoxProgramRoot, "qtox.ini"), "owned qTox portable settings", QTOX_PORTABLE_INI.length);
      check(await readFile(portableIni.path, "utf8") === QTOX_PORTABLE_INI, "owned qTox portable settings changed");
      check(portableIni.mtimeMs <= profile.mtimeMs && portableIni.mtimeMs <= history.mtimeMs, "qTox portable settings were not present before profile creation");
      const executable = await ordinaryFile(executablePath, "owned qTox executable", 1_000_000);
      const runtimeManifest = await ordinaryFile(runtimeManifestPath, "owned qTox runtime manifest", 64);
      requireWithin(this.paths.qtoxProgramRoot, executable.path, "qTox executable");
      requireWithin(this.paths.qtoxProgramRoot, runtimeManifest.path, "qTox runtime manifest");
      check(path.extname(executable.path).toLowerCase() === ".exe", "owned qTox executable extension is invalid");

      const kaigenToxId = await this.adapter.invoke("get_tox_id");
      const kaigenPublicKey = publicKeyFromToxId(kaigenToxId, "Kaigen qTox interop profile");
      check(kaigenPublicKey !== qtoxPublicKey, "qTox and Kaigen identities unexpectedly match");
      await this.adapter.invoke("add_tox_friend", {
        toxId,
        message: `Kaigen qTox ${this.target} compatibility ${this.fixture.caseToken}`,
      });
      this.qtox = { toxId, profilePath: profile.path, historyPath: history.path };
      this.qtoxPublicKey = qtoxPublicKey;
      this.kaigenToxId = kaigenToxId;
      this.kaigenPublicKey = kaigenPublicKey;
      this.qtoxInstanceBefore = instanceToken;
      this.qtoxLauncher = {
        instanceToken,
        programDirectoryCopied: true,
        portableSidecarPrecreated: true,
        disposableProfileRoot: true,
        immutableRuntimeLaunched: false,
        sidecarSha256: await sha256File(portableIni.path),
        runtimeManifestSha256: await sha256File(runtimeManifest.path),
        executableSha256: await sha256File(executable.path),
      };
      this.kaigenInstanceBefore = await adapterInstanceToken(this.adapter, "initial Kaigen");
      return Object.freeze({ kaigenToxId, actionPlan: this.actionPlan() });
    });
  }

  async waitOnlineAndProbe() {
    return this.runPhase("waitOnlineAndProbe", "bound", "online", async () => {
      const friend = await waitFriendOnline(this.adapter, this.qtoxPublicKey, this.timeoutMs, "qTox friendship online");
      this.friendNumber = friend.number;
      const capabilities = assertCapabilities(
        await this.adapter.invoke("get_chat_capabilities", { profileId: null, friendNumber: this.friendNumber }),
        "qTox contact",
      );
      const pqPre = assertUnavailablePq(
        await this.adapter.invoke("get_pq_status", { friendNumber: this.friendNumber }),
        "qTox pre-send",
      );
      this.originalFileSettings = await this.adapter.invoke("get_file_receive_settings");
      check(this.originalFileSettings && typeof this.originalFileSettings === "object" && !Array.isArray(this.originalFileSettings), "Kaigen file-receive settings are unavailable");
      await this.adapter.invoke("set_file_receive_settings", {
        settings: {
          denyAll: false,
          autoAcceptImages: this.originalFileSettings.autoAcceptImages === true,
          showImages: this.originalFileSettings.showImages === true,
          autoAcceptAny: true,
          maxAutoBytes: Math.max(FIXTURE_BYTES, Number(this.originalFileSettings.maxAutoBytes) || 0),
          maxConcurrent: Math.max(1, Math.min(2, Number(this.originalFileSettings.maxConcurrent) || 1)),
        },
      });
      this.fileSettingsChanged = true;
      this.compatibility = { capabilities, pqPre };
      return Object.freeze({ friendOnline: true, capabilitySupported: false, actionPlan: this.actionPlan() });
    });
  }

  async assertFormattingUnavailable() {
    const ui = this.adapter.ui;
    await ui.ensureChat(this.friendNumber);
    const draft = `qtox-formatting-disabled-${this.fixture.caseToken}`;
    const selector = ".compose-row textarea";
    await ui.setValue(selector, draft);
    await ui.setSelection(selector, 0, draft.length);
    await ui.contextClick(selector);
    await ui.waitFor('document.querySelector(".text-edit-context-menu")', "qTox text context menu", this.timeoutMs);
    const observation = await ui.evaluate(`(() => {
      const textarea = document.querySelector(${JSON.stringify(selector)});
      return {
        menuVisible: document.querySelector(".text-edit-context-menu") !== null,
        formattingGroups: document.querySelectorAll(".text-edit-formatting-group").length,
        formattingActions: document.querySelectorAll("[data-kaigen-format-kind]").length,
        toolbarCount: document.querySelectorAll(".composer-formatting-toolbar").length,
        selectionRetained: textarea instanceof HTMLTextAreaElement && textarea.selectionStart === 0 && textarea.selectionEnd === ${draft.length},
      };
    })()`);
    assert.deepEqual(observation, {
      menuVisible: true,
      formattingGroups: 0,
      formattingActions: 0,
      toolbarCount: 0,
      selectionRetained: true,
    }, "qTox contact exposed advanced formatting controls");
    const screenshot = path.join(this.paths.evidenceRoot, SCREENSHOT_NAMES[1]);
    await ui.capture(screenshot);
    await validatePng(screenshot, "Kaigen no-formatting screenshot");
    await ui.keyPress("Escape");
    await ui.setValue(selector, "");
    return false;
  }

  async runKaigenInitial() {
    return this.runPhase("runKaigenInitial", "online", "initial-outbound", async () => {
      const formattingGroupVisible = await this.assertFormattingUnavailable();
      const operationId = randomUUID();
      const firstSendStarted = performance.now();
      const result = await this.adapter.invoke("send_tox_message", {
        profileId: null,
        friendNumber: this.friendNumber,
        text: this.fixture.kaigenToQtoxText,
        operationId,
        quote: null,
        formatting: [],
      });
      check(performance.now() - firstSendStarted <= FIRST_SEND_MAX_MS, "unsupported qTox first send waited for a PQ decision");
      check(result && typeof result.messageId === "string" && result.messageId.length > 0 && result.delivery !== "failed", "Kaigen initial qTox send result is invalid");
      const [pqAfterFirstSendRaw, immediateHistory, promptState] = await Promise.all([
        this.adapter.invoke("get_pq_status", { friendNumber: this.friendNumber }),
        historyFor(this.adapter, this.friendNumber),
        this.adapter.ui.evaluate(`(() => ({
          pqPromptVisible: document.querySelector(".pq-capability-wait") !== null,
          entropyPanelVisible: document.querySelector(".pq-entropy-panel") !== null,
        }))()`),
      ]);
      const immediateRows = rowsWithText(immediateHistory, this.fixture.kaigenToQtoxText, true);
      check(immediateRows.length === 1, "initial qTox message was not atomically recorded exactly once");
      assertPlainProtocolRow(immediateRows[0], "immediate Kaigen-to-qTox first-send row");
      const pqAfterFirstSend = assertUnavailablePq(pqAfterFirstSendRaw, "qTox immediate first send");
      assert.deepEqual(promptState, { pqPromptVisible: false, entropyPanelVisible: false }, "unsupported qTox contact opened a PQ prompt");
      const delivered = await waitExactTextRow(
        this.adapter,
        this.friendNumber,
        this.fixture.kaigenToQtoxText,
        true,
        this.timeoutMs,
        "initial Kaigen-to-qTox text",
        (row) => row.delivery === "delivered" && row.pq_protected === false && row.protocol_version == null,
      );
      assertPlainProtocolRow(delivered, "initial Kaigen-to-qTox text");
      const promptAfterDelivery = await this.adapter.ui.evaluate(`(() => ({
        pqPromptVisible: document.querySelector(".pq-capability-wait") !== null,
        entropyPanelVisible: document.querySelector(".pq-entropy-panel") !== null,
      }))()`);
      assert.deepEqual(promptAfterDelivery, { pqPromptVisible: false, entropyPanelVisible: false }, "unsupported qTox contact exposed a delayed PQ prompt");

      await this.adapter.sendFile({
        friendNumber: this.friendNumber,
        filePath: this.fixture.kaigenOutboundPath,
        fileName: this.fixture.kaigenOutboundName,
        mime: "application/octet-stream",
        bytes: Buffer.from(this.fixture.bytes),
      });
      await waitExactFileRow(
        this.adapter,
        this.friendNumber,
        this.fixture.kaigenOutboundName,
        true,
        this.timeoutMs,
        "Kaigen-to-qTox file offer",
        false,
      );
      this.compatibility = {
        ...this.compatibility,
        pqAfterFirstSend,
        pqPromptVisible: promptState.pqPromptVisible,
        formattingGroupVisible,
        entropyPanelVisible: promptState.entropyPanelVisible,
      };
      return Object.freeze({
        qtoxUiRequired: true,
        acceptKaigenFile: this.fixture.kaigenOutboundName,
        sendText: this.fixture.qtoxToKaigenText,
        quoteMessage: this.fixture.kaigenToQtoxText,
        quoteBody: this.fixture.qtoxQuoteBody,
        sendFilePath: this.fixture.qtoxOutboundPath,
        sendFileName: this.fixture.qtoxOutboundName,
      });
    });
  }

  async observeQtoxInitialAndReply() {
    return this.runPhase("observeQtoxInitialAndReply", "initial-outbound", "replied", async () => {
      const qtoxText = await waitExactTextRow(
        this.adapter,
        this.friendNumber,
        this.fixture.qtoxToKaigenText,
        false,
        this.timeoutMs,
        "qTox-to-Kaigen text",
      );
      assertPlainProtocolRow(qtoxText, "qTox-to-Kaigen text");
      const qtoxQuote = await waitExactTextRow(
        this.adapter,
        this.friendNumber,
        this.fixture.qtoxQuoteBody,
        false,
        this.timeoutMs,
        "qTox-to-Kaigen quote",
        (row) => row.quote?.legacy === true,
      );
      assertPlainProtocolRow(qtoxQuote, "qTox-to-Kaigen quote");
      assertLegacyQuoteRow(qtoxQuote, this.fixture.kaigenToQtoxText, "qTox-to-Kaigen quote");

      const receivedFile = await waitExactFileRow(
        this.adapter,
        this.friendNumber,
        this.fixture.qtoxOutboundName,
        false,
        this.timeoutMs,
        "qTox-to-Kaigen file",
      );
      const received = await this.adapter.readReceivedFile({
        friendNumber: this.friendNumber,
        message: receivedFile,
        expectedName: this.fixture.qtoxOutboundName,
      });
      check(received && typeof received === "object", "Kaigen received-file adapter returned no evidence");
      const receivedPath = await ordinaryFile(received.path, "Kaigen received qTox file", FIXTURE_BYTES);
      requireWithin(this.paths.kaigenReceiveRoot, receivedPath.path, "Kaigen received qTox file");
      const receivedBytes = normalizeBytes(received.bytes, "Kaigen received qTox file");
      check(receivedBytes.length === FIXTURE_BYTES && sha256Bytes(receivedBytes) === this.fixture.sha256, "Kaigen received different qTox file bytes");

      const quote = {
        messageId: qtoxText.id,
        author: "peer",
        text: this.fixture.qtoxToKaigenText,
        legacy: false,
      };
      await sendPlainOnce(
        this.adapter,
        this.friendNumber,
        this.fixture.kaigenQuoteBody,
        quote,
      );
      const sentQuote = await waitExactTextRow(
        this.adapter,
        this.friendNumber,
        this.fixture.kaigenQuoteBody,
        true,
        this.timeoutMs,
        "Kaigen-to-qTox quote",
        (row) => row.delivery === "delivered",
      );
      assertPlainProtocolRow(sentQuote, "Kaigen-to-qTox quote");
      check(sentQuote.quote?.text === this.fixture.qtoxToKaigenText, "Kaigen outgoing quote lost its semantic target");

      await waitExactFileRow(
        this.adapter,
        this.friendNumber,
        this.fixture.kaigenOutboundName,
        true,
        this.timeoutMs,
        "completed Kaigen-to-qTox file",
      );
      await this.adapter.ui.ensureChat(this.friendNumber);
      const screenshot = path.join(this.paths.evidenceRoot, SCREENSHOT_NAMES[2]);
      await this.adapter.ui.capture(screenshot);
      await validatePng(screenshot, "Kaigen legacy-chat screenshot");
      return Object.freeze({
        qtoxUiRequired: true,
        expectQuoteWire: `> ${this.fixture.qtoxToKaigenText}\n${this.fixture.kaigenQuoteBody}`,
        capturePhase: "initial-chat",
        restartQtoxAfterCapture: true,
      });
    });
  }

  async recordQtoxScreenshot(phase, bytes) {
    const expected = phase === "initial-chat"
      ? { stage: "replied", next: "initial-evidenced", name: SCREENSHOT_NAMES[0] }
      : phase === "post-restart"
        ? { stage: "post-inbound", next: "post-evidenced", name: SCREENSHOT_NAMES[3] }
        : null;
    check(expected, "unknown qTox screenshot phase");
    return this.runPhase(`recordQtoxScreenshot:${phase}`, expected.stage, expected.next, async () => {
      const image = normalizeBytes(bytes, `qTox ${phase} screenshot`);
      check(image.length >= 1_024 && image.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE), `qTox ${phase} evidence is not a nontrivial PNG`);
      const file = path.join(this.paths.evidenceRoot, expected.name);
      await writeFile(file, image, { flag: "wx" });
      await validatePng(file, `qTox ${phase} screenshot`);
      return Object.freeze({ recorded: expected.name, sha256: sha256Bytes(image) });
    });
  }

  async restartKaigenAndProbe({ qtoxInstanceToken }) {
    return this.runPhase("restartKaigenAndProbe", "initial-evidenced", "restarted", async () => {
      check(typeof qtoxInstanceToken === "string" && SAFE_INSTANCE_TOKEN.test(qtoxInstanceToken), "restarted qTox UI instance token is invalid");
      check(qtoxInstanceToken !== this.qtoxInstanceBefore, "qTox UI instance did not change across restart");
      this.qtoxInstanceAfter = qtoxInstanceToken;
      await this.adapter.restart();
      this.kaigenInstanceAfter = await adapterInstanceToken(this.adapter, "restarted Kaigen");
      check(this.kaigenInstanceAfter !== this.kaigenInstanceBefore, "Kaigen instance did not change across restart");
      const friend = await waitFriendOnline(this.adapter, this.qtoxPublicKey, this.timeoutMs, "qTox friendship after restart");
      this.friendNumber = friend.number;
      assertCapabilities(
        await this.adapter.invoke("get_chat_capabilities", { profileId: null, friendNumber: this.friendNumber }),
        "restarted qTox contact",
      );
      const pqAfterReconnect = assertUnavailablePq(
        await this.adapter.invoke("get_pq_status", { friendNumber: this.friendNumber }),
        "qTox reconnect",
      );
      const history = await historyFor(this.adapter, this.friendNumber);
      for (const [text, mine, label] of [
        [this.fixture.kaigenToQtoxText, true, "initial Kaigen text"],
        [this.fixture.qtoxToKaigenText, false, "initial qTox text"],
        [this.fixture.qtoxQuoteBody, false, "initial qTox quote"],
        [this.fixture.kaigenQuoteBody, true, "initial Kaigen quote"],
      ]) {
        check(rowsWithText(history, text, mine).length === 1, `${label} did not persist across Kaigen restart`);
      }
      this.compatibility = { ...this.compatibility, pqAfterReconnect };
      return Object.freeze({
        qtoxUiRequired: true,
        kaigenRestarted: true,
        qtoxRestartObserved: true,
        nextKaigenText: this.fixture.kaigenPostRestartText,
        nextQtoxText: this.fixture.qtoxPostRestartText,
      });
    });
  }

  async runKaigenPostRestart() {
    return this.runPhase("runKaigenPostRestart", "restarted", "post-outbound", async () => {
      await sendPlainOnce(
        this.adapter,
        this.friendNumber,
        this.fixture.kaigenPostRestartText,
        null,
      );
      const row = await waitExactTextRow(
        this.adapter,
        this.friendNumber,
        this.fixture.kaigenPostRestartText,
        true,
        this.timeoutMs,
        "post-restart Kaigen-to-qTox text",
        (item) => item.delivery === "delivered",
      );
      assertPlainProtocolRow(row, "post-restart Kaigen-to-qTox text");
      assertUnavailablePq(
        await this.adapter.invoke("get_pq_status", { friendNumber: this.friendNumber }),
        "qTox next send after reconnect",
      );
      return Object.freeze({ qtoxUiRequired: true, sendText: this.fixture.qtoxPostRestartText });
    });
  }

  async observeQtoxPostRestart() {
    return this.runPhase("observeQtoxPostRestart", "post-outbound", "post-inbound", async () => {
      const row = await waitExactTextRow(
        this.adapter,
        this.friendNumber,
        this.fixture.qtoxPostRestartText,
        false,
        this.timeoutMs,
        "post-restart qTox-to-Kaigen text",
      );
      assertPlainProtocolRow(row, "post-restart qTox-to-Kaigen text");
      return Object.freeze({ qtoxUiRequired: true, capturePhase: "post-restart", stopQtoxAfterCapture: true });
    });
  }

  expectedSemantics() {
    return [
      messageSemantic("kaigen-to-qtox", "text", this.fixture.kaigenToQtoxText),
      messageSemantic("qtox-to-kaigen", "text", this.fixture.qtoxToKaigenText),
      messageSemantic("qtox-to-kaigen", "quote", this.fixture.qtoxQuoteBody, this.fixture.kaigenToQtoxText),
      messageSemantic("kaigen-to-qtox", "quote", this.fixture.kaigenQuoteBody, this.fixture.qtoxToKaigenText),
      messageSemantic("kaigen-to-qtox", "restart", this.fixture.kaigenPostRestartText),
      messageSemantic("qtox-to-kaigen", "restart", this.fixture.qtoxPostRestartText),
    ];
  }

  async finalKaigenEvidence() {
    const history = await historyFor(this.adapter, this.friendNumber);
    const userRows = messageRows(history);
    check(userRows.length === 6, "Kaigen qTox transcript contains missing or unexpected text rows");
    const expected = [
      [this.fixture.kaigenToQtoxText, true, "text", null],
      [this.fixture.qtoxToKaigenText, false, "text", null],
      [this.fixture.qtoxQuoteBody, false, "quote", this.fixture.kaigenToQtoxText],
      [this.fixture.kaigenQuoteBody, true, "quote", this.fixture.qtoxToKaigenText],
      [this.fixture.kaigenPostRestartText, true, "restart", null],
      [this.fixture.qtoxPostRestartText, false, "restart", null],
    ];
    const semantics = [];
    for (const [text, mine, kind, quoteText] of expected) {
      const matches = rowsWithText(history, text, mine);
      check(matches.length === 1, `Kaigen qTox ${kind} row count was not exactly one`);
      const row = matches[0];
      assertPlainProtocolRow(row, `Kaigen qTox ${kind}`);
      if (text === this.fixture.qtoxQuoteBody) assertLegacyQuoteRow(row, quoteText, "final qTox-to-Kaigen quote");
      if (text === this.fixture.kaigenQuoteBody) check(row.quote?.text === quoteText && row.quote?.legacy === false, "final Kaigen-to-qTox quote semantics changed");
      if (mine) check(row.delivery === "delivered", `Kaigen qTox ${kind} sender receipt was not delivered`);
      semantics.push(messageSemantic(mine ? "kaigen-to-qtox" : "qtox-to-kaigen", kind, text, quoteText));
    }
    const files = fileRows(history);
    check(files.length === 2, "Kaigen qTox transcript contains missing or unexpected file rows");
    const outgoing = files.filter((row) => row.mine === true && row.attachment?.name === this.fixture.kaigenOutboundName);
    const incoming = files.filter((row) => row.mine === false && row.attachment?.name === this.fixture.qtoxOutboundName);
    check(outgoing.length === 1 && incoming.length === 1, "Kaigen qTox file directions are invalid");
    for (const [row, label] of [[outgoing[0], "outgoing"], [incoming[0], "incoming"]]) {
      const attachment = row.attachment;
      check(attachment.completed === true && attachment.transfer_state === "complete"
        && attachment.size === FIXTURE_BYTES && attachment.transferred === FIXTURE_BYTES
        && !attachment.transfer_error, `Kaigen qTox ${label} file is incomplete`);
    }
    const received = await this.adapter.readReceivedFile({
      friendNumber: this.friendNumber,
      message: incoming[0],
      expectedName: this.fixture.qtoxOutboundName,
    });
    const receivedPath = await ordinaryFile(received.path, "final Kaigen qTox download", FIXTURE_BYTES);
    requireWithin(this.paths.kaigenReceiveRoot, receivedPath.path, "final Kaigen qTox download");
    const bytes = normalizeBytes(received.bytes, "final Kaigen qTox download");
    check(bytes.length === FIXTURE_BYTES && sha256Bytes(bytes) === this.fixture.sha256, "final Kaigen qTox download hash differs");
    return { semantics, fileHash: sha256Bytes(bytes) };
  }

  async finalQtoxEvidence() {
    const database = await readQtoxDatabase(this.qtox.historyPath);
    check(database.pendingCount === 0 && database.brokenCount === 0, "qTox transcript retained pending or broken message rows");
    const rows = database.rows.map((row) => ({
      sourceId: Number(row.source_id),
      timestampMs: Number(row.timestamp_ms),
      type: normalizeTextValue(row.message_type, "qTox message type"),
      chatKey: normalizeKey(row.chat_key, "qTox chat key"),
      senderKey: normalizeKey(row.sender_key, "qTox sender key"),
      message: row.message == null ? null : normalizeTextValue(row.message, "qTox message"),
      fileName: row.file_name == null ? null : normalizeTextValue(row.file_name, "qTox file name"),
      filePath: row.file_path == null ? null : normalizeTextValue(row.file_path, "qTox file path"),
      fileSize: row.file_size == null ? null : Number(row.file_size),
      direction: row.direction == null ? null : Number(row.direction),
      fileState: row.file_state == null ? null : Number(row.file_state),
    }));
    check(rows.length === 8, "qTox transcript contains missing or unexpected user/file rows");
    check(rows.every((row) => row.chatKey === this.kaigenPublicKey), "qTox transcript includes another chat identity");
    const texts = rows.filter((row) => row.type === "T");
    const files = rows.filter((row) => row.type === "F");
    check(texts.length === 6 && files.length === 2, "qTox transcript type counts are invalid");

    const expected = [
      [this.fixture.kaigenToQtoxText, this.kaigenPublicKey, "kaigen-to-qtox", "text", null],
      [this.fixture.qtoxToKaigenText, this.qtoxPublicKey, "qtox-to-kaigen", "text", null],
      [`> ${this.fixture.kaigenToQtoxText}\n${this.fixture.qtoxQuoteBody}`, this.qtoxPublicKey, "qtox-to-kaigen", "quote", this.fixture.kaigenToQtoxText],
      [`> ${this.fixture.qtoxToKaigenText}\n${this.fixture.kaigenQuoteBody}`, this.kaigenPublicKey, "kaigen-to-qtox", "quote", this.fixture.qtoxToKaigenText],
      [this.fixture.kaigenPostRestartText, this.kaigenPublicKey, "kaigen-to-qtox", "restart", null],
      [this.fixture.qtoxPostRestartText, this.qtoxPublicKey, "qtox-to-kaigen", "restart", null],
    ];
    const semantics = [];
    for (const [wire, senderKey, direction, kind, quoteText] of expected) {
      const matches = texts.filter((row) => row.message === wire && row.senderKey === senderKey);
      check(matches.length === 1, `qTox ${kind} transcript row count was not exactly one`);
      let body = wire;
      let parsedQuote = null;
      if (kind === "quote") {
        parsedQuote = parseLegacyQuote(wire);
        check(parsedQuote?.quoteText === quoteText, "qTox quote prefix changed");
        body = parsedQuote.body;
      }
      semantics.push(messageSemantic(direction, kind, body, parsedQuote?.quoteText ?? null));
    }

    const incoming = files.filter((row) => row.senderKey === this.kaigenPublicKey && row.fileName === this.fixture.kaigenOutboundName);
    const outgoing = files.filter((row) => row.senderKey === this.qtoxPublicKey && row.fileName === this.fixture.qtoxOutboundName);
    check(incoming.length === 1 && outgoing.length === 1, "qTox file transcript directions are invalid");
    check(incoming[0].fileSize === FIXTURE_BYTES && outgoing[0].fileSize === FIXTURE_BYTES, "qTox file transcript sizes differ");
    check(incoming[0].direction === 1 && outgoing[0].direction === 0, "qTox file directions differ from receiving/sending");
    check(incoming[0].fileState === 5 && outgoing[0].fileState === 5, "qTox file rows did not reach FINISHED");

    const incomingPath = await ordinaryFile(incoming[0].filePath, "qTox received Kaigen file", FIXTURE_BYTES);
    requireWithin(this.paths.qtoxDownloadRoot, incomingPath.path, "qTox received Kaigen file");
    const outgoingPath = await ordinaryFile(outgoing[0].filePath, "qTox source file", FIXTURE_BYTES);
    requireWithin(this.paths.fixtureRoot, outgoingPath.path, "qTox source file");
    check(path.basename(incomingPath.path) === this.fixture.kaigenOutboundName, "qTox received filename changed");
    check(path.basename(outgoingPath.path) === this.fixture.qtoxOutboundName, "qTox source filename changed");
    const [incomingHash, outgoingHash] = await Promise.all([sha256File(incomingPath.path), sha256File(outgoingPath.path)]);
    check(incomingHash === this.fixture.sha256 && outgoingHash === this.fixture.sha256, "qTox file bytes differ from the fixture");
    return { semantics, receivedFileHash: incomingHash, orphanPending: database.pendingCount };
  }

  async restoreFileSettings() {
    if (!this.fileSettingsChanged) return;
    await this.adapter.invoke("set_file_receive_settings", { settings: this.originalFileSettings });
    this.fileSettingsChanged = false;
  }

  async finalizeAfterQtoxStopped() {
    return this.runPhase("finalizeAfterQtoxStopped", "post-evidenced", "complete", async () => {
      const [kaigen, qtox] = await Promise.all([this.finalKaigenEvidence(), this.finalQtoxEvidence()]);
      const expected = this.expectedSemantics();
      assert.deepEqual(kaigen.semantics, expected, "Kaigen semantic transcript changed");
      assert.deepEqual(qtox.semantics, expected, "qTox semantic transcript changed");
      const expectedTranscriptSha256 = semanticHash(expected);
      const kaigenTranscriptSha256 = semanticHash(kaigen.semantics);
      const qtoxTranscriptSha256 = semanticHash(qtox.semantics);
      const expectedQuotes = expected.filter((row) => row.kind === "quote")
        .map(({ direction, bodySha256, quoteTextSha256 }) => ({ direction, bodySha256, quoteTextSha256 }));
      const kaigenQuotes = kaigen.semantics.filter((row) => row.kind === "quote")
        .map(({ direction, bodySha256, quoteTextSha256 }) => ({ direction, bodySha256, quoteTextSha256 }));
      const qtoxQuotes = qtox.semantics.filter((row) => row.kind === "quote")
        .map(({ direction, bodySha256, quoteTextSha256 }) => ({ direction, bodySha256, quoteTextSha256 }));
      const expectedQuoteSha256 = semanticHash(expectedQuotes);
      const kaigenQuoteSha256 = semanticHash(kaigenQuotes);
      const qtoxQuoteSha256 = semanticHash(qtoxQuotes);
      check(new Set([expectedTranscriptSha256, kaigenTranscriptSha256, qtoxTranscriptSha256]).size === 1, "qTox/Kaigen transcript hashes differ");
      check(new Set([expectedQuoteSha256, kaigenQuoteSha256, qtoxQuoteSha256]).size === 1, "qTox/Kaigen quote hashes differ");
      check(kaigen.fileHash === this.fixture.sha256 && qtox.receivedFileHash === this.fixture.sha256, "qTox/Kaigen received file hashes differ");
      await this.restoreFileSettings();

      const screenshots = [];
      for (const name of SCREENSHOT_NAMES) {
        screenshots.push(await validatePng(path.join(this.paths.evidenceRoot, name), `qTox interop screenshot ${name}`));
      }
      const receipt = {
        schemaVersion: 1,
        status: "PASS",
        scope: "qtox-interop",
        target: this.target,
        identity: {
          kaigenCommit: this.identity.kaigenCommit,
          sourceTree: this.identity.sourceTree,
          buildId: this.identity.buildId,
          artifactKind: this.identity.artifactKind,
          artifactSha256: this.identity.artifactSha256,
          qtoxFixtureSha256: QTOX_FIXTURE_SHA256,
          qtoxVersion: QTOX_VERSION,
          qtoxPlatform: QTOX_PLATFORM,
          qtoxInstallerSha256: QTOX_INSTALLER_SHA256,
        },
        environment: {
          syntheticOnly: true,
          launcher: this.qtoxLauncher,
          productionContacted: false,
          secretsIncluded: false,
        },
        checks: Object.fromEntries(RECEIPT_CHECKS.map((name) => [name, true])),
        evidence: {
          friendship: { qtoxPublicKeyMatched: true, kaigenPublicKeyMatched: true, onlineBeforeTraffic: true },
          messages: {
            count: 6,
            directions: 2,
            kaigenRows: 6,
            qtoxRows: 6,
            expectedTranscriptSha256,
            kaigenTranscriptSha256,
            qtoxTranscriptSha256,
            exactPlaintext: true,
            exactOnce: true,
            unexpectedRows: 0,
            controlTextLeaks: 0,
          },
          files: {
            directions: 2,
            count: 2,
            fixtureSha256: this.fixture.sha256,
            qtoxReceivedSha256: qtox.receivedFileHash,
            kaigenReceivedSha256: kaigen.fileHash,
            exactBytes: true,
            outsideRoots: false,
            orphanPending: qtox.orphanPending,
          },
          quotes: {
            directions: 2,
            count: 2,
            expectedTranscriptSha256: expectedQuoteSha256,
            kaigenTranscriptSha256: kaigenQuoteSha256,
            qtoxTranscriptSha256: qtoxQuoteSha256,
            legacyPrefixExact: true,
            legacyAuthorEmpty: true,
            structuredQuoteWireUsed: false,
          },
          compatibility: {
            chatCapabilities: this.compatibility.capabilities,
            pqPre: this.compatibility.pqPre,
            pqAfterFirstSend: this.compatibility.pqAfterFirstSend,
            pqAfterReconnect: this.compatibility.pqAfterReconnect,
            pqPromptVisible: this.compatibility.pqPromptVisible,
            formattingGroupVisible: this.compatibility.formattingGroupVisible,
            entropyPanelVisible: this.compatibility.entropyPanelVisible,
            protocolRowsPlain: true,
            formattingSpansSent: 0,
            qtoxVisibleControlTextLeaks: 0,
          },
          reconnect: {
            qtoxRestarted: this.qtoxInstanceAfter !== this.qtoxInstanceBefore,
            kaigenRestarted: this.kaigenInstanceAfter !== this.kaigenInstanceBefore,
            friendReboundByPublicKey: true,
            onlineRestored: true,
            historyPersisted: true,
            postRestartDirections: 2,
          },
          screenshots,
        },
      };
      validateReceipt(receipt);
      const receiptPath = path.join(this.paths.evidenceRoot, "qtox-interop-receipt.json");
      await writeFile(receiptPath, canonicalJsonBytes(receipt), { encoding: "utf8", flag: "wx" });
      return Object.freeze({
        schemaVersion: 1,
        status: "PASS",
        target: this.target,
        receiptPath,
        receiptSha256: await sha256File(receiptPath),
      });
    });
  }

  async abort(error) {
    if (this.stage === "complete") throw new Error("qTox interop session already completed");
    const phase = this.stage;
    this.stage = "failed";
    let restoreError = null;
    try {
      await this.restoreFileSettings();
    } catch (value) {
      restoreError = value;
    }
    await this.writeFailure(`abort:${phase}`, restoreError ?? error).catch(() => {});
    if (restoreError) throw restoreError;
    return Object.freeze({ status: "FAIL", target: this.target, phase });
  }
}

export async function createQtoxInteropSession(config) {
  check(config && typeof config === "object" && !Array.isArray(config), "qTox interop configuration is unavailable");
  assert.deepEqual(Object.keys(config), ["target", "identity", "runId", "runRoot", "timeoutMs", "kaigen"]);
  check(ALLOWED_TARGETS.has(config.target), "qTox interop target is invalid");
  validateIdentity(config.target, config.identity);
  check(SAFE_RUN_ID.test(config.runId), "qTox interop run ID is invalid");
  check(Number.isInteger(config.timeoutMs) && config.timeoutMs >= 30_000 && config.timeoutMs <= 10 * 60_000, "qTox interop timeout is invalid");
  validateAdapter(config.kaigen);
  const pin = await validatePin();

  await mkdir(RUNS_ROOT, { recursive: true });
  const runsRoot = await ordinaryDirectory(RUNS_ROOT, "qTox interop runs root");
  const expectedRoot = path.join(runsRoot, config.runId, config.target);
  check(path.resolve(config.runRoot) === expectedRoot, "qTox interop run root is not the exact owned target path");
  await mkdir(path.dirname(expectedRoot), { recursive: true });
  await access(expectedRoot).then(
    () => { throw new Error("qTox interop run root already exists"); },
    (error) => { if (error?.code !== "ENOENT") throw error; },
  );
  await mkdir(expectedRoot, { recursive: false });
  const createdAt = Date.now() - 1_000;
  const paths = {
    runRoot: await ordinaryDirectory(expectedRoot, "qTox interop run root"),
    qtoxProgramRoot: path.join(expectedRoot, "qtox-program"),
    qtoxProfileRoot: path.join(expectedRoot, "qtox-profile"),
    qtoxDownloadRoot: path.join(expectedRoot, "qtox-downloads"),
    kaigenProfileRoot: path.join(expectedRoot, "kaigen-profile"),
    kaigenReceiveRoot: path.join(expectedRoot, "kaigen-downloads"),
    fixtureRoot: path.join(expectedRoot, "fixtures"),
    evidenceRoot: path.join(expectedRoot, "evidence"),
    createdAt,
  };
  for (const directory of [
    paths.qtoxProgramRoot,
    paths.qtoxProfileRoot,
    paths.qtoxDownloadRoot,
    paths.kaigenProfileRoot,
    paths.kaigenReceiveRoot,
    paths.fixtureRoot,
    paths.evidenceRoot,
  ]) {
    await mkdir(directory, { recursive: false });
  }
  const ownerMarker = {
    schemaVersion: 1,
    scope: "qtox-interop",
    runId: config.runId,
    target: config.target,
    status: "OWNED_NEW_ROOT",
  };
  await writeFile(path.join(paths.runRoot, ".kaigen-qtox-run.json"), canonicalJsonBytes(ownerMarker), { encoding: "utf8", flag: "wx" });

  const caseToken = randomBytes(8).toString("hex");
  const bytes = randomBytes(FIXTURE_BYTES);
  const sha256 = sha256Bytes(bytes);
  const kaigenOutboundName = `kaigen-to-qtox-${caseToken}.bin`;
  const qtoxOutboundName = `qtox-to-kaigen-${caseToken}.bin`;
  const kaigenOutboundPath = path.join(paths.fixtureRoot, kaigenOutboundName);
  const qtoxOutboundPath = path.join(paths.fixtureRoot, qtoxOutboundName);
  await Promise.all([
    writeFile(kaigenOutboundPath, bytes, { flag: "wx" }),
    writeFile(qtoxOutboundPath, bytes, { flag: "wx" }),
  ]);
  check(await sha256File(kaigenOutboundPath) === sha256 && await sha256File(qtoxOutboundPath) === sha256, "qTox interop fixture write changed bytes");
  const fixture = {
    caseToken,
    bytes,
    sha256,
    kaigenOutboundName,
    qtoxOutboundName,
    kaigenOutboundPath,
    qtoxOutboundPath,
    kaigenToQtoxText: `Kaigen to qTox ${caseToken}`,
    qtoxToKaigenText: `qTox to Kaigen ${caseToken}`,
    qtoxQuoteBody: `qTox quoted reply ${caseToken}`,
    kaigenQuoteBody: `Kaigen quoted reply ${caseToken}`,
    kaigenPostRestartText: `Kaigen after restart ${caseToken}`,
    qtoxPostRestartText: `qTox after restart ${caseToken}`,
  };
  return new QtoxInteropSession(config, paths, pin, fixture);
}

async function selfTest() {
  check(SCREENSHOT_NAMES.length === 4 && new Set(SCREENSHOT_NAMES).size === 4, "qTox screenshot contract changed");
  check(RECEIPT_CHECKS.length === 11 && new Set(RECEIPT_CHECKS).size === 11, "qTox receipt check contract changed");
  await validatePin();
  const semantic = [messageSemantic("kaigen-to-qtox", "quote", "body", "quote")];
  check(HEX64.test(semanticHash(semantic)), "qTox transcript hashing failed");
  assert.deepEqual(parseLegacyQuote("> one\n> two\nbody"), { quoteText: "one\ntwo", body: "body" });
  check(parseLegacyQuote("plain") === null, "qTox quote parser accepted plain text");
  check(sha256Text(QTOX_PORTABLE_INI) === "0D7433A2D651CD582BA1B9E4CA6DAEFFD8421DAB8C154BAD7638BDF46784AB83", "qTox portable sidecar bytes changed");
  const source = await readFile(fileURLToPath(import.meta.url), "utf8");
  const exports = [...source.matchAll(/^export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)/gmu)].map((match) => match[1]);
  assert.deepEqual(exports, ["createQtoxInteropSession"], "qTox interop fixture export surface changed");
  const forbiddenSkip = ["skip", "pq", "auto"].join("_");
  check(!source.includes(["await this.adapter.invoke(\"", forbiddenSkip, "\""].join("")), "qTox fixture still requires a manual PQ skip");
  console.log("QTOX_INTEROP_FIXTURE_SELF_TEST_PASS pin=true transcriptHelpers=true sidecar=true unsupportedImmediateSource=true importSurface=true");
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length === 3 && process.argv[2] === "--self-test") await selfTest();
  else {
    console.error("Usage: node scripts/test-qtox-interop.mjs --self-test\nReal qTox runs import createQtoxInteropSession into the owner-controlled persistent UI orchestrator.");
    process.exitCode = 2;
  }
}
