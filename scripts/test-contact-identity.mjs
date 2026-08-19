import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { importTypeScriptModule } from "./import-typescript-module.mjs";

const identity = await importTypeScriptModule(new URL("../src/contactIdentity.ts", import.meta.url));
const friends = [
  { number: 7, public_key: "A1B2" },
  { number: 9, public_key: "C3D4" },
];

assert.equal(identity.toxChatId("a1b2"), "tox-A1B2");
assert.equal(identity.migrateLegacyToxChatId("tox-7", friends), "tox-A1B2");
assert.equal(identity.migrateLegacyToxChatId("tox-A1B2", friends), "tox-A1B2");
assert.equal(identity.migrateLegacyToxChatId("tox-404", friends), "tox-404");

const legacyNames = { "tox-7": "Alice", "tox-C3D4": "Bob", untouched: "Local" };
assert.deepEqual(identity.migrateLegacyContactRecord(legacyNames, friends), {
  "tox-A1B2": "Alice",
  "tox-C3D4": "Bob",
  untouched: "Local",
});
const preferredStableName = { "tox-7": "stale", "tox-A1B2": "stable" };
assert.deepEqual(identity.migrateLegacyContactRecord(preferredStableName, friends), {
  "tox-A1B2": "stable",
});

assert.equal(identity.resolveFriendChatId("a1b2", 99, friends), "tox-A1B2");
assert.equal(identity.resolveFriendChatId(undefined, 9, friends), "tox-C3D4");
assert.equal(identity.resolveFriendChatId(undefined, 99, friends), undefined);

function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function migrateAfterPromiseOrder(firstToSettle) {
  let coreFriends = [];
  let persistenceReady = false;
  let activeChat = "";
  let contactNames = {};
  let drafts = {};

  const runMigrationEffect = () => {
    if (!persistenceReady) return;
    activeChat = identity.migrateLegacyToxChatId(activeChat, coreFriends);
    contactNames = identity.migrateLegacyContactRecord(contactNames, coreFriends);
    drafts = identity.migrateLegacyContactRecord(drafts, coreFriends);
  };

  const friendsReady = deferred();
  const localStateReady = deferred();
  const friendsTask = friendsReady.promise.then((nextFriends) => {
    coreFriends = nextFriends;
    runMigrationEffect();
  });
  const localStateTask = localStateReady.promise.then((saved) => {
    activeChat = saved.activeChat;
    contactNames = saved.contactNames;
    drafts = saved.drafts;
    persistenceReady = true;
    runMigrationEffect();
  });
  const saved = {
    activeChat: "tox-7",
    contactNames: { "tox-7": "Alice" },
    drafts: { "tox-7": "unsent" },
  };

  if (firstToSettle === "friends") {
    friendsReady.resolve(friends);
    await friendsTask;
    localStateReady.resolve(saved);
  } else {
    localStateReady.resolve(saved);
    await localStateTask;
    friendsReady.resolve(friends);
  }
  await Promise.all([friendsTask, localStateTask]);

  return { activeChat, contactNames, drafts };
}

const migratedAfterFriendsFirst = await migrateAfterPromiseOrder("friends");
const migratedAfterLocalStateFirst = await migrateAfterPromiseOrder("local-state");
const expectedMigratedState = {
  activeChat: "tox-A1B2",
  contactNames: { "tox-A1B2": "Alice" },
  drafts: { "tox-A1B2": "unsent" },
};
assert.deepEqual(migratedAfterFriendsFirst, expectedMigratedState);
assert.deepEqual(migratedAfterLocalStateFirst, expectedMigratedState);

const [appSource, coreSource, settingsSource] = await Promise.all([
  readFile(new URL("../src/App.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8"),
  readFile(new URL("../src/Settings.tsx", import.meta.url), "utf8"),
]);
assert.match(appSource, /id: toxChatId\(friend\.public_key\)/);
assert.doesNotMatch(appSource, /id: `tox-\$\{friend\.number\}`/);
const migrationEffectStart = appSource.indexOf("const pendingNumber = pendingUnreadFriendNumber.current;");
const migrationEffectEnd = appSource.indexOf("\n\n  useEffect", migrationEffectStart);
const migrationEffectSource = appSource.slice(migrationEffectStart, migrationEffectEnd);
assert.match(migrationEffectSource, /if \(!persistenceReady\) return;/);
assert.match(migrationEffectSource, /\}, \[coreFriends, persistenceReady\]\);/);
assert.match(coreSource, /TOX_PROFILE_IDENTITY_ALREADY_LOADED/);
assert.match(coreSource, /friend_public_key: String/);
assert.match(settingsSource, /Один Tox-профиль нельзя одновременно запускать/);

console.log("stable contact identity regressions passed");
