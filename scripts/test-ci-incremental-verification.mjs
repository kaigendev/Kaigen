import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertComplete, assertJob, assertOutsideSource, normalizeLog, passedTests, rustCommand, selectChecks, unixTestBlock } from './ci-incremental-verification.mjs';
import { rustSummary } from './incremental-windows-verification.mjs';

export async function runCiVerificationTests() {
  const root = new URL('../', import.meta.url), catalog = JSON.parse(await readFile(new URL('ci/verification-v0.2.8.json', root), 'utf8'));
  assert.equal(normalizeLog('a\r\nb\r\n\r\n'), 'a\nb\n');
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
  const actions = Object.fromEntries(['windows', 'debian', 'macos', 'web'].map(platform => [platform, selectChecks(catalog, platform)]));
  assert.equal(actions.windows.length, catalog.checks.length);
  for (const platform of ['debian', 'macos']) {
    const tests = actions[platform]; assert.equal(tests.filter(test => test.action === 'run').length, 6);
    for (const name of catalog.baseline.jobs[platform].passingTests) assert(tests.some(test => name.includes(test.id.slice(5))), `uncovered ${platform} baseline test ${name}`);
    for (const test of tests.filter(test => test.action === 'run')) assert(rustCommand(test, platform).includes('--offline'));
  }
  assert.equal(actions.web.filter(test => test.id.startsWith('rust:')).length, 4);
  assert.equal(actions.web.filter(test => test.id.startsWith('webd:')).length, 59);
  assert.equal(actions.web.filter(test => test.action === 'run').length, 9);
  for (const test of actions.web.filter(test => test.id.startsWith('rust:'))) assert.deepEqual(rustCommand(test, 'web').slice(5, 8), ['--no-default-features', '--features', 'web-core']);
  assert.throws(() => rustCommand({ id: 'rust:all', action: 'run' }, 'debian'), /full baseline/);
  assert.throws(() => rustCommand({ id: 'rust:pq;other', action: 'run' }, 'debian'), /invalid Rust filter/);
  assert.throws(() => rustCommand({ id: 'rust:pq::', action: 'reuse' }, 'debian'), /unapproved/);
  const check = { id: 'rust:pq::', action: 'run' }, result = { id: check.id, disposition: 'rerun', outputSha256: 'a'.repeat(64) };
  assertComplete([check], [result]);
  assert.throws(() => assertComplete([check], []), /incomplete/);
  assert.throws(() => assertComplete([check], [result, result]), /duplicate/);
  assert.throws(() => assertComplete([check], [{ ...result, disposition: 'reused' }]), /disposition/);
  for (const [filename, platform] of [['scripts/build-appimage.sh', 'debian'], ['scripts/build-macos.sh', 'macos']]) assert((await readFile(new URL(filename, root), 'utf8')).replaceAll('\r\n', '\n').includes(unixTestBlock(platform)));
  const windows = await readFile(new URL('.github/workflows/build-windows.yml', root), 'utf8'), unix = await readFile(new URL('.github/workflows/build-unix.yml', root), 'utf8');
  assert(windows.includes('-VerificationPlanPath "%KAIGEN_WINDOWS_VERIFICATION_PLAN%"') && windows.includes('-VerificationPlanSha256 "%KAIGEN_WINDOWS_VERIFICATION_PLAN_SHA256%"'));
  assert.equal((`${windows}\n${unix}`.match(/fetch-depth: 0/gu) || []).length, 4);
  assert.equal((`${windows}\n${unix}`.match(/actions: read/gu) || []).length, 4);
  assert.equal((`${windows}\n${unix}`.match(/name: Verify public incremental baseline and prepare exact selection/gu) || []).length, 4);
  assert(!unix.includes('cargo test --locked --manifest-path web/kaigen-webd/Cargo.toml'));
  for (const platform of Object.keys(actions)) assert(`${windows}\n${unix}`.includes(`path: artifacts/ci-verification-${platform}.json`));
  for (const inputs of Object.values(catalog.inputSets)) for (const input of inputs) assert(input.kind === 'git' && !/^[A-Za-z]:|^\/|\\/u.test(input.path));
  assert(!/C:|D:|\/home\/|context\.local|baseline-logs/u.test(JSON.stringify(catalog)), 'public catalog must not contain local data paths');
  console.log('CI incremental selection: provenance, portability, nonempty filters, complete coverage and fail-closed regressions passed');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runCiVerificationTests();
