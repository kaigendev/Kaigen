import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { assertFullSelection, defaultCatalog, localFullChecks, prepareLocalFull, releaseCiPaths, selectChecks, RELEASE_0298_CI_PATHS, rustCommand, localFrontendPolicy, localFrontendCoverage, assertComplete, assertImportedFrontendCommand, windowsCoverageResults } from './ci-incremental-verification.mjs';
import { reviewedFrontendCheckIds } from './frontend-verification-inputs.mjs';
import { assertVerification } from './publish-release.mjs';
import { readReleaseVersion } from './release-version.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const identity = await readReleaseVersion(root);
const catalog = JSON.parse(await readFile(defaultCatalog(root), 'utf8'));
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const scripts = new Set(manifest.scripts['test:frontend'].split(/\s*&&\s*/u).map(command => /^npm run (test:[\w-]+)$/u.exec(command)?.[1]).filter(Boolean));
function checkActionsReuseGuards() {
  for (const name of ['ui-identity', 'localization', 'browser-runtime']) {
    const proof = { checkId: 'frontend:' + name, command: { program: 'npm.cmd', args: ['run', 'test:' + name, '--', '--no-qtox'] } };
    assertImportedFrontendCommand(proof, catalog, scripts);
    const full = structuredClone(catalog); delete full.checks.find(check => check.id === proof.checkId).variant;
    assert.throws(() => assertImportedFrontendCommand(proof, full, scripts), /current selected variant/);
    const contradictory = structuredClone(proof); contradictory.command.args.push('--runtime');
    assert.throws(() => assertImportedFrontendCommand(contradictory, catalog, scripts), /current selected variant/);
  }
  const old = { id: 'frontend:chat-file-batch', disposition: 'reused', outputSha256: 'c'.repeat(64) };
  const fresh = { id: 'frontend:file-receive-settings', disposition: 'rerun', outputSha256: 'd'.repeat(64) };
  const historical = windowsCoverageResults({ results: [old] }, [old, fresh]);
  assert.deepEqual(historical, [old, fresh]);
  const imported = windowsCoverageResults({ frontendCoverage: { gateSha256: 'e'.repeat(64) }, results: [old] }, [fresh]);
  assert.deepEqual(imported, [old, fresh]);
  const selected = [{ id: old.id, action: 'reuse' }, { id: fresh.id, action: 'run' }];
  assertComplete(selected, historical); assertComplete(selected, imported);
  assert.throws(() => assertComplete(selected, windowsCoverageResults({ frontendCoverage: {}, results: [old] }, [old, fresh])), /duplicate/);
}
checkActionsReuseGuards();
if (process.argv.includes('--actions-guards-only')) { console.log('ACTIONS_REUSE_GUARDS_PASS: historical Windows results stay unique; exact no-qtox variant retained; full/contradictory scope drift rejected'); process.exit(0); }
assert.equal(catalog.version, identity.version);
assert.equal(catalog.selectionScope, 'release-full');
assert.deepEqual(catalog.allowedCiPaths, releaseCiPaths(catalog));
assert.deepEqual(catalog.referenceSource, catalog.productSource);
assert.deepEqual(catalog.unixProducerReferenceSource, catalog.productSource);
assertFullSelection(catalog, scripts);
const selectedWindows = selectChecks(catalog, 'windows');
assert.deepEqual(selectedWindows.filter(check => check.action === 'reuse').map(check => check.id).sort(), reviewedFrontendCheckIds);
assert.equal(selectedWindows.filter(check => check.action === 'run').length, 8);
assert.equal(selectedWindows.filter(check => check.id.startsWith('frontend:') && check.action === 'run').length, 4);
assert.deepEqual(selectChecks(catalog, 'debian').map(check => check.id), ['rust:all']);
assert.deepEqual(selectChecks(catalog, 'macos').map(check => check.id), ['rust:all']);
assert.deepEqual(selectChecks(catalog, 'web').map(check => check.id), ['rust:all', 'webd:all']);
for (const platform of ['debian', 'macos', 'web']) {
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
const future = { ...catalog, version: '0.2.9+10' }; delete future.actionsFrontendReuse;
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
assert.equal(localFrontendPolicy(catalog), true);
assert.throws(() => localFrontendPolicy({ ...catalog, version: '0.2.9+10' }), /unreviewed/);
for (const mutate of [value => value.actionsFrontendReuse.source.tree = 'unresolved',
  value => value.actionsFrontendReuse.evidence.path = '../local-full.json',
  value => value.actionsFrontendReuse.extra = true]) {
  const bad = structuredClone(catalog); mutate(bad); assert.throws(() => localFrontendPolicy(bad), /unreviewed/);
}
if (catalog.actionsFrontendReuse.evidence.sha256 === null) await assert.rejects(() => localFrontendCoverage(root, catalog, { commit: 'a'.repeat(40), tree: 'b'.repeat(40) }), /coverage is pending/);
// Receipt comparison tests exercise data validation only; no suite is executed.
const source = { commit: 'a'.repeat(40), tree: 'b'.repeat(40) }, digest = 'c'.repeat(64);
const reused = selectedWindows.filter(check => check.action === 'reuse').map(check => ({ id: check.id, disposition: 'reused', source: catalog.actionsFrontendReuse.source,
  outputSha256: digest, localFrontend: { resultSha256: digest, originalInputsSha256: digest, startedAt: '2026-10-01T00:00:00Z', completedAt: '2026-10-01T00:00:01Z' } }));
const binding = { gateSha256: digest, source: catalog.actionsFrontendReuse.source, validatorProofSha256: digest, receiptSha256: digest };
const receipt = { schemaVersion: 1, kind: 'kaigen-ci-incremental-verification', status: 'PASS', repository: 'kaigendev/Kaigen', platform: 'windows',
  builtFrom: source, productReference: catalog.productSource, verificationReference: catalog.referenceSource, fullBaselineRerun: false, selectionSha256: digest,
  equivalence: { unchangedOutsideCiPaths: true, changedCiPaths: [] }, frontendCoverage: binding,
  checks: [...reused, ...selectedWindows.filter(check => check.action === 'run').map(check => ({ id: check.id, disposition: 'rerun', source, outputSha256: digest }))], artifacts: [] };
const release = { source, catalog: { sha256: digest } }, inherited = { binding, results: reused };
assertComplete(selectedWindows, receipt.checks); assertVerification(receipt, 'windows', release, catalog, inherited);
assert.throws(() => assertVerification(receipt, 'windows', release, catalog), /independently validate/);
for (const mutate of [value => value.checks[0].disposition = 'rerun', value => value.checks[0].source = source,
  value => value.checks[0].localFrontend.resultSha256 = 'd'.repeat(64), value => value.checks.pop(),
  value => value.checks.push(value.checks[0]), value => value.frontendCoverage.gateSha256 = 'd'.repeat(64),
  value => value.fullBaselineRerun = true, value => value.checks.at(-1).disposition = 'reused']) {
  const bad = structuredClone(receipt); mutate(bad); assert.throws(() => assertVerification(bad, 'windows', release, catalog, inherited));
}
const originalFetch = globalThis.fetch; let networkCalls = 0;
globalThis.fetch = () => { networkCalls++; throw new Error('Offline planning must not access the network'); };
try {
  await assert.rejects(() => prepareLocalFull({ root, platform: 'web', evidenceRoot: path.dirname(root) }), /Windows plan runner/);
  await assert.rejects(() => prepareLocalFull({ root, platform: 'windows', evidenceRoot: path.join(root, 'artifacts') }), /outside the source/);
  const dirty = execFileSync('git', ['-c', `safe.directory=${root.replaceAll('\\', '/')}`, '-C', root, 'status', '--porcelain=v1', '--untracked-files=all'], { encoding: 'utf8' }).trim();
  if (dirty) await assert.rejects(() => prepareLocalFull({ root, platform: 'windows', evidenceRoot: path.join(path.dirname(root), 'outputs', identity.releaseLabel, 'must-not-write-dirty-plan') }), /must be clean/);
} finally { globalThis.fetch = originalFetch; }
assert.equal(networkCalls, 0);
console.log(`CI_RELEASE_SELECTION_PASS ${identity.tag}: 39 retained frontend checks, 8 fresh Actions checks, changed receipts rejected, historical policy preserved`);
