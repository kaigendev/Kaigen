import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

const baseUrl = process.env.KAIGEN_E2E_BASE_URL ?? "http://127.0.0.1:8787";
const publicOrigin = process.env.KAIGEN_E2E_PUBLIC_ORIGIN ?? "https://web.kaigen.one";
const diskRoot = process.env.KAIGEN_E2E_DATA_ROOT;
const activeRoot = process.env.KAIGEN_E2E_ACTIVE_ROOT;
const networkRoute = process.env.KAIGEN_E2E_NETWORK_ROUTE ?? "direct";
const storageMode = process.env.KAIGEN_E2E_STORAGE_MODE ?? "disk";
const exactAup3Path = process.env.KAIGEN_E2E_AUP3_PATH;
const payloadBytes = 3 * 1024 * 1024 + 12_345;
const exactAup3Bytes = 13_574_144;
const oversizedAup3Bytes = 38_572_032;
const rateLimit = 1024 * 1024;
const passwordPrefix = "disposable-transfer-smoke-password";

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const base64url = (bytes) => Buffer.from(bytes).toString("base64url");
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

async function postJson(route, body, session) {
  const headers = { "Content-Type": "application/json", Origin: publicOrigin };
  if (session?.cookie) headers.Cookie = session.cookie;
  if (session?.csrf) headers["X-Kaigen-CSRF"] = session.csrf;
  if (session?.selector) headers["X-Kaigen-Workspace"] = session.selector;
  const response = await fetch(`${baseUrl}${route}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  return { response, payload };
}

async function command(session, name, args = {}) {
  const result = await postJson(`/api/v1/commands/${name}`, args, session);
  if (result.response.status !== 200) {
    throw new Error(`${name} failed with ${result.response.status}:${result.payload?.code ?? "invalid-response"}`);
  }
  return result.payload;
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
  const { response, payload } = await postJson("/api/v1/initializer/challenge", {});
  assert.equal(response.status, 200);
  for (let nonce = 0; nonce <= 0xffff_ffff; nonce += 1) {
    const digest = createHash("sha256").update(`${payload.salt}:${nonce}`).digest();
    if (leadingZeroBits(digest) >= payload.difficulty) {
      return { challengeId: payload.challengeId, nonce };
    }
  }
  throw new Error("proof was not solved");
}

async function createSession(suffix) {
  const password = `${passwordPrefix}-workspace-${suffix}`;
  const profilePassword = `${passwordPrefix}-profile-${suffix}`;
  const created = await postJson("/api/v1/workspaces", {
    storageMode,
    accessPassword: password,
    language: "en",
    proof: await solveProof(),
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.payload));
  const pair = await webcrypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign", "verify"],
  );
  const publicKey = base64url(await webcrypto.subtle.exportKey("spki", pair.publicKey));
  const loggedIn = await postJson("/api/v1/auth/password", {
    identifier: created.payload.identifier,
    password,
    publicKey,
  });
  assert.equal(loggedIn.response.status, 200, JSON.stringify(loggedIn.payload));
  const setCookie = loggedIn.response.headers.get("set-cookie") ?? "";
  const cookie = setCookie.split(";", 1)[0];
  const selector = workspaceSelector(created.payload.identifier);
  assert.match(cookie, new RegExp(`^__Host-kaigen-device-${selector}=`));
  const session = {
    cookie,
    csrf: loggedIn.payload.csrfToken,
    selector,
    identifier: created.payload.identifier,
    password,
    profilePassword,
  };
  const createdProfile = await command(session, "create_profile", {
    name: `Disposable Transfer ${suffix}`,
    password: profilePassword,
  });
  const profiles = createdProfile.profiles;
  assert.equal(createdProfile.initialConnectionPresetRequired, true);
  session.profileId = profiles.find((profile) => profile.active)?.id;
  assert.ok(session.profileId);
  const initialStartup = await command(session, "get_startup_state");
  const activeProfile = initialStartup.profiles.find((profile) => profile.id === session.profileId);
  assert.equal(activeProfile?.connection, "offline");
  assert.equal(activeProfile?.userStatus, "offline");
  if (initialStartup.initialConnectionPresetRequired) {
    const selected = await command(session, "apply_initial_connection_preset", { preset: "fast" });
    assert.equal(selected.preset, "fast");
  }
  assert.equal((await command(session, "get_startup_state")).initialConnectionPresetRequired, false);
  return session;
}

async function archiveAndEraseDisposableWorkspace(session, suffix) {
  const archivePassword = `${passwordPrefix}-archive-${suffix}`;
  const response = await fetch(`${baseUrl}/api/v1/workspaces/archive`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: publicOrigin,
      Cookie: session.cookie,
      "X-Kaigen-CSRF": session.csrf,
      "X-Kaigen-Workspace": session.selector,
    },
    body: JSON.stringify({ password: archivePassword, identifier: session.identifier }),
  });
  if (response.status !== 200) {
    throw new Error(`workspace archive cleanup failed with ${response.status}:${await response.text()}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const archiveHash = createHash("sha256").update(bytes).digest("base64url");
  const transactionId = response.headers.get("x-kaigen-archive-transaction") ?? "";
  assert.equal(response.headers.get("x-kaigen-archive-sha256"), archiveHash);
  assert.equal(Number(response.headers.get("content-length")), bytes.length);
  assert.match(transactionId, /^[A-Za-z0-9_-]{32}$/u);
  assert.equal(bytes.includes(Buffer.from(session.identifier)), false);
  assert.equal(bytes.includes(Buffer.from(session.password)), false);
  assert.equal(bytes.includes(Buffer.from(session.profilePassword)), false);
  assert.equal(bytes.includes(Buffer.from(archivePassword)), false);
  const erased = await postJson("/api/v1/workspaces/erase", {
    archiveHash,
    archiveBytes: bytes.length,
    transactionId,
    explicitConfirmation: true,
  }, session);
  assert.equal(erased.response.status, 200, JSON.stringify(erased.payload));
  assert.equal(erased.payload.erased, true);
}

async function waitFor(label, probe, timeoutMilliseconds = 240_000) {
  const deadline = Date.now() + timeoutMilliseconds;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await probe();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await sleep(500);
  }
  throw new Error(`${label} timed out${lastError ? `: ${lastError.message}` : ""}`);
}

async function transferStatus(session, transferId) {
  const result = await postJson("/api/v1/transfers/status", { transferId }, session);
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  return result.payload;
}

async function uploadRange(session, transferId, position, bytes) {
  const response = await fetch(`${baseUrl}/api/v1/transfers/upload`, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      Origin: publicOrigin,
      Cookie: session.cookie,
      "X-Kaigen-CSRF": session.csrf,
      "X-Kaigen-Workspace": session.selector,
      "X-Kaigen-Profile-Id": session.profileId,
      "X-Kaigen-Transfer-Id": transferId,
      "X-Kaigen-Transfer-Position": String(position),
    },
    body: bytes,
  });
  const payload = await response.json().catch(() => null);
  if (response.status === 409 && payload?.code === "TRANSFER_CHUNK_STALE") {
    return { stale: true, retryAfterMs: 0 };
  }
  assert.equal(response.status, 200, JSON.stringify(payload));
  return payload;
}

async function downloadRange(session, transferId) {
  const response = await fetch(`${baseUrl}/api/v1/transfers/download`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: publicOrigin,
      Cookie: session.cookie,
      "X-Kaigen-CSRF": session.csrf,
      "X-Kaigen-Workspace": session.selector,
    },
    body: JSON.stringify({ transferId }),
  });
  if (response.status === 204) return null;
  if (response.status !== 200) {
    throw new Error(`transfer download failed with ${response.status}:${await response.text()}`);
  }
  return {
    position: Number(response.headers.get("x-kaigen-transfer-position")),
    bytes: Buffer.from(await response.arrayBuffer()),
  };
}

async function beginTransfer(
  session,
  friendNumber,
  filename,
  payload,
  mime = "application/octet-stream",
) {
  const started = await postJson("/api/v1/transfers/outgoing", {
    profileId: session.profileId,
    friendNumber,
    filename,
    mime,
    sizeBytes: payload.length,
  }, session);
  assert.equal(started.response.status, 200, JSON.stringify(started.payload));
  return started.payload;
}

async function expectBeginTransferRejected(
  session,
  friendNumber,
  filename,
  sizeBytes,
  expectedCode,
) {
  const started = await postJson("/api/v1/transfers/outgoing", {
    profileId: session.profileId,
    friendNumber,
    filename,
    mime: "application/octet-stream",
    sizeBytes,
  }, session);
  assert.equal(started.response.status, 400, JSON.stringify(started.payload));
  assert.equal(started.payload?.code, expectedCode);
}

async function controlTransfer(session, transfer, action) {
  return command(session, "control_tox_file_transfer", {
    profileId: session.profileId,
    messageId: transfer.messageId,
    action,
  });
}

async function waitForIncomingOffer(session, friendNumber, filename, sizeBytes) {
  return waitFor(`incoming file offer ${filename}`, async () => {
    const messages = await command(session, "get_tox_messages", { friendNumber });
    return messages.find((message) => !message.mine
      && message.attachment?.name === filename
      && message.attachment?.size === sizeBytes
      && message.attachment?.path?.startsWith("browser-stream://"));
  });
}

async function acceptIncomingTransfer(session, message) {
  const incomingId = message.attachment.path.slice("browser-stream://".length);
  const accepted = await command(session, "control_tox_file_transfer", {
    profileId: session.profileId,
    messageId: message.id,
    action: "resume",
  });
  assert.equal(accepted.id, incomingId);
  return incomingId;
}

async function pumpOutgoing(session, transfer, payload, jitterAtBytes = null) {
  let firstRequestedAt = 0;
  let sentBytes = 0;
  let uploadedBodyBytes = 0;
  let jitterApplied = false;
  const progressSamples = new Set();
  const speedSamples = new Set();
  const etaSamples = new Set();
  const sample = (view) => {
    progressSamples.add(view.transferredBytes);
    if (view.speedBytesPerSec > 0) speedSamples.add(view.speedBytesPerSec);
    if (view.etaSeconds != null) etaSamples.add(view.etaSeconds);
  };
  while (true) {
    const status = await transferStatus(session, transfer.id);
    sample(status);
    sentBytes = Math.max(sentBytes, status.transferredBytes);
    if (status.state === "complete") {
      assert.equal(uploadedBodyBytes, payload.length,
        `${transfer.id} must upload each source byte exactly once`);
      return {
        firstRequestedAt,
        sentBytes,
        uploadedBodyBytes,
        progressSamples: [...progressSamples],
        speedSamples: [...speedSamples],
        etaSamples: [...etaSamples],
      };
    }
    assert.notEqual(status.state, "failed");
    assert.notEqual(status.state, "cancelled");
    if (status.requestedPosition == null || status.requestedLength == null) {
      await sleep(25);
      continue;
    }
    if (!firstRequestedAt) firstRequestedAt = Date.now();
    const start = status.requestedPosition;
    const end = start + status.requestedLength;
    assert.ok(end <= payload.length);
    uploadedBodyBytes += end - start;
    const result = await uploadRange(session, transfer.id, start, payload.subarray(start, end));
    if (result.stale) continue;
    sample(result.transfer);
    sentBytes = Math.max(sentBytes, result.transfer.transferredBytes);
    if (!jitterApplied && jitterAtBytes != null && sentBytes >= jitterAtBytes) {
      jitterApplied = true;
      await sleep(650);
    }
    if (result.retryAfterMs > 0) await sleep(result.retryAfterMs);
  }
}

async function pumpIncoming(session, transferId, payload, initialDelay = 0, card = null) {
  if (initialDelay > 0) await sleep(initialDelay);
  const expectedHash = createHash("sha256").update(payload).digest("hex");
  const receivedHash = createHash("sha256");
  let receivedBytes = 0;
  let committedBytes = 0;
  let maxBufferedBytes = 0;
  const cardProgressSamples = new Set();
  while (true) {
    const chunk = await downloadRange(session, transferId);
    if (chunk) {
      assert.equal(chunk.position, receivedBytes);
      if (card) {
        const messages = await command(session, "get_tox_messages", { friendNumber: card.friendNumber });
        const message = messages.find((candidate) => candidate.id === card.messageId);
        assert.equal(message?.attachment?.transferred, committedBytes,
          "receiver progress must not count bytes that only reached the server buffer");
      }
      receivedHash.update(chunk.bytes);
      receivedBytes += chunk.bytes.length;
      const acknowledged = await command(session, "acknowledge_web_incoming_chunk", {
        profileId: session.profileId,
        transferId,
        through: receivedBytes,
      });
      assert.equal(acknowledged.acknowledgedBytes, receivedBytes);
      maxBufferedBytes = Math.max(maxBufferedBytes, acknowledged.bufferedBytes);
      if (card) {
        const messages = await command(session, "get_tox_messages", { friendNumber: card.friendNumber });
        const message = messages.find((candidate) => candidate.id === card.messageId);
        assert.ok(message?.attachment, `receiver card disappeared for ${card.messageId}`);
        assert.equal(message.attachment.completed, false, "receiver cannot complete before browser confirmation");
        assert.notEqual(message.attachment.transfer_state, "complete");
        assert.equal(message.attachment.transferred, receivedBytes,
          "receiver progress must advance with browser-committed bytes");
        cardProgressSamples.add(message.attachment.transferred);
      }
      committedBytes = receivedBytes;
      if (receivedBytes === payload.length) break;
    }
    const status = await transferStatus(session, transferId);
    maxBufferedBytes = Math.max(maxBufferedBytes, status.bufferedBytes);
    assert.notEqual(status.state, "failed");
    assert.notEqual(status.state, "cancelled");
    if (!chunk) await sleep(25);
  }
  assert.equal(receivedBytes, payload.length);
  assert.equal(receivedHash.digest("hex"), expectedHash);
  const completed = await waitFor("remote completion acknowledgement", async () => {
    try {
      const result = await command(session, "complete_web_incoming_transfer", {
        profileId: session.profileId,
        transferId,
      });
      return result.state === "complete" ? result : false;
    } catch (error) {
      if (String(error).includes("TRANSFER_REMOTE_NOT_COMPLETE")) return false;
      throw error;
    }
  });
  assert.equal(completed.state, "complete");
  return { receivedBytes, maxBufferedBytes, cardProgressSamples: [...cardProgressSamples] };
}

async function waitForTerminalCards(
  sender,
  senderFriend,
  outgoingId,
  receiver,
  receiverFriend,
  incomingMessageId,
  sizeBytes,
) {
  return waitFor(`terminal file cards ${outgoingId}`, async () => {
    const [sentMessages, receivedMessages] = await Promise.all([
      command(sender, "get_tox_messages", { friendNumber: senderFriend }),
      command(receiver, "get_tox_messages", { friendNumber: receiverFriend }),
    ]);
    const sent = sentMessages.find((message) => message.mine
      && message.attachment?.path === `browser-stream://${outgoingId}`);
    const received = receivedMessages.find((message) => message.id === incomingMessageId);
    if (!sent?.attachment?.completed || sent.attachment.transfer_state !== "complete") return false;
    if (!received?.attachment?.completed || received.attachment.transfer_state !== "complete") return false;
    assert.equal(sent.attachment.transferred, sizeBytes);
    assert.equal(received.attachment.transferred, sizeBytes);
    return true;
  });
}

async function waitForCancelledCards(
  sender,
  senderFriend,
  outgoing,
  receiver,
  receiverFriend,
  incomingMessageId,
  expectedSenderError = null,
  expectedReceiverError = null,
) {
  return waitFor(`cancelled file cards ${outgoing.id}`, async () => {
    const [sentMessages, receivedMessages] = await Promise.all([
      command(sender, "get_tox_messages", { friendNumber: senderFriend }),
      command(receiver, "get_tox_messages", { friendNumber: receiverFriend }),
    ]);
    const sent = sentMessages.find((message) => message.id === outgoing.messageId);
    const received = receivedMessages.find((message) => message.id === incomingMessageId);
    if (sent?.attachment?.transfer_state !== "cancelled") return false;
    if (received?.attachment?.transfer_state !== "cancelled") return false;
    assert.equal(sent.attachment.completed, false);
    assert.equal(received.attachment.completed, false);
    assert.equal(sent.attachment.speed_bytes_per_sec, 0);
    assert.equal(received.attachment.speed_bytes_per_sec, 0);
    assert.equal(sent.attachment.eta_seconds, null);
    assert.equal(received.attachment.eta_seconds, null);
    if (expectedSenderError) assert.equal(sent.attachment.transfer_error, expectedSenderError);
    if (expectedReceiverError) assert.equal(received.attachment.transfer_error, expectedReceiverError);
    return true;
  });
}

async function assertNoIncomingCards(session, friendNumber, filenames) {
  const messages = await command(session, "get_tox_messages", { friendNumber });
  for (const filename of filenames) {
    assert.equal(
      messages.some((message) => !message.mine && message.attachment?.name === filename),
      false,
      `receiver unexpectedly saw ${filename}`,
    );
  }
}

function deterministicPayload(bytes, multiplier, increment) {
  const payload = Buffer.allocUnsafe(bytes);
  for (let index = 0; index < payload.length; index += 1) {
    payload[index] = (index * multiplier + increment) & 0xff;
  }
  return payload;
}

async function scanForPayload(root, marker, exactSize) {
  if (!root) return { files: 0, markerMatches: 0, exactSizeMatches: 0 };
  const result = { files: 0, markerMatches: 0, exactSizeMatches: 0 };
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("unexpected symlink in workspace storage");
      if (entry.isDirectory()) await visit(target);
      if (!entry.isFile()) continue;
      result.files += 1;
      const metadata = await stat(target);
      if (metadata.size === exactSize) result.exactSizeMatches += 1;
      if (metadata.size <= 8 * 1024 * 1024) {
        const bytes = await readFile(target);
        if (bytes.includes(marker)) result.markerMatches += 1;
      }
    }
  }
  await visit(root);
  return result;
}

async function assertDisposableTreesRemainRemoved(sessions) {
  assert.ok(diskRoot, "KAIGEN_E2E_DATA_ROOT is required for cleanup verification");
  assert.ok(activeRoot, "KAIGEN_E2E_ACTIVE_ROOT is required for cleanup verification");
  // The deferred persistence workers batch for at most 350 ms.  Waiting past
  // that boundary catches a late history write that recreates an erased tree.
  await sleep(750);
  const targets = sessions.flatMap((session) => {
    const directory = Buffer.from(session.selector, "base64url").toString("hex");
    return [path.join(diskRoot, directory), path.join(activeRoot, directory)];
  });
  for (const target of targets) {
    await assert.rejects(stat(target), (error) => error?.code === "ENOENT");
  }
  return {
    cleanupStorageTreesRemoved: true,
    cleanupActiveTreesRemoved: true,
  };
}

const first = await createSession("one");
const second = await createSession("two");
const sharedBrowserCookies = mergeCookieJar(first.cookie, second.cookie);
first.cookie = sharedBrowserCookies;
second.cookie = sharedBrowserCookies;
const heartbeat = setInterval(() => {
  void postJson("/api/v1/lease/heartbeat", {}, first).catch(() => {});
  void postJson("/api/v1/lease/heartbeat", {}, second).catch(() => {});
}, 15_000);
let transferSummary;
let cleanupSummary;

try {
  assert.ok(networkRoute === "direct" || networkRoute === "obfs4");
  const expectedReceiveDefaults = {
    denyAll: false,
    autoAcceptImages: true,
    showImages: true,
    autoAcceptAny: true,
    maxAutoBytes: 24 * 1024 * 1024,
    maxConcurrent: 2,
  };
  const [firstReceiveSettings, secondReceiveSettings] = await Promise.all([
    command(first, "get_file_receive_settings"),
    command(second, "get_file_receive_settings"),
  ]);
  assert.deepEqual(firstReceiveSettings, expectedReceiveDefaults);
  assert.deepEqual(secondReceiveSettings, expectedReceiveDefaults);
  const torSettings = networkRoute === "obfs4"
    ? { enabled: true, transport: "obfs4", bridgeLines: "" }
    : { enabled: false, transport: "none", bridgeLines: "" };
  await Promise.all([
    command(first, "set_tor_settings", { settings: torSettings }),
    command(second, "set_tor_settings", { settings: torSettings }),
  ]);
  if (networkRoute === "direct") {
    const proxy = { mode: "none", host: "127.0.0.1", port: 9050, username: "", password: "" };
    const network = { udpEnabled: true, ipv6Enabled: true, localDiscoveryEnabled: true };
    await Promise.all([
      command(first, "set_proxy_settings", { settings: proxy }),
      command(second, "set_proxy_settings", { settings: proxy }),
      command(first, "set_network_settings", { settings: network }),
      command(second, "set_network_settings", { settings: network }),
    ]);
  }
  assert.deepEqual(await Promise.all([
    command(first, "set_profile_user_status", { profileId: first.profileId, status: "online" }),
    command(second, "set_profile_user_status", { profileId: second.profileId, status: "online" }),
  ]), ["online", "online"]);
  let lastConnectivityReport = 0;
  await waitFor("both disposable network routes", async () => {
    const [left, right, leftTor, rightTor] = await Promise.all([
      command(first, "get_tox_network_status"),
      command(second, "get_tox_network_status"),
      command(first, "get_tor_status"),
      command(second, "get_tor_status"),
    ]);
    if (Date.now() - lastConnectivityReport >= 30_000) {
      process.stderr.write(`${JSON.stringify({
        stage: "connectivity",
        tox: [left, right],
        tor: [
          { state: leftTor.state, progress: leftTor.progress },
          { state: rightTor.state, progress: rightTor.progress },
        ],
      })}\n`);
      lastConnectivityReport = Date.now();
    }
    const toxOnline = left === "online" && right === "online";
    return networkRoute === "direct"
      ? toxOnline && leftTor.state === "disabled" && rightTor.state === "disabled"
      : toxOnline && leftTor.state === "connected" && rightTor.state === "connected";
  });

  const firstToxId = await command(first, "get_tox_id");
  const secondToxId = await command(second, "get_tox_id");
  const firstFriend = await command(first, "add_tox_friend", {
    toxId: secondToxId,
    message: "Disposable transfer verification",
  });
  const request = await waitFor("friend request", async () => {
    const requests = await command(second, "get_incoming_friend_requests");
    return requests.find((item) => item.public_key === firstToxId.slice(0, 64));
  });
  const secondFriend = await command(second, "accept_incoming_friend_request", {
    publicKey: request.public_key,
  });
  await waitFor("mutual friend connectivity", async () => {
    const [left, right] = await Promise.all([
      command(first, "get_tox_friends"),
      command(second, "get_tox_friends"),
    ]);
    const leftFriend = left.find((friend) => friend.number === firstFriend);
    const rightFriend = right.find((friend) => friend.number === secondFriend);
    if (!leftFriend || !rightFriend) return false;
    assert.equal(typeof leftFriend.public_key, "string");
    assert.equal(typeof rightFriend.public_key, "string");
    assert.equal("publicKey" in leftFriend, false);
    assert.equal("publicKey" in rightFriend, false);
    return leftFriend.connection === "online" && rightFriend.connection === "online";
  });
  await waitFor("mutual chat capabilities", async () => {
    const [left, right] = await Promise.all([
      command(first, "get_chat_capabilities", { profileId: first.profileId, friendNumber: firstFriend }),
      command(second, "get_chat_capabilities", { profileId: second.profileId, friendNumber: secondFriend }),
    ]);
    for (const capabilities of [left, right]) {
      if (capabilities.protocolVersion !== 1) return false;
      assert.equal(capabilities.stableMessageIds, true);
      assert.equal(capabilities.reactions, true);
      assert.equal(capabilities.quotes, true);
      assert.equal(capabilities.formatting, true);
    }
    return true;
  });

  const plainMarker = `kaigen-plain-${Date.now()}-${firstToxId.slice(0, 8)}`;
  await command(first, "send_tox_message", { friendNumber: firstFriend, text: plainMarker });
  await waitFor("plain Tox message delivery", async () => {
    const [left, right] = await Promise.all([
      command(first, "get_tox_messages", { friendNumber: firstFriend }),
      command(second, "get_tox_messages", { friendNumber: secondFriend }),
    ]);
    return left.some((message) => message.mine && message.text === plainMarker && message.delivery === "delivered")
      && right.some((message) => !message.mine && message.text === plainMarker);
  });

  await waitFor("mutual PQ capability", async () => {
    const [left, right] = await Promise.all([
      command(first, "get_pq_status", { friendNumber: firstFriend }),
      command(second, "get_pq_status", { friendNumber: secondFriend }),
    ]);
    return left.supported && right.supported && left.state === "available" && right.state === "available";
  });
  await command(first, "request_pq_session", { friendNumber: firstFriend });
  await waitFor("incoming PQ offer", async () => {
    const status = await command(second, "get_pq_status", { friendNumber: secondFriend });
    return status.state === "incoming_offer";
  });
  await command(second, "accept_pq_session", { friendNumber: secondFriend });
  await waitFor("active PQ session", async () => {
    const [left, right] = await Promise.all([
      command(first, "get_pq_status", { friendNumber: firstFriend }),
      command(second, "get_pq_status", { friendNumber: secondFriend }),
    ]);
    return left.state === "active" && right.state === "active"
      && typeof left.peer_fingerprint === "string"
      && typeof right.peer_fingerprint === "string";
  });

  const pqMarker = `kaigen-pq-${Date.now()}-${secondToxId.slice(0, 8)}`;
  await command(first, "send_tox_message", { friendNumber: firstFriend, text: pqMarker });
  await waitFor("post-quantum message delivery", async () => {
    const [left, right] = await Promise.all([
      command(first, "get_tox_messages", { friendNumber: firstFriend }),
      command(second, "get_tox_messages", { friendNumber: secondFriend }),
    ]);
    const activeEvents = [...left, ...right].filter((message) => message.event?.kind === "pq" && message.event.status === "active");
    return activeEvents.length >= 2
      && left.some((message) => message.mine && message.text === pqMarker && message.delivery === "delivered")
      && right.some((message) => !message.mine && message.text === pqMarker);
  });

  const [pqSenderHistory, pqReceiverHistory] = await Promise.all([
    command(first, "get_tox_messages", { profileId: first.profileId, friendNumber: firstFriend }),
    command(second, "get_tox_messages", { profileId: second.profileId, friendNumber: secondFriend }),
  ]);
  const pqSenderMessage = pqSenderHistory.find((message) => message.mine && message.text === pqMarker);
  const pqReceiverMessage = pqReceiverHistory.find((message) => !message.mine && message.text === pqMarker);
  assert.match(pqSenderMessage?.id ?? "", /^[a-f0-9]{32}$/u);
  assert.equal(pqReceiverMessage?.id, pqSenderMessage.id);

  const unreadBeforeAcknowledge = await command(second, "get_unread_state", {
    profileId: second.profileId,
  });
  const unreadKey = String(secondFriend);
  const unreadBeforeCount = unreadBeforeAcknowledge.friends[unreadKey] ?? 0;
  assert.ok(unreadBeforeCount >= 1);
  const unreadAfterAcknowledge = await command(second, "acknowledge_local_messages", {
    profileId: second.profileId,
    friendNumber: secondFriend,
    messageIds: [pqReceiverMessage.id],
  });
  assert.equal(unreadAfterAcknowledge.friends[unreadKey] ?? 0, unreadBeforeCount - 1);

  const reaction = await command(second, "set_message_reactions", {
    profileId: second.profileId,
    friendNumber: secondFriend,
    messageId: pqReceiverMessage.id,
    reactions: ["heart"],
    operationId: `web-transfer-reaction-${Date.now()}`,
  });
  assert.deepEqual(reaction.mine, ["heart"]);
  assert.equal(await command(second, "release_chat_history", {
    profileId: second.profileId,
    friendNumber: secondFriend,
    viewLeaseId: "web-transfer-smoke:1",
  }), null);
  await waitFor("reaction delivery after history release", async () => {
    const [left, right, unread] = await Promise.all([
      command(first, "get_tox_messages", { profileId: first.profileId, friendNumber: firstFriend }),
      command(second, "get_tox_messages", { profileId: second.profileId, friendNumber: secondFriend }),
      command(second, "get_unread_state", { profileId: second.profileId }),
    ]);
    const leftTarget = left.find((message) => message.id === pqSenderMessage.id);
    const rightTarget = right.find((message) => message.id === pqReceiverMessage.id);
    return leftTarget?.reactions?.peer?.includes("heart")
      && rightTarget?.reactions?.mine?.includes("heart")
      && (unread.friends[unreadKey] ?? 0) === unreadBeforeCount - 1;
  });

  const payload = Buffer.allocUnsafe(payloadBytes);
  for (let index = 0; index < payload.length; index += 1) payload[index] = (index * 31 + 17) & 0xff;
  const marker = createHash("sha256").update("kaigen-disposable-transfer-marker").digest();
  marker.copy(payload, 0);
  marker.copy(payload, payload.length - marker.length);
  const outgoing = await beginTransfer(first, firstFriend, "first-same-direction.aup3", payload);
  const sameDirectionPayload = Buffer.allocUnsafe(384 * 1024 + 71);
  for (let index = 0; index < sameDirectionPayload.length; index += 1) {
    sameDirectionPayload[index] = (index * 23 + 41) & 0xff;
  }
  const sameDirectionOutgoing = await beginTransfer(
    first,
    firstFriend,
    "second-same-direction.aup3",
    sameDirectionPayload,
  );
  const sameDirectionOutgoingPump = pumpOutgoing(first, sameDirectionOutgoing, sameDirectionPayload);
  assert.equal((await transferStatus(first, sameDirectionOutgoing.id)).state, "queued");
  const incomingMessage = await waitForIncomingOffer(
    second,
    secondFriend,
    "first-same-direction.aup3",
    payload.length,
  );
  const incomingId = await acceptIncomingTransfer(second, incomingMessage);

  const primaryOutgoingPump = pumpOutgoing(first, outgoing, payload);
  const primaryIncomingPump = pumpIncoming(second, incomingId, payload, 750);
  await waitFor("active file transfer before concurrent PQ message", async () => {
    const status = await transferStatus(first, outgoing.id);
    return status.transferredBytes > 0 && status.transferredBytes < payload.length;
  });
  const concurrentPqMarker = `kaigen-pq-during-file-${Date.now()}`;
  await command(first, "send_tox_message", { friendNumber: firstFriend, text: concurrentPqMarker });
  await waitFor("PQ message delivery during active file transfer", async () => {
    const messages = await command(second, "get_tox_messages", { friendNumber: secondFriend });
    return messages.some((message) => !message.mine && message.text === concurrentPqMarker);
  });
  const [primaryOutgoing, primaryIncoming] = await Promise.all([
    primaryOutgoingPump,
    // Let a small real buffer form; the unit test separately exercises the
    // full 25 MiB threshold without making this network smoke unnecessarily long.
    primaryIncomingPump,
  ]);
  const completedAt = Date.now();
  assert.equal(primaryOutgoing.sentBytes, payload.length);
  assert.equal(primaryIncoming.receivedBytes, payload.length);
  assert.ok(primaryOutgoing.firstRequestedAt > 0);
  const measuredBytesPerSecond = payload.length
    / ((completedAt - primaryOutgoing.firstRequestedAt) / 1000);
  assert.ok(measuredBytesPerSecond <= rateLimit * 1.05, `measured rate ${measuredBytesPerSecond}`);
  await waitForTerminalCards(
    first,
    firstFriend,
    outgoing.id,
    second,
    secondFriend,
    incomingMessage.id,
    payload.length,
  );

  const sameDirectionIncomingMessage = await waitForIncomingOffer(
    second,
    secondFriend,
    "second-same-direction.aup3",
    sameDirectionPayload.length,
  );
  const sameDirectionIncomingId = await acceptIncomingTransfer(second, sameDirectionIncomingMessage);
  const [sameDirectionSent, sameDirectionReceived] = await Promise.all([
    sameDirectionOutgoingPump,
    pumpIncoming(second, sameDirectionIncomingId, sameDirectionPayload),
  ]);
  assert.equal(sameDirectionSent.sentBytes, sameDirectionPayload.length);
  assert.equal(sameDirectionReceived.receivedBytes, sameDirectionPayload.length);
  await waitForTerminalCards(
    first,
    firstFriend,
    sameDirectionOutgoing.id,
    second,
    secondFriend,
    sameDirectionIncomingMessage.id,
    sameDirectionPayload.length,
  );

  // Exercise the reverse direction only after the two same-direction files
  // have drained. Queueing it earlier would intentionally put it ahead of the
  // second incoming offer in the receiver's one-slot workspace and deadlock
  // the test harness itself rather than the product.
  const reversePayload = Buffer.allocUnsafe(256 * 1024 + 113);
  for (let index = 0; index < reversePayload.length; index += 1) {
    reversePayload[index] = (index * 17 + 29) & 0xff;
  }
  const reverseOutgoing = await beginTransfer(
    second,
    secondFriend,
    "queued-reply.bin",
    reversePayload,
  );
  const reverseOutgoingPump = pumpOutgoing(second, reverseOutgoing, reversePayload);

  const reverseIncomingMessage = await waitForIncomingOffer(
    first,
    firstFriend,
    "queued-reply.bin",
    reversePayload.length,
  );
  const reverseIncomingId = await acceptIncomingTransfer(first, reverseIncomingMessage);
  const [reverseSent, reverseReceived] = await Promise.all([
    reverseOutgoingPump,
    pumpIncoming(first, reverseIncomingId, reversePayload),
  ]);
  assert.equal(reverseSent.sentBytes, reversePayload.length);
  await waitForTerminalCards(
    second,
    secondFriend,
    reverseOutgoing.id,
    first,
    firstFriend,
    reverseIncomingMessage.id,
    reversePayload.length,
  );

  // A third transfer exercises the next native file-number lifecycle after
  // the mixed-direction queue was fully drained.
  const finalPayload = Buffer.allocUnsafe(128 * 1024 + 37);
  for (let index = 0; index < finalPayload.length; index += 1) {
    finalPayload[index] = (index * 43 + 7) & 0xff;
  }
  const finalOutgoing = await beginTransfer(
    first,
    firstFriend,
    "third-sequential.bin",
    finalPayload,
  );
  const finalOutgoingPump = pumpOutgoing(first, finalOutgoing, finalPayload);
  const finalIncomingMessage = await waitForIncomingOffer(
    second,
    secondFriend,
    "third-sequential.bin",
    finalPayload.length,
  );
  const finalIncomingId = await acceptIncomingTransfer(second, finalIncomingMessage);
  const [finalSent, finalReceived] = await Promise.all([
    finalOutgoingPump,
    pumpIncoming(second, finalIncomingId, finalPayload),
  ]);
  assert.equal(finalSent.sentBytes, finalPayload.length);
  await waitForTerminalCards(
    first,
    firstFriend,
    finalOutgoing.id,
    second,
    secondFriend,
    finalIncomingMessage.id,
    finalPayload.length,
  );

  // Reproduce the reported Audacity-project case with the exact supplied
  // 1.aup3 size. The optional path lets the Web Lab run against the user's
  // actual file; deterministic bytes keep the same boundary coverage in CI.
  const exactAup3Payload = exactAup3Path
    ? await readFile(exactAup3Path)
    : deterministicPayload(exactAup3Bytes, 47, 13);
  assert.equal(exactAup3Payload.length, exactAup3Bytes, "1.aup3 size drift");

  // 2.aup3 is 38,572,032 bytes: it must be rejected before a message or Tox
  // offer is created, while later valid files remain independently usable.
  await expectBeginTransferRejected(
    first,
    firstFriend,
    "2.aup3",
    oversizedAup3Bytes,
    "TRANSFER_FILE_TOO_LARGE",
  );
  await assertNoIncomingCards(second, secondFriend, ["2.aup3"]);

  const batch = [
    {
      name: "cancel-first.bin",
      mime: "application/octet-stream",
      payload: deterministicPayload(96 * 1024 + 3, 5, 19),
    },
    {
      name: "1.aup3",
      mime: "application/x-audacity-project",
      payload: exactAup3Payload,
    },
    {
      name: "cancel-middle.txt",
      mime: "text/plain",
      payload: Buffer.from("This queued text file is intentionally cancelled.\n", "utf8"),
    },
    {
      name: "matrix-photo.jpg",
      mime: "image/jpeg",
      payload: deterministicPayload(192 * 1024 + 29, 11, 31),
    },
    {
      name: "cancel-last.zip",
      mime: "application/zip",
      payload: Buffer.from("504b0506000000000000000000000000000000000000", "hex"),
    },
  ];
  const batchTransfers = [];
  for (const item of batch) {
    batchTransfers.push(await beginTransfer(first, firstFriend, item.name, item.payload, item.mime));
  }
  const queuedStates = await Promise.all(batchTransfers.slice(1).map((transfer) => transferStatus(first, transfer.id)));
  assert.ok(queuedStates.every((view) => view.state === "queued"));
  await expectBeginTransferRejected(
    first,
    firstFriend,
    "sixth.png",
    1024,
    "TRANSFER_QUEUE_LIMIT",
  );
  await assertNoIncomingCards(second, secondFriend, ["sixth.png"]);

  const cancelledFirstOffer = await waitForIncomingOffer(
    second,
    secondFriend,
    batch[0].name,
    batch[0].payload.length,
  );
  assert.equal(cancelledFirstOffer.attachment.transferred, 0);
  assert.equal(cancelledFirstOffer.attachment.completed, false);

  await command(first, "request_pq_shutdown", { friendNumber: firstFriend });
  await waitFor("PQ shutdown while the file queue is occupied", async () => {
    const [left, right] = await Promise.all([
      command(first, "get_pq_status", { friendNumber: firstFriend }),
      command(second, "get_pq_status", { friendNumber: secondFriend }),
    ]);
    return left.state === "available" && right.state === "available";
  });

  // Cancel the first active item plus the middle and last queued items. None
  // may leave a spinner, retain a bridge slot, or reorder the two survivors.
  await controlTransfer(first, batchTransfers[2], "cancel");
  await controlTransfer(first, batchTransfers[4], "cancel");
  await controlTransfer(first, batchTransfers[0], "cancel");
  await waitForCancelledCards(
    first,
    firstFriend,
    batchTransfers[0],
    second,
    secondFriend,
    cancelledFirstOffer.id,
    null,
    "TRANSFER_CANCELLED_BY_SENDER",
  );
  await waitFor("queued middle/last cards become terminal", async () => {
    const messages = await command(first, "get_tox_messages", { friendNumber: firstFriend });
    return [batchTransfers[2], batchTransfers[4]].every((transfer) => {
      const message = messages.find((candidate) => candidate.id === transfer.messageId);
      if (message?.attachment?.transfer_state !== "cancelled") return false;
      assert.equal(message.attachment.completed, false);
      assert.equal(message.attachment.speed_bytes_per_sec, 0);
      assert.equal(message.attachment.eta_seconds, null);
      return true;
    });
  });

  const exactOutgoingPump = pumpOutgoing(
    first,
    batchTransfers[1],
    exactAup3Payload,
    Math.floor(exactAup3Payload.length / 3),
  );
  const exactIncomingMessage = await waitForIncomingOffer(
    second,
    secondFriend,
    batch[1].name,
    exactAup3Payload.length,
  );
  const exactIncomingId = await acceptIncomingTransfer(second, exactIncomingMessage);
  await command(second, "request_pq_session", { friendNumber: secondFriend });
  await waitFor("reverse PQ offer during queued file transfer", async () => {
    const status = await command(first, "get_pq_status", { friendNumber: firstFriend });
    return status.state === "incoming_offer";
  });
  await command(first, "accept_pq_session", { friendNumber: firstFriend });
  await waitFor("reverse PQ handshake during active file transfer", async () => {
    const [left, right] = await Promise.all([
      command(first, "get_pq_status", { friendNumber: firstFriend }),
      command(second, "get_pq_status", { friendNumber: secondFriend }),
    ]);
    return left.state === "active" && right.state === "active";
  });
  const [exactSent, exactReceived] = await Promise.all([
    exactOutgoingPump,
    pumpIncoming(second, exactIncomingId, exactAup3Payload, 0, {
      friendNumber: secondFriend,
      messageId: exactIncomingMessage.id,
    }),
  ]);
  assert.equal(exactSent.sentBytes, exactAup3Payload.length);
  assert.equal(exactReceived.receivedBytes, exactAup3Payload.length);
  assert.ok(exactSent.progressSamples.filter((value) => value > 0).length >= 2,
    "sender progress must update throughout 1.aup3");
  assert.ok(exactSent.speedSamples.some((value) => value > 0),
    "sender speed must be measured for 1.aup3");
  assert.ok(exactSent.etaSamples.length >= 2,
    "sender ETA must be recalculated as 1.aup3 advances");
  assert.ok(exactReceived.cardProgressSamples.some((value) => value > 0),
    "receiver card must advance before completion");
  await waitForTerminalCards(
    first,
    firstFriend,
    batchTransfers[1].id,
    second,
    secondFriend,
    exactIncomingMessage.id,
    exactAup3Payload.length,
  );

  const photoOutgoingPump = pumpOutgoing(first, batchTransfers[3], batch[3].payload);
  const photoIncomingMessage = await waitForIncomingOffer(
    second,
    secondFriend,
    batch[3].name,
    batch[3].payload.length,
  );
  const photoIncomingId = await acceptIncomingTransfer(second, photoIncomingMessage);
  const [photoSent, photoReceived] = await Promise.all([
    photoOutgoingPump,
    pumpIncoming(second, photoIncomingId, batch[3].payload),
  ]);
  assert.equal(photoSent.sentBytes, batch[3].payload.length);
  assert.equal(photoReceived.receivedBytes, batch[3].payload.length);
  await waitForTerminalCards(
    first,
    firstFriend,
    batchTransfers[3].id,
    second,
    secondFriend,
    photoIncomingMessage.id,
    batch[3].payload.length,
  );
  await assertNoIncomingCards(second, secondFriend, [batch[2].name, batch[4].name]);

  // A receiver-side refusal must reach the sender as a terminal state and
  // release the queue for the following image without manual intervention.
  const rejectedPayload = deterministicPayload(128 * 1024 + 17, 7, 23);
  const afterRejectionPayload = deterministicPayload(160 * 1024 + 11, 13, 37);
  const rejectedOutgoing = await beginTransfer(
    first,
    firstFriend,
    "receiver-reject.dat",
    rejectedPayload,
  );
  const afterRejectionOutgoing = await beginTransfer(
    first,
    firstFriend,
    "after-rejection.png",
    afterRejectionPayload,
    "image/png",
  );
  assert.equal((await transferStatus(first, afterRejectionOutgoing.id)).state, "queued");
  const rejectedIncomingMessage = await waitForIncomingOffer(
    second,
    secondFriend,
    "receiver-reject.dat",
    rejectedPayload.length,
  );
  await controlTransfer(second, {
    id: rejectedIncomingMessage.attachment.path.slice("browser-stream://".length),
    messageId: rejectedIncomingMessage.id,
  }, "cancel");
  await waitFor("sender observes receiver rejection", async () => {
    const status = await transferStatus(first, rejectedOutgoing.id);
    return status.state === "cancelled";
  });
  await waitForCancelledCards(
    first,
    firstFriend,
    rejectedOutgoing,
    second,
    secondFriend,
    rejectedIncomingMessage.id,
    "TRANSFER_REJECTED_BY_RECIPIENT",
  );

  const afterRejectionPump = pumpOutgoing(first, afterRejectionOutgoing, afterRejectionPayload);
  const afterRejectionIncomingMessage = await waitForIncomingOffer(
    second,
    secondFriend,
    "after-rejection.png",
    afterRejectionPayload.length,
  );
  const afterRejectionIncomingId = await acceptIncomingTransfer(second, afterRejectionIncomingMessage);
  const [afterRejectionSent, afterRejectionReceived] = await Promise.all([
    afterRejectionPump,
    pumpIncoming(second, afterRejectionIncomingId, afterRejectionPayload),
  ]);
  assert.equal(afterRejectionSent.sentBytes, afterRejectionPayload.length);
  assert.equal(afterRejectionReceived.receivedBytes, afterRejectionPayload.length);
  await waitForTerminalCards(
    first,
    firstFriend,
    afterRejectionOutgoing.id,
    second,
    secondFriend,
    afterRejectionIncomingMessage.id,
    afterRejectionPayload.length,
  );

  const maxBufferedBytes = Math.max(
    primaryIncoming.maxBufferedBytes,
    sameDirectionReceived.maxBufferedBytes,
    reverseReceived.maxBufferedBytes,
    finalReceived.maxBufferedBytes,
    exactReceived.maxBufferedBytes,
    photoReceived.maxBufferedBytes,
    afterRejectionReceived.maxBufferedBytes,
  );
  assert.ok(maxBufferedBytes <= 25 * 1024 * 1024);

  const [diskScan, activeScan] = await Promise.all([
    scanForPayload(diskRoot, marker, payload.length),
    scanForPayload(activeRoot, marker, payload.length),
  ]);
  assert.equal(diskScan.markerMatches + activeScan.markerMatches, 0);
  assert.equal(diskScan.exactSizeMatches + activeScan.exactSizeMatches, 0);

  await command(first, "request_pq_shutdown", { friendNumber: firstFriend });
  await waitFor("coordinated PQ shutdown", async () => {
    const [left, right] = await Promise.all([
      command(first, "get_pq_status", { friendNumber: firstFriend }),
      command(second, "get_pq_status", { friendNumber: secondFriend }),
    ]);
    return left.state === "available" && right.state === "available";
  });

  transferSummary = {
    ok: true,
    bytes: payload.length
      + sameDirectionPayload.length
      + reversePayload.length
      + finalPayload.length
      + exactAup3Payload.length
      + batch[3].payload.length
      + afterRejectionPayload.length,
    completedTransfers: 7,
    cancelledTransfers: 4,
    rejectedBeforeQueue: 2,
    queuedSameDirection: true,
    mixedFiveFileBatch: true,
    cancellationPositions: ["first", "middle", "last"],
    receiverRejectionReleasedQueue: true,
    pqMessageDuringTransfer: true,
    pqShutdownWithOccupiedQueue: true,
    reversePqHandshakeDuringTransfer: true,
    chatCommandParity: true,
    terminalCards: 20,
    measuredBytesPerSecond: Math.round(measuredBytesPerSecond),
    maxBufferedBytes,
    persistedFilesInspected: diskScan.files + activeScan.files,
    networkRoute,
    storageMode,
    exactAup3Source: exactAup3Path ? "provided" : "size-equivalent-fixture",
    checks: 121,
  };
} finally {
  clearInterval(heartbeat);
  const cleanup = await Promise.allSettled([
    archiveAndEraseDisposableWorkspace(first, "one"),
    archiveAndEraseDisposableWorkspace(second, "two"),
  ]);
  const cleanupErrors = cleanup
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason instanceof Error ? result.reason.message : String(result.reason));
  assert.deepEqual(cleanupErrors, [], `disposable workspace cleanup failed: ${cleanupErrors.join("; ")}`);
  cleanupSummary = await assertDisposableTreesRemainRemoved([first, second]);
}

process.stdout.write(`${JSON.stringify({ ...transferSummary, ...cleanupSummary })}\n`);
