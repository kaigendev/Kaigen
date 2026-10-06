import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (actual, expected, label) => assert.deepEqual(actual, expected, label);
const [manifestArg, distArg, outputArg] = process.argv.slice(2);
assert.ok(manifestArg && distArg && outputArg && process.argv.length === 5,
  'Usage: publish-site-release.mjs <release.json> <built dist directory> <output directory>');
const manifestBytes = await readFile(manifestArg);
const m = JSON.parse(manifestBytes);
same(m.schemaVersion, 1);
assert.match(m.repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
assert.match(m.releaseTag, /^v[0-9]+(?:\.[0-9]+){3}$/);
assert.ok(Number.isSafeInteger(m.releaseId) && m.releaseId > 0);
for (const commit of [m.productSource, m.siteSourceCommit]) assert.match(commit, /^[a-f0-9]{40}$/);
assert.ok(Number.isFinite(Date.parse(m.publishedAt)));
assert.match(m.siteArchiveName, /^Kaigen-Site-[0-9]+(?:\.[0-9]+){3}\.tar\.gz$/);
same(m.siteArchiveName, `Kaigen-Site-${m.releaseTag.slice(1)}.tar.gz`);
const env = process.env;
same(env.GITHUB_ACTIONS, 'true', 'Actions required');
same(env.GITHUB_REPOSITORY, m.repository);
same(env.GITHUB_REF, 'refs/heads/main');
same(env.GITHUB_EVENT_NAME, 'workflow_dispatch');
assert.match(env.EXPECTED_SHA ?? '', /^[a-f0-9]{40}$/);
same(env.GITHUB_SHA, env.EXPECTED_SHA, 'reviewed commit mismatch');
assert.ok(env.GITHUB_TOKEN);
const git = args => execFileSync('git', args, { encoding: 'utf8' }).trim();
same(git(['rev-parse', 'HEAD']), env.GITHUB_SHA);
same(git(['status', '--porcelain', '--untracked-files=no']), '', 'tracked checkout changed');
const sourcePrefix = `site-release/${m.releaseTag.slice(1)}/source/`;
assert.ok(Array.isArray(m.sourceFiles) && m.sourceFiles.length > 0);
const sourceNames = new Set();
for (const file of m.sourceFiles) {
  assert.ok(typeof file.path === 'string' && file.path.length > 0);
  assert.ok(file.path.split('/').every(part => /^[A-Za-z0-9_.-]+$/.test(part) && !['.', '..'].includes(part)));
  const sourcePath = sourcePrefix + file.path;
  assert.ok(!sourceNames.has(sourcePath), 'duplicate source path');
  sourceNames.add(sourcePath);
  assert.ok(Number.isSafeInteger(file.size) && file.size > 0);
  assert.match(file.sha256, /^[a-f0-9]{64}$/);
  assert.ok((await lstat(sourcePath)).isFile(), 'ordinary source file required');
  const bytes = await readFile(sourcePath);
  same(bytes.length, file.size); same(sha(bytes), file.sha256, 'source snapshot changed');
}
same(git(['ls-files', '--', sourcePrefix]).split('\n').filter(Boolean).sort(), [...sourceNames].sort(), 'incomplete source inventory');
const dist = path.resolve(distArg), output = path.resolve(outputArg);
assert.ok(output !== dist && !output.startsWith(dist + path.sep), 'output cannot be inside dist');
assert.ok((await lstat(dist)).isDirectory());
const files = [];
async function collect(directory, prefix = '') {
  for (const name of (await readdir(directory)).sort()) {
    const relative = prefix + name, absolute = path.join(directory, name);
    const stat = await lstat(absolute);
    if (relative === 'assets' && stat.isDirectory()) { await collect(absolute, 'assets/'); continue; }
    // Vite emits this non-public deployment marker; it is never packaged.
    if (relative === '.assetsignore' && stat.isFile()) continue;
    assert.ok(stat.isFile(), `non-ordinary public entry: ${relative}`);
    assert.match(relative, /^(?:index\.html|robots\.txt|site\.webmanifest|assets\/[A-Za-z0-9_.-]+\.(?:png|webp|js|css))$/);
    assert.ok(Buffer.byteLength(relative) < 100 && stat.size > 0 && stat.size <= 32 * 1024 * 1024);
    const bytes = await readFile(absolute);
    files.push({ path: relative, size: bytes.length, sha256: sha(bytes), bytes });
  }
}
await collect(dist);
for (const required of ['index.html', 'robots.txt', 'site.webmanifest']) assert.ok(files.some(f => f.path === required), `missing ${required}`);
files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
assert.ok(files.reduce((sum, file) => sum + file.size, 0) <= 128 * 1024 * 1024);
// Minimal ustar: regular public files, uid/gid/mtime zero, no host paths or names.
const chunks = [];
for (const file of files) {
  const header = Buffer.alloc(512);
  const octal = (offset, length, value) => header.write(value.toString(8).padStart(length - 1, '0') + '\0', offset, length, 'ascii');
  header.write(file.path, 0, 'utf8');
  octal(100, 8, 0o644); octal(108, 8, 0); octal(116, 8, 0);
  octal(124, 12, file.size); octal(136, 12, 0);
  header.fill(32, 148, 156); header[156] = 48;
  header.write('ustar\0', 257, 'ascii'); header.write('00', 263, 'ascii');
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  chunks.push(header, file.bytes, Buffer.alloc((512 - file.size % 512) % 512));
}
chunks.push(Buffer.alloc(1024));
const archive = gzipSync(Buffer.concat(chunks), { level: 9 });
const archiveSha = sha(archive);
await mkdir(output, { recursive: true });
await writeFile(path.join(output, m.siteArchiveName), archive, { flag: 'wx' });
const publicManifest = { schemaVersion: 1, release: m.releaseTag, files: files.map(({ bytes, ...file }) => file) };
await writeFile(path.join(output, 'public-package-manifest.json'), JSON.stringify(publicManifest, null, 2) + '\n', { flag: 'wx' });
async function api(endpoint) {
  const response = await fetch(`https://api.github.com/repos/${m.repository}/${endpoint}`, {
    headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, redirect: 'error',
  });
  assert.ok(response.ok, `API ${endpoint}: ${response.status}`);
  return response.json();
}
same((await api('git/ref/heads/main')).object?.sha, env.GITHUB_SHA, 'current main changed');
const tagBefore = await api(`git/ref/tags/${m.releaseTag}`);
let tagTarget = tagBefore.object;
if (tagTarget?.type === 'tag') tagTarget = (await api(`git/tags/${tagTarget.sha}`)).object;
same(tagTarget?.sha, m.productSource, 'release tag source mismatch');
assert.ok(Array.isArray(m.originalAssets) && m.originalAssets.length === 7);
for (const asset of m.originalAssets) {
  assert.ok(Number.isSafeInteger(asset.id) && asset.id > 0);
  assert.ok(Number.isSafeInteger(asset.size) && asset.size > 0);
  assert.match(asset.name, /^[A-Za-z0-9_.-]+$/);
  assert.match(asset.digest, /^sha256:[a-f0-9]{64}$/);
}
const originalNames = new Set(m.originalAssets.map(a => a.name));
same(originalNames.size, 7); assert.ok(!originalNames.has(m.siteArchiveName));
function protect(release) {
  same(release.id, m.releaseId); same(release.tag_name, m.releaseTag);
  same(release.target_commitish, m.productSource); same(release.published_at, m.publishedAt);
  same(release.draft, false); same(release.prerelease, false);
  assert.ok([7, 8].includes(release.assets.length));
  const byName = new Map(release.assets.map(a => [a.name, a]));
  same(byName.size, release.assets.length);
  for (const original of m.originalAssets) {
    const asset = byName.get(original.name); assert.ok(asset, 'original asset missing');
    for (const key of ['id', 'name', 'size', 'digest']) same(asset[key], original[key], `original asset ${key} changed`);
    same(asset.state, 'uploaded');
  }
  for (const name of byName.keys()) assert.ok(originalNames.has(name) || name === m.siteArchiveName);
  const site = byName.get(m.siteArchiveName);
  if (site) { same(site.size, archive.length); same(site.digest, `sha256:${archiveSha}`); same(site.state, 'uploaded'); }
  const { assets, updated_at, ...metadata } = release;
  return { site, identity: { metadata, originalAssets: assets.filter(a => originalNames.has(a.name)).map(({ download_count, ...a }) => a).sort((a, b) => a.id - b.id) } };
}
const before = protect(await api(`releases/${m.releaseId}`));
let action = 'verified-existing';
if (!before.site) {
  const response = await fetch(`https://uploads.github.com/repos/${m.repository}/releases/${m.releaseId}/assets?name=${encodeURIComponent(m.siteArchiveName)}`, {
    method: 'POST', headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, 'Content-Type': 'application/gzip', Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, body: archive, redirect: 'error',
  });
  same(response.status, 201, 'append failed; assets are never replaced');
  const uploaded = await response.json(); same(uploaded.name, m.siteArchiveName); same(uploaded.size, archive.length); same(uploaded.digest, `sha256:${archiveSha}`);
  action = 'uploaded';
}
const after = protect(await api(`releases/${m.releaseId}`));
assert.ok(after.site); same(after.identity, before.identity, 'release metadata/original assets changed');
same(await api(`git/ref/tags/${m.releaseTag}`), tagBefore, 'release tag changed');
const receipt = {
  schemaVersion: 1, kind: 'kaigen-actions-site-publication', status: 'PUBLISHED_VERIFIED',
  repository: m.repository, releaseId: m.releaseId, tag: m.releaseTag, productSource: m.productSource,
  siteSourceCommit: m.siteSourceCommit, controllerCommit: env.GITHUB_SHA, manifestSha256: sha(manifestBytes),
  runId: Number(env.GITHUB_RUN_ID), attempt: Number(env.GITHUB_RUN_ATTEMPT), action,
  site: { id: after.site.id, name: m.siteArchiveName, url: after.site.browser_download_url, size: archive.length, sha256: archiveSha, files: publicManifest.files, apiDigestAndSizeVerified: true },
  originalAssetsUnchanged: true, releaseMetadataUnchanged: true, tagUnchanged: true, completedAtUtc: new Date().toISOString(),
};
await writeFile(path.join(output, 'site-publication.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
console.log(`SITE_PUBLISHED_VERIFIED ${m.siteArchiveName} ${archiveSha}; original seven assets unchanged`);
