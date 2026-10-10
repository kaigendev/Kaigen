import * as base from "../app-tablet-runtime/platform";
export * from "../app-tablet-runtime/platform";

let activeProfile = "qa-profile-a";
const saved = new Map<string, any>();
export async function invoke<T>(command: string, args: any = {}): Promise<T> {
  if (command === "switch_profile") activeProfile = args.profileId;
  if (command === "load_local_state") {
    const state: any = await base.invoke(command, args);
    return { ...state, contactGroups: { version: 1, enabled: false, groups: [{ id: "compact-fixture-group", name: "Synthetic group with long name" }], assignments: { ["B".repeat(64)]: "compact-fixture-group" }, order: ["__ungrouped__", "compact-fixture-group"], collapsed: [] }, ...saved.get(args.profileId ?? activeProfile), activeChat: "", spellcheckEnabled: false } as T;
  }
  if (command === "save_local_state") saved.set(args.profileId ?? activeProfile, structuredClone(args.state));
  if (command === "get_tox_status_message") return (activeProfile === "qa-profile-a" ? "Alice status" : "Second status") as T;
  if (command === "get_tox_user_status") return (activeProfile === "qa-profile-a" ? "online" : "away") as T;
  if (command === "get_tox_id") return ((activeProfile === "qa-profile-a" ? "F" : "E").repeat(64) + "0".repeat(12)) as T;
  if (command === "get_tox_friends") {
    const friends: any[] = await base.invoke(command, args);
    return friends.map(friend => ({ ...friend, name: `${activeProfile === "qa-profile-a" ? "Alice" : "Second"} contact ${friend.number}` })) as T;
  }
  return base.invoke<T>(command, args);
}
