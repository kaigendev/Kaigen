import { readFile, readdir } from "node:fs/promises";
import assert from "node:assert/strict";

export function auditRegistration(files, scripts, catalog) {
  assert.equal(catalog.schema, 1);
  const names = scripts["test:frontend"].split(/\s*&&\s*/).map((command) => {
    const match = /^npm run (test:[a-z0-9-]+)$/.exec(command);
    assert.ok(match, `unsupported aggregate command: ${command}`);
    assert.ok(scripts[match[1]], `missing npm script: ${match[1]}`);
    return match[1];
  });
  assert.equal(new Set(names).size, names.length, "aggregate suites must run once");
  for (const [name, file] of [["test:notification-sound", "test-notification-sound.mjs"], ["test:product-fixes3-ui", "test-product-fixes3-ui.mjs"], ["test:registration", "test-test-registration.mjs"]]) {
    assert.equal(scripts[name], `node scripts/${file}`);
    assert.ok(names.includes(name), `${name} must run in test:frontend`);
  }
  const direct = new Set(Object.values(scripts).flatMap((command) => [...command.matchAll(/(?:^|&&\s*)node scripts\/(test-[a-z0-9-]+\.(?:mjs|ps1|sh))(?=\s|$)/g)].map((match) => match[1])));
  const declared = new Set([...direct]);
  for (const entry of [...catalog.nested, ...catalog.separate]) {
    assert.ok(files.includes(entry.file), `stale registration: ${entry.file}`);
    assert.ok(!declared.has(entry.file), `duplicate registration: ${entry.file}`);
    assert.ok(entry.reason?.trim() || entry.invocation?.trim(), `missing route/reason: ${entry.file}`);
    declared.add(entry.file);
  }
  for (const file of direct) assert.ok(files.includes(file), `npm route references missing test: ${file}`);
  for (const entry of catalog.nested) assert.ok(direct.has(entry.parent), `unregistered parent: ${entry.parent}`);
  const missing = files.filter((file) => !declared.has(file));
  assert.deepEqual(missing, [], `unregistered test entrypoints: ${missing.join(", ")}`);
  return { discovered: files.length, direct: direct.size, nested: catalog.nested.length, separate: catalog.separate.length, aggregate: names.length };
}

export async function readRegistration(root = new URL("../", import.meta.url)) {
  const packageJson = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  const catalog = JSON.parse(await readFile(new URL("ci/test-entrypoints.json", root), "utf8"));
  const files = (await readdir(new URL("scripts/", root))).filter((file) => /^test-.*\.(mjs|ps1|sh)$/.test(file)).sort();
  const result = auditRegistration(files, packageJson.scripts, catalog);
  for (const entry of catalog.nested) {
    const source = await readFile(new URL(`scripts/${entry.parent}`, root), "utf8");
    assert.ok(source.includes(entry.invocation), `nested route missing: ${entry.file}`);
  }
  return { files, scripts: packageJson.scripts, catalog, result };
}
