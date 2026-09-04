import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { importTypeScriptModule } from "./import-typescript-module.mjs";

const layout = await importTypeScriptModule(new URL("../src/appLayout.ts", import.meta.url));

assert.deepEqual(
  layout.normalizeProfileOrder(["beta", "stale", "beta", ""], ["alpha", "beta", "gamma", "alpha"]),
  ["beta", "alpha", "gamma"],
  "saved order keeps known unique profiles and appends new profiles",
);
assert.deepEqual(
  layout.moveProfileOrder(["alpha", "beta", "gamma"], ["alpha", "beta", "gamma"], "gamma", "alpha", "before"),
  ["gamma", "alpha", "beta"],
  "dragging before the first profile persists the requested order",
);
assert.deepEqual(
  layout.moveProfileOrder(["alpha", "beta", "gamma"], ["alpha", "beta", "gamma"], "alpha", "gamma", "after"),
  ["beta", "gamma", "alpha"],
  "dragging after the last profile persists the requested order",
);
assert.deepEqual(
  layout.moveProfileOrder(["beta", "alpha"], ["alpha", "beta"], "missing", "alpha", "before"),
  ["beta", "alpha"],
  "an unknown drag source cannot corrupt the saved order",
);
assert.deepEqual(
  layout.moveProfileOrder(["beta", "alpha"], ["alpha", "beta"], "beta", "missing", "after"),
  ["beta", "alpha"],
  "an unknown drop target cannot corrupt the saved order",
);
assert.deepEqual(
  layout.moveProfileOrder(["alpha", "locked", "gamma"], ["alpha", "locked", "gamma"], "gamma", "alpha", "before"),
  ["gamma", "alpha", "locked"],
  "reordering loaded profiles retains a temporarily locked profile in persistent order",
);
assert.deepEqual(
  layout.normalizeProfileOrder(["gamma", "alpha", "beta"], ["alpha", "gamma", "delta"]),
  ["gamma", "alpha", "delta"],
  "restart normalization removes disabled profiles and appends newly loaded profiles",
);

const [appSource, rootSource, cssSource, nativeSource, webServerSource] = await Promise.all([
  readFile(new URL("../src/App.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/RootApp.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/App.css", import.meta.url), "utf8"),
  readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8"),
  readFile(new URL("../web/kaigen-webd/src/server.rs", import.meta.url), "utf8"),
]);

assert.match(appSource, /profileOrder: string\[\]/);
assert.match(appSource, /invoke\("save_layout_state", \{ state: sharedLayoutState \}\)/);
assert.match(appSource, /Array\.isArray\(saved\.profileOrder\)/);
assert.match(appSource, /await onStatusChange\(profileId, status\)/);
assert.doesNotMatch(appSource, /statusContext\?\.profileId === activeId/,
  "becoming or already being active must not close the profile status menu");
assert.doesNotMatch(appSource, /if \(profile\.active \|\| switching\)/,
  "the active profile must accept the same context-menu gesture as inactive profiles");
assert.doesNotMatch(appSource, /statusContext && contextProfile && !contextProfile\.active/,
  "the active profile status menu must render");
assert.match(appSource, /aria-haspopup="menu" aria-expanded=\{menuOpen\}/,
  "every loaded profile exposes status-menu accessibility semantics");
assert.match(appSource, /onProfileOrderChange\(moveProfileOrder\(/);
assert.match(appSource, /event\.key === "ContextMenu" \|\| \(event\.shiftKey && event\.key === "F10"\)/);
assert.match(appSource, /event\.altKey && \(event\.key === "ArrowLeft" \|\| event\.key === "ArrowRight"\)/);
assert.match(appSource, /role="alert">\{statusError\}/);
assert.match(cssSource, /\.inactive-profile-status-menu \.inactive-profile-status-option:disabled/);
assert.match(cssSource, /\.inactive-profile-status-error/);

assert.match(rootSource, /invoke\("set_profile_user_status", \{ profileId, status \}\)/);
assert.match(rootSource, /await refresh\(\)/);
assert.match(rootSource, /onProfileStatusChange=\{changeProfileStatus\}/);
assert.match(rootSource, /onSwitchProfile=\{switchProfile\}/,
  "App must await the one serialized root profile switch");

assert.match(appSource, /invoke\("save_local_state", \{ profileId: activeProfileId, state \}\)/,
  "local state writes are bound to the mounted profile identity");
assert.match(appSource, /invoke<LocalState \| null>\("load_local_state", \{ profileId: activeProfileId \}\)/,
  "local state reads are bound to the mounted profile identity");
assert.doesNotMatch(appSource, /setProfileAvatar\(saved\.profileAvatar\)/,
  "stale local state cannot replace the mounted profile's authoritative self-avatar");
assert.doesNotMatch(appSource, /setProfileName\(saved\.profileName\)/,
  "stale local state cannot replace the mounted profile's authoritative name");
assert.match(appSource, /profileSwitchRequestRef\.current/,
  "rapid clicks share one in-flight profile switch boundary");
assert.match(appSource, /invoke\("set_profile_avatar", \{[\s\S]*?profileId: activeProfileId,[\s\S]*?dataUrl:/,
  "avatar normalization commits only through an exact-profile command");

assert.match(nativeSource, /fn set_profile_user_status\(/);
assert.match(nativeSource, /\.get\(&profile_id\)[\s\S]*?PROFILE_NOT_LOADED/);
assert.match(nativeSource, /set_profile_user_status,[\s\S]*?get_tox_status_message/);

assert.match(webServerSource, /"set_profile_user_status" => \{/);
assert.match(webServerSource, /set_stored_profile_status\(stored, &profile_id, args\)/);
assert.match(webServerSource, /set_presence\(profile_id, previous\)/);
assert.match(webServerSource, /\| "set_profile_user_status"/);

console.log("profile switcher status and persistent-order regressions passed");
