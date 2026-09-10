import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { importTypeScriptModule } from "./import-typescript-module.mjs";
const { BackgroundTransferDiscovery } = await importTypeScriptModule(new URL("../src/web/backgroundTransfers.ts", import.meta.url));
const work = (id, overrides = {}) => ({ profileId: `profile-${id}`, friendNumber: 0, messageId: `message-${id}`, transferId: id, direction: "incoming", name: "image.png", size: 200, image: true, state: "complete", completed: true, autoAccept: false, operationId: null, uploadedBytes: 0, persistedBytes: 200, payloadCommitted: true, payloadSha256: "a".repeat(43), downloadAvailable: true, ...overrides });
let now = 0;
let entries = [work("a", { state: "offered", autoAccept: true }), work("b"), work("c", { state: "paused" }), work("d", { state: "offered" }), work("e", { payloadCommitted: false, downloadAvailable: false }), work("f", { direction: "outgoing", operationId: "operation-f", state: "uploading", completed: false, payloadCommitted: false })];
let maxConcurrent = 3;
let running = new Set();
const calls = [];
let failures = false;
const discovery = new BackgroundTransferDiscovery({
  load: async () => ({ entries, maxConcurrent }),
  running: () => running,
  recover: async (entry) => { if (failures) throw new Error("HTTP_503"); calls.push(`recover:${entry.profileId}:${entry.transferId}`); },
  report: (entry) => calls.push(`error:${entry.transferId}`),
  now: () => now,
});
await discovery.run();
assert.deepEqual(calls.sort(), ["recover:profile-b:b", "recover:profile-f:f"].sort(), "browser only copies backend commits and resumes full-source uploads; it never accepts offers or drives the native queue");
calls.length = 0;
entries = [work("a"), work("a"), work("b"), work("c")];
running = new Set(["a"]);
maxConcurrent = 2;
await discovery.run();
assert.deepEqual(calls, ["recover:profile-b:b"], "running pumps and duplicate entries consume no extra slot");
calls.length = 0;
entries = [work("b")];
running.clear();
failures = true;
await discovery.run();
assert.deepEqual(calls, ["error:b"]);
await discovery.run();
assert.deepEqual(calls, ["error:b"], "transient failure does not hammer recovery or duplicate the user error");
now = 2000;
failures = false;
await discovery.run();
assert.equal(calls.at(-1), "recover:profile-b:b");

let releaseLoad;
const staleCalls = [];
const stale = new BackgroundTransferDiscovery({
  load: () => new Promise((resolve) => { releaseLoad = resolve; }),
  running: () => new Set(),
  recover: async () => staleCalls.push("recover"), report: () => staleCalls.push("report"), now: () => 0,
});
const pending = stale.run();
await stale.run();
stale.reset();
releaseLoad({ entries: [work("a")], maxConcurrent: 4 });
await pending;
assert.deepEqual(staleCalls, [], "a discovery returned after workspace shutdown cannot start a transfer");

let releaseNeeded;
const afterConsumedLookup = new BackgroundTransferDiscovery({
  load: async () => ({ entries: [work("a")], maxConcurrent: 1 }),
  running: () => new Set(), needed: () => new Promise((resolve) => { releaseNeeded = resolve; }),
  recover: async () => staleCalls.push("recover"), report: () => staleCalls.push("report"), now: () => 0,
});
const checking = afterConsumedLookup.run();
await Promise.resolve();
afterConsumedLookup.reset();
releaseNeeded(true);
await checking;
assert.deepEqual(staleCalls, [], "a consumed-marker lookup returned after shutdown cannot start a stale browser pump");

const freshCopies = [];
const consumed = new Set(["a", "b", "c"]);
const retained = new BackgroundTransferDiscovery({
  load: async () => ({ entries: [work("a"), work("b"), work("c"), work("d"), work("e")], maxConcurrent: 1 }),
  running: () => new Set(), needed: async (entry) => !consumed.has(entry.transferId),
  recover: async (entry) => { freshCopies.push(entry.transferId); consumed.add(entry.transferId); },
  report: () => assert.fail("retained copy failed"), now: () => 0,
});
await retained.run();
await retained.run();
await retained.run();
assert.deepEqual(freshCopies, ["d", "e"], "retained consumed files neither duplicate downloads nor starve newer files behind a full first page");
console.log("background transfer discovery: backend ownership, retained copies, concurrency, retry, dedupe and owner cancellation PASS");

const fixture = JSON.parse(await readFile(new URL("./fixtures/web-background-transfer-contract.json", import.meta.url), "utf8"));
assert.equal(fixture.schemaVersion, 2);
for (const testCase of fixture.cases) {
  const actions = [];
  const consumer = new BackgroundTransferDiscovery({
    load: async () => ({ entries: [testCase.work], maxConcurrent: 1 }),
    running: () => new Set(),
    recover: async (entry) => { assert.equal(entry.transferId, testCase.work.transferId); actions.push("recover"); },
    report: () => assert.fail("contract fixture unexpectedly failed"),
    now: () => 0,
  });
  await consumer.run();
  assert.deepEqual(actions, testCase.actions, testCase.id);
}
for (const variant of [
  { ...fixture.cases[0].work, state: undefined, transferState: "offered" },
  { ...fixture.cases[0].work, direction: undefined },
  { ...fixture.cases[0].work, direction: "unknown" },
  { ...fixture.cases[0].work, direction: "outgoing", autoAccept: true },
  { ...fixture.cases[0].work, state: "awaiting_confirmation" },
]) {
  const consumer = new BackgroundTransferDiscovery({
    load: async () => ({ entries: [variant], maxConcurrent: 1 }),
    running: () => new Set(),
    recover: async () => assert.fail("unrecognized wire state/direction was recovered"),
    report: () => assert.fail("unrecognized wire data reached an operation"),
    now: () => 0,
  });
  await consumer.run();
}
console.log(
  `background consumer contract: ${fixture.cases.length} shared wire cases and 5 malformed/direction guards PASS`,
);
