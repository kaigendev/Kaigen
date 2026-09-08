import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { importTypeScriptModule } from "./import-typescript-module.mjs";

const { TransferPreviewRegistry } = await importTypeScriptModule(
  new URL("../src/web/transferPreviewRegistry.ts", import.meta.url),
);

function transferId(character) {
  return character.repeat(32);
}

function harness(options = {}) {
  let now = 0;
  let nextTimer = 0;
  let nextUrl = 0;
  const timers = new Map();
  const created = [];
  const revoked = [];
  const invalidated = [];
  const registry = new TransferPreviewRegistry({
    ttlMs: options.ttlMs ?? 100,
    maxEntries: options.maxEntries ?? 8,
    maxBytes: options.maxBytes ?? 1024,
    now: () => now,
    createObjectURL: (blob) => {
      const url = `blob:test-${++nextUrl}-${blob.size}`;
      created.push(url);
      return url;
    },
    revokeObjectURL: (url) => revoked.push(url),
    schedule: (callback, delayMs) => {
      const id = ++nextTimer;
      timers.set(id, { callback, due: now + delayMs });
      return id;
    },
    cancel: (id) => timers.delete(id),
    onInvalidate: (preview) => invalidated.push(preview),
  });
  const advance = (milliseconds) => {
    now += milliseconds;
    for (let guard = 0; guard < 100; guard += 1) {
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.due <= now)
        .sort((left, right) => left[1].due - right[1].due || left[0] - right[0])[0];
      if (!due) break;
      timers.delete(due[0]);
      due[1].callback();
    }
  };
  const elapseWithoutTimers = (milliseconds) => { now += milliseconds; };
  return { registry, created, revoked, invalidated, advance, elapseWithoutTimers };
}

{
  const { registry, revoked, invalidated, advance } = harness({ ttlMs: 100, maxEntries: 3, maxBytes: 12 });
  const first = transferId("a");
  const unpinned = transferId("b");
  registry.setOwnerActive("profile-a", 4, true);
  registry.setPins("profile-a", 4, [first]);
  const lease = registry.captureOwner("profile-a", 4);
  const firstUrl = registry.remember(first, new Blob([new Uint8Array(8)]), lease);
  assert.equal(registry.source("profile-a", 4, first), firstUrl);
  assert.equal(
    registry.remember(unpinned, new Blob([new Uint8Array(8)]), lease),
    "",
    "an active chat protects visible pins only; an unpinned URL can be evicted for the global byte budget",
  );
  assert.equal(registry.source("profile-a", 4, first), firstUrl, "the visible active preview stays alive");

  const replacementUrl = registry.remember(first, new Blob([new Uint8Array(6)]), lease);
  assert.notEqual(replacementUrl, firstUrl);
  assert.ok(revoked.includes(firstUrl), "replacing a transfer preview revokes its previous Object URL");
  registry.setOwnerActive("profile-a", 4, false);
  advance(99);
  assert.equal(registry.source("profile-a", 4, first), replacementUrl, "a left chat retains its cached preview before the two-hour-equivalent TTL");
  advance(1);
  assert.equal(registry.source("profile-a", 4, first), "", "the leave TTL revokes the inactive preview");
  assert.ok(revoked.includes(replacementUrl));
  assert.ok(invalidated.some((entry) => entry.profileId === "profile-a" && entry.friendNumber === 4 && entry.transferId === first),
    "URL revocation identifies the owner so cached message snapshots can discard stale Blob URLs");

  const lateUrl = registry.remember(first, new Blob([new Uint8Array(6)]), lease);
  assert.match(lateUrl, /^blob:test-/u,
    "a late completion after ordinary leave starts a fresh bounded inactive TTL");
  advance(50);
  const lateReplacementUrl = registry.remember(first, new Blob([new Uint8Array(5)]), lease);
  assert.ok(revoked.includes(lateUrl), "an inactive replacement still revokes the previous Object URL");
  advance(50);
  assert.equal(registry.source("profile-a", 4, first), lateReplacementUrl,
    "an inactive replacement gets a fresh bounded TTL instead of inheriting an almost-expired deadline");
  advance(50);
  assert.equal(registry.source("profile-a", 4, first), "", "the late inactive completion cannot become an unbounded cache");
}

{
  const { registry, created, revoked } = harness();
  const late = transferId("c");
  const lease = registry.captureOwner("profile-b", 8);
  registry.setOwnerActive("profile-b", 8, true);
  registry.releaseOwner("profile-b", 8, true);
  assert.equal(registry.remember(late, new Blob(["late"]), lease), "");
  assert.equal(created.length, 0, "a completion captured before contact deletion cannot recreate an Object URL");

  const reset = transferId("d");
  const resetLease = registry.captureOwner("profile-b", 9);
  registry.setOwnerActive("profile-b", 9, true);
  const resetUrl = registry.remember(reset, new Blob(["reset"]), resetLease);
  registry.clear();
  assert.ok(revoked.includes(resetUrl), "profile lock clears every retained Object URL");
  assert.equal(registry.remember(reset, new Blob(["stale"]), resetLease), "");
  assert.equal(created.length, 1, "a callback from the previous workspace generation stays rejected");
}

{
  const { registry, advance } = harness({ ttlMs: 100 });
  const id = transferId("e");
  registry.setOwnerActive("profile-c", 2, true);
  registry.setPins("profile-c", 2, [id]);
  const url = registry.remember(id, new Blob(["cached"]), registry.captureOwner("profile-c", 2));
  registry.setOwnerActive("profile-c", 2, false);
  advance(50);
  registry.setOwnerActive("profile-c", 2, true);
  advance(100);
  assert.equal(registry.source("profile-c", 2, id), url, "reopening before expiry cancels the inactive TTL");
  assert.equal(registry.releaseOwner("profile-c", 2), 0, "normal release cannot revoke an active chat");
  assert.equal(registry.releaseOwner("profile-c", 2, true), 1, "contact deletion force-releases an active preview");
  assert.equal(registry.source("profile-c", 2, id), "");
}

{
  const { registry } = harness();
  const first = transferId("f");
  const second = transferId("g");
  registry.remember(first, new Blob(["first"]), registry.captureOwner("profile-one", 1));
  registry.remember(second, new Blob(["second"]), registry.captureOwner("profile-two", 1));
  assert.equal(registry.releaseProfile("profile-one"), 1);
  assert.equal(registry.source("profile-one", 1, first), "");
  assert.match(registry.source("profile-two", 1, second), /^blob:test-/u, "profile release cannot revoke another profile's cache");
  registry.clear();
}

{
  const { registry, revoked } = harness();
  const shared = transferId("z");
  const firstUrl = registry.remember(shared, new Blob(["one"]), registry.captureOwner("profile-one", 7));
  const secondUrl = registry.remember(shared, new Blob(["two"]), registry.captureOwner("profile-two", 7));
  assert.notEqual(firstUrl, secondUrl, "the same untrusted transfer ID is isolated by profile and contact owner");
  assert.equal(registry.source("profile-one", 7, shared), firstUrl);
  assert.equal(registry.source("profile-two", 7, shared), secondUrl);
  assert.equal(registry.source("profile-one", 8, shared), "", "another contact cannot resolve the owner's Blob URL");
  assert.equal(registry.releaseOwner("profile-one", 7, true), 1);
  assert.ok(revoked.includes(firstUrl));
  assert.equal(registry.source("profile-two", 7, shared), secondUrl,
    "releasing one owner cannot revoke an equal transfer ID owned by another profile");
  registry.clear();
}

{
  const { registry, invalidated, elapseWithoutTimers } = harness({ ttlMs: 100 });
  const id = transferId("h");
  registry.remember(id, new Blob(["stale"]), registry.captureOwner("profile-render", 3));
  elapseWithoutTimers(101);
  assert.equal(registry.source("profile-render", 3, id), "",
    "an expired preview is never returned when a background timer was throttled");
  assert.equal(invalidated.length, 0,
    "render-time source lookup does not synchronously dispatch an invalidation event");
  registry.sweep();
  assert.equal(invalidated.length, 1, "the scheduled/effect-side sweep performs the eventual revocation");
}

const session = await readFile(new URL("../src/web/session.ts", import.meta.url), "utf8");
const webPlatform = await readFile(new URL("../src/platform/web.ts", import.meta.url), "utf8");
const desktopPlatform = await readFile(new URL("../src/platform/desktop.ts", import.meta.url), "utf8");
assert.match(session, /recoverIncomingTransfer\(work\.profileId, work\.messageId, work\.transferId, work\.friendNumber\)/u);
assert.match(session, /return this\.rememberTransferPreview\(transfer\.id, cached, previewOwner\)/u,
  "completed recovery reports success only while its replacement Object URL is retained");
assert.match(session, /kaigen:transfer-preview-invalidated/u,
  "eviction tells the renderer to discard any cached revoked Blob URL");
for (const source of [webPlatform, desktopPlatform]) {
  assert.match(source, /export function setTransferPreviewChatActive/u);
  assert.match(source, /export function setTransferPreviewPins/u);
  assert.match(source, /export function releaseTransferPreviews/u);
  assert.match(source, /export function transferPreviewSource/u);
}

console.log("Transfer preview registry lifecycle tests passed.");
