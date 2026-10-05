// Disposable actual-App adapter for the geometry runtime test. It never ships.
import { onboardingCommands, onboardingDialog, onboardingEnabled, onboardingInvoke, onboardingProfiles, onboardingReadStartup } from "./onboarding-platform";
import { qtoxFixtureInvoke } from "./qtox-export-platform";
import { avatarOwnerInvoke } from "./avatar-owner-platform";
import { avatarSettingsDataUrl, avatarSettingsInvoke } from "./avatar-settings-platform";
export const platformCapabilities = { nativeFilesystem: new URLSearchParams(location.search).has("desktop-notifications"), systemTray: false, browserAuthorization: false, containerRelativeLayout: false, outgoingTransferRetry: true, proxyConnectivityTest: false };

const keys = ["A".repeat(64), "B".repeat(64), "C".repeat(64), "D".repeat(64)];
const pendingRequestKey = "9".repeat(64);
let pendingRequestFriendNumber: number | null = null;
export const geometryPendingRequestKey = () => pendingRequestKey;
export const geometryPendingRequestFriendNumber = () => pendingRequestFriendNumber;
const counts = [100_000, 51, 8, 1];
const friendNames = ["QA Bob · 100k", "QA Carol", "QA Dave", "QA Erin · unread geometry"];
const removedFriends = new Set<number>();
let sendFailures = 0;
let cancellationFailures = 0;
let friendDiscoveryPending = 0;
export const geometrySendAttempts: any[] = [];
export const geometryCancellationCalls: any[] = [];
export const geometryDeleteCalls: any[] = [];
let richReactionRows = false;
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
type SnapshotEvidence = {
  requestTarget: string | null;
  requestRange: number | null;
  requestKnownRevision: number | null;
  revision: number;
  windowStart: number;
  total: number;
  hasMoreAfter: boolean;
  firstMessageId: string | null;
  lastMessageId: string | null;
  latestMessageId: string | null;
  returnedMessages: boolean;
};
const latestSnapshots: Array<SnapshotEvidence | null> = counts.map(() => null);
type SearchEvidence = {
  startedCalls: number;
  completedCalls: number;
  inFlight: number;
  matchingQueryRequests: number;
  lastRequest: { sequence: number; queryMatchesNeedle: boolean; queryLength: number | null; cursorIndex: number | null; startedAt: number } | null;
  lastResponse: { sequence: number; scannedStart: number; scannedEnd: number; matchCount: number; firstMatchIndex: number | null; nextCursorIndex: number | null; elapsedMs: number } | null;
};
const searchEvidence: SearchEvidence[] = counts.map(() => ({ startedCalls: 0, completedCalls: 0, inFlight: 0, matchingQueryRequests: 0, lastRequest: null, lastResponse: null }));
let revision = 1;
let local: any = {
  activeChat: `tox-${keys[0]}`, historyMessageLimit: 500, drafts: {}, saveChatHistory: true, spellcheckEnabled: false,
  ...(new URLSearchParams(location.search).has("spellcheck-controlled") ? { spellcheckEnabled: true, spellcheckRussian: true, spellcheckEnglish: false } : {}),
  ...(new URLSearchParams(location.search).has("spellcheck-native") ? { spellcheckEnabled: true, spellcheckRussian: true, spellcheckEnglish: true } : {}),
  ...(new URLSearchParams(location.search).has("outbox-fixture")
    ? { outgoingFriendRequests: [{ toxId: `${keys[0]}${"0".repeat(12)}`, message: "Disposable earlier authorization" }] }
    : {}),
};
let activeProfileId = "qa-profile-a";
const profilePasswords = new Map<string, string | null>();
export const geometryPasswordCalls: any[] = [];
let holdPasswords = false;
const passwordReplies: Array<(error?: string, stale?: boolean) => void> = [];
export const geometryHoldPasswords = (hold: boolean) => { holdPasswords = hold; };
export const geometryResolvePassword = (index: number, error?: string, stale = false) => passwordReplies[index](error, stale);
const profileLocalStates = new Map<string, any>();
const clearedHistoryProfiles = new Set<string>();
export const geometryHistoryTotal = (profileId: string, friend = 0) => clearedHistoryProfiles.has(profileId) ? 0 : counts[friend];
export const geometryRestoreProfileHistory = (profileId: string) => { clearedHistoryProfiles.delete(profileId); revision++; };
export const geometryClearHistoryCalls: Array<{ profileId: string; friendNumber: number | null; status: string }> = [];
let holdClearHistory = false;
const clearHistoryReplies: Array<(error?: string) => void> = [];
export const geometryHoldClearHistory = (hold = true) => { holdClearHistory = hold; };
export const geometryResolveClearHistory = (index: number, error?: string) => clearHistoryReplies[index](error);
type HistoryReadKind = "snapshot" | "search" | "local";
const holdNextHistoryRead = new Set<HistoryReadKind>();
const heldLocalStateOwners = new Set<string>();
export const geometryHoldLocalState = (owner: string, hold = true) => { if (hold) heldLocalStateOwners.add(owner); else heldLocalStateOwners.delete(owner); };
export const geometryHistoryReads: Array<{ kind: HistoryReadKind; profileId: string; status: string; rows: number }> = [];
const historyReadReplies: Array<() => void> = [];
export const geometryHoldNextHistoryRead = (kind: HistoryReadKind) => { holdNextHistoryRead.add(kind); };
export const geometryResolveHistoryRead = (index: number) => historyReadReplies[index]();
function historyRead<T>(kind: HistoryReadKind, profileId: string, value: T): Promise<T> {
  if (!holdNextHistoryRead.delete(kind) && !(kind === "local" && heldLocalStateOwners.has(profileId))) return Promise.resolve(value);
  const index = geometryHistoryReads.length;
  const captured = value as any;
  const call = { kind, profileId, status: "pending", rows: kind === "local" ? Object.keys(captured?.draftQuotes ?? {}).length : (kind === "snapshot" ? captured.messages : captured.matches)?.length ?? 0 };
  geometryHistoryReads.push(call);
  return new Promise<T>((resolve) => { historyReadReplies[index] = () => { call.status = "resolved"; resolve(value); }; });
}
type RouteKind = "network" | "proxy";
const routeValues: Record<RouteKind, any> = {
  network: { udpEnabled: true, ipv6Enabled: true, localDiscoveryEnabled: true },
  proxy: { mode: "none", host: "", port: 9050, username: "", password: "" },
};
const heldRouteGets = new Set<RouteKind>();
export const geometryRouteCalls: Array<{ index: number; kind: RouteKind; command: string; settings?: any; status: string }> = [];
const routeReplies: Array<(error?: string) => void> = [];
export const geometryHoldRouteGets = (kind: RouteKind, hold = true) => { if (hold) heldRouteGets.add(kind); else heldRouteGets.delete(kind); };
export const geometryResolveRoute = (index: number, error?: string) => { if (!routeReplies[index]) throw new Error("route request is not pending"); routeReplies[index](error); };
function routeInvoke<T>(kind: RouteKind, command: string, args: any): Promise<T> {
  const index = geometryRouteCalls.length;
  const read = command.startsWith("get_");
  const snapshot = structuredClone(read ? routeValues[kind] : args.settings);
  const call = { index, kind, command, settings: read ? undefined : snapshot, status: "pending" };
  geometryRouteCalls.push(call);
  return new Promise<T>((resolve, reject) => {
    routeReplies[index] = (error?: string) => {
      if (call.status !== "pending") throw new Error("route request already completed");
      call.status = error ? "rejected" : "resolved";
      if (error) { reject(new Error(error)); return; }
      if (!read) routeValues[kind] = structuredClone(snapshot);
      resolve(structuredClone(snapshot) as T);
    };
    if (read && !heldRouteGets.has(kind)) routeReplies[index]();
  });
}
export const geometryProfileSwitches: Array<{ profileId: string; previousProfileId: string; previousState: any }> = [];
export const geometryProfileLocalState = (id: string) => structuredClone(id === activeProfileId ? local : profileLocalStates.get(id));
export const geometryNativeListenerCount = (name: string) => events.get(name)?.size ?? 0;
export function geometryEmitNativeEvent(name: string, payload: unknown) {
  for (const handler of events.get(name) ?? []) handler({ event: name, id: ++profileEventSequence, payload });
}
let friendDiscoveryDelay = 0;
export const geometryDelayFriendDiscovery = (ms: number) => { friendDiscoveryDelay = ms; };
export const geometryFriendDiscoveryPending = () => friendDiscoveryPending;
export const geometryFailNextSend = (count = 1) => { sendFailures = count; };
export const geometryFailNextCancellation = (count = 1) => { cancellationFailures = count; };
export const geometryFriendKey = (friend: number) => keys[friend];
export function geometryReuseFriendSlot(friend: number, publicKey: string) {
  if (!removedFriends.has(friend) || publicKey.length !== 64) throw new Error("friend slot is not available for reuse");
  keys[friend] = publicKey;
  friendNames[friend] = "QA Replacement";
  counts[friend] = 1;
  removedFriends.delete(friend);
  revision += 1;
  emitProfilesChanged();
}
let layout: any = {};
let menuProfilesEnabled = platformCapabilities.nativeFilesystem;
export const geometryProfileActions: Array<{ command: string; profileId: string }> = [];
export const geometrySavedProfileOrder = () => structuredClone(layout.profileOrder ?? []);
let acknowledgeDelayMs = 0;
let acknowledgeFailures = 0;
let torState = { state: "disabled", progress: 0, lines: [] as string[] };
let localSaveCount = 0;
type OwnUserStatus = "online" | "away" | "busy" | "offline";
let ownUserStatus: OwnUserStatus = "online";
let profileConnection = "udp";
let historyDelayMs = 0;
const tailSnapshotFailures = new Map<number, number>();
const tailSnapshotDelays = new Map<number, number>();
const tailSnapshotRowLimits = new Map<number, number>();
type SnapshotCall = { id: number; friendNumber: number; requestRange: number | null; requestTarget: string | null;
  requestKnownRevision: number | null; status: "started" | "resolved" | "failed"; revision: number | null;
  latestMessageId: string | null; lastMessageId: string | null; startedAt: number; finishedAt: number | null };
const snapshotCalls: SnapshotCall[] = [];
let snapshotCallId = 0;
const incomingRequests: Array<{ public_key: string; message: string }> = [];
let requestActionFailures = 0;
export const geometryRequestActions: Array<{ command: string; profileId: string; publicKey: string }> = [];
export function geometrySetProfileConnection(connection: "udp" | "tcp" | "offline", status: OwnUserStatus = "online") {
  profileConnection = connection;
  ownUserStatus = status;
  emitProfilesChanged();
}
export function geometryDelayHistory(milliseconds: number) { historyDelayMs = milliseconds; }
export function geometryFailNextTailSnapshot(friendNumber: number, count = 1) {
  tailSnapshotFailures.set(friendNumber, Math.max(0, count));
}
export function geometryDelayNextTailSnapshot(friendNumber: number, milliseconds: number) {
  tailSnapshotDelays.set(friendNumber, Math.max(0, milliseconds));
}
export function geometryLimitNextTailSnapshot(friendNumber: number, maximumRows: number) {
  tailSnapshotRowLimits.set(friendNumber, Math.max(1, Math.floor(maximumRows)));
}
export function geometryPrepareEmptyChat(friendNumber = 3) {
  if (friendNumber !== 3) throw new Error("empty-chat fixture is reserved for disposable friend 3");
  counts[friendNumber] = 0;
  for (const id of appended.keys()) if (Number.parseInt(id, 16) >= (friendNumber + 1) * 1_000_000
    && Number.parseInt(id, 16) < (friendNumber + 2) * 1_000_000) appended.delete(id);
  unseenMessages.delete(friendNumber);
  delete unread[String(friendNumber)];
  revision += 1;
}
export function geometrySnapshotCalls(friendNumber: number) {
  return snapshotCalls.filter((call) => call.friendNumber === friendNumber).map((call) => ({ ...call }));
}
export function geometryAddFriendRequest(publicKey: string, failures = 0) {
  incomingRequests.push({ public_key: publicKey, message: "Disposable authorization request" });
  requestActionFailures = failures;
  emitProfilesChanged();
}
let profileEventSequence = 0;

function emitProfilesChanged(profileId = "qa-profile-a") {
  const event = { event: "profiles-changed", id: ++profileEventSequence, payload: profileId };
  for (const handler of events.get("profiles-changed") ?? []) handler(event);
}

export function geometrySetTorState(state: "disabled" | "starting" | "connecting" | "connected" | "error", progress = 0) {
  torState = { state, progress, lines: [] };
}

export function geometryDraftPersistenceEvidence() {
  return { count: localSaveCount, state: structuredClone(local) };
}

export function geometrySetMenuProfiles(enabled: boolean) {
  menuProfilesEnabled = enabled;
  window.dispatchEvent(new Event("profiles-changed"));
}

export function geometryDelayAcknowledgements(milliseconds: number, failures = 0) {
  acknowledgeDelayMs = milliseconds;
  acknowledgeFailures = failures;
}

export function geometryAppendImage(friend: number, source: string, mine = true) {
  const index = counts[friend]++;
  const id = geometryMessageId(friend, index);
  appended.set(id, { id, friend_number: friend, text: "", mine, timestamp: Math.floor(Date.now() / 1000), delivery: "delivered", protocol_version: 1,
    attachment: { name: "menu-layout.png", size: 256, mime: "image/png", path: source, image: true, transferred: 256, transfer_state: "complete", completed: true } });
  revision += 1;
  return id;
}

export const geometryMessageId = (friend: number, index: number) => ((friend + 1) * 1_000_000 + index).toString(16).padStart(32, "0");
export const geometrySentPayloads: any[] = [];
export const geometryOpenedUrls: string[] = [];

// Detached metadata only: observing a send or snapshot never refreshes history.
export function geometrySnapshotEvidence(friendNumber: number) {
  const snapshot = latestSnapshots[friendNumber];
  return snapshot ? { ...snapshot } : null;
}

export function geometrySearchEvidence(friendNumber: number) {
  const evidence = searchEvidence[friendNumber];
  if (!evidence) return null;
  const { lastRequest, lastResponse, ...counters } = evidence;
  const request = lastRequest && { ...lastRequest };
  return { ...counters, lastRequest: request, lastResponse: lastResponse && { ...lastResponse }, requestAgeMs: request ? Math.round(performance.now() - request.startedAt) : null };
}

export function geometryAcceptedSendResult(operationId: string) {
  const result = operations.get(operationId);
  return result ? { messageId: result.messageId as string, delivery: result.delivery as string, recovered: result.recovered as boolean } : undefined;
}

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

export function geometryAppendOutgoingText(friend: number, text: string, delivery: "pending" | "delivered" = "pending") {
  const index = counts[friend]++;
  const id = geometryMessageId(friend, index);
  appended.set(id, {
    id, friend_number: friend, friend_public_key: keys[friend], text, mine: true,
    timestamp: Math.floor(Date.now() / 1000), delivery, protocol_version: 1, pq_protected: false,
    ...(delivery === "delivered" ? { delivered_at: Math.floor(Date.now() / 1000) } : {}),
  });
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

export function geometryAppendFileAttachment(friend: number, mine: boolean, attachment: Record<string, unknown>) {
  const index = counts[friend]++;
  const id = geometryMessageId(friend, index);
  appended.set(id, {
    id, friend_number: friend, text: "", mine,
    timestamp: Math.floor(Date.now() / 1000), delivery: "delivered", pq_protected: false,
    attachment: structuredClone(attachment),
  });
  revision += 1;
  return id;
}

export function geometryUpdateFileAttachment(id: string, patch: Record<string, unknown>) {
  const message = appended.get(id);
  if (!message?.attachment) throw new Error("file attachment fixture is missing");
  appended.set(id, { ...message, attachment: { ...message.attachment, ...structuredClone(patch) } });
  revision += 1;
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
  emitProfilesChanged();
}

export function geometryEmitOwnStatus(status: OwnUserStatus) {
  if (!["online", "away", "busy", "offline"].includes(status)) throw new Error("unsupported own-status fixture value");
  ownUserStatus = status;
  const immediate = { event: "active-user-status-changed", id: ++profileEventSequence, payload: status };
  for (const handler of events.get("active-user-status-changed") ?? []) handler(immediate);
  emitProfilesChanged();
}

export function prepareRichUiScenario() {
  geometrySentPayloads.length = 0;
  // This fixture tests the 50-message cutoff independently from own-message exclusion.
  richReactionRows = true;
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
    mine: friend === 3 || (richReactionRows && friend === 1) ? false : index % 3 === 0,
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
const profile = () => ({ id: "qa-profile-a", name: "QA Alice", fileName: "qa.kai", encrypted: false, loaded: true, active: true, connection: profileConnection, userStatus: ownUserStatus, unread: 0, notificationsEnabled: false });
const profileSummaries = () => onboardingEnabled ? onboardingProfiles() : [profile(), ...(menuProfilesEnabled ? [{ ...profile(), id: "qa-profile-b", name: "QA Second", fileName: "second.kai" }] : [])].map((item) => ({ ...item, avatar: avatarSettingsDataUrl(item.id), encrypted: !!profilePasswords.get(item.id), active: item.id === activeProfileId }));

export async function invoke<T>(command: string, args: any = {}): Promise<T> {
  const avatarOwnerRequest = avatarOwnerInvoke<T>(command, args);
  if (avatarOwnerRequest) return avatarOwnerRequest;
  const avatarSettingsRequest = avatarSettingsInvoke<T>(command, args, profileSummaries);
  if (avatarSettingsRequest) return avatarSettingsRequest;
  if (command === "export_qtox_profile") return qtoxFixtureInvoke<T>(args, activeProfileId, profilePasswords.get(args.profileId ?? activeProfileId) ?? null);
  if (onboardingEnabled && onboardingCommands.has(command)) return onboardingInvoke<T>(command, args);
  switch (command) {
    case "clear_tox_history": {
      const owner = args.profileId ?? activeProfileId;
      const index = geometryClearHistoryCalls.length;
      const call = { profileId: owner, friendNumber: args.friendNumber ?? null, status: "pending" };
      geometryClearHistoryCalls.push(call);
      return new Promise<T>((resolve, reject) => {
        clearHistoryReplies[index] = (error?: string) => {
          if (call.status !== "pending") throw new Error("history clear already completed");
          call.status = error ? "rejected" : "resolved";
          if (error) { reject(new Error(error)); return; }
          if (call.friendNumber !== null) throw new Error("this fixture clears only the complete disposable profile");
          clearedHistoryProfiles.add(owner); revision++;
           const previous = owner === activeProfileId ? local : profileLocalStates.get(owner);
           const epoch = (previous?.historyClearEpoch ?? 0) + 1;
           const next = { ...structuredClone(previous ?? {}), historyClearEpoch: epoch, draftQuotes: {}, peerReactionNotices: {}, scrollAnchors: {} };
           profileLocalStates.set(owner, next);
           if (owner === activeProfileId) local = structuredClone(next);
           resolve(epoch as T);
        };
        if (!holdClearHistory) clearHistoryReplies[index]();
      });
    }
    case "change_profile_password": {
      const index = geometryPasswordCalls.length;
      geometryPasswordCalls.push(structuredClone(args));
      const owner = args.profileId ?? activeProfileId;
      const snapshot = profileSummaries();
      return new Promise<T>((resolve, reject) => {
        const reply = (error?: string, stale = false) => {
          if (error) { reject(new Error(error)); return; }
          if ((profilePasswords.get(owner) ?? null) !== args.currentPassword) { reject(new Error("PROFILE_PASSWORD_INVALID")); return; }
          profilePasswords.set(owner, args.newPassword);
          resolve((stale ? snapshot.map((item) => ({ ...item, encrypted: !!profilePasswords.get(item.id) })) : profileSummaries()) as T);
        };
        passwordReplies[index] = reply;
        if (!holdPasswords) reply();
      });
    }
    case "disable_profile": {
      geometryProfileActions.push({ command, profileId: args.profileId });
      if (args.profileId === "qa-profile-b") menuProfilesEnabled = false;
      return [profile()] as T;
    }
    case "switch_profile": {
      if (!profileSummaries().some((item) => item.id === args.profileId)) throw new Error("PROFILE_NOT_LOADED");
      geometryProfileSwitches.push({ profileId: args.profileId, previousProfileId: activeProfileId, previousState: structuredClone(local) });
      profileLocalStates.set(activeProfileId, structuredClone(local));
      activeProfileId = args.profileId;
      local = profileLocalStates.get(activeProfileId) ?? { activeChat: `tox-${keys[0]}`, historyMessageLimit: 500, drafts: {}, saveChatHistory: true };
      return profileSummaries() as T;
    }
    case "get_startup_state": return onboardingEnabled ? onboardingReadStartup<T>() : { firstRun: false, language: "ru", closeToTray: false, profiles: profileSummaries() } as T;
    case "load_local_state": return historyRead("local", args.profileId ?? activeProfileId, structuredClone(args.profileId && args.profileId !== activeProfileId ? profileLocalStates.get(args.profileId) : local)) as Promise<T>;
    case "save_local_state": {
      localSaveCount += 1;
      const owner = args.profileId ?? activeProfileId;
      const previous = owner === activeProfileId ? local : profileLocalStates.get(owner);
      const epoch = previous?.historyClearEpoch ?? 0;
      const next = structuredClone(args.state);
      if ((next.historyClearEpoch ?? 0) !== epoch) { next.draftQuotes = {}; next.peerReactionNotices = {}; next.scrollAnchors = {}; }
      next.historyClearEpoch = epoch;
      profileLocalStates.set(owner, next);
      if (owner === activeProfileId) local = structuredClone(next);
      return null as T;
    }
    case "load_layout_state": return layout as T;
    case "save_layout_state": layout = structuredClone(args.state); return null as T;
    case "get_tox_friends": {
      const snapshot = keys.flatMap((key, number) => removedFriends.has(number) ? [] : [{ number, public_key: key, tox_id: key + "0".repeat(12), authorized: number !== pendingRequestFriendNumber, connection: number === pendingRequestFriendNumber ? "offline" : "online", name: friendNames[number], status: friendStatuses[number], status_message: "", last_event: 1_788_800_000 + counts[number], addedAt: 1_788_800_000, lastEventSequence: counts[number] }]);
      if (friendDiscoveryDelay) {
        friendDiscoveryPending += 1;
        try { await sleep(friendDiscoveryDelay); } finally { friendDiscoveryPending -= 1; }
      }
      return snapshot as T;
    }
    case "get_tox_id": return ("F".repeat(64) + "0".repeat(12)) as T;
    case "add_tox_friend": {
      if (new URLSearchParams(location.search).has("outbox-fixture") && args.toxId?.toUpperCase().startsWith(pendingRequestKey)) {
        if (pendingRequestFriendNumber === null) {
          pendingRequestFriendNumber = keys.length;
          keys.push(pendingRequestKey);
          counts.push(0);
          friendNames.push("QA Pending Request");
          friendStatuses.push("offline");
          reactionEventRevisions.push(0);
          latestSnapshots.push(null);
          searchEvidence.push({ startedCalls: 0, completedCalls: 0, inFlight: 0, matchingQueryRequests: 0, lastRequest: null, lastResponse: null });
          revision += 1;
        }
        return pendingRequestFriendNumber as T;
      }
      const friend = keys.findIndex((key, number) => !removedFriends.has(number) && args.toxId?.toUpperCase().startsWith(key));
      if (friend < 0) throw new Error("DISPOSABLE_FRIEND_REQUEST_TARGET_INVALID");
      return friend as T;
    }
    case "get_tox_user_status": return ownUserStatus as T;
    case "get_tox_network_status": return (ownUserStatus === "offline" ? "offline" : profileConnection === "offline" ? "connecting" : "online") as T;
    case "get_tox_status_message": return "" as T;
    case "get_proxy_settings": return routeInvoke<T>("proxy", command, args);
    case "set_proxy_settings": return routeInvoke<T>("proxy", command, args);
    case "get_network_settings": return routeInvoke<T>("network", command, args);
    case "set_network_settings": return routeInvoke<T>("network", command, args);
    case "get_tor_status": return { ...torState, lines: [...torState.lines] } as T;
    case "get_pq_status": return { supported: true, state: "available", local_fingerprint: "", peer_fingerprint: null, fingerprint_changed: false } as T;
    case "get_file_receive_settings": return { autoAccept: "none", showImages: true, maxConcurrent: 2, maxFileSizeMb: 25 } as T;
    case "get_chat_capabilities": return (args.friendNumber === 2
      ? { version: 0, enhancedMessages: false, reactions: false, formatting: false, quotes: false }
      : { version: 1, enhancedMessages: true, reactions: true, formatting: true, quotes: true }) as T;
    case "get_incoming_friend_requests": return structuredClone(incomingRequests) as T;
    case "accept_incoming_friend_request":
    case "reject_incoming_friend_request": {
      geometryRequestActions.push({ command, profileId: args.profileId, publicKey: args.publicKey });
      await sleep(100);
      if (requestActionFailures > 0) { requestActionFailures -= 1; throw new Error("DISPOSABLE_REQUEST_FAILURE"); }
      const index = incomingRequests.findIndex((request) => request.public_key === args.publicKey);
      if (index >= 0) incomingRequests.splice(index, 1);
      return null as T;
    }
    case "get_unread_state": return { friends: { ...unread }, requests: [] } as T;
    case "acknowledge_local_messages": {
      const friendNumber = Number(args.friendNumber);
      const messageIds = Array.isArray(args.messageIds) ? args.messageIds.filter((id: unknown): id is string => typeof id === "string") : [];
      acknowledgeCalls.push({ friendNumber, messageIds: [...messageIds] });
      await sleep(acknowledgeDelayMs);
      if (acknowledgeFailures > 0) { acknowledgeFailures -= 1; throw new Error("DISPOSABLE_ACK_FAILURE"); }
      const pending = unseenMessages.get(friendNumber);
      if (pending) {
        for (const messageId of messageIds) pending.delete(messageId);
        unread[String(friendNumber)] = pending.size;
      }
      return { friends: { ...unread }, requests: [] } as T;
    }
    case "get_tox_messages_snapshot": {
      const friend = args.friendNumber;
      const owner = args.profileId ?? activeProfileId;
      const tailRequest = args.rangeOffset === undefined && args.targetMessageId === undefined;
      const call: SnapshotCall = { id: ++snapshotCallId, friendNumber: friend,
        requestRange: args.rangeOffset ?? null, requestTarget: args.targetMessageId ?? null,
        requestKnownRevision: args.knownRevision ?? null, status: "started", revision: null, latestMessageId: null,
        lastMessageId: null,
        startedAt: performance.now(), finishedAt: null };
      snapshotCalls.push(call);
      if (snapshotCalls.length > 160) snapshotCalls.shift();
      if (tailRequest) {
        const delay = tailSnapshotDelays.get(friend);
        if (delay !== undefined) {
          tailSnapshotDelays.delete(friend);
          await sleep(delay);
        }
        const remainingFailures = tailSnapshotFailures.get(friend) ?? 0;
        if (remainingFailures > 0) {
          tailSnapshotFailures.set(friend, remainingFailures - 1);
          call.status = "failed";
          call.finishedAt = performance.now();
          throw new Error("DISPOSABLE_HISTORY_TAIL_TRANSIENT");
        }
      }
      if (historyDelayMs) await sleep(historyDelayMs);
      await sleep(25);
      if (args.ackPeerReactionThrough) reactionEvents.set(friend, (reactionEvents.get(friend) ?? []).filter((event) => event.eventRevision > args.ackPeerReactionThrough));
      const total = geometryHistoryTotal(owner, friend);
      const nextTailRowLimit = tailRequest ? tailSnapshotRowLimits.get(friend) : undefined;
      if (nextTailRowLimit !== undefined) tailSnapshotRowLimits.delete(friend);
      const limit = Math.min(1000, args.limit || 1000, nextTailRowLimit ?? Infinity);
      const target = args.targetMessageId ? Number.parseInt(args.targetMessageId, 16) - (friend + 1) * 1_000_000 : undefined;
      const windowStart = Math.max(0, Math.min(total - limit, target !== undefined ? target - Math.floor(limit / 2) : args.rangeOffset ?? total - limit));
      const messages = Array.from({ length: Math.min(limit, total - windowStart) }, (_, offset) => row(friend, windowStart + offset));
      const snapshot = {
        revision,
        windowStart,
        total,
        hasMoreBefore: windowStart > 0,
        hasMoreAfter: windowStart + messages.length < total,
        targetIndex: target,
        messages: args.knownRevision === revision && args.targetMessageId === undefined && args.rangeOffset === undefined ? null : messages,
        peerReactionEvents: (reactionEvents.get(friend) ?? []).filter((event) => event.eventRevision > (args.peerReactionAfter ?? 0)).slice(0, 64),
        peerReactionLatestRevision: reactionEventRevisions[friend],
        latestMessageId: total > 0 ? geometryMessageId(friend, total - 1) : null,
        reactionEligibleIds: Array.from({ length: Math.min(total, 50) }, (_, index) => geometryMessageId(friend, total - Math.min(total, 50) + index)),
        firstUnseenMessageId: [...(unseenMessages.get(friend) ?? [])][0],
        unseenMessageIds: [...(unseenMessages.get(friend) ?? [])],
      };
      if (Number.isInteger(friend) && friend >= 0 && friend < latestSnapshots.length) {
        latestSnapshots[friend] = {
          requestTarget: args.targetMessageId ?? null,
          requestRange: args.rangeOffset ?? null,
          requestKnownRevision: args.knownRevision ?? null,
          revision: snapshot.revision,
          windowStart: snapshot.windowStart,
          total: snapshot.total,
          hasMoreAfter: snapshot.hasMoreAfter,
          firstMessageId: messages.at(0)?.id ?? null,
          lastMessageId: messages.at(-1)?.id ?? null,
          latestMessageId: snapshot.latestMessageId,
          returnedMessages: snapshot.messages !== null,
        };
      }
      call.status = "resolved";
      call.revision = snapshot.revision;
      call.latestMessageId = snapshot.latestMessageId;
      call.lastMessageId = messages.at(-1)?.id ?? null;
      call.finishedAt = performance.now();
      return historyRead("snapshot", owner, snapshot as T);
    }
    case "get_tox_messages": return (geometryHistoryTotal(args.profileId ?? activeProfileId, args.friendNumber) ? [row(args.friendNumber, counts[args.friendNumber] - 1)] : []) as T;
    case "search_tox_messages": {
      const owner = args.profileId ?? activeProfileId;
      const evidence = Number.isInteger(args.friendNumber) ? searchEvidence[args.friendNumber] : undefined;
      const startedAt = performance.now();
      const sequence = evidence ? ++evidence.startedCalls : 0;
      if (evidence) {
        evidence.inFlight += 1;
        if (args.query === "Needle") evidence.matchingQueryRequests += 1;
        evidence.lastRequest = {
          sequence, queryMatchesNeedle: args.query === "Needle",
          queryLength: typeof args.query === "string" ? args.query.length : null,
          cursorIndex: typeof args.cursor === "string" ? Number(args.cursor.split(":")[1]) : args.cursor == null ? 0 : null,
          startedAt,
        };
      }
      try {
        await sleep(5);
        let index = Number(args.cursor?.split(":")[1] ?? 0);
        const scannedStart = index;
        const total = geometryHistoryTotal(owner, args.friendNumber);
        const end = Math.min(total, index + 500);
        const matches = [];
        for (; index < end && matches.length < 100; index++) {
          const message = row(args.friendNumber, index);
          const start = message.text.toLowerCase().indexOf(args.query.toLowerCase());
          if (start >= 0) matches.push({ messageId: message.id, index, field: "text", start, end: start + args.query.length });
        }
        if (evidence) {
          evidence.completedCalls += 1;
          evidence.lastResponse = {
            sequence, scannedStart, scannedEnd: index, matchCount: matches.length,
            firstMatchIndex: matches.at(0)?.index ?? null,
            nextCursorIndex: index < total ? index : null,
            elapsedMs: Math.round(performance.now() - startedAt),
          };
        }
        return historyRead("search", owner, { matches, nextCursor: index < total ? `1:${index}` : null } as T);
      } finally {
        if (evidence) evidence.inFlight -= 1;
      }
    }
    case "send_tox_message": {
      geometrySendAttempts.push(structuredClone(args));
      await sleep(225);
      if (sendFailures > 0) { sendFailures -= 1; throw new Error("DISPOSABLE_SEND_FAILURE"); }
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
    case "cancel_tox_message": {
      geometryCancellationCalls.push(structuredClone(args));
      await sleep(80);
      if (cancellationFailures > 0) { cancellationFailures -= 1; throw new Error("CHAT_MESSAGE_ALREADY_SENT"); }
      if (keys[args.friendNumber] !== args.expectedPublicKey) throw new Error("CHAT_CONTACT_IDENTITY_CHANGED");
      const message = appended.get(args.messageId);
      if (!message || message.delivery !== "pending" || !message.mine) throw new Error("CHAT_MESSAGE_ALREADY_SENT");
      appended.set(args.messageId, { ...message, delivery: "cancelled" });
      revision += 1;
      return { delivery: "cancelled", alreadyTransmitted: false } as T;
    }
    case "delete_tox_friend": {
      geometryDeleteCalls.push(structuredClone(args));
      await sleep(100);
      if (keys[args.friendNumber] !== args.expectedPublicKey) throw new Error("CHAT_CONTACT_IDENTITY_CHANGED");
      removedFriends.add(args.friendNumber);
      revision += 1;
      return null as T;
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
export const openDialog = async (options?: any) => onboardingEnabled ? onboardingDialog(options) : null;
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
