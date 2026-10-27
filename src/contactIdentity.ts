export type FriendIdentity = { number: number; public_key: string };

export function toxChatId(publicKey: string): string {
  return `tox-${publicKey.toUpperCase()}`;
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
