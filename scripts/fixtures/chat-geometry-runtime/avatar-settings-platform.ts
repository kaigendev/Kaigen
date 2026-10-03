// Disposable native boundary only. Settings, App and browser image processing are real.
export const avatarSettingsEnabled = new URLSearchParams(location.search).has("avatar-settings-fixture");
const avatars = new Map<string, string | null>();
export function avatarSettingsDataUrl(id: string): string | null | undefined {
  if (!avatarSettingsEnabled) return undefined;
  if (!avatars.has(id)) {
    const canvas = document.createElement("canvas"); canvas.width = 32; canvas.height = 32;
    const context = canvas.getContext("2d")!;
    context.fillStyle = id === "qa-profile-a" ? "#153b72" : "#802a35";
    context.fillRect(0, 0, 32, 32); avatars.set(id, canvas.toDataURL("image/png"));
  }
  return avatars.get(id)!;
}
export type AvatarSettingsCall = { profileId: string; dataUrl: string | null; filename: string | null; bytes: number[] | null; status: string };
export const avatarSettingsCalls: AvatarSettingsCall[] = [];
export const avatarSettingsPickers: Array<{ profileId: string; status: string }> = [];
const setters = new Map<number, (error?: string) => void>();
const pickers = new Map<number, (value: string | null, error?: string) => void>();
export function avatarSettingsResolveSet(index: number, error?: string) { setters.get(index)?.(error); }
export function avatarSettingsResolvePicker(index: number, value: string | null, error?: string) { pickers.get(index)?.(value, error); }
export const avatarSettingsPending = () => ({ setters: setters.size, pickers: pickers.size });
export function avatarSettingsInvoke<T>(command: string, args: any, profiles: () => Array<{ id: string; active?: boolean }>): Promise<T> | null {
  if (!avatarSettingsEnabled) return null;
  if (command === "pick_profile_avatar_data_url") {
    const index = avatarSettingsPickers.length;
    const call = { profileId: profiles().find(profile => profile.active)?.id ?? "missing", status: "pending" };
    avatarSettingsPickers.push(call);
    return new Promise<T>((resolve, reject) => {
      pickers.set(index, (value, error) => {
        pickers.delete(index); call.status = error ? "rejected" : "resolved";
        if (error) reject(new Error(error)); else resolve(value as T);
      });
    });
  }
  if (command !== "set_profile_avatar") return null;
  const index = avatarSettingsCalls.length;
  const call: AvatarSettingsCall = { profileId: args.profileId, dataUrl: args.dataUrl, filename: args.filename, bytes: args.bytes ? [...args.bytes] : null, status: "pending" };
  avatarSettingsCalls.push(call);
  return new Promise<T>((resolve, reject) => {
    setters.set(index, error => {
      setters.delete(index); call.status = error ? "rejected" : "resolved";
      if (error) { reject(new Error(error)); return; }
      avatars.set(call.profileId, call.dataUrl); resolve(profiles() as T);
    });
  });
}
