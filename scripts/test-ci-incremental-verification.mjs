import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm, mkdir, rename, lstat, symlink, realpath } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertCleanTree, assertComplete, assertExecutedJob, assertJob, assertOutsideSource, derivedUnixProducer, github, normalizeLog, passedTests, rustCommand, selectChecks, unixProducerReference, unixTestBlock, validateExecutedReceipt, validateRerunResult } from './ci-incremental-verification.mjs';
import { acceptedVersionBaselineTemplate, assertAcceptedVersionDeclaration, assertAcceptedVersionDelta, canonicalVerificationRoot, createImmutableGitReadCache, descriptor, rustSummary, validatePlan, validateReleaseMetadata, verificationExecutionRoot, verifyFinalReceipt } from './incremental-windows-verification.mjs';
import { IMPORTED_RUST_KIND, packageScriptClosureEquivalent, rootVersionEquivalent, isolatedInputLanguageChange, validateImportedRustExecution, validatePackageOnlySourceClosure } from './imported-rust-execution.mjs';

export async function runImmutableGitReadCacheTests() {
  const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), 'kaigen-immutable-git-')));
  const repository = path.join(temporary, 'repo-a'), second = path.join(temporary, 'repo-b');
  const output = path.join(temporary, 'evidence');
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const git = (root, args) => execFileSync('git', ['-c', 'core.autocrlf=false', '-c', `safe.directory=${root.replaceAll('\\', '/')}`, '-C', root, ...args], { encoding: 'utf8', windowsHide: true }).trim();
  const commit = root => {
    git(root, ['add', '.']);
    git(root, ['-c', 'user.name=Immutable Git fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'disposable immutable read fixture']);
    return { commit: git(root, ['rev-parse', 'HEAD']), tree: git(root, ['rev-parse', 'HEAD^{tree}']) };
  };
  try {
    await mkdir(repository); await mkdir(second); await mkdir(output);
    git(repository, ['init', '--quiet']); git(second, ['init', '--quiet']);
    const packageBytes = Buffer.from('{"scripts":{"test:frontend":"npm run test:fixture"}}\n');
    const original = Buffer.from([0, 255, 13, 10, 71, 105, 116]);
    await writeFile(path.join(repository, 'package.json'), packageBytes);
    await writeFile(path.join(repository, 'fixture.bin'), original);
    const before = commit(repository), cache = createImmutableGitReadCache();
    const first = cache.blob(repository, before.commit, 'fixture.bin');
    assert.deepEqual(first, original); first.fill(42);
    assert.deepEqual(cache.blob(repository, before.commit, 'fixture.bin'), original, 'a returned Buffer must not mutate cached Git bytes');
    for (const kind of ['commit', 'tree']) {
      const bytes = cache.identity(repository, before.commit, kind);
      assert.equal(bytes.toString().trim(), before[kind]); bytes.fill(42);
      assert.equal(cache.identity(repository, before.commit, kind).toString().trim(), before[kind]);
    }
    assert.deepEqual(cache.stats(), { entries: 3, hits: 3, misses: 3 });
    for (const value of ['HEAD', before.commit.slice(0, 12), `${before.commit}^{commit}`, '', null, { toString: () => before.commit }]) {
      assert.throws(() => cache.blob(repository, value, 'fixture.bin'), /complete commit ID/);
    }
    for (const filename of ['../fixture.bin', '/fixture.bin', 'a\\fixture.bin', 'a:fixture.bin', '']) {
      assert.throws(() => cache.blob(repository, before.commit, filename), /repository path|nonempty text/);
    }
    assert.throws(() => cache.identity(repository, before.commit, 'HEAD'), /identity peel/);
    const beforeFailure = cache.stats();
    assert.throws(() => cache.blob(second, before.commit, 'fixture.bin'), /git/);
    assert.deepEqual(cache.stats(), beforeFailure, 'failed Git reads must never enter the cache');
    git(second, ['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', repository, before.commit]);
    assert.deepEqual(cache.blob(second, before.commit, 'fixture.bin'), original);
    assert.equal(cache.stats().misses, beforeFailure.misses + 1, 'the same commit in another repository needs a separate read');
    const independent = createImmutableGitReadCache();
    assert.deepEqual(independent.blob(repository, before.commit, 'fixture.bin'), original);
    assert.deepEqual(independent.stats(), { entries: 1, hits: 0, misses: 1 });
    const changed = Buffer.from('new immutable object\n');
    await writeFile(path.join(repository, 'fixture.bin'), changed);
    const current = commit(repository);
    assert.notEqual(current.commit, before.commit);
    assert.deepEqual(cache.blob(repository, before.commit, 'fixture.bin'), original);
    assert.deepEqual(cache.blob(repository, current.commit, 'fixture.bin'), changed);

    const save = async (name, value) => {
      const bytes = Buffer.from(JSON.stringify(value)), filename = path.join(output, name);
      await writeFile(filename, bytes); return { path: filename, sha256: hash(bytes) };
    };
    const baseline = await save('baseline.json', { fixture: true });
    const ids = ['frontend:fixture', 'native:prepared-cache', 'native:retry-cap', 'native:offline-friend-request', 'rust:fixture::'];
    const plan = { schemaVersion: 1, kind: 'kaigen-windows-incremental-plan', source: current, productSource: current,
      baseline: { source: current, evidence: [baseline] }, testOnlyPaths: [], changes: [],
      checks: ids.map(id => ({ id, action: 'run', reason: 'Actual Git validation fixture; no product commands run', inputs: [{ id: 'package.json', kind: 'git', path: 'package.json', sha256: hash(packageBytes) }] })) };
    const pin = await save('plan.json', plan);
    const options = { planPath: pin.path, planSha256: pin.sha256, projectRoot: repository, referenceRoot: repository };
    const [one, two] = await Promise.all([validatePlan(options), validatePlan(options)]);
    assert.notEqual(one.blobCache, two.blobCache, 'concurrent top-level validations need independent caches');
    for (const context of [one, two]) assert.deepEqual(context.blobCache.stats(), { entries: 3, hits: 8, misses: 3 });
    const wrongTree = structuredClone(plan); wrongTree.productSource = { ...current, tree: '0'.repeat(40) };
    const wrongTreePin = await save('wrong-tree.json', wrongTree);
    await assert.rejects(() => validatePlan({ ...options, planPath: wrongTreePin.path, planSha256: wrongTreePin.sha256 }), /source tree does not match/);
    const wrongInput = structuredClone(plan); wrongInput.checks[1].inputs[0].sha256 = '0'.repeat(64);
    const wrongInputPin = await save('wrong-input.json', wrongInput);
    await assert.rejects(() => validatePlan({ ...options, planPath: wrongInputPin.path, planSha256: wrongInputPin.sha256 }), /input identity changed/);
    await writeFile(path.join(repository, 'fixture.bin'), 'dirty working tree');
    await assert.rejects(() => validatePlan(options), /checkout must be clean/);
    await writeFile(path.join(repository, 'fixture.bin'), changed);
    const baselineBytes = await readFile(baseline.path);
    await writeFile(baseline.path, 'changed evidence');
    await assert.rejects(() => validatePlan(options), /file hash changed/);
    await writeFile(baseline.path, baselineBytes);
    assert.equal(git(repository, ['status', '--porcelain']), '');
    console.log('Immutable Git reads: real object reuse, copied buffers, failed-read retry, separate roots/concurrent calls, and wrong tree/input/dirty/evidence regressions passed');
  } finally {
    assert.equal(path.dirname(temporary), await realpath(os.tmpdir()));
    assert(path.basename(temporary).startsWith('kaigen-immutable-git-'));
    await rm(temporary, { recursive: true, force: true });
  }
}

export function runAcceptedVersionBaselineTests() {
  const entry = acceptedVersionBaselineTemplate(), baseline = entry.baselineSource, product = entry.productSource;
  const checks = ['frontend:component-inventory', 'frontend:build-pipeline'].map(id => ({ id, action: 'run' }));
  const validate = (value = entry, old = baseline, current = product, planned = checks) => assertAcceptedVersionDeclaration(value, old, current, planned);
  validate();
  validate(Object.fromEntries(Object.entries(entry).reverse()));
  const mutations = [
    value => { value.unreviewedWaiver = true; },
    value => { value.publicRef.sha256 = '0'.repeat(64); },
    value => { value.publicRef.logicalDigest = '0'.repeat(64); },
    value => { value.publicRef.path = 'context.local/work/runtime/local-portable/payloads/windows-finish/wrong.json'; },
    value => { value.transactionId = '0'.repeat(32); },
    value => { value.prebuiltEvidence.sha256 = '0'.repeat(64); },
    value => { value.productSnapshot.manifest.sha256 = '0'.repeat(64); },
    value => { value.productSnapshot.build.sha256 = '0'.repeat(64); },
    value => { value.productSnapshot.archive.path = '../wrong.zip'; },
    value => { value.productSnapshot.manifest.optional = true; },
  ];
  for (const mutate of mutations) {
    const copy = acceptedVersionBaselineTemplate(); mutate(copy);
    assert.throws(() => validate(copy), /exact reviewed declaration/);
  }
  assert.throws(() => validate(entry, { ...baseline, commit: '0'.repeat(40) }), /source identities/);
  assert.throws(() => validate(entry, baseline, { ...product, tree: '0'.repeat(40) }), /source identities/);
  for (const check of checks) {
    assert.throws(() => validate(entry, baseline, product, checks.filter(value => value.id !== check.id)), /requires fresh/);
    assert.throws(() => validate(entry, baseline, product, checks.map(value => value.id === check.id ? { ...value, action: 'reuse' } : value)), /requires fresh/);
    assert.throws(() => validate(entry, baseline, product, checks.map(value => value.id === check.id ? { ...value, evidence: {} } : value)), /requires fresh/);
  }
  const files = {
    'package-lock.json': '{"version":"0.2.9+5","packages":{"":{"version":"0.2.9+5"}}}\n',
    'package.json': '{"version":"0.2.9+5","scripts":{"test:fixture":"node fixture.mjs"}}\n',
    'src-tauri/Cargo.lock': '[[package]]\nname = "kaigen"\nversion = "0.2.9+5"\n',
    'src-tauri/Cargo.toml': '[package]\nname = "kaigen"\nversion = "0.2.9+5"\n',
    'src-tauri/tauri.conf.json': '{"version":"0.2.9+5","identifier":"fixture"}\n',
    'src/componentVersions.ts': 'export const COMPONENT_VERSIONS = Object.freeze({\n  app: "0.2.9.5",\n  appManifest: "0.2.9+5",\n  webBackendManifest: "0.2.9+5",\n});\n',
    'web/kaigen-webd/Cargo.lock': '[[package]]\nname = "kaigen"\nversion = "0.2.9+5"\n[[package]]\nname = "kaigen-webd"\nversion = "0.2.9+5"\n',
    'web/kaigen-webd/Cargo.toml': '[package]\nname = "kaigen-webd"\nversion = "0.2.9+5"\n',
  };
  const changes = Object.keys(files).map(path => ({ path, beforeMode: '100644', afterMode: '100644' }));
  const before = name => Buffer.from(files[name]), after = name => Buffer.from(files[name].replaceAll('"0.2.9+5"', '"0.2.9+6"').replaceAll('"0.2.9.5"', '"0.2.9.6"'));
  assertAcceptedVersionDelta(changes, before, after);
  assert.throws(() => assertAcceptedVersionDelta(changes.slice(1), before, after), /exactly the eight/);
  assert.throws(() => assertAcceptedVersionDelta([...changes, { path: 'src/App.tsx', beforeMode: '100644', afterMode: '100644' }], before, after), /exactly the eight/);
  assert.throws(() => assertAcceptedVersionDelta(changes.map((change, index) => index ? change : { ...change, afterMode: '100755' }), before, after), /source mode/);
  assert.throws(() => assertAcceptedVersionDelta(changes, before, name => Buffer.from(after(name).toString().replaceAll('0.2.9+6', '0.2.9+7'))), /unknown version transition/);
  assert.throws(() => assertAcceptedVersionDelta(changes, before, name => Buffer.concat([after(name), Buffer.from(name === 'package.json' ? ' ' : '')])), /non-version change/);
  assert.throws(() => assertAcceptedVersionDelta(changes, before, name => name === 'package.json' ? Buffer.from(after(name).toString().replace('node fixture.mjs', 'node changed.mjs')) : after(name)), /non-version change/);
  console.log('Accepted version baseline: exact declaration, immutable pins, fresh checks, eight literal-only paths, source modes and unknown version negative checks passed');
}

export function runReleaseMetadataVersionTests() {
  const old = 'KAIGEN_RELEASE_LABEL: 0.2.9.5\nKAIGEN_WEB_BUILD_ID: kaigen-0.2.9.5\nname: Kaigen-Web-Debian13-Nginx-0.2.9.5\nartifacts/Kaigen-Web-Debian13-Nginx-0.2.9.5.tar.gz\nartifacts/Kaigen-Web-Installer-0.2.9.5.sh\n';
  const current = old.replaceAll('0.2.9.5', '0.2.9.6');
  validateReleaseMetadata(old, current, '0.2.9+5', '0.2.9+6');
  validateReleaseMetadata(old, current, '0.2.9.5', '0.2.9.6');
  for (const version of ['0.2.9+6-extra', '0.2.9.6.1', '0.2', 'HEAD', '', undefined]) assert.throws(() => validateReleaseMetadata(old, current, '0.2.9+5', version), /invalid release metadata version/);
  assert.throws(() => validateReleaseMetadata(old, current, '0.2.9+5', '0.2.9.5'), /invalid release metadata version/);
  assert.throws(() => validateReleaseMetadata(old, current, '0.2.9+5', '0.2.9+7'), /beyond the five version labels/);
  assert.throws(() => validateReleaseMetadata(old, `${current}run: arbitrary-command\n`, '0.2.9+5', '0.2.9+6'), /beyond the five version labels/);
  assert.throws(() => validateReleaseMetadata(old, current.replace('KAIGEN_RELEASE_LABEL: 0.2.9.6', 'KAIGEN_RELEASE_LABEL: 0.2.9.5'), '0.2.9+5', '0.2.9+6'), /beyond the five version labels/);
  assert.throws(() => validateReleaseMetadata(`${old}KAIGEN_RELEASE_LABEL: 0.2.9.5\n`, `${current}KAIGEN_RELEASE_LABEL: 0.2.9.6\n`, '0.2.9+5', '0.2.9+6'), /missing or ambiguous/);
  console.log('Release metadata: root manifest to public version labels; invalid, incomplete, duplicate and unrelated workflow edits rejected');
}

export async function runWindowsSubstRootTests() {
  if (process.platform !== 'win32') return;
  const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), 'kaigen-subst-root-Юникод путь-')));
  const owner = path.join(temporary, 'owner with spaces');
  const repository = path.join(owner, 'KaigenToxClient'), output = path.join(owner, 'outputs');
  const subst = path.join(process.env.SystemRoot, 'System32', 'subst.exe');
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  let drive, mapped = false;
  try {
    for (let code = 90; code >= 68; code -= 1) {
      const candidate = `${String.fromCharCode(code)}:`;
      try { await lstat(`${candidate}\\`); } catch (error) { if (error.code !== 'ENOENT') throw error; drive = candidate; break; }
    }
    assert(drive, 'No free drive for the disposable Windows SUBST regression');
    await mkdir(repository, { recursive: true }); await mkdir(output); await mkdir(path.join(repository, 'scripts'));
    const packageBytes = Buffer.from('{"scripts":{"test:frontend":"npm run test:fixture"}}\n');
    await writeFile(path.join(repository, 'package.json'), packageBytes);
    const script = "$ErrorActionPreference = 'Stop'\nif ($PSScriptRoot -match '[^\\x00-\\x7F]' -or (Get-Location).Path -match '[^\\x00-\\x7F]') { throw 'Fixture requires ASCII execution paths' }\n[pscustomobject]@{ scriptRoot = $PSScriptRoot; cwd = (Get-Location).Path } | ConvertTo-Json -Compress\n";
    for (const id of ['native:prepared-cache', 'native:retry-cap', 'native:offline-friend-request']) {
      await writeFile(path.join(repository, descriptor(id, new Set()).args[2]), script);
    }
    const git = args => execFileSync('git', ['-c', 'core.autocrlf=false', '-c', `safe.directory=${repository.replaceAll('\\', '/')}`, '-C', repository, ...args], { encoding: 'utf8', windowsHide: true }).trim();
    git(['init', '--quiet']); git(['add', '.']);
    git(['-c', 'user.name=Kaigen SUBST fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'disposable SUBST fixture']);
    const source = { commit: git(['rev-parse', 'HEAD']), tree: git(['rev-parse', 'HEAD^{tree}']) };
    const save = async (name, value) => { const bytes = Buffer.from(JSON.stringify(value)), filename = path.join(output, name); await writeFile(filename, bytes); return { path: filename, sha256: hash(bytes) }; };
    const baseline = await save('baseline.json', { fixture: true });
    const ids = ['frontend:fixture', 'native:prepared-cache', 'native:retry-cap', 'native:offline-friend-request', 'rust:fixture::'];
    const plan = { schemaVersion: 1, kind: 'kaigen-windows-incremental-plan', source, productSource: source, baseline: { source, evidence: [baseline] }, evidenceOwnerRoot: owner, testOnlyPaths: [], changes: [],
      checks: ids.map(id => ({ id, action: 'run', reason: 'Disposable validation fixture; native commands only observe their paths', inputs: [{ id: 'package.json', kind: 'git', path: 'package.json', sha256: hash(packageBytes) }] })) };
    const pin = await save('plan.json', plan), options = { planPath: pin.path, planSha256: pin.sha256, projectRoot: repository, referenceRoot: repository };
    await validatePlan(options);
    execFileSync(subst, [drive, temporary], { windowsHide: true }); mapped = true;
    const alias = `${drive}\\owner with spaces\\KaigenToxClient`;
    assert.equal(await canonicalVerificationRoot(alias), repository);
    const validated = await validatePlan({ ...options, projectRoot: alias, referenceRoot: alias });
    assert.equal(validated.root, repository); assert.equal(validated.referenceRoot, repository);
    assert.equal(validated.executionRoot, alias);
    assert.equal(await verificationExecutionRoot(validated), alias);
    const lowerAlias = alias.toLowerCase();
    assert.equal(await verificationExecutionRoot({ ...validated, executionRoot: lowerAlias }), lowerAlias);
    const receiptPath = path.join(output, 'native-path-fixture.json');
    const cli = execFileSync(process.execPath, [fileURLToPath(new URL('./incremental-windows-verification.mjs', import.meta.url)), 'run-native', '--plan', pin.path, '--plan-sha256', pin.sha256, '--project-root', lowerAlias, '--reference-root', alias, '--receipt', receiptPath], { encoding: 'utf8', windowsHide: true });
    assert.match(cli, /INCREMENTAL_WINDOWS_RUN_NATIVE_PASS/);
    const progress = JSON.parse(await readFile(`${receiptPath}.pending.json`, 'utf8'));
    assert.equal(progress.checks.length, 3);
    for (const entry of progress.checks) {
      const result = JSON.parse(await readFile(entry.result.path, 'utf8'));
      const observation = JSON.parse(await readFile(result.output.path, 'utf8'));
      assert(!/[^\x00-\x7F]/u.test(observation.cwd + observation.scriptRoot));
      assert.equal(await realpath(observation.cwd), repository);
      assert.equal(await realpath(observation.scriptRoot), path.join(repository, 'scripts'));
      assert.equal(observation.cwd.slice(0, 2).toLowerCase(), drive.toLowerCase());
      assert.deepEqual(result.source, source);
    }
    const outside = path.join(temporary, 'outside-owner-route'); await mkdir(outside);
    const junction = path.join(temporary, 'junction'); await symlink(outside, junction, 'junction');
    await assert.rejects(() => canonicalVerificationRoot(junction), /not an ordinary directory/);
    const nestedJunction = path.join(repository, 'junction'); await symlink(outside, nestedJunction, 'junction');
    await assert.rejects(() => canonicalVerificationRoot(path.join(alias, 'junction')), /not an ordinary directory/);
    await assert.rejects(() => verificationExecutionRoot({ ...validated, executionRoot: path.join(alias, 'junction') }), /not an ordinary directory/);
    await assert.rejects(() => canonicalVerificationRoot('\\\\localhost\\C$\\Windows'), /local absolute path/);
    await assert.rejects(() => verificationExecutionRoot({ ...validated, executionRoot: '\\\\localhost\\C$\\Windows' }), /local absolute path/);
    await rm(nestedJunction); await rm(junction);
    execFileSync(subst, [drive, '/D'], { windowsHide: true }); mapped = false;
    await mkdir(path.join(outside, 'owner with spaces', 'KaigenToxClient'), { recursive: true });
    execFileSync(subst, [drive, outside], { windowsHide: true }); mapped = true;
    await assert.rejects(() => verificationExecutionRoot(validated), /changed after validation/);
    await assert.rejects(() => validatePlan({ ...options, projectRoot: alias }), /disagree with the declared evidence owner/);
    assert.equal(git(['status', '--porcelain']), '');
    console.log('Windows SUBST root: real three-pwsh dispatch retains ASCII cwd/script roots over a Unicode target, spaces and case variants; remapping, junctions, UNC and outside-owner roots rejected');
  } finally {
    if (mapped) execFileSync(subst, [drive, '/D'], { windowsHide: true });
    assert.equal(path.dirname(temporary), await realpath(os.tmpdir()));
    assert(path.basename(temporary).startsWith('kaigen-subst-root-'));
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function runPackageClosureTests() {
  const bytes = value => Buffer.from(JSON.stringify(value));
  const before = { name: 'kaigen', private: true, version: '0.2.9+5', type: 'module', dependencies: { react: '19.2.8' }, scripts: { 'test:chat-navigation': 'node scripts/test-chat-navigation.mjs', 'test:frontend': 'npm run test:friend-resilience && npm run test:localization' } };
  const after = { ...before, version: '0.2.9+6', scripts: { ...before.scripts, 'test:outgoing-message-state': 'node scripts/test-outgoing-message-state.mjs', 'test:input-language-sync': 'node scripts/test-input-language-sync.mjs', 'test:frontend': 'npm run test:friend-resilience && npm run test:outgoing-message-state && npm run test:input-language-sync && npm run test:localization' } };
  const lock = version => ({ name: 'kaigen', version, packages: { '': { name: 'kaigen', version }, 'node_modules/react': { version: '19.2.8', integrity: 'fixture-locked' } } });
  const oldLock = lock(before.version), newLock = lock(after.version);
  const check = (a = after, b = newLock, id = 'frontend:chat-navigation') => packageScriptClosureEquivalent(id, bytes(before), bytes(a), bytes(oldLock), bytes(b));
  assert.deepEqual(check(), { script: 'test:chat-navigation', closure: ['test:chat-navigation'] });
  assert.throws(() => check({ ...after, dependencies: { react: '20' } }), /dependency/);
  assert.throws(() => check({ ...after, injected: true }), /other field/);
  assert.throws(() => check({ ...after, scripts: { ...after.scripts, 'test:other': 'node other.mjs' } }), /catalog/);
  assert.throws(() => check({ ...after, scripts: { ...after.scripts, 'test:chat-navigation': 'node modified.mjs' } }), /script changed/);
  assert.throws(() => check({ ...after, scripts: { ...after.scripts, 'pretest:chat-navigation': 'node hook.mjs' } }), /closure changed/);
  assert.throws(() => check({ ...after, scripts: { ...after.scripts, 'test:frontend': before.scripts['test:frontend'] } }), /catalog/);
  assert.throws(() => check(after, { ...newLock, packages: { ...newLock.packages, 'node_modules/react': { version: '20' } } }), /lock dependency/);
  for (const id of ['frontend:chat-notifications', 'frontend:web-content-security', 'frontend:build-pipeline']) assert.throws(() => check(after, newLock, id), /not approved/);
  await assert.rejects(() => validatePackageOnlySourceClosure('frontend:chat-navigation', { before: () => Buffer.from('same but unreviewed'), after: () => Buffer.from('same but unreviewed') }), /not been reviewed/);
  await assert.rejects(() => validatePackageOnlySourceClosure('frontend:chat-navigation', { before: () => Buffer.from('before'), after: () => Buffer.from('changed') }), /consumer changed/);
  await assert.rejects(() => validatePackageOnlySourceClosure('frontend:file-receive-settings', { before: () => Buffer.from('before'), after: name => Buffer.from(name === 'src/Settings.tsx' ? 'changed setting consumer' : 'before') }), /consumer changed: src\/Settings.tsx/);
  console.log('Package reuse closure: exact catalog recipe, lifecycle commands, dependencies, lock graph and reviewed consumer negative checks passed');
}

export async function runImportedExecutionTests() {
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const bytes = value => Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
  const root = path.resolve(os.tmpdir(), 'kaigen-import-fixture'), compiled = path.join(root, 'compile'), sourceRoot = path.join(root, 'source');
  const storage = new Map();
  const pin = (name, value) => {
    const filename = path.join(root, name), content = bytes(value);
    storage.set(filename, content);
    return { path: filename, sha256: hash(content) };
  };
  const source = { commit: '1'.repeat(40), tree: '2'.repeat(40) };
  const sourceBytes = bytes('[package]\nname = "kaigen"\nversion = "0.2.9+5"\n');
  const currentBytes = bytes('[package]\nname = "kaigen"\nversion = "0.2.9+6"\n');
  const sourcePath = 'src-tauri/Cargo.toml';
  pin(`source/${sourcePath}`, sourceBytes);
  const inventoryEntry = { path: sourcePath, size: sourceBytes.length, sha256: hash(sourceBytes) };
  const inventory = { sha256: hash(bytes(`${sourcePath}\t${sourceBytes.length}\t${hash(sourceBytes)}\n`)), files: [inventoryEntry] };
  const inventoryPin = pin('compile/source-inventory.json', inventory);
  const manifestPin = pin('compile/coordinator-source-manifest.json', { windowsSnapshotCommit: source.commit, tree: source.tree, files: 1 });
  const helperPin = pin('compile-helper.ps1', 'fixture compile producer'), runnerPin = pin('runner.ps1', 'fixture immutable VM runner');
  const embeddedBuildSourceRoot = 'Z:\\fixture-source';
  const compileLog = pin('compile/desktop-lib-no-run.log', `${JSON.stringify({ reason: 'compiler-artifact', target: { name: 'tauri_app_lib', src_path: 'Z:\\fixture-source\\src-tauri\\src\\lib.rs' }, profile: { test: true }, manifest_path: 'Z:\\fixture-source\\src-tauri\\Cargo.toml', features: ['default', 'desktop'], executable: 'Z:\\fixture-source\\src-tauri\\target\\debug\\deps\\fixture.exe' })}\n${JSON.stringify({ reason: 'build-finished', success: true })}\n`);
  const targetFiles = ['kaigen-lib-tests.exe', 'pthreadVC3.dll', 'toxcore.dll'].map(name => {
    const reference = pin(`compile/desktop-tests/${name}`, `MZfixture-${name}`);
    return { path: name, size: storage.get(reference.path).length, sha256: reference.sha256 };
  });
  const targetPin = pin('compile/desktop-tests/compile-inputs.json', { status: 'COMPILED_ONLY', testsExecuted: false, sourceInventorySha256: inventory.sha256, coordinatorManifestSha256: manifestPin.sha256, target: 'tauri_app_lib', files: targetFiles, logSha256: compileLog.sha256, embeddedBuildSourceRoot });
  const fileEntry = reference => ({ path: path.relative(compiled, reference.path).replaceAll('\\', '/'), size: storage.get(reference.path).length, sha256: reference.sha256 });
  const compile = { schemaVersion: 1, documentType: 'kaigen-task-compile-only', status: 'COMPILED_ONLY', testsExecuted: false, sourceRoot,
    sourceInventorySha256: inventory.sha256, coordinatorManifestSha256: manifestPin.sha256, helperSha256: helperPin.sha256, embeddedBuildSourceRoot,
    startedUtc: '2026-09-26T23:08:00Z', finishedUtc: '2026-09-26T23:09:00Z',
    files: [fileEntry(inventoryPin), fileEntry(manifestPin), fileEntry(targetPin), ...targetFiles.map(value => ({ ...value, path: `desktop-tests/${value.path}` }))],
    commands: [{ label: 'desktop-lib-no-run', program: 'cargo', arguments: ['test', '--offline', '--locked', '--manifest-path', 'src-tauri\\Cargo.toml', '--lib', '--no-run', '--message-format=json-render-diagnostics'], exitCode: 0, log: 'desktop-lib-no-run.log', logSha256: compileLog.sha256, startedUtc: '2026-09-26T23:08:01Z', finishedUtc: '2026-09-26T23:08:59Z' }],
  };
  const compilePin = pin('compile/compile-only.json', compile);
  const inputManifest = { compileReceiptSha256: compilePin.sha256, sourceInventorySha256: inventory.sha256, sourceManifestSha256: manifestPin.sha256,
    files: compile.files.filter(entry => entry.path.startsWith('desktop-tests/')).map(entry => ({ path: entry.path, sha256: entry.sha256, bytes: entry.size })) };
  const inputPin = pin('execution/input-files.json', inputManifest);
  const stdoutPin = pin('execution/stdout.log', 'test pq::works ... ok\ntest result: ok. 1 passed; 0 failed; 0 ignored;\n');
  const stderrPin = pin('execution/stderr.log', '');
  const listingPin = pin('execution/desktop-tests.list.log', 'pq::works: test\nother::works: test\n');
  const rawCase = { command: ['C:\\fixture\\desktop-tests\\kaigen-lib-tests.exe', 'pq:: --test-threads=1'], workingDirectory: 'C:\\fixture\\desktop-tests',
    fixtureTemp: 'C:\\fixture\\scratch\\case-000-desktop-tests',
    target: 'desktop-tests', filter: 'pq::', status: 'PASS', timedOut: false, exitCode: 0, startedUtc: '2026-09-26T23:10:02Z', finishedUtc: '2026-09-26T23:10:03Z',
    stdoutSha256: stdoutPin.sha256, stderrSha256: stderrPin.sha256, matchedTests: ['pq::works'], summary: 'test result: ok. 1 passed; 0 failed; 0 ignored;' };
  const casePin = pin('execution/case.json', rawCase);
  const vm = { schemaVersion: 1, kind: 'kaigen-vm-pq-rust-r2-full', status: 'PASS', testsExecutedInVm: true, testsExecutedOnHost: false,
    sourceInventorySha256: inventory.sha256, sourceManifestSha256: manifestPin.sha256, compileReceiptSha256: compilePin.sha256, inputManifestSha256: inputPin.sha256, helperSha256: runnerPin.sha256,
    startedUtc: '2026-09-26T23:10:00Z', finishedUtc: '2026-09-26T23:10:04Z', preflight: { utc: '2026-09-26T23:10:01Z', filesVerified: 4, sourceInventorySha256: inventory.sha256, compileReceiptSha256: compilePin.sha256 }, postflight: { utc: '2026-09-26T23:10:05Z', filesVerified: 4 }, cases: [rawCase] };
  const vmPin = pin('execution/receipt.json', vm);
  const result = { schemaVersion: 1, kind: IMPORTED_RUST_KIND, checkId: 'rust:pq::', source, command: rawCase.command, startedAt: rawCase.startedUtc, completedAt: rawCase.finishedUtc,
    compile: { receipt: compilePin, inventory: inventoryPin, manifest: manifestPin, sourceRoot, helper: helperPin },
    execution: { receipt: vmPin, inputManifest: inputPin, runner: runnerPin, caseIndex: 0, case: casePin, stdout: stdoutPin, stderr: stderrPin, listing: listingPin },
    sourceChanges: [{ path: sourcePath, beforeSha256: hash(sourceBytes), afterSha256: hash(currentBytes), disposition: 'application-version-only' }] };
  const check = { id: 'rust:pq::', action: 'reuse' };
  const api = { read: async reference => {
    const content = storage.get(reference.path);
    assert(content && hash(content) === reference.sha256, 'immutable file hash changed');
    return { path: reference.path, bytes: content };
  }, sourceIdentity: async (directory, identity) => { assert.equal(directory, sourceRoot); assert.deepEqual(identity, source); },
    sourcePaths: async () => [sourcePath], sourceBlob: async () => sourceBytes,
    currentPaths: async () => [sourcePath], currentBlob: async () => currentBytes, freshVersionInventory: true };
  assert.deepEqual((await validateImportedRustExecution(result, check, api)).command, rawCase.command);
  await assert.rejects(() => validateImportedRustExecution(result, { ...check, action: 'run' }, api), /reuse/);
  await assert.rejects(() => validateImportedRustExecution({ ...result, command: ['cargo', 'test'] }, check, api), /original command/);
  await assert.rejects(() => validateImportedRustExecution({ ...result, startedAt: '2026-09-28T00:00:00Z' }, check, api), /timestamps/);
  await assert.rejects(() => validateImportedRustExecution({ ...result, source: { ...source, commit: '3'.repeat(40) } }, check, api), /built-from/);
  await assert.rejects(() => validateImportedRustExecution({ ...result, sourceChanges: [] }, check, api), /complete source change/);
  await assert.rejects(() => validateImportedRustExecution(result, check, { ...api, freshVersionInventory: false }), /fresh component/);
  await assert.rejects(() => validateImportedRustExecution(result, check, { ...api, sourcePaths: async () => [sourcePath, 'omitted.rs'] }), /incomplete/);
  await assert.rejects(() => validateImportedRustExecution(result, check, { ...api, currentBlob: async () => bytes(`${currentBytes}[dependencies]\nchanged = "1"\n`) }), /changed build dependency/);
  for (const reference of [compilePin, inventoryPin, manifestPin, targetPin, vmPin, casePin, stdoutPin, listingPin, runnerPin, compileLog,
    { path: path.join(compiled, 'desktop-tests', 'kaigen-lib-tests.exe') }, { path: path.join(sourceRoot, sourcePath) }]) {
    const previous = storage.get(reference.path);
    storage.set(reference.path, Buffer.concat([previous, bytes('mutation')]));
    await assert.rejects(() => validateImportedRustExecution(result, check, api), /immutable file hash changed/);
    storage.set(reference.path, previous);
  }
  const forged = (name, value) => pin(`forged-${name}.json`, value);
  const filteredPin = forged('filtered-vm', { ...vm, kind: 'kaigen-vm-rust-filtered-execution' });
  await validateImportedRustExecution({ ...result, execution: { ...result.execution, receipt: filteredPin } }, check, api);
  await assert.rejects(() => validateImportedRustExecution({ ...result, execution: { ...result.execution, receipt: forged('unknown-vm', { ...vm, kind: 'unknown' }) } }, check, api), /VM execution/);
  const outside = { path: 'src/unrelated.ts', beforeSha256: null, afterSha256: hash(bytes('new')), disposition: 'outside-rust-library' };
  await assert.rejects(() => validateImportedRustExecution({ ...result, sourceChanges: [outside, ...result.sourceChanges].sort((a,b) => a.path < b.path ? -1 : 1) }, check,
    { ...api, currentPaths: () => [sourcePath, outside.path].sort(), currentBlob: name => name === sourcePath ? currentBytes : bytes('new') }), /unreviewed Rust dependency boundary/);
  await assert.rejects(() => validateImportedRustExecution(result, check, { ...api, currentPaths: () => [sourcePath, 'src-tauri/src/new.rs'], currentBlob: name => name === sourcePath ? currentBytes : bytes('include_str!("../../src/new.ts")') }), /changed build dependency/);
  const badCase = { ...rawCase, command: [rawCase.command[0], 'other:: --test-threads=1'] };
  const badCasePin = forged('case', badCase), badVmPin = forged('vm', { ...vm, cases: [badCase] });
  await assert.rejects(() => validateImportedRustExecution({ ...result, execution: { ...result.execution, case: badCasePin, receipt: badVmPin } }, check, api), /EXE command/);
  const wrongArtifact = { ...rawCase, command: ['C:\\fixture\\desktop-tests\\other.exe', rawCase.command[1]] };
  await assert.rejects(() => validateImportedRustExecution({ ...result, execution: { ...result.execution, case: forged('artifact-case', wrongArtifact), receipt: forged('artifact-vm', { ...vm, cases: [wrongArtifact] }) } }, check, api), /EXE command/);
  const tooEarly = { ...rawCase, startedUtc: '2026-09-25T00:00:00Z' };
  await assert.rejects(() => validateImportedRustExecution({ ...result, startedAt: tooEarly.startedUtc, execution: { ...result.execution, case: forged('time-case', tooEarly), receipt: forged('time-vm', { ...vm, cases: [tooEarly] }) } }, check, api), /chronology/);
  assert(rootVersionEquivalent(sourcePath, sourceBytes, currentBytes));
  assert(!rootVersionEquivalent(sourcePath, sourceBytes, bytes(`${currentBytes}[dependencies]\nchanged = "1"`)));
  assert(!rootVersionEquivalent('arbitrary.toml', sourceBytes, currentBytes));
  const packageOld = bytes('{"version":"0.2.9+5","dependencies":{"react":"19.2.8"}}');
  assert(rootVersionEquivalent('package.json', packageOld, bytes('{"version":"0.2.9+6","dependencies":{"react":"19.2.8"}}')));
  assert(!rootVersionEquivalent('package.json', packageOld, bytes('{"version":"0.2.9+6","dependencies":{"react":"20"}}')));
  assert(!isolatedInputLanguageChange(sourceBytes, currentBytes, sourceBytes, 'rust:input_language::policy::'));
  console.log('Imported Rust evidence: immutable artifacts, complete inventory, commands, timestamps, source/version dependencies and reuse-only negative checks passed');
}

export async function runEvidenceRelocationTests() {
  const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), 'kaigen-evidence-relocation-')));
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const jsonBytes = value => Buffer.from(`${JSON.stringify(value, null, 2)}\r\n`);
  try {
    const repository = path.join(temporary, 'source'), sourceRoot = path.join(temporary, 'context.local', 'state');
    const archiveRoot = path.join(temporary, 'local-data', 'context-history', 'KOP-v1', 'CTX-02', 'archive', 'state');
    await mkdir(repository, { recursive: true });
    const git = args => execFileSync('git', ['-c', 'core.autocrlf=false', '-c', `safe.directory=${repository.replaceAll('\\', '/')}`, '-C', repository, ...args], { encoding: 'utf8', windowsHide: true }).trim();
    git(['init', '--quiet']);
    await writeFile(path.join(repository, 'package.json'), jsonBytes({ scripts: { 'test:frontend': 'npm run test:fixture' } }));
    git(['add', 'package.json']);
    git(['-c', 'user.name=Kaigen evidence fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'disposable evidence fixture']);
    const source = { commit: git(['rev-parse', 'HEAD']), tree: git(['rev-parse', 'HEAD^{tree}']) };
    const originalBytes = new Map();
    const original = async (relative, bytes) => {
      const filename = path.join(sourceRoot, relative);
      await mkdir(path.dirname(filename), { recursive: true });
      await writeFile(filename, bytes);
      originalBytes.set(filename, Buffer.from(bytes));
      return { path: filename, sha256: hash(bytes) };
    };
    const input = await original('inputs/binary.bin', Buffer.from([0, 255, 13, 10, 128, 1]));
    const output = await original('logs/proof.log', Buffer.from([
      '\uFEFFdisposable original output: Привет',
      'PASS Windows prepared-native cache: built -> hit, compiler sentinel, corruption, missing, revocation, receipt, fresh-app ordering',
      'PASS toxcore retry-cap transformation (60 seconds, idempotent, fail-closed)',
      'PASS controlled recovery model: capped=5->10->20->40->60->60->60',
      'PASS sender stayed routable', 'PASS offline friend request delivered', 'Verified native harness UDP ports:',
      'test fixture::works ... ok', 'test result: ok. 1 passed; 0 failed;', '',
    ].join('\r\n')));
    const checkIds = ['native:prepared-cache', 'native:retry-cap', 'native:offline-friend-request', 'frontend:fixture', 'rust:fixture::'];
    const checks = [];
    for (const [index, id] of checkIds.entries()) {
      const command = descriptor(id, new Set(['test:fixture']));
      const result = await original(`results/${index}.json`, jsonBytes({
        schemaVersion: 1, kind: 'kaigen-incremental-check-result', checkId: id, status: 'PASS', source,
        inputs: [{ id: 'binary-fixture', kind: 'file', path: '../inputs/binary.bin', sha256: input.sha256 }],
        command: { program: command.program, args: command.args }, exitCode: 0,
        output: { ...output, path: '../logs/proof.log' }, startedAt: '2026-09-13T00:00:00Z', completedAt: '2026-09-13T00:00:01Z',
      }));
      checks.push({ id, action: 'reuse', reason: 'Original disposable result remains byte-identical', inputs: [{ id: 'binary-fixture', kind: 'file', ...input }], evidence: result });
    }
    const plan = { schemaVersion: 1, kind: 'kaigen-windows-incremental-plan', source, productSource: source,
      baseline: { source, evidence: [output] }, testOnlyPaths: [], changes: [], checks };
    const oldPlan = await original('nested/plan.json', jsonBytes({ ...plan,
      baseline: { source, evidence: [{ ...output, path: '../logs/proof.log' }] },
      checks: checks.map(check => ({ ...check, evidence: { ...check.evidence, path: `../results/${checks.indexOf(check)}.json` },
        inputs: check.inputs.map(value => ({ ...value, path: '../inputs/binary.bin' })) })),
    }));
    const oldArchive = await original('nested/archive.zip', Buffer.from([80, 75, 3, 4, 0, 255]));
    const receipt = (document, planPin, archivePin) => ({ schemaVersion: 1, kind: 'kaigen-windows-incremental-verification', status: 'PASS', fullBaselineRerun: false,
      plan: planPin, source, productSource: source, materialization: source, baseline: document.baseline,
      checks: document.checks.map(check => ({ id: check.id, disposition: 'reused', result: check.evidence })), archive: archivePin, completedAt: '2026-09-13T00:00:02Z' });
    const oldReceipt = await original('nested/receipt.json', jsonBytes(receipt(JSON.parse(originalBytes.get(oldPlan.path)), oldPlan, oldArchive)));
    const retainedSources = [{ source, verification: { receipt: oldReceipt, plan: oldPlan, archive: oldArchive, projectRoot: repository, referenceRoot: repository } }];
    const writePlan = async (name, manifest) => {
      const document = { ...plan, retainedSources };
      if (manifest !== undefined) {
        const filename = path.join(temporary, `${name}-relocations.json`), bytes = jsonBytes(manifest);
        await writeFile(filename, bytes);
        document.evidenceRelocations = { path: filename, sha256: hash(bytes) };
      }
      const filename = path.join(temporary, `${name}-plan.json`), bytes = jsonBytes(document);
      await writeFile(filename, bytes);
      return { planPath: filename, planSha256: hash(bytes), projectRoot: repository, referenceRoot: repository };
    };
    const originalOptions = await writePlan('original');
    await validatePlan(originalOptions);
    await mkdir(path.dirname(archiveRoot), { recursive: true });
    await rename(sourceRoot, archiveRoot);
    const manifest = { schemaVersion: 1, kind: 'kaigen-evidence-relocations', sourceRoot, archiveRoot,
      files: [...originalBytes].map(([from, bytes]) => ({ from, to: path.join(archiveRoot, path.relative(sourceRoot, from)), sha256: hash(bytes) })) };
    await assert.rejects(() => validatePlan(originalOptions), error => error.code === 'ENOENT', 'no implicit archive prefix fallback');
    const relocatedOptions = await writePlan('relocated', manifest);
    const context = await validatePlan(relocatedOptions);
    assert.deepEqual(context.retainedResults.map(value => value.path).sort(), checks.map(value => value.evidence.path).sort(), 'retained bindings must keep their original logical paths');
    for (const check of checks) assert.deepEqual(context.inputs.get(check.id), [{ id: 'binary-fixture', kind: 'file', sha256: input.sha256 }], 'file-kind identity must retain the original hash');
    const finalPlan = JSON.parse(await readFile(relocatedOptions.planPath));
    const finalReceipt = path.join(temporary, 'new-receipt.json'), finalArchive = path.join(temporary, 'new-archive.zip');
    const finalArchiveBytes = Buffer.from([80, 75, 3, 4, 2, 255]);
    await writeFile(finalArchive, finalArchiveBytes);
    const finalDocument = receipt(finalPlan, { path: relocatedOptions.planPath, sha256: relocatedOptions.planSha256 }, { path: finalArchive, sha256: hash(finalArchiveBytes) });
    const finalReceiptBytes = jsonBytes(finalDocument);
    await writeFile(finalReceipt, finalReceiptBytes);
    assert.deepEqual(await verifyFinalReceipt({ ...relocatedOptions, receiptPath: finalReceipt, archivePath: finalArchive }), finalDocument, 'final consumer must inherit relocations through the old receipt, plan, archive, results, output and file inputs');
    await assert.rejects(() => validatePlan(originalOptions), error => error.code === 'ENOENT', 'relocation authority must not leak into a later plan');

    const rejected = async (name, changed, expected) => assert.rejects(() => writePlan(name, changed).then(validatePlan), expected);
    await assert.rejects(() => validatePlan({ ...relocatedOptions, planSha256: '0'.repeat(64) }), /file hash changed/);
    const badPin = JSON.parse(await readFile(relocatedOptions.planPath));
    badPin.evidenceRelocations.sha256 = '0'.repeat(64);
    const badPinBytes = jsonBytes(badPin), badPinPath = path.join(temporary, 'wrong-manifest-pin.json');
    await writeFile(badPinPath, badPinBytes);
    await assert.rejects(() => validatePlan({ ...relocatedOptions, planPath: badPinPath, planSha256: hash(badPinBytes) }), /file hash changed/);
    const networkPin = { ...badPin, evidenceRelocations: { path: '//server/share/relocations.json', sha256: '0'.repeat(64) } };
    const networkPinBytes = jsonBytes(networkPin), networkPinPath = path.join(temporary, 'network-manifest-pin.json');
    await writeFile(networkPinPath, networkPinBytes);
    await assert.rejects(() => validatePlan({ ...relocatedOptions, planPath: networkPinPath, planSha256: hash(networkPinBytes) }), /local absolute path/);
    await rejected('wrong-entry-hash', { ...manifest, files: manifest.files.map((entry, index) => index ? entry : { ...entry, sha256: '0'.repeat(64) }) }, /relocated evidence hash changed/);
    await rejected('duplicate-source', { ...manifest, files: [...manifest.files, { ...manifest.files[0] }] }, /ambiguous evidence relocation mapping/);
    await rejected('duplicate-target', { ...manifest, files: [...manifest.files, { ...manifest.files[0], from: path.join(sourceRoot, 'alias.bin') }] }, /ambiguous evidence relocation mapping/);
    await rejected('outside-target', { ...manifest, files: [{ ...manifest.files[0], to: path.join(temporary, 'outside.bin') }] }, /outside its root/);
    await rejected('outside-source', { ...manifest, files: [{ ...manifest.files[0], from: path.join(temporary, 'outside.bin') }] }, /outside its root/);
    await rejected('outside-archive-root', { ...manifest, archiveRoot: path.join(temporary, 'other-archive') }, /unapproved evidence relocation roots/);
    await rejected('network-path', { ...manifest, files: [{ ...manifest.files[0], to: '//server/share/proof.bin' }] }, /local absolute path/);
    await rejected('alternate-stream', { ...manifest, files: [{ ...manifest.files[0], to: `${manifest.files[0].to}:stream` }] }, /alternate stream/);
    await rejected('missing-target', { ...manifest, files: manifest.files.map((entry, index) => index ? entry : { ...entry, to: path.join(archiveRoot, 'missing.bin') }) }, error => error.code === 'ENOENT');
    await rejected('unmapped-input', { ...manifest, files: manifest.files.filter(entry => entry.from !== input.path) }, error => error.code === 'ENOENT');
    await rejected('unmapped-nested-plan', { ...manifest, files: manifest.files.filter(entry => entry.from !== oldPlan.path) }, error => error.code === 'ENOENT');
    await mkdir(path.dirname(output.path), { recursive: true });
    await writeFile(output.path, 'corrupted original must not use the valid archive');
    await assert.rejects(() => validatePlan(relocatedOptions), /file hash changed/, 'existing original corruption must fail closed');
    await rm(output.path);
    const external = path.join(temporary, 'external'), link = path.join(archiveRoot, 'redirect');
    await mkdir(external);
    await writeFile(path.join(external, 'binary.bin'), originalBytes.get(input.path));
    await symlink(external, link, process.platform === 'win32' ? 'junction' : 'dir');
    await rejected('reparse-target', { ...manifest, files: manifest.files.map((entry, index) => index ? entry : { ...entry, to: path.join(link, 'binary.bin') }) }, /relocation path is not ordinary/);
    await rm(link);
    for (const [filename, bytes] of originalBytes) {
      assert.deepEqual(await readFile(path.join(archiveRoot, path.relative(sourceRoot, filename))), bytes, 'all archived proof bytes must remain unchanged');
      await assert.rejects(() => lstat(filename), error => error.code === 'ENOENT', 'the consumer must never restore legacy payload');
    }
    assert.deepEqual(await readFile(finalReceipt), finalReceiptBytes, 'the consumer must not rewrite receipts');
    assert.equal(git(['status', '--porcelain']), '', 'the consumer must leave the source fixture clean');
    console.log('Evidence relocation: original and nested final consumers, immutable bytes/logical hashes, no authority leak, wrong hashes, ambiguity, containment, missing files and reparse rejection passed');
  } finally {
    assert.equal(path.dirname(temporary), await realpath(os.tmpdir()));
    assert(path.basename(temporary).startsWith('kaigen-evidence-relocation-'));
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function runTestOnlyEquivalenceTests() {
  const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), 'kaigen-test-only-equivalence-')));
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  try {
    const repository = path.join(temporary, 'source');
    await mkdir(path.join(repository, 'scripts'), { recursive: true });
    const git = args => execFileSync('git', ['-c', 'core.autocrlf=false', '-c', `safe.directory=${repository.replaceAll('\\', '/')}`, '-C', repository, ...args], { encoding: 'utf8', windowsHide: true }).trim();
    const save = async (name, value) => {
      const bytes = Buffer.from(`${JSON.stringify(value)}\n`), filename = path.join(temporary, name);
      await writeFile(filename, bytes);
      return { path: filename, sha256: hash(bytes) };
    };
    const commit = message => {
      git(['add', '.']);
      git(['-c', 'user.name=Kaigen fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', message]);
      return { commit: git(['rev-parse', 'HEAD']), tree: git(['rev-parse', 'HEAD^{tree}']) };
    };
    git(['init', '--quiet']);
    const packageBytes = Buffer.from('{"scripts":{"test:frontend":"npm run test:fixture"}}\n');
    await writeFile(path.join(repository, 'package.json'), packageBytes);
    await writeFile(path.join(repository, 'scripts/test-app-layout.mjs'), 'old fixture assertion\n');
    await writeFile(path.join(repository, 'scripts/test-prepared-native-cache-windows.ps1'), 'old producer callback assertion\n');
    const timingPaths = ['scripts/test-chat-geometry-runtime.mjs', 'scripts/fixtures/chat-geometry-runtime/app-message-visibility-scenario.ts'];
    await mkdir(path.join(repository, 'scripts/fixtures/chat-geometry-runtime'), { recursive: true });
    for (const filename of timingPaths) await writeFile(path.join(repository, filename), 'old timing assertion\n');
    const productSource = commit('disposable product');
    await writeFile(path.join(repository, 'scripts/test-app-layout.mjs'), 'corrected fixture assertion\n');
    await writeFile(path.join(repository, 'scripts/test-prepared-native-cache-windows.ps1'), 'corrected producer callback assertion\n');
    for (const filename of timingPaths) await writeFile(path.join(repository, filename), 'corrected timing assertion\n');
    const source = commit('disposable test-only correction');
    const baselineEvidence = await save('baseline.json', { fixture: true });
    const ids = ['native:prepared-cache', 'native:retry-cap', 'native:offline-friend-request', 'frontend:fixture', 'rust:fixture::'];
    const plan = { schemaVersion: 1, kind: 'kaigen-windows-incremental-plan', source, productSource,
      baseline: { source: productSource, evidence: [baselineEvidence] }, testOnlyPaths: ['scripts/test-app-layout.mjs', 'scripts/test-prepared-native-cache-windows.ps1', ...timingPaths],
      changes: [{ path: 'scripts/test-app-layout.mjs', beforeBlob: git(['rev-parse', `${productSource.commit}:scripts/test-app-layout.mjs`]), beforeMode: '100644',
        afterBlob: git(['rev-parse', `${source.commit}:scripts/test-app-layout.mjs`]), afterMode: '100644',
        reason: 'Only the stale test assertion changed', checkIds: ['frontend:fixture'] },
      { path: 'scripts/test-prepared-native-cache-windows.ps1', beforeBlob: git(['rev-parse', `${productSource.commit}:scripts/test-prepared-native-cache-windows.ps1`]), beforeMode: '100644',
        afterBlob: git(['rev-parse', `${source.commit}:scripts/test-prepared-native-cache-windows.ps1`]), afterMode: '100644',
        reason: 'Only the producer callback regression changed', checkIds: ['native:prepared-cache'] },
      ...timingPaths.map(filename => ({ path: filename, beforeBlob: git(['rev-parse', `${productSource.commit}:${filename}`]), beforeMode: '100644',
        afterBlob: git(['rev-parse', `${source.commit}:${filename}`]), afterMode: '100644',
        reason: 'Only the exact timing runner or fixture changed', checkIds: ['frontend:fixture'] }))],
      checks: ids.map(id => ({ id, action: 'run', reason: 'Disposable validation fixture; commands are never executed',
        inputs: [{ id: 'package.json', kind: 'git', path: 'package.json', sha256: hash(packageBytes) }] })) };
    const validate = async (name, document) => {
      const pin = await save(name, document);
      return validatePlan({ planPath: pin.path, planSha256: pin.sha256, projectRoot: repository, referenceRoot: repository });
    };
    await validate('allowed.json', plan);
    for (const id of ['frontend:fixture', 'native:prepared-cache', 'native:retry-cap', 'native:offline-friend-request', 'rust:fixture::']) {
      const reduced = { ...plan, checks: plan.checks.filter(check => check.id !== id), changes: plan.changes.map(change => ({ ...change, checkIds: change.checkIds.includes(id) ? ['rust:fixture::'] : change.checkIds })) };
      await assert.rejects(() => validate(`missing-${id.replaceAll(':', '-')}.json`, reduced), /missing canonical check coverage|Rust evidence coverage is missing/);
    }
    await assert.rejects(() => validate('unbound-baseline-waiver.json', { ...plan, acceptedVersionBaseline: acceptedVersionBaselineTemplate() }), /requires the plan-bound evidence owner root/);
    await assert.rejects(() => validate('undeclared.json', { ...plan, testOnlyPaths: [] }), /differences exceed/);
    await assert.rejects(() => validate('undeclared-native-regression.json', { ...plan, testOnlyPaths: ['scripts/test-app-layout.mjs'] }), /differences exceed/);
    for (const [index, filename] of timingPaths.entries()) {
      await assert.rejects(() => validate(`undeclared-timing-${index}.json`, { ...plan, testOnlyPaths: plan.testOnlyPaths.filter(value => value !== filename) }), /differences exceed/);
    }
    await assert.rejects(() => validate('arbitrary-script.json', { ...plan, testOnlyPaths: ['scripts/arbitrary.mjs'] }), /unapproved test-only/);
    await assert.rejects(() => validate('arbitrary-sibling-fixture.json', { ...plan, testOnlyPaths: [...plan.testOnlyPaths, 'scripts/fixtures/chat-geometry-runtime/arbitrary-scenario.ts'] }), /unapproved test-only/);
    await assert.rejects(() => validate('product-path.json', { ...plan, testOnlyPaths: ['src/App.tsx'] }), /unapproved test-only/);
    await assert.rejects(() => validate('native-product-path.json', { ...plan, testOnlyPaths: [...plan.testOnlyPaths, 'src-tauri/src/lib.rs'] }), /unapproved test-only/);
    assert.equal(git(['status', '--porcelain']), '');
    console.log('Test-only equivalence: exact layout/native-cache/timing runner and fixture corrections accepted; undeclared paths, arbitrary sibling fixture, scripts and product App/lib paths rejected');
  } finally {
    assert.equal(path.dirname(temporary), await realpath(os.tmpdir()));
    assert(path.basename(temporary).startsWith('kaigen-test-only-equivalence-'));
    await rm(temporary, { recursive: true, force: true });
  }
}

export function assertSelectedWebHydration(workflow, checks) {
  const job = workflow.split(/\n  web-debian13-nginx:\r?\n/u)[1];
  assert(job, 'Web job is missing');
  const testStart = job.indexOf('node scripts/ci-incremental-verification.mjs run-tests --platform web ');
  assert(testStart >= 0, 'Web selected-test invocation is missing');
  const primed = new Set([...job.slice(0, testStart).matchAll(/^\s*cargo fetch --locked --manifest-path (\S+)\s*$/gmu)].map(match => match[1]));
  const manifests = new Set(checks.filter(check => check.action === 'run').map(check => {
    const command = rustCommand(check, 'web');
    return command[command.indexOf('--manifest-path') + 1];
  }));
  assert(manifests.size > 0, 'Web selection contains no Rust manifest');
  for (const manifest of manifests) assert(primed.has(manifest), 'Web offline selected manifest lacks preceding locked hydration: ' + manifest);
}

export async function runCiVerificationTests() {
  await runImmutableGitReadCacheTests();
  runAcceptedVersionBaselineTests();
  runReleaseMetadataVersionTests();
  await runWindowsSubstRootTests();
  await runPackageClosureTests();
  await runImportedExecutionTests();
  await runTestOnlyEquivalenceTests();
  await runEvidenceRelocationTests();
  const root = new URL('../', import.meta.url), catalog = JSON.parse(await readFile(new URL('ci/verification-v0.2.9.json', root), 'utf8'));
  if (catalog.selectionScope === 'release-0297-changed-only') {
    const producer = { commit: 'a59edc59c3d22f7b237f01b6938c084ab407d0f2', tree: 'b1ada2380e0dcdf6117c7dd8a4828ee553e66669' };
    assert.deepEqual(catalog.productSource, producer);
    assert.deepEqual(catalog.referenceSource, producer);
    assert.deepEqual(catalog.unixProducerReferenceSource, producer);
    for (const filename of ['src/App.ui-ids.json', 'src/web/WebRoot.ui-ids.json', 'src/ui-id-history.json']) {
      const currentSha = createHash('sha256').update(await readFile(new URL(filename, root))).digest('hex');
      const inputs = Object.values(catalog.inputSets).flat().filter(input => input.path === filename);
      assert(inputs.length > 0 && inputs.every(input => input.sha256 === currentSha), `CI selection has stale UI catalog input: ${filename}`);
    }
    // This catalog is a pinned historical snapshot; current version and full coverage are checked by the current-verification contract.
    assert.equal(catalog.version, '0.2.9+7');
    assert.equal(catalog.baseline.source.commit, '6639b980bc9649ebb712471bc7765d48f6a0e4d0');
    assert.equal(catalog.baseline.jobs.windows.runAttempt, 2);
    const manifest = Buffer.from(catalog.publishedBaselineManifest.base64, 'base64');
    assert.equal(createHash('sha256').update(manifest).digest('hex'), '5c783473e6aa44becbdec511d4d6ee2df139ad3dd2d944c9b81d9d925118b53c');
    const selected = Object.fromEntries(['windows', 'debian', 'macos', 'web'].map(platform => [platform, selectChecks(catalog, platform)]));
    assert.deepEqual(Object.fromEntries(Object.entries(selected).map(([platform, checks]) => [platform, checks.length])), { windows: 14, debian: 1, macos: 1, web: 3 });
    for (const checks of Object.values(selected)) assert(checks.every(check => check.action === 'run' && !/qtox/iu.test(check.id)));
    assert.equal(selected.windows.find(check => check.id === 'frontend:chat-geometry-runtime')?.variant, 'message-visibility-only');
    for (const id of ['frontend:localization', 'frontend:browser-runtime', 'frontend:ui-identity']) assert.equal(selected.windows.find(check => check.id === id)?.variant, 'no-qtox');
    assert.equal(selected.web.find(check => check.id === 'rust:local_message_deletion')?.variant, 'web-core');
    for (const check of selected.web) assert(rustCommand(check, 'web').includes('--offline'));
    const unix = await readFile(new URL('.github/workflows/build-unix.yml', root), 'utf8');
    assert(!unix.includes('-Task web-gates') && !unix.includes('-Task web-installer-tests'));
    assertSelectedWebHydration(unix, selected.web);
    const baseline = { commit: 'a'.repeat(40) }, pin = { runId: 1, jobId: 2, name: 'build', stepNumber: 8, runAttempt: 2 };
    const run = { repository: { full_name: 'kaigendev/Kaigen' }, id: 1, event: 'push', head_branch: 'main', head_sha: baseline.commit, status: 'completed', conclusion: 'success', run_attempt: 2 };
    const job = { id: 2, run_id: 1, name: 'build', head_sha: baseline.commit, conclusion: 'success', steps: [{ number: 8, conclusion: 'success' }] };
    assertJob(job, run, baseline, pin);
    assert.throws(() => assertJob(job, { ...run, run_attempt: 1 }, baseline, pin), /provenance/);
    console.log('CI v0.2.9.7 affected-only selection, published baseline, exact rerun attempt, and Web hydration passed');
    return;
  }
  const producer = { commit: '262af4eab2a620f240351b9f144874eadd8e0c62', tree: '828e8911ef67c85b583b8c5285c562db69b88ef5' };
  assert.deepEqual(catalog.productSource, producer, 'CI selection must bind the accepted component product source');
  const laterProduct = { ...catalog, referenceSource: { commit: 'a'.repeat(40), tree: 'b'.repeat(40) } };
  const resolveProducer = commit => { assert.equal(commit, producer.commit); return producer; };
  assert.deepEqual(unixProducerReference(laterProduct, resolveProducer), producer);
  assert.throws(() => unixProducerReference({ ...catalog, unixProducerReferenceSource: undefined }, resolveProducer), /reference is required/);
  assert.throws(() => unixProducerReference({ ...catalog, unixProducerReferenceSource: { ...producer, commit: 'HEAD' } }, resolveProducer), /reference is required/);
  assert.throws(() => unixProducerReference(catalog, () => ({ ...producer, tree: 'c'.repeat(40) })), /does not resolve exactly/);
  assert.equal(normalizeLog('a\r\nb\r\n\r\n'), 'a\nb\n');
  const logBytes = Buffer.from('\uFEFF2026-09-10T18:00:00.000Z test pq::works ... ok\r\n\u041f\u0440\u043e\u0432\u0435\u0440\u043a\u0430\r\n\r\n', 'utf8');
  const logResource = '/repos/kaigendev/Kaigen/actions/jobs/123/logs';
  const decodedLog = await github(logResource, true, async url => {
    assert.equal(url, `https://api.github.com${logResource}`);
    return new Response(logBytes, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  });
  assert.equal(decodedLog, logBytes.toString('utf8'), 'hash-bound log decoding must preserve the UTF-8 BOM and all source characters');
  assert.notEqual(decodedLog, await new Response(logBytes).text(), 'Response.text strips the BOM and changes the pinned log');
  assert.equal(normalizeLog(decodedLog), '\uFEFF2026-09-10T18:00:00.000Z test pq::works ... ok\n\u041f\u0440\u043e\u0432\u0435\u0440\u043a\u0430\n');
  assert.deepEqual(await github('/repos/kaigendev/Kaigen/actions/jobs/123', false, async () => new Response('{"id":123}')), { id: 123 });
  const zipBytes = Buffer.from([80, 75, 3, 4, 255, 0, 195, 128]);
  assert.deepEqual(await github(logResource, 'buffer', async () => new Response(zipBytes)), zipBytes, 'receipt archives must preserve binary bytes');
  await assert.rejects(() => github(logResource, true, async () => new Response('', { status: 404 })), /do not fall back to a full test run/);
  assert.deepEqual(passedTests('2026-09-10T18:00:00.000Z test pq::works ... ok\r\n'), ['pq::works']);
  assert.throws(() => rustSummary('test result: ok. 0 passed; 0 failed;', 'rust:pq::'), /no passing tests/);
  assert.throws(() => rustSummary('test other::ok ... ok\ntest result: ok. 1 passed; 0 failed;', 'rust:pq::'), /contains no passing test/);
  const source = path.resolve('fixture/source');
  assert.throws(() => assertOutsideSource(source, path.join(source, 'artifacts')), /outside/);
  assertOutsideSource(source, path.resolve('fixture/evidence'));
  const baseline = { commit: 'a'.repeat(40) }, expected = { runId: 1, jobId: 2, name: 'build', stepNumber: 7 };
  const run = { repository: { full_name: 'kaigendev/Kaigen' }, id: 1, event: 'push', head_branch: 'main', head_sha: baseline.commit, status: 'completed', conclusion: 'success', run_attempt: 1 };
  const job = { id: 2, run_id: 1, name: 'build', head_sha: baseline.commit, conclusion: 'success', steps: [{ number: 7, conclusion: 'success' }] };
  assertJob(job, run, baseline, expected);
  for (const corrupt of [{ ...run, event: 'pull_request' }, { ...run, head_sha: 'b'.repeat(40) }, { ...run, conclusion: 'failure' }, { ...run, run_attempt: 2 }, { ...run, repository: { full_name: 'other/Kaigen' } }]) assert.throws(() => assertJob(job, corrupt, baseline, expected), /provenance/);
  assert.throws(() => assertJob({ ...job, steps: [{ number: 7, conclusion: 'skipped' }] }, run, baseline, expected), /did not pass/);
  const executedPin = { ...expected, source: { ...baseline, tree: 'b'.repeat(40) }, selectionSha256: 'c'.repeat(64), artifact: { id: 3, name: 'verification', sha256: 'd'.repeat(64) } };
  const executedJob = { ...job, status: 'completed' }, partialRun = { ...run, conclusion: 'failure' };
  const artifact = { id: 3, name: 'verification', expired: false, digest: `sha256:${executedPin.artifact.sha256}`, workflow_run: { id: 1, head_sha: baseline.commit, head_branch: 'main' } };
  assertExecutedJob(executedJob, partialRun, artifact, executedPin);
  assert.throws(() => assertExecutedJob({ ...executedJob, conclusion: 'failure' }, partialRun, artifact, executedPin), /platform job did not pass/);
  assert.throws(() => assertExecutedJob(executedJob, { ...partialRun, event: 'pull_request' }, artifact, executedPin), /provenance/);
  assert.throws(() => assertExecutedJob(executedJob, partialRun, { ...artifact, expired: true }, executedPin), /artifact provenance/);
  assert.throws(() => assertExecutedJob(executedJob, partialRun, { ...artifact, digest: `sha256:${'e'.repeat(64)}` }, executedPin), /artifact provenance/);
  const executedCheck = { id: 'rust:pq::' }, executedLog = 'test pq::works ... ok\ntest result: ok. 1 passed; 0 failed;\n';
  const priorResult = { id: executedCheck.id, disposition: 'rerun', source: executedPin.source, outputSha256: 'e'.repeat(64) };
  const priorReceipt = { schemaVersion: 1, kind: 'kaigen-ci-incremental-verification', status: 'PASS', fullBaselineRerun: false, repository: 'kaigendev/Kaigen', platform: 'debian', builtFrom: executedPin.source, selectionSha256: executedPin.selectionSha256, checks: [priorResult] };
  const encodedReceipt = Buffer.from(JSON.stringify(priorReceipt)); executedPin.receiptSha256 = createHash('sha256').update(encodedReceipt).digest('hex');
  assert.deepEqual(validateExecutedReceipt(encodedReceipt, executedPin, 'debian', [executedCheck], executedLog), [{ ...priorResult, disposition: 'reused' }]);
  assert.throws(() => validateExecutedReceipt(Buffer.from(JSON.stringify({ ...priorReceipt, checks: [{ ...priorResult, outputSha256: 'f'.repeat(64) }] })), executedPin, 'debian', [executedCheck], executedLog), /receipt hash changed/);
  assert.throws(() => validateExecutedReceipt(encodedReceipt, { ...executedPin, source: { ...executedPin.source, tree: 'f'.repeat(40) } }, 'debian', [executedCheck], executedLog), /identity changed/);
  assert.throws(() => validateExecutedReceipt(encodedReceipt, executedPin, 'debian', [{ id: 'rust:other::' }], executedLog), /lacks the original/);
  const actions = Object.fromEntries(['windows', 'debian', 'macos', 'web'].map(platform => [platform, selectChecks(catalog, platform)]));
  assert.equal(catalog.version, JSON.parse(await readFile(new URL('package.json', root), 'utf8')).version);
  const previousCatalog = JSON.parse(execFileSync('git', ['-c', `safe.directory=${fileURLToPath(root).replaceAll('\\', '/')}`, '-C', fileURLToPath(root), 'show', `${catalog.referenceSource.commit}:ci/verification-v0.2.9.json`], { encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024 }));
  assert.deepEqual(catalog.baseline, previousCatalog.baseline, 'release selection must preserve the original public baseline provenance');
  for (const [id, inputs] of Object.entries(previousCatalog.inputSets)) assert.deepEqual(catalog.inputSets[id], inputs, 'previous immutable input definitions must remain intact');
  assert.equal(actions.windows.length, catalog.checks.length);
  assert.equal(actions.windows.length, 86);
  assert.equal(actions.windows.filter(test => test.action === 'run').length, 74);
  assert.equal(actions.windows.filter(test => test.action === 'reuse').length, 12);
  for (const platform of ['debian', 'macos']) {
    const tests = actions[platform]; assert.equal(tests.filter(test => test.action === 'run').length, 27);
    assert.equal(tests.filter(test => test.action === 'reuse').length, 5);
    assert(!tests.some(test => test.id === 'rust:webview_recovery::'), 'Windows-only recovery tests must not produce an empty Unix filter');
    assert(!tests.some(test => test.id === 'rust:qtox_history::'), 'Windows-only qTox history tests must not produce an empty Unix filter');
    assert.equal(tests.filter(test => test.executedBaseline === platform).length, 0);
    for (const name of catalog.baseline.jobs[platform].passingTests) assert(tests.some(test => name.includes(test.id.slice(5))), `uncovered ${platform} baseline test ${name}`);
    for (const test of tests.filter(test => test.action === 'run')) assert(rustCommand(test, platform).includes('--offline'));
  }
  assert.equal(actions.web.filter(test => test.id.startsWith('rust:')).length, 14);
  assert.equal(actions.web.filter(test => test.id.startsWith('webd:')).length, 6);
  assert.equal(actions.web.filter(test => test.action === 'run').length, 17);
  assert.equal(actions.web.filter(test => test.action === 'reuse').length, 3);
  assert(actions.web.some(test => test.id === 'rust:web_core::tests::web_friends_snapshot_' && test.action === 'run'));
  for (const platform of ['windows', 'debian', 'macos', 'web']) {
    const proxy = actions[platform].filter(test => test.id === 'rust:proxy_bridge_tests::');
    assert.equal(proxy.length, 1, `${platform} must execute the real delayed proxy handshake regressions exactly once`);
    assert.equal(proxy[0].action, 'run');
    assert(catalog.inputSets[proxy[0].inputSet].some(input => input.path === 'src-tauri/src/proxy_bridge_tests.rs'));
    if (platform === 'web') assert.equal(proxy[0].variant, 'web-core');
  }
  for (const id of ['native:retry-cap', 'native:offline-friend-request', 'frontend:source-hygiene']) {
    assert(actions.windows.some(test => test.id === id && test.action === 'run'), `corrective source requires fresh ${id}`);
  }
  assert(actions.web.some(test => test.id === 'webd:server::tests::' && test.action === 'run'));
  for (const name of catalog.baseline.jobs.web.passingTests) assert(actions.web.some(test => test.id.startsWith('webd:') && name.includes(test.id.slice(5))), `uncovered Web daemon baseline test ${name}`);
  for (const platform of ['windows', 'debian', 'macos']) {
    for (const id of ['rust:tox_tests::', 'rust:desktop_notifications::', 'rust:contact_event_tests::']) assert(actions[platform].some(test => test.id === id && test.action === 'run'), `${platform} must cover changed and new native modules`);
    assert.equal(actions[platform].filter(test => test.id.startsWith('rust:tox_tests::')).length, 1, 'affected tox checks share one module invocation');
  }
  assert(actions.windows.some(test => test.id === 'frontend:vite-config' && test.action === 'run'));
  assert(actions.windows.some(test => test.id === 'rust:webview_recovery::' && test.action === 'run'), 'Windows recovery coverage must remain selected');
  assert(actions.windows.some(test => test.id === 'rust:qtox_history::' && test.action === 'run'), 'Windows qTox history coverage must remain selected');
  for (const platform of ['windows', 'debian', 'macos', 'web']) assert(actions[platform].some(test => test.id === 'rust:pq::v2::history_notice_defaults_for_old_peer_and_only_completed_close_rearms_it' && test.action === 'run'), `${platform} must cover the PQ history notice outside the tests submodule`);
  for (const platform of ['windows', 'web']) for (const id of ['rust:web_core::tests::web_runtime_attaches_profile_durability_before_initial_profile_checkpoint', 'rust:web_core::tests::web_outgoing_progress_preserves_cancel_until_explicit_retry']) {
    assert(actions[platform].some(test => test.id === id && test.variant === 'web-core' && test.action === 'run'), `${platform} must cover the qualified durability and outgoing-cancel consumer`);
  }
  assert.match(await readFile(new URL('src-tauri/src/webview_recovery.rs', root), 'utf8'), /#\[cfg\(all\(test, target_os = "windows"\)\)\]\s*mod tests/u);
  const outgoingProgress = 'rust:web_core::tests::native_delivery_commit_regressions::web_outgoing_file_progress_invalidates_contact_snapshots_before_completion';
  for (const platform of ['windows', 'web']) assert(actions[platform].some(test => test.id === outgoingProgress && test.action === 'run' && test.variant === 'web-core'), `${platform} must select the qualified outgoing-progress regression`);
  for (const test of actions.web.filter(test => test.id.startsWith('rust:'))) assert.deepEqual(rustCommand(test, 'web').slice(5, 8), ['--no-default-features', '--features', 'web-core']);
  const resumeRegression = 'web_core::tests::web_file_bridge_incoming_storage_resume_releases_profile';
  assert((await readFile(new URL('src-tauri/src/web_core.rs', root), 'utf8')).includes(`fn ${resumeRegression.split('::').at(-1)}(`));
  for (const platform of ['windows', 'web']) assert(actions[platform].some(test => test.action === 'run' && test.variant === 'web-core' && resumeRegression.includes(test.id.slice(5))), `${platform} must select the incoming-resume regression`);
  const progressRegression = 'rust:web_core::tests::native_delivery_commit_regressions::web_incoming_file_progress_invalidates_only_changed_snapshots';
  for (const platform of ['windows', 'web']) assert(actions[platform].some(test => test.id === progressRegression && test.action === 'run' && test.variant === 'web-core'), `${platform} must select the exact incoming-progress regression`);
  assert.equal(actions.windows.find(test => test.id === 'frontend:chat-geometry-runtime')?.variant, 'menus-only');
  assert.equal(actions.windows.find(test => test.id === 'frontend:chat-enhancements')?.action, 'run');
  assert.equal(actions.windows.find(test => test.id === 'frontend:status-message')?.action, 'run');
  assert.throws(() => rustCommand({ id: 'rust:all', action: 'run' }, 'debian'), /full baseline/);
  assert.throws(() => rustCommand({ id: 'rust:pq;other', action: 'run' }, 'debian'), /invalid Rust filter/);
  assert.throws(() => rustCommand({ id: 'rust:pq::', action: 'reuse' }, 'debian'), /unapproved/);
  const check = { id: 'rust:pq::', action: 'run' }, result = { id: check.id, disposition: 'rerun', outputSha256: 'a'.repeat(64) };
  assertComplete([check], [result]);
  assert.throws(() => assertComplete([check], []), /incomplete/);
  assert.throws(() => assertComplete([check], [result, result]), /duplicate/);
  assert.throws(() => assertComplete([check], [{ ...result, disposition: 'reused' }]), /disposition/);
  const output = 'test pq::works ... ok\ntest result: ok. 1 passed; 0 failed;\n';
  const currentSource = { commit: 'c'.repeat(40), tree: 'd'.repeat(40) };
  const current = { ...result, source: currentSource, exitCode: 0, command: { program: 'cargo', args: rustCommand(check, 'debian') }, startedAt: '2026-09-11T00:00:00Z', completedAt: '2026-09-11T00:00:01Z', outputSha256: createHash('sha256').update(output).digest('hex') };
  validateRerunResult(current, check, 'debian', output, currentSource);
  assert.throws(() => validateRerunResult({ ...current, exitCode: 1 }, check, 'debian', output, currentSource), /exit code/);
  assert.throws(() => validateRerunResult({ ...current, command: { program: 'cargo', args: ['test'] } }, check, 'debian', output, currentSource), /command changed/);
  const zero = 'test result: ok. 0 passed; 0 failed;';
  assert.throws(() => validateRerunResult({ ...current, outputSha256: createHash('sha256').update(zero).digest('hex') }, check, 'debian', zero, currentSource), /no passing tests/);
  const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), 'kaigen-ci-mode-regression-')));
  try {
    const git = args => execFileSync('git', ['-c', 'core.autocrlf=false', '-c', `safe.directory=${temporary.replaceAll('\\', '/')}`, '-C', temporary, ...args], { encoding: 'utf8', windowsHide: true });
    git(['init', '--quiet']); git(['config', 'core.filemode', 'false']);
    await writeFile(path.join(temporary, 'producer.sh'), 'echo fixture\n'); git(['add', 'producer.sh']);
    git(['-c', 'user.name=Kaigen CI fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture']);
    assertCleanTree(git(['status', '--porcelain']).trim());
    git(['update-index', '--chmod=+x', 'producer.sh']);
    assert.match(git(['diff', '--cached', '--raw']), /:100644 100755/u);
    assert.throws(() => assertCleanTree(git(['status', '--porcelain']).trim()), /file modes/);
  } finally {
    assert.equal(path.dirname(temporary), await realpath(os.tmpdir()));
    assert(path.basename(temporary).startsWith('kaigen-ci-mode-regression-'));
    await rm(temporary, { recursive: true, force: true });
  }
  const before = '"$project_root/scripts/prepare-unix-dependencies.sh" linux\ncargo test --locked --manifest-path src-tauri/Cargo.toml\ncompile-unchanged\n';
  assert.equal(derivedUnixProducer(before, 'debian'), `bash "$project_root/scripts/prepare-unix-dependencies.sh" linux\n${unixTestBlock('debian')}\ncompile-unchanged\n`);
  const acceptedComponentSource = '262af4eab2a620f240351b9f144874eadd8e0c62';
  const currentGtkPluginPin = /^  "linuxdeploy-plugin-gtk\.sh\|\$gtk_plugin_sha256\|\$gtk_plugin_size\|GTK plugin\|https:\/\/raw\.githubusercontent\.com\/tauri-apps\/tauri\/tauri-bundler-v2\.10\.0\/crates\/tauri-bundler\/src\/bundle\/linux\/appimage\/linuxdeploy-plugin-gtk\.sh\|none"$/gmu;
  for (const [filename, platform] of [['scripts/build-appimage.sh', 'debian'], ['scripts/build-macos.sh', 'macos']]) {
    const producerBytes = execFileSync('git', ['-c', `safe.directory=${fileURLToPath(root).replaceAll('\\', '/')}`, '-C', fileURLToPath(root), 'show', `${producer.commit}:${filename}`], { encoding: 'utf8', windowsHide: true }).replaceAll('\r\n', '\n');
    const currentBytes = (await readFile(new URL(filename, root), 'utf8')).replaceAll('\r\n', '\n');
    const componentBytes = execFileSync('git', ['-c', `safe.directory=${fileURLToPath(root).replaceAll('\\', '/')}`, '-C', fileURLToPath(root), 'show', `${acceptedComponentSource}:${filename}`], { encoding: 'utf8', windowsHide: true }).replaceAll('\r\n', '\n');
    assert.equal(producerBytes, componentBytes, `${platform} producer reference differs from the accepted component source`);
    assert.equal(currentBytes, componentBytes, `${platform} producer changed outside the accepted component source`);
    assert(currentBytes.includes(unixTestBlock(platform)), `${platform} producer lost the selected CI test block`);
    assert(currentBytes.includes(`bash "$project_root/scripts/prepare-unix-dependencies.sh" ${platform === 'debian' ? 'linux' : 'macos'}`), `${platform} producer lost its bash launcher`);
    if (platform === 'debian') {
      assert.equal([...currentBytes.matchAll(currentGtkPluginPin)].length, 1, 'Current Debian GTK plugin has no exact pinned source');
      const changedGtkPlugin = currentBytes.replace('/tauri-bundler-v2.10.0/crates/tauri-bundler/src/bundle/linux/appimage/linuxdeploy-plugin-gtk.sh', '/tauri-bundler-v2.10.1/crates/tauri-bundler/src/bundle/linux/appimage/linuxdeploy-plugin-gtk.sh');
      assert.notEqual(changedGtkPlugin, currentBytes, 'Current Debian GTK plugin source was not found');
      assert.equal([...changedGtkPlugin.matchAll(currentGtkPluginPin)].length, 0, 'Changed Debian GTK plugin source was accepted');
    }
    assert.notEqual(derivedUnixProducer(currentBytes, platform), currentBytes, 'an already-derived product reference must not be used as the original producer');
  }
  const windows = await readFile(new URL('.github/workflows/build-windows.yml', root), 'utf8'), unix = await readFile(new URL('.github/workflows/build-unix.yml', root), 'utf8');
  assert(windows.includes('-VerificationPlanPath "%KAIGEN_WINDOWS_VERIFICATION_PLAN%"') && windows.includes('-VerificationPlanSha256 "%KAIGEN_WINDOWS_VERIFICATION_PLAN_SHA256%"'));
  assert.equal((`${windows}\n${unix}`.match(/fetch-depth: 0/gu) || []).length, 4);
  assert.equal((`${windows}\n${unix}`.match(/actions: read/gu) || []).length, 4);
  assert.equal((`${windows}\n${unix}`.match(/name: Verify public incremental baseline and prepare exact selection/gu) || []).length, 4);
  assert(!unix.includes('cargo test --locked --manifest-path web/kaigen-webd/Cargo.toml'));
  assert(!unix.includes('chmod +x scripts/') && unix.includes('bash scripts/build-appimage.sh') && unix.includes('bash scripts/build-macos.sh') && unix.includes('bash scripts/prepare-unix-dependencies.sh linux'));
  assertSelectedWebHydration(unix, actions.web);
  const webJob = '\n  web-debian13-nginx:\n' + unix.split(/\n  web-debian13-nginx:\r?\n/u)[1];
  const missingShared = webJob.replace(/^\s*cargo fetch --locked --manifest-path src-tauri\/Cargo\.toml\r?\n/mu, '');
  assert.throws(() => assertSelectedWebHydration(missingShared, actions.web), /lacks preceding locked hydration/);
  assert.throws(() => assertSelectedWebHydration(missingShared + '\n          cargo fetch --locked --manifest-path src-tauri/Cargo.toml\n', actions.web), /lacks preceding locked hydration/);
  assert.throws(() => assertSelectedWebHydration(webJob.replace('cargo fetch --locked --manifest-path src-tauri/Cargo.toml', 'cargo fetch --manifest-path src-tauri/Cargo.toml'), actions.web), /lacks preceding locked hydration/);
  for (const platform of Object.keys(actions)) assert(`${windows}\n${unix}`.includes(`path: artifacts/ci-verification-${platform}.json`));
  for (const inputs of Object.values(catalog.inputSets)) for (const input of inputs) assert(input.kind === 'git' && !/^[A-Za-z]:|^\/|\\/u.test(input.path));
  assert(!/C:|D:|\/home\/|context\.local|baseline-logs/u.test(JSON.stringify(catalog)), 'public catalog must not contain local data paths');
  console.log('CI incremental selection: provenance, portability, nonempty filters, complete coverage and fail-closed regressions passed');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runCiVerificationTests();
