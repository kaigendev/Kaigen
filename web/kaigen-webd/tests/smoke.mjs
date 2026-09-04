import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

const baseUrl = process.env.KAIGEN_E2E_BASE_URL ?? "http://127.0.0.1:8787";
const publicOrigin = process.env.KAIGEN_E2E_PUBLIC_ORIGIN ?? "https://web.kaigen.one";
const diskRoot = process.env.KAIGEN_E2E_DATA_ROOT;
const profileName = "Disposable Web Smoke";
const workspacePassword = "disposable-workspace-access-password";
const password = "disposable-profile-password";
const exportPassword = "disposable-export-password";
const importSourcePassword = "disposable-import-source-password";
const importSourceWorkspacePassword = "disposable-import-workspace-password";
const importExportPassword = "disposable-import-export-password";
const importSourceName = "Disposable Import Source";
const packageSourcePassword = "disposable-package-source-password";
const packageSourceWorkspacePassword = "disposable-package-workspace-password";
const packageExportPassword = "disposable-package-export-password";
const packageSourceName = "Disposable Package Source";

const base64url = (bytes) => Buffer.from(bytes).toString("base64url");
const fromBase64url = (value) => Buffer.from(value, "base64url");
const workspaceSelector = (identifier) => createHash("sha256")
  .update("kaigen-workspace-identifier-v1")
  .update(identifier)
  .digest("base64url");

function mergeCookieJar(...cookies) {
  const jar = new Map();
  for (const cookie of cookies) {
    const [name, value] = cookie.split("=", 2);
    jar.set(name, value);
  }
  return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
}

function extractStoredZipEntry(bytes, expectedName) {
  let offset = 0;
  while (offset + 30 <= bytes.length && bytes.readUInt32LE(offset) === 0x04034b50) {
    const flags = bytes.readUInt16LE(offset + 6);
    const method = bytes.readUInt16LE(offset + 8);
    const compressedBytes = bytes.readUInt32LE(offset + 18);
    const logicalBytes = bytes.readUInt32LE(offset + 22);
    const nameBytes = bytes.readUInt16LE(offset + 26);
    const extraBytes = bytes.readUInt16LE(offset + 28);
    assert.equal(flags, 0);
    assert.equal(method, 0);
    assert.equal(compressedBytes, logicalBytes);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameBytes + extraBytes;
    const dataEnd = dataStart + compressedBytes;
    assert.ok(dataEnd <= bytes.length, "qTox ZIP entry exceeds the archive boundary");
    const name = bytes.subarray(nameStart, nameStart + nameBytes).toString("utf8");
    if (name === expectedName) return Buffer.from(bytes.subarray(dataStart, dataEnd));
    offset = dataEnd;
  }
  assert.fail(`qTox ZIP entry not found: ${expectedName}`);
}

async function api(route, body, session) {
  const headers = { "Content-Type": "application/json", Origin: publicOrigin };
  if (session?.cookie) headers.Cookie = session.cookie;
  if (session?.csrf) headers["X-Kaigen-CSRF"] = session.csrf;
  if (session?.selector) headers["X-Kaigen-Workspace"] = session.selector;
  const response = await fetch(`${baseUrl}${route}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  return { response, payload };
}

function leadingZeroBits(bytes) {
  let bits = 0;
  for (const byte of bytes) {
    if (byte === 0) bits += 8;
    else {
      bits += Math.clz32(byte) - 24;
      break;
    }
  }
  return bits;
}

async function solveProof() {
  const { response, payload } = await api("/api/v1/initializer/challenge", {});
  assert.equal(response.status, 200);
  for (let nonce = 0; nonce <= 0xffff_ffff; nonce += 1) {
    const digest = createHash("sha256").update(`${payload.salt}:${nonce}`).digest();
    if (leadingZeroBits(digest) >= payload.difficulty) {
      return { challengeId: payload.challengeId, nonce };
    }
  }
  throw new Error("proof was not solved");
}

async function deviceKeys() {
  const pair = await webcrypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign", "verify"],
  );
  const spki = await webcrypto.subtle.exportKey("spki", pair.publicKey);
  return { pair, publicKey: base64url(spki) };
}

function sessionFrom(response, payload, identifier) {
  const selector = workspaceSelector(identifier);
  const setCookie = response.headers.get("set-cookie") ?? "";
  const cookie = setCookie.split(";", 1)[0];
  assert.match(cookie, new RegExp(`^__Host-kaigen-device-${selector}=`));
  return { cookie, csrf: payload.csrfToken, deviceId: payload.deviceId, selector };
}

async function login(identifier, keys, loginPassword = workspacePassword) {
  const { response, payload } = await api("/api/v1/auth/password", {
    identifier,
    password: loginPassword,
    publicKey: keys.publicKey,
  });
  assert.equal(response.status, 200, JSON.stringify(payload));
  return sessionFrom(response, payload, identifier);
}

async function command(session, name, args = {}) {
  const result = await api(`/api/v1/commands/${name}`, args, session);
  assert.equal(result.response.status, 200, `${name}: ${JSON.stringify(result.payload)}`);
  return result.payload;
}

async function receiveArchive(
  session,
  archivePassword = exportPassword,
  privateNames = [profileName],
  privatePasswords = [workspacePassword, password, archivePassword],
  workspaceIdentifier,
) {
  const response = await fetch(`${baseUrl}/api/v1/workspaces/archive`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: publicOrigin,
      Cookie: session.cookie,
      "X-Kaigen-CSRF": session.csrf,
      "X-Kaigen-Workspace": session.selector,
    },
    body: JSON.stringify({ password: archivePassword, identifier: workspaceIdentifier }),
  });
  if (response.status !== 200) {
    assert.fail(`archive request failed: ${response.status} ${await response.text()}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const hash = createHash("sha256").update(bytes).digest("base64url");
  const transactionId = response.headers.get("x-kaigen-archive-transaction") ?? "";
  assert.equal(response.headers.get("x-kaigen-archive-sha256"), hash);
  assert.equal(Number(response.headers.get("content-length")), bytes.length);
  assert.match(transactionId, /^[A-Za-z0-9_-]{32}$/u);
  for (const privateName of privateNames) assert.equal(bytes.includes(Buffer.from(privateName)), false);
  for (const privatePassword of privatePasswords) assert.equal(bytes.includes(Buffer.from(privatePassword)), false);
  if (workspaceIdentifier) assert.equal(bytes.includes(Buffer.from(workspaceIdentifier)), false);
  return { hash, bytes: bytes.length, transactionId, payload: bytes };
}

async function uploadWorkspaceImport(
  bytes,
  archivePassword,
  profilePassword,
  finishArchivePassword = archivePassword,
) {
  const started = await api("/api/v1/workspaces/import/start", {
    storageMode: "disk",
    sizeBytes: bytes.length,
    proof: await solveProof(),
  });
  assert.equal(started.response.status, 200, JSON.stringify(started.payload));
  assert.match(started.payload.importId, /^[A-Za-z0-9_-]{32}$/u);
  for (let position = 0; position < bytes.length; position += started.payload.chunkBytes) {
    const chunk = bytes.subarray(position, position + started.payload.chunkBytes);
    const response = await fetch(`${baseUrl}/api/v1/workspaces/import/upload`, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        Origin: publicOrigin,
        "X-Kaigen-Import-Id": started.payload.importId,
        "X-Kaigen-Import-Position": String(position),
      },
      body: chunk,
    });
    assert.equal(response.status, 200, await response.text());
  }
  const finished = await api("/api/v1/workspaces/import/finish", {
    importId: started.payload.importId,
    archivePassword: finishArchivePassword,
    profilePassword,
    sha256: createHash("sha256").update(bytes).digest("base64url"),
  });
  return { ...finished, importId: started.payload.importId };
}

async function receiveProfileExport(session, kind, profileExportPassword = exportPassword, privateName = profileName) {
  const response = await fetch(`${baseUrl}/api/v1/profiles/export/${kind}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: publicOrigin,
      Cookie: session.cookie,
      "X-Kaigen-CSRF": session.csrf,
      "X-Kaigen-Workspace": session.selector,
    },
    body: JSON.stringify({ password: profileExportPassword }),
  });
  if (response.status !== 200) {
    assert.fail(`profile ${kind} export failed: ${response.status} ${await response.text()}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.ok(bytes.length > 0);
  assert.equal(bytes.includes(Buffer.from(privateName)), false);
  assert.equal(bytes.includes(Buffer.from(password)), false);
  assert.equal(bytes.includes(Buffer.from(exportPassword)), false);
  assert.equal(bytes.includes(Buffer.from(profileExportPassword)), false);
  if (kind === "package") {
    assert.equal(response.headers.get("content-type"), "application/vnd.kaigen.profile+encrypted");
    assert.equal(bytes.subarray(0, "KAIGEN-PROFILE\n".length).toString(), "KAIGEN-PROFILE\n");
    assert.equal(
      response.headers.get("x-kaigen-export-sha256"),
      createHash("sha256").update(bytes).digest("base64url"),
    );
  } else {
    assert.equal(response.headers.get("content-type"), "application/zip");
    assert.deepEqual([...bytes.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
    assert.ok(bytes.includes(Buffer.from("kaigen-profile.tox")));
    assert.ok(bytes.includes(Buffer.from("toxEsave")));
    assert.equal(bytes.includes(Buffer.from("KAIGEN-PROFILE\n")), false);
  }
  return bytes;
}

async function uploadProfileImport(
  session,
  bytes,
  name,
  importPassword,
  finishPassword = importPassword,
  kind = "tox",
) {
  const started = await api("/api/v1/profiles/import/start", {
    kind,
    sizeBytes: bytes.length,
  }, session);
  assert.equal(started.response.status, 200, JSON.stringify(started.payload));
  assert.match(started.payload.importId, /^[A-Za-z0-9_-]{32}$/u);
  for (let position = 0; position < bytes.length; position += started.payload.chunkBytes) {
    const chunk = bytes.subarray(position, position + started.payload.chunkBytes);
    const response = await fetch(`${baseUrl}/api/v1/profiles/import/upload`, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        Origin: publicOrigin,
        Cookie: session.cookie,
        "X-Kaigen-CSRF": session.csrf,
        "X-Kaigen-Workspace": session.selector,
        "X-Kaigen-Import-Id": started.payload.importId,
        "X-Kaigen-Import-Position": String(position),
      },
      body: chunk,
    });
    assert.equal(response.status, 200, await response.text());
  }
  const finished = await api("/api/v1/profiles/import/finish", {
    importId: started.payload.importId,
    name,
    password: finishPassword,
    sha256: createHash("sha256").update(bytes).digest("base64url"),
  }, session);
  return { ...finished, importId: started.payload.importId };
}

async function scanFiles(root) {
  const output = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("unexpected symlink in storage");
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile() && (await stat(target)).size <= 16 * 1024 * 1024) {
        output.push(await readFile(target));
      }
    }
  }
  await visit(root);
  return Buffer.concat(output);
}

async function scanFileNames(root) {
  const output = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile()) output.push(entry.name);
    }
  }
  await visit(root);
  return output;
}

const health = await fetch(`${baseUrl}/healthz`);
assert.equal(health.status, 200);
const createResult = await api("/api/v1/workspaces", {
  storageMode: "disk",
  accessPassword: workspacePassword,
  language: "en",
  proof: await solveProof(),
});
assert.equal(createResult.response.status, 201, JSON.stringify(createResult.payload));
const identifier = createResult.payload.identifier;
assert.match(identifier, /^[A-Za-z0-9_-]{43,55}$/u);

const firstKeys = await deviceKeys();
const firstSession = await login(identifier, firstKeys);
const emptyStartup = await command(firstSession, "get_startup_state");
assert.equal(emptyStartup.firstRun, true);
assert.deepEqual(emptyStartup.profiles, []);
await command(firstSession, "create_profile", { name: profileName, password });
const workspaceBeforeLastProfileDestroy = await api("/api/v1/lease/heartbeat", {}, firstSession);
assert.equal(workspaceBeforeLastProfileDestroy.response.status, 200, JSON.stringify(workspaceBeforeLastProfileDestroy.payload));
assert.deepEqual(await command(firstSession, "destroy_active_profile"), []);
const emptyAfterLastProfileDestroy = await command(firstSession, "get_startup_state");
assert.equal(emptyAfterLastProfileDestroy.firstRun, true);
assert.deepEqual(emptyAfterLastProfileDestroy.profiles, []);
const workspaceAfterLastProfileDestroy = await api("/api/v1/lease/heartbeat", {}, firstSession);
assert.equal(workspaceAfterLastProfileDestroy.response.status, 200, JSON.stringify(workspaceAfterLastProfileDestroy.payload));
assert.equal(workspaceAfterLastProfileDestroy.payload.workspace.storageMode, workspaceBeforeLastProfileDestroy.payload.workspace.storageMode);
assert.equal(workspaceAfterLastProfileDestroy.payload.workspace.leaseSeconds, workspaceBeforeLastProfileDestroy.payload.workspace.leaseSeconds);
assert.equal(workspaceAfterLastProfileDestroy.payload.workspace.expiresAt, workspaceBeforeLastProfileDestroy.payload.workspace.expiresAt);
await command(firstSession, "create_profile", { name: profileName, password });
const startup = await command(firstSession, "get_startup_state");
assert.equal(startup.firstRun, false);
assert.equal(startup.profiles.length, 1);
assert.equal(startup.profiles[0].name, profileName);
assert.match(startup.profiles[0].fileName, /\.kai$/u);
const avatarDataUrl = "data:image/png;base64,iVBORw0KGgo=";
const avatarProfiles = await command(firstSession, "set_profile_avatar", {
  profileId: startup.profiles[0].id,
  dataUrl: avatarDataUrl,
  filename: "avatar.png",
  bytes: [137, 80, 78, 71],
});
assert.equal(avatarProfiles[0].avatar, avatarDataUrl);
const legacyLargeLocalState = {
  profileAvatar: avatarDataUrl,
  drafts: { regression: "A".repeat(1_100_000) },
};
await command(firstSession, "save_local_state", {
  profileId: startup.profiles[0].id,
  state: legacyLargeLocalState,
});
assert.deepEqual(
  await command(firstSession, "load_local_state", { profileId: startup.profiles[0].id }),
  legacyLargeLocalState,
);
const boundedLayout = await api("/api/v1/commands/save_layout_state", {
  state: { oversized: "B".repeat(1_100_000) },
}, firstSession);
assert.equal(boundedLayout.response.status, 413);
assert.equal(boundedLayout.payload.code, "REQUEST_TOO_LARGE");
const toxId = await command(firstSession, "get_tox_id");
assert.equal(typeof toxId, "string");
assert.equal(toxId.length, 76);
const profileBeforeBrowserLock = (await command(firstSession, "get_startup_state")).profiles
  .find((profile) => profile.id === startup.profiles[0].id);
assert.equal(profileBeforeBrowserLock?.loaded, true);
assert.equal(profileBeforeBrowserLock?.active, true);
const browserLocked = await api("/api/v1/workspaces/lock", {}, firstSession);
assert.equal(browserLocked.response.status, 200, JSON.stringify(browserLocked.payload));
assert.equal(browserLocked.payload.locked, true);
const browserLockRevokedSession = await api("/api/v1/lease/heartbeat", {}, firstSession);
assert.equal(browserLockRevokedSession.response.status, 401);
const browserLockRequiresPassword = await api(
  "/api/v1/auth/device-challenge",
  { identifier, deviceId: firstSession.deviceId },
  firstSession,
);
assert.equal(browserLockRequiresPassword.response.status, 401);
const browserUnlockKeys = await deviceKeys();
const browserUnlockSession = await login(identifier, browserUnlockKeys);
const profileAfterBrowserUnlock = (await command(browserUnlockSession, "get_startup_state")).profiles
  .find((profile) => profile.id === startup.profiles[0].id);
assert.equal(profileAfterBrowserUnlock?.loaded, true);
assert.equal(profileAfterBrowserUnlock?.active, true);
assert.equal(await command(browserUnlockSession, "get_tox_id"), toxId);

const secondKeys = await deviceKeys();
const secondSession = await login(identifier, secondKeys);
const revoked = await api("/api/v1/lease/heartbeat", {}, firstSession);
assert.equal(revoked.response.status, 401);
const heartbeat = await api("/api/v1/lease/heartbeat", {}, secondSession);
assert.equal(heartbeat.response.status, 200, JSON.stringify(heartbeat.payload));
const missingCsrf = await api(
  "/api/v1/lease/heartbeat",
  {},
  { ...secondSession, csrf: undefined },
);
assert.equal(missingCsrf.response.status, 401);
assert.equal(missingCsrf.payload.code, "CSRF_INVALID");

const challengeResult = await api(
  "/api/v1/auth/device-challenge",
  { identifier, deviceId: secondSession.deviceId },
  secondSession,
);
assert.equal(challengeResult.response.status, 200);
const signature = await webcrypto.subtle.sign(
  { name: "ECDSA", hash: "SHA-256" },
  secondKeys.pair.privateKey,
  fromBase64url(challengeResult.payload.challenge),
);
const inFlightCsrf = secondSession.csrf;
const restored = await api(
  "/api/v1/auth/device",
  {
    identifier,
    deviceId: secondSession.deviceId,
    challenge: challengeResult.payload.challenge,
    signature: base64url(signature),
  },
  secondSession,
);
assert.equal(restored.response.status, 200, JSON.stringify(restored.payload));
secondSession.csrf = restored.payload.csrfToken;
const inFlightSession = { ...secondSession, csrf: inFlightCsrf };
const inFlightHeartbeat = await api("/api/v1/lease/heartbeat", {}, inFlightSession);
assert.equal(inFlightHeartbeat.response.status, 200, JSON.stringify(inFlightHeartbeat.payload));

const importSourceCreated = await api("/api/v1/workspaces", {
  storageMode: "disk",
  accessPassword: importSourceWorkspacePassword,
  language: "en",
  proof: await solveProof(),
});
assert.equal(importSourceCreated.response.status, 201, JSON.stringify(importSourceCreated.payload));
const importSourceKeys = await deviceKeys();
const importSourceSession = await login(
  importSourceCreated.payload.identifier,
  importSourceKeys,
  importSourceWorkspacePassword,
);
await command(importSourceSession, "create_profile", {
  name: importSourceName,
  password: importSourcePassword,
});
const sharedBrowserCookies = mergeCookieJar(
  secondSession.cookie,
  importSourceSession.cookie,
  `__Host-kaigen-device=${importSourceSession.deviceId}`,
);
const firstWorkspaceTab = { ...secondSession, cookie: sharedBrowserCookies };
const secondWorkspaceTab = { ...importSourceSession, cookie: sharedBrowserCookies };
const firstWorkspaceTor = await command(firstWorkspaceTab, "get_tor_status");
const secondWorkspaceTor = await command(secondWorkspaceTab, "get_tor_status");
assert.equal(typeof firstWorkspaceTor.state, "string");
assert.equal(typeof secondWorkspaceTor.state, "string");
const legacyFirstWorkspaceTab = { ...firstWorkspaceTab, selector: undefined };
const legacyFirstWorkspaceTor = await command(legacyFirstWorkspaceTab, "get_tor_status");
assert.equal(typeof legacyFirstWorkspaceTor.state, "string");
const legacyChallenge = await api(
  "/api/v1/auth/device-challenge",
  { identifier, deviceId: secondSession.deviceId },
  legacyFirstWorkspaceTab,
);
assert.equal(legacyChallenge.response.status, 200, JSON.stringify(legacyChallenge.payload));
const legacySignature = await webcrypto.subtle.sign(
  { name: "ECDSA", hash: "SHA-256" },
  secondKeys.pair.privateKey,
  fromBase64url(legacyChallenge.payload.challenge),
);
const legacyRestored = await api(
  "/api/v1/auth/device",
  {
    identifier,
    deviceId: secondSession.deviceId,
    challenge: legacyChallenge.payload.challenge,
    signature: base64url(legacySignature),
  },
  legacyFirstWorkspaceTab,
);
assert.equal(legacyRestored.response.status, 200, JSON.stringify(legacyRestored.payload));
secondSession.csrf = legacyRestored.payload.csrfToken;
const importSourceToxId = await command(importSourceSession, "get_tox_id");
const importableQtox = await receiveProfileExport(
  importSourceSession,
  "tox",
  importExportPassword,
  importSourceName,
);
assert.ok(extractStoredZipEntry(importableQtox, "kaigen-profile.tox").length > 0);
const importSourceArchive = await receiveArchive(
  importSourceSession,
  exportPassword,
  [importSourceName],
  [importSourcePassword, exportPassword],
  importSourceCreated.payload.identifier,
);
const erasedImportSource = await api("/api/v1/workspaces/erase", {
  archiveHash: importSourceArchive.hash,
  archiveBytes: importSourceArchive.bytes,
  transactionId: importSourceArchive.transactionId,
  explicitConfirmation: true,
}, importSourceSession);
assert.equal(erasedImportSource.response.status, 200, JSON.stringify(erasedImportSource.payload));

const wrongImportPassword = await uploadProfileImport(
  secondSession,
  importableQtox,
  "Imported Disposable Profile",
  importExportPassword,
  "wrong import password",
  "qtoxZip",
);
assert.equal(wrongImportPassword.response.status, 400);
assert.equal(wrongImportPassword.payload.code, "PROFILE_PASSWORD_INVALID");
const imported = await api("/api/v1/profiles/import/finish", {
  importId: wrongImportPassword.importId,
  name: "Imported Disposable Profile",
  password: importExportPassword,
  sha256: createHash("sha256").update(importableQtox).digest("base64url"),
}, secondSession);
assert.equal(imported.response.status, 200, JSON.stringify(imported.payload));
assert.equal(imported.payload.length, 2);
const importedProfile = imported.payload.find((profile) => profile.name === "Imported Disposable Profile");
assert.ok(importedProfile?.id);
await command(secondSession, "switch_profile", { profileId: importedProfile.id });
assert.equal(await command(secondSession, "get_tox_id"), importSourceToxId);
await command(secondSession, "switch_profile", { profileId: startup.profiles[0].id });
assert.equal(await command(secondSession, "get_tox_id"), toxId);

const packageSourceCreated = await api("/api/v1/workspaces", {
  storageMode: "disk",
  accessPassword: packageSourceWorkspacePassword,
  language: "en",
  proof: await solveProof(),
});
assert.equal(packageSourceCreated.response.status, 201, JSON.stringify(packageSourceCreated.payload));
const packageSourceKeys = await deviceKeys();
const packageSourceSession = await login(
  packageSourceCreated.payload.identifier,
  packageSourceKeys,
  packageSourceWorkspacePassword,
);
await command(packageSourceSession, "create_profile", {
  name: packageSourceName,
  password: packageSourcePassword,
});
const packageSourceToxId = await command(packageSourceSession, "get_tox_id");
const importablePackage = await receiveProfileExport(
  packageSourceSession,
  "package",
  packageExportPassword,
  packageSourceName,
);
const packageSourceArchive = await receiveArchive(
  packageSourceSession,
  exportPassword,
  [packageSourceName],
  [packageSourcePassword, packageExportPassword, exportPassword],
  packageSourceCreated.payload.identifier,
);
const erasedPackageSource = await api("/api/v1/workspaces/erase", {
  archiveHash: packageSourceArchive.hash,
  archiveBytes: packageSourceArchive.bytes,
  transactionId: packageSourceArchive.transactionId,
  explicitConfirmation: true,
}, packageSourceSession);
assert.equal(erasedPackageSource.response.status, 200, JSON.stringify(erasedPackageSource.payload));

const packageImported = await uploadProfileImport(
  secondSession,
  importablePackage,
  "",
  packageExportPassword,
  packageExportPassword,
  "package",
);
assert.equal(packageImported.response.status, 200, JSON.stringify(packageImported.payload));
assert.equal(packageImported.payload.length, 3);
const importedPackageProfile = packageImported.payload.find((profile) => profile.name === packageSourceName);
assert.ok(importedPackageProfile?.id);
await command(secondSession, "switch_profile", { profileId: importedPackageProfile.id });
assert.equal(await command(secondSession, "get_tox_id"), packageSourceToxId);
await command(secondSession, "switch_profile", { profileId: startup.profiles[0].id });
assert.equal(await command(secondSession, "get_tox_id"), toxId);

await receiveProfileExport(secondSession, "package");
await receiveProfileExport(secondSession, "tox");
assert.equal(await command(secondSession, "get_tox_id"), toxId);

if (diskRoot) {
  await new Promise((resolve) => setTimeout(resolve, 50));
  const persisted = await scanFiles(diskRoot);
  assert.equal(persisted.includes(Buffer.from(profileName)), false);
  assert.equal(persisted.includes(Buffer.from(password)), false);
  assert.equal(persisted.includes(Buffer.from("Imported Disposable Profile")), false);
  assert.equal(persisted.includes(Buffer.from(importExportPassword)), false);
  assert.equal(persisted.includes(Buffer.from(packageSourceName)), false);
  assert.equal(persisted.includes(Buffer.from(packageExportPassword)), false);
  const persistedNames = await scanFileNames(diskRoot);
  assert.equal(persistedNames.some((name) => name.startsWith(".profile-export-")), false);
  assert.equal(persistedNames.some((name) => name.startsWith(".profile-import-")), false);
  assert.equal(persistedNames.some((name) => name.startsWith(".profile-restore-")), false);
}

const cancelledArchive = await receiveArchive(
  secondSession,
  exportPassword,
  [profileName, "Imported Disposable Profile", packageSourceName],
  [password, importExportPassword, packageExportPassword, exportPassword],
  identifier,
);
const frozen = await api("/api/v1/commands/get_startup_state", {}, secondSession);
assert.equal(frozen.response.status, 409);
assert.equal(frozen.payload.code, "WORKSPACE_FROZEN");
const cancelled = await api("/api/v1/workspaces/archive/cancel", {}, secondSession);
assert.equal(cancelled.response.status, 200, JSON.stringify(cancelled.payload));
assert.equal(await command(secondSession, "get_tox_id"), toxId);

const finalArchive = await receiveArchive(
  secondSession,
  exportPassword,
  [profileName, "Imported Disposable Profile", packageSourceName],
  [password, importExportPassword, packageExportPassword, exportPassword],
  identifier,
);
assert.notEqual(finalArchive.transactionId, cancelledArchive.transactionId);
const rejectedErasure = await api("/api/v1/workspaces/erase", {
  archiveHash: finalArchive.hash,
  archiveBytes: finalArchive.bytes + 1,
  transactionId: finalArchive.transactionId,
  explicitConfirmation: true,
}, secondSession);
assert.equal(rejectedErasure.response.status, 400);
assert.equal(rejectedErasure.payload.code, "ARCHIVE_CONFIRMATION_INVALID");
const erased = await api("/api/v1/workspaces/erase", {
  archiveHash: finalArchive.hash,
  archiveBytes: finalArchive.bytes,
  transactionId: finalArchive.transactionId,
  explicitConfirmation: true,
}, secondSession);
assert.equal(erased.response.status, 200, JSON.stringify(erased.payload));
assert.equal(erased.payload.erased, true);
const erasedHeartbeat = await api("/api/v1/lease/heartbeat", {}, secondSession);
assert.equal(erasedHeartbeat.response.status, 401);

const wrongWorkspaceArchivePassword = await uploadWorkspaceImport(
  finalArchive.payload,
  exportPassword,
  workspacePassword,
  "wrong workspace archive password",
);
assert.equal(wrongWorkspaceArchivePassword.response.status, 400);
assert.equal(
  wrongWorkspaceArchivePassword.payload.code,
  "WORKSPACE_ARCHIVE_PASSWORD_INVALID",
);
const restoredWorkspace = await api("/api/v1/workspaces/import/finish", {
  importId: wrongWorkspaceArchivePassword.importId,
  archivePassword: exportPassword,
  accessPassword: workspacePassword,
  sha256: createHash("sha256").update(finalArchive.payload).digest("base64url"),
});
assert.equal(restoredWorkspace.response.status, 201, JSON.stringify(restoredWorkspace.payload));
assert.equal(restoredWorkspace.payload.identifier, identifier);
const restoredKeys = await deviceKeys();
const restoredSession = await login(identifier, restoredKeys, workspacePassword);
const restoredStartup = await command(restoredSession, "get_startup_state");
assert.equal(restoredStartup.profiles.length, 3);
await command(restoredSession, "unlock_profile", {
  profileId: restoredStartup.profiles.find((profile) => profile.name === profileName).id,
  password,
});
await command(restoredSession, "switch_profile", {
  profileId: restoredStartup.profiles.find((profile) => profile.name === profileName).id,
});
assert.equal(await command(restoredSession, "get_tox_id"), toxId);
const closedWorkspace = await api("/api/v1/workspaces/close", {}, restoredSession);
assert.equal(closedWorkspace.response.status, 200, JSON.stringify(closedWorkspace.payload));
assert.equal(closedWorkspace.payload.closed, true);
const closedHeartbeat = await api("/api/v1/lease/heartbeat", {}, restoredSession);
assert.equal(closedHeartbeat.response.status, 401);
const closedLookup = await api("/api/v1/workspaces/lookup", { identifier });
assert.equal(closedLookup.response.status, 200, JSON.stringify(closedLookup.payload));
assert.equal(closedLookup.payload.exists, true);
const reopenedKeys = await deviceKeys();
const reopenedSession = await login(identifier, reopenedKeys, workspacePassword);
const reopenedStartup = await command(reopenedSession, "get_startup_state");
assert.equal(reopenedStartup.profiles.length, 3);
assert.equal(reopenedStartup.profiles.find((profile) => profile.name === profileName)?.avatar, avatarDataUrl);
await command(reopenedSession, "unlock_profile", {
  profileId: reopenedStartup.profiles.find((profile) => profile.name === profileName).id,
  password,
});
await command(reopenedSession, "switch_profile", {
  profileId: reopenedStartup.profiles.find((profile) => profile.name === profileName).id,
});
assert.equal(await command(reopenedSession, "get_tox_id"), toxId);
const rejectedDirectDestroy = await api("/api/v1/workspaces/destroy", {
  explicitConfirmation: false,
}, reopenedSession);
assert.equal(rejectedDirectDestroy.response.status, 400);
assert.equal(rejectedDirectDestroy.payload.code, "WORKSPACE_DESTROY_CONFIRMATION_REQUIRED");
const cleanupErasure = await api("/api/v1/workspaces/destroy", {
  explicitConfirmation: true,
}, reopenedSession);
assert.equal(cleanupErasure.response.status, 200, JSON.stringify(cleanupErasure.payload));
assert.equal(cleanupErasure.payload.destroyed, true);
const destroyedLookup = await api("/api/v1/workspaces/lookup", { identifier });
assert.equal(destroyedLookup.response.status, 200, JSON.stringify(destroyedLookup.payload));
assert.equal(destroyedLookup.payload.exists, false);
if (diskRoot) assert.deepEqual(await readdir(diskRoot), []);

process.stdout.write(`${JSON.stringify({
  ok: true,
  identifierLength: identifier.length,
  toxIdLength: toxId.length,
  checks: 110,
})}\n`);
