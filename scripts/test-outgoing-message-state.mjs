import assert from "node:assert/strict";
import { importTypeScriptModule } from "./import-typescript-module.mjs";

const { resolveOutgoingTarget, canCancelQueuedMessage, outgoingRequestMatchesPeer } = await importTypeScriptModule(new URL("../src/outgoingMessageState.ts", import.meta.url));
const keyA = "A".repeat(64);
const keyB = "B".repeat(64);
const original = { profileId: "profile-a", friendNumber: 7, chatId: `tox-${keyA}`, operationId: "stable-operation", text: "offline" };
const friends = [{ number: 7, public_key: keyB }, { number: 19, public_key: keyA }];
assert.deepEqual(resolveOutgoingTarget(original, "profile-a", friends), { ...original, friendNumber: 19, expectedPublicKey: keyA });
assert.equal(resolveOutgoingTarget(original, "profile-b", friends), null);
assert.equal(resolveOutgoingTarget(original, "profile-a", [friends[0]]), null);
assert.equal(resolveOutgoingTarget({ ...original, chatId: "tox-7" }, "profile-a", friends), null);
assert.equal(resolveOutgoingTarget({ ...original, expectedPublicKey: keyB }, "profile-a", friends), null);
assert.equal(resolveOutgoingTarget({ ...original, expectedPublicKey: keyA.toLowerCase() }, "profile-a", friends)?.friendNumber, 19);
assert.equal(original.friendNumber, 7, "resolution must not mutate persisted input");
for (const delivery of ["queued", "pending"]) {
  assert.equal(canCancelQueuedMessage({ coreId: "m", mine: true, delivery }), true);
}
for (const delivery of ["awaiting_receipt", "sent", "delivered", "cancelled", "failed", "unknown", undefined]) {
  assert.equal(canCancelQueuedMessage({ coreId: "m", mine: true, delivery }), false);
}
for (const patch of [{ mine: false }, { coreId: undefined }, { attachment: {} }, { event: {} }]) {
  assert.equal(canCancelQueuedMessage({ coreId: "m", mine: true, delivery: "pending", ...patch }), false);
}
assert.equal(outgoingRequestMatchesPeer(` ${keyA.toLowerCase()}1234 `, keyA), true);
assert.equal(outgoingRequestMatchesPeer(`${keyB}1234`, keyA), false);
assert.equal(outgoingRequestMatchesPeer(keyA, ""), false);
console.log("PASS outgoing message state: stable identity, slot reuse, profile isolation and safe cancellation eligibility");
