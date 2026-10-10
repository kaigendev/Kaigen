import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { readReleaseVersion, releaseVersion, releaseVersionCli } from './release-version.mjs';

const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const version = '0.2.9+8';
const historical = { expectedTag: 'v0.2.9.8', verificationCatalog: 'ci/verification-v0.2.9.8.json' };

function filesFor(value = version) {
  return {
    'package.json': JSON.stringify({ name: 'kaigen', version: value }),
    'package-lock.json': JSON.stringify({ name: 'kaigen', version: value, lockfileVersion: 3, packages: { '': { name: 'kaigen', version: value } } }),
    'src-tauri/tauri.conf.json': JSON.stringify({ version: value }),
    'src-tauri/Cargo.toml': `[package]\nname = "kaigen"\nversion = "${value}" # product version\n\n[dependencies]\nother = "99.0.0"\n`,
    'src-tauri/Cargo.lock': `version = 4\n\n[[package]]\nname = "dependency"\nversion = "99.0.0"\n\n[[package]]\nname = "kaigen"\nversion = "${value}"\ndependencies = [\n "dependency",\n]\n`,
    'web/kaigen-webd/Cargo.lock': `version = 4\n\n[[package]]\nname = "kaigen"\nversion = "${value}"\n\n[[package]]\nname = "kaigen-webd"\nversion = "${value}"\ndependencies = [\n "kaigen",\n]\n`,
    [historical.verificationCatalog]: JSON.stringify({ schemaVersion: 1, kind: 'kaigen-ci-incremental-selection', repository: 'kaigendev/Kaigen', version: value }),
  };
}

async function fixture(files, run) {
  const root = await mkdtemp(path.join(tmpdir(), 'kaigen-release-version-'));
  try {
    for (const [name, text] of Object.entries(files)) {
      if (text === null) continue;
      const target = path.join(root, name);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, text, 'utf8');
    }
    await run(root);
  } finally {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()), 'cleanup stays in the owned temporary namespace');
    assert.ok(path.basename(root).startsWith('kaigen-release-version-'));
    await rm(root, { recursive: true, force: true });
  }
}

test('canonical current source agrees with the current package manifest', async () => {
  const manifest = JSON.parse(await readFile(path.join(sourceRoot, 'package.json'), 'utf8'));
  const current = releaseVersion(manifest.version);
  assert.deepEqual(await readReleaseVersion(sourceRoot, { expectedTag: current.tag }), current);
});

for (const [value, label] of [['1.2.3', '1.2.3'], ['1.2.3+0', '1.2.3.0'], ['10.20.30+123', '10.20.30.123']]) {
  test('numeric version ' + value, async () => {
    await fixture(filesFor(value), async root => {
      assert.deepEqual(await readReleaseVersion(root), { version: value, releaseLabel: label, tag: 'v' + label });
    });
  });
}
for (const value of [null, 8, '', 'v0.2.9+8', '0.2.9.8', '0.2.9-rc.1+8', '0.2.9+build', '0.2.9+8.1', '0.2.9+08', '00.2.9+8', '0.2.9+8\nINJECT=x', '0.2.9+8\n', '0.2.9+8\r\n', ' 0.2.9+8']) {
  test('reject ambiguous release version ' + JSON.stringify(value), () => assert.throws(() => releaseVersion(value)));
}

for (const file of ['package.json', 'package-lock.json', 'src-tauri/tauri.conf.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock', 'web/kaigen-webd/Cargo.lock']) {
  test('missing required input ' + file, async () => {
    await fixture({ ...filesFor(), [file]: null }, root => assert.rejects(() => readReleaseVersion(root), /ENOENT/));
  });
  test('dirty version in ' + file, async () => {
    const files = filesFor();
    files[file] = files[file].replaceAll(version, '0.2.9+9');
    await fixture(files, root => assert.rejects(() => readReleaseVersion(root), /version differs from package.json/));
  });
}

test('npm root lock mismatch cannot hide behind matching top-level version', async () => {
  const files = filesFor();
  const lock = JSON.parse(files['package-lock.json']); lock.packages[''].version = '0.2.9+9';
  files['package-lock.json'] = JSON.stringify(lock);
  await fixture(files, root => assert.rejects(() => readReleaseVersion(root), /root package version differs/));
});
test('reject duplicate Kaigen Cargo lock identities', async () => {
  const files = filesFor(); files['src-tauri/Cargo.lock'] += `\n[[package]]\nname = "kaigen"\nversion = "${version}"\n`;
  await fixture(files, root => assert.rejects(() => readReleaseVersion(root), /exactly one Kaigen package/));
});
test('Web lock cannot retain the previous desktop path-package version', async () => {
  const files = filesFor('0.2.9+9');
  files['web/kaigen-webd/Cargo.lock'] = files['web/kaigen-webd/Cargo.lock'].replace('name = "kaigen"\nversion = "0.2.9+9"', 'name = "kaigen"\nversion = "0.2.9+8"');
  await fixture(files, root => assert.rejects(() => readReleaseVersion(root), /Kaigen path package version differs/));
});
test('Web lock requires exactly one local Kaigen path package', async () => {
  for (const suffix of [`\n[[package]]\nname = "kaigen"\nversion = "${version}"\n`, 'source = "registry+https://github.com/rust-lang/crates.io-index"\n']) {
    const files = filesFor();
    files['web/kaigen-webd/Cargo.lock'] = suffix.startsWith('source')
      ? files['web/kaigen-webd/Cargo.lock'].replace(`name = "kaigen"\nversion = "${version}"\n`, `name = "kaigen"\nversion = "${version}"\n${suffix}`)
      : files['web/kaigen-webd/Cargo.lock'] + suffix;
    await fixture(files, root => assert.rejects(() => readReleaseVersion(root), /exactly one Kaigen path package|must be a local path package/));
  }
});
test('reject inherited or duplicate Cargo package version', async () => {
  for (const declaration of ['version.workspace = true', `version = "${version}"\nversion = "${version}"`]) {
    const files = filesFor(); files['src-tauri/Cargo.toml'] = `[package]\nname = "kaigen"\n${declaration}\n`;
    await fixture(files, root => assert.rejects(() => readReleaseVersion(root), /exactly one package version/));
  }
});

test('coherent future version cannot activate the historical publisher', async () => {
  await fixture(filesFor('0.2.9+9'), root => assert.rejects(() => readReleaseVersion(root, historical), /historical publisher tag/));
});
for (const [field, value, error] of [['version', '0.2.9+9', /version differs/], ['schemaVersion', 2, /schema/], ['kind', 'untrusted', /kind/], ['repository', 'other/Kaigen', /repository/]]) {
  test('historical catalog mismatch ' + field, async () => {
    const files = filesFor(); const catalog = JSON.parse(files[historical.verificationCatalog]); catalog[field] = value;
    files[historical.verificationCatalog] = JSON.stringify(catalog);
    await fixture(files, root => assert.rejects(() => readReleaseVersion(root, historical), error));
  });
}
test('historical catalog is required and stays source-relative', async () => {
  await fixture(filesFor(), async root => {
    await assert.rejects(() => readReleaseVersion(root, { verificationCatalog: historical.verificationCatalog }), /explicit historical/);
    await assert.rejects(() => readReleaseVersion(root, { ...historical, verificationCatalog: '../catalog.json' }), /source-relative/);
    await assert.rejects(() => readReleaseVersion(root, { ...historical, verificationCatalog: path.join(root, 'catalog.json') }), /source-relative/);
    await assert.rejects(() => readReleaseVersion(root, { ...historical, verificationCatalog: 'ci/missing.json' }), /ENOENT/);
  });
});

test('CLI exports the validated identity and never writes a partial failed guard', async () => {
  await fixture(filesFor(), async root => {
    const envFile = path.join(root, 'github-env.txt'); await writeFile(envFile, 'PRESERVED=yes\n');
    let output = '';
    const config = { root, env: { GITHUB_ENV: envFile }, stdout: { write: text => { output += text; } } };
    await releaseVersionCli(['--github-env', '--expect-tag', historical.expectedTag, '--verification-catalog', historical.verificationCatalog], config);
    const expected = 'PRESERVED=yes\nKAIGEN_PACKAGE_VERSION=0.2.9+8\nKAIGEN_RELEASE_LABEL=0.2.9.8\nKAIGEN_RELEASE_TAG=v0.2.9.8\n';
    assert.equal(await readFile(envFile, 'utf8'), expected);
    assert.deepEqual(JSON.parse(output), releaseVersion(version));
    await assert.rejects(() => releaseVersionCli(['--github-env', '--expect-tag', 'v0.2.9.9'], config), /historical publisher tag/);
    assert.equal(await readFile(envFile, 'utf8'), expected);
    for (const args of [['--bad'], ['toString', historical.expectedTag], ['--expect-tag'], ['--github-env', '--github-env'], ['--expect-tag', historical.expectedTag, '--expect-tag', historical.expectedTag]]) {
      await assert.rejects(() => releaseVersionCli(args, config));
      assert.equal(await readFile(envFile, 'utf8'), expected);
    }
    await assert.rejects(() => releaseVersionCli(['--github-env'], { ...config, env: {} }), /GITHUB_ENV/);
  });
});

test('publisher workflow derives labels while preserving historical trust predicates', async () => {
  const workflow = await readFile(path.join(sourceRoot, '.github/workflows/publish-release-0298.yml'), 'utf8');
  const guard = 'node scripts/release-version.mjs --github-env --expect-tag v0.2.9.8 --verification-catalog ci/verification-v0.2.9.8.json';
  const jobs = workflow.split(/^jobs:\s*$/mu)[1];
  assert.ok(jobs, 'publisher must define its release job');
  assert.deepEqual([...jobs.matchAll(/^  ([\w-]+):\s*$/gmu)].map((match) => match[1]), ['release']);
  const release = jobs.split(/^  release:\s*$/mu)[1];
  assert.ok(release.includes("github.repository == 'kaigendev/Kaigen' && github.ref == 'refs/heads/main' && github.event_name == 'workflow_dispatch'"));
  const guardOffset = release.indexOf(guard);
  assert.ok(guardOffset >= 0 && release.indexOf(guard, guardOffset + guard.length) === -1, 'the release job must contain one canonical historical-version guard');
  assert.ok(guardOffset < release.indexOf('dotnet tool install'));
  assert.ok(guardOffset < release.indexOf('node scripts/publish-actions-release.mjs publish'));
  assert.ok(workflow.includes('name: Kaigen-Actions-publication-${{ env.KAIGEN_RELEASE_LABEL }}-${{ github.run_id }}-${{ github.run_attempt }}'));
  assert.ok(workflow.includes('group: kaigen-release-0.2.9.8-actions'));
  const { PRODUCERS, assertCorrectionPaths, assertProducerReusePaths } = await import('./publish-actions-release.mjs');
  assert.deepEqual(PRODUCERS, [
    { id: 333598718, name: 'build-kaigen-windows-portable', path: '.github/workflows/build-windows.yml', jobs: ['build'], source: '26252991641a45195d45b7b5fa8a6fe59b4277dd', tree: '68e1c76a7d611ca6b35663a80e6415f06a233ec2', runId: 37232893084 },
    { id: 333598717, name: 'build-kaigen-linux-macos-portable', path: '.github/workflows/build-unix.yml', jobs: ['debian-appimage', 'macos-universal', 'web-debian13-nginx'], source: 'ad6ff48fc28bc79a0a4b568bc812ea53a54377df', tree: 'f73b466a0b1ba3c807a13fe83892df7e36ea9c49', runId: 37235459220 },
    { id: 374774956, name: 'extended-native-regressions', path: '.github/workflows/regression-extended.yml', jobs: ['pq-fault-desktop', 'pq-fault-web-core'], source: '486f2c34dbe3e1c04745317aa3a15ad5502327b0', tree: 'a0b05cc19e747115e1b207ff0be4d6c1bd19f29f', runId: 37236924663 },
  ], 'publication executor must retain the exact saved producer identities and job coverage');
  for (const file of ['scripts/release-version.mjs', 'scripts/test-release-version.mjs', 'package.json']) {
    assert.throws(() => assertCorrectionPaths([file]), /unexpected product or producer changes/);
    assert.throws(() => assertProducerReusePaths([file]), /producer reuse requires unchanged/);
  }
});

test('Unix jobs validate versions and Web artifacts use the same canonical label', async () => {
  const workflow = await readFile(path.join(sourceRoot, '.github/workflows/build-unix.yml'), 'utf8');
  assert.equal(workflow.split('run: node scripts/release-version.mjs --github-env').length - 1, 3);
  assert.ok(workflow.includes('run: echo "KAIGEN_WEB_BUILD_ID=kaigen-$KAIGEN_RELEASE_LABEL" >> "$GITHUB_ENV"'));
  assert.ok(workflow.includes('name: Kaigen-Web-Debian13-Nginx-${{ env.KAIGEN_RELEASE_LABEL }}'));
  assert.ok(workflow.includes('artifacts/Kaigen-Web-Debian13-Nginx-${{ env.KAIGEN_RELEASE_LABEL }}.tar.gz'));
  assert.ok(workflow.includes('artifacts/Kaigen-Web-Installer-${{ env.KAIGEN_RELEASE_LABEL }}.sh'));
  assert.ok(!workflow.includes('0.2.9.8'));
});
