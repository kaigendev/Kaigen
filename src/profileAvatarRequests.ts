// A backend write outlives its view. Retain only ownership tokens so reopening
// a profile cannot dispatch a competing write before the first one settles.
const pending = new Map<string, symbol>();
const observers = new Set<(profileId: string) => void>();

export const isProfileAvatarPending = (profileId: string) => pending.has(profileId);

export function observeProfileAvatarRequests(observer: (profileId: string) => void) {
  observers.add(observer);
  return () => { observers.delete(observer); };
}

export function reserveProfileAvatar(profileId: string): symbol | null {
  if (pending.has(profileId)) return null;
  const token = Symbol();
  pending.set(profileId, token);
  for (const observer of observers) observer(profileId);
  return token;
}

export function releaseProfileAvatar(profileId: string, token: symbol) {
  if (pending.get(profileId) !== token) return;
  pending.delete(profileId);
  for (const observer of observers) observer(profileId);
}
