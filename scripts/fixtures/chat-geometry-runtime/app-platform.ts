// Disposable actual-App adapter for the geometry runtime test. It never ships.
export const platformCapabilities = { nativeFilesystem: false, systemTray: false, browserAuthorization: false, containerRelativeLayout: false, outgoingTransferRetry: true, proxyConnectivityTest: false };

const keys = ["A".repeat(64), "B".repeat(64), "C".repeat(64), "D".repeat(64)];
const counts = [100_000, 51, 8, 1];
const unread: Record<string, number> = {};
const unseenMessages = new Map<number, Set<string>>();
const acknowledgeCalls: Array<{ friendNumber: number; messageIds: string[] }> = [];
const appended = new Map<string, any>();
const reactions = new Map<string, any>();
const operations = new Map<string, any>();
const events = new Map<string, Set<(event: any) => void>>();
const reactionEvents = new Map<number, any[]>();
const reactionEventRevisions = [0, 0, 0, 0];
const friendStatuses = ["online", "online", "online", "online"];
let revision = 1;
let local: any = { activeChat: `tox-${keys[0]}`, historyMessageLimit: 500, drafts: {}, saveChatHistory: true, spellcheckEnabled: false };
let layout: any = {};

export const geometryMessageId = (friend: number, index: number) => ((friend + 1) * 1_000_000 + index).toString(16).padStart(32, "0");
export const geometrySentPayloads: any[] = [];
export const geometryOpenedUrls: string[] = [];

export function geometrySetExistingReaction(friend: number, index: number, code: "heart" | null) {
  const id = geometryMessageId(friend, index);
  if (code) reactions.set(id, { mine: [], peer: [code], mineRevision: 0, peerRevision: 1, delivery: "delivered" });
  else reactions.delete(id);
  revision += 1;
  return id;
}

export function geometryAppendMessage(friend: number, text = "new negotiated message", formatting?: Array<{ kind: string; offsetUtf16: number; lengthUtf16: number }>) {
  const index = counts[friend]++;
  const id = geometryMessageId(friend, index);
  appended.set(id, { id, friend_number: friend, text, formatting, mine: false, timestamp: Math.floor(Date.now() / 1000), delivery: "delivered", protocol_version: 1, pq_protected: false });
  revision += 1;
  return id;
}

// Renderer-only outgoing file metadata; this fixture performs no transfer.
export function geometryAppendOutgoingFile(friend: number) {
  const index = counts[friend]++;
  const id = geometryMessageId(friend, index);
  appended.set(id, {
    id, friend_number: friend, text: "", mine: true,
    timestamp: Math.floor(Date.now() / 1000), delivery: "delivered", protocol_version: 1,
    attachment: { name: "outgoing-height-fixture.txt", size: 4096, mime: "text/plain",
      path: "browser-stream://" + id, image: false, transferred: 4096,
      transfer_state: "complete", completed: true },
  });
  revision += 1;
  return id;
}

export function geometryInjectPeerReaction(friend: number, targetIndex: number, code: "heart" = "heart") {
  const id = geometryMessageId(friend, targetIndex);
  const previous = reactions.get(id) ?? { mine: [], peer: [], mineRevision: 0, peerRevision: 0, delivery: "delivered" };
  reactions.set(id, { ...previous, peer: [code], peerRevision: previous.peerRevision + 1 });
  const eventRevision = ++reactionEventRevisions[friend];
  const queue = reactionEvents.get(friend) ?? [];
  queue.push({ eventRevision, messageId: id, peerRevision: previous.peerRevision + 1, added: [code], removed: [], createdAt: Math.floor(Date.now() / 1000) });
  reactionEvents.set(friend, queue);
  revision += 1;
  return id;
}

export function geometryEmitFriendStatus(friend: number, status: "online" | "away" | "busy" | "offline") {
  friendStatuses[friend] = status;
  const event = { event: "profiles-changed", id: 1, payload: "qa-profile-a" };
  for (const handler of events.get("profiles-changed") ?? []) handler(event);
}

export function prepareRichUiScenario() {
  geometrySentPayloads.length = 0;
  geometrySetExistingReaction(1, 0, "heart");
  geometryInjectPeerReaction(1, 1, "heart");
}

export function prepareUnreadVisibilityScenario() {
  const friendNumber = 3;
  const messageId = geometryMessageId(friendNumber, 0);
  unread[String(friendNumber)] = 1;
  unseenMessages.set(friendNumber, new Set([messageId]));
  acknowledgeCalls.length = 0;
  revision += 1;
  return { friendNumber, messageId };
}

export function geometryAppendUnreadMessage(friendNumber: number, text: string) {
  const messageId = geometryAppendMessage(friendNumber, text);
  const pending = unseenMessages.get(friendNumber) ?? new Set<string>();
  pending.add(messageId);
  unseenMessages.set(friendNumber, pending);
  unread[String(friendNumber)] = pending.size;
  return messageId;
}

export function unreadVisibilityEvidence(friendNumber = 3) {
  return {
    unreadCount: unread[String(friendNumber)] ?? 0,
    unseenMessageIds: [...(unseenMessages.get(friendNumber) ?? [])],
    acknowledgements: acknowledgeCalls
      .filter((call) => call.friendNumber === friendNumber)
      .map((call) => ({ friendNumber: call.friendNumber, messageIds: [...call.messageIds] })),
  };
}

export function richUiEvidence() {
  return { latestSendArgs: geometrySentPayloads.at(-1), reactions: Object.fromEntries(reactions) };
}

function row(friend: number, index: number): any {
  const id = geometryMessageId(friend, index);
  if (appended.has(id)) return { ...appended.get(id), reactions: reactions.get(id) };
  const label = ["Bob", "Carol", "Dave", "Erin"][friend];
  const text = friend === 3 && index === 0
    ? "Erin short unread message"
    : index === 1000
    ? "Needle distant history — уникальная дальняя цель поиска"
    : index % 87 === 0
      ? `Длинное сообщение ${index}\n${"Тестовая строка для плавной прокрутки. ".repeat(150)}`
      : `${label} synthetic message ${String(index).padStart(6, "0")} — проверка истории Kaigen`;
  return {
    id,
    friend_number: friend,
    text,
    mine: friend === 3 ? false : index % 3 === 0,
    timestamp: 1_788_800_000 + index,
    delivery: "delivered",
    delivered_at: 1_788_800_000 + index,
    protocol_version: friend !== 2 && index >= counts[friend] - 70 ? 1 : undefined,
    formatting: friend === 2 && index === counts[friend] - 1 ? [{ kind: "bold", offsetUtf16: 0, lengthUtf16: 4 }] : undefined,
    pq_protected: false,
    reactions: reactions.get(id),
  };
}

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const profile = () => ({ id: "qa-profile-a", name: "QA Alice", fileName: "qa.kai", encrypted: false, loaded: true, active: true, connection: "udp", userStatus: "online", unread: 0, notificationsEnabled: false });

export async function invoke<T>(command: string, args: any = {}): Promise<T> {
  switch (command) {
    case "get_startup_state": return { firstRun: false, language: "ru", closeToTray: false, profiles: [profile()] } as T;
    case "load_local_state": return structuredClone(local) as T;
    case "save_local_state": local = structuredClone(args.state); return null as T;
    case "load_layout_state": return layout as T;
    case "save_layout_state": layout = structuredClone(args.state); return null as T;
    case "get_tox_friends": return keys.map((key, number) => ({ number, public_key: key, tox_id: key + "0".repeat(12), authorized: true, connection: "online", name: ["QA Bob · 100k", "QA Carol", "QA Dave", "QA Erin · unread geometry"][number], status: friendStatuses[number], status_message: "", last_event: 1_788_800_000 + counts[number], addedAt: 1_788_800_000, lastEventSequence: counts[number] })) as T;
    case "get_tox_id": return ("F".repeat(64) + "0".repeat(12)) as T;
    case "get_tox_user_status": return "online" as T;
    case "get_tox_network_status": return "online" as T;
    case "get_tox_status_message": return "" as T;
    case "get_proxy_settings": return { mode: "none", host: "", port: 0, username: "", password: "" } as T;
    case "get_tor_status": return { state: "disabled", progress: 0, lines: [] } as T;
    case "get_pq_status": return { supported: true, state: "available", local_fingerprint: "", peer_fingerprint: null, fingerprint_changed: false } as T;
    case "get_file_receive_settings": return { autoAccept: "none", showImages: true, maxConcurrent: 2, maxFileSizeMb: 25 } as T;
    case "get_chat_capabilities": return (args.friendNumber === 2
      ? { version: 0, enhancedMessages: false, reactions: false, formatting: false, quotes: false }
      : { version: 1, enhancedMessages: true, reactions: true, formatting: true, quotes: true }) as T;
    case "get_incoming_friend_requests": return [] as T;
    case "get_unread_state": return { friends: { ...unread }, requests: [] } as T;
    case "acknowledge_local_messages": {
      const friendNumber = Number(args.friendNumber);
      const messageIds = Array.isArray(args.messageIds) ? args.messageIds.filter((id: unknown): id is string => typeof id === "string") : [];
      acknowledgeCalls.push({ friendNumber, messageIds: [...messageIds] });
      const pending = unseenMessages.get(friendNumber);
      if (pending) {
        for (const messageId of messageIds) pending.delete(messageId);
        unread[String(friendNumber)] = pending.size;
      }
      return { friends: { ...unread }, requests: [] } as T;
    }
    case "get_tox_messages_snapshot": {
      await sleep(25);
      const friend = args.friendNumber;
      if (args.ackPeerReactionThrough) reactionEvents.set(friend, (reactionEvents.get(friend) ?? []).filter((event) => event.eventRevision > args.ackPeerReactionThrough));
      const total = counts[friend];
      const limit = Math.min(1000, args.limit || 1000);
      const target = args.targetMessageId ? Number.parseInt(args.targetMessageId, 16) - (friend + 1) * 1_000_000 : undefined;
      const windowStart = Math.max(0, Math.min(total - limit, target !== undefined ? target - Math.floor(limit / 2) : args.rangeOffset ?? total - limit));
      const messages = Array.from({ length: Math.min(limit, total - windowStart) }, (_, offset) => row(friend, windowStart + offset));
      return {
        revision,
        windowStart,
        total,
        hasMoreBefore: windowStart > 0,
        hasMoreAfter: windowStart + messages.length < total,
        targetIndex: target,
        messages: args.knownRevision === revision && args.targetMessageId === undefined && args.rangeOffset === undefined ? null : messages,
        peerReactionEvents: (reactionEvents.get(friend) ?? []).filter((event) => event.eventRevision > (args.peerReactionAfter ?? 0)).slice(0, 64),
        peerReactionLatestRevision: reactionEventRevisions[friend],
        latestMessageId: geometryMessageId(friend, total - 1),
        reactionEligibleIds: Array.from({ length: Math.min(total, 50) }, (_, index) => geometryMessageId(friend, total - Math.min(total, 50) + index)),
        firstUnseenMessageId: [...(unseenMessages.get(friend) ?? [])][0],
        unseenMessageIds: [...(unseenMessages.get(friend) ?? [])],
      } as T;
    }
    case "get_tox_messages": return [row(args.friendNumber, counts[args.friendNumber] - 1)] as T;
    case "search_tox_messages": {
      await sleep(5);
      let index = Number(args.cursor?.split(":")[1] ?? 0);
      const end = Math.min(counts[args.friendNumber], index + 500);
      const matches = [];
      for (; index < end && matches.length < 100; index++) {
        const message = row(args.friendNumber, index);
        const start = message.text.toLowerCase().indexOf(args.query.toLowerCase());
        if (start >= 0) matches.push({ messageId: message.id, index, field: "text", start, end: start + args.query.length });
      }
      return { matches, nextCursor: index < counts[args.friendNumber] ? `1:${index}` : null } as T;
    }
    case "send_tox_message": {
      await sleep(225);
      if (operations.has(args.operationId)) return operations.get(args.operationId);
      geometrySentPayloads.push(structuredClone(args));
      const index = counts[args.friendNumber]++;
      const id = geometryMessageId(args.friendNumber, index);
      appended.set(id, { id, friend_number: args.friendNumber, text: args.text, mine: true, timestamp: Math.floor(Date.now() / 1000), delivery: "awaiting_receipt", protocol_version: 1, quote: args.quote, formatting: args.formatting, pq_protected: false });
      revision += 1;
      const result = { messageId: id, delivery: "queued", recovered: false };
      operations.set(args.operationId, result);
      return result as T;
    }
    case "set_message_reactions": {
      const previous = reactions.get(args.messageId) ?? { mine: [], peer: [], mineRevision: 0, peerRevision: 0, delivery: "delivered" };
      const state = { ...previous, mine: args.reactions, mineRevision: previous.mineRevision + 1 };
      reactions.set(args.messageId, state);
      revision += 1;
      return state as T;
    }
    default: return null as T;
  }
}

export const recordChildRender = () => {};
export const recordAppBody = () => {};
export const convertFileSrc = (value: string) => value.startsWith("data:") || value.startsWith("blob:") ? value : "";
export const getCurrentWindow = () => ({ setTitle: async () => {} });
export const isPermissionGranted = async () => false;
export const requestPermission = async () => "denied";
export const sendNotification = () => {};
export const openDialog = async () => null;
export const openUrl = async (url: string) => { geometryOpenedUrls.push(url); };
export const recoverIncomingTransfer = async () => false;
export const setTransferPreviewChatActive = () => {};
export const setTransferPreviewPins = () => {};
export const releaseTransferPreviews = () => {};
export const releaseProfileTransferPreviews = () => {};
export const transferPreviewSource = () => "";
export const sendFile = async () => 0;
export async function listen<T>(event: string, handler: (event: T) => void) {
  const handlers = events.get(event) ?? new Set();
  handlers.add(handler as (event: any) => void);
  events.set(event, handlers);
  return () => handlers.delete(handler as (event: any) => void);
}
