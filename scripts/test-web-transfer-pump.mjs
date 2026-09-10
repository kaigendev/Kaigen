import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { importTypeScriptModule } from "./import-typescript-module.mjs";

const {
  incomingBrowserCommitComplete,
  outgoingUploadRange,
  isRetryableTransferFailure,
  retryTransferOperation,
  transferFailureCode,
  transferRetryDelay,
  transferPayloadSha256,
  verifyTransferPayload,
} = await importTypeScriptModule(new URL("../src/web/transferPump.ts", import.meta.url));

const payload = new Blob([new Uint8Array([1, 2, 3, 4])]);
const digest = await transferPayloadSha256(payload);
assert.equal(incomingBrowserCommitComplete(4, 4, true, digest), true);
assert.equal(incomingBrowserCommitComplete(4, 4, false, digest), false, "a complete browser copy cannot substitute for backend commit");
assert.equal(incomingBrowserCommitComplete(3, 4, true, digest), false);
assert.equal(incomingBrowserCommitComplete(4, 4, true, null), false);
await verifyTransferPayload(payload, 4, digest);
await assert.rejects(verifyTransferPayload(new Blob([new Uint8Array([4, 3, 2, 1])]), 4, digest), /TRANSFER_HASH_MISMATCH/u, "equal lengths do not authenticate cached bytes");
assert.deepEqual(outgoingUploadRange(0, 2_000_000), { position: 0, length: 1_048_576 });
assert.deepEqual(outgoingUploadRange(1_999_999, 2_000_000), { position: 1_999_999, length: 1 });
assert.equal(outgoingUploadRange(4, 4), null);
for (const offset of [-1, 5, NaN, 0.5]) assert.throws(() => outgoingUploadRange(offset, 4), /TRANSFER_CHUNK_RANGE_INVALID/u);

assert.equal(transferFailureCode(new Error(" TOX_BUSY ")), "TOX_BUSY");
assert.equal(transferFailureCode("Error: STATE_UNAVAILABLE"), "STATE_UNAVAILABLE");
assert.equal(isRetryableTransferFailure(new Error("TRANSFER_CANCELLED")), false);
assert.equal(isRetryableTransferFailure(new Error("TRANSFER_CHUNK_RANGE_INVALID")), false);
assert.equal(isRetryableTransferFailure(new Error("TRANSFER_HASH_MISMATCH")), false);
assert.equal(isRetryableTransferFailure(new Error("TRANSFER_STORAGE_CONFLICT")), false);
assert.equal(isRetryableTransferFailure(new Error("WORKSPACE_QUOTA_FULL")), false);
assert.equal(isRetryableTransferFailure(new Error("TRANSFER_STORAGE_BUSY")), true);
for (const code of ["PERSIST_FAILED", "RUNTIME_LOCKED", "TOX_BUSY", "TRANSFER_STORAGE_UNAVAILABLE"]) {
  assert.equal(isRetryableTransferFailure(new Error(code)), true, `${code} remains transient`);
}
assert.equal(isRetryableTransferFailure(new TypeError("Failed to fetch")), true);
assert.equal(isRetryableTransferFailure(new Error("HTTP_503")), true);
assert.deepEqual(
  [0, 1, 2, 3, 4, 5, 9].map(transferRetryDelay),
  [100, 200, 400, 800, 1_600, 2_000, 2_000],
);

{
  let attempts = 0;
  const waits = [];
  const result = await retryTransferOperation(async () => {
    attempts += 1;
    if (attempts < 4) throw new TypeError("Failed to fetch");
    return "complete";
  }, { wait: async (milliseconds) => waits.push(milliseconds) });
  assert.equal(result, "complete");
  assert.equal(attempts, 4);
  assert.deepEqual(waits, [100, 200, 400]);
}

{
  let attempts = 0;
  await assert.rejects(
    retryTransferOperation(async () => {
      attempts += 1;
      throw new Error("TRANSFER_CANCELLED");
    }, { wait: async () => {} }),
    /TRANSFER_CANCELLED/u,
  );
  assert.equal(attempts, 1, "an explicit terminal state must never be retried");
}

{
  let active = true;
  let attempts = 0;
  await assert.rejects(
    retryTransferOperation(async () => {
      attempts += 1;
      throw new Error("STATE_UNAVAILABLE");
    }, {
      active: () => active,
      wait: async () => { active = false; },
    }),
    /TRANSFER_PUMP_STOPPED/u,
  );
  assert.equal(attempts, 1, "session teardown must stop a retrying browser pump");
}

{
  let active = true;
  await assert.rejects(retryTransferOperation(async () => {
    active = false;
    return "late success";
  }, { active: () => active }), /TRANSFER_PUMP_STOPPED/u,
  "a successful response arriving after teardown must not resume consumer side effects");
}

// Execute the actual WebSession with only browser I/O replaced. Transport and
// OPFS observations below catch sequencing and reload bugs that source regexes
// cannot distinguish from a working implementation.
function memoryStorage() {
  const files = new Map();
  function directory(prefix = "") {
    return {
      async getDirectoryHandle(name) { return directory(`${prefix}${name}/`); },
      async getFileHandle(name, options = {}) {
        const key = `${prefix}${name}`;
        if (!files.has(key)) {
          if (!options.create) throw new DOMException("Missing file", "NotFoundError");
          files.set(key, new Uint8Array());
        }
        return {
          async getFile() { return new File([files.get(key)], name); },
          async createWritable(options = {}) {
            let bytes = options.keepExistingData ? files.get(key).slice() : new Uint8Array();
            return {
              async write(value) {
                const positioned = value?.type === "write";
                const offset = positioned ? value.position : 0;
                const data = positioned ? value.data : value;
                const part = new Uint8Array(await new Blob([data]).arrayBuffer());
                const merged = new Uint8Array(Math.max(bytes.length, offset + part.length));
                merged.set(bytes); merged.set(part, offset); bytes = merged;
              },
              async close() { files.set(key, bytes); },
              async abort() {},
            };
          },
        };
      },
      async removeEntry(name, options = {}) {
        const key = `${prefix}${name}`;
        files.delete(key);
        if (options.recursive) for (const candidate of files.keys()) {
          if (candidate.startsWith(`${key}/`)) files.delete(candidate);
        }
      },
    };
  }
  return { files, root: directory() };
}

const compiledRoot = mkdtempSync(path.join(tmpdir(), "kaigen-browser-pump-"));
process.on("exit", () => rmSync(compiledRoot, { recursive: true, force: true }));
const compile = spawnSync(process.execPath, [
  fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url)),
  "--ignoreConfig", fileURLToPath(new URL("../src/web/session.ts", import.meta.url)),
  "--module", "esnext", "--moduleResolution", "bundler",
  "--target", "es2020", "--outDir", compiledRoot, "--skipLibCheck", "--pretty", "false",
], { encoding: "utf8" });
assert.equal(compile.status, 0, `${compile.stdout}${compile.stderr}`);

function loadSession(storage, downloads = [], browserIo = {}) {
  const modules = new Map();
  const browser = new EventTarget();
  browser.setTimeout = (fn) => { fn(); return 0; };
  browser.clearTimeout = () => {};
  browser.clearInterval = () => {};
  browser.setInterval = browserIo.setInterval ?? (() => 0);
  const shared = {
    Blob, File, crypto, btoa, atob, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer,
    Response, Headers, Request, Event, CustomEvent, DOMException, URL,
    setTimeout: browserIo.setTimeout ?? setTimeout, clearTimeout: browserIo.clearTimeout ?? clearTimeout,
    fetch: browserIo.fetch, indexedDB: browserIo.indexedDB,
    window: browser, navigator: { storage: { getDirectory: async () => storage.root } },
    document: { createElement: () => ({ click() { downloads.push(this.download); }, remove() {} }), body: { append() {}, appendChild() {} } },
    __KAIGEN_WEB_BUILD_ID__: "test-build", console,
  };
  function load(file) {
    const resolved = path.resolve(file);
    if (modules.has(resolved)) return modules.get(resolved).exports;
    const module = { exports: {} }; modules.set(resolved, module);
    const names = [];
    // Only module linkage changes for the VM; function/class bodies are the
    // exact compiler output. Unexpected module syntax fails evaluation.
    const source = readFileSync(resolved, "utf8")
      .replace(/import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["'];/gu, (_all, bindings, specifier) =>
        `const {${bindings.replace(/\b(\w+)\s+as\s+(\w+)/gu, "$1: $2")}} = require(${JSON.stringify(specifier)});`)
      .replace(/export\s+((?:async\s+)?(?:function|class|const|let|var)\s+(\w+))/gu, (_all, declaration, name) => {
        names.push(name); return declaration;
      });
    const localRequire = (specifier) => {
      assert.ok(specifier.startsWith("."), `unexpected browser dependency ${specifier}`);
      return load(path.resolve(path.dirname(resolved), `${specifier}.js`));
    };
    vm.runInNewContext(`${source}\nObject.assign(exports, { ${names.join(", ")} });`, { ...shared, module, exports: module.exports, require: localRequire }, { filename: resolved });
    return module.exports;
  }
  const session = load(path.join(compiledRoot, "web", "session.js")).webSession;
  session.workspaceDigest = async () => "workspace-fixture";
  return session;
}

const storage = memoryStorage();
const outgoingSession = loadSession(storage);
let outgoing;
let beginAttempts = 0;
let uploadAttempts = 0;
let durableWrites = 0;
outgoingSession.request = async (url, init) => {
  assert.equal(url, "/api/v1/transfers/outgoing");
  const begin = JSON.parse(init.body);
  const key = `.kaigen-transfer-cache/workspace-fixture/${begin.operationId}.payload`;
  assert.deepEqual(storage.files.get(key), new Uint8Array([1, 2, 3, 4]), "the complete source must exist before begin can succeed or lose its response");
  assert.equal(begin.sha256, digest);
  beginAttempts += 1;
  if (outgoing) assert.equal(begin.operationId, outgoing.operationId, "lost begin response reuses the operation identity");
  outgoing ??= { id: "t".repeat(32), messageId: "message", profileId: "profile", operationId: begin.operationId,
    name: "fixture.bin", mime: "application/octet-stream", sizeBytes: 4, direction: "outgoing", state: "uploading",
    uploadedBytes: 0, persistedBytes: 0, payloadCommitted: false, payloadSha256: null, downloadAvailable: false };
  if (beginAttempts === 1) throw new TypeError("Failed to fetch");
  return { ...outgoing };
};
outgoingSession.transferStatus = async () => ({ ...outgoing });
outgoingSession.fetchResponse = async (url, init) => {
  assert.equal(url, "/api/v1/transfers/upload");
  assert.equal(init.headers["X-Kaigen-Transfer-Position"], "0");
  assert.deepEqual(new Uint8Array(init.body), new Uint8Array([1, 2, 3, 4]));
  uploadAttempts += 1;
  if (uploadAttempts === 1) {
    return new Response(JSON.stringify({ retryAfterMs: 0, transfer: outgoing }));
  }
  if (!outgoing.payloadCommitted) {
    durableWrites += 1;
    Object.assign(outgoing, { state: "queued", uploadedBytes: 4, payloadCommitted: true, payloadSha256: digest, downloadAvailable: true });
    throw new TypeError("Failed to fetch");
  }
  return new Response(JSON.stringify({ retryAfterMs: 0, transfer: outgoing }));
};
outgoingSession.reportTransferPumpError = (_messageId, error) => assert.fail(String(error));
await outgoingSession.sendBrowserFile("profile", 1, new File([payload], "fixture.bin"));
await Promise.all([...outgoingSession.transferPumps.values()]);
assert.equal(beginAttempts, 2, "a lost begin reply must not create a new operation or lose the staged source");
assert.equal(uploadAttempts, 3, "Pending keeps the durable offset and a lost committed reply retries the same source range");
assert.equal(durableWrites, 1, "a committed upload reply may be lost without requiring a second payload");
assert.equal(outgoing.state, "queued", "the browser pump finishes on durable commit while the native peer is still unavailable");

for (const code of ["WORKSPACE_LEASE_EXPIRED", "PROFILE_NOT_ACTIVE", "PROFILE_ID_INVALID",
  "TRANSFER_OPERATION_ID_INVALID", "TRANSFER_OPERATION_INVALID", "TRANSFER_HASH_INVALID", "TRANSFER_SIZE_INVALID"]) {
  const refused = loadSession(memoryStorage());
  let attempts = 0;
  refused.request = async (url) => {
    assert.equal(url, "/api/v1/transfers/outgoing");
    attempts += 1;
    // A regression fails promptly instead of leaving this test in the retry loop.
    throw new Error(attempts === 1 ? code : "TRANSFER_CANCELLED");
  };
  await assert.rejects(refused.sendBrowserFile("profile", 1, new File([payload], "fixture.bin")),
    new RegExp(code, "u"), `${code} must reach the caller so batch sending can release its busy state`);
  assert.equal(attempts, 1);
  assert.equal(refused.transferPumps.size, 0);
}

const downloads = [];
const incoming = { ...outgoing, id: "i".repeat(32), direction: "incoming", state: "complete", operationId: null, persistedBytes: 4, uploadedBytes: 0 };
const configureIncoming = (session) => {
  session.transferStatus = async () => ({ ...incoming });
  session.command = async (command, args) => {
    assert.equal(command, "complete_web_incoming_transfer", "copying must not accept, resume, ACK native buffers, pause or cancel");
    assert.equal(args.sizeBytes, 4); assert.equal(args.sha256, digest);
    return { ...incoming };
  };
  session.fetchResponse = async (url, init) => {
    assert.equal(url, "/api/v1/transfers/download");
    const range = JSON.parse(init.body);
    assert.equal(range.transferId, incoming.id);
    assert.equal(range.position, 2, "a reloaded browser resumes its own durable OPFS prefix, independent of server ACK state");
    assert.equal(range.length, 2);
    return new Response(new Uint8Array([3, 4]), { headers: { "X-Kaigen-Transfer-Position": "2" } });
  };
  session.reportTransferPumpError = (_messageId, error) => assert.fail(String(error));
};
storage.files.set(`.kaigen-transfer-cache/workspace-fixture/${incoming.id}.payload`, new Uint8Array([1, 2]));
const incomingSession = loadSession(storage, downloads);
configureIncoming(incomingSession);
await incomingSession.startIncomingTransfer(incoming, 1);
await Promise.all([...incomingSession.transferPumps.values()]);
assert.deepEqual(downloads, ["fixture.bin"]);
assert.ok([...storage.files.keys()].some(key => key.endsWith(".consumed")), "the local receipt must survive document reload");
const reloaded = loadSession(storage, downloads);
configureIncoming(reloaded);
reloaded.fetchResponse = () => assert.fail("an already consumed automatic copy must not download again");
assert.equal(await reloaded.recoverIncomingTransfer("profile", "message", incoming.id, 1, "automatic"), true);
assert.deepEqual(downloads, ["fixture.bin"]);
reloaded.fetchResponse = async (_url, init) => {
  assert.equal(JSON.parse(init.body).position, 0, "explicit download can re-read the retained backend payload");
  return new Response(new Uint8Array([1, 2, 3, 4]), { headers: { "X-Kaigen-Transfer-Position": "0" } });
};
await reloaded.downloadTransfer("profile", "message", incoming.id, 1);
assert.deepEqual(downloads, ["fixture.bin", "fixture.bin"]);

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

{
  const copyDownloads = [];
  const copySession = loadSession(memoryStorage(), copyDownloads);
  const rangeStarted = deferred();
  const rangeReply = deferred();
  let statusCalls = 0;
  copySession.transferStatus = async () => { statusCalls += 1; return { ...incoming }; };
  copySession.command = async () => ({ ...incoming });
  copySession.fetchResponse = async () => {
    rangeStarted.resolve();
    await rangeReply.promise;
    return new Response(new Uint8Array([1, 2, 3, 4]), { headers: { "X-Kaigen-Transfer-Position": "0" } });
  };
  const first = copySession.downloadTransfer("profile", "message", incoming.id, 1);
  const second = copySession.downloadTransfer("profile", "message", incoming.id, 1);
  await rangeStarted.promise;
  assert.equal(statusCalls, 1, "concurrent download clicks reserve one owner before async status/OPFS reads");
  assert.equal(copySession.transferPumps.size, 1);
  rangeReply.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(copyDownloads, ["fixture.bin"]);
  assert.equal(copySession.transferPumps.size, 0);
}

{
  const copies = [];
  const session = loadSession(memoryStorage(), copies);
  const uncommitted = { ...incoming, id: "u".repeat(32), profileId: "profile-waiting",
    state: "receiving", payloadCommitted: false, payloadSha256: null, downloadAvailable: false };
  session.transferStatus = async () => ({ ...incoming });
  session.command = async (command) => command === "get_background_transfer_work" ? {
    entries: [{ ...incoming, transferId: incoming.id, size: 4, friendNumber: 1, completed: true }], maxConcurrent: 1,
  } : ({ ...incoming });
  session.fetchResponse = async () => new Response(new Uint8Array([1, 2, 3, 4]),
    { headers: { "X-Kaigen-Transfer-Position": "0" } });
  await session.startIncomingTransfer(uncommitted, 1);
  assert.equal(session.transferPumps.size, 0, "manual acceptance does not allocate a browser slot before backend commit");
  await session.backgroundTransfers.run();
  await Promise.all([...session.transferPumps.values()]);
  assert.deepEqual(copies, ["fixture.bin"], "a retained file in another unlocked profile remains discoverable");
}

for (const action of ["lockWorkspace", "closeWorkspace", "destroyWorkspace"]) {
  const storage = memoryStorage();
  const copies = [];
  const session = loadSession(storage, copies);
  const receiptStarted = deferred();
  const receiptReply = deferred();
  const commands = [];
  const transferErrors = [];
  session.command = async (command) => {
    commands.push(command);
    receiptStarted.resolve();
    await receiptReply.promise;
    return { ...incoming };
  };
  session.reportTransferPumpError = (_messageId, error) => transferErrors.push(transferFailureCode(error));
  session.request = async () => ({ locked: true, closed: true, destroyed: true });
  storage.files.set(`.kaigen-transfer-cache/workspace-fixture/${incoming.id}.payload`, new Uint8Array([1, 2, 3, 4]));
  await session.startIncomingTransfer(incoming, 1);
  const pump = session.transferPumps.get(incoming.id);
  await receiptStarted.promise;
  await session[action]();
  assert.equal(session.sessionLifecycle, "closed");
  // Reauthorization must not revive an old pump merely by becoming active again.
  session.sessionLifecycle = "active";
  receiptReply.resolve();
  await pump;
  assert.deepEqual(copies, [], `${action}: a late receipt cannot download data from the closed session`);
  assert.equal(storage.files.size, 0, `${action}: a late receipt cannot recreate OPFS payload/consumed data`);
  assert.deepEqual(commands, ["complete_web_incoming_transfer"], "browser shutdown does not issue peer transfer controls");
  assert.deepEqual(transferErrors, ["TRANSFER_PUMP_STOPPED"]);
}

const workPath = "/api/v1/commands/get_background_transfer_work";
const emptyWork = { entries: [], maxConcurrent: 1 };
const jsonReply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

for (const [action, endpoint] of [["lockWorkspace", "lock"], ["closeWorkspace", "close"], ["destroyWorkspace", "destroy"]]) {
  const controlEntered = deferred(), controlReply = deferred(), cacheEntered = deferred(), cacheReply = deferred();
  const storage = memoryStorage(), phases = [], completionOrder = [];
  const originalDirectory = storage.root.getDirectoryHandle;
  storage.root.getDirectoryHandle = async (name) => {
    const directory = await originalDirectory(name);
    if (name === ".kaigen-transfer-cache") {
      const remove = directory.removeEntry;
      directory.removeEntry = async (...args) => { cacheEntered.resolve(); await cacheReply.promise; return remove(...args); };
    }
    return directory;
  };
  let session;
  session = loadSession(storage, [], { fetch: async (url) => {
    if (url === `/api/v1/workspaces/${endpoint}`) { controlEntered.resolve(); await controlReply.promise; return jsonReply({ locked: true, closed: true, destroyed: true }); }
    assert.equal(url, workPath); phases.push(session.sessionLifecycle); return jsonReply(emptyWork);
  } });
  await session.backgroundTransfers.run();
  const closing = session[action]();
  await controlEntered.promise;
  const queued = session.command("get_background_transfer_work").then(
    () => assert.fail("teardown read unexpectedly succeeded"),
    error => { assert.match(error.message, /SESSION_NOT_ACTIVE/u); completionOrder.push("queued-read-rejected"); },
  );
  assert.equal(await session.command("save_local_state", { state: {} }), undefined);
  controlReply.resolve(); await cacheEntered.promise;
  assert.equal(session.sessionLifecycle, "closed");
  const duringCleanup = session.command("get_background_transfer_work").then(
    () => assert.fail("cleanup read unexpectedly succeeded"), error => assert.match(error.message, /SESSION_NOT_ACTIVE/u),
  );
  await Promise.resolve();
  assert.deepEqual(completionOrder, [], "closed local cleanup must not reject mounted consumers early");
  cacheReply.resolve(); await closing;
  // The real WebRoot now uses flushSync in this continuation, after success.
  completionOrder.push("caller-success-continuation");
  await Promise.all([queued, duringCleanup]);
  await assert.rejects(session.command("get_background_transfer_work"), /SESSION_NOT_ACTIVE/u);
  assert.deepEqual(phases, ["active"], `${action}: new teardown/closed requests must never reach fetch`);
  assert.deepEqual(completionOrder, ["caller-success-continuation", "queued-read-rejected"]);
}

{
  const headerEntered = deferred(), headerReply = deferred(), calls = [];
  const session = loadSession(memoryStorage(), [], { fetch: async (url) => {
    calls.push(url === workPath ? "admitted-read" : "lock");
    assert.ok(url === workPath || url === "/api/v1/workspaces/lock");
    return jsonReply(url === workPath ? emptyWork : { locked: true });
  } });
  let digests = 0;
  session.workspaceDigest = async () => {
    if (++digests === 1) { headerEntered.resolve(); await headerReply.promise; }
    return "workspace-fixture";
  };
  session.legacyWorkspaceDigest = async () => "legacy-fixture";
  const admitted = session.command("get_background_transfer_work");
  await headerEntered.promise;
  const closing = session.lockWorkspace();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [], "lock must wait for work registered before its auth-header await");
  headerReply.resolve();
  const [work] = await Promise.all([admitted, closing]);
  assert.equal(work.maxConcurrent, 1, "the real admitted response is preserved");
  assert.deepEqual(calls, ["admitted-read", "lock"], "auth is revoked only after the admitted request finishes");
}

{
  const bodyEntered = deferred(), bodyReply = deferred(), calls = [];
  const session = loadSession(memoryStorage(), [], { fetch: async (url) => {
    if (url === workPath) {
      calls.push("admitted-headers");
      const response = jsonReply(emptyWork);
      const parse = response.json.bind(response);
      response.json = async () => {
        bodyEntered.resolve(); await bodyReply.promise;
        const body = await parse(); calls.push("admitted-body"); return body;
      };
      return response;
    }
    assert.equal(url, "/api/v1/workspaces/lock"); calls.push("lock"); return jsonReply({ locked: true });
  } });
  const admitted = session.command("get_background_transfer_work");
  await bodyEntered.promise;
  const closing = session.lockWorkspace();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ["admitted-headers"], "Response headers alone must not release a JSON request lease");
  bodyReply.resolve();
  const [work] = await Promise.all([admitted, closing]);
  assert.equal(work.maxConcurrent, 1);
  assert.deepEqual(calls, ["admitted-headers", "admitted-body", "lock"]);
}

{
  const admittedEntered = deferred(), admittedReply = deferred();
  const fetchCalls = [], intervals = [], timerToken = { owned: "drain" };
  let expireDrain, timerCleared = false, reads = 0;
  const session = loadSession(memoryStorage(), [], {
    setTimeout: (callback, milliseconds) => {
      assert.equal(milliseconds, 30_000, "the production drain owns one bounded timeout");
      expireDrain = callback; return timerToken;
    },
    clearTimeout: (token) => { assert.equal(token, timerToken); timerCleared = true; },
    setInterval: (_callback, milliseconds) => { intervals.push(milliseconds); return intervals.length; },
    fetch: async (url) => {
      fetchCalls.push(url); assert.equal(url, workPath, "drain timeout must never dispatch the revoke POST");
      if (++reads === 1) { admittedEntered.resolve(); await admittedReply.promise; return jsonReply({ code: "STATE_UNAVAILABLE" }, 503); }
      return jsonReply(emptyWork);
    },
  });
  session.realtimeActive = true;
  const admitted = assert.rejects(session.command("get_background_transfer_work"), /STATE_UNAVAILABLE/u);
  await admittedEntered.promise;
  const closing = assert.rejects(session.lockWorkspace(), /SESSION_DRAIN_TIMEOUT/u);
  assert.equal(typeof expireDrain, "function");
  const queued = session.command("get_background_transfer_work");
  await Promise.resolve();
  assert.equal(reads, 1, "outcome waiters are not admitted into the drain set");
  expireDrain(); await closing;
  const work = await queued;
  assert.equal(work.maxConcurrent, 1, "timeout rollback resumes queued reads with a real response");
  assert.equal(session.sessionLifecycle, "active");
  assert.equal(session.realtimeActive, true);
  assert.deepEqual(intervals, [2000, 20000, 300000]);
  assert.equal(timerCleared, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(session.pendingSessionRequests.size, 1, "the original in-flight request remains tracked and is not aborted");
  admittedReply.resolve(); await admitted;
  assert.equal(session.pendingSessionRequests.size, 0);
  assert.ok(fetchCalls.length >= 2 && fetchCalls.every(url => url === workPath));
}

for (const realtimeWasActive of [false, true]) {
  const controlEntered = deferred(), controlReply = deferred(), phases = [], intervals = [];
  let session;
  session = loadSession(memoryStorage(), [], {
    setInterval: (_callback, milliseconds) => { intervals.push(milliseconds); return intervals.length; },
    fetch: async (url) => {
      if (url === "/api/v1/workspaces/lock") { controlEntered.resolve(); await controlReply.promise; return jsonReply({ code: "STATE_UNAVAILABLE" }, 503); }
      assert.equal(url, workPath); phases.push(session.sessionLifecycle); return jsonReply(emptyWork);
    },
  });
  session.realtimeActive = realtimeWasActive;
  const closing = session.lockWorkspace();
  const rejected = assert.rejects(closing, /STATE_UNAVAILABLE/u);
  await controlEntered.promise;
  assert.equal(session.realtimeActive, false);
  const queued = session.command("get_background_transfer_work");
  await Promise.resolve(); assert.deepEqual(phases, []);
  controlReply.resolve(); await rejected;
  const work = await queued;
  assert.equal(work.maxConcurrent, 1, "failed lock resumes queued reads with a real response");
  assert.equal(session.realtimeActive, realtimeWasActive);
  assert.deepEqual(intervals, realtimeWasActive ? [2000, 20000, 300000] : []);
  assert.ok(phases.length > 0 && phases.every(value => value === "active"));
}

{
  const entered = deferred(), reply = deferred();
  let workRequests = 0;
  const session = loadSession(memoryStorage(), [], { fetch: async (url) => {
    if (url === "/api/v1/workspaces/lock") { entered.resolve(); await reply.promise; return jsonReply({ locked: true }); }
    assert.equal(url, workPath); workRequests += 1; return jsonReply(emptyWork);
  } });
  const closing = session.lockWorkspace(); await entered.promise;
  const queued = assert.rejects(session.command("get_background_transfer_work"), /SESSION_NOT_ACTIVE/u);
  reply.resolve(); await closing;
  // Becoming active again cannot revive work captured by the old closed outcome.
  session.sessionLifecycle = "active";
  await queued;
  assert.equal(workRequests, 0);
}

{
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const records = new Map([["workspace:workspace-fixture", { workspaceDigest: "workspace-fixture", deviceId: "owned-device", privateKey: keys.privateKey, publicKey: keys.publicKey }]]);
  const idbRequest = (result) => {
    const request = { result };
    queueMicrotask(() => request.onsuccess?.()); return request;
  };
  const store = {
    get: key => idbRequest(records.get(key)),
    put: (value, key) => { records.set(key, value); return idbRequest(key); },
    delete: key => { records.delete(key); return idbRequest(undefined); },
  };
  const indexedDB = { open: () => idbRequest({ transaction: () => ({ objectStore: () => store }), close() {} }) };
  const deviceEntered = deferred(), deviceReply = deferred(), calls = [], intervals = [];
  const session = loadSession(memoryStorage(), [], { indexedDB,
    setInterval: (_callback, milliseconds) => { intervals.push(milliseconds); return intervals.length; },
    fetch: async (url, init) => {
      if (url === "/api/v1/auth/device-challenge") return jsonReply({ challenge: Buffer.alloc(32).toString("base64url") });
      if (url === "/api/v1/auth/device") {
        calls.push("device"); deviceEntered.resolve(); await deviceReply.promise;
        return jsonReply({ csrfToken: "fresh-csrf", deviceId: "owned-device", workspace: { storageMode: "disk" } });
      }
      assert.equal(url, "/api/v1/workspaces/lock");
      calls.push("lock");
      assert.equal(session.sessionLifecycle, "tearing-down", "late acceptSession must not reactivate teardown");
      assert.equal(init.headers.get("X-Kaigen-CSRF"), "fresh-csrf", "drained device auth supplies the current cookie's CSRF before revoke");
      return jsonReply({ locked: true });
    },
  });
  session.setIdentifier("owned-identifier");
  const refresh = session.restoreDeviceSession(); await deviceEntered.promise;
  const closing = session.lockWorkspace();
  await Promise.resolve(); assert.deepEqual(calls, ["device"]);
  deviceReply.resolve(); await Promise.all([refresh, closing]);
  assert.deepEqual(calls, ["device", "lock"]);
  assert.equal(session.sessionLifecycle, "closed");
  assert.equal(session.realtimeActive, false);
  assert.equal(session.csrfToken, "");
  assert.equal(records.size, 0, "lock removes the refreshed device record after the auth chain drains");
  assert.deepEqual(intervals, [], "late session refresh must not restart background timers");
}

console.log("WEB_TRANSFER_PUMP_PASS pending_durable_offset=1 lost_begin_identity=1 lost_commit_reply=1 terminal_begin_refusals=7 browser_stops_at_backend_commit=1 positional_opfs_resume=1 verified_sha256=1 persistent_consume=1 explicit_redownload=1 single_download_owner=1 manual_accept_cross_profile=1 stale_receipt_teardown=3 session_teardown_success=3 admitted_header_drain=1 admitted_json_body_drain=1 drain_timeout_rollback=1 lock_failure_rollback=2 captured_closed_outcome=1 pending_device_refresh=1");
