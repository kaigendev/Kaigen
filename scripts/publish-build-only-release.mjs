import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readReleaseVersion } from './release-version.mjs';

const repository = 'kaigendev/Kaigen';
const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const sha256 = async filename => {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(filename)) hash.update(bytes);
  return hash.digest('hex');
};
async function publish(folder, reportPath) {
  const env = process.env, source = env.GITHUB_SHA, token = env.GITHUB_TOKEN;
  assert.equal(env.GITHUB_ACTIONS, 'true');
  assert.equal(env.GITHUB_REPOSITORY, repository);
  assert.equal(env.GITHUB_REF, 'refs/heads/main');
  assert.match(source ?? '', /^[a-f0-9]{40}$/u);
  assert.ok(token, 'GITHUB_TOKEN is required');
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim(), source,
    'publisher checkout differs from this workflow commit');
  const canonical = await readReleaseVersion(sourceRoot);
  const names = ['Kaigen-portable-windows-x64.zip', 'Kaigen-installer-windows-x64.msi',
    'Kaigen-portable-debian-x64.zip', 'Kaigen-portable-macos-universal.zip',
    `Kaigen-Web-Debian13-Nginx-${canonical.releaseLabel}.tar.gz`, `Kaigen-Web-Installer-${canonical.releaseLabel}.sh`,
    `Kaigen-source-${canonical.releaseLabel}.zip`];
  assert.deepEqual((await readdir(folder)).sort(), [...names].sort(), 'publication folder must contain exactly seven release files');
  const assets = [];
  for (const name of names) {
    const filename = path.join(folder, name), info = await lstat(filename);
    assert.ok(info.isFile() && !info.isSymbolicLink() && info.size > 0, 'release asset must be an ordinary nonempty file: ' + name);
    assets.push({ name, size: info.size, sha256: await sha256(filename) });
  }
  const web = assets.find(asset => asset.name.endsWith('.tar.gz'));
  const bootstrap = await readFile(path.join(folder, `Kaigen-Web-Installer-${canonical.releaseLabel}.sh`), 'utf8');
  for (const line of [`BUNDLE_SHA256='${web.sha256}'`, `RELEASE_LABEL='${canonical.releaseLabel}'`, `BUILD_ID='kaigen-${canonical.releaseLabel}'`]) {
    assert.equal(bootstrap.split(/\r?\n/u).filter(value => value === line).length, 1, 'Web installer binding differs: ' + line.split('=')[0]);
  }
  const report = { schemaVersion: 1, kind: 'kaigen-build-only-actions-release', status: 'PREPARED',
    repository, source, tag: canonical.tag, version: canonical.version, releaseLabel: canonical.releaseLabel,
    runId: Number(env.GITHUB_RUN_ID), attempt: Number(env.GITHUB_RUN_ATTEMPT), assets };
  assert.ok(Number.isSafeInteger(report.runId) && report.runId > 0 && Number.isSafeInteger(report.attempt) && report.attempt > 0);
  const save = () => writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  await save();
  const request = async (endpoint, { method = 'GET', body, file, missing = false } = {}) => {
    const url = file ? `https://uploads.github.com/repos/${repository}/${endpoint}` : `https://api.github.com/repos/${repository}/${endpoint}`;
    const response = await fetch(url, { method, redirect: 'error', headers: {
      Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
      ...(file ? { 'Content-Type': 'application/octet-stream', 'Content-Length': String(file.size) }
        : body === undefined ? {} : { 'Content-Type': 'application/json' }),
    }, ...(file ? { body: createReadStream(file.path), duplex: 'half' } : body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (missing && response.status === 404) return null;
    const text = await response.text();
    let value; try { value = JSON.parse(text); } catch { value = {}; }
    if (!response.ok) {
      const message = String(value.message ?? response.statusText).replaceAll(token, '[redacted]');
      const detail = value.errors ? JSON.stringify(value.errors).replaceAll(token, '[redacted]') : '';
      throw new Error(`GitHub ${method} ${endpoint.split('?')[0]}: ${response.status} ${message}${detail ? ' ' + detail : ''}`);
    }
    return value;
  };
  const assertTag = async (allowPendingDraft = false) => {
    const reference = await request('git/ref/tags/' + canonical.tag, { missing: allowPendingDraft });
    if (reference === null) return;
    let object = reference.object;
    for (let depth = 0; object?.type === 'tag' && depth < 5; depth++) object = (await request('git/tags/' + object.sha)).object;
    assert.equal(reference.ref, 'refs/tags/' + canonical.tag);
    assert.equal(object?.type, 'commit'); assert.equal(object.sha, source, 'release tag differs from workflow commit');
  };
  const assertRelease = release => {
    assert.equal(release.tag_name, canonical.tag); assert.equal(release.target_commitish, source);
    assert.equal(release.prerelease, false); assert.ok(Number.isSafeInteger(release.id) && release.id > 0);
  };
  const remoteAssets = async release => {
    const rows = [];
    for (let page = 1; page <= 10; page++) {
      const items = await request(`releases/${release.id}/assets?per_page=100&page=${page}`);
      assert.ok(Array.isArray(items)); rows.push(...items); if (items.length < 100) return rows;
    }
    throw new Error('Incomplete release asset listing');
  };
  const assertAssets = (remote, complete) => {
    assert.equal(new Set(remote.map(asset => asset.name)).size, remote.length, 'duplicate release asset');
    if (complete) assert.deepEqual(remote.map(asset => asset.name).sort(), [...names].sort(), 'release must contain exactly seven assets');
    for (const asset of remote) {
      const expected = assets.find(item => item.name === asset.name); assert.ok(expected, 'unexpected release asset: ' + asset.name);
      assert.equal(asset.state, 'uploaded'); assert.equal(asset.size, expected.size);
      assert.equal(asset.digest, 'sha256:' + expected.sha256, 'remote asset digest differs: ' + asset.name);
    }
  };
  let release = await request('releases/tags/' + canonical.tag, { missing: true });
  if (!release) {
    // An authenticated draft can be absent from the by-tag endpoint.
    const drafts = [];
    for (let page = 1; page <= 10; page++) {
      const items = await request(`releases?per_page=100&page=${page}`); assert.ok(Array.isArray(items));
      drafts.push(...items.filter(item => item.tag_name === canonical.tag));
      if (items.length < 100) break;
      assert.ok(page < 10, 'incomplete release listing');
    }
    assert.ok(drafts.length <= 1, 'ambiguous release tag'); release = drafts[0] ?? null;
  }
  if (!release) {
    assert.equal(await request('git/ref/tags/' + canonical.tag, { missing: true }), null, 'tag already exists without this release');
    release = await request('releases', { method: 'POST', body: { tag_name: canonical.tag, target_commitish: source,
      name: 'Kaigen ' + canonical.releaseLabel, draft: true, prerelease: false, make_latest: 'false',
      body: `## Kaigen ${canonical.releaseLabel}\n\nSource: \x60${source}\x60.\n\nBuilt and published by [GitHub Actions](https://github.com/${repository}/actions/runs/${report.runId}).\n\nmacOS universal: ad-hoc signed, not notarized.\n` } });
  }
  assertRelease(release); await assertTag(release.draft);
  let remote = await remoteAssets(release); assertAssets(remote, !release.draft);
  if (release.draft) {
    assert.equal(release.immutable, false, 'draft release is immutable');
    for (const asset of assets.filter(item => !remote.some(existing => existing.name === item.name))) {
      console.log('Upload ' + asset.name);
      const uploaded = await request(`releases/${release.id}/assets?name=${encodeURIComponent(asset.name)}`, {
        method: 'POST', file: { path: path.join(folder, asset.name), size: asset.size } });
      assertAssets([uploaded], false);
    }
    remote = await remoteAssets(release); assertAssets(remote, true); await assertTag(true);
    release = await request('releases/' + release.id, { method: 'PATCH', body: { draft: false, make_latest: 'true' } });
  }
  release = await request('releases/' + release.id); assertRelease(release); assert.equal(release.draft, false);
  await assertTag(); assertAssets(await remoteAssets(release), true);
  report.status = 'PUBLISHED_VERIFIED'; report.releaseId = release.id; report.releaseUrl = release.html_url;
  report.completedAtUtc = new Date().toISOString(); await save();
  console.log('Published seven verified Actions assets: ' + release.html_url);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [folder, report] = process.argv.slice(2);
  assert.ok(folder && report && process.argv.length === 4, 'usage: publish-build-only-release.mjs <seven-files-folder> <report.json>');
  publish(path.resolve(folder), path.resolve(report)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
