import assert from 'node:assert/strict';
import { appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_ROOT = fileURLToPath(new URL('../', import.meta.url));
const NUMBER = '(?:0|[1-9][0-9]*)';
const RELEASE_VERSION = new RegExp(`^(${NUMBER}\\.${NUMBER}\\.${NUMBER})(?:\\+(${NUMBER}(?:\\.${NUMBER})?))?$`);

export function releaseVersion(version) {
  assert.equal(typeof version, 'string', 'package.json version must be a string');
  const match = RELEASE_VERSION.exec(version);
  assert.ok(match && match[0] === version, 'release version must be numeric major.minor.patch with an optional numeric +revision[.hotfix]');
  const releaseLabel = match[1] + (match[2] === undefined ? '' : '.' + match[2]);
  return Object.freeze({ version, releaseLabel, tag: 'v' + releaseLabel });
}

// These release inputs use literal package fields, not workspace inheritance or executable TOML.
function literalField(block, field, file) {
  const declarations = [...block.matchAll(new RegExp(`^\\s*${field}\\s*=([^\\r\\n]*)$`, 'gm'))];
  assert.equal(declarations.length, 1, `${file} must contain exactly one package ${field}`);
  const match = declarations[0][1].match(/^\s*(?:"([^"\\]*)"|'([^'\\]*)')\s*(?:#.*)?$/);
  assert.ok(match, `${file} package ${field} must be a literal string`);
  return match[1] ?? match[2];
}

function packageBlocks(text, header) {
  return [...text.matchAll(/^\s*(\[\[?[^\]\r\n]+\]\]?)\s*(?:#.*)?\r?\n([\s\S]*?)(?=^\s*\[|$(?![\s\S]))/gm)]
    .filter(match => match[1] === header).map(match => match[2]);
}

export async function readReleaseVersion(root = SOURCE_ROOT, { expectedTag, verificationCatalog } = {}) {
  const readJson = async file => JSON.parse(await readFile(path.join(root, file), 'utf8'));
  const [manifest, lock, tauri, cargo, cargoLock, webCargoLock] = await Promise.all([
    readJson('package.json'), readJson('package-lock.json'), readJson('src-tauri/tauri.conf.json'),
    readFile(path.join(root, 'src-tauri/Cargo.toml'), 'utf8'), readFile(path.join(root, 'src-tauri/Cargo.lock'), 'utf8'),
    readFile(path.join(root, 'web/kaigen-webd/Cargo.lock'), 'utf8'),
  ]);
  assert.equal(manifest.name, 'kaigen', 'package.json must identify the Kaigen source');
  const identity = releaseVersion(manifest.version);
  const same = (value, file) => assert.equal(value, identity.version, `${file} version differs from package.json`);
  same(lock.version, 'package-lock.json');
  assert.equal(lock.name, manifest.name, 'package-lock.json package identity differs');
  assert.equal(lock.packages?.['']?.name, manifest.name, 'package-lock.json root package identity differs');
  same(lock.packages?.['']?.version, 'package-lock.json root package');
  same(tauri.version, 'src-tauri/tauri.conf.json');
  const packages = packageBlocks(cargo, '[package]');
  assert.equal(packages.length, 1, 'src-tauri/Cargo.toml must contain exactly one [package]');
  assert.equal(literalField(packages[0], 'name', 'src-tauri/Cargo.toml'), manifest.name, 'Cargo package identity differs');
  same(literalField(packages[0], 'version', 'src-tauri/Cargo.toml'), 'src-tauri/Cargo.toml');
  const locked = packageBlocks(cargoLock, '[[package]]').filter(block => literalField(block, 'name', 'src-tauri/Cargo.lock') === manifest.name);
  assert.equal(locked.length, 1, 'src-tauri/Cargo.lock must contain exactly one Kaigen package');
  same(literalField(locked[0], 'version', 'src-tauri/Cargo.lock'), 'src-tauri/Cargo.lock');
  const webLocked = packageBlocks(webCargoLock, '[[package]]').filter(block => literalField(block, 'name', 'web/kaigen-webd/Cargo.lock') === manifest.name);
  assert.equal(webLocked.length, 1, 'web/kaigen-webd/Cargo.lock must contain exactly one Kaigen path package');
  assert.ok(!/^\s*source\s*=/m.test(webLocked[0]), 'web/kaigen-webd/Cargo.lock Kaigen package must be a local path package');
  same(literalField(webLocked[0], 'version', 'web/kaigen-webd/Cargo.lock'), 'web/kaigen-webd/Cargo.lock Kaigen path package');
  if (expectedTag !== undefined) assert.equal(identity.tag, expectedTag, 'current version differs from the historical publisher tag');
  if (verificationCatalog !== undefined) {
    assert.ok(expectedTag, 'a verification catalog requires an explicit historical publisher tag');
    assert.ok(!path.isAbsolute(verificationCatalog) && verificationCatalog.split(/[\\/]/).every(part => part && part !== '.' && part !== '..'), 'verification catalog must be a source-relative file');
    const catalog = await readJson(verificationCatalog);
    assert.equal(catalog.schemaVersion, 1, 'unsupported verification catalog schema');
    assert.equal(catalog.kind, 'kaigen-ci-incremental-selection', 'unexpected verification catalog kind');
    assert.equal(catalog.repository, 'kaigendev/Kaigen', 'unexpected verification catalog repository');
    same(catalog.version, verificationCatalog);
  }
  return identity;
}

export async function releaseVersionCli(args, { root = SOURCE_ROOT, env = process.env, stdout = process.stdout } = {}) {
  let githubEnv = false;
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--github-env') { assert.equal(githubEnv, false, 'duplicate --github-env'); githubEnv = true; }
    else {
      const key = argument === '--expect-tag' ? 'expectedTag' : argument === '--verification-catalog' ? 'verificationCatalog' : null;
      assert.ok(key && options[key] === undefined, 'unknown or duplicate release version argument: ' + argument);
      const value = args[++index];
      assert.ok(value && !value.startsWith('--'), 'missing value for ' + argument);
      options[key] = value;
    }
  }
  const identity = await readReleaseVersion(root, options);
  if (githubEnv) {
    assert.ok(env.GITHUB_ENV, 'GITHUB_ENV is required for --github-env');
    await appendFile(env.GITHUB_ENV, `KAIGEN_PACKAGE_VERSION=${identity.version}\nKAIGEN_RELEASE_LABEL=${identity.releaseLabel}\nKAIGEN_RELEASE_TAG=${identity.tag}\n`, 'utf8');
  }
  stdout.write(JSON.stringify(identity) + '\n');
  return identity;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await releaseVersionCli(process.argv.slice(2));
}
