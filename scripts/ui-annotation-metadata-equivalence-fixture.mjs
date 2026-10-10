import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { descriptor, trackedChanges, uiAnnotationMetadataTemplate, validateUiAnnotationMetadata, validatePlan, verifyFinalReceipt } from "./incremental-windows-verification.mjs";

// Historical host-only validator fixtures, explicitly callable for maintenance.
// The reviewed transition is frozen; the current product catalog is not an input.
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const declaration = uiAnnotationMetadataTemplate();
const catalog = await readFile(path.join(sourceRoot, "scripts/fixtures/ui-annotation-metadata-before.json"));
assert.equal(hash(catalog), declaration.beforeSha256, "historical fixture must match the independently reviewed preimage");
// Recover the approved postimage from frozen bytes without a Git history requirement.
// Both results still match the independent fixed review pins.
const lines = catalog.toString("utf8").split("\n");
for (const { family, scenario } of declaration.removals) {
  const key = lines.indexOf(`      "key": "${family}",`);
  assert(key >= 0);
  const disabled = lines.indexOf('        "main-tor-indicator-disabled",', key);
  assert(disabled > key && disabled - key < 30);
  if (hash(catalog) === declaration.afterSha256) lines.splice(disabled + 1, 0, `        "${scenario}",`);
}
const before = Buffer.from(lines.join("\n"));
for (const { family, scenario } of declaration.removals) {
  const key = lines.indexOf(`      "key": "${family}",`);
  const removal = lines.indexOf(`        "${scenario}",`, key);
  assert(removal > key && removal - key < 30);
  lines.splice(removal, 1);
}
const after = Buffer.from(lines.join("\n"));
assert.equal(hash(before), declaration.beforeSha256);
assert.equal(hash(after), declaration.afterSha256);
const fresh = [{ id: "frontend:ui-identity", action: "run", inputs: [{ id: "catalog", kind: "git", path: declaration.path, sha256: hash(after) }] }];
let cases = 0;
const pass = (name, callback) => { callback(); cases++; console.log(`PASS ${name}`); };
const reject = (name, callback, error) => pass(name, () => assert.throws(callback, error));
const check = (candidate = after, checks = fresh, declared = declaration, original = before) => validateUiAnnotationMetadata(declared, original, candidate, checks);
pass("reviewed byte transition and unchanged runtime IDs", () => {
  const proof = check();
  assert.equal(proof.runtimeIdsSha256, hash(Buffer.from(JSON.stringify(JSON.parse(before).ids))));
  assert.equal(proof.bundledBytesUnchanged, false);
  assert.equal(proof.allOtherCatalogBytesUnchanged, true);
});
const changedJson = edit => { const value = JSON.parse(after); edit(value); return Buffer.from(JSON.stringify(value, null, 2) + "\n"); };
for (const [name, edit] of [
  ["runtime ID", value => { value.ids[Object.keys(value.ids)[0]] += "-changed"; }],
  ["selector", value => { value.families.find(entry => entry.key === declaration.removals[0].family).targetSelector += "-changed"; }],
  ["kind", value => { value.families.find(entry => entry.key === declaration.removals[0].family).kind = "group"; }],
  ["order", value => { value.families.find(entry => entry.key === declaration.removals[0].family).order++; }],
  ["family order", value => { value.families.reverse(); }],
  ["static metadata", value => { value.static = []; }],
  ["other family", value => { value.families.find(entry => !declaration.removals.some(item => item.family === entry.key)).name += " changed"; }],
  ["additional scenario removal", value => { value.families.find(entry => entry.key === declaration.removals[0].family).scenarios.shift(); }],
]) reject(`reject ${name}`, () => check(changedJson(edit)), /exceeds the two scenario removals/);
reject("reject whitespace-only extra edit", () => check(Buffer.concat([after, Buffer.from("\r\n")])), /bytes outside/);
reject("reject duplicate JSON key", () => check(Buffer.from(after.toString().replace('{\n', '{\n  "schemaVersion": 1,\n'))), /bytes outside|exceeds/);
reject("reject unreviewed preimage", () => check(after, fresh, declaration, Buffer.concat([before, Buffer.from(" ")])), /preimage changed/);
reject("reject caller-selected postimage pin", () => check(after, fresh, { ...declaration, afterSha256: "0".repeat(64) }), /unapproved/);
reject("reject extra declaration permission", () => check(after, fresh, { ...declaration, allowOtherChanges: true }), /unapproved/);
reject("reject old catalog unchanged", () => check(before), /exceeds/);
reject("reject missing fresh annotation check", () => check(after, []), /requires fresh/);
reject("reject reused annotation check", () => check(after, [{ ...fresh[0], action: "reuse" }]), /requires fresh/);
reject("reject duplicate annotation check", () => check(after, [...fresh, ...fresh]), /requires fresh/);
reject("reject stale evidence on fresh check", () => check(after, [{ ...fresh[0], evidence: {} }]), /requires fresh/);
reject("reject omitted catalog input", () => check(after, [{ ...fresh[0], inputs: [] }]), /complete new catalog/);
reject("reject catalog line slice", () => check(after, [{ ...fresh[0], inputs: [{ ...fresh[0].inputs[0], lines: [1, 5] }] }]), /complete new catalog/);
reject("reject stale catalog input pin", () => check(after, [{ ...fresh[0], inputs: [{ ...fresh[0].inputs[0], sha256: hash(before) }] }]), /complete new catalog/);

const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), "kaigen-ui-metadata-")));
try {
  const repository = path.join(temporary, "source");
  await mkdir(path.join(repository, "src"), { recursive: true });
  await mkdir(path.join(repository, "src-tauri", "src"), { recursive: true });
  const git = args => execFileSync("git", ["-c", "core.autocrlf=false", "-c", `safe.directory=${repository.replaceAll("\\", "/")}`, "-C", repository, ...args], { encoding: "utf8", windowsHide: true }).trim();
  const save = async (name, value) => {
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`), filename = path.join(temporary, name);
    await writeFile(filename, bytes);
    return { path: filename, sha256: hash(bytes) };
  };
  const commit = message => {
    git(["add", "."]);
    git(["-c", "user.name=Kaigen fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", message]);
    return { commit: git(["rev-parse", "HEAD"]), tree: git(["rev-parse", "HEAD^{tree}"]) };
  };
  git(["init", "--quiet"]);
  const packageBytes = Buffer.from('{"scripts":{"test:frontend":"npm run test:ui-identity"}}\n');
  await writeFile(path.join(repository, "package.json"), packageBytes);
  await writeFile(path.join(repository, declaration.path), before);
  await writeFile(path.join(repository, "src-tauri/src/lib.rs"), "fixture original product\n");
  const productSource = commit("disposable product fixture");
  await writeFile(path.join(repository, declaration.path), after);
  const source = commit("disposable annotation fixture");
  const baseline = { source: productSource, evidence: [await save("baseline.json", { syntheticFixtureOnly: true })] };
  const ids = ["native:prepared-cache", "native:retry-cap", "native:offline-friend-request", "frontend:ui-identity", "rust:fixture::"];
  const plan = { schemaVersion: 1, kind: "kaigen-windows-incremental-plan", source, productSource, baseline,
    testOnlyPaths: [], uiAnnotationMetadataEquivalence: declaration,
    changes: trackedChanges(repository, productSource.commit, source.commit).map(change => ({ ...change, reason: "Synthetic annotation metadata fixture", checkIds: ["frontend:ui-identity"] })),
    checks: ids.map(id => ({ id, action: "run", reason: "Synthetic fixture only; no commands executed", inputs: id === "frontend:ui-identity" ? fresh[0].inputs : [{ id: "package", kind: "git", path: "package.json", sha256: hash(packageBytes) }] })) };
  const options = async document => {
    const pin = await save("plan.json", document);
    return { planPath: pin.path, planSha256: pin.sha256, projectRoot: repository, referenceRoot: repository };
  };
  const rejectPlan = async (name, document, error) => {
    const opts = await options(document);
    await assert.rejects(() => validatePlan(opts), error);
    cases++; console.log(`PASS ${name}`);
  };
  const context = await validatePlan(await options(plan));
  pass("plan preserves actual productSource separately", () => {
    assert.deepEqual(context.plan.productSource, productSource);
    assert.notDeepEqual(context.plan.productSource, context.plan.source);
    assert.deepEqual(context.uiAnnotationMetadataEquivalence, check());
  });
  const undeclared = structuredClone(plan); delete undeclared.uiAnnotationMetadataEquivalence;
  await rejectPlan("reject undeclared catalog change", undeclared, /differences exceed/);
  await rejectPlan("reject whole-catalog test-only allowance", { ...undeclared, testOnlyPaths: [declaration.path] }, /unapproved test-only/);
  await rejectPlan("reject changed whole-lib allowance", { ...plan, testOnlyPaths: ["src-tauri/src/lib.rs"] }, /unapproved test-only/);
  await rejectPlan("reject reused annotation at plan boundary", { ...plan, checks: plan.checks.map(item => item.id === "frontend:ui-identity" ? { ...item, action: "reuse" } : item) }, /requires fresh/);

  // Verify receipt bindings with explicit synthetic result files, never with
  // production evidence or a claimed execution of the fixture commands.
  const nativeOutput = "PASS Windows prepared-native cache: built -> hit, compiler sentinel, corruption, missing, revocation, receipt, fresh-app ordering\nPASS toxcore retry-cap transformation (60 seconds, idempotent, fail-closed)\nPASS controlled recovery model: capped=5->10->20->40->60->60->60\nPASS sender stayed routable\nPASS offline friend request delivered\nVerified native harness UDP ports:\n";
  const checks = [];
  for (const [index, item] of plan.checks.entries()) {
    const outputBytes = Buffer.from(item.id.startsWith("rust:") ? "test fixture::example ... ok\ntest result: ok. 1 passed; 0 failed;\n" : nativeOutput);
    const outputPath = path.join(temporary, `synthetic-${index}.log`);
    await writeFile(outputPath, outputBytes);
    const { program, args } = descriptor(item.id, new Set(["test:ui-identity"]));
    const result = await save(`synthetic-${index}.json`, { schemaVersion: 1, kind: "kaigen-incremental-check-result", checkId: item.id, status: "PASS", source,
      inputs: item.inputs, command: { program, args }, exitCode: 0, output: { path: outputPath, sha256: hash(outputBytes) }, startedAt: "2026-09-29T00:00:00Z", completedAt: "2026-09-29T00:00:01Z" });
    checks.push({ id: item.id, disposition: "rerun", result });
  }
  const opts = await options(plan);
  const archivePath = path.join(temporary, "synthetic-archive.txt");
  const archiveBytes = Buffer.from("synthetic unbuilt artifact\n"); await writeFile(archivePath, archiveBytes);
  const receipt = { schemaVersion: 1, kind: "kaigen-windows-incremental-verification", status: "PASS", fullBaselineRerun: false,
    plan: { path: opts.planPath, sha256: opts.planSha256 }, source, productSource, materialization: source, baseline, checks,
    archive: { path: archivePath, sha256: hash(archiveBytes) }, completedAt: "2026-09-29T00:00:02Z", uiAnnotationMetadataEquivalence: check() };
  const verify = async document => {
    const pin = await save("synthetic-receipt.json", document);
    return verifyFinalReceipt({ ...opts, receiptPath: pin.path, receiptSha256: pin.sha256, archivePath });
  };
  const verified = await verify(receipt);
  pass("final receipt preserves original artifact hash and build source", () => { assert.deepEqual(verified.archive, receipt.archive); assert.deepEqual(verified.productSource, productSource); });
  for (const [name, bad, error] of [
    ["receipt missing annotation binding", { ...receipt, uiAnnotationMetadataEquivalence: undefined }, /metadata binding differs/],
    ["receipt falsely claims bundle equality", { ...receipt, uiAnnotationMetadataEquivalence: { ...receipt.uiAnnotationMetadataEquivalence, bundledBytesUnchanged: true } }, /metadata binding differs/],
    ["receipt relabels built-from", { ...receipt, productSource: source }, /identities do not match/],
    ["receipt substitutes archive bytes", { ...receipt, archive: { ...receipt.archive, sha256: "0".repeat(64) } }, /file hash changed/],
  ]) { await assert.rejects(() => verify(bad), error); cases++; console.log(`PASS reject ${name}`); }

  await writeFile(path.join(repository, "src-tauri/src/lib.rs"), "fixture Linux-only change still needs separate reviewed equivalence\n");
  const withLib = commit("disposable unsupported lib change");
  await rejectPlan("unrelated lib difference remains fail-closed", { ...plan, source: withLib }, /differences exceed/);
  assert.equal(git(["status", "--porcelain"]), "");
} finally {
  assert.equal(path.dirname(temporary), await realpath(os.tmpdir()));
  assert(path.basename(temporary).startsWith("kaigen-ui-metadata-"));
  await rm(temporary, { recursive: true, force: true });
}
console.log(`UI annotation metadata equivalence: ${cases} focused host checks PASS; no product/runtime tests executed`);
