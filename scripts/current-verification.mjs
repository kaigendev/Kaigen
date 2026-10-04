import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { access, lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
const SHA = /^[A-F0-9]{64}$/;
const privatePath = /^(profiles?|data|downloads|history|messages|credentials|secrets|runtime|context\.local|node_modules|target|dist(?:-web)?|work|outputs|\.git|\.serena)(\/|$)|^(src-tauri|web\/kaigen-webd)\/target(\/|$)/i;
export const digest = (bytes) => createHash("sha256").update(bytes).digest("hex").toUpperCase();
const json = (value) => JSON.stringify(value, null, 2) + "\n";
const normalized = (value) => value.replaceAll("\\", "/");
export function within(root, file) {
  const rel = path.relative(path.resolve(root), path.resolve(file));
  assert.ok(rel && !rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel), "path outside exact owner root");
  return normalized(rel);
}
async function fingerprint(file) {
  const item = await lstat(file);
  assert.ok(item.isFile() && !item.isSymbolicLink(), "expected a regular file: " + file);
  return { sha256: digest(await readFile(file)), bytes: item.size };
}
async function executable(program) {
  if (program === "node") return process.execPath;
  if (path.isAbsolute(program)) return realpath(program);
  const extensions = process.platform === "win32" ? ["", ...((process.env.PATHEXT ?? ".EXE;.CMD").split(";"))] : [""];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    for (const extension of extensions) {
      const candidate = path.join(dir, program + extension);
      try { await access(candidate); if ((await lstat(candidate)).isFile()) return realpath(candidate); } catch {}
    }
  }
  throw new Error("executable unavailable: " + program);
}
async function capture(program, args, cwd, timeoutMs = 120000, env = process.env) {
  const actual = await executable(program);
  return new Promise((resolve, reject) => {
    const child = spawn(actual, args, { cwd, env, windowsHide: true, shell: false });
    let stdout = "", stderr = "", timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
      else child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ program: actual, args, code, signal, timedOut, stdout, stderr });
    });
  });
}
async function success(program, args, root) {
  const result = await capture(program, args, root);
  assert.ok(result.code === 0 && !result.timedOut, program + " failed: " + result.stderr.slice(-2000));
  return result.stdout;
}
export async function inventory(root) {
  const names = (await success("git", ["-c", "safe.directory=" + root, "ls-files", "--cached", "--others", "--exclude-standard", "-z"], root)).split("\0").filter(Boolean);
  const excluded = [];
  const files = [];
  for (const name of [...new Set(names)].sort()) {
    const rel = normalized(name);
    within(root, path.resolve(root, rel));
    if (privatePath.test(rel)) { excluded.push({ path: rel, reason: "generated, managed cache, private or runtime tree" }); continue; }
    try { files.push({ path: rel, ...await fingerprint(path.join(root, rel)) }); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      files.push({ path: rel, missing: true });
    }
  }
  assert.ok(files.length, "empty current source inventory");
  return { files, excluded, sha256: digest(json(files)) };
}
function tokens(command) {
  const matches = command.match(/"[^"]*"|'[^']*'|[^\s]+/g) ?? [];
  return matches.map((value) => /^["']/.test(value) ? value.slice(1, -1) : value);
}
function routeKey(route) {
  return route.program + ":" + digest(json(route.args)).slice(0, 16);
}
function checkRoute(route, catalog) {
  assert.ok(route.id && ["node", "pwsh", "powershell", "bash", "cargo"].includes(route.program), "missing executable route: " + route.id);
  assert.ok(Array.isArray(route.args) && route.args.length, "empty command: " + route.id);
  assert.ok(route.platforms?.length && route.platforms.every((p) => catalog.platforms.includes(p)), "unknown route platform");
  if (route.program === "powershell") assert.deepEqual(route.platforms, ["windows"], "Windows PowerShell requires a Windows-only route");
  assert.ok(["product", "laboratory", "release"].includes(route.authority), "missing applicability authority");
  if (route.proof === "runtime") assert.ok(!route.args.includes("--self-test") && !route.args.includes("--pure"), "runtime replaced by contract selftest");
  if (route.args.includes("scripts/test-windows-msi-upgrade-runtime.ps1")) {
    assert.equal(route.program, "powershell", "MSI runtime requires Windows PowerShell");
    assert.equal(route.authority, "laboratory", "MSI mutation requires separate laboratory authority");
    assert.equal(route.proof, "runtime", "MSI phase must retain its runtime boundary");
    const phases = route.args.flatMap((arg, index) => arg.toLowerCase() === "-phase" ? [route.args[index + 1]] : []);
    assert.ok(phases.length === 1 && phases[0] === "Upgrade", "MSI runtime must execute the fixed upgrade phase");
    assert.equal(route.args[route.args.indexOf("-WorkRoot") + 1], "{msi-runtime-work-root}", "MSI runtime requires its exact work root binding");
    assert.equal(route.requires?.["msi-runtime-work-root"], "value", "MSI work root is mutable runtime state");
    assert.equal(route.requires?.["msi-runtime-state"], "file", "MSI runtime requires immutable prepared state identity");
  }
  const placeholders = route.args.filter((arg) => /^\{[^{}]+\}$/.test(arg)).map((arg) => arg.slice(1, -1));
  for (const key of placeholders) assert.ok(route.requires?.[key], "unbound command argument: " + key);
  for (const kind of Object.values(route.requires ?? {})) assert.ok(["file", "directory", "output", "value"].includes(kind), "unknown prerequisite kind");
}
export function impactOf(changed, catalog) {
  return changed.map((input) => {
    const file = normalized(input);
    return { input: file, impact: catalog.sharedContracts.some((prefix) => file.startsWith(prefix)) ? "shared-contract"
      : file.startsWith("src-tauri/") || file.startsWith("web/") ? "native"
      : file.startsWith("src/") || file.startsWith("scripts/") ? "frontend" : "unknown",
    action: "full-current-fallback" };
  });
}
export function createFullPlan({ catalog, packageJson, registration, files, metadata, platform, changed = [] }) {
  assert.equal(catalog.schema, 1);
  assert.equal(catalog.kind, "kaigen-current-full-verification");
  assert.ok(catalog.platforms.includes(platform), "unsupported current platform");
  assert.equal(registration.schema, 1);
  const scripts = packageJson.scripts;
  const sourceFiles = new Set(files.filter((f) => !f.missing).map((f) => f.path));
  const routes = new Map();
  const aliasCoverage = [];
  const insert = (route) => {
    checkRoute(route, catalog);
    assert.ok(!routes.has(route.id), "duplicate route ID: " + route.id);
    routes.set(route.id, route);
  };
  for (const route of catalog.routes) {
    for (const file of route.covers) assert.ok(sourceFiles.has("scripts/" + file), "stale route: " + file);
    insert({ ...route, aliases: [] });
  }
  const nonLeaf = new Map(catalog.nonLeafAliases.map((item) => [item.alias, item]));
  const visiting = new Set();
  const addCommand = (alias, command, buildOnly = false) => {
    for (const part of command.split(/\s*&&\s*/)) {
      const args = tokens(part);
      if (args[0] === "npm" && args[1] === "run" && args.length === 3) {
        const next = args[2];
        assert.ok(scripts[next], "missing aggregate alias: " + next);
        assert.ok(!visiting.has(next), "recursive aggregate alias: " + next);
        visiting.add(next); addAlias(next); visiting.delete(next);
        for (const route of routes.values()) if (route.aliases.includes(next)) route.aliases.push(alias);
      } else if (args[0] === "node" && /^scripts\/[^\s]+\.mjs$/.test(args[1] ?? "")) {
        if (buildOnly && !/^scripts\/test-/.test(args[1])) continue;
        const file = path.posix.basename(args[1]);
        assert.ok(sourceFiles.has(args[1]), "missing script: " + args[1]);
        if (catalog.replaceDirect.some((entry) => entry.file === file && json(entry.args) === json(args.slice(2)))) continue;
        const route = { program: "node", args: args.slice(1), covers: [args[1].slice(8)], platforms: catalog.platforms, authority: "product", proof: args.includes("--self-test") ? "contract" : "suite",
          requires: catalog.directPrerequisites[file] ?? {}, aliases: [alias] };
        const declared = [...routes.values()].find((entry) => entry.program === route.program && json(entry.args) === json(route.args) && entry.authority === "product");
        if (declared) {
          declared.aliases.push(alias);
          declared.covers = [...new Set([...declared.covers, ...route.covers])];
          continue;
        }
        const id = "script:" + file + ":" + routeKey(route).split(":")[1];
        if (routes.has(id)) routes.get(id).aliases.push(alias);
        else insert({ ...route, id });
      } else if (!buildOnly) throw new Error("test alias needs an explicit executable route: " + alias + " = " + part);
    }
  };
  const addAlias = (alias) => {
    if (catalog.controlAliases.includes(alias)) return;
    if (nonLeaf.has(alias)) {
      assert.equal(scripts[alias], nonLeaf.get(alias).command, "changed native aggregate needs catalog review");
      aliasCoverage.push({ alias, reason: nonLeaf.get(alias).reason }); return;
    }
    const covered = catalog.coverageAliases[alias];
    if (covered) {
      assert.equal(scripts[alias], covered.command, "changed subset alias needs coverage review");
      assert.ok(scripts[covered.by], "missing covering alias");
      aliasCoverage.push({ alias, by: covered.by, reason: covered.reason }); addCommand(covered.by, scripts[covered.by]); return;
    }
    addCommand(alias, scripts[alias]);
  };
  for (const alias of Object.keys(scripts).filter((name) => name.startsWith("test:")).sort()) addAlias(alias);
  for (const alias of ["build", "build:web"]) if (scripts[alias]) addCommand(alias, scripts[alias], true);
  const covered = new Set([...routes.values()].flatMap((route) => route.covers));
  const nested = [];
  for (const entry of registration.nested) {
    assert.ok(covered.has(entry.parent), "missing nested parent route: " + entry.parent);
    assert.ok(sourceFiles.has("scripts/" + entry.file), "stale nested registration");
    assert.ok(entry.invocation, "missing nested invocation");
    covered.add(entry.file); nested.push(entry);
  }
  const entrypoints = files.filter((file) => /^scripts\/(?:.*\/)?test-[^/]+\.(mjs|ps1|sh)$/.test(file.path) && !file.missing).map((file) => file.path.slice(8));
  for (const file of entrypoints) assert.ok(covered.has(file), "unregistered executable test: " + file);
  for (const entry of registration.separate) assert.ok(covered.has(entry.file), "reason-only registration has no executable route: " + entry.file);
  const unresolved = [];
  const native = new Map(catalog.native.map((item) => [item.manifest, item]));
  const manifests = files.filter((file) => /(^|\/)Cargo\.toml$/.test(file.path) && !file.missing).map((file) => file.path);
  for (const manifest of manifests) {
    const spec = native.get(manifest);
    if (!spec) { unresolved.push({ input: manifest, reason: "new Cargo manifest requires explicit target/feature/platform routes" }); continue; }
    const meta = metadata[manifest];
    assert.ok(meta?.features && meta?.targets, "missing offline Cargo metadata: " + manifest);
    const primaryTarget = (target) => target.name === spec.target.name && (spec.target.kind === "lib"
      ? target.kind.some((kind) => ["lib", "rlib", "staticlib", "cdylib"].includes(kind)) : target.kind.includes(spec.target.kind));
    for (const target of meta.targets.filter((target) => target.test && !primaryTarget(target))) {
      const exemption = (spec.exemptTargets ?? []).find((item) => item.name === target.name && target.kind.includes(item.kind));
      const input = exemption && files.find((file) => file.path === exemption.source);
      if (!exemption || !input || input.sha256 !== exemption.sha256) unresolved.push({ input: manifest + "#target:" + target.name, reason: "new or changed additional Cargo test target requires an executable route" });
    }
    for (const feature of Object.keys(meta.features)) if (!spec.features.includes(feature)) unresolved.push({ input: manifest + "#" + feature, reason: "new feature requires supported variant registration" });
    for (const feature of spec.features) assert.ok(Object.hasOwn(meta.features, feature), "stale supported Cargo feature: " + feature);
    const supportedFeatures = new Set();
    const includeFeature = (feature) => {
      if (supportedFeatures.has(feature) || !Object.hasOwn(meta.features, feature)) return;
      supportedFeatures.add(feature);
      for (const dependency of meta.features[feature]) includeFeature(dependency);
    };
    for (const variant of spec.variants) {
      if (!variant.noDefault) includeFeature("default");
      variant.features.forEach(includeFeature);
    }
    for (const feature of Object.keys(meta.features)) if (feature !== "default" && !supportedFeatures.has(feature)) unresolved.push({ input: manifest + "#" + feature, reason: "declared feature has no supported test variant" });
    assert.ok(meta.targets.some((target) => primaryTarget(target) && target.test), "missing test target: " + manifest + "#" + spec.target.name);
    for (const variant of spec.variants) {
      assert.ok(variant.features.every((feature) => Object.hasOwn(meta.features, feature)), "variant uses unknown Cargo feature");
      const args = ["test", "--locked", "--offline", "--manifest-path", manifest,
        ...(spec.target.kind === "lib" ? ["--lib"] : ["--bin", spec.target.name]),
        ...(variant.noDefault ? ["--no-default-features"] : []),
        ...(variant.features.length ? ["--features", variant.features.join(",")] : []), "--no-run", "--message-format=json"];
      const ignored = spec.ignored.filter((item) => item.variants.includes(variant.scaleVariant ?? variant.id)).map((item) => ({
        name: item.name, route: platform === "windows" ? item.windowsRoute : "native-scale:" + manifest + ":" + (variant.scaleVariant ?? variant.id) + ":" + item.id,
      }));
      insert({ id: "native:" + manifest + ":" + variant.id, covers: [], program: "cargo", args, platforms: variant.platforms, authority: "product", proof: "native",
        target: spec.target, ignored, features: variant.features, noDefault: variant.noDefault, requires: {}, aliases: [] });
      for (const item of spec.ignored.filter((item) => item.variants.includes(variant.id))) {
        const scalePlatforms = variant.platforms.filter((p) => p !== "windows");
        if (!scalePlatforms.length) continue;
        const scaleArgs = args.slice();
        if (item.profile === "release") scaleArgs.splice(1, 0, "--release");
        insert({ id: "native-scale:" + manifest + ":" + variant.id + ":" + item.id, covers: [], program: "cargo", args: scaleArgs,
          platforms: scalePlatforms, authority: "product", proof: "native-ignored", target: spec.target,
          selectedTests: [item.name], ignored: [], features: variant.features, noDefault: variant.noDefault, requires: {}, aliases: [], timeoutMs: item.timeoutMs });
      }
    }
  }
  for (const spec of catalog.native) assert.ok(manifests.includes(spec.manifest), "stale native manifest route");
  for (const route of routes.values()) route.aliases = [...new Set(route.aliases)].sort();
  const selected = [], excluded = [];
  for (const route of routes.values()) {
    if (!route.platforms.includes(platform)) excluded.push({ id: route.id, reason: "different supported platform", route });
    else if (route.authority !== "product") excluded.push({ id: route.id, reason: route.exclusion ?? "requires explicit " + route.authority + " authority", route });
    else selected.push({ ...route, required: true });
  }
  for (const route of selected.filter((item) => item.proof === "native")) for (const item of route.ignored) {
    if (!selected.some((candidate) => candidate.id === item.route)) unresolved.push({ input: item.name, reason: "required ignored scale route is unavailable on selected platform" });
  }
  assert.ok(selected.length, "full selection is empty");
  return { schema: 1, kind: "kaigen-current-full-plan", mode: "full", platform, packageName: packageJson.name, packageVersion: packageJson.version,
    impact: impactOf(changed, catalog), discovered: { entrypoints, manifests, routes: routes.size }, selected, excluded, nested, aliasCoverage, unresolved,
    status: unresolved.length ? "BLOCKED" : "READY", claim: "Plan is not execution or product acceptance." };
}
export async function prepare(root, platform, changed = []) {
  root = await realpath(root);
  const source = await inventory(root);
  const catalog = JSON.parse(await readFile(path.join(root, "ci/verification-current.json"), "utf8"));
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const registration = JSON.parse(await readFile(path.join(root, "ci/test-entrypoints.json"), "utf8"));
  const metadata = {};
  for (const file of source.files.filter((item) => /(^|\/)Cargo\.toml$/.test(item.path) && !item.missing)) {
    const raw = await success("cargo", ["metadata", "--locked", "--offline", "--no-deps", "--format-version", "1", "--manifest-path", file.path], root);
    const parsed = JSON.parse(raw);
    const ownManifest = path.resolve(root, file.path);
    const pkg = parsed.packages.find((item) => path.resolve(item.manifest_path) === ownManifest);
    assert.ok(pkg, "metadata did not identify exact manifest");
    metadata[file.path] = { name: pkg.name, features: pkg.features, targets: pkg.targets.map((target) => ({ name: target.name, kind: target.kind, test: target.test, requiredFeatures: target["required-features"] ?? [] })) };
  }
  const plan = createFullPlan({ catalog, packageJson, registration, files: source.files, metadata, platform, changed });
  for (const entry of plan.nested) assert.ok((await readFile(path.join(root, "scripts", entry.parent), "utf8")).includes(entry.invocation), "nested invocation disappeared");
  return { ...plan, root, source, catalog: await fingerprint(path.join(root, "ci/verification-current.json")), producer: await fingerprint(import.meta.filename), metadata };
}
export async function treeIdentity(root) {
  const entries = [];
  async function visit(directory) {
    for (const item of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, item.name), rel = within(root, file);
      assert.ok(!/(^|\/)(profiles?|data|downloads|credentials|secrets|history|messages)(\/|$)/i.test(rel), "private material inside artifact binding");
      assert.ok(!item.isSymbolicLink(), "symlink inside artifact binding");
      if (item.isDirectory()) await visit(file);
      else entries.push({ path: rel, ...await fingerprint(file) });
    }
  }
  await visit(root);
  assert.ok(entries.length, "empty directory binding");
  return { sha256: digest(json(entries)), files: entries };
}
export async function bindingIdentity(binding, kind, root, key) {
  assert.ok(binding && typeof binding.value === "string" && binding.value, "missing prerequisite: " + key);
  assert.equal(binding.kind, kind, "wrong prerequisite kind: " + key);
  if (kind === "value") return { kind, value: binding.value, sha256: digest(binding.value) };
  assert.ok(path.isAbsolute(binding.value), "binding path must be absolute: " + key);
  if (kind === "output") {
    try { await lstat(binding.value); throw new Error("output already exists: " + key); } catch (error) { if (error.code !== "ENOENT") throw error; }
    return { kind, value: path.resolve(binding.value), absent: true };
  }
  assert.ok(SHA.test(binding.sha256 ?? ""), "missing exact prerequisite SHA-256: " + key);
  const actual = await realpath(binding.value);
  if (["dist", "dist-web"].includes(key)) assert.equal(actual, path.resolve(root, key), "bundle must be canonical current output");
  const identity = kind === "file" ? await fingerprint(actual) : await treeIdentity(actual);
  assert.equal(identity.sha256, binding.sha256, "prerequisite identity mismatch: " + key);
  return { kind, value: actual, ...identity };
}
function discovery(text, allowEmpty = false) {
  const tests = [...text.matchAll(/^(.+): test$/gm)].map((m) => m[1]);
  assert.ok((allowEmpty || tests.length) && new Set(tests).size === tests.length, "empty or duplicate native discovery");
  return tests;
}
export function nativeCounts(text) {
  const summaries = [...text.matchAll(/test result: (ok|FAILED)\.\s+(\d+) passed;\s+(\d+) failed;\s+(\d+) ignored;\s+(\d+) measured;\s+(\d+) filtered out/g)];
  assert.equal(summaries.length, 1, "missing/duplicate native execution summary");
  const [, status, passed, failed, ignored, measured, filtered] = summaries[0];
  return { status, passed: Number(passed), failed: Number(failed), ignored: Number(ignored), measured: Number(measured), filtered: Number(filtered) };
}
export async function execute(plan, planSha256, evidenceRoot, bindings = {}) {
  assert.equal(digest(json(plan)), planSha256, "plan identity mismatch");
  assert.equal(plan.kind, "kaigen-current-full-plan");
  assert.equal(plan.mode, "full");
  const current = await prepare(plan.root, plan.platform, plan.impact.map((item) => item.input));
  const source = current.source;
  assert.equal(source.sha256, plan.source.sha256, "source changed after full plan");
  assert.equal(digest(json(current)), planSha256, "full plan/catalog/producer/selection changed");
  assert.ok(plan.selected.length, "empty full execution");
  assert.equal(new Set(plan.selected.map((route) => route.id)).size, plan.selected.length, "duplicate execution route");
  await mkdir(evidenceRoot, { recursive: false });
  const receipt = { schema: 1, kind: "kaigen-current-full-receipt", status: "OPEN", scope: "current-owner-full-" + plan.platform,
    packageName: plan.packageName, root: plan.root, host: { platform: process.platform, arch: process.arch, node: process.version }, planSha256, sourceSha256: source.sha256, catalogSha256: plan.catalog.sha256,
    discovered: plan.discovered, selected: plan.selected.length, executed: [], skipped: plan.excluded.map(({ id, reason }) => ({ id, reason })), blocked: [...plan.unresolved], bindings: {},
    nativeProvenanceLimit: "Cargo exe bytes/features/arguments/discovery/counts are bound. This runner does not observe loaded DLLs or establish managed native runtime closure; that evidence belongs to the separate artifact finish.",
    claim: "Execution applies only to this exact owner inventory/platform; contract tests are not runtime acceptance." };
  const expectedHost = { windows: "win32", debian: "linux", macos: "darwin" }[plan.platform];
  if (expectedHost && process.platform !== expectedHost) receipt.blocked.push({ reason: "selected platform requires actual host " + expectedHost });
  const required = new Map();
  for (const route of plan.selected) for (const [key, kind] of Object.entries(route.requires ?? {})) {
    assert.ok(!required.has(key) || required.get(key) === kind, "incompatible shared prerequisite: " + key); required.set(key, kind);
  }
  for (const [key, kind] of required) {
    try { receipt.bindings[key] = await bindingIdentity(bindings[key], kind, plan.root, key); }
    catch (error) { receipt.blocked.push({ prerequisite: key, reason: error.message }); }
  }
  const save = async () => { await writeFile(path.join(evidenceRoot, "receipt.json"), json(receipt)); return receipt; };
  if (receipt.blocked.length) { receipt.status = "BLOCKED"; return save(); }
  const env = { ...process.env, CARGO_NET_OFFLINE: "true" };
  delete env.KAIGEN_PQ_FAULT_STAGE; delete env.QTOX_IMPORT_SCRIPT_OUTPUT_ROOT;
  for (let index = 0; index < plan.selected.length; index++) {
    const route = plan.selected[index], prefix = String(index + 1).padStart(3, "0");
    const recorded = { id: route.id, proof: route.proof, status: "OPEN", commands: [] };
    const run = async (program, args, suffix, processEnv = env) => {
      const start = Date.now();
      const result = await capture(program, args, plan.root, route.timeoutMs ?? 1200000, processEnv);
      const stdoutFile = prefix + "-" + suffix + ".stdout.log", stderrFile = prefix + "-" + suffix + ".stderr.log";
      await writeFile(path.join(evidenceRoot, stdoutFile), result.stdout);
      await writeFile(path.join(evidenceRoot, stderrFile), result.stderr);
      recorded.commands.push({ program: result.program, tool: await fingerprint(result.program), args, exitCode: result.code, signal: result.signal, timedOut: result.timedOut, elapsedMs: Date.now() - start,
        stdout: { path: stdoutFile, sha256: digest(result.stdout) }, stderr: { path: stderrFile, sha256: digest(result.stderr) } });
      assert.ok(result.code === 0 && !result.timedOut, "command failed: " + route.id);
      return result.stdout + "\n" + result.stderr;
    };
    try {
      const args = route.args.map((arg) => /^\{[^{}]+\}$/.test(arg) ? receipt.bindings[arg.slice(1, -1)].value : arg);
      if (route.proof === "native" || route.proof === "native-ignored") {
        const output = await run(route.program, args, "compile");
        const artifacts = output.split(/\r?\n/).filter((line) => line.startsWith("{")).map((line) => JSON.parse(line)).filter((item) =>
          item.reason === "compiler-artifact" && item.profile?.test && item.target?.name === route.target.name && item.executable);
        assert.equal(artifacts.length, 1, "ambiguous/missing full native test artifact");
        const binary = await realpath(artifacts[0].executable);
        recorded.artifact = { path: binary, ...await fingerprint(binary), features: artifacts[0].features, profile: artifacts[0].profile };
        const nativeEnv = { ...env, PATH: [path.dirname(binary), path.dirname(path.dirname(binary)), env.PATH].join(path.delimiter) };
        const all = discovery(await run(binary, ["--list", "--format", "terse"], "discovery", nativeEnv));
        const ignored = discovery(await run(binary, ["--list", "--ignored", "--format", "terse"], "ignored", nativeEnv), true);
        for (const name of route.proof === "native" ? ignored : []) {
          const known = route.ignored.find((item) => item.name === name);
          assert.ok(known, "new ignored test has no executable scale route: " + name);
          assert.ok(plan.selected.some((item) => item.id === known.route), "missing required ignored-test route");
        }
        recorded.discovered = all.length;
        const selectedTests = route.proof === "native-ignored" ? route.selectedTests : all.filter((name) => !ignored.includes(name));
        assert.ok(selectedTests.length && selectedTests.every((name) => all.includes(name)), "required native tests missing");
        if (route.proof === "native-ignored") assert.ok(selectedTests.every((name) => ignored.includes(name)), "scale selector is not ignored");
        const testArgs = route.proof === "native-ignored" ? [...selectedTests, "--exact", "--ignored", "--nocapture"] : ["--nocapture"];
        const counts = nativeCounts(await run(binary, testArgs, "tests", nativeEnv));
        assert.equal(counts.status, "ok"); assert.equal(counts.failed, 0); assert.equal(counts.measured, 0);
        assert.equal(counts.passed, selectedTests.length); assert.ok(counts.passed > 0, "empty native execution");
        assert.equal(counts.ignored, route.proof === "native" ? ignored.length : 0);
        assert.equal(counts.filtered, route.proof === "native" ? 0 : all.length - selectedTests.length);
        recorded.counts = counts; recorded.selectedTests = selectedTests;
        recorded.ignoredRoutes = route.proof === "native" ? ignored.map((name) => route.ignored.find((item) => item.name === name)) : [];
        const after = await fingerprint(binary);
        assert.equal(after.sha256, recorded.artifact.sha256, "native exe changed during execution");
      } else {
        const output = await run(route.program, args, "tests");
        assert.ok(output.trim(), "empty suite execution: " + route.id);
      }
      recorded.status = "PASS";
    } catch (error) {
      recorded.status = "FAIL"; recorded.error = error.message;
    }
    receipt.executed.push(recorded);
    if (recorded.status !== "PASS") {
      receipt.status = "FAIL";
      receipt.blocked.push(...plan.selected.slice(index + 1).map((item) => ({ id: item.id, reason: "not executed after required route failure" })));
      return save();
    }
  }
  for (const [key, kind] of required) if (kind !== "output") {
    try { const finalBinding = await bindingIdentity(bindings[key], kind, plan.root, key); assert.equal(finalBinding.sha256, receipt.bindings[key].sha256, "immutable binding changed"); }
    catch (error) { receipt.blocked.push({ prerequisite: key, reason: error.message }); }
  }
  for (const item of receipt.executed.filter((entry) => entry.artifact)) {
    try { assert.equal((await fingerprint(item.artifact.path)).sha256, item.artifact.sha256, "native exe changed after execution"); }
    catch (error) { receipt.blocked.push({ id: item.id, reason: error.message }); }
  }
  const finalSource = await inventory(plan.root);
  if (finalSource.sha256 !== plan.source.sha256) { receipt.status = "FAIL"; receipt.blocked.push({ reason: "source mutated during full execution" }); }
  else receipt.status = receipt.executed.length === receipt.selected && receipt.executed.every((item) => item.status === "PASS") && !receipt.blocked.length ? "PASS" : "FAIL";
  return save();
}
async function main(argv) {
  const operation = argv.shift(), options = {};
  const changed = [];
  while (argv.length) {
    const flag = argv.shift(), value = argv.shift();
    assert.ok(value && !value.startsWith("--"), "missing option value: " + flag);
    if (flag === "--changed") changed.push(value);
    else {
      assert.ok(["--root", "--platform", "--output", "--plan", "--plan-sha256", "--evidence-root", "--bindings"].includes(flag) && !options[flag], "unknown/duplicate option: " + flag);
      options[flag] = value;
    }
  }
  if (operation === "plan") {
    assert.ok(options["--output"] && options["--platform"], "plan requires --platform and fresh --output");
    const plan = await prepare(options["--root"] ?? ROOT, options["--platform"], changed);
    const body = json(plan);
    await writeFile(options["--output"], body, { flag: "wx" });
    console.log(json({ status: plan.status, selected: plan.selected.length, excluded: plan.excluded.length, unresolved: plan.unresolved, planSha256: digest(body), output: options["--output"] }));
    if (plan.status === "BLOCKED") process.exitCode = 2;
  } else if (operation === "run") {
    assert.ok(options["--plan"] && options["--plan-sha256"] && options["--evidence-root"], "run requires exact --plan/--plan-sha256 and fresh --evidence-root");
    const body = await readFile(options["--plan"]);
    assert.equal(digest(body), options["--plan-sha256"], "raw plan SHA-256 mismatch");
    const receipt = await execute(JSON.parse(body), options["--plan-sha256"], options["--evidence-root"], options["--bindings"] ? JSON.parse(await readFile(options["--bindings"], "utf8")) : {});
    console.log(json({ status: receipt.status, selected: receipt.selected, executed: receipt.executed.length, skipped: receipt.skipped.length, blocked: receipt.blocked.length }));
    if (receipt.status !== "PASS") process.exitCode = 2;
  } else throw new Error("Use plan --platform windows|debian|macos|web --output <fresh.json>; run --plan <json> --plan-sha256 <SHA256> --evidence-root <fresh-directory> [--bindings <json>].");
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try { await main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

