import baseAssert from "node:assert/strict";
import { importTypeScriptModule } from "./import-typescript-module.mjs";

let assertionCount = 0;
const assert = new Proxy(baseAssert, {
  get(target, property, receiver) {
    const value = Reflect.get(target, property, receiver);
    if (typeof value !== "function") return value;
    return (...args) => {
      assertionCount += 1;
      return Reflect.apply(value, target, args);
    };
  },
});

const sourceUrl = new URL("../src/chatNavigation.ts", import.meta.url);
const navigation = await importTypeScriptModule(sourceUrl);

assert.equal(navigation.shouldShowJumpToLatest(1_500, 1_000), false, "1.5 screens must stay hidden");
assert.equal(navigation.shouldShowJumpToLatest(1_501, 1_000), true, "more than 1.5 screens must show jump");
assert.equal(navigation.chatNavigationMode(0, 1_000, 1_000), "none");
assert.equal(navigation.chatNavigationMode(0, 1_501, 1_000), "jump");
assert.equal(navigation.chatNavigationMode(2, 5_000, 1_000), "unseen", "unseen has priority over jump");
assert.equal(navigation.shouldPublishNavigationForScroll(100, 200, true, 300), false, "automatic scroll wins");
assert.equal(navigation.shouldPublishNavigationForScroll(200, 100, false, 300), true, "recent user scroll publishes UI");
assert.equal(navigation.shouldPublishNavigationForScroll(400, 100, false, 300), false, "passive scroll does not publish UI");
assert.deepEqual(navigation.DEFAULT_NOTIFICATION_SETTINGS, { messages: false, requests: false });
assert.equal(navigation.incomingPrepaintAction(false, false, true, false), "bottom", "short incoming renders above the composer before paint");
assert.equal(navigation.incomingPrepaintAction(false, false, true, true), "context", "long incoming receives its context position before paint");
assert.equal(navigation.incomingPrepaintAction(true, false, true, false), "hold", "history reading is never moved before paint");
assert.equal(navigation.incomingPrepaintAction(false, true, true, false), "hold", "active user scroll is never overridden");
assert.equal(navigation.incomingPrepaintAction(false, false, false, false), "hold", "missing DOM target waits for the next layout pass");

for (const cardKind of ["text", "file", "image"]) {
  assert.equal(navigation.incomingPrepaintAction(false, false, true, false), "bottom", `${cardKind} incoming item uses prepaint navigation`);
  assert.equal(navigation.shouldPrepaintOutgoing(1_600, 800), true, `${cardKind} outgoing item scrolls from at most two screens away`);
  assert.equal(navigation.shouldPrepaintOutgoing(1_601, 800), false, `${cardKind} outgoing item preserves history beyond two screens`);
}
assert.equal(navigation.shouldPrepaintOutgoing(0, 0), false, "outgoing prepaint waits for a measurable viewport");
assert.equal(navigation.mediaLoadBelongsToIntent("incoming", 4, 7, 4), true, "first image in an incoming block keeps the shared context");
assert.equal(navigation.mediaLoadBelongsToIntent("incoming", 4, 7, 6), true, "later image in an incoming block keeps the shared context");
assert.equal(navigation.mediaLoadBelongsToIntent("incoming", 4, 7, 8), false, "unrelated image cannot reuse an old incoming intent");
assert.equal(navigation.mediaLoadBelongsToIntent("outgoing", 4, 4, 4), true, "outgoing image keeps the latest position while decoding");
assert.equal(navigation.mediaLoadBelongsToIntent("outgoing", 4, 4, 5), false, "another image cannot hijack an outgoing intent");

const attachmentSequence = [
  { key: "text-before", incoming: true, unseen: false, attachment: false },
  { key: "image-1", incoming: true, unseen: true, attachment: true },
  { key: "image-2", incoming: true, unseen: true, attachment: true },
  { key: "file-3", incoming: true, unseen: true, attachment: true },
];
assert.deepEqual(
  navigation.incomingNavigationBatch(attachmentSequence, "image-2", "image-1"),
  { anchorKey: "image-2", boundaryKey: "image-2", settleMs: 0 },
  "a second attachment starts its own navigation range",
);
assert.deepEqual(
  navigation.incomingNavigationBatch(attachmentSequence, "file-3", "image-2"),
  { anchorKey: "file-3", boundaryKey: "file-3", settleMs: 0 },
  "later files cannot remain pinned to the second card",
);
assert.deepEqual(
  navigation.incomingNavigationBatch([
    { key: "fragment-1", incoming: true, unseen: true, attachment: false },
    { key: "fragment-2", incoming: true, unseen: true, attachment: false },
    { key: "fragment-3", incoming: true, unseen: true, attachment: false },
  ], "fragment-3", "fragment-1"),
  { anchorKey: "fragment-1", boundaryKey: "fragment-3", settleMs: 900 },
  "text protocol fragments still share one readable range",
);

for (const card of [
  { kind: "file", height: 110 },
  { kind: "image", height: 760 },
]) {
  const result = navigation.incomingContextMetrics({
    viewportHeight: 800,
    targetKey: card.kind,
    targetTop: 130,
    targetHeight: card.height,
    previousOwn: { bottom: 120, height: 34, lineHeight: 24 },
    incoming: [{ key: card.kind, bottom: 130 + card.height }],
  });
  assert.equal(result.top, 78, `${card.kind} card preserves the outgoing context`);
  assert.equal(result.long, card.kind === "image", `${card.kind} card uses its rendered height`);
}

for (const fragmentCount of [3, 6, 7, 8]) {
  const result = navigation.incomingContextMetrics({
    viewportHeight: 800,
    targetKey: "incoming-1",
    targetTop: 130,
    targetHeight: 280,
    previousOwn: { bottom: 120, height: 34, lineHeight: 24 },
    incoming: Array.from({ length: fragmentCount }, (_, index) => ({
      key: `incoming-${index + 1}`,
      bottom: 410 + index * 280,
    })),
  });
  assert.equal(result.top, 78, `${fragmentCount} fragments must preserve the same outgoing context`);
  assert.equal(result.long, true, `${fragmentCount} maximum messages must be treated as one long block`);
  assert.equal(result.boundaryMessageKey, `incoming-${fragmentCount}`, `${fragmentCount} fragments must track the final boundary`);
}

assert.equal(navigation.incomingContextMetrics({
  viewportHeight: 800,
  targetKey: "short",
  targetTop: 200,
  targetHeight: 100,
  incoming: [{ key: "short", bottom: 300 }],
}).long, false);

baseAssert.equal(assertionCount, 49, "update the declared assertion count when chat-navigation coverage changes");
console.log(`chat navigation rules: ${assertionCount} assertions passed`);
