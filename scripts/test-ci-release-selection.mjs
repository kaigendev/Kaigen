import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { assertFullSelection, defaultCatalog, localFullChecks, prepareLocalFull, releaseCiPaths, selectChecks, RELEASE_0298_CI_PATHS, rustCommand } from './ci-incremental-verification.mjs';
import { readReleaseVersion } from './release-version.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const identity = await readReleaseVersion(root);
const catalog = JSON.parse(await readFile(defaultCatalog(root), 'utf8'));
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const scripts = new Set(manifest.scripts['test:frontend'].split(/\s*&&\s*/u).map(command => /^npm run (test:[\w-]+)$/u.exec(command)?.[1]).filter(Boolean));
assert.equal(catalog.version, identity.version);
assert.equal(catalog.selectionScope, 'release-full');
assert.deepEqual(catalog.allowedCiPaths, releaseCiPaths(catalog));
assert.deepEqual(catalog.referenceSource, catalog.productSource);
assert.deepEqual(catalog.unixProducerReferenceSource, catalog.productSource);
assertFullSelection(catalog, scripts);
assert.deepEqual(selectChecks(catalog, 'windows'), catalog.checks);
assert.deepEqual(selectChecks(catalog, 'debian').map(check => check.id), ['rust:all']);
assert.deepEqual(selectChecks(catalog, 'macos').map(check => check.id), ['rust:all']);
assert.deepEqual(selectChecks(catalog, 'web').map(check => check.id), ['rust:all', 'webd:all']);
for (const platform of ['windows', 'debian', 'macos', 'web']) {
  assert(selectChecks(catalog, platform).every(check => check.action === 'run'));
}
const webRust = selectChecks(catalog, 'web')[0];
assert(rustCommand(webRust, 'web', true).includes('web-core'));
assert(!rustCommand(webRust, 'web', true).includes('all'));

for (const mutate of [
  value => value.checks.pop(),
  value => value.checks.push({ ...value.checks[0] }),
  value => value.checks[0].action = 'reuse',
  value => value.webd.checks[0].action = 'reuse',
  value => value.webd.checks = [],
  value => value.executedBaselines = { windows: {} },
]) {
  const altered = structuredClone(catalog); mutate(altered);
  assert.throws(() => assertFullSelection(altered, scripts), /full selection/);
}
const expandedRecipe = new Set([...scripts, 'test:new-current-suite']);
assert.throws(() => assertFullSelection(catalog, expandedRecipe), /full selection/);
assert.throws(() => releaseCiPaths({ ...catalog, version: '../invalid' }), /release version/);
for (const forbidden of ['package.json', 'src/App.tsx', 'src-tauri/Cargo.toml', 'scripts/build-macos.sh', '.github/workflows/build-windows.yml', 'ci/verification-v0.2.9.8.json']) {
  assert(!catalog.allowedCiPaths.includes(forbidden), `product or historical input admitted as verification-only: ${forbidden}`);
}
const future = { ...catalog, version: '0.2.9+10' };
assertFullSelection(future, scripts);
assert(releaseCiPaths(future).includes('ci/verification-v0.2.9.10.json'));
assert(releaseCiPaths(future).includes('ci/releases/v0.2.9.10.json'));
assert(releaseCiPaths(future).includes('ci/releases/evidence/v0.2.9.10/gate.json'));
assert(!releaseCiPaths(future).includes('ci/verification-v0.2.9.9.json'));

const historical = JSON.parse(await readFile(new URL('../ci/verification-v0.2.9.8.json', import.meta.url), 'utf8'));
assert.deepEqual(releaseCiPaths(historical), RELEASE_0298_CI_PATHS);
assertFullSelection(historical, scripts);
assert.throws(() => assertFullSelection({ ...historical, version: '0.2.9+9' }, scripts), /full selection/);
const localChecks = localFullChecks(catalog, scripts);
assert.equal(localChecks.length, catalog.checks.length + 1);
assert(localChecks.every(check => check.action === 'run' && !Object.hasOwn(check, 'evidence')));
assert.equal(localChecks.at(-1).id, 'driver:pq-two-instances');
assert.throws(() => localFullChecks(historical, scripts), /current explicit full-release catalog/);
const originalFetch = globalThis.fetch; let networkCalls = 0;
globalThis.fetch = () => { networkCalls++; throw new Error('Offline planning must not access the network'); };
try {
  await assert.rejects(() => prepareLocalFull({ root, platform: 'web', evidenceRoot: path.dirname(root) }), /Windows plan runner/);
  await assert.rejects(() => prepareLocalFull({ root, platform: 'windows', evidenceRoot: path.join(root, 'artifacts') }), /outside the source/);
  const dirty = execFileSync('git', ['-c', `safe.directory=${root.replaceAll('\\', '/')}`, '-C', root, 'status', '--porcelain=v1', '--untracked-files=all'], { encoding: 'utf8' }).trim();
  if (dirty) await assert.rejects(() => prepareLocalFull({ root, platform: 'windows', evidenceRoot: path.join(path.dirname(root), 'outputs', identity.releaseLabel, 'must-not-write-dirty-plan') }), /must be clean/);
} finally { globalThis.fetch = originalFetch; }
assert.equal(networkCalls, 0);
console.log(`CI_RELEASE_SELECTION_PASS ${identity.tag}: full current coverage, no imported PASS, future catalog routing and historical restrictions`);
