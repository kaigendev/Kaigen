import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const VISIBILITY_WORKFLOW = '.github/workflows/verify-release-0298-visibility.yml';
export const VISIBILITY_JOB = 'Existing Kaigen production visibility regression';
const SHA = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const identity = value => hash(JSON.stringify(value));
const fixedInputs = new Set(['package.json', 'package-lock.json', '.gitattributes', '.npmrc', '.nvmrc', '.node-version',
  'scripts/test-chat-geometry-runtime.mjs', 'scripts/release-visibility-evidence.mjs', VISIBILITY_WORKFLOW]);
const requiredInputs = ['package.json', 'package-lock.json', 'src/App.tsx', 'src/RootApp.tsx',
  'scripts/test-chat-geometry-runtime.mjs', 'scripts/release-visibility-evidence.mjs', VISIBILITY_WORKFLOW,
  'scripts/fixtures/chat-geometry-runtime/main.ts', 'scripts/fixtures/chat-geometry-runtime/app-entry.tsx',
  'scripts/fixtures/chat-geometry-runtime/app-message-visibility-scenario.ts',
  'scripts/fixtures/chat-geometry-runtime/app-message-visibility-edges.ts'];

export function gitAt(root, args, { encoding = 'utf8' } = {}) {
  const options = { cwd: root, encoding, windowsHide: true };
  try { return execFileSync('git', ['-C', root, ...args], options); }
  catch (error) {
    if (!String(error.stderr).includes('detected dubious ownership in repository')) throw error;
    return execFileSync('git', ['-c', 'safe.directory=' + root, '-C', root, ...args], options);
  }
}

export function isVisibilityInput(name) {
  return fixedInputs.has(name) || /^(?:src|public|scripts\/fixtures\/chat-geometry-runtime)\//.test(name)
    || /^tsconfig(?:\.[^/]+)?\.json$/.test(name);
}

export function visibilityInputs(root = ROOT, revision = 'HEAD', { checkWorkingTree = false } = {}) {
  assert.ok(revision === 'HEAD' || COMMIT.test(revision), 'exact visibility source required');
  const entries = gitAt(root, ['ls-tree', '-rz', '--full-tree', revision]).split('\0').filter(Boolean)
    .map(line => { const match = /^(\d+) blob ([a-f0-9]{40})\t(.+)$/.exec(line);
      return match ? { path: match[3], mode: match[1], gitBlob: match[2] } : { path: line.split('\t')[1], mode: 'unsupported' }; })
    .filter(item => isVisibilityInput(item.path)).sort((a, b) => a.path.localeCompare(b.path, 'en'));
  for (const name of requiredInputs) assert.ok(entries.some(item => item.path === name), 'missing visibility input: ' + name);
  for (const entry of entries) assert.ok(['100644', '100755'].includes(entry.mode), 'unsupported visibility input: ' + entry.path);
  if (checkWorkingTree) {
    // Use Git's path inventory instead of parsing quoted porcelain names.
    const changed = [...gitAt(root, ['diff', '--name-only', '-z', revision]).split('\0'),
      ...gitAt(root, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0'),
      ...gitAt(root, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--',
        'src', 'public', 'scripts/fixtures/chat-geometry-runtime', ...fixedInputs, 'tsconfig*.json']).split('\0')];
    assert.ok(!changed.filter(Boolean).some(isVisibilityInput), 'changed or untracked visibility input');
  }
  return { files: entries, sha256: identity(entries) };
}

export function assertVisibilityRun(run, source) {
  assert.match(source, COMMIT);
  assert.equal(run.repository?.full_name, 'kaigendev/Kaigen');
  assert.equal(run.head_repository?.full_name, 'kaigendev/Kaigen');
  assert.equal(run.path, VISIBILITY_WORKFLOW); assert.equal(run.event, 'workflow_dispatch');
  assert.equal(run.head_branch, 'main'); assert.equal(run.head_sha, source);
  assert.equal(run.status, 'completed'); assert.equal(run.conclusion, 'success');
  assert.ok(Number.isSafeInteger(run.id) && run.id > 0);
  assert.ok(Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0);
}

export function assertVisibilityEnvironment(env) {
  assert.equal(env?.runnerOs, 'Windows'); assert.equal(env.runnerArch, 'X64');
  assert.ok(env.imageOS && env.imageVersion); assert.equal(env.ci, 'true'); assert.equal(env.nodeEnv, 'production');
  assert.equal(env.nodeOptions, ''); assert.equal(env.npmUserConfig, 'isolated-empty');
  assert.match(env.node?.sha256 ?? '', SHA); assert.match(env.browser?.sha256 ?? '', SHA);
  assert.equal(env.browser?.executable, 'chrome.exe'); assert.ok(env.node?.version);
}

export function assertVisibilityReceipt(receipt, run, inputs, expectedEnvironmentSha256) {
  assert.equal(receipt?.kind, 'kaigen-release-visibility'); assert.equal(receipt.status, 'PASS');
  assert.equal(receipt.repository, 'kaigendev/Kaigen'); assert.equal(receipt.source?.commit, run.head_sha);
  assert.equal(receipt.publicationEvidence?.runId, run.id); assert.equal(receipt.publicationEvidence?.attempt, run.run_attempt);
  assert.equal(receipt.inputs?.sha256, inputs.sha256); assert.deepEqual(receipt.inputs?.files, inputs.files);
  assert.match(expectedEnvironmentSha256 ?? '', SHA, 'reviewed visibility environment required');
  assert.equal(receipt.environmentSha256, expectedEnvironmentSha256);
  assert.equal(identity(receipt.environment), expectedEnvironmentSha256, 'visibility environment changed');
  assertVisibilityEnvironment(receipt.environment);
  assert.equal(receipt.results?.length, 2);
  for (const [name, assertions] of [['app-message-visibility-scenario', 17], ['app-message-visibility-edges', 23]]) {
    const result = receipt.results.find(item => item.name === name);
    assert.equal(result?.assertions, assertions); assert.match(result?.resultSha256 ?? '', SHA);
    assert.match(result?.runtimeSha256 ?? '', SHA);
  }
}

async function environment() {
  const browser = process.env.KAIGEN_UI_TEST_BROWSER;
  assert.ok(browser && path.isAbsolute(browser), 'explicit visibility browser required');
  const userConfig = process.env.NPM_CONFIG_USERCONFIG;
  assert.ok(userConfig && (await readFile(userConfig)).length === 0, 'isolated empty npm user config required');
  return { runnerOs: process.env.RUNNER_OS, runnerArch: process.env.RUNNER_ARCH,
    imageOS: process.env.ImageOS, imageVersion: process.env.ImageVersion, ci: process.env.CI,
    nodeEnv: 'production', nodeOptions: process.env.NODE_OPTIONS ?? '', npmUserConfig: 'isolated-empty',
    node: { version: process.version, sha256: hash(await readFile(process.execPath)) },
    browser: { executable: path.basename(browser).toLowerCase(), sha256: hash(await readFile(browser)) } };
}

async function capture(mode, directory) {
  assert.ok(['prepare', 'complete'].includes(mode)); assert.ok(directory && path.isAbsolute(directory));
  assert.equal(process.env.GITHUB_ACTIONS, 'true'); assert.equal(process.env.GITHUB_REPOSITORY, 'kaigendev/Kaigen');
  assert.equal(process.env.GITHUB_WORKFLOW_REF, 'kaigendev/Kaigen/' + VISIBILITY_WORKFLOW + '@refs/heads/main');
  assert.equal(process.env.GITHUB_EVENT_NAME, 'workflow_dispatch'); assert.equal(process.env.GITHUB_REF, 'refs/heads/main');
  const source = gitAt(ROOT, ['rev-parse', 'HEAD']).trim(); assert.equal(source, process.env.GITHUB_SHA);
  assert.equal(source, process.env.EXPECTED_SHA); assert.match(source, COMMIT);
  assert.equal(source, process.env.GITHUB_WORKFLOW_SHA, 'visibility controller source mismatch');
  const inputs = visibilityInputs(ROOT, 'HEAD', { checkWorkingTree: true });
  const env = await environment(), environmentSha256 = identity(env);
  assertVisibilityEnvironment(env);
  const run = { id: Number(process.env.GITHUB_RUN_ID), run_attempt: Number(process.env.GITHUB_RUN_ATTEMPT), head_sha: source };
  await mkdir(directory, { recursive: true });
  const preparedPath = path.join(directory, 'visibility-inputs.json');
  if (mode === 'prepare') {
    await writeFile(preparedPath, JSON.stringify({ source, inputs, environment: env, environmentSha256, run }, null, 2) + '\n', { flag: 'wx' });
    return;
  }
  const prepared = JSON.parse(await readFile(preparedPath));
  assert.deepEqual(prepared, { source, inputs, environment: env, environmentSha256, run }, 'visibility inputs/environment changed during verification');
  const results = [];
  for (const [name, assertions] of [['app-message-visibility-scenario', 17], ['app-message-visibility-edges', 23]]) {
    const resultBytes = await readFile(path.join(directory, name + '.json'));
    const runtimeBytes = await readFile(path.join(directory, name + '-production-runtime.json'));
    const result = JSON.parse(resultBytes), runtime = JSON.parse(runtimeBytes);
    assert.equal(result.ok, true); assert.equal(result.assertions, assertions);
    assert.equal(runtime.nodeEnv, 'production'); assert.equal(runtime.isProduction, true); assert.equal(runtime.privateCache, true);
    assert.ok(runtime.runtimeSources.length > 0 && runtime.runtimeSources.every(item => !item.debugJsx));
    results.push({ name, assertions, resultSha256: hash(resultBytes), runtimeSha256: hash(runtimeBytes) });
  }
  const receipt = { kind: 'kaigen-release-visibility', schema: 1, status: 'PASS', repository: 'kaigendev/Kaigen',
    source: { commit: source }, publicationEvidence: { runId: run.id, attempt: run.run_attempt },
    inputs, environment: env, environmentSha256, results, completedAt: new Date().toISOString() };
  assertVisibilityReceipt(receipt, run, inputs, environmentSha256);
  await writeFile(path.join(directory, 'visibility-receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  console.log('VISIBILITY_EVIDENCE_PASS environment_sha256=' + environmentSha256);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await capture(...process.argv.slice(2));
}
