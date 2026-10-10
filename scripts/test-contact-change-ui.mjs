import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import path from "node:path";

// Approved plan 1,2,4,5,6,9: one browser, actual App, no default geometry suite.
const repository = path.resolve(import.meta.dirname, "..");
const selected = (process.argv.find(arg => arg.startsWith("--points="))?.slice(9) ?? "1,2,4,5,6,9").split(",").map(Number);
assert.ok(selected.length && selected.every(id => [1,2,4,5,6,9].includes(id)));
const evidence = process.env.KAIGEN_CONTACT_CHANGE_EVIDENCE_DIR
  ? path.resolve(process.env.KAIGEN_CONTACT_CHANGE_EVIDENCE_DIR)
  : path.resolve(repository, "../outputs/web-contact-clipboard-20261007-r1/regression/ui", "run-" + Date.now());
const require = createRequire(path.join(repository, "package.json"));
const original = (await readFile(path.join(import.meta.dirname, "test-chat-geometry-runtime.mjs"), "utf8")).replaceAll("\r\n", "\n");
const prefixEnd = original.indexOf("  if (imageReactionsOnly) {");
const cleanupStart = original.indexOf("} catch (error) {\n  primaryError = error;");
const cleanupEnd = original.indexOf("// The default geometry check includes");
assert.ok(prefixEnd > 0 && cleanupStart > prefixEnd && cleanupEnd > cleanupStart);
let driver = original.slice(0, prefixEnd);
driver = driver.replace('from "vite"', 'from ' + JSON.stringify(pathToFileURL(require.resolve("vite")).href))
  .replace('from "@vitejs/plugin-react"', 'from ' + JSON.stringify(pathToFileURL(require.resolve("@vitejs/plugin-react")).href))
  .replace('path.resolve(import.meta.dirname, "..")', JSON.stringify(repository))
  .replace('path.join(import.meta.dirname, "fixtures", "chat-geometry-runtime")', 'path.join(repository,"scripts","fixtures","chat-geometry-runtime")')
  .replace('path.join(fixture, "app-platform.ts")', 'path.join(fixture, "app-contact-change-platform.ts")')
  .replace('await mkdtemp(path.join(os.tmpdir(), "kaigen-chat-geometry-"))', 'await mkdtemp(path.join(evidenceDirectory,"disposable-browser-"))')
  .replace('  configFile: false,', '  configFile: false,\n  cacheDir: path.join(profile,"vite-cache"),');
// The reused launch/cleanup code performs no unrelated source assertions/scenarios.
driver = driver.slice(0, driver.indexOf("const appSource =")) + driver.slice(driver.indexOf("const profile ="));
const modulesStart = driver.indexOf("    const fixtureModules =");
const modulesEnd = driver.indexOf("  await within((async () => {", modulesStart);
assert.ok(modulesStart > 0 && modulesEnd > modulesStart);
driver = driver.slice(0, modulesStart) + '  const fixtureModules = ["/app-entry.tsx"];\n' + driver.slice(modulesEnd);
driver += "{\nconst selectedApprovedPoints = " + JSON.stringify(selected) + ";\n" + await readFile(path.join(import.meta.dirname,"fixtures/chat-geometry-runtime/contact-change-ui-driver.mjs"), "utf8") + "\n}\n";
driver += original.slice(cleanupStart, cleanupEnd).replace('  if (cleanupErrors.length) {',
  '  await writeFile(path.join(evidenceDirectory,"cleanup.json"),JSON.stringify({browserStopped,serverClosed:!server.httpServer?.listening,disposableProfileRemoved:!existsSync(profile),errors:cleanupErrors},null,2)+"\\n");\n  if (cleanupErrors.length) {');
await mkdir(evidence, { recursive: true });
const driverPath = path.join(evidence, "driver.mjs");
await writeFile(driverPath, driver);
const paths = ["src/App.tsx", "src/TextEditContextMenu.tsx", "src/ContactGroupHeader.tsx", "src/ContactGroups.css", "src/contactGroups.ts", "src/contextMenuPlacement.ts",
  "scripts/test-contact-change-ui.mjs", "scripts/test-chat-geometry-runtime.mjs", "scripts/fixtures/chat-geometry-runtime/app-contact-change-platform.ts", "scripts/fixtures/chat-geometry-runtime/contact-change-ui-driver.mjs"];
const sources = await Promise.all(paths.map(async relative => ({ path: relative, sha256: createHash("sha256").update(await readFile(path.join(repository,relative))).digest("hex") })));
await writeFile(path.join(evidence,"inputs.json"),JSON.stringify({baseCommit:"374f9ffa1701df0f51f96e0793d81b5db4214338",approved:selected,sources,driverSha256:createHash("sha256").update(driver).digest("hex")},null,2)+"\n");
const child = spawn(process.execPath,[driverPath,"--menus-only"],{cwd:repository,windowsHide:true,stdio:"inherit",env:{...process.env,KAIGEN_CHAT_GEOMETRY_EVIDENCE_DIR:evidence}});
console.log("CONTACT_CHANGE_UI_EVIDENCE " + evidence);
await new Promise((resolve,reject)=>{ child.once("error",reject); child.once("close",code=>code===0?resolve():reject(new Error("Approved contact UI tests failed: "+code))); });
