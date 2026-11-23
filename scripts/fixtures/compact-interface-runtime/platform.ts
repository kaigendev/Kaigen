import * as base from "../app-tablet-runtime/platform";
export * from "../app-tablet-runtime/platform";

let activeProfile = "qa-profile-a";
const saved = new Map<string, any>();
const exerciseSpellcheck = new URLSearchParams(location.search).has("spellcheck");
const exercisePendingContact = new URLSearchParams(location.search).has("pendingContact");
const exerciseNotificationSettings = new URLSearchParams(location.search).has("notificationSettings");
let releaseNotificationLoad: (() => void) | undefined;
if (exerciseNotificationSettings) Object.assign(window, { compactNotificationFixture: {
  isHeld: () => releaseNotificationLoad !== undefined,
  release: () => releaseNotificationLoad?.(),
} });
const notificationLoad = exerciseNotificationSettings
  ? new Promise<void>(resolve => { releaseNotificationLoad = resolve; })
  : undefined;
const pendingContacts = new Map<string, { profileId: string; number: number; public_key: string; tox_id: string; authorized: boolean; connection: string; name: string; status: string; status_message: string }>();
let releasePendingContact: (() => void) | undefined;
if (exercisePendingContact) Object.assign(window, { compactPendingContactFixture: {
  admitted: () => releasePendingContact !== undefined,
  acknowledge: () => releasePendingContact?.(),
} });
const spellcheckFixtureKey = "disposable-compact-spellcheck-local-state";
let nextSpellcheckSave: "hold" | "reject" | undefined;
let releaseSpellcheckSave: (() => void) | undefined;
if (exerciseSpellcheck) Object.assign(window, { compactSpellcheckFixture: {
  holdNext: () => { nextSpellcheckSave = "hold"; },
  rejectNext: () => { nextSpellcheckSave = "reject"; },
  isHeld: () => releaseSpellcheckSave !== undefined,
  release: () => releaseSpellcheckSave?.(),
  read: () => JSON.parse(sessionStorage.getItem(spellcheckFixtureKey) ?? "null"),
} });
let geometryTorSettings: any = null;
Object.assign(window, { compactTorFixture: { setState: base.geometrySetTorState, setSettings: (settings: any) => { geometryTorSettings = structuredClone(settings); } } });
export async function invoke<T>(command: string, args: any = {}): Promise<T> {
  if (command === "get_tor_settings" && geometryTorSettings) return structuredClone(geometryTorSettings) as T;
  if (command === "switch_profile") activeProfile = args.profileId;
  if (command === "load_local_state") {
    const state: any = await base.invoke(command, args);
    if (notificationLoad) {
      await notificationLoad;
      return { ...state, notifySound: true, notificationVolume: 0.25, activeChat: "" } as T;
    }
    if (exerciseSpellcheck) {
      const restored = JSON.parse(sessionStorage.getItem(spellcheckFixtureKey) ?? "null");
      return { ...state, spellcheckEnabled: true, spellcheckRussian: true, spellcheckEnglish: false, ...restored, activeChat: "" } as T;
    }
    return { ...state, contactGroups: { version: 1, enabled: false, groups: [{ id: "compact-fixture-group", name: "Synthetic group with long name" }], assignments: { ["B".repeat(64)]: "compact-fixture-group" }, order: ["__ungrouped__", "compact-fixture-group"], collapsed: [] }, ...saved.get(args.profileId ?? activeProfile), activeChat: "", spellcheckEnabled: false } as T;
  }
  if (command === "save_local_state") {
    if (exerciseSpellcheck) {
      const previous = JSON.parse(sessionStorage.getItem(spellcheckFixtureKey) ?? "null")?.spellcheckEnglish ?? false;
      if (args.state.spellcheckEnglish !== previous) {
        const control = nextSpellcheckSave;
        nextSpellcheckSave = undefined;
        if (control === "reject") throw new Error("DISPOSABLE_SPELLCHECK_SAVE_REFUSED");
        if (control === "hold") await new Promise<void>(resolve => { releaseSpellcheckSave = resolve; });
        releaseSpellcheckSave = undefined;
      }
      sessionStorage.setItem(spellcheckFixtureKey, JSON.stringify(args.state));
    }
    saved.set(args.profileId ?? activeProfile, structuredClone(args.state));
  }
  if (command === "get_tox_status_message") return (activeProfile === "qa-profile-a" ? "Alice status" : "Second status") as T;
  if (command === "get_tox_user_status") return (activeProfile === "qa-profile-a" ? "online" : "away") as T;
  if (command === "get_tox_id") return ((activeProfile === "qa-profile-a" ? "F" : "E").repeat(64) + "0".repeat(12)) as T;
  if (command === "add_tox_friend" && exercisePendingContact) {
    const key = args.toxId.slice(0, 64);
    const profileId = args.profileId ?? activeProfile;
    const number = 70 + pendingContacts.size;
    await new Promise<void>(resolve => { releasePendingContact = resolve; });
    releasePendingContact = undefined;
    pendingContacts.set(profileId + ":" + key, { profileId, number, public_key: key, tox_id: args.toxId, authorized: false, connection: "offline", name: "", status: "offline", status_message: "" });
    return number as T;
  }
  if (command === "get_tox_friends") {
    const friends: any[] = await base.invoke(command, args);
    return [...friends.map(friend => ({ ...friend, name: `${activeProfile === "qa-profile-a" ? "Alice" : "Second"} contact ${friend.number}` })), ...[...pendingContacts.values()].filter(friend => friend.profileId === (args.profileId ?? activeProfile))] as T;
  }
  return base.invoke<T>(command, args);
}
