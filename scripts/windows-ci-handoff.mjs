import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFile, lstat, mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HASH = /^[a-f0-9]{64}$/u;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const safeId = id => id.replace(/[^a-zA-Z0-9_-]/gu, '_');
const PUBLIC_FILES = ['Kaigen-portable-windows-x64.zip', 'Kaigen-source-github.zip', 'windows-incremental-verification.json'];
const MANIFEST = 'handoff.json';
const inside = (root, filename) => { const relative = path.relative(root, filename); return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
const separate = (a, b) => a !== b && !inside(a, b) && !inside(b, a);

async function regular(filename) {
  const info = await lstat(filename);
  assert(info.isFile() && !info.isSymbolicLink(), `handoff requires a regular file: ${filename}`);
  assert(path.resolve(await realpath(filename)) === path.resolve(filename), `handoff path traverses a link: ${filename}`);
  return readFile(filename);
}
async function directory(root) {
  const info = await lstat(root);
  assert(info.isDirectory() && !info.isSymbolicLink() && path.resolve(await realpath(root)) === path.resolve(root), 'handoff directory must be canonical and link-free');
}
async function makeDirectory(root) {
  try { await directory(root); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await makeDirectory(path.dirname(root)); await mkdir(root); await directory(root);
  }
}
function identity(expected) {
  assert(expected.repository === 'kaigendev/Kaigen' && /^[a-f0-9]{40}$/u.test(expected.sourceSha), 'invalid handoff repository/source');
  assert(/^[1-9][0-9]*$/u.test(String(expected.runId)), 'invalid handoff run');
  assert(Number.isSafeInteger(expected.producerAttempt) && expected.producerAttempt >= 1
    && Number.isSafeInteger(expected.consumerAttempt) && expected.consumerAttempt >= expected.producerAttempt, 'invalid producer/consumer attempts');
}
function evidenceNames(checks) {
  return new Set(['windows-baseline.log', 'windows-plan.json', 'ci-windows-state.json', 'release-v0296-manifest.json',
    'windows-executed-run.json', 'windows-executed-job.json', 'windows-executed-artifact.json', 'windows-executed-log.log',
    'windows-executed-receipt.json', 'windows-executed-receipt.zip',
    ...checks.flatMap(check => [`${safeId(check.id)}-baseline.json`, `${safeId(check.id)}-baseline.log`])]);
}
function allowedEntry(entry, checks) {
  assert(['artifacts', 'evidence'].includes(entry.area) && typeof entry.path === 'string'
    && /^[A-Za-z0-9_./-]+$/u.test(entry.path) && !entry.path.split('/').some(part => !part || part === '.' || part === '..'), 'unsafe handoff path');
  if (entry.area === 'evidence') assert(evidenceNames(checks).has(entry.path), `unapproved evidence file: ${entry.path}`);
  else assert(PUBLIC_FILES.includes(entry.path) || checks.filter(check => check.action === 'run').some(check =>
    [`incremental-checks/${safeId(check.id)}.json`, `incremental-checks/${safeId(check.id)}.log`].includes(entry.path)), `unapproved build file: ${entry.path}`);
  assert(HASH.test(entry.sha256) && Number.isSafeInteger(entry.size) && entry.size >= 0, 'invalid handoff file digest/size');
}
async function inventory(root, prefix = '') {
  await directory(root);
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const relative = prefix + entry.name;
    assert(!entry.isSymbolicLink(), 'handoff links are forbidden');
    if (entry.isDirectory()) files.push(...await inventory(path.join(root, entry.name), `${relative}/`));
    else { assert(entry.isFile(), 'handoff special files are forbidden'); files.push(relative); }
    assert(files.length <= 2048, 'handoff file count exceeded');
  }
  return files.sort();
}
async function validateProof({ root, evidenceRoot, expected, lookup, selectionSha256, planSha256 }) {
  const statePath = path.join(evidenceRoot, 'ci-windows-state.json');
  const state = JSON.parse((await lookup(statePath)).toString('utf8'));
  const planPath = path.join(evidenceRoot, 'windows-plan.json');
  const planBytes = await lookup(planPath), plan = JSON.parse(planBytes.toString('utf8'));
  const receipt = JSON.parse((await lookup(path.join(root, 'artifacts/windows-incremental-verification.json'))).toString('utf8'));
  assert(state.platform === 'windows' && state.source?.commit === expected.sourceSha && same(state.source, plan.source)
    && same(receipt.source, plan.source) && receipt.status === 'PASS', 'handoff verification source/status mismatch');
  assert(HASH.test(state.selectionSha256) && (!selectionSha256 || selectionSha256 === state.selectionSha256), 'handoff selection mismatch');
  assert(state.windowsPlan?.path === planPath && state.windowsPlan.sha256 === sha(planBytes)
    && (!planSha256 || planSha256 === sha(planBytes)) && same(receipt.plan, state.windowsPlan), 'handoff plan mismatch');
  assert(Array.isArray(state.checks) && state.checks.length > 0 && same(state.checks, plan.checks)
    && Array.isArray(receipt.checks) && receipt.checks.length === state.checks.length, 'handoff check coverage mismatch');
  const ids = new Set();
  const pin = async reference => {
    assert(reference && path.isAbsolute(reference.path) && HASH.test(reference.sha256), 'invalid handoff evidence pin');
    assert(sha(await lookup(reference.path)) === reference.sha256, `handoff evidence digest mismatch: ${reference.path}`);
  };
  for (const item of receipt.checks) {
    const check = state.checks.find(check => check.id === item.id);
    assert(check && !ids.has(item.id) && item.disposition === (check.action === 'run' ? 'rerun' : 'reused'), 'handoff check disposition/identity mismatch');
    ids.add(item.id);
    if (check.action === 'reuse') assert(same(item.result, check.evidence), 'handoff reused result substitution');
    await pin(item.result);
    const result = JSON.parse((await lookup(item.result.path)).toString('utf8'));
    assert(result.status === 'PASS' && result.exitCode === 0 && result.checkId === item.id, 'handoff result is not a passing check');
    await pin(result.output);
  }
  assert(receipt.archive?.path === path.join(root, 'artifacts/Kaigen-portable-windows-x64.zip'), 'handoff portable path mismatch');
  await pin(receipt.archive);
  for (const reference of plan.baseline?.evidence ?? []) await pin(reference);
  return { checks: state.checks, selectionSha256: state.selectionSha256, planSha256: sha(planBytes) };
}

export async function createHandoff({ root, evidenceRoot, handoffRoot, expected }) {
  identity(expected);
  assert(expected.producerAttempt === expected.consumerAttempt, 'producer must record its current attempt');
  root = path.resolve(root); evidenceRoot = path.resolve(evidenceRoot); handoffRoot = path.resolve(handoffRoot);
  await directory(root); await directory(evidenceRoot);
  assert(separate(root, evidenceRoot) && separate(root, handoffRoot) && separate(evidenceRoot, handoffRoot), 'handoff/evidence must be separate from source and each other');
  const artifactRoot = path.join(root, 'artifacts');
  const lookup = filename => {
    const artifact = path.relative(artifactRoot, filename).replaceAll('\\', '/');
    const evidence = path.relative(evidenceRoot, filename).replaceAll('\\', '/');
    assert((inside(artifactRoot, filename) && (PUBLIC_FILES.includes(artifact) || /^incremental-checks\/[A-Za-z0-9_-]+\.(json|log)$/u.test(artifact)))
      || (inside(evidenceRoot, filename) && /^[A-Za-z0-9_-]+\.(json|log|zip)$/u.test(evidence)), 'handoff evidence escapes its allowed roots');
    return regular(filename);
  };
  const proof = await validateProof({ root, evidenceRoot, expected, lookup });
  const paths = PUBLIC_FILES.map(name => ({ area: 'artifacts', path: name }));
  for (const check of proof.checks.filter(check => check.action === 'run')) {
    paths.push(...['json', 'log'].map(extension => ({ area: 'artifacts', path: `incremental-checks/${safeId(check.id)}.${extension}` })));
  }
  paths.push(...(await inventory(evidenceRoot)).map(name => ({ area: 'evidence', path: name })));
  const files = [];
  for (const entry of paths) {
    const bytes = await regular(path.join(entry.area === 'artifacts' ? artifactRoot : evidenceRoot, entry.path));
    const pin = { ...entry, size: bytes.length, sha256: sha(bytes) }; allowedEntry(pin, proof.checks); files.push(pin);
  }
  // The finalizer will independently revalidate all source, baseline and coverage contracts.
  const manifest = { schemaVersion: 1, kind: 'kaigen-windows-ci-handoff', repository: expected.repository,
    sourceSha: expected.sourceSha, runId: String(expected.runId), producerJob: 'build', producerAttempt: expected.producerAttempt,
    sourceRoot: root, evidenceRoot, selectionSha256: proof.selectionSha256, planSha256: proof.planSha256, files };
  await makeDirectory(path.dirname(handoffRoot)); await mkdir(handoffRoot); await directory(handoffRoot);
  for (const entry of files) {
    const destination = path.join(handoffRoot, entry.area, entry.path);
    await makeDirectory(path.dirname(destination));
    const bytes = await regular(path.join(entry.area === 'artifacts' ? artifactRoot : evidenceRoot, entry.path));
    assert(sha(bytes) === entry.sha256, 'producer file changed during handoff');
    await writeFile(destination, bytes, { flag: 'wx' });
  }
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(path.join(handoffRoot, MANIFEST), bytes, { flag: 'wx' });
  return { manifestSha256: sha(bytes), producerAttempt: expected.producerAttempt, files: files.length };
}

export async function restoreHandoff({ root, evidenceRoot, handoffRoot, expected, manifestSha256 }) {
  identity(expected); assert(HASH.test(manifestSha256), 'expected handoff manifest digest is required');
  root = path.resolve(root); evidenceRoot = path.resolve(evidenceRoot); handoffRoot = path.resolve(handoffRoot);
  await directory(root); await directory(handoffRoot);
  const bytes = await regular(path.join(handoffRoot, MANIFEST));
  assert(sha(bytes) === manifestSha256, 'handoff manifest digest mismatch');
  const manifest = JSON.parse(bytes.toString('utf8'));
  assert(manifest.schemaVersion === 1 && manifest.kind === 'kaigen-windows-ci-handoff'
    && manifest.repository === expected.repository && manifest.sourceSha === expected.sourceSha && manifest.runId === String(expected.runId)
    && manifest.producerJob === 'build' && manifest.producerAttempt === expected.producerAttempt, 'handoff producer identity mismatch');
  // Existing receipt paths are immutable. A different runner layout fails instead of rewriting pins.
  assert(manifest.sourceRoot === root && manifest.evidenceRoot === evidenceRoot && separate(root, evidenceRoot)
    && separate(root, handoffRoot) && separate(evidenceRoot, handoffRoot), 'handoff runner path mismatch');
  assert(Array.isArray(manifest.files) && manifest.files.length > 0 && manifest.files.length <= 2048, 'invalid handoff inventory');
  const byTarget = new Map(), keys = [];
  const stateBytes = await regular(path.join(handoffRoot, 'evidence/ci-windows-state.json'));
  const checks = JSON.parse(stateBytes.toString('utf8')).checks;
  assert(Array.isArray(checks), 'handoff checks missing');
  for (const entry of manifest.files) {
    allowedEntry(entry, checks);
    const key = `${entry.area}/${entry.path}`;
    assert(!keys.includes(key), 'duplicate handoff file'); keys.push(key);
    const target = path.join(entry.area === 'artifacts' ? path.join(root, 'artifacts') : evidenceRoot, entry.path);
    const file = path.join(handoffRoot, key), content = await regular(file);
    assert(content.length === entry.size && sha(content) === entry.sha256, `handoff file digest mismatch: ${key}`);
    byTarget.set(target, file);
  }
  assert(same(await inventory(handoffRoot), [...keys, MANIFEST].sort()), 'handoff inventory has missing or extra files');
  for (const name of PUBLIC_FILES) assert(keys.includes(`artifacts/${name}`), `handoff public file missing: ${name}`);
  await validateProof({ root, evidenceRoot, expected, selectionSha256: manifest.selectionSha256, planSha256: manifest.planSha256,
    lookup: filename => { assert(byTarget.has(filename), `handoff evidence escapes inventory: ${filename}`); return regular(byTarget.get(filename)); } });
  // Check all bytes before writing any consumer file; a new runner supplies empty destinations.
  for (const [target, file] of byTarget) {
    await makeDirectory(path.dirname(target));
    await writeFile(target, await regular(file), { flag: 'wx' });
  }
  return { producerAttempt: manifest.producerAttempt, consumerAttempt: expected.consumerAttempt, files: manifest.files.length,
    planSha256: manifest.planSha256, selectionSha256: manifest.selectionSha256 };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [operation, ...args] = process.argv.slice(2);
  assert(['create', 'restore'].includes(operation) && args.length === 4 && args[0] === '--evidence-root' && args[2] === '--handoff-root', 'use create|restore --evidence-root PATH --handoff-root PATH');
  assert(process.env.GITHUB_ACTIONS === 'true' && process.env.GITHUB_JOB === (operation === 'create' ? 'build' : 'package'), 'handoff is restricted to its GitHub Actions jobs');
  const root = process.cwd(), sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  assert(sourceSha === process.env.GITHUB_SHA, 'checkout is not the current workflow source');
  const expected = { repository: process.env.GITHUB_REPOSITORY, sourceSha, runId: process.env.GITHUB_RUN_ID,
    producerAttempt: Number(operation === 'create' ? process.env.GITHUB_RUN_ATTEMPT : process.env.KAIGEN_HANDOFF_PRODUCER_ATTEMPT),
    consumerAttempt: Number(process.env.GITHUB_RUN_ATTEMPT) };
  const options = { root, evidenceRoot: args[1], handoffRoot: args[3], expected, manifestSha256: process.env.KAIGEN_HANDOFF_MANIFEST_SHA256 };
  const result = operation === 'create' ? await createHandoff(options) : await restoreHandoff(options);
  if (operation === 'create') {
    assert(process.env.GITHUB_OUTPUT, 'GitHub output path required');
    await appendFile(process.env.GITHUB_OUTPUT, `manifest-sha256=${result.manifestSha256}\nproducer-attempt=${result.producerAttempt}\n`);
  }
  console.log(JSON.stringify({ operation, ...result }));
}
