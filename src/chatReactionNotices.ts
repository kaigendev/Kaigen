import { CHAT_REACTION_CODES, type ChatReactionCode } from "./chatRichText";

export type PeerReactionEvent = {
  eventRevision: number;
  messageId: string;
  peerRevision: number;
  added: ChatReactionCode[];
  removed: ChatReactionCode[];
  createdAt: number;
};
export type ReactionNotice = {
  messageKey: string;
  revision: number;
  reaction: ChatReactionCode;
  removed: boolean;
};
export type ReactionNoticeState = { through: number; notices: ReactionNotice[] };
export type ReactionNoticeStore = Record<string, ReactionNoticeState>;
export const MAX_REACTION_NOTICES_PER_CHAT = 50;
const validRevision = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const validMessageId = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{32}$/i.test(value);
const validReaction = (value: unknown): value is ChatReactionCode => CHAT_REACTION_CODES.includes(value as ChatReactionCode);

/** Only identifiers and one bounded notice per target are retained; no message text. */
export function restoreReactionNotices(value: unknown): ReactionNoticeStore {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const restored: ReactionNoticeStore = {};
  for (const [chatId, raw] of Object.entries(value)) {
    if (!/^tox-[0-9a-f]{64}$/i.test(chatId) || !raw || typeof raw !== "object") continue;
    const candidate = raw as Partial<ReactionNoticeState>;
    if (!validRevision(candidate.through) || !Array.isArray(candidate.notices)) continue;
    const notices = new Map<string, ReactionNotice>();
    for (const notice of candidate.notices) {
      if (!notice || !validMessageId(notice.messageKey) || !validRevision(notice.revision) || !validReaction(notice.reaction)) continue;
      notices.delete(notice.messageKey);
      notices.set(notice.messageKey, { messageKey: notice.messageKey, revision: notice.revision, reaction: notice.reaction, removed: notice.removed === true });
    }
    restored[chatId] = { through: candidate.through, notices: [...notices.values()].slice(-MAX_REACTION_NOTICES_PER_CHAT) };
  }
  return restored;
}

/** The returned cursor may be acknowledged to core only after this state is saved. */
export function applyPeerReactionEvents(
  previous: ReactionNoticeState | undefined,
  events: readonly PeerReactionEvent[],
  visibleMessageIds: ReadonlySet<string>,
): ReactionNoticeState {
  const state = previous ?? { through: 0, notices: [] };
  let through = state.through;
  const notices = new Map(state.notices.map((notice) => [notice.messageKey, notice]));
  for (const event of [...events].sort((left, right) => left.eventRevision - right.eventRevision)) {
    if (!validRevision(event.eventRevision) || event.eventRevision <= through || !validMessageId(event.messageId)
      || !validRevision(event.peerRevision) || !Array.isArray(event.added) || !Array.isArray(event.removed)) continue;
    const added = event.added.find(validReaction);
    const removed = event.removed.find(validReaction);
    if (!added && !removed) continue;
    through = event.eventRevision;
    notices.delete(event.messageId);
    if (!visibleMessageIds.has(event.messageId)) notices.set(event.messageId, {
      messageKey: event.messageId, revision: event.peerRevision, reaction: added ?? removed!, removed: !added,
    });
  }
  if (through === state.through) return state;
  return { through, notices: [...notices.values()].slice(-MAX_REACTION_NOTICES_PER_CHAT) };
}

export function dismissReactionNotice(state: ReactionNoticeState, messageKey: string): ReactionNoticeState {
  const notices = state.notices.filter((notice) => notice.messageKey !== messageKey);
  return notices.length === state.notices.length ? state : { through: state.through, notices };
}
