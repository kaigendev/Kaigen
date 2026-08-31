import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

const baseUrl = process.env.KAIGEN_E2E_BASE_URL ?? "http://127.0.0.1:8787";
const publicOrigin = process.env.KAIGEN_E2E_PUBLIC_ORIGIN ?? "https://web.kaigen.one";
const diskRoot = process.env.KAIGEN_E2E_DATA_ROOT;
const activeRoot = process.env.KAIGEN_E2E_ACTIVE_ROOT;
const networkRoute = process.env.KAIGEN_E2E_NETWORK_ROUTE ?? "direct";
const payloadBytes = 3 * 1024 * 1024 + 12_345;
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
    storageMode: "disk",
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
  await command(session, "create_profile", {
    name: `Disposable Transfer ${suffix}`,
    password: profilePassword,
  });
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

async function beginTransfer(session, friendNumber, filename, payload) {
  const started = await postJson("/api/v1/transfers/outgoing", {
    friendNumber,
    filename,
    mime: "application/octet-stream",
    sizeBytes: payload.length,
  }, session);
  assert.equal(started.response.status, 200, JSON.stringify(started.payload));
  return started.payload;
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
    messageId: message.id,
    action: "resume",
  });
  assert.equal(accepted.id, incomingId);
  return incomingId;
}

async function pumpOutgoing(session, transfer, payload) {
  let firstRequestedAt = 0;
  let sentBytes = 0;
  while (true) {
    const status = await transferStatus(session, transfer.id);
    sentBytes = Math.max(sentBytes, status.transferredBytes);
    if (status.state === "complete") return { firstRequestedAt, sentBytes };
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
    const result = await uploadRange(session, transfer.id, start, payload.subarray(start, end));
    if (result.stale) continue;
    sentBytes = Math.max(sentBytes, result.transfer.transferredBytes);
    if (result.retryAfterMs > 0) await sleep(result.retryAfterMs);
  }
}

async function pumpIncoming(session, transferId, payload, initialDelay = 0) {
  if (initialDelay > 0) await sleep(initialDelay);
  const expectedHash = createHash("sha256").update(payload).digest("hex");
  const receivedHash = createHash("sha256");
  let receivedBytes = 0;
  let maxBufferedBytes = 0;
  while (true) {
    const chunk = await downloadRange(session, transferId);
    if (chunk) {
      assert.equal(chunk.position, receivedBytes);
      receivedHash.update(chunk.bytes);
      receivedBytes += chunk.bytes.length;
    }
    const status = await transferStatus(session, transferId);
    maxBufferedBytes = Math.max(maxBufferedBytes, status.bufferedBytes);
    if (status.state === "complete") {
      assert.equal(receivedBytes, payload.length);
      assert.equal(receivedHash.digest("hex"), expectedHash);
      return { receivedBytes, maxBufferedBytes };
    }
    assert.notEqual(status.state, "failed");
    assert.notEqual(status.state, "cancelled");
    if (!chunk) await sleep(25);
  }
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

const first = await createSession("one");
const second = await createSession("two");
const sharedBrowserCookies = mergeCookieJar(first.cookie, second.cookie);
first.cookie = sharedBrowserCookies;
second.cookie = sharedBrowserCookies;
const heartbeat = setInterval(() => {
  void postJson("/api/v1/lease/heartbeat", {}, first).catch(() => {});
  void postJson("/api/v1/lease/heartbeat", {}, second).catch(() => {});
}, 15_000);

try {
  assert.ok(networkRoute === "direct" || networkRoute === "obfs4");
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

  const payload = Buffer.allocUnsafe(payloadBytes);
  for (let index = 0; index < payload.length; index += 1) payload[index] = (index * 31 + 17) & 0xff;
  const marker = createHash("sha256").update("kaigen-disposable-transfer-marker").digest();
  marker.copy(payload, 0);
  marker.copy(payload, payload.length - marker.length);
  const outgoing = await beginTransfer(first, firstFriend, "disposable-stream.bin", payload);
  const incomingMessage = await waitForIncomingOffer(
    second,
    secondFriend,
    "disposable-stream.bin",
    payload.length,
  );
  const incomingId = await acceptIncomingTransfer(second, incomingMessage);

  // Queue the reverse direction while the receiver still owns the workspace
  // transfer slot. It must remain queued and start only after the incoming
  // terminal state has advanced both bridge and domain coordinators.
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
  const reverseQueued = await transferStatus(second, reverseOutgoing.id);
  assert.equal(reverseQueued.state, "queued");

  const [primaryOutgoing, primaryIncoming] = await Promise.all([
    pumpOutgoing(first, outgoing, payload),
    // Let a small real buffer form; the unit test separately exercises the
    // full 25 MiB threshold without making this network smoke unnecessarily long.
    pumpIncoming(second, incomingId, payload, 750),
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

  const maxBufferedBytes = Math.max(
    primaryIncoming.maxBufferedBytes,
    reverseReceived.maxBufferedBytes,
    finalReceived.maxBufferedBytes,
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

  process.stdout.write(`${JSON.stringify({
    ok: true,
    bytes: payload.length + reversePayload.length + finalPayload.length,
    transfers: 3,
    queuedReverseDirection: true,
    terminalCards: 6,
    measuredBytesPerSecond: Math.round(measuredBytesPerSecond),
    maxBufferedBytes,
    persistedFilesInspected: diskScan.files + activeScan.files,
    networkRoute,
    checks: 44,
  })}\n`);
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
}
