import type { FriendIdentity } from "./contactIdentity";

export type OutgoingTarget = {
  profileId: string;
  friendNumber: number;
  chatId: string;
  expectedPublicKey?: string;
};

// Persisted numeric slots are hints, never recipient identities. An old retry
// may outlive a contact deletion or a savedata friend-number reconciliation.
export function resolveOutgoingTarget<T extends OutgoingTarget>(
  operation: T,
  profileId: string,
  friends: readonly FriendIdentity[],
): (T & { expectedPublicKey: string }) | null {
  if (operation.profileId !== profileId) return null;
  const friend = friends.find((candidate) => `tox-${candidate.public_key.toUpperCase()}` === operation.chatId);
  if (!friend) return null;
  const publicKey = friend.public_key.toUpperCase();
  if (operation.expectedPublicKey && operation.expectedPublicKey.toUpperCase() !== publicKey) return null;
  return { ...operation, friendNumber: friend.number, expectedPublicKey: publicKey };
}

export function canCancelQueuedMessage(message: {
  coreId?: string;
  mine?: boolean;
  attachment?: unknown;
  event?: unknown;
  delivery?: string;
}): boolean {
  return !!message.coreId && !!message.mine && !message.attachment && !message.event
    && (message.delivery === "pending" || message.delivery === "queued");
}

export function outgoingRequestMatchesPeer(toxId: string, publicKey: string): boolean {
  const key = publicKey.trim().toUpperCase();
  return !!key && toxId.trim().toUpperCase().slice(0, key.length) === key;
}
