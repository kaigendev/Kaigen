import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile, lstat, realpath } from "node:fs/promises";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { IMPORTED_RUST_KIND, PACKAGE_ONLY_FRONTEND, packageScriptClosureEquivalent, rootVersionEquivalent, validateImportedRustExecution, validatePackageOnlySourceClosure } from "./imported-rust-execution.mjs";

const PLAN_KIND = "kaigen-windows-incremental-plan";
const RESULT_KIND = "kaigen-incremental-check-result";
const RECEIPT_KIND = "kaigen-windows-incremental-verification";
const HASH = /^[a-f0-9]{64}$/u;
const OBJECT = /^[a-f0-9]{40}$/u;
const TEST_ONLY_PATHS = new Set([
  "scripts/build-portable.ps1",
  "scripts/incremental-windows-verification.mjs",
  "scripts/test-ui-annotation-metadata-equivalence.mjs",
  "scripts/imported-rust-execution.mjs",
  "scripts/test-build-pipeline.mjs",
  "scripts/test-prepared-native-cache-windows.ps1",
  "scripts/test-chat-geometry-runtime.mjs",
  "scripts/fixtures/chat-geometry-runtime/app-message-visibility-scenario.ts",
  "scripts/ci-incremental-verification.mjs",
  "scripts/test-ci-incremental-verification.mjs",
  "scripts/test-app-layout.mjs",
  "scripts/test-friend-resilience.mjs",
  "scripts/test-resource-bounds.mjs",
  "scripts/test-browser-runtime.mjs",
  "scripts/test-localization.mjs",
  "scripts/test-ui-identity-contract.mjs",
  "ci/verification-v0.2.8.json",
  "ci/verification-v0.2.9.json",
]);
const RELEASE_METADATA_PATH = ".github/workflows/build-unix.yml";
// Annotation scenarios are bundled JSON, but the shipped UI consumes `ids`.
// Permit only this reviewed correction, never the catalog as a test-only path.
const UI_ANNOTATION_METADATA = Object.freeze({
  schemaVersion: 1,
  kind: "kaigen-ui-annotation-metadata-equivalence",
  path: "src/App.ui-ids.json",
  beforeSha256: "3b895b807753451ff1d2c01cf221fb9e237635a17dbf52bfe811498cf79a5199",
  afterSha256: "f673a2dc8be12ad801e2eb9d371f413e977fff59a9907fcc86fde044ac8873b9",
  removals: [
    { family: "main_contacts_family_contact_status_dot", scenario: "main-tor-indicator-error" },
    { family: "main_contacts_family_contact_status_dot_leading", scenario: "main-tor-indicator-error" },
  ],
});
export function uiAnnotationMetadataTemplate() { return structuredClone(UI_ANNOTATION_METADATA); }

export function validateUiAnnotationMetadata(declaration, before, after, checks) {
  assert(same(declaration, UI_ANNOTATION_METADATA), "unapproved UI annotation metadata equivalence");
  assert(Buffer.isBuffer(before) && Buffer.isBuffer(after), "UI annotation equivalence requires exact source bytes");
  assert(sha(before) === UI_ANNOTATION_METADATA.beforeSha256, "UI annotation metadata preimage changed");
  const previous = JSON.parse(before.toString("utf8")), current = JSON.parse(after.toString("utf8"));
  const expected = structuredClone(previous);
  let expectedBytes = before.toString("utf8");
  for (const { family, scenario } of UI_ANNOTATION_METADATA.removals) {
    const matches = expected.families.filter(entry => entry.key === family);
    assert(matches.length === 1 && matches[0].scenarios.filter(value => value === scenario).length === 1, "UI annotation removal is ambiguous");
    matches[0].scenarios = matches[0].scenarios.filter(value => value !== scenario);
    const block = new RegExp(`^      "key": "${family}",\\r?\\n[\\s\\S]*?^    \\}`, "gmu");
    const blocks = [...expectedBytes.matchAll(block)];
    const line = `        "${scenario}",\n`;
    assert(blocks.length === 1 && blocks[0][0].split(line).length === 2, "UI annotation byte removal is ambiguous");
    expectedBytes = expectedBytes.replace(block, blocks[0][0].replace(line, ""));
  }
  assert(same(current, expected), "UI annotation change exceeds the two scenario removals");
  assert(after.equals(Buffer.from(expectedBytes)), "UI annotation bytes outside the two removals changed");
  assert(sha(after) === UI_ANNOTATION_METADATA.afterSha256, "UI annotation metadata postimage changed");
  const fresh = Array.isArray(checks) && checks.filter(check => check.id === "frontend:ui-identity");
  assert(fresh && fresh.length === 1 && fresh[0].action === "run" && !Object.hasOwn(fresh[0], "evidence"), "UI annotation equivalence requires fresh frontend:ui-identity");
  assert(Array.isArray(fresh[0].inputs) && fresh[0].inputs.some(input => input.kind === "git" && input.path === UI_ANNOTATION_METADATA.path
    && input.lines === undefined && input.sha256 === UI_ANNOTATION_METADATA.afterSha256), "fresh UI annotation check must bind the complete new catalog");
  return { ...uiAnnotationMetadataTemplate(), runtimeIdsSha256: sha(Buffer.from(JSON.stringify(current.ids))),
    allOtherCatalogBytesUnchanged: true, bundledBytesUnchanged: false, freshCheckId: "frontend:ui-identity" };
}
// Fixed Windows release proof for the Linux-only attachment command change.
// This permits reuse of the existing Windows artifact, not a claim that a new
// binary or full Rust source file would have identical bytes.
const WINDOWS_LIB_TARGET = Object.freeze({
  schemaVersion: 1,
  kind: "kaigen-windows-lib-target-equivalence",
  target: "windows-x64",
  path: "src-tauri/src/lib.rs",
  builtFrom: { commit: "24b0cd4752f25c6e989c3f104b2feb6d748c7fef", tree: "81c4f2cbb9fdd03b98e1f5fd9dd80ea16b65043b" },
  beforeSha256: "afb0cb0861b1fba44e935c6eead4c53dc34c29f52237b21f3719775ce64db0bf",
  afterSha256: "ad11f28ba95030f7ea824858b7be62843f4b813fe0ab447a874b746f762b45ff",
  priorWindowsReceiptSha256: "43abad44f0b30cf7809122cbdfde6e1d8d2fd6b91333e2ebdcbedcc1a0354a2b",
  archiveSha256: "deb7072f28370cc716728dad718dfd5df7330d99b15638b5e290078bee3c69de",
});
export function windowsLibTargetTemplate() { return structuredClone(WINDOWS_LIB_TARGET); }

export function validateWindowsLibTarget(declaration, entry, before, after, receiptBytes) {
  assert(same(declaration, WINDOWS_LIB_TARGET), "unapproved Windows target source equivalence");
  assert(entry?.path === WINDOWS_LIB_TARGET.path && entry.beforeMode === "100644" && entry.afterMode === "100644", "Windows target equivalence requires the exact ordinary lib source");
  assert(Buffer.isBuffer(before) && sha(before) === WINDOWS_LIB_TARGET.beforeSha256, "Windows target lib preimage changed");
  assert(Buffer.isBuffer(after) && sha(after) === WINDOWS_LIB_TARGET.afterSha256, "Windows target lib postimage changed");
  assert(Buffer.isBuffer(receiptBytes) && sha(receiptBytes) === WINDOWS_LIB_TARGET.priorWindowsReceiptSha256, "Windows target prior receipt changed");
  const receipt = JSON.parse(receiptBytes.toString("utf8"));
  assert(receipt.kind === "kaigen-windows-incremental-verification" && receipt.status === "PASS"
    && same(receipt.source, WINDOWS_LIB_TARGET.builtFrom) && receipt.archive?.sha256 === WINDOWS_LIB_TARGET.archiveSha256,
  "Windows target prior build proof is not the approved artifact");
  return { ...windowsLibTargetTemplate(), windowsCommandBehaviorEquivalent: true, bundledBytesUnchanged: false };
}
const NATIVE = new Map([
  ["native:prepared-cache", "scripts/test-prepared-native-cache-windows.ps1"],
  ["native:retry-cap", "scripts/test-toxcore-retry-cap.ps1"],
  ["native:offline-friend-request", "scripts/test-offline-friend-request-loopback.ps1"],
]);
const NATIVE_MARKERS = new Map([
  ["native:prepared-cache", [["PASS Windows prepared-native cache: built -> hit, compiler sentinel, corruption, missing, revocation, receipt, fresh-app ordering"]]],
  ["native:retry-cap", [
    ["PASS toxcore retry-cap transformation (60 seconds, idempotent, fail-closed)", "PASS controlled recovery model: capped=5->10->20->40->60->60->60"],
    ["PASS Kaigen fork retry cap: pinned source and 60-second schedule"],
  ]],
  ["native:offline-friend-request", [["PASS sender stayed routable", "PASS offline friend request delivered", "Verified native harness UDP ports:"]]],
]);

// The v0.2.9.7 product candidate includes the final UI identity catalog. The
// published v0.2.9.6 CI catalog is the accepted check inventory for deciding
// which local Windows checks have changed inputs. This exception is exact to
// the reviewed release identities; later releases need their own proof.
const AFFECTED_ONLY_0297 = Object.freeze({
  kind: "kaigen-v0297-affected-only",
  baselineCommit: "6639b980bc9649ebb712471bc7765d48f6a0e4d0",
  productCommit: "46f57d24a57274cd41b70178b8d91d8d0678a20c",
  successorProductSource: {
    commit: "a59edc59c3d22f7b237f01b6938c084ab407d0f2",
    tree: "b1ada2380e0dcdf6117c7dd8a4828ee553e66669",
  },
  successorVerificationPaths: [
    "ci/verification-v0.2.9.json",
    "scripts/ci-incremental-verification.mjs",
    "scripts/fixtures/chat-geometry-runtime/app-message-visibility-scenario.ts",
    "scripts/incremental-windows-verification.mjs",
    "scripts/test-ci-incremental-verification.mjs",
  ],
  adjunctCheckIds: [
    "frontend:source-archive-privacy",
    "rust:local_message_deletion",
  ],
  requiredCheckIds: [
    "frontend:chat-geometry-runtime",
    "frontend:pq-entropy",
    "frontend:app-layout",
    "frontend:ui-identity",
    "frontend:ui-interaction-state",
    "frontend:localization",
    "frontend:product-boundaries",
    "frontend:build-pipeline",
    "frontend:browser-runtime",
    "frontend:web-renderer-contract",
    "frontend:web-installer",
    "frontend:input-language-sync",
  ],
  // These suites list whole shared App/lib files as inputs, but the edited
  // regions do not implement their named feature. Their original evidence is
  // retained for historical analysis, not represented as current execution.
  omittedSharedInputChecks: [
    "frontend:desktop-file-routing",
    "frontend:theme-system",
    "frontend:profile-switcher",
    "frontend:contact-identity",
    "frontend:contact-list-order",
    "frontend:friend-resilience",
    "frontend:status-message",
    "frontend:platform-runtime",
    "frontend:resource-bounds",
    "frontend:prepared-native-cache",
    "native:prepared-cache",
  ],
});

// This narrow bridge imports an already accepted whole behavioral baseline.
// It is deliberately bound to one reviewed release transition, not a caller-
// supplied waiver or a source of synthetic per-check execution records.
const ACCEPTED_VERSION_BASELINE = Object.freeze({
  schemaVersion: 1,
  kind: "kaigen-accepted-version-baseline",
  baselineSource: { commit: "3fc57ad647dead133e6f1e083b12a28a1c9286f3", tree: "9a08fec5f117bb40ea505caa033b3bd0624a720a" },
  productSource: { commit: "434e6553d128ae426431a18460fcf94b76ceeba8", tree: "710eca355ccd3c2d1a686485d64fe43d3f7c7b7e" },
  transactionId: "3e55b92159ba4cb4880687f740f4fe26",
  publicRef: { path: "context.local/work/runtime/local-portable/payloads/windows-finish/ad941e809bcf71115e28ad8050e46019.json", sha256: "14d6eeabe2d083ac15c70ff34cd7a0fb2dd6b9c67ad47820779b5815c836a803", logicalDigest: "4cf6d88e813ebbac6683eca85ed64ee146cd073bba5b066ec36a2dc48462aca0" },
  prebuiltEvidence: { path: "outputs/message-visibility-20260928-r2/evidence/prebuilt-import/message-visibility-prebuilt-windows-finish-3e55b92159ba4cb4880687f740f4fe26.json", sha256: "aaf087b0237b39b88337cef483b7f25ca41c5091fd84bd76fa144cfe89cc9fbb" },
  productSnapshot: {
    build: { path: "outputs/release-v0.2.9.6-434e6553/snapshot/build.json", sha256: "df14c9d95f7a90df8524907d2a7b0cd9ef2677077ccc64724bb34d74966180df" },
    manifest: { path: "outputs/release-v0.2.9.6-434e6553/snapshot/manifest-sha256.tsv", sha256: "096ab2187f0f84eca4d8315195ad8f22302b22b2946b160793e51eca7f4ec95c" },
    archive: { path: "outputs/release-v0.2.9.6-434e6553/snapshot/Kaigen-source-snapshot.zip", sha256: "bc498c330153afe6fa9ab31ca5643d6f71dac3186a096c8b3a1b5145ed25d7be" },
  },
});
const ACCEPTED_VERSION_PATHS = ["package-lock.json", "package.json", "src-tauri/Cargo.lock", "src-tauri/Cargo.toml", "src-tauri/tauri.conf.json", "src/componentVersions.ts", "web/kaigen-webd/Cargo.lock", "web/kaigen-webd/Cargo.toml"];
const FRESH_VERSION_CHECKS = ["frontend:component-inventory", "frontend:build-pipeline"];
export function acceptedVersionBaselineTemplate() { return structuredClone(ACCEPTED_VERSION_BASELINE); }

function assert(condition, message) {
  if (!condition) throw new Error(`Incremental verification: ${message}`);
}
function shape(value, required, optional = [], label = "document") {
  assert(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  for (const key of required) assert(Object.hasOwn(value, key), `${label} is missing ${key}`);
  for (const key of Object.keys(value)) assert(required.includes(key) || optional.includes(key), `${label} has unknown field ${key}`);
}
function text(value, label) {
  assert(typeof value === "string" && value.trim().length > 0, `${label} must be nonempty text`);
  return value;
}
function sha(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function refPath(base, value) { return path.resolve(base, text(value, "file path")); }
function git(root, args, options = {}) {
  return execFileSync("git", ["-c", `safe.directory=${root.replaceAll("\\", "/")}`, "-C", root, ...args], { maxBuffer: 96 * 1024 * 1024, windowsHide: true, ...options });
}
function gitText(root, args) { return git(root, args).toString("utf8").trim(); }
// One cache belongs to one top-level validation call. Only immutable object
// reads are memoized; authority, working-tree and evidence checks still run.
export function createImmutableGitReadCache() {
  const entries = new Map();
  let hits = 0, misses = 0;
  const read = (root, kind, commit, filename) => {
    assert(typeof commit === "string" && OBJECT.test(commit), "immutable Git read requires a complete commit ID");
    assert(["blob", "commit", "tree"].includes(kind), "unapproved immutable Git read");
    const canonicalRoot = realpathSync.native(root);
    const objectRef = kind === "blob" ? `${commit}:${repoPath(filename)}` : `${commit}^{${kind}}`;
    const key = JSON.stringify([canonicalRoot, kind, objectRef]);
    if (!entries.has(key)) {
      const bytes = git(canonicalRoot, [kind === "blob" ? "show" : "rev-parse", objectRef]);
      entries.set(key, Buffer.from(bytes));
      misses++;
    } else hits++;
    return Buffer.from(entries.get(key));
  };
  return Object.freeze({
    blob: (root, commit, filename) => read(root, "blob", commit, filename),
    identity: (root, commit, kind) => {
      assert(kind === "commit" || kind === "tree", "unapproved source identity peel");
      return read(root, kind, commit);
    },
    stats: () => Object.freeze({ entries: entries.size, hits, misses }),
  });
}
function sourceBlob(root, source, filename, cache) {
  return cache.blob(root, source.commit, filename);
}
function repoPath(value) {
  text(value, "repository path");
  assert(!value.includes("\\") && !value.includes(":") && !value.startsWith("/") && !value.split("/").some((part) => !part || part === "." || part === ".."), `invalid repository path ${value}`);
  return value;
}
export function inputBytes(bytes, lines) {
  if (lines === undefined) return bytes;
  assert(Array.isArray(lines) && lines.length === 2 && lines.every(Number.isInteger) && lines[0] > 0 && lines[1] >= lines[0], "invalid input line range");
  const chunks = bytes.toString("utf8").replaceAll("\r\n", "\n").match(/[^\n]*\n|[^\n]+$/gu) || [];
  assert(lines[1] <= chunks.length, "input line range exceeds file");
  return Buffer.from(chunks.slice(lines[0] - 1, lines[1]).join(""));
}
async function fileBytes(filename) {
  const info = await lstat(filename);
  assert(info.isFile() && !info.isSymbolicLink(), `expected ordinary file: ${filename}`);
  return readFile(filename);
}
function pathKey(filename) { return process.platform === "win32" ? filename.toLowerCase() : filename; }
function localAbsolutePath(value, label) {
  text(value, label);
  assert(path.isAbsolute(value) && !/^[\\/]{2}/u.test(value) && !value.includes("\0"), `${label} must be a local absolute path`);
  const absolute = path.resolve(value);
  assert(!absolute.slice(path.parse(absolute).root.length).includes(":"), `${label} must not contain an alternate stream`);
  if (process.platform === "win32") assert(!absolute.slice(path.parse(absolute).root.length).split(path.sep).some(part => /[<>"|?*]|[ .]$/u.test(part)), `${label} contains an ambiguous Windows path`);
  return absolute;
}
function insideRoot(root, filename) {
  const relative = path.relative(root, filename);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
async function ordinaryDirectory(filename) {
  let current = path.parse(filename).root;
  for (const part of ["", ...filename.slice(current.length).split(path.sep).filter(Boolean)]) {
    if (part) current = path.join(current, part);
    const info = await lstat(current);
    assert(info.isDirectory() && !info.isSymbolicLink(), `verification root is not an ordinary directory: ${current}`);
  }
}
export async function canonicalVerificationRoot(value) {
  const original = localAbsolutePath(path.resolve(value), "verification root");
  // Check the spelling supplied by the caller before resolving it. Resolving
  // first would hide a junction/symlink that crosses the owner boundary.
  await ordinaryDirectory(original);
  const canonical = localAbsolutePath(await realpath(original), "canonical verification root");
  if (pathKey(original) !== pathKey(canonical)) {
    assert(process.platform === "win32", "verification root alias is not an approved Windows SUBST drive");
    const drive = path.parse(original).root;
    assert(/^[A-Za-z]:\\$/u.test(drive), "verification root alias must use a local drive");
    // Only the ASCII drive prefix is decoded. The mapped target may contain
    // Unicode under an OEM console codepage; native realpath supplies its exact
    // identity instead. A drive mapping alone never grants owner containment.
    const mappings = execFileSync(path.join(process.env.SystemRoot, "System32", "subst.exe"), [], { windowsHide: true, maxBuffer: 128 * 1024 }).toString("latin1");
    const prefix = `${drive}: => `.toLowerCase();
    assert(mappings.split(/\r?\n/u).some(line => line.slice(0, prefix.length).toLowerCase() === prefix), "verification root alias is not an approved Windows SUBST drive");
    await ordinaryDirectory(canonical);
    assert(pathKey(await realpath(original)) === pathKey(canonical), "verification root alias changed during resolution");
  }
  return canonical;
}
export async function verificationExecutionRoot(context) {
  const executionRoot = localAbsolutePath(context.executionRoot, "verification execution root");
  assert(pathKey(await canonicalVerificationRoot(executionRoot)) === pathKey(context.root), "verification execution root changed after validation");
  return executionRoot;
}
async function ordinaryPath(filename, allowMissing = false) {
  let current = path.parse(filename).root;
  const parts = filename.slice(current.length).split(path.sep).filter(Boolean);
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    let info;
    try { info = await lstat(current); } catch (error) {
      if (allowMissing && error.code === "ENOENT") return false;
      throw error;
    }
    assert(!info.isSymbolicLink() && (index === parts.length - 1 ? info.isFile() : info.isDirectory()), `relocation path is not ordinary: ${current}`);
  }
  assert(pathKey(await realpath(filename)) === pathKey(filename), `relocation path resolves elsewhere: ${filename}`);
  return true;
}
async function relocatedBytes(entry) {
  await ordinaryPath(entry.to);
  const bytes = await fileBytes(entry.to);
  assert(sha(bytes) === entry.sha256, `relocated evidence hash changed: ${entry.to}`);
  return bytes;
}
async function evidenceReadContext(reference, base, inherited) {
  if (reference === undefined) return inherited;
  shape(reference, ["path", "sha256"], [], "evidence relocation manifest pin");
  assert(!/^[\\/]{2}/u.test(text(reference.path, "evidence relocation manifest path")), "evidence relocation manifest path must be a local absolute path");
  localAbsolutePath(refPath(base, reference.path), "evidence relocation manifest path");
  const pinned = await pinnedFile(reference, base, inherited);
  await ordinaryPath(pinned.path, inherited?.entries.has(pathKey(pinned.path)) ?? false);
  assert(pinned.bytes.length <= 4 * 1024 * 1024, "evidence relocation manifest exceeds its bound");
  const manifest = JSON.parse(pinned.bytes.toString("utf8"));
  shape(manifest, ["schemaVersion", "kind", "sourceRoot", "archiveRoot", "files"], [], "evidence relocation manifest");
  assert(manifest.schemaVersion === 1 && manifest.kind === "kaigen-evidence-relocations", "unsupported evidence relocation schema");
  const sourceRoot = localAbsolutePath(manifest.sourceRoot, "relocation source root");
  const archiveRoot = localAbsolutePath(manifest.archiveRoot, "relocation archive root");
  const project = path.dirname(path.dirname(sourceRoot));
  assert(pathKey(sourceRoot) === pathKey(path.join(project, "context.local", "state"))
    && pathKey(archiveRoot) === pathKey(path.join(project, "local-data", "context-history", "KOP-v1", "CTX-02", "archive", "state")), "unapproved evidence relocation roots");
  assert(insideRoot(project, pinned.path), "evidence relocation manifest must stay inside its project");
  assert(!inherited || (pathKey(sourceRoot) === pathKey(inherited.sourceRoot) && pathKey(archiveRoot) === pathKey(inherited.archiveRoot)), "nested evidence relocation roots changed");
  assert(Array.isArray(manifest.files) && manifest.files.length > 0 && manifest.files.length <= 4096, "invalid evidence relocation file list");
  const entries = new Map(inherited?.entries), sources = new Set(), targets = new Set();
  for (const file of manifest.files) {
    shape(file, ["from", "to", "sha256"], [], "evidence relocation file");
    assert(HASH.test(file.sha256), "invalid evidence relocation SHA-256");
    const from = localAbsolutePath(file.from, "relocation source");
    const to = localAbsolutePath(file.to, "relocation target");
    assert(insideRoot(sourceRoot, from) && insideRoot(archiveRoot, to), "evidence relocation is outside its root");
    const sourceKey = pathKey(from), targetKey = pathKey(to);
    assert(!sources.has(sourceKey) && !targets.has(targetKey), "ambiguous evidence relocation mapping");
    sources.add(sourceKey); targets.add(targetKey);
    const previous = entries.get(sourceKey);
    assert(!previous || (pathKey(previous.to) === targetKey && previous.sha256 === file.sha256), "conflicting inherited evidence relocation mapping");
    assert(![...entries].some(([key, entry]) => key !== sourceKey && pathKey(entry.to) === targetKey), "ambiguous inherited evidence relocation target");
    const entry = { from, to, sha256: file.sha256 };
    await ordinaryPath(from, true);
    await relocatedBytes(entry);
    entries.set(sourceKey, entry);
  }
  return { sourceRoot, archiveRoot, entries, identity: sha(Buffer.from(JSON.stringify([inherited?.identity, pinned.path, reference.sha256]))) };
}
async function pinnedFile(reference, base, readContext) {
  shape(reference, ["path", "sha256"], [], "file reference");
  assert(HASH.test(reference.sha256), "invalid file SHA-256");
  const absolute = refPath(base, reference.path);
  const relocation = readContext?.entries.get(pathKey(absolute));
  if (relocation) {
    assert(relocation.sha256 === reference.sha256, `relocation does not match the original file hash: ${absolute}`);
    await ordinaryPath(absolute, true);
  }
  let bytes;
  try { bytes = await fileBytes(absolute); } catch (error) {
    if (error.code !== "ENOENT" || !relocation) throw error;
    bytes = await relocatedBytes(relocation);
  }
  assert(sha(bytes) === reference.sha256, `file hash changed: ${absolute}`);
  // The physical archive is never promoted to the logical reference identity.
  return { path: absolute, bytes };
}
function sourceIdentity(root, source, cache) {
  shape(source, ["commit", "tree"], [], "source identity");
  assert(OBJECT.test(source.commit) && OBJECT.test(source.tree), "source identity must use complete lowercase Git object IDs");
  assert(cache.identity(root, source.commit, "commit").toString("utf8").trim() === source.commit, "source commit does not resolve");
  assert(cache.identity(root, source.commit, "tree").toString("utf8").trim() === source.tree, "source tree does not match commit");
}
export function trackedChanges(root, before, after) {
  const fields = git(root, ["diff", "--raw", "--no-abbrev", "--no-renames", "-z", before, after, "--"]).toString("utf8").split("\0");
  const changes = [];
  for (let i = 0; i < fields.length && fields[i]; i += 2) {
    const match = /^:(\d{6}) (\d{6}) ([a-f0-9]{40}) ([a-f0-9]{40}) [AMDT]$/u.exec(fields[i]);
    assert(match && fields[i + 1], "unsupported tracked diff entry");
    changes.push({ path: fields[i + 1], beforeBlob: match[3], beforeMode: match[1], afterBlob: match[4], afterMode: match[2] });
  }
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}
async function validateInputs(root, source, inputs, base, blobCache, readContext) {
  assert(Array.isArray(inputs) && inputs.length > 0, "every check requires explicit input identities");
  const ids = new Set();
  for (const input of inputs) {
    shape(input, ["id", "kind", "path", "sha256"], ["lines"], "check input");
    assert(!ids.has(text(input.id, "input id")), `duplicate input id ${input.id}`);
    ids.add(input.id);
    assert(HASH.test(input.sha256), `invalid input hash ${input.id}`);
    let bytes;
    if (input.kind === "git") bytes = sourceBlob(root, source, repoPath(input.path), blobCache);
    else {
      assert(input.kind === "file" && input.lines === undefined, `invalid file input ${input.id}`);
      bytes = (await pinnedFile({ path: input.path, sha256: input.sha256 }, base, readContext)).bytes;
    }
    assert(sha(inputBytes(bytes, input.lines)) === input.sha256, `input identity changed: ${input.id}`);
  }
  return inputs.map(({ id, kind, sha256 }) => ({ id, kind, sha256 })).sort((a, b) => a.id.localeCompare(b.id));
}
export function descriptor(id, npmScripts, variant) {
  const webCore = id.startsWith("rust:") && variant === "web-core";
  const variantFlag = variant === undefined ? []
    : id === "frontend:chat-geometry-runtime" && ["menus-only", "filecards-only", "message-visibility-only"].includes(variant) ? ["--", `--${variant}`]
      : ["frontend:localization", "frontend:browser-runtime", "frontend:ui-identity"].includes(id) && variant === "no-qtox" ? ["--", "--no-qtox"]
      : id === "frontend:pq-entropy" && variant === "runtime" ? ["--", "--runtime"] : webCore ? [] : null;
  assert(variantFlag !== null, `unapproved check variant ${id}`);
  if (id === "driver:pq-two-instances") return { stage: "tests", program: "node", args: ["scripts/test-pq-two-instances.mjs", "--self-test"] };
  if (NATIVE.has(id)) return { stage: "native", program: "pwsh", args: ["-NoProfile", "-File", NATIVE.get(id)] };
  if (id.startsWith("frontend:")) {
    const name = `test:${id.slice("frontend:".length)}`;
    assert(npmScripts.has(name), `unapproved frontend check ${id}`);
    return { stage: "tests", program: "npm.cmd", args: ["run", name, ...variantFlag] };
  }
  if (id.startsWith("rust:")) {
    const filter = id.slice("rust:".length);
    assert(filter === "all" || /^[A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)*(?:::)?$/u.test(filter), `unapproved Rust check ${id}`);
    return { stage: "tests", program: "cargo", args: ["test", "--locked", "--offline", "--manifest-path", "src-tauri/Cargo.toml", ...(webCore ? ["--no-default-features", "--features", "web-core"] : []), "--lib", ...(filter === "all" ? [] : [filter]), "--", "--nocapture"] };
  }
  throw new Error(`Incremental verification: unapproved check ID ${id}`);
}
export function validateCommand(command, check, npmScripts) {
  shape(command, ["program", "args"], [], "recorded command");
  assert(Array.isArray(command.args) && command.args.every((arg) => typeof arg === "string"), "invalid recorded command args");
  const expected = descriptor(check.id, npmScripts, check.variant);
  const program = path.win32.basename(command.program).replace(/\.exe$/iu, "").toLowerCase();
  if (expected.program === "npm.cmd") {
    const direct = check.id === "frontend:chat-geometry-runtime" && ["filecards-only", "menus-only", "message-visibility-only"].includes(check.variant)
      ? ["scripts/test-chat-geometry-runtime.mjs", `--${check.variant}`]
      : check.id === "frontend:pq-entropy" && check.variant === "runtime"
        ? ["scripts/test-pq-entropy-ui.mjs", "--runtime"]
        : check.id === "frontend:pq-entropy" && check.variant === undefined
          ? ["scripts/test-pq-entropy-ui.mjs"]
          : check.id === "frontend:component-inventory" && check.variant === undefined
            ? ["scripts/test-component-inventory.mjs"] : null;
    const directMatch = program === "node" && direct && (same(command.args, direct)
      || (check.id === "frontend:pq-entropy" && check.variant === "runtime" && same(command.args, [...direct, "--host-reduced-motion"])));
    assert(directMatch || (["npm", "npm.cmd"].includes(program) && (same(command.args, expected.args) || (check.variant === undefined && same(command.args, ["run", "test:frontend"])))), "recorded npm/direct command does not cover the check");
  } else if (expected.program === "pwsh") {
    assert(program === "pwsh", "recorded native command must be pwsh");
    const normalized = command.args.map((arg) => arg.replaceAll("\\", "/"));
    const ancestor = same(normalized, ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", "scripts/Invoke-KaigenAutomation.ps1", "-Task", "windows-portable"]);
    assert(ancestor || (command.args.length === 3 && command.args[0] === "-NoProfile" && command.args[1] === "-File" && normalized[2].endsWith(expected.args[2])), "recorded native command does not match the check");
    return ancestor;
  } else if (expected.program === "node") {
    assert(program === "node" && same(command.args, expected.args), "recorded driver command does not match the approved self-test");
  } else {
    assert(program === "cargo", "recorded Rust command must be cargo test");
    const args = command.args.filter((arg) => !["--offline", "--nocapture", "--"].includes(arg));
    const expectedArgs = expected.args.filter((arg) => !["--offline", "--nocapture", "--"].includes(arg));
    assert(same(args, expectedArgs) || (check.variant === undefined && same(args, ["test", "--locked", "--manifest-path", "src-tauri/Cargo.toml", "--lib"])), "recorded Rust command does not cover the check");
  }
}
export function rustSummary(output, id) {
  output = output.replaceAll("\r\n", "\n").replace(/\u001b\[[0-9;]*m/gu, "")
    .replace(/^[^\t\n]+\t[^\t\n]+\t\d{4}-\d{2}-\d{2}T[0-9:.]+Z /gmu, "");
  const summaries = [...output.matchAll(/test result: (ok|FAILED)\. (\d+) passed; (\d+) failed;/gu)];
  assert(summaries.length > 0 && summaries.every((match) => match[1] === "ok" && Number(match[3]) === 0), "Rust output lacks a successful test summary");
  assert(summaries.some((match) => Number(match[2]) > 0), "Rust filter selected no passing tests");
  const filter = id.slice("rust:".length);
  if (filter !== "all") {
    const passed = [...output.matchAll(/^test ([A-Za-z0-9_:]+) \.\.\. ok[ \t]*$/gmu)].map((match) => match[1]);
    assert(passed.some((name) => name.includes(filter)), `Rust output contains no passing test for ${id}`);
  }
}
async function validateResult(context, check, reference) {
  const pinned = await pinnedFile(reference, context.planBase, context.readContext);
  const result = JSON.parse(pinned.bytes.toString("utf8"));
  if (result.kind === IMPORTED_RUST_KIND) {
    assert(context.projectOwnerRoot, "imported evidence requires the plan-bound evidence owner root");
    const owner = context.projectOwnerRoot;
    const owned = filename => {
      const absolute = localAbsolutePath(filename, "imported evidence path");
      assert([path.join(owner, "outputs"), path.join(owner, "context.local", "work")].some(root => insideRoot(root, absolute)), "imported evidence escapes its owner evidence roots");
      return absolute;
    };
    await ordinaryPath(owned(pinned.path));
    const read = async pin => {
      const filename = owned(refPath(path.dirname(pinned.path), pin.path));
      await ordinaryPath(filename);
      return pinnedFile({ ...pin, path: filename }, context.planBase, context.readContext);
    };
    const modes = (root, source) => new Map(git(root, ["ls-tree", "-r", "-z", source.commit]).toString("utf8").split("\0").filter(Boolean).map(row => {
      const [metadata, filename] = row.split("\t"), [mode, type] = metadata.split(" ");
      assert(type === "blob" && ["100644", "100755"].includes(mode), "imported source tree contains a nonordinary entry");
      return [repoPath(filename), mode];
    }));
    const paths = (root, source) => [...modes(root, source).keys()].sort();
    await validateImportedRustExecution(result, check, {
      read,
      sourceIdentity: async (root, source) => {
        root = owned(root);
        await ordinaryPath(path.join(root, "package.json"));
        sourceIdentity(root, source, context.blobCache);
        const previous = modes(root, source), current = modes(context.referenceRoot, context.plan.productSource);
        for (const [filename, mode] of previous) assert(!current.has(filename) || current.get(filename) === mode, `source mode changed: ${filename}`);
      },
      sourcePaths: paths,
      sourceBlob: (root, source, filename) => sourceBlob(root, source, repoPath(filename), context.blobCache),
      currentPaths: () => paths(context.referenceRoot, context.plan.productSource),
      currentBlob: filename => sourceBlob(context.referenceRoot, context.plan.productSource, repoPath(filename), context.blobCache),
      freshVersionInventory: context.plan.checks.some(item => item.id === "frontend:component-inventory" && item.action === "run"),
    });
    return { path: pinned.path, sha256: reference.sha256 };
  }
  validateResultHeader(result, check.id);
  if (![context.plan.source, context.plan.productSource, context.plan.baseline.source].some((source) => same(source, result.source))) {
    assertRetainedResult(context.retainedResults, result, { path: pinned.path, sha256: reference.sha256 });
  }
  sourceIdentity(context.referenceRoot, result.source, context.blobCache);
  const observed = await validateInputs(context.referenceRoot, result.source, result.inputs, path.dirname(pinned.path), context.blobCache, context.readContext);
  const expected = context.inputs.get(check.id);
  if (same(observed, expected)) assertMatchingInputs(observed, expected, check.id);
  else {
    // Reuse keeps its old raw input hashes. Root-version equivalence is an
    // additional comparison, never a rewritten result or dependency hash.
    assert(observed.length === expected.length && context.plan.checks.some(item => item.id === "frontend:component-inventory" && item.action === "run") && check.id !== "frontend:component-inventory", `input fingerprint changed: ${check.id}`);
    let packageEquivalent = false;
    if (PACKAGE_ONLY_FRONTEND.has(check.id)) {
      const before = filename => sourceBlob(context.referenceRoot, result.source, filename, context.blobCache);
      const after = filename => sourceBlob(context.referenceRoot, context.plan.source, filename, context.blobCache);
      if (!rootVersionEquivalent("package.json", before("package.json"), after("package.json"))) {
        packageScriptClosureEquivalent(check.id, before("package.json"), after("package.json"), before("package-lock.json"), after("package-lock.json"));
        await validatePackageOnlySourceClosure(check.id, { before, after,
          paths: which => git(context.referenceRoot, ["ls-tree", "-r", "--name-only", "-z", which === "before" ? result.source.commit : context.plan.source.commit]).toString("utf8").split("\0").filter(Boolean).sort(),
          absent: async names => { for (const name of names) { try { await lstat(path.join(context.root, name)); assert(false, `legacy source path is present: ${name}`); } catch (error) { if (error.code !== "ENOENT") throw error; } } },
        });
        packageEquivalent = true;
      }
    }
    for (let index = 0; index < observed.length; index += 1) {
      if (same(observed[index], expected[index])) continue;
      const before = result.inputs.find(input => input.id === observed[index].id), after = check.inputs.find(input => input.id === observed[index].id);
      const beforeBytes = before?.kind === "git" ? sourceBlob(context.referenceRoot, result.source, before.path, context.blobCache) : null;
      const afterBytes = after?.kind === "git" ? sourceBlob(context.referenceRoot, context.plan.source, after.path, context.blobCache) : null;
      const windowsRustEquivalent = context.windowsTargetSourceEquivalence && check.id.startsWith("rust:")
        && same(result.source, context.plan.productSource) && before?.path === WINDOWS_LIB_TARGET.path
        && after?.path === WINDOWS_LIB_TARGET.path && sha(beforeBytes) === WINDOWS_LIB_TARGET.beforeSha256
        && sha(afterBytes) === WINDOWS_LIB_TARGET.afterSha256;
      assert(before && after && before.kind === "git" && after.kind === "git" && before.path === after.path && before.lines === undefined && after.lines === undefined && observed[index].id === expected[index].id
        && ((packageEquivalent && before.path === "package.json") || windowsRustEquivalent || rootVersionEquivalent(before.path, beforeBytes, afterBytes)), `input fingerprint changed: ${check.id}`);
    }
  }
  const nativeAncestor = validateCommand(result.command, check, context.npmScripts);
  if (nativeAncestor) {
    const wrapper = sourceBlob(context.referenceRoot, result.source, "scripts/Invoke-KaigenAutomation.ps1", context.blobCache).toString("utf8");
    const block = /^    'windows-portable' \{([\s\S]*?)^    \}/mu.exec(wrapper)?.[1] || "";
    assert(block.includes("& (Join-Path $PSScriptRoot 'build-portable.ps1') @arguments"), "historical wrapper does not invoke the Windows build");
    const producer = sourceBlob(context.referenceRoot, result.source, "scripts/build-portable.ps1", context.blobCache).toString("utf8");
    const scriptName = path.posix.basename(NATIVE.get(check.id));
    const invocations = [
      `& pwsh -NoProfile -File ${NATIVE.get(check.id)}`,
      `& (Join-Path $PSScriptRoot "${scriptName}")`,
      `& (Join-Path $PSScriptRoot '${scriptName}')`,
    ];
    assert(producer.split(/\r?\n/u).some((line) => invocations.includes(line.trim())), "historical Windows build does not invoke the native check");
  }
  shape(result.output, ["path", "sha256"], ["lines"], "test output");
  const output = await pinnedFile({ path: result.output.path, sha256: result.output.sha256 }, path.dirname(pinned.path), context.readContext);
  const selected = inputBytes(output.bytes, result.output.lines).toString("utf8");
  assert(selected.trim().length > 0, `test output is empty: ${check.id}`);
  if (NATIVE.has(check.id)) assert(NATIVE_MARKERS.get(check.id).some((markers) => markers.every((marker) => selected.includes(marker))), `native output lacks its passing check markers: ${check.id}`);
  if (check.id === "driver:pq-two-instances") assert(selected.includes("PQ two-instance harness self-test passed"), "PQ driver output lacks its self-test result");
  if (check.id.startsWith("rust:")) {
    assert(check.id !== "rust:all" || same(result.source, context.plan.source) || same(result.source, context.plan.productSource), "old full Rust baseline cannot stand in for the changed candidate; enumerate unchanged families");
    rustSummary(selected, check.id);
  }
  for (const name of ["startedAt", "completedAt"]) assert(Number.isFinite(Date.parse(result[name])), `invalid result timestamp ${name}`);
  return { path: pinned.path, sha256: reference.sha256 };
}
export function validateResultHeader(result, id) {
  shape(result, ["schemaVersion", "kind", "checkId", "status", "source", "inputs", "command", "exitCode", "output", "startedAt", "completedAt"], [], "check result");
  assert(result.schemaVersion === 1 && result.kind === RESULT_KIND && result.checkId === id && result.status === "PASS" && result.exitCode === 0, `check result is not PASS: ${id}`);
}
export function assertFilecardExecutionProof(proof, result) {
  assert(proof.kind === "kaigen-completed-filecard-actual-app-regression" && proof.status === "PASS"
    && proof.source?.commit === result.source.commit && proof.source?.tree === result.source.tree
    && proof.green?.exitCode === 0 && proof.green?.actualAppRendered === true && proof.green?.assertions === 36
    && proof.green?.cases?.length === 16 && proof.green?.command === "node scripts/test-chat-geometry-runtime.mjs --filecards-only"
    && Array.isArray(proof.source.inputs) && proof.source.inputs.length >= 5 && Array.isArray(proof.evidence), "retained filecard execution is not the original actual-App PASS");
}
export function assertSourceRepresentation(source, recorded, expectedHash) {
  assert(sha(recorded) === expectedHash.toLowerCase() && sha(Buffer.from(recorded.toString("utf8").replaceAll("\r\n", "\n"))) === sha(source), "original source representation does not match the recorded hash and Git bytes");
}
async function validateAttachments(context) {
  const attachments = context.plan.attachments ?? [];
  assert(Array.isArray(attachments) && attachments.length <= 8, "invalid plan attachments");
  for (const attachment of attachments) {
    shape(attachment, ["kind", "proof"], ["sourceRepresentations"], "plan attachment");
    assert(attachment.kind === "filecard-actual-app", "unapproved plan attachment");
    const pinned = await pinnedFile(attachment.proof, context.planBase, context.readContext);
    const proof = JSON.parse(pinned.bytes.toString("utf8"));
    assertFilecardExecutionProof(proof, { source: context.plan.productSource });
    const representations = new Map();
    assert(Array.isArray(attachment.sourceRepresentations ?? []), "invalid source representations");
    for (const representation of attachment.sourceRepresentations ?? []) {
      shape(representation, ["sourcePath", "file"], [], "source representation");
      assert(!representations.has(representation.sourcePath) && proof.source.inputs.some(input => input.path === representation.sourcePath), "unbound or duplicate source representation");
      representations.set(representation.sourcePath, await pinnedFile(representation.file, context.planBase, context.readContext));
    }
    for (const input of proof.source.inputs) {
      const bytes = sourceBlob(context.referenceRoot, context.plan.source, repoPath(input.path), context.blobCache);
      if (sha(bytes) !== input.sha256.toLowerCase()) {
        const original = representations.get(input.path);
        assert(original, "original filecard source representation is missing");
        assertSourceRepresentation(bytes, original.bytes, input.sha256);
      }
    }
    for (const evidence of proof.evidence) await pinnedFile({ path: evidence.path, sha256: evidence.sha256.toLowerCase() }, path.dirname(pinned.path), context.readContext);
  }
}
export function assertMatchingInputs(observed, expected, id) {
  assert(same(observed, expected), `reused inputs do not match candidate: ${id}`);
}

export function assertAcceptedVersionDeclaration(entry, baseline, product, checks) {
  const ordered = value => Array.isArray(value) ? value.map(ordered) : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value;
  assert(same(ordered(entry), ordered(ACCEPTED_VERSION_BASELINE)), "accepted version baseline is not the exact reviewed declaration");
  assert(same(baseline, ACCEPTED_VERSION_BASELINE.baselineSource) && same(product, ACCEPTED_VERSION_BASELINE.productSource), "accepted version baseline source identities differ");
  for (const id of FRESH_VERSION_CHECKS) assert(checks.some(check => check.id === id && check.action === "run" && !Object.hasOwn(check, "evidence")), `accepted version baseline requires fresh ${id}`);
}
export function assertAcceptedVersionDelta(changes, before, after) {
  assert(same(changes.map(change => change.path).sort(), ACCEPTED_VERSION_PATHS), "accepted version baseline requires exactly the eight version paths");
  for (const change of changes) {
    assert(change.beforeMode === change.afterMode && ["100644", "100755"].includes(change.beforeMode), "accepted version baseline source mode changed");
    const oldBytes = before(change.path), newBytes = after(change.path);
    assert(rootVersionEquivalent(change.path, oldBytes, newBytes), `accepted version baseline contains a non-version change: ${change.path}`);
    const previous = oldBytes.toString("utf8"), expected = previous.replaceAll('"0.2.9+5"', '"0.2.9+6"').replaceAll('"0.2.9.5"', '"0.2.9.6"');
    assert(expected !== previous && newBytes.equals(Buffer.from(expected)), `accepted version baseline contains an unknown version transition: ${change.path}`);
  }
}
function fullSourceTree(root, source, cache) {
  const entries = git(root, ["ls-tree", "-r", "-z", source.commit]).toString("utf8").split("\0").filter(Boolean).map(row => {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t([^\0]+)$/u.exec(row);
    assert(match, "accepted source tree contains a nonordinary entry");
    return { path: repoPath(match[3]), mode: match[1], oid: match[2] };
  });
  assert(entries.length === 1605 && new Set(entries.map(entry => entry.path.toLowerCase())).size === 1605, "accepted source inventory must contain all 1605 unique files");
  for (let offset = 0; offset < entries.length; offset += 256) {
    const batch = entries.slice(offset, offset + 256);
    const bytes = git(root, ["cat-file", "--batch"], { input: `${batch.map(entry => entry.oid).join("\n")}\n` });
    let cursor = 0;
    for (const entry of batch) {
      const end = bytes.indexOf(10, cursor), header = bytes.subarray(cursor, end).toString("ascii");
      const match = /^([a-f0-9]{40}) blob (\d+)$/u.exec(header);
      assert(end >= cursor && match && match[1] === entry.oid, "accepted source blob batch identity differs");
      const size = Number(match[2]); cursor = end + 1;
      assert(Number.isSafeInteger(size) && size >= 0 && cursor + size < bytes.length && bytes[cursor + size] === 10, "accepted source blob batch is truncated");
      cache.set(JSON.stringify([root, source.commit, entry.path]), Buffer.from(bytes.subarray(cursor, cursor + size)));
      cursor += size + 1;
    }
    assert(cursor === bytes.length, "accepted source blob batch has extra output");
  }
  return entries;
}
export async function validateAcceptedVersionBaseline(context) {
  const { plan, projectOwnerRoot: owner, referenceRoot, blobCache } = context;
  if (plan.acceptedVersionBaseline === undefined) return undefined;
  assert(owner, "accepted version baseline requires the plan-bound evidence owner root");
  const entry = plan.acceptedVersionBaseline;
  assertAcceptedVersionDeclaration(entry, plan.baseline.source, plan.productSource, plan.checks);
  assert(same(plan.releaseMetadataPaths ?? [], []) || same(plan.releaseMetadataPaths, [RELEASE_METADATA_PATH]), "accepted version baseline has unapproved release metadata paths");
  const read = async reference => {
    const filename = path.resolve(owner, repoPath(reference.path));
    assert(insideRoot(owner, filename), "accepted baseline evidence escapes its owner");
    await ordinaryPath(filename);
    return pinnedFile({ path: filename, sha256: reference.sha256 }, owner);
  };
  const json = async reference => JSON.parse((await read(reference)).bytes.toString("utf8").replace(/^\uFEFF/u, ""));
  await read({ path: entry.publicRef.path, sha256: entry.publicRef.sha256 });
  const resolverPath = path.join(owner, "context.local", "tools", "windows-finish-receipt.mjs");
  await ordinaryPath(resolverPath);
  const { resolveWindowsFinishProjection } = await import(pathToFileURL(resolverPath).href);
  const projection = await resolveWindowsFinishProjection({ projectRoot: owner, transactionId: entry.transactionId, deploymentKind: "local-portable", publicRef: entry.publicRef });
  assert(projection.privatePayloadReads === 0 && same(projection.ref, entry.publicRef)
    && projection.payload.verification.status === "PASS" && projection.payload.verification.protectedDataUnchanged === true && projection.payload.verification.privateDataAbsent === true
    && same(projection.payload.sourceTree, { fileCount: 88, sha256: "d932e34d936316dfb869d1c4d6ee4b56ecf84f205a05e580c0a9f70418d78252" }), "accepted public baseline projection changed");
  const prebuilt = await json(entry.prebuiltEvidence);
  assert(prebuilt.schemaVersion === 1 && prebuilt.documentType === "kaigen-prebuilt-windows-finish-evidence" && prebuilt.transactionId === entry.transactionId && prebuilt.deploymentKind === "local-portable", "accepted prebuilt identity changed");
  const archive = await read({ path: prebuilt.archive.path, sha256: prebuilt.archive.sha256 });
  assert(archive.bytes.length === prebuilt.archive.bytes && same(projection.payload.artifact, { bytes: archive.bytes.length, sha256: prebuilt.archive.sha256 }), "accepted archive differs from the public projection");
  const [inventory, manifest, compile, packaged, native, snapshot, productManifest] = await Promise.all([
    json(prebuilt.sourceInventory), json(prebuilt.sourceManifest), json(prebuilt.compileReceipt), json(prebuilt.packageReceipt), json(prebuilt.nativeReceipt),
    json(entry.productSnapshot.build), read(entry.productSnapshot.manifest),
  ]);
  await read(prebuilt.sourceArchive);
  await read(entry.productSnapshot.archive);
  assert(manifest.tree === plan.baseline.source.tree && manifest.files === 1605 && manifest.sourceZipSha256.toLowerCase() === prebuilt.sourceArchive.sha256
    && compile.sourceInventorySha256 === inventory.sha256 && compile.coordinatorManifestSha256.toLowerCase() === prebuilt.sourceManifest.sha256
    && packaged.archiveSha256 === prebuilt.archive.sha256 && packaged.sourceInventorySha256 === inventory.sha256
    && packaged.compileReceiptSha256 === prebuilt.compileReceipt.sha256 && packaged.sourceZipSha256 === prebuilt.sourceArchive.sha256
    && native.status === "PASS" && native.executableSha256 === packaged.productionExeSha256 && native.actualPortableRootIsExecutableDirectory === true,
  "accepted original source, package or native acceptance binding differs");
  assert(snapshot.head === plan.productSource.commit && snapshot.tree === plan.productSource.tree && snapshot.files === 1605
    && snapshot.canonicalManifestSha256.toLowerCase() === entry.productSnapshot.manifest.sha256 && snapshot.sourceZipSha256.toLowerCase() === entry.productSnapshot.archive.sha256
    && snapshot.privacyForbiddenMatches === 0 && snapshot.windowsIndexMatchesSnapshot === true, "release product snapshot binding differs");
  const baselineTree = fullSourceTree(referenceRoot, plan.baseline.source, blobCache), productTree = fullSourceTree(referenceRoot, plan.productSource, blobCache);
  assert(same(baselineTree.map(({ path, mode }) => ({ path, mode })), productTree.map(({ path, mode }) => ({ path, mode }))), "accepted source paths or modes changed");
  assert(Array.isArray(inventory.files) && inventory.files.length === 1605 && sha(Buffer.from(inventory.files.map(file => `${file.path}\t${file.size}\t${file.sha256}\n`).join(""))) === inventory.sha256, "accepted raw inventory digest differs");
  const productFiles = productManifest.bytes.toString("utf8").replace(/^\uFEFF/u, "").split(/\r?\n/u).filter(Boolean).map(row => {
    const match = /^([a-fA-F0-9]{64})\t(\d+)\t([^\t\r\n]+)$/u.exec(row);
    assert(match, "invalid release source manifest row");
    return { path: repoPath(match[3]), size: Number(match[2]), sha256: match[1].toLowerCase() };
  });
  const baselineRoot = path.join(owner, "outputs", "message-visibility-20260928-r2", "windows", "source");
  assert(pathKey(path.resolve(compile.sourceRoot)) === pathKey(baselineRoot), "accepted original source root differs");
  const validateInventory = async (files, tree, source, sourceRoot) => {
    assert(same(files.map(file => file.path).sort(), tree.map(file => file.path).sort()), "accepted source inventory is incomplete or duplicated");
    for (const file of files) {
      shape(file, ["path", "size", "sha256"], [], "accepted source inventory entry");
      assert(Number.isSafeInteger(file.size) && file.size >= 0 && HASH.test(file.sha256), "invalid accepted source size or hash");
      const filename = path.join(sourceRoot, repoPath(file.path));
      await ordinaryPath(filename);
      const raw = await fileBytes(filename), original = sourceBlob(referenceRoot, source, file.path, blobCache);
      assert(raw.length === file.size && sha(raw) === file.sha256, `accepted source raw bytes changed: ${file.path}`);
      assert(raw.equals(original) || (!raw.includes(0) && Buffer.from(raw.toString("utf8").replaceAll("\r\n", "\n")).equals(original)), `accepted source differs from its Git tree: ${file.path}`);
    }
  };
  await validateInventory(inventory.files, baselineTree, plan.baseline.source, baselineRoot);
  await validateInventory(productFiles, productTree, plan.productSource, path.join(owner, "outputs", "release-v0.2.9.6-434e6553", "windows", "source"));
  assertAcceptedVersionDelta(trackedChanges(referenceRoot, plan.baseline.source.commit, plan.productSource.commit),
    name => sourceBlob(referenceRoot, plan.baseline.source, name, blobCache), name => sourceBlob(referenceRoot, plan.productSource, name, blobCache));
  return { status: "REUSED_ACCEPTED_BASELINE", source: plan.baseline.source, publicRef: entry.publicRef, prebuiltEvidence: entry.prebuiltEvidence,
    productSnapshot: entry.productSnapshot, newTestsExecuted: false,
    inheritedFrontendChecks: [...context.npmScripts].map(name => `frontend:${name.slice(5)}`).filter(id => !plan.checks.some(check => check.id === id)).sort() };
}
export function validateDeclaredChanges(changes, actual, ids) {
  assert(Array.isArray(changes), "tracked diff map is required");
  const declared = changes.map((change) => {
    shape(change, ["path", "beforeBlob", "beforeMode", "afterBlob", "afterMode", "checkIds", "reason"], [], "changed path");
    text(change.reason, "changed-path reason");
    assert(Array.isArray(change.checkIds) && change.checkIds.length > 0 && change.checkIds.every((id) => ids.has(id)), `changed path has incomplete check coverage: ${change.path}`);
    return Object.fromEntries(["path", "beforeBlob", "beforeMode", "afterBlob", "afterMode"].map((key) => [key, change[key]]));
  }).sort((a, b) => a.path.localeCompare(b.path));
  assert(same(declared, actual), "plan must cover the complete exact baseline-to-candidate tracked diff");
}
export function validateReleaseMetadata(before, after, oldVersion, newVersion) {
  const publicVersion = value => {
    assert(typeof value === "string" && /^\d+\.\d+\.\d+(?:\+\d+|\.\d+)?$/u.test(value), "invalid release metadata version transition");
    return value.replace("+", ".");
  };
  oldVersion = publicVersion(oldVersion); newVersion = publicVersion(newVersion);
  assert(oldVersion !== newVersion, "invalid release metadata version transition");
  const fields = [
    ["KAIGEN_RELEASE_LABEL: ", ""], ["KAIGEN_WEB_BUILD_ID: kaigen-", ""],
    ["name: Kaigen-Web-Debian13-Nginx-", ""],
    ["artifacts/Kaigen-Web-Debian13-Nginx-", ".tar.gz"],
    ["artifacts/Kaigen-Web-Installer-", ".sh"],
  ];
  let expected = before;
  for (const [prefix, suffix] of fields) {
    const oldValue = `${prefix}${oldVersion}${suffix}`;
    assert(expected.split(oldValue).length === 2, `release metadata field is missing or ambiguous: ${prefix}`);
    expected = expected.replace(oldValue, `${prefix}${newVersion}${suffix}`);
  }
  assert(expected === after, "release metadata contains changes beyond the five version labels");
}
export function bindRetainedSource(source, results) {
  shape(source, ["commit", "tree"], [], "retained source");
  assert(OBJECT.test(source.commit) && OBJECT.test(source.tree), "retained source requires exact identity");
  const matches = results.filter(({ result }) => same(result.source, source));
  assert(matches.length > 0, "retained source is not bound to any verified prior result");
  return matches.map(({ reference, result }) => ({ path: path.resolve(reference.path), sha256: reference.sha256, checkId: result.checkId, source: result.source }));
}
export function assertRetainedResult(bindings, result, reference) {
  assert(bindings.some(binding => binding.path === path.resolve(reference.path)
    && binding.sha256 === reference.sha256 && binding.checkId === result.checkId
    && same(binding.source, result.source)), "retained result is not the immutable result bound by prior proof");
}
async function validateRetainedSources(plan, planBase, referenceRoot, provenance, readContext) {
  const entries = plan.retainedSources ?? [];
  assert(Array.isArray(entries) && entries.length <= 8, "invalid retained source list");
  const bindings = [], seen = new Set();
  for (const entry of entries) {
    shape(entry, ["source", "verification"], [], "retained source entry");
    sourceIdentity(referenceRoot, entry.source, provenance.immutableGitReads);
    assert(!seen.has(entry.source.commit), "duplicate retained source");
    seen.add(entry.source.commit);
    const proof = entry.verification;
    shape(proof, ["receipt", "plan", "archive", "projectRoot", "referenceRoot"], [], "retained verification proof");
    for (const pin of [proof.receipt, proof.plan, proof.archive]) {
      shape(pin, ["path", "sha256"], [], "retained proof pin");
      assert(HASH.test(pin.sha256), "retained proof requires exact hashes");
    }
    const receiptPath = refPath(planBase, proof.receipt.path);
    const options = { receiptPath, receiptSha256: proof.receipt.sha256, planPath: refPath(planBase, proof.plan.path), planSha256: proof.plan.sha256,
      archivePath: refPath(planBase, proof.archive.path), projectRoot: refPath(planBase, proof.projectRoot), referenceRoot: refPath(planBase, proof.referenceRoot) };
    const key = JSON.stringify([proof.receipt.sha256, proof.archive.sha256, options, readContext?.identity]);
    let checked = provenance.proofs.get(key);
    if (!checked) {
      assert(!provenance.active.has(receiptPath) && provenance.active.size < 8, "cyclic or excessive retained proof chain");
      provenance.active.add(receiptPath);
      try {
        await pinnedFile(proof.receipt, planBase, readContext);
        const receipt = await verifyFinalReceiptInternal(options, provenance, readContext);
        assert(receipt.archive.sha256 === proof.archive.sha256, "retained archive identity changed");
        checked = [];
        for (const item of receipt.checks) {
          const pin = await pinnedFile(item.result, path.dirname(receiptPath), readContext);
          checked.push({ reference: { path: pin.path, sha256: item.result.sha256 }, result: JSON.parse(pin.bytes.toString("utf8")) });
        }
        provenance.proofs.set(key, checked);
      } finally { provenance.active.delete(receiptPath); }
    }
    bindings.push(...bindRetainedSource(entry.source, checked));
  }
  return bindings;
}

async function validateAffectedOnly0297(context) {
  const { plan, planBase, referenceRoot, blobCache, npmScripts, readContext } = context;
  const declaration = plan.affectedOnly;
  if (declaration === undefined) return undefined;
  shape(declaration, ["kind", "baselineReleaseManifest", "adjunctCheckIds"], [], "affected-only declaration");
  let successor = false;
  if (same(plan.productSource, plan.source) && plan.source.commit !== AFFECTED_ONLY_0297.productCommit) {
    sourceIdentity(referenceRoot, AFFECTED_ONLY_0297.successorProductSource, blobCache);
    const changedPaths = trackedChanges(referenceRoot, AFFECTED_ONLY_0297.successorProductSource.commit, plan.source.commit).map(change => change.path).sort();
    assert(same(changedPaths, [...AFFECTED_ONLY_0297.successorVerificationPaths].sort()), "successor verification source changes exceed the reviewed verification files");
    successor = true;
  }
  assert(declaration.kind === AFFECTED_ONLY_0297.kind
    && plan.baseline.source.commit === AFFECTED_ONLY_0297.baselineCommit
    && (plan.productSource.commit === AFFECTED_ONLY_0297.productCommit || successor)
    && same(declaration.adjunctCheckIds, AFFECTED_ONLY_0297.adjunctCheckIds), "affected-only scope is not the reviewed v0.2.9.7 release");
  const pinned = await pinnedFile(declaration.baselineReleaseManifest, planBase, readContext);
  const published = JSON.parse(pinned.bytes.toString("utf8"));
  assert(published.schemaVersion === 1 && published.version === "0.2.9.6" && published.tag === "v0.2.9.6"
    && published.releaseCommit === plan.baseline.source.commit && published.releaseTree === plan.baseline.source.tree
    && published.windowsCiRun > 0 && published.windowsCiAttempt > 0,
  "affected-only baseline is not the published prior release");
  const catalog = JSON.parse(sourceBlob(referenceRoot, plan.baseline.source, "ci/verification-v0.2.9.json", blobCache).toString("utf8"));
  assert(catalog.schemaVersion === 1 && catalog.kind === "kaigen-ci-incremental-selection" && catalog.version === "0.2.9+6"
    && catalog.productSource?.commit === published.productBuiltFromCommit
    && catalog.productSource?.tree === published.productBuiltFromTree
    && Array.isArray(catalog.checks) && catalog.checks.length === 86,
  "affected-only catalog differs from the prior published CI selection");
  const mandatory = [...NATIVE.keys(), ...[...npmScripts].map(name => `frontend:${name.slice(5)}`)];
  const catalogChecks = new Map(catalog.checks.map(check => [check.id, check]));
  assert(mandatory.length === 42 && new Set(mandatory).size === 42
    && mandatory.every(id => catalogChecks.has(id)), "affected-only mandatory check catalog differs");
  const selected = new Map(plan.checks.map(check => [check.id, check]));
  const adjunct = new Set(declaration.adjunctCheckIds);
  const required = new Set(AFFECTED_ONLY_0297.requiredCheckIds);
  const sharedInputOnly = new Set(AFFECTED_ONLY_0297.omittedSharedInputChecks);
  const affected = [], omitted = [], sharedInputOmitted = [];
  for (const id of mandatory) {
    const catalogCheck = catalogChecks.get(id);
    const inputs = catalog.inputSets?.[catalogCheck.inputSet];
    assert(Array.isArray(inputs) && inputs.length > 0 && inputs.every(input => input.kind === "git"), `prior CI input set is incomplete: ${id}`);
    let changed = false;
    for (const input of inputs) {
      let before, after;
      try {
        before = sourceBlob(referenceRoot, plan.baseline.source, repoPath(input.path), blobCache);
        after = sourceBlob(referenceRoot, plan.productSource, repoPath(input.path), blobCache);
      } catch { changed = true; break; }
      if (sha(inputBytes(before, input.lines)) === sha(inputBytes(after, input.lines))) continue;
      if (input.lines === undefined && rootVersionEquivalent(input.path, before, after)) continue;
      changed = true;
      break;
    }
    const check = selected.get(id);
    if (required.has(id) || adjunct.has(id)) {
      assert(changed || adjunct.has(id), `reviewed affected check no longer has changed inputs: ${id}`);
      assert(check?.action === "run" && !Object.hasOwn(check, "evidence"), `affected check must run: ${id}`);
      for (const input of inputs) {
        const current = check.inputs.find(item => item.id === input.id);
        assert(current && current.kind === "git" && current.path === input.path && same(current.lines, input.lines), `affected check dropped a catalog input: ${id}/${input.id}`);
      }
      affected.push(id);
    } else {
      assert(!check, `unaffected check was unnecessarily selected: ${id}`);
      if (changed) {
        assert(sharedInputOnly.has(id), `changed check lacks reviewed scope disposition: ${id}`);
        sharedInputOmitted.push(id);
      } else omitted.push(id);
    }
  }
  assert(same(sharedInputOmitted.sort(), [...sharedInputOnly].sort()), "reviewed shared-input omission changed");
  const allowed = new Set([...affected, ...adjunct]);
  assert([...selected.keys()].every(id => allowed.has(id)), "affected-only plan contains an unrelated check");
  for (const id of adjunct) assert(selected.get(id)?.action === "run", `adjunct check is missing: ${id}`);
  for (const id of ["frontend:localization", "frontend:browser-runtime", "frontend:ui-identity"]) {
    assert(selected.get(id)?.variant === "no-qtox", `v0.2.9.7 must exclude qTox compatibility assertions: ${id}`);
  }
  assert(selected.get("frontend:chat-geometry-runtime")?.variant === "message-visibility-only",
    "v0.2.9.7 geometry check must use the affected message-visibility scenario");
  assert(selected.get("rust:local_message_deletion")?.variant === undefined
    && selected.get("rust:local_message_deletion")?.inputs.some(input => input.path === "src-tauri/src/message_deletion.rs"),
  "affected-only Rust check is not bound to local deletion");
  return { kind: declaration.kind, baselineReleaseManifest: declaration.baselineReleaseManifest,
    publishedSource: plan.baseline.source, productSource: plan.productSource,
    affected: affected.sort(), omitted: omitted.sort(), sharedInputOmitted,
    adjunct: [...adjunct].sort() };
}

export async function validatePlan(options) {
  return validatePlanInternal(options, { proofs: new Map(), active: new Set(), immutableGitReads: createImmutableGitReadCache() });
}
async function validatePlanInternal({ planPath, planSha256, projectRoot, referenceRoot = projectRoot }, provenance, inheritedReads) {
  assert(HASH.test(planSha256), "expected plan SHA-256 is required");
  const executionRoot = localAbsolutePath(path.resolve(projectRoot), "verification execution root");
  const root = await canonicalVerificationRoot(executionRoot);
  referenceRoot = await canonicalVerificationRoot(referenceRoot);
  const pinned = await pinnedFile({ path: path.resolve(planPath), sha256: planSha256 }, root, inheritedReads);
  const plan = JSON.parse(pinned.bytes.toString("utf8"));
  shape(plan, ["schemaVersion", "kind", "source", "productSource", "baseline", "testOnlyPaths", "changes", "checks"], ["releaseMetadataPaths", "retainedSources", "attachments", "evidenceRelocations", "evidenceOwnerRoot", "acceptedVersionBaseline", "uiAnnotationMetadataEquivalence", "windowsTargetSourceEquivalence", "affectedOnly"], "verification plan");
  assert(plan.schemaVersion === 1 && plan.kind === PLAN_KIND, "unsupported plan schema");
  const planBase = path.dirname(pinned.path);
  let projectOwnerRoot;
  if (plan.evidenceOwnerRoot !== undefined) {
    projectOwnerRoot = localAbsolutePath(plan.evidenceOwnerRoot, "evidence owner root");
    await ordinaryPath(path.join(projectOwnerRoot, "KaigenToxClient", "package.json"));
    const ownedSource = filename => pathKey(filename) === pathKey(path.join(projectOwnerRoot, "KaigenToxClient")) || insideRoot(path.join(projectOwnerRoot, "outputs"), filename) || insideRoot(path.join(projectOwnerRoot, "context.local", "work"), filename);
    assert(ownedSource(root) && ownedSource(referenceRoot) && (insideRoot(path.join(projectOwnerRoot, "outputs"), pinned.path) || insideRoot(path.join(projectOwnerRoot, "context.local", "work"), pinned.path)), "plan/source roots disagree with the declared evidence owner");
  }
  const readContext = await evidenceReadContext(plan.evidenceRelocations, planBase, inheritedReads);
  sourceIdentity(referenceRoot, plan.source, provenance.immutableGitReads);
  sourceIdentity(referenceRoot, plan.productSource, provenance.immutableGitReads);
  assert(gitText(referenceRoot, ["rev-parse", "HEAD"]) === plan.source.commit, "plan does not match the canonical verification revision");
  const materialization = { commit: gitText(root, ["rev-parse", "HEAD"]), tree: gitText(root, ["rev-parse", "HEAD^{tree}"]) };
  assert(materialization.tree === plan.source.tree, "materialized checkout tree does not match the verification source");
  assert(gitText(root, ["status", "--porcelain=v1", "--untracked-files=all"]) === "", "verification checkout must be clean");
  assert(gitText(referenceRoot, ["status", "--porcelain=v1", "--untracked-files=all"]) === "", "canonical verification checkout must be clean");
  shape(plan.baseline, ["source", "evidence"], [], "baseline");
  sourceIdentity(referenceRoot, plan.baseline.source, provenance.immutableGitReads);
  assert(Array.isArray(plan.baseline.evidence) && plan.baseline.evidence.length > 0, "baseline evidence is required");
  for (const evidence of plan.baseline.evidence) await pinnedFile(evidence, planBase, readContext);
  assert(Array.isArray(plan.testOnlyPaths) && plan.testOnlyPaths.every((name) => TEST_ONLY_PATHS.has(name)), "unapproved test-only equivalence path");
  const metadataPaths = plan.releaseMetadataPaths ?? [];
  assert(same(metadataPaths, []) || same(metadataPaths, [RELEASE_METADATA_PATH]), "unapproved release metadata equivalence path");
  const verificationDiff = trackedChanges(referenceRoot, plan.productSource.commit, plan.source.commit);
  let uiAnnotationMetadataEquivalence;
  const annotationPaths = [];
  if (plan.uiAnnotationMetadataEquivalence !== undefined) {
    const entry = verificationDiff.find(change => change.path === UI_ANNOTATION_METADATA.path);
    assert(entry && entry.beforeMode === "100644" && entry.afterMode === "100644", "UI annotation equivalence requires an ordinary changed catalog");
    uiAnnotationMetadataEquivalence = validateUiAnnotationMetadata(plan.uiAnnotationMetadataEquivalence,
      sourceBlob(referenceRoot, plan.productSource, UI_ANNOTATION_METADATA.path, provenance.immutableGitReads),
      sourceBlob(referenceRoot, plan.source, UI_ANNOTATION_METADATA.path, provenance.immutableGitReads), plan.checks);
    annotationPaths.push(UI_ANNOTATION_METADATA.path);
  }
  let windowsTargetSourceEquivalence;
  const windowsTargetPaths = [];
  if (plan.windowsTargetSourceEquivalence !== undefined) {
    assert(same(plan.productSource, WINDOWS_LIB_TARGET.builtFrom), "Windows target equivalence requires the actual built-from source");
    const entry = verificationDiff.find(change => change.path === WINDOWS_LIB_TARGET.path);
    const proof = plan.baseline.evidence.find(item => item.sha256?.toLowerCase() === WINDOWS_LIB_TARGET.priorWindowsReceiptSha256);
    assert(proof, "Windows target equivalence requires the exact prior Windows receipt");
    const priorReceipt = await pinnedFile(proof, planBase, readContext);
    windowsTargetSourceEquivalence = validateWindowsLibTarget(plan.windowsTargetSourceEquivalence, entry,
      sourceBlob(referenceRoot, plan.productSource, WINDOWS_LIB_TARGET.path, provenance.immutableGitReads),
      sourceBlob(referenceRoot, plan.source, WINDOWS_LIB_TARGET.path, provenance.immutableGitReads), priorReceipt.bytes);
    windowsTargetPaths.push(WINDOWS_LIB_TARGET.path);
  }
  const verificationChanges = verificationDiff.map(({ path }) => path).sort();
  assert(same(verificationChanges, [...new Set([...plan.testOnlyPaths, ...metadataPaths, ...annotationPaths, ...windowsTargetPaths])].sort()), "product/verification differences exceed declared test and metadata equivalence");
  const packageJson = JSON.parse(git(referenceRoot, ["show", `${plan.source.commit}:package.json`]).toString("utf8"));
  if (metadataPaths.length) {
    const baselinePackage = JSON.parse(git(referenceRoot, ["show", `${plan.baseline.source.commit}:package.json`]).toString("utf8"));
    validateReleaseMetadata(
      git(referenceRoot, ["show", `${plan.productSource.commit}:${RELEASE_METADATA_PATH}`]).toString("utf8"),
      git(referenceRoot, ["show", `${plan.source.commit}:${RELEASE_METADATA_PATH}`]).toString("utf8"),
      baselinePackage.version, packageJson.version,
    );
  }
  const npmScripts = new Set((packageJson.scripts["test:frontend"] || "").split(/\s*&&\s*/u).map((entry) => /^npm run (test:[a-z0-9-]+)$/u.exec(entry)?.[1]).filter(Boolean));
  assert(npmScripts.size > 0, "canonical frontend check catalog is missing");
  assert(Array.isArray(plan.checks) && plan.checks.length > 0, "check coverage is required");
  const retainedResults = await validateRetainedSources(plan, planBase, referenceRoot, provenance, readContext);
  const context = { root, executionRoot, referenceRoot, projectOwnerRoot, materialization, plan, planBase, planPath: pinned.path, planSha256, npmScripts, inputs: new Map(), blobCache: provenance.immutableGitReads, retainedResults, readContext };
  context.uiAnnotationMetadataEquivalence = uiAnnotationMetadataEquivalence;
  context.windowsTargetSourceEquivalence = windowsTargetSourceEquivalence;
  context.acceptedVersionBaseline = await validateAcceptedVersionBaseline(context);
  await validateAttachments(context);
  const ids = new Set();
  for (const check of plan.checks) {
    shape(check, ["id", "action", "reason", "inputs"], ["evidence", "variant"], "planned check");
    descriptor(check.id, npmScripts, check.variant);
    assert(!ids.has(check.id), `duplicate check ${check.id}`);
    ids.add(check.id);
    text(check.reason, "check reason");
    assert(["run", "reuse"].includes(check.action), `missing or invalid evidence disposition ${check.id}`);
    assert((check.action === "reuse") === Object.hasOwn(check, "evidence"), `evidence/action mismatch ${check.id}`);
    context.inputs.set(check.id, await validateInputs(referenceRoot, plan.source, check.inputs, planBase, context.blobCache, readContext));
    if (check.action === "reuse") await validateResult(context, check, check.evidence);
  }
  validateDeclaredChanges(plan.changes, trackedChanges(referenceRoot, plan.baseline.source.commit, plan.source.commit), ids);
  context.affectedOnly = await validateAffectedOnly0297(context);
  // Every retained native regression and frontend suite must be accounted for,
  // whether independently rerun or supported by an unchanged baseline input.
  if (!context.affectedOnly) {
    for (const id of [...NATIVE.keys(), ...(context.acceptedVersionBaseline ? FRESH_VERSION_CHECKS : [...npmScripts].map((name) => `frontend:${name.slice(5)}`))]) assert(ids.has(id), `missing canonical check coverage: ${id}`);
  }
  assert([...ids].some((id) => id.startsWith("rust:")), "Rust evidence coverage is missing");
  return context;
}
async function jsonFile(filename, document) {
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}
async function readProgress(context, receiptPath) {
  try {
    const progress = JSON.parse(await readFile(`${receiptPath}.pending.json`, "utf8"));
    shape(progress, ["planSha256", "source", "checks"], [], "verification progress");
    assert(progress.planSha256 === context.planSha256 && same(progress.source, context.plan.source), "pending verification belongs to another plan/source");
    return progress;
  } catch (error) {
    if (error.code === "ENOENT") return { planSha256: context.planSha256, source: context.plan.source, checks: [] };
    throw error;
  }
}
async function executeCheck(context, check, receiptPath) {
  const command = descriptor(check.id, context.npmScripts, check.variant);
  const safeId = check.id.replace(/[^a-zA-Z0-9_-]/gu, "_");
  const outputPath = path.join(path.dirname(receiptPath), "incremental-checks", `${safeId}.log`);
  const resultPath = path.join(path.dirname(outputPath), `${safeId}.json`);
  await mkdir(path.dirname(outputPath), { recursive: true });
  const startedAt = new Date().toISOString();
  let output = Buffer.alloc(0);
  const program = command.program === "npm.cmd" ? "cmd.exe" : command.program;
  const args = command.program === "npm.cmd" ? ["/d", "/s", "/c", `npm.cmd ${command.args.join(" ")}`] : command.args;
  // Keep the caller's verified ASCII SUBST spelling for native tools. Evidence
  // and source authority still use root; reject a remapped alias before spawn.
  const executionRoot = await verificationExecutionRoot(context);
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd: executionRoot, windowsHide: true, env: { ...process.env, NPM_CONFIG_OFFLINE: "true", CARGO_NET_OFFLINE: "true" } });
    const collect = (chunk) => {
      output = Buffer.concat([output, chunk]);
      if (output.length > 64 * 1024 * 1024) { child.kill(); reject(new Error("Incremental test output exceeded its bound")); }
      process.stdout.write(chunk);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", reject);
    child.on("close", resolve);
  });
  await writeFile(outputPath, output, { flag: "wx" });
  assert(exitCode === 0, `${check.id} failed with exit code ${exitCode}; output=${outputPath}`);
  if (check.id.startsWith("rust:")) rustSummary(output.toString("utf8"), check.id);
  const result = { schemaVersion: 1, kind: RESULT_KIND, checkId: check.id, status: "PASS", source: context.plan.source, inputs: check.inputs.map((input) => input.kind === "file" ? { ...input, path: refPath(context.planBase, input.path) } : input), command: { program: command.program, args: command.args }, exitCode, output: { path: outputPath, sha256: sha(output) }, startedAt, completedAt: new Date().toISOString() };
  await jsonFile(resultPath, result);
  return { path: resultPath, sha256: sha(await readFile(resultPath)) };
}
async function runStage(context, stage, receiptPath) {
  const progress = await readProgress(context, receiptPath);
  for (const check of context.plan.checks) {
    if (descriptor(check.id, context.npmScripts, check.variant).stage !== stage) continue;
    const previous = progress.checks.find(({ id }) => id === check.id);
    if (previous) { await validateResult(context, check, previous.result); continue; }
    const result = check.action === "reuse" ? await validateResult(context, check, check.evidence) : await executeCheck(context, check, receiptPath);
    progress.checks.push({ id: check.id, disposition: check.action === "reuse" ? "reused" : "rerun", result });
    await mkdir(path.dirname(receiptPath), { recursive: true });
    await writeFile(`${receiptPath}.pending.json`, `${JSON.stringify(progress, null, 2)}\n`, "utf8");
  }
}
async function checkedResults(context, checks) {
  assert(Array.isArray(checks) && checks.length === context.plan.checks.length, "verification result coverage is incomplete");
  const ids = new Set();
  for (const item of checks) {
    shape(item, ["id", "disposition", "result"], [], "verified check");
    const check = context.plan.checks.find(({ id }) => id === item.id);
    assert(check && !ids.has(item.id), `unexpected or duplicate result ${item.id}`);
    ids.add(item.id);
    assert(item.disposition === (check.action === "reuse" ? "reused" : "rerun"), `incorrect disposition ${item.id}`);
    if (check.action === "reuse") assert(item.result.sha256 === check.evidence.sha256, `reused result was substituted ${item.id}`);
    await validateResult(context, check, item.result);
  }
}
async function finalize(context, receiptPath, archivePath) {
  const progress = await readProgress(context, receiptPath);
  await checkedResults(context, progress.checks);
  const archive = path.resolve(archivePath);
  const archiveBytes = await fileBytes(archive);
  if (context.windowsTargetSourceEquivalence) assert(sha(archiveBytes) === WINDOWS_LIB_TARGET.archiveSha256, "Windows target artifact differs from the proven built-from archive");
  const receipt = { schemaVersion: 1, kind: RECEIPT_KIND, status: "PASS", fullBaselineRerun: false, plan: { path: context.planPath, sha256: context.planSha256 }, source: context.plan.source, productSource: context.plan.productSource, materialization: context.materialization, baseline: context.plan.baseline, checks: progress.checks, archive: { path: archive, sha256: sha(archiveBytes) }, completedAt: new Date().toISOString() };
  if (context.affectedOnly) receipt.affectedOnly = context.affectedOnly;
  if (context.acceptedVersionBaseline) receipt.acceptedVersionBaseline = context.acceptedVersionBaseline;
  if (context.uiAnnotationMetadataEquivalence) receipt.uiAnnotationMetadataEquivalence = context.uiAnnotationMetadataEquivalence;
  if (context.windowsTargetSourceEquivalence) receipt.windowsTargetSourceEquivalence = context.windowsTargetSourceEquivalence;
  await jsonFile(receiptPath, receipt);
  return receipt;
}
export async function verifyFinalReceipt(options) {
  return verifyFinalReceiptInternal(options, { proofs: new Map(), active: new Set(), immutableGitReads: createImmutableGitReadCache() });
}
async function verifyFinalReceiptInternal(options, provenance, readContext) {
  const context = await validatePlanInternal(options, provenance, readContext);
  const receiptBytes = options.receiptSha256
    ? (await pinnedFile({ path: options.receiptPath, sha256: options.receiptSha256 }, context.planBase, context.readContext)).bytes
    : await fileBytes(path.resolve(options.receiptPath));
  const receipt = JSON.parse(receiptBytes);
  shape(receipt, ["schemaVersion", "kind", "status", "fullBaselineRerun", "plan", "source", "productSource", "materialization", "baseline", "checks", "archive", "completedAt"], ["acceptedVersionBaseline", "uiAnnotationMetadataEquivalence", "windowsTargetSourceEquivalence", "affectedOnly"], "final verification receipt");
  assert(receipt.schemaVersion === 1 && receipt.kind === RECEIPT_KIND && receipt.status === "PASS" && receipt.fullBaselineRerun === false, "final receipt is not an incremental PASS");
  assert(receipt.plan.sha256 === context.planSha256 && path.resolve(receipt.plan.path) === context.planPath && same(receipt.source, context.plan.source) && same(receipt.productSource, context.plan.productSource) && same(receipt.baseline, context.plan.baseline), "final receipt identities do not match the plan");
  assert(same(receipt.materialization, context.materialization), "final receipt belongs to a different source materialization");
  assert(same(receipt.acceptedVersionBaseline, context.acceptedVersionBaseline), "final receipt accepted baseline binding differs");
  assert(same(receipt.uiAnnotationMetadataEquivalence, context.uiAnnotationMetadataEquivalence), "final receipt UI annotation metadata binding differs");
  assert(same(receipt.windowsTargetSourceEquivalence, context.windowsTargetSourceEquivalence), "final receipt Windows target source binding differs");
  assert(same(receipt.affectedOnly, context.affectedOnly), "final receipt affected-only coverage differs");
  assert(path.resolve(receipt.archive.path) === path.resolve(options.archivePath), "final receipt references another archive");
  if (context.windowsTargetSourceEquivalence) assert(receipt.archive.sha256 === WINDOWS_LIB_TARGET.archiveSha256, "final Windows target artifact pin differs");
  await pinnedFile(receipt.archive, context.planBase, context.readContext);
  await checkedResults(context, receipt.checks);
  return receipt;
}
async function main() {
  const [operation, ...argv] = process.argv.slice(2);
  assert(["validate", "run-native", "run-tests", "finalize", "verify-final"].includes(operation), "unknown operation");
  assert(argv.length % 2 === 0, "options must be key/value pairs");
  const args = new Map();
  for (let i = 0; i < argv.length; i += 2) {
    assert(["--plan", "--plan-sha256", "--project-root", "--reference-root", "--receipt", "--archive"].includes(argv[i]) && !args.has(argv[i]), "unknown or duplicate option");
    args.set(argv[i], argv[i + 1]);
  }
  const options = { planPath: text(args.get("--plan"), "plan path"), planSha256: text(args.get("--plan-sha256"), "plan hash").toLowerCase(), projectRoot: text(args.get("--project-root"), "project root"), referenceRoot: args.get("--reference-root"), receiptPath: args.get("--receipt"), archivePath: args.get("--archive") };
  if (operation === "verify-final") await verifyFinalReceipt(options);
  else {
    const context = await validatePlan(options);
    if (operation !== "validate") {
      const receiptPath = path.resolve(text(options.receiptPath, "receipt path"));
      if (operation === "finalize") await finalize(context, receiptPath, text(options.archivePath, "archive path"));
      else await runStage(context, operation === "run-native" ? "native" : "tests", receiptPath);
    }
  }
  console.log(`INCREMENTAL_WINDOWS_${operation.replaceAll("-", "_").toUpperCase()}_PASS`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
