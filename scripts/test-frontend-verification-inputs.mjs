import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { FRONTEND_TRANSITION, projectReviewedFrontendBytes, compareReviewedFrontendInventories, reviewedFrontendSourceCompatibility, reviewedFrontendVariant } from './frontend-verification-inputs.mjs';

export function runFrontendVerificationInputTests() {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const git = (...args) => execFileSync('git', ['-c', `safe.directory=${root.replaceAll('\\', '/')}`, '-C', root, ...args], { windowsHide: true, maxBuffer: 96 * 1024 * 1024 });
  const bytes = (source, filename) => git('show', source.commit + ':' + filename);
  const current = { commit: git('rev-parse', 'HEAD').toString().trim(), tree: git('rev-parse', 'HEAD^{tree}').toString().trim() };
  for (const filename of ['src/App.tsx', 'src/fileReceiveSettings.ts', 'package-lock.json']) {
    const before = bytes(FRONTEND_TRANSITION.before, filename), after = bytes(FRONTEND_TRANSITION.product, filename);
    projectReviewedFrontendBytes(filename, before, after);
    assert.throws(() => projectReviewedFrontendBytes(filename, before, Buffer.concat([after, Buffer.from('\n// unknown delta\n')])), /unreviewed frontend source bytes/);
    assert.throws(() => projectReviewedFrontendBytes(filename, Buffer.concat([before, Buffer.from('\n')]), after), /unreviewed frontend source bytes/);
  }
  const options = name => ({ root, source: current, originalSource: FRONTEND_TRANSITION.before, checkId: 'frontend:' + name,
    command: { program: 'npm.cmd', args: ['run', 'test:' + name] }, securityValidationSha256: FRONTEND_TRANSITION.securityValidationSha256 });
  const variant = { ...options('localization'), command: { program: 'npm.cmd', args: ['run', 'test:localization', '--', '--no-qtox'] } };
  const preserved = reviewedFrontendSourceCompatibility(variant);
  assert.deepEqual(preserved.command, variant.command);
  assert(reviewedFrontendVariant('frontend:localization', 'no-qtox'));
  assert(!reviewedFrontendVariant('frontend:localization', 'runtime'));
  assert(!reviewedFrontendVariant('frontend:chat-file-batch', 'no-qtox'));
  assert.throws(() => reviewedFrontendSourceCompatibility({ ...options('chat-file-batch'), command: { program: 'npm.cmd', args: ['run', 'test:chat-file-batch', '--', '--no-qtox'] } }), /variant is outside/);
  if (process.argv.includes('--variant-only')) { console.log('Frontend original no-qtox variant preserved; wrong variants rejected; no suites executed'); return; }
  // Run the compatibility validators only. These never launch the named suites,
  // compile an App fixture or start a browser/native application.
  for (const name of ['chat-file-batch', 'chat-geometry-runtime', 'component-inventory', 'source-hygiene', 'web-content-security']) {
    const result = reviewedFrontendSourceCompatibility(options(name));
    assert.equal(result.checkId, 'frontend:' + name); assert.deepEqual(result.source, FRONTEND_TRANSITION.before);
    assert.equal(result.projections.length, 3); assert.equal(result.securityValidationSha256, FRONTEND_TRANSITION.securityValidationSha256);
    assert.equal(result.sourceClosureSha256, '92f42679f07703864ef65e052817a54ff630117e833400f561ec6e5eb712645a', 'saved frontend closure changed');
  }
  for (const name of ['registration', 'file-receive-settings', 'current-verification-contract', 'build-pipeline', 'unknown-suite']) {
    assert.throws(() => reviewedFrontendSourceCompatibility(options(name)), /lacks a reviewed reuse recipe/);
  }
  assert.throws(() => reviewedFrontendSourceCompatibility({ ...options('chat-file-batch'), command: { program: 'npm.cmd', args: ['run', 'test:frontend'] } }), /exact command changed/);
  assert.throws(() => reviewedFrontendSourceCompatibility({ ...options('chat-file-batch'), securityValidationSha256: '0'.repeat(64) }), /security validation binding missing/);
  assert.throws(() => reviewedFrontendSourceCompatibility({ ...options('chat-file-batch'), originalSource: current }), /outside the reviewed transition/);
  assert.throws(() => reviewedFrontendSourceCompatibility({ ...options('chat-file-batch'), source: { ...current, tree: FRONTEND_TRANSITION.before.tree } }), /source tree changed/);
  const before = [{ path: 'src/fixture.ts', mode: '100644', blob: '1'.repeat(40) }];
  for (const after of [
    [{ ...before[0], blob: '2'.repeat(40) }], [], [...before, { path: 'src/new.ts', mode: '100644', blob: '2'.repeat(40) }],
    [{ ...before[0], mode: '120000' }], [{ ...before[0], mode: '100755' }],
  ]) assert.throws(() => compareReviewedFrontendInventories(before, after, 'verification-transition'));
  assert.throws(() => compareReviewedFrontendInventories(before, before, ['src/fixture.ts']), /unreviewed inventory comparison mode/);
  const handoffBefore = { path: 'scripts/test-windows-ci-handoff.mjs', mode: '100644', blob: '67261e3896a5b53f47e8f3c3bbd0632b1affbe25' };
  const handoffAfter = { ...handoffBefore, blob: 'd69b84ce9c4e19f3c4e5d2962c9ef32ad4bc78a1' };
  compareReviewedFrontendInventories([handoffBefore], [handoffAfter], 'verification-transition');
  assert.throws(() => compareReviewedFrontendInventories([handoffBefore], [handoffAfter], 'product-transition'));
  for (const [old, next] of [
    [[], [handoffAfter]], [[handoffBefore], []], [[handoffAfter], [handoffBefore]],
    [[{ ...handoffBefore, blob: '0'.repeat(40) }], [handoffAfter]],
    [[handoffBefore], [{ ...handoffAfter, blob: '0'.repeat(40) }]],
    [[handoffBefore], [{ ...handoffAfter, mode: '100755' }]], [[handoffBefore], [{ ...handoffAfter, mode: '120000' }]],
    [[{ ...handoffBefore, path: 'scripts/test-windows-ci-handoff-other.mjs' }], [{ ...handoffAfter, path: 'scripts/test-windows-ci-handoff-other.mjs' }]],
    [[{ ...handoffBefore, path: 'scripts/windows-ci-handoff.mjs' }], [{ ...handoffAfter, path: 'scripts/windows-ci-handoff.mjs' }]],
  ]) assert.throws(() => compareReviewedFrontendInventories(old, next, 'verification-transition'));
  assert.throws(() => projectReviewedFrontendBytes('src/other.ts', Buffer.alloc(0), Buffer.alloc(0)), /unsupported frontend projection/);
  console.log('Frontend reuse projection focused validation passed: exact App/helper/security-lock transition, 5 source compatibility cases with preserved closure and 32 rejection cases; no product/UI/functional suites executed');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runFrontendVerificationInputTests();
