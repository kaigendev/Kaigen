import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  REPOSITORY, WORKFLOW_PATH, PRODUCERS, assetNames, artifactNames, assertManifest,
  assertActionsContext, assertTrustedRun, selectSuccessfulJobs, selectVisibilityArtifact, assertArtifact,
  assertVerification, assertDraftState, assertRemoteAssets, assertPreviousPublication, assertReleaseGates, assertNativeEvidence, localFullCheckPins, REQUIRED_GATE_ROLES, canonicalDigest, EXTRACT_ARTIFACT, inspectWindowsArchive, verificationRevisionPaths, verificationRevisionProof, gitVerificationRevision, assertLabArtifactReceipt,
} from './publish-release.mjs';

const clone = value => structuredClone(value);
const source = { commit: 'a'.repeat(40), tree: 'b'.repeat(40) };
const digest = 'c'.repeat(64), repositoryId = 123;
let checks = 0;
function test(name, callback) { callback(); checks++; console.log('PASS ' + name); }
function rejects(name, value, mutation, validator) {
  test(name, () => { const changed = clone(value); mutation(changed); assert.throws(() => validator(changed)); });
}
function fixture(version = '0.2.9+9') {
  const label = version.replace('+', '.'); let id = 100;
  return { schemaVersion: 1, kind: 'kaigen-actions-release-input', repository: REPOSITORY, version, tag: 'v' + label,
    source, catalog: { path: 'ci/verification-v' + label + '.json', sha256: digest },
    producers: Object.fromEntries(Object.entries(artifactNames(version)).map(([key, names], index) => [key,
      { runId: 10 + index, attempt: 2, artifacts: names.map(name => ({ name, id: id++, digest: 'sha256:' + digest })) }])),
    gates: { path: `ci/releases/evidence/v${label}/gate.json`, sha256: digest } };
}
const manifest = fixture();
test('current and next versions use the same code and seven asset contract', () => {
  for (const version of ['0.2.9+9', '0.2.9+10', '1.0.0']) {
    const value = fixture(version); assertManifest(value, version);
    const names = Object.values(assetNames(version)).flat(); assert.equal(names.length, 7);
    assert.equal(new Set(names).size, 7); assert.ok(names.includes('Kaigen-source-' + version.replace('+', '.') + '.zip'));
  }
});
for (const [name, mutate] of [
  ['wrong version', v => { v.version = '0.2.9+8'; }],
  ['historical tag substitution', v => { v.tag = 'v0.2.9.8'; }],
  ['foreign repository', v => { v.repository = 'attacker/Kaigen'; }],
  ['arbitrary catalog path', v => { v.catalog.path = '../secret.json'; }],
  ['invalid source identity', v => { v.source.commit = 'main'; }],
  ['missing native producer', v => { delete v.producers.native; }],
  ['duplicate artifact pin', v => { v.producers.windows.artifacts[1].id = v.producers.windows.artifacts[0].id; }],
  ['missing installer artifact', v => { v.producers.windows.artifacts.pop(); }],
  ['missing artifact digest', v => { delete v.producers.unix.artifacts[0].digest; }],
  ['missing release gates', v => { delete v.gates; }],
]) rejects(name, manifest, mutate, value => assertManifest(value, '0.2.9+9'));

const env = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: REPOSITORY, GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_REF: 'refs/heads/main', GITHUB_WORKFLOW_REF: REPOSITORY + '/' + WORKFLOW_PATH + '@refs/heads/main',
  GITHUB_SHA: source.commit, GITHUB_WORKFLOW_SHA: source.commit, GITHUB_RUN_ID: '50', GITHUB_RUN_ATTEMPT: '1',
  KAIGEN_RELEASE_MANIFEST_SHA256: digest };
const event = { repository: { full_name: REPOSITORY }, ref: 'refs/heads/main', inputs: { manifest_sha256: digest } };
test('trusted manual publication context', () => assertActionsContext(env, event, source.commit));
for (const [name, mutate] of [
  ['local invocation', e => { delete e.GITHUB_ACTIONS; }],
  ['pull request trigger', e => { e.GITHUB_EVENT_NAME = 'pull_request_target'; }],
  ['feature branch controller', e => { e.GITHUB_REF = 'refs/heads/release'; }],
  ['different workflow controller', e => { e.GITHUB_WORKFLOW_REF = REPOSITORY + '/.github/workflows/publish-release-0298.yml@refs/heads/main'; }],
  ['workflow source mismatch', e => { e.GITHUB_WORKFLOW_SHA = 'd'.repeat(40); }],
]) rejects(name, env, mutate, value => assertActionsContext(value, event, source.commit));
rejects('dispatch digest substitution', event, value => { value.inputs.manifest_sha256 = 'd'.repeat(64); }, value => assertActionsContext(env, value, source.commit));

const producer = PRODUCERS.windows, pin = manifest.producers.windows;
const run = { id: pin.runId, run_attempt: pin.attempt, workflow_id: producer.id, name: producer.name, path: producer.path,
  event: 'push', head_branch: 'main', head_sha: source.commit,
  repository: { full_name: REPOSITORY, id: repositoryId }, head_repository: { full_name: REPOSITORY, id: repositoryId },
  status: 'completed', conclusion: 'success' };
test('exact trusted producer run', () => assertTrustedRun(run, producer, pin, source, repositoryId));
for (const [name, mutate] of [
  ['fork-origin producer', r => { r.head_repository.id++; }],
  ['different producer commit', r => { r.head_sha = 'd'.repeat(40); }],
  ['different workflow ID', r => { r.workflow_id++; }],
  ['different workflow path', r => { r.path = WORKFLOW_PATH; }],
  ['producer PR run', r => { r.event = 'pull_request'; }],
  ['producer still running', r => { r.status = 'in_progress'; }],
  ['failed producer', r => { r.conclusion = 'failure'; }],
  ['new producer attempt invalidates pin', r => { r.run_attempt++; }],
]) rejects(name, run, mutate, value => assertTrustedRun(value, producer, pin, source, repositoryId));

const job = (name, attempt, id) => ({ name, run_id: pin.runId, head_sha: source.commit, run_attempt: attempt, id,
  status: 'completed', conclusion: 'success', started_at: '2026-10-01T00:00:00Z', completed_at: '2026-10-01T00:05:00Z' });
const jobs = [job('build', 1, 30), { ...job('package', 1, 31), conclusion: 'failure' }, job('package', 2, 32)];
test('package retry retains exact successful build and selects latest package', () => {
  assert.deepEqual(selectSuccessfulJobs(jobs, producer, pin, source).map(j => j.id), [30, 32]);
});
for (const [name, mutate] of [
  ['missing build job', values => { values.splice(0, 1); }],
  ['missing package job', values => { values.splice(1); }],
  ['latest package failed', values => { values[2].conclusion = 'failure'; }],
  ['new failed build supersedes earlier PASS', values => { values.push({ ...job('build', 2, 33), conclusion: 'failure' }); }],
  ['ambiguous successful package', values => { values.push(job('package', 2, 34)); }],
  ['foreign run job', values => { values[0].run_id++; }],
  ['future job attempt', values => { values[0].run_attempt = 3; }],
]) rejects(name, jobs, mutate, value => selectSuccessfulJobs(value, producer, pin, source));

const artifactPin = pin.artifacts[0];
const artifact = { ...artifactPin, expired: false, created_at: '2026-10-01T00:04:00Z',
  workflow_run: { id: run.id, head_sha: source.commit, repository_id: repositoryId, head_repository_id: repositoryId } };
test('artifact ID, digest, repo, source and successful job interval bound', () => assertArtifact(artifact, artifactPin, run, jobs[2], repositoryId));
for (const [name, mutate] of [
  ['artifact ID changed', v => { v.id++; }],
  ['artifact digest changed', v => { v.digest = 'sha256:' + 'd'.repeat(64); }],
  ['expired artifact', v => { v.expired = true; }],
  ['artifact before successful job', v => { v.created_at = '2026-09-30T23:59:59Z'; }],
  ['artifact after job completion', v => { v.created_at = '2026-10-01T00:06:00Z'; }],
  ['artifact fork identity', v => { v.workflow_run.head_repository_id++; }],
]) rejects(name, artifact, mutate, value => assertArtifact(value, artifactPin, run, jobs[2], repositoryId));

const visibilityRun = { ...run, id: 50, run_attempt: 2 };
const visibilityJob = { ...job('Release visibility regression', 1, 70), run_id: visibilityRun.id };
const visibilityArtifact = { ...artifact, id: 71, name: 'Kaigen-visibility-0.2.9.9-50-1', workflow_run: { ...artifact.workflow_run, id: visibilityRun.id } };
const visibilityRetry = { jobs: [visibilityJob, { ...job('release', 2, 72), run_id: visibilityRun.id }], artifacts: [visibilityArtifact] };
const selectVisibility = value => selectVisibilityArtifact(value.jobs, value.artifacts, visibilityRun, '0.2.9.9', source, repositoryId);
test('release-only retry retains successful visibility dependency and its earlier attempt artifact', () => {
  const selected = selectVisibility(visibilityRetry);
  assert.equal(selected.job.run_attempt, 1); assert.equal(selected.artifact.id, visibilityArtifact.id);
});
test('a successful rerun of visibility selects its own newer artifact', () => {
  const value = clone(visibilityRetry);
  value.jobs.push({ ...visibilityJob, run_attempt: 2, id: 73 });
  value.artifacts.push({ ...visibilityArtifact, id: 74, name: 'Kaigen-visibility-0.2.9.9-50-2' });
  const selected = selectVisibility(value); assert.equal(selected.job.run_attempt, 2); assert.equal(selected.artifact.id, 74);
});
for (const [name, mutate] of [
  ['newest failed visibility rejects previous successful dependency', v => { v.jobs.push({ ...visibilityJob, id: 73, run_attempt: 2, conclusion: 'failure' }); }],
  ['duplicate visibility jobs in the selected attempt rejected', v => { v.jobs.push({ ...visibilityJob, id: 73 }); }],
  ['future visibility job attempt rejected', v => { v.jobs.push({ ...visibilityJob, id: 73, run_attempt: 3 }); }],
  ['retained visibility job source mismatch rejected', v => { v.jobs[0].head_sha = 'd'.repeat(40); }],
  ['visibility artifact cannot come from a different attempt', v => { v.artifacts[0].name = 'Kaigen-visibility-0.2.9.9-50-2'; }],
  ['visibility artifact cannot come from another run', v => { v.artifacts[0].workflow_run.id++; }],
  ['retained visibility job cannot come from another run', v => { v.jobs[0].run_id++; }],
  ['retained visibility artifact must fall inside its successful job interval', v => { v.artifacts[0].created_at = '2026-10-01T00:06:00Z'; }],
]) rejects(name, visibilityRetry, mutate, selectVisibility);

const catalog = { version: manifest.version, selectionScope: 'release-full', productSource: source, referenceSource: source,
  checks: [{ id: 'rust:all', action: 'run' }], webd: { checks: [{ id: 'webd:all', action: 'run' }] } };
const receipt = { schemaVersion: 1, kind: 'kaigen-ci-incremental-verification', status: 'PASS', repository: REPOSITORY,
  platform: 'web', builtFrom: source, productReference: source, verificationReference: source, fullBaselineRerun: true,
  selectionSha256: digest, equivalence: { unchangedOutsideCiPaths: true, changedCiPaths: [] },
  checks: ['rust:all', 'webd:all'].map(id => ({ id, disposition: 'rerun', source, outputSha256: digest })), artifacts: [] };
test('exact complete Web verification receipt', () => assertVerification(receipt, 'web', manifest, catalog));
for (const [name, mutate] of [
  ['missing Web core execution', v => { v.checks.shift(); }],
  ['duplicate check', v => { v.checks.push(clone(v.checks[0])); }],
  ['historical PASS reused', v => { v.checks[0].disposition = 'reused'; }],
  ['wrong test source', v => { v.checks[0].source.commit = 'd'.repeat(40); }],
  ['missing full baseline', v => { v.fullBaselineRerun = false; }],
  ['selection digest mismatch', v => { v.selectionSha256 = 'd'.repeat(64); }],
  ['product input hidden by equivalence', v => { v.equivalence.changedCiPaths = ['src/App.tsx']; }],
]) rejects(name, receipt, mutate, value => assertVerification(value, 'web', manifest, catalog));

const names = Object.values(assetNames(manifest.version)).flat(), marker = '<!-- owned publication -->';
const expected = { tag: manifest.tag, source, marker, names };
const tag = { ref: 'refs/tags/' + manifest.tag, object: { type: 'tag' }, annotation: { tag: manifest.tag, message: marker, object: { type: 'commit', sha: source.commit } } };
const draft = { id: 42, tag_name: manifest.tag, draft: true, immutable: false, prerelease: false, target_commitish: source.commit, body: marker + '\nrelease notes', assets: [] };
test('new tag/release and owned draft are valid states', () => { assertDraftState(null, null, expected); assertDraftState(null, tag, expected); assertDraftState(draft, tag, expected); });
for (const [name, mutate] of [
  ['published release never mutated', r => { r.draft = false; }],
  ['historical release never mutated', r => { r.tag_name = 'v0.2.9.8'; }],
  ['another publication draft', r => { r.body = '<!-- different owner -->'; }],
  ['wrong draft source', r => { r.target_commitish = 'd'.repeat(40); }],
  ['unexpected draft asset', r => { r.assets = [{ name: 'surprise.zip' }]; }],
]) rejects(name, draft, mutate, value => assertDraftState(value, tag, expected));
rejects('foreign annotated tag', tag, value => { value.annotation.object.sha = 'd'.repeat(40); }, value => assertDraftState(draft, value, expected));
rejects('matching lightweight tag is not publisher owned', tag, value => { value.object.type = 'commit'; }, value => assertDraftState(draft, value, expected));
const localAssets = names.map(name => ({ name, size: 42, sha256: digest }));
const remoteAssets = names.map((name, index) => ({ name, size: 42, digest: 'sha256:' + digest, state: 'uploaded', id: index + 1 }));
test('same draft bytes support retry without clobber', () => assertRemoteAssets(remoteAssets.slice(0, 2), localAssets, { complete: false }));
test('all seven remote assets match', () => assertRemoteAssets(remoteAssets, localAssets));
rejects('conflicting remote bytes cannot be replaced', remoteAssets, value => { value[0].digest = 'sha256:' + 'd'.repeat(64); }, value => assertRemoteAssets(value, localAssets));
rejects('missing public source archive', remoteAssets, value => { value.pop(); }, value => assertRemoteAssets(value, localAssets));
const previousContext = { canonical: { version: manifest.version, tag: manifest.tag }, manifest, manifestSha256: digest, controller: source };
const previous = { schemaVersion: 1, kind: 'kaigen-actions-release', repository: REPOSITORY, tag: manifest.tag,
  manifestSha256: digest, source, controller: source, publication: { runId: 50, attempt: 1 },
  status: 'VERIFIED_BEFORE_PUBLICATION', assets: localAssets };
test('owned draft source can reuse prior same-run canonical packaging proof', () => assertPreviousPublication(previous, previousContext, { runId: 50, attempt: 2 }, 1));
for (const [name, mutate] of [
  ['other publisher run cannot supply source archive', v => { v.publication.runId++; }],
  ['other reviewed manifest cannot supply source archive', v => { v.manifestSha256 = 'd'.repeat(64); }],
  ['other source cannot supply source archive', v => { v.source.commit = 'd'.repeat(40); }],
  ['unverified source report rejected', v => { v.status = 'PACKAGING_STARTED'; }],
]) rejects(name, previous, mutate, value => assertPreviousPublication(value, previousContext, { runId: 50, attempt: 2 }, 1));
test('bare signed or unsigned PASS cannot open release gates', () => {
  for (const value of [{ status: 'PASS' }, { status: 'PASS', signature: digest }, {}]) assert.throws(() => assertReleaseGates(value, { source, assets: localAssets }));
});

// These fixtures test rejection and identity binding only. They are synthetic and
// are never saved as release evidence or offered to the publication workflow.
const hashed = value => createHash('sha256').update(value).digest('hex');
function gateFixture(inspected = { archive: { sha256: hashed('artifact:windows'), bytes: 1234 },
  executable: { path: 'Kaigen-portable/Kaigen.exe', sha256: hashed('shipping-executable:windows'), bytes: 567 } }) {
  const candidateSource = source;
  const candidate = { source: candidateSource, buildId: 'synthetic-test-only', sourceArchiveSha256: hashed('candidate-archive') };
  const npmScripts = new Set(['test:example', 'test:build-pipeline']);
  const localCatalog = { version: manifest.version, selectionScope: 'release-full',
    checks: ['frontend:example', 'frontend:build-pipeline', 'native:prepared-cache', 'native:retry-cap', 'native:offline-friend-request', 'rust:all']
      .map(id => ({ id, action: 'run', inputSet: 'full-current' })),
    webd: { checks: [{ id: 'webd:all', action: 'run' }] },
    inputSets: { 'full-current': [{ id: 'code', kind: 'git', path: 'src/App.tsx', sha256: digest }] } };
  const readCandidateBlob = filename => Buffer.from('synthetic candidate input: ' + filename);
  const localFullPins = localFullCheckPins(localCatalog, npmScripts, readCandidateBlob, ['scripts/publish-release.mjs']);
  const localFullValidatorSha256 = hashed('validator:windows:baseline');
  const plan = { schemaVersion: 1, kind: 'kaigen-release-required-leaves', version: manifest.version,
    groups: Object.fromEntries(Object.entries(REQUIRED_GATE_ROLES).map(([group, roles]) => [group,
      { inputsSha256: hashed('inputs:' + group), leaves: roles.map(role => ({ id: group + ':' + role, role,
        validatorId: group + '-validator', validatorSha256: hashed('validator:' + group + ':' + role) })) }])) };
  function leaf(spec, group, artifactSha256, actualSource = candidateSource) {
    return { ...spec, status: 'PASS', source: actualSource, artifactSha256, runnerSha256: hashed('runner:' + group),
      inputsSha256: plan.groups[group].inputsSha256, receiptSha256: hashed('receipt:' + spec.id), disposition: 'executed', reuse: null };
  }
  const units = Object.fromEntries(['windows', 'debian', 'macos', 'web'].map(platform => [platform,
    { status: 'PASS', source: candidateSource, artifactSha256: hashed('artifact:' + platform), runnerSha256: hashed('runner:' + platform),
      builtFrom: clone(candidate), artifactVerification: null,
      leaves: plan.groups[platform].leaves.map(spec => leaf(spec, platform, hashed('artifact:' + platform))) }]));
  units.windows.artifactSha256 = inspected.archive.sha256;
  for (const item of units.windows.leaves) item.artifactSha256 = inspected.archive.sha256;
  const artifactSet = canonicalDigest(Object.fromEntries(Object.entries(units).map(([platform, unit]) => [platform, unit.artifactSha256])));
  const aggregate = group => ({ status: 'PASS', source: candidateSource, artifactSha256: artifactSet, runnerSha256: hashed('runner:' + group),
    leaves: plan.groups[group].leaves.map(spec => leaf(spec, group, artifactSet)) });
  const windowsLeaf = units.windows.leaves.find(item => item.role === 'release-test-set');
  const baselineLeaf = units.windows.leaves.find(item => item.role === 'baseline');
  const archiveLeaf = units.windows.leaves.find(item => item.role === 'archive-executable');
  const archiveExecutableValidatorSha256 = archiveLeaf.validatorSha256;
  const executableReceipt = { schemaVersion: 1, kind: 'kaigen-windows-archive-executable', source: candidateSource,
    buildId: 'synthetic-test-only', validatorSha256: archiveExecutableValidatorSha256, ...clone(inspected) };
  archiveLeaf.receiptSha256 = hashed(JSON.stringify(executableReceipt, null, 2) + '\n');
  const assets = Object.entries(assetNames(manifest.version)).flatMap(([platform, names]) => names.map(name => ({ name, platform, sha256: hashed('final:' + name) })));
  const qtoxFixture = { sha256: hashed('qtox-fixture'), installerSha256: hashed('qtox-installer') };
  const gates = { schemaVersion: 1, kind: 'kaigen-release-gate-export', status: 'PASS', fullPlatformReleaseGate: true,
    generatedAtUtc: '2026-10-06T00:00:00Z', candidate, verificationRevisions: [],
    plan, planSha256: canonicalDigest(plan), units, matrix: aggregate('matrix'), integral: aggregate('integral'),
    windowsTestSet: { publicRef: { sha256: hashed('public-ref'), logicalDigest: hashed('logical-digest') },
      validatorSha256: windowsLeaf.validatorSha256, returnedProofSha256: windowsLeaf.receiptSha256, privatePayloadReads: 0, clientCount: 9,
      localFull: { validatorSha256: localFullValidatorSha256, validatorProofSha256: baselineLeaf.receiptSha256,
        plan: { sha256: hashed('original-local-plan'), source: candidateSource, checks: localFullPins },
        receipt: { sha256: hashed('original-local-receipt'), kind: 'kaigen-windows-incremental-verification', status: 'PASS', source: candidateSource,
          planSha256: hashed('original-local-plan'), archiveSha256: units.windows.artifactSha256, fullBaselineRerun: false,
          checks: localFullPins.map(check => ({ id: check.id, status: 'PASS', disposition: 'rerun', source: candidateSource,
            inputsSha256: check.inputsSha256, resultSha256: hashed('result:' + check.id) })) } },
      summary: { transactionId: 'synthetic-transaction', deploymentKind: 'release-test-set', validationProfile: 'incremental',
        sourceTree: { fileCount: 5, sha256: hashed('windows-input-tree') }, artifact: clone(inspected.archive),
        verification: { status: 'PASS', checkCount: 9, passedCheckCount: 9, checksDigest: hashed('actual-true-checks'), protectedDataUnchanged: true, privateDataAbsent: true },
        generatedAtUtc: '2026-10-06T00:00:00Z' } },
    windowsExecutable: { receiptSha256: archiveLeaf.receiptSha256, receipt: executableReceipt },
    qtox: { schemaVersion: 1, status: 'PASS', scope: 'qtox-release-gate', identity: { kaigenCommit: candidateSource.commit, sourceTree: candidateSource.tree,
      buildId: 'synthetic-test-only', qtoxFixtureSha256: qtoxFixture.sha256.toUpperCase(), qtoxInstallerSha256: qtoxFixture.installerSha256.toUpperCase(),
      qtoxRuntimeManifestSha256: hashed('qtox-runtime').toUpperCase(), qtoxExecutableSha256: hashed('qtox-executable').toUpperCase() },
      targets: ['desktop', 'web'].map(target => ({ target, artifactSha256: (target === 'desktop' ? inspected.executable.sha256 : units.web.artifactSha256).toUpperCase(),
        receiptSha256: hashed('qtox:' + target).toUpperCase(), checks: 11, screenshots: 4 })), productionContacted: false, secretsIncluded: false },
    finalActions: Object.fromEntries([['windowsSmoke', 'windows-smoke', 'windows', '.zip'], ['webBundle', 'web-bundle', 'web', '.tar.gz']].map(([key, role, platform, suffix]) => [key,
      leaf(plan.groups.finalActions.leaves.find(spec => spec.role === role), 'finalActions', assets.find(asset => asset.platform === platform && asset.name.endsWith(suffix)).sha256, source)])),
  };
  return { gates, context: { source, candidateSource, assets, canonical: { version: manifest.version, tag: manifest.tag }, qtoxFixture, localFullPins, localFullValidatorSha256, archiveExecutableValidatorSha256 },
    localCatalog, npmScripts, readCandidateBlob };
}
const gate = gateFixture();
test('synthetic complete gate binds one frozen source and distinct candidate/final artifact identities', () => assertReleaseGates(gate.gates, gate.context));
test('local full pins derive the current recipe, three native checks, Rust and local driver', () => {
  assert.deepEqual(gate.context.localFullPins.map(check => check.id), ['frontend:example', 'frontend:build-pipeline',
    'native:prepared-cache', 'native:retry-cap', 'native:offline-friend-request', 'rust:all', 'driver:pq-two-instances']);
  assert.ok(gate.context.localFullPins.every(check => check.action === 'run'));
  const expandedCatalog = clone(gate.localCatalog); expandedCatalog.checks.splice(2, 0, { id: 'frontend:next', action: 'run', inputSet: 'full-current' });
  const expandedPins = localFullCheckPins(expandedCatalog, new Set([...gate.npmScripts, 'test:next']), gate.readCandidateBlob, ['scripts/publish-release.mjs']);
  assert.equal(expandedPins.length, gate.context.localFullPins.length + 1);
  assert.throws(() => assertReleaseGates(gate.gates, { ...gate.context, localFullPins: expandedPins }));
});
test('local full input pins come from exact source blobs including controller inputs', () => {
  const changed = localFullCheckPins(gate.localCatalog, gate.npmScripts, filename => Buffer.from('changed: ' + filename), ['scripts/publish-release.mjs']);
  assert.throws(() => assertReleaseGates(gate.gates, { ...gate.context, localFullPins: changed }));
});
test('an arbitrary local source cannot replace the single frozen Actions source', () => {
  assert.throws(() => assertReleaseGates(gate.gates, { ...gate.context, candidateSource: { commit: '1'.repeat(40), tree: '2'.repeat(40) } }));
});
test('matrix roles include network, Tor and each required behavior', () => assert.deepEqual(REQUIRED_GATE_ROLES.matrix,
  ['network', 'tor', 'normal-mode', 'offline-first', 'fault-rotation', 'entropy', 'formatting', 'about']));
for (const [name, mutate] of [
  ['legacy Windows-Web-only gate rejected', v => { v.fullPlatformReleaseGate = false; }],
  ['private path export rejected', v => { v.windowsTestSet.publicRef.path = 'C:/private/receipt.json'; }],
  ['missing macOS unit rejected', v => { delete v.units.macos; }],
  ['wrong candidate source rejected', v => { v.candidate.source.commit = '3'.repeat(40); }],
  ['coverage plan tamper rejected', v => { v.plan.groups.web.leaves[0].validatorSha256 = digest; }],
  ['required matrix Tor scope cannot be removed with recomputed plan digest', v => {
    v.plan.groups.matrix.leaves = v.plan.groups.matrix.leaves.filter(leaf => leaf.role !== 'tor');
    v.matrix.leaves = v.matrix.leaves.filter(leaf => leaf.role !== 'tor'); v.planSha256 = canonicalDigest(v.plan);
  }],
  ['extra required leaf cannot disappear from executed evidence', v => {
    v.plan.groups.web.leaves.push({ id: 'web:required-extra', role: 'extra-browser-flow', validatorId: 'real-validator', validatorSha256: digest });
    v.planSha256 = canonicalDigest(v.plan);
  }],
  ['duplicate executed leaf rejected', v => { v.units.web.leaves.push(clone(v.units.web.leaves[0])); }],
  ['wrong validator implementation rejected', v => { v.units.debian.leaves[0].validatorSha256 = digest; }],
  ['unexecuted required leaf rejected', v => { v.units.web.leaves[0].status = 'SKIP'; }],
  ['local candidate artifact substitution rejected', v => { v.units.windows.leaves[0].artifactSha256 = digest; }],
  ['runner substitution rejected', v => { v.units.web.leaves[0].runnerSha256 = digest; }],
  ['input fingerprint substitution rejected', v => { v.units.web.leaves[0].inputsSha256 = digest; }],
  ['reused PASS without exact identity proof rejected', v => { v.units.web.leaves[0].disposition = 'reused'; }],
  ['matrix artifact-set mismatch rejected', v => { v.matrix.artifactSha256 = digest; }],
  ['missing integral runtime proof rejected', v => { v.integral.leaves = []; }],
  ['Windows local portable cannot stand for nine release clients', v => { v.windowsTestSet.summary.deploymentKind = 'local-portable'; }],
  ['Windows full label cannot replace truthful incremental public summary', v => { v.windowsTestSet.summary.validationProfile = 'full'; }],
  ['Windows incremental profile without full executed coverage rejected', v => { delete v.windowsTestSet.localFull; }],
  ['local full plan cannot omit a required current check', v => { v.windowsTestSet.localFull.plan.checks.pop(); }],
  ['local full result cannot omit a required current check', v => { v.windowsTestSet.localFull.receipt.checks.pop(); }],
  ['local full plan cannot select reuse', v => { v.windowsTestSet.localFull.plan.checks[0].action = 'reuse'; }],
  ['local full result cannot reuse a prior PASS', v => { v.windowsTestSet.localFull.receipt.checks[0].disposition = 'reused'; }],
  ['local full failed check rejected', v => { v.windowsTestSet.localFull.receipt.checks[0].status = 'FAIL'; }],
  ['local full wrong original plan binding rejected', v => { v.windowsTestSet.localFull.receipt.planSha256 = digest; }],
  ['local full wrong planned inputs rejected even when result agrees', v => {
    v.windowsTestSet.localFull.plan.checks[0].inputsSha256 = digest; v.windowsTestSet.localFull.receipt.checks[0].inputsSha256 = digest;
  }],
  ['local full wrong result inputs rejected', v => { v.windowsTestSet.localFull.receipt.checks[0].inputsSha256 = digest; }],
  ['local full wrong result source rejected', v => { v.windowsTestSet.localFull.receipt.source = { commit: '1'.repeat(40), tree: '2'.repeat(40) }; }],
  ['local full cannot invent fullBaselineRerun true', v => { v.windowsTestSet.localFull.receipt.fullBaselineRerun = true; }],
  ['local full wrong archive rejected', v => { v.windowsTestSet.localFull.receipt.archiveSha256 = digest; }],
  ['local full untrusted validator rejected', v => { v.windowsTestSet.localFull.validatorSha256 = digest; }],
  ['local full disconnected registered validator proof rejected', v => { v.windowsTestSet.localFull.validatorProofSha256 = digest; }],
  ['Windows nine-client count mismatch rejected', v => { v.windowsTestSet.clientCount = 8; }],
  ['Windows private payload access rejected', v => { v.windowsTestSet.privatePayloadReads = 1; }],
  ['Windows check failures rejected', v => { v.windowsTestSet.summary.verification.passedCheckCount--; }],
  ['Windows protected data mutation rejected', v => { v.windowsTestSet.summary.verification.protectedDataUnchanged = false; }],
  ['Windows fabricated public summary disconnected from required leaf rejected', v => { v.windowsTestSet.returnedProofSha256 = digest; }],
  ['missing original ZIP/executable bridge rejected', v => { delete v.windowsExecutable; }],
  ['ZIP hash cannot replace qTox shipping executable hash', v => { v.qtox.targets[0].artifactSha256 = v.units.windows.artifactSha256.toUpperCase(); }],
  ['wrong inspected ZIP rejected', v => { v.windowsExecutable.receipt.archive.sha256 = digest; }],
  ['wrong inspected ZIP size rejected', v => { v.windowsExecutable.receipt.archive.bytes++; }],
  ['wrong inspected EXE rejected', v => { v.windowsExecutable.receipt.executable.sha256 = digest; }],
  ['noncanonical inspected EXE rejected', v => { v.windowsExecutable.receipt.executable.path = 'Kaigen.exe'; }],
  ['wrong inspection source rejected', v => { v.windowsExecutable.receipt.source = { commit: '1'.repeat(40), tree: '2'.repeat(40) }; }],
  ['wrong inspection build rejected', v => { v.windowsExecutable.receipt.buildId = 'another-candidate'; }],
  ['untrusted archive validator rejected even with coherent receipt and plan hashes', v => {
    v.windowsExecutable.receipt.validatorSha256 = digest;
    v.windowsExecutable.receiptSha256 = hashed(JSON.stringify(v.windowsExecutable.receipt, null, 2) + '\n');
    const leaf = v.units.windows.leaves.find(item => item.role === 'archive-executable');
    leaf.validatorSha256 = digest; leaf.receiptSha256 = v.windowsExecutable.receiptSha256;
    v.plan.groups.windows.leaves.find(item => item.role === 'archive-executable').validatorSha256 = digest; v.planSha256 = canonicalDigest(v.plan);
  }],
  ['forged bridge and matching qTox hash cannot replace original executed inspection', v => {
    v.windowsExecutable.receipt.executable.sha256 = digest; v.qtox.targets[0].artifactSha256 = digest.toUpperCase();
    v.windowsExecutable.receiptSha256 = hashed(JSON.stringify(v.windowsExecutable.receipt, null, 2) + '\n');
  }],
  ['archive inspection cannot be reused instead of executed', v => {
    const leaf = v.units.windows.leaves.find(item => item.role === 'archive-executable'); leaf.disposition = 'reused';
    leaf.reuse = { inputsSha256: leaf.inputsSha256, artifactSha256: leaf.artifactSha256, runnerSha256: leaf.runnerSha256, originalReceiptSha256: leaf.receiptSha256 };
  }],
  ['mandatory archive inspection cannot disappear with recomputed plan', v => {
    v.units.windows.leaves = v.units.windows.leaves.filter(item => item.role !== 'archive-executable');
    v.plan.groups.windows.leaves = v.plan.groups.windows.leaves.filter(item => item.role !== 'archive-executable'); v.planSha256 = canonicalDigest(v.plan);
  }],
  ['qTox child ID cannot be relabelled as a different parent ID', v => { v.qtox.identity.buildId += '-web'; }],
  ['qTox missing Web target rejected', v => { v.qtox.targets.pop(); }],
  ['qTox wrong candidate artifact rejected', v => { v.qtox.targets[0].artifactSha256 = digest.toUpperCase(); }],
  ['qTox incomplete screenshot evidence rejected', v => { v.qtox.targets[0].screenshots = 0; }],
  ['qTox wrong official fixture rejected', v => { v.qtox.identity.qtoxFixtureSha256 = digest.toUpperCase(); }],
  ['qTox same desktop and Web receipt rejected', v => { v.qtox.targets[1].receiptSha256 = v.qtox.targets[0].receiptSha256; }],
  ['qTox production contact rejected', v => { v.qtox.productionContacted = true; }],
  ['final Windows smoke wrong source rejected', v => { v.finalActions.windowsSmoke.source = { commit: '1'.repeat(40), tree: '2'.repeat(40) }; }],
  ['final Web bundle digest substitution rejected', v => { v.finalActions.webBundle.artifactSha256 = v.units.web.artifactSha256; }],
  ['final runtime check cannot be a reuse label', v => {
    const leaf = v.finalActions.windowsSmoke; leaf.disposition = 'reused';
    leaf.reuse = { inputsSha256: leaf.inputsSha256, artifactSha256: leaf.artifactSha256, runnerSha256: leaf.runnerSha256, originalReceiptSha256: leaf.receiptSha256 };
  }],
]) rejects(name, gate.gates, mutate, value => assertReleaseGates(value, gate.context));
test('exact preserved candidate evidence may be reused explicitly', () => {
  const value = clone(gate.gates), leaf = value.units.debian.leaves[0]; leaf.disposition = 'reused';
  leaf.reuse = { inputsSha256: leaf.inputsSha256, artifactSha256: leaf.artifactSha256, runnerSha256: leaf.runnerSha256, originalReceiptSha256: leaf.receiptSha256 };
  assertReleaseGates(value, gate.context);
});

// Synthetic Git records exercise the proof algorithm; they are not build evidence.
const previousSource = { commit: 'd'.repeat(40), tree: 'e'.repeat(40) };
const treeRecords = entries => Buffer.from(entries.map(entry => `${entry.mode ?? '100644'} ${entry.type ?? 'blob'} ${entry.objectId}\t${entry.path}\0`).join(''));
const beforeRecords = [
  { path: 'scripts/current-verification.mjs', objectId: '1'.repeat(40) },
  { path: 'src-tauri/src/lib.rs', objectId: '2'.repeat(40) },
  { path: 'scripts/build-macos.sh', objectId: '3'.repeat(40) },
];
const afterRecords = clone(beforeRecords); afterRecords[0].objectId = '4'.repeat(40);
const proofInput = { builtFrom: previousSource, verificationSource: source, version: manifest.version,
  beforeTree: treeRecords(beforeRecords), afterTree: treeRecords(afterRecords),
  readBlob: (revision, filename) => Buffer.from(revision.commit + ':' + filename), diff: Buffer.from('synthetic exact verification-only diff') };
const revisionProof = verificationRevisionProof(proofInput);
test('verification proof retains exact original/current source and hashes changed and unchanged Git records', () => {
  assert.deepEqual(revisionProof.builtFrom, previousSource); assert.deepEqual(revisionProof.verificationSource, source);
  assert.deepEqual(revisionProof.changedFiles.map(file => file.path), ['scripts/current-verification.mjs']);
  assert.equal(revisionProof.unchangedFileCount, 2); assert.equal(revisionProof.diffSha256, hashed(proofInput.diff));
  assert.notEqual(revisionProof.changedFiles[0].before.sha256, revisionProof.changedFiles[0].after.sha256);
  assert.ok(!verificationRevisionPaths(manifest.version).includes('scripts/build-macos.sh'));
});
for (const [name, mutate] of [
  ['product code change', records => { records[1].objectId = '5'.repeat(40); }],
  ['build recipe change', records => { records[2].objectId = '5'.repeat(40); }],
  ['verification file executable-bit change', records => { records[0].mode = '100755'; }],
  ['verification file symlink change', records => { records[0].mode = '120000'; }],
  ['verification file deletion', records => { records.shift(); }],
  ['unknown test path addition', records => { records.push({ path: 'scripts/test-unregistered.mjs', objectId: '5'.repeat(40) }); }],
  ['duplicate Git record', records => { records.push(clone(records[0])); }],
]) test('source closure rejects ' + name, () => {
  const records = clone(afterRecords); mutate(records);
  assert.throws(() => verificationRevisionProof({ ...proofInput, afterTree: treeRecords(records) }));
});

const metadataPaths = ['ci/releases/v0.2.9.9.json', 'ci/releases/evidence/v0.2.9.9/gate.json'];
test('only exact current-release manifest and gate may be added with full immutable blob identity', () => {
  const records = [...afterRecords, ...metadataPaths.map(filename => ({ path: filename, objectId: '6'.repeat(40) }))];
  const proof = verificationRevisionProof({ ...proofInput, afterTree: treeRecords(records) });
  for (const filename of metadataPaths) {
    const addition = proof.changedFiles.find(file => file.path === filename);
    assert.equal(addition.before, null); assert.equal(addition.after.mode, '100644');
    const bytes = proofInput.readBlob(source, filename);
    assert.equal(addition.after.sha256, hashed(bytes)); assert.equal(addition.after.bytes, bytes.length);
    assert.equal(addition.after.objectId, '6'.repeat(40));
  }
  assert.equal(proof.unchangedFileCount, revisionProof.unchangedFileCount);
});
for (const [name, record] of [
  ['wrong release manifest', { path: 'ci/releases/v0.2.9.10.json' }],
  ['wrong release gate', { path: 'ci/releases/evidence/v0.2.9.10/gate.json' }],
  ['unknown evidence sibling', { path: 'ci/releases/evidence/v0.2.9.9/other.json' }],
  ['new verification executable', { path: 'scripts/test-publish-release.mjs' }],
  ['new release document', { path: 'openspec/changes/release-v0-2-9-9/design.md' }],
  ['new workflow', { path: '.github/workflows/publish-release.yml' }],
  ['executable manifest', { path: metadataPaths[0], mode: '100755' }],
  ['symlink gate', { path: metadataPaths[1], mode: '120000' }],
  ['submodule manifest', { path: metadataPaths[0], mode: '160000', type: 'commit' }],
]) test('controller metadata additions reject ' + name, () => {
  assert.throws(() => verificationRevisionProof({ ...proofInput, afterTree: treeRecords([...afterRecords, { objectId: '6'.repeat(40), ...record }]) }));
});
test('empty added metadata cannot claim a content hash', () => {
  assert.throws(() => verificationRevisionProof({ ...proofInput,
    afterTree: treeRecords([...afterRecords, { path: metadataPaths[0], objectId: '6'.repeat(40) }]),
    readBlob: () => Buffer.alloc(0) }));
});
test('an existing release metadata file cannot be removed or change its mode', () => {
  const records = [...beforeRecords, { path: metadataPaths[0], objectId: '6'.repeat(40) }];
  assert.throws(() => verificationRevisionProof({ ...proofInput, beforeTree: treeRecords(records), afterTree: treeRecords(afterRecords) }));
  const changed = [...afterRecords, { path: metadataPaths[0], objectId: '6'.repeat(40), mode: '100755' }];
  assert.throws(() => verificationRevisionProof({ ...proofInput, beforeTree: treeRecords(records), afterTree: treeRecords(changed) }));
});

// Real local Git fixture verifies the same immutable ancestry/tree/blob path used
// by verifySource. These synthetic commits are tests, never candidate evidence.
const controllerFixture = await mkdtemp(path.join(tmpdir(), 'kaigen-publisher-controller-'));
const callerRoot = process.cwd();
try {
  const localGit = (...args) => execFileSync('git', ['-c', 'safe.directory=' + controllerFixture,
    '-c', 'user.name=Kaigen Controller Fixture', '-c', 'user.email=controller-fixture@example.invalid',
    '-c', 'core.autocrlf=false', '-c', 'core.hooksPath=' + path.join(controllerFixture, 'no-hooks'), ...args],
  { cwd: controllerFixture, windowsHide: true }).toString('utf8').trim();
  const put = async (filename, text) => {
    const target = path.join(controllerFixture, filename); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, text);
  };
  const tuple = () => ({ commit: localGit('rev-parse', 'HEAD'), tree: localGit('rev-parse', 'HEAD^{tree}') });
  localGit('init', '--quiet', '--initial-branch=main');
  localGit('config', '--local', 'core.longpaths', 'true');
  await put('ci/verification-current.json', '{"synthetic":"desktop-and-web-scale"}\n');
  await put('scripts/test-current-verification-contract.mjs', '// synthetic old contract\n');
  await put('openspec/changes/release-v0-2-9-9/tasks.md', 'Synthetic original release tasks\n');
  await put('src-tauri/src/lib.rs', '// synthetic frozen product bytes\n');
  await put('scripts/build-macos.sh', '# synthetic frozen build recipe\n');
  await put('.github/workflows/build-windows.yml', '# synthetic frozen producer workflow\n');
  localGit('add', '.'); localGit('commit', '--quiet', '-m', 'Synthetic producer source'); const builtFrom = tuple();
  await put('ci/verification-current.json', '{"synthetic":"desktop-only-scale"}\n');
  await put('scripts/test-current-verification-contract.mjs', '// synthetic corrected applicability contract\n');
  localGit('add', '.'); localGit('commit', '--quiet', '-m', 'Synthetic applicability controller'); const applicability = tuple();
  process.chdir(controllerFixture);
  test('actual Git applicability-only controller preserves producer source and full product/build closure', () => {
    const proof = gitVerificationRevision(builtFrom, applicability, manifest.version);
    assert.deepEqual(proof.builtFrom, builtFrom); assert.deepEqual(proof.verificationSource, applicability);
    assert.deepEqual(proof.changedFiles.map(file => file.path), ['ci/verification-current.json', 'scripts/test-current-verification-contract.mjs']);
    assert.equal(proof.unchangedFileCount, 4);
    assert.equal(proof.changedFiles[0].after.sha256, hashed(Buffer.from('{"synthetic":"desktop-only-scale"}\n')));
  });
  await put('openspec/changes/release-v0-2-9-9/tasks.md', 'Synthetic completed release tasks\n');
  await put(metadataPaths[0], '{"synthetic":"release-manifest"}\n');
  await put(metadataPaths[1], '{"synthetic":"gate-receipts"}\n');
  localGit('add', '.'); localGit('commit', '--quiet', '-m', 'Synthetic reviewed release metadata'); const controller = tuple();
  test('actual Git controller permits exact manifest/gate additions plus existing release docs after applicability correction', () => {
    const proof = gitVerificationRevision(builtFrom, controller, manifest.version);
    assert.deepEqual(proof.builtFrom, builtFrom); assert.deepEqual(proof.verificationSource, controller);
    assert.equal(proof.changedFiles.length, 5); assert.equal(proof.unchangedFileCount, 3);
    for (const filename of metadataPaths) {
      const file = proof.changedFiles.find(item => item.path === filename); assert.equal(file.before, null);
      const content = execFileSync('git', ['-c', 'safe.directory=' + controllerFixture, 'show', controller.commit + ':' + filename], { cwd: controllerFixture });
      assert.equal(file.after.sha256, hashed(content)); assert.equal(file.after.bytes, content.length);
    }
  });
  test('actual Git controller rejects forged producer/controller trees and reversed ancestry', () => {
    assert.throws(() => gitVerificationRevision({ ...builtFrom, tree: '0'.repeat(40) }, controller, manifest.version));
    assert.throws(() => gitVerificationRevision(builtFrom, { ...controller, tree: '0'.repeat(40) }, manifest.version));
    assert.throws(() => gitVerificationRevision(controller, builtFrom, manifest.version));
  });
  for (const [name, filename] of [['product bytes', 'src-tauri/src/lib.rs'], ['build recipe', 'scripts/build-macos.sh'], ['workflow', '.github/workflows/build-windows.yml']]) {
    await put(filename, 'Synthetic forbidden change\n'); localGit('add', '.'); localGit('commit', '--quiet', '-m', 'Synthetic negative ' + name);
    const forbidden = tuple();
    test('actual Git controller rejects changed ' + name, () => assert.throws(() => gitVerificationRevision(builtFrom, forbidden, manifest.version)));
  }
} finally { process.chdir(callerRoot); await rm(controllerFixture, { recursive: true, force: true }); }

function retainedGateFixture() {
  const value = gateFixture(), { gates, context } = value;
  gates.verificationRevisions = [clone(revisionProof)]; context.verificationRevisionProofs = [clone(revisionProof)];
  for (const platform of ['debian', 'macos']) {
    const unit = gates.units[platform];
    unit.builtFrom = { source: previousSource, buildId: 'synthetic-original-b3', sourceArchiveSha256: hashed('original-b3-source-archive') };
    const receipt = { schemaVersion: 1, kind: 'kaigen-retained-artifact-verification', status: 'PASS', platform, builtFrom: clone(unit.builtFrom), verificationSource: source,
      artifactSha256: unit.artifactSha256, originalArtifactReceiptSha256: hashed(platform + '-original-build-receipt'),
      originalArtifactValidatorSha256: hashed('registered-lab-validator'),
      sourceEquivalenceSha256: canonicalDigest(revisionProof), validatorSha256: context.archiveExecutableValidatorSha256 };
    unit.artifactVerification = { receiptSha256: hashed(JSON.stringify(receipt, null, 2) + '\n'), receipt };
    const spec = { id: platform + ':artifact-verification', role: 'artifact-verification', validatorId: 'publisher-retained-artifact', validatorSha256: context.archiveExecutableValidatorSha256 };
    gates.plan.groups[platform].leaves.push(spec);
    unit.leaves.push({ ...spec, status: 'PASS', source, artifactSha256: unit.artifactSha256, runnerSha256: unit.runnerSha256,
      inputsSha256: gates.plan.groups[platform].inputsSha256, receiptSha256: unit.artifactVerification.receiptSha256, disposition: 'executed', reuse: null });
  }
  gates.planSha256 = canonicalDigest(gates.plan);
  return value;
}
const retainedGate = retainedGateFixture();
const labArtifact = { name: 'Kaigen-portable-debian-x64.zip', sha256: retainedGate.gates.units.debian.artifactSha256, bytes: 123 };
const labValidator = hashed('registered-lab-validator');
const labReceipt = { schemaVersion: 1, kind: 'kaigen-lab-candidate-artifact', status: 'PASS', platform: 'debian',
  builtFrom: clone(retainedGate.gates.units.debian.builtFrom), artifact: labArtifact,
  evidence: Object.fromEntries(['sourceMarkerSha256', 'buildStatusSha256', 'buildLogSha256', 'collectionLogSha256', 'sourceSnapshotManifestSha256'].map(key => [key, hashed(key)])),
  validator: { id: 'kaigen-lab-candidate-artifact', sha256: labValidator } };
const checkLab = value => assertLabArtifactReceipt(value, { producerValidatorSha256: labValidator, artifact: labArtifact });
test('registered Lab receipt binds original source evidence and actual ZIP bytes to approved collector code', () => checkLab(labReceipt));
for (const [name, mutate] of [
  ['manual checkpoint is not a producer receipt', value => { value.kind = 'COMPILED_ONLY'; }],
  ['failed original build', value => { value.status = 'FAIL'; }],
  ['wrong producer validator', value => { value.validator.sha256 = digest; }],
  ['wrong producer identity', value => { value.validator.id = 'unregistered'; }],
  ['missing actual source marker', value => { delete value.evidence.sourceMarkerSha256; }],
  ['missing original snapshot manifest', value => { delete value.evidence.sourceSnapshotManifestSha256; }],
  ['unbound status evidence', value => { value.evidence.buildStatusSha256 = 'PASS'; }],
  ['wrong retained ZIP hash', value => { value.artifact.sha256 = digest; }],
  ['wrong retained ZIP size', value => { value.artifact.bytes++; }],
  ['wrong native archive name', value => { value.artifact.name = 'alternate.zip'; }],
  ['private source path', value => { value.evidence.privatePath = 'private'; }],
]) rejects('Lab receipt rejects ' + name, labReceipt, mutate, checkLab);
test('B3 Debian/macOS ZIPs retain builtFrom while current B4 validators cover the exact retained bytes', () => assertReleaseGates(retainedGate.gates, retainedGate.context));
for (const [name, mutate] of [
  ['missing independently recomputed proof', value => { value.verificationRevisions = []; }],
  ['forged proof body', value => { value.verificationRevisions[0].diffSha256 = digest; }],
  ['forged preserved input inventory', value => { value.verificationRevisions[0].unchangedFileCount--; }],
  ['relabelled original build tree', value => { value.units.debian.builtFrom.source.tree = '6'.repeat(40); }],
  ['wrong original build ID', value => { value.units.debian.builtFrom.buildId = 'other-original-build'; }],
  ['wrong original source archive', value => { value.units.debian.builtFrom.sourceArchiveSha256 = digest; }],
  ['missing fresh owner receipt', value => { value.units.debian.artifactVerification = null; }],
  ['same-source proof cannot cover another retained ZIP', value => { value.units.debian.artifactVerification.receipt.artifactSha256 = digest; }],
  ['same-source proof cannot relabel a different native platform', value => { value.units.debian.artifactVerification.receipt.platform = 'macos'; }],
  ['old validator source cannot impersonate current verification', value => { value.units.debian.leaves[0].source = previousSource; }],
  ['owner receipt cannot erase baseline coverage', value => { value.units.debian.leaves = value.units.debian.leaves.filter(leaf => leaf.role !== 'baseline'); }],
  ['arbitrary retained validator', value => { value.units.debian.artifactVerification.receipt.validatorSha256 = digest; }],
  ['old Web cannot be relabelled under current qTox identity', value => { value.units.web.builtFrom = clone(value.units.debian.builtFrom); }],
]) rejects('retained native artifact rejects ' + name, retainedGate.gates, mutate, value => assertReleaseGates(value, retainedGate.context));
test('self-authored coherent proof cannot replace independent Git recomputation', () => {
  const value = clone(retainedGate.gates); value.verificationRevisions[0].changedFiles = [];
  for (const platform of ['debian', 'macos']) {
    const unit = value.units[platform]; unit.artifactVerification.receipt.sourceEquivalenceSha256 = canonicalDigest(value.verificationRevisions[0]);
    unit.artifactVerification.receiptSha256 = hashed(JSON.stringify(unit.artifactVerification.receipt, null, 2) + '\n');
    unit.leaves.find(leaf => leaf.role === 'artifact-verification').receiptSha256 = unit.artifactVerification.receiptSha256;
  }
  assert.throws(() => assertReleaseGates(value, retainedGate.context));
});

const nativeJob = { id: 'pq-fault-desktop', expectedTests: 1, ignored: false, selectors: ['pq::test'], limits: { seconds: 120, workingSetMiB: 512, fixtureMiB: 64 } };
const nativeStdout = Buffer.from('test pq::test ... ok\n\ntest result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 1 filtered out;\n');
const nativeStderr = Buffer.from(''); const nativeResource = { status: 'PASS' };
const nativeInputs = [{ path: 'src-tauri/src/lib.rs', sha256: digest }];
const nativeResult = { schema: 1, kind: 'kaigen-extended-native-result', job: nativeJob.id, status: 'PASS', host: { platform: 'win32' }, selectedMode: 'ordinary',
  limits: nativeJob.limits, resource: nativeResource, output: { stdoutSha256: hashed(nativeStdout), stderrSha256: hashed(nativeStderr) },
  discovery: { names: ['pq::test', 'unselected::test'], ignoredNames: [], selectedNames: ['pq::test'], selected: 1, total: 2 },
  counts: { discovered: 1, executed: 1, passed: 1, failed: 0, skipped: 0, filteredOut: 1, names: ['pq::test'] },
  source: { inputs: nativeInputs, sha256: hashed(JSON.stringify(nativeInputs)) } };
test('native receipt is bound to actual selected test output and resource document', () => assertNativeEvidence(nativeResult, nativeJob, nativeStdout, nativeStderr, nativeResource));
for (const [name, mutate] of [
  ['native claimed count differs from raw output', v => { v.counts.passed = 2; }],
  ['native wrong selected test', v => { v.discovery.selectedNames = ['wrong::test']; }],
  ['native missing test output digest', v => { v.output.stdoutSha256 = digest; }],
  ['native raw resource differs from receipt', v => { v.resource.modified = true; }],
  ['native input fingerprint changed', v => { v.source.inputs[0].sha256 = 'd'.repeat(64); }],
  ['native absolute input path rejected', v => { v.source.inputs[0].path = 'C:/private/input'; }],
  ['native skipped mode rejected', v => { v.selectedMode = 'ignored-only'; }],
]) rejects(name, nativeResult, mutate, value => assertNativeEvidence(value, nativeJob, nativeStdout, nativeStderr, nativeResource));
test('native false PASS cannot substitute failed stdout', () => {
  const badOutput = Buffer.from(nativeStdout.toString().replace('... ok', '... FAILED'));
  const value = clone(nativeResult); value.output.stdoutSha256 = hashed(badOutput);
  assert.throws(() => assertNativeEvidence(value, nativeJob, badOutput, nativeStderr, nativeResource));
});

const temporary = await mkdtemp(path.join(tmpdir(), 'kaigen-publisher-test-'));
try {
  const python = process.platform === 'win32' ? 'python' : 'python3';
  const archive = path.join(temporary, 'input.zip');
  for (const [name, entries, ok] of [
    ['ordinary artifact extraction', [['file.json', 0]], true],
    ['zip parent traversal rejected', [['../outside', 0]], false],
    ['zip absolute path rejected', [['/outside', 0]], false],
    ['zip Windows separator rejected', [['..\\outside', 0]], false],
    ['zip symlink rejected', [['link', 0o120777]], false],
    ['zip duplicate case-folded entry rejected', [['file', 0], ['FILE', 0]], false],
  ]) {
    execFileSync(python, ['-c', 'import json,sys,zipfile\nwith zipfile.ZipFile(sys.argv[1],"w") as z:\n for name,mode in json.loads(sys.argv[2]):\n  i=zipfile.ZipInfo(name); i.external_attr=mode<<16; z.writestr(i,b"proof")', archive, JSON.stringify(entries)]);
    test(name, () => {
      const result = spawnSync(python, ['-c', EXTRACT_ARTIFACT, archive, path.join(temporary, 'files')], { encoding: 'utf8' });
      assert.equal(result.status === 0, ok, result.stderr);
    });
  }
  const executable = path.join(temporary, 'Kaigen.exe'), executableBytes = Buffer.from('MZ synthetic shipping executable; never execute');
  await writeFile(executable, executableBytes);
  const writeZip = entries => execFileSync(python, ['-c', 'import json,sys,zipfile\nwith zipfile.ZipFile(sys.argv[1],"w",compression=zipfile.ZIP_DEFLATED) as z:\n for name,mode,content in json.loads(sys.argv[2]):\n  i=zipfile.ZipInfo(name); i.external_attr=mode<<16; i.compress_type=zipfile.ZIP_DEFLATED; z.writestr(i,bytes.fromhex(content))', archive, JSON.stringify(entries)]);
  const validEntry = ['Kaigen-portable/Kaigen.exe', 0o100644, executableBytes.toString('hex')];
  writeZip([validEntry, ['Kaigen-portable/PORTABLE.txt', 0o100644, Buffer.from('synthetic portable').toString('hex')]]);
  test('actual ZIP inspection binds distinct ZIP and shipping EXE digests through the complete gate', () => {
    const observed = inspectWindowsArchive(archive, executable);
    assert.equal(observed.executable.sha256, hashed(executableBytes)); assert.equal(observed.executable.bytes, executableBytes.length);
    assert.notEqual(observed.archive.sha256, observed.executable.sha256);
    const value = gateFixture(observed); assertReleaseGates(value.gates, value.context);
  });
  for (const [name, entries] of [
    ['wrong ZIP shipping bytes rejected', [[validEntry[0], 0o100644, Buffer.from('different bytes with no matching shipping executable').toString('hex')]]],
    ['same-size wrong ZIP shipping bytes rejected', [[validEntry[0], 0o100644, Buffer.alloc(executableBytes.length, 1).toString('hex')]]],
    ['missing shipping EXE rejected', [['Kaigen-portable/readme.txt', 0o100644, '31']]],
    ['duplicate shipping EXE rejected', [validEntry, validEntry]],
    ['case-alias shipping EXE rejected', [validEntry, ['Kaigen-portable/KAIGEN.EXE', 0o100644, validEntry[2]]]],
    ['trailing-dot Windows shipping EXE alias rejected', [validEntry, ['Kaigen-portable/Kaigen.exe.', 0o100644, validEntry[2]]]],
    ['trailing-space Windows shipping EXE alias rejected', [validEntry, ['Kaigen-portable/Kaigen.exe ', 0o100644, validEntry[2]]]],
    ['alternate shipping EXE path rejected', [validEntry, ['other/Kaigen.exe', 0o100644, validEntry[2]]]],
    ['symlink shipping EXE rejected', [[validEntry[0], 0o120777, validEntry[2]]]],
    ['directory shipping EXE rejected', [[validEntry[0], 0o40755, validEntry[2]]]],
    ['unsafe adjacent ZIP entry rejected', [validEntry, ['../outside.txt', 0o100644, '31']]],
    ['Windows traversal ZIP entry rejected', [validEntry, ['..\\outside.txt', 0o100644, '31']]],
    ['noncanonical shipping path rejected', [['Kaigen-portable/./Kaigen.exe', 0o100644, validEntry[2]]]],
  ]) {
    writeZip(entries);
    test(name, () => assert.throws(() => inspectWindowsArchive(archive, executable)));
  }
  writeZip([['Kaigen-portable\\Kaigen.exe', 0o100644, validEntry[2]]]);
  test('Windows ZIP separator is canonicalized safely before executable matching', () => assert.equal(inspectWindowsArchive(archive, executable).executable.sha256, hashed(executableBytes)));
  writeZip([validEntry]); await writeFile(executable, Buffer.alloc(executableBytes.length, 2));
  test('wrong actual shipping EXE is rejected against unchanged ZIP', () => assert.throws(() => inspectWindowsArchive(archive, executable)));
  test('ambient Python optimization cannot disable archive validation', () => {
    const previous = process.env.PYTHONOPTIMIZE;
    try { process.env.PYTHONOPTIMIZE = '1'; assert.throws(() => inspectWindowsArchive(archive, executable)); }
    finally { if (previous === undefined) delete process.env.PYTHONOPTIMIZE; else process.env.PYTHONOPTIMIZE = previous; }
  });
} finally { await rm(temporary, { recursive: true, force: true }); }

const script = await readFile(new URL('./publish-release.mjs', import.meta.url), 'utf8');
const workflow = await readFile(new URL('../.github/workflows/publish-release.yml', import.meta.url), 'utf8');
test('publisher has no clobber/delete/tag replacement path', () => {
  assert.ok(!script.includes('--clobber')); assert.ok(!script.includes("method: 'DELETE'")); assert.ok(!script.includes("api('git/refs', { method: 'PATCH'"));
});
test('manual trusted workflow never interpolates dispatch input into shell', () => {
  assert.ok(workflow.includes('workflow_dispatch:')); assert.ok(!/^  (push|pull_request|workflow_run):/m.test(workflow));
  assert.ok(workflow.includes('KAIGEN_RELEASE_MANIFEST_SHA256: ${{ inputs.manifest_sha256 }}'));
  assert.ok(!/run:.*\$\{\{ inputs\./.test(workflow));
});
console.log(`Publisher trust checks: ${checks} PASS`);
