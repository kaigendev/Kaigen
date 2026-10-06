import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { FRONTEND_TRANSITION, projectReviewedFrontendBytes, compareReviewedFrontendInventories, reviewedFrontendSourceCompatibility } from './frontend-verification-inputs.mjs';

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
  // Run the compatibility validators only. These never launch the named suites,
  // compile an App fixture or start a browser/native application.
  for (const name of ['chat-file-batch', 'chat-geometry-runtime', 'component-inventory', 'source-hygiene', 'web-content-security']) {
    const result = reviewedFrontendSourceCompatibility(options(name));
    assert.equal(result.checkId, 'frontend:' + name); assert.deepEqual(result.source, FRONTEND_TRANSITION.before);
    assert.equal(result.projections.length, 3); assert.equal(result.securityValidationSha256, FRONTEND_TRANSITION.securityValidationSha256);
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
  assert.throws(() => projectReviewedFrontendBytes('src/other.ts', Buffer.alloc(0), Buffer.alloc(0)), /unsupported frontend projection/);
  console.log('Frontend reuse projection focused validation passed: exact App/helper/security-lock transition, 5 source compatibility cases and 22 rejection cases; no product/UI/functional suites executed');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runFrontendVerificationInputTests();
