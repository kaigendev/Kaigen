import { createHash } from "node:crypto";
import path from "node:path";

export const IMPORTED_RUST_KIND = "kaigen-imported-rust-execution";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const requireValue = (value, message) => { if (!value) throw new Error(`Imported Rust evidence: ${message}`); };
const lf = bytes => bytes.toString("utf8").replaceAll("\r\n", "\n");
const hex = value => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value.toLowerCase());
const time = value => { const result = Date.parse(value); requireValue(Number.isFinite(result), "invalid timestamp"); return result; };
function relative(value) {
  requireValue(typeof value === "string" && !/[\\:\r\n\t\0]/u.test(value) && !value.startsWith("/") && !value.split("/").some(part => !part || part === "." || part === ".."), "unsafe inventory path");
  return value;
}
function records(values, label) {
  requireValue(Array.isArray(values) && values.length > 0 && values.length <= 8192, `invalid ${label}`);
  const result = new Map();
  for (const value of values) {
    const name = relative(value.path);
    requireValue(!result.has(name.toLowerCase()) && hex(value.sha256), `duplicate or invalid ${label} entry`);
    result.set(name.toLowerCase(), value);
  }
  return result;
}

// Only the application's own version token is removed. Every dependency byte,
// feature, source path and remaining manifest field still participates in equality.
export function rootVersionEquivalent(filename, before, after) {
  let a = lf(before), b = lf(after);
  const token = "\\d+\\.\\d+\\.\\d+\\+\\d+(?:\\.\\d+)?";
  let pattern;
  if (["src-tauri/Cargo.toml", "web/kaigen-webd/Cargo.toml"].includes(filename)) {
    pattern = new RegExp(`(\\[package\\]\\nname = \"${filename.startsWith("web/") ? "kaigen-webd" : "kaigen"}\"\\nversion = \")${token}(\")`, "u");
  } else if (["src-tauri/Cargo.lock", "web/kaigen-webd/Cargo.lock"].includes(filename)) {
    const normalize = value => {
      for (const name of filename.startsWith("web/") ? ["kaigen", "kaigen-webd"] : ["kaigen"]) {
        const match = new RegExp(`(\\[\\[package\\]\\]\\nname = \"${name}\"\\nversion = \")${token}(\")`, "u");
        requireValue(match.test(value), "root lock package missing");
        value = value.replace(match, "$1<application-version>$2");
      }
      return value;
    };
    try { return normalize(a) === normalize(b); } catch { return false; }
  } else if (filename === "src/componentVersions.ts") {
    const normalize = value => {
      const versions = [...value.matchAll(/^  (app|appManifest|webBackendManifest): "([^"]+)",$/gmu)];
      requireValue(versions.length === 3 && versions[0][1] === "app" && versions[1][1] === "appManifest" && versions[2][1] === "webBackendManifest" && versions[1][2] === versions[2][2] && new RegExp(`^${token}$`, "u").test(versions[1][2]) && versions[0][2] === versions[1][2].replace("+", "."), "inconsistent About versions");
      return value.replace(/^  (app|appManifest|webBackendManifest): "[^"]+",$/gmu, "  $1: \"<application-version>\",");
    };
    try { return normalize(a) === normalize(b); } catch { return false; }
  } else if (["package.json", "package-lock.json", "src-tauri/tauri.conf.json"].includes(filename)) {
    // Replacing exact JSON value spans retains formatting and every other byte.
    const normalize = value => {
      const parsed = JSON.parse(value);
      requireValue(new RegExp(`^${token}$`, "u").test(parsed.version), "invalid root application version");
      const old = parsed.version;
      if (filename === "package-lock.json") requireValue(parsed.packages?.[""]?.version === old, "lock root version differs");
      const expected = filename === "package-lock.json" ? 2 : 1;
      let count = 0;
      const result = value.replace(/("version"\s*:\s*")([^"\n]+)(")/gu, (all, start, version, end) => {
        if (version !== old) return all;
        count += 1; return `${start}<application-version>${end}`;
      });
      requireValue(count === expected, "ambiguous application version fields");
      return result;
    };
    try { return normalize(a) === normalize(b); } catch { return false; }
  } else return false;
  return pattern.test(a) && pattern.test(b) && a.replace(pattern, "$1<application-version>$2") === b.replace(pattern, "$1<application-version>$2");
}

export const PACKAGE_ONLY_FRONTEND = new Set([
  "frontend:chat-navigation", "frontend:chat-view-state", "frontend:chat-notification-queue",
  "frontend:chat-reaction-notices", "frontend:background-transfers", "frontend:chat-file-batch",
  "frontend:source-hygiene", "frontend:prepared-native-cache", "frontend:source-archive-privacy",
  "frontend:file-receive-settings",
]);
const FRONTEND_CLOSURES = {
  "file-receive-settings": [["scripts/import-typescript-module.mjs", "scripts/test-file-receive-settings.mjs", "src/Settings.tsx", "src/fileReceiveSettings.ts"], "46f3454b82e0f83640c513f23b9211a3f5de0e8c95464f024ecf00110aa0feb5"],
  "chat-navigation": [["scripts/import-typescript-module.mjs", "scripts/test-chat-navigation.mjs", "src/chatNavigation.ts"], "f0e95ed32838df2191c642e44a4d7a5bac31d1995292da8082ea3e920e1bd7d4"],
  "chat-view-state": [["scripts/import-typescript-module.mjs", "scripts/test-chat-view-state.mjs", "src/chatDateFormat.ts", "src/chatViewState.ts", "src/chatWindow.ts"], "3f73b18e7ecbb82ace0b62445c7eb8813d07a17171ab88ed8c6640279471e088"],
  "chat-notification-queue": [["scripts/import-typescript-module.mjs", "scripts/test-chat-notification-queue.mjs", "src/chatNotificationQueue.ts"], "0f090c4f4f2c2ff5eba1ed3910fac9366770a0e7231c0f55620ed5cfbd53c71a"],
  "chat-reaction-notices": [["scripts/test-chat-reaction-notices.mjs", "src/chatReactionNotices.ts", "src/chatRichText.ts", "tsconfig.json", "tsconfig.node.json"], "a3ab13183d39aa89d84a351b634faaac771e8f7f9390875e217096d026385f76"],
  "background-transfers": [["scripts/fixtures/web-background-transfer-contract.json", "scripts/import-typescript-module.mjs", "scripts/test-background-transfers.mjs", "src/web/backgroundTransfers.ts"], "9cf7288add39ead68a423f84c66e894846bfb4f21e2f4d418aecb412914af5f8"],
  "chat-file-batch": [["scripts/import-typescript-module.mjs", "scripts/test-chat-file-batch.mjs", "src/chatFileBatch.ts", "src/fileReceiveSettings.ts"], "321a881e9f5ba21f1bbcb0523633e2d822f605cd23640940a5dc060a6d89fa3f"],
  "source-hygiene": [["scripts/test-source-hygiene.mjs", "scripts/verify-source-hygiene.mjs"], "37d24343035b7191bfa3369339b750cd372407f5e0e9d866844172c2ef3e84c8"],
  "prepared-native-cache": [["scripts/build-appimage.sh", "scripts/build-macos.sh", "scripts/build-portable.ps1", "scripts/build-web-installer.ps1", "scripts/prepare-unix-dependencies.sh", "scripts/prepared-native-cache-windows.ps1", "scripts/prepared-native-cache.mjs", "scripts/test-prepared-native-cache.mjs"], "fe247ae4a66e6aee32141acc33f821dc56ca09e644fe82a5016761baffb308b1"],
  "source-archive-privacy": [["scripts/build-source-archive.ps1", "scripts/test-source-archive-privacy.mjs"], "c48d5317581aa774c9e2b47defb781329fa5b4534d75e01c4681e10710963754"],
};

export async function validatePackageOnlySourceClosure(id, api) {
  requireValue(PACKAGE_ONLY_FRONTEND.has(id), "unreviewed frontend package projection");
  const [names, digest] = FRONTEND_CLOSURES[id.slice(9)], rows = [];
  for (const name of names) {
    const before = await api.before(name), after = await api.after(name);
    requireValue(before.equals(after), `frontend consumer changed: ${name}`);
    rows.push(`${name}\t${hash(after)}\n`);
  }
  requireValue(hash(Buffer.from(rows.join(""))) === digest, "frontend dependency closure has not been reviewed");
  if (id === "frontend:source-hygiene") await api.absent(["patches/c-toxcore/security", "patches/c-toxcore/security-v3"]);
  if (id === "frontend:chat-reaction-notices") {
    // Vite configFile:false is fixed in the reviewed producer above. Preserve
    // its remaining default public/env/config inputs, including additions.
    const relevant = name => name.startsWith("public/") || /^\.env(?:\.|$)/u.test(name) || /(?:^|\/)tsconfig[^/]*\.json$/u.test(name);
    const beforeNames = (await api.paths("before")).filter(relevant), afterNames = (await api.paths("after")).filter(relevant);
    requireValue(equal(beforeNames, afterNames), "Vite default input inventory changed");
    for (const name of beforeNames) requireValue((await api.before(name)).equals(await api.after(name)), `Vite default input changed: ${name}`);
  }
  return names;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}
function scriptClosure(scripts, initial) {
  const seen = new Set(), pending = [initial];
  while (pending.length) {
    const name = pending.pop();
    requireValue(typeof scripts[name] === "string", `missing npm script ${name}`);
    if (seen.has(name)) continue;
    seen.add(name);
    for (const lifecycle of [`pre${name}`, `post${name}`]) if (Object.hasOwn(scripts, lifecycle)) pending.push(lifecycle);
    for (const match of scripts[name].matchAll(/\bnpm(?:\.cmd)?\s+run\s+([A-Za-z0-9:_-]+)/gu)) pending.push(match[1]);
  }
  return seen;
}
export function packageScriptClosureEquivalent(checkId, beforePackageBytes, afterPackageBytes, beforeLockBytes, afterLockBytes) {
  requireValue(PACKAGE_ONLY_FRONTEND.has(checkId), `package-only reuse is not approved for ${checkId}`);
  const before = JSON.parse(beforePackageBytes.toString("utf8")), after = JSON.parse(afterPackageBytes.toString("utf8"));
  const script = `test:${checkId.slice("frontend:".length)}`;
  const beforeClosure = scriptClosure(before.scripts ?? {}, script), afterClosure = scriptClosure(after.scripts ?? {}, script);
  requireValue(equal([...beforeClosure].sort(), [...afterClosure].sort()), "selected npm script closure changed");
  for (const name of beforeClosure) requireValue(before.scripts[name] === after.scripts[name], `selected npm script changed: ${name}`);
  const strip = value => { const copy = structuredClone(value); delete copy.version; delete copy.scripts; return copy; };
  requireValue(equal(canonical(strip(before)), canonical(strip(after))), "package dependency or other field changed");
  const additions = { "test:outgoing-message-state": "node scripts/test-outgoing-message-state.mjs", "test:input-language-sync": "node scripts/test-input-language-sync.mjs" };
  const allowedScripts = structuredClone(before.scripts);
  for (const [name, command] of Object.entries(additions)) {
    requireValue(!Object.hasOwn(before.scripts, name) && after.scripts[name] === command, "unexpected added test command");
    allowedScripts[name] = command;
  }
  const anchor = "npm run test:friend-resilience && npm run test:localization";
  requireValue(typeof allowedScripts["test:frontend"] === "string" && allowedScripts["test:frontend"].split(anchor).length === 2, "unexpected frontend chain recipe");
  allowedScripts["test:frontend"] = allowedScripts["test:frontend"].replace(anchor, "npm run test:friend-resilience && npm run test:outgoing-message-state && npm run test:input-language-sync && npm run test:localization");
  requireValue(equal(canonical(allowedScripts), canonical(after.scripts)), "npm catalog differs beyond the reviewed two-command recipe");
  const lockBefore = JSON.parse(beforeLockBytes.toString("utf8")), lockAfter = JSON.parse(afterLockBytes.toString("utf8"));
  const normalizeLock = lock => { const copy = structuredClone(lock); delete copy.version; if (copy.packages?.[""]) delete copy.packages[""].version; return copy; };
  requireValue(equal(canonical(normalizeLock(lockBefore)), canonical(normalizeLock(lockAfter))), "package lock dependency graph changed");
  const versionOnlyAfter = { ...after, scripts: before.scripts };
  requireValue(rootVersionEquivalent("package.json", Buffer.from(JSON.stringify(before)), Buffer.from(JSON.stringify(versionOnlyAfter))) && rootVersionEquivalent("package-lock.json", beforeLockBytes, afterLockBytes), "root application version transition is not exact");
  return { script, closure: [...beforeClosure].sort() };
}

// This is deliberately a whole build contour, not caller-selected Rust lines.
// Unknown new roots are included. Only presentation/documentation and the
// separately built Web server can be outside a web-core library test contour.
function dependencyPath(filename, variant) {
  // Frontend test scripts and verification adapters are never invoked by the
  // recorded cargo --lib --no-run command. Native preparation/build scripts stay.
  if (/^scripts\/(?:test-[^/]+\.(?:mjs|ps1)|(?:ci-incremental-verification|incremental-windows-verification|imported-rust-execution)\.mjs)$/u.test(filename)) return false;
  if (filename.startsWith("scripts/fixtures/") && filename !== "scripts/fixtures/web-background-transfer-contract.json") return false;
  return !/^(?:src\/|public\/|web\/|packaging\/|\.github\/|\.vscode\/|ci\/)/u.test(filename)
    && !/^(?:README\.md|BUILDING(?:-PLATFORMS)?\.md|LICENSE|THIRD_PARTY_NOTICES\.md|POST_QUANTUM\.txt|index\.html|vite\.config\.ts|tsconfig(?:\.[a-z]+)?\.json)$/u.test(filename);
}

// Reviewed, exact-byte isolation of the September input-language policy change.
// The full module diff changes only its private observation policy/Win32 input
// path. Its sole application entry is the window IPC command, never these Rust
// families. A different module or lib.rs revision requires a new review.
export function isolatedInputLanguageChange(before, after, lib, id) {
  const families = ["pq::", "pq_delivery_tests::", "chat_history_store::tests::", "chat_protocol::tests::", "outbox_cancel_local_state_tests::", "deferred_persistence_tests::", "web_core::tests::"];
  const notice = /^tox_tests::(?:pq_notice_policy_suppresses_auto_refresh_but_keeps_manual_restart_and_identity_changes|suppressed_pq_offer_is_removed_after_older_batched_history_snapshot|automatic_pq_active_history_is_role_correct_persistent_and_idempotent|required_pq_active_history_retries_an_unchanged_in_memory_card|pq_history_card_keeps_one_entry_and_reaches_terminal_state)$/u;
  return (families.includes(id.slice(5)) || notice.test(id.slice(5)))
    && hash(before) === "2fed95e4b38ed98ce592139d5bcead6b4e50af8794920106a116d26aaac6b7f7"
    && hash(after) === "eed225601df5ef1895ae2225eedc9594663674efb8afe8a9b558443e99b1ff87"
    && hash(lib) === "4642b52c75239c8c63c3eac1a8f0316265182c2711c30b661c9e311b0aceae4a";
}

/** Read-only adapter for the original compile-only + VM Rust receipt format.
 * The caller supplies its existing strict pin/path/Git readers. No execution,
 * evidence rewriting, current-source relabelling or inferred cargo command occurs.
 */
export async function validateImportedRustExecution(result, check, api) {
  requireValue(result.schemaVersion === 1 && result.kind === IMPORTED_RUST_KIND && result.checkId === check.id && check.action === "reuse", "import requires an explicit reuse disposition");
  requireValue(check.id.startsWith("rust:") && check.id !== "rust:all", "import requires a named Rust family");
  const allowed = ["schemaVersion", "kind", "checkId", "source", "command", "startedAt", "completedAt", "compile", "execution", "sourceChanges"];
  requireValue(equal(Object.keys(result).sort(), allowed.sort()), "unexpected imported result fields");
  const compile = result.compile, execution = result.execution;
  requireValue(equal(Object.keys(compile).filter(key => key !== "helper").sort(), ["receipt", "inventory", "manifest", "sourceRoot"].sort()), "unexpected compile proof fields");
  requireValue(equal(Object.keys(execution).sort(), ["receipt", "inputManifest", "runner", "caseIndex", "case", "stdout", "stderr", "listing"].sort()), "unexpected execution proof fields");
  const read = api.read;
  const json = async pin => JSON.parse((await read(pin)).bytes.toString("utf8").replace(/^\uFEFF/u, ""));
  const receipt = await json(compile.receipt), inventory = await json(compile.inventory), manifest = await json(compile.manifest);
  requireValue(receipt.schemaVersion === 1 && receipt.documentType === "kaigen-task-compile-only" && receipt.status === "COMPILED_ONLY" && receipt.testsExecuted === false, "invalid compile-only receipt");
  requireValue(receipt.sourceRoot === compile.sourceRoot && receipt.sourceInventorySha256 === inventory.sha256 && receipt.coordinatorManifestSha256.toLowerCase() === compile.manifest.sha256, "compile source binding differs");
  requireValue(manifest.windowsSnapshotCommit === result.source.commit && manifest.tree === result.source.tree, "built-from source differs from the original manifest");
  await api.sourceIdentity(compile.sourceRoot, result.source);
  requireValue(hex(receipt.helperSha256), "missing original compile helper hash");
  if (compile.helper) requireValue(hash((await read(compile.helper)).bytes) === receipt.helperSha256.toLowerCase(), "compile helper differs");
  const files = records(receipt.files, "compiled files"), sourceFiles = records(inventory.files, "source inventory");
  requireValue(manifest.files === sourceFiles.size, "manifest source count differs");
  const names = inventory.files.map(value => value.path);
  requireValue(equal([...names].sort(), names), "source inventory is not sorted");
  requireValue(hash(Buffer.from(inventory.files.map(value => `${value.path}\t${value.size}\t${value.sha256}\n`).join(""))) === inventory.sha256, "source inventory digest differs");
  requireValue(equal(await api.sourcePaths(compile.sourceRoot, result.source), names), "source inventory is incomplete");
  const originals = new Map();
  for (const entry of inventory.files) {
    requireValue(Number.isSafeInteger(entry.size) && entry.size >= 0, "invalid source size");
    const original = await read({ path: path.join(compile.sourceRoot, entry.path), sha256: entry.sha256 });
    requireValue(original.bytes.length === entry.size, "source size differs");
    const gitBytes = await api.sourceBlob(compile.sourceRoot, result.source, entry.path);
    requireValue(original.bytes.equals(gitBytes) || (lf(original.bytes) === gitBytes.toString("utf8") && !original.bytes.includes(0)), "original source differs from built-from Git tree");
    originals.set(entry.path, gitBytes);
  }
  const compiledFile = async name => {
    const entry = files.get(relative(name).toLowerCase());
    requireValue(entry && entry.path === name && Number.isSafeInteger(entry.size), "missing compiled file");
    const value = await read({ path: path.join(path.dirname(compile.receipt.path), name), sha256: entry.sha256 });
    requireValue(value.bytes.length === entry.size, "compiled file size differs");
    return value;
  };
  requireValue(files.get("source-inventory.json")?.sha256 === compile.inventory.sha256 && files.get("coordinator-source-manifest.json")?.sha256 === compile.manifest.sha256, "raw inventory/manifest pin differs from compile receipt");
  const vm = await json(execution.receipt), inputs = await json(execution.inputManifest);
  requireValue(equal(Object.keys(vm).sort(), ["schemaVersion", "kind", "status", "startedUtc", "finishedUtc", "testsExecutedInVm", "testsExecutedOnHost", "sourceInventorySha256", "sourceManifestSha256", "compileReceiptSha256", "inputManifestSha256", "helperSha256", "preflight", "postflight", "cases"].sort()), "unexpected VM receipt fields");
  requireValue(vm.schemaVersion === 1 && ["kaigen-vm-pq-rust-r2-full", "kaigen-vm-rust-filtered-execution"].includes(vm.kind) && vm.status === "PASS" && vm.testsExecutedInVm === true && vm.testsExecutedOnHost === false, "invalid original VM execution receipt");
  requireValue(vm.compileReceiptSha256 === compile.receipt.sha256 && vm.sourceInventorySha256 === inventory.sha256 && vm.sourceManifestSha256 === compile.manifest.sha256 && vm.inputManifestSha256 === execution.inputManifest.sha256, "VM/compile identity differs");
  requireValue(inputs.compileReceiptSha256 === compile.receipt.sha256 && inputs.sourceInventorySha256 === inventory.sha256 && inputs.sourceManifestSha256 === compile.manifest.sha256, "VM input binding differs");
  requireValue(hash((await read(execution.runner)).bytes) === vm.helperSha256, "execution runner differs");
  const inputFiles = records(inputs.files, "VM input files");
  for (const entry of inputs.files) {
    const observed = await compiledFile(entry.path);
    requireValue(hash(observed.bytes) === entry.sha256 && observed.bytes.length === entry.bytes, "VM input artifact differs");
  }
  requireValue(vm.preflight?.filesVerified === inputFiles.size && vm.postflight?.filesVerified === inputFiles.size && vm.preflight.sourceInventorySha256 === inventory.sha256 && vm.preflight.compileReceiptSha256 === compile.receipt.sha256, "VM pre/postflight proof differs");
  requireValue(Array.isArray(vm.cases) && Number.isInteger(execution.caseIndex) && execution.caseIndex >= 0 && execution.caseIndex < vm.cases.length, "invalid original case index");
  const selected = vm.cases[execution.caseIndex], rawCase = await json(execution.case);
  requireValue(equal(Object.keys(selected).sort(), ["command", "workingDirectory", "fixtureTemp", "startedUtc", "finishedUtc", "exitCode", "timedOut", "status", "target", "filter", "matchedTests", "stdoutSha256", "stderrSha256", "summary"].sort()), "unexpected original case fields");
  requireValue(equal(rawCase, selected), "original case differs from execution receipt");
  const target = check.variant === "web-core" ? "web-core-tests" : "desktop-tests";
  const filter = check.id.slice(5);
  requireValue(selected.target === target && selected.filter === filter && selected.exitCode === 0 && selected.timedOut === false && selected.status === "PASS", "original case target/filter/result differs");
  requireValue(Array.isArray(selected.command) && selected.command.length === 2 && selected.command[0] === path.win32.join(selected.workingDirectory, "kaigen-lib-tests.exe") && selected.command[1] === `${filter} --test-threads=1` && path.win32.basename(selected.workingDirectory) === target, "unapproved original EXE command");
  requireValue(equal(result.command, selected.command) && result.startedAt === selected.startedUtc && result.completedAt === selected.finishedUtc, "import changed the original command or execution timestamps");
  requireValue(time(receipt.startedUtc) <= time(receipt.finishedUtc) && time(receipt.finishedUtc) <= time(vm.startedUtc) && time(vm.startedUtc) <= time(vm.preflight.utc) && time(vm.preflight.utc) <= time(selected.startedUtc) && time(selected.startedUtc) <= time(selected.finishedUtc) && time(selected.finishedUtc) <= time(vm.finishedUtc) && time(selected.finishedUtc) <= time(vm.postflight.utc) && time(vm.finishedUtc) <= time(vm.postflight.utc) + 2000, "execution/compile chronology differs");
  const targetInput = JSON.parse((await compiledFile(`${target}/compile-inputs.json`)).bytes.toString("utf8"));
  for (const name of ["kaigen-lib-tests.exe", "pthreadVC3.dll", "toxcore.dll", "compile-inputs.json"]) requireValue(inputFiles.has(`${target}/${name}`.toLowerCase()), "executed target is absent from the VM preflight inputs");
  requireValue(targetInput.status === "COMPILED_ONLY" && targetInput.testsExecuted === false && targetInput.sourceInventorySha256 === inventory.sha256 && targetInput.coordinatorManifestSha256.toLowerCase() === compile.manifest.sha256 && targetInput.target === "tauri_app_lib" && targetInput.embeddedBuildSourceRoot === receipt.embeddedBuildSourceRoot, "target compile binding differs");
  requireValue(equal([...records(targetInput.files, "target files").keys()].sort(), ["kaigen-lib-tests.exe", "pthreadvc3.dll", "toxcore.dll"]), "target runtime closure differs");
  for (const entry of targetInput.files) {
    const bytes = (await compiledFile(`${target}/${entry.path}`)).bytes;
    requireValue(hash(bytes) === entry.sha256 && bytes.length === entry.size && bytes.subarray(0, 2).toString() === "MZ", "compiled PE/runtime binding differs");
  }
  const label = target === "desktop-tests" ? "desktop-lib-no-run" : "web-core-lib-no-run";
  const commands = receipt.commands.filter(value => value.label === label);
  requireValue(commands.length === 1, "compile command missing or duplicated");
  const command = commands[0], args = ["test", "--offline", "--locked", "--manifest-path", "src-tauri\\Cargo.toml", ...(check.variant === "web-core" ? ["--no-default-features", "--features", "web-core"] : []), "--lib", "--no-run", "--message-format=json-render-diagnostics"];
  requireValue(command.program === "cargo" && equal(command.arguments, args) && command.exitCode === 0 && command.logSha256 === targetInput.logSha256 && time(command.startedUtc) >= time(receipt.startedUtc) && time(command.finishedUtc) <= time(receipt.finishedUtc), "original compile command differs");
  const compileLog = await read({ path: path.join(path.dirname(compile.receipt.path), relative(command.log)), sha256: command.logSha256 });
  const cargoRecords = lf(compileLog.bytes).split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line));
  const artifacts = cargoRecords.filter(value => value.reason === "compiler-artifact" && value.target?.name === "tauri_app_lib" && value.profile?.test === true);
  requireValue(artifacts.length === 1 && artifacts[0].manifest_path === path.win32.join(receipt.embeddedBuildSourceRoot, "src-tauri", "Cargo.toml") && artifacts[0].target.src_path === path.win32.join(receipt.embeddedBuildSourceRoot, "src-tauri", "src", "lib.rs") && equal(artifacts[0].features, check.variant === "web-core" ? ["web-core"] : ["default", "desktop"]) && typeof artifacts[0].executable === "string" && artifacts[0].executable.startsWith(path.win32.join(receipt.embeddedBuildSourceRoot, "src-tauri", "target") + "\\") && artifacts[0].executable.endsWith(".exe") && cargoRecords.some(value => value.reason === "build-finished" && value.success === true) && !cargoRecords.some(value => value.reason === "compiler-message" && value.message?.level === "error"), "compile log does not prove the requested test artifact");
  const output = (await read(execution.stdout)).bytes, errors = (await read(execution.stderr)).bytes;
  requireValue(hash(output) === selected.stdoutSha256 && hash(errors) === selected.stderrSha256, "original output differs");
  const listing = lf((await read(execution.listing)).bytes).split("\n").filter(line => line.endsWith(": test")).map(line => line.slice(0, -6));
  const expected = listing.filter(name => name.includes(filter));
  const passed = [...lf(output).matchAll(/^test (\S+) \.\.\. ok$/gmu)].map(match => match[1]);
  const summaries = [...lf(output).matchAll(/test result: ok\. (\d+) passed; (\d+) failed; (\d+) ignored;/gu)];
  requireValue(expected.length > 0 && new Set(listing).size === listing.length && equal(expected, selected.matchedTests) && equal([...expected].sort(), passed.sort()) && summaries.length === 1 && Number(summaries[0][1]) === expected.length && summaries[0][2] === "0" && summaries[0][3] === "0" && selected.summary === summaries[0][0], "test inventory/output coverage differs");
  const currentNames = await api.currentPaths(), changes = [];
  const allNames = [...new Set([...names, ...currentNames])].sort();
  for (const name of allNames) {
    const before = originals.get(name), after = currentNames.includes(name) ? await api.currentBlob(name) : undefined;
    if (before && after && before.equals(after)) continue;
    let disposition = "outside-rust-library";
    if (dependencyPath(name, check.variant)) {
      if (before && after && rootVersionEquivalent(name, before, after)) disposition = "application-version-only";
      else if (name === "src-tauri/src/input_language.rs" && before && after && originals.get("src-tauri/src/lib.rs")?.equals(await api.currentBlob("src-tauri/src/lib.rs")) && isolatedInputLanguageChange(before, after, originals.get("src-tauri/src/lib.rs"), check.id)) disposition = "reviewed-input-language-isolation";
      else requireValue(false, `changed build dependency: ${name}`);
    }
    changes.push({ path: name, beforeSha256: before ? hash(before) : null, afterSha256: after ? hash(after) : null, disposition });
  }
  requireValue(equal(changes, result.sourceChanges), "complete source change proof differs");
  if (changes.some(change => change.disposition === "outside-rust-library")) {
    // The exclusions above describe this reviewed native consumer, not arbitrary
    // future Rust code that might start reading a frontend file at compile/run time.
    const nativeNames = currentNames.filter(name => name.startsWith("src-tauri/") && name.endsWith(".rs")).sort();
    const nativeRows = [];
    for (const name of nativeNames) nativeRows.push(`${name}\t${hash(await api.currentBlob(name))}\n`);
    requireValue(hash(Buffer.from(nativeRows.join(""))) === "188925a39b92ebc76836d8229c24c2a23327e43ba0b0f338404846c29ad60c13", "unreviewed Rust dependency boundary");
  }
  requireValue(api.freshVersionInventory === true || !changes.some(change => change.disposition === "application-version-only"), "version equivalence requires fresh component inventory/About check");
  return { source: result.source, command: selected.command, startedAt: selected.startedUtc, completedAt: selected.finishedUtc, matchedTests: expected };
}
