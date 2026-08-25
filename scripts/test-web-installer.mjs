import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const installer = path.join(root, 'web', 'installer', 'install-kaigen-web.sh');
const configSource = await readFile(path.join(root, 'web', 'kaigen-webd', 'src', 'config.rs'), 'utf8');
const stateSource = await readFile(path.join(root, 'web', 'kaigen-webd', 'src', 'state.rs'), 'utf8');
const webRootSource = await readFile(path.join(root, 'src', 'web', 'WebRoot.tsx'), 'utf8');
const installerSource = await readFile(installer, 'utf8');

const bash = process.platform === 'win32'
  ? 'C:\\Program Files\\Git\\bin\\bash.exe'
  : '/bin/bash';
assert.equal(existsSync(bash), true, `Bash runner is missing: ${bash}`);

function posixPath(value) {
  if (process.platform !== 'win32') return value;
  const normalized = path.resolve(value).replaceAll('\\', '/');
  return `/${normalized[0].toLowerCase()}${normalized.slice(2)}`;
}

function runBash(args, environment = {}) {
  const result = spawnSync(bash, args, {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, MSYS2_ARG_CONV_EXCL: '*', ...environment },
    timeout: 120000,
  });
  assert.equal(result.status, 0, `${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

runBash(['-n', posixPath(installer)]);
assert.match(installerSource, /Personal: exactly one workspace/);
assert.match(installerSource, /Service: multiple workspaces/);
assert.match(installerSource, /noswap,nodev,nosuid,noexec/);
assert.match(installerSource, /LimitMEMLOCK=infinity/);
assert.match(installerSource, /CapabilityBoundingSet=CAP_IPC_LOCK/);
assert.match(installerSource, /proxy_set_header Upgrade/);
assert.match(installerSource, /http2 on;/);
assert.doesNotMatch(installerSource, /listen .*http2/);
assert.match(installerSource, /drain_deadline/);
assert.match(installerSource, /ROLLBACK_PASS/);
assert.match(installerSource, /\/healthz/);
assert.match(installerSource, /\/readyz/);
assert.doesNotMatch(installerSource, /\/api\/v1\/health/);
assert.match(installerSource, /payload\/lib\/Kaigen\/libtoxcore\.so\.2\.23\.0/);
assert.match(installerSource, /\$\{KAIGEN_RELEASE_ROOT\}\/bin\/kaigen-webd/);
assert.match(installerSource, /chmod 0755 -- "\$INSTALL_DIR" "\$RELEASES_DIR"/);
assert.match(installerSource, /chmod 0755 -- "\$target"/);
assert.match(installerSource, /chmod 0750 -- "\$target\/bin" "\$target\/lib" "\$target\/lib\/Kaigen"/);
assert.match(installerSource, /Type ERASE to remove all Kaigen Web workspace data/);
assert.doesNotMatch(installerSource, /apt-get|apachectl|a2en/);
assert.match(configSource, /DeploymentMode::Personal => None/);
assert.match(configSource, /return Ok\(personal_limits\(\)\)/);
assert.match(stateSource, /PERSONAL_MODE_REQUIRES_AT_MOST_ONE_WORKSPACE/);
assert.match(webRootSource, /quotaBytes == null \? "∞"/);

const temp = await mkdtemp(path.join(root, '.tmp-web-installer-'));

async function createRoot(name) {
  const target = path.join(temp, name);
  await mkdir(path.join(target, 'etc', 'ssl', 'certs'), { recursive: true });
  await mkdir(path.join(target, 'etc', 'ssl', 'private'), { recursive: true });
  await writeFile(path.join(target, 'etc', 'os-release'), 'ID=debian\nVERSION_ID=13\n', 'utf8');
  await writeFile(path.join(target, 'etc', 'ssl', 'certs', 'kaigen-test.pem'), 'test-certificate\n', 'utf8');
  await writeFile(path.join(target, 'etc', 'ssl', 'private', 'kaigen-test.key'), 'test-key\n', 'utf8');
  return target;
}

async function listFiles(directory, base = directory) {
  const values = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) values.push(...await listFiles(full, base));
    else values.push(path.relative(base, full).replaceAll('\\', '/'));
  }
  return values.sort();
}

async function createBundle(releaseId) {
  const bundle = path.join(temp, `bundle-${releaseId}`);
  await mkdir(path.join(bundle, 'payload', 'bin'), { recursive: true });
  await mkdir(path.join(bundle, 'payload', 'lib', 'Kaigen'), { recursive: true });
  await mkdir(path.join(bundle, 'payload', 'ui', 'assets'), { recursive: true });
  await writeFile(path.join(bundle, 'release-id'), `${releaseId}\n`, 'utf8');
  await writeFile(path.join(bundle, 'payload', 'bin', 'kaigen-webd'), '#!/bin/sh\nexit 0\n', 'utf8');
  await chmod(path.join(bundle, 'payload', 'bin', 'kaigen-webd'), 0o755);
  await writeFile(path.join(bundle, 'payload', 'lib', 'Kaigen', 'libtoxcore.so.2.23.0'), 'test-toxcore-runtime\n', 'utf8');
  await writeFile(path.join(bundle, 'payload', 'ui', 'index.html'), '<!doctype html><title>Kaigen Web</title>\n', 'utf8');
  await writeFile(path.join(bundle, 'payload', 'ui', 'assets', 'index-test.js'), 'globalThis.kaigen=true;\n', 'utf8');
  const files = await listFiles(bundle);
  const lines = [];
  for (const relative of files) {
    const bytes = await readFile(path.join(bundle, ...relative.split('/')));
    lines.push(`${createHash('sha256').update(bytes).digest('hex')}  ${relative}`);
  }
  await writeFile(path.join(bundle, 'manifest.sha256'), `${lines.join('\n')}\n`, 'utf8');
  return bundle;
}

function installEnvironment(installRoot, mode) {
  return {
    KAIGEN_INSTALL_ROOT: posixPath(installRoot),
    KAIGEN_INSTALL_TEST: '1',
    KAIGEN_INSTALL_MODE: mode,
    KAIGEN_INSTALL_HOSTNAME: 'kaigen.test',
    KAIGEN_INSTALL_TLS_CERT: '/etc/ssl/certs/kaigen-test.pem',
    KAIGEN_INSTALL_TLS_KEY: '/etc/ssl/private/kaigen-test.key',
  };
}

try {
  const firstBundle = await createBundle('installer-test-r1');
  const secondBundle = await createBundle('installer-test-r2');
  const personalRoot = await createRoot('personal-root');
  const personalEnv = installEnvironment(personalRoot, 'personal');
  assert.match(runBash([
    posixPath(installer), 'install', '--bundle', posixPath(firstBundle), '--non-interactive',
  ], personalEnv), /INSTALL_PASS mode=personal/);
  const personalSlot = await readFile(path.join(personalRoot, 'etc', 'kaigen-webd', 'slots', 'a.env'), 'utf8');
  assert.match(personalSlot, /KAIGEN_WEB_DEPLOYMENT_MODE=personal/);
  assert.match(personalSlot, /LD_LIBRARY_PATH=\/opt\/kaigen-webd\/releases\/installer-test-r1\/lib\/Kaigen/);
  assert.doesNotMatch(personalSlot, /QUOTA|MAX_INSTANCES/);
  assert.equal(existsSync(path.join(personalRoot, 'etc', 'systemd', 'system', 'kaigen-webd@.service.d', 'limits.conf')), false);
  assert.equal(existsSync(path.join(personalRoot, 'opt', 'kaigen-webd', 'releases', 'installer-test-r1', 'bin', 'kaigen-webd')), true);
  assert.equal(existsSync(path.join(personalRoot, 'opt', 'kaigen-webd', 'releases', 'installer-test-r1', 'lib', 'Kaigen', 'libtoxcore.so.2')), true);

  assert.match(runBash([
    posixPath(installer), 'update', '--bundle', posixPath(secondBundle), '--non-interactive',
  ], personalEnv), /UPDATE_PASS release=installer-test-r2 slot=b/);
  let state = await readFile(path.join(personalRoot, 'var', 'lib', 'kaigen-webd', 'installer-state'), 'utf8');
  assert.match(state, /ACTIVE_SLOT=b/);
  assert.match(state, /CURRENT_RELEASE=installer-test-r2/);
  assert.match(state, /PREVIOUS_RELEASE=installer-test-r1/);

  assert.match(runBash([posixPath(installer), 'rollback', '--non-interactive'], personalEnv), /ROLLBACK_PASS release=installer-test-r1 slot=a/);
  state = await readFile(path.join(personalRoot, 'var', 'lib', 'kaigen-webd', 'installer-state'), 'utf8');
  assert.match(state, /CURRENT_RELEASE=installer-test-r1/);
  assert.match(runBash([posixPath(installer), 'uninstall', '--non-interactive'], {
    ...personalEnv,
    KAIGEN_UNINSTALL_ERASE_DATA: 'no',
  }), /UNINSTALL_PASS dataPreserved=true/);
  assert.equal(existsSync(path.join(personalRoot, 'var', 'lib', 'kaigen-webd')), true);
  assert.equal(existsSync(path.join(personalRoot, 'opt', 'kaigen-webd')), false);

  const serviceRoot = await createRoot('service-root');
  const serviceEnv = installEnvironment(serviceRoot, 'service');
  assert.match(runBash([
    posixPath(installer), 'install', '--bundle', posixPath(firstBundle), '--non-interactive',
  ], serviceEnv), /INSTALL_PASS mode=service/);
  const serviceSlot = await readFile(path.join(serviceRoot, 'etc', 'kaigen-webd', 'slots', 'a.env'), 'utf8');
  assert.match(serviceSlot, /KAIGEN_WEB_DISK_QUOTA_BYTES=268435456/);
  assert.match(serviceSlot, /KAIGEN_WEB_MAX_INSTANCES=8/);
  const limits = await readFile(path.join(serviceRoot, 'etc', 'systemd', 'system', 'kaigen-webd@.service.d', 'limits.conf'), 'utf8');
  assert.match(limits, /MemoryMax=4G/);
  assert.match(limits, /TasksMax=256/);

  process.stdout.write('WEB_INSTALLER_TEST_PASS modes=2 update=true rollback=true safeUninstall=true\n');
} finally {
  await rm(temp, { recursive: true, force: true });
}
