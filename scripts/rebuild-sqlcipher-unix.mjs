#!/usr/bin/env node
// Offline Linux provider recipe. Component acquisition belongs to prepare-unix-dependencies.sh.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const recipePath = fileURLToPath(import.meta.url);
const root = fs.realpathSync(path.resolve(path.dirname(recipePath), '..'));
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
const fail = message => { throw new Error(message); };
const assert = (ok, message) => { if (!ok) fail(message); };
const regular = p => {
  const st = fs.lstatSync(p);
  assert(st.isFile() && !st.isSymbolicLink(), 'Regular input required: ' + p);
  return st;
};
const identity = p => ({ size: regular(p).size, sha256: sha(fs.readFileSync(p)) });
const same = (a, b) => a.size === b.size && a.sha256 === b.sha256.toLowerCase();
const exact = (p, pin) => { const found = identity(p); assert(same(found, pin), 'Input identity mismatch: ' + p); return found; };
const confined = (base, relative) => {
  assert(typeof relative === 'string' && relative.length > 0 && !relative.includes('\\') &&
    !path.posix.isAbsolute(relative) && relative.split('/').every(x => x && x !== '.' && x !== '..' && x !== '.git'),
  'Unsafe relative source path');
  const full = path.resolve(base, relative);
  assert(full.startsWith(base + path.sep), 'Source path escaped owner');
  return full;
};
const json = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const manifestPath = path.join(root, 'patches/sqlcipher/manifest.json');
const provenancePath = path.join(root, 'runtime/qtox-import/provenance.json');
const spec = json(manifestPath);
const windows = json(provenancePath);
assert(spec.schemaVersion === 1 && spec.materializedTree.algorithm === 'sha256-file-size-path-lines-v1',
  'Unsupported reviewed SQLCipher manifest');
assert(spec.versions.sqlcipher === '4.19.0' && spec.versions.sqlite === '3.54.0' &&
  spec.versions.openssl === '4.0.3' && windows.versions.sqlcipher === '4.19.0 community' &&
  windows.versions.sqlite === spec.versions.sqlite && windows.versions.openssl === spec.versions.openssl,
  'Pinned provider versions changed');
const sources = [spec.baseSource, spec.upstreamSQLite].map(x => ({ ...x }));
const openssl = windows.sources.filter(x => x.Name === 'openssl-' + spec.versions.openssl + '.tar.gz');
assert(openssl.length === 1, 'Pinned OpenSSL source missing or ambiguous');
sources.push({ name: openssl[0].Name, url: openssl[0].Url, size: openssl[0].Size, sha256: openssl[0].Sha256.toLowerCase() });
for (const item of sources) {
  assert(/^[A-Za-z0-9._-]+$/.test(item.name) && /^https:\/\/[^\s]+$/.test(item.url) &&
    Number.isSafeInteger(item.size) && item.size > 0 && /^[a-f0-9]{64}$/i.test(item.sha256), 'Invalid source pin');
  item.sha256 = item.sha256.toLowerCase();
  const original = windows.sources.filter(x => x.Name === item.name);
  assert(original.length === 1 && original[0].Url === item.url &&
    same({ size: original[0].Size, sha256: original[0].Sha256.toLowerCase() }, item),
  'Source provenance disagrees with patch manifest');
}
assert(spec.patch.path.startsWith('patches/sqlcipher/'), 'Patch outside SQLCipher owner');
const patchPath = confined(root, spec.patch.path);
const patchPin = exact(patchPath, spec.patch);
const requiredExports = windows.requiredExports;
assert(Array.isArray(requiredExports) && requiredExports.length === 12 &&
  new Set(requiredExports).size === 12 && requiredExports.every(x => /^sqlite3_[a-z0-9_]+$/.test(x)),
  'Invalid SQLCipher ABI export contract');
if (process.argv.length === 3 && process.argv[2] === '--inputs') {
  for (const item of sources) process.stdout.write([item.name, item.url, item.size, item.sha256].join('\t') + '\n');
  process.exit(0);
}
assert(process.argv.length === 8 && process.argv[2] === '--downloads' &&
  process.argv[4] === '--output' && process.argv[6] === '--jobs',
  'Usage: rebuild-sqlcipher-unix.mjs --inputs | --downloads DIR --output DIR --jobs N');
assert(process.platform === 'linux' && process.arch === 'x64', 'Provider build requires Linux x86_64');
assert(/^ID=debian$/m.test(fs.readFileSync('/etc/os-release', 'utf8')) &&
  /^VERSION_ID="?13"?$/m.test(fs.readFileSync('/etc/os-release', 'utf8')), 'Provider build requires Debian 13');
const jobs = process.argv[7];
assert(/^[1-9][0-9]{0,3}$/.test(jobs), 'Invalid build parallelism');
for (const name of ['CC', 'CXX', 'AR', 'CPPFLAGS', 'CXXFLAGS', 'LDFLAGS', 'LIBS', 'MAKEFLAGS', 'MFLAGS',
  'LD_PRELOAD', 'LD_LIBRARY_PATH', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) {
  assert(!process.env[name], 'Ambient build override forbidden: ' + name);
}
const downloads = fs.realpathSync(process.argv[3]);
const output = path.resolve(process.argv[5]);
assert(downloads === path.join(root, 'work/downloads') &&
  output === path.join(root, 'work/platform/linux/qtox-import'), 'Unexpected managed build input/output root');
// The existing libsodium prepare branch exports exactly these flags; cache hits may leave them unset.
assert(!process.env.CFLAGS || process.env.CFLAGS === '-O2 -fPIC', 'Unexpected inherited CFLAGS');
const env = { ...process.env, CFLAGS: '-O2 -fPIC', LC_ALL: 'C', LANG: 'C', SOURCE_DATE_EPOCH: String(windows.sourceDateEpoch) };
assert(Number.isSafeInteger(windows.sourceDateEpoch) && windows.sourceDateEpoch > 0, 'Missing source date epoch');
const run = (command, args, cwd, capture = false, extraEnv = {}) => {
  const result = spawnSync(command, args, { cwd, env: { ...env, ...extraEnv },
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.error || result.status !== 0 || result.signal) fail('Provider build command failed: ' + command);
  return capture ? result.stdout : '';
};
const glibc = run('getconf', ['GNU_LIBC_VERSION'], root, true).trim();
assert(glibc === 'glibc 2.41', 'Unexpected Debian 13 libc baseline');
const compiler = run('cc', ['--version'], root, true).trim();
for (const item of sources) exact(path.join(downloads, item.name), item);
const inputPins = { manifest: identity(manifestPath), provenance: identity(provenancePath), patch: patchPin,
  recipe: identity(recipePath), sources, versions: spec.versions, compiler, glibc, architecture: process.arch,
  sourceDateEpoch: windows.sourceDateEpoch };
const inputFingerprint = sha(JSON.stringify(inputPins));
const safeDirectory = p => {
  const absolute = path.resolve(p);
  let cursor = path.parse(absolute).root;
  for (const part of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    if (!fs.existsSync(cursor)) fs.mkdirSync(cursor);
    const st = fs.lstatSync(cursor);
    assert(st.isDirectory() && !st.isSymbolicLink(), 'Unsafe build directory: ' + cursor);
  }
  assert(fs.realpathSync(absolute) === absolute, 'Build directory canonical mismatch');
  return absolute;
};
safeDirectory(path.dirname(output));
if (fs.existsSync(output) || fs.existsSync(output + '/provenance.json')) {
  safeDirectory(output);
  const previous = json(path.join(output, 'provenance.json'));
  assert(previous.inputFingerprint === inputFingerprint && previous.platform === 'linux-x86_64-debian13',
    'Existing provider output belongs to other inputs; preserve it and select a fresh owner work root');
  exact(path.join(output, 'libsqlcipher.so'), previous.runtime);
  exact(path.join(output, 'README.txt'), previous.readme);
  assert(fs.readdirSync(output).sort().join('|') === 'README.txt|libsqlcipher.so|provenance.json',
    'Unexpected managed provider output entries');
  process.stdout.write('SQLCIPHER_LINUX_REUSED\n');
  process.exit(0);
}
const builds = safeDirectory(path.join(root, 'work/sqlcipher-unix-builds'));
const work = fs.mkdtempSync(path.join(builds, 'build-'));
const extract = (archive, destination) => {
  const names = run('tar', ['-tzf', archive], work, true).trimEnd().split('\n');
  const listing = run('tar', ['-tvzf', archive], work, true).trimEnd().split('\n');
  assert(names.length > 0 && names.length === listing.length && listing.every(x => /^[d-]/.test(x)),
    'Source archive contains links or special entries');
  const top = names[0].split('/')[0];
  assert(/^[A-Za-z0-9._-]+$/.test(top) && top !== '.' && top !== '..', 'Invalid archive root');
  const unique = new Set();
  for (const name of names) {
    const clean = name.replace(/\/$/, '');
    assert(!unique.has(clean), 'Duplicate archive member');
    unique.add(clean);
    assert(!clean.includes('\\') && !clean.startsWith('/') && clean.split('/')[0] === top &&
      clean.split('/').every(x => x && x !== '.' && x !== '..' && x !== '.git'), 'Unsafe archive member');
  }
  fs.mkdirSync(destination);
  run('tar', ['-xzf', archive, '--strip-components=1', '--no-same-owner', '--no-same-permissions', '-C', destination], work);
};
const cipher = path.join(work, 'sqlcipher');
const ssl = path.join(work, 'openssl');
extract(path.join(downloads, sources[0].name), cipher);
extract(path.join(downloads, sources[2].name), ssl);
const tree = base => {
  const rows = new Map();
  const visit = (directory, relative = '') => {
    for (const name of fs.readdirSync(directory)) {
      const rel = relative ? relative + '/' + name : name;
      const full = confined(base, rel);
      const st = fs.lstatSync(full);
      assert(!st.isSymbolicLink() && (st.isFile() || st.isDirectory()), 'Unsafe materialized source entry');
      if (st.isDirectory()) visit(full, rel);
      else rows.set(rel, identity(full));
    }
  };
  visit(base);
  const lines = [...rows].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([name, value]) => value.sha256 + '\t' + value.size + '\t' + name + '\n').join('');
  return { sha256: sha(lines), rows };
};
const touched = (snapshot, side) => {
  assert(Array.isArray(spec.touchedFiles) && spec.touchedFiles.length > 0, 'Missing touched-file contract');
  const names = new Set();
  for (const item of spec.touchedFiles) {
    confined(cipher, item.path);
    assert(!names.has(item.path), 'Duplicate patch entry');
    names.add(item.path);
    const found = snapshot.rows.get(item.path);
    const expected = item[side];
    assert(expected === null ? found === undefined : found && same(found, expected), 'Patch ' + side + ' identity mismatch: ' + item.path);
  }
};
const before = tree(cipher);
assert(before.sha256 === spec.materializedTree.beforeSha256, 'Complete SQLCipher base tree mismatch');
touched(before, 'before');
const gitEnv = { GIT_CEILING_DIRECTORIES: work, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
const gitArgs = ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'apply'];
run('git', [...gitArgs, '--check', '--whitespace=nowarn', '--', patchPath], cipher, false, gitEnv);
run('git', [...gitArgs, '--whitespace=nowarn', '--', patchPath], cipher, false, gitEnv);
const after = tree(cipher);
assert(after.sha256 === spec.materializedTree.afterSha256, 'Complete patched SQLCipher tree mismatch');
touched(after, 'after');
run('perl', ['Configure', 'linux-x86_64', 'no-shared', 'no-module', 'no-tests', 'no-asm', '-fPIC',
  '--prefix=' + path.join(work, 'openssl-install'), '--openssldir=' + path.join(work, 'openssl-install/ssl')], ssl);
run('make', ['-j' + jobs, 'build_libs'], ssl);
run('./configure', ['--disable-tcl'], cipher);
run('make', ['-j' + jobs, 'sqlite3.c'], cipher);
const staging = path.join(work, 'runtime');
fs.mkdirSync(staging);
const library = path.join(staging, 'libsqlcipher.so');
const flags = ['-O2', '-fPIC', '-shared', '-pthread', '-DSQLITE_HAS_CODEC', '-DSQLITE_TEMP_STORE=2',
  '-DSQLITE_EXTRA_INIT=sqlcipher_extra_init', '-DSQLITE_EXTRA_SHUTDOWN=sqlcipher_extra_shutdown',
  '-DSQLCIPHER_CRYPTO_OPENSSL', '-I', path.join(ssl, 'include'), 'sqlite3.c', path.join(ssl, 'libcrypto.a'),
  '-Wl,-soname,libsqlcipher.so', '-Wl,-z,relro,-z,now', '-Wl,--no-undefined', '-Wl,--exclude-libs,ALL', '-ldl', '-lm', '-o', library];
run('cc', flags, cipher);
const elf = run('readelf', ['-h', library], work, true);
const dynamic = run('readelf', ['-d', library], work, true);
const symbols = run('nm', ['-D', '--defined-only', library], work, true);
assert(/Class:\s+ELF64/.test(elf) && /Machine:\s+Advanced Micro Devices X86-64/.test(elf), 'Unexpected provider ELF target');
assert(!/\((RPATH|RUNPATH)\)/.test(dynamic), 'Provider must not embed a search path');
const needed = [...dynamic.matchAll(/\(NEEDED\).*Shared library: \[([^\]]+)\]/g)].map(m => m[1]).sort();
assert(needed.length > 0 && needed.every(x => ['libc.so.6', 'libm.so.6', 'libdl.so.2', 'libpthread.so.0', 'ld-linux-x86-64.so.2'].includes(x)),
  'Unexpected shared provider dependency; OpenSSL must be static');
const exported = new Set(symbols.trim().split('\n').map(x => x.trim().split(/\s+/).at(-1).split('@')[0]));
assert(requiredExports.every(x => exported.has(x)), 'Provider ABI export missing');
const readme = 'Kaigen qTox history provider for Linux x86_64, Debian 13 (glibc 2.41).\n' +
  'SQLCipher ' + spec.versions.sqlcipher + '; SQLite ' + spec.versions.sqlite + '; OpenSSL ' + spec.versions.openssl + '.\n' +
  'OpenSSL libcrypto is linked statically with PIC. Only the bundled libsqlcipher.so is loaded.\n' +
  'Exact source, patch, compiler and output identities are recorded in provenance.json.\n';
fs.writeFileSync(path.join(staging, 'README.txt'), readme, { flag: 'wx' });
for (const item of sources) exact(path.join(downloads, item.name), item);
exact(manifestPath, inputPins.manifest); exact(provenancePath, inputPins.provenance);
exact(recipePath, inputPins.recipe); exact(patchPath, patchPin);
const record = { schemaVersion: 1, platform: 'linux-x86_64-debian13', versions: spec.versions,
  inputFingerprint, inputs: inputPins, materializedTree: { beforeSha256: before.sha256, afterSha256: after.sha256 },
  sourceDateEpoch: windows.sourceDateEpoch, requiredExports, needed, opensslStaticLibrary: identity(path.join(ssl, 'libcrypto.a')),
  effectiveFlags: flags.map(x => x.replaceAll(work, '$BUILD_ROOT')), runtime: identity(library),
  readme: identity(path.join(staging, 'README.txt')) };
fs.writeFileSync(path.join(staging, 'provenance.json'), JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
// Exclusive publish: failed work/output is preserved, never deleted or overwritten.
fs.mkdirSync(output);
for (const name of ['libsqlcipher.so', 'provenance.json', 'README.txt']) {
  fs.copyFileSync(path.join(staging, name), path.join(output, name), fs.constants.COPYFILE_EXCL);
  exact(path.join(output, name), identity(path.join(staging, name)));
}
process.stdout.write('SQLCIPHER_LINUX_PREPARED\n');
