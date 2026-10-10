// Disposable extension of the existing actual-App adapter. Never shipped.
import * as base from "./app-platform";
export * from "./app-platform";

const storageKey = "kaigen-contact-groups-runtime-profiles";
const saved: Record<string, any> = JSON.parse(sessionStorage.getItem(storageKey) ?? "{}");
const saveCalls: Array<{ profileId: string; state: any; status: string }> = [];
const heldOwners = new Set<string>();
const pendingSaves: Array<() => void> = [];
const activity = new Map<number, number>();
let activitySequence = 0;
let activeProfileId = "qa-profile-a";
base.geometrySetMenuProfiles(true);

export function contactGroupsEvidence() {
  return { activeProfileId, saved: structuredClone(saved), saves: structuredClone(saveCalls) };
}

export function contactGroupsEnableMany() { sessionStorage.setItem("kaigen-contact-groups-runtime-many", "true"); }

export function contactGroupsSetScale(scale: number) {
  sessionStorage.setItem("kaigen-contact-groups-runtime-scale", String(scale));
}

export function contactGroupsHoldSave(profileId: string) { heldOwners.add(profileId); }
export function contactGroupsReleaseSaves() { for (const release of pendingSaves.splice(0)) release(); }

export function contactGroupsInjectEvent(friendNumber: number, text: string) {
  activity.set(friendNumber, Math.floor(Date.now() / 1000) + ++activitySequence);
  const id = base.geometryAppendUnreadMessage(friendNumber, text);
  base.geometryEmitNativeEvent("profiles-changed", activeProfileId);
  return id;
}

export async function invoke<T>(command: string, args: any = {}): Promise<T> {
  if (command === "load_local_state") {
    const profileId = args.profileId ?? activeProfileId;
    if (saved[profileId]) {
      const snapshot = structuredClone(saved[profileId]);
      const scale = Number(sessionStorage.getItem("kaigen-contact-groups-runtime-scale"));
      if (scale) snapshot.appearance = { ...snapshot.appearance, interfaceScale: scale };
      return snapshot;
    }
  }
  if (command === "save_local_state") {
    if (!args.profileId) throw new Error("CONTACT_GROUPS_RUNTIME_SAVE_REQUIRES_EXPLICIT_PROFILE");
    const call = { profileId: args.profileId, state: structuredClone(args.state), status: "pending" };
    saveCalls.push(call);
    if (heldOwners.delete(args.profileId)) await new Promise<void>(resolve => pendingSaves.push(resolve));
    saved[args.profileId] = structuredClone(call.state);
    sessionStorage.setItem(storageKey, JSON.stringify(saved));
    call.status = "saved";
  }
  let result = await base.invoke<T>(command, args);
  if (command === "get_tox_friends" && sessionStorage.getItem("kaigen-contact-groups-runtime-many") === "true") {
    result = [...result as any[], ...Array.from({ length: 12 }, (_, index) => {
      const key = (index + 1).toString(16).toUpperCase().padStart(64, "0");
      return { ...(result as any[])[0], number: 20 + index, public_key: key, tox_id: key + "0".repeat(12), name: "Many " + (index + 1) };
    })] as T;
  }
  if (command === "load_layout_state") {
    const scale = Number(sessionStorage.getItem("kaigen-contact-groups-runtime-scale"));
    if (scale) return { ...result, appearance: { ...(result as any)?.appearance, interfaceScale: scale } } as T;
  }
  if (command === "switch_profile") activeProfileId = args.profileId;
  if (command === "get_tox_friends") return (result as any[]).map(friend => activity.has(friend.number)
    ? { ...friend, last_event: activity.get(friend.number), lastEventSequence: activity.get(friend.number) }
    : friend) as T;
  return result;
}
