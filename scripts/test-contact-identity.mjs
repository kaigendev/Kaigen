import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { importTypeScriptModule } from "./import-typescript-module.mjs";

const identity = await importTypeScriptModule(new URL("../src/contactIdentity.ts", import.meta.url));
const friends = [
  { number: 7, public_key: "A1B2" },
  { number: 9, public_key: "C3D4" },
];

assert.equal(identity.toxChatId("a1b2"), "tox-A1B2");

assert.equal(identity.resolveFriendChatId("a1b2", 99, friends), "tox-A1B2");
assert.equal(identity.resolveFriendChatId(undefined, 9, friends), "tox-C3D4");
assert.equal(identity.resolveFriendChatId(undefined, 99, friends), undefined);

const [appSource, coreSource, settingsSource] = await Promise.all([
  readFile(new URL("../src/App.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8"),
  readFile(new URL("../src/Settings.tsx", import.meta.url), "utf8"),
]);
assert.match(appSource, /id: toxChatId\(friend\.public_key\)/);
assert.doesNotMatch(appSource, /id: `tox-\$\{friend\.number\}`/);
assert.match(coreSource, /TOX_PROFILE_IDENTITY_ALREADY_LOADED/);
assert.match(coreSource, /friend_public_key: String/);
assert.match(settingsSource, /Один Tox-профиль нельзя одновременно запускать/);

console.log("stable contact identity regressions passed");
