import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, readdir, stat, copyFile } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPOSITORY = 'kaigendev/Kaigen';
export const PRODUCT_COMMIT = '724dea3b287f68d5d25700e6cda32b8f161a1296';
const PRODUCT_TREE = 'ddcfeae83ba43a99f174ce01d074501fb5ea73b1';
const DOCUMENT_COMMIT = '6a8fc5caf736c52fbe998997363394c42447f55c';
const DOCUMENT_TREE = '430a0901cd0fcba084cadba87253949c4b3bf8ba';
const RELEASE_ID = 403141563;
const TAG = 'v0.2.9.8';
const TAG_OBJECT = '5b8466f589d4f74611b4b7583c9aa2005c49dda0';
const HASH = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const CHANGE = 'openspec/changes/correct-release-0298-actions-publication/';
export const CORRECTION_PATHS = new Set([
  '.github/workflows/build-windows.yml', '.github/workflows/regression-extended.yml',
  '.github/workflows/publish-release-0298.yml', 'scripts/ci-incremental-verification.mjs',
  'scripts/test-ci-incremental-verification.mjs', 'scripts/publish-actions-release.mjs',
  'ci/verification-v0.2.9.8.json',
  ...['.openspec.yaml', 'proposal.md', 'design.md', 'tasks.md'].map(name => CHANGE + name),
]);
export const PRODUCERS = [
  { id: 333598718, name: 'build-kaigen-windows-portable', path: '.github/workflows/build-windows.yml', jobs: ['build'] },
  { id: 333598717, name: 'build-kaigen-linux-macos-portable', path: '.github/workflows/build-unix.yml', jobs: ['debian-appimage', 'macos-universal', 'web-debian13-nginx'] },
  { id: 374774956, name: 'extended-native-regressions', path: '.github/workflows/regression-extended.yml', jobs: ['pq-fault-desktop', 'pq-fault-web-core'] },
];
const FILES = {
  windows: [['Kaigen-portable-windows-x64.zip', 'Kaigen-portable-windows-x64.zip'], ['Kaigen-installer-windows-x64.msi', 'Kaigen-installer-windows-x64.msi']],
  debian: [['Kaigen-portable-debian-x64.zip', 'Kaigen-portable-debian-x64.zip']],
  macos: [['Kaigen-portable-macos-universal.zip', 'Kaigen-portable-macos-universal.zip']],
  web: [['Kaigen-Web-Debian13-Nginx-0.2.9.8.tar.gz', 'Kaigen-Web-Debian13-Nginx-0.2.9.8.tar.gz'], ['Kaigen-Web-Installer-0.2.9.8.sh', 'Kaigen-Web-Installer-0.2.9.8.sh']],
};
export const PUBLIC_NAMES = [...Object.values(FILES).flat().map(([, name]) => name), 'Kaigen-source-0.2.9.8.zip'].sort();
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const git = (...args) => execFileSync('git', ['-c', 'safe.directory=' + process.cwd(), ...args], { encoding: 'utf8' }).trim();
const json = async name => JSON.parse(await readFile(name, 'utf8'));
async function fileHash(name) { const hash = createHash('sha256'); for await (const data of createReadStream(name)) hash.update(data); return hash.digest('hex'); }
const save = async (name, value) => writeFile(name, JSON.stringify(value, null, 2) + '\n');
const command = (program, args) => {
  const result = spawnSync(program, args, { encoding: 'utf8', stdio: 'inherit' });
  assert.equal(result.status, 0, 'command failed: ' + program); return result;
};
export function assertCorrectionPaths(paths) {
  assert.ok(paths.length > 0 && paths.every(name => CORRECTION_PATHS.has(name)), 'unexpected product or producer changes after the document-only reference');
}
export function assertTrustedRun(run, producer, source) {
  assert.ok(COMMIT.test(source));
  assert.equal(run.workflow_id, producer.id); assert.equal(run.name, producer.name);
  assert.equal(run.path, producer.path); assert.equal(run.event, 'push');
  assert.equal(run.head_branch, 'main'); assert.equal(run.head_sha, source);
  assert.equal(run.repository?.full_name, REPOSITORY); assert.equal(run.head_repository?.full_name, REPOSITORY);
  assert.ok(Number.isSafeInteger(run.id) && Number.isSafeInteger(run.run_attempt));
}
export function assertVerification(receipt, platform, source, tree, selection, checkIds) {
  assert.equal(receipt.kind, 'kaigen-ci-incremental-verification'); assert.equal(receipt.status, 'PASS');
  assert.equal(receipt.repository, REPOSITORY); assert.equal(receipt.platform, platform);
  assert.equal(receipt.builtFrom?.commit, source); assert.equal(receipt.builtFrom?.tree, tree);
  assert.equal(receipt.productReference?.commit, PRODUCT_COMMIT); assert.equal(receipt.productReference?.tree, PRODUCT_TREE);
  assert.equal(receipt.verificationReference?.commit, DOCUMENT_COMMIT);
  assert.equal(receipt.fullBaselineRerun, true); assert.equal(receipt.selectionSha256, selection);
  assert.equal(receipt.equivalence?.unchangedOutsideCiPaths, true);
  assert.ok(equal(receipt.checks.map(check => check.id).sort(), [...checkIds].sort()), 'missing, duplicate or extra current checks');
  for (const check of receipt.checks) {
    assert.equal(check.disposition, 'rerun'); assert.equal(check.source?.commit, source);
    assert.equal(check.source?.tree, tree); assert.match(check.outputSha256, HASH);
  }
}
async function api(endpoint, { method = 'GET', body, accept = 'application/vnd.github+json', raw = false } = {}) {
  const response = await fetch('https://api.github.com/repos/' + REPOSITORY + '/' + endpoint, {
    method, headers: { Authorization: 'Bearer ' + process.env.GITHUB_TOKEN, Accept: accept,
      'X-GitHub-Api-Version': '2022-11-28', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), redirect: raw ? 'manual' : 'follow',
  });
  if (raw) return response;
  assert.ok(response.ok, 'GitHub API ' + method + ' ' + endpoint + ': ' + response.status);
  return response.status === 204 ? null : response.json();
}
async function download(url, destination, expected) {
  const response = await fetch(url); assert.ok(response.ok, 'artifact download failed: ' + response.status);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination, { flags: 'wx' }));
  const digest = await fileHash(destination); if (expected) assert.equal(digest, expected, 'downloaded bytes differ from the Actions/server digest');
  return digest;
}
async function releaseIdentity({ allowIncompleteDraft = false } = {}) {
  const tag = await api('git/ref/tags/' + TAG); assert.equal(tag.object?.sha, TAG_OBJECT);
  const object = await api('git/tags/' + TAG_OBJECT); assert.equal(object.object?.sha, PRODUCT_COMMIT);
  const release = await api('releases/' + RELEASE_ID);
  assert.equal(release.tag_name, TAG); assert.equal(release.immutable, false);
  const names = release.assets.map(asset => asset.name).sort();
  assert.ok(new Set(names).size === names.length && (equal(names, PUBLIC_NAMES)
    || (allowIncompleteDraft && release.draft && names.every(name => PUBLIC_NAMES.includes(name)))), 'unexpected current public asset set');
  return release;
}
async function verifySource() {
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'publication is Actions-only');
  assert.equal(process.env.GITHUB_REPOSITORY, REPOSITORY);
  assert.equal(process.env.GITHUB_WORKFLOW_REF, REPOSITORY + '/.github/workflows/publish-release-0298.yml@refs/heads/main');
  const source = git('rev-parse', 'HEAD'), tree = git('rev-parse', 'HEAD^{tree}');
  assert.match(source, COMMIT); assert.equal(source, process.env.GITHUB_SHA);
  assert.equal(git('rev-parse', TAG + '^{}'), PRODUCT_COMMIT);
  assert.equal(git('rev-parse', PRODUCT_COMMIT + '^{tree}'), PRODUCT_TREE);
  assert.equal(git('rev-parse', DOCUMENT_COMMIT + '^{tree}'), DOCUMENT_TREE);
  assert.equal(git('merge-base', DOCUMENT_COMMIT, source), DOCUMENT_COMMIT);
  const documentPaths = git('diff', '--name-only', PRODUCT_COMMIT, DOCUMENT_COMMIT).split('\n').filter(Boolean);
  assert.ok(documentPaths.every(name => name.startsWith('openspec/changes/fix-release-0298-product-defects/')
    || name.startsWith('openspec/changes/archive/2026-10-04-fix-release-0298-product-defects/')
    || ['openspec/specs/attachment-file-reveal/spec.md', 'openspec/specs/pq-establishment-history/spec.md', 'openspec/specs/web-shell/spec.md'].includes(name)));
  const changes = git('diff', '--name-only', DOCUMENT_COMMIT, source).split('\n').filter(Boolean); assertCorrectionPaths(changes);
  assert.equal((await api('branches/main')).commit.sha, source, 'stale publication source');
  assert.equal((await json('package.json')).version, '0.2.9+8');
  const catalogBytes = await readFile('ci/verification-v0.2.9.8.json'), catalog = JSON.parse(catalogBytes);
  assert.equal(catalog.selectionScope, 'release-0298-full'); assert.equal(catalog.productSource.commit, PRODUCT_COMMIT);
  assert.equal(catalog.referenceSource.commit, DOCUMENT_COMMIT);
  await stat(CHANGE + 'tasks.md'); // An archived correction must not activate a later release.
  return { source, tree, changes, selection: sha(catalogBytes), catalog };
}
async function completedProducers(source) {
  const runs = [];
  for (const producer of PRODUCERS) {
    const list = await api('actions/workflows/' + producer.id + '/runs?event=push&branch=main&head_sha=' + source + '&per_page=100');
    const matching = list.workflow_runs.filter(run => run.head_sha === source).sort((a, b) => b.id - a.id);
    if (!matching.length) return null;
    const run = await api('actions/runs/' + matching[0].id); assertTrustedRun(run, producer, source);
    if (run.status !== 'completed') return null;
    assert.equal(run.conclusion, 'success', 'required producer failed: ' + producer.name);
    const attempt = await api('actions/runs/' + run.id + '/attempts/' + run.run_attempt); assertTrustedRun(attempt, producer, source);
    const jobs = (await api('actions/runs/' + run.id + '/attempts/' + run.run_attempt + '/jobs?per_page=100')).jobs;
    assert.ok(equal(jobs.map(job => job.name).sort(), [...producer.jobs].sort()), 'unexpected required job coverage');
    for (const job of jobs) { assert.equal(job.status, 'completed'); assert.equal(job.conclusion, 'success'); }
    const artifacts = (await api('actions/runs/' + run.id + '/artifacts?per_page=100')).artifacts;
    runs.push({ ...run, jobs, artifacts, currentAttemptStartedAt: attempt.run_started_at });
  }
  return runs;
}
async function getArtifact(run, name, directory, provenance) {
  const matches = run.artifacts.filter(artifact => artifact.name === name);
  assert.equal(matches.length, 1, 'missing or ambiguous Actions artifact: ' + name);
  const artifact = matches[0];
  assert.equal(artifact.expired, false); assert.match(artifact.digest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(artifact.workflow_run?.id, run.id); assert.equal(artifact.workflow_run?.head_sha, run.head_sha);
  assert.equal(artifact.workflow_run?.repository_id, artifact.workflow_run?.head_repository_id);
  assert.ok(Date.parse(artifact.created_at) >= Date.parse(run.currentAttemptStartedAt), 'artifact from an earlier run attempt');
  const target = path.join(directory, String(artifact.id)); await mkdir(target);
  const response = await api('actions/artifacts/' + artifact.id + '/zip', { raw: true }); assert.equal(response.status, 302);
  const archive = path.join(target, 'actions.zip');
  await download(response.headers.get('location'), archive, artifact.digest.slice(7));
  const extraction = path.join(target, 'files'); await mkdir(extraction);
  command('python3', ['-c', [
    'import pathlib,stat,sys,zipfile',
    'with zipfile.ZipFile(sys.argv[1]) as archive:',
    ' for entry in archive.infolist():',
    '  name=entry.filename; p=pathlib.PurePosixPath(name)',
    '  assert name and not p.is_absolute() and ".." not in p.parts and "\\\\" not in name and ":" not in name',
    '  kind=stat.S_IFMT(entry.external_attr>>16)',
    '  assert kind in (0,stat.S_IFREG,stat.S_IFDIR), "non-regular artifact entry"',
    ' archive.extractall(sys.argv[2])',
  ].join('\n'), archive, extraction]);
  const files = [];
  async function walk(root) { for (const entry of await readdir(root, { withFileTypes: true })) { const name = path.join(root, entry.name); if (entry.isDirectory()) await walk(name); else { assert.ok(entry.isFile()); files.push(name); } } }
  await walk(extraction);
  provenance.push({ name, id: artifact.id, digest: artifact.digest, createdAt: artifact.created_at,
    runId: run.id, attempt: run.run_attempt, headSha: run.head_sha,
    files: await Promise.all(files.map(async file => ({ name: path.relative(extraction, file).replaceAll('\\', '/'), sha256: await fileHash(file) }))) });
  return files;
}
const one = (files, name) => { const matching = files.filter(file => path.basename(file) === name); assert.equal(matching.length, 1, 'artifact file missing/ambiguous: ' + name); return matching[0]; };
async function publicBytes(asset, destination, expected) {
  const response = await api('releases/assets/' + asset.id, { raw: true, accept: 'application/octet-stream' });
  if (response.status === 302) return download(response.headers.get('location'), destination, expected);
  assert.equal(response.status, 200); assert.ok(!response.headers.get('content-type')?.includes('json'));
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination, { flags: 'wx' }));
  assert.equal(await fileHash(destination), expected, 'published bytes differ from their verified digest');
}
async function previousPublication(release, context, incoming, provenance) {
  const link = release.body.match(/\[Publication\]\(https:\/\/github\.com\/kaigendev\/Kaigen\/actions\/runs\/(\d+)\) \(attempt (\d+)\)/);
  assert.ok(link, 'previous Actions publication run/attempt is missing');
  const runId = Number(link[1]), attempt = Number(link[2]);
  const currentRun = Number(process.env.GITHUB_RUN_ID), currentAttempt = Number(process.env.GITHUB_RUN_ATTEMPT);
  assert.ok(Number.isSafeInteger(runId) && Number.isSafeInteger(attempt)
    && (runId < currentRun || (runId === currentRun && attempt < currentAttempt)));
  const run = await api('actions/runs/' + runId + '/attempts/' + attempt);
  assert.equal(run.name, 'publish-kaigen-release-0298'); assert.equal(run.path, '.github/workflows/publish-release-0298.yml');
  assert.equal(run.event, 'workflow_run'); assert.equal(run.head_branch, 'main'); assert.equal(run.head_sha, context.source);
  assert.equal(run.repository?.full_name, REPOSITORY); assert.equal(run.head_repository?.full_name, REPOSITORY);
  assert.equal(run.run_attempt, attempt); assert.equal(run.status, 'completed');
  run.artifacts = (await api('actions/runs/' + runId + '/artifacts?per_page=100')).artifacts;
  run.currentAttemptStartedAt = run.run_started_at;
  const files = await getArtifact(run, 'Kaigen-Actions-publication-0.2.9.8-' + runId + '-' + attempt, incoming, provenance);
  const manifest = await json(one(files, 'publication-manifest.json'));
  assert.equal(manifest.kind, 'kaigen-actions-release'); assert.equal(manifest.repository, REPOSITORY);
  assert.equal(manifest.releaseId, RELEASE_ID); assert.equal(manifest.tag, TAG);
  assert.equal(manifest.productSource?.commit, PRODUCT_COMMIT); assert.equal(manifest.productSource?.tree, PRODUCT_TREE);
  assert.equal(manifest.builtFrom?.commit, context.source); assert.equal(manifest.builtFrom?.tree, context.tree);
  assert.equal(manifest.controllerCommit, context.source);
  assert.equal(manifest.publication?.runId, runId); assert.equal(manifest.publication?.attempt, attempt);
  assert.ok(equal(manifest.assets.map(asset => asset.name).sort(), PUBLIC_NAMES));
  return manifest;
}
async function verifiedPublicBytes(asset, destination, expected, marker, directory) {
  try { return await publicBytes(asset, destination, expected); }
  catch (error) {
    const failed = await releaseIdentity(); assert.ok(failed.body.includes(marker), 'refusing to withdraw a different publication');
    if (!failed.draft) await api('releases/' + RELEASE_ID, { method: 'PATCH', body: { draft: true } });
    await save(path.join(directory, 'public-byte-failure.json'), { status: 'FAIL_DRAFT', releaseId: RELEASE_ID,
      tag: TAG, asset: asset.name, expectedSha256: expected, error: error.message, completedAt: new Date().toISOString() });
    throw error;
  }
}
async function publish(mode, directory) {
  const context = await verifySource(); await mkdir(directory, { recursive: true });
  const before = await releaseIdentity({ allowIncompleteDraft: mode === 'publish' }); await save(path.join(directory, 'release-before.json'), before);
  if (mode === 'withdraw') {
    if (!before.draft) {
      assert.ok(!before.body.includes('<!-- kaigen-actions-v0298:'), 'a verified Actions publication must not be withdrawn');
      await api('releases/' + RELEASE_ID, { method: 'PATCH', body: { draft: true } });
    }
    await save(path.join(directory, 'withdrawal.json'), { status: 'DRAFT', releaseId: RELEASE_ID, tag: TAG, productCommit: PRODUCT_COMMIT, workflowCommit: context.source, runId: Number(process.env.GITHUB_RUN_ID), completedAt: new Date().toISOString() });
    console.log('Existing local-built publication withdrawn to draft by Actions.'); return;
  }
  assert.equal(mode, 'publish');
  const event = await json(process.env.GITHUB_EVENT_PATH);
  const triggered = PRODUCERS.find(producer => producer.id === event.workflow_run?.workflow_id);
  assert.ok(triggered, 'untrusted producer trigger'); assertTrustedRun(event.workflow_run, triggered, context.source);
  const runs = await completedProducers(context.source);
  if (!runs) { console.log('Other required producers are still running; final producer completion will resume publication.'); return; }
  const marker = '<!-- kaigen-actions-v0298:' + context.source + ' -->';
  const alreadyPublished = !before.draft && before.body.includes(marker);
  const incoming = path.join(directory, 'incoming'), outgoing = path.join(directory, 'release');
  await mkdir(incoming); await mkdir(outgoing);
  const provenance = [], receipts = [], assets = [];
  for (const platform of ['windows', 'debian', 'macos', 'web']) {
    const run = runs[platform === 'windows' ? 0 : 1];
    const checks = platform === 'windows' ? context.catalog.checks.map(check => check.id) : platform === 'web' ? ['rust:all', 'webd:all'] : ['rust:all'];
    const evidence = await getArtifact(run, 'Kaigen-verification-' + platform, incoming, provenance); assert.equal(evidence.length, 1);
    const receipt = await json(one(evidence, 'ci-verification-' + platform + '.json'));
    assertVerification(receipt, platform, context.source, context.tree, context.selection, checks); receipts.push(receipt);
    const names = platform === 'windows' ? ['Kaigen-portable-windows-x64', 'Kaigen-installer-windows-x64']
      : [platform === 'web' ? 'Kaigen-Web-Debian13-Nginx-0.2.9.8' : 'Kaigen-portable-' + (platform === 'debian' ? 'debian-x64' : 'macos-universal')];
    const productFiles = [];
    for (const name of names) productFiles.push(...await getArtifact(run, name, incoming, provenance));
    for (const [original, publicName] of FILES[platform]) {
      const file = one(productFiles, original), digest = await fileHash(file);
      assert.equal(receipt.artifacts.find(artifact => artifact.name === original)?.sha256, digest, 'final product bytes are not bound to the successful CI receipt');
      await copyFile(file, path.join(outgoing, publicName));
      assets.push({ name: publicName, sha256: digest, size: (await stat(file)).size, platform, runId: run.id, attempt: run.run_attempt });
    }
    if (platform === 'windows') await copyFile(one(productFiles, 'Kaigen-installer-windows-x64.manifest.json'), path.join(directory, 'windows-msi-manifest.json'));
  }
  const nativeResults = [];
  for (const job of ['pq-fault-desktop', 'pq-fault-web-core']) {
    const files = await getArtifact(runs[2], 'extended-native-' + job, incoming, provenance);
    const result = await json(one(files, 'result.json'));
    assert.equal(result.kind, 'kaigen-extended-native-result'); assert.equal(result.job, job);
    assert.equal(result.status, 'PASS'); assert.equal(result.resource?.status, 'PASS');
    assert.ok(result.counts?.passed > 0 && result.counts?.failed === 0);
    nativeResults.push(result);
  }
  const sourceName = 'Kaigen-source-0.2.9.8.zip';
  if (alreadyPublished) {
    const previous = await previousPublication(before, context, incoming, provenance);
    for (const asset of assets) {
      const retained = previous.assets.find(value => value.name === asset.name);
      assert.equal(retained?.sha256, asset.sha256); assert.equal(retained?.size, asset.size);
    }
    const retained = previous.assets.find(value => value.name === sourceName), remote = before.assets.find(value => value.name === sourceName);
    assert.equal(retained?.sourceCommit, PRODUCT_COMMIT); assert.equal(retained?.platform, 'source'); assert.match(retained?.sha256, HASH);
    assert.equal(retained?.producerRunId, previous.publication.runId); assert.equal(remote.digest, 'sha256:' + retained.sha256);
    await verifiedPublicBytes(remote, path.join(outgoing, sourceName), retained.sha256, marker, directory); assets.push(retained);
  } else {
    const canonical = path.join(directory, 'canonical-source'); await mkdir(canonical);
    command('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', 'scripts/build-source-archive.ps1', '-GitRevision', PRODUCT_COMMIT, '-ArtifactsDir', canonical]);
    const sourceFile = path.join(canonical, 'Kaigen-source-github.zip'); await copyFile(sourceFile, path.join(outgoing, sourceName));
    assets.push({ name: sourceName, sha256: await fileHash(sourceFile), size: (await stat(sourceFile)).size, platform: 'source', sourceCommit: PRODUCT_COMMIT, producerRunId: Number(process.env.GITHUB_RUN_ID) });
  }
  assert.ok(equal(assets.map(asset => asset.name).sort(), PUBLIC_NAMES));
  const web = assets.find(asset => asset.name.endsWith('.tar.gz'));
  const bootstrap = await readFile(path.join(outgoing, 'Kaigen-Web-Installer-0.2.9.8.sh'), 'utf8');
  assert.ok(bootstrap.includes("BUNDLE_SHA256='" + web.sha256 + "'") && bootstrap.includes("RELEASE_LABEL='0.2.9.8'"));
  command('bash', ['-n', path.join(outgoing, 'Kaigen-Web-Installer-0.2.9.8.sh')]);
  const manifest = { schema: 1, kind: 'kaigen-actions-release', status: 'VERIFIED_BEFORE_PUBLICATION', repository: REPOSITORY,
    releaseId: RELEASE_ID, tag: TAG, productSource: { commit: PRODUCT_COMMIT, tree: PRODUCT_TREE },
    builtFrom: { commit: context.source, tree: context.tree }, controllerCommit: process.env.GITHUB_WORKFLOW_SHA,
    publication: { runId: Number(process.env.GITHUB_RUN_ID), attempt: Number(process.env.GITHUB_RUN_ATTEMPT) },
    equivalence: { referenceCommit: DOCUMENT_COMMIT, changedCiPaths: context.changes, productInputsUnchanged: true },
    runs: runs.map(run => ({ id: run.id, attempt: run.run_attempt, workflowId: run.workflow_id, path: run.path, headSha: run.head_sha,
      url: run.html_url, jobs: run.jobs.map(job => ({ id: job.id, name: job.name, conclusion: job.conclusion })) })),
    artifacts: provenance, verification: receipts, nativeResults, assets, preparedAt: new Date().toISOString() };
  await save(path.join(directory, 'publication-manifest.json'), manifest);
  const current = await releaseIdentity({ allowIncompleteDraft: true });
  assert.ok(current.draft || !current.body.includes('<!-- kaigen-actions-v0298:') || current.body.includes(marker), 'a different Actions source was already published');
  assert.equal(!current.draft && current.body.includes(marker), alreadyPublished, 'publication state changed');
  if (!alreadyPublished) {
    if (!current.draft) await api('releases/' + RELEASE_ID, { method: 'PATCH', body: { draft: true } });
    command('gh', ['release', 'upload', TAG, ...assets.map(asset => path.join(outgoing, asset.name)), '--repo', REPOSITORY, '--clobber']);
  }
  const uploaded = await releaseIdentity();
  for (const asset of assets) {
    const remote = uploaded.assets.find(value => value.name === asset.name);
    assert.equal(remote.size, asset.size); assert.equal(remote.digest, 'sha256:' + asset.sha256);
  }
  const runLinks = runs.map(run => '- [' + run.name + '](' + run.html_url + ')').join('\n');
  const body = marker + '\n## Kaigen 0.2.9.8\n\n'
    + 'Исправлены порядок сообщения о PQ-ключах и первого сообщения, Enter на планшетах, прокрутка создания пространства, показ файла в папке и контекстное меню по долгому нажатию.\n\n'
    + 'Все семь файлов выпущены через GitHub Actions. Тег и canonical source: \x60' + PRODUCT_COMMIT + '\x60. Фактический коммит сборок и CI: \x60' + context.source + '\x60; отличия ограничены CI и архивированием спецификаций.\n\n'
    + 'All seven assets are produced and published by GitHub Actions. The tag/canonical source remains at \x60' + PRODUCT_COMMIT + '\x60; binary builds use \x60' + context.source + '\x60 with verified unchanged product inputs.\n\n'
    + 'macOS universal: ad-hoc signed, not notarized. macOS universal: подпись ad-hoc, без нотариализации.\n\n'
    + runLinks + '\n- [Publication](https://github.com/' + REPOSITORY + '/actions/runs/' + process.env.GITHUB_RUN_ID + ') (attempt ' + process.env.GITHUB_RUN_ATTEMPT + ')\n\n'
    + '| File | SHA-256 |\n| --- | --- |\n' + assets.map(asset => '| ' + asset.name + ' | \x60' + asset.sha256 + '\x60 |').join('\n') + '\n';
  if (!alreadyPublished) {
    const published = await api('releases/' + RELEASE_ID, { method: 'PATCH', body: { draft: false, body, name: 'Kaigen 0.2.9.8', make_latest: 'true' } }); assert.equal(published.draft, false);
  }
  const final = await releaseIdentity(); await save(path.join(directory, 'release-after.json'), final);
  const verified = path.join(directory, 'public-bytes'); await mkdir(verified);
  try {
    for (const asset of assets) await verifiedPublicBytes(final.assets.find(value => value.name === asset.name), path.join(verified, asset.name), asset.sha256, marker, directory);
  } catch (error) {
    manifest.status = 'PUBLICATION_FAILED_DRAFT'; manifest.error = error.message;
    await save(path.join(directory, 'publication-manifest.json'), manifest); throw error;
  }
  manifest.status = 'PUBLISHED_VERIFIED'; manifest.completedAt = new Date().toISOString(); manifest.releaseUrl = final.html_url;
  await save(path.join(directory, 'publication-manifest.json'), manifest);
  console.log('Actions publication and all seven downloaded public SHA-256 values verified: ' + final.html_url);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.ok(process.env.GITHUB_TOKEN, 'Actions token required');
  const [mode, directory] = process.argv.slice(2); assert.ok(directory && path.isAbsolute(directory));
  await publish(mode, directory);
}

