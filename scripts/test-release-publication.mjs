import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT, gitAt, visibilityInputs, assertVisibilityRun, assertVisibilityEnvironment, assertVisibilityReceipt, VISIBILITY_WORKFLOW } from './release-visibility-evidence.mjs';
import { assertPublicationTrigger, githubDiagnostic, githubFailure, recordedOperation, api as releaseApi } from './publish-actions-release.mjs';
import { api as siteApi } from '../site-release/0.2.9.8/publish-site.mjs';

const artifacts = path.resolve(ROOT, '../outputs/workflow-improvement-20261007');
await mkdir(artifacts, { recursive: true });
const fixture = await mkdtemp(path.join(artifacts, 'publication-offline-'));
const emptyConfig = path.join(fixture, 'empty-gitconfig'), emptyHooks = path.join(fixture, 'empty-hooks');
await writeFile(emptyConfig, ''); await mkdir(emptyHooks);
for (const name of Object.keys(process.env)) if (/^GIT_/i.test(name)) delete process.env[name];
Object.assign(process.env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_SYSTEM: emptyConfig,
  GIT_CONFIG_COUNT: '0', GIT_TEMPLATE_DIR: emptyHooks, GIT_AUTHOR_NAME: 'Offline fixture', GIT_AUTHOR_EMAIL: 'offline@example.invalid',
  GIT_COMMITTER_NAME: 'Offline fixture', GIT_COMMITTER_EMAIL: 'offline@example.invalid' });
const source = path.join(fixture, 'source with spaces'); await mkdir(source);
const h = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
let cases = 0; const passed = name => { cases++; console.log('PASS ' + name); };
const write = async (name, bytes) => { const file = path.join(source, name); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, bytes); };
const commit = message => { gitAt(source, ['add', '--all']); gitAt(source, ['-c', 'core.hooksPath=' + emptyHooks, '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', message]); return gitAt(source, ['rev-parse', 'HEAD']).trim(); };
gitAt(source, ['init', '--quiet']);
for (const name of ['package.json', 'package-lock.json', 'src/App.tsx', 'src/RootApp.tsx',
  'scripts/test-chat-geometry-runtime.mjs', 'scripts/release-visibility-evidence.mjs', VISIBILITY_WORKFLOW,
  'scripts/fixtures/chat-geometry-runtime/main.ts', 'scripts/fixtures/chat-geometry-runtime/app-entry.tsx',
  'scripts/fixtures/chat-geometry-runtime/app-message-visibility-scenario.ts',
  'scripts/fixtures/chat-geometry-runtime/app-message-visibility-edges.ts']) await write(name, 'saved offline source\n');
await write('.gitattributes', '* text eol=lf\n');
const original = commit('saved visibility inputs');
const initial = visibilityInputs(source, original);
const previousCwd = process.cwd(); process.chdir(fixture);
try { assert.equal(gitAt(source, ['rev-parse', 'HEAD']).trim(), original); } finally { process.chdir(previousCwd); }
passed('Git exact owner from a different cwd with spaces');
let nativeError; try { gitAt(source, ['rev-parse', '--verify', 'missing-ref'], { encoding: 'utf8' }); } catch (error) { nativeError = error; }
assert.ok(nativeError); assert.notEqual(nativeError.status, 0); passed('native Git failure retains nonzero exit status');
await write('local-service-notes.md', 'local only\n'); const docs = commit('documentation only');
assert.notEqual(docs, original); assert.deepEqual(visibilityInputs(source, docs), initial); passed('overall commit change alone does not invalidate visibility inputs');
await write('.gitignore', 'scripts/fixtures/chat-geometry-runtime/.env.production\n'); commit('ignore local environment file');
await write('scripts/fixtures/chat-geometry-runtime/.env.production', 'PUBLIC_CASE=changed\n');
assert.throws(() => visibilityInputs(source, 'HEAD', { checkWorkingTree: true }), /untracked visibility input/);
gitAt(source, ['add', '--force', 'scripts/fixtures/chat-geometry-runtime/.env.production']);
const hidden = commit('hidden Vite input'); assert.notEqual(visibilityInputs(source, hidden).sha256, initial.sha256); passed('untracked and tracked hidden fixture inputs invalidate reuse');
await write('src/App.tsx', 'changed application input\n'); const changed = commit('source changed');
assert.notEqual(visibilityInputs(source, changed).sha256, visibilityInputs(source, hidden).sha256); passed('changed product input invalidates reuse');
gitAt(source, ['rm', '--quiet', 'package-lock.json']); const missing = commit('missing required input');
assert.throws(() => visibilityInputs(source, missing), /missing visibility input/); passed('missing lock file fails before verification');

const run = { id: 42, run_attempt: 2, head_sha: original, repository: { full_name: 'kaigendev/Kaigen' }, head_repository: { full_name: 'kaigendev/Kaigen' },
  path: VISIBILITY_WORKFLOW, event: 'workflow_dispatch', head_branch: 'main', status: 'completed', conclusion: 'success' };
assertVisibilityRun(run, original);
for (const altered of [{ ...run, conclusion: 'failure' }, { ...run, head_sha: docs }, { ...run, path: '.github/workflows/untrusted.yml' },
  { ...run, head_repository: { full_name: 'other/Kaigen' } }]) assert.throws(() => assertVisibilityRun(altered, original));
passed('failed, wrong source, workflow and repository runs rejected');
const environment = { runnerOs: 'Windows', runnerArch: 'X64', imageOS: 'win25', imageVersion: 'saved-case', ci: 'true', nodeEnv: 'production',
  nodeOptions: '', npmUserConfig: 'isolated-empty', node: { version: 'v24.0.0', sha256: h('node') }, browser: { executable: 'chrome.exe', sha256: h('browser') } };
const environmentSha256 = h(environment);
assertVisibilityEnvironment(environment);
assert.throws(() => assertVisibilityEnvironment({ ...environment, imageVersion: undefined }));
assert.throws(() => assertVisibilityEnvironment({ ...environment, nodeOptions: '--import=unknown' }));
passed('missing runner environment and inherited instrumentation rejected before tests');
const receipt = { kind: 'kaigen-release-visibility', status: 'PASS', repository: 'kaigendev/Kaigen', source: { commit: original },
  publicationEvidence: { runId: run.id, attempt: run.run_attempt }, inputs: initial, environment, environmentSha256,
  results: ['app-message-visibility-scenario', 'app-message-visibility-edges'].map((name, i) => ({ name, assertions: i ? 23 : 17, resultSha256: h(name), runtimeSha256: h(name + 'runtime') })) };
assertVisibilityReceipt(receipt, run, initial, environmentSha256);
for (const altered of [undefined, { ...receipt, environment: undefined }, { ...receipt, status: 'CANCELLED' },
  { ...receipt, publicationEvidence: { runId: run.id, attempt: 1 } }, { ...receipt, inputs: visibilityInputs(source, docs), results: [] }]) {
  assert.throws(() => assertVisibilityReceipt(altered, run, initial, environmentSha256));
}
assert.throws(() => assertVisibilityReceipt(receipt, run, initial, h('different browser environment')));
assert.throws(() => assertVisibilityReceipt(receipt, run, visibilityInputs(source, hidden), environmentSha256));
passed('missing, old-attempt, cancelled, incomplete and environment/input-mismatched receipts rejected');
const event = { repository: { full_name: 'kaigendev/Kaigen' }, ref: 'refs/heads/main', inputs: { expected_sha: original, visibility_run_id: '42', visibility_environment_sha256: environmentSha256 } };
assertPublicationTrigger(event, 'workflow_dispatch', original);
for (const inputs of [{ ...event.inputs, expected_sha: docs }, { ...event.inputs, visibility_run_id: '' },
  { ...event.inputs, visibility_run_id: '99999999999999999999' }, { ...event.inputs, visibility_environment_sha256: '' }]) {
  assert.throws(() => assertPublicationTrigger({ ...event, inputs }, 'workflow_dispatch', original));
}
passed('manual publication requires exact reviewed SHA and complete receipt selection');
const response = new Response('', { status: 403, headers: { 'x-github-request-id': 'AA11:BB22' } });
const secret = 'ghp_private_fixture_token';
const diagnostic = githubDiagnostic(response, 'PATCH', 'releases/42?token=' + secret, { message: 'Resource not accessible by integration',
  documentation_url: 'https://private.example/' + secret, errors: [{ resource: secret, code: 'invalid', field: 'name' }] });
assert.equal(diagnostic.reason, 'integration_permission_denied'); assert.equal(diagnostic.requestId, 'AA11:BB22'); assert.ok(!JSON.stringify(diagnostic).includes(secret));
const invalidEnvironment = githubDiagnostic(new Response('', { status: 422 }), 'POST', 'releases', { message: 'Validation Failed', errors: [{ resource: 'WorkflowRun', code: 'invalid', field: 'environment' }] });
assert.equal(invalidEnvironment.reason, 'invalid_environment_input'); assert.notEqual(invalidEnvironment.reason, diagnostic.reason); passed('safe API diagnostics distinguish denial and invalid environment input');
assert.equal(githubDiagnostic(response, 'PATCH', 'releases/42', null).reason, 'forbidden');
assert.equal(githubDiagnostic(response, 'PATCH', 'releases/42', { errors: Array.from({ length: 25 }, () => ({ resource: 'Release', code: 'invalid', field: 'name' })) }).errors.length, 20);
const apiError = await githubFailure(new Response(JSON.stringify({ message: 'Resource not accessible by integration' }), { status: 403 }), 'POST', 'releases/42/assets');
const originalFetch = globalThis.fetch;
try {
  globalThis.fetch = async () => new Response(JSON.stringify({ message: 'Resource not accessible by integration' }), { status: 403 });
  for (const action of [() => releaseApi('actions/artifacts/1/zip', { raw: true }), () => siteApi('releases/assets/1', true)]) {
    await assert.rejects(action(), error => error.diagnostic?.reason === 'integration_permission_denied');
  }
  globalThis.fetch = async () => new Response(null, { status: 302 });
  assert.equal((await releaseApi('actions/artifacts/1/zip', { raw: true })).status, 302);
  assert.equal((await siteApi('releases/assets/1', true)).status, 302);
} finally { globalThis.fetch = originalFetch; }
passed('raw API denial preserves safe diagnostics while expected redirects remain usable');
const operations = [];
await recordedOperation(fixture, operations, 'verify-tag-reference', async () => ({ sha: original }));
await assert.rejects(recordedOperation(fixture, operations, 'upload-assets', async () => { throw apiError; }));
const saved = JSON.parse(await readFile(path.join(fixture, 'publication-operations.json')));
assert.deepEqual(saved.operations.map(item => item.status), ['PASS', 'FAILED']); assert.equal(saved.operations[1].failure.reason, 'integration_permission_denied');
assert.ok(!saved.operations.some(item => item.operation === 'publish-release')); passed('failed upload preserves exact operation and does not claim final publication');
const overall = [];
await assert.rejects(recordedOperation(fixture, overall, 'site-publication', async () => {
  await recordedOperation(fixture, overall, 'verify-tag', async () => true);
  throw apiError;
}));
const overallSaved = JSON.parse(await readFile(path.join(fixture, 'publication-operations.json')));
assert.equal(overallSaved.operations[0].status, 'FAILED');
assert.equal(overallSaved.operations[0].failure.reason, 'integration_permission_denied');
passed('overall receipt preserves API failures between named stages');
await writeFile(path.join(artifacts, 'publication-offline-results.json'), JSON.stringify({ status: 'PASS', cases, fixture,
  scope: 'offline Git, saved receipt/input mismatches, safe API/operation failures', networkCalls: 0, productTests: 0 }, null, 2) + '\n');
console.log('PUBLICATION_OFFLINE_PASS ' + cases + ' cases; no network or product verification');
