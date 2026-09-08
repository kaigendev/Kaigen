import assert from "node:assert/strict";
import { importTypeScriptModule } from "./import-typescript-module.mjs";

const { ChatNotificationQueue } = await importTypeScriptModule(
  new URL("../src/chatNotificationQueue.ts", import.meta.url),
);

const queue = new ChatNotificationQueue();
queue.resetOwner("profile-a", { alice: 0, bob: 0 });

assert.equal(queue.enqueue("alice", 1), true);
assert.equal(queue.enqueue("alice", 1), true, "a presence refresh must retain the pending increase");
assert.equal(queue.pendingCount(), 1);
const first = [];
assert.equal(await queue.drain((candidate) => { first.push(candidate); return true; }), 1);
assert.deepEqual(first, [{ profileId: "profile-a", key: "alice", previousUnread: 0, unread: 1, increase: 1 }]);
assert.equal(queue.watermark("alice"), 1);
assert.equal(queue.hasPending(), false);

queue.enqueue("alice", 2);
queue.enqueue("alice", 4);
const accumulated = [];
await queue.drain((candidate) => { accumulated.push(candidate); return true; });
assert.deepEqual(accumulated, [{ profileId: "profile-a", key: "alice", previousUnread: 1, unread: 4, increase: 3 }]);

queue.enqueue("alice", 5);
assert.equal(await queue.drain(() => false), 0, "a failed fetch or notice enqueue cannot advance the watermark");
assert.equal(queue.watermark("alice"), 4);
assert.equal(queue.pendingCount(), 1);
assert.equal(await queue.drain(() => true), 1, "the same candidate remains retryable");
assert.equal(queue.watermark("alice"), 5);

queue.enqueue("alice", 6);
assert.equal(await queue.drain(() => true), 1, "current-viewport suppression is a successfully handled candidate");
assert.equal(queue.hasPending(), false);

queue.enqueue("alice", 7);
queue.enqueue("bob", 1);
const interleaved = [];
await queue.drain((candidate) => {
  interleaved.push(`${candidate.key}:${candidate.unread}`);
  if (candidate.key === "bob") queue.enqueue("alice", 8);
  return true;
});
assert.deepEqual(interleaved, ["alice:7", "bob:1", "alice:8"]);
assert.equal(queue.watermark("alice"), 8);
assert.equal(queue.pendingCount(), 0, "an increase arriving during a drain is handled without another render");

queue.enqueue("alice", 9);
queue.enqueue("alice", 0);
assert.equal(queue.hasPending(), false, "a local unread reset cancels a stale notification candidate");
assert.equal(queue.watermark("alice"), 0);

queue.enqueue("alice", 1);
let releaseOldOwner;
const oldOwnerDrain = queue.drain(async () => {
  await new Promise((resolve) => { releaseOldOwner = resolve; });
  return true;
});
queue.resetOwner("profile-b", { alice: 5 });
releaseOldOwner();
assert.equal(await oldOwnerDrain, 0, "a late handler from the old profile cannot advance the new owner");
assert.equal(queue.watermark("alice"), 5);
assert.equal(queue.hasPending(), false);

queue.enqueue("alice", 6);
let releaseConcurrent;
const concurrentlyHandled = [];
const firstDrain = queue.drain(async (candidate) => {
  concurrentlyHandled.push(candidate.unread);
  if (candidate.unread === 6) {
    await new Promise((resolve) => { releaseConcurrent = resolve; });
  }
  return true;
});
queue.enqueue("alice", 7);
const secondDrain = queue.drain((candidate) => {
  concurrentlyHandled.push(candidate.unread);
  return true;
});
releaseConcurrent();
assert.equal(await firstDrain, 2);
assert.equal(await secondDrain, 2, "concurrent drains share one serialized pass");
assert.deepEqual(concurrentlyHandled, [6, 7]);
assert.equal(queue.watermark("alice"), 7);

queue.enqueue("alice", 8);
let releaseReset;
const resetDuringDrain = queue.drain(async () => {
  await new Promise((resolve) => { releaseReset = resolve; });
  return true;
});
queue.enqueue("alice", 0);
releaseReset();
assert.equal(await resetDuringDrain, 0, "a local unread reset supersedes an in-flight candidate");
assert.equal(queue.watermark("alice"), 0);
assert.equal(queue.hasPending(), false);

queue.resetOwner("profile-c", { alice: 0, bob: 0 });
queue.enqueue("alice", 1);
queue.enqueue("bob", 1);
assert.equal(queue.retainKeys(["bob"]), 1, "a deleted contact releases its watermark and pending candidate");
const afterDelete = [];
assert.equal(await queue.drain((candidate) => { afterDelete.push(candidate.key); return true; }), 1);
assert.deepEqual(afterDelete, ["bob"]);
assert.equal(queue.watermark("alice"), undefined);

queue.enqueue("bob", 2);
let releaseDeletedInflight;
const deletedInflight = queue.drain(async () => {
  await new Promise((resolve) => { releaseDeletedInflight = resolve; });
  return true;
});
assert.equal(queue.retainKeys([]), 1);
releaseDeletedInflight();
assert.equal(await deletedInflight, 0, "a late completion cannot restore a deleted contact watermark");
assert.equal(queue.watermark("bob"), undefined);
assert.equal(queue.hasPending(), false);

assert.equal(queue.enqueue("alice", Number.NaN), false);
assert.equal(queue.enqueue("", 6), false);
queue.resetOwner("   ", { alice: 0 });
assert.equal(queue.enqueue("alice", 1), false, "a blank profile cannot own notification state");
assert.equal(queue.pendingCount(), 0);

console.log("chat notification queue accumulation, owner, retry, and watermark races: PASS");
