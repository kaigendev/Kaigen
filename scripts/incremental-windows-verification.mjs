import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLAN_KIND = "kaigen-windows-incremental-plan";
const RESULT_KIND = "kaigen-incremental-check-result";
const RECEIPT_KIND = "kaigen-windows-incremental-verification";
const HASH = /^[a-f0-9]{64}$/u;
const OBJECT = /^[a-f0-9]{40}$/u;
const TEST_ONLY_PATHS = new Set([
  "scripts/build-portable.ps1",
  "scripts/incremental-windows-verification.mjs",
  "scripts/test-build-pipeline.mjs",
  "scripts/ci-incremental-verification.mjs",
  "scripts/test-ci-incremental-verification.mjs",
  "scripts/test-app-layout.mjs",
  "scripts/test-friend-resilience.mjs",
  "scripts/test-resource-bounds.mjs",
  "ci/verification-v0.2.8.json",
  "ci/verification-v0.2.9.json",
]);
const RELEASE_METADATA_PATH = ".github/workflows/build-unix.yml";
const NATIVE = new Map([
  ["native:prepared-cache", "scripts/test-prepared-native-cache-windows.ps1"],
  ["native:retry-cap", "scripts/test-toxcore-retry-cap.ps1"],
  ["native:offline-friend-request", "scripts/test-offline-friend-request-loopback.ps1"],
]);
const NATIVE_MARKERS = new Map([
  ["native:prepared-cache", ["PASS Windows prepared-native cache: built -> hit, compiler sentinel, corruption, missing, revocation, receipt, fresh-app ordering"]],
  ["native:retry-cap", ["PASS toxcore retry-cap transformation (60 seconds, idempotent, fail-closed)", "PASS controlled recovery model: capped=5->10->20->40->60->60->60"]],
  ["native:offline-friend-request", ["PASS sender stayed routable", "PASS offline friend request delivered", "Verified native harness UDP ports:"]],
]);

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
function git(root, args) {
  return execFileSync("git", ["-c", `safe.directory=${root.replaceAll("\\", "/")}`, "-C", root, ...args], { maxBuffer: 32 * 1024 * 1024, windowsHide: true });
}
function gitText(root, args) { return git(root, args).toString("utf8").trim(); }
function sourceBlob(root, source, filename, cache) {
  const key = JSON.stringify([root, source.commit, filename]);
  if (!cache.has(key)) cache.set(key, git(root, ["show", `${source.commit}:${filename}`]));
  return cache.get(key);
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
function sourceIdentity(root, source) {
  shape(source, ["commit", "tree"], [], "source identity");
  assert(OBJECT.test(source.commit) && OBJECT.test(source.tree), "source identity must use complete lowercase Git object IDs");
  assert(gitText(root, ["rev-parse", `${source.commit}^{commit}`]) === source.commit, "source commit does not resolve");
  assert(gitText(root, ["rev-parse", `${source.commit}^{tree}`]) === source.tree, "source tree does not match commit");
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
    : id === "frontend:chat-geometry-runtime" && ["menus-only", "filecards-only"].includes(variant) ? ["--", `--${variant}`]
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
    const direct = check.id === "frontend:chat-geometry-runtime" && ["filecards-only", "menus-only"].includes(check.variant)
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
  validateResultHeader(result, check.id);
  if (![context.plan.source, context.plan.productSource, context.plan.baseline.source].some((source) => same(source, result.source))) {
    assertRetainedResult(context.retainedResults, result, { path: pinned.path, sha256: reference.sha256 });
  }
  sourceIdentity(context.referenceRoot, result.source);
  const observed = await validateInputs(context.referenceRoot, result.source, result.inputs, path.dirname(pinned.path), context.blobCache, context.readContext);
  assertMatchingInputs(observed, context.inputs.get(check.id), check.id);
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
  if (NATIVE.has(check.id)) assert(NATIVE_MARKERS.get(check.id).every((marker) => selected.includes(marker)), `native output lacks its passing check markers: ${check.id}`);
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
  assert(/^\d+\.\d+\.\d+$/u.test(oldVersion) && /^\d+\.\d+\.\d+$/u.test(newVersion) && oldVersion !== newVersion, "invalid release metadata version transition");
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
    sourceIdentity(referenceRoot, entry.source);
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

export async function validatePlan(options) {
  return validatePlanInternal(options, { proofs: new Map(), active: new Set() });
}
async function validatePlanInternal({ planPath, planSha256, projectRoot, referenceRoot = projectRoot }, provenance, inheritedReads) {
  assert(HASH.test(planSha256), "expected plan SHA-256 is required");
  const root = path.resolve(projectRoot);
  referenceRoot = path.resolve(referenceRoot);
  const pinned = await pinnedFile({ path: path.resolve(planPath), sha256: planSha256 }, root, inheritedReads);
  const plan = JSON.parse(pinned.bytes.toString("utf8"));
  shape(plan, ["schemaVersion", "kind", "source", "productSource", "baseline", "testOnlyPaths", "changes", "checks"], ["releaseMetadataPaths", "retainedSources", "attachments", "evidenceRelocations"], "verification plan");
  assert(plan.schemaVersion === 1 && plan.kind === PLAN_KIND, "unsupported plan schema");
  const planBase = path.dirname(pinned.path);
  const readContext = await evidenceReadContext(plan.evidenceRelocations, planBase, inheritedReads);
  sourceIdentity(referenceRoot, plan.source);
  sourceIdentity(referenceRoot, plan.productSource);
  assert(gitText(referenceRoot, ["rev-parse", "HEAD"]) === plan.source.commit, "plan does not match the canonical verification revision");
  const materialization = { commit: gitText(root, ["rev-parse", "HEAD"]), tree: gitText(root, ["rev-parse", "HEAD^{tree}"]) };
  assert(materialization.tree === plan.source.tree, "materialized checkout tree does not match the verification source");
  assert(gitText(root, ["status", "--porcelain=v1", "--untracked-files=all"]) === "", "verification checkout must be clean");
  assert(gitText(referenceRoot, ["status", "--porcelain=v1", "--untracked-files=all"]) === "", "canonical verification checkout must be clean");
  shape(plan.baseline, ["source", "evidence"], [], "baseline");
  sourceIdentity(referenceRoot, plan.baseline.source);
  assert(Array.isArray(plan.baseline.evidence) && plan.baseline.evidence.length > 0, "baseline evidence is required");
  for (const evidence of plan.baseline.evidence) await pinnedFile(evidence, planBase, readContext);
  assert(Array.isArray(plan.testOnlyPaths) && plan.testOnlyPaths.every((name) => TEST_ONLY_PATHS.has(name)), "unapproved test-only equivalence path");
  const metadataPaths = plan.releaseMetadataPaths ?? [];
  assert(same(metadataPaths, []) || same(metadataPaths, [RELEASE_METADATA_PATH]), "unapproved release metadata equivalence path");
  const verificationChanges = trackedChanges(referenceRoot, plan.productSource.commit, plan.source.commit).map(({ path }) => path).sort();
  assert(same(verificationChanges, [...new Set([...plan.testOnlyPaths, ...metadataPaths])].sort()), "product/verification differences exceed declared test and metadata equivalence");
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
  const context = { root, referenceRoot, materialization, plan, planBase, planPath: pinned.path, planSha256, npmScripts, inputs: new Map(), blobCache: new Map(), retainedResults, readContext };
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
  // Every retained native regression and frontend suite must be accounted for,
  // whether independently rerun or supported by an unchanged baseline input.
  for (const id of [...NATIVE.keys(), ...[...npmScripts].map((name) => `frontend:${name.slice(5)}`)]) assert(ids.has(id), `missing canonical check coverage: ${id}`);
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
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd: context.root, windowsHide: true, env: { ...process.env, NPM_CONFIG_OFFLINE: "true", CARGO_NET_OFFLINE: "true" } });
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
  const receipt = { schemaVersion: 1, kind: RECEIPT_KIND, status: "PASS", fullBaselineRerun: false, plan: { path: context.planPath, sha256: context.planSha256 }, source: context.plan.source, productSource: context.plan.productSource, materialization: context.materialization, baseline: context.plan.baseline, checks: progress.checks, archive: { path: archive, sha256: sha(archiveBytes) }, completedAt: new Date().toISOString() };
  await jsonFile(receiptPath, receipt);
  return receipt;
}
export async function verifyFinalReceipt(options) {
  return verifyFinalReceiptInternal(options, { proofs: new Map(), active: new Set() });
}
async function verifyFinalReceiptInternal(options, provenance, readContext) {
  const context = await validatePlanInternal(options, provenance, readContext);
  const receiptBytes = options.receiptSha256
    ? (await pinnedFile({ path: options.receiptPath, sha256: options.receiptSha256 }, context.planBase, context.readContext)).bytes
    : await fileBytes(path.resolve(options.receiptPath));
  const receipt = JSON.parse(receiptBytes);
  shape(receipt, ["schemaVersion", "kind", "status", "fullBaselineRerun", "plan", "source", "productSource", "materialization", "baseline", "checks", "archive", "completedAt"], [], "final verification receipt");
  assert(receipt.schemaVersion === 1 && receipt.kind === RECEIPT_KIND && receipt.status === "PASS" && receipt.fullBaselineRerun === false, "final receipt is not an incremental PASS");
  assert(receipt.plan.sha256 === context.planSha256 && path.resolve(receipt.plan.path) === context.planPath && same(receipt.source, context.plan.source) && same(receipt.productSource, context.plan.productSource) && same(receipt.baseline, context.plan.baseline), "final receipt identities do not match the plan");
  assert(same(receipt.materialization, context.materialization), "final receipt belongs to a different source materialization");
  assert(path.resolve(receipt.archive.path) === path.resolve(options.archivePath), "final receipt references another archive");
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
