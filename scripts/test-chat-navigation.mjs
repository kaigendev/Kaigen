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

function scrollFixture({
  scrollTop = 400,
  scrollHeight = 2_000,
  clientHeight = 500,
  offsetHeight = 500,
  containerTop = 100,
  containerHeight = 500,
  targetTop = 500,
  targetHeight = 50,
} = {}) {
  const calls = [];
  const outer = { scrollTop: 233, scrollToCalls: 0 };
  const container = {
    scrollTop,
    scrollHeight,
    clientHeight,
    offsetHeight,
    getBoundingClientRect: () => ({ top: containerTop, height: containerHeight }),
    scrollTo: (options) => calls.push(options),
  };
  const target = {
    getBoundingClientRect: () => ({ top: targetTop, height: targetHeight }),
    scrollIntoView: () => { outer.scrollToCalls += 1; },
  };
  return { calls, container, outer, target };
}

{
  const fixture = scrollFixture({ scrollTop: 400, targetTop: 500, targetHeight: 50 });
  navigation.scrollMessageWithinContainer(fixture.container, fixture.target);
  assert.deepEqual(fixture.calls, [{ top: 575, behavior: "auto" }], "a rendered message is centered by scrolling only its viewport");
  assert.equal(fixture.outer.scrollTop, 233, "centering cannot move the clipped conversation ancestor");
  assert.equal(fixture.outer.scrollToCalls, 0, "centering never delegates to target.scrollIntoView");
}
{
  const fixture = scrollFixture({ scrollTop: 20, targetTop: -300 });
  navigation.scrollMessageWithinContainer(fixture.container, fixture.target);
  assert.equal(fixture.calls[0].top, 0, "a target above the history clamps to its top boundary");
}
{
  const fixture = scrollFixture({ scrollTop: 1_450, targetTop: 1_500 });
  navigation.scrollMessageWithinContainer(fixture.container, fixture.target);
  assert.equal(fixture.calls[0].top, 1_500, "a target below the history clamps to its bottom boundary");
}
{
  const fixture = scrollFixture({ scrollTop: 80, scrollHeight: 300, clientHeight: 500 });
  navigation.scrollMessageWithinContainer(fixture.container, fixture.target);
  assert.equal(fixture.calls[0].top, 0, "short history has no scrollable range");
}
{
  const fixture = scrollFixture({
    scrollTop: 400,
    offsetHeight: 500,
    containerHeight: 750,
    targetTop: 775,
    targetHeight: 75,
  });
  navigation.scrollMessageWithinContainer(fixture.container, fixture.target, "smooth");
  assert.deepEqual(fixture.calls, [{ top: 625, behavior: "smooth" }], "CSS zoom is removed from the visual center delta and smooth behavior is preserved");
}
{
  const fixture = scrollFixture({ targetTop: Number.NaN });
  navigation.scrollMessageWithinContainer(fixture.container, fixture.target);
  assert.equal(fixture.calls.length, 0, "non-finite layout metrics cannot corrupt scroll state");
}
assert.deepEqual(navigation.DEFAULT_NOTIFICATION_SETTINGS, { messages: false, requests: false });
assert.equal(navigation.MAX_RENDERED_CHAT_MESSAGES, 500);
assert.equal(navigation.NOTIFICATION_TAIL_MESSAGES, 32);
assert.equal(navigation.normalizeHistoryMessageLimit("all"), "all", "the all-history setting must survive restoration");
assert.equal(navigation.normalizeHistoryMessageLimit(500), 500);
assert.equal(navigation.normalizeHistoryMessageLimit(1000), 1000);
assert.equal(navigation.normalizeHistoryMessageLimit(999), 500, "invalid history settings restore the 500-message default");
assert.equal(navigation.boundedHistoryRequestLimit(20, 250), 20, "unread state cannot enlarge the configured opening window");
assert.equal(navigation.boundedHistoryRequestLimit(100, 4_000), 100, "large unread counts cannot enlarge the configured opening window");
assert.equal(navigation.boundedHistoryRequestLimit(500, Number.NaN), 500);
assert.equal(navigation.boundedHistoryRequestLimit("all", 4_000), 0, "zero is the explicit all-history backend request");
assert.equal(navigation.nextHistoryMessageLimit(20), 500);
assert.equal(navigation.nextHistoryMessageLimit(50), 500);
assert.equal(navigation.nextHistoryMessageLimit(100), 500);
assert.equal(navigation.nextHistoryMessageLimit(500), 1000);
assert.equal(navigation.nextHistoryMessageLimit(1000), "all");
assert.equal(navigation.nextHistoryMessageLimit("all"), "all");
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
assert.equal(navigation.shouldShowTransferActivity(false, "sending"), true, "active file transfer keeps progress visible");
assert.equal(navigation.shouldShowTransferActivity(false, "cancelled"), false, "cancelled file transfer hides stale progress");
assert.equal(navigation.shouldShowTransferActivity(false, "failed"), false, "failed file transfer hides terminal progress");
assert.equal(navigation.shouldShowPendingDelivery("pending", "sending"), true, "active outgoing file may show delivery pending");
assert.equal(navigation.shouldShowPendingDelivery("pending", "cancelled"), false, "cancelled file never shows a delivery spinner");
assert.equal(navigation.shouldShowPendingDelivery("pending", "failed"), false, "failed file never shows a delivery spinner");
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
assert.deepEqual(
  navigation.incomingNavigationBatch([
    { key: "grouped-1", incoming: true, unseen: true, attachment: false, fragmentGroup: "message-uid-1" },
    { key: "grouped-2", incoming: true, unseen: true, attachment: false, fragmentGroup: "message-uid-1" },
    { key: "grouped-3", incoming: true, unseen: true, attachment: false, fragmentGroup: "message-uid-1" },
  ], "grouped-3", "grouped-1"),
  { anchorKey: "grouped-1", boundaryKey: "grouped-3", settleMs: 120 },
  "a proven protocol fragment group shares one short-settle navigation range",
);
assert.deepEqual(
  navigation.incomingNavigationBatch([
    { key: "grouped-1", incoming: true, unseen: true, attachment: false, fragmentGroup: "message-uid-1" },
    { key: "grouped-2", incoming: true, unseen: true, attachment: false, fragmentGroup: "message-uid-1" },
    { key: "next-message", incoming: true, unseen: true, attachment: false, fragmentGroup: "message-uid-2" },
  ], "next-message", "grouped-1"),
  { anchorKey: "next-message", boundaryKey: "next-message", settleMs: 120 },
  "a different protocol group cannot reuse the previous message anchor",
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

baseAssert.equal(assertionCount, 81, "update the declared assertion count when chat-navigation coverage changes");
console.log(`chat navigation rules: ${assertionCount} assertions passed`);
