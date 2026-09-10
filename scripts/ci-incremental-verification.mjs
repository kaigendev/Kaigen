import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, lstat, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { descriptor, inputBytes, rustSummary, trackedChanges, validatePlan, verifyFinalReceipt } from './incremental-windows-verification.mjs';

const CI_PATHS = ['.github/workflows/build-windows.yml', '.github/workflows/build-unix.yml', 'scripts/Invoke-KaigenAutomation.ps1', 'scripts/build-appimage.sh', 'scripts/build-macos.sh', 'scripts/ci-incremental-verification.mjs', 'scripts/test-ci-incremental-verification.mjs', 'scripts/test-build-pipeline.mjs', 'ci/verification-v0.2.8.json'];
const PLATFORMS = ['windows', 'debian', 'macos', 'web'];
const HASH = /^[a-f0-9]{64}$/u;
const REPO = 'kaigendev/Kaigen';
const CARGO_TEST = 'cargo test --locked --manifest-path src-tauri/Cargo.toml';
const UNIX_TEST = `if [[ "\${GITHUB_ACTIONS:-}" == "true" ]]; then\n  node scripts/ci-incremental-verification.mjs run-tests --platform PLATFORM --evidence-root "\${KAIGEN_CI_EVIDENCE_ROOT:?CI incremental plan is required}"\nelse\n  ${CARGO_TEST}\nfi`;
const assert = (condition, message) => { if (!condition) throw new Error(`CI incremental verification: ${message}`); };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const git = (root, args) => execFileSync('git', ['-c', `safe.directory=${root.replaceAll('\\', '/')}`, '-C', root, ...args], { maxBuffer: 32 * 1024 * 1024, windowsHide: true });
const gitText = (root, args) => git(root, args).toString('utf8').trim();
const identity = (root, commit = 'HEAD') => ({ commit: gitText(root, ['rev-parse', `${commit}^{commit}`]), tree: gitText(root, ['rev-parse', `${commit}^{tree}`]) });
const json = async filename => JSON.parse(await readFile(filename, 'utf8'));
const save = async (filename, value) => { await mkdir(path.dirname(filename), { recursive: true }); await writeFile(filename, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' }); };
const statePath = (directory, platform) => path.join(directory, `ci-${platform}-state.json`);
const safeId = id => id.replace(/[^a-zA-Z0-9_-]/gu, '_');

export function normalizeLog(value) { return value.replaceAll('\r\n', '\n').replace(/\n*$/u, '\n'); }
export function testOutput(value) { return normalizeLog(value).replace(/\u001b\[[0-9;]*m/gu, '').replace(/^\d{4}-\d{2}-\d{2}T[0-9:.]+Z /gmu, ''); }
export function passedTests(value) { return [...testOutput(value).matchAll(/^test ([\w:]+) \.\.\. ok[ \t]*$/gmu)].map(match => match[1]); }
export function unixTestBlock(platform) { assert(['debian', 'macos'].includes(platform), 'invalid Unix platform'); return UNIX_TEST.replace('PLATFORM', platform); }
export function assertCleanTree(status) { assert(status === '', 'CI source checkout must be clean, including file modes'); }
export function derivedUnixProducer(before, platform) {
  const call = `"$project_root/scripts/prepare-unix-dependencies.sh" ${platform === 'debian' ? 'linux' : 'macos'}`;
  assert(before.split(CARGO_TEST).length === 2 && before.split(call).length === 2, 'ambiguous Unix producer template');
  return before.replace(CARGO_TEST, unixTestBlock(platform)).replace(call, `bash ${call}`);
}
export function unixProducerReference(catalog, resolveIdentity) {
  const reference = catalog.unixProducerReferenceSource;
  assert(reference && /^[a-f0-9]{40}$/u.test(reference.commit) && /^[a-f0-9]{40}$/u.test(reference.tree), 'exact Unix producer reference is required');
  assert(same(resolveIdentity(reference.commit), reference), 'Unix producer reference does not resolve exactly');
  return reference;
}
export function assertOutsideSource(root, directory) {
  const relative = path.relative(root, directory);
  assert(relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative), 'runner evidence must be outside the source/archive tree');
}
export function assertJob(metadata, run, baseline, expected) {
  assert(run.repository?.full_name === REPO && run.event === 'push' && run.head_branch === 'main' && run.head_sha === baseline.commit && run.status === 'completed' && run.conclusion === 'success' && run.id === expected.runId && run.run_attempt === 1, 'baseline run provenance is not the pinned successful main push');
  assert(metadata.id === expected.jobId && metadata.run_id === expected.runId && metadata.name === expected.name && metadata.head_sha === baseline.commit && metadata.conclusion === 'success', 'baseline job identity or conclusion changed');
  assert(metadata.steps?.find(step => step.number === expected.stepNumber)?.conclusion === 'success', 'baseline build/test step did not pass');
}
export function selectChecks(catalog, platform) {
  assert(PLATFORMS.includes(platform), 'unknown platform');
  if (platform === 'windows') return catalog.checks;
  if (platform === 'web') {
    const core = ['rust:pq::v2::tests::', 'rust:pq_delivery_tests::', 'rust:pq::engine::tests::', 'rust:web_core::tests::web_file_bridge_'];
    return [
      ...catalog.checks.filter(check => core.includes(check.id)).map(check => ({ ...check, action: 'run', variant: 'web-core' })),
      ...catalog.baseline.jobs.web.passingTests.map(name => ({ id: `webd:${name}`, action: catalog.webd.rerun.includes(name) ? 'run' : 'reuse', inputSet: catalog.webd.inputSet, baselineInputSet: catalog.webd.inputSet, reason: catalog.webd.reason })),
    ];
  }
  return catalog.checks.filter(check => check.id.startsWith('rust:') && check.variant !== 'web-core' && (check.action === 'run' || catalog.baseline.jobs[platform].passingTests.some(name => name.includes(check.id.slice(5)))));
}
async function file(filename) { const stat = await lstat(filename); assert(stat.isFile() && !stat.isSymbolicLink(), 'expected ordinary evidence file'); return readFile(filename); }
export async function github(resource, bytes = false, fetchResponse = fetch) {
  assert(resource.startsWith(`/repos/${REPO}/actions/`) && !resource.includes('..'), 'unapproved GitHub evidence endpoint');
  const response = await fetchResponse(`https://api.github.com${resource}`, { headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) }, signal: AbortSignal.timeout(60000) });
  assert(response.ok, `baseline evidence unavailable (${response.status}); do not fall back to a full test run`);
  return bytes ? Buffer.from(await response.arrayBuffer()).toString('utf8') : response.json();
}
async function sourceContext(root, catalogPath) {
  const bytes = await file(catalogPath), catalog = JSON.parse(bytes.toString('utf8'));
  assert(catalog.schemaVersion === 1 && catalog.kind === 'kaigen-ci-incremental-selection' && catalog.repository === REPO, 'unsupported selection');
  assert(same(catalog.allowedCiPaths, CI_PATHS), 'unapproved CI equivalence paths');
  for (const reference of [catalog.referenceSource, catalog.productSource, catalog.baseline.source]) assert(same(identity(root, reference.commit), reference), 'source identity does not resolve exactly');
  const producerSource = unixProducerReference(catalog, commit => identity(root, commit));
  const source = identity(root);
  assertCleanTree(gitText(root, ['status', '--porcelain=v1', '--untracked-files=all']));
  const changes = trackedChanges(root, catalog.referenceSource.commit, source.commit);
  assert(changes.every(change => CI_PATHS.includes(change.path)), 'product inputs changed after the accepted verification reference; update the affected selection');
  for (const [filename, platform] of [['scripts/build-appimage.sh', 'debian'], ['scripts/build-macos.sh', 'macos']]) {
    const before = git(root, ['show', `${producerSource.commit}:${filename}`]).toString('utf8').replaceAll('\r\n', '\n');
    const after = git(root, ['show', `${source.commit}:${filename}`]).toString('utf8').replaceAll('\r\n', '\n');
    assert(derivedUnixProducer(before, platform) === after, 'Unix producer changed beyond the selected test statement and explicit bash launcher');
  }
  const packageJson = JSON.parse(git(root, ['show', `${source.commit}:package.json`]).toString('utf8'));
  assert(packageJson.version === catalog.version, 'selection version mismatch');
  const npmScripts = new Set(packageJson.scripts['test:frontend'].split(/\s*&&\s*/u).map(command => /^npm run (test:[\w-]+)$/u.exec(command)?.[1]).filter(Boolean));
  const seen = new Set();
  for (const check of catalog.checks) {
    assert(!seen.has(check.id) && ['run', 'reuse'].includes(check.action), 'duplicate or invalid check'); seen.add(check.id);
    descriptor(check.id, npmScripts, check.variant);
  }
  return { root, catalogPath, catalog, selectionSha256: sha(bytes), source, changes, npmScripts, blobs: new Map() };
}
function inputs(context, setId, source) {
  const definitions = context.catalog.inputSets[setId];
  assert(Array.isArray(definitions) && definitions.length > 0, 'missing explicit check inputs');
  return definitions.map(input => {
    assert(input.kind === 'git' && !input.path.includes('\\') && !input.path.includes(':') && !input.path.startsWith('/') && !input.path.split('/').includes('..'), 'nonportable input');
    const key = `${source.commit}:${input.path}`;
    if (!context.blobs.has(key)) context.blobs.set(key, git(context.root, ['show', key]));
    const observed = sha(inputBytes(context.blobs.get(key), input.lines));
    return { ...input, sha256: observed };
  });
}
function validateReuse(context, check) {
  const previous = inputs(context, check.baselineInputSet, context.catalog.baseline.source), current = inputs(context, check.inputSet, context.source);
  const summarize = list => list.map(({ id, sha256 }) => ({ id, sha256 })).sort((a, b) => a.id.localeCompare(b.id));
  assert(same(previous, context.catalog.inputSets[check.baselineInputSet]), `baseline input hash mismatch: ${check.id}`);
  assert(same(summarize(previous), summarize(current)), `reused inputs changed: ${check.id}`);
  return previous;
}
function currentInputs(context, check) {
  const current = inputs(context, check.inputSet, context.source);
  if (check.id === 'frontend:build-pipeline') for (const filename of CI_PATHS) {
    if (!current.some(input => input.path === filename && input.lines === undefined)) current.push({ id: `ci:${filename}`, kind: 'git', path: filename, sha256: sha(git(context.root, ['show', `${context.source.commit}:${filename}`])) });
  }
  return current;
}
function validateWebDependencies(context) {
  for (const filename of ['web/kaigen-webd/Cargo.toml', 'web/kaigen-webd/Cargo.lock']) {
    const before = git(context.root, ['show', `${context.catalog.baseline.source.commit}:${filename}`]).toString('utf8');
    const after = git(context.root, ['show', `${context.source.commit}:${filename}`]).toString('utf8');
    const normalized = before.replace(/(\[\[(?:package)\]\]\r?\nname = "(?:kaigen|kaigen-webd)"\r?\nversion = ")0\.2\.7(")/gu, `$1${context.catalog.version}$2`).replace(/^(name = "kaigen-webd"\r?\nversion = ")0\.2\.7(")/mu, `$1${context.catalog.version}$2`);
    assert(normalized === after, 'Web daemon dependencies changed beyond first-party package version');
  }
}
function baselineOutput(log, check) {
  if (check.id.startsWith('frontend:')) {
    const name = check.id.slice(9), marker = `> kaigen@0.2.7 test:${name}`;
    const start = log.indexOf(marker);
    assert(start >= 0, `baseline lacks frontend command ${name}`);
    const end = log.indexOf('\n> kaigen@', start + marker.length);
    return log.slice(start, end < 0 ? undefined : end);
  }
  if (check.id.startsWith('rust:')) rustSummary(log, check.id);
  if (check.id.startsWith('webd:')) assert(passedTests(log).includes(check.id.slice(5)), 'baseline lacks Web daemon test');
  return log;
}
export async function prepare({ root, evidenceRoot, platform, catalogPath = path.join(root, 'ci/verification-v0.2.8.json'), get = github }) {
  assertOutsideSource(root, evidenceRoot);
  const context = await sourceContext(root, catalogPath), { catalog, source } = context;
  const expected = catalog.baseline.jobs[platform]; assert(expected && HASH.test(expected.logSha256), 'missing pinned platform baseline');
  const [run, job] = await Promise.all([get(`/repos/${REPO}/actions/runs/${expected.runId}`), get(`/repos/${REPO}/actions/jobs/${expected.jobId}`)]);
  assertJob(job, run, catalog.baseline.source, expected);
  const raw = normalizeLog(await get(`/repos/${REPO}/actions/jobs/${expected.jobId}/logs`, true));
  assert(sha(raw) === expected.logSha256, 'baseline log SHA-256 mismatch');
  assert(same(passedTests(raw), expected.passingTests), 'baseline passing test inventory changed');
  if (platform === 'web') validateWebDependencies(context);
  await mkdir(evidenceRoot, { recursive: true });
  const rawPath = path.join(evidenceRoot, `${platform}-baseline.log`);
  await writeFile(rawPath, raw, { flag: 'wx' });
  const checks = selectChecks(catalog, platform), output = testOutput(raw), results = [];
  const windowsChecks = [];
  for (const check of checks) {
    const current = currentInputs(context, check);
    const entry = { id: check.id, action: check.action, reason: check.reason, inputs: current, ...(check.variant ? { variant: check.variant } : {}) };
    if (check.action === 'reuse') {
      const before = validateReuse(context, check), selected = baselineOutput(output, check);
      const logPath = path.join(evidenceRoot, `${safeId(check.id)}-baseline.log`);
      await writeFile(logPath, selected, { flag: 'wx' });
      const resultPath = path.join(evidenceRoot, `${safeId(check.id)}-baseline.json`);
      const command = check.id.startsWith('frontend:') ? { program: 'npm.cmd', args: ['run', 'test:frontend'] } : check.id.startsWith('native:') ? { program: 'pwsh', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', 'scripts\\Invoke-KaigenAutomation.ps1', '-Task', 'windows-portable'] } : { program: 'cargo', args: ['test', '--locked', '--manifest-path', check.id.startsWith('webd:') ? 'web/kaigen-webd/Cargo.toml' : 'src-tauri/Cargo.toml', ...(platform === 'windows' ? ['--lib'] : [])] };
      const result = { schemaVersion: 1, kind: 'kaigen-incremental-check-result', checkId: check.id, status: 'PASS', source: catalog.baseline.source, inputs: before, command, exitCode: 0, output: { path: logPath, sha256: sha(selected) }, startedAt: job.started_at, completedAt: job.completed_at };
      await save(resultPath, result);
      entry.evidence = { path: resultPath, sha256: sha(await file(resultPath)) };
      results.push({ id: check.id, disposition: 'reused', source: catalog.baseline.source, outputSha256: sha(selected) });
    }
    windowsChecks.push(entry);
  }
  const state = { schemaVersion: 1, platform, source, productReference: catalog.productSource, verificationReference: catalog.referenceSource, unixProducerReference: catalog.unixProducerReferenceSource, selectionSha256: context.selectionSha256, baseline: { source: catalog.baseline.source, runId: expected.runId, jobId: expected.jobId, logSha256: expected.logSha256 }, checks: windowsChecks, results };
  if (platform === 'windows') {
    const changes = trackedChanges(root, catalog.baseline.source.commit, source.commit).map(change => ({ ...change, checkIds: windowsChecks.filter(check => check.inputs.some(input => input.path === change.path)).map(check => check.id), reason: 'Exact public baseline-to-CI source diff; affected input checks and CI producer contract.' }));
    for (const change of changes) if (!change.checkIds.length) change.checkIds.push('frontend:build-pipeline');
    const plan = { schemaVersion: 1, kind: 'kaigen-windows-incremental-plan', source, productSource: source, baseline: { source: catalog.baseline.source, evidence: [{ path: rawPath, sha256: sha(raw) }] }, testOnlyPaths: [], changes, checks: windowsChecks };
    const planPath = path.join(evidenceRoot, 'windows-plan.json'); await save(planPath, plan);
    state.windowsPlan = { path: planPath, sha256: sha(await file(planPath)) };
    await validatePlan({ planPath, planSha256: state.windowsPlan.sha256, projectRoot: root });
  }
  await save(statePath(evidenceRoot, platform), state);
  if (process.env.GITHUB_ENV) {
    const entries = [`KAIGEN_CI_EVIDENCE_ROOT=${evidenceRoot}`];
    if (state.windowsPlan) entries.push(`KAIGEN_WINDOWS_VERIFICATION_PLAN=${state.windowsPlan.path}`, `KAIGEN_WINDOWS_VERIFICATION_PLAN_SHA256=${state.windowsPlan.sha256}`);
    await appendFile(process.env.GITHUB_ENV, `${entries.join('\n')}\n`);
  }
  return { platform, run: checks.filter(check => check.action === 'run').length, reuse: results.length, selectionSha256: context.selectionSha256 };
}
async function loadState(root, directory, platform) {
  assertOutsideSource(root, directory);
  const context = await sourceContext(root, path.join(root, 'ci/verification-v0.2.8.json'));
  const state = await json(statePath(directory, platform));
  assert(state.platform === platform && same(state.source, context.source) && state.selectionSha256 === context.selectionSha256, 'prepared selection/source changed');
  assert(same(state.productReference, context.catalog.productSource) && same(state.verificationReference, context.catalog.referenceSource) && same(state.unixProducerReference, context.catalog.unixProducerReferenceSource), 'prepared source references changed');
  const raw = normalizeLog((await file(path.join(directory, `${platform}-baseline.log`))).toString('utf8'));
  const expected = context.catalog.baseline.jobs[platform];
  assert(state.baseline.logSha256 === expected.logSha256 && state.baseline.runId === expected.runId && state.baseline.jobId === expected.jobId && same(state.baseline.source, context.catalog.baseline.source), 'prepared baseline provenance changed');
  assert(sha(raw) === expected.logSha256, 'prepared baseline log changed');
  assert(same(state.checks.map(({ id, action }) => ({ id, action })), selectChecks(context.catalog, platform).map(({ id, action }) => ({ id, action }))), 'prepared check coverage changed');
  for (const check of selectChecks(context.catalog, platform).filter(check => check.action === 'reuse')) validateReuse(context, check);
  return { context, state, raw };
}
export function rustCommand(check, platform) {
  assert(check.action === 'run' && (check.id.startsWith('rust:') || check.id.startsWith('webd:')), 'unapproved selected command');
  const filter = check.id.slice(5);
  assert(/^[A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)*(?:::)?$/u.test(filter), 'invalid Rust filter');
  assert(filter !== 'all', 'full baseline is not a selected filter');
  const webd = check.id.startsWith('webd:');
  return ['test', '--locked', '--offline', '--manifest-path', webd ? 'web/kaigen-webd/Cargo.toml' : 'src-tauri/Cargo.toml', ...(!webd && platform === 'web' ? ['--no-default-features', '--features', 'web-core'] : []), ...(!webd ? ['--lib'] : []), filter, '--', '--nocapture'];
}
async function execute(program, args, root) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd: root, windowsHide: true, shell: false });
    let output = ''; child.stdout.on('data', data => { output += data; process.stdout.write(data); }); child.stderr.on('data', data => { output += data; process.stderr.write(data); });
    child.once('error', reject); child.once('close', code => resolve({ code, output }));
  });
}
export async function runTests({ root, evidenceRoot, platform }) {
  assert(platform !== 'windows', 'Windows tests remain owned by the existing hash-bound plan runner');
  const { state } = await loadState(root, evidenceRoot, platform), results = [...state.results];
  for (const check of state.checks.filter(check => check.action === 'run')) {
    const args = rustCommand(check, platform), startedAt = new Date().toISOString();
    const result = await execute('cargo', args, root);
    assert(result.code === 0, `selected check failed: ${check.id}`);
    rustSummary(result.output, `rust:${check.id.slice(5)}`);
    const logPath = path.join(evidenceRoot, `${safeId(check.id)}-current.log`); await writeFile(logPath, result.output, { flag: 'wx' });
    results.push({ id: check.id, disposition: 'rerun', source: state.source, outputSha256: sha(result.output), command: { program: 'cargo', args }, exitCode: 0, startedAt, completedAt: new Date().toISOString() });
  }
  await save(path.join(evidenceRoot, `${platform}-results.json`), { selectionSha256: state.selectionSha256, source: state.source, checks: results });
  return { platform, completed: results.length, rerun: results.filter(result => result.disposition === 'rerun').length };
}
export function assertComplete(checks, results) {
  assert(new Set(results.map(result => result.id)).size === results.length && same(checks.map(check => check.id).sort(), results.map(result => result.id).sort()), 'incomplete or duplicate final check coverage');
  for (const check of checks) { const result = results.find(result => result.id === check.id); assert(result.disposition === (check.action === 'run' ? 'rerun' : 'reused') && HASH.test(result.outputSha256), 'final result disposition or digest mismatch'); }
}
export function validateRerunResult(result, check, platform, output, source) {
  assert(result.exitCode === 0 && same(result.source, source), 'current result exit code or source changed');
  assert(same(result.command, { program: 'cargo', args: rustCommand(check, platform) }), 'current result command changed');
  assert(sha(output) === result.outputSha256, 'current check output changed');
  assert(Number.isFinite(Date.parse(result.startedAt)) && Date.parse(result.completedAt) >= Date.parse(result.startedAt), 'current result timestamps are invalid');
  rustSummary(output.toString('utf8'), `rust:${check.id.slice(5)}`);
}
export async function finalize({ root, evidenceRoot, platform, archives }) {
  const { context, state, raw } = await loadState(root, evidenceRoot, platform);
  let results;
  if (platform === 'windows') {
    const verified = await verifyFinalReceipt({ planPath: state.windowsPlan.path, planSha256: state.windowsPlan.sha256, projectRoot: root, receiptPath: path.join(root, 'artifacts/windows-incremental-verification.json'), archivePath: path.join(root, 'artifacts/Kaigen-portable-windows-x64.zip') });
    results = await Promise.all(verified.checks.map(async check => { const result = await json(check.result.path); return { id: check.id, disposition: check.disposition, source: result.source, outputSha256: result.output.sha256 }; }));
  } else {
    const verified = await json(path.join(evidenceRoot, `${platform}-results.json`));
    assert(verified.selectionSha256 === state.selectionSha256 && same(verified.source, state.source), 'result/source binding changed'); results = verified.checks;
    for (const result of results.filter(result => result.disposition === 'rerun')) validateRerunResult(result, state.checks.find(check => check.id === result.id), platform, await file(path.join(evidenceRoot, `${safeId(result.id)}-current.log`)), state.source);
    for (const result of results) {
      assert(same(result.source, result.disposition === 'rerun' ? state.source : context.catalog.baseline.source), 'result has a different source identity');
      if (result.disposition === 'reused') assert(result.outputSha256 === sha(baselineOutput(testOutput(raw), state.checks.find(check => check.id === result.id))), 'reused result does not match pinned public output');
    }
  }
  assertComplete(state.checks, results);
  assert(archives.length > 0, 'final artifact binding is required');
  const artifacts = await Promise.all(archives.map(async name => { assert(!path.isAbsolute(name) && !name.includes('..') && name.startsWith('artifacts/'), 'invalid public artifact path'); return { name: path.posix.basename(name), sha256: sha(await file(path.join(root, name))) }; }));
  const receipt = { schemaVersion: 1, kind: 'kaigen-ci-incremental-verification', status: 'PASS', fullBaselineRerun: false, repository: REPO, platform, builtFrom: state.source, productReference: state.productReference, verificationReference: state.verificationReference, unixProducerReference: state.unixProducerReference, selectionSha256: state.selectionSha256, equivalence: { unchangedOutsideCiPaths: true, changedCiPaths: context.changes.map(change => change.path) }, baseline: state.baseline, checks: results.map(({ id, disposition, source, outputSha256 }) => ({ id, disposition, source, outputSha256 })), artifacts, completedAt: new Date().toISOString() };
  await save(path.join(root, `artifacts/ci-verification-${platform}.json`), receipt);
  return { platform, status: receipt.status, checks: results.length, artifacts };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [operation, ...arguments_] = process.argv.slice(2), options = { root: process.cwd(), archives: [] };
  for (let index = 0; index < arguments_.length; index += 2) {
    const key = arguments_[index], value = arguments_[index + 1]; assert(value, 'missing argument value');
    if (key === '--archive') options.archives.push(value);
    else if (key === '--platform') options.platform = value;
    else if (key === '--evidence-root') options.evidenceRoot = path.resolve(value);
    else if (key === '--source-root') options.root = path.resolve(value);
    else assert(false, `unknown argument ${key}`);
  }
  assert(PLATFORMS.includes(options.platform) && options.evidenceRoot, 'platform and external evidence root are required');
  const handlers = { prepare, 'run-tests': runTests, finalize }; assert(handlers[operation], 'unknown operation');
  console.log(JSON.stringify(await handlers[operation](options)));
}
