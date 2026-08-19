export type FriendIdentity = { number: number; public_key: string };

export function toxChatId(publicKey: string): string {
  return `tox-${publicKey.toUpperCase()}`;
}

export function migrateLegacyToxChatId(
  chatId: string,
  friends: readonly FriendIdentity[],
): string {
  const legacyNumber = /^tox-(\d+)$/.exec(chatId)?.[1];
  if (legacyNumber === undefined) return chatId;
  const friend = friends.find((candidate) => candidate.number === Number(legacyNumber));
  return friend ? toxChatId(friend.public_key) : chatId;
}

export function migrateLegacyContactRecord<T>(
  record: Readonly<Record<string, T>>,
  friends: readonly FriendIdentity[],
): Record<string, T> {
  let next: Record<string, T> | null = null;
  for (const friend of friends) {
    const legacyId = `tox-${friend.number}`;
    if (!Object.prototype.hasOwnProperty.call(record, legacyId)) continue;
    next ??= { ...record };
    const stableId = toxChatId(friend.public_key);
    if (!Object.prototype.hasOwnProperty.call(next, stableId)) {
      next[stableId] = record[legacyId];
    }
    delete next[legacyId];
  }
  return next ?? (record as Record<string, T>);
}

export function resolveFriendChatId(
  publicKey: string | undefined,
  friendNumber: number | undefined,
  friends: readonly FriendIdentity[],
): string | undefined {
  const resolvedPublicKey = publicKey
    ?? friends.find((friend) => friend.number === friendNumber)?.public_key;
  return resolvedPublicKey ? toxChatId(resolvedPublicKey) : undefined;
}
