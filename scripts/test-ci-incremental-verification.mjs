import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm, mkdir, rename, lstat, symlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertCleanTree, assertComplete, assertExecutedJob, assertJob, assertOutsideSource, derivedUnixProducer, github, normalizeLog, passedTests, rustCommand, selectChecks, unixProducerReference, unixTestBlock, validateExecutedReceipt, validateRerunResult } from './ci-incremental-verification.mjs';
import { descriptor, rustSummary, validatePlan, verifyFinalReceipt } from './incremental-windows-verification.mjs';

export async function runEvidenceRelocationTests() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'kaigen-evidence-relocation-'));
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
    assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
    assert(path.basename(temporary).startsWith('kaigen-evidence-relocation-'));
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function runTestOnlyEquivalenceTests() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'kaigen-test-only-equivalence-'));
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
    const productSource = commit('disposable product');
    await writeFile(path.join(repository, 'scripts/test-app-layout.mjs'), 'corrected fixture assertion\n');
    const source = commit('disposable test-only correction');
    const baselineEvidence = await save('baseline.json', { fixture: true });
    const ids = ['native:prepared-cache', 'native:retry-cap', 'native:offline-friend-request', 'frontend:fixture', 'rust:fixture::'];
    const plan = { schemaVersion: 1, kind: 'kaigen-windows-incremental-plan', source, productSource,
      baseline: { source: productSource, evidence: [baselineEvidence] }, testOnlyPaths: ['scripts/test-app-layout.mjs'],
      changes: [{ path: 'scripts/test-app-layout.mjs', beforeBlob: git(['rev-parse', `${productSource.commit}:scripts/test-app-layout.mjs`]), beforeMode: '100644',
        afterBlob: git(['rev-parse', `${source.commit}:scripts/test-app-layout.mjs`]), afterMode: '100644',
        reason: 'Only the stale test assertion changed', checkIds: ['frontend:fixture'] }],
      checks: ids.map(id => ({ id, action: 'run', reason: 'Disposable validation fixture; commands are never executed',
        inputs: [{ id: 'package.json', kind: 'git', path: 'package.json', sha256: hash(packageBytes) }] })) };
    const validate = async (name, document) => {
      const pin = await save(name, document);
      return validatePlan({ planPath: pin.path, planSha256: pin.sha256, projectRoot: repository, referenceRoot: repository });
    };
    await validate('allowed.json', plan);
    await assert.rejects(() => validate('undeclared.json', { ...plan, testOnlyPaths: [] }), /differences exceed/);
    await assert.rejects(() => validate('arbitrary-script.json', { ...plan, testOnlyPaths: ['scripts/arbitrary.mjs'] }), /unapproved test-only/);
    await assert.rejects(() => validate('product-path.json', { ...plan, testOnlyPaths: ['src/App.tsx'] }), /unapproved test-only/);
    assert.equal(git(['status', '--porcelain']), '');
    console.log('Test-only equivalence: exact layout-test correction accepted; undeclared, arbitrary script and product paths rejected');
  } finally {
    assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
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
  await runTestOnlyEquivalenceTests();
  await runEvidenceRelocationTests();
  const root = new URL('../', import.meta.url), catalog = JSON.parse(await readFile(new URL('ci/verification-v0.2.9.json', root), 'utf8'));
  const producer = { commit: 'e01d60c20c97daa0145769c33fde9318825da8f3', tree: 'c21e24b7e2b349db682f67ba6cb26f46e8ead85a' };
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
  assert.equal(actions.windows.length, catalog.checks.length);
  for (const platform of ['debian', 'macos']) {
    const tests = actions[platform]; assert.equal(tests.filter(test => test.action === 'run').length, 6);
    assert.equal(tests.filter(test => test.executedBaseline === platform).length, 0);
    for (const name of catalog.baseline.jobs[platform].passingTests) assert(tests.some(test => name.includes(test.id.slice(5))), `uncovered ${platform} baseline test ${name}`);
    for (const test of tests.filter(test => test.action === 'run')) assert(rustCommand(test, platform).includes('--offline'));
  }
  assert.equal(actions.web.filter(test => test.id.startsWith('rust:')).length, 6);
  assert.equal(actions.web.filter(test => test.id.startsWith('webd:')).length, 60);
  assert.equal(actions.web.filter(test => test.action === 'run').length, 12);
  assert(actions.web.some(test => test.id === 'rust:web_core::tests::web_friends_snapshot_' && test.action === 'run'));
  assert(actions.web.some(test => test.id === 'webd:server::tests::friends_route_preserves_authentication_and_workspace_guards' && test.action === 'run'));
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
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'kaigen-ci-mode-regression-'));
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
    assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
    assert(path.basename(temporary).startsWith('kaigen-ci-mode-regression-'));
    await rm(temporary, { recursive: true, force: true });
  }
  const before = '"$project_root/scripts/prepare-unix-dependencies.sh" linux\ncargo test --locked --manifest-path src-tauri/Cargo.toml\ncompile-unchanged\n';
  assert.equal(derivedUnixProducer(before, 'debian'), `bash "$project_root/scripts/prepare-unix-dependencies.sh" linux\n${unixTestBlock('debian')}\ncompile-unchanged\n`);
  for (const [filename, platform] of [['scripts/build-appimage.sh', 'debian'], ['scripts/build-macos.sh', 'macos']]) {
    const producerBytes = execFileSync('git', ['-c', `safe.directory=${fileURLToPath(root).replaceAll('\\', '/')}`, '-C', fileURLToPath(root), 'show', `${producer.commit}:${filename}`], { encoding: 'utf8', windowsHide: true }).replaceAll('\r\n', '\n');
    const currentBytes = (await readFile(new URL(filename, root), 'utf8')).replaceAll('\r\n', '\n');
    assert.equal(derivedUnixProducer(producerBytes, platform), currentBytes);
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
