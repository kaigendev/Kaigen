// Disposable boundary for actual RootApp avatar ownership. The image pipeline is real.
import type { ProfileSummary } from "../../../src/RootApp";

export const avatarOwnerEnabled = new URLSearchParams(location.search).has("avatar-root-fixture");
const seedAvatar = (color: string) => {
  const canvas = document.createElement("canvas"); canvas.width = 32; canvas.height = 32;
  const context = canvas.getContext("2d")!; context.fillStyle = color; context.fillRect(0, 0, 32, 32);
  return canvas.toDataURL("image/png");
};
const profile = (id: string, name: string, loaded: boolean, color: string): ProfileSummary => ({
  id, name, fileName: `${id}.kai`, encrypted: true, loaded, active: id === "avatar-a",
  connection: loaded ? "offline" : "locked", userStatus: "offline", unread: 0,
  notificationsEnabled: false, avatar: seedAvatar(color),
});
let profiles = [profile("avatar-a", "Avatar Alpha", true, "#a02030"), profile("avatar-b", "Avatar Beta", true, "#207040"), profile("avatar-c", "Avatar Locked", false, "#203060")];
export const avatarOwnerProfiles = () => structuredClone(profiles);
export const avatarOwnerReplace = (next: ProfileSummary[]) => {
  profiles = structuredClone(next);
  window.dispatchEvent(new Event("profiles-changed"));
};
export const avatarOwnerCalls: Array<{ profileId: string; filename: string | null; bytes: number[] | null; dataUrl: string | null; status: "pending" | "resolved" | "rejected"; committed: boolean }> = [];
type Pending = { resolve: (profiles: ProfileSummary[]) => void; reject: (error: Error) => void; snapshot?: ProfileSummary[] };
const pending = new Map<number, Pending>();
export const avatarOwnerPending = () => pending.size;
export function avatarOwnerCommit(index: number) {
  const item = pending.get(index), call = avatarOwnerCalls[index];
  if (!item || !call) throw new Error("AVATAR_CALL_NOT_PENDING");
  if (call.committed) return;
  const owner = profiles.find(profile => profile.id === call.profileId);
  if (!owner?.loaded) throw new Error("PROFILE_NOT_LOADED");
  owner.avatar = call.dataUrl; call.committed = true; item.snapshot = avatarOwnerProfiles();
}
export function avatarOwnerResolve(index: number, error?: string) {
  const item = pending.get(index), call = avatarOwnerCalls[index];
  if (!item || !call) throw new Error("AVATAR_CALL_NOT_PENDING");
  try {
    if (error) throw new Error(error);
    avatarOwnerCommit(index); call.status = "resolved"; item.resolve(structuredClone(item.snapshot!));
  } catch (failure) {
    call.status = "rejected"; item.reject(failure instanceof Error ? failure : new Error(String(failure)));
  } finally { pending.delete(index); }
}
export function avatarOwnerInvoke<T>(command: string, args: any): Promise<T> | null {
  if (!avatarOwnerEnabled) return null;
  if (command === "get_startup_state") return Promise.resolve({ firstRun: false, language: "ru", closeToTray: false, initialConnectionPresetRequired: false, profiles: avatarOwnerProfiles() } as T);
  if (command === "continue_with_loaded_profiles") return Promise.resolve(avatarOwnerProfiles() as T);
  if (command !== "set_profile_avatar") return null;
  const index = avatarOwnerCalls.length;
  avatarOwnerCalls.push({ profileId: args.profileId, filename: args.filename, bytes: args.bytes ? [...args.bytes] : null, dataUrl: args.dataUrl, status: "pending", committed: false });
  return new Promise<T>((resolve, reject) => pending.set(index, { resolve: resolve as any, reject }));
}
