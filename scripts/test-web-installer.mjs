import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
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
assert.equal([...installerSource.matchAll(/proxy_set_header X-Real-IP \\\$remote_addr;/gu)].length, 2);
assert.match(installerSource, /systemctl enable --now "kaigen-webd@\$slot\.service"/u);
assert.match(installerSource, /systemctl disable --now "kaigen-webd@\$old_slot\.service"/u);
assert.doesNotMatch(installerSource, /systemctl restart "kaigen-webd@\$slot\.service"/u);
const activateReleaseSource = installerSource.match(/^activate_release\(\) \{[\s\S]*?^\}/mu)?.[0] ?? '';
const activationOrder = [
  'write_slot_env "$slot" "$release_id" "$port"',
  'start_candidate_backend "$slot" "$release_id"',
  'wait_for_candidate_backend "$slot" "$port"',
  'commit_release_routes "$slot" "$release_id" "$port"',
].map((needle) => activateReleaseSource.indexOf(needle));
assert.ok(activationOrder.every((position) => position >= 0), 'activation contains prepare, explicit start, health, and route commit phases');
assert.deepEqual([...activationOrder].sort((left, right) => left - right), activationOrder, 'inactive explicit release starts and passes health checks before route commit');
assert.ok(activateReleaseSource.indexOf('commit_release_routes ') < activateReleaseSource.indexOf('drain_deadline'), 'route pointer, upstream, and state commit before old-slot drain');
assert.match(installerSource, /readonly ROUTE_SNAPSHOTS_DIR="\$ETC_DIR\/installer-route-snapshots"/u);
assert.match(installerSource, /chown root:root -- "\$DATA_DIR"/u);
assert.doesNotMatch(installerSource, /chown -R [^\n]*\$DATA_DIR/u);
assert.match(installerSource, /validate_active_route_binding/u);
const activeBindingSource = installerSource.match(/^validate_active_route_binding\(\) \{[\s\S]*?^\}/mu)?.[0] ?? '';
const beginTransactionSource = installerSource.match(/^begin_route_transaction\(\) \{[\s\S]*?^\}/mu)?.[0] ?? '';
assert.doesNotMatch(activeBindingSource, /systemctl/u, 'state structure validation must remain usable for stopped-service uninstall');
assert.match(beginTransactionSource, /systemctl is-active/u, 'update and rollback transactions require the recorded active service');
assert.match(installerSource, /add_header Content-Security-Policy .*script-src 'self'.*script-src-attr 'none'.*require-trusted-types-for 'script'.*trusted-types kaigen-spellcheck-worker.* always;/u);
assert.match(installerSource, /add_header Cross-Origin-Opener-Policy "same-origin" always;/u);
assert.match(installerSource, /add_header X-Content-Type-Options "nosniff" always;/u);
assert.match(installerSource, /http2 on;/);
assert.doesNotMatch(installerSource, /listen .*http2/);
assert.match(installerSource, /drain_deadline/);
assert.match(installerSource, /ROLLBACK_PASS/);
assert.match(installerSource, /\/healthz/);
assert.match(installerSource, /\/readyz/);
assert.doesNotMatch(installerSource, /\/api\/v1\/health/);
assert.match(installerSource, /payload\/lib\/Kaigen\/libtoxcore\.so\.2\.23\.0/);
assert.match(installerSource, /payload\/TorExpertBundle\/tor\/pluggable_transports\/lyrebird/);
assert.match(installerSource, /payload\/TorExpertBundle\/tor\/pluggable_transports\/pt_config\.json/);
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

async function createBundle(releaseId, uiBuildId = releaseId) {
  const bundle = path.join(temp, `bundle-${releaseId}`);
  await mkdir(path.join(bundle, 'payload', 'bin'), { recursive: true });
  await mkdir(path.join(bundle, 'payload', 'lib', 'Kaigen'), { recursive: true });
  await mkdir(path.join(bundle, 'payload', 'TorExpertBundle', 'data'), { recursive: true });
  await mkdir(path.join(bundle, 'payload', 'TorExpertBundle', 'tor', 'pluggable_transports'), { recursive: true });
  await mkdir(path.join(bundle, 'payload', 'ui', 'assets'), { recursive: true });
  await writeFile(path.join(bundle, 'release-id'), `${releaseId}\n`, 'utf8');
  await writeFile(path.join(bundle, 'payload', 'bin', 'kaigen-webd'), '#!/bin/sh\nexit 0\n', 'utf8');
  await chmod(path.join(bundle, 'payload', 'bin', 'kaigen-webd'), 0o755);
  await writeFile(path.join(bundle, 'payload', 'lib', 'Kaigen', 'libtoxcore.so.2.23.0'), 'test-toxcore-runtime\n', 'utf8');
  await writeFile(path.join(bundle, 'payload', 'TorExpertBundle', 'data', 'geoip'), 'test-geoip\n', 'utf8');
  await writeFile(path.join(bundle, 'payload', 'TorExpertBundle', 'data', 'geoip6'), 'test-geoip6\n', 'utf8');
  await writeFile(path.join(bundle, 'payload', 'TorExpertBundle', 'tor', 'tor'), '#!/bin/sh\nexit 0\n', 'utf8');
  await writeFile(path.join(bundle, 'payload', 'TorExpertBundle', 'tor', 'pluggable_transports', 'lyrebird'), '#!/bin/sh\nexit 0\n', 'utf8');
  await writeFile(path.join(bundle, 'payload', 'TorExpertBundle', 'tor', 'pluggable_transports', 'conjure-client'), '#!/bin/sh\nexit 0\n', 'utf8');
  await writeFile(path.join(bundle, 'payload', 'TorExpertBundle', 'tor', 'pluggable_transports', 'pt_config.json'), '{"pluggableTransports":{"lyrebird":"ClientTransportPlugin obfs4 exec ${pt_path}lyrebird"}}\n', 'utf8');
  await chmod(path.join(bundle, 'payload', 'TorExpertBundle', 'tor', 'tor'), 0o755);
  await chmod(path.join(bundle, 'payload', 'TorExpertBundle', 'tor', 'pluggable_transports', 'lyrebird'), 0o755);
  await chmod(path.join(bundle, 'payload', 'TorExpertBundle', 'tor', 'pluggable_transports', 'conjure-client'), 0o755);
  await writeFile(path.join(bundle, 'payload', 'ui', 'index.html'), '<!doctype html><title>Kaigen Web</title>\n', 'utf8');
  await writeFile(path.join(bundle, 'payload', 'ui', 'kaigen-build-id'), `${uiBuildId}\n`, 'utf8');
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

async function convertInstalledRouteToLegacy(installRoot, releaseId) {
  const releaseRoot = path.join(installRoot, 'opt', 'kaigen-webd', 'releases', releaseId);
  await rm(path.join(releaseRoot, 'ui', 'kaigen-build-id'));
  const nginxSite = path.join(installRoot, 'etc', 'nginx', 'sites-available', 'kaigen-web');
  const upstream = path.join(installRoot, 'etc', 'nginx', 'kaigen-webd-upstream.conf');
  const serviceUnit = path.join(installRoot, 'etc', 'systemd', 'system', 'kaigen-webd@.service');
  const limitsFile = path.join(installRoot, 'etc', 'systemd', 'system', 'kaigen-webd@.service.d', 'limits.conf');
  const enabledSite = path.join(installRoot, 'etc', 'nginx', 'sites-enabled', 'kaigen-web');
  const stateFile = path.join(installRoot, 'var', 'lib', 'kaigen-webd', 'installer-state');
  await writeFile(nginxSite, `# Managed by Kaigen Web installer.
server {
    include /etc/nginx/kaigen-webd-upstream.conf;
    location /api/ { proxy_pass $kaigen_web_backend; }
    location /ws { proxy_pass $kaigen_web_backend; }
    location / { try_files $uri $uri/ /index.html; }
}
`, 'utf8');
  await writeFile(upstream, `# Managed by Kaigen Web installer.
set $kaigen_web_backend http://127.0.0.1:8787;
`, 'utf8');
  await writeFile(serviceUnit, `${await readFile(serviceUnit, 'utf8')}# legacy-service-unit\n`, 'utf8');
  await writeFile(limitsFile, `${await readFile(limitsFile, 'utf8')}# legacy-service-limits\n`, 'utf8');
  await writeFile(enabledSite, '# Managed by Kaigen Web installer.\n../sites-available/kaigen-web\n# legacy-enabled-route\n', 'utf8');
  await writeFile(stateFile, `# Managed by Kaigen Web installer.
ACTIVE_SLOT=a
CURRENT_RELEASE=${releaseId}
PREVIOUS_RELEASE=installer-test-prelegacy
INSTALL_MODE=service
PREVIOUS_MODE=service
PUBLIC_ORIGIN=https://kaigen.test
HOSTNAME=kaigen.test
TLS_CERT=/etc/ssl/certs/kaigen-test.pem
TLS_KEY=/etc/ssl/private/kaigen-test.key
`, 'utf8');
  await chmod(stateFile, 0o600);
}

async function assertRouteCompatibility(installRoot, releaseId, expectedSchema) {
  const nginxSite = await readFile(path.join(installRoot, 'etc', 'nginx', 'sites-available', 'kaigen-web'), 'utf8');
  const upstream = await readFile(path.join(installRoot, 'etc', 'nginx', 'kaigen-webd-upstream.conf'), 'utf8');
  assert.match(nginxSite, /location \/api\//u, 'active route must retain the API proxy');
  const siteRequiresBuildId = nginxSite.includes('$kaigen_web_build_id');
  const upstreamProvidesBuildId = upstream.includes(`set $kaigen_web_build_id ${releaseId};`);
  if (expectedSchema === 'build-id-v1') {
    assert.equal(siteRequiresBuildId, true, 'build-id route must enforce client identity');
    assert.equal(upstreamProvidesBuildId, true, 'build-id route must define its active identity');
    assert.equal(await readFile(path.join(installRoot, 'opt', 'kaigen-webd', 'releases', releaseId, 'ui', 'kaigen-build-id'), 'utf8'), `${releaseId}\n`);
  } else {
    assert.equal(expectedSchema, 'legacy-v0');
    assert.equal(siteRequiresBuildId, false, 'legacy route must not require an identity its UI cannot send');
    assert.equal(existsSync(path.join(installRoot, 'opt', 'kaigen-webd', 'releases', releaseId, 'ui', 'kaigen-build-id')), false);
  }
}

try {
  const firstBundle = await createBundle('installer-test-r1');
  const secondBundle = await createBundle('installer-test-r2');
  const unhealthyBundle = await createBundle('installer-test-unhealthy');
  const mismatchedBundle = await createBundle('installer-test-r3', 'installer-test-wrong');
  const personalRoot = await createRoot('personal-root');
  const personalEnv = installEnvironment(personalRoot, 'personal');
  assert.match(runBash([
    posixPath(installer), 'install', '--bundle', posixPath(firstBundle), '--non-interactive',
  ], personalEnv), /INSTALL_PASS mode=personal/);
  const personalSlot = await readFile(path.join(personalRoot, 'etc', 'kaigen-webd', 'slots', 'a.env'), 'utf8');
  const personalNginx = await readFile(path.join(personalRoot, 'etc', 'nginx', 'sites-available', 'kaigen-web'), 'utf8');
  assert.match(personalSlot, /KAIGEN_WEB_DEPLOYMENT_MODE=personal/);
  assert.match(personalNginx, /Content-Security-Policy .*default-src 'none'/u);
  assert.match(personalNginx, /Content-Security-Policy .*frame-ancestors 'none'/u);
  assert.match(personalNginx, /Content-Security-Policy .*script-src 'self'.*script-src-attr 'none'/u);
  assert.match(personalNginx, /Cross-Origin-Resource-Policy "same-origin" always;/u);
  assert.match(personalNginx, /location = \/api\/v1\/build-identity/u);
  assert.match(personalNginx, /UPGRADE_REQUIRED/u);
  assert.equal((personalNginx.match(/proxy_set_header X-Real-IP \$remote_addr;/gu) ?? []).length, 2);
  assert.match(personalSlot, /LD_LIBRARY_PATH=\/opt\/kaigen-webd\/releases\/installer-test-r1\/lib\/Kaigen/);
  assert.doesNotMatch(personalSlot, /QUOTA|MAX_INSTANCES/);
  assert.equal(existsSync(path.join(personalRoot, 'etc', 'systemd', 'system', 'kaigen-webd@.service.d', 'limits.conf')), false);
  assert.equal(existsSync(path.join(personalRoot, 'opt', 'kaigen-webd', 'releases', 'installer-test-r1', 'bin', 'kaigen-webd')), true);
  assert.equal(existsSync(path.join(personalRoot, 'opt', 'kaigen-webd', 'releases', 'installer-test-r1', 'lib', 'Kaigen', 'libtoxcore.so.2')), true);
  assert.equal(existsSync(path.join(personalRoot, 'opt', 'kaigen-webd', 'releases', 'installer-test-r1', 'TorExpertBundle', 'tor', 'tor')), true);
  assert.equal(existsSync(path.join(personalRoot, 'opt', 'kaigen-webd', 'releases', 'installer-test-r1', 'TorExpertBundle', 'tor', 'pluggable_transports', 'lyrebird')), true);

  assert.match(runBash([
    posixPath(installer), 'update', '--bundle', posixPath(secondBundle), '--non-interactive',
  ], personalEnv), /UPDATE_PASS release=installer-test-r2 slot=b/);
  let state = await readFile(path.join(personalRoot, 'var', 'lib', 'kaigen-webd', 'installer-state'), 'utf8');
  assert.match(state, /ACTIVE_SLOT=b/);
  assert.match(state, /CURRENT_RELEASE=installer-test-r2/);
  assert.match(state, /PREVIOUS_RELEASE=installer-test-r1/);
  let upstream = await readFile(path.join(personalRoot, 'etc', 'nginx', 'kaigen-webd-upstream.conf'), 'utf8');
  assert.match(upstream, /set \$kaigen_web_build_id installer-test-r2;/u);
  const currentTargetPath = path.join(personalRoot, 'opt', 'kaigen-webd', 'current.test-target');
  const currentTargetBeforeFailure = await readFile(currentTargetPath, 'utf8');
  const stateBeforeFailure = state;
  const upstreamBeforeFailure = upstream;
  assert.throws(() => runBash([
    posixPath(installer), 'update', '--bundle', posixPath(unhealthyBundle), '--non-interactive',
  ], { ...personalEnv, KAIGEN_INSTALL_TEST_CANDIDATE_HEALTH: 'fail' }), /Candidate backend did not become healthy/u);
  assert.equal(await readFile(currentTargetPath, 'utf8'), currentTargetBeforeFailure, 'failed candidate cannot switch the current UI');
  assert.equal(await readFile(path.join(personalRoot, 'etc', 'nginx', 'kaigen-webd-upstream.conf'), 'utf8'), upstreamBeforeFailure, 'failed candidate cannot switch the backend upstream');
  assert.equal(await readFile(path.join(personalRoot, 'var', 'lib', 'kaigen-webd', 'installer-state'), 'utf8'), stateBeforeFailure, 'failed candidate cannot advance installer state');
  assert.throws(() => runBash([
    posixPath(installer), 'update', '--bundle', posixPath(mismatchedBundle), '--non-interactive',
  ], personalEnv), /Bundle UI build identity does not match release-id/u);

  assert.match(runBash([posixPath(installer), 'rollback', '--non-interactive'], personalEnv), /ROLLBACK_PASS release=installer-test-r1 slot=a/);
  state = await readFile(path.join(personalRoot, 'var', 'lib', 'kaigen-webd', 'installer-state'), 'utf8');
  assert.match(state, /CURRENT_RELEASE=installer-test-r1/);
  upstream = await readFile(path.join(personalRoot, 'etc', 'nginx', 'kaigen-webd-upstream.conf'), 'utf8');
  assert.match(upstream, /set \$kaigen_web_build_id installer-test-r1;/u);
  assert.match(runBash([posixPath(installer), 'uninstall', '--non-interactive'], {
    ...personalEnv,
    KAIGEN_UNINSTALL_ERASE_DATA: 'no',
  }), /UNINSTALL_PASS dataPreserved=true/);
  assert.equal(existsSync(path.join(personalRoot, 'var', 'lib', 'kaigen-webd')), true);
  assert.equal(existsSync(path.join(personalRoot, 'opt', 'kaigen-webd')), false);
  assert.equal(existsSync(path.join(personalRoot, 'etc', 'kaigen-webd', 'installer-route-snapshots')), false, 'preserve-data uninstall must remove root-owned route snapshots');

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

  const legacyBundle = await createBundle('installer-test-legacy');
  const legacyRoot = await createRoot('legacy-root');
  const legacyEnv = installEnvironment(legacyRoot, 'service');
  assert.match(runBash([
    posixPath(installer), 'install', '--bundle', posixPath(legacyBundle), '--non-interactive',
  ], legacyEnv), /INSTALL_PASS mode=service/);
  await convertInstalledRouteToLegacy(legacyRoot, 'installer-test-legacy');
  await assertRouteCompatibility(legacyRoot, 'installer-test-legacy', 'legacy-v0');
  assert.throws(() => runBash([
    posixPath(installer), 'rollback', '--non-interactive',
  ], legacyEnv), /Previous release lacks route metadata/u, 'legacy state with a previous release but no route metadata must be readable yet not guessed during rollback');
  const legacyPaths = {
    site: path.join(legacyRoot, 'etc', 'nginx', 'sites-available', 'kaigen-web'),
    upstream: path.join(legacyRoot, 'etc', 'nginx', 'kaigen-webd-upstream.conf'),
    unit: path.join(legacyRoot, 'etc', 'systemd', 'system', 'kaigen-webd@.service'),
    limits: path.join(legacyRoot, 'etc', 'systemd', 'system', 'kaigen-webd@.service.d', 'limits.conf'),
    enabled: path.join(legacyRoot, 'etc', 'nginx', 'sites-enabled', 'kaigen-web'),
    state: path.join(legacyRoot, 'var', 'lib', 'kaigen-webd', 'installer-state'),
    current: path.join(legacyRoot, 'opt', 'kaigen-webd', 'current.test-target'),
  };
  const legacyBeforeFailure = Object.fromEntries(await Promise.all(Object.entries(legacyPaths).map(async ([key, file]) => [key, await readFile(file, 'utf8')])));
  assert.throws(() => runBash([
    posixPath(installer), 'update', '--bundle', posixPath(unhealthyBundle), '--non-interactive',
  ], { ...legacyEnv, KAIGEN_INSTALL_TEST_CANDIDATE_HEALTH: 'fail' }), /Candidate backend did not become healthy/u);
  for (const [key, file] of Object.entries(legacyPaths)) {
    assert.equal(await readFile(file, 'utf8'), legacyBeforeFailure[key], `legacy pre-health failure must restore ${key}`);
  }
  await assertRouteCompatibility(legacyRoot, 'installer-test-legacy', 'legacy-v0');

  assert.throws(() => runBash([
    posixPath(installer), 'update', '--bundle', posixPath(secondBundle), '--non-interactive',
  ], { ...legacyEnv, KAIGEN_INSTALL_TEST_ROUTE_COMMIT: 'fail-before-state' }), /Candidate release routes could not be switched/u);
  for (const [key, file] of Object.entries(legacyPaths)) {
    assert.equal(await readFile(file, 'utf8'), legacyBeforeFailure[key], `failed atomic route/state commit must restore ${key}`);
  }
  await assertRouteCompatibility(legacyRoot, 'installer-test-legacy', 'legacy-v0');

  assert.match(runBash([
    posixPath(installer), 'update', '--bundle', posixPath(secondBundle), '--non-interactive',
  ], legacyEnv), /UPDATE_PASS release=installer-test-r2 slot=b/);
  state = await readFile(legacyPaths.state, 'utf8');
  assert.match(state, /CURRENT_RELEASE=installer-test-r2/);
  assert.match(state, /PREVIOUS_RELEASE=installer-test-legacy/);
  assert.match(state, /CURRENT_ROUTE_SCHEMA=build-id-v1/);
  assert.match(state, /PREVIOUS_ROUTE_SCHEMA=legacy-v0/);
  assert.match(state, /PREVIOUS_ROUTE_SNAPSHOT=installer-test-legacy/);
  await assertRouteCompatibility(legacyRoot, 'installer-test-r2', 'build-id-v1');

  assert.match(runBash([posixPath(installer), 'rollback', '--non-interactive'], legacyEnv), /ROLLBACK_PASS release=installer-test-legacy slot=a/);
  state = await readFile(legacyPaths.state, 'utf8');
  assert.match(state, /CURRENT_RELEASE=installer-test-legacy/);
  assert.match(state, /PREVIOUS_RELEASE=installer-test-r2/);
  assert.match(state, /CURRENT_ROUTE_SCHEMA=legacy-v0/);
  assert.match(state, /PREVIOUS_ROUTE_SCHEMA=build-id-v1/);
  for (const key of ['site', 'upstream', 'unit', 'limits', 'enabled']) {
    assert.equal(await readFile(legacyPaths[key], 'utf8'), legacyBeforeFailure[key], `legacy rollback must restore ${key}`);
  }
  await assertRouteCompatibility(legacyRoot, 'installer-test-legacy', 'legacy-v0');

  if (process.platform !== 'win32') {
    const unsafeModeRoot = await createRoot('unsafe-state-mode-root');
    const unsafeModeEnv = installEnvironment(unsafeModeRoot, 'personal');
    assert.match(runBash([
      posixPath(installer), 'install', '--bundle', posixPath(firstBundle), '--non-interactive',
    ], unsafeModeEnv), /INSTALL_PASS mode=personal/);
    const unsafeModeState = path.join(unsafeModeRoot, 'var', 'lib', 'kaigen-webd', 'installer-state');
    await chmod(unsafeModeState, 0o666);
    assert.throws(() => runBash([
      posixPath(installer), 'update', '--bundle', posixPath(secondBundle), '--non-interactive',
    ], unsafeModeEnv), /Installer state ownership or mode is unsafe/u);
  }

  const symlinkStateRoot = await createRoot('unsafe-state-symlink-root');
  const symlinkStateEnv = installEnvironment(symlinkStateRoot, 'personal');
  assert.match(runBash([
    posixPath(installer), 'install', '--bundle', posixPath(firstBundle), '--non-interactive',
  ], symlinkStateEnv), /INSTALL_PASS mode=personal/);
  const symlinkState = path.join(symlinkStateRoot, 'var', 'lib', 'kaigen-webd', 'installer-state');
  const symlinkTarget = `${symlinkState}.trusted`;
  await rename(symlinkState, symlinkTarget);
  let symlinkCoverage = 'runtime-pass';
  try {
    await symlink(symlinkTarget, symlinkState, 'file');
  } catch (error) {
    if (process.platform === 'win32' && error?.code === 'EPERM') symlinkCoverage = 'linux-required';
    else throw error;
  }
  if (symlinkCoverage === 'runtime-pass') {
    assert.throws(() => runBash([
      posixPath(installer), 'update', '--bundle', posixPath(secondBundle), '--non-interactive',
    ], symlinkStateEnv), /Installer state is not a regular file/u);
  }

  const routeBindingRoot = await createRoot('route-binding-root');
  const routeBindingEnv = installEnvironment(routeBindingRoot, 'personal');
  assert.match(runBash([
    posixPath(installer), 'install', '--bundle', posixPath(firstBundle), '--non-interactive',
  ], routeBindingEnv), /INSTALL_PASS mode=personal/);
  const boundCurrent = path.join(routeBindingRoot, 'opt', 'kaigen-webd', 'current.test-target');
  const boundUpstream = path.join(routeBindingRoot, 'etc', 'nginx', 'kaigen-webd-upstream.conf');
  const originalCurrent = await readFile(boundCurrent, 'utf8');
  const originalUpstream = await readFile(boundUpstream, 'utf8');
  await writeFile(boundCurrent, 'installer-test-unrelated\n', 'utf8');
  assert.throws(() => runBash([
    posixPath(installer), 'update', '--bundle', posixPath(secondBundle), '--non-interactive',
  ], routeBindingEnv), /Installer state does not match the active release target/u);
  await writeFile(boundCurrent, originalCurrent, 'utf8');
  await writeFile(boundUpstream, originalUpstream.replace('127.0.0.1:8787', '127.0.0.1:8788'), 'utf8');
  assert.throws(() => runBash([
    posixPath(installer), 'update', '--bundle', posixPath(secondBundle), '--non-interactive',
  ], routeBindingEnv), /Installer state does not match the active upstream port/u);

  process.stdout.write(`WEB_INSTALLER_TEST_PASS modes=2 update=true rollback=true legacyMigration=true atomicRouteState=true hostileState=true hostileSymlink=${symlinkCoverage} routeBinding=true failureOrder=true safeUninstall=true\n`);
} finally {
  await rm(temp, { recursive: true, force: true });
}
