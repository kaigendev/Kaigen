import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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

const [root, app, desktop, web, settings] = await Promise.all(["RootApp.tsx", "App.tsx", "desktopNotifications.ts", "platform/web.ts", "Settings.tsx"].map((file) => readFile(new URL(`../src/${file}`, import.meta.url), "utf8")));
assert.match(root, /useEffect\(installDesktopNotifications, \[\]\)/u, "native notifications are subscribed once at the application root");
assert.match(desktop, /if \(!platformCapabilities\.nativeFilesystem\) return/u, "Web never installs the desktop event listeners");
assert.match(desktop, /listen<number>\("kaigen-message-sound"/u);
assert.match(desktop, /"kaigen-notification-activate"/u);
assert.match(desktop, /const now = Date\.now\(\)/u, "the routing TTL begins at notification activation");
assert.match(desktop, /import signal from "\.\/assets\/signal\.wav"/u);
assert.doesNotMatch(`${app}\n${root}`, /className="(?:event-notices|profile-event-notices)"|sendNotification\(/u, "native popups have no in-window replacement");
assert.doesNotMatch(web, /new Notification\b|Notification\.(?:requestPermission|permission)/u, "Web does not invoke the Browser Notification API or request permission");
assert.match(settings, /tabs\.filter\(\(\[id\]\) => id !== "notifications" \|\| platformCapabilities\.nativeFilesystem\)/u);
assert.match(settings, /platformCapabilities\.nativeFilesystem && tab === "notifications"/u);
console.log("chat notification owner, TTL, invalid payloads, app-root lifecycle and Web exclusion: PASS");
