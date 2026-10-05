import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { bindingIdentity, digest, nativeCounts, prepare, treeIdentity, within } from "./current-verification.mjs";

const actualRoot = path.resolve(import.meta.dirname, "..");
const fixturePlatform = { win32: "windows", linux: "debian", darwin: "macos" }[process.platform];
assert.ok(fixturePlatform, "unsupported host for conformance");
const driver = path.join(actualRoot, "scripts/current-verification.mjs");
const supplied = process.argv.slice(2);
assert.ok(supplied.length === 0 || supplied.length === 2 && supplied[0] === "--evidence-root", "use optional --evidence-root <fresh directory>");
const persistent = supplied.length > 0;
const workspace = persistent ? path.resolve(supplied[1]) : await mkdtemp(path.join(tmpdir(), "kaigen-full-catalog-"));
if (persistent) await mkdir(workspace, { recursive: false });
const owner = path.join(workspace, "owner"), results = [];
const json = (value) => JSON.stringify(value, null, 2) + "\n";
let sequence = 0, assertions = 0;
async function check(name, action) {
  await action(); assertions++; results.push({ name, status: "PASS" }); console.log("PASS " + name);
}
async function file(relative, text) {
  const target = path.join(owner, relative);
  within(owner, target);
  await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, text);
}
async function cli(args, expected = 0) {
  const result = spawnSync(process.execPath, [driver, ...args], { cwd: owner, encoding: "utf8", windowsHide: true, timeout: 120000 });
  const id = String(++sequence).padStart(3, "0");
  await writeFile(path.join(workspace, id + "-cli.stdout.log"), result.stdout ?? "");
  await writeFile(path.join(workspace, id + "-cli.stderr.log"), result.stderr ?? "");
  await writeFile(path.join(workspace, id + "-command.json"), json({ program: process.execPath, args, exitCode: result.status, signal: result.signal }));
  assert.equal(result.status, expected, (result.stderr ?? "") + (result.stdout ?? ""));
  return result;
}
async function planned(changed = ["unmapped/future.input"], expected = 0) {
  const output = path.join(workspace, "plan-" + sequence + "-" + Date.now() + ".json");
  await cli(["plan", "--root", owner, "--platform", fixturePlatform, "--output", output, ...changed.flatMap((input) => ["--changed", input])], expected);
  const body = await readFile(output);
  return { output, sha256: digest(body), value: JSON.parse(body) };
}
async function run(plan, bindings = {}, expected = 0) {
  const bindingFile = path.join(workspace, "bindings-" + sequence + "-" + Date.now() + ".json");
  const evidence = path.join(workspace, "run-" + sequence + "-" + Date.now());
  await writeFile(bindingFile, json(bindings));
  await cli(["run", "--plan", plan.output, "--plan-sha256", plan.sha256, "--evidence-root", evidence, "--bindings", bindingFile], expected);
  return JSON.parse(await readFile(path.join(evidence, "receipt.json"), "utf8"));
}
const platformList = ["windows", "debian", "macos", "web"];
const fixtureCatalog = {
  schema: 1, kind: "kaigen-current-full-verification", platforms: platformList, sharedContracts: ["src/shared", "package.json"],
  coverageAliases: {}, controlAliases: [], nonLeafAliases: [], directPrerequisites: {}, replaceDirect: [],
  native: [{ manifest: "native/Cargo.toml", target: { name: "catalog_fixture", kind: "lib" }, features: ["default"], variants: [
    { id: "default", platforms: platformList, features: [], noDefault: false }], ignored: [] }],
  routes: [
    { id: "driver:fixture:runtime", covers: ["test-driver.mjs"], program: "node", args: ["scripts/test-driver.mjs", "{candidate}"], requires: { candidate: "file", "artifact-directory": "directory" }, platforms: platformList, authority: "product", proof: "runtime" },
    { id: "release:fixture", covers: ["test-release.mjs"], program: "node", args: ["scripts/test-release.mjs", "--receipt", "{release-receipt}"], requires: { "release-receipt": "file" }, platforms: platformList, authority: "release", proof: "receipt", exclusion: "explicit release authority absent" },
    { id: "manual:first", covers: ["test-first.mjs"], program: "node", args: ["scripts/test-first.mjs"], requires: {}, platforms: platformList, authority: "product", proof: "contract" },
  ],
};
const fixturePackage = { name: "selector-conformance-fixture", version: "1.0.0", type: "module", scripts: {
  "test:first": "node scripts/test-first.mjs",
  "test:duplicate": "npm run test:first",
  "test:driver": "node scripts/test-driver.mjs --self-test",
  "test:frontend": "npm run test:first && npm run test:driver",
}};
const registration = { schema: 1, nested: [{ file: "test-nested.mjs", parent: "test-first.mjs", invocation: 'import "./test-nested.mjs";' }],
  separate: [{ file: "test-release.mjs", reason: "release-only receipt gate" }] };
const marker = 'import { appendFileSync } from "node:fs";import path from "node:path";\nconst mark=(label)=>appendFileSync(path.resolve(import.meta.dirname,"../../marks.log"),label+"\\n");\n';
const driverSource = marker + '\nimport { readFileSync } from "node:fs";\nif(process.argv.includes("--self-test")){mark("contract");console.log("driver contract: 1 assertion passed");}\nelse{assert.equal(readFileSync(process.argv[2],"utf8"),"candidate-bytes");mark("runtime");console.log("driver actual artifact route: 1 assertion passed");}\n';
try {
  await mkdir(owner);
  await file(".gitignore", "**/target/\n");
  await file("package.json", json(fixturePackage));
  await file("ci/verification-current.json", json(fixtureCatalog));
  await file("ci/test-entrypoints.json", json(registration));
  await file("scripts/test-first.mjs", marker + '\nimport "./test-nested.mjs";mark("first");console.log("first suite: 1 assertion passed");\n');
  await file("scripts/test-nested.mjs", marker + '\nmark("nested");console.log("nested suite: 1 assertion passed");\n');
  await file("scripts/test-driver.mjs", 'import assert from "node:assert/strict";\n' + driverSource);
  await file("scripts/test-release.mjs", 'throw new Error("release route must not execute in product scope");\n');
  await file("native/Cargo.toml", '[package]\nname="catalog_fixture"\nversion="0.1.0"\nedition="2021"\n[features]\ndefault=[]\n');
  await file("native/src/lib.rs", '#[test]\nfn baseline(){assert_eq!(2+2,4);}\n');
  let result = spawnSync("git", ["-c", "safe.directory=" + owner, "init", "-q"], { cwd: owner, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  result = spawnSync("cargo", ["generate-lockfile", "--offline", "--manifest-path", "native/Cargo.toml"], { cwd: owner, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  const artifactDirectory = path.join(workspace, "program-artifact"); await mkdir(artifactDirectory);
  const artifact = path.join(artifactDirectory, "candidate.bin"); await writeFile(artifact, "candidate-bytes");
  const directorySha = (await treeIdentity(artifactDirectory)).sha256;
  const bindings = { candidate: { kind: "file", value: artifact, sha256: digest("candidate-bytes") }, "artifact-directory": { kind: "directory", value: artifactDirectory, sha256: directorySha } };
  let plan = await planned();
  await check("unknown input chooses the full current set and remains nonempty", () => {
    assert.ok(plan.value.selected.length >= 4); assert.equal(plan.value.impact[0].impact, "unknown");
    assert.ok(plan.value.selected.every((route) => route.required)); assert.equal(plan.value.mode, "full");
  });
  await check("npm aliases/aggregate deduplicate the actual leaf", () => {
    assert.equal(plan.value.selected.filter((route) => route.covers.includes("test-first.mjs")).length, 1);
    assert.equal(plan.value.nested.length, 1);
    assert.ok(plan.value.selected.find((route) => route.id === "manual:first").aliases.includes("test:duplicate"));
  });
  await check("release-only gate has executable route and explicit exclusion", () => {
    const entry = plan.value.excluded.find((entry) => entry.id === "release:fixture");
    assert.equal(entry.reason, "explicit release authority absent"); assert.equal(entry.route.program, "node");
  });
  await check("real full fixture CLI executes Node, nested, runtime and Rust", async () => {
    const receipt = await run(plan, bindings);
    assert.equal(receipt.status, "PASS"); assert.equal(receipt.executed.length, receipt.selected); assert.equal(receipt.blocked.length, 0);
    const marks = (await readFile(path.join(workspace, "marks.log"), "utf8")).trim().split("\n");
    assert.deepEqual(marks.sort(), ["contract", "first", "nested", "runtime"].sort());
    assert.equal(receipt.executed.find((entry) => entry.proof === "native").counts.passed, 1);
    assert.equal(receipt.packageName, "selector-conformance-fixture");
  });
  await check("missing runtime prerequisite blocks before contract selftest", async () => {
    const receipt = await run(plan, {}, 2);
    assert.equal(receipt.status, "BLOCKED"); assert.equal(receipt.executed.length, 0);
    assert.ok(receipt.blocked.some((entry) => entry.prerequisite === "candidate"));
  });
  await check("wrong artifact SHA-256 blocks real runtime", async () => {
    const receipt = await run(plan, { ...bindings, candidate: { ...bindings.candidate, sha256: "0".repeat(64) } }, 2);
    assert.equal(receipt.status, "BLOCKED"); assert.equal(receipt.executed.length, 0);
  });
  await check("directory identity mismatch blocks all children", async () => {
    const receipt = await run(plan, { ...bindings, "artifact-directory": { ...bindings["artifact-directory"], sha256: "0".repeat(64) } }, 2);
    assert.equal(receipt.status, "BLOCKED"); assert.equal(receipt.executed.length, 0);
  });
  await check("program artifact directory refuses private profile material", async () => {
    const profiles = path.join(artifactDirectory, "profiles"); await mkdir(profiles); await writeFile(path.join(profiles, "synthetic.tox"), "synthetic-only");
    await assert.rejects(() => bindingIdentity(bindings["artifact-directory"], "directory", owner, "artifact-directory"), /private material/);
    within(artifactDirectory, profiles); await rm(profiles, { recursive: true });
  });
  await check("physical host mismatch blocks selected platform execution", async () => {
    const otherPlatform = fixturePlatform === "windows" ? "debian" : "windows";
    const value = await prepare(owner, otherPlatform, []), output = path.join(workspace, "other-host-plan.json"), body = json(value);
    await writeFile(output, body);
    const receipt = await run({ output, sha256: digest(body), value }, bindings, 2);
    assert.equal(receipt.status, "BLOCKED"); assert.equal(receipt.executed.length, 0);
    assert.ok(receipt.blocked.some((item) => item.reason.includes("actual host")));
  });
  await check("raw plan SHA-256 rejects alteration", async () => {
    await cli(["run", "--plan", plan.output, "--plan-sha256", "0".repeat(64), "--evidence-root", path.join(workspace, "bad-sha")], 1);
  });
  await check("even rehashed truncated selection is rejected against complete current plan", async () => {
    const value = structuredClone(plan.value); value.selected = value.selected.slice(0, 1);
    const body = json(value), output = path.join(workspace, "tampered-plan.json"); await writeFile(output, body);
    await cli(["run", "--plan", output, "--plan-sha256", digest(body), "--evidence-root", path.join(workspace, "bad-selection")], 1);
  });
  await file("src/history/new-module.ts", "export const publicHistory = 1;\n");
  await file("scripts/data/test-new-suite.mjs", marker.replace("../../marks.log", "../../../marks.log") + '\nmark("new-suite");console.log("new suite: 1 assertion passed");\n');
  fixturePackage.scripts["test:new"] = "node scripts/data/test-new-suite.mjs";
  await file("package.json", json(fixturePackage));
  await file("native/src/late.rs", '#[cfg(feature="extra")]\n#[test]\nfn extra_test(){assert_eq!(7,7);}\n');
  await file("native/src/lib.rs", '#[test]\nfn baseline(){assert_eq!(2+2,4);}\nmod late;\n');
  await file("native/Cargo.toml", '[package]\nname="catalog_fixture"\nversion="0.1.0"\nedition="2021"\n[features]\ndefault=[]\nextra=[]\n');
  const unknownFeature = await planned(["src/shared/types.ts", "native/src/late.rs"], 2);
  await check("new module/suite are included; new unregistered feature blocks", () => {
    assert.ok(unknownFeature.value.source.files.some((item) => item.path === "src/history/new-module.ts"));
    assert.ok(unknownFeature.value.source.files.some((item) => item.path === "scripts/data/test-new-suite.mjs"));
    assert.ok(unknownFeature.value.selected.some((route) => route.args[0] === "scripts/data/test-new-suite.mjs"));
    assert.ok(unknownFeature.value.unresolved.some((item) => item.input.endsWith("#extra")));
    assert.equal(unknownFeature.value.impact[0].impact, "shared-contract");
  });
  fixtureCatalog.native[0].features.push("extra");
  await file("ci/verification-current.json", json(fixtureCatalog));
  await check("declaring a feature without a supported variant still blocks", async () => {
    const blocked = await planned([], 2);
    assert.ok(blocked.value.unresolved.some((item) => item.reason.includes("no supported test variant")));
  });
  fixtureCatalog.native[0].variants.push({ id: "extra", platforms: platformList, features: ["extra"], noDefault: false, scaleVariant: "default" });
  await file("ci/verification-current.json", json(fixtureCatalog));
  plan = await planned(["native/src/late.rs", "scripts/data/test-new-suite.mjs"]);
  await check("registered new feature/suite execute without editing a fixed suite list", async () => {
    const receipt = await run(plan, bindings);
    assert.equal(receipt.status, "PASS");
    assert.deepEqual(receipt.executed.filter((entry) => entry.proof === "native").map((entry) => entry.counts.passed), [1, 2]);
    assert.ok((await readFile(path.join(workspace, "marks.log"), "utf8")).includes("new-suite"));
  });
  await check("stale source is rejected before any child", async () => {
    await file("src/history/new-module.ts", "export const publicHistory = 2;\n");
    await cli(["run", "--plan", plan.output, "--plan-sha256", plan.sha256, "--evidence-root", path.join(workspace, "stale-source")], 1);
    await file("src/history/new-module.ts", "export const publicHistory = 1;\n");
  });
  await check("new unregistered physical suite fails closed", async () => {
    await file("scripts/test-unregistered.mjs", 'console.log("must not silently drop");\n');
    await cli(["plan", "--root", owner, "--platform", fixturePlatform, "--output", path.join(workspace, "unregistered-plan.json")], 1);
    await rm(path.join(owner, "scripts/test-unregistered.mjs"));
  });
  await check("new Cargo integration target is unresolved instead of dropped", async () => {
    await file("native/tests/late.rs", "#[test]\nfn integration(){assert!(true);}\n");
    const blocked = await planned([], 2);
    assert.ok(blocked.value.unresolved.some((item) => item.input.includes("#target:late")));
    await rm(path.join(owner, "native/tests/late.rs"));
  });
  await check("new Cargo manifest is unresolved instead of empty PASS", async () => {
    await file("new-native/Cargo.toml", '[package]\nname="new_native"\nversion="0.1.0"\nedition="2021"\n');
    await file("new-native/src/lib.rs", "#[test]\nfn new_test(){assert!(true);}\n");
    const lock = spawnSync("cargo", ["generate-lockfile", "--offline", "--manifest-path", "new-native/Cargo.toml"], { cwd: owner, encoding: "utf8", windowsHide: true });
    assert.equal(lock.status, 0, lock.stderr);
    const blocked = await planned([], 2);
    assert.ok(blocked.value.unresolved.some((item) => item.input === "new-native/Cargo.toml"));
    within(owner, path.join(owner, "new-native")); await rm(path.join(owner, "new-native"), { recursive: true });
  });
  await check("runtime descriptor cannot substitute --self-test", async () => {
    fixtureCatalog.routes[0].args = ["scripts/test-driver.mjs", "--self-test"];
    await file("ci/verification-current.json", json(fixtureCatalog));
    await cli(["plan", "--root", owner, "--platform", fixturePlatform, "--output", path.join(workspace, "bad-runtime-plan.json")], 1);
    fixtureCatalog.routes[0].args = ["scripts/test-driver.mjs", "{candidate}"];
    await file("ci/verification-current.json", json(fixtureCatalog));
  });
  const msiRuntime = {
    id: "windows:msi:fixture", covers: ["test-windows-msi-upgrade-runtime.ps1"], program: "powershell",
    args: ["-NoLogo", "-NoProfile", "-File", "scripts/test-windows-msi-upgrade-runtime.ps1", "-Phase", "Upgrade", "-WorkRoot", "{msi-runtime-work-root}"],
    platforms: ["windows"], authority: "laboratory", proof: "runtime",
    requires: { "msi-runtime-work-root": "value", "msi-runtime-state": "file" },
    exclusion: "Separate disposable guest and selected interactive console authority; UI Finish lifecycle gate remains separate.",
  };
  fixtureCatalog.routes.push(msiRuntime);
  registration.separate.push({ file: "test-windows-msi-upgrade-runtime.ps1", reason: msiRuntime.exclusion });
  await file("scripts/test-windows-msi-upgrade-runtime.ps1", 'throw "Laboratory MSI fixture must never execute in a product plan"\n');
  await file("ci/test-entrypoints.json", json(registration));
  await file("ci/verification-current.json", json(fixtureCatalog));
  await check("Windows PowerShell MSI phases register but remain outside product execution", async () => {
    for (const phase of ["Upgrade"]) {
      msiRuntime.args[5] = phase; await file("ci/verification-current.json", json(fixtureCatalog));
      const output = path.join(workspace, "msi-" + phase + "-plan.json");
      await cli(["plan", "--root", owner, "--platform", "windows", "--output", output]);
      const value = JSON.parse(await readFile(output, "utf8"));
      assert.equal(value.status, "READY");
      assert.ok(!value.selected.some((route) => route.id === msiRuntime.id));
      const entry = value.excluded.find((entry) => entry.id === msiRuntime.id);
      assert.equal(entry.route.program, "powershell"); assert.equal(entry.route.args[5], phase);
      assert.equal(entry.reason, msiRuntime.exclusion);
      assert.deepEqual(entry.route.requires, { "msi-runtime-work-root": "value", "msi-runtime-state": "file" });
    }
  });
  await check("Windows PowerShell rejects non-Windows and mixed platform declarations", async () => {
    for (const platforms of [["debian"], ["macos"], ["web"], ["windows", "debian"]]) {
      msiRuntime.platforms = platforms; await file("ci/verification-current.json", json(fixtureCatalog));
      const rejected = await cli(["plan", "--root", owner, "--platform", "windows", "--output", path.join(workspace, "bad-powershell-platform-plan.json")], 1);
      assert.match(rejected.stderr, /Windows PowerShell requires a Windows-only route/);
    }
    msiRuntime.platforms = ["windows"];
  });
  await check("MSI Status and Prepare cannot replace native runtime proof", async () => {
    for (const phase of ["Status", "Prepare"]) {
      msiRuntime.args[5] = phase; await file("ci/verification-current.json", json(fixtureCatalog));
      const rejected = await cli(["plan", "--root", owner, "--platform", "windows", "--output", path.join(workspace, "bad-msi-" + phase + "-plan.json")], 1);
      assert.match(rejected.stderr, /MSI runtime must execute the fixed upgrade phase/);
    }
    msiRuntime.args[5] = "Upgrade";
  });
  await check("MSI mutation cannot acquire automatic product authority", async () => {
    msiRuntime.authority = "product"; await file("ci/verification-current.json", json(fixtureCatalog));
    const rejected = await cli(["plan", "--root", owner, "--platform", "windows", "--output", path.join(workspace, "bad-msi-authority-plan.json")], 1);
    assert.match(rejected.stderr, /MSI mutation requires separate laboratory authority/);
    msiRuntime.authority = "laboratory";
  });
  await check("MSI runtime requires a prepared state file identity", async () => {
    delete msiRuntime.requires["msi-runtime-state"]; await file("ci/verification-current.json", json(fixtureCatalog));
    const rejected = await cli(["plan", "--root", owner, "--platform", "windows", "--output", path.join(workspace, "bad-msi-state-plan.json")], 1);
    assert.match(rejected.stderr, /MSI runtime requires immutable prepared state identity/);
  });
  fixtureCatalog.routes.pop(); registration.separate.pop();
  await file("ci/verification-current.json", json(fixtureCatalog));
  await file("ci/test-entrypoints.json", json(registration));
  await rm(path.join(owner, "scripts/test-windows-msi-upgrade-runtime.ps1"));
  await check("real child nonzero propagates FAIL and stops remaining required suites", async () => {
    await file("scripts/test-fail.mjs", 'console.error("injected child failure");process.exit(7);\n');
    fixturePackage.scripts["test:aaa-fail"] = "node scripts/test-fail.mjs";
    await file("package.json", json(fixturePackage)); const failedPlan = await planned();
    const receipt = await run(failedPlan, bindings, 2);
    assert.equal(receipt.status, "FAIL"); assert.ok(receipt.executed.some((item) => item.commands.some((cmd) => cmd.exitCode === 7)));
    assert.ok(receipt.blocked.some((item) => item.reason.includes("after required route failure")));
    delete fixturePackage.scripts["test:aaa-fail"]; await file("package.json", json(fixturePackage)); await rm(path.join(owner, "scripts/test-fail.mjs"));
  });
  await check("real child mutating bound artifact prevents final PASS", async () => {
    await file("scripts/test-driver.mjs", 'import assert from "node:assert/strict";\n' + driverSource.replace('mark("runtime");', 'writeFileSync(process.argv[2],"changed");mark("runtime");').replace('import { readFileSync }', 'import { readFileSync,writeFileSync }'));
    const mutationPlan = await planned(); const receipt = await run(mutationPlan, bindings, 2);
    assert.equal(receipt.status, "FAIL"); assert.ok(receipt.blocked.some((item) => item.prerequisite === "candidate"));
    await writeFile(artifact, "candidate-bytes"); await file("scripts/test-driver.mjs", 'import assert from "node:assert/strict";\n' + driverSource);
  });
  await check("real empty child cannot manufacture suite PASS", async () => {
    await file("scripts/test-empty.mjs", "");
    fixturePackage.scripts["test:aaa-empty"] = "node scripts/test-empty.mjs"; await file("package.json", json(fixturePackage));
    const emptyPlan = await planned(); const receipt = await run(emptyPlan, bindings, 2);
    assert.equal(receipt.status, "FAIL"); assert.ok(receipt.executed.some((item) => item.error?.includes("empty suite")));
    delete fixturePackage.scripts["test:aaa-empty"]; await file("package.json", json(fixturePackage)); await rm(path.join(owner, "scripts/test-empty.mjs"));
  });
  await check("real child mutating public source prevents final PASS", async () => {
    await file("scripts/test-driver.mjs", 'import assert from "node:assert/strict";\n' + driverSource.replace('mark("runtime");', 'writeFileSync(path.resolve(import.meta.dirname,"../src/during-run.ts"),"mutated");mark("runtime");').replace('import { readFileSync }', 'import { readFileSync,writeFileSync }'));
    const mutated = await planned(); const receipt = await run(mutated, bindings, 2);
    assert.equal(receipt.status, "FAIL"); assert.ok(receipt.blocked.some((item) => item.reason.includes("source mutated")));
    await rm(path.join(owner, "src/during-run.ts"));
    await file("scripts/test-driver.mjs", 'import assert from "node:assert/strict";\n' + driverSource);
  });
  await check("empty native test binary cannot manufacture full PASS", async () => {
    const previous = await readFile(path.join(owner, "native/src/lib.rs"), "utf8");
    await file("native/src/lib.rs", "pub fn empty(){}\n");
    const empty = await planned(); const receipt = await run(empty, bindings, 2);
    assert.equal(receipt.status, "FAIL"); assert.ok(receipt.executed.some((item) => item.error?.includes("empty or duplicate native discovery")));
    await file("native/src/lib.rs", previous);
  });
  await check("new ignored native test has no implicit skip authority", async () => {
    await file("native/src/lib.rs", '#[test]\nfn baseline(){assert_eq!(2+2,4);}\nmod late;\n#[test]\n#[ignore]\nfn scale_fixture(){assert_eq!(9,9);}\n');
    const ignoredPlan = await planned(); const receipt = await run(ignoredPlan, bindings, 2);
    assert.equal(receipt.status, "FAIL"); assert.ok(receipt.executed.some((item) => item.error?.includes("new ignored test")));
  });
  fixtureCatalog.native[0].ignored = [{ id: "fixture", name: "scale_fixture", windowsRoute: "scale:fixture", variants: ["default"], profile: "debug", timeoutMs: 120000 }];
  fixtureCatalog.routes.push({ id: "scale:fixture", covers: [], program: "cargo", args: ["test", "--locked", "--offline", "--manifest-path", "native/Cargo.toml", "--lib", "--no-run", "--message-format=json"],
    requires: {}, platforms: ["windows"], authority: "product", proof: "native-ignored", target: { name: "catalog_fixture", kind: "lib" }, selectedTests: ["scale_fixture"], ignored: [] });
  await file("ci/verification-current.json", json(fixtureCatalog));
  await check("registered ignored route really executes while ordinary counts remain explicit", async () => {
    const scalePlan = await planned(); const receipt = await run(scalePlan, bindings);
    const scaleID = fixturePlatform === "windows" ? "scale:fixture" : "native-scale:native/Cargo.toml:default:fixture";
    const scale = receipt.executed.find((item) => item.id === scaleID);
    assert.equal(scale.counts.passed, 1); assert.equal(scale.counts.ignored, 0);
    assert.ok(receipt.executed.filter((item) => item.proof === "native").every((item) => item.counts.ignored === 1));
  });
  await check("missing applicable ignored route blocks selection on that platform", async () => {
    if (fixturePlatform === "windows") fixtureCatalog.routes.find((item) => item.id === "scale:fixture").platforms = ["debian"];
    else fixtureCatalog.native[0].variants[0].platforms = ["windows"];
    await file("ci/verification-current.json", json(fixtureCatalog));
    const blocked = await planned([], 2); assert.ok(blocked.value.unresolved.some((item) => item.reason.includes("required ignored scale route")));
    fixtureCatalog.routes.find((item) => item.id === "scale:fixture").platforms = ["windows"]; fixtureCatalog.native[0].variants[0].platforms = platformList; await file("ci/verification-current.json", json(fixtureCatalog));
  });
  await check("unknown platform is rejected", async () => {
    await cli(["plan", "--root", owner, "--platform", "android", "--output", path.join(workspace, "android-plan.json")], 1);
  });
  await check("native summary forbids missing or duplicate execution counts", () => {
    assert.throws(() => nativeCounts("")); assert.throws(() => nativeCounts("test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out\n".repeat(2)));
  });
  const actualPlans = {};
  for (const platform of platformList) {
    await check("current owner " + platform + " has executable complete full plan", async () => {
      const current = await prepare(actualRoot, platform, ["future/unknown", "src/types.ts"]);
      assert.equal(current.status, "READY", json(current.unresolved));
      assert.ok(current.selected.length > 0 && current.selected.every((route) => route.args.length && route.required));
      assert.ok(current.discovered.entrypoints.includes("test-current-verification-contract.mjs"));
      assert.ok(current.selected.filter((route) => route.proof === "native").every((route) => !route.args.includes("--all-features")));
      const raw = json(current); await writeFile(path.join(workspace, "current-" + platform + "-plan.json"), raw);
      actualPlans[platform] = { sha256: digest(raw), selected: current.selected.length, excluded: current.excluded.length, discovered: current.discovered };
    });
  }
  await check("real two-client route and selftest are distinct in current owner plan", async () => {
    const current = JSON.parse(await readFile(path.join(workspace, "current-windows-plan.json"), "utf8"));
    const runtime = current.selected.find((route) => route.id === "driver:pq-two-instances:runtime");
    const contract = current.selected.find((route) => route.id === "driver:pq-two-instances:contract");
    assert.ok(runtime && contract && runtime.id !== contract.id);
    assert.ok(runtime.args.includes("--artifact-root") && !runtime.args.includes("--self-test"));
    assert.ok(contract.args.includes("--self-test") && !contract.requires?.["artifact-root"]);
  });
  await check("current MSI registration preserves fixed native phases and separate UI acceptance", async () => {
    for (const platform of platformList) {
      const current = JSON.parse(await readFile(path.join(workspace, "current-" + platform + "-plan.json"), "utf8"));
      assert.ok(current.discovered.entrypoints.includes("test-windows-msi-upgrade-runtime.ps1"));
      assert.ok(!current.selected.some((route) => route.covers.includes("test-windows-msi-upgrade-runtime.ps1")));
      const routes = current.excluded.filter((entry) => entry.route.covers.includes("test-windows-msi-upgrade-runtime.ps1")).map((entry) => entry.route);
      assert.equal(routes.length, 1);
      assert.deepEqual(routes.map((route) => route.args[route.args.indexOf("-Phase") + 1]).sort(), ["Upgrade"]);
      for (const route of routes) {
        assert.equal(route.program, "powershell"); assert.equal(route.authority, "laboratory"); assert.equal(route.proof, "runtime");
        assert.deepEqual(route.platforms, ["windows"]);
        assert.deepEqual(route.requires, { "msi-runtime-work-root": "value", "msi-runtime-state": "file" });
        assert.match(route.exclusion, /interactive console/); assert.match(route.exclusion, /UI Finish cases remain a separate lifecycle gate/);
      }
    }
  });
  await check("all nested leaves are counted under selected parent execution", async () => {
    const current = JSON.parse(await readFile(path.join(workspace, "current-windows-plan.json"), "utf8"));
    assert.deepEqual(current.nested.map((nested) => nested.file).sort(), [
      "test-chat-links.mjs",
      "test-context-menu-coordinator.mjs",
      "test-ci-incremental-verification.mjs",
      "test-windows-ci-handoff.mjs",
      "test-release-version.mjs",
    ].sort());
    for (const nested of current.nested) assert.ok(current.selected.some((route) => route.covers.includes(nested.parent)));
  });
  await writeFile(path.join(workspace, "conformance.json"), json({ schema: 1, status: "PASS", scope: "selector-conformance-fixture; current-owner plans only",
    assertions, results, actualPlans, productBaselineExecuted: false, actualTwoClientRuntimeExecuted: false, noManagedDownloads: true, noPublication: true }));
  console.log(json({ status: "PASS", assertions, scope: "selector conformance; product full execution remains separate", evidenceRoot: persistent ? workspace : "disposable cleaned" }));
} catch (error) {
  await writeFile(path.join(workspace, "conformance-failure.json"), json({ status: "FAIL", results, error: error.stack }));
  throw error;
} finally {
  if (!persistent) {
    const parent = path.resolve(tmpdir()), rel = within(parent, workspace);
    assert.ok(rel.startsWith("kaigen-full-catalog-") && !rel.includes("/"), "unexpected disposable cleanup target");
    await rm(workspace, { recursive: true, force: false });
  }
}

