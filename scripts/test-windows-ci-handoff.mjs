import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHandoff, restoreHandoff } from './windows-ci-handoff.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const encode = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const expected = { repository: 'kaigendev/Kaigen', sourceSha: 'a'.repeat(40), runId: '1234', producerAttempt: 1, consumerAttempt: 1 };
let scenarios = 0;
async function write(filename, bytes) { await mkdir(path.dirname(filename), { recursive: true }); await writeFile(filename, bytes); }
async function json(filename) { return JSON.parse(await readFile(filename, 'utf8')); }
async function missing(filename) { await assert.rejects(access(filename), { code: 'ENOENT' }); }
async function fixture(run) {
  const temporaryRoot = await realpath(os.tmpdir());
  const base = await realpath(await mkdtemp(path.join(temporaryRoot, 'kaigen-ci-handoff-')));
  try {
    const root = path.join(base, 'source'), evidenceRoot = path.join(base, 'ci-evidence'), handoffRoot = path.join(base, 'handoff');
    const artifacts = path.join(root, 'artifacts'), portable = path.join(artifacts, 'Kaigen-portable-windows-x64.zip');
    const source = { commit: expected.sourceSha, tree: 'b'.repeat(40), dirty: false };
    const checks = [{ id: 'frontend:build-pipeline', action: 'run' }, { id: 'rust:baseline', action: 'reuse' }];
    const receiptChecks = [];
    for (const check of checks) {
      const stem = check.id.replace(/[^a-zA-Z0-9_-]/gu, '_');
      const resultPath = check.action === 'run' ? path.join(artifacts, 'incremental-checks', `${stem}.json`) : path.join(evidenceRoot, `${stem}-baseline.json`);
      const outputPath = resultPath.replace(/\.json$/u, '.log'), output = Buffer.from(`PASS disposable ${check.id}\n`);
      await write(outputPath, output);
      const result = { status: 'PASS', exitCode: 0, checkId: check.id, source, output: { path: outputPath, sha256: sha(output) } };
      const bytes = encode(result); await write(resultPath, bytes);
      const pin = { path: resultPath, sha256: sha(bytes) };
      if (check.action === 'reuse') check.evidence = pin;
      receiptChecks.push({ id: check.id, disposition: check.action === 'run' ? 'rerun' : 'reused', result: pin });
    }
    const baseline = Buffer.from('PASS disposable public baseline\n');
    const baselinePath = path.join(evidenceRoot, 'windows-baseline.log'); await write(baselinePath, baseline);
    const planPath = path.join(evidenceRoot, 'windows-plan.json');
    const plan = { source, checks, baseline: { evidence: [{ path: baselinePath, sha256: sha(baseline) }] } };
    const planBytes = encode(plan); await write(planPath, planBytes);
    const state = { platform: 'windows', source, checks, selectionSha256: 'c'.repeat(64), windowsPlan: { path: planPath, sha256: sha(planBytes) } };
    await write(path.join(evidenceRoot, 'ci-windows-state.json'), encode(state));
    const portableBytes = Buffer.from('disposable portable fixture'); await write(portable, portableBytes);
    await write(path.join(artifacts, 'Kaigen-source-github.zip'), 'disposable source fixture');
    const receiptPath = path.join(artifacts, 'windows-incremental-verification.json');
    const receipt = { status: 'PASS', source, plan: state.windowsPlan, checks: receiptChecks, archive: { path: portable, sha256: sha(portableBytes) } };
    await write(receiptPath, encode(receipt));
    const options = { root, evidenceRoot, handoffRoot, expected };
    const create = () => createHandoff(options);
    const clearConsumer = async () => { await rm(artifacts, { recursive: true }); await rm(evidenceRoot, { recursive: true }); };
    const restore = (created, overrides = {}) => restoreHandoff({ ...options, manifestSha256: created.manifestSha256, ...overrides });
    const mutateManifest = async (created, mutate) => {
      const filename = path.join(handoffRoot, 'handoff.json'), manifest = await json(filename);
      mutate(manifest); const bytes = encode(manifest); await writeFile(filename, bytes); created.manifestSha256 = sha(bytes);
    };
    await run({ ...options, artifacts, portable, receiptPath, create, clearConsumer, restore, mutateManifest });
    scenarios++;
  } finally {
    assert(path.dirname(base) === temporaryRoot && path.basename(base).startsWith('kaigen-ci-handoff-'), 'fixture cleanup must stay in its captured temporary directory');
    await rm(base, { recursive: true, force: true });
  }
}

for (const consumerAttempt of [1, 2]) await fixture(async f => {
  // Real target/cache/profile trees are never visited; these are inert synthetic markers.
  await write(path.join(f.root, 'src-tauri/target/do-not-transfer'), 'fixture');
  await write(path.join(f.root, 'profiles/do-not-transfer'), 'fixture');
  const created = await f.create();
  const manifest = await json(path.join(f.handoffRoot, 'handoff.json'));
  assert(manifest.files.every(file => ['artifacts', 'evidence'].includes(file.area)));
  await missing(path.join(f.handoffRoot, 'profiles')); await missing(path.join(f.handoffRoot, 'src-tauri'));
  await f.clearConsumer();
  const restored = await f.restore(created, { expected: { ...expected, consumerAttempt } });
  assert.equal(restored.producerAttempt, 1); assert.equal(restored.consumerAttempt, consumerAttempt);
  assert.equal((await readFile(f.portable)).toString(), 'disposable portable fixture');
  const receipt = await json(f.receiptPath);
  assert.equal(receipt.plan.path, path.join(f.evidenceRoot, 'windows-plan.json'));
  assert.equal(receipt.archive.path, f.portable);
});

for (const override of [{ repository: 'foreign/repository' }, { runId: '9999' }, { sourceSha: 'd'.repeat(40) }, { producerAttempt: 2, consumerAttempt: 2 }, { consumerAttempt: 0 }]) await fixture(async f => {
  const created = await f.create(); await f.clearConsumer();
  await assert.rejects(f.restore(created, { expected: { ...expected, ...override } }), /identity|repository|attempts/u);
  await missing(f.artifacts);
});

await fixture(async f => {
  const created = await f.create(); await f.clearConsumer();
  await writeFile(path.join(f.handoffRoot, 'handoff.json'), '{}');
  await assert.rejects(f.restore(created), /manifest digest/u); await missing(f.artifacts);
});
await fixture(async f => {
  const created = await f.create(); await f.clearConsumer();
  await writeFile(path.join(f.handoffRoot, 'artifacts/Kaigen-portable-windows-x64.zip'), 'tampered');
  await assert.rejects(f.restore(created), /file digest/u); await missing(f.artifacts);
});
await fixture(async f => {
  const created = await f.create(); await f.clearConsumer();
  await rm(path.join(f.handoffRoot, 'evidence/windows-plan.json'));
  await assert.rejects(f.restore(created), /ENOENT/u); await missing(f.artifacts);
});
await fixture(async f => {
  const created = await f.create(); await f.clearConsumer();
  await write(path.join(f.handoffRoot, 'cache/unapproved.json'), '{}');
  await assert.rejects(f.restore(created), /inventory/u); await missing(f.artifacts);
});
for (const mutation of [
  m => { m.files[0].path = '../outside.zip'; },
  m => { m.files.push(m.files[0]); },
  m => { m.selectionSha256 = 'e'.repeat(64); },
  m => { m.planSha256 = 'e'.repeat(64); },
  m => { m.sourceRoot += '-different-runner-layout'; },
]) await fixture(async f => {
  const created = await f.create(); await f.clearConsumer(); await f.mutateManifest(created, mutation);
  await assert.rejects(f.restore(created), /unsafe|duplicate|selection|plan|runner path/u); await missing(f.artifacts);
});
await fixture(async f => {
  const receipt = await json(f.receiptPath); receipt.checks.pop(); await writeFile(f.receiptPath, encode(receipt));
  await assert.rejects(f.create(), /check coverage/u); await missing(f.handoffRoot);
});
await fixture(async f => {
  const receipt = await json(f.receiptPath); receipt.checks[0].result.path = path.join(path.dirname(f.root), 'outside.json');
  await writeFile(f.receiptPath, encode(receipt));
  await assert.rejects(f.create(), /allowed roots/u); await missing(f.handoffRoot);
});
await fixture(async f => {
  await write(path.join(f.evidenceRoot, 'credentials.json'), 'synthetic forbidden marker');
  await assert.rejects(f.create(), /unapproved evidence/u); await missing(f.handoffRoot);
});
await fixture(async f => {
  const created = await f.create(); await f.clearConsumer();
  const file = path.join(f.handoffRoot, 'artifacts/incremental-checks/frontend_build-pipeline.log');
  await writeFile(file, 'digest mismatch after complete transfer');
  await f.mutateManifest(created, m => { const entry = m.files.find(e => e.path.endsWith('frontend_build-pipeline.log')); entry.sha256 = sha(Buffer.from('digest mismatch after complete transfer')); entry.size = Buffer.byteLength('digest mismatch after complete transfer'); });
  await assert.rejects(f.restore(created), /evidence digest/u); await missing(f.artifacts);
});
await fixture(async f => {
  const created = await f.create(); await f.clearConsumer();
  const outside = path.join(path.dirname(f.root), 'link-target'); await mkdir(outside);
  await symlink(outside, f.artifacts, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.restore(created), /canonical|link/u);
  await missing(path.join(outside, 'Kaigen-portable-windows-x64.zip'));
});
await fixture(async f => {
  const created = await f.create();
  await assert.rejects(f.restore(created), /EEXIST/u);
  assert.equal((await readFile(f.portable)).toString(), 'disposable portable fixture');
});

const workflow = await readFile(new URL('../.github/workflows/build-windows.yml', import.meta.url), 'utf8');
const build = workflow.split(/^  build:\s*$/mu)[1]?.split(/^  package:\s*$/mu)[0];
const packaging = workflow.split(/^  package:\s*$/mu)[1];
assert(build && packaging && /^    needs: build$/mu.test(packaging), 'packaging must depend on successful producer');
assert(build.includes('-Task windows-portable') && build.includes('-VerificationPlanPath "%KAIGEN_WINDOWS_VERIFICATION_PLAN%"')
  && build.includes('-VerificationPlanSha256 "%KAIGEN_WINDOWS_VERIFICATION_PLAN_SHA256%"'), 'retain complete existing portable checks');
assert(build.indexOf('node scripts/release-version.mjs --github-env') >= 0
  && build.indexOf('node scripts/release-version.mjs --github-env') < build.indexOf('ci-incremental-verification.mjs prepare'), 'version drift must fail before expensive compilation');
assert(!/windows-portable|ci-windows-prime|cargo (?:build|test)/u.test(packaging), 'packaging rerun must not compile or rerun the portable build');
assert(packaging.includes('dtolnay/rust-toolchain@'), 'retain rustc for the existing small MSI shutdown helper');
assert(!build.includes('build-windows-msi.ps1') && packaging.includes('build-windows-msi.ps1')
  && packaging.includes('ci-incremental-verification.mjs finalize'), 'MSI and finalizer must remain in packaging');
assert(packaging.includes('artifact-ids: ${{ needs.build.outputs.handoff-artifact-id }}')
  && packaging.includes('digest-mismatch: error') && !/^\s+(?:run-id|github-token|repository):/mu.test(packaging), 'download must stay within this run');
assert(packaging.indexOf('Validate exact build handoff locator') < packaging.indexOf('actions/download-artifact@')
  && packaging.includes("$env:KAIGEN_HANDOFF_ARTIFACT_ID -cnotmatch '^[1-9][0-9]*$'"), 'missing locator must not trigger an all-artifacts download');
assert(packaging.indexOf('windows-ci-handoff.mjs restore') < packaging.indexOf('Expand-Archive -LiteralPath artifacts/Kaigen-portable'), 'verify before consuming portable');
assert(packaging.includes('node scripts/release-version.mjs --github-env') && packaging.includes('-ReleaseLabel "%KAIGEN_RELEASE_LABEL%"'), 'MSI must consume canonical version');
assert(!packaging.includes('if:') && workflow.includes('  pull_request:'), 'retain PR packaging coverage');
for (const name of ['Kaigen-verification-windows', 'Kaigen-portable-windows-x64', 'Kaigen-installer-windows-x64', 'Kaigen-source-github']) {
  assert(packaging.includes(`name: ${name}`), `retain public artifact ${name}`);
}
assert(build.includes('compression-level: 0') && build.includes('${{ github.run_id }}-${{ github.run_attempt }}'), 'internal handoff is immutable per producer attempt');
assert(!build.includes('overwrite:') && (packaging.match(/overwrite: true/gu) ?? []).length === 4, 'only this run\'s public outputs are replaceable after a partial package upload');
console.log(`PASS Windows CI handoff: ${scenarios} disposable transfer/rejection scenarios and workflow contracts`);
