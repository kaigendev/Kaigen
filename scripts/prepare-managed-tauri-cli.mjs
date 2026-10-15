import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const debian13ContainerImage = 'debian:13-slim@sha256:a29215f6a35e51e22adffa17f89e9d2ef06214e64a2bad10d765c46aea49f11f';
const pinsPath = path.join(projectRoot, 'patches/tauri-cli/manifest.json');
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const fail = (message) => { throw new Error(message); };
const [action, ...rest] = process.argv.slice(2);
const args = {};
for (let index = 0; index < rest.length; index += 2) {
  if (!rest[index]?.startsWith('--') || !rest[index + 1]) fail('Expected explicit option/value pairs');
  args[rest[index].slice(2)] = path.resolve(rest[index + 1]);
}
async function fileBytes(file) {
  const info = await fs.lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) fail(`Expected ordinary file: ${file}`);
  return fs.readFile(file);
}
async function verify(file, expected) {
  const bytes = await fileBytes(file);
  if (sha(bytes) !== expected.toLowerCase()) fail(`SHA-256 mismatch: ${file}`);
  return bytes;
}
function run(command, argv, options = {}) {
  const result = spawnSync(command, argv, { encoding: 'utf8', ...options });
  if (result.error || result.status !== 0) fail(`${command} failed: ${result.error?.message || result.stderr || result.status}`);
  return result.stdout;
}
async function inventory(root, relative = '') {
  const rows = [];
  for (const entry of (await fs.readdir(path.join(root, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) fail(`Symlink input denied: ${name}`);
    if (entry.isDirectory()) rows.push(...await inventory(root, name));
    else if (entry.isFile()) {
      const bytes = await fileBytes(path.join(root, name));
      rows.push({ path: name, size: bytes.length, sha256: sha(bytes) });
    } else fail(`Special input denied: ${name}`);
  }
  return rows;
}
async function seedOfflineInput(spec, cacheRoot, parts = [spec]) {
  if (!spec || !/^[A-Za-z0-9._-]+$/.test(spec.filename) || !/^[a-f0-9]{64}$/i.test(spec.sha256)) fail('Invalid offline input pin');
  const destination = path.join(cacheRoot, spec.sha256.toUpperCase(), spec.filename);
  try {
    const bytes = await verify(destination, spec.sha256);
    if (bytes.length !== spec.size) fail('Cached offline input size mismatch');
    return destination;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.partial-${process.pid}`;
  const output = await fs.open(temporary, 'wx');
  try {
    for (const part of parts) {
      if (!/^[A-Za-z0-9._-]+$/.test(part.filename)) fail('Unsafe offline input part name');
      const bytes = await verify(path.join(projectRoot, 'runtime-manifests/vendor-inputs', part.filename), part.sha256);
      if (bytes.length !== part.size) fail('Offline input part size mismatch');
      await output.writeFile(bytes);
    }
  } finally { await output.close(); }
  try {
    const bytes = await verify(temporary, spec.sha256);
    if (bytes.length !== spec.size) fail('Assembled offline input size mismatch');
    try { await fs.link(temporary, destination); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = await verify(destination, spec.sha256);
      if (existing.length !== spec.size) fail('Immutable existing input size mismatch');
    }
  } finally { await fs.unlink(temporary); }
  return destination;
}
const pins = JSON.parse(await fileBytes(pinsPath));
await verify(path.join(projectRoot, 'patches/tauri-cli/Cargo.lock'), pins.lockSha256);
if (!/^\d+\.\d+\.\d+$/.test(pins.source?.version)) fail('Invalid managed CLI source version');
const sourceDirectory = `tauri-cli-${pins.source.version}`;
if (pins.sourcePatch === 'none') {
  if (pins.patchSha256 !== null || pins.originalManifestSha256 !== pins.patchedManifestSha256) fail('Patchless CLI requires the exact unchanged official manifest');
} else fail('Expected explicitly patchless official CLI source');

if (action === 'build-seeded') {
  if (!args['cache-root'] || !args.destination || !args.cargo || !pins.buildInputs?.parts?.length) fail('build-seeded requires exact cache-root, destination, cargo and source parts');
  const inputs = await seedOfflineInput(pins.buildInputs, args['cache-root'], pins.buildInputs.parts);
  args['source-archive'] = await seedOfflineInput(pins.originalSourceArchive, args['cache-root']);
  const staging = `${args.destination}.inputs`;
  await fs.mkdir(staging);
  run('tar', ['-xzf', inputs, '-C', staging]);
  args.source = path.join(staging, sourceDirectory);
  args.vendor = path.join(staging, 'vendor');
}

if (action === 'build' || action === 'build-seeded') {
  if (process.platform !== 'linux' || process.arch !== 'x64') fail('Managed CLI producer requires Linux x64');
  const compilerOverrides = Object.keys(process.env).filter((name) => /^(RUSTFLAGS|CARGO_ENCODED_RUSTFLAGS|CARGO_BUILD_RUSTFLAGS|CARGO_BUILD_TARGET|RUSTC_WRAPPER|RUSTC_WORKSPACE_WRAPPER|CC|CFLAGS|CPPFLAGS|LDFLAGS|AR|ARFLAGS)$/.test(name) || /^CARGO_TARGET_.*_RUSTFLAGS$/.test(name));
  if (compilerOverrides.some((name) => process.env[name])) fail('Ambient compiler/target overrides are outside the pinned managed-tool recipe');
  if (!args.source || !args.vendor || !args.destination || !args.cargo || !args['source-archive']) fail('build requires source, vendor, destination, cargo, source-archive');
  await verify(path.join(args.source, 'Cargo.toml'), pins.patchedManifestSha256);
  await verify(path.join(args.source, 'Cargo.lock'), pins.lockSha256);
  const sourceFiles = await inventory(args.source);
  const vendorFiles = await inventory(args.vendor);
  await verify(args['source-archive'], pins.source.sha256);
  await fs.mkdir(args.destination);
  const originalRoot = path.join(args.destination, 'official-source');
  await fs.mkdir(originalRoot);
  run('tar', ['-xzf', args['source-archive'], '-C', originalRoot]);
  const originalSource = path.join(originalRoot, sourceDirectory);
  await verify(path.join(originalSource, 'Cargo.toml'), pins.originalManifestSha256);
  const originalFiles = await inventory(originalSource);
  const expectedFiles = originalFiles.map((row) => {
    if (row.path === 'Cargo.toml') return sourceFiles.find((file) => file.path === row.path);
    if (row.path === 'Cargo.lock') return sourceFiles.find((file) => file.path === row.path);
    return row;
  });
  if (JSON.stringify(sourceFiles) !== JSON.stringify(expectedFiles)) fail('Materialized source differs from official archive outside approved manifest/lock patch');
  const sourceTreeSha256 = sha(JSON.stringify(sourceFiles));
  const vendorTreeSha256 = sha(JSON.stringify(vendorFiles));
  if (sourceTreeSha256 !== pins.buildInputs.sourceTreeSha256 || vendorTreeSha256 !== pins.buildInputs.vendorTreeSha256) fail('Exact source/vendor tree fingerprint mismatch');
  const rustc = path.join(path.dirname(args.cargo), 'rustc');
  const compiler = run(rustc, ['-Vv']).trim();
  if (!compiler.includes('release: 1.97.1') || !compiler.includes('host: x86_64-unknown-linux-gnu')) fail('Expected pinned rustc 1.97.1 Linux x64');
  const sysroot = run(rustc, ['--print', 'sysroot']).trim();
  const osReleaseBytes = await fileBytes(await fs.realpath('/etc/os-release'));
  const osRelease = osReleaseBytes.toString('utf8');
  const os = { id: osRelease.match(/^ID=(.*)$/m)?.[1].replaceAll('"', ''), versionId: osRelease.match(/^VERSION_ID=(.*)$/m)?.[1].replaceAll('"', ''), releaseSha256: sha(osReleaseBytes) };
  const toolchain = { rustc: compiler, cargo: run(args.cargo, ['-V']).trim(), cc: run('cc', ['--version']).trim(), linker: run('ld', ['--version']).trim(), libc: run('getconf', ['GNU_LIBC_VERSION']).trim(), liblzma: run('pkg-config', ['--modversion', 'liblzma']).trim(), os, sysroot, rustcBinarySha256: sha(await fileBytes(path.join(sysroot, 'bin/rustc'))), cargoBinarySha256: sha(await fileBytes(path.join(sysroot, 'bin/cargo'))), ccBinarySha256: sha(await fileBytes(await fs.realpath(run('which', ['cc']).trim()))), linkerBinarySha256: sha(await fileBytes(await fs.realpath(run('which', ['ld']).trim()))) };
  if (!toolchain.cargo.startsWith('cargo 1.97.1 ')) fail('Expected pinned Cargo 1.97.1');
  const recipeSha256 = sha(await fileBytes(fileURLToPath(import.meta.url)));
  const fingerprint = sha(JSON.stringify({ sourceTreeSha256, vendorTreeSha256, source: pins.source, patch: pins.patchSha256, lock: pins.lockSha256, features: pins.features, toolchain, recipeSha256, flags: ['--release', '--offline', '--locked', '--no-default-features', '--features', pins.features.join(',')] }));
  const cargoHome = path.join(args.destination, 'cargo-home');
  await fs.mkdir(cargoHome);
  await fs.writeFile(path.join(cargoHome, 'config.toml'), `[source.crates-io]\nreplace-with = "managed-vendor"\n[source.managed-vendor]\ndirectory = ${JSON.stringify(args.vendor)}\n[net]\noffline = true\n`);
  const target = args.target || path.join(args.destination, 'target');
  run(args.cargo, ['build', '--manifest-path', path.join(args.source, 'Cargo.toml'), '--bin', 'cargo-tauri', '--release', '--offline', '--locked', '--no-default-features', '--features', pins.features.join(',')], { cwd: args.source, stdio: 'inherit', env: { ...process.env, PATH: `${path.dirname(args.cargo)}:${process.env.PATH}`, CARGO_HOME: cargoHome, CARGO_TARGET_DIR: target, CARGO_NET_OFFLINE: 'true', KAIGEN_ALLOW_NETWORK_COMPONENT_FETCH: '', KAIGEN_COMPONENT_UPDATE_SCOPE: '' } });
  const executable = path.join(args.destination, 'cargo-tauri');
  await fs.copyFile(path.join(target, 'release/cargo-tauri'), executable, fs.constants.COPYFILE_EXCL);
  await fs.chmod(executable, 0o755);
  const binary = await fileBytes(executable);
  const reportedVersion = run(executable, ['--version']).trim();
  if (reportedVersion !== `tauri-cli ${pins.source.version}`) fail('CLI version mismatch');
  const jobBinding = process.env.GITHUB_ACTIONS === 'true'
    ? { environment: 'github-actions', runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT, job: process.env.GITHUB_JOB, workspace: process.env.GITHUB_WORKSPACE, runnerTemp: process.env.RUNNER_TEMP, declaredContainerImage: process.env.KAIGEN_CI_CONTAINER_IMAGE }
    : { environment: 'local' };
  if (jobBinding.environment === 'github-actions' && (!jobBinding.runId || !jobBinding.runAttempt || !jobBinding.job || !jobBinding.workspace || !jobBinding.runnerTemp)) fail('Actions producer job binding missing');
  if (jobBinding.environment === 'github-actions' && (jobBinding.declaredContainerImage !== debian13ContainerImage || os.id !== 'debian' || os.versionId !== '13' || toolchain.libc !== 'glibc 2.41')) fail('Actions managed producer requires its pinned Debian 13 / glibc 2.41 container');
  await fs.writeFile(path.join(args.destination, 'provenance.json'), JSON.stringify({ schema: 1, status: 'BUILT', fingerprint, source: pins.source, bundler: pins.bundler, patchSha256: pins.patchSha256, lockSha256: pins.lockSha256, features: pins.features, sourceTreeSha256, vendorTreeSha256, recipeSha256, toolchain, reportedVersion, jobBinding, binary: { filename: 'cargo-tauri', size: binary.length, sha256: sha(binary) } }, null, 2) + '\n', { flag: 'wx' });
} else if (action === 'admit-built') {
  if (!args['build-root']) fail('admit-built requires exact build-root');
  const buildRoot = await fs.realpath(args['build-root']);
  const provenance = JSON.parse(await fileBytes(path.join(buildRoot, 'provenance.json')));
  if (process.env.GITHUB_ACTIONS === 'true') {
    const runnerTemp = await fs.realpath(process.env.RUNNER_TEMP || fail('RUNNER_TEMP missing'));
    const relative = path.relative(runnerTemp, buildRoot);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) fail('Actions tool output must stay inside this runner temporary root');
    const job = provenance.jobBinding;
    if (job?.environment !== 'github-actions' || job.runId !== process.env.GITHUB_RUN_ID || job.runAttempt !== process.env.GITHUB_RUN_ATTEMPT || job.job !== process.env.GITHUB_JOB || job.workspace !== process.env.GITHUB_WORKSPACE || job.runnerTemp !== process.env.RUNNER_TEMP) fail('Managed CLI does not belong to this Actions job');
    if (job.declaredContainerImage !== debian13ContainerImage || process.env.KAIGEN_CI_CONTAINER_IMAGE !== debian13ContainerImage || provenance.toolchain?.os?.id !== 'debian' || provenance.toolchain.os.versionId !== '13' || provenance.toolchain.libc !== 'glibc 2.41') fail('Actions managed CLI Debian container/OS/ABI provenance mismatch');
  }
  const recipeSha256 = sha(await fileBytes(fileURLToPath(import.meta.url)));
  if (provenance.schema !== 1 || provenance.status !== 'BUILT' || provenance.source?.sha256 !== pins.source.sha256 || provenance.bundler !== pins.bundler || provenance.patchSha256 !== pins.patchSha256 || provenance.lockSha256 !== pins.lockSha256 || provenance.sourceTreeSha256 !== pins.buildInputs.sourceTreeSha256 || provenance.vendorTreeSha256 !== pins.buildInputs.vendorTreeSha256 || provenance.recipeSha256 !== recipeSha256 || JSON.stringify(provenance.features) !== JSON.stringify(pins.features)) fail('Built managed CLI source/patch/lock/features/recipe provenance mismatch');
  if (!provenance.toolchain.rustc.includes('release: 1.97.1') || !provenance.toolchain.rustc.includes('host: x86_64-unknown-linux-gnu')) fail('Built managed CLI compiler target mismatch');
  const fingerprint = sha(JSON.stringify({ sourceTreeSha256: provenance.sourceTreeSha256, vendorTreeSha256: provenance.vendorTreeSha256, source: pins.source, patch: pins.patchSha256, lock: pins.lockSha256, features: pins.features, toolchain: provenance.toolchain, recipeSha256, flags: ['--release', '--offline', '--locked', '--no-default-features', '--features', pins.features.join(',')] }));
  if (provenance.fingerprint !== fingerprint || provenance.binary?.filename !== 'cargo-tauri') fail('Built managed CLI fingerprint/output contract mismatch');
  const executable = path.join(buildRoot, 'cargo-tauri');
  const binary = await verify(executable, provenance.binary.sha256);
  if (binary.length !== provenance.binary.size || run(executable, ['--version']).trim() !== provenance.reportedVersion || provenance.reportedVersion !== `tauri-cli ${pins.source.version}`) fail('Built managed CLI executable identity mismatch');
  process.stdout.write(`${executable}|${provenance.binary.sha256}\n`);
} else if (action === 'materialize') {
  if (!args['cache-root'] || !args.destination || !pins.archive) fail('materialize requires exact cache and destination plus accepted archive pins');
  const archive = pins.archive;
  if (!/^[a-zA-Z0-9._-]+$/.test(archive.filename)) fail('Unsafe archive filename');
  const cacheRoot = args['cache-root'];
  const candidates = [path.join(cacheRoot, archive.sha256.toUpperCase(), archive.filename), path.join(cacheRoot, archive.filename)];
  let input;
  for (const candidate of candidates) { try { await fs.access(candidate); input = candidate; break; } catch {} }
  if (!input) fail('Exact managed CLI cache object missing');
  const bytes = await verify(input, archive.sha256);
  if (bytes.length !== archive.size) fail('Managed CLI archive size mismatch');
  const names = run('tar', ['-tzf', input]).trim().split('\n');
  if (names.length !== 3 || !['managed-tauri-cli/', 'managed-tauri-cli/cargo-tauri', 'managed-tauri-cli/provenance.json'].every((name) => names.includes(name))) fail('Unexpected managed CLI archive layout');
  const listing = run('tar', ['-tvzf', input]).trim().split('\n');
  if (listing.some((line) => !['-', 'd'].includes(line[0]))) fail('Managed CLI symlink or special file denied');
  await fs.mkdir(args.destination);
  run('tar', ['-xzf', input, '-C', args.destination]);
  const executable = path.join(args.destination, 'managed-tauri-cli/cargo-tauri');
  const provenance = JSON.parse(await fileBytes(path.join(args.destination, 'managed-tauri-cli/provenance.json')));
  await verify(executable, archive.binarySha256);
  if (provenance.lockSha256 !== pins.lockSha256 || provenance.patchSha256 !== pins.patchSha256 || provenance.bundler !== '2.10.3' || provenance.fingerprint !== archive.fingerprint) fail('Managed CLI provenance mismatch');
  process.stdout.write(`${executable}\n`);
} else fail('Use build, build-seeded, admit-built or materialize');
