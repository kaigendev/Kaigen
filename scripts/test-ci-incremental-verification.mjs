import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertCleanTree, assertComplete, assertExecutedJob, assertJob, assertOutsideSource, derivedUnixProducer, github, normalizeLog, passedTests, rustCommand, selectChecks, unixProducerReference, unixTestBlock, validateExecutedReceipt, validateRerunResult } from './ci-incremental-verification.mjs';
import { rustSummary } from './incremental-windows-verification.mjs';

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
