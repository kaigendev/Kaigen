import assert from "node:assert/strict";
import { importTypeScriptModule } from "./import-typescript-module.mjs";
const { BackgroundTransferDiscovery } = await importTypeScriptModule(new URL("../src/web/backgroundTransfers.ts", import.meta.url));
const work = (id, overrides = {}) => ({ profileId: `profile-${id}`, friendNumber: 0, messageId: `message-${id}`, transferId: id, name: "image.png", size: 200, image: true, state: "queued", completed: false, autoAccept: false, ...overrides });
let now = 0;
let entries = [work("a", { state: "awaiting_confirmation", autoAccept: true }), work("b"), work("c", { state: "paused" }), work("d", { state: "awaiting_confirmation" }), work("e", { completed: true })];
let maxConcurrent = 3;
let running = new Set();
const calls = [];
let failures = false;
const discovery = new BackgroundTransferDiscovery({
  load: async () => ({ entries, maxConcurrent }),
  running: () => running,
  accept: async (entry) => calls.push(`accept:${entry.profileId}:${entry.transferId}`),
  recover: async (entry) => { if (failures) throw new Error("HTTP_503"); calls.push(`recover:${entry.profileId}:${entry.transferId}`); },
  report: (entry) => calls.push(`error:${entry.transferId}`),
  now: () => now,
});
await discovery.run();
assert.deepEqual(calls.sort(), ["accept:profile-a:a", "recover:profile-a:a", "recover:profile-b:b"].sort(), "offers and recovery discover every unlocked profile without an open chat; policy/paused/completed states are honored");
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
  running: () => new Set(), accept: async () => staleCalls.push("accept"),
  recover: async () => staleCalls.push("recover"), report: () => staleCalls.push("report"), now: () => 0,
});
const pending = stale.run();
await stale.run();
stale.reset();
releaseLoad({ entries: [work("a")], maxConcurrent: 4 });
await pending;
assert.deepEqual(staleCalls, [], "a discovery returned after workspace shutdown cannot start a transfer");

let releaseAccept;
const afterAccept = new BackgroundTransferDiscovery({
  load: async () => ({ entries: [work("a", { state: "awaiting_confirmation", autoAccept: true })], maxConcurrent: 1 }),
  running: () => new Set(), accept: () => new Promise((resolve) => { releaseAccept = resolve; }),
  recover: async () => staleCalls.push("recover"), report: () => staleCalls.push("report"), now: () => 0,
});
const accepting = afterAccept.run();
await Promise.resolve();
afterAccept.reset();
releaseAccept();
await accepting;
assert.deepEqual(staleCalls, [], "an accepted offer returned after shutdown does not start a stale browser pump");
console.log("background transfer discovery: multi-profile policy, concurrency, retry, dedupe and owner cancellation PASS");
