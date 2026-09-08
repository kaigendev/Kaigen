import assert from "node:assert/strict";
import { importTypeScriptModule } from "./import-typescript-module.mjs";

const notifications = await importTypeScriptModule(
  new URL("../src/chatNotificationTarget.ts", import.meta.url),
);

const now = 2_000_000;
const friendKey = "A1".repeat(32);

assert.deepEqual(
  notifications.parseChatNotificationTarget(
    JSON.stringify({ profileId: "alice", target: "requests", createdAt: now }),
    now,
  ),
  { profileId: "alice", target: "requests", createdAt: now },
  "a current request notice retains its exact profile owner",
);
assert.deepEqual(
  notifications.parseChatNotificationTarget(
    JSON.stringify({ profileId: "bob", target: `friend-key:${friendKey}`, createdAt: now - 1 }),
    now,
  ),
  { profileId: "bob", target: `friend-key:${friendKey}`, createdAt: now - 1 },
  "a friend notice retains its exact profile and stable public-key target",
);

const alice = notifications.parseChatNotificationTarget(
  JSON.stringify({ profileId: "alice", target: `friend-key:${friendKey}`, createdAt: now }),
  now,
);
const bob = notifications.parseChatNotificationTarget(
  JSON.stringify({ profileId: "bob", target: `friend-key:${friendKey}`, createdAt: now }),
  now,
);
assert.notEqual(alice?.profileId, bob?.profileId, "the same friend key in two profiles must not collapse owners");

assert.notEqual(
  notifications.parseChatNotificationTarget(
    JSON.stringify({ profileId: "alice", target: "requests", createdAt: now - notifications.CHAT_NOTIFICATION_TARGET_AGE_MS }),
    now,
  ),
  null,
  "the exact TTL boundary remains actionable",
);
assert.equal(
  notifications.parseChatNotificationTarget(
    JSON.stringify({ profileId: "alice", target: "requests", createdAt: now - notifications.CHAT_NOTIFICATION_TARGET_AGE_MS - 1 }),
    now,
  ),
  null,
  "a notice older than the TTL is rejected",
);
assert.notEqual(
  notifications.parseChatNotificationTarget(
    JSON.stringify({ profileId: "alice", target: "requests", createdAt: now + 1_000 }),
    now,
  ),
  null,
  "the documented one-second clock-skew boundary is accepted",
);
assert.equal(
  notifications.parseChatNotificationTarget(
    JSON.stringify({ profileId: "alice", target: "requests", createdAt: now + 1_001 }),
    now,
  ),
  null,
  "a target too far in the future is rejected",
);

for (const invalid of [
  null,
  "",
  "not-json",
  "null",
  "[]",
  JSON.stringify({ profileId: "", target: "requests", createdAt: now }),
  JSON.stringify({ profileId: " alice", target: "requests", createdAt: now }),
  JSON.stringify({ profileId: "alice ", target: "requests", createdAt: now }),
  JSON.stringify({ profileId: 7, target: "requests", createdAt: now }),
  JSON.stringify({ profileId: "alice", target: "friend-number:7", createdAt: now }),
  JSON.stringify({ profileId: "alice", target: "friend-key:abcd", createdAt: now }),
  JSON.stringify({ profileId: "alice", target: `friend-key:${"g".repeat(64)}`, createdAt: now }),
  JSON.stringify({ profileId: "alice", target: `friend-key:${friendKey} `, createdAt: now }),
  JSON.stringify({ profileId: "alice", target: "requests", createdAt: "now" }),
  JSON.stringify({ profileId: "alice", target: "requests", createdAt: null }),
]) {
  assert.equal(
    notifications.parseChatNotificationTarget(invalid, now),
    null,
    `invalid notification payload must fail closed: ${String(invalid)}`,
  );
}

for (const invalidNow of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
  assert.equal(
    notifications.parseChatNotificationTarget(
      JSON.stringify({ profileId: "alice", target: "requests", createdAt: now }),
      invalidNow,
    ),
    null,
    "notification parsing requires a finite local clock",
  );
}

console.log("chat notification target owner, TTL, and invalid-payload rules: PASS");
