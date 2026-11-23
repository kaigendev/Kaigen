import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { stripTypeScriptTypes } from "node:module";
import { importTypeScriptModule } from "./import-typescript-module.mjs";

const layout = await importTypeScriptModule(new URL("../src/appLayout.ts", import.meta.url));
const { contactPresence, profilePresence } = await importTypeScriptModule(new URL("../src/profilePresence.ts", import.meta.url));
const { formatProfileSwitcherTitle } = await importTypeScriptModule(new URL("../src/localization.ts", import.meta.url));
const { createWebgatePlatformRouter, isWebgateProfileId } = await importTypeScriptModule(new URL("../src/webgate/platformRouter.ts", import.meta.url));

for (const userStatus of ["online", "away", "busy", "offline"]) {
  for (const connection of ["udp", "tcp", "offline", "locked"]) {
    const expected = userStatus === "offline" || connection === "locked" ? "offline" : connection === "offline" ? "connecting" : userStatus;
    assert.equal(profilePresence({ loaded: true, userStatus, connection }), expected,
      `${userStatus}/${connection}: visible presence requires a live transport`);
    assert.equal(profilePresence({ loaded: false, userStatus, connection }), "offline", "an unloaded profile cannot claim a connection");
  }
}
assert.equal(formatProfileSwitcherTitle("QA", "connecting", "ru"), "QA · Подключаюсь…");
assert.equal(formatProfileSwitcherTitle("QA", "connecting", "en"), "QA · Connecting…");

// A successful disconnect must change every visible friend before another poll.
// Keep the same backend snapshot to reproduce stale toxcore/HTTP responses.
for (const status of ["online", "away", "busy"]) {
  const staleFriend = Object.freeze({ connection: "online", status });
  assert.equal(contactPresence(staleFriend, "online", "online"), status);
  assert.equal(contactPresence(staleFriend, "offline", "online"), "offline",
    "an in-flight online poll cannot undo the explicit offline selection");
  assert.equal(contactPresence(staleFriend, "offline", "offline"), "offline");
  assert.equal(contactPresence(staleFriend, "online", "connecting"), "offline",
    "reconnecting does not revive a cached friend presence before our route is ready");
  assert.equal(contactPresence(staleFriend, "online", "connecting-tor"), "offline");
  assert.equal(contactPresence(staleFriend, "online", "offline"), "offline",
    "transport loss masks presence even when the selected user status stays online");
  assert.equal(contactPresence(staleFriend, "online", "online"), status,
    "presence is restored when transport and friend are online");
  assert.deepEqual(staleFriend, { connection: "online", status });
  assert.equal(contactPresence({ connection: "offline", status }, "online", "online"), "offline",
    "a disconnected friend cannot advertise a retained availability preference");
}

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

const [appSource, rootSource, cssSource, nativeSource, webServerSource, realtimeSource] = await Promise.all([
  readFile(new URL("../src/App.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/RootApp.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/App.css", import.meta.url), "utf8"),
  readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8"),
  readFile(new URL("../web/kaigen-webd/src/server.rs", import.meta.url), "utf8"),
  readFile(new URL("../src/webgate/realtime.ts", import.meta.url), "utf8"),
]);

// Execute the real App effects and command callback with deferred bridge replies.
// This catches ordering bugs that the presence truth table alone cannot detect.
function readAppEffect(source, anchor) {
  const position = source.indexOf(anchor);
  assert.ok(position >= 0, `missing App effect: ${anchor}`);
  const start = source.lastIndexOf("  useEffect(() => {", position);
  const end = source.indexOf("\n  }, [", position);
  assert.ok(start >= 0 && end > position, `invalid App effect: ${anchor}`);
  return source.slice(start, source.indexOf("\n", end + 1));
}

const historyPreferenceEffect = readAppEffect(appSource, 'invoke("set_chat_history_enabled"');
let activeRemote = true;
const historyCommands = [];
const routeHistoryPreference = createWebgatePlatformRouter(async (command, args) => {
  if (command === "webgate_profiles") return {
    profiles: [
      { id: "local-profile", loaded: true, active: !activeRemote },
      { id: "wg-remote-profile", loaded: true, active: activeRemote },
    ],
  };
  historyCommands.push({ route: command, ...args });
});
function applyHistoryPreference(profileId, ready, enabled) {
  vm.runInNewContext(historyPreferenceEffect, {
    useEffect: (effect) => effect(),
    invoke: routeHistoryPreference,
    activeProfileId: profileId,
    persistenceReady: ready,
    saveChatHistory: enabled,
    console,
  });
}

await routeHistoryPreference("webgate_profiles");
applyHistoryPreference("local-profile", false, false);
applyHistoryPreference("", true, true);
assert.equal(historyCommands.length, 0, "history preference waits for a loaded owner");
applyHistoryPreference("local-profile", true, false);
assert.deepEqual(historyCommands[0], { route: "set_chat_history_enabled", profileId: "local-profile", enabled: false },
  "a local preference must stay local when the Webgate profile became active first");

activeRemote = false;
await routeHistoryPreference("webgate_profiles");
applyHistoryPreference("wg-remote-profile", true, true);
assert.equal(historyCommands[1]?.route, "webgate_invoke");
assert.equal(historyCommands[1]?.profileId, "wg-remote-profile");
assert.equal(historyCommands[1]?.args.profileId, "wg-remote-profile");
assert.equal(historyCommands[1]?.args.enabled, true,
  "a Webgate preference must keep its remote owner after switching back to Local");

async function continueWithProfiles(profiles, expectedActive, expectedCalls) {
  const calls = [];
  const port = createWebgatePlatformRouter(async (command, args) => {
    calls.push(command);
    if (command === "webgate_profiles") return { profiles };
    if (command === "continue_with_loaded_profiles") {
      const local = profiles.find((profile) => profile.loaded && !isWebgateProfileId(profile.id));
      if (local) profiles = profiles.map((profile) => ({ ...profile, active: profile.id === local.id }));
      return profiles;
    }
    assert.equal(command, "webgate_select_profile");
    assert.equal(args.profileId, expectedActive);
    assert.ok(profiles.some((profile) => profile.id === args.profileId && profile.loaded));
    profiles = profiles.map((profile) => ({ ...profile, active: profile.id === args.profileId }));
    return { profiles };
  });

  await port("webgate_profiles");
  calls.length = 0;
  const resumed = await port("continue_with_loaded_profiles");
  assert.deepEqual(calls, expectedCalls);
  assert.deepEqual(resumed.filter((profile) => profile.active && profile.loaded).map((profile) => profile.id),
    expectedActive ? [expectedActive] : []);
}

const lockedLocal = { id: "local", loaded: false, active: true };
const loadedRemote = { id: "wg-loaded", loaded: true, active: false };
const lockedRemote = { id: "wg-locked", loaded: false, active: false };
const normalContinue = ["continue_with_loaded_profiles", "webgate_profiles"];
await continueWithProfiles([lockedLocal, lockedRemote, loadedRemote], "wg-loaded", [...normalContinue, "webgate_select_profile"]);
await continueWithProfiles([{ ...lockedLocal, loaded: true }, loadedRemote], "local", normalContinue);
await continueWithProfiles([{ ...lockedLocal, active: false }, { ...loadedRemote, active: true }], "wg-loaded", ["webgate_profiles"]);
await continueWithProfiles([lockedLocal, lockedRemote], null, normalContinue);

function deferredReply() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function drainReplies() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function ownPresenceHarness(source, initialStatus = "online") {
  const effects = [];
  const requests = [];
  const commands = [];
  const listeners = new Map();
  const intervals = new Set();
  const state = { userStatus: initialStatus, networkStatus: initialStatus, menuOpen: true };
  const context = {
    activeProfileId: "active",
    activeProfileAtMount: { id: "active", userStatus: initialStatus },
    ownPresenceRevisionRef: { current: 0 },
    document: Object.assign(new EventTarget(), { visibilityState: "visible" }),
    isWebgateProfileId,
    console,
    useEffect: (setup) => effects.push(setup),
    setUserStatus: (value) => { state.userStatus = typeof value === "function" ? value(state.userStatus) : value; },
    setNetworkStatus: (value) => { state.networkStatus = typeof value === "function" ? value(state.networkStatus) : value; },
    setStatusMenuOpen: (value) => { state.menuOpen = value; },
    window: Object.assign(new EventTarget(), {
      setInterval: (callback) => { intervals.add(callback); return callback; },
      clearInterval: (callback) => intervals.delete(callback),
    }),
    invoke: (command) => { const reply = deferredReply(); requests.push({ command, ...reply }); return reply.promise; },
    listen: (name, callback) => { listeners.set(name, callback); return Promise.resolve(() => listeners.delete(name)); },
    onProfileStatusChange: (profileId, status) => { const reply = deferredReply(); commands.push({ profileId, status, ...reply }); return reply.promise; },
  };
  const start = source.indexOf("  async function changeProfileStatus(");
  const end = source.indexOf("\n  function changeUserStatus(", start);
  assert.ok(start >= 0 && end > start, "missing real App status command callback");
  const code = [
    // Keep the real coalescing/visibility scheduler; replace only its platform imports.
    realtimeSource.replace(/^import[^\n]*\r?\n/gmu, "").replace("export function watchProfileUpdates", "function watchProfileUpdates"),
    readAppEffect(source, "if (!activeProfileAtMount) return;"),
    readAppEffect(source, 'listen<string>("active-user-status-changed"'),
    readAppEffect(source, 'invoke<UserStatus>("get_tox_user_status")'),
    readAppEffect(source, 'invoke<NetworkStatus>("get_tox_network_status")'),
    source.slice(start, end),
    "globalThis.changeStatus = changeProfileStatus;",
  ].join("\n");
  vm.runInNewContext(stripTypeScriptTypes(code), context);
  const cleanup = effects.map((setup) => setup());
  return {
    state, context, requests, commands,
    changeStatus: context.changeStatus,
    emit: (status) => listeners.get("active-user-status-changed")?.({ payload: status }),
    props: (status) => { context.activeProfileAtMount = { id: "active", userStatus: status }; effects[0](); },
    tick: () => { for (const callback of intervals) callback(); },
    dispose: () => { for (const callback of cleanup) callback?.(); },
  };
}

for (const transition of ["command", "event", "props"]) {
  const harness = ownPresenceHarness(appSource);
  try {
    assert.equal(harness.requests.length, 2);
    if (transition === "command") {
      const command = harness.changeStatus("active", "offline");
      harness.commands[0].resolve();
      await command;
    } else if (transition === "event") harness.emit("offline");
    else harness.props("offline");
    assert.equal(harness.state.userStatus, "offline", `${transition}: confirmed disconnect updates own status`);
    assert.equal(harness.state.networkStatus, "offline", `${transition}: confirmed disconnect updates transport`);
    for (const reply of harness.requests) reply.resolve("online");
    await drainReplies();
    assert.equal(harness.state.userStatus, "offline", `${transition}: late own-status response must not undo disconnect`);
    assert.equal(harness.state.networkStatus, "offline", `${transition}: late network response must not undo disconnect`);
    harness.emit("online");
    assert.equal(harness.state.networkStatus, "connecting", "reconnect waits for a fresh transport result");
    harness.tick();
    harness.requests.at(-1).resolve("online");
    await drainReplies();
    assert.equal(harness.state.userStatus, "online");
    assert.equal(harness.state.networkStatus, "online", "a fresh connection response restores presence");
  } finally { harness.dispose(); }
}

{
  const harness = ownPresenceHarness(appSource, "offline");
  try {
    harness.tick(); harness.tick(); harness.tick();
    assert.equal(harness.requests.filter(({ command }) => command === "get_tox_network_status").length, 1,
      "a slow network request must not overlap newer polls");
    harness.requests.find(({ command }) => command === "get_tox_user_status").resolve("busy");
    harness.requests.find(({ command }) => command === "get_tox_network_status").resolve("online");
    await drainReplies();
    assert.equal(harness.state.userStatus, "busy", "a current mount reply remains authoritative");
    assert.equal(harness.state.networkStatus, "online");
    assert.equal(harness.requests.length, 3, "pending refresh events coalesce into one follow-up after the slow request settles");
    harness.requests.at(-1).resolve("online");
    await drainReplies();
    harness.context.document.visibilityState = "hidden";
    harness.tick();
    assert.equal(harness.requests.length, 3, "hidden tabs do not poll");
    harness.context.document.visibilityState = "visible";
    harness.tick();
    assert.equal(harness.requests.length, 4, "polling resumes after the previous request settles");
    harness.requests.at(-1).reject(new Error("synthetic transport failure"));
    await drainReplies();
    harness.tick();
    assert.equal(harness.requests.length, 5, "a failed request must not lock the polling loop");
  } finally { harness.dispose(); }
}

{
  const harness = ownPresenceHarness(appSource, "offline");
  harness.dispose();
  for (const reply of harness.requests) reply.resolve("online");
  harness.emit("online");
  await drainReplies();
  assert.equal(harness.state.userStatus, "offline", "unmounted profile ignores late responses and events");
  assert.equal(harness.state.networkStatus, "offline");
}

{
  const harness = ownPresenceHarness(appSource);
  try {
    const oldCommand = harness.changeStatus("active", "offline");
    const newCommand = harness.changeStatus("active", "busy");
    harness.commands[1].resolve();
    await newCommand;
    harness.commands[0].resolve();
    await oldCommand;
    assert.equal(harness.state.userStatus, "busy", "an older command completion cannot replace the newer selection");
    const rejected = harness.changeStatus("active", "offline");
    harness.commands[2].reject(new Error("synthetic command failure"));
    await assert.rejects(rejected, /synthetic command failure/);
    assert.equal(harness.state.userStatus, "busy", "failed disconnect must not advertise success");
    const inactive = harness.changeStatus("background", "offline");
    harness.commands[3].resolve();
    await inactive;
    assert.equal(harness.state.userStatus, "busy", "background profile command cannot change active presence");
  } finally { harness.dispose(); }
}
// End of real App presence concurrency regressions.

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

const localPersistence = appSource.match(/const persistLocalState = useCallback\([\s\S]*?^  \}, \[[^\r\n]*\]\);/mu)?.[0] ?? "";
assert.match(localPersistence, /owner = captureProfileOwner\(\);[^]*const state = structuredClone\([^]*const save = enqueueLocalStateOperation\(async \(\) => \{[^]*if \(!appOwnerMountedRef\.current\) throw new Error\("PROFILE_OWNER_CHANGED"\);[^]*await invoke\("save_local_state", \{ profileId: owner\.profileId, state \}\);/u,
  "local state captures mounted owner and bytes before queueing, then writes only that profile");
assert.match(appSource, /const enqueueLocalStateOperation = useCallback\([^]*const result = localSaveQueueRef\.current\.catch\(\(\) => \{\}\)\.then\(operation\);\s*localSaveQueueRef\.current = result\.then\(\(\) => \{\}, \(\) => \{\}\);\s*return result;/u,
  "all saved local state operations use the same queue and return their own result");
assert.match(appSource, /const captureProfileOwner = useCallback\(\(\): ProfileOwnerLease => \{[^]*if \(!appOwnerMountedRef\.current \|\| !activeProfileId \|\| owner\.profileId !== activeProfileId\) throw new Error\("PROFILE_OWNER_CHANGED"\);\s*return \{ profileId: activeProfileId, generation: owner\.generation \};/u,
  "the saved owner lease originates from the mounted profile and current generation");
assert.match(localPersistence, /return required \? save : save\.catch\(\(\) => false\);/u,
  "a required profile save awaits its own serialized durable result");
assert.match(appSource, /invoke<LocalState \| null>\("load_local_state", \{ profileId: activeProfileId \}\)/,
  "local state reads are bound to the mounted profile identity");
assert.doesNotMatch(appSource, /setProfileAvatar\(saved\.profileAvatar\)/,
  "stale local state cannot replace the mounted profile's authoritative self-avatar");
assert.doesNotMatch(appSource, /setProfileName\(saved\.profileName\)/,
  "stale local state cannot replace the mounted profile's authoritative name");
assert.match(appSource, /profileSwitchRequestRef\.current/,
  "rapid clicks share one in-flight profile switch boundary");
const avatarCallbackStart = appSource.indexOf("  function updateProfileAvatar(");
const avatarCallbackEnd = appSource.indexOf("\n  function showAttachmentInFolder(", avatarCallbackStart);
assert.ok(avatarCallbackStart >= 0 && avatarCallbackEnd > avatarCallbackStart, "exact avatar callback is present");
const avatarCallback = appSource.slice(avatarCallbackStart, avatarCallbackEnd);
assert.match(avatarCallback, /const owner = activeProfileId;[\s\S]*?await normalizeProfileAvatar\(avatar\)[\s\S]*?if \(!isCurrent\(\)\) return;[\s\S]*?reserveProfileAvatar\(owner\)[\s\S]*?invoke\("set_profile_avatar", \{\s*profileId: owner,\s*dataUrl:/,
  "avatar normalization commits through the captured profile owner after its current-request guard");
assert.match(avatarCallback, /avatarUpdateMountedRef\.current && avatarUpdateOwnerRef\.current === owner\s*&& avatarUpdateRevisionRef\.current === revision/,
  "normalization remains bound to mount, profile and request revision");
assert.match(avatarCallback, /if \(isCurrent\(\)\) setProfileAvatar\(normalized\?\.dataUrl \?\? null\);[\s\S]*?finally \{\s*releaseProfileAvatar\(owner, token\);/,
  "late avatar completion cannot update a different profile and always releases the exact reservation");

assert.match(nativeSource, /fn set_profile_user_status\(/);
assert.match(nativeSource, /\.get\(&profile_id\)[\s\S]*?PROFILE_NOT_LOADED/);
assert.match(nativeSource, /set_profile_user_status,[\s\S]*?get_tox_status_message/);

assert.match(webServerSource, /"set_profile_user_status" => \{/);
assert.match(webServerSource, /set_stored_profile_status\(stored, &profile_id, args\)/);
assert.match(webServerSource, /set_presence\(profile_id, previous\)/);
assert.match(webServerSource, /\| "set_profile_user_status"/);

console.log("profile switcher status and persistent-order regressions passed");
