export type ChatFileAdmissionContext = {
  screen: string;
  friendNumber?: number;
  addContactOpen: boolean;
  incomingRequestsOpen: boolean;
};

export function hasFileDragType(types: ArrayLike<string> | null | undefined): boolean {
  if (!types) return false;
  for (let index = 0; index < types.length; index += 1) {
    if (types[index] === "Files") return true;
  }
  return false;
}

export function canStageChatFile(context: ChatFileAdmissionContext): boolean {
  return context.screen === "chat"
    && Number.isInteger(context.friendNumber)
    && (context.friendNumber ?? -1) >= 0
    && !context.addContactOpen
    && !context.incomingRequestsOpen;
}
