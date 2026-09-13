import assert from "node:assert/strict";
import { importTypeScriptModule } from "./import-typescript-module.mjs";

const { clipboardToxId, ContactClipboardPrefill } = await importTypeScriptModule(new URL("../src/contactClipboard.ts", import.meta.url));
const { ProfileReorderGesture } = await importTypeScriptModule(new URL("../src/profileReorderGesture.ts", import.meta.url));
const address = (seed) => {
  const bytes = Array.from({ length: 36 }, (_, index) => (seed + index * 7) % 256);
  const checksum = [0, 0];
  bytes.forEach((value, index) => { checksum[index % 2] ^= value; });
  return [...bytes, ...checksum].map((value) => value.toString(16).padStart(2, "0")).join("").toUpperCase();
};
const first = address(3);
const second = address(19);
assert.equal(clipboardToxId(`  tox:${first.toLowerCase()}  `), first);
assert.equal(clipboardToxId(`Contact: ${first}\n`), first);
assert.equal(clipboardToxId(first.slice(0, -2) + "FF"), null, "a checksum error is not a valid Tox ID");
assert.equal(clipboardToxId(first.slice(0, 64)), null, "a public key is not a complete address");
assert.equal(clipboardToxId(`A${first}`), null, "do not truncate a longer hex token");
assert.equal(clipboardToxId(`${first}A`), null);
assert.equal(clipboardToxId("not an address"), null);

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const settle = () => new Promise((done) => setImmediate(done));
const prefill = new ContactClipboardPrefill();
const values = [];
let requestedSynchronously = false;
const immediate = deferred();
prefill.begin(() => { requestedSynchronously = true; return immediate.promise; }, (value) => values.push(value));
assert.equal(requestedSynchronously, true, "readText must start during the user's click gesture");
immediate.resolve(first);
await settle();
assert.deepEqual(values, [first]);

for (const reason of ["typing", "closing", "changing profile/unmount"]) {
  const pending = deferred();
  prefill.begin(() => pending.promise, (value) => values.push(value));
  prefill.cancel();
  pending.resolve(second);
  await settle();
  assert.deepEqual(values, [first], `a late clipboard response cannot win after ${reason}`);
}
const older = deferred();
const newer = deferred();
prefill.begin(() => older.promise, (value) => values.push(value));
prefill.begin(() => newer.promise, (value) => values.push(value));
newer.resolve(second);
older.resolve(first);
await settle();
assert.deepEqual(values, [first, second], "reopening owns a fresh request even if the first resolves last");
prefill.begin(() => Promise.reject(new Error("permission denied")), (value) => values.push(value));
prefill.begin(() => { throw new Error("clipboard unavailable"); }, (value) => values.push(value));
await settle();
assert.deepEqual(values, [first, second], "denial and absent clipboard stay nonblocking");

const gesture = new ProfileReorderGesture();
assert.equal(gesture.begin(1, "alpha", 40, 30), true);
assert.equal(gesture.move(1, 45, 30), null, "ordinary click jitter does not reorder");
assert.equal(gesture.finish(1), null);
assert.equal(gesture.owns(1), false);
assert.equal(gesture.begin(2, "beta", 40, 30), true);
assert.equal(gesture.begin(3, "gamma", 40, 30), false, "a second pointer cannot replace the owner");
assert.equal(gesture.move(3, 140, 30), null);
assert.equal(gesture.finish(3), null);
assert.equal(gesture.owns(2), true, "foreign pointer completion leaves the original drag alive");
assert.equal(gesture.move(2, 46, 30), "beta", "six pixels activates pointer ordering");
assert.equal(gesture.move(2, 40, 30), "beta", "moving back retains a drag until completion");
assert.equal(gesture.finish(2), "beta");
assert.equal(gesture.finish(2), null, "a completed gesture cannot apply twice");
for (const reason of ["blur", "Escape", "lost capture", "unmount", "profile removal", "switching"]) {
  gesture.begin(5, "alpha", 20, 20);
  gesture.move(5, 80, 20);
  gesture.cancel();
  assert.equal(gesture.finish(5), null, `${reason} prevents a late pointerup from reordering`);
}
assert.equal(gesture.begin(6, "gamma", 0, 0), true, "cancellation does not leave a stuck drag");
assert.equal(gesture.move(6, 0, 6), "gamma", "vertical movement also counts toward drag activation");
console.log("product fixes #3 clipboard races and pointer-ordering regressions passed");
