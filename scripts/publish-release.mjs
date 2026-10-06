import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readReleaseVersion, releaseVersion } from './release-version.mjs';
import { preflight, releaseCiPaths, selectChecks, localFullChecks, localFrontendPolicy, localFrontendCoverage } from './ci-incremental-verification.mjs';
import { inputBytes, descriptor } from './incremental-windows-verification.mjs';
import { legacyNativeClosure, isNativeInputCheck, nativeCacheCompatibility } from './native-verification-inputs.mjs';
import { FRONTEND_TRANSITION, WEB_COMPONENT_TRANSITION, reviewedFrontendSourceCompatibility, reviewedWebComponentApplicability } from './frontend-verification-inputs.mjs';
import { parseRun, selectTests, validateCatalog as validateNativeCatalog } from './extended-native-verification.mjs';

export const REPOSITORY = 'kaigendev/Kaigen';
export const WORKFLOW_PATH = '.github/workflows/publish-release.yml';
export const PRODUCERS = Object.freeze({
  windows: { id: 333598718, name: 'build-kaigen-windows-portable', path: '.github/workflows/build-windows.yml', jobs: ['build', 'package'] },
  unix: { id: 333598717, name: 'build-kaigen-linux-macos-portable', path: '.github/workflows/build-unix.yml', jobs: ['debian-appimage', 'macos-universal', 'web-debian13-nginx'] },
  native: { id: 374774956, name: 'extended-native-regressions', path: '.github/workflows/regression-extended.yml', jobs: ['pq-fault-desktop', 'pq-fault-web-core'] },
});
const HASH = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const PLATFORMS = ['windows', 'debian', 'macos', 'web'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = async filename => JSON.parse(await readFile(filename, 'utf8'));
const save = (filename, value) => writeFile(filename, JSON.stringify(value, null, 2) + '\n');
const gitBytes = (...args) => execFileSync('git', ['-c', 'safe.directory=' + process.cwd(), ...args], { maxBuffer: 32 * 1024 * 1024, windowsHide: true });
const git = (...args) => gitBytes(...args).toString('utf8').trim();
const positive = (value, label) => assert.ok(Number.isSafeInteger(value) && value > 0, 'invalid ' + label);
const sorted = items => [...items].sort();
const identity = value => { assert.match(value?.commit ?? '', COMMIT); assert.match(value?.tree ?? '', COMMIT); };
async function fileHash(filename) { const hash = createHash('sha256'); for await (const chunk of createReadStream(filename)) hash.update(chunk); return hash.digest('hex'); }
function command(program, args) { execFileSync(program, args, { stdio: 'inherit', windowsHide: true }); }

export function assetNames(version) {
  const { releaseLabel } = releaseVersion(version);
  return {
    windows: ['Kaigen-portable-windows-x64.zip', 'Kaigen-installer-windows-x64.msi'],
    debian: ['Kaigen-portable-debian-x64.zip'],
    macos: ['Kaigen-portable-macos-universal.zip'],
    web: [`Kaigen-Web-Debian13-Nginx-${releaseLabel}.tar.gz`, `Kaigen-Web-Installer-${releaseLabel}.sh`],
    source: [`Kaigen-source-${releaseLabel}.zip`],
  };
}
export function artifactNames(version) {
  const { releaseLabel } = releaseVersion(version);
  return {
    windows: ['Kaigen-verification-windows', 'Kaigen-portable-windows-x64', 'Kaigen-installer-windows-x64'],
    unix: ['Kaigen-verification-debian', 'Kaigen-verification-macos', 'Kaigen-verification-web', 'Kaigen-portable-debian-x64', 'Kaigen-portable-macos-universal', `Kaigen-Web-Debian13-Nginx-${releaseLabel}`],
    native: ['extended-native-pq-fault-desktop', 'extended-native-pq-fault-web-core'],
  };
}
export function assertManifest(manifest, version) {
  const canonical = releaseVersion(version);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.kind, 'kaigen-actions-release-input');
  assert.equal(manifest.repository, REPOSITORY);
  assert.equal(manifest.version, canonical.version);
  assert.equal(manifest.tag, canonical.tag);
  identity(manifest.source);
  assert.equal(manifest.catalog?.path, `ci/verification-v${canonical.releaseLabel}.json`);
  assert.match(manifest.catalog?.sha256 ?? '', HASH);
  assert.deepEqual(sorted(Object.keys(manifest.producers ?? {})), sorted(Object.keys(PRODUCERS)));
  const required = artifactNames(version), ids = new Set();
  for (const key of Object.keys(PRODUCERS)) {
    const pin = manifest.producers[key];
    producerSource(manifest, key);
    positive(pin.runId, 'producer run'); positive(pin.attempt, 'producer attempt');
    assert.deepEqual(sorted(pin.artifacts.map(item => item.name)), sorted(required[key]), 'missing, duplicate or unexpected artifact pin');
    for (const artifact of pin.artifacts) {
      positive(artifact.id, 'artifact ID'); assert.ok(!ids.has(artifact.id), 'duplicate artifact ID'); ids.add(artifact.id);
      assert.match(artifact.digest ?? '', /^sha256:[a-f0-9]{64}$/);
    }
  }
  assert.equal(manifest.gates?.path, `ci/releases/evidence/${canonical.tag}/gate.json`, 'exact current release gate export is required');
  assert.match(manifest.gates?.sha256 ?? '', HASH);
  return canonical;
}

// Optional in schema v1: absent means the canonical release source, as before.
// A supplied source is an immutable identity, never a caller-supplied reuse proof.
export function producerSource(manifest, key) {
  assert.ok(Object.hasOwn(PRODUCERS, key), 'unknown producer');
  const pin = manifest.producers[key];
  const source = Object.hasOwn(pin, 'source') ? pin.source : manifest.source;
  safeSource(source); return source;
}

export function gitProducerSources(manifest) {
  safeSource(manifest.source);
  assert.equal(git('rev-parse', manifest.source.commit + '^{tree}'), manifest.source.tree);
  const verified = new Map(), result = {};
  for (const key of Object.keys(PRODUCERS)) {
    const source = producerSource(manifest, key), cacheKey = JSON.stringify(source);
    if (!verified.has(cacheKey)) {
      let equivalence = null;
      if (source.commit === manifest.source.commit) assert.deepEqual(source, manifest.source);
      else {
        assert.equal(manifest.version, '0.2.9+9', 'mixed producer sources are limited to the reviewed release');
        equivalence = gitVerificationRevision(source, manifest.source, manifest.version);
      }
      assert.equal(sha(gitBytes('show', source.commit + ':' + manifest.catalog.path)), manifest.catalog.sha256,
        'producer used another selection');
      verified.set(cacheKey, { source, equivalence });
    }
    result[key] = verified.get(cacheKey);
  }
  return result;
}

export function assertActionsContext(env, event, source) {
  assert.equal(env.GITHUB_ACTIONS, 'true', 'publication is Actions-only');
  assert.equal(env.GITHUB_REPOSITORY, REPOSITORY);
  assert.equal(env.GITHUB_EVENT_NAME, 'workflow_dispatch');
  assert.equal(env.GITHUB_REF, 'refs/heads/main');
  assert.equal(env.GITHUB_WORKFLOW_REF, `${REPOSITORY}/${WORKFLOW_PATH}@refs/heads/main`);
  assert.equal(env.GITHUB_SHA, source); assert.equal(env.GITHUB_WORKFLOW_SHA, source);
  assert.equal(event.repository?.full_name, REPOSITORY); assert.equal(event.ref, 'refs/heads/main');
  assert.match(env.KAIGEN_RELEASE_MANIFEST_SHA256 ?? '', HASH);
  assert.equal(event.inputs?.manifest_sha256, env.KAIGEN_RELEASE_MANIFEST_SHA256);
  positive(Number(env.GITHUB_RUN_ID), 'publisher run'); positive(Number(env.GITHUB_RUN_ATTEMPT), 'publisher attempt');
}

export function assertTrustedRun(run, producer, pin, source, repositoryId) {
  identity(source); positive(repositoryId, 'repository ID');
  assert.equal(run.id, pin.runId); assert.equal(run.run_attempt, pin.attempt);
  assert.equal(run.workflow_id, producer.id); assert.equal(run.name, producer.name); assert.equal(run.path, producer.path);
  assert.equal(run.event, 'push'); assert.equal(run.head_branch, 'main'); assert.equal(run.head_sha, source.commit);
  assert.equal(run.repository?.full_name, REPOSITORY); assert.equal(run.head_repository?.full_name, REPOSITORY);
  assert.equal(run.repository?.id, repositoryId); assert.equal(run.head_repository?.id, repositoryId);
  assert.equal(run.status, 'completed'); assert.equal(run.conclusion, 'success');
}

// A package-only retry may retain the successful build job from a previous attempt.
// Select the newest job for each required name, then bind each artifact to its own job interval.
export function selectSuccessfulJobs(jobs, producer, pin, source) {
  const result = [];
  assert.ok(jobs.length > 0);
  for (const job of jobs) {
    assert.equal(job.run_id, pin.runId); assert.equal(job.head_sha, source.commit);
    assert.ok(producer.jobs.includes(job.name), 'unexpected producer job');
    positive(job.run_attempt, 'job attempt'); assert.ok(job.run_attempt <= pin.attempt);
  }
  for (const name of producer.jobs) {
    const matching = jobs.filter(job => job.name === name).sort((a, b) => b.run_attempt - a.run_attempt);
    assert.ok(matching.length, 'missing required job: ' + name);
    assert.ok(matching.length === 1 || matching[0].run_attempt !== matching[1].run_attempt, 'ambiguous required job');
    const job = matching[0]; positive(job.id, 'job ID');
    assert.equal(job.status, 'completed'); assert.equal(job.conclusion, 'success');
    assert.ok(Number.isFinite(Date.parse(job.started_at)) && Date.parse(job.completed_at) >= Date.parse(job.started_at));
    result.push(job);
  }
  return result;
}

export function assertArtifact(artifact, pin, run, job, repositoryId) {
  assert.equal(artifact.id, pin.id); assert.equal(artifact.name, pin.name); assert.equal(artifact.digest, pin.digest);
  assert.match(artifact.digest ?? '', /^sha256:[a-f0-9]{64}$/); assert.equal(artifact.expired, false);
  assert.equal(artifact.workflow_run?.id, run.id); assert.equal(artifact.workflow_run?.head_sha, run.head_sha);
  assert.equal(artifact.workflow_run?.repository_id, repositoryId); assert.equal(artifact.workflow_run?.head_repository_id, repositoryId);
  const created = Date.parse(artifact.created_at);
  assert.ok(created >= Date.parse(job.started_at) && created <= Date.parse(job.completed_at), 'artifact is not from the successful producing job');
}

export function assertVerification(receipt, platform, manifest, catalog, inheritedFrontend = null) {
  const source = producerSource(manifest, platform === 'windows' ? 'windows' : 'unix');
  assert.equal(receipt.schemaVersion, 1); assert.equal(receipt.kind, 'kaigen-ci-incremental-verification');
  assert.equal(receipt.status, 'PASS'); assert.equal(receipt.repository, REPOSITORY); assert.equal(receipt.platform, platform);
  assert.deepEqual(receipt.builtFrom, source); assert.deepEqual(receipt.productReference, catalog.productSource);
  assert.deepEqual(receipt.verificationReference, catalog.referenceSource);
  const inherited = platform === 'windows' && localFrontendPolicy(catalog);
  assert.equal(receipt.fullBaselineRerun, !inherited); assert.equal(receipt.selectionSha256, manifest.catalog.sha256);
  if (inherited) {
    assert.ok(inheritedFrontend, 'publisher must independently validate the public local frontend proof');
    assert.deepEqual(receipt.frontendCoverage, inheritedFrontend.binding);
  } else assert.equal(receipt.frontendCoverage, undefined);
  assert.equal(receipt.equivalence?.unchangedOutsideCiPaths, true);
  assert.ok(receipt.equivalence.changedCiPaths.every(filename => releaseCiPaths(catalog).includes(filename)));
  const checks = selectChecks(catalog, platform);
  assert.deepEqual(sorted(receipt.checks.map(check => check.id)), sorted(checks.map(check => check.id)), 'missing, duplicate or extra current checks');
  for (const check of receipt.checks) {
    const selected = checks.find(item => item.id === check.id);
    if (selected.localFrontendCoverage) {
      assert.deepEqual(check, inheritedFrontend.results.find(item => item.id === check.id), 'original local frontend receipt fields changed');
    } else {
      assert.equal(selected.action, 'run'); assert.equal(check.disposition, 'rerun'); assert.deepEqual(check.source, source); assert.match(check.outputSha256 ?? '', HASH);
      assert.equal(check.localFrontend, undefined);
    }
  }
  assert.ok(Array.isArray(receipt.artifacts) && new Set(receipt.artifacts.map(item => item.name)).size === receipt.artifacts.length);
}

export function assertDraftState(release, tag, expected) {
  if (tag) {
    assert.equal(tag.ref, 'refs/tags/' + expected.tag);
    assert.equal(tag.object?.type, 'tag'); assert.equal(tag.annotation?.object?.type, 'commit');
    assert.equal(tag.annotation?.object?.sha, expected.source.commit);
    assert.equal(tag.annotation?.tag, expected.tag); assert.equal(tag.annotation?.message?.trim(), expected.marker);
  }
  if (!release) return;
  assert.ok(tag, 'draft without the owned annotated tag');
  positive(release.id, 'release ID'); assert.equal(release.tag_name, expected.tag);
  assert.equal(release.draft, true, 'an existing published release cannot be changed');
  assert.equal(release.immutable, false); assert.equal(release.prerelease, false);
  assert.equal(release.target_commitish, expected.source.commit);
  assert.equal(release.body?.split('\n')[0], expected.marker, 'draft belongs to another publication');
  assert.ok(new Set(release.assets.map(asset => asset.name)).size === release.assets.length);
  assert.ok(release.assets.every(asset => expected.names.includes(asset.name)), 'unexpected draft asset');
}

export function assertRemoteAssets(remote, assets, { complete = true } = {}) {
  assert.ok(new Set(remote.map(asset => asset.name)).size === remote.length, 'duplicate remote assets');
  if (complete) assert.deepEqual(sorted(remote.map(asset => asset.name)), sorted(assets.map(asset => asset.name)));
  for (const asset of remote) {
    const expected = assets.find(item => item.name === asset.name); assert.ok(expected, 'unexpected remote asset');
    positive(asset.id, 'release asset ID'); assert.equal(asset.state, 'uploaded');
    assert.equal(asset.size, expected.size); assert.equal(asset.digest, 'sha256:' + expected.sha256, 'existing asset differs; automatic replacement is forbidden');
  }
}

async function api(endpoint, { method = 'GET', body, raw = false, missing = false, accept = 'application/vnd.github+json' } = {}) {
  // Endpoints are constructed by this module; no URL, command or endpoint comes from the manifest.
  const response = await fetch(`https://api.github.com/repos/${REPOSITORY}${endpoint ? '/' + endpoint : ''}`, {
    method, redirect: 'manual', headers: { Authorization: 'Bearer ' + process.env.GITHUB_TOKEN, Accept: accept,
      'X-GitHub-Api-Version': '2022-11-28', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (missing && response.status === 404) return null;
  if (raw) return response;
  assert.ok(response.ok, `GitHub ${method} ${endpoint}: ${response.status}`);
  return response.status === 204 ? null : response.json();
}
async function all(endpoint, key) {
  const rows = [];
  for (let page = 1; page <= 100; page++) {
    const response = await api(endpoint + (endpoint.includes('?') ? '&' : '?') + `per_page=100&page=${page}`);
    const values = key ? response[key] : response; assert.ok(Array.isArray(values)); rows.push(...values);
    if (values.length < 100) return rows;
  }
  throw new Error('GitHub pagination limit reached; incomplete evidence is forbidden');
}
async function download(url, filename, digest) {
  const parsed = new URL(url);
  assert.equal(parsed.protocol, 'https:'); assert.equal(parsed.username, ''); assert.equal(parsed.password, '');
  assert.ok(parsed.hostname === 'release-assets.githubusercontent.com' || parsed.hostname.endsWith('.blob.core.windows.net') || parsed.hostname.endsWith('.actions.githubusercontent.com'), 'unexpected GitHub download host');
  const response = await fetch(parsed, { redirect: 'error' }); assert.ok(response.ok, 'download failed');
  await pipeline(Readable.fromWeb(response.body), createWriteStream(filename, { flags: 'wx' }));
  assert.equal(await fileHash(filename), digest, 'download digest mismatch');
}
async function publicBytes(asset, filename, digest) {
  const response = await api('releases/assets/' + asset.id, { raw: true, accept: 'application/octet-stream' });
  if (response.status === 302) return download(response.headers.get('location'), filename, digest);
  assert.equal(response.status, 200); assert.ok(!response.headers.get('content-type')?.includes('json'));
  await pipeline(Readable.fromWeb(response.body), createWriteStream(filename, { flags: 'wx' }));
  assert.equal(await fileHash(filename), digest, 'release bytes differ from verified product bytes');
}
async function uploadAsset(releaseId, asset, filename) {
  positive(releaseId, 'upload release ID');
  const response = await fetch(`https://uploads.github.com/repos/${REPOSITORY}/releases/${releaseId}/assets?name=${encodeURIComponent(asset.name)}`, {
    method: 'POST', redirect: 'error', duplex: 'half', body: createReadStream(filename),
    headers: { Authorization: 'Bearer ' + process.env.GITHUB_TOKEN, Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/octet-stream', 'Content-Length': String(asset.size) },
  });
  assert.ok(response.ok, 'asset upload failed: ' + response.status);
  assertRemoteAssets([await response.json()], [asset]);
}

export const EXTRACT_ARTIFACT = [
  'import pathlib,stat,sys,zipfile',
  'with zipfile.ZipFile(sys.argv[1]) as archive:',
  ' seen=set()',
  ' for entry in archive.infolist():',
  '  name=entry.filename; p=pathlib.PurePosixPath(name)',
  '  assert name and not p.is_absolute() and ".." not in p.parts and "\\\\" not in name and ":" not in name and "\\x00" not in name',
  '  key=str(p).casefold(); assert key not in seen, "duplicate artifact entry"; seen.add(key)',
  '  kind=stat.S_IFMT(entry.external_attr>>16)',
  '  assert kind in (0,stat.S_IFREG,stat.S_IFDIR), "non-regular artifact entry"',
  ' archive.extractall(sys.argv[2])',
].join('\n');

// Read the original candidate ZIP and the actual shipping executable. Nothing is
// extracted to disk and no caller-provided executable digest becomes evidence.
const INSPECT_WINDOWS_ARCHIVE = String.raw`
import hashlib,json,os,pathlib,stat,sys,zipfile
def ordinary(name):
 p=os.path.abspath(name); s=os.lstat(p)
 assert stat.S_ISREG(s.st_mode) and not stat.S_ISLNK(s.st_mode), "ordinary file required"
 assert os.path.normcase(os.path.realpath(p))==os.path.normcase(p), "canonical file path required"
 return p
def digest(stream):
 stream.seek(0); h=hashlib.sha256()
 while True:
  part=stream.read(1024*1024)
  if not part: break
  h.update(part)
 return h.hexdigest()
archive_path=ordinary(sys.argv[1]); executable_path=ordinary(sys.argv[2])
with open(archive_path,'rb') as archive_file, open(executable_path,'rb') as executable_file:
 archive_hash=digest(archive_file); executable_hash=digest(executable_file)
 archive_size=os.fstat(archive_file.fileno()).st_size; executable_size=os.fstat(executable_file.fileno()).st_size
 assert archive_size>0 and executable_size>0, "empty archive or executable"
 with zipfile.ZipFile(archive_file) as archive:
  seen=set(); matches=[]
  for entry in archive.infolist():
   assert entry.orig_filename==entry.filename, "truncated ZIP member name"
   name=entry.filename.replace('\\','/'); parts=name.rstrip('/').split('/')
   assert name and not name.startswith('/') and all(part not in ('','.','..') for part in parts), "unsafe ZIP member path"
   assert all(not part.endswith(('.', ' ')) for part in parts), "Windows ZIP path alias"
   assert ':' not in name and not any(ord(c)<32 for c in name), "unsafe ZIP member name"
   key=name.rstrip('/').casefold(); assert key not in seen, "duplicate ZIP member"; seen.add(key)
   kind=stat.S_IFMT(entry.external_attr>>16)
   assert kind in (0,stat.S_IFREG,stat.S_IFDIR), "non-regular ZIP member"
   assert not entry.flag_bits & 1, "encrypted ZIP member"
   if parts[-1].casefold()=='kaigen.exe':
    assert name=='Kaigen-portable/Kaigen.exe' and kind in (0,stat.S_IFREG), "noncanonical shipping executable"
    matches.append(entry)
  assert len(matches)==1, "exactly one shipping executable required"
  entry=matches[0]; assert entry.file_size==executable_size, "shipping executable size mismatch"
  with archive.open(entry) as stream:
   h=hashlib.sha256(); count=0
   while True:
    part=stream.read(1024*1024)
    if not part: break
    count+=len(part); assert count<=executable_size, "shipping executable size overflow"; h.update(part)
  assert count==executable_size and h.hexdigest()==executable_hash, "shipping executable hash mismatch"
 assert digest(archive_file)==archive_hash and digest(executable_file)==executable_hash, "inputs changed during inspection"
 assert ordinary(archive_path)==archive_path and ordinary(executable_path)==executable_path
 assert os.path.samestat(os.stat(archive_path),os.fstat(archive_file.fileno())) and os.path.samestat(os.stat(executable_path),os.fstat(executable_file.fileno())), "input file replaced"
 print(json.dumps({'archive':{'sha256':archive_hash,'bytes':archive_size},'executable':{'path':'Kaigen-portable/Kaigen.exe','sha256':executable_hash,'bytes':executable_size}}))
`;

export function inspectWindowsArchive(archive, executable) {
  const output = execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['-I', '-c', INSPECT_WINDOWS_ARCHIVE, archive, executable],
    { encoding: 'utf8', stdio: 'pipe', windowsHide: true, maxBuffer: 1024 * 1024 });
  return JSON.parse(output);
}

async function recordWindowsExecutable(archive, executable, buildId, output) {
  assert.match(buildId, SAFE_ID);
  assert.equal(git('status', '--porcelain', '--untracked-files=all'), '', 'archive inspection requires the clean frozen candidate checkout');
  const source = { commit: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}') };
  const filename = 'scripts/publish-release.mjs', validatorSha256 = sha(await readFile(fileURLToPath(import.meta.url)));
  assert.equal(validatorSha256, sha(gitBytes('show', source.commit + ':' + filename)), 'executed validator bytes differ from frozen Git blob (including line endings)');
  const observed = inspectWindowsArchive(archive, executable);
  assert.equal(git('rev-parse', 'HEAD'), source.commit); assert.equal(git('status', '--porcelain', '--untracked-files=all'), '');
  assert.equal(sha(await readFile(fileURLToPath(import.meta.url))), validatorSha256, 'validator changed during inspection');
  const receipt = { schemaVersion: 1, kind: 'kaigen-windows-archive-executable', source, buildId, validatorSha256, ...observed };
  await writeFile(output, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ receiptSha256: sha(JSON.stringify(receipt, null, 2) + '\n'), archive: observed.archive, executable: observed.executable }));
}

async function getArtifact(artifact, directory, provenance) {
  const target = path.join(directory, String(artifact.id)); await mkdir(target);
  const response = await api('actions/artifacts/' + artifact.id + '/zip', { raw: true }); assert.equal(response.status, 302);
  const archive = path.join(target, 'actions.zip'); await download(response.headers.get('location'), archive, artifact.digest.slice(7));
  const extraction = path.join(target, 'files'); await mkdir(extraction);
  command('python3', ['-c', EXTRACT_ARTIFACT, archive, extraction]);
  const files = [];
  async function walk(root) {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const filename = path.join(root, entry.name);
      if (entry.isDirectory()) await walk(filename); else { assert.ok(entry.isFile()); files.push(filename); }
    }
  }
  await walk(extraction);
  provenance.push({ id: artifact.id, name: artifact.name, digest: artifact.digest, createdAt: artifact.created_at, workflowRun: artifact.workflow_run,
    files: await Promise.all(files.map(async filename => ({ name: path.relative(extraction, filename).replaceAll('\\', '/'), sha256: await fileHash(filename) }))) });
  return files;
}
const one = (files, name) => { const matching = files.filter(filename => path.basename(filename) === name); assert.equal(matching.length, 1, 'missing or ambiguous artifact file: ' + name); return matching[0]; };

function producingJob(key, artifactName) {
  if (key === 'windows') return 'package';
  if (key === 'native') return artifactName.slice('extended-native-'.length);
  if (artifactName.includes('debian') && !artifactName.includes('Debian13')) return 'debian-appimage';
  if (artifactName.includes('macos')) return 'macos-universal';
  return 'web-debian13-nginx';
}

async function loadManifest() {
  const canonical = await readReleaseVersion(process.cwd());
  const filename = `ci/releases/${canonical.tag}.json`;
  const info = await lstat(filename); assert.ok(info.isFile() && !info.isSymbolicLink());
  const bytes = await readFile(filename), manifest = JSON.parse(bytes);
  assertManifest(manifest, canonical.version);
  assert.equal(sha(bytes), process.env.KAIGEN_RELEASE_MANIFEST_SHA256, 'release manifest differs from the reviewed dispatch input');
  return { canonical, manifest, manifestPath: filename, manifestSha256: sha(bytes) };
}

async function verifySource() {
  const source = git('rev-parse', 'HEAD'), tree = git('rev-parse', 'HEAD^{tree}');
  assert.match(source, COMMIT);
  assertActionsContext(process.env, await json(process.env.GITHUB_EVENT_PATH), source);
  assert.equal(git('status', '--porcelain', '--untracked-files=all'), '', 'publication checkout is not clean');
  const context = await loadManifest(), { manifest, canonical } = context;
  const repository = await api(''); positive(repository.id, 'official repository ID'); assert.equal(repository.full_name, REPOSITORY);
  assert.equal((await api('branches/main')).commit.sha, source, 'stale publisher controller');
  assert.equal(git('rev-parse', manifest.source.commit + '^{tree}'), manifest.source.tree);
  assert.equal(git('merge-base', manifest.source.commit, source), manifest.source.commit);
  const catalogBytes = await readFile(manifest.catalog.path), catalog = JSON.parse(catalogBytes);
  assert.equal(sha(catalogBytes), manifest.catalog.sha256);
  assert.equal(sha(gitBytes('show', manifest.source.commit + ':' + manifest.catalog.path)), manifest.catalog.sha256, 'producer used another selection');
  assert.equal(catalog.selectionScope, 'release-full'); assert.equal(catalog.version, canonical.version);
  const verified = await preflight({ root: process.cwd(), catalogPath: path.resolve(manifest.catalog.path) });
  assert.equal(verified.status, 'PASS'); assert.equal(verified.selectionSha256, manifest.catalog.sha256);
  assert.equal(git('merge-base', catalog.productSource.commit, manifest.source.commit), catalog.productSource.commit, 'frozen candidate is not descended from the accepted product');
  const producerChanges = git('diff', '--name-only', catalog.productSource.commit, manifest.source.commit).split('\n').filter(Boolean);
  assert.ok(producerChanges.every(filename => releaseCiPaths(catalog).includes(filename)), 'frozen candidate changed accepted product or build inputs');
  const controller = { commit: source, tree };
  // A later controller retains the immutable producer source. Recompute its exact
  // permitted verification/data diff and the unchanged product/build Git closure.
  const controllerEquivalence = source === manifest.source.commit ? null : gitVerificationRevision(manifest.source, controller, canonical.version);
  const changes = controllerEquivalence?.changedFiles.map(file => file.path) ?? [];
  const producerSources = gitProducerSources(manifest);
  return { ...context, catalog, controller, controllerEquivalence, producerSources, repositoryId: repository.id, controllerChanges: changes, producerChanges };
}

async function producerArtifacts(context, incoming, provenance) {
  const { manifest, repositoryId } = context, runs = [], files = new Map();
  for (const [key, producer] of Object.entries(PRODUCERS)) {
    const pin = manifest.producers[key];
    const { source, equivalence } = context.producerSources[key];
    const run = await api('actions/runs/' + pin.runId);
    assertTrustedRun(run, producer, pin, source, repositoryId);
    const attempt = await api(`actions/runs/${pin.runId}/attempts/${pin.attempt}`);
    assertTrustedRun(attempt, producer, pin, source, repositoryId);
    const jobs = selectSuccessfulJobs(await all(`actions/runs/${pin.runId}/jobs?filter=all`, 'jobs'), producer, pin, source);
    const artifacts = await all(`actions/runs/${pin.runId}/artifacts`, 'artifacts');
    for (const artifactPin of pin.artifacts) {
      const matching = artifacts.filter(artifact => artifact.id === artifactPin.id && artifact.name === artifactPin.name);
      assert.equal(matching.length, 1, 'pinned artifact unavailable');
      assert.equal(artifacts.filter(artifact => artifact.name === artifactPin.name).length, 1, 'ambiguous artifact name');
      const artifact = matching[0], job = jobs.find(item => item.name === producingJob(key, artifact.name));
      assertArtifact(artifact, artifactPin, run, job, repositoryId);
      files.set(artifact.name, await getArtifact(artifact, incoming, provenance));
    }
    runs.push({ key, id: run.id, attempt: pin.attempt, workflowId: producer.id, source, equivalence, jobs });
  }
  return { runs, files };
}

export function selectVisibilityArtifact(jobs, artifacts, run, releaseLabel, source, repositoryId) {
  const name = 'Release visibility regression';
  const [job] = selectSuccessfulJobs(jobs.filter(item => item.name === name), { jobs: [name] },
    { runId: run.id, attempt: run.run_attempt }, source);
  const artifactName = `Kaigen-visibility-${releaseLabel}-${run.id}-${job.run_attempt}`;
  const matching = artifacts.filter(artifact => artifact.name === artifactName);
  assert.equal(matching.length, 1, 'missing or ambiguous artifact for the latest successful visibility job');
  const artifact = matching[0];
  assertArtifact(artifact, artifact, run, job, repositoryId);
  return { job, artifact };
}

async function visibilityEvidence(context, incoming, provenance) {
  const id = Number(process.env.GITHUB_RUN_ID), attempt = Number(process.env.GITHUB_RUN_ATTEMPT);
  const run = await api(`actions/runs/${id}/attempts/${attempt}`);
  assert.equal(run.name, 'publish-kaigen-release'); assert.equal(run.path, WORKFLOW_PATH);
  assert.equal(run.id, id); assert.equal(run.run_attempt, attempt); assert.equal(run.event, 'workflow_dispatch');
  assert.equal(run.head_branch, 'main'); assert.equal(run.head_sha, context.controller.commit);
  assert.equal(run.repository?.id, context.repositoryId); assert.equal(run.head_repository?.id, context.repositoryId);
  // Re-run failed jobs retains a successful dependency from an earlier attempt.
  // Bind the newest dependency result to its own attempt-specific artifact.
  const jobs = await all(`actions/runs/${id}/jobs?filter=all`, 'jobs');
  const artifacts = await all(`actions/runs/${id}/artifacts`, 'artifacts');
  const { artifact } = selectVisibilityArtifact(jobs, artifacts, run, context.canonical.releaseLabel, context.controller, context.repositoryId);
  const files = await getArtifact(artifact, incoming, provenance), results = [];
  for (const [scenario, count] of [['app-message-visibility-scenario', 17], ['app-message-visibility-edges', 23]]) {
    const result = await json(one(files, scenario + '.json')), runtime = await json(one(files, scenario + '-production-runtime.json'));
    assert.equal(result.ok, true); assert.equal(result.assertions, count);
    assert.equal(runtime.nodeEnv, 'production'); assert.equal(runtime.isProduction, true); assert.equal(runtime.privateCache, true);
    assert.ok(runtime.runtimeSources.length > 0 && runtime.runtimeSources.every(item => !item.debugJsx));
    if (scenario.endsWith('edges')) { assert.equal(result.details.nearTail.length, 4); assert.ok(result.details.nearTail.every(item => item.mountedWithoutScroll && item.recoveredByScroll)); }
    results.push({ scenario, result, runtime });
  }
  return results;
}

async function releaseState(tag) {
  const reference = await api('git/ref/tags/' + tag, { missing: true });
  if (reference?.object?.type === 'tag') reference.annotation = await api('git/tags/' + reference.object.sha);
  // The tag endpoint may omit unpublished drafts; list visible releases as well.
  const candidates = (await all('releases')).filter(release => release.tag_name === tag);
  assert.ok(candidates.length <= 1, 'ambiguous release tag');
  return { tag: reference, release: candidates[0] ?? null };
}

export function assertPreviousPublication(report, context, publication, attempt) {
  assert.equal(report.schemaVersion, 1); assert.equal(report.kind, 'kaigen-actions-release');
  assert.equal(report.repository, REPOSITORY); assert.equal(report.tag, context.canonical.tag);
  assert.equal(report.manifestSha256, context.manifestSha256);
  assert.deepEqual(report.source, context.manifest.source); assert.deepEqual(report.controller, context.controller);
  assert.equal(report.publication?.runId, publication.runId); assert.equal(report.publication?.attempt, attempt);
  assert.ok(attempt < publication.attempt);
  assert.ok(['VERIFIED_BEFORE_PUBLICATION', 'PUBLISHED_VERIFIED'].includes(report.status));
  assert.deepEqual(sorted(report.assets.map(asset => asset.name)), sorted(Object.values(assetNames(context.canonical.version)).flat()));
  for (const asset of report.assets) { assert.match(asset.sha256 ?? '', HASH); positive(asset.size, 'retained asset size'); }
}

async function retainedSourceAsset(state, context, publication, directory, incoming, provenance, sourceName) {
  const remote = state.release?.assets.find(asset => asset.name === sourceName);
  if (!remote) return null;
  assert.ok(publication.attempt > 1, 'source asset exists without a prior same-run publication attempt');
  const artifacts = await all(`actions/runs/${publication.runId}/artifacts`, 'artifacts');
  const prefix = `Kaigen-Actions-publication-${context.canonical.releaseLabel}-${publication.runId}-`;
  const matching = artifacts.filter(artifact => artifact.name.startsWith(prefix) && /^[1-9][0-9]*$/.test(artifact.name.slice(prefix.length)))
    .map(artifact => ({ artifact, attempt: Number(artifact.name.slice(prefix.length)) }))
    .filter(item => item.attempt < publication.attempt).sort((a, b) => b.attempt - a.attempt);
  assert.ok(matching.length, 'retained source has no Actions publication report');
  for (const { artifact, attempt } of matching) {
    const run = await api(`actions/runs/${publication.runId}/attempts/${attempt}`);
    assert.equal(run.id, publication.runId); assert.equal(run.run_attempt, attempt);
    assert.equal(run.path, WORKFLOW_PATH); assert.equal(run.name, 'publish-kaigen-release');
    assert.equal(run.head_sha, context.controller.commit); assert.equal(run.head_branch, 'main'); assert.equal(run.event, 'workflow_dispatch');
    assert.equal(run.repository?.id, context.repositoryId); assert.equal(run.head_repository?.id, context.repositoryId);
    assert.equal(run.status, 'completed');
    const jobs = (await all(`actions/runs/${publication.runId}/attempts/${attempt}/jobs`, 'jobs')).filter(job => job.name === 'release');
    assert.equal(jobs.length, 1); assert.equal(jobs[0].status, 'completed'); assert.equal(jobs[0].run_attempt, attempt);
    assertArtifact(artifact, artifact, run, jobs[0], context.repositoryId);
    const files = await getArtifact(artifact, incoming, provenance);
    const reportFiles = files.filter(filename => path.basename(filename) === 'publication-manifest.json');
    if (reportFiles.length === 0) continue;
    assert.equal(reportFiles.length, 1); const report = await json(reportFiles[0]);
    assertPreviousPublication(report, context, publication, attempt);
    const asset = report.assets.find(item => item.name === sourceName);
    assert.equal(asset.platform, 'source'); assert.deepEqual(asset.source, context.manifest.source);
    assertRemoteAssets([remote], [asset]);
    await publicBytes(remote, path.join(directory, sourceName), asset.sha256);
    return asset;
  }
  throw new Error('retained source lacks a matching same-run Actions publication report');
}

export const REQUIRED_GATE_ROLES = Object.freeze({
  windows: ['baseline', 'native-runtime', 'release-test-set', 'archive-executable'],
  debian: ['baseline', 'desktop-runtime'],
  macos: ['baseline', 'desktop-runtime', 'distribution'],
  web: ['backend', 'frontend', 'browser-runtime'],
  matrix: ['network', 'tor', 'normal-mode', 'offline-first', 'fault-rotation', 'entropy', 'formatting', 'about'],
  integral: ['cross-platform'],
  finalActions: ['windows-smoke', 'web-bundle'],
});
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
function keys(value, expected, label) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'invalid ' + label);
  assert.deepEqual(sorted(Object.keys(value)), sorted(expected), 'unexpected or missing fields in ' + label);
}
export function canonicalDigest(value) {
  const canonical = item => Array.isArray(item) ? item.map(canonical) : item && typeof item === 'object'
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, canonical(item[key])])) : item;
  return sha(JSON.stringify(canonical(value)));
}
function hash(value, label) { assert.match(value ?? '', HASH, label); }
function safeSource(value) { keys(value, ['commit', 'tree'], 'source'); identity(value); }
function buildIdentity(value) {
  keys(value, ['source', 'buildId', 'sourceArchiveSha256'], 'actual artifact build identity'); safeSource(value.source);
  assert.match(value.buildId, SAFE_ID); hash(value.sourceArchiveSha256, 'original source archive');
}

// Deliberately narrower than the producer CI allowlist: these exact verification
// files may change without invalidating an already built local artifact.
export function verificationRevisionPaths(version) {
  const { tag, releaseLabel } = releaseVersion(version), change = `openspec/changes/release-v${releaseLabel.replaceAll('.', '-')}/`;
  return ['scripts/test-native-verification-inputs.mjs', 'scripts/current-verification.mjs', 'scripts/test-current-verification-contract.mjs',
    'scripts/publish-release.mjs', 'scripts/test-publish-release.mjs', 'scripts/ci-incremental-verification.mjs',
    'ci/verification-current.json', 'ci/test-entrypoints.json', `ci/verification-${tag}.json`, `ci/releases/${tag}.json`, `ci/releases/evidence/${tag}/gate.json`,
    ...(tag === 'v0.2.9.9' ? ['scripts/incremental-windows-verification.mjs', 'scripts/frontend-verification-inputs.mjs', 'scripts/test-ci-release-selection.mjs', 'ci/releases/evidence/v0.2.9.9/local-full.json'] : []),
    ...['.openspec.yaml', 'proposal.md', 'design.md', 'tasks.md', 'specs/release-publication/spec.md'].map(name => change + name)];
}

export function verificationRevisionProof({ builtFrom, verificationSource, version, beforeTree, afterTree, readBlob, diff }) {
  safeSource(builtFrom); safeSource(verificationSource); assert.notDeepEqual(builtFrom, verificationSource);
  const records = buffer => {
    const result = new Map();
    for (const line of buffer.toString('utf8').split('\0').filter(Boolean)) {
      const match = /^(\d{6}) (blob|commit) ([a-f0-9]{40})\t(.+)$/s.exec(line);
      assert.ok(match && !result.has(match[4]), 'malformed or duplicate Git tree record');
      const [mode, type, objectId, filename] = match.slice(1);
      assert.ok(filename && !filename.includes('\\') && !filename.includes(':') && !filename.startsWith('/')
        && filename.split('/').every(part => part && part !== '.' && part !== '..'), 'unsafe Git tree path');
      result.set(filename, { path: filename, mode, type, objectId });
    }
    assert.ok(result.size > 0, 'empty Git tree'); return result;
  };
  const before = records(beforeTree), after = records(afterTree), permitted = new Set(verificationRevisionPaths(version));
  const { tag } = releaseVersion(version);
  const metadataAdditions = new Set([`ci/releases/${tag}.json`, `ci/releases/evidence/${tag}/gate.json`]);
  if (tag === 'v0.2.9.9') metadataAdditions.add('ci/releases/evidence/v0.2.9.9/local-full.json');
  const changed = sorted(new Set([...before.keys(), ...after.keys()])).filter(filename => JSON.stringify(before.get(filename)) !== JSON.stringify(after.get(filename)));
  const changedFiles = changed.map(filename => {
    assert.ok(permitted.has(filename), 'verification revision changed a product/build or unregistered input: ' + filename);
    const old = before.get(filename), current = after.get(filename);
    if (!old) {
      assert.ok(metadataAdditions.has(filename) && current?.type === 'blob' && current.mode === '100644',
        'verification revision added an executable, document, unknown or non-regular metadata input: ' + filename);
      const bytes = readBlob(verificationSource, filename);
      assert.ok(Buffer.isBuffer(bytes) && bytes.length > 0, 'empty or unavailable release metadata blob');
      return { path: filename, before: null, after: { mode: current.mode, objectId: current.objectId, sha256: sha(bytes), bytes: bytes.length } };
    }
    assert.ok(old?.type === 'blob' && current?.type === 'blob' && old.mode === current.mode && ['100644', '100755'].includes(old.mode),
      'verification revision added, removed or changed a file mode/type: ' + filename);
    const pin = (record, source) => ({ mode: record.mode, objectId: record.objectId, sha256: sha(readBlob(source, filename)) });
    return { path: filename, before: pin(old, builtFrom), after: pin(current, verificationSource) };
  });
  const unchanged = tree => [...tree.values()].filter(record => !changed.includes(record.path)).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const preserved = unchanged(before); assert.deepEqual(unchanged(after), preserved, 'product/build Git records differ');
  assert.ok(preserved.length > 0); assert.ok(Buffer.isBuffer(diff));
  return { schemaVersion: 1, kind: 'kaigen-verification-revision', version, builtFrom, verificationSource, changedFiles,
    unchangedFileCount: preserved.length, unchangedGitRecordsSha256: canonicalDigest(preserved), diffSha256: sha(diff) };
}

export function gitVerificationRevision(builtFrom, verificationSource, version) {
  safeSource(builtFrom); safeSource(verificationSource);
  for (const source of [builtFrom, verificationSource]) assert.equal(git('rev-parse', source.commit + '^{tree}'), source.tree, 'source tree differs from immutable commit');
  assert.equal(git('merge-base', builtFrom.commit, verificationSource.commit), builtFrom.commit, 'verification revision is not descended from the original build');
  return verificationRevisionProof({ builtFrom, verificationSource, version,
    beforeTree: gitBytes('ls-tree', '-rz', builtFrom.commit), afterTree: gitBytes('ls-tree', '-rz', verificationSource.commit),
    readBlob: (source, filename) => gitBytes('show', source.commit + ':' + filename),
    diff: gitBytes('-c', 'core.quotePath=false', 'diff', '--binary', '--full-index', '--no-ext-diff', '--no-textconv', '--no-renames', '--no-color',
      '--diff-algorithm=myers', '--no-indent-heuristic', '--unified=3', builtFrom.commit, verificationSource.commit, '--') });
}

export function gitVerificationCandidate(executingSource, candidateCommit, version) {
  safeSource(executingSource);
  if (candidateCommit === undefined) return executingSource;
  assert.equal(version, '0.2.9+9', 'explicit retained candidate is limited to the reviewed current release');
  assert.match(candidateCommit, COMMIT);
  const candidate = { commit: candidateCommit, tree: git('rev-parse', candidateCommit + '^{tree}') };
  if (candidate.commit === executingSource.commit) assert.deepEqual(candidate, executingSource);
  else gitVerificationRevision(candidate, executingSource, version);
  return candidate;
}

async function recordVerificationRevision(originalCommit, output, candidateCommit) {
  assert.match(originalCommit, COMMIT); assert.equal(git('status', '--porcelain', '--untracked-files=all'), '', 'verification proof requires a clean frozen checkout');
  const executingSource = { commit: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}') };
  assert.equal(sha(await readFile(fileURLToPath(import.meta.url))), sha(gitBytes('show', executingSource.commit + ':scripts/publish-release.mjs')), 'executed proof validator differs from frozen source');
  const builtFrom = { commit: originalCommit, tree: git('rev-parse', originalCommit + '^{tree}') };
  const { version } = await readReleaseVersion(process.cwd());
  const verificationSource = gitVerificationCandidate(executingSource, candidateCommit, version), proof = gitVerificationRevision(builtFrom, verificationSource, version);
  assert.equal(git('rev-parse', 'HEAD'), executingSource.commit); assert.equal(git('status', '--porcelain', '--untracked-files=all'), '');
  await writeFile(output, JSON.stringify(proof, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ proofSha256: sha(JSON.stringify(proof, null, 2) + '\n'), changedPaths: proof.changedFiles.map(file => file.path) }));
}

export function assertLabArtifactReceipt(receipt, { producerValidatorSha256, artifact }) {
  keys(receipt, ['schemaVersion', 'kind', 'status', 'platform', 'builtFrom', 'artifact', 'evidence', 'validator'], 'registered Lab artifact receipt');
  assert.equal(receipt.schemaVersion, 1); assert.equal(receipt.kind, 'kaigen-lab-candidate-artifact'); assert.equal(receipt.status, 'PASS');
  assert.ok(['debian', 'macos', 'web'].includes(receipt.platform)); buildIdentity(receipt.builtFrom);
  keys(receipt.artifact, ['name', 'sha256', 'bytes'], 'collected artifact');
  assert.equal(receipt.artifact.name, { debian: 'Kaigen-portable-debian-x64.zip', macos: 'Kaigen-portable-macos-universal.zip',
    web: 'Kaigen-Web-Debian13-Nginx-0.2.9.9.tar.gz' }[receipt.platform]);
  hash(receipt.artifact.sha256, 'collected artifact'); positive(receipt.artifact.bytes, 'collected artifact bytes');
  assert.deepEqual(receipt.artifact, artifact, 'actual retained archive differs from the registered collection receipt');
  keys(receipt.evidence, receipt.platform === 'web'
    ? ['readySha256', 'exportReadySha256', 'packageExportSha256', 'sourceSnapshotManifestSha256']
    : ['sourceMarkerSha256', 'buildStatusSha256', 'buildLogSha256', 'collectionLogSha256', 'sourceSnapshotManifestSha256'], 'original Lab evidence');
  for (const [name, value] of Object.entries(receipt.evidence)) hash(value, name);
  keys(receipt.validator, ['id', 'sha256'], 'registered collection validator'); assert.equal(receipt.validator.id, 'kaigen-lab-candidate-artifact');
  hash(producerValidatorSha256, 'approved Lab validator pin'); assert.equal(receipt.validator.sha256, producerValidatorSha256);
  return receipt;
}

async function ordinaryBinding(filename) {
  const resolved = path.resolve(filename), info = await lstat(resolved);
  assert.ok(info.isFile() && !info.isSymbolicLink(), 'ordinary immutable input file required');
  assert.equal(path.relative(resolved, await realpath(resolved)), '', 'input path resolves through a symlink');
  return { name: path.basename(resolved), sha256: await fileHash(resolved), bytes: info.size };
}

async function recordRetainedArtifact(producerFile, producerSha256, producerValidatorSha256, archive, output, candidateCommit) {
  hash(producerSha256, 'original registered producer receipt'); hash(producerValidatorSha256, 'approved registered producer code');
  assert.equal(git('status', '--porcelain', '--untracked-files=all'), '', 'retained artifact validation requires the clean frozen verification checkout');
  const executingSource = { commit: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}') };
  const validatorSha256 = sha(await readFile(fileURLToPath(import.meta.url)));
  assert.equal(validatorSha256, sha(gitBytes('show', executingSource.commit + ':scripts/publish-release.mjs')), 'executed retained-artifact validator differs from frozen source');
  const producerBinding = await ordinaryBinding(producerFile); assert.equal(producerBinding.sha256, producerSha256);
  assert.ok(producerBinding.bytes > 0 && producerBinding.bytes <= 4 * 1024 * 1024, 'unexpected producer receipt size');
  const producerBytes = await readFile(producerFile); assert.equal(sha(producerBytes), producerSha256);
  const artifact = await ordinaryBinding(archive), producer = assertLabArtifactReceipt(JSON.parse(producerBytes), { producerValidatorSha256, artifact });
  const { version } = await readReleaseVersion(process.cwd());
  if (producer.platform === 'web') assert.equal(version, '0.2.9+9', 'retained Web is limited to the reviewed current release');
  const verificationSource = gitVerificationCandidate(executingSource, candidateCommit, version);
  const proof = gitVerificationRevision(producer.builtFrom.source, verificationSource, version);
  // The registered collector rechecks original platform evidence, snapshot,
  // archive and privacy. Preserve its original receipt; this command rechecks
  // the retained bytes and Git without changing the artifact's build identity.
  const receipt = { schemaVersion: 1, kind: 'kaigen-retained-artifact-verification', status: 'PASS', platform: producer.platform, builtFrom: producer.builtFrom,
    verificationSource, artifactSha256: artifact.sha256, originalArtifactReceiptSha256: producerSha256,
    originalArtifactValidatorSha256: producerValidatorSha256, sourceEquivalenceSha256: canonicalDigest(proof), validatorSha256 };
  assert.deepEqual(await ordinaryBinding(archive), artifact); assert.equal((await ordinaryBinding(producerFile)).sha256, producerSha256);
  assert.equal(git('rev-parse', 'HEAD'), executingSource.commit); assert.equal(git('status', '--porcelain', '--untracked-files=all'), '');
  assert.equal(sha(await readFile(fileURLToPath(import.meta.url))), validatorSha256);
  await writeFile(output, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ receiptSha256: sha(JSON.stringify(receipt, null, 2) + '\n'), artifactSha256: artifact.sha256,
    sourceEquivalenceSha256: receipt.sourceEquivalenceSha256, builtFrom: receipt.builtFrom, verificationSource }));
}
function assertGatePlan(plan, version) {
  keys(plan, ['schemaVersion', 'kind', 'version', 'groups'], 'frozen coverage plan');
  assert.equal(plan.schemaVersion, 1); assert.equal(plan.kind, 'kaigen-release-required-leaves'); assert.equal(plan.version, version);
  keys(plan.groups, Object.keys(REQUIRED_GATE_ROLES), 'required gate groups');
  const ids = new Set();
  for (const [group, roles] of Object.entries(REQUIRED_GATE_ROLES)) {
    const spec = plan.groups[group]; keys(spec, ['inputsSha256', 'leaves'], 'coverage group'); hash(spec.inputsSha256, 'planned inputs');
    assert.ok(Array.isArray(spec.leaves) && spec.leaves.length > 0);
    for (const role of roles) assert.ok(spec.leaves.some(leaf => leaf.role === role), 'required coverage role missing: ' + group + ':' + role);
    for (const leaf of spec.leaves) {
      keys(leaf, ['id', 'role', 'validatorId', 'validatorSha256'], 'required leaf');
      assert.match(leaf.id, SAFE_ID); assert.match(leaf.role, SAFE_ID); assert.match(leaf.validatorId, SAFE_ID); hash(leaf.validatorSha256, 'validator pin');
      assert.ok(!ids.has(leaf.id), 'duplicate required leaf'); ids.add(leaf.id);
    }
  }
}
function assertGateLeaf(leaf, spec, expected) {
  keys(leaf, ['id', 'role', 'status', 'validatorId', 'validatorSha256', 'source', 'artifactSha256', 'runnerSha256', 'inputsSha256', 'receiptSha256', 'disposition', 'reuse'], 'executed gate leaf');
  for (const field of ['id', 'role', 'validatorId', 'validatorSha256']) assert.equal(leaf[field], spec[field]);
  assert.equal(leaf.status, 'PASS'); safeSource(leaf.source); assert.deepEqual(leaf.source, expected.source);
  for (const field of ['artifactSha256', 'runnerSha256', 'inputsSha256']) { hash(leaf[field], field); assert.equal(leaf[field], expected[field]); }
  hash(leaf.receiptSha256, 'original validator receipt');
  assert.ok(['executed', 'reused'].includes(leaf.disposition), 'unknown evidence disposition');
  if (leaf.disposition === 'executed') assert.equal(leaf.reuse, null);
  else {
    keys(leaf.reuse, ['inputsSha256', 'artifactSha256', 'runnerSha256', 'originalReceiptSha256'], 'reuse identity proof');
    for (const field of ['inputsSha256', 'artifactSha256', 'runnerSha256']) assert.equal(leaf.reuse[field], leaf[field]);
    assert.equal(leaf.reuse.originalReceiptSha256, leaf.receiptSha256);
  }
}
function assertGateGroup(group, plan, source, artifactSha256, unit = false) {
  keys(group, ['status', 'source', 'artifactSha256', 'runnerSha256', 'leaves', ...(unit ? ['builtFrom', 'artifactVerification'] : [])], 'gate group');
  assert.equal(group.status, 'PASS'); safeSource(group.source); assert.deepEqual(group.source, source);
  hash(group.artifactSha256, 'group artifact'); if (artifactSha256 !== undefined) assert.equal(group.artifactSha256, artifactSha256);
  hash(group.runnerSha256, 'group runner');
  assert.deepEqual(sorted(group.leaves.map(leaf => leaf.id)), sorted(plan.leaves.map(leaf => leaf.id)), 'incomplete or duplicate required leaf coverage');
  for (const leaf of group.leaves) assertGateLeaf(leaf, plan.leaves.find(item => item.id === leaf.id), { source, artifactSha256: group.artifactSha256, runnerSha256: group.runnerSha256, inputsSha256: plan.inputsSha256 });
}

// This is a privacy-safe export of local registered-validator results, committed
// and reviewed with the release manifest. These checks bind the complete frozen
// plan and original receipt hashes; they do not rerun or invent local runtime tests.
export function assertReleaseGates(gates, { source, candidateSource, assets, canonical, qtoxFixture, localFullPins, localFullValidatorSha256, archiveExecutableValidatorSha256, retainedArtifactValidatorSha256 = archiveExecutableValidatorSha256, verificationRevisionProofs = [], candidateSourceProof = null, qtoxApplicability = null, componentApplicability = null }) {
  const component = Object.hasOwn(gates, 'componentApplicability') ? gates.componentApplicability : null;
  if (component) {
    assert.equal(canonical.version, '0.2.9+9', 'component applicability is limited to the reviewed release');
    assert.ok(componentApplicability, 'component applicability requires independent immutable Git proof');
    assert.deepEqual(component, componentApplicability, 'component applicability differs from independently recomputed Git');
    assert.deepEqual(candidateSource, WEB_COMPONENT_TRANSITION.candidateSource, 'unreviewed component candidate');
    assert.deepEqual(component.source, candidateSource); assert.deepEqual(component.candidateSource, candidateSource);
    assert.deepEqual(component.evidenceSource, WEB_COMPONENT_TRANSITION.evidenceSource);
    assert.deepEqual(component.evidenceControllerSource, WEB_COMPONENT_TRANSITION.evidenceControllerSource);
    assert.equal(component.kind, 'kaigen-v0299-web-component-applicability');
    assert.equal(component.webArtifactReuseAllowed, false); assert.equal(component.webCoreInDesktop, false);
  } else assert.equal(componentApplicability, null, 'component proof is absent from the gate');
  const desktopEvidenceSource = component ? component.evidenceSource : candidateSource;
  if (JSON.stringify(candidateSource) !== JSON.stringify(source)) {
    assert.equal(canonical.version, '0.2.9+9', 'candidate source equivalence is limited to the reviewed current release');
    assert.ok(candidateSourceProof, 'local candidate and Actions producers must use the same frozen source or independently verified metadata equivalence');
    assert.deepEqual(candidateSourceProof.builtFrom, candidateSource); assert.deepEqual(candidateSourceProof.verificationSource, source);
    assert.equal(candidateSourceProof.version, canonical.version);
  }
  keys(gates, ['schemaVersion', 'kind', 'status', 'fullPlatformReleaseGate', 'generatedAtUtc', 'candidate', 'verificationRevisions', 'plan', 'planSha256', 'units', 'matrix', 'integral', 'windowsTestSet', 'windowsExecutable', 'qtox', 'finalActions',
    ...(Object.hasOwn(gates, 'qtoxReuseValidation') ? ['qtoxReuseValidation'] : []),
    ...(Object.hasOwn(gates, 'componentApplicability') ? ['componentApplicability'] : [])], 'release gate export');
  assert.equal(gates.schemaVersion, 1); assert.equal(gates.kind, 'kaigen-release-gate-export'); assert.equal(gates.status, 'PASS');
  assert.equal(gates.fullPlatformReleaseGate, true, 'Windows/Web-only runtime proof is not the full release gate');
  assert.ok(Number.isFinite(Date.parse(gates.generatedAtUtc)));
  keys(gates.candidate, ['source', 'buildId', 'sourceArchiveSha256'], 'candidate'); safeSource(gates.candidate.source);
  assert.deepEqual(gates.candidate.source, candidateSource); assert.match(gates.candidate.buildId, SAFE_ID); hash(gates.candidate.sourceArchiveSha256, 'candidate archive');
  assertGatePlan(gates.plan, canonical.version); assert.equal(gates.planSha256, canonicalDigest(gates.plan));
  keys(gates.units, PLATFORMS, 'four platform units');
  assert.deepEqual(gates.verificationRevisions, verificationRevisionProofs, 'verification revisions differ from independently recomputed Git proofs');
  const originalSources = new Set();
  for (const platform of PLATFORMS) {
    const unit = gates.units[platform]; buildIdentity(unit.builtFrom);
    const evidenceSource = platform === 'web' ? candidateSource : desktopEvidenceSource;
    assertGateGroup(unit, gates.plan.groups[platform], evidenceSource, undefined, true);
    if (component && platform === 'web') {
      assert.deepEqual(unit.builtFrom, gates.candidate, 'fixed Web requires a real current candidate artifact');
      for (const role of ['backend', 'browser-runtime']) assert.ok(unit.leaves.some(leaf => leaf.role === role && leaf.disposition === 'executed'),
        'fixed Web backend and affected browser runtime require actual current execution');
    }
    if (unit.builtFrom.source.commit === evidenceSource.commit) {
      if (component && platform !== 'web') {
        assert.equal(platform, 'windows', 'unexpected current desktop evidence identity');
        assert.deepEqual(unit.builtFrom, { source: WEB_COMPONENT_TRANSITION.evidenceSource,
          buildId: 'release-v0299-r9-25a38de3f185-a122251bf564', sourceArchiveSha256: 'a122251bf564e781f24b848745c155c17fd1503355adc1edf2fbdff9686619b5' }, 'original Windows build identity changed');
      } else assert.deepEqual(unit.builtFrom, gates.candidate, 'current-source artifact build tuple differs from candidate');
      assert.equal(unit.artifactVerification, null);
    } else {
      // Windows anchors the local candidate; retained units require fresh owner
      // validation against its unchanged product/build closure.
      assert.ok(['debian', 'macos'].includes(platform) || (platform === 'web' && canonical.version === '0.2.9+9'),
        'platform requires the current shared candidate identity');
      originalSources.add(unit.builtFrom.source.commit);
      const proof = verificationRevisionProofs.find(item => item.builtFrom.commit === unit.builtFrom.source.commit);
      assert.ok(proof, 'retained artifact lacks a verified source closure'); assert.deepEqual(proof.builtFrom, unit.builtFrom.source);
      assert.deepEqual(proof.verificationSource, evidenceSource); assert.equal(proof.version, canonical.version);
      assertRetainedArtifact(unit, proof, component && platform !== 'web' ? component.evidenceValidatorSha256 : retainedArtifactValidatorSha256, platform);
    }
  }
  assert.deepEqual(sorted(verificationRevisionProofs.map(proof => proof.builtFrom.commit)), sorted(originalSources), 'missing, duplicate or unrelated verification proof');
  const artifactSet = canonicalDigest(Object.fromEntries(PLATFORMS.map(platform => [platform, gates.units[platform].artifactSha256])));
  for (const key of ['matrix', 'integral']) assertGateGroup(gates[key], gates.plan.groups[key], candidateSource, artifactSet);

  const windows = gates.windowsTestSet;
  keys(windows, ['publicRef', 'summary', 'validatorSha256', 'returnedProofSha256', 'privatePayloadReads', 'clientCount', 'localFull'], 'Windows public validation');
  keys(windows.publicRef, ['sha256', 'logicalDigest'], 'redacted immutable public reference');
  hash(windows.publicRef.sha256, 'Windows public projection'); hash(windows.publicRef.logicalDigest, 'Windows logical digest');
  hash(windows.validatorSha256, 'Windows validator'); hash(windows.returnedProofSha256, 'Windows returned validation proof');
  assert.equal(windows.privatePayloadReads, 0); assert.equal(windows.clientCount, 9);
  const summary = windows.summary;
  keys(summary, ['transactionId', 'deploymentKind', 'validationProfile', 'sourceTree', 'artifact', 'verification', 'generatedAtUtc'], 'Windows public summary');
  assert.match(summary.transactionId, SAFE_ID); assert.equal(summary.deploymentKind, 'release-test-set'); assert.equal(summary.validationProfile, 'incremental');
  assert.ok(Number.isFinite(Date.parse(summary.generatedAtUtc)));
  keys(summary.sourceTree, ['fileCount', 'sha256'], 'Windows input tree'); positive(summary.sourceTree.fileCount, 'Windows file count'); hash(summary.sourceTree.sha256, 'Windows input tree digest');
  keys(summary.artifact, ['bytes', 'sha256'], 'Windows candidate artifact'); positive(summary.artifact.bytes, 'Windows archive bytes');
  assert.equal(summary.artifact.sha256.toLowerCase(), gates.units.windows.artifactSha256);
  keys(summary.verification, ['status', 'checkCount', 'passedCheckCount', 'checksDigest', 'protectedDataUnchanged', 'privateDataAbsent'], 'Windows actual checks');
  assert.equal(summary.verification.status, 'PASS'); positive(summary.verification.checkCount, 'Windows check count');
  assert.equal(summary.verification.passedCheckCount, summary.verification.checkCount); hash(summary.verification.checksDigest, 'Windows sorted passed checks');
  assert.equal(summary.verification.protectedDataUnchanged, true); assert.equal(summary.verification.privateDataAbsent, true);
  const windowsLeaves = gates.units.windows.leaves.filter(leaf => leaf.role === 'release-test-set');
  assert.ok(windowsLeaves.some(leaf => leaf.validatorSha256 === windows.validatorSha256 && leaf.receiptSha256 === windows.returnedProofSha256), 'Windows public proof is not bound to its executed required leaf');
  assertLocalFullCoverage(windows.localFull, { source: desktopEvidenceSource, artifactSha256: gates.units.windows.artifactSha256,
    expectedChecks: localFullPins, validatorSha256: localFullValidatorSha256 });
  assert.ok(gates.units.windows.leaves.some(leaf => leaf.role === 'baseline' && leaf.disposition === 'executed'
    && leaf.validatorSha256 === windows.localFull.validatorSha256 && leaf.receiptSha256 === windows.localFull.validatorProofSha256),
  'local full coverage is not bound to the executed baseline validator proof');

  const shipping = assertWindowsExecutableBridge(gates.windowsExecutable, { source: desktopEvidenceSource, buildId: gates.units.windows.builtFrom.buildId,
    archive: { sha256: gates.units.windows.artifactSha256, bytes: summary.artifact.bytes }, validatorSha256: archiveExecutableValidatorSha256 });
  const archiveLeaves = gates.units.windows.leaves.filter(leaf => leaf.role === 'archive-executable');
  assert.equal(archiveLeaves.length, 1, 'exactly one executed archive inspection is required');
  assert.equal(archiveLeaves[0].disposition, 'executed');
  assert.equal(archiveLeaves[0].validatorSha256, archiveExecutableValidatorSha256);
  assert.equal(archiveLeaves[0].receiptSha256, gates.windowsExecutable.receiptSha256, 'archive inspection differs from its required executed leaf');

  const qtox = gates.qtox;
  keys(qtox, ['schemaVersion', 'status', 'scope', 'identity', 'targets', 'productionContacted', 'secretsIncluded'], 'qTox aggregate');
  assert.equal(qtox.schemaVersion, 1); assert.equal(qtox.status, 'PASS'); assert.equal(qtox.scope, 'qtox-release-gate');
  keys(qtox.identity, ['kaigenCommit', 'sourceTree', 'buildId', 'qtoxFixtureSha256', 'qtoxInstallerSha256', 'qtoxRuntimeManifestSha256', 'qtoxExecutableSha256'], 'qTox identity');
  const reusedQtox = Object.hasOwn(gates, 'qtoxReuseValidation');
  if (reusedQtox) {
    assert.equal(canonical.version, '0.2.9+9', 'qTox reuse is limited to the reviewed current release');
    assertQtoxReuseValidation(gates.qtoxReuseValidation, { original: qtox, source: candidateSource, applicability: qtoxApplicability,
      validatorSha256: retainedArtifactValidatorSha256, currentTargets: ['desktop', 'web'].map(target => ({ target,
        builtFrom: gates.units[target === 'desktop' ? 'windows' : 'web'].builtFrom,
        artifactSha256: target === 'desktop' ? shipping.sha256 : gates.units.web.artifactSha256,
        originalReceiptSha256: qtox.targets.find(item => item.target === target)?.receiptSha256.toLowerCase() })) });
  } else {
    assert.equal(qtox.identity.kaigenCommit, candidateSource.commit); assert.equal(qtox.identity.sourceTree, candidateSource.tree); assert.equal(qtox.identity.buildId, gates.candidate.buildId);
    assert.deepEqual(gates.units.web.builtFrom, gates.candidate, 'different Web build requires explicit original qTox reuse validation');
  }
  assert.equal(qtox.identity.qtoxFixtureSha256.toLowerCase(), qtoxFixture.sha256);
  assert.equal(qtox.identity.qtoxInstallerSha256.toLowerCase(), qtoxFixture.installerSha256);
  for (const field of ['qtoxRuntimeManifestSha256', 'qtoxExecutableSha256']) hash(qtox.identity[field].toLowerCase(), field);
  assert.deepEqual(sorted(qtox.targets.map(target => target.target)), ['desktop', 'web']);
  for (const target of qtox.targets) {
    keys(target, ['target', 'artifactSha256', 'receiptSha256', 'checks', 'screenshots'], 'qTox target');
    if (!reusedQtox) assert.equal(target.artifactSha256.toLowerCase(), target.target === 'desktop' ? shipping.sha256 : gates.units.web.artifactSha256);
    hash(target.receiptSha256.toLowerCase(), 'qTox original receipt'); assert.equal(target.checks, 11); assert.equal(target.screenshots, 4);
  }
  assert.notEqual(qtox.targets[0].receiptSha256, qtox.targets[1].receiptSha256);
  assert.equal(qtox.productionContacted, false); assert.equal(qtox.secretsIncluded, false);

  keys(gates.finalActions, ['windowsSmoke', 'webBundle'], 'final Actions runtime evidence');
  const finalPlan = gates.plan.groups.finalActions;
  assert.deepEqual(sorted(finalPlan.leaves.map(leaf => leaf.role)), ['web-bundle', 'windows-smoke']);
  for (const [key, role, platform, suffix] of [['windowsSmoke', 'windows-smoke', 'windows', '.zip'], ['webBundle', 'web-bundle', 'web', '.tar.gz']]) {
    const leaf = gates.finalActions[key], asset = assets.find(item => item.platform === platform && item.name.endsWith(suffix)); assert.ok(asset);
    hash(leaf.runnerSha256, 'final runtime runner');
    assertGateLeaf(leaf, finalPlan.leaves.find(item => item.role === role), { source: Object.hasOwn(asset, 'source') ? asset.source : source, artifactSha256: asset.sha256, runnerSha256: leaf.runnerSha256, inputsSha256: finalPlan.inputsSha256 });
    assert.equal(leaf.disposition, 'executed', 'final published bytes require an actual runtime check');
  }
  return gates;
}

const QTOX_ORIGINAL_AGGREGATE_SHA256 = 'd9f34a70c42eda7a35d4d9d41219d1301dd4fa82817bb13d4ebb03eff5fd3398';
export function qtoxReuseApplicability(source) {
  // This is source applicability only. It neither executes qTox nor substitutes
  // for the separate current incoming-Accept/file runtime coverage.
  const projection = reviewedFrontendSourceCompatibility({ root: process.cwd(), source, originalSource: FRONTEND_TRANSITION.before,
    checkId: 'frontend:ui-identity', command: { program: 'npm.cmd', args: ['run', 'test:ui-identity', '--', '--no-qtox'] },
    securityValidationSha256: FRONTEND_TRANSITION.securityValidationSha256 });
  const originalSource = FRONTEND_TRANSITION.before, seen = new Set();
  const visit = filename => {
    assert.ok(!filename.startsWith('../') && !filename.includes('\\') && !filename.includes(':'), 'unsafe qTox source input');
    if (seen.has(filename)) return; seen.add(filename);
    const before = gitBytes('ls-tree', originalSource.commit, '--', filename), after = gitBytes('ls-tree', source.commit, '--', filename);
    assert.ok(/^100(?:644|755) blob [a-f0-9]{40}\t/u.test(before.toString('utf8')), 'qTox input must be an ordinary tracked file: ' + filename);
    assert.deepEqual(after, before, 'qTox input mode, membership or bytes changed: ' + filename);
    const content = gitBytes('show', originalSource.commit + ':' + filename).toString('utf8');
    if (filename.endsWith('.mjs')) for (const match of content.matchAll(/(?:^|\n)\s*(?:import\s+(?:[\w*$\s{},]*?\s+from\s+)?|export\s+(?:[\w*$\s{},]*?\s+from\s+))["'](\.[^"'\r\n]+\.mjs)["']/gu))
      visit(path.posix.normalize(path.posix.join(path.posix.dirname(filename), match[1])));
  };
  for (const filename of ['package.json', 'scripts/fixtures/qtox-v1.18.5-windows.json', 'scripts/test-qtox-release-gate.mjs',
    'scripts/test-qtox-interop.mjs', 'scripts/qtox-interop-adapters.mjs']) visit(filename);
  const commands = Object.fromEntries(['test:qtox-release-gate', 'test:qtox-interop-fixture'].map(name => [name,
    JSON.parse(gitBytes('show', originalSource.commit + ':package.json')).scripts[name]]));
  assert.equal(commands['test:qtox-release-gate'], 'node scripts/test-qtox-release-gate.mjs');
  assert.equal(commands['test:qtox-interop-fixture'], 'node scripts/qtox-interop-adapters.mjs --self-test && node scripts/test-qtox-interop.mjs --self-test && node scripts/test-qtox-release-gate.mjs --self-test');
  return { originalSource, candidateSource: source, commands,
    inputs: [...seen].sort().map(filename => ({ path: filename, sha256: sha(gitBytes('show', source.commit + ':' + filename)) })),
    sourceProjection: { ...Object.fromEntries(['reviewedProductSource', 'projections', 'securityValidationSha256', 'sourceClosureSha256'].map(name => [name, projection[name]])),
      ...(projection.componentApplicability ? { componentApplicability: projection.componentApplicability } : {}) } };
}
export function assertQtoxReuseValidation(value, { original, source, currentTargets, applicability, validatorSha256 }) {
  keys(value, ['receiptSha256', 'receipt'], 'qTox reuse validation');
  const receipt = value.receipt;
  keys(receipt, ['schemaVersion', 'kind', 'status', 'disposition', 'source', 'originalAggregateSha256', 'currentTargets', 'applicability', 'validatorSha256'], 'qTox reuse receipt');
  assert.equal(receipt.schemaVersion, 1); assert.equal(receipt.kind, 'kaigen-qtox-reuse-validation');
  assert.equal(receipt.status, 'PASS'); assert.equal(receipt.disposition, 'reused');
  assert.equal(receipt.originalAggregateSha256, QTOX_ORIGINAL_AGGREGATE_SHA256);
  assert.equal(sha(JSON.stringify(original, null, 2) + '\n'), QTOX_ORIGINAL_AGGREGATE_SHA256, 'original qTox aggregate bytes changed');
  assert.deepEqual(receipt.source, source); assert.deepEqual(receipt.currentTargets, currentTargets, 'qTox reuse current artifact or original receipt binding changed');
  assert.ok(applicability, 'qTox source/input applicability must be independently recomputed');
  assert.deepEqual(receipt.applicability, applicability, 'qTox source/input applicability differs from immutable Git');
  hash(validatorSha256, 'trusted qTox reuse validator'); assert.equal(receipt.validatorSha256, validatorSha256);
  assert.equal(value.receiptSha256, sha(JSON.stringify(receipt, null, 2) + '\n'), 'qTox reuse receipt bytes changed');
}

function assertRetainedArtifact(unit, proof, validatorSha256, platform) {
  const value = unit.artifactVerification;
  keys(value, ['receiptSha256', 'receipt'], 'fresh retained-artifact validation'); hash(value.receiptSha256, 'original owner validation receipt');
  const receipt = value.receipt;
  keys(receipt, ['schemaVersion', 'kind', 'status', 'platform', 'builtFrom', 'verificationSource', 'artifactSha256', 'originalArtifactReceiptSha256', 'originalArtifactValidatorSha256', 'sourceEquivalenceSha256', 'validatorSha256'], 'retained-artifact owner receipt');
  assert.equal(receipt.schemaVersion, 1); assert.equal(receipt.kind, 'kaigen-retained-artifact-verification'); assert.equal(receipt.status, 'PASS');
  assert.equal(receipt.platform, platform);
  assert.deepEqual(receipt.builtFrom, unit.builtFrom); assert.deepEqual(receipt.verificationSource, unit.source);
  assert.equal(receipt.artifactSha256, unit.artifactSha256); hash(receipt.originalArtifactReceiptSha256, 'original artifact provenance receipt');
  hash(receipt.originalArtifactValidatorSha256, 'original registered producer validator');
  assert.equal(receipt.sourceEquivalenceSha256, canonicalDigest(proof)); hash(receipt.validatorSha256, 'current owner validator');
  assert.equal(receipt.validatorSha256, validatorSha256, 'retained artifact was not checked by the current executable publisher validator');
  assert.equal(value.receiptSha256, sha(JSON.stringify(receipt, null, 2) + '\n'), 'original retained-artifact validation receipt bytes changed');
  const leaves = unit.leaves.filter(leaf => leaf.role === 'artifact-verification');
  assert.equal(leaves.length, 1, 'retained artifact requires one fresh owner artifact-verification leaf');
  assert.equal(leaves[0].disposition, 'executed'); assert.equal(leaves[0].receiptSha256, value.receiptSha256);
  assert.equal(leaves[0].validatorSha256, receipt.validatorSha256);
}

// This preserves the original local inspection receipt in the reviewed gate
// export. Its hash is an evidence binding, not a signature or runtime PASS.
export function assertWindowsExecutableBridge(value, { source, buildId, archive, validatorSha256 }) {
  keys(value, ['receiptSha256', 'receipt'], 'Windows ZIP/executable bridge');
  hash(value.receiptSha256, 'original archive inspection receipt');
  const receipt = value.receipt;
  keys(receipt, ['schemaVersion', 'kind', 'source', 'buildId', 'validatorSha256', 'archive', 'executable'], 'archive inspection receipt');
  assert.equal(receipt.schemaVersion, 1); assert.equal(receipt.kind, 'kaigen-windows-archive-executable');
  safeSource(receipt.source); assert.deepEqual(receipt.source, source); assert.equal(receipt.buildId, buildId);
  hash(validatorSha256, 'trusted archive inspector'); assert.equal(receipt.validatorSha256, validatorSha256);
  keys(receipt.archive, ['sha256', 'bytes'], 'inspected ZIP'); hash(receipt.archive.sha256, 'inspected ZIP hash'); positive(receipt.archive.bytes, 'inspected ZIP bytes');
  assert.deepEqual(receipt.archive, archive, 'inspected ZIP differs from validated Windows candidate');
  keys(receipt.executable, ['path', 'sha256', 'bytes'], 'inspected executable');
  assert.equal(receipt.executable.path, 'Kaigen-portable/Kaigen.exe'); hash(receipt.executable.sha256, 'inspected executable hash'); positive(receipt.executable.bytes, 'inspected executable bytes');
  assert.equal(value.receiptSha256, sha(JSON.stringify(receipt, null, 2) + '\n'), 'original archive inspection receipt bytes changed');
  return receipt.executable;
}

// The registered incremental runner keeps its truthful incremental labels even
// when every current local full check runs. Preserve original plan/result pins.
export function assertLocalFullCoverage(value, { source, artifactSha256, expectedChecks, validatorSha256, referenceRoot = process.cwd() }) {
  keys(value, ['validatorSha256', 'validatorProofSha256', 'plan', 'receipt', ...(Object.hasOwn(value, 'nativeReuse') ? ['nativeReuse'] : []), ...(Object.hasOwn(value, 'frontendReuse') ? ['frontendReuse'] : []),
    ...(Object.hasOwn(value, 'buildPipelineCoverage') ? ['buildPipelineCoverage'] : [])], 'validated local full coverage');
  assert.equal(value.validatorSha256, validatorSha256); hash(value.validatorProofSha256, 'local full validator proof');
  keys(value.plan, ['sha256', 'source', 'checks'], 'original local full plan');
  hash(value.plan.sha256, 'original local full plan hash'); safeSource(value.plan.source); assert.deepEqual(value.plan.source, source);
  assert.ok(Array.isArray(expectedChecks) && expectedChecks.length > 0);
  const inputCoverage = Object.hasOwn(value, 'buildPipelineCoverage') ? localBuildPipelineCoverage(source, referenceRoot) : null;
  if (inputCoverage) assertLocalBuildPipelineCoverage(value, inputCoverage, expectedChecks);
  const nativeReuse = value.nativeReuse ?? [], frontendReuse = value.frontendReuse ?? [];
  assert.ok(Array.isArray(nativeReuse) && Array.isArray(frontendReuse));
  const reuse = [...nativeReuse, ...frontendReuse];
  assert.ok(Array.isArray(reuse));
  assert.equal(new Set(reuse.map(proof => proof.checkId)).size, reuse.length, 'duplicate native reuse validation');
  for (const proof of nativeReuse) assertNativeReuseExport(proof, { source, artifactSha256, referenceRoot });
  for (const proof of frontendReuse) assertFrontendReuseExport(proof, { source, referenceRoot });
  assert.deepEqual(value.plan.checks, expectedChecks.map(check => ({ ...check,
    ...(inputCoverage && check.id === inputCoverage.checkId ? { inputsSha256: inputCoverage.originalInputsSha256 } : {}),
    action: reuse.some(proof => proof.checkId === check.id) ? 'reuse' : 'run' })), 'local full plan must match every trusted current check and source input');
  const receipt = value.receipt;
  keys(receipt, ['sha256', 'kind', 'status', 'source', 'planSha256', 'archiveSha256', 'fullBaselineRerun', 'checks'], 'original local full result receipt');
  hash(receipt.sha256, 'original local full result hash'); assert.equal(receipt.kind, 'kaigen-windows-incremental-verification'); assert.equal(receipt.status, 'PASS');
  safeSource(receipt.source); assert.deepEqual(receipt.source, source); assert.equal(receipt.planSha256, value.plan.sha256);
  assert.equal(receipt.archiveSha256, artifactSha256); assert.equal(receipt.fullBaselineRerun, false);
  assert.deepEqual(sorted(receipt.checks.map(check => check.id)), sorted(expectedChecks.map(check => check.id)), 'incomplete or duplicate local full results');
  for (const check of receipt.checks) {
    keys(check, ['id', 'status', 'disposition', 'source', 'inputsSha256', 'resultSha256'], 'original local full check result');
    const expected = expectedChecks.find(item => item.id === check.id);
    const proof = reuse.find(item => item.checkId === check.id);
    assert.equal(check.status, 'PASS'); hash(check.resultSha256, 'original check result'); safeSource(check.source);
    if (proof) {
      assert.equal(check.disposition, 'reused'); assert.deepEqual(check.source, proof.source);
      assert.equal(check.resultSha256, proof.resultSha256); assert.equal(check.inputsSha256, proof.originalInputsSha256);
    } else {
      assert.equal(expected.action, 'run'); assert.equal(check.disposition, 'rerun');
      assert.deepEqual(check.source, source);
      assert.equal(check.inputsSha256, inputCoverage && check.id === inputCoverage.checkId ? inputCoverage.originalInputsSha256 : expected.inputsSha256);
    }
  }
  assert.ok(reuse.every(proof => receipt.checks.some(check => check.id === proof.checkId)), 'unused native reuse validation');
}

// One existing executed result declared the full-current roots. The publisher
// also enumerates CI files. Preserve both digests and prove that exact coverage;
// neither the original result nor its execution time is rewritten.
export function localBuildPipelineCoverage(source, referenceRoot = process.cwd()) {
  assert.deepEqual(source, { commit: '419ae6a345dac6acbf5f82397059ea9901a2e0aa', tree: '25a38de3f185409236205e63286a4a4c4d7d8394' },
    'local CI input coverage is limited to the reviewed actual candidate');
  const readGit = (...args) => execFileSync('git', ['-c', `safe.directory=${referenceRoot.replaceAll('\\', '/')}`, '-C', referenceRoot, ...args], { windowsHide: true, maxBuffer: 96 * 1024 * 1024 });
  assert.equal(readGit('rev-parse', source.commit + '^{tree}').toString().trim(), source.tree);
  const blobs = new Map();
  const readBlob = filename => { if (!blobs.has(filename)) blobs.set(filename, readGit('show', source.commit + ':' + filename)); return blobs.get(filename); };
  const catalog = JSON.parse(readBlob('ci/verification-v0.2.9.9.json')), pkg = JSON.parse(readBlob('package.json'));
  assert.equal(catalog.version, '0.2.9+9');
  const npmScripts = new Set(pkg.scripts['test:frontend'].split(/\s*&&\s*/u).map(command => /^npm run (test:[\w-]+)$/u.exec(command)?.[1]).filter(Boolean));
  const ciPaths = readGit('ls-tree', '-r', '--name-only', source.commit, '--', ...releaseCiPaths(catalog)).toString().trim().split('\n').filter(Boolean);
  const ciInputs = ciPaths.map(filename => {
    const record = readGit('ls-tree', source.commit, '--', filename).toString().trim();
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/u.exec(record);
    assert.ok(match && match[3] === filename, 'CI coverage requires the exact ordinary Git record');
    return { path: filename, mode: match[1], objectId: match[2], sha256: sha(readBlob(filename)) };
  });
  assert.equal(ciInputs.length, 22);
  const checkId = 'frontend:build-pipeline', pin = paths => localFullCheckPins(catalog, npmScripts, readBlob, paths).find(check => check.id === checkId).inputsSha256;
  return { schemaVersion: 1, kind: 'kaigen-local-build-pipeline-input-coverage', disposition: 'validated-existing-result', checkId, source,
    planSha256: 'fbb190000e9f42d2fa8d8d97040c9b9d9e3f79bc465f87843033be094824a691',
    receiptSha256: '6358310a43f57a19224859060944718ac47038b5954143766ebfd74cf9433b10',
    resultSha256: '741081987a506524f7eeaf2762e9659f0810a689f5bf9dc65d30dc3c7e68df2b',
    originalInputsSha256: pin([]), expandedInputsSha256: pin(ciPaths), ciInputs,
    validatorSha256: sha(readBlob('scripts/incremental-windows-verification.mjs')),
    // These are observations during data validation; the original execution's
    // materialization is bound by receiptSha256 and the original validator.
    validationMaterialization: { before: source, after: source, cleanBefore: true, cleanAfter: true } };
}

export function assertLocalBuildPipelineCoverage(value, expected, expectedChecks) {
  assert.deepEqual(value.buildPipelineCoverage, expected, 'local CI input coverage differs from immutable source and original pins');
  assert.equal(value.validatorSha256, expected.validatorSha256);
  assert.equal(value.plan.sha256, expected.planSha256); assert.equal(value.receipt.sha256, expected.receiptSha256);
  assert.deepEqual(value.plan.source, expected.source); assert.deepEqual(value.receipt.source, expected.source);
  const planned = value.plan.checks.find(check => check.id === expected.checkId), result = value.receipt.checks.find(check => check.id === expected.checkId);
  assert.ok(planned && result); assert.equal(planned.action, 'run'); assert.equal(planned.inputsSha256, expected.originalInputsSha256);
  assert.equal(result.status, 'PASS'); assert.equal(result.disposition, 'rerun'); assert.deepEqual(result.source, expected.source);
  assert.equal(result.resultSha256, expected.resultSha256); assert.equal(result.inputsSha256, expected.originalInputsSha256);
  assert.equal(expectedChecks.find(check => check.id === expected.checkId)?.inputsSha256, expected.expandedInputsSha256);
}
export function assertFrontendReuseExport(proof, { source, referenceRoot = process.cwd() }) {
  keys(proof, ['schemaVersion', 'kind', 'checkId', 'source', 'candidateSource', 'reviewedProductSource', 'command', 'projections', 'securityValidationSha256',
    'sourceClosureSha256', 'readersSha256', 'resultSha256', 'originalInputsSha256', 'outputSha256', 'startedAt', 'completedAt', 'migrationSha256'], 'retained frontend validation');
  const compatibility = reviewedFrontendSourceCompatibility({ root: referenceRoot, source, originalSource: proof.source,
    checkId: proof.checkId, command: proof.command, securityValidationSha256: proof.securityValidationSha256 });
  for (const [name, value] of Object.entries(compatibility)) assert.deepEqual(proof[name], value, 'publisher frontend projection differs: ' + name);
  for (const name of ['resultSha256', 'originalInputsSha256', 'outputSha256', 'migrationSha256']) hash(proof[name], name);
  for (const name of ['startedAt', 'completedAt']) assert.ok(Number.isFinite(Date.parse(proof[name])), 'invalid original frontend timestamp');
  assert.ok(Date.parse(proof.completedAt) >= Date.parse(proof.startedAt));
}
export function assertNativeReuseExport(proof, { source, artifactSha256, referenceRoot = process.cwd() }) {
  keys(proof, ['schemaVersion', 'kind', 'checkId', 'source', 'candidateSource', 'closure', 'resultSha256', 'originalInputsSha256', 'outputSha256', 'startedAt', 'completedAt', 'externalSha256', 'cacheGroups', 'archiveSha256', 'finalCacheSha256'], 'legacy native reuse validation');
  assert.equal(proof.schemaVersion, 1); assert.equal(proof.kind, 'kaigen-legacy-native-reuse');
  safeSource(proof.source); safeSource(proof.candidateSource); assert.deepEqual(proof.candidateSource, source);
  assert.equal(proof.closure.variant, null, 'legacy native full-release reuse requires the desktop variant');
  const check = { id: proof.checkId };
  assert.ok(isNativeInputCheck(check), 'native bridge cannot authorize frontend reuse');
  const { program, args } = descriptor(check.id, new Set(), check.variant), command = { program, args };
  const original = legacyNativeClosure(referenceRoot, proof.source, check, command), current = legacyNativeClosure(referenceRoot, source, check, command);
  assert.deepEqual(original, current, 'publisher independently found a changed native closure');
  assert.deepEqual(proof.closure, current, 'declared native closure differs from immutable source');
  for (const name of ['resultSha256', 'originalInputsSha256', 'outputSha256', 'finalCacheSha256']) hash(proof[name], name);
  keys(proof.externalSha256, ['native', 'worker', 'verification', 'previousCache', 'currentCache'], 'original native runner/cache pins');
  for (const value of Object.values(proof.externalSha256)) hash(value, 'native external chain hash');
  for (const name of ['startedAt', 'completedAt']) assert.ok(Number.isFinite(Date.parse(proof[name])), 'invalid original native timestamp');
  assert.ok(Date.parse(proof.completedAt) >= Date.parse(proof.startedAt));
  assert.equal(proof.archiveSha256, artifactSha256, 'native reuse proof belongs to another new archive');
  assert.deepEqual(nativeCacheCompatibility({ schemaVersion: 2, policy: 'verified-prepared-native-v2', platform: 'windows-x64',
    groups: proof.cacheGroups.map(group => ({ ...group, cacheDisposition: 'hit', physicalCacheDisposition: 'hit', producerInvoked: false, status: 'active', patchSetManifestSha256: 'none', tombstoneIds: [] })) }), proof.cacheGroups);
}

export function localFullCheckPins(catalog, npmScripts, readSourceBlob, ciSourcePaths) {
  return localFullChecks(catalog, npmScripts).map(check => {
    const definitions = catalog.inputSets[check.inputSet]; assert.ok(Array.isArray(definitions) && definitions.length > 0);
    const inputs = definitions.map(input => {
      assert.equal(input.kind, 'git'); assert.ok(!input.path.includes('\\') && !input.path.includes(':') && !path.isAbsolute(input.path)
        && input.path.split('/').every(part => part && part !== '.' && part !== '..'));
      return { ...input, sha256: sha(inputBytes(readSourceBlob(input.path), input.lines)) };
    });
    if (check.id === 'frontend:build-pipeline') for (const filename of ciSourcePaths) {
      if (!inputs.some(input => input.path === filename && input.lines === undefined)) inputs.push({ id: 'ci:' + filename, kind: 'git', path: filename, sha256: sha(readSourceBlob(filename)) });
    }
    return { id: check.id, action: 'run', inputsSha256: canonicalDigest(inputs) };
  });
}

async function loadReleaseGates(context, assets) {
  const filename = context.manifest.gates.path, info = await lstat(filename);
  assert.ok(info.isFile() && !info.isSymbolicLink()); const bytes = await readFile(filename);
  assert.equal(sha(bytes), context.manifest.gates.sha256, 'gate export differs from reviewed manifest');
  assert.equal(sha(gitBytes('show', context.controller.commit + ':' + filename)), sha(bytes), 'gate export is not committed');
  const gates = JSON.parse(bytes), inherited = localFrontendPolicy(context.catalog);
  const componentApplicability = Object.hasOwn(gates, 'componentApplicability')
    ? reviewedWebComponentApplicability({ root: process.cwd(), source: WEB_COMPONENT_TRANSITION.candidateSource }) : null;
  const candidateSource = componentApplicability ? WEB_COMPONENT_TRANSITION.candidateSource : inherited ? context.catalog.actionsFrontendReuse.source : context.manifest.source;
  const desktopEvidenceSource = componentApplicability ? WEB_COMPONENT_TRANSITION.evidenceSource : candidateSource;
  if (componentApplicability) {
    assert.ok(inherited, 'component evidence requires the immutable local frontend export');
    assert.deepEqual(context.catalog.actionsFrontendReuse.source, desktopEvidenceSource);
  }
  assert.deepEqual(gates.candidate?.source, candidateSource);
  const candidateSourceProof = JSON.stringify(candidateSource) === JSON.stringify(context.manifest.source) ? null
    : gitVerificationRevision(candidateSource, context.manifest.source, context.canonical.version);
  if (inherited) {
    const publicBytes = await readFile(context.catalog.actionsFrontendReuse.evidence.path);
    assert.equal(sha(publicBytes), context.catalog.actionsFrontendReuse.evidence.sha256);
    assert.deepEqual(JSON.parse(publicBytes), { schemaVersion: 1, kind: 'kaigen-local-frontend-coverage', source: desktopEvidenceSource,
      artifactSha256: gates.units.windows.artifactSha256, localFull: gates.windowsTestSet.localFull,
      baseline: { validatorSha256: gates.windowsTestSet.localFull.validatorSha256, receiptSha256: gates.windowsTestSet.localFull.validatorProofSha256, disposition: 'executed' } }, 'pre-Actions local full export differs from final release gate');
  }
  const allowedPaths = releaseCiPaths(context.catalog);
  const candidatePackage = JSON.parse(gitBytes('show', desktopEvidenceSource.commit + ':package.json'));
  const npmScripts = new Set(candidatePackage.scripts['test:frontend'].split(/\s*&&\s*/).map(command => /^npm run (test:[\w-]+)$/.exec(command)?.[1]).filter(Boolean));
  const readCandidateBlob = filename => gitBytes('show', desktopEvidenceSource.commit + ':' + filename);
  const ciSourcePaths = git('ls-tree', '-r', '--name-only', desktopEvidenceSource.commit, '--', ...allowedPaths).split('\n').filter(Boolean);
  const localFullPins = localFullCheckPins(context.catalog, npmScripts, readCandidateBlob, ciSourcePaths);
  const retainedSources = new Map();
  for (const platform of PLATFORMS) {
    const builtFrom = gates.units?.[platform]?.builtFrom; buildIdentity(builtFrom);
    const evidenceSource = platform === 'web' ? candidateSource : desktopEvidenceSource;
    if (builtFrom.source.commit !== evidenceSource.commit) retainedSources.set(builtFrom.source.commit, { builtFrom: builtFrom.source, evidenceSource });
  }
  const verificationRevisionProofs = [...retainedSources.values()].sort((a, b) => a.builtFrom.commit.localeCompare(b.builtFrom.commit))
    .map(({ builtFrom, evidenceSource }) => gitVerificationRevision(builtFrom, evidenceSource, context.canonical.version));
  const fixtureBytes = await readFile('scripts/fixtures/qtox-v1.18.5-windows.json');
  const fixture = JSON.parse(fixtureBytes);
  assertReleaseGates(gates, { source: context.manifest.source, candidateSource, localFullPins,
    localFullValidatorSha256: sha(readCandidateBlob('scripts/incremental-windows-verification.mjs')),
    archiveExecutableValidatorSha256: sha(readCandidateBlob('scripts/publish-release.mjs')),
    ...(context.canonical.version === '0.2.9+9' ? { retainedArtifactValidatorSha256: sha(gitBytes('show', context.controller.commit + ':scripts/publish-release.mjs')) } : {}),
    qtoxApplicability: Object.hasOwn(gates, 'qtoxReuseValidation') ? qtoxReuseApplicability(candidateSource) : null,
    verificationRevisionProofs, candidateSourceProof, componentApplicability,
    assets, canonical: context.canonical, qtoxFixture: { sha256: sha(fixtureBytes), installerSha256: fixture.sha256.toLowerCase() } });
  return gates;
}

export function assertNativeEvidence(result, job, stdout, stderr, resource) {
  assert.equal(result.schema, 1); assert.equal(result.kind, 'kaigen-extended-native-result'); assert.equal(result.job, job.id);
  assert.equal(result.status, 'PASS'); assert.equal(result.host?.platform, 'win32'); assert.equal(result.selectedMode, 'ordinary');
  assert.deepEqual(result.limits, job.limits); assert.equal(result.resource?.status, 'PASS'); assert.deepEqual(result.resource, resource);
  assert.equal(result.output?.stdoutSha256, sha(stdout)); assert.equal(result.output?.stderrSha256, sha(stderr));
  assert.equal(new Set(result.discovery.names).size, result.discovery.names.length);
  assert.equal(new Set(result.discovery.ignoredNames).size, result.discovery.ignoredNames.length);
  const selected = selectTests(job, result.discovery.names, result.discovery.ignoredNames);
  assert.deepEqual(result.discovery.selectedNames, selected); assert.equal(result.discovery.selected, selected.length);
  assert.equal(result.discovery.total, result.discovery.names.length);
  assert.deepEqual(result.counts, parseRun(stdout.toString('utf8') + '\n' + stderr.toString('utf8'), selected));
  assert.equal(result.counts.filteredOut, result.discovery.names.length - selected.length);
  assert.ok(result.source.inputs.length > 0 && new Set(result.source.inputs.map(input => input.path)).size === result.source.inputs.length);
  for (const input of result.source.inputs) {
    hash(input.sha256, 'native source input');
    assert.ok(typeof input.path === 'string' && !path.isAbsolute(input.path) && !input.path.includes('\\') && !input.path.includes(':')
      && input.path.split('/').every(part => part && part !== '.' && part !== '..'));
  }
  assert.equal(result.source.sha256, sha(JSON.stringify(result.source.inputs.map(({ path: filename, sha256 }) => ({ path: filename, sha256 })))));
}

async function publish(directory) {
  const context = await verifySource(), { manifest, canonical } = context;
  const relative = path.relative(process.cwd(), directory);
  assert.ok(relative.startsWith('..' + path.sep) || path.isAbsolute(relative), 'publication outputs must be outside source');
  await mkdir(directory, { recursive: true });
  const incoming = path.join(directory, 'incoming'), outgoing = path.join(directory, 'release');
  await mkdir(incoming); await mkdir(outgoing);
  const provenance = [], receipts = [], assets = [], names = assetNames(canonical.version);
  const inheritedFrontend = localFrontendPolicy(context.catalog) ? await localFrontendCoverage(process.cwd(), context.catalog, producerSource(manifest, 'windows')) : null;
  const produced = await producerArtifacts(context, incoming, provenance);
  const visibility = await visibilityEvidence(context, incoming, provenance);
  for (const platform of PLATFORMS) {
    const evidence = produced.files.get('Kaigen-verification-' + platform); assert.equal(evidence.length, 1);
    const receipt = await json(one(evidence, 'ci-verification-' + platform + '.json'));
    assertVerification(receipt, platform, manifest, context.catalog, platform === 'windows' ? inheritedFrontend : null); receipts.push(receipt);
    const labels = platform === 'windows' ? ['Kaigen-portable-windows-x64', 'Kaigen-installer-windows-x64']
      : [platform === 'web' ? `Kaigen-Web-Debian13-Nginx-${canonical.releaseLabel}` : 'Kaigen-portable-' + (platform === 'debian' ? 'debian-x64' : 'macos-universal')];
    const productFiles = labels.flatMap(label => produced.files.get(label));
    for (const name of names[platform]) {
      const file = one(productFiles, name), digest = await fileHash(file);
      assert.equal(receipt.artifacts.find(item => item.name === name)?.sha256, digest, 'asset is not bound to a successful CI receipt');
      await copyFile(file, path.join(outgoing, name)); assets.push({ name, sha256: digest, size: (await stat(file)).size, platform, source: producerSource(manifest, platform === 'windows' ? 'windows' : 'unix') });
    }
  }
  const nativeResults = [];
  const nativeCatalog = validateNativeCatalog(await json('ci/extended-native-jobs.json'));
  for (const id of PRODUCERS.native.jobs) {
    const files = produced.files.get('extended-native-' + id), result = await json(one(files, 'result.json'));
    const job = nativeCatalog.jobs.find(value => value.id === id); assert.ok(job && !job.ignored);
    assertNativeEvidence(result, job, await readFile(one(files, 'process.stdout.log')), await readFile(one(files, 'process.stderr.log')), await json(one(files, 'resource.json')));
    nativeResults.push(result);
  }
  const web = assets.find(asset => asset.platform === 'web' && asset.name.endsWith('.tar.gz'));
  const bootstrapPath = path.join(outgoing, names.web[1]), bootstrap = await readFile(bootstrapPath, 'utf8');
  for (const line of [`BUNDLE_SHA256='${web.sha256}'`, `RELEASE_LABEL='${canonical.releaseLabel}'`, `BUILD_ID='kaigen-${canonical.releaseLabel}'`]) {
    assert.equal(bootstrap.split(/\r?\n/).filter(value => value === line).length, 1, 'Web bootstrap identity mismatch');
  }
  command('bash', ['-n', bootstrapPath]);
  const gates = await loadReleaseGates(context, assets);
  const publication = { runId: Number(process.env.GITHUB_RUN_ID), attempt: Number(process.env.GITHUB_RUN_ATTEMPT) };
  const marker = `<!-- kaigen-actions-release:${canonical.tag}:${manifest.source.commit}:${context.manifestSha256}:${publication.runId} -->`;
  const expected = { tag: canonical.tag, source: manifest.source, marker, names: Object.values(names).flat() };
  const initial = await releaseState(canonical.tag); assertDraftState(initial.release, initial.tag, expected);
  const retained = await retainedSourceAsset(initial, context, publication, outgoing, incoming, provenance, names.source[0]);
  if (retained) assets.push(retained);
  else {
    const archiveRoot = path.join(directory, 'canonical-source'); await mkdir(archiveRoot);
    command('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', 'scripts/build-source-archive.ps1', '-GitRevision', manifest.source.commit, '-ArtifactsDir', archiveRoot]);
    const archive = path.join(archiveRoot, 'Kaigen-source-github.zip'); await copyFile(archive, path.join(outgoing, names.source[0]));
    assets.push({ name: names.source[0], sha256: await fileHash(archive), size: (await stat(archive)).size, platform: 'source', source: manifest.source });
  }
  const report = { schemaVersion: 1, kind: 'kaigen-actions-release', status: 'VERIFIED_BEFORE_PUBLICATION', repository: REPOSITORY,
    tag: canonical.tag, manifestSha256: context.manifestSha256, source: manifest.source, controller: context.controller, publication,
    controllerChanges: context.controllerChanges, controllerEquivalence: context.controllerEquivalence,
    producerEquivalence: { acceptedProduct: context.catalog.productSource, source: manifest.source, changedCiPaths: context.producerChanges },
    producers: produced.runs, artifacts: provenance, verification: receipts, nativeResults, visibility, gates, assets };
  await save(path.join(directory, 'publication-manifest.json'), report);
  assert.equal((await api('branches/main')).commit.sha, context.controller.commit, 'stale publication before mutation');
  let state = await releaseState(canonical.tag); assertDraftState(state.release, state.tag, expected);
  if (!state.tag) {
    const annotation = await api('git/tags', { method: 'POST', body: { tag: canonical.tag, message: marker, object: manifest.source.commit, type: 'commit' } });
    assert.equal(annotation.object?.sha, manifest.source.commit); assert.equal(annotation.tag, canonical.tag);
    await api('git/refs', { method: 'POST', body: { ref: 'refs/tags/' + canonical.tag, sha: annotation.sha } });
  }
  const body = marker + `\n## Kaigen ${canonical.releaseLabel}\n\n`
    + `Все семь файлов произведены и опубликованы GitHub Actions. Source: \x60${manifest.source.commit}\x60.\n\n`
    + 'macOS universal: ad-hoc signed, not notarized. Подпись ad-hoc, без нотариализации.\n\n'
    + `[Publication](https://github.com/${REPOSITORY}/actions/runs/${publication.runId}) (attempt ${publication.attempt})\n\n`
    + '| File | SHA-256 |\n| --- | --- |\n' + assets.map(asset => `| ${asset.name} | \x60${asset.sha256}\x60 |`).join('\n') + '\n';
  if (!state.release) {
    await api('releases', { method: 'POST', body: { tag_name: canonical.tag, target_commitish: manifest.source.commit,
      name: 'Kaigen ' + canonical.releaseLabel, body, draft: true, prerelease: false, make_latest: 'false' } });
  }
  state = await releaseState(canonical.tag); assertDraftState(state.release, state.tag, expected);
  assertRemoteAssets(state.release.assets, assets, { complete: false });
  for (const asset of assets.filter(item => !state.release.assets.some(remote => remote.name === item.name))) {
    await uploadAsset(state.release.id, asset, path.join(outgoing, asset.name));
  }
  state = await releaseState(canonical.tag); assertDraftState(state.release, state.tag, expected);
  assertRemoteAssets(state.release.assets, assets);
  const draftBytes = path.join(directory, 'draft-bytes'); await mkdir(draftBytes);
  for (const asset of assets) await publicBytes(state.release.assets.find(item => item.name === asset.name), path.join(draftBytes, asset.name), asset.sha256);
  assert.equal((await api('branches/main')).commit.sha, context.controller.commit, 'stale publication before visibility');
  const finalCheck = await releaseState(canonical.tag); assertDraftState(finalCheck.release, finalCheck.tag, expected);
  assert.equal(finalCheck.release.id, state.release.id); assertRemoteAssets(finalCheck.release.assets, assets);
  const published = await api('releases/' + state.release.id, { method: 'PATCH', body: { draft: false, body, make_latest: 'true' } });
  assert.equal(published.id, state.release.id); assert.equal(published.tag_name, canonical.tag); assert.equal(published.draft, false);
  const final = await api('releases/' + state.release.id); assert.equal(final.draft, false); assertRemoteAssets(final.assets, assets);
  await save(path.join(directory, 'release-after.json'), final);
  const publicRoot = path.join(directory, 'public-bytes'); await mkdir(publicRoot);
  for (const asset of assets) await publicBytes(final.assets.find(item => item.name === asset.name), path.join(publicRoot, asset.name), asset.sha256);
  report.status = 'PUBLISHED_VERIFIED'; report.releaseId = final.id; report.releaseUrl = final.html_url; report.completedAt = new Date().toISOString();
  await save(path.join(directory, 'publication-manifest.json'), report);
  console.log('Verified seven published Actions assets: ' + final.html_url);
}

async function main() {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === 'inspect-windows-archive') {
    assert.equal(args.length, 4, 'inspect-windows-archive <candidate.zip> <shipping-Kaigen.exe> <build-id> <new-receipt.json>');
    await recordWindowsExecutable(...args);
  } else if (mode === 'verify-revision') {
    assert.ok([2, 3].includes(args.length), 'verify-revision <original-build-commit> <new-proof.json> [verification-candidate-commit]');
    await recordVerificationRevision(...args);
  } else if (mode === 'verify-retained-artifact') {
    assert.ok([5, 6].includes(args.length), 'verify-retained-artifact <registered-producer.json> <producer-sha256> <approved-producer-validator-sha256> <retained-archive> <new-receipt.json> [verification-candidate-commit]');
    await recordRetainedArtifact(...args);
  } else if (mode === 'validate-manifest') {
    assert.equal(args.length, 0); const context = await loadManifest(); console.log(JSON.stringify({ tag: context.canonical.tag, manifestSha256: context.manifestSha256 }));
  } else {
    assert.equal(mode, 'publish'); assert.equal(args.length, 1); const [directory] = args;
    assert.ok(process.env.GITHUB_TOKEN && directory && path.isAbsolute(directory)); await publish(directory);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
