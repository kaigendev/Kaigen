import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, mkdtemp, rm, realpath, lstat, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NATIVE_INPUT_REVIEW, assertNativeInputDeclaration, assertNativeResultDeclaration, canonicalNativeInputs, createNativeInputContext, produceNativeInputPlan, validateNativeInputCheck, validateNativeInputResult, legacyNativeClosure, validateLegacyNativeReuse } from './native-verification-inputs.mjs';
import { assertNativeReuseExport, assertFrontendReuseExport, assertLocalFullCoverage } from './publish-release.mjs';
import { descriptor, trackedChanges, validatePlan, readOwnedLegacyEvidence, validateRetainedFrontendEvidence, readPinnedSecurityValidation } from './incremental-windows-verification.mjs';
import { FRONTEND_TRANSITION } from './frontend-verification-inputs.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const git = (root, args) => execFileSync('git', ['-c', 'core.autocrlf=false', '-c', `safe.directory=${root.replaceAll('\\', '/')}`, '-C', root, ...args], { windowsHide: true, maxBuffer: 96 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
export function reviewedNativeReaderBytes(root, review) {
  const reviewed = [...new Map(Object.values(review.readers).flat().map(entry => [entry.path, entry])).values()];
  const modes = new Map(git(root, ['ls-tree', '-r', '-z', 'HEAD', '--', ...reviewed.map(entry => entry.path)]).toString('utf8').split('\0').filter(Boolean).map(row => {
    const [metadata, filename] = row.split('\t'), [mode, type] = metadata.split(' ');
    assert.equal(type, 'blob'); return [filename, mode];
  }));
  return reviewed.map(entry => {
    assert.equal(modes.get(entry.path), entry.mode, `reviewed fixture reader mode changed: ${entry.path}`);
    const bytes = git(root, ['show', `HEAD:${entry.path}`]);
    assert.equal(sha(bytes), entry.sha256, `reviewed fixture reader hash changed: ${entry.path}`);
    return { path: entry.path, mode: entry.mode, sha256: entry.sha256, bytes };
  });
}
// Disposable plans declare an empty compiler environment. The caller's build
// remap belongs to another source root and must never enter these fixtures.
async function withFixtureCompilerEnvironment(action, environment = process.env) {
  const compilerFlag = name => ['RUSTFLAGS', 'CARGO_ENCODED_RUSTFLAGS'].includes(name.toUpperCase());
  const previous = Object.entries(environment).filter(([name]) => compilerFlag(name));
  const clear = () => { for (const name of Object.keys(environment)) if (compilerFlag(name)) delete environment[name]; };
  clear();
  try { return await action(); }
  finally { clear(); for (const [name, value] of previous) environment[name] = value; }
}
export async function runNativeVerificationInputTests() {
  // A plain map can represent case aliases even on Windows, where process.env
  // itself is case-insensitive. Check both success and failure restoration.
  for (const fails of [false, true]) {
    const environment = { RUSTFLAGS: 'caller', RustFlags: 'alias', cargo_encoded_rustflags: 'caller-remap', PATH: 'unchanged' };
    const previous = { ...environment };
    const action = () => withFixtureCompilerEnvironment(async () => {
      assert.deepEqual(environment, { PATH: 'unchanged' });
      environment.Cargo_Encoded_RustFlags = 'fixture-remap';
      if (fails) throw new Error('fixture failure');
      return 'fixture success';
    }, environment);
    if (fails) await assert.rejects(action, /fixture failure/);
    else assert.equal(await action(), 'fixture success');
    assert.deepEqual(environment, previous, 'compiler flags and case aliases must be restored');
  }
  const previous = { ...process.env };
  try { return await withFixtureCompilerEnvironment(runIsolatedNativeVerificationInputTests); }
  finally { assert.deepEqual({ ...process.env }, previous, 'fixture integration must restore the caller environment'); }
}
async function runIsolatedNativeVerificationInputTests() {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    console.log('Native input Windows x64 integration: skipped on unsupported host; existing portable contracts continue');
    return;
  }
  const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), 'kaigen-native-inputs-')));
  let mappedDrive;
  const subst = path.join(process.env.SystemRoot, 'System32', 'subst.exe');
  const root = path.join(temporary, 'source'), evidence = path.join(temporary, 'evidence');
  const save = async (filename, bytes) => { await mkdir(path.dirname(filename), { recursive: true }); await writeFile(filename, bytes); };
  const commit = () => {
    git(root, ['add', '.']);
    git(root, ['-c', 'user.name=Native input fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'disposable native input fixture']);
    return { commit: git(root, ['rev-parse', 'HEAD']).toString().trim(), tree: git(root, ['rev-parse', 'HEAD^{tree}']).toString().trim() };
  };
  const checks = ['native:prepared-cache', 'native:retry-cap', 'native:offline-friend-request', 'rust:all'];
  const canonical = (source, id = 'rust:all', environment = {}, variant) => canonicalNativeInputs(createNativeInputContext({ root, source, environment }), { id, ...(variant ? { variant } : {}) }, descriptor(id, new Set(), variant));
  const pin = async (name, value) => { const bytes = Buffer.from(JSON.stringify(value)), filename = path.join(evidence, name); await save(filename, bytes); return { path: filename, sha256: sha(bytes) }; };
  try {
    await mkdir(root); await mkdir(evidence); git(root, ['init', '--quiet']);
    const review = JSON.parse(await readFile(new URL('native-verification-input-review.json', import.meta.url), 'utf8'));
    const readers = reviewedNativeReaderBytes(sourceRoot, review);
    // Copy only task-bound immutable audited readers into a fresh fixture. No
    // history, object borrowing, working-tree mutation or product execution.
    for (const reader of readers) await save(path.join(root, reader.path), reader.bytes);
    for (const filename of ['scripts/native-verification-inputs.mjs', 'scripts/native-verification-input-review.json', 'scripts/incremental-windows-verification.mjs', 'scripts/imported-rust-execution.mjs', 'scripts/frontend-verification-inputs.mjs']) {
      await save(path.join(root, filename), await readFile(path.join(sourceRoot, filename)));
    }
    const data = ['src-tauri/icons/fixture.bin', 'runtime/native-fixture.dll', 'scripts/fixtures/web-background-transfer-contract.json'];
    for (const filename of data) await save(path.join(root, filename), Buffer.from(`native data ${filename}\n`));
    for (const filename of ['src/Settings.tsx', 'src/Settings.ui-ids.json', 'src/i18n.tsx']) await save(path.join(root, filename), 'original UI\n');
    const packageBytes = Buffer.from('{"scripts":{"test:frontend":"npm run test:fixture"}}\n');
    await save(path.join(root, 'package.json'), packageBytes);
    const first = commit();
    assert.throws(() => git(root, ['cat-file', '-e', `${NATIVE_INPUT_REVIEW}^{commit}`]), /git/, 'materialized source fixture must lack the historical audit object');
    assert.deepEqual(reviewedNativeReaderBytes(root, review), readers, 'the test bootstrap must also work from an anchor-free source HEAD');
    const initial = new Map(checks.map(id => [id, canonical(first, id)]));
    for (const filename of ['src/Settings.tsx', 'src/Settings.ui-ids.json', 'src/i18n.tsx']) await save(path.join(root, filename), 'changed UI\n');
    const ui = commit(); assert.notEqual(ui.commit, first.commit);
    for (const id of checks) assert.deepEqual(canonical(ui, id), initial.get(id), `${id}: UI changes must not affect source policy/inputs`);
    const rustInputs = initial.get('rust:all').inputs;
    assert(rustInputs.every(input => input.lines === undefined && /^native-source:100(?:644|755):/u.test(input.id)));
    assert(!JSON.stringify(initial.get('rust:all').policy).includes(first.commit), 'candidate whole-source identity cannot enter narrow policy');

    const baselinePin = await pin('baseline.json', { legacy: true });
    const externalPin = await pin('source-provenance.json', { legacySnapshot: true });
    const legacy = { schemaVersion: 1, kind: 'kaigen-windows-incremental-plan', source: ui, productSource: ui,
      baseline: { source: first, evidence: [baselinePin] }, testOnlyPaths: [], changes: trackedChanges(root, first.commit, ui.commit).map(change => ({ ...change, reason: 'Disposable UI-only diff', checkIds: ['frontend:fixture'] })), checks: checks.map(id => ({ id, action: 'reuse', reason: 'Disposable migration fixture', evidence: { path: 'legacy.json', sha256: 'a'.repeat(64) },
        inputs: [{ id: 'UI', kind: 'git', path: 'src/Settings.tsx', sha256: sha(Buffer.from('changed UI\n')) }, { id: 'immutable-provenance', kind: 'file', ...externalPin }] })) };
    legacy.checks.push({ id: 'frontend:fixture', action: 'run', reason: 'Disposable frontend coverage', inputs: [{ id: 'package', kind: 'git', path: 'package.json', sha256: sha(packageBytes) }] });
    const legacyBytes = Buffer.from(JSON.stringify(legacy));
    const migrated = await produceNativeInputPlan({ root, plan: legacy, environment: {} });
    assert.equal(JSON.stringify(legacy), legacyBytes.toString(), 'producer must not mutate the old plan');
    assert.deepEqual(migrated.baseline, legacy.baseline, 'migration must retain original baseline/provenance');
    for (const check of migrated.checks.slice(0, 4)) {
      assert.equal(check.action, 'run'); assert(!Object.hasOwn(check, 'evidence'));
      assert.deepEqual(check.inputs.at(-1), legacy.checks.find(item => item.id === check.id).inputs.at(-1));
      validateNativeInputCheck(createNativeInputContext({ root, source: ui, environment: {} }), check, descriptor(check.id, new Set()));
    }
    const compatible = structuredClone(migrated); compatible.checks[0].action = 'reuse'; compatible.checks[0].evidence = legacy.checks[0].evidence;
    assert.deepEqual(await produceNativeInputPlan({ root, plan: compatible, environment: {} }), compatible, 'compatible policy keeps explicit reuse disposition');
    const rebound = structuredClone(compatible); rebound.checks[0].inputs.at(-1).sha256 = '0'.repeat(64);
    const reboundPlan = await produceNativeInputPlan({ root, plan: rebound, environment: {} });
    assert.equal(reboundPlan.checks[0].action, 'run'); assert(!Object.hasOwn(reboundPlan.checks[0], 'evidence'));
    const candidate = migrated.checks[0], command = descriptor(candidate.id, new Set());
    const result = { kind: 'kaigen-incremental-check-result', nativeInputPolicy: candidate.nativeInputPolicy, command: { program: command.program, args: command.args } };
    validateNativeInputResult(candidate, result, command);
    assertNativeInputDeclaration(candidate); assertNativeResultDeclaration(candidate, result);
    assert.throws(() => assertNativeResultDeclaration({ ...candidate, nativeInputPolicy: undefined }, result), /cannot downgrade/);
    assert.throws(() => assertNativeInputDeclaration({ ...candidate, nativeInputPolicy: undefined }), /reserved policy input IDs/);
    for (const forged of [{ ...result, nativeInputPolicy: undefined }, { ...result, kind: 'kaigen-imported-rust-execution' }, { ...result, variant: 'web-core' }, { ...result, command: { ...result.command, args: [...command.args, '-Skip'] } }, { ...result, nativeInputPolicy: { ...result.nativeInputPolicy, producerSha256: '0'.repeat(64) } }]) {
      assert.throws(() => validateNativeInputResult(candidate, forged, command), /Native inputs/);
    }
    for (const inputs of [candidate.inputs.slice(1), [...candidate.inputs, candidate.inputs[0]], candidate.inputs.map((input, index) => index ? input : { ...input, sha256: '0'.repeat(64) }), candidate.inputs.map((input, index) => index ? input : { ...input, id: input.id.replace('100644', '100755') })]) {
      assert.throws(() => validateNativeInputCheck(createNativeInputContext({ root, source: ui, environment: {} }), { ...candidate, inputs }, command), /canonical source inputs/);
    }
    const planPin = await pin('migrated.json', migrated);
    await validatePlan({ planPath: planPin.path, planSha256: planPin.sha256, projectRoot: root });
    const rustCheck = migrated.checks.find(check => check.id === 'rust:all'), rustCommand = descriptor(rustCheck.id, new Set());
    const rustOutput = Buffer.from('test fixture::pass ... ok\ntest result: ok. 1 passed; 0 failed; 0 filtered out;\n'), rustOutputPath = path.join(evidence, 'original-rust-output.log');
    await writeFile(rustOutputPath, rustOutput);
    const rustResult = { schemaVersion: 1, kind: 'kaigen-incremental-check-result', checkId: rustCheck.id, status: 'PASS', source: first,
      inputs: rustCheck.inputs, nativeInputPolicy: rustCheck.nativeInputPolicy, command: { program: rustCommand.program, args: rustCommand.args }, exitCode: 0,
      output: { path: rustOutputPath, sha256: sha(rustOutput) }, startedAt: '2026-10-01T10:00:00Z', completedAt: '2026-10-01T10:01:00Z' };
    const rustResultPin = await pin('original-rust-result.json', rustResult), reusable = structuredClone(migrated);
    reusable.checks.find(check => check.id === 'rust:all').action = 'reuse'; reusable.checks.find(check => check.id === 'rust:all').evidence = rustResultPin;
    const reusablePin = await pin('reusable-rust-plan.json', reusable);
    await validatePlan({ planPath: reusablePin.path, planSha256: reusablePin.sha256, projectRoot: root });
    assert.deepEqual(JSON.parse(await readFile(rustResultPin.path, 'utf8')), rustResult, 'UI-only reuse must preserve original result timestamps/inputs/source');
    const invalidResults = [
      { ...rustResult, nativeInputPolicy: undefined }, { ...rustResult, variant: 'web-core' },
      { ...rustResult, nativeInputPolicy: { ...rustResult.nativeInputPolicy, producerSha256: '0'.repeat(64) } },
      { ...rustResult, command: { ...rustResult.command, args: [...rustResult.command.args, '--features', 'custom-protocol'] } },
      { ...rustResult, inputs: rustResult.inputs.map((input, index) => index === 0 ? { ...input, sha256: '0'.repeat(64) } : input) },
      { ...rustResult, inputs: rustResult.inputs.map(input => input.kind === 'file' ? { ...input, sha256: '0'.repeat(64) } : input) },
    ];
    for (const [index, invalidResult] of invalidResults.entries()) {
      const resultPin = await pin(`invalid-rust-result-${index}.json`, invalidResult), invalidPlan = structuredClone(reusable);
      invalidPlan.checks.find(check => check.id === 'rust:all').evidence = resultPin;
      const invalidPin = await pin(`invalid-rust-plan-${index}.json`, invalidPlan);
      await assert.rejects(() => validatePlan({ planPath: invalidPin.path, planSha256: invalidPin.sha256, projectRoot: root }), /Native inputs|input identity changed|file hash changed/);
    }
    const downgrade = structuredClone(reusable); delete downgrade.checks.find(check => check.id === 'rust:all').nativeInputPolicy;
    const downgradePin = await pin('downgrade-plan.json', downgrade);
    await assert.rejects(() => validatePlan({ planPath: downgradePin.path, planSha256: downgradePin.sha256, projectRoot: root }), /reserved policy input IDs/);
    const forgedPlan = structuredClone(migrated); forgedPlan.checks[0].inputs.shift(); const forgedPin = await pin('forged.json', forgedPlan);
    await assert.rejects(() => validatePlan({ planPath: forgedPin.path, planSha256: forgedPin.sha256, projectRoot: root }), /canonical source inputs/);
    const cliPlan = path.join(evidence, 'legacy-plan.json'), cliOutput = path.join(evidence, 'new-plan.json');
    await writeFile(cliPlan, legacyBytes);
    const cli = ['scripts/native-verification-inputs.mjs', 'produce', '--root', root, '--plan', cliPlan, '--plan-sha256', sha(legacyBytes), '--output', cliOutput];
    execFileSync(process.execPath, cli, { cwd: root, windowsHide: true, stdio: 'pipe' });
    assert.deepEqual(JSON.parse(await readFile(cliOutput, 'utf8')), migrated);
    assert.deepEqual(await readFile(cliPlan), legacyBytes); assert.deepEqual(await readFile(baselinePin.path), Buffer.from(JSON.stringify({ legacy: true })));
    assert.throws(() => execFileSync(process.execPath, cli, { cwd: root, windowsHide: true, stdio: 'pipe' }), /Command failed/, 'CLI must never overwrite an existing output');
    assert.throws(() => execFileSync(process.execPath, cli.map(value => value === sha(legacyBytes) ? '0'.repeat(64) : value), { cwd: root, windowsHide: true, stdio: 'pipe' }), /input plan hash changed/);
    const otherDirectory = path.join(evidence, 'other'); await mkdir(otherDirectory);
    assert.throws(() => execFileSync(process.execPath, cli.map(value => value === cliOutput ? path.join(otherDirectory, 'new-plan.json') : value), { cwd: root, windowsHide: true, stdio: 'pipe' }), /same canonical directory/);

    const remap = `--remap-path-prefix=${root}=C:\\KaigenRepro\\source\u001f--remap-path-prefix=${os.userInfo().homedir}=C:\\KaigenRepro\\user`;
    assert.deepEqual(canonical(ui, 'rust:all', { CARGO_ENCODED_RUSTFLAGS: remap }), initial.get('rust:all'));
    for (const letter of 'ZYXWVUTSRQPONM') {
      try { await lstat(`${letter}:\\`); } catch (error) { if (error.code !== 'ENOENT') throw error; mappedDrive = `${letter}:`; break; }
    }
    assert(mappedDrive, 'a free drive is required for disposable native policy SUBST coverage');
    execFileSync(subst, [mappedDrive, temporary], { windowsHide: true, stdio: 'pipe' });
    const alias = `${mappedDrive}\\source`, aliasRemap = remap.replace(root, alias);
    assert.deepEqual(canonicalNativeInputs(createNativeInputContext({ root, source: ui, executionRoot: alias, environment: { CARGO_ENCODED_RUSTFLAGS: aliasRemap } }), { id: 'rust:all' }, descriptor('rust:all', new Set())), initial.get('rust:all'));
    const previousRemap = process.env.CARGO_ENCODED_RUSTFLAGS;
    try {
      process.env.CARGO_ENCODED_RUSTFLAGS = aliasRemap;
      await validatePlan({ planPath: reusablePin.path, planSha256: reusablePin.sha256, projectRoot: alias, referenceRoot: root });
    } finally {
      if (previousRemap === undefined) delete process.env.CARGO_ENCODED_RUSTFLAGS; else process.env.CARGO_ENCODED_RUSTFLAGS = previousRemap;
      execFileSync(subst, [mappedDrive, '/D'], { windowsHide: true, stdio: 'pipe' }); mappedDrive = undefined;
    }
    for (const environment of [{ TAURI_CONFIG: '{"build":{"devUrl":null}}' }, { TAURI_CONFIG_FILE: 'external.json' }, { CARGO_HOME: 'elsewhere' }, { CARGO_BUILD_TARGET: 'other' }, { RUSTFLAGS: '-C opt-level=3' }, { CARGO_ENCODED_RUSTFLAGS: remap + '\u001f-Ctarget-feature=+crt-static' }, { CARGO_ENCODED_RUSTFLAGS: remap.replace(root, os.tmpdir()) }, { cargo_encoded_rustflags: remap.replace(root, os.tmpdir()) }, { CARGO_ENCODED_RUSTFLAGS: remap + '\u001f-C\u001ftarget-feature=+crt-static' }, { RustFlags: '-C opt-level=3' }, { CC: 'external-compiler' }, { CC_x86_64_pc_windows_msvc: 'external' }, { HOST_CFLAGS: '-include outside.h' }, { REMOVE_UNUSED_COMMANDS: 'outside' }, { KAIGEN_QTOX_IMPORT_RUNTIME_ROOT: 'outside' }]) {
      assert.throws(() => canonical(ui, 'rust:all', environment), /unreviewed environment override/);
    }
    const localCargo = path.join(root, '.cargo', 'config.toml'); await save(localCargo, '[build]\ntarget="different"\n');
    assert.throws(() => canonical(ui), /effective Cargo configuration/); await rm(path.dirname(localCargo), { recursive: true });
    const ancestorCargo = path.join(temporary, '.cargo', 'config'); await save(ancestorCargo, '[build]\n');
    assert.throws(() => canonical(ui), /effective Cargo configuration/); await rm(path.dirname(ancestorCargo), { recursive: true });
    const ancestorToolchain = path.join(temporary, 'rust-toolchain.toml'); await save(ancestorToolchain, '[toolchain]\nchannel="nightly"\n');
    assert.throws(() => canonical(ui), /effective Cargo configuration/); await rm(ancestorToolchain);
    const exclude = path.join(root, '.git', 'info', 'exclude'), originalExclude = await readFile(exclude);
    const ignoredDiscoveries = ['src-tauri/tauri.windows.conf.json', 'src-tauri/TAURI.WINDOWS.CONF.JSON', 'src-tauri/capabilities/ignored.json', 'src-tauri/permissions/ignored.toml', 'vendor/mlkem-native-2.0.0/mlkem/src/ignored.c'];
    await save(exclude, Buffer.concat([originalExclude, Buffer.from('\n' + ignoredDiscoveries.join('\n') + '\n')]));
    for (const filename of ignoredDiscoveries) {
      await save(path.join(root, filename), '#include "../../../../outside.h"\n');
      assert.equal(git(root, ['status', '--porcelain=v1', '--untracked-files=all']).toString().trim(), '', 'ignored discovery must bypass ordinary Git status in this regression');
      assert.throws(() => canonical(ui), /physical dependency discovery membership/);
      await rm(path.join(root, filename));
    }
    await save(exclude, originalExclude);

    for (const filename of data) {
      const original = await readFile(path.join(root, filename)); await save(path.join(root, filename), Buffer.concat([original, Buffer.from('changed\n')])); const changed = commit();
      assert.notDeepEqual(canonical(changed).inputs, rustInputs, `${filename}: native data changes invalidate inputs`);
      await save(path.join(root, filename), original); commit();
    }
    await save(path.join(root, 'runtime/added.dll'), 'added dependency'); const added = commit(); assert.notDeepEqual(canonical(added).inputs, rustInputs);
    await rm(path.join(root, 'runtime/added.dll')); const deleted = commit(); assert.deepEqual(canonical(deleted).inputs, rustInputs);
    for (const filename of ['src-tauri/new_reader.rs', 'src-tauri/tauri.windows.conf.json', 'rust-toolchain.toml', 'Cargo.toml', 'vendor/mlkem-native-2.0.0/mlkem/new_reader.h']) {
      await save(path.join(root, filename), 'unreviewed recipe\n'); const changed = commit();
      assert.throws(() => canonical(changed), filename === 'rust-toolchain.toml' ? /effective Cargo configuration/ : /unreviewed dependency-reader/);
      await rm(path.join(root, filename)); commit();
    }
    for (const filename of ['src-tauri/src/lib.rs', 'src-tauri/build.rs', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock', 'scripts/build-portable.ps1', 'scripts/test-toxcore-retry-cap.ps1', 'vendor/mlkem-native-2.0.0/mlkem/src/common.h']) {
      const original = await readFile(path.join(root, filename)); await save(path.join(root, filename), Buffer.concat([original, Buffer.from('\n#include "../../../../outside.h"\n')])); const changed = commit();
      assert.throws(() => canonical(changed, filename.includes('retry-cap') ? 'native:retry-cap' : 'rust:all'), /unreviewed dependency-reader/);
      await save(path.join(root, filename), original); commit();
    }
    const policyFile = path.join(root, 'scripts/native-verification-inputs.mjs'), originalPolicy = await readFile(policyFile);
    await save(policyFile, Buffer.concat([originalPolicy, Buffer.from('\n// policy revision\n')])); const revised = commit();
    assert.throws(() => canonical(revised), /running producer\/validator differs/);
    const wrongProducerPin = await pin('wrong-producer-plan.json', { ...legacy, source: revised, productSource: revised });
    assert.throws(() => execFileSync(process.execPath, [path.join(sourceRoot, 'scripts/native-verification-inputs.mjs'), 'produce', '--root', root, '--plan', wrongProducerPin.path, '--plan-sha256', wrongProducerPin.sha256, '--output', path.join(evidence, 'wrong-producer-output.json')], { cwd: root, windowsHide: true, stdio: 'pipe' }), /running producer\/validator differs/);
    await save(policyFile, originalPolicy); commit();
    const validatorFile = path.join(root, 'scripts/incremental-windows-verification.mjs'), originalValidator = await readFile(validatorFile);
    await save(validatorFile, Buffer.concat([originalValidator, Buffer.from('\n// validator revision\n')])); const wrongValidator = commit();
    assert.throws(() => canonical(wrongValidator), /running producer\/validator differs/);
    const wrongValidatorPin = await pin('wrong-validator-plan.json', { ...legacy, source: wrongValidator, productSource: wrongValidator });
    assert.throws(() => execFileSync(process.execPath, [path.join(sourceRoot, 'scripts/native-verification-inputs.mjs'), 'produce', '--root', root, '--plan', wrongValidatorPin.path, '--plan-sha256', wrongValidatorPin.sha256, '--output', path.join(evidence, 'wrong-validator-output.json')], { cwd: root, windowsHide: true, stdio: 'pipe' }), /running producer\/validator differs/);
    await save(validatorFile, originalValidator); commit();
    const unsafePath = 'runtime/symlink.dll'; git(root, ['update-index', '--add', '--cacheinfo', `120000,${git(root, ['rev-parse', 'HEAD:runtime/native-fixture.dll']).toString().trim()},${unsafePath}`]);
    git(root, ['-c', 'user.name=Native input fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'unsafe disposable input mode']);
    const unsafe = { commit: git(root, ['rev-parse', 'HEAD']).toString().trim(), tree: git(root, ['rev-parse', 'HEAD^{tree}']).toString().trim() };
    assert.throws(() => canonical(unsafe), /unsafe or missing input/);
    console.log('Native input policy: UI independence, source-only review, exact membership/hash/mode, legacy fresh migration, policy/result/command guards, external bindings, remap/config/env rejection and write-once CLI passed');
  } finally {
    if (mappedDrive) execFileSync(subst, [mappedDrive, '/D'], { windowsHide: true, stdio: 'pipe' });
    assert.equal(path.dirname(temporary), await realpath(os.tmpdir())); assert(path.basename(temporary).startsWith('kaigen-native-inputs-'));
    await rm(temporary, { recursive: true, force: true });
  }
}
export async function runLegacyNativeReuseTests() {
  const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), 'kaigen-native-reuse-'))), root = path.join(temporary, 'source');
  const save = async (filename, value) => { await mkdir(path.dirname(filename), { recursive: true }); await writeFile(filename, value); };
  const commit = () => {
    git(root, ['add', '.']); git(root, ['-c', 'user.name=Native reuse fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'disposable reuse fixture']);
    return { commit: git(root, ['rev-parse', 'HEAD']).toString().trim(), tree: git(root, ['rev-parse', 'HEAD^{tree}']).toString().trim() };
  };
  try {
    await mkdir(root); git(root, ['init', '--quiet']);
    const reviewBytes = await readFile(new URL('native-verification-input-review.json', import.meta.url));
    for (const reader of reviewedNativeReaderBytes(sourceRoot, JSON.parse(reviewBytes))) await save(path.join(root, reader.path), reader.bytes);
    await save(path.join(root, 'scripts/native-verification-input-review.json'), reviewBytes);
    await save(path.join(root, 'scripts/fixtures/web-background-transfer-contract.json'), '{}\n');
    await save(path.join(root, 'runtime/fixture.dll'), 'unchanged runtime\n');
    await save(path.join(root, 'src/App.tsx'), 'old UI\n');
    const previous = commit();
    await save(path.join(root, 'src/App.tsx'), 'new UI\n');
    await save(path.join(root, 'package-lock.json'), 'changed bundler dependency\n');
    await save(path.join(root, 'scripts/incremental-windows-verification.mjs'), 'changed validation only\n');
    const current = commit();
    const ids = ['native:prepared-cache', 'native:retry-cap', 'native:offline-friend-request', 'rust:all'];
    for (const id of ids) assert.deepEqual(legacyNativeClosure(root, previous, { id }, descriptor(id, new Set())), legacyNativeClosure(root, current, { id }, descriptor(id, new Set())));
    const check = { id: 'rust:all', action: 'reuse' }, { program, args } = descriptor(check.id, new Set()), command = { program, args };
    const result = { source: previous, command, inputs: [{ id: 'old broad UI', kind: 'git', path: 'src/App.tsx', sha256: sha(Buffer.from('old UI\n')) }],
      output: { sha256: 'a'.repeat(64) }, startedAt: '2026-10-06T01:00:00Z', completedAt: '2026-10-06T01:01:00Z' };
    const resultPin = { path: 'original-result.json', sha256: sha(Buffer.from(JSON.stringify(result))) }, archive = 'b'.repeat(64);
    const cache = { schemaVersion: 2, policy: 'verified-prepared-native-v2', platform: 'windows-x64', applicationRebuilt: true, applicationSha256: archive,
      groups: ['c-toxcore', 'libsodium', 'tor-universal'].map(group => ({ group, cacheDisposition: 'hit', physicalCacheDisposition: 'hit', producerInvoked: false,
        status: 'active', patchSetManifestSha256: 'none', tombstoneIds: [], fingerprint: 'c'.repeat(64), outputManifestSha256: 'd'.repeat(64), outputs: [{ path: group + '/fixture.bin', size: 1, sha256: 'e'.repeat(64) }] })) };
    const docs = new Map(), pin = value => { const bytes = Buffer.from(JSON.stringify(value)), sha256 = sha(bytes); docs.set(sha256, bytes); return { path: sha256 + '.json', sha256 }; };
    const verification = { kind: 'kaigen-windows-incremental-verification', status: 'PASS', fullBaselineRerun: false, source: previous,
      checks: [{ id: check.id, disposition: 'rerun', result: resultPin }], archive: { sha256: archive } };
    const verificationPin = pin(verification);
    const native = { schemaVersion: 2, status: 'PASS', validationProfile: 'incremental', transactionId: 'fixture', archive: { sha256: archive },
      incremental: { verification: { receiptSha256: verificationPin.sha256 }, result: verification } };
    const nativePin = pin(native), worker = { documentType: 'kaigen-windows-finish-worker-result', status: 'PASS', transactionId: 'fixture', nativeReceipt: nativePin, archive: { sha256: archive } };
    const proof = { schemaVersion: 1, kind: 'kaigen-legacy-native-reuse', source: previous, candidateSource: current, checkId: check.id, result: resultPin,
      external: { native: nativePin, worker: pin(worker), verification: verificationPin, previousCache: pin(cache), currentCache: pin({ ...cache, applicationRebuilt: false, applicationSha256: null }) } };
    const read = async reference => { const bytes = docs.get(reference.sha256); assert(bytes && sha(bytes) === reference.sha256); return { bytes }; };
    const options = { root, source: current, check, command, result, resultPin, proof, read }, original = JSON.stringify(result);
    const validated = await validateLegacyNativeReuse(options);
    assert.equal(JSON.stringify(result), original, 'original result/input hashes must remain unchanged');
    const exported = { ...validated, archiveSha256: archive, finalCacheSha256: 'f'.repeat(64) };
    assertNativeReuseExport(exported, { source: current, artifactSha256: archive, referenceRoot: root });
    const coverage = { validatorSha256: '1'.repeat(64), validatorProofSha256: '2'.repeat(64), nativeReuse: [exported],
      plan: { sha256: '3'.repeat(64), source: current, checks: [{ id: check.id, action: 'reuse', inputsSha256: '4'.repeat(64) }] },
      receipt: { sha256: '5'.repeat(64), kind: 'kaigen-windows-incremental-verification', status: 'PASS', source: current, planSha256: '3'.repeat(64), archiveSha256: archive,
        fullBaselineRerun: false, checks: [{ id: check.id, status: 'PASS', disposition: 'reused', source: previous, inputsSha256: exported.originalInputsSha256, resultSha256: resultPin.sha256 }] } };
    const coverageOptions = { source: current, artifactSha256: archive, expectedChecks: [{ id: check.id, action: 'run', inputsSha256: '4'.repeat(64) }], validatorSha256: coverage.validatorSha256, referenceRoot: root };
    assertLocalFullCoverage(coverage, coverageOptions);
    assert.throws(() => assertLocalFullCoverage({ ...coverage, nativeReuse: [] }, coverageOptions), /local full plan/);
    for (const mutated of [
      { ...options, check: { ...check, variant: 'web-core' } },
      { ...options, result: { ...result, command: { program: 'cargo', args: ['test'] } } },
      { ...options, resultPin: { ...resultPin, sha256: '6'.repeat(64) } },
      { ...options, proof: { ...proof, external: { ...proof.external, worker: pin({ ...worker, nativeReceipt: { sha256: '7'.repeat(64) } }) } } },
      { ...options, proof: { ...proof, external: { ...proof.external, currentCache: pin({ ...cache, groups: cache.groups.slice(1) }) } } },
      { ...options, proof: { ...proof, external: { ...proof.external, currentCache: pin({ ...cache, groups: cache.groups.map((group, index) => index ? group : { ...group, fingerprint: '8'.repeat(64) }) }) } } },
      { ...options, proof: { ...proof, external: { ...proof.external, currentCache: pin({ ...cache, groups: cache.groups.map((group, index) => index ? group : { ...group, cacheDisposition: 'miss' }) }) } } },
      { ...options, proof: { ...proof, external: { ...proof.external, currentCache: pin(cache) } } },
    ]) await assert.rejects(validateLegacyNativeReuse(mutated), /Native inputs:/);
    assert.throws(() => assertNativeReuseExport({ ...exported, archiveSha256: '9'.repeat(64) }, { source: current, artifactSha256: archive, referenceRoot: root }), /another new archive/);
    assert.throws(() => assertNativeReuseExport({ ...exported, closure: { ...exported.closure, inputsSha256: '0'.repeat(64) } }, { source: current, artifactSha256: archive, referenceRoot: root }), /declared native closure/);
    const webCheck = { id: 'rust:all', variant: 'web-core' };
    const webClosure = legacyNativeClosure(root, current, webCheck, descriptor(webCheck.id, new Set(), webCheck.variant));
    assert.throws(() => assertNativeReuseExport({ ...exported, closure: webClosure }, { source: current, artifactSha256: archive, referenceRoot: root }), /desktop variant/);
    const owner = path.join(temporary, 'owner'), evidenceFile = path.join(owner, 'outputs', 'original.json');
    await save(evidenceFile, 'original evidence');
    const ownedContext = { projectOwnerRoot: owner }, evidencePin = { path: evidenceFile, sha256: sha(Buffer.from('original evidence')) };
    assert.equal((await readOwnedLegacyEvidence(ownedContext, evidencePin, owner)).bytes.toString(), 'original evidence');
    const outside = path.join(temporary, 'outside', 'original.json'); await save(outside, 'original evidence');
    await assert.rejects(readOwnedLegacyEvidence(ownedContext, { ...evidencePin, path: outside }, owner), /escapes its owner/);
    await assert.rejects(readOwnedLegacyEvidence(ownedContext, { ...evidencePin, path: '../../outside/original.json' }, path.join(owner, 'outputs')), /escapes its owner/);
    const linked = path.join(owner, 'outputs', 'linked');
    await symlink(path.dirname(outside), linked, process.platform === 'win32' ? 'junction' : 'dir');
    try { await assert.rejects(readOwnedLegacyEvidence(ownedContext, { ...evidencePin, path: path.join(linked, 'original.json') }, owner), /not ordinary|resolves elsewhere/); }
    finally { await rm(linked); }
    await assert.rejects(readOwnedLegacyEvidence({}, evidencePin, owner), /owner root/);
    await save(path.join(root, 'runtime/fixture.dll'), 'changed runtime\n'); const changed = commit();
    await assert.rejects(validateLegacyNativeReuse({ ...options, source: changed, proof: { ...proof, candidateSource: changed } }), /source closure changed/);
    assert.throws(() => legacyNativeClosure(root, current, { id: 'frontend:fixture' }, command), /limited to native/);
    console.log('Legacy native reuse focused validation: 4 closures, retained originals, current cache hits, independent publisher, coverage and 18 rejection cases passed; no product tests executed');
  } finally {
    assert.equal(path.dirname(temporary), await realpath(os.tmpdir())); assert(path.basename(temporary).startsWith('kaigen-native-reuse-'));
    await rm(temporary, { recursive: true, force: true });
  }
}
export async function runRetainedFrontendIntegrationTests() {
  const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), 'kaigen-frontend-evidence-'))), owner = path.join(temporary, 'owner'), base = path.join(owner, 'outputs');
  try {
    await mkdir(base, { recursive: true });
    const current = { commit: git(sourceRoot, ['rev-parse', 'HEAD']).toString().trim(), tree: git(sourceRoot, ['rev-parse', 'HEAD^{tree}']).toString().trim() };
    const id = 'frontend:chat-file-batch', command = { program: 'npm.cmd', args: ['run', 'test:chat-file-batch'] };
    const result = { schemaVersion: 1, kind: 'kaigen-incremental-check-result', checkId: id, status: 'PASS', source: FRONTEND_TRANSITION.before,
      inputs: [{ id: 'original broad input', kind: 'git', path: 'src/App.tsx', sha256: 'a'.repeat(64) }], command, exitCode: 0,
      output: { path: 'original.log', sha256: 'b'.repeat(64) }, startedAt: '2026-10-06T01:00:00Z', completedAt: '2026-10-06T01:01:00Z' };
    const originalBytes = Buffer.from(JSON.stringify(result)), resultPin = { path: path.join(base, 'original.json'), sha256: sha(originalBytes) };
    await writeFile(resultPin.path, originalBytes);
    const proof = { schemaVersion: 1, kind: 'kaigen-reviewed-frontend-reuse', checkId: id, source: result.source, candidateSource: current,
      result: resultPin, securityValidationSha256: FRONTEND_TRANSITION.securityValidationSha256 };
    const saveProof = async (name, value, folder = base) => { const bytes = Buffer.from(JSON.stringify(value)), filename = path.join(folder, name); await writeFile(filename, bytes); return { path: filename, sha256: sha(bytes) }; };
    const pin = await saveProof('migration.json', proof);
    const provider = process.env.KAIGEN_SECURITY_EVIDENCE_ROOT;
    assert(provider, 'focused integration requires the separately approved task security provider binding');
    const context = { projectOwnerRoot: owner, referenceRoot: sourceRoot, root: sourceRoot, planBase: base, plan: { source: current, securityEvidenceRoot: provider },
      securityEvidenceRoot: provider, npmScripts: new Set(['test:chat-file-batch']) };
    const check = { id, action: 'reuse', retainedFrontendReuse: pin };
    const exported = await validateRetainedFrontendEvidence(context, check, result, resultPin);
    assert.deepEqual(await readFile(resultPin.path), originalBytes, 'original stored receipt bytes must remain unchanged');
    assertFrontendReuseExport(exported, { source: current, referenceRoot: sourceRoot });
    const coverage = { validatorSha256: '1'.repeat(64), validatorProofSha256: '2'.repeat(64), frontendReuse: [exported],
      plan: { sha256: '3'.repeat(64), source: current, checks: [{ id, action: 'reuse', inputsSha256: '4'.repeat(64) }] },
      receipt: { sha256: '5'.repeat(64), kind: 'kaigen-windows-incremental-verification', status: 'PASS', source: current, planSha256: '3'.repeat(64), archiveSha256: '6'.repeat(64),
        fullBaselineRerun: false, checks: [{ id, status: 'PASS', disposition: 'reused', source: result.source, inputsSha256: exported.originalInputsSha256, resultSha256: resultPin.sha256 }] } };
    const coverageOptions = { source: current, artifactSha256: '6'.repeat(64), expectedChecks: [{ id, action: 'run', inputsSha256: '4'.repeat(64) }], validatorSha256: coverage.validatorSha256, referenceRoot: sourceRoot };
    assertLocalFullCoverage(coverage, coverageOptions);
    assert.throws(() => assertLocalFullCoverage({ ...coverage, frontendReuse: [] }, coverageOptions), /local full plan/);
    assert.throws(() => assertFrontendReuseExport({ ...exported, readersSha256: '0'.repeat(64) }, { source: current, referenceRoot: sourceRoot }), /publisher frontend projection differs/);
    const outside = await saveProof('outside.json', proof, temporary);
    await assert.rejects(validateRetainedFrontendEvidence(context, { ...check, retainedFrontendReuse: outside }, result, resultPin), /escapes its owner evidence roots/);
    await assert.rejects(validateRetainedFrontendEvidence(context, { ...check, action: 'run' }, result, resultPin), /original frontend result/);
    await assert.rejects(validateRetainedFrontendEvidence(context, check, { ...result, status: 'FAIL' }, resultPin), /not PASS/);
    await assert.rejects(validateRetainedFrontendEvidence(context, check, { ...result, command: { ...command, args: ['run', 'test:frontend'] } }, resultPin), /original command/);
    await assert.rejects(validateRetainedFrontendEvidence(context, check, result, { ...resultPin, sha256: '0'.repeat(64) }), /proof identities changed/);
    await assert.rejects(readPinnedSecurityValidation({ ...context, plan: { ...context.plan, securityEvidenceRoot: temporary } }), /separately approved root/);
    await assert.rejects(readPinnedSecurityValidation({ ...context, securityEvidenceRoot: undefined }), /approved Codex Security artifact provider root/);
    await writeFile(path.join(temporary, 'report_validation.md'), 'not the validated security report');
    await assert.rejects(readPinnedSecurityValidation({ plan: { securityEvidenceRoot: temporary }, securityEvidenceRoot: temporary }), /report bytes changed/);
    console.log('Retained frontend integration focused validation PASS: actual task-bound security report bytes, owner-safe proof, unchanged original bytes, independent publisher and 10 rejection cases; no product suites executed');
  } finally {
    assert.equal(path.dirname(temporary), await realpath(os.tmpdir())); assert(path.basename(temporary).startsWith('kaigen-frontend-evidence-'));
    await rm(temporary, { recursive: true, force: true });
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--frontend-reuse-only')) await runRetainedFrontendIntegrationTests();
  else if (process.argv.includes('--legacy-reuse-only')) await runLegacyNativeReuseTests();
  else { await runNativeVerificationInputTests(); await runLegacyNativeReuseTests(); }
}
