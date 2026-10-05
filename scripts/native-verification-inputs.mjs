import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// This is a reviewed reader boundary, not a dependency parser. Reader changes
// require a new audit; a complete Git inventory cannot bind unknown external reads.
export const NATIVE_INPUT_REVIEW = '046c865fc9f67337190867ababb5a46591f2b304';
export const NATIVE_INPUT_POLICY_KIND = 'kaigen-reviewed-native-source-inputs';
const PRODUCER = 'scripts/native-verification-inputs.mjs';
const VALIDATOR = 'scripts/incremental-windows-verification.mjs';
const RUNNING_PRODUCER = readFileSync(fileURLToPath(import.meta.url));
const RUNNING_VALIDATOR = readFileSync(new URL('./incremental-windows-verification.mjs', import.meta.url));
const REVIEW = 'scripts/native-verification-input-review.json';
const REVIEW_SHA256 = '729318656be6dc07d3e9d5ffe91602a6cfb06002b8d45bd297467b38b7caab3a';
const HASH = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const NATIVE_READERS = new Map([
  ['native:prepared-cache', ['scripts/test-prepared-native-cache-windows.ps1', 'scripts/prepared-native-cache-windows.ps1', 'scripts/build-portable.ps1', 'scripts/prepare-dependencies.ps1']],
  ['native:retry-cap', ['scripts/test-toxcore-retry-cap.ps1']],
  ['native:offline-friend-request', ['scripts/test-offline-friend-request-loopback.ps1', 'scripts/tests/offline-friend-request-loopback.c']],
]);
const RUST_FIXTURE = 'scripts/fixtures/web-background-transfer-contract.json';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const assert = (condition, message) => { if (!condition) throw new Error(`Native inputs: ${message}`); };
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const repositoryPath = value => {
  assert(typeof value === 'string' && value && !value.includes('\\') && !value.includes(':') && !value.includes('\0')
    && !value.startsWith('/') && value.split('/').every(part => part && part !== '.' && part !== '..'), 'invalid repository path');
  return value;
};
function git(root, args, options = {}) {
  return execFileSync('git', ['-c', `safe.directory=${root.replaceAll('\\', '/')}`, '-C', root, ...args], { windowsHide: true, maxBuffer: 96 * 1024 * 1024, ...options });
}
function tree(root, commit) {
  assert(COMMIT.test(commit), 'complete immutable commit required');
  assert(git(root, ['rev-parse', `${commit}^{commit}`]).toString().trim() === commit, 'immutable source commit changed');
  return git(root, ['ls-tree', '-r', '-z', commit]).toString('utf8').split('\0').filter(Boolean).map(row => {
    const match = /^(\d{6}) (blob|commit) ([a-f0-9]{40})\t([\s\S]+)$/u.exec(row);
    assert(match, 'unsupported source tree entry');
    return { path: repositoryPath(match[4]), mode: match[1], type: match[2], blob: match[3] };
  }).sort((a, b) => compare(a.path, b.path));
}
function cargoOrToolchain(filename) {
  filename = filename.toLowerCase();
  return /(?:^|\/)\.cargo\//u.test(filename) || /(?:^|\/)rust-toolchain(?:\.toml)?$/u.test(filename);
}
function rustReader(filename) {
  filename = filename.toLowerCase();
  return filename.startsWith('vendor/mlkem-native-2.0.0/mlkem/') || filename === 'scripts/build-portable.ps1' || cargoOrToolchain(filename) || ['cargo.toml', 'cargo.lock'].includes(filename) || (filename.startsWith('src-tauri/')
    && (/\.(?:rs|toml|json|json5|lock)$/u.test(filename) || /(?:^|\/)Tauri\.toml$/u.test(filename)));
}
function rustInput(filename) {
  filename = filename.toLowerCase();
  return filename.startsWith('src-tauri/') || filename.startsWith('vendor/mlkem-native-2.0.0/mlkem/')
    || filename.startsWith('runtime/') || filename === RUST_FIXTURE || cargoOrToolchain(filename) || ['cargo.toml', 'cargo.lock', 'scripts/build-portable.ps1'].includes(filename);
}
export function isNativeInputCheck(check) {
  return NATIVE_READERS.has(check?.id) || (typeof check?.id === 'string' && check.id.startsWith('rust:'));
}
function canonicalRemap(value, root) {
  if (typeof value !== 'string') return false;
  const tokens = value.split('\u001f');
  if (tokens.length !== 2) return false;
  const targets = ['C:\\KaigenRepro\\source', 'C:\\KaigenRepro\\user'];
  const originals = [root, os.userInfo().homedir];
  return tokens.every((token, index) => {
    const prefix = '--remap-path-prefix=', suffix = `=${targets[index]}`;
    if (!token.startsWith(prefix) || !token.endsWith(suffix)) return false;
    const original = token.slice(prefix.length, -suffix.length);
    if (!path.isAbsolute(original)) return false;
    try { return realpathSync.native(original).toLowerCase() === realpathSync.native(originals[index]).toLowerCase(); }
    catch { return false; }
  });
}
function assertEnvironment(environment, rust, root) {
  const names = Object.entries(environment).filter(([, value]) => value !== undefined && value !== '')
    .filter(([name, value]) => !(rust && name.toUpperCase() === 'CARGO_ENCODED_RUSTFLAGS' && canonicalRemap(value, root)))
    .map(([name]) => name.toUpperCase()).filter(name => /^TAURI_CONFIG(?:_|$)/u.test(name)
      || name === 'KAIGEN_QTOX_IMPORT_RUNTIME_ROOT'
      || name === 'REMOVE_UNUSED_COMMANDS'
      || /^(?:(?:CC|CXX|AR|CFLAGS|CXXFLAGS|CPPFLAGS|LDFLAGS)(?:_|$)|(?:HOST|TARGET)_(?:CC|CXX|AR|CFLAGS|CXXFLAGS|CPPFLAGS|LDFLAGS)(?:_|$)|PKG_CONFIG(?:_|$)|CMAKE_TOOLCHAIN_FILE$)/u.test(name)
      || (rust && (/^CARGO_(?:HOME$|BUILD_|TARGET_|PROFILE_|FEATURE_|ENCODED_RUSTFLAGS$|ENCODED_RUSTDOCFLAGS$)/u.test(name)
        || /^(?:RUSTFLAGS|RUSTDOCFLAGS|RUSTC|RUSTC_WRAPPER|RUSTC_WORKSPACE_WRAPPER|RUSTUP_TOOLCHAIN|RUSTUP_HOME|CARGO_FEATURES|CARGO_FLAGS|CARGO_TARGET)$/u.test(name))));
  assert(names.length === 0, `unreviewed environment override: ${names.sort(compare).join(', ')}`);
}
function present(filename) {
  try { lstatSync(filename); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
function assertExternalCargoConfig(root) {
  const files = new Set();
  for (let folder = path.join(root, 'src-tauri');; folder = path.dirname(folder)) {
    for (const name of ['config', 'config.toml']) files.add(path.join(folder, '.cargo', name));
    for (const name of ['rust-toolchain', 'rust-toolchain.toml']) files.add(path.join(folder, name));
    if (folder !== root && folder !== path.join(root, 'src-tauri')) files.add(path.join(folder, 'Cargo.toml'));
    if (path.dirname(folder) === folder) break;
  }
  for (const name of ['config', 'config.toml']) files.add(path.join(os.userInfo().homedir, '.cargo', name));
  // Metadata only. No personal configuration, credentials or profiles are read.
  assert(![...files].some(present), 'unreviewed effective Cargo configuration is present');
}
function assertPhysicalMembership(context) {
  const discovered = [], directories = ['src-tauri/capabilities', 'src-tauri/permissions', 'vendor/mlkem-native-2.0.0/mlkem'];
  const ordinaryPhysical = filename => {
    const absolute = path.join(context.executionRoot, filename), stat = lstatSync(absolute);
    assert(!stat.isSymbolicLink() && realpathSync.native(absolute).toLowerCase() === path.resolve(absolute).toLowerCase(), `unsafe physical discovery path: ${filename}`);
    assert(stat.isDirectory() || stat.isFile(), `unsupported physical discovery entry: ${filename}`);
    return stat;
  };
  const walk = filename => {
    if (!present(path.join(context.executionRoot, filename))) return;
    const stat = ordinaryPhysical(filename);
    if (stat.isFile()) { discovered.push(repositoryPath(filename)); return; }
    for (const name of readdirSync(path.join(context.executionRoot, filename))) walk(`${filename}/${name}`);
  };
  for (const directory of directories) walk(directory);
  // Tauri selects optional platform overlays from the physical crate directory;
  // ignored files can alter discovery even when Git status is clean. Generated
  // target/gen outputs are not source discovery surfaces and are never traversed.
  const crate = path.join(context.executionRoot, 'src-tauri');
  if (present(crate)) {
    ordinaryPhysical('src-tauri');
    for (const name of readdirSync(crate)) {
      const filename = `src-tauri/${name}`;
      if (rustReader(filename)) { assert(ordinaryPhysical(filename).isFile(), `unsupported physical reader: ${filename}`); discovered.push(filename); }
    }
  }
  const selected = filename => directories.some(directory => filename.startsWith(`${directory}/`))
    || (filename.startsWith('src-tauri/') && !filename.slice('src-tauri/'.length).includes('/') && rustReader(filename));
  const expected = context.entries.filter(entry => selected(entry.path)).map(entry => entry.path).sort(compare);
  assert(same(discovered.sort(compare), expected), 'physical dependency discovery membership differs from tracked source; ignored/missing inputs require review');
}
export function createNativeInputContext({ root, source, executionRoot = root, environment = process.env }) {
  assert(process.platform === 'win32' && process.arch === 'x64', 'reviewed policy supports only Windows x64');
  root = realpathSync.native(root);
  assert(source && COMMIT.test(source.commit) && COMMIT.test(source.tree), 'complete source identity required');
  assert(git(root, ['rev-parse', `${source.commit}^{tree}`]).toString().trim() === source.tree, 'source tree identity changed');
  const context = { root, source, executionRoot: realpathSync.native(executionRoot), environment, entries: tree(root, source.commit), bytes: new Map() };
  for (const [filename, running] of [[PRODUCER, RUNNING_PRODUCER], [VALIDATOR, RUNNING_VALIDATOR]]) {
    const pinned = bytes(context, context.entries.find(entry => entry.path === filename));
    assert(running.equals(pinned) || running.toString('utf8').replaceAll('\r\n', '\n') === pinned.toString('utf8').replaceAll('\r\n', '\n'),
      `running producer/validator differs from immutable source: ${filename}`);
  }
  const recordBytes = bytes(context, context.entries.find(entry => entry.path === REVIEW));
  assert(sha(recordBytes) === REVIEW_SHA256, 'reader review record changed; new audit required');
  context.reviewed = JSON.parse(recordBytes.toString('utf8'));
  return context;
}
function ordinary(entry) {
  assert(entry && entry.type === 'blob' && ['100644', '100755'].includes(entry.mode), `unsafe or missing input: ${entry?.path ?? 'required file'}`);
}
function bytes(context, entry) {
  ordinary(entry);
  if (!context.bytes.has(entry.path)) context.bytes.set(entry.path, git(context.root, ['show', `${context.source.commit}:${entry.path}`]));
  return context.bytes.get(entry.path);
}
function loadBytes(context, entries) {
  const missing = entries.filter(entry => !context.bytes.has(entry.path));
  if (!missing.length) return;
  missing.forEach(ordinary);
  const output = git(context.root, ['cat-file', '--batch'], { input: Buffer.from(missing.map(entry => entry.blob).join('\n') + '\n') });
  let offset = 0;
  for (const entry of missing) {
    const end = output.indexOf(10, offset);
    assert(end >= offset, 'immutable blob batch header missing');
    const header = /^([a-f0-9]{40}) blob ([0-9]+)$/u.exec(output.subarray(offset, end).toString('ascii'));
    assert(header && header[1] === entry.blob, 'immutable blob batch identity changed');
    const size = Number(header[2]), start = end + 1;
    assert(Number.isSafeInteger(size) && start + size < output.length && output[start + size] === 10, 'immutable blob batch is incomplete');
    context.bytes.set(entry.path, Buffer.from(output.subarray(start, start + size)));
    offset = start + size + 1;
  }
  assert(offset === output.length, 'immutable blob batch has extra data');
}
export function canonicalNativeInputs(context, check, command) {
  assert(isNativeInputCheck(check), 'unsupported check');
  const rust = check.id.startsWith('rust:');
  assert(check.variant === undefined || (rust && check.variant === 'web-core'), 'unsupported native/Rust variant');
  assert(command && typeof command.program === 'string' && Array.isArray(command.args) && command.args.every(arg => typeof arg === 'string'), 'exact command required');
  assertEnvironment(context.environment, rust, context.executionRoot);
  if (rust) { assertExternalCargoConfig(context.executionRoot); assertPhysicalMembership(context); }
  const required = rust ? null : NATIVE_READERS.get(check.id);
  loadBytes(context, context.entries.filter(entry => (rust ? rustInput(entry.path) : required.includes(entry.path)) || [PRODUCER, VALIDATOR, REVIEW].includes(entry.path)));
  const selectReaders = entries => entries.filter(entry => rust ? rustReader(entry.path) : required.includes(entry.path));
  const readers = selectReaders(context.entries).map(entry => ({ path: entry.path, mode: entry.mode, sha256: sha(bytes(context, entry)) }));
  const reviewed = context.reviewed.readers[rust ? 'rust' : check.id];
  if (!rust) assert(readers.length === required.length && reviewed.length === required.length, 'required reader membership changed');
  assert(same(readers, reviewed), 'unreviewed dependency-reader recipe or configuration membership; new audit required');
  const selected = context.entries.filter(entry => rust ? rustInput(entry.path) : required.includes(entry.path));
  for (const filename of [PRODUCER, VALIDATOR, REVIEW, ...(rust ? [RUST_FIXTURE] : [])]) {
    const entry = context.entries.find(item => item.path === filename);
    ordinary(entry);
    if (!selected.some(item => item.path === filename)) selected.push(entry);
  }
  selected.sort((a, b) => compare(a.path, b.path));
  const inputs = selected.map(entry => ({ id: `native-source:${entry.mode}:${entry.path}`, kind: 'git', path: entry.path, sha256: sha(bytes(context, entry)) }));
  const findHash = filename => inputs.find(input => input.path === filename).sha256;
  const externalBindings = (check.inputs ?? []).filter(input => input.kind === 'file')
    .map(input => ({ id: input.id, kind: input.kind, path: input.path, sha256: input.sha256 })).sort((a, b) => compare(a.id, b.id));
  return { inputs, policy: { schemaVersion: 1, kind: NATIVE_INPUT_POLICY_KIND, mode: 'reviewed-narrow', target: 'windows-x64', reviewedAnchor: NATIVE_INPUT_REVIEW, reviewRecordSha256: REVIEW_SHA256,
    readerRecipeSha256: sha(Buffer.from(JSON.stringify(readers))), producerSha256: findHash(PRODUCER), validatorSha256: findHash(VALIDATOR),
    externalBindingsSha256: sha(Buffer.from(JSON.stringify(externalBindings))), command: { program: command.program, args: [...command.args] }, variant: check.variant ?? null } };
}
export function validateNativeInputCheck(context, check, command) {
  const canonical = canonicalNativeInputs(context, check, command);
  assert(same(check.nativeInputPolicy, canonical.policy), 'policy/producer/validator/command/variant identity changed');
  assert(Array.isArray(check.inputs), 'complete input set required');
  const actual = check.inputs.filter(input => input.kind === 'git');
  assert(same(actual, canonical.inputs), 'canonical source inputs are incomplete or changed');
  assert(check.inputs.every(input => input.kind === 'git' || input.kind === 'file'), 'unsupported external input kind');
  return canonical;
}
export function assertNativeInputDeclaration(check) {
  assert(!check.inputs?.some(input => typeof input.id === 'string' && input.id.startsWith('native-source:')) || check.nativeInputPolicy !== undefined,
    'reserved policy input IDs require an explicit native input policy');
}
export function assertNativeResultDeclaration(check, result) {
  if (check.nativeInputPolicy === undefined) assert(result.nativeInputPolicy === undefined
    && !result.inputs?.some(input => typeof input.id === 'string' && input.id.startsWith('native-source:')), 'new-policy result cannot downgrade to a legacy check');
}
export function validateNativeInputResult(check, result, command) {
  assert(result.kind === 'kaigen-incremental-check-result', 'legacy/imported result cannot supply the new policy');
  assert(same(result.nativeInputPolicy, check.nativeInputPolicy), 'result lacks matching policy/producer identity; fresh execution required');
  assert((result.variant ?? null) === (check.variant ?? null), 'result variant changed');
  assert(same(result.command, { program: command.program, args: command.args }), 'result command changed');
}
export async function produceNativeInputPlan({ root, plan, environment = process.env }) {
  assert(plan?.kind === 'kaigen-windows-incremental-plan' && plan.schemaVersion === 1 && Array.isArray(plan.checks), 'ordinary input plan required');
  const context = createNativeInputContext({ root, source: plan.source, environment });
  const { descriptor } = await import('./incremental-windows-verification.mjs');
  const output = structuredClone(plan);
  for (const check of output.checks.filter(isNativeInputCheck)) {
    assert(Array.isArray(check.inputs) && check.inputs.every(input => ['git', 'file'].includes(input.kind)), 'unsupported input binding');
    const { inputs, policy } = canonicalNativeInputs(context, check, descriptor(check.id, new Set(), check.variant));
    const unchanged = same(check.nativeInputPolicy, policy) && same(check.inputs.filter(input => input.kind === 'git'), inputs);
    // Immutable external bindings remain in the plan. They do not independently
    // prove DLL/toolchain/runtime compatibility, which remains a runner/cache gate.
    check.inputs = [...inputs, ...check.inputs.filter(input => input.kind === 'file')];
    check.nativeInputPolicy = policy;
    if (!unchanged) { check.action = 'run'; delete check.evidence; }
  }
  return output;
}
async function main(args) {
  assert(args.shift() === 'produce', 'use produce --root ROOT --plan PLAN --plan-sha256 SHA --output NEWPLAN');
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index], value = args[index + 1];
    assert(['--root', '--plan', '--plan-sha256', '--output'].includes(name) && value && !Object.hasOwn(options, name), 'invalid or duplicate CLI option');
    options[name] = value;
  }
  assert(Object.keys(options).length === 4 && HASH.test(options['--plan-sha256']), 'all CLI options and exact plan hash required');
  const input = path.resolve(options['--plan']), output = path.resolve(options['--output']);
  assert(input.toLowerCase() !== output.toLowerCase(), 'new output path required');
  assert((await realpath(path.dirname(input))).toLowerCase() === (await realpath(path.dirname(output))).toLowerCase(), 'new plan must remain in the same canonical directory as its input');
  const original = await readFile(input);
  assert(sha(original) === options['--plan-sha256'], 'input plan hash changed');
  const document = await produceNativeInputPlan({ root: options['--root'], plan: JSON.parse(original.toString('utf8')) });
  const encoded = Buffer.from(`${JSON.stringify(document, null, 2)}\n`);
  await writeFile(output, encoded, { flag: 'wx' });
  console.log(JSON.stringify({ path: output, sha256: sha(encoded), policy: NATIVE_INPUT_POLICY_KIND, checks: document.checks.filter(isNativeInputCheck).length }));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
