export type FriendIdentity = { number: number; public_key: string };

export function toxChatId(publicKey: string): string {
  return `tox-${publicKey.toUpperCase()}`;
}
