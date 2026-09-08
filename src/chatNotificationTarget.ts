export type ChatNotificationTarget = { profileId: string; target: string; createdAt: number };
export const CHAT_NOTIFICATION_TARGET_AGE_MS = 5 * 60_000;

export function parseChatNotificationTarget(value: string | null, now: number): ChatNotificationTarget | null {
  if (!value || !Number.isFinite(now)) return null;
  try {
    const item = JSON.parse(value) as Partial<ChatNotificationTarget>;
    if (typeof item.profileId !== "string" || !item.profileId.trim() || item.profileId.trim() !== item.profileId || typeof item.target !== "string"
      || (item.target !== "requests" && !/^friend-key:[a-f0-9]{64}$/i.test(item.target))
      || typeof item.createdAt !== "number" || !Number.isFinite(item.createdAt)
      || item.createdAt > now + 1000 || now - item.createdAt > CHAT_NOTIFICATION_TARGET_AGE_MS) return null;
    return item as ChatNotificationTarget;
  } catch { return null; }
}
