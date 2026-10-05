// Disposable command boundary for actual RootApp onboarding. No user data or network.
export const onboardingEnabled = new URLSearchParams(location.search).has("onboarding-fixture");
const mode = new URLSearchParams(location.search).get("onboarding-mode");
const profile = (id: string, loaded = false) => ({
  id, name: id.endsWith("a") ? "Synthetic Alpha" : "Synthetic Beta", fileName: id.endsWith("a") ? "alpha.kai" : "beta.kai",
  encrypted: true, loaded, active: false, connection: loaded ? "offline" : "locked", userStatus: "offline", unread: 0, notificationsEnabled: false,
});
let profiles: any[] = mode === "unlock" || mode === "removedowner" ? [profile("qa-profile-a"), profile("qa-profile-b")] : [];
export const onboardingRemoveOwner = (owner: string) => {
  profiles = profiles.filter((profile) => profile.id !== owner);
  if (!profiles.some((profile) => profile.active)) { const next = profiles.find((profile) => profile.loaded); if (next) next.active = true; }
  window.dispatchEvent(new Event("profiles-changed"));
};
export const onboardingProfiles = () => structuredClone(profiles);
export const onboardingStartup = () => ({ firstRun: profiles.length === 0, language: "ru", closeToTray: false, initialConnectionPresetRequired: false, profiles: onboardingProfiles() });
// The unlock regression controls the first read before RootApp mounts.
let holdStartup = onboardingEnabled && mode === "unlock";
const startupReplies: Array<() => void> = [];
export const onboardingStartupReads: Array<{ status: string }> = [];
export const onboardingHoldStartup = (hold: boolean) => { holdStartup = hold; };
export function onboardingReadStartup<T>(): Promise<T> {
  const snapshot = onboardingStartup();
  if (!holdStartup) return Promise.resolve(snapshot as T);
  const index = onboardingStartupReads.length;
  const call = { status: "pending" }; onboardingStartupReads.push(call);
  return new Promise<T>((resolve) => { startupReplies[index] = () => { call.status = "resolved"; resolve(structuredClone(snapshot) as T); }; });
}
export const onboardingReleaseStartup = () => { holdStartup = false; onboardingStartupReads.forEach((call, index) => { if (call.status === "pending") startupReplies[index](); }); };
export const onboardingHeartbeats: Array<{ startupReady: boolean; splash: boolean; unlockVisible: boolean; pendingStartup: number }> = [];
export const onboardingHeartbeat = (args: { startupReady?: boolean }) => {
  const unlock = document.querySelector<HTMLElement>(".unlock-screen");
  onboardingHeartbeats.push({ startupReady: args.startupReady === true, splash: !!document.querySelector(".splash-screen"),
    unlockVisible: !!unlock && unlock.getBoundingClientRect().height > 0 && getComputedStyle(unlock).visibility !== "hidden",
    pendingStartup: onboardingStartupReads.filter((call) => call.status === "pending").length });
};
export const onboardingCommands = new Set(["create_profile", "discover_qtox_profiles", "import_qtox_profile", "unlock_profile", "continue_with_loaded_profiles"]);
export const onboardingCalls: Array<{ command: string; owner: string | null; source: string | null; passwordLength: number; status: string; committed: boolean; returnedLoaded: string[] }> = [];
type Pending = { args: any; resolve: (value: any) => void; reject: (value: any) => void; snapshot?: any };
const pending = new Map<number, Pending>();
export const onboardingPending = () => pending.size + onboardingStartupReads.filter((call) => call.status === "pending").length;
export const onboardingPickerCalls: any[] = [];
const pickerReplies: Array<string | null | Error> = [];
export const onboardingPick = (reply: string | null | Error) => { pickerReplies.push(reply); };
export async function onboardingDialog(options: any) {
  onboardingPickerCalls.push(structuredClone(options));
  const reply = pickerReplies.shift() ?? null;
  if (reply instanceof Error) throw reply;
  return reply;
}
const candidates = [
  { name: "Synthetic encrypted source", profilePath: "synthetic-source-a.tox", sourceLabel: "synthetic-source-a.tox", historyPath: "synthetic-history-a.db", encrypted: true },
  { name: "Synthetic encrypted neighbor", profilePath: "synthetic-source-b.tox", sourceLabel: "synthetic-source-b.tox", historyPath: null, encrypted: true },
];
function commit(index: number, item: Pending) {
  const call = onboardingCalls[index];
  if (call.committed) return;
  if (call.command === "unlock_profile") {
    if (item.args.password !== (item.args.profileId === "qa-profile-a" ? "synthetic-key-a" : "synthetic-key-b")) throw new Error("PROFILE_PASSWORD_INVALID");
    const owner = profiles.find((profile) => profile.id === item.args.profileId);
    owner.loaded = true; owner.connection = "offline";
    if (!profiles.some((profile) => profile.active)) owner.active = true;
    item.snapshot = onboardingProfiles();
  } else if (call.command === "create_profile") {
    if (profiles.length) throw new Error("SYNTHETIC_DUPLICATE_CREATE");
    profiles = [{ ...profile("qa-profile-a", true), name: item.args.name, encrypted: !!item.args.password, active: true }];
    item.snapshot = { profiles: onboardingProfiles(), initialConnectionPresetRequired: false };
  } else if (call.command === "import_qtox_profile") {
    if (item.args.password !== "synthetic-import-key") throw new Error("QTOX_PROFILE_PASSWORD_INVALID");
    if (profiles.length) throw new Error("SYNTHETIC_DUPLICATE_IMPORT");
    profiles = [{ ...profile("qa-profile-a", true), name: "Synthetic imported Alpha", active: true }];
    item.snapshot = onboardingProfiles();
  } else if (call.command === "discover_qtox_profiles") {
    item.snapshot = item.args.location === "synthetic-empty.zip" ? [] : structuredClone(candidates);
  } else { item.snapshot = onboardingProfiles(); }
  call.committed = true;
}
export const onboardingCommit = (index: number) => {
  const item = pending.get(index); if (!item) throw new Error("ONBOARDING_CALL_NOT_PENDING");
  commit(index, item);
};
export const onboardingResolve = (index: number, error?: string) => {
  const item = pending.get(index); if (!item) throw new Error("ONBOARDING_CALL_NOT_PENDING");
  pending.delete(index);
  try {
    if (error) throw new Error(error);
    commit(index, item);
    onboardingCalls[index].status = "resolved";
    const list = Array.isArray(item.snapshot) ? item.snapshot : item.snapshot?.profiles;
    onboardingCalls[index].returnedLoaded = list?.filter((profile: any) => profile.loaded).map((profile: any) => profile.id) ?? [];
    item.resolve(structuredClone(item.snapshot));
  } catch (failure) { onboardingCalls[index].status = "rejected"; item.reject(failure); }
};
export function onboardingInvoke<T>(command: string, args: any): Promise<T> {
  const index = onboardingCalls.length;
  onboardingCalls.push({ command, owner: args.profileId ?? null, source: args.profilePath ?? args.location ?? null,
    passwordLength: typeof args.password === "string" ? args.password.length : 0, status: "pending", committed: false, returnedLoaded: [] });
  return new Promise<T>((resolve, reject) => { pending.set(index, { args: structuredClone(args), resolve, reject }); });
}
