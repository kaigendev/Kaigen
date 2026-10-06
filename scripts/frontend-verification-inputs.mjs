import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
import path from 'node:path';

// Reviewed immutable product transition. This is deliberately bounded: a new
// product delta needs a new review, never a caller's declaration of no impact.
export const FRONTEND_TRANSITION = Object.freeze({
  before: Object.freeze({ commit: '0b5d06b47ae417930c6a7d9d0bfebea1e54c49d3', tree: 'c8c551662f3b1fa617ae2784dfe52f2138e5a2e5' }),
  product: Object.freeze({ commit: '6a4a9917386faeb83d5a856da9caa7e68b95c01c', tree: 'd5f963779827649f6755be84a71867aaed6ddeea' }),
  securityValidationSha256: '96f6ce4a7d5d220829b9ab1fa3b26f29f3f62ff1f7fa0b5db65ab534a76a1871',
});
const HASH = /^[a-f0-9]{40}$/u;
const sha = value => createHash('sha256').update(value).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const EXCLUDED = new Set(['registration', 'file-receive-settings', 'current-verification-contract', 'build-pipeline']);
const REVIEWED = new Set(('extended-native-contract notification-sound product-fixes3-ui chat-navigation chat-geometry-runtime chat-enhancements pq-entropy chat-view-state chat-notifications chat-notification-queue chat-reaction-notices background-transfers transfer-preview-registry chat-file-batch desktop-file-routing app-layout ui-identity ui-interaction-state theme-system profile-switcher contact-identity contact-list-order friend-resilience outgoing-message-state localization status-message component-inventory source-hygiene product-boundaries vite-config prepared-native-cache platform-runtime browser-runtime web-transfer-pump web-renderer-contract web-content-security resource-bounds web-installer source-archive-privacy').split(' '));
// These have independent verification/CI review. A frontend test that imports
// one of them is refused below. Product/runtime files are never in this set.
const VERIFICATION = new Set([
  'ci/verification-current.json', 'ci/verification-v0.2.9.9.json',
  'ci/test-entrypoints.json',
  'scripts/native-verification-inputs.mjs', 'scripts/test-native-verification-inputs.mjs',
  'scripts/incremental-windows-verification.mjs', 'scripts/publish-release.mjs', 'scripts/test-publish-release.mjs',
  'scripts/test-current-verification-contract.mjs', 'scripts/ci-incremental-verification.mjs',
  'scripts/frontend-verification-inputs.mjs', 'scripts/test-frontend-verification-inputs.mjs',
  ...['design.md', 'proposal.md', 'tasks.md', 'specs/release-publication/spec.md'].map(name => 'openspec/changes/release-v0-2-9-9/' + name),
]);
const PRODUCT_CHANGES = new Set(['src/App.tsx', 'src/fileReceiveSettings.ts', 'package-lock.json', 'scripts/test-file-receive-settings.mjs']);
const PINS = {
  'src/App.tsx': ['82a36a4b91843071535650b4e94149f608f420211811ea847a130be115b06948', 'fa89f1bd52cfdf7fb62402a9d55b53e40c6552a3127a1376ad4d3abdef946858'],
  'src/fileReceiveSettings.ts': ['8af6663a8128e0ee5893b248ae5a9eb1ec818ad3b44740dab042c9a5ab605a85', 'd165016e43a03d841be246ced87800d25eb6f16448cfba6a0c5f607e2f8d3b69'],
  'package-lock.json': ['2b0af45909bac24f751cdcb9c2d8a891999752d99f7ef5efc6350725eba8e920', '3cd915900f4cea7461d568f688aa45ac84ccf5dea18c048ab0683f6ccfc938c5'],
};
function once(source, needle, replacement) {
  assert.equal(source.split(needle).length, 2, 'reviewed projection token must occur exactly once');
  return source.replace(needle, replacement);
}
export function projectReviewedFrontendBytes(filename, before, after) {
  assert.ok(Object.hasOwn(PINS, filename), 'unsupported frontend projection');
  assert.deepEqual([sha(before), sha(after)], PINS[filename], 'unreviewed frontend source bytes');
  let projected = after.toString('utf8');
  if (filename === 'src/App.tsx') {
    projected = once(projected, '  canAcceptIncomingFile,\n', '');
    projected = once(projected, '    if (action === "resume" && !message.mine\n      && message.attachment?.transferState === "awaiting_confirmation"\n      && !canAcceptIncomingFile(message.mine, message.attachment)) return;\n', '');
    projected = once(projected, ' disabled={!canAcceptIncomingFile(message.mine, message.attachment)}', '');
    assert.equal(projected, before.toString('utf8'), 'App delta exceeds the reviewed incoming-Accept transition');
  } else if (filename === 'src/fileReceiveSettings.ts') {
    projected = once(projected, '/** A metadata card precedes the native offer and cannot be resumed yet. */\nexport function canAcceptIncomingFile(\n  mine: boolean | undefined,\n  attachment: { path?: string; transferState?: string } | undefined,\n): boolean {\n  const path = attachment?.path;\n  return !mine\n    && attachment?.transferState === "awaiting_confirmation"\n    && typeof path === "string"\n    && path.trim().length > 0\n    && !path.startsWith("pending-file-card://");\n}\n\n', '');
    assert.equal(projected, before.toString('utf8'), 'existing receive-settings exports or top-level effects changed');
  } else {
    const old = JSON.parse(before), current = JSON.parse(after), oldPackage = old.packages['node_modules/source-map-js'], currentPackage = current.packages['node_modules/source-map-js'];
    assert.deepEqual([oldPackage.version, oldPackage.resolved, oldPackage.integrity], ['1.2.1', 'https://registry.npmjs.org/source-map-js/-/source-map-js-1.2.1.tgz', 'sha512-UXWMKhLOwVKb728IUtQPXxfYU+usdybtUrK/8uGE8CQMvrhOpwvzDBwj0QhSL7MQc7vIsISBG8VQ8+IDQxpfQA==']);
    assert.deepEqual([currentPackage.version, currentPackage.resolved, currentPackage.integrity], ['1.2.2', 'https://registry.npmjs.org/source-map-js/-/source-map-js-1.2.2.tgz', 'sha512-KGj/8Y43x35aZVDtt+J4mK1hoLGHULMYfSkODJNQjNDC3oW1PqPoxMwo0pLUsWM/UEGzON/NxeHywEfNXNP3Vw==']);
    for (const name of ['version', 'resolved', 'integrity']) currentPackage[name] = oldPackage[name];
    assert.deepEqual(current, old, 'lock graph changed beyond the verified source-map security patch');
  }
  return { path: filename, beforeSha256: PINS[filename][0], afterSha256: PINS[filename][1] };
}
function git(root, args) {
  return execFileSync('git', ['-c', `safe.directory=${root.replaceAll('\\', '/')}`, '-C', root, ...args], { windowsHide: true, maxBuffer: 96 * 1024 * 1024 });
}
function sourceTree(root, source) {
  assert.ok(source && HASH.test(source.commit) && HASH.test(source.tree), 'immutable frontend source identity required');
  assert.equal(git(root, ['rev-parse', `${source.commit}^{commit}`]).toString().trim(), source.commit);
  assert.equal(git(root, ['rev-parse', `${source.commit}^{tree}`]).toString().trim(), source.tree, 'frontend source tree changed');
  return git(root, ['ls-tree', '-r', '-z', source.commit]).toString('utf8').split('\0').filter(Boolean).map(row => {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t([^\0]+)$/u.exec(row);
    assert.ok(match, 'frontend inventory contains a nonordinary mode or entry');
    const filename = match[3];
    assert.ok(!filename.includes('\\') && !filename.includes(':') && filename.split('/').every(part => part && part !== '.' && part !== '..'), 'unsafe frontend source path');
    return { path: filename, mode: match[1], blob: match[2] };
  }).sort((a, b) => compare(a.path, b.path));
}
export function compareReviewedFrontendInventories(previous, current, allowedChanges) {
  // The public comparator accepts no allowlist: only internal reviewed modes.
  assert.ok(allowedChanges === 'product-transition' || allowedChanges === 'verification-transition', 'unreviewed inventory comparison mode');
  const before = new Map(previous.map(entry => [entry.path, entry])), after = new Map(current.map(entry => [entry.path, entry]));
  assert.equal(before.size, previous.length); assert.equal(after.size, current.length);
  for (const filename of new Set([...before.keys(), ...after.keys()])) {
    const old = before.get(filename), next = after.get(filename);
    assert.ok(!old || ['100644', '100755'].includes(old.mode)); assert.ok(!next || ['100644', '100755'].includes(next.mode));
    if (same(old, next)) continue;
    assert.ok(VERIFICATION.has(filename) || (allowedChanges === 'product-transition' && PRODUCT_CHANGES.has(filename)), 'unreviewed frontend inventory delta: ' + filename);
    assert.ok(!old || !next || old.mode === next.mode, 'frontend mode changed: ' + filename);
    if (PRODUCT_CHANGES.has(filename)) assert.ok(old && next, 'reviewed product membership changed');
  }
}
function importedReaders(root, source, entry, inventory) {
  const seen = new Set(), visit = filename => {
    assert.ok(!VERIFICATION.has(filename) && filename !== 'scripts/test-file-receive-settings.mjs', 'frontend reader reaches changed verification or receive-settings suite: ' + filename);
    if (seen.has(filename)) return; seen.add(filename);
    assert.ok(inventory.some(item => item.path === filename), 'frontend imported reader missing: ' + filename);
    const text = git(root, ['show', `${source.commit}:${filename}`]).toString('utf8');
    for (const match of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)["'](\.[^"']+\.mjs)["']/gu)) {
      const dependency = path.posix.normalize(path.posix.join(path.posix.dirname(filename), match[1]));
      assert.ok(!dependency.startsWith('../'), 'frontend import escapes source'); visit(dependency);
    }
  };
  visit(entry); return [...seen].sort().map(filename => inventory.find(item => item.path === filename));
}
export function reviewedFrontendSourceCompatibility({ root, source, originalSource, checkId, command, securityValidationSha256, executionRoot = root }) {
  const name = checkId?.replace(/^frontend:/u, '');
  assert.ok(checkId === 'frontend:' + name && REVIEWED.has(name) && !EXCLUDED.has(name), 'frontend suite lacks a reviewed reuse recipe');
  assert.deepEqual(originalSource, FRONTEND_TRANSITION.before, 'frontend original is outside the reviewed transition');
  assert.equal(securityValidationSha256, FRONTEND_TRANSITION.securityValidationSha256, 'source-map security validation binding missing');
  const before = sourceTree(root, originalSource), product = sourceTree(root, FRONTEND_TRANSITION.product), current = sourceTree(root, source);
  compareReviewedFrontendInventories(before, product, 'product-transition');
  compareReviewedFrontendInventories(product, current, 'verification-transition');
  const projections = Object.keys(PINS).map(filename => projectReviewedFrontendBytes(filename,
    git(root, ['show', `${originalSource.commit}:${filename}`]), git(root, ['show', `${source.commit}:${filename}`])));
  const packageBefore = JSON.parse(git(root, ['show', `${originalSource.commit}:package.json`])), packageCurrent = JSON.parse(git(root, ['show', `${source.commit}:package.json`]));
  assert.deepEqual(packageCurrent, packageBefore, 'frontend command or package configuration changed');
  const script = packageBefore.scripts['test:' + name], match = /^node (scripts\/[A-Za-z0-9-]+\.mjs)$/u.exec(script ?? '');
  assert.ok(match, 'unsupported frontend test entrypoint');
  assert.deepEqual(command, { program: 'npm.cmd', args: ['run', 'test:' + name] }, 'frontend exact command changed');
  const oldReaders = importedReaders(root, originalSource, match[1], before), currentReaders = importedReaders(root, source, match[1], current);
  assert.deepEqual(currentReaders, oldReaders, 'frontend test/import reader bytes or membership changed');
  if (name === 'source-hygiene') for (const legacy of ['security', 'security-v3']) {
    try { lstatSync(path.join(executionRoot, 'patches', 'c-toxcore', legacy)); assert.fail('legacy c-toxcore discovery path is present: ' + legacy); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const closure = before.filter(entry => !VERIFICATION.has(entry.path) && entry.path !== 'scripts/test-file-receive-settings.mjs');
  return { schemaVersion: 1, kind: 'kaigen-reviewed-frontend-reuse', checkId, source: originalSource, candidateSource: source,
    reviewedProductSource: FRONTEND_TRANSITION.product, command, projections, securityValidationSha256,
    sourceClosureSha256: sha(JSON.stringify(closure)), readersSha256: sha(JSON.stringify(oldReaders)) };
}
