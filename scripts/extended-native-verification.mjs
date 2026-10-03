import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const root = fileURLToPath(new URL("../", import.meta.url));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export function parseDiscovery(output) {
  const names = [...output.matchAll(/^([A-Za-z_][A-Za-z0-9_:]*): test\r?$/gm)].map((match) => match[1]);
  assert.ok(names.length, "Rust discovery returned zero tests");
  assert.equal(new Set(names).size, names.length, "duplicate discovered Rust test");
  return names.sort();
}
function executionRows(output) {
  const summaryIndex=output.search(/^test result: /m);
  const starts=[...output.matchAll(/^test ([A-Za-z_][A-Za-z0-9_:]*) \.\.\. /gm)].filter((match)=>summaryIndex<0||match.index<summaryIndex);
  return starts.map((match,index)=>{
    const end=starts[index+1]?.index ?? (summaryIndex<0 ? output.length : summaryIndex);
    const block=output.slice(match.index+match[0].length,end).trimEnd();
    const terminal=block.split(/\r?\n/).at(-1);
    const status=/^(ok|FAILED|ignored)(?:, .*)?$/.exec(terminal)?.[1] ?? null;
    return {name:match[1],status};
  });
}
export function executionCounts(output) {
  const rows=executionRows(output);
  const summaries=[...output.matchAll(/^test result: (\w+)\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured; (\d+) filtered out;/gm)];
  const summary=summaries.length===1?summaries[0]:null;
  const passed=summary?Number(summary[2]):rows.filter(row=>row.status==="ok").length;
  const failed=summary?Number(summary[3]):rows.filter(row=>row.status==="FAILED").length;
  const skipped=summary?Number(summary[4]):rows.filter(row=>row.status==="ignored").length;
  return {completedRows:summary?passed+failed+skipped:rows.filter(row=>row.status!==null).length,passed,failed,skipped,summaryPresent:Boolean(summary),names:rows.map(row=>row.name)};
}
export function parseRun(output, selected) {
  const summaries = [...output.matchAll(/^test result: (\w+)\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured; (\d+) filtered out;/gm)];
  assert.equal(summaries.length, 1, "missing or ambiguous Rust result summary");
  const [, status, passed, failed, ignored, measured, filtered] = summaries[0];
  const executed = executionRows(output);
  assert.equal(status, "ok", "Rust reported failure");
  assert.equal(Number(failed), 0, "Rust failures");
  assert.equal(Number(ignored), 0, "selected test was skipped");
  assert.equal(Number(measured), 0, "benchmark substituted for test");
  assert.equal(Number(passed), selected.length, "zero or incomplete Rust execution");
  assert.deepEqual(executed.map((row) => row.name).sort(), [...selected].sort(), "wrong Rust tests executed");
  assert.ok(executed.every((row) => row.status === "ok"), "Rust test did not pass");
  return { discovered: selected.length, executed: Number(passed), passed: Number(passed), failed: 0, skipped: 0, filteredOut: Number(filtered), names: [...selected] };
}
export function validateCatalog(catalog) {
  assert.equal(catalog.schema, 1);
  assert.equal(catalog.kind, "kaigen-extended-native-jobs");
  assert.deepEqual(catalog.platforms, ["win32"]);
  assert.ok(Number.isInteger(catalog.compileTimeoutSeconds) && catalog.compileTimeoutSeconds > 0);
  assert.equal(new Set(catalog.jobs.map((job) => job.id)).size, catalog.jobs.length);
  assert.ok(catalog.jobs.length > 0);
  for (const job of catalog.jobs) {
    assert.match(job.id, /^[a-z][a-z0-9-]+$/);
    assert.ok(["pq-faults", "scale"].includes(job.group));
    assert.ok(["src-tauri/Cargo.toml", "web/kaigen-webd/Cargo.toml"].includes(job.manifest));
    assert.ok(["debug", "release"].includes(job.profile));
    assert.ok(Array.isArray(job.features) && job.features.every((feature) => ["web-core", "pq-fault-tests"].includes(feature)));
    assert.equal(new Set(job.features).size, job.features.length);
    assert.equal(typeof job.lib, "boolean");
    assert.equal(typeof job.ignored, "boolean");
    assert.ok(Number.isInteger(job.expectedTests) && job.expectedTests > 0);
    assert.ok(job.selectors.length && job.selectors.every((selector) => /^[A-Za-z_][A-Za-z0-9_:]*$/.test(selector)));
    assert.equal(new Set(job.selectors).size, job.selectors.length);
    for (const value of Object.values(job.limits)) assert.ok(Number.isInteger(value) && value > 0, "invalid resource limit");
    assert.deepEqual(Object.keys(job.limits).sort(), ["fixtureMiB", "seconds", "workingSetMiB"]);
  }
  return catalog;
}
export function cargoArguments(job) {
  return ["test", "--locked", "--offline", "--manifest-path", job.manifest,
    ...(job.profile === "release" ? ["--release"] : []),
    ...(job.noDefaultFeatures ? ["--no-default-features"] : []),
    ...(job.features.length ? ["--features", job.features.join(",")] : []),
    ...(job.lib ? ["--lib"] : []), "--no-run", "--message-format=json"];
}
export function selectTests(job, all, ignored) {
  const selected = all.filter((name) => job.selectors.some((selector) => selector.endsWith("::") ? name.startsWith(selector) : name === selector));
  assert.equal(selected.length, job.expectedTests, "expected selected Rust tests absent or changed");
  assert.ok(selected.every((name) => ignored.includes(name) === job.ignored), "ignored mode differs from discovered test");
  return selected;
}
async function identity(filename) {
  const bytes = await readFile(filename), info = await stat(filename);
  return { path: path.relative(root, filename).replaceAll("\\", "/"), sha256: digest(bytes), bytes: bytes.length, modifiedUtc: info.mtime.toISOString() };
}
async function tree(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a,b) => a.name.localeCompare(b.name))) {
    assert.ok(!entry.isSymbolicLink(), "source fingerprint refuses symbolic links");
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await tree(filename));
    else if (entry.isFile()) files.push(filename);
  }
  return files;
}
export async function sourceIdentity(job) {
  const base = path.join(root, path.dirname(job.manifest));
  const files = new Set([
    path.join(root, "ci/extended-native-jobs.json"), fileURLToPath(import.meta.url), path.join(root, "scripts/native-test-monitor.ps1"),
    ...await tree(path.join(root, "src-tauri/src")), ...await tree(path.join(root, "vendor/mlkem-native-2.0.0")),
    ...["Cargo.toml", "Cargo.lock", "build.rs", "tauri.conf.json"].map((name) => path.join(root, "src-tauri", name)),
    ...["work/build/toxcore-native-windows/toxcore.dll", "work/build/toxcore-native-windows/toxcore.lib",
      "work/deps/pthreads4w-dynamic/pthreadVC3.dll", "work/deps/libsodium/libsodium/x64/Release/v143/static/libsodium.lib"].map((name) => path.join(root, name)),
    ...(job.manifest.startsWith("web/") ? [...await tree(path.join(base,"src")), path.join(base,"Cargo.toml"), path.join(base,"Cargo.lock")] : []),
  ]);
  for (const directory of [root, path.join(root,"src-tauri"), ...(job.manifest.startsWith("web/") ? [base] : [])]) {
    for (const name of [".cargo/config", ".cargo/config.toml", "rust-toolchain", "rust-toolchain.toml"]) {
      const filename = path.join(directory,name);
      try { if ((await stat(filename)).isFile()) files.add(filename); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  }
  const inputs = await Promise.all([...files].sort().map(identity));
  return { sha256: digest(JSON.stringify(inputs.map(({ path, sha256 }) => ({ path, sha256 })))), inputs };
}
async function toolchainIdentity(directory) {
  const tools = [];
  for (const program of ["cargo", "rustc"]) {
    const itemRoot=path.join(directory,program); await mkdir(itemRoot);
    const actual=await execute("rustup",["which",program],itemRoot,30);
    assert.equal(actual.code,0,"toolchain executable resolution failed");
    const executable=actual.stdout.trim();
    const versionRoot=path.join(itemRoot,"version"); await mkdir(versionRoot);
    const version=await execute(executable,["--version","--verbose"],versionRoot,30);
    assert.equal(version.code,0,"toolchain version failed");
    tools.push({program,executable,identity:await identity(executable),version:version.stdout.trim()});
  }
  const shellRoot=path.join(directory,"powershell"); await mkdir(shellRoot);
  const shell=await execute("pwsh",["-NoLogo","-NoProfile","-Command","@{ path=(Get-Process -Id $PID).Path; version=$PSVersionTable.PSVersion.ToString() } | ConvertTo-Json -Compress"],shellRoot,30);
  assert.equal(shell.code,0,"PowerShell identity failed");
  const shellInfo=JSON.parse(shell.stdout); tools.push({program:"pwsh",executable:shellInfo.path,identity:await identity(shellInfo.path),version:shellInfo.version});
  tools.push({program:"node",executable:process.execPath,identity:await identity(process.execPath),version:process.version});
  const environment=Object.fromEntries(Object.entries(process.env).filter(([name])=>/^(RUSTC|RUSTC_WRAPPER|RUSTC_WORKSPACE_WRAPPER|RUSTFLAGS|CARGO_ENCODED_RUSTFLAGS|RUSTUP_TOOLCHAIN|CARGO_BUILD_TARGET|CARGO_TARGET_DIR|CARGO_PROFILE_[A-Z_]+|KAIGEN_TOXCORE_LIB_DIR|KAIGEN_LIBSODIUM_LIB_DIR)$/.test(name)));
  return {tools,environment};
}
async function execute(program, args, directory, timeoutSeconds) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd: root, windowsHide: true, shell: false });
    let stdout = "", stderr = "", timedOut = false;
    child.stdout.on("data", (bytes) => { stdout += bytes; });
    child.stderr.on("data", (bytes) => { stderr += bytes; });
    const timeout = setTimeout(() => {
      timedOut = true;
      if (process.platform === "win32") {
        const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide:true, shell:false });
        killer.on("error", () => child.kill());
      } else child.kill("SIGKILL");
    }, timeoutSeconds * 1000);
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("close", async (code) => {
      clearTimeout(timeout);
      try {
        await writeFile(path.join(directory,"stdout.log"), stdout);
        await writeFile(path.join(directory,"stderr.log"), stderr);
        resolve({ code, timedOut, stdout, stderr });
      } catch (error) { reject(error); }
    });
  });
}
async function compile(job, directory, timeoutSeconds, cargoExecutable) {
  console.log(JSON.stringify({ job: job.id, phase: "compile", features: job.features, profile: job.profile }));
  const args = cargoArguments(job), result = await execute(cargoExecutable, args, directory, timeoutSeconds);
  assert.ok(!result.timedOut && result.code === 0, "offline test compilation failed; inspect preserved compile logs");
  const artifacts = result.stdout.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
    .filter((record) => record.reason === "compiler-artifact" && record.profile?.test && record.executable && record.target.kind.some((kind) => job.lib ? ["lib", "rlib", "cdylib", "staticlib"].includes(kind) : kind === "bin"));
  assert.equal(artifacts.length, 1, "Cargo did not identify one exact test artifact");
  return { executable: artifacts[0].executable, command: { program:cargoExecutable, args }, cargoArtifact:artifacts[0], artifact: await identity(artifacts[0].executable) };
}
export async function runJob(job, evidenceRoot, compileTimeoutSeconds) {
  const directory = path.join(evidenceRoot, job.id);
  await mkdir(directory, { recursive: false });
  const startedAt = new Date().toISOString(), source = await sourceIdentity(job);
  const receipt = { schema:1, kind:"kaigen-extended-native-result", job:job.id, status:"FAIL", startedAt, host:{platform:os.platform(), arch:os.arch(), release:os.release(), node:process.version}, source, limits:job.limits, selectedMode:job.ignored ? "ignored-only" : "ordinary" };
  try {
    const toolsRoot=path.join(directory,"toolchain"); await mkdir(toolsRoot);
    receipt.toolchain=await toolchainIdentity(toolsRoot);
    const compileRoot = path.join(directory,"compile"); await mkdir(compileRoot);
    const built = await compile(job, compileRoot, compileTimeoutSeconds, receipt.toolchain.tools.find((tool)=>tool.program==="cargo").executable);
    receipt.build = built;
    const discoveryRoot = path.join(directory,"discovery"); await mkdir(discoveryRoot);
    const discovery = await execute(built.executable, ["--list","--format","terse"], discoveryRoot, 30);
    assert.ok(!discovery.timedOut && discovery.code === 0, "Rust discovery failed");
    const all = parseDiscovery(discovery.stdout);
    const ignoredRoot = path.join(directory,"ignored-discovery"); await mkdir(ignoredRoot);
    const ignoredDiscovery = await execute(built.executable, ["--list","--ignored","--format","terse"], ignoredRoot, 30);
    assert.ok(!ignoredDiscovery.timedOut && ignoredDiscovery.code === 0, "ignored discovery failed");
    const ignored = ignoredDiscovery.stdout.trim() ? parseDiscovery(ignoredDiscovery.stdout) : [];
    const selected = selectTests(job, all, ignored);
    receipt.discovery = { total:all.length, ignored:ignored.length, selected:selected.length, excluded:all.length-selected.length, names:all, ignoredNames:ignored, selectedNames:selected };
    receipt.runtimeLibraryCandidates = await Promise.all(["toxcore.dll", "pthreadVC3.dll"].map((name) => identity(path.join(path.dirname(built.executable),name))));
    const runtimeRoot = path.join(directory,"runtime"); await mkdir(runtimeRoot);
    const args = [...selected, "--exact", ...(job.ignored ? ["--ignored"] : []), "--nocapture","--test-threads=1"];
    receipt.command = { program:built.executable, args };
    console.log(JSON.stringify({job:job.id, phase:"execute", discovered:all.length, selected:selected.length, ignoredOnly:job.ignored, limits:job.limits}));
    const monitored = await execute("pwsh", ["-NoLogo","-NoProfile","-NonInteractive","-File",path.join(root,"scripts/native-test-monitor.ps1"),
      "-Program",built.executable,"-ArgumentsJson",JSON.stringify(args),"-EvidenceRoot",runtimeRoot,
      "-MaxSeconds",String(job.limits.seconds),"-MaxWorkingSetMiB",String(job.limits.workingSetMiB),"-MaxFixtureMiB",String(job.limits.fixtureMiB)], runtimeRoot, job.limits.seconds+60);
    receipt.resource = JSON.parse(await readFile(path.join(runtimeRoot,"resource.json"),"utf8"));
    const stdout = await readFile(path.join(runtimeRoot,"process.stdout.log"),"utf8");
    const stderr = await readFile(path.join(runtimeRoot,"process.stderr.log"),"utf8");
    receipt.output = { stdoutSha256:digest(stdout),stderrSha256:digest(stderr) };
    receipt.observedExecution=executionCounts(stdout+"\n"+stderr);
    assert.ok(!monitored.timedOut && monitored.code === 0 && receipt.resource.status === "PASS", "native resource/process gate failed");
    receipt.counts = parseRun(stdout+"\n"+stderr,selected);
    receipt.runtimeBindings=[];
    for (const candidate of receipt.runtimeLibraryCandidates) {
      const loaded=receipt.resource.loadedNativeModules.find((module)=>path.basename(module.path).toLowerCase()===path.basename(candidate.path).toLowerCase());
      const nativeName=path.basename(candidate.path).toLowerCase();
      const prepared=source.inputs.find((input)=>input.path=== (nativeName==="toxcore.dll" ? "work/build/toxcore-native-windows/toxcore.dll" : "work/deps/pthreads4w-dynamic/pthreadVC3.dll"));
      assert.equal(candidate.sha256,prepared?.sha256,"runtime candidate differs from prepared build input");
      receipt.runtimeBindings.push({name:nativeName,disposition:loaded ? "loaded-and-verified" : "not-observed",...loaded});
      if (!loaded && nativeName!=="toxcore.dll") continue; // Some fault tests do not initialize native threads.
      assert.ok(loaded && loaded.sha256.toLowerCase()===candidate.sha256,"native dependency not bound to the loaded process module");
      assert.equal(path.resolve(loaded.path).toLowerCase(),path.resolve(root,candidate.path).toLowerCase(),"native dependency loaded from an unexpected directory");
    }
    assert.equal(receipt.counts.filteredOut, all.length-selected.length, "Rust execution/discovery count mismatch");
    assert.ok(same(source.inputs.map(({path,sha256})=>({path,sha256})), (await sourceIdentity(job)).inputs.map(({path,sha256})=>({path,sha256}))), "inputs changed during execution");
    assert.equal((await identity(built.executable)).sha256,built.artifact.sha256,"test artifact changed during execution");
    receipt.status = "PASS";
  } catch (error) { receipt.error = error.message; }
  receipt.completedAt = new Date().toISOString();
  await writeFile(path.join(directory,"result.json"),JSON.stringify(receipt,null,2)+"\n");
  console.log(JSON.stringify({job:job.id,status:receipt.status,counts:receipt.counts,resource:receipt.resource,error:receipt.error}));
  assert.equal(receipt.status,"PASS", "named native job failed; preserved result.json identifies the failure");
  return receipt;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = Object.fromEntries(process.argv.slice(2).reduce((pairs,value,index,args) => {
    if (index%2===0) { assert.ok(["--group","--job","--evidence-root"].includes(value) && args[index+1], "invalid extended job arguments"); pairs.push([value,args[index+1]]); } return pairs;
  },[]));
  assert.ok(process.platform === "win32", "resource monitor currently requires Windows");
  assert.ok(options["--evidence-root"], "an exact local evidence root is required");
  assert.ok(Boolean(options["--group"]) !== Boolean(options["--job"]), "select exactly one named job or group");
  const catalog = validateCatalog(JSON.parse(await readFile(path.join(root,"ci/extended-native-jobs.json"),"utf8")));
  const jobs = catalog.jobs.filter((job) => options["--job"] ? job.id === options["--job"] : job.group === options["--group"]);
  assert.ok(jobs.length,"unknown extended native job/group");
  const evidenceRoot = path.resolve(options["--evidence-root"]); await mkdir(evidenceRoot,{recursive:true});
  for (const job of jobs) await runJob(job,evidenceRoot,catalog.compileTimeoutSeconds);
}
