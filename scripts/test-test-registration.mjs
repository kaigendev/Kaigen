import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { auditRegistration, readRegistration } from "./registration-catalog.mjs";

const { files, scripts, catalog, result } = await readRegistration();
assert.throws(() => auditRegistration([...files, "test-unregistered-future.mjs"], scripts, catalog), /unregistered test entrypoints/);
assert.throws(() => auditRegistration(files.filter((file) => file !== catalog.separate[0].file), scripts, catalog), /stale registration/);
for (const name of ["test:notification-sound", "test:product-fixes3-ui"]) {
  const removed = { ...scripts, "test:frontend": scripts["test:frontend"].split(/\s*&&\s*/).filter((command) => command !== `npm run ${name}`).join(" && ") };
  assert.throws(() => auditRegistration(files, removed, catalog), /must run in test:frontend/);
}
const commands = scripts["test:frontend"].split(/\s*&&\s*/).map((command) => command.slice("npm run ".length));
for (const [name, testFile] of [["test:notification-sound", "test-notification-sound.mjs"], ["test:product-fixes3-ui", "test-product-fixes3-ui.mjs"]]) {
  const directory = await mkdtemp(join(tmpdir(), "kaigen-test-registration-"));
  try {
    const trace = join(directory, "trace.txt");
    await writeFile(join(directory, "noop.mjs"), 'import { appendFileSync } from "node:fs"; appendFileSync(process.env.KAIGEN_REGISTRATION_TRACE, process.argv[2] + "\\n");');
    await writeFile(join(directory, "inject.mjs"), 'import assert from "node:assert/strict"; import { appendFileSync } from "node:fs"; appendFileSync(process.env.KAIGEN_REGISTRATION_TRACE, process.env.KAIGEN_FAILING_SUITE + "\\n"); assert.equal = assert.deepEqual = () => { throw new Error("INJECTED_SUITE_FAILURE"); };');
    const fixtureScripts = Object.fromEntries(commands.map((command) => [command, `node noop.mjs ${command}`]));
    const testPath = fileURLToPath(new URL(testFile, import.meta.url));
    fixtureScripts[name] = `node --import "${pathToFileURL(join(directory, "inject.mjs")).href}" "${testPath}"`;
    fixtureScripts["test:frontend"] = scripts["test:frontend"];
    await writeFile(join(directory, "package.json"), JSON.stringify({ private: true, type: "module", scripts: fixtureScripts }));
    const execution = spawnSync(process.platform === "win32" ? (process.env.ComSpec || "cmd.exe") : "npm",
      process.platform === "win32" ? ["/d", "/s", "/c", "npm run test:frontend"] : ["run", "test:frontend"],
      { cwd: directory, env: { ...process.env, NODE_OPTIONS: "", KAIGEN_REGISTRATION_TRACE: trace, KAIGEN_FAILING_SUITE: name }, encoding: "utf8", timeout: 60000, windowsHide: true });
    assert.ifError(execution.error);
    assert.notEqual(execution.status, 0, `${name} failure must fail actual npm aggregate`);
    assert.match(execution.stdout + execution.stderr, /INJECTED_SUITE_FAILURE/, "failure comes from the actual suite");
    const executed = (await readFile(trace, "utf8")).trim().split("\n");
    assert.deepEqual(executed, commands.slice(0, commands.indexOf(name) + 1), "aggregate stops at the failed suite");
    console.log(`actual npm aggregate rejects ${name}, exit=${execution.status}, later suites not run: PASS`);
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()), "cleanup stays in the owned temporary namespace");
    assert.ok(directory.startsWith(join(tmpdir(), "kaigen-test-registration-")));
    await rm(directory, { recursive: true, force: true });
  }
}
console.log(`test registration completeness: ${JSON.stringify(result)} PASS (classification counts are not runtime test counts)`);
