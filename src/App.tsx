import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { createPortal } from "react-dom";
import { openUrl } from "@kaigen/platform";
import { ChatMessageText } from "./ChatMessageText";
import { chatLinkAtTarget } from "./chatLinks";
import { elementGeometryScale } from "./chatNavigation";
import { convertFileSrc, invoke, isPermissionGranted, listen, platformCapabilities, recoverIncomingTransfer, releaseProfileTransferPreviews, releaseTransferPreviews, requestPermission, sendFile, sendNotification, setTransferPreviewChatActive, setTransferPreviewPins, transferPreviewSource } from "@kaigen/platform";
import "./App.css";
import Settings, { type SettingsOpenRequest, type TorStatus } from "./Settings";
import MessageComposer, { clearSpellcheckMemory } from "./SpellcheckComposer";
import { ChatImageViewer } from "./ChatImageViewer";
import PqEntropy, { isPqAwaitingManualDecision, PqCapabilityWait, PqSessionControl } from "./PqEntropy";
import { FormattedMessageText, MessageQuotePreview, OffscreenReactionNotice, ReactionBar, ReactionPicker } from "./ChatMessageEnhancements";
import { dismissContextMenus, registerContextMenuDismissal } from "./contextMenuCoordinator";
import { applyPeerReactionEvents, dismissReactionNotice, restoreReactionNotices, type PeerReactionEvent, type ReactionNotice, type ReactionNoticeStore } from "./chatReactionNotices";
import { parseChatNotificationTarget } from "./chatNotificationTarget";
import { ChatNotificationQueue } from "./chatNotificationQueue";
import { formatChatDate } from "./chatDateFormat";
import ProfileAvatar, { type ProfileAvatarState } from "./ProfileAvatar";
import type { ProfileSummary } from "./RootApp";
import { isEditableTextTarget } from "./editableTextTarget";
import { translateText, useI18n, type Language } from "./i18n";
import { normalizeProfileAvatar } from "./avatar";
import { canStageChatFile, hasFileDragType } from "./chatFileDrop";
import { admitChatFileBatch, formatChatFileBatchNotice } from "./chatFileBatch";
import {
  normalizeFileReceiveSettings,
  type FileReceiveSettings,
} from "./fileReceiveSettings";
import { appShellScaleStyle } from "./interfaceScale";
import { normalizeOwnStatusMessage } from "./statusMessage";
import {
  initialProxySettings,
  initialTorStatus,
  retainProxySettings,
  retainTorStatus,
  type ProxySettings,
} from "./torRuntimeState";
import { useKaigenTheme } from "@kaigen/theme";
import {
  hydratePortableLayout,
  isPortableLayoutHydrated,
  readPortableLayoutSnapshot,
  retainPortableLayoutPatch,
  savePortableLayoutPatch,
} from "./layoutPersistence";
import {
  migrateLegacyContactRecord,
  migrateLegacyToxChatId,
  resolveFriendChatId,
  toxChatId,
} from "./contactIdentity";
import {
  DEFAULT_CONTACT_SORT,
  normalizeContactSort,
  orderContacts,
  toggleContactSort,
  updateActivityHold,
  type ActivityHold,
  type ContactSortDirection,
  type ContactSortState,
} from "./contactListOrder";
import {
  APP_RAIL_WIDTH,
  SIDEBAR_MAX_REQUESTED_WIDTH,
  SIDEBAR_MIN_REQUESTED_WIDTH,
  moveProfileOrder,
  normalizeProfileOrder,
  resolveAppLayout,
} from "./appLayout";
import {
  DEFAULT_APPEARANCE,
  getTypographyFont,
  normalizeAppearance,
  type AppearanceSettings,
} from "./chatTypography";
import {
  formatChatMessageNotice,
  formatChatRequestNotice,
  formatDeliveryReceiptTitle,
  formatFriendRequestDefault,
  formatPqDescription,
  formatPqTitle,
  formatProfileSwitcherAria,
  formatProfileSwitcherTitle,
  formatTorIndicator,
  formatUnreadMessagesLabel,
  formatUserFacingError,
} from "./localization";
import {
  boundedHistoryRequestLimit,
  chatNavigationMode,
  DEFAULT_NOTIFICATION_SETTINGS,
  type HistoryMessageLimit,
  incomingContextMetrics,
  incomingNavigationBatch,
  incomingPrepaintAction,
  mediaLoadBelongsToIntent,
  normalizeHistoryMessageLimit,
  nextHistoryMessageLimit,
  scrollMessageWithinContainer,
  shouldPrepaintOutgoing,
  shouldPublishNavigationForScroll,
  shouldShowPendingDelivery,
  shouldShowJumpToLatest,
  shouldShowTransferActivity,
} from "./chatNavigation";
import { anchorScrollDelta, captureChatAnchor, isMessageInViewport, isMessageLocallySeen, mayAcknowledgeLocalView, retainSearchTarget, userScrollCancelsHistoryRestore, ChatHistoryCache, LatestChatSearch, type ChatViewAnchor } from "./chatViewState";
import { buildHistoryOffsets, historyIndexAtOffset, historyWindowRange } from "./chatWindow";
import { parseQtoxQuoteMessage, searchTextSegments, type ChatFormattingSpan, type ChatQuote, type ChatMessageReactions, type ChatReactionCode } from "./chatRichText";
import appUiCatalog from "./App.ui-ids.json";
import { messageDayModelKey, opaqueUiEntityKey } from "./uiIdentity";

const APP_UI_IDS = appUiCatalog.ids;
const CHAT_VIEW_SESSION_ID = crypto.randomUUID();
let chatViewGeneration = 0;
const chatSearchRequests = new LatestChatSearch();

type Chat = {
  id: string;
  initial: string;
  name: string;
  preview: string;
  time: string;
  color: string;
  status: UserStatus;
  lastOnline: string;
  toxId: string;
  friendNumber?: number;
  publicKey?: string;
  avatarPath?: string | null;
  pq?: boolean;
  lastEvent?: number | null;
  eventSequence?: number | null;
};

const chats: Chat[] = [];
/*
  { id: "alex", initial: "А", name: "Алексей", preview: "✓ Подтверждено обеими сторонами", time: "21:47", color: "blue", status: "online", lastOnline: "сейчас в сети", toxId: "7BXi8N3tns1LATmGvkXE8XodXdjqLsSgZ2", pq: true },
  { id: "masha", initial: "М", name: "Маша", preview: "Файл получен", time: "21:32", color: "pink", status: "busy", lastOnline: "сегодня, 21:32", toxId: "B953JR5hc0UFR4mDoNcMRb3Unp6KXz3HZ" },
  { id: "tox", initial: "Т", name: "Tox-разработка", preview: "Новый мост протестирован", time: "18:41", color: "green", status: "online", lastOnline: "сейчас в сети", toxId: "4PEoZy3t9R7vDk8xL2nA6sC5mQ1wYh0Uj" },
  { id: "olga", initial: "О", name: "Ольга", preview: "Отправила изображение", time: "17:20", color: "pink", status: "online", lastOnline: "сейчас в сети", toxId: "Q7dnK5aPx1MeT0cVz3HrY8uWi6BsL9fGo" },
  { id: "sergey", initial: "С", name: "Сергей", preview: "Проверю вечером", time: "16:48", color: "blue", status: "online", lastOnline: "сейчас в сети", toxId: "W2rFp8kDt4ZxN6vBh9CmJ1qL0sYeG3aUi" },
  { id: "anna", initial: "А", name: "Анна", preview: "Печатайте, я читаю", time: "15:13", color: "purple", status: "online", lastOnline: "сейчас в сети", toxId: "E6cXm2sPa9LfR4wVn7HdK0bJ5qTzY1uGo" },
  { id: "denis", initial: "Д", name: "Денис", preview: "Файл готов к загрузке", time: "14:36", color: "green", status: "online", lastOnline: "сейчас в сети", toxId: "M3qLz7pAe0RuB8wXh4NtF1cK6sYdV2jGo" },
  { id: "kate", initial: "К", name: "Катя", preview: "Вернусь через час", time: "13:05", color: "pink", status: "busy", lastOnline: "сегодня, 13:05", toxId: "H8vDc1aQm5ZrT9xLs2PeK6nJ0wFyB4uGo" },
  { id: "max", initial: "М", name: "Максим", preview: "Занят на встрече", time: "12:40", color: "blue", status: "busy", lastOnline: "сегодня, 12:40", toxId: "R5sNy9kQd1AeL7vXc3JmT8pF0wZuB6hGo" },
  { id: "lena", initial: "Л", name: "Лена", preview: "Позже отвечу", time: "11:19", color: "purple", status: "busy", lastOnline: "сегодня, 11:19", toxId: "B1wFp6rDt9KxM4vQh7NcL0aJ3sYeT8uGo" },
  { id: "ivan", initial: "И", name: "Иван", preview: "В сети через Tor", time: "15:52", color: "purple", status: "offline", lastOnline: "сегодня, 15:52", toxId: "A1xZ9qL6rF3pT7wV2nM8dK4sB0cH5yEJg" },
  { id: "pavel", initial: "П", name: "Павел", preview: "Последнее сообщение вчера", time: "Вчера", color: "green", status: "offline", lastOnline: "вчера, 22:14", toxId: "T4mZq1cLp8VxH5rNs0AeK7dJ3wFuB9yGo" },
  { id: "vera", initial: "В", name: "Вера", preview: "Спасибо!", time: "Вчера", color: "pink", status: "offline", lastOnline: "вчера, 19:31", toxId: "Y9uHd3sQm6AeR1vXk4NtL8pJ0wZcF5bGo" },
  { id: "roman", initial: "Р", name: "Роман", preview: "Сообщение удалено", time: "Пн", color: "blue", status: "offline", lastOnline: "понедельник, 09:47", toxId: "C6rFp0kDt8ZxN2vBh5JmL9qA1sYeW4uGo" },
  { id: "mila", initial: "М", name: "Мила", preview: "В сети через Tor", time: "Пн", color: "purple", status: "offline", lastOnline: "понедельник, 08:12", toxId: "N2qLz8pAe4RuB1wXh6MtF9cK0sYdV3jGo" },
];
*/

type Attachment = {
  name: string; size: number; type: string; path?: string; url?: string;
  image?: boolean;
  transferred?: number; speed?: number; eta?: number | null;
  transferState?: "uploading" | "queued" | "sending" | "awaiting_confirmation" | "receiving" | "paused" | "cancelled" | "failed" | "complete";
  completed?: boolean; completedAt?: number | null; error?: string | null; retryCount?: number;
};

type PqHistoryEvent = { kind: "pq"; status: "offered" | "incoming_offer" | "accepting" | "active" | "rejected" | "withdrawn" | "superseded" | "close_pending" | "closed" | "error"; role: "initiator" | "responder"; local_fingerprint: string; peer_fingerprint?: string | null; fingerprint_changed?: boolean; error?: string | null };
type Message = { id: number; coreId?: string; text: string; mine?: boolean; timestamp: number; time: string; attachment?: Attachment; delivery?: "queued" | "pending" | "awaiting_receipt" | "delivered" | "sent" | "unknown_recovered" | "unknown" | "failed"; deliveredAt?: number | null; event?: PqHistoryEvent | null; protocolVersion?: number; quote?: ChatQuote; formatting?: readonly ChatFormattingSpan[]; reactions?: ChatMessageReactions; pqProtected?: boolean };
type UserStatus = "online" | "away" | "busy" | "offline";

function PresenceDot({ status, className = "" }: { status: UserStatus; className?: string }) {
  if (status === "offline") return null;
  return <span className={`status-dot ${status}${className ? ` ${className}` : ""}`} aria-hidden="true" />;
}

function ActivitySortIcon({ direction }: { direction: ContactSortDirection }) {
  return <svg className={`contact-list-control-icon ${direction === "reverse" ? "reverse" : ""}`} viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="8.5" cy="12" r="5.5" />
    <path d="M8.5 8.8v3.5l2.3 1.4" />
    <path className="contact-sort-arrow" d="M18.5 5v14m-2.7-2.7 2.7 2.7 2.7-2.7" />
  </svg>;
}

function StatusSortIcon({ direction }: { direction: ContactSortDirection }) {
  return <svg className={`contact-list-control-icon ${direction === "reverse" ? "reverse" : ""}`} viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="5" cy="7" r="1.4" />
    <circle cx="5" cy="12" r="1.4" />
    <circle cx="5" cy="17" r="1.4" />
    <path d="M8.5 7h5M8.5 12h5M8.5 17h5" />
    <path className="contact-sort-arrow" d="M19 5v14m-2.7-2.7L19 19l2.7-2.7" />
  </svg>;
}

function OfflineVisibilityIcon({ hidden }: { hidden: boolean }) {
  return <svg className={`contact-list-control-icon ${hidden ? "offline-hidden" : ""}`} viewBox="0 0 24 24" aria-hidden="true">
    <path d="M2.5 12s3.4-5 9.5-5 9.5 5 9.5 5-3.4 5-9.5 5-9.5-5-9.5-5Z" />
    <circle cx="12" cy="12" r="2.4" />
    <path className="contact-offline-slash" d="M4 4l16 16" />
  </svg>;
}

type NetworkStatus = "connecting-tor" | "connecting" | "online" | "offline";
type CoreFriend = { number: number; public_key: string; tox_id: string; authorized: boolean; connection: "online" | "offline"; name: string; status: UserStatus; status_message: string; avatar_path?: string | null; last_online?: number | null; last_event?: number | null; lastEventSequence?: number; addedAt?: number };
type IncomingFriendRequest = { public_key: string; message: string };
type OutgoingFriendRequest = { toxId: string; message: string };
type CoreMessage = { id?: string; friend_number: number; text: string; mine: boolean; timestamp: number; delivery?: Message["delivery"]; delivered_at?: number | null; attachment?: { name: string; size: number; mime: string; path: string; preview_source?: string; image: boolean; transferred?: number; speed_bytes_per_sec?: number; eta_seconds?: number | null; transfer_state?: "queued" | "sending" | "awaiting_confirmation" | "receiving" | "paused" | "cancelled" | "failed" | "complete"; completed?: boolean; completed_at?: number | null; transfer_error?: string | null; retry_count?: number } | null; event?: PqHistoryEvent | null; protocol_version?: Message["protocolVersion"]; quote?: ChatQuote; formatting?: readonly ChatFormattingSpan[]; reactions?: ChatMessageReactions; pq_protected?: boolean };
type NativeFileSelection = { grantToken: string; name: string; mime: string; size: number };
type NativeFileBatchSelection = {
  accepted: NativeFileSelection[];
  rejected: Array<{ file: { name: string; size: number }; reason: "empty" | "too_large" | "unreadable" }>;
  selectedCount: number;
  tooMany: boolean;
};
type NativeFileDropBatch = {
  profileId: string;
  friendNumber: number;
  batch: NativeFileBatchSelection;
};
type ChatFileTarget = { profileId: string; friendNumber: number; chatId: string };
type PendingChatFile = ChatFileTarget & { file: File; grantToken: string | null; size: number };
const sameChatFileTarget = (left: ChatFileTarget | null, right: ChatFileTarget) => left !== null
  && left.profileId === right.profileId
  && left.friendNumber === right.friendNumber
  && left.chatId === right.chatId;
type CoreMessagesSnapshot = { revision: number; messages?: CoreMessage[] | null; windowStart: number; total: number; hasMoreBefore: boolean; hasMoreAfter: boolean; targetIndex?: number; reactionEligibleIds?: string[]; peerReactionEvents?: PeerReactionEvent[]; peerReactionLatestRevision?: number; latestMessageId?: string; firstUnseenMessageId?: string; unseenMessageIds?: string[] };
type CoreSearchPage = { matches: Array<{ messageId: string; index: number; field: "text" | "attachment"; start: number; end: number; snippet?: string }>; nextCursor?: string | null; totalMatches?: number };
type PqStatus = { supported: boolean; state: "unavailable" | "available" | "offered" | "incoming_offer" | "accepting" | "active" | "closing" | "closing_commit" | "closing_ack" | "closing_final" | "error"; local_fingerprint: string; peer_fingerprint?: string | null; fingerprint_changed: boolean; identity_needs_entropy: boolean; identity_waiting: boolean; auto_pending: boolean; protocol_version: number; error?: string | null };
const PQ_PROTECTED_STATES = new Set<PqStatus["state"]>(["active", "closing", "closing_commit", "closing_ack", "closing_final"]);
const isPqTransportProtected = (status?: PqStatus) => !!status && PQ_PROTECTED_STATES.has(status.state);
const PQ_ERROR_TEXT: Readonly<Record<string, string>> = {
  PQ_AUTO_ALREADY_NEGOTIATING: "Согласование PQ уже выполняется. Сообщение сохранено и будет отправлено после завершения.",
  PQ_CONTACT_IDENTITY_CHANGED: "PQ-идентичность контакта изменилась. Сверьте отпечаток перед продолжением.",
  PQ_OUTBOX_BACKPRESSURE: "Очередь защищённых сообщений временно заполнена. Сообщение сохранено локально и будет повторно отправлено.",
  PQ_SESSION_WAIT: "Сообщение сохранено и ждёт завершения согласования защищённой сессии.",
  PQ_PEER_CANCELLED_MESSAGES_WAIT_FOR_MANUAL_PQ: "Клиент собеседника остановил согласование PQ. Сообщения ожидают: включите PQ в меню чата или продолжите без него.",
  PQ_NEGOTIATION_CANCELLED_MESSAGES_WAIT_FOR_MANUAL_PQ: "Согласование PQ остановлено. Сообщения ожидают: включите PQ в меню чата или продолжите без него.",
};

function pqErrorCode(error: unknown): string {
  if (typeof error === "string") return error.trim();
  if (error instanceof Error) return error.message.trim();
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code.trim();
  return "";
}

function formatPqUserFacingError(error: unknown, fallback: { ru: string; en: string }, language: Language): string {
  const known = PQ_ERROR_TEXT[pqErrorCode(error)];
  return known ? translateText(known, language) : formatUserFacingError(error, fallback, language);
}
type AppEventNotice = { id: number; title: string; body: string; friendNumber?: number; friendPublicKey?: string; requests?: boolean };
type UnreadState = { friends: Record<string, number>; requests: string[]; pendingPeerReactionRevisionByTarget?: Record<string, number> };
type DeferredIncomingScroll = {
  chatId: string;
  messageKey: string;
  boundaryMessageKey: string;
  renderAttempts: number;
  settleUntil: number;
  userScrolled: boolean;
};
type DeferredOutgoingScroll = { chatId: string; messageKey: string };
type IncomingReadingState = { chatId: string; anchorMessageKey: string; boundaryMessageKey: string; userScrolled: boolean };
type AutoScrollIntent = { chatId: string; messageKey: string; boundaryMessageKey: string; intent: "incoming" | "outgoing" };
type MessageSearchMatch = { messageKey: string; field: "text" | "attachment"; start: number; end: number };
type AttachmentContext = { x: number; y: number; kind: "copy" | "image" | "file"; path?: string; previewPath?: string; showInFolder?: boolean; messageKey?: string; copyValue?: string; linkUrl?: string };
type SendResult = { messageId: string; delivery: Message["delivery"]; recovered?: boolean };
type PendingSend = { operationId: string; profileId: string; friendNumber: number; chatId: string; text: string; formatting?: readonly ChatFormattingSpan[]; quote?: ChatQuote };
type ChatCapabilities = { reactions: boolean; formatting: boolean; quotes: boolean; protocolVersion?: number };
type LocalState = Partial<{
  activeChat: string;
  sendOnEnter: boolean;
  contactNames: Record<string, string>;
  autoDownloadImages: boolean;
  saveChatHistory: boolean;
  outgoingFriendRequests: OutgoingFriendRequest[];
  drafts: Record<string, string>;
  draftFormatting: Record<string, readonly ChatFormattingSpan[]>;
  draftQuotes: Record<string, ChatQuote>;
  pendingSendOperations: Record<string, PendingSend>;
  scrollAnchors: Record<string, ChatViewAnchor>;
  peerReactionNotices: ReactionNoticeStore;
  historyMessageLimit: HistoryMessageLimit;
  notifyMessages: boolean;
  notifyRequests: boolean;
  spellcheckEnabled: boolean;
  spellcheckRussian: boolean;
  spellcheckEnglish: boolean;
}>;

type LayoutState = {
  appearance: AppearanceSettings;
  chatListWidth: number;
  profileOrder: string[];
  contactSort: ContactSortState;
  hideOfflineContacts: boolean;
};

function DownloadIcon({ className }: { className?: string }) {
  return <svg className={className} viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v11m0 0 4-4m-4 4-4-4M5 17v3h14v-3" /></svg>;
}

// Remote Tox values are always rendered as React text nodes. Removing only
// non-printing control characters keeps the original text readable while
// preventing invisible control payloads from leaking into labels or exports.
function plainText(value: string): string {
  return value.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "");
}

async function copyDecodedImage(path: string) {
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") throw new Error("Clipboard image API is unavailable");
  const response = await fetch(convertFileSrc(path));
  if (!response.ok) throw new Error(`Could not read image (${response.status})`);
  const bitmap = await createImageBitmap(await response.blob());
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not create image canvas");
    context.drawImage(bitmap, 0, 0);
    const png = await new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Could not encode image")), "image/png"));
    await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
  } finally {
    bitmap.close();
  }
}

function chatImageSource(path: string, profileId: string, friendNumber: number | undefined) {
  return path.startsWith("browser-stream://")
    ? friendNumber === undefined ? "" : transferPreviewSource(path, profileId, friendNumber)
    : convertFileSrc(path);
}

// MessengerApp is intentionally remounted when the active profile changes.
// Keep successful local image loads outside that component so returning to an
// already viewed profile does not briefly replace its avatars with initials.
const loadedAvatarSources = new Set<string>();
const MAX_CACHED_AVATAR_SOURCES = 512;

function rememberLoadedAvatar(source: string) {
  loadedAvatarSources.delete(source);
  loadedAvatarSources.add(source);
  if (loadedAvatarSources.size <= MAX_CACHED_AVATAR_SOURCES) return;
  const oldest = loadedAvatarSources.values().next().value;
  if (oldest) loadedAvatarSources.delete(oldest);
}

function AvatarImage({ path, initial }: { path?: string | null; initial: string }) {
  const source = path ? convertFileSrc(path) : "";
  const [imageState, setImageState] = useState(() => ({
    source,
    loaded: Boolean(source && loadedAvatarSources.has(source)),
    failed: false,
  }));
  const currentState = imageState.source === source
    ? imageState
    : { source, loaded: Boolean(source && loadedAvatarSources.has(source)), failed: false };
  if (!source || currentState.failed) return <span className="avatar-initial">{initial}</span>;
  return <>{!currentState.loaded && <span className="avatar-initial">{initial}</span>}<img
    key={source}
    className={currentState.loaded ? "avatar-image-ready" : "avatar-image-loading"}
    src={source}
    alt=""
    onLoad={() => {
      rememberLoadedAvatar(source);
      setImageState({ source, loaded: true, failed: false });
    }}
    onError={() => {
      loadedAvatarSources.delete(source);
      setImageState({ source, loaded: false, failed: true });
    }}
  /></>;
}

function formatLastOnline(timestamp: number | null | undefined, language: "ru" | "en"): string {
  if (!timestamp) return "данных нет";
  const date = new Date(timestamp * 1000);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const day = sameDay ? (language === "en" ? "today" : "сегодня") : date.toDateString() === yesterday.toDateString()
    ? (language === "en" ? "yesterday" : "вчера")
    : formatChatDate(date, language, date.getFullYear() === today.getFullYear() ? "shortDay" : "shortFullYear");
  return `${day}, ${formatChatDate(date, language, "time")}`;
}

function formatMessageDay(timestamp: number, language: "ru" | "en"): string {
  const date = new Date(timestamp * 1000);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return language === "en" ? "Today" : "Сегодня";
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return language === "en" ? "Yesterday" : "Вчера";
  return formatChatDate(date, language, date.getFullYear() === today.getFullYear() ? "day" : "dayYear");
}

const emptyChat: Chat = { id: "", initial: "", name: "Выберите контакт", preview: "", time: "", color: "blue", status: "offline", lastOnline: "", toxId: "" };

function sameData(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameMessages(left: Message[], right: Message[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((message, index) => {
    const other = right[index];
    if (!other) return false;
    const event = message.event;
    const otherEvent = other.event;
    const sameEvent = event === otherEvent || (!!event && !!otherEvent
      && event.kind === otherEvent.kind
      && event.status === otherEvent.status
      && event.role === otherEvent.role
      && event.local_fingerprint === otherEvent.local_fingerprint
      && event.peer_fingerprint === otherEvent.peer_fingerprint
      && event.fingerprint_changed === otherEvent.fingerprint_changed
      && event.error === otherEvent.error);
    const attachment = message.attachment;
    const otherAttachment = other.attachment;
    const sameAttachment = attachment === otherAttachment || (!!attachment && !!otherAttachment
      && attachment.name === otherAttachment.name
      && attachment.size === otherAttachment.size
      && attachment.type === otherAttachment.type
      && attachment.path === otherAttachment.path
      && attachment.url === otherAttachment.url
      && attachment.image === otherAttachment.image
      && attachment.transferred === otherAttachment.transferred
      && attachment.speed === otherAttachment.speed
      && attachment.eta === otherAttachment.eta
      && attachment.transferState === otherAttachment.transferState
      && attachment.completed === otherAttachment.completed
      && attachment.completedAt === otherAttachment.completedAt
      && attachment.error === otherAttachment.error
      && attachment.retryCount === otherAttachment.retryCount);
    return message.id === other.id
      && message.coreId === other.coreId
      && message.text === other.text
      && message.mine === other.mine
      && message.timestamp === other.timestamp
      && message.time === other.time
      && message.delivery === other.delivery
      && message.deliveredAt === other.deliveredAt
      && message.protocolVersion === other.protocolVersion
      && message.pqProtected === other.pqProtected
      && sameData(message.quote, other.quote)
      && sameData(message.formatting, other.formatting)
      && sameData(message.reactions, other.reactions)
      && sameEvent
      && sameAttachment;
  });
}

function formatContactEvent(timestamp: number | null | undefined, language: "ru" | "en"): string {
  if (!timestamp) return "";
  const date = new Date(timestamp * 1000);
  const today = new Date();
  const locale = language === "en" ? "en-US" : "ru-RU";
  if (date.toDateString() === today.toDateString()) return new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(date);
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return language === "en" ? "Yesterday" : "Вчера";
  return new Intl.DateTimeFormat(locale, { day: "2-digit", month: "2-digit", year: date.getFullYear() === today.getFullYear() ? undefined : "2-digit" }).format(date);
}

const initialMessages: Message[] = [];
/*
  { id: 1, text: "Привет! Проверим новый режим защиты?", time: "21:41" },
  { id: 2, text: "Да, я уже подтвердил отпечаток.", mine: true, time: "21:42" },
  { id: 3, text: "Отлично. У меня всё тоже включилось.", time: "21:43" },
  { id: 4, text: "Проверил: статус контакта стал зелёным, а уведомление пришло без задержки.", mine: true, time: "21:44" },
  { id: 5, text: "Хорошо. Я вижу подтверждённый отпечаток и активный постквантовый слой.", time: "21:45" },
  { id: 6, text: "Я добавлю тестовый файл и посмотрю, как он передаётся через Tor.", mine: true, time: "21:46" },
  { id: 7, text: "Давай. Важно, чтобы при ошибке Tor прямое подключение не включалось.", time: "21:47" },
  { id: 8, text: "Kill switch включён. Прокси вручную не задавал — используется локальный Tor SOCKS5.", mine: true, time: "21:48" },
  { id: 9, text: "Отлично. Потом проверим режим с WebTunnel-мостом.", time: "21:49" },
  { id: 10, text: "Сначала протестируем обычное соединение без мостов и сохраним результат.", mine: true, time: "21:50" },
  { id: 11, text: "Согласен. Интерфейс уже выглядит заметно понятнее.", time: "21:51" },
  { id: 12, text: "Спасибо. Следующим шагом займёмся настоящей интеграцией toxcore.", mine: true, time: "21:52" },
];
*/

function isTerminalTransferState(transferState: Attachment["transferState"]) {
  return transferState === "complete" || transferState === "cancelled" || transferState === "failed";
}

function effectiveTransferState(
  transferState: Attachment["transferState"],
  uiOverride?: Attachment["transferState"],
): Attachment["transferState"] {
  // Terminal states always win. For all intermediate updates retain a
  // locally requested pause until the user explicitly resumes it.
  if (isTerminalTransferState(transferState)) {
    return transferState;
  }

  // React keeps this value in component state. It is the source of truth for
  // the control until the user explicitly changes it or Tox reports a terminal
  // result. Network progress events must not flip the button back.
  return uiOverride ?? transferState;
}

function ProfileSwitcher({ profiles, profileOrder, onProfileOrderChange, onSwitch, switching, onStatusChange }: {
  profiles: ProfileSummary[];
  profileOrder: string[];
  onProfileOrderChange: (order: string[]) => void;
  onSwitch: (id: string) => void;
  switching: boolean;
  onStatusChange: (profileId: string, status: UserStatus) => Promise<void>;
}) {
  const { language, t } = useI18n();
  const available = Array.from(new Map(profiles.filter((profile) => profile.loaded).map((profile) => [profile.id, profile])).values());
  const allProfileIds = Array.from(new Set(profiles.map((profile) => profile.id)));
  const availableIds = available.map((profile) => profile.id);
  const normalizedOrder = normalizeProfileOrder(profileOrder, availableIds);
  const availableById = new Map(available.map((profile) => [profile.id, profile]));
  const orderedAvailable = normalizedOrder.map((id) => availableById.get(id)).filter((profile): profile is ProfileSummary => Boolean(profile));
  const hostRef = useRef<HTMLDivElement>(null);
  const [hostWidth, setHostWidth] = useState(0);
  const [startIndex, setStartIndex] = useState(0);
  const [statusContext, setStatusContext] = useState<{ profileId: string; x: number; y: number } | null>(null);
  useLayoutEffect(() => registerContextMenuDismissal(() => setStatusContext(null)), []);
  const [statusBusy, setStatusBusy] = useState(false);
  const [statusError, setStatusError] = useState("");
  const activeId = orderedAvailable.find((profile) => profile.active)?.id ?? "";
  const fullWidth = orderedAvailable.length * 46;
  const carousel = hostWidth > 0 && fullWidth > hostWidth;
  const visibleCount = carousel
    ? Math.max(1, Math.min(orderedAvailable.length, Math.floor((hostWidth - 32) / 46)))
    : orderedAvailable.length;
  const effectiveStatus = (profile: ProfileSummary): UserStatus => profile.loaded ? profile.userStatus : "offline";

  useLayoutEffect(() => {
    if (!hostRef.current) return;
    const update = () => setHostWidth(hostRef.current?.clientWidth ?? 0);
    const observer = new ResizeObserver(update);
    observer.observe(hostRef.current);
    update();
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const activeIndex = orderedAvailable.findIndex((profile) => profile.id === activeId);
    if (activeIndex >= 0) setStartIndex(activeIndex);
  }, [activeId, profileOrder, visibleCount]);

  useEffect(() => {
    if (!statusContext) return;
    const close = () => setStatusContext(null);
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (hostRef.current?.contains(event.target as Node)) return;
      close();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("click", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("click", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
    };
  }, [statusContext]);

  const [draggedProfileId, setDraggedProfileId] = useState<string | null>(null);
  const [profileDropHint, setProfileDropHint] = useState<{ profileId: string; edge: "before" | "after" } | null>(null);
  const suppressProfileClickRef = useRef(false);

  if (orderedAvailable.length < 2) return null;
  const visible = carousel
    ? Array.from({ length: visibleCount }, (_, offset) => orderedAvailable[(startIndex + offset) % orderedAvailable.length])
    : orderedAvailable;
  const move = (direction: number) => setStartIndex((current) => (current + direction + orderedAvailable.length) % orderedAvailable.length);
  const contextProfile = statusContext ? orderedAvailable.find((profile) => profile.id === statusContext.profileId) : undefined;
  const contextStatus = contextProfile ? effectiveStatus(contextProfile) : "offline";
  const statusOptions: Array<{ value: UserStatus; label: string }> = [
    { value: "online", label: t("Онлайн") },
    { value: "away", label: t("Отошёл") },
    { value: "busy", label: t("Занят") },
    { value: "offline", label: t("Отключен") },
  ];
  const changeProfileStatus = async (profileId: string, status: UserStatus) => {
    if (statusBusy) return;
    setStatusBusy(true);
    setStatusError("");
    try {
      await onStatusChange(profileId, status);
      setStatusContext(null);
    } catch (error) {
      setStatusError(formatUserFacingError(error, {
        ru: "Не удалось изменить статус профиля",
        en: "Could not change the profile status",
      }, language));
    } finally {
      setStatusBusy(false);
    }
  };
  const openProfileStatus = (profileId: string, x: number, y: number) => {
    dismissContextMenus();
    const menuWidth = 190;
    const menuHeight = 210;
    const margin = 8;
    setStatusError("");
    setStatusContext({
      profileId,
      x: Math.max(margin, Math.min(x, window.innerWidth - menuWidth - margin)),
      y: Math.max(margin, Math.min(y, window.innerHeight - menuHeight - margin)),
    });
  };
  const beginProfileDrag = (event: React.DragEvent<HTMLButtonElement>, profileId: string) => {
    if (switching) {
      event.preventDefault();
      return;
    }
    suppressProfileClickRef.current = true;
    setStatusContext(null);
    setDraggedProfileId(profileId);
    setProfileDropHint(null);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", profileId);
  };
  const updateProfileDropHint = (event: React.DragEvent<HTMLButtonElement>, targetProfileId: string) => {
    const sourceProfileId = draggedProfileId || event.dataTransfer.getData("text/plain");
    if (!sourceProfileId || sourceProfileId === targetProfileId || !orderedAvailable.some((profile) => profile.id === sourceProfileId)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    const bounds = event.currentTarget.getBoundingClientRect();
    const edge = event.clientX < bounds.left + bounds.width / 2 ? "before" : "after";
    setProfileDropHint((current) => current?.profileId === targetProfileId && current.edge === edge ? current : { profileId: targetProfileId, edge });
  };
  const completeProfileDrop = (event: React.DragEvent<HTMLButtonElement>, targetProfileId: string) => {
    event.preventDefault();
    event.stopPropagation();
    const sourceProfileId = draggedProfileId || event.dataTransfer.getData("text/plain");
    if (sourceProfileId && sourceProfileId !== targetProfileId && orderedAvailable.some((profile) => profile.id === sourceProfileId)) {
      const bounds = event.currentTarget.getBoundingClientRect();
      const edge = event.clientX < bounds.left + bounds.width / 2 ? "before" : "after";
      onProfileOrderChange(moveProfileOrder(profileOrder, allProfileIds, sourceProfileId, targetProfileId, edge));
    }
    setDraggedProfileId(null);
    setProfileDropHint(null);
  };
  const finishProfileDrag = () => {
    setDraggedProfileId(null);
    setProfileDropHint(null);
    window.setTimeout(() => { suppressProfileClickRef.current = false; }, 0);
  };

  return <div ref={hostRef} className={`profile-switcher ${carousel ? "carousel" : ""}`} aria-label="Доступные профили">
    {carousel && <button type="button" className="profile-carousel-arrow previous" onClick={() => move(-1)} title="Предыдущие профили" aria-label="Показать предыдущие профили">‹</button>}
    <div className="profile-switcher-track">
      {visible.map((profile) => {
        const avatarStatus = effectiveStatus(profile);
        const menuOpen = statusContext?.profileId === profile.id;
        return <button type="button" key={profile.id} disabled={switching} draggable={!switching} data-profile-id={profile.id} className={`profile-switcher-item status-${avatarStatus} ${profile.active ? "active" : ""} ${draggedProfileId === profile.id ? "dragging" : ""} ${profileDropHint?.profileId === profile.id ? `drop-${profileDropHint.edge}` : ""}`} data-i18n-ignore translate="no" onDragStart={(event) => beginProfileDrag(event, profile.id)} onDragOver={(event) => updateProfileDropHint(event, profile.id)} onDrop={(event) => completeProfileDrop(event, profile.id)} onDragLeave={(event) => {
          const nextTarget = event.relatedTarget;
          if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) setProfileDropHint((current) => current?.profileId === profile.id ? null : current);
        }} onDragEnd={finishProfileDrag} onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (switching) {
            setStatusContext(null);
            return;
          }
          openProfileStatus(profile.id, event.clientX + 6, event.clientY + 6);
        }} onKeyDown={(event) => {
          if (!switching && (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) {
            event.preventDefault();
            event.stopPropagation();
            const bounds = event.currentTarget.getBoundingClientRect();
            openProfileStatus(profile.id, bounds.right + 6, bounds.top);
            return;
          }
          if (!switching && event.altKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
            const currentIndex = orderedAvailable.findIndex((candidate) => candidate.id === profile.id);
            const direction = event.key === "ArrowLeft" ? -1 : 1;
            const target = orderedAvailable[currentIndex + direction];
            if (target) {
              event.preventDefault();
              onProfileOrderChange(moveProfileOrder(profileOrder, allProfileIds, profile.id, target.id, direction < 0 ? "before" : "after"));
            }
          }
        }} onClick={() => {
          if (suppressProfileClickRef.current) return;
          setStatusContext(null);
          if (!profile.active && !switching) onSwitch(profile.id);
        }} title={formatProfileSwitcherTitle(profile.name, avatarStatus, language)} aria-label={formatProfileSwitcherAria(profile.name, language)} aria-haspopup="menu" aria-expanded={menuOpen}>
          <ProfileAvatar src={profile.avatar} initial={profile.name.charAt(0).toUpperCase()} state={avatarStatus} className="profile-switcher-avatar" />
          {profile.unread > 0 && <b>{profile.unread > 99 ? "99+" : profile.unread}</b>}
        </button>;
      })}
    </div>
    {carousel && <button type="button" className="profile-carousel-arrow next" onClick={() => move(1)} title="Следующие профили" aria-label="Показать следующие профили">›</button>}
    {statusContext && contextProfile && createPortal(<div className="inactive-profile-status-menu" role="menu" aria-label={language === "ru" ? `Статус профиля ${contextProfile.name}` : `Status for profile ${contextProfile.name}`} data-i18n-ignore translate="no" style={{ left: statusContext.x, top: statusContext.y }} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()} onContextMenu={(event) => event.preventDefault()}>
      {statusOptions.map((option) => {
        const selected = contextStatus === option.value;
        return <button type="button" key={option.value} disabled={statusBusy} className={`inactive-profile-status-option status-${option.value}-option ${selected ? "selected" : ""}`} role="menuitemradio" aria-checked={selected} onClick={(event) => {
          event.stopPropagation();
          void changeProfileStatus(contextProfile.id, option.value);
        }}>
          <PresenceDot status={option.value} />
          <span>{option.label}</span>
          <span className="inactive-profile-status-check" aria-hidden="true">{statusBusy && selected ? "…" : selected ? "✓" : ""}</span>
        </button>;
      })}
      {statusError && <p className="inactive-profile-status-error" role="alert">{statusError}</p>}
    </div>, document.body)}
  </div>;
}

function PqHistoryCard({ event, mine, time, messageKey, contactName, onAccept, onReject, onWithdraw }: {
  event: PqHistoryEvent;
  mine: boolean;
  time: string;
  messageKey: string;
  contactName: string;
  onAccept: () => void;
  onReject: () => void;
  onWithdraw: () => void;
}) {
  const { language, t } = useI18n();
  const title = formatPqTitle(event.status, event.role, language);
  const description = formatPqDescription(event.status, event.role, contactName, language);
  return <article data-message-key={messageKey} data-kaigen-ui-entity-key={opaqueUiEntityKey("chat-message", messageKey)} className={`pq-offer-message pq-history-message ${event.status} ${mine ? "mine" : ""}`}>
    <div className="pq-history-heading"><b data-i18n-ignore translate="no">{title}</b><time>{time}</time></div>
    <p data-i18n-ignore translate="no">{description}</p>
    <div className="pq-history-fingerprints">
      <label>{t("Ваш отпечаток")}<code>{event.local_fingerprint || "—"}</code></label>
      <label>{t("Отпечаток контакта")}<code>{event.peer_fingerprint || "—"}</code></label>
    </div>
    {event.fingerprint_changed && <em>{t("Отпечаток контакта изменился. Сверьте его по независимому каналу.")}</em>}
    {event.error && event.status === "error" && <em>{formatPqUserFacingError(event.error, { ru: "Не удалось завершить постквантовое согласование", en: "Post-quantum negotiation failed" }, language)}</em>}
    {(event.status === "offered" && mine) || (event.status === "incoming_offer" && !mine) ? <div className="pq-history-actions">
      {event.status === "offered" && mine && <button className="text-button" onClick={onWithdraw}>{t("Отозвать запрос")}</button>}
      {event.status === "incoming_offer" && !mine && <><button className="text-button" onClick={onReject}>{t("Отказаться")}</button><button className="pq-confirm-button" onClick={onAccept}>{t("Принять и продолжить")}</button></>}
    </div> : null}
  </article>;
}

function App({ profiles, onSwitchProfile, onProfileStatusChange, profileSwitching = false }: { profiles: ProfileSummary[]; onSwitchProfile: (id: string) => Promise<void>; onDisableProfile: (id: string) => Promise<void>; onDestroyActiveProfile: () => Promise<void>; onProfileStatusChange: (profileId: string, status: UserStatus) => Promise<void>; profileSwitching?: boolean }) {
  const { language, t } = useI18n();
  const { theme, setTheme } = useKaigenTheme();
  const activeProfileAtMount = profiles.find((profile) => profile.active && profile.loaded);
  const activeProfileId = activeProfileAtMount?.id ?? "";
  const layoutAtMount = useRef(readPortableLayoutSnapshot() as Partial<LayoutState> | null).current;
  const [layoutHydrated, setLayoutHydrated] = useState(() => isPortableLayoutHydrated());
  const [transferUiStateOverrides, setTransferUiStateOverrides] = useState<
    Record<string, NonNullable<Attachment["transferState"]>>
  >({});
  const [screen, setScreen] = useState<"chat" | "settings">(() => sessionStorage.getItem("kaigen-active-screen") === "settings" ? "settings" : "chat");
  const [appearance, setAppearance] = useState<AppearanceSettings>(() => normalizeAppearance(layoutAtMount?.appearance));
  const [activeChat, setActiveChat] = useState("");
  const draftsRef = useRef<Record<string, string>>({});
  const draftFormattingRef = useRef<Record<string, readonly ChatFormattingSpan[]>>({});
  const draftQuotesRef = useRef<Record<string, ChatQuote>>({});
  const [replyQuote, setReplyQuote] = useState<ChatQuote | null>(null);
  const [chatCapabilities, setChatCapabilities] = useState<ChatCapabilities>({ reactions: false, formatting: false, quotes: false });
  const [failedSends, setFailedSends] = useState<PendingSend[]>([]);
  const pendingSendOperationsRef = useRef<Record<string, PendingSend>>({});
  const [pendingSentMessage, setPendingSentMessage] = useState<string | null>(null);
  const [reactionNotices, setReactionNotices] = useState<ReactionNotice[]>([]);
  const reactionNoticeStoreRef = useRef<ReactionNoticeStore>({});
  const reactionNoticeDurableCursorRef = useRef<Record<string, number>>({});
  const reactionNoticeSaveRef = useRef<Promise<void> | null>(null);
  const [reactionErrors, setReactionErrors] = useState<Record<string, string>>({});
  const pendingReactionIdsRef = useRef(new Set<string>());
  const draftCommitTimer = useRef<number | undefined>(undefined);
  const draftMaxCommitTimer = useRef<number | undefined>(undefined);
  const [sendOnEnter, setSendOnEnter] = useState(true);
  const [historyMessageLimit, setHistoryMessageLimit] = useState<HistoryMessageLimit>(500);
  const [loadedHistoryLimit, setLoadedHistoryLimit] = useState<HistoryMessageLimit>(500);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState(false);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [historyHasAfter, setHistoryHasAfter] = useState(false);
  const [historyWindowStart, setHistoryWindowStart] = useState(0);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyRequest, setHistoryRequest] = useState<{ rangeOffset?: number; targetMessageId?: string }>({});
  const [reactionEligibleIds, setReactionEligibleIds] = useState<string[]>([]);
  const latestHistoryMessageIdRef = useRef<string | undefined>(undefined);
  const historyCacheRangesRef = useRef(new Map<string, { start: number; total: number }>());
  const historySnapshotAtTailRef = useRef(true);
  const pendingHistoryIndexRef = useRef<number | null>(null);
  const [windowAnchorKey, setWindowAnchorKey] = useState<string | null>(null);
  const measuredMessageHeightsRef = useRef(new Map<string, number>());
  const [heightMeasurementRevision, setHeightMeasurementRevision] = useState(0);
  const [localPersistenceError, setLocalPersistenceError] = useState(false);
  const [messages, setMessages] = useState(initialMessages);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const [pendingIncomingCount, setPendingIncomingCount] = useState(0);
  const [messageVisibilityRevision, setMessageVisibilityRevision] = useState(0);
  const [messageRefreshRequest, setMessageRefreshRequest] = useState(0);
  const [userStatus, setUserStatus] = useState<UserStatus>(() => activeProfileAtMount?.userStatus ?? "online");
  const [networkStatus, setNetworkStatus] = useState<NetworkStatus>(() => {
    if (activeProfileAtMount?.connection === "tcp" || activeProfileAtMount?.connection === "udp") return "online";
    return activeProfileAtMount?.userStatus === "offline" ? "offline" : "connecting";
  });
  const [coreFriends, setCoreFriends] = useState<CoreFriend[]>([]);
  const [incomingFriendRequests, setIncomingFriendRequests] = useState<IncomingFriendRequest[]>([]);
  const [outgoingFriendRequests, setOutgoingFriendRequests] = useState<OutgoingFriendRequest[]>([]);
  const [unreadFriendCounts, setUnreadFriendCounts] = useState<Record<string, number>>({});
  const [unreadIncomingRequestKeys, setUnreadIncomingRequestKeys] = useState<string[]>([]);
  const [statusMenuOpen, setStatusMenuOpen] = useState(false);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [profileAvatar, setProfileAvatar] = useState<string | null>(() => activeProfileAtMount?.avatar ?? null);
  const [profileName, setProfileName] = useState(() => activeProfileAtMount?.name ?? "Tox User");
  const [messageSearchOpen, setMessageSearchOpen] = useState(false);
  const [messageSearch, setMessageSearch] = useState("");
  const [messageSearchMatches, setMessageSearchMatches] = useState<MessageSearchMatch[]>([]);
  const [messageSearchIndex, setMessageSearchIndex] = useState(-1);
  const [messageSearchBusy, setMessageSearchBusy] = useState(false);
  const searchSelectionRef = useRef<MessageSearchMatch | undefined>(undefined);
  const searchQueryRef = useRef("");
  const [searchPage, setSearchPage] = useState<{ cursor?: string; offset: number; selectLast?: boolean }>({ offset: 0 });
  const searchPreviousPagesRef = useRef<Array<{ cursor?: string; offset: number }>>([]);
  const searchRecoveryTargetRef = useRef<MessageSearchMatch | undefined>(undefined);
  const searchSeekOffsetRef = useRef<number | undefined>(undefined);
  const searchRecoveryAttemptsRef = useRef(0);
  const searchExhaustedCursorRef = useRef<{ cursor: string; total: number } | undefined>(undefined);
  const [searchNextCursor, setSearchNextCursor] = useState<string | undefined>(undefined);
  const [searchError, setSearchError] = useState(false);
  const searchJumpedTargetRef = useRef("");
  const [contactSearch, setContactSearch] = useState("");
  const [contactSort, setContactSort] = useState(() => normalizeContactSort(layoutAtMount?.contactSort ?? DEFAULT_CONTACT_SORT));
  const [hideOfflineContacts, setHideOfflineContacts] = useState(() => layoutAtMount?.hideOfflineContacts === true);
  const [activityHold, setActivityHold] = useState<ActivityHold>({ contactId: null, selectedId: "", events: {} });
  const [promotedActivityId, setPromotedActivityId] = useState<string | undefined>(undefined);
  const [contactMenuOpen, setContactMenuOpen] = useState(false);
  const [composerFocusRequest, setComposerFocusRequest] = useState(0);
  useLayoutEffect(() => registerContextMenuDismissal(() => {
    setStatusMenuOpen(false);
    setProfileMenuOpen(false);
    setContactMenuOpen(false);
    setContactContext(null);
    setGeneralContext(null);
  }), []);
  const [contactAction, setContactAction] = useState<"rename" | "delete" | null>(null);
  const [contactActionTarget, setContactActionTarget] = useState<Chat | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [contactContext, setContactContext] = useState<{ x: number; y: number; chat: Chat } | null>(null);
  const [generalContext, setGeneralContext] = useState<AttachmentContext | null>(null);
  const [eventNotices, setEventNotices] = useState<AppEventNotice[]>([]);
  const [contactNames, setContactNames] = useState<Record<string, string>>({});
  const [contactsScrollActive, setContactsScrollActive] = useState(false);
  const [messageScrollActive, setMessageScrollActive] = useState(false);
  const [chatListWidth, setChatListWidth] = useState(() => layoutAtMount?.chatListWidth ?? 360);
  const [profileOrder, setProfileOrder] = useState<string[]>(() => layoutAtMount?.profileOrder ?? []);
  const [isResizingList, setIsResizingList] = useState(false);
  const isResizingListRef = useRef(false);
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<PendingChatFile[]>([]);
  const [fileSendError, setFileSendError] = useState<string | null>(null);
  const [fileSendBusy, setFileSendBusy] = useState(false);
  const [profileSwitchPending, setProfileSwitchPending] = useState(false);
  const [transferErrors, setTransferErrors] = useState<Record<string, string>>({});
  const [fullImage, setFullImage] = useState<Attachment | null>(null);
  const [autoDownloadImages, setAutoDownloadImages] = useState(true);
  const [saveChatHistory, setSaveChatHistory] = useState(true);
  const [notifyMessages, setNotifyMessages] = useState<boolean>(DEFAULT_NOTIFICATION_SETTINGS.messages);
  const [notifyRequests, setNotifyRequests] = useState<boolean>(DEFAULT_NOTIFICATION_SETTINGS.requests);
  const [spellcheckEnabled, setSpellcheckEnabled] = useState(false);
  const [spellcheckRussian, setSpellcheckRussian] = useState(false);
  const [spellcheckEnglish, setSpellcheckEnglish] = useState(false);
  const [showReceivedImages, setShowReceivedImages] = useState(true);
  const [revealedImages, setRevealedImages] = useState<string[]>([]);
  const [ownToxId, setOwnToxId] = useState("");
  const [copyNotice, setCopyNotice] = useState(false);
  const [transferNotice, setTransferNotice] = useState<{ text: string; path?: string } | null>(null);
  const [ownStatusMessage, setOwnStatusMessage] = useState("");
  const [editingOwnStatusMessage, setEditingOwnStatusMessage] = useState(false);
  const [addContactOpen, setAddContactOpen] = useState(false);
  const [contactToxId, setContactToxId] = useState("");
  const [friendRequestMessage, setFriendRequestMessage] = useState(() => formatFriendRequestDefault(language));
  const friendRequestCustomized = useRef(false);
  const [addContactStatus, setAddContactStatus] = useState<string | null>(null);
  const [incomingRequestsOpen, setIncomingRequestsOpen] = useState(false);
  const [persistenceReady, setPersistenceReady] = useState(false);
  const [settingsOpenRequest, setSettingsOpenRequest] = useState<SettingsOpenRequest>({ tab: "profile", nonce: 0 });
  const sharedLayoutState = { appearance, chatListWidth, profileOrder, contactSort, hideOfflineContacts };
  if (layoutHydrated) retainPortableLayoutPatch(sharedLayoutState);
  const [pqStatuses, setPqStatuses] = useState<Record<number, PqStatus>>({});
  const pqStatusRequestsRef = useRef<Record<number, number>>({});
  const refreshPqStatus = useCallback(async (friendNumber: number) => {
    const revision = (pqStatusRequestsRef.current[friendNumber] ?? 0) + 1;
    pqStatusRequestsRef.current[friendNumber] = revision;
    const status = await invoke<PqStatus>("get_pq_status", { friendNumber });
    if (pqStatusRequestsRef.current[friendNumber] === revision) {
      setPqStatuses((current) => sameData(current[friendNumber], status) ? current : { ...current, [friendNumber]: status });
    }
    return status;
  }, []);
  const beginPqEntropy = useCallback(async (friendNumber: number) => {
    const remainingMs = await invoke<number>("begin_pq_entropy", { friendNumber });
    if (remainingMs < 3250) await refreshPqStatus(friendNumber);
    return remainingMs;
  }, [refreshPqStatus]);
  const completePqIdentity = useCallback(async (friendNumber: number, extraNoise: number[]) => {
    const status = await invoke<PqStatus>("complete_pq_identity", { friendNumber, extraNoise });
    setPqStatuses((current) => ({ ...current, [friendNumber]: status }));
    setMessageRefreshRequest((current) => current + 1);
  }, []);
  const skipPqAuto = useCallback(async (friendNumber: number) => {
    const status = await invoke<PqStatus>("skip_pq_auto", { friendNumber });
    setPqStatuses((current) => ({ ...current, [friendNumber]: status }));
    setMessageRefreshRequest((current) => current + 1);
  }, []);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const [torStatus, setTorStatus] = useState<TorStatus>(() => initialTorStatus());
  const [torDoneVisible, setTorDoneVisible] = useState(false);
  const previousTorStateRef = useRef<TorStatus["state"]>(torStatus.state);
  const notificationQueueRef = useRef(new ChatNotificationQueue());
  const notificationOwnerRef = useRef<string | null>(null);
  const [unreadSnapshotReady, setUnreadSnapshotReady] = useState(false);
  const notificationVisibleRef = useRef<(chatId: string, messageId?: string) => boolean>(() => false);
  const [proxySettings, setProxySettings] = useState<ProxySettings>(() => initialProxySettings());
  const torEnabled = torStatus.state === "connected";
  const customProxyActive = torStatus.state === "disabled" && proxySettings.mode !== "none";
  const torIndicatorText = formatTorIndicator(torStatus, proxySettings, language);
  const torStatusLine = customProxyActive
    ? ""
    : torStatus.state === "starting"
      ? "Initialization"
      : torStatus.state === "connecting"
        ? (torStatus.progress < 50 ? "Bootstrap" : "Connecting")
        : torStatus.state === "connected"
          ? (torDoneVisible ? "Done!" : t("Подключен"))
          : torStatus.state === "error"
            ? "Error"
            : torStatus.state === "disabled"
              ? t("Отключен")
              : "";
  const torStatusDotsRunning = torStatus.state === "starting" || torStatus.state === "connecting";
  const messageScrollRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<Message[]>(initialMessages);
  const messageSnapshotChatRef = useRef("");
  const historyRevisionRef = useRef<number | undefined>(undefined);
  const historyMutationRevisionRef = useRef(0);
  const historyFarFromLatestRef = useRef(false);
  const deferredIncomingScrollRef = useRef<DeferredIncomingScroll | null>(null);
  const deferredIncomingTimerRef = useRef<number | undefined>(undefined);
  const deferredOutgoingScrollRef = useRef<DeferredOutgoingScroll | null>(null);
  const userScrollActiveRef = useRef(false);
  const userScrollBlockedUntilRef = useRef(0);
  const userScrollUiUntilRef = useRef(0);
  const automaticScrollUntilRef = useRef(0);
  const scrollPointerIdRef = useRef<number | null>(null);
  const lastAutoScrollIntentRef = useRef<AutoScrollIntent | null>(null);
  const unseenIncomingKeysRef = useRef(new Set<string>());
  const locallySeenPendingRef = useRef(new Set<string>());
  const locallyAcknowledgedRef = useRef(new Set<string>());
  const localViewAckPendingRef = useRef<{ generation: number } | null>(null);
  const localViewAckRetryRef = useRef<number | undefined>(undefined);
  const dismissVisibleReactionsRef = useRef<() => void>(() => {});
  const unreadMutationRevisionRef = useRef(0);
  const readingLongIncomingRef = useRef<IncomingReadingState | null>(null);
  const trackedUnreadCountRef = useRef(0);
  const scrollAnchorsRef = useRef<Record<string, ChatViewAnchor>>({});
  const pendingPreserveAnchorRef = useRef<ChatViewAnchor | null>(null);
  const followLatestRef = useRef(true);
  const [returnAnchor, setReturnAnchor] = useState<ChatViewAnchor | null>(null);
  const returnAnchorRef = useRef(returnAnchor);
  returnAnchorRef.current = returnAnchor;
  const chatVisibilityRef = useRef({ activeId: activeChat, chatOpen: false, overlayOpen: false });
  chatVisibilityRef.current = {
    activeId: activeChat,
    chatOpen: screen === "chat",
    overlayOpen: !!fullImage || pendingFiles.length > 0 || !!contactAction || addContactOpen || incomingRequestsOpen,
  };
  const [unseenBoundary, setUnseenBoundary] = useState<string | null>(null);
  const pendingNavigationRef = useRef<{ messageKey: string; generation: number; deadline: number; anchor?: ChatViewAnchor } | null>(null);
  const pendingNavigationTimerRef = useRef<number | undefined>(undefined);
  const historyCacheRef = useRef(new ChatHistoryCache<Message>({ maxEntries: 3, maxCost: 2_000_000, cost: (message) => 128 + message.text.length + (message.quote?.text.length ?? 0) }));
  const viewOwnerRef = useRef({ key: "", generation: 0, leaseId: "" });
  const viewFramesRef = useRef(new Set<number>());
  const viewKey = `${activeProfileId}:${activeChat}:${screen}:${incomingRequestsOpen}:${addContactOpen}`;
  const displayedChatActiveRef = useRef(false);
  useLayoutEffect(() => {
    const generation = ++chatViewGeneration;
    viewOwnerRef.current = { key: viewKey, generation, leaseId: `${CHAT_VIEW_SESSION_ID}:${generation}` };
    displayedChatActiveRef.current = screen === "chat" && !incomingRequestsOpen && !addContactOpen;
  }, [viewKey]);
  function scheduleViewFrame(callback: FrameRequestCallback): number {
    const generation = viewOwnerRef.current.generation;
    const frame = globalThis.requestAnimationFrame((time) => {
      viewFramesRef.current.delete(frame);
      if (viewOwnerRef.current.generation === generation) callback(time);
    });
    viewFramesRef.current.add(frame);
    return frame;
  }
  const openedChats = useRef(new Set<string>());
  const pendingScrollRestore = useRef<string | null>(null);
  const [scrollRestoreTick, setScrollRestoreTick] = useState(0);
  const contactsScrollTimer = useRef<number | undefined>(undefined);
  const messageScrollTimer = useRef<number | undefined>(undefined);
  const searchRunRef = useRef(0);
  const seenIncomingRequestKeys = useRef(new Set<string>());
  const copyNoticeTimer = useRef<number | undefined>(undefined);
  const transferNoticeTimer = useRef<number | undefined>(undefined);
  const eventNoticeCounter = useRef(0);
  const contactContextMenuRef = useRef<HTMLDivElement>(null);
  const generalContextMenuRef = useRef<HTMLDivElement>(null);
  const profileMenuRef = useRef<HTMLDivElement>(null);
  const lastUnreadSnapshot = useRef("");
  const unreadFriendCountsRef = useRef<Record<string, number>>({});
  const persistenceReadyRef = useRef(false);
  const localStateSnapshotRef = useRef<LocalState | null>(null);
  const localSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const profileSwitchRequestRef = useRef<Promise<void> | null>(null);
  const avatarUpdateRevisionRef = useRef(0);
  const nativeFilePickRevisionRef = useRef(0);
  const dragDepthRef = useRef(0);
  const fileDragResetTimerRef = useRef<number | undefined>(undefined);
  const recoveringIncomingFilesRef = useRef(new Set<string>());
  const browserRecoveryAttemptedRef = useRef(new Set<string>());
  const fileSendBusyRef = useRef(false);
  const activeFileTargetRef = useRef<ChatFileTarget | null>(null);
  const sendMessageRef = useRef<(text: string, formatting?: readonly ChatFormattingSpan[], reply?: ChatQuote | null) => Promise<boolean>>(async () => false);
  const stableSendMessage = useCallback((text: string, formatting?: readonly ChatFormattingSpan[], reply?: ChatQuote | null) => sendMessageRef.current(text, formatting, reply), []);
  const activeChatRef = useRef(activeChat);

  persistenceReadyRef.current = persistenceReady;
  unreadFriendCountsRef.current = unreadFriendCounts;
  activeChatRef.current = activeChat;
  localStateSnapshotRef.current = {
    activeChat,
    sendOnEnter,
    contactNames,
    autoDownloadImages,
    saveChatHistory,
    outgoingFriendRequests,
    drafts: draftsRef.current,
    draftFormatting: draftFormattingRef.current,
    draftQuotes: draftQuotesRef.current,
    pendingSendOperations: pendingSendOperationsRef.current,
    scrollAnchors: scrollAnchorsRef.current,
    peerReactionNotices: reactionNoticeStoreRef.current,
    historyMessageLimit,
    notifyMessages,
    notifyRequests,
    spellcheckEnabled,
    spellcheckRussian,
    spellcheckEnglish,
  };

  const persistLocalState = useCallback(async (required = false) => {
    if (!activeProfileId || !persistenceReadyRef.current || !localStateSnapshotRef.current) return;
    const save = localSaveQueueRef.current.catch(() => {}).then(async () => {
      const state = structuredClone(localStateSnapshotRef.current);
      try {
        await invoke("save_local_state", { profileId: activeProfileId, state });
        setLocalPersistenceError(false);
      } catch (error) {
        setLocalPersistenceError(true);
        throw error;
      }
    });
    localSaveQueueRef.current = save;
    if (required) await save;
    else await save.catch(() => {});
  }, [activeProfileId]);

  function flushReactionNotices() {
    if (!persistenceReadyRef.current || reactionNoticeSaveRef.current) return;
    const cursors = Object.fromEntries(Object.entries(reactionNoticeStoreRef.current).map(([key, state]) => [key, state.through]));
    if (!Object.entries(cursors).some(([key, through]) => through > (reactionNoticeDurableCursorRef.current[key] ?? 0))) return;
    // Persist-before-local-ACK: a failed save keeps the core journal replayable.
    const request = persistLocalState(true).then(() => {
      for (const [key, through] of Object.entries(cursors)) {
        if (!reactionNoticeStoreRef.current[key]) continue;
        reactionNoticeDurableCursorRef.current[key] = Math.max(reactionNoticeDurableCursorRef.current[key] ?? 0, through);
      }
    });
    reactionNoticeSaveRef.current = request;
    void request.catch(() => {}).finally(() => { if (reactionNoticeSaveRef.current === request) reactionNoticeSaveRef.current = null; });
  }

  function receivePeerReactionEvents(chatId: string, events: readonly PeerReactionEvent[]) {
    if (!persistenceReadyRef.current) return;
    const container = messageScrollRef.current;
    const viewport = container?.getBoundingClientRect();
    const visible = new Set<string>();
    if (container && viewport && chatViewportAvailable() && messageSnapshotChatRef.current === chatId) {
      for (const event of events) {
        const row = messageElement(container, event.messageId);
        const bounds = row?.getBoundingClientRect();
        if (bounds && isMessageInViewport({ key: event.messageId, top: bounds.top, bottom: bounds.bottom }, viewport.top, viewport.height)) visible.add(event.messageId);
      }
    }
    const previous = reactionNoticeStoreRef.current[chatId];
    const next = applyPeerReactionEvents(previous, events, visible);
    if (next !== previous) {
      reactionNoticeStoreRef.current[chatId] = next;
      if (localStateSnapshotRef.current) localStateSnapshotRef.current.peerReactionNotices = reactionNoticeStoreRef.current;
      setReactionNotices(next.notices);
    }
    flushReactionNotices();
  }

  function navigateReactionNotice(messageKey: string) {
    jumpToMessageKey(messageKey);
  }

  useEffect(() => {
    const cleared = (event: Event) => {
      if ((event as CustomEvent<{ profileId: string }>).detail?.profileId === activeProfileId) discardCachedChatHistory(null);
    };
    window.addEventListener("kaigen:chat-history-cleared", cleared);
    return () => window.removeEventListener("kaigen:chat-history-cleared", cleared);
  }, [activeProfileId]);

  const switchProfileAfterDraftSave = useCallback((profileId: string) => {
    if (!profileId || profileId === activeProfileId || profileSwitchRequestRef.current) return;
    nativeFilePickRevisionRef.current += 1;
    activeFileTargetRef.current = null;
    setPendingFiles([]);
    setFileSendError(null);
    setProfileSwitchPending(true);
    const request = persistLocalState(true).then(() => onSwitchProfile(profileId));
    profileSwitchRequestRef.current = request;
    void request.catch(() => {}).finally(() => {
      if (profileSwitchRequestRef.current === request) profileSwitchRequestRef.current = null;
      setProfileSwitchPending(false);
    });
  }, [activeProfileId, onSwitchProfile, persistLocalState]);

  useEffect(() => {
    sessionStorage.setItem("kaigen-active-screen", screen);
  }, [screen]);

  useEffect(() => {
    const availableIds = profiles.map((profile) => profile.id);
    setProfileOrder((current) => {
      const next = normalizeProfileOrder(current, availableIds);
      return next.length === current.length && next.every((id, index) => id === current[index]) ? current : next;
    });
  }, [profiles]);

  useEffect(() => {
    if (!profileMenuOpen) return;
    const closeOutside = (event: PointerEvent) => {
      if (!profileMenuRef.current?.contains(event.target as Node)) setProfileMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setProfileMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [profileMenuOpen]);

  useEffect(() => {
    if (!contactContext && !generalContext) return;
    const close = () => { setContactContext(null); setGeneralContext(null); };
    const closeOutside = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Node) || (!contactContextMenuRef.current?.contains(target) && !generalContextMenuRef.current?.contains(target))) close();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };

    document.addEventListener("pointerdown", closeOutside, true);
    document.addEventListener("focusin", closeOutside, true);
    document.addEventListener("scroll", closeOutside, true);
    document.addEventListener("keydown", closeOnEscape, true);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", closeOutside, true);
      document.removeEventListener("focusin", closeOutside, true);
      document.removeEventListener("scroll", closeOutside, true);
      document.removeEventListener("keydown", closeOnEscape, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
    };
  }, [contactContext, generalContext]);

  useLayoutEffect(() => {
    setContactContext(null);
    setGeneralContext(null);
  }, [activeChat, addContactOpen, incomingRequestsOpen, screen]);

  useEffect(() => {
    if (persistenceReady && (!spellcheckEnabled || (!spellcheckRussian && !spellcheckEnglish))) {
      clearSpellcheckMemory();
    }
  }, [persistenceReady, spellcheckEnabled, spellcheckEnglish, spellcheckRussian]);

  useLayoutEffect(() => {
    const margin = 8;
    const fit = <T extends { x: number; y: number }>(
      menu: T | null,
      element: HTMLDivElement | null,
      update: React.Dispatch<React.SetStateAction<T | null>>,
    ) => {
      if (!menu || !element) return;
      const bounds = element.getBoundingClientRect();
      const scaleX = bounds.width / element.offsetWidth || 1;
      const scaleY = bounds.height / element.offsetHeight || 1;
      let x = menu.x;
      let y = menu.y;
      if (bounds.right > window.innerWidth - margin) x -= (bounds.right - window.innerWidth + margin) / scaleX;
      if (bounds.left < margin) x += (margin - bounds.left) / scaleX;
      if (bounds.bottom > window.innerHeight - margin) y -= (bounds.bottom - window.innerHeight + margin) / scaleY;
      if (bounds.top < margin) y += (margin - bounds.top) / scaleY;
      if (x !== menu.x || y !== menu.y) update((current) => current ? { ...current, x, y } : current);
    };
    fit(contactContext, contactContextMenuRef.current, setContactContext);
    fit(generalContext, generalContextMenuRef.current, setGeneralContext);
  }, [contactContext, generalContext, messages, chatCapabilities.reactions, reactionEligibleIds]);
  useEffect(() => {
    let mounted = true;
    let revision = 0;
    const apply = (settings: FileReceiveSettings) => {
      const normalized = normalizeFileReceiveSettings(settings);
      setShowReceivedImages(normalized.showImages);
    };
    void invoke<FileReceiveSettings>("get_file_receive_settings", { profileId: activeProfileId }).then((settings) => {
      if (mounted && revision === 0) apply(settings);
    }).catch(() => {});
    const listener = (event: Event) => {
      const settings = (event as CustomEvent<FileReceiveSettings & { profileId?: string }>).detail;
      if (!settings.profileId || settings.profileId === activeProfileId) { revision += 1; apply(settings); }
    };
    window.addEventListener("file-settings-changed", listener);
    return () => { mounted = false; window.removeEventListener("file-settings-changed", listener); };
  }, [activeProfileId]);

  useEffect(() => {
    const apply = (settings: ProxySettings) => {
      retainProxySettings(settings);
      setProxySettings(settings);
    };
    void invoke<ProxySettings>("get_proxy_settings").then(apply).catch(() => {});
    const listener = (event: Event) => apply((event as CustomEvent<ProxySettings>).detail);
    window.addEventListener("proxy-settings-changed", listener);
    return () => window.removeEventListener("proxy-settings-changed", listener);
  }, []);
  useEffect(() => {
    const raw = sessionStorage.getItem("kaigen-open-unread-target");
    const item = parseChatNotificationTarget(raw, Date.now());
    if (!item) { if (raw) sessionStorage.removeItem("kaigen-open-unread-target"); return; }
    if (item.profileId !== activeProfileId || !persistenceReady) return;
    if (item.target === "requests") {
      if (screen === "chat" && incomingRequestsOpen) { sessionStorage.removeItem("kaigen-open-unread-target"); return; }
      setScreen("chat");
      setAddContactOpen(false);
      setIncomingRequestsOpen(true);
      setActiveChat("");
    } else {
      const publicKey = item.target.slice("friend-key:".length).toUpperCase();
      const friend = coreFriends.find((candidate) => candidate.public_key.toUpperCase() === publicKey);
      if (!friend) return;
      const chatId = toxChatId(friend.public_key);
      if (screen === "chat" && activeChat === chatId && !incomingRequestsOpen && !addContactOpen) { sessionStorage.removeItem("kaigen-open-unread-target"); return; }
      setScreen("chat");
      setAddContactOpen(false);
      setIncomingRequestsOpen(false);
      setActiveChat(chatId);
    }
  }, [activeProfileId, coreFriends, persistenceReady, screen, activeChat, incomingRequestsOpen, addContactOpen]);
  const hasPendingOutgoingRequest = (friend: CoreFriend) => outgoingFriendRequests.some((request) => request.toxId.trim().toUpperCase().startsWith(friend.public_key));
  const pushEventNotice = useCallback((notice: Omit<AppEventNotice, "id">) => {
    if ((notice.requests && !notifyRequests) || (!notice.requests && !notifyMessages)) return;
    const id = ++eventNoticeCounter.current;
    setEventNotices((current) => [...current, { ...notice, id }]);
    window.setTimeout(() => setEventNotices((current) => current.filter((item) => item.id !== id)), 4000);
    void isPermissionGranted().then(async (granted) => {
      const allowed = granted || await requestPermission() === "granted";
      if (allowed) sendNotification({ title: notice.title, body: notice.body, autoCancel: true });
    }).catch(() => {});
  }, [notifyMessages, notifyRequests]);

  useEffect(() => {
    if (!friendRequestCustomized.current) setFriendRequestMessage(formatFriendRequestDefault(language));
    setAddContactStatus(null);
    setEventNotices([]);
    setFileSendError(null);
    setTransferNotice(null);
  }, [language]);
  const coreChats: Chat[] = coreFriends
    // toxcore creates a local friend record immediately. It becomes a visible
    // contact only after the remote side accepts. Authorization is persisted
    // as soon as a connection or a valid inbound Kaigen/Tox event proves it.
    .filter((friend) => !hasPendingOutgoingRequest(friend) || friend.authorized)
    .map((friend) => ({
    id: toxChatId(friend.public_key),
    initial: plainText(friend.name).trim().charAt(0).toLocaleUpperCase() || "?",
    name: plainText(friend.name).trim() || `Контакт ${friend.public_key.slice(-6)}`,
    preview: plainText(friend.status_message) || (friend.connection === "online" ? "В сети Tox" : "Отключен"),
    time: formatContactEvent(friend.last_event, language),
    color: "blue",
    status: friend.status,
    lastOnline: friend.connection === "online" ? "сейчас в сети" : formatLastOnline(friend.last_online, language),
    toxId: friend.tox_id || friend.public_key,
    friendNumber: friend.number,
    publicKey: friend.public_key,
    avatarPath: friend.avatar_path,
    pq: isPqTransportProtected(pqStatuses[friend.number]),
    lastEvent: friend.last_event ?? friend.addedAt,
    eventSequence: friend.lastEventSequence,
    }));
  const allChats = [...coreChats, ...chats];

  useEffect(() => {
    if (!persistenceReady) return;
    setActiveChat((current) => {
      return migrateLegacyToxChatId(current, coreFriends);
    });
    setContactNames((current) => {
      return migrateLegacyContactRecord(current, coreFriends);
    });
    draftsRef.current = migrateLegacyContactRecord(draftsRef.current, coreFriends);
  }, [coreFriends, persistenceReady]);

  useEffect(() => {
    if (!coreFriends.length) return;
    setOutgoingFriendRequests((requests) => {
      const pending = requests.filter((request) => !coreFriends.some((friend) => friend.authorized && request.toxId.trim().toUpperCase().startsWith(friend.public_key)));
      return pending.length === requests.length ? requests : pending;
    });
  }, [coreFriends]);
  const active = allChats.find((chat) => chat.id === activeChat) ?? emptyChat;
  useLayoutEffect(() => setFullImage(null), [active.id, screen]);
  useEffect(() => {
    const previewReady = () => setMessageRefreshRequest((current) => current + 1);
    const previewInvalidated = (event: Event) => {
      const detail = (event as CustomEvent<{ profileId: string; friendNumber: number }>).detail;
      if (detail?.profileId === activeProfileId && detail.friendNumber === active.friendNumber) previewReady();
    };
    const pumpFailed = (event: Event) => {
      const detail = (event as CustomEvent<{ messageId?: string; code?: string }>).detail;
      if (!detail?.messageId || !detail.code) return;
      setTransferErrors((current) => ({ ...current, [detail.messageId!]: detail.code! }));
      setMessageRefreshRequest((current) => current + 1);
    };
    window.addEventListener("kaigen:transfer-preview-ready", previewReady);
    window.addEventListener("kaigen:transfer-preview-invalidated", previewInvalidated);
    window.addEventListener("kaigen:transfer-pump-error", pumpFailed);
    return () => {
      window.removeEventListener("kaigen:transfer-preview-ready", previewReady);
      window.removeEventListener("kaigen:transfer-preview-invalidated", previewInvalidated);
      window.removeEventListener("kaigen:transfer-pump-error", pumpFailed);
    };
  }, [activeProfileId, active.friendNumber]);
  const messageKeys = useMemo(() => messages.map((message) => message.coreId ?? String(message.id)), [messages]);
  const historyOffsets = useMemo(() => buildHistoryOffsets(messageKeys, measuredMessageHeightsRef.current), [messageKeys, heightMeasurementRevision]);
  const windowAnchorIndex = windowAnchorKey ? messageKeys.indexOf(windowAnchorKey) : -1;
  const messageWindow = historyWindowRange(messages.length, windowAnchorIndex >= 0 ? windowAnchorIndex : null);
  const messageWindowRef = useRef(messageWindow);
  messageWindowRef.current = messageWindow;
  const renderedMessages = messageSnapshotChatRef.current === active.id ? messages.slice(messageWindow.start, messageWindow.end) : [];
  const reactionEligibleKeys = useMemo(() => new Set(reactionEligibleIds), [reactionEligibleIds]);
  const contextMessage = generalContext?.messageKey
    ? messages.find((message) => (message.coreId ?? String(message.id)) === generalContext.messageKey)
    : undefined;
  const contextReactionEligible = !!contextMessage && !contextMessage.event
    && chatCapabilities.reactions && reactionEligibleKeys.has(contextMessage.coreId ?? "");
  const accessibleHistoryStart = Math.max(0, historyTotal - (loadedHistoryLimit === "all" ? historyTotal : loadedHistoryLimit));
  const historySpaceBefore = Math.max(0, historyWindowStart - accessibleHistoryStart) * 64 + historyOffsets[messageWindow.start];
  const historySpaceAfter = Math.max(0, historyTotal - historyWindowStart - messages.length) * 64 + historyOffsets[messages.length] - historyOffsets[messageWindow.end];
  const chatFileAdmission = {
    screen,
    friendNumber: active.friendNumber,
    addContactOpen,
    incomingRequestsOpen,
  };
  const canStageFileForActiveChat = !profileSwitching
    && !profileSwitchPending
    && canStageChatFile(chatFileAdmission);
  const activeFileTarget: ChatFileTarget | null = canStageFileForActiveChat
    && activeProfileId
    && active.friendNumber !== undefined
    ? { profileId: activeProfileId, friendNumber: active.friendNumber, chatId: active.id }
    : null;
  activeFileTargetRef.current = activeFileTarget;
  const pendingFileMatchesActiveTarget = pendingFiles.length > 0
    && activeFileTarget !== null
    && pendingFiles.every((file) => file.profileId === activeFileTarget.profileId
      && file.friendNumber === activeFileTarget.friendNumber
      && file.chatId === activeFileTarget.chatId);
  const stageFiles = useCallback((files: Iterable<File>) => {
    const target = activeFileTargetRef.current;
    const admission = admitChatFileBatch(files);
    if (!admission.selectedCount || !target) return false;
    const notice = formatChatFileBatchNotice(admission, language);
    if (notice) showTransferNotice(notice);
    if (!admission.accepted.length) return false;
    setPendingFiles(admission.accepted.map((file) => ({ ...target, file, grantToken: null, size: file.size })));
    return true;
  }, [language]);
  const discardNativeSelections = useCallback((selections: NativeFileSelection[]) => {
    for (const selection of selections) {
      void invoke("discard_native_file_grant", { grantToken: selection.grantToken }).catch(() => {});
    }
  }, []);
  const stageNativeFileBatch = useCallback((batch: NativeFileBatchSelection, target: ChatFileTarget) => {
    const notice = formatChatFileBatchNotice(batch, language);
    if (notice) showTransferNotice(notice);
    if (!batch.accepted.length) return false;
    setPendingFiles(batch.accepted.map((selection) => ({
      ...target,
      file: new File([], selection.name, { type: selection.mime }),
      grantToken: selection.grantToken,
      size: selection.size,
    })));
    return true;
  }, [language]);
  const stagePastedFiles = useCallback((files: Iterable<File>) => {
    if (!platformCapabilities.nativeFilesystem) return stageFiles(files);
    const target = activeFileTargetRef.current;
    if (!target) return false;
    const revision = ++nativeFilePickRevisionRef.current;
    void invoke<NativeFileBatchSelection>("stage_clipboard_image_for_chat", { profileId: target.profileId, friendNumber: target.friendNumber })
      .then((batch) => {
        if (revision !== nativeFilePickRevisionRef.current || !sameChatFileTarget(activeFileTargetRef.current, target)) { discardNativeSelections(batch.accepted); return; }
        stageNativeFileBatch(batch, target);
      })
      .catch((error) => { if (revision === nativeFilePickRevisionRef.current) showTransferNotice(formatUserFacingError(error, { ru: "Не удалось вставить изображение из буфера", en: "Could not paste the clipboard image" }, language)); });
    return true;
  }, [stageFiles, stageNativeFileBatch, discardNativeSelections, language]);
  const resetFileDrag = useCallback(() => {
    dragDepthRef.current = 0;
    if (fileDragResetTimerRef.current !== undefined) window.clearTimeout(fileDragResetTimerRef.current);
    fileDragResetTimerRef.current = undefined;
    setIsDraggingFile(false);
  }, []);
  const keepFileDragReady = useCallback(() => {
    if (!activeFileTargetRef.current) return;
    setIsDraggingFile(true);
    if (fileDragResetTimerRef.current !== undefined) window.clearTimeout(fileDragResetTimerRef.current);
    // Browsers can omit the terminal dragleave after quick repeated crossings.
    // A live dragover refreshes this watchdog; a lost drag session cannot leave
    // the readiness overlay stuck indefinitely.
    fileDragResetTimerRef.current = window.setTimeout(resetFileDrag, 180);
  }, [resetFileDrag]);
  const activeName = plainText(contactNames[active.id] ?? active.name);
  const activeUnreadCount = active.friendNumber === undefined ? 0 : unreadFriendCounts[String(active.friendNumber)] ?? 0;
  const activePq = active.friendNumber === undefined ? undefined : pqStatuses[active.friendNumber];
  const activePqProtected = isPqTransportProtected(activePq);
  const activePqCancelledAwaitingDecision = isPqAwaitingManualDecision(activePq);
  const activePqAwaitingDecision = !!activePq?.auto_pending
    && !activePq.identity_waiting
    && (!activePq.supported || activePqCancelledAwaitingDecision);
  const activePqComposerStage = activePq?.identity_needs_entropy && activePq.identity_waiting
    ? "entropy"
    : activePqAwaitingDecision
      ? activePqCancelledAwaitingDecision ? "cancelled" : "capability"
      : "none";
  const displayName = (chat: Chat) => plainText(contactNames[chat.id] ?? chat.name);
  const normalizedContactSearch = contactSearch.trim().toLocaleLowerCase();
  const nextActivityHold = updateActivityHold(activityHold, allChats, active.id, contactSort, promotedActivityId);
  useLayoutEffect(() => {
    if (!sameData(activityHold, nextActivityHold)) setActivityHold(nextActivityHold);
    if (promotedActivityId) setPromotedActivityId(undefined);
  }, [activityHold, nextActivityHold, promotedActivityId]);
  const visibleChats = orderContacts(
    allChats.filter((chat) => displayName(chat).toLocaleLowerCase().includes(normalizedContactSearch)),
    { ...contactSort, hideOffline: hideOfflineContacts, heldContactId: nextActivityHold.contactId },
  );
  const activitySortLabel = contactSort.mode === "activity"
    ? t(contactSort.direction === "forward" ? "Сортировка по событиям: новые сначала" : "Сортировка по событиям: старые сначала")
    : t("Сортировать по событиям: новые сначала");
  const statusSortLabel = contactSort.mode === "status"
    ? t(contactSort.direction === "forward" ? "Сортировка по статусу: онлайн сначала" : "Сортировка по статусу: отключённые сначала")
    : t("Сортировать по статусу: онлайн сначала");
  const offlineVisibilityLabel = t(hideOfflineContacts ? "Показать отключённые контакты" : "Скрыть отключённые контакты");
  const highlightContactName = (name: string) => {
    const pattern = contactSearch.trim();
    const index = pattern ? name.toLocaleLowerCase().indexOf(pattern.toLocaleLowerCase()) : -1;
    if (index < 0) return name;
    return <>{name.slice(0, index)}<mark>{name.slice(index, index + pattern.length)}</mark>{name.slice(index + pattern.length)}</>;
  };
  const searchMatchesByMessage = useMemo(() => {
    const grouped = new Map<string, Array<MessageSearchMatch & { resultIndex: number }>>();
    messageSearchMatches.forEach((match, resultIndex) => {
      const current = grouped.get(match.messageKey) ?? [];
      current.push({ ...match, resultIndex });
      grouped.set(match.messageKey, current);
    });
    return grouped;
  }, [messageSearchMatches]);
  // After a native resize only the current browser viewport is authoritative.
  // Keeping an old saved width here makes columns overflow a small window.
  const {
    layoutWidth,
    preferredContentWidth: minimumContentWidth,
    compactSidebar,
    sidebarWidth,
    listEdge,
    gridTemplateColumns: gridColumns,
  } = resolveAppLayout({
    screen,
    viewportWidth,
    interfaceScale: appearance.interfaceScale,
    requestedSidebarWidth: chatListWidth,
  });

  useEffect(() => {
    const updateViewportWidth = () => {
      // On a monitor with another DPI Windows can update the WebView viewport
      // after the native resize event. Read the live document width instead of
      // keeping the old monitor's CSS width.
      const width = document.documentElement.clientWidth || window.innerWidth;
      setViewportWidth(width);
    };
    const visualViewport = window.visualViewport;
    const observer = new ResizeObserver(updateViewportWidth);
    observer.observe(document.documentElement);
    window.addEventListener("resize", updateViewportWidth);
    visualViewport?.addEventListener("resize", updateViewportWidth);
    updateViewportWidth();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateViewportWidth);
      visualViewport?.removeEventListener("resize", updateViewportWidth);
    };
  }, []);

  useEffect(() => {
    const runId = ++searchRunRef.current;
    const query = plainText(messageSearch).trim();
    const queryIdentity = `${activeProfileId}:${active.id}:${query}`;
    if (queryIdentity !== searchQueryRef.current) {
      searchQueryRef.current = queryIdentity;
      searchPreviousPagesRef.current = [];
      searchRecoveryTargetRef.current = undefined;
      searchSeekOffsetRef.current = undefined;
      searchRecoveryAttemptsRef.current = 0;
      searchExhaustedCursorRef.current = undefined;
      setSearchPage({ offset: 0 });
      setMessageSearchMatches([]);
      setMessageSearchIndex(-1);
      setSearchNextCursor(undefined);
      return;
    }
    const previousTarget = searchSelectionRef.current;
    if (!messageSearchOpen || !query || active.friendNumber === undefined) {
      setMessageSearchMatches([]);
      setMessageSearchIndex(-1);
      setMessageSearchBusy(false);
      return;
    }
    setMessageSearchBusy(true);
    setSearchError(false);
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        let cursor = searchPage.cursor;
        let offset = searchPage.offset;
        const recoveryPages: Array<{ cursor?: string; offset: number }> = [];
        const visited: string[] = [];
        while (!cancelled && runId === searchRunRef.current) {
          const pageCursor = cursor;
          const page = await chatSearchRequests.run(
            () => invoke<CoreSearchPage>("search_tox_messages", { profileId: activeProfileId, friendNumber: active.friendNumber, query, cursor, limit: 100 }),
            () => !cancelled && runId === searchRunRef.current,
          );
          if (!page || cancelled || runId !== searchRunRef.current) return;
          const nextCursor = page.nextCursor ?? undefined;
          if (!page.matches.length && nextCursor && !visited.includes(nextCursor)) {
            visited.push(nextCursor);
            if (visited.length > 8) visited.shift();
            cursor = nextCursor;
            await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
            continue;
          }
          const matches = page.matches.map((match) => ({ messageKey: match.messageId, field: match.field, start: match.start, end: match.end }));
          const recovery = searchRecoveryTargetRef.current;
          const seekOffset = searchSeekOffsetRef.current;
          const recoveryFound = recovery && matches.some((match) => match.messageKey === recovery.messageKey && match.field === recovery.field && match.start === recovery.start && match.end === recovery.end);
          const seekFound = seekOffset !== undefined && offset + matches.length > seekOffset;
          if ((recovery && !recoveryFound || seekOffset !== undefined && !seekFound) && nextCursor) {
            if (matches.length) {
              recoveryPages.push({ cursor: pageCursor, offset });
              if (recoveryPages.length > 128) recoveryPages.shift();
            }
            offset += matches.length;
            cursor = nextCursor;
            await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
            continue;
          }
          searchRecoveryTargetRef.current = undefined;
          searchSeekOffsetRef.current = undefined;
          if (recovery || seekOffset !== undefined) searchPreviousPagesRef.current = recoveryPages;
          if (!matches.length && !nextCursor && searchPage.offset > 0 && searchPage.cursor) {
            searchExhaustedCursorRef.current = { cursor: searchPage.cursor, total: historyTotal };
            const previous = searchPreviousPagesRef.current.pop();
            if (previous) { setSearchPage({ ...previous, selectLast: true }); return; }
          }
          if ((recoveryFound || seekFound) && (offset !== searchPage.offset || pageCursor !== searchPage.cursor)) {
            setSearchPage({ cursor: pageCursor, offset, selectLast: seekFound });
          }
          setMessageSearchMatches(matches);
          setMessageSearchIndex(retainSearchTarget(matches, recovery ?? (seekFound ? undefined : previousTarget), seekFound || searchPage.selectLast ? matches.length - 1 : 0));
          const exhausted = searchExhaustedCursorRef.current;
          setSearchNextCursor(exhausted?.total === historyTotal && exhausted.cursor === nextCursor ? undefined : nextCursor);
          setMessageSearchBusy(false);
          searchRecoveryAttemptsRef.current = 0;
          return;
        }
      })().catch((error) => {
        if (cancelled || runId !== searchRunRef.current) return;
        if (String(error).includes("CHAT_HISTORY_SEARCH_CURSOR_STALE") && searchRecoveryAttemptsRef.current < 3) {
          searchRecoveryAttemptsRef.current += 1;
          if (searchSeekOffsetRef.current === undefined) searchRecoveryTargetRef.current ??= previousTarget;
          searchPreviousPagesRef.current = [];
          searchExhaustedCursorRef.current = undefined;
          setSearchPage({ offset: 0 });
          return;
        }
        setSearchError(true);
        setMessageSearchBusy(false);
      });
    }, 120);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [messageSearch, messageSearchOpen, activeProfileId, active.id, active.friendNumber, searchPage, historyTotal]);

  searchSelectionRef.current = messageSearchMatches[messageSearchIndex];

  useLayoutEffect(() => {
    setLoadedHistoryLimit(historyMessageLimit);
    setHistoryError(false);
    setHistoryHasMore(false);
    setHistoryHasAfter(false);
    setHistoryRequest({});
    setHistoryWindowStart(0);
    setHistoryTotal(0);
    setReactionEligibleIds([]);
  }, [active.id, historyMessageLimit]);

  useLayoutEffect(() => {
    setReplyQuote(draftQuotesRef.current[active.id] ?? null);
    setReactionNotices(reactionNoticeStoreRef.current[active.id]?.notices ?? []);
    setChatCapabilities({ reactions: false, formatting: false, quotes: false });
  }, [active.id, activeProfileId]);

  useEffect(() => {
    if (active.friendNumber === undefined) return;
    let mounted = true;
    const refresh = () => void invoke<ChatCapabilities>("get_chat_capabilities", { profileId: activeProfileId, friendNumber: active.friendNumber })
      .then((capabilities) => { if (mounted) setChatCapabilities((current) => sameData(current, capabilities) ? current : capabilities); }).catch(() => {});
    refresh();
    const timer = window.setInterval(refresh, 3000);
    return () => { mounted = false; window.clearInterval(timer); };
  }, [active.id, active.friendNumber, activeProfileId]);

  // A cached chat is hydrated in the layout phase. Clear the previous chat's
  // visibility and scroll intent first, before any new rows can be seen or ACKed.
  useLayoutEffect(() => {
    if (screen === "chat" && active.id && active.friendNumber !== undefined) {
      if (deferredIncomingTimerRef.current !== undefined) window.clearTimeout(deferredIncomingTimerRef.current);
      deferredIncomingTimerRef.current = undefined;
      deferredIncomingScrollRef.current = null;
      deferredOutgoingScrollRef.current = null;
      lastAutoScrollIntentRef.current = null;
      unseenIncomingKeysRef.current.clear();
      locallySeenPendingRef.current.clear();
      locallyAcknowledgedRef.current.clear();
      window.clearTimeout(localViewAckRetryRef.current);
      localViewAckRetryRef.current = undefined;
      readingLongIncomingRef.current = null;
      trackedUnreadCountRef.current = 0;
      userScrollActiveRef.current = false;
      userScrollBlockedUntilRef.current = 0;
      userScrollUiUntilRef.current = 0;
      automaticScrollUntilRef.current = 0;
      pendingScrollRestore.current = active.id;
      pendingPreserveAnchorRef.current = null;
      cancelPendingMessageNavigation();
      setReturnAnchor(null);
      setUnseenBoundary(null);
      setWindowAnchorKey(scrollAnchorsRef.current[active.id]?.messageKey ?? null);
      followLatestRef.current = scrollAnchorsRef.current[active.id]?.atBottom ?? true;
      setPendingIncomingCount(0);
      setShowJumpToLatest(false);
      historyFarFromLatestRef.current = false;
    }
  }, [active.id, active.friendNumber, activeProfileId, screen]);

  function measureMessageRows(container: HTMLDivElement) {
    if (messageSnapshotChatRef.current !== active.id) return;
    const rows = Array.from(container.querySelectorAll<HTMLElement>("[data-message-key]"));
    let changed = false;
    rows.forEach((row, index) => {
      const height = rows[index + 1] ? rows[index + 1].offsetTop - row.offsetTop : row.offsetHeight + 8;
      const key = row.dataset.messageKey!;
      if (height > 0 && Math.abs((measuredMessageHeightsRef.current.get(key) ?? 64) - height) > 1) {
        measuredMessageHeightsRef.current.set(key, height);
        changed = true;
      }
    });
    while (measuredMessageHeightsRef.current.size > 1500) {
      const oldest = measuredMessageHeightsRef.current.keys().next().value;
      if (oldest === undefined) break;
      measuredMessageHeightsRef.current.delete(oldest);
    }
    if (changed) {
      if (!pendingNavigationRef.current && !deferredOutgoingScrollRef.current && !followLatestRef.current) pendingPreserveAnchorRef.current ??= captureCurrentAnchor();
      setHeightMeasurementRevision((value) => value + 1);
    }
  }

  useLayoutEffect(() => {
    const container = messageScrollRef.current;
    if (container) measureMessageRows(container);
  }, [messages, messageWindow.start, messageWindow.end, viewportWidth, appearance.chatFontSize, appearance.interfaceScale]);

  useLayoutEffect(() => {
    const key = `${activeProfileId}:${active.id}`;
    const viewLeaseId = viewOwnerRef.current.leaseId;
    if (active.friendNumber !== undefined) setTransferPreviewChatActive(activeProfileId, active.friendNumber, displayedChatActiveRef.current);
    const cached = displayedChatActiveRef.current && active.id ? historyCacheRef.current.open(key, Date.now()) : undefined;
    if (cached && messageSnapshotChatRef.current !== active.id) {
      const count = historyMessageLimit === "all" ? cached.length : historyMessageLimit;
      const restored = cached.slice(-count).map((message) => {
        const attachment = message.attachment;
        if (platformCapabilities.nativeFilesystem || !attachment?.image || !attachment.path?.startsWith("browser-stream://")) return message;
        const url = transferPreviewSource(attachment.path, activeProfileId, active.friendNumber!);
        return attachment.url === url ? message : { ...message, attachment: { ...attachment, url } };
      });
      messageSnapshotChatRef.current = active.id;
      messagesRef.current = restored;
      setMessages(restored);
      const range = historyCacheRangesRef.current.get(key);
      if (range) {
        historyCacheRangesRef.current.delete(key);
        historyCacheRangesRef.current.set(key, range);
        const start = range.start + cached.length - restored.length;
        setHistoryWindowStart(start);
        setHistoryTotal(range.total);
        setHistoryRequest({ rangeOffset: start });
      }
    } else if (!cached) {
      messageSnapshotChatRef.current = "";
      messagesRef.current = [];
      setMessages([]);
    }
    return () => {
      cancelPendingMessageNavigation();
      if (active.friendNumber !== undefined) setTransferPreviewChatActive(activeProfileId, active.friendNumber, false);
      if (active.id) historyCacheRef.current.leave(key, Date.now());
      if (active.friendNumber !== undefined) void invoke("release_chat_history", { profileId: activeProfileId, friendNumber: active.friendNumber, viewLeaseId }).catch(() => {});
      for (const frame of viewFramesRef.current) window.cancelAnimationFrame(frame);
      viewFramesRef.current.clear();
    };
  }, [viewKey]);

  useEffect(() => {
    if (!displayedChatActiveRef.current || active.friendNumber === undefined) return;
    const viewLeaseId = viewOwnerRef.current.leaseId;
    const refreshLease = () => {
      void invoke("refresh_chat_history_lease", { profileId: activeProfileId, friendNumber: active.friendNumber, viewLeaseId }).catch(() => {});
    };
    // Minimizing the window does not mean leaving this chat. This inexpensive
    // heartbeat deliberately continues while message polling is suspended.
    refreshLease();
    const timer = window.setInterval(refreshLease, 15_000);
    return () => window.clearInterval(timer);
  }, [viewKey]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const expired = historyCacheRef.current.expire(Date.now());
      for (const key of expired) historyCacheRangesRef.current.delete(key);
      const snapshotKey = `${activeProfileId}:${messageSnapshotChatRef.current}`;
      if (!displayedChatActiveRef.current && expired.includes(snapshotKey)) {
        messagesRef.current = [];
        messageSnapshotChatRef.current = "";
        setMessages([]);
        searchRunRef.current += 1;
        setMessageSearchMatches([]);
        setReactionNotices([]);
        measuredMessageHeightsRef.current.clear();
      }
    }, 30_000);
    return () => { window.clearInterval(timer); historyCacheRef.current.clear(); };
  }, []);

  useLayoutEffect(() => {
    if (!messageSearchOpen || messageSearchIndex < 0 || !messageSearchMatches[messageSearchIndex]) return;
    const target = messageSearchMatches[messageSearchIndex];
    const signature = `${active.id}:${messageSearch}:${target.messageKey}:${target.field}:${target.start}:${target.end}`;
    if (searchJumpedTargetRef.current === signature) return;
    searchJumpedTargetRef.current = signature;
    setReturnAnchor((current) => current ?? captureCurrentAnchor());
    followLatestRef.current = false;
    jumpToMessageKey(target.messageKey, false);
    const frame = scheduleViewFrame(() => {
      const container = messageScrollRef.current;
      const match = container?.querySelector<HTMLElement>(`[data-search-result="${messageSearchIndex}"]`);
      if (container && match) scrollMessageWithinContainer(container, match, "smooth");
    });
    return () => window.cancelAnimationFrame(frame);
  }, [messageSearchIndex, messageSearchMatches, messageSearchOpen]);

  useEffect(() => {
    if (screen !== "chat" || !active.id) return;
    const container = messageScrollRef.current;
    if (!container) return;
    let activeObserver = true;
    const observer = new ResizeObserver(() => {
      if (!activeObserver || messageSnapshotChatRef.current !== active.id || pendingScrollRestore.current || pendingNavigationRef.current) return;
      try {
        measureMessageRows(container);
        const reading = readingLongIncomingRef.current;
        if (reading?.chatId === active.id && !reading.userScrolled) { maintainLongIncomingContext(reading); return; }
        if (deferredIncomingScrollRef.current || deferredOutgoingScrollRef.current) return;
        const saved = scrollAnchorsRef.current[active.id];
        if (followLatestRef.current) {
          markAutomaticScroll();
          container.scrollTop = container.scrollHeight;
        } else if (saved) restoreViewAnchor(saved);
      } finally {
        markVisibleIncomingMessages();
        syncUnseenIndicator();
        syncReturnAnchor();
      }
    });
    observer.observe(container);
    for (const row of container.querySelectorAll<HTMLElement>("[data-message-key]")) observer.observe(row);
    return () => { activeObserver = false; observer.disconnect(); };
  }, [active.id, screen, messages, historyHasAfter, messageWindow.start, messageWindow.end]);

  useEffect(() => {
    let mounted = true;
    let friendsRefreshPending = false;
    const refresh = () => {
      if (document.visibilityState !== "visible") return;
      if (!friendsRefreshPending) {
        friendsRefreshPending = true;
        void invoke<CoreFriend[]>("get_tox_friends").then((friends) => {
          if (mounted) setCoreFriends((current) => sameData(current, friends) ? current : friends);
        }).catch(() => {}).finally(() => { friendsRefreshPending = false; });
      }
      void invoke<IncomingFriendRequest[]>("get_incoming_friend_requests").then((requests) => {
        if (!mounted) return;
        setIncomingFriendRequests((current) => sameData(current, requests) ? current : requests);
        if (incomingRequestsOpen) {
          requests.forEach((request) => seenIncomingRequestKeys.current.add(request.public_key));
          setUnreadIncomingRequestKeys((current) => current.length ? [] : current);
          return;
        }
        const fresh = requests.filter((request) => !seenIncomingRequestKeys.current.has(request.public_key));
        fresh.forEach((request) => {
          seenIncomingRequestKeys.current.add(request.public_key);
          pushEventNotice({
            ...formatChatRequestNotice(profileName, request.message || request.public_key.slice(0, 12), language),
            requests: true,
          });
        });
        setUnreadIncomingRequestKeys((current) => {
          const next = Array.from(new Set([...current, ...fresh.map((request) => request.public_key)]));
          return sameData(current, next) ? current : next;
        });
      }).catch(() => {});
    };
    refresh();
    const timer = window.setInterval(refresh, 5000);
    const backendListener = listen<string>("profiles-changed", () => refresh());
    return () => {
      mounted = false;
      window.clearInterval(timer);
      void backendListener.then((unlisten) => unlisten());
    };
  }, [incomingRequestsOpen, language, profileName, pushEventNotice]);

  useEffect(() => {
    if (!incomingRequestsOpen) return;
    incomingFriendRequests.forEach((request) => seenIncomingRequestKeys.current.add(request.public_key));
    setUnreadIncomingRequestKeys([]);
    void invoke("mark_requests_read").then(() => window.dispatchEvent(new Event("profiles-changed"))).catch(() => {});
  }, [incomingFriendRequests, incomingRequestsOpen]);

  useEffect(() => {
    let mounted = true;
    let refreshPending = false;
    const refresh = () => {
      if (document.visibilityState !== "visible") return;
      if (refreshPending) return;
      refreshPending = true;
      const mutationRevision = unreadMutationRevisionRef.current;
      void invoke<UnreadState>("get_unread_state", { profileId: activeProfileId }).then((state) => {
      if (!mounted || mutationRevision !== unreadMutationRevisionRef.current) return;
      setUnreadSnapshotReady(true);
      const signature = JSON.stringify(state);
      if (signature === lastUnreadSnapshot.current) return;
      lastUnreadSnapshot.current = signature;
      setUnreadFriendCounts(state.friends ?? {});
      setUnreadIncomingRequestKeys(state.requests ?? []);
      window.dispatchEvent(new Event("profiles-changed"));
      }).catch(() => {}).finally(() => { refreshPending = false; });
    };
    refresh();
    const timer = window.setInterval(refresh, 3000);
    return () => { mounted = false; window.clearInterval(timer); };
  }, [activeProfileId]);

  useEffect(() => {
    if (!unreadSnapshotReady) return;
    const queue = notificationQueueRef.current;
    if (notificationOwnerRef.current !== activeProfileId) {
      notificationOwnerRef.current = activeProfileId;
      queue.resetOwner(activeProfileId, Object.fromEntries(coreFriends.map((friend) => [friend.public_key, unreadFriendCounts[String(friend.number)] ?? 0])));
    }
    coreFriends.forEach((friend) => queue.enqueue(friend.public_key, unreadFriendCounts[String(friend.number)] ?? 0));
    queue.retainKeys(coreFriends.map((friend) => friend.public_key));
    let cancelled = false;
    const drain = () => {
      void queue.drain(async (candidate) => {
          const friend = coreFriends.find((item) => item.public_key === candidate.key);
          if (cancelled || !friend || candidate.profileId !== activeProfileId) return false;
          const latest = await invoke<CoreMessage[]>("get_tox_messages", { profileId: candidate.profileId, friendNumber: friend.number, limit: 1 });
          if (cancelled) return false;
          const message = latest[0];
          if (notificationVisibleRef.current(toxChatId(friend.public_key), message?.id)) return true;
          const increase = candidate.increase;
          pushEventNotice({
            ...formatChatMessageNotice(profileName, friend.name, increase > 1 ? (language === "ru" ? `${increase} новых сообщений` : `${increase} new messages`) : message?.text || message?.attachment?.name, language),
            friendNumber: friend.number,
            friendPublicKey: friend.public_key,
          });
          return true;
      });
    };
    const timer = window.setTimeout(drain, 600);
    const retry = window.setInterval(drain, 2000);
    return () => { cancelled = true; window.clearTimeout(timer); window.clearInterval(retry); };
  }, [unreadSnapshotReady, unreadFriendCounts, coreFriends, activeProfileId, language, profileName, pushEventNotice]);

  useEffect(() => {
    if (!coreFriends.length) {
      setPqStatuses({});
      return;
    }
    const pending = new Set<number>();
    const nextPoll = new Map<number, number>();
    const refresh = () => {
      if (document.visibilityState !== "visible") return;
      for (const friend of coreFriends) {
        if (pending.has(friend.number) || (nextPoll.get(friend.number) ?? 0) > Date.now()) continue;
        pending.add(friend.number);
        nextPoll.set(friend.number, Date.now() + (activeChatRef.current === toxChatId(friend.public_key) ? 1000 : 3000));
        void refreshPqStatus(friend.number).catch(() => {}).finally(() => pending.delete(friend.number));
      }
    };
    refresh();
    const timer = window.setInterval(refresh, 1000);
    return () => {
      window.clearInterval(timer);
      for (const friendNumber of pending) pqStatusRequestsRef.current[friendNumber] = (pqStatusRequestsRef.current[friendNumber] ?? 0) + 1;
    };
  }, [coreFriends, refreshPqStatus]);

  useEffect(() => {
    if (active.friendNumber === undefined) {
      messagesRef.current = [];
      messageSnapshotChatRef.current = "";
      setMessages([]);
      return;
    }
    if (screen !== "chat" || incomingRequestsOpen || addContactOpen) return;
    const viewLeaseId = viewOwnerRef.current.leaseId;
    let mounted = true;
    let refreshPending = false;
    historyRevisionRef.current = undefined;
    const refresh = () => {
      if (document.visibilityState !== "visible") return;
      if (refreshPending) return;
      refreshPending = true;
      const mutationRevision = historyMutationRevisionRef.current;
      void invoke<CoreMessagesSnapshot>("get_tox_messages_snapshot", {
      profileId: activeProfileId,
      friendNumber: active.friendNumber,
      viewLeaseId,
      limit: boundedHistoryRequestLimit(loadedHistoryLimit, activeUnreadCount),
      knownRevision: historyRevisionRef.current,
      peerReactionAfter: reactionNoticeDurableCursorRef.current[active.id] ?? 0,
      ackPeerReactionThrough: reactionNoticeDurableCursorRef.current[active.id] ?? 0,
      ...historyRequest,
    })
      .then((snapshot) => {
        if (!mounted || mutationRevision !== historyMutationRevisionRef.current) return;
        historyRevisionRef.current = snapshot.revision;
        receivePeerReactionEvents(active.id, snapshot.peerReactionEvents ?? []);
        if (!snapshot.messages) return;
        setHistoryTotal(snapshot.total);
        setHistoryWindowStart(snapshot.windowStart);
        setHistoryHasMore(snapshot.hasMoreBefore);
        setHistoryHasAfter(snapshot.hasMoreAfter);
        setReactionEligibleIds((current) => sameData(current, snapshot.reactionEligibleIds ?? []) ? current : snapshot.reactionEligibleIds ?? []);
        latestHistoryMessageIdRef.current = snapshot.latestMessageId;
        if (snapshot.firstUnseenMessageId) setUnseenBoundary((boundary) => boundary ?? snapshot.firstUnseenMessageId!);
        const items = snapshot.messages;
        setHistoryError(false);
        const terminalTransferIds = items.flatMap((item) =>
          item.id && isTerminalTransferState(item.attachment?.transfer_state)
            ? [item.id]
            : [],
        );
        const nextMessages = items.map((item, index) => ({
          id: item.timestamp * 1000 + index,
          coreId: item.id,
          text: item.quote ? plainText(item.text) : parseQtoxQuoteMessage(plainText(item.text))?.body ?? plainText(item.text),
          mine: item.mine,
          delivery: item.delivery === "queued" ? "pending" : item.delivery === "unknown_recovered" ? "unknown" : item.delivery || "sent",
          deliveredAt: item.delivered_at,
          event: item.event,
          protocolVersion: item.protocol_version,
          quote: item.quote ?? (parseQtoxQuoteMessage(plainText(item.text)) ? { author: "", text: parseQtoxQuoteMessage(plainText(item.text))!.quoteText, legacy: true } : undefined),
          formatting: item.protocol_version === 1 && plainText(item.text) === item.text ? item.formatting : undefined,
          reactions: item.reactions,
          pqProtected: item.pq_protected,
          timestamp: item.timestamp,
          time: formatChatDate(new Date(item.timestamp * 1000), language, "time"),
          attachment: item.attachment ? {
            name: plainText(item.attachment.name), size: item.attachment.size, type: plainText(item.attachment.mime), path: item.attachment.path,
            // A local sender can preview the original immediately. A received
            // image is exposed only after its final chunk has been written.
            url: item.attachment.image && (item.mine || item.attachment.completed !== false) && (item.mine || showReceivedImages || (item.id ? revealedImages.includes(item.id) : false)) ? chatImageSource(item.attachment.preview_source ?? item.attachment.path, activeProfileId, active.friendNumber) : undefined,
            image: item.attachment.image,
            transferred: item.attachment.transferred ?? item.attachment.size,
            speed: item.attachment.speed_bytes_per_sec ?? 0,
            eta: item.attachment.eta_seconds,
            transferState: effectiveTransferState(
              item.attachment.transfer_state ?? "complete",
              item.id ? transferUiStateOverrides[item.id] : undefined,
            ),
            completed: item.attachment.completed ?? true,
            completedAt: item.attachment.completed_at,
            error: item.attachment.transfer_error ?? null,
            retryCount: item.attachment.retry_count ?? 0,
          } : undefined,
        }));
        const pendingIndex = pendingHistoryIndexRef.current;
        if (pendingIndex !== null && nextMessages.length) {
          const target = nextMessages[Math.max(0, Math.min(nextMessages.length - 1, pendingIndex - snapshot.windowStart))];
          const targetKey = target.coreId ?? String(target.id);
          setWindowAnchorKey(targetKey);
          beginPendingMessageNavigation(targetKey);
          pendingHistoryIndexRef.current = null;
        }
        const sameChatSnapshot = messageSnapshotChatRef.current === active.id;
        const previousMessages = sameChatSnapshot ? messagesRef.current : [];
        const previousIds = new Set(previousMessages.map((message) => message.coreId ?? String(message.id)));
        const previousLastKey = previousMessages[previousMessages.length - 1]?.coreId;
        const previousLastIndex = previousLastKey ? nextMessages.findIndex((message) => message.coreId === previousLastKey) : -1;
        const newMessages = sameChatSnapshot && historySnapshotAtTailRef.current && !snapshot.hasMoreAfter && previousLastIndex >= 0
          ? nextMessages.slice(previousLastIndex + 1).filter((message) => !previousIds.has(message.coreId ?? String(message.id)))
          : [];
        const unreadCount = unreadFriendCountsRef.current[String(active.friendNumber)] ?? 0;
        const newlyArrivedIncoming = newMessages.filter((message) => !message.mine);
        const windowUnseen = new Set(snapshot.unseenMessageIds ?? []);
        const incomingToTrack = nextMessages.filter((message) => !message.mine && windowUnseen.has(message.coreId ?? ""))
          .filter((message, index, candidates) => {
            const key = message.coreId ?? String(message.id);
            return !unseenIncomingKeysRef.current.has(key)
              && candidates.findIndex((candidate) => (candidate.coreId ?? String(candidate.id)) === key) === index;
          });
        const incomingKeys = incomingToTrack.map((message) => message.coreId ?? String(message.id));
        if (incomingKeys.length) {
          registerUnseenIncoming(incomingKeys);
          setUnseenBoundary((boundary) => boundary ?? incomingKeys[0]);
          trackedUnreadCountRef.current = Math.max(trackedUnreadCountRef.current, unreadCount, incomingKeys.length);
        }
        trackedUnreadCountRef.current = unreadCount;
        historySnapshotAtTailRef.current = !snapshot.hasMoreAfter;
        const latestNewMessage = newMessages[newMessages.length - 1];
        const container = messageScrollRef.current;
        const previousDistance = container
          ? Math.max(0, container.scrollHeight - container.scrollTop - container.clientHeight)
          : 0;
        const changed = !sameMessages(previousMessages, nextMessages) || !sameChatSnapshot;
        if (changed && sameChatSnapshot && !pendingNavigationRef.current && (!newMessages.length || !followLatestRef.current)) pendingPreserveAnchorRef.current = captureCurrentAnchor();
        messageSnapshotChatRef.current = active.id;
        messagesRef.current = nextMessages;
        historyCacheRef.current.retain(`${activeProfileId}:${active.id}`, nextMessages);
        historyCacheRangesRef.current.delete(`${activeProfileId}:${active.id}`);
        historyCacheRangesRef.current.set(`${activeProfileId}:${active.id}`, { start: snapshot.windowStart, total: snapshot.total });
        for (const key of historyCacheRangesRef.current.keys()) if (!historyCacheRef.current.has(key)) historyCacheRangesRef.current.delete(key);
        const incomingNavigationTarget = newlyArrivedIncoming[0];
        if (incomingNavigationTarget && changed) {
          const target = incomingNavigationTarget;
          scheduleIncomingScroll(target.coreId ?? String(target.id), previousDistance);
        }
        if (latestNewMessage?.mine && changed) {
          const latestKey = latestNewMessage.coreId ?? String(latestNewMessage.id);
          if (container && shouldPrepaintOutgoing(previousDistance, container.clientHeight)) {
            setWindowAnchorKey(null);
            deferredOutgoingScrollRef.current = { chatId: active.id, messageKey: latestKey };
          }
        }
        if (changed) setMessages(nextMessages);
        if (pendingScrollRestore.current === active.id) {
          setScrollRestoreTick((tick) => tick + 1);
        }
        if (terminalTransferIds.length) {
          setTransferUiStateOverrides((current) => {
            const next = { ...current };
            let changed = false;
            for (const messageId of terminalTransferIds) {
              if (!(messageId in next)) continue;
              delete next[messageId];
              changed = true;
            }
            return changed ? next : current;
          });
        }
      })
      .catch(() => { if (mounted) setHistoryError(true); })
      .finally(() => { refreshPending = false; if (mounted) setHistoryLoading(false); });
    };
    setHistoryLoading(true);
    refresh();
    const timer = window.setInterval(refresh, 1000);
    return () => { mounted = false; window.clearInterval(timer); };
  }, [active.friendNumber, activeUnreadCount, activeProfileId, loadedHistoryLimit, language, messageRefreshRequest, revealedImages, screen, showReceivedImages, transferUiStateOverrides, incomingRequestsOpen, addContactOpen, historyRequest]);

  useEffect(() => {
    const container = messageScrollRef.current;
    const friendNumber = active.friendNumber;
    if (platformCapabilities.nativeFilesystem || friendNumber === undefined || !container || !displayedChatActiveRef.current) return;
    const generation = viewOwnerRef.current.generation;
    const candidates = new Map<Element, Message>();
    for (const message of messages.slice(messageWindow.start, messageWindow.end)) {
      const attachment = message.attachment;
      if (!message.coreId || !attachment?.image || !attachment.completed || !attachment.path?.startsWith("browser-stream://")
        || !(message.mine || showReceivedImages || revealedImages.includes(message.coreId))) continue;
      const row = messageElement(container, message.coreId);
      if (row) candidates.set(row, message);
    }
    const nearViewport = new Set<Element>();
    const retryAfter = new Map<string, number>();
    let disposed = false;
    const recoverVisible = () => {
      if (disposed || generation !== viewOwnerRef.current.generation) return;
      const nearby = [...nearViewport].flatMap((element) => candidates.get(element) ?? []);
      setTransferPreviewPins(activeProfileId, friendNumber, [...nearby.flatMap((message) => message.attachment?.path ?? []), ...(fullImage?.path ? [fullImage.path] : [])]);
      for (const message of nearby) {
        if (recoveringIncomingFilesRef.current.size >= 2) break;
        const messageId = message.coreId!;
        const path = message.attachment!.path!;
        if (transferPreviewSource(path, activeProfileId, friendNumber) || browserRecoveryAttemptedRef.current.has(path) || recoveringIncomingFilesRef.current.has(messageId) || (retryAfter.get(path) ?? 0) > Date.now()) continue;
        recoveringIncomingFilesRef.current.add(messageId);
        void recoverIncomingTransfer(activeProfileId, messageId, path, friendNumber)
          .then((recovered) => {
            if (!recovered) {
              browserRecoveryAttemptedRef.current.add(path);
              while (browserRecoveryAttemptedRef.current.size > 256) browserRecoveryAttemptedRef.current.delete(browserRecoveryAttemptedRef.current.values().next().value!);
            }
            if (!disposed && generation === viewOwnerRef.current.generation && recovered) setMessageRefreshRequest((value) => value + 1);
          })
          .catch((error) => {
            retryAfter.set(path, Date.now() + 5000);
            if (!disposed && generation === viewOwnerRef.current.generation) setTransferError(messageId, error);
          })
          .finally(() => { recoveringIncomingFilesRef.current.delete(messageId); recoverVisible(); });
      }
    };
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) nearViewport.add(entry.target);
        else nearViewport.delete(entry.target);
      }
      recoverVisible();
    }, { root: container, rootMargin: "100% 0px" });
    for (const element of candidates.keys()) observer.observe(element);
    const timer = window.setInterval(recoverVisible, 2000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      observer.disconnect();
      if (generation !== viewOwnerRef.current.generation) setTransferPreviewPins(activeProfileId, friendNumber, []);
    };
  }, [active.id, active.friendNumber, activeProfileId, messages, messageWindow.start, messageWindow.end, showReceivedImages, revealedImages, viewKey, fullImage]);

  useLayoutEffect(() => {
    if (screen !== "chat" || !active.id) return;
    const navigation = pendingNavigationRef.current;
    const anchor = pendingPreserveAnchorRef.current;
    if (anchor && !navigation && messageSnapshotChatRef.current === active.id && !deferredOutgoingScrollRef.current) {
      restoreViewAnchor(anchor);
      pendingPreserveAnchorRef.current = null;
    } else if (anchor && navigation) {
      pendingPreserveAnchorRef.current = null;
    }
    let navigationFrame: number | undefined;
    let navigationSettleFrame: number | undefined;
    if (navigation && navigation.generation === viewOwnerRef.current.generation) {
      const container = messageScrollRef.current;
      const target = container && messageElement(container, navigation.messageKey);
      if (container && target) {
        const position = () => {
          markAutomaticScroll();
          if (navigation.anchor) restoreViewAnchor(navigation.anchor);
          else scrollMessageWithinContainer(container, target);
        };
        position();
        if (!navigation.anchor?.atBottom) followLatestRef.current = false;
        navigationFrame = scheduleViewFrame(() => {
          if (pendingNavigationRef.current !== navigation || navigation.generation !== viewOwnerRef.current.generation) return;
          position();
          navigationSettleFrame = scheduleViewFrame(() => {
            if (pendingNavigationRef.current !== navigation || navigation.generation !== viewOwnerRef.current.generation) return;
            position();
            const settledAnchor = captureCurrentAnchor();
            if (settledAnchor) scrollAnchorsRef.current[active.id] = settledAnchor;
            cancelPendingMessageNavigation(navigation);
            syncReturnAnchor();
          });
        });
      } else if (Date.now() >= navigation.deadline) {
        cancelPendingMessageNavigation(navigation, true);
      }
    }
    if (deferredOutgoingScrollRef.current?.chatId === active.id) {
      positionPendingOutgoingBeforePaint();
    } else {
      const reading = readingLongIncomingRef.current;
      const maintained = reading?.chatId === active.id && !reading.userScrolled
        ? maintainLongIncomingContext(reading)
        : false;
      if (!maintained && deferredIncomingScrollRef.current?.chatId === active.id) positionPendingIncomingBeforePaint();
    }
    if (followLatestRef.current && !navigation && !readingLongIncomingRef.current && !deferredIncomingScrollRef.current && !pendingScrollRestore.current) {
      const container = messageScrollRef.current;
      if (container) {
        markAutomaticScroll();
        container.scrollTop = container.scrollHeight;
        const settled = captureCurrentAnchor();
        if (settled) scrollAnchorsRef.current[active.id] = settled;
      }
    }
    const frame = scheduleViewFrame(() => {
      if (deferredOutgoingScrollRef.current?.chatId === active.id) {
        positionPendingOutgoingBeforePaint();
        return;
      }
      const reading = readingLongIncomingRef.current;
      if (reading?.chatId === active.id && !reading.userScrolled) {
        if (maintainLongIncomingContext(reading)) return;
      }
      if (deferredIncomingScrollRef.current?.chatId === active.id) flushDeferredIncomingScroll();
    });
    return () => {
      window.cancelAnimationFrame(frame);
      if (navigationFrame !== undefined) window.cancelAnimationFrame(navigationFrame);
      if (navigationSettleFrame !== undefined) window.cancelAnimationFrame(navigationSettleFrame);
    };
  }, [active.id, appearance.interfaceScale, messages, screen, viewportWidth, historyLoading, messageWindow.start, heightMeasurementRevision, scrollRestoreTick]);

  useLayoutEffect(() => {
    const container = messageScrollRef.current;
    if (screen !== "chat" || !active.id || !container || !followLatestRef.current) return;
    const keepLatestVisible = () => {
      markAutomaticScroll();
      container.scrollTop = container.scrollHeight;
    };
    keepLatestVisible();
    const frame = scheduleViewFrame(keepLatestVisible);
    return () => window.cancelAnimationFrame(frame);
  }, [active.id, activePqComposerStage, screen]);

  useEffect(() => {
    if (active.friendNumber === undefined || !localViewAllowed() || localViewAckPendingRef.current?.generation === viewOwnerRef.current.generation || !locallySeenPendingRef.current.size) return;
    const friendNumber = active.friendNumber;
    const generation = viewOwnerRef.current.generation;
    const messageIds = [...locallySeenPendingRef.current];
    const request = { generation };
    localViewAckPendingRef.current = request;
    let failed = false;
    void invoke<UnreadState>("acknowledge_local_messages", { profileId: activeProfileId, friendNumber, messageIds })
      .then((state) => {
        if (generation !== viewOwnerRef.current.generation) return;
        for (const id of messageIds) {
          locallySeenPendingRef.current.delete(id);
          locallyAcknowledgedRef.current.add(id);
        }
        while (locallyAcknowledgedRef.current.size > 1500) locallyAcknowledgedRef.current.delete(locallyAcknowledgedRef.current.values().next().value!);
        unreadMutationRevisionRef.current += 1;
        lastUnreadSnapshot.current = JSON.stringify(state);
        setUnreadFriendCounts(state.friends ?? {});
        setUnreadIncomingRequestKeys(state.requests ?? []);
        trackedUnreadCountRef.current = state.friends?.[String(friendNumber)] ?? 0;
        window.dispatchEvent(new Event("profiles-changed"));
      })
      .catch(() => { failed = true; })
      .finally(() => {
        if (localViewAckPendingRef.current === request) localViewAckPendingRef.current = null;
        if (generation !== viewOwnerRef.current.generation || !locallySeenPendingRef.current.size) return;
        // Messages seen while IPC was pending need their own drain. A failed
        // acknowledgement retains the exact IDs and retries without user scroll.
        window.clearTimeout(localViewAckRetryRef.current);
        localViewAckRetryRef.current = window.setTimeout(() => {
          localViewAckRetryRef.current = undefined;
          if (generation === viewOwnerRef.current.generation) setMessageVisibilityRevision((value) => value + 1);
        }, failed ? 1000 : 0);
      });
  }, [active.friendNumber, messageVisibilityRevision, screen, unreadFriendCounts]);

  useLayoutEffect(() => {
    const container = messageScrollRef.current;
    if (!reactionNotices.length || !container) return;
    const dismissVisible = () => {
      const state = reactionNoticeStoreRef.current[active.id];
      if (!state?.notices.length || !chatViewportAvailable()) return;
      const viewport = container.getBoundingClientRect();
      let next = state;
      for (const notice of state.notices) {
        const bounds = messageElement(container, notice.messageKey)?.getBoundingClientRect();
        if (bounds && isMessageInViewport({ key: notice.messageKey, top: bounds.top, bottom: bounds.bottom }, viewport.top, viewport.height)) next = dismissReactionNotice(next, notice.messageKey);
      }
      if (next === state) return;
      reactionNoticeStoreRef.current[active.id] = next;
      setReactionNotices(next.notices);
      void persistLocalState();
    };
    dismissVisibleReactionsRef.current = dismissVisible;
    const observer = new IntersectionObserver(dismissVisible, { root: container });
    for (const notice of reactionNotices) {
      const element = messageElement(container, notice.messageKey);
      if (element) observer.observe(element);
    }
    dismissVisible();
    window.addEventListener("focus", dismissVisible);
    document.addEventListener("visibilitychange", dismissVisible);
    return () => {
      if (dismissVisibleReactionsRef.current === dismissVisible) dismissVisibleReactionsRef.current = () => {};
      observer.disconnect();
      window.removeEventListener("focus", dismissVisible);
      document.removeEventListener("visibilitychange", dismissVisible);
    };
  }, [active.id, messageVisibilityRevision, messages, reactionNotices, messageWindow.start, messageWindow.end, scrollRestoreTick, historyLoading, screen, fullImage, pendingFiles.length, contactAction, addContactOpen, incomingRequestsOpen]);

  useEffect(() => {
    const refreshView = () => { markVisibleIncomingMessages(); setMessageVisibilityRevision((value) => value + 1); };
    window.addEventListener("focus", refreshView);
    document.addEventListener("visibilitychange", refreshView);
    refreshView();
    return () => { window.removeEventListener("focus", refreshView); document.removeEventListener("visibilitychange", refreshView); };
  }, [active.id, screen, fullImage, pendingFiles.length, contactAction, addContactOpen, incomingRequestsOpen]);

  useLayoutEffect(() => {
    if (screen !== "chat" || pendingScrollRestore.current !== active.id) return;
    const container = messageScrollRef.current;
    if (!container) return;
    if (messageSnapshotChatRef.current !== active.id || historyLoading) return;
    const saved = scrollAnchorsRef.current[active.id];
    if (saved) {
      if (!restoreViewAnchor(saved)) {
        if (historyRequest.targetMessageId !== saved.messageKey && !messageKeys.includes(saved.messageKey)) {
          setLoadedHistoryLimit("all");
          setHistoryRequest({ targetMessageId: saved.messageKey });
          setHistoryLoading(true);
          return;
        }
        if (messageKeys.includes(saved.messageKey)) {
          setWindowAnchorKey(saved.messageKey);
          return;
        }
        container.scrollTop = container.scrollHeight;
      }
    }
    else {
      markAutomaticScroll();
      const boundary = unseenBoundary ? messageElement(container, unseenBoundary) : null;
      if (boundary) container.scrollTop += (boundary.getBoundingClientRect().top - container.getBoundingClientRect().top) / chatGeometryScale(container);
      else container.scrollTop = container.scrollHeight;
    }
    openedChats.current.add(active.id);
    const nextAnchor = captureCurrentAnchor();
    if (nextAnchor) scrollAnchorsRef.current[active.id] = nextAnchor;
    pendingScrollRestore.current = null;
    const distance = container.scrollHeight - container.scrollTop - container.clientHeight;
    historyFarFromLatestRef.current = distance > container.clientHeight * 2;
    setShowJumpToLatest(shouldShowJumpToLatest(distance, container.clientHeight));
  }, [active.id, appearance.interfaceScale, screen, scrollRestoreTick, viewportWidth, historyLoading, unseenBoundary, messageWindow.start]);

  useLayoutEffect(() => {
    if (screen !== "chat" || !active.id) return;
    // Navigation follows laid-out content, independently of whether this window
    // has focus and may acknowledge the incoming messages as locally seen.
    syncUnseenIndicator();
    markVisibleIncomingMessages();
    syncReturnAnchor();
    dismissVisibleReactionsRef.current();
  }, [active.id, appearance.interfaceScale, screen, messages, unreadFriendCounts, messageVisibilityRevision,
    viewportWidth, historyLoading, historyHasAfter, messageWindow.start, messageWindow.end,
    heightMeasurementRevision, scrollRestoreTick, activePqComposerStage]);

  useEffect(() => () => {
    if (deferredIncomingTimerRef.current !== undefined) window.clearTimeout(deferredIncomingTimerRef.current);
    if (messageScrollTimer.current !== undefined) window.clearTimeout(messageScrollTimer.current);
    window.clearTimeout(localViewAckRetryRef.current);
  }, []);

  useEffect(() => {
    const finishPointerScroll = (event: PointerEvent) => {
      if (scrollPointerIdRef.current !== event.pointerId) return;
      scrollPointerIdRef.current = null;
      userScrollActiveRef.current = false;
      userScrollBlockedUntilRef.current = Date.now() + 5000;
      if (deferredIncomingScrollRef.current) armDeferredIncomingScroll(5000);
    };
    document.addEventListener("pointerup", finishPointerScroll);
    document.addEventListener("pointercancel", finishPointerScroll);
    return () => {
      document.removeEventListener("pointerup", finishPointerScroll);
      document.removeEventListener("pointercancel", finishPointerScroll);
    };
  }, [active.id]);

  useEffect(() => {
    void invoke<string>("get_tox_id")
      .then(setOwnToxId)
      .catch((error) => console.error("Не удалось получить Tox ID", error));
  }, []);

  useEffect(() => {
    void invoke<UserStatus>("get_tox_user_status")
      .then(setUserStatus)
      .catch((error) => console.error("Не удалось получить статус Tox", error));
  }, []);

  useEffect(() => {
    void invoke<string>("get_tox_status_message")
      .then(setOwnStatusMessage)
      .catch((error) => console.error("Не удалось получить текст статуса Tox", error));
  }, []);

  useEffect(() => {
    let mounted = true;
    const refresh = () => {
      if (document.visibilityState !== "visible") return;
      void invoke<NetworkStatus>("get_tox_network_status")
      .then((value) => {
        if (!mounted) return;
        // Switching profiles only changes the visible data. Display the actual
        // background connection immediately instead of faking a startup delay.
        const next = value === "offline" ? "offline" : value === "connecting-tor" ? "connecting-tor" : value === "online" ? "online" : "connecting";
        setNetworkStatus((current) => current === next ? current : next);
      })
      .catch(() => {});
    };
    refresh();
    const timer = window.setInterval(refresh, 1000);
    return () => { mounted = false; window.clearInterval(timer); };
  }, []);

  useEffect(() => {
    const previousState = previousTorStateRef.current;
    previousTorStateRef.current = torStatus.state;
    if (torStatus.state !== "connected") {
      setTorDoneVisible(false);
      return;
    }
    if (previousState === "connected") return;
    setTorDoneVisible(true);
    const timeoutId = window.setTimeout(() => setTorDoneVisible(false), 1_400);
    return () => window.clearTimeout(timeoutId);
  }, [torStatus.state]);

  useEffect(() => {
    let mounted = true;
    const refresh = () => {
      if (document.visibilityState !== "visible") return;
      void invoke<TorStatus>("get_tor_status")
      .then((status) => {
        retainTorStatus(status);
        if (mounted) setTorStatus((current) => sameData(current, status) ? current : status);
      })
      .catch((error) => {
        if (mounted) setTorStatus((current) => {
          const next: TorStatus = { ...current, state: "error", message: String(error), progress: 0 };
          retainTorStatus(next);
          return sameData(current, next) ? current : next;
        });
      });
    };
    refresh();
    const timer = window.setInterval(refresh, 1000);
    return () => { mounted = false; window.clearInterval(timer); };
  }, []);

  useEffect(() => {
    let mounted = true;
    void hydratePortableLayout(() => invoke<Record<string, unknown> | null>("load_layout_state")).then((saved) => {
      if (!mounted || !saved) return;
      if (saved.appearance) {
        setAppearance(normalizeAppearance(saved.appearance as AppearanceSettings));
      }
      if (typeof saved.chatListWidth === "number") setChatListWidth(saved.chatListWidth);
      if (Array.isArray(saved.profileOrder) && saved.profileOrder.every((id) => typeof id === "string")) setProfileOrder(saved.profileOrder);
      if (saved.contactSort) setContactSort(normalizeContactSort(saved.contactSort));
      if (typeof saved.hideOfflineContacts === "boolean") setHideOfflineContacts(saved.hideOfflineContacts);
      setLayoutHydrated(true);
    }).catch((error) => {
      console.error("Не удалось загрузить общую компоновку интерфейса", error);
    });
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    if (!layoutHydrated) return;
    const state = { appearance, chatListWidth, profileOrder, contactSort, hideOfflineContacts };
    retainPortableLayoutPatch(state);
    const timer = window.setTimeout(() => {
      void savePortableLayoutPatch(state, (sharedLayoutState) => invoke("save_layout_state", { state: sharedLayoutState }))
        .catch((error) => console.error("Не удалось сохранить общую компоновку интерфейса", error));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [appearance, chatListWidth, contactSort, hideOfflineContacts, layoutHydrated, profileOrder]);

  useEffect(() => {
    let mounted = true;
    if (!activeProfileId) {
      setPersistenceReady(true);
      return () => { mounted = false; };
    }
    void invoke<LocalState | null>("load_local_state", { profileId: activeProfileId })
      .then((saved) => {
        if (!mounted) return;
        if (!saved) {
          setSpellcheckEnabled(true);
          setSpellcheckRussian(true);
          return;
        }
        if (saved.activeChat) setActiveChat(saved.activeChat);
        if (typeof saved.sendOnEnter === "boolean") setSendOnEnter(saved.sendOnEnter);
        // The mounted profile summary is derived from its own self-avatar file.
        // Never let an older local-state race override that profile identity.
        // The profile registry/Tox savedata is authoritative for the name too.
        if (saved.contactNames) setContactNames(saved.contactNames);
        if (typeof saved.autoDownloadImages === "boolean") setAutoDownloadImages(saved.autoDownloadImages);
        if (typeof saved.saveChatHistory === "boolean") setSaveChatHistory(saved.saveChatHistory);
        if (Array.isArray(saved.outgoingFriendRequests)) setOutgoingFriendRequests(saved.outgoingFriendRequests);
        if (saved.drafts && typeof saved.drafts === "object") draftsRef.current = { ...saved.drafts };
        if (saved.draftFormatting && typeof saved.draftFormatting === "object") draftFormattingRef.current = { ...saved.draftFormatting };
        if (saved.draftQuotes && typeof saved.draftQuotes === "object") draftQuotesRef.current = { ...saved.draftQuotes };
        if (saved.pendingSendOperations && typeof saved.pendingSendOperations === "object") {
          pendingSendOperationsRef.current = { ...saved.pendingSendOperations };
          setFailedSends(Object.values(saved.pendingSendOperations).filter((operation) => operation.profileId === activeProfileId));
        }
        if (saved.scrollAnchors && typeof saved.scrollAnchors === "object") scrollAnchorsRef.current = { ...saved.scrollAnchors };
        reactionNoticeStoreRef.current = restoreReactionNotices(saved.peerReactionNotices);
        reactionNoticeDurableCursorRef.current = Object.fromEntries(Object.entries(reactionNoticeStoreRef.current).map(([key, state]) => [key, state.through]));
        setReactionNotices(reactionNoticeStoreRef.current[saved.activeChat ?? activeChatRef.current]?.notices ?? []);
        if (saved.historyMessageLimit !== undefined) setHistoryMessageLimit(normalizeHistoryMessageLimit(saved.historyMessageLimit));
        if (typeof saved.notifyMessages === "boolean") setNotifyMessages(saved.notifyMessages);
        if (typeof saved.notifyRequests === "boolean") setNotifyRequests(saved.notifyRequests);
        setSpellcheckEnabled(saved.spellcheckEnabled ?? true);
        setSpellcheckRussian(saved.spellcheckRussian ?? true);
        setSpellcheckEnglish(saved.spellcheckEnglish ?? false);
      })
      .catch((error) => console.error("Не удалось загрузить локальные данные", error))
      .finally(() => { if (mounted) setPersistenceReady(true); });
    return () => { mounted = false; };
  }, [activeProfileId]);

  useEffect(() => {
    if (!persistenceReady) return;
    const timer = window.setTimeout(() => {
      void persistLocalState();
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [activeChat, autoDownloadImages, contactNames, historyMessageLimit, notifyMessages, notifyRequests, outgoingFriendRequests, persistenceReady, persistLocalState, saveChatHistory, sendOnEnter, spellcheckEnabled, spellcheckEnglish, spellcheckRussian]);

  useEffect(() => {
    return () => {
      if (draftCommitTimer.current !== undefined) window.clearTimeout(draftCommitTimer.current);
      if (draftMaxCommitTimer.current !== undefined) window.clearTimeout(draftMaxCommitTimer.current);
    };
  }, []);

  useEffect(() => {
    if (!persistenceReady) return;
    void invoke("set_chat_history_enabled", { enabled: saveChatHistory }).catch((error) => console.error("Не удалось применить настройку истории", error));
  }, [persistenceReady, saveChatHistory]);

  function saveOwnStatusMessage() {
    const value = normalizeOwnStatusMessage(ownStatusMessage);
    setOwnStatusMessage(value);
    setEditingOwnStatusMessage(false);
    void invoke<string>("set_tox_status_message", { message: value })
      .then(setOwnStatusMessage)
      .catch((error) => console.error("Не удалось обновить текст статуса Tox", error));
  }

  async function changeProfileStatus(profileId: string, status: UserStatus) {
    await onProfileStatusChange(profileId, status);
    if (profileId === activeProfileId) {
      setUserStatus(status);
      setStatusMenuOpen(false);
      if (status === "offline") {
        setNetworkStatus("offline");
      } else if (networkStatus === "offline") {
        setNetworkStatus("connecting");
      }
    }
  }

  function changeUserStatus(status: UserStatus) {
    if (!activeProfileId) return;
    void changeProfileStatus(activeProfileId, status)
      .catch((error) => {
        setStatusMenuOpen(false);
        console.error("Не удалось изменить статус Tox", error);
      });
  }

  useEffect(() => {
    if (!persistenceReady) return;
    void invoke("set_tox_nickname", { nickname: profileName })
      .then(() => window.dispatchEvent(new Event("profiles-changed")))
      .catch((error) => console.error("Не удалось обновить ник Tox", error));
  }, [persistenceReady, profileName]);

  useEffect(() => {
    const tokens = pendingFiles.flatMap((file) => file.grantToken ? [file.grantToken] : []);
    if (!tokens.length) return;
    return () => {
      for (const grantToken of tokens) void invoke("discard_native_file_grant", { grantToken }).catch(() => {});
    };
  }, [pendingFiles]);

  useEffect(() => {
    if (platformCapabilities.nativeFilesystem) return;
    const onDragOver = (event: DragEvent) => {
      if (!hasFileDragType(event.dataTransfer?.types)) return;
      event.preventDefault();
      if (canStageFileForActiveChat) keepFileDragReady();
    };
    const onDrop = (event: DragEvent) => {
      if (!hasFileDragType(event.dataTransfer?.types)) return;
      event.preventDefault();
      resetFileDrag();
      if (canStageFileForActiveChat && event.dataTransfer?.files) stageFiles(event.dataTransfer.files);
    };
    const onDragEnd = () => resetFileDrag();
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    window.addEventListener("dragleave", onDragEnd);
    window.addEventListener("blur", onDragEnd);
    document.addEventListener("dragend", onDragEnd);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
      window.removeEventListener("dragleave", onDragEnd);
      window.removeEventListener("blur", onDragEnd);
      document.removeEventListener("dragend", onDragEnd);
    };
  }, [canStageFileForActiveChat, keepFileDragReady, resetFileDrag, stageFiles]);

  useEffect(() => {
    if (!platformCapabilities.nativeFilesystem) return;
    const target = activeFileTargetRef.current;
    void invoke("set_native_file_drop_target", {
      profileId: target?.profileId ?? null,
      friendNumber: target?.friendNumber ?? null,
    }).catch((error) => console.error("Не удалось обновить цель нативного drag-and-drop", error));
  }, [activeFileTarget?.friendNumber, activeFileTarget?.profileId]);

  useEffect(() => {
    if (!platformCapabilities.nativeFilesystem) return;
    let disposed = false;
    const unlisten: Array<() => void> = [];
    const registrations = [
      listen<string>("native-file-drag-state", (event) => {
        if (disposed) return;
        if (event.payload === "over") {
          if (activeFileTargetRef.current) keepFileDragReady();
        } else {
          resetFileDrag();
        }
      }),
      listen<NativeFileDropBatch>("native-file-drop-ready", (event) => {
        resetFileDrag();
        const target = activeFileTargetRef.current;
        const matches = target !== null
          && target.profileId === event.payload.profileId
          && target.friendNumber === event.payload.friendNumber;
        if (disposed || !matches) {
          discardNativeSelections(event.payload.batch.accepted);
          return;
        }
        stageNativeFileBatch(event.payload.batch, target);
      }),
      listen<string>("native-file-drop-error", (event) => {
        resetFileDrag();
        if (disposed || !activeFileTargetRef.current) return;
        showTransferNotice(formatUserFacingError(event.payload, {
          ru: "Не удалось подготовить файлы",
          en: "Could not prepare the files",
        }, language));
      }),
    ];
    for (const registration of registrations) {
      void registration.then((dispose) => {
        if (disposed) dispose();
        else unlisten.push(dispose);
      }).catch((error) => console.error("Не удалось включить нативный drag-and-drop", error));
    }
    return () => {
      disposed = true;
      for (const dispose of unlisten) dispose();
    };
  }, [discardNativeSelections, keepFileDragReady, language, resetFileDrag, stageNativeFileBatch]);

  useEffect(() => {
    nativeFilePickRevisionRef.current += 1;
    setIsDraggingFile(false);
    resetFileDrag();
    setPendingFiles([]);
    setFileSendError(null);
    fileSendBusyRef.current = false;
    setFileSendBusy(false);
  }, [active.friendNumber, active.id, activeProfileId, addContactOpen, incomingRequestsOpen, resetFileDrag, screen]);

  useEffect(() => () => {
    activeFileTargetRef.current = null;
    nativeFilePickRevisionRef.current += 1;
    resetFileDrag();
    if (platformCapabilities.nativeFilesystem) {
      void invoke("set_native_file_drop_target", { profileId: null, friendNumber: null }).catch(() => {});
    }
  }, [resetFileDrag]);

  const scheduleDraftSave = useCallback(() => {
    if (draftCommitTimer.current !== undefined) window.clearTimeout(draftCommitTimer.current);
    draftCommitTimer.current = window.setTimeout(() => {
      draftCommitTimer.current = undefined;
      if (draftMaxCommitTimer.current !== undefined) window.clearTimeout(draftMaxCommitTimer.current);
      draftMaxCommitTimer.current = undefined;
      void persistLocalState();
    }, 1500);
    if (draftMaxCommitTimer.current === undefined) {
      draftMaxCommitTimer.current = window.setTimeout(() => {
        draftMaxCommitTimer.current = undefined;
        void persistLocalState();
      }, 10000);
    }
  }, [persistLocalState]);

  const updateDraft = useCallback((chatId: string, value: string) => {
    if (value) draftsRef.current[chatId] = value;
    else delete draftsRef.current[chatId];
    scheduleDraftSave();
  }, [scheduleDraftSave]);

  const updateDraftFormatting = useCallback((chatId: string, formatting: readonly ChatFormattingSpan[]) => {
    if (formatting.length) draftFormattingRef.current[chatId] = [...formatting];
    else delete draftFormattingRef.current[chatId];
    scheduleDraftSave();
  }, [scheduleDraftSave]);

  const cancelReply = useCallback(() => {
    delete draftQuotesRef.current[activeChatRef.current];
    setReplyQuote(null);
    scheduleDraftSave();
  }, [scheduleDraftSave]);

  async function submitSendOperation(operation: PendingSend): Promise<boolean> {
    try {
      const { chatId: _chatId, ...args } = operation;
      const result = await invoke<SendResult>("send_tox_message", args);
      delete pendingSendOperationsRef.current[operation.operationId];
      void persistLocalState();
      setFailedSends((items) => items.filter((item) => item.operationId !== operation.operationId));
      if (activeChatRef.current === operation.chatId) {
        setPromotedActivityId(operation.chatId);
        setMessageRefreshRequest((current) => current + 1);
        void refreshPqStatus(operation.friendNumber).catch(() => {});
        const container = messageScrollRef.current;
        if (container && !shouldPrepaintOutgoing(container.scrollHeight - container.scrollTop - container.clientHeight, container.clientHeight)) {
          showTransferNotice(language === "ru" ? "Сообщение в очереди" : "Message queued");
          setPendingSentMessage(result.messageId);
        }
      }
      return true;
    } catch (error) {
      setFailedSends((items) => items.some((item) => item.operationId === operation.operationId) ? items : [...items, operation]);
      showTransferNotice(formatPqUserFacingError(error, { ru: "Не удалось отправить сообщение", en: "Could not send the message" }, language));
      return false;
    }
  }

  async function sendMessage(text: string, formatting?: readonly ChatFormattingSpan[], reply?: ChatQuote | null): Promise<boolean> {
    if (!text.trim() || active.friendNumber === undefined || !activeProfileId) return false;
    const operation: PendingSend = { operationId: crypto.randomUUID(), profileId: activeProfileId, friendNumber: active.friendNumber, chatId: active.id, text, formatting: chatCapabilities.formatting ? formatting : [], quote: reply ?? replyQuote ?? undefined };
    pendingSendOperationsRef.current[operation.operationId] = operation;
    delete draftsRef.current[active.id];
    delete draftFormattingRef.current[active.id];
    delete draftQuotesRef.current[active.id];
    setReplyQuote(null);
    void persistLocalState();
    return submitSendOperation(operation);
  }
  sendMessageRef.current = sendMessage;

  function showContactsScrollbar() {
    setContactsScrollActive(true);
    window.clearTimeout(contactsScrollTimer.current);
    contactsScrollTimer.current = window.setTimeout(() => setContactsScrollActive(false), 850);
  }

  function resizeChatList(clientX: number) {
    const shell = document.querySelector<HTMLElement>(".app-shell");
    const shellLeft = shell?.getBoundingClientRect().left ?? 0;
    const scale = appearance.interfaceScale / 100;
    const localX = (clientX - shellLeft) / scale;
    const maximum = Math.min(
      SIDEBAR_MAX_REQUESTED_WIDTH,
      Math.max(SIDEBAR_MIN_REQUESTED_WIDTH, layoutWidth - APP_RAIL_WIDTH - minimumContentWidth),
    );
    setChatListWidth(Math.max(
      SIDEBAR_MIN_REQUESTED_WIDTH,
      Math.min(maximum, localX - APP_RAIL_WIDTH),
    ));
  }

  function finishChatListResize() {
    isResizingListRef.current = false;
    setIsResizingList(false);
  }

  const pickNativeFile = useCallback(() => {
    const target = activeFileTargetRef.current;
    if (!target) return;
    const revision = ++nativeFilePickRevisionRef.current;
    void invoke<NativeFileBatchSelection>("pick_tox_files", { friendNumber: target.friendNumber }).then((batch) => {
      if (!batch.selectedCount) return;
      if (revision !== nativeFilePickRevisionRef.current || !sameChatFileTarget(activeFileTargetRef.current, target)) {
        discardNativeSelections(batch.accepted);
        return;
      }
      stageNativeFileBatch(batch, target);
    }).catch((error) => {
      if (revision !== nativeFilePickRevisionRef.current || !sameChatFileTarget(activeFileTargetRef.current, target)) return;
      showTransferNotice(formatUserFacingError(error, { ru: "Не удалось подготовить файл", en: "Could not prepare the file" }, language));
    });
  }, [discardNativeSelections, language, stageNativeFileBatch]);

  function clearPendingFile() {
    nativeFilePickRevisionRef.current += 1;
    setPendingFiles([]);
    setFileSendError(null);
  }

  function formatFileSize(bytes: number) {
    if (bytes <= 0) return language === "en" ? "0 B" : "0 Б";
    return bytes < 1024 * 1024
      ? `${Math.max(1, Math.round(bytes / 1024))} ${language === "en" ? "KB" : "КБ"}`
      : `${(bytes / (1024 * 1024)).toFixed(1)} ${language === "en" ? "MB" : "МБ"}`;
  }

  function formatTransferEta(seconds?: number | null) {
    if (!seconds || seconds < 1) return language === "en" ? "estimating time…" : "оценка времени…";
    if (seconds < 60) return language === "en" ? `${Math.ceil(seconds)} s left` : `осталось ${Math.ceil(seconds)} с`;
    return language === "en"
      ? `${Math.floor(seconds / 60)} min ${Math.ceil(seconds % 60)} s left`
      : `осталось ${Math.floor(seconds / 60)} мин ${Math.ceil(seconds % 60)} с`;
  }

  function deliveryReceiptTitle(message: Message) {
    const timestamp = formatChatDate(new Date((message.deliveredAt ?? 0) * 1000), language, "receipt");
    return formatDeliveryReceiptTitle(message.attachment ? "file" : "message", timestamp, language);
  }

  function attachmentProgress(attachment: Attachment) {
    return Math.max(0, Math.min(100, Math.round(((attachment.transferred ?? 0) / Math.max(1, attachment.size)) * 100)));
  }

  function attachmentTransferText(attachment: Attachment, mine: boolean) {
    if (attachment.transferState === "uploading") return language === "ru" ? "Загрузка файла на сервер" : "Uploading file to server";
    if (attachment.transferState === "queued") return mine ? "Ожидает отправки" : "Ожидает получения";
    if (attachment.transferState === "awaiting_confirmation") return mine ? "Файл отправлен, ожидается подтверждение получателя" : "Файл ожидает вашего подтверждения";
    if (attachment.transferState === "paused") return mine ? "Передача приостановлена" : "Получение приостановлено";
    if (attachment.transferState === "cancelled") return mine ? "Передача отменена" : "Получение отменено";
    if (attachment.transferState === "failed") return formatUserFacingError(attachment.error, { ru: "Передача не завершена", en: "File transfer failed" }, language);
    const action = t(mine ? "Отправка" : "Получение");
    const speed = attachment.speed ?? 0;
    return speed
      ? `${action}: ${formatFileSize(speed)}/${language === "en" ? "s" : "с"} · ${formatTransferEta(attachment.eta)}`
      : `${action}: ${language === "en"
        ? (mine ? "waiting for the recipient…" : "waiting for data…")
        : (mine ? "ожидание получателя…" : "ожидание данных…")}`;
  }

  function attachmentTransferTitle(attachment: Attachment, mine: boolean) {
    if (attachment.transferState === "uploading") return language === "ru" ? "Загрузка файла на сервер" : "Uploading file to server";
    if (attachment.transferState === "queued") return mine ? "Ожидает отправки" : "Ожидает получения";
    if (attachment.transferState === "awaiting_confirmation") return "Ожидание подтверждения";
    if (attachment.transferState === "paused") return mine ? "Передача приостановлена" : "Получение приостановлено";
    if (attachment.transferState === "cancelled") {
      return attachment.error
        ? formatUserFacingError(attachment.error, mine
          ? { ru: "Передача отменена получателем", en: "The recipient cancelled the transfer" }
          : { ru: "Передача отменена отправителем", en: "The sender cancelled the transfer" }, language)
        : (mine ? "Передача отменена" : "Получение отменено");
    }
    if (attachment.transferState === "failed") return "Ошибка передачи";
    return mine ? "Отправка файла" : "Получение файла";
  }

  function setTransferError(messageId: string, error: unknown) {
    setTransferErrors((current) => ({ ...current, [messageId]: String(error) }));
  }

  function clearTransferError(messageId: string) {
    setTransferErrors((current) => {
      const next = { ...current };
      delete next[messageId];
      return next;
    });
  }

  function downloadWebAttachment(message: Message) {
    if (!message.coreId || !message.attachment?.path || active.friendNumber === undefined) return;
    const messageId = message.coreId;
    setGeneralContext(null);
    void invoke("download_web_transfer", {
      profileId: activeProfileId, friendNumber: active.friendNumber,
      messageId, path: message.attachment.path,
    }).catch((error) => showTransferNotice(formatUserFacingError(error,
      { ru: "Не удалось скачать файл", en: "Could not download file" }, language)));
  }

  function revealAttachmentImage(message: Message) {
    if (!message.coreId || !message.attachment) return;
    setRevealedImages((current) => current.includes(message.coreId!) ? current : [...current, message.coreId!]);
    const attachmentPath = message.attachment.path;
    if (attachmentPath?.startsWith("browser-stream://")) {
      browserRecoveryAttemptedRef.current.delete(attachmentPath);
      clearTransferError(message.coreId);
      setMessageRefreshRequest((current) => current + 1);
    }
  }

  function setLocalTransferState(
    messageId: string,
    transferState: NonNullable<Attachment["transferState"]>,
  ) {
    setMessages((current) => current.map((item) => {
      if (item.coreId !== messageId || !item.attachment) return item;
      return {
        ...item,
        attachment: { ...item.attachment, transferState },
      };
    }));
  }

  function controlAttachmentTransfer(message: Message, action: "pause" | "resume" | "cancel") {
    if (active.friendNumber === undefined || !message.coreId) return;
    const transferProfileId = activeProfileId;
    const previousState = message.attachment?.transferState;
    const previousOverride = transferUiStateOverrides[message.coreId];
    const nextState = action === "pause"
      ? "paused"
      : action === "resume"
        ? (message.mine ? "sending" : "receiving")
        : "cancelled";

    // Keep the user's requested state across polling updates. Without this
    // override a stale toxcore snapshot can immediately flip the button back.
    setTransferUiStateOverrides((current) => ({
      ...current,
      [message.coreId!]: nextState,
    }));
    setLocalTransferState(message.coreId, nextState);
    clearTransferError(message.coreId);
    void invoke("control_tox_file_transfer", {
      profileId: transferProfileId,
      friendNumber: active.friendNumber,
      messageId: message.coreId,
      action,
    }).then(() => {
      clearTransferError(message.coreId!);
    }).catch((error) => {

    // Если пользователь нажал «Пауза» в самый момент завершения, toxcore
    // может уже удалить активную передачу и вернуть code 6. Это не отмена и
    // не ошибка файла: финальный снимок от ядра должен пометить его полученным.
    if (
      action === "pause" &&
      /active transfer was not found|transfer.*not active|code 6/i.test(String(error))
    ) {
        clearTransferError(message.coreId!);
        return;
      }
      setTransferUiStateOverrides((current) => {
        const next = { ...current };
        if (previousOverride) next[message.coreId!] = previousOverride;
        else delete next[message.coreId!];
        return next;
      });
      if (previousState) setLocalTransferState(message.coreId!, previousState);
      setTransferError(message.coreId!, error);
    });
  }

  function retryAttachmentTransfer(message: Message) {
    if (active.friendNumber === undefined || !message.coreId) return;
    const transferProfileId = activeProfileId;
    setTransferUiStateOverrides((current) => {
      if (!(message.coreId! in current)) return current;
      const next = { ...current };
      delete next[message.coreId!];
      return next;
    });
    void invoke("retry_tox_file_transfer", {
      profileId: transferProfileId,
      friendNumber: active.friendNumber,
      messageId: message.coreId,
    }).then(() => clearTransferError(message.coreId!)).catch((error) => setTransferError(message.coreId!, error));
  }

  async function confirmFileSend() {
    if (!pendingFiles.length || fileSendBusyRef.current) return;
    if (!activeFileTarget || !pendingFiles.every((file) => sameChatFileTarget(activeFileTarget, file))) {
      clearPendingFile();
      return;
    }
    fileSendBusyRef.current = true;
    setFileSendBusy(true);
    try {
      setFileSendError(null);
      const failed: PendingChatFile[] = [];
      const failureNotices: string[] = [];
      let queued = 0;
      for (const selection of pendingFiles) {
        try {
          await sendFile(selection.profileId, selection.friendNumber, selection.file, selection.grantToken);
          queued += 1;
        } catch (error) {
          failed.push(selection);
          failureNotices.push(`${selection.file.name}: ${formatUserFacingError(error, { ru: "не удалось добавить файл в очередь", en: "could not queue the file" }, language)}`);
        }
      }
      if (failureNotices.length) setFileSendError(failureNotices.join("\n"));
      if (queued > 0) setMessageRefreshRequest((current) => current + 1);
      if (!failed.length) {
        clearPendingFile();
        return;
      }
      if (failed.length !== pendingFiles.length) setPendingFiles(failed);
    } finally {
      fileSendBusyRef.current = false;
      setFileSendBusy(false);
    }
  }

  function updateProfileAvatar(avatar: string | null) {
    if (!activeProfileId) return;
    const revision = ++avatarUpdateRevisionRef.current;
    void (async () => {
      const normalized = avatar ? await normalizeProfileAvatar(avatar) : null;
      if (avatarUpdateRevisionRef.current !== revision) return;
      await invoke("set_profile_avatar", {
        profileId: activeProfileId,
        dataUrl: normalized?.dataUrl ?? null,
        filename: normalized ? "avatar.png" : null,
        bytes: normalized?.bytes ?? null,
      });
      if (avatarUpdateRevisionRef.current !== revision) return;
      setProfileAvatar(normalized?.dataUrl ?? null);
      window.dispatchEvent(new Event("profiles-changed"));
    })().catch((error) => showTransferNotice(formatUserFacingError(error, {
      ru: "Не удалось обновить аватар профиля",
      en: "Could not update the profile avatar",
    }, language)));
  }

  function showAttachmentInFolder(path: string | undefined) {
    if (!path) return;
    void invoke("show_attachment_in_folder", { path })
      .then(() => setGeneralContext(null))
      .catch((error) => showTransferNotice(formatUserFacingError(error, { ru: "Не удалось показать файл в папке", en: "Could not show the file in its folder" }, language)));
  }

  function copyAttachmentToClipboard(path: string | undefined, image: boolean) {
    if (!path) return;
    const operation = image
      ? !platformCapabilities.nativeFilesystem
        ? copyDecodedImage(path)
        : copyDecodedImage(path).catch(() => invoke("copy_attachment_to_clipboard", { path, image: true }))
      : invoke("copy_attachment_to_clipboard", { path, image: false });
    void operation
      .then(() => {
        setGeneralContext(null);
        showTransferNotice(t(image ? "Изображение скопировано в буфер обмена" : "Файл скопирован в буфер обмена"));
      })
      .catch((error) => showTransferNotice(formatUserFacingError(error, image
        ? { ru: "Не удалось скопировать изображение", en: "Could not copy the image" }
        : { ru: "Не удалось скопировать файл", en: "Could not copy the file" }, language)));
  }

  function openSettings(tab: SettingsOpenRequest["tab"]) {
    setAddContactOpen(false);
    setIncomingRequestsOpen(false);
    setStatusMenuOpen(false);
    setProfileMenuOpen(false);
    setScreen("settings");
    setSettingsOpenRequest((request) => ({ tab, nonce: request.nonce + 1 }));
  }

  function openProfileSettings() {
    openSettings("profile");
  }

  function exitApplication() {
    setProfileMenuOpen(false);
    void persistLocalState(true)
      .then(() => invoke("exit_application"))
      .catch((error) => showTransferNotice(formatUserFacingError(error, {
        ru: "Не удалось закрыть приложение",
        en: "Could not close the application",
      }, language)));
  }

  function openDownloadsFolder() {
    void invoke("open_downloads_directory")
      .catch((error) => showTransferNotice(formatUserFacingError(error, { ru: "Не удалось открыть папку downloads", en: "Could not open the downloads folder" }, language)));
  }

  function updatePqStatus(command: "request_pq_session" | "withdraw_pq_session" | "accept_pq_session" | "reject_pq_session" | "request_pq_shutdown") {
    if (active.friendNumber === undefined) return;
    const friendNumber = active.friendNumber;
    void invoke<PqStatus>(command, { friendNumber })
      .then((status) => {
        setPqStatuses((current) => ({ ...current, [friendNumber]: status }));
        setMessageRefreshRequest((current) => current + 1);
      })
      .catch((error) => {
        setPqStatuses((current) => ({
          ...current,
          [friendNumber]: {
            ...(current[friendNumber] ?? { supported: false, state: "error", local_fingerprint: "", peer_fingerprint: null, fingerprint_changed: false, identity_needs_entropy: false, identity_waiting: false, auto_pending: false, protocol_version: 0 }),
            state: "error",
            error: String(error),
          },
        }));
        showTransferNotice(formatPqUserFacingError(error, { ru: "Не удалось изменить состояние PQ", en: "Could not change the PQ state" }, language));
      });
  }

  function clearDeferredIncomingScroll() {
    if (deferredIncomingTimerRef.current !== undefined) window.clearTimeout(deferredIncomingTimerRef.current);
    deferredIncomingTimerRef.current = undefined;
    deferredIncomingScrollRef.current = null;
  }

  function messageElement(container: HTMLDivElement, messageKey: string) {
    return container.querySelector<HTMLElement>(`[data-message-key="${CSS.escape(messageKey)}"]`);
  }

  function captureCurrentAnchor(): ChatViewAnchor | null {
    const container = messageScrollRef.current;
    if (!container || messageSnapshotChatRef.current !== active.id) return null;
    const box = container.getBoundingClientRect();
    const rows = Array.from(container.querySelectorAll<HTMLElement>("[data-message-key]")).map((element) => {
      const row = element.getBoundingClientRect();
      return { key: element.dataset.messageKey!, top: row.top, bottom: row.bottom };
    });
    return captureChatAnchor(rows, box.top, box.height, container.scrollHeight - container.scrollTop - container.clientHeight);
  }

  function restoreViewAnchor(anchor: ChatViewAnchor): boolean {
    const container = messageScrollRef.current;
    if (!container) return false;
    if (anchor.atBottom) {
      markAutomaticScroll();
      container.scrollTop = container.scrollHeight;
      followLatestRef.current = true;
      return true;
    }
    const row = messageElement(container, anchor.messageKey);
    if (!row) return false;
    const delta = anchorScrollDelta(anchor, row.getBoundingClientRect().top, container.getBoundingClientRect().top) / chatGeometryScale(container);
    if (Math.abs(delta) > .5) { markAutomaticScroll(); container.scrollTop += delta; }
    followLatestRef.current = false;
    const settled = captureCurrentAnchor();
    if (settled) scrollAnchorsRef.current[active.id] = settled;
    return true;
  }

  function cancelPendingMessageNavigation(
    expected?: NonNullable<typeof pendingNavigationRef.current>,
    unavailable = false,
  ) {
    if (expected && pendingNavigationRef.current !== expected) return;
    pendingNavigationRef.current = null;
    if (pendingNavigationTimerRef.current !== undefined) {
      window.clearTimeout(pendingNavigationTimerRef.current);
      pendingNavigationTimerRef.current = undefined;
    }
    if (unavailable) showTransferNotice(language === "ru" ? "Сообщение недоступно" : "Message is unavailable");
  }

  function beginPendingMessageNavigation(messageKey: string, anchor?: ChatViewAnchor) {
    cancelPendingMessageNavigation();
    const navigation = { messageKey, generation: viewOwnerRef.current.generation, deadline: Date.now() + 15_000, anchor };
    pendingNavigationRef.current = navigation;
    pendingNavigationTimerRef.current = window.setTimeout(() => cancelPendingMessageNavigation(navigation, true), 15_000);
  }

  function jumpToMessageKey(messageKey: string, remember = true) {
    if (remember) setReturnAnchor((current) => current ?? captureCurrentAnchor());
    cancelPendingMessageNavigation();
    clearDeferredIncomingScroll();
    deferredOutgoingScrollRef.current = null;
    readingLongIncomingRef.current = null;
    followLatestRef.current = false;
    setWindowAnchorKey(messageKey);
    beginPendingMessageNavigation(messageKey);
    const container = messageScrollRef.current;
    const target = container && messageElement(container, messageKey);
    if (container && target) {
      markAutomaticScroll();
      scrollMessageWithinContainer(container, target, "smooth");
      setScrollRestoreTick((value) => value + 1);
      return;
    }
    if (!messageKeys.includes(messageKey)) {
      setHistoryLoading(true);
      setLoadedHistoryLimit("all");
      setHistoryRequest({ targetMessageId: messageKey });
      setMessageRefreshRequest((value) => value + 1);
    }
  }

  function loadOlderHistory() {
    if (historyLoading || !historyHasMore) return;
    pendingPreserveAnchorRef.current = captureCurrentAnchor();
    setHistoryLoading(true);
    setLoadedHistoryLimit(nextHistoryMessageLimit(loadedHistoryLimit));
    setHistoryRequest({ rangeOffset: Math.max(0, historyWindowStart - 500) });
  }

  function returnToReadingPosition() {
    const anchor = returnAnchor;
    if (!anchor) return;
    setReturnAnchor(null);
    cancelPendingMessageNavigation();
    clearDeferredIncomingScroll();
    deferredOutgoingScrollRef.current = null;
    readingLongIncomingRef.current = null;
    if (anchor.atBottom) { scrollToBottomGuaranteed(); return; }
    if (restoreViewAnchor(anchor)) return;
    jumpToMessageKey(anchor.messageKey, false);
    beginPendingMessageNavigation(anchor.messageKey, anchor);
  }

  function prefetchHistoryAround(globalIndex: number, anchor: ChatViewAnchor | null) {
    if (historyLoading || historyTotal === 0) return;
    const margin = Math.min(100, Math.floor(messages.length / 4));
    const nearBefore = globalIndex < historyWindowStart + margin && historyHasMore;
    const nearAfter = globalIndex > historyWindowStart + messages.length - margin && historyHasAfter;
    if (!nearBefore && !nearAfter) return;
    const nextLimit = nearBefore ? nextHistoryMessageLimit(loadedHistoryLimit) : loadedHistoryLimit;
    const permittedStart = Math.max(0, historyTotal - (nextLimit === "all" ? historyTotal : nextLimit));
    const offset = Math.max(permittedStart, globalIndex - 250);
    pendingPreserveAnchorRef.current = anchor;
    if (!anchor) pendingHistoryIndexRef.current = globalIndex;
    setHistoryLoading(true);
    setLoadedHistoryLimit(nextLimit);
    setHistoryRequest({ rangeOffset: offset });
  }

  function chatViewportAvailable(): boolean {
    const container = messageScrollRef.current;
    const view = chatVisibilityRef.current;
    return mayAcknowledgeLocalView({
      visible: document.visibilityState === "visible",
      // Spatial visibility is also used by offscreen reaction notices. An
      // unfocused visible window is not an offscreen viewport.
      focused: true,
      chatOpen: view.chatOpen && messageSnapshotChatRef.current === view.activeId,
      overlayOpen: view.overlayOpen,
      geometryReady: !!container && container.clientHeight > 0 && pendingScrollRestore.current !== view.activeId,
    });
  }

  function localViewAllowed(): boolean {
    return document.hasFocus() && chatViewportAvailable();
  }

  function chatGeometryScale(container: HTMLElement): number {
    return elementGeometryScale(container);
  }

  function syncReturnAnchor() {
    const anchor = returnAnchorRef.current;
    if (!anchor || pendingNavigationRef.current || !chatViewportAvailable()) return;
    const container = messageScrollRef.current!;
    const distance = container.scrollHeight - container.scrollTop - container.clientHeight;
    const row = messageElement(container, anchor.messageKey);
    const reached = anchor.atBottom ? distance <= 10 : !!row
      && Math.abs(anchorScrollDelta(anchor, row.getBoundingClientRect().top, container.getBoundingClientRect().top)) <= 12 * chatGeometryScale(container);
    if (reached) setReturnAnchor((current) => current === anchor ? null : current);
  }

  notificationVisibleRef.current = (chatId, messageId) => {
    if (activeChatRef.current !== chatId || !messageId || !localViewAllowed()) return false;
    const container = messageScrollRef.current;
    const row = container && messageElement(container, messageId);
    if (!container || !row) return false;
    const viewport = container.getBoundingClientRect();
    const bounds = row.getBoundingClientRect();
    return isMessageInViewport({ key: messageId, top: bounds.top, bottom: bounds.bottom }, viewport.top, viewport.height);
  };

  function registerUnseenIncoming(messageKeys: string[]) {
    for (const key of messageKeys) if (!locallySeenPendingRef.current.has(key) && !locallyAcknowledgedRef.current.has(key)) unseenIncomingKeysRef.current.add(key);
  }

  function syncUnseenIndicator() {
    const container = messageScrollRef.current;
    if (!container || messageSnapshotChatRef.current !== active.id || pendingScrollRestore.current === active.id) {
      setPendingIncomingCount(0);
      setShowJumpToLatest(false);
      return;
    }
    const viewport = container.getBoundingClientRect();
    const total = Math.max(unseenIncomingKeysRef.current.size, trackedUnreadCountRef.current - locallySeenPendingRef.current.size);
    const rows = new Map(Array.from(container.querySelectorAll<HTMLElement>("[data-message-key]"), (row) => [row.dataset.messageKey, row]));
    let located = 0;
    let below = 0;
    for (const [index, message] of messagesRef.current.entries()) {
      const key = message.coreId ?? String(message.id);
      if (message.mine || !unseenIncomingKeysRef.current.has(key) || locallySeenPendingRef.current.has(key)) continue;
      located += 1;
      const row = rows.get(key);
      if (row ? row.getBoundingClientRect().bottom > viewport.bottom + 1 : index >= messageWindowRef.current.end) below += 1;
    }
    // Unknown positions may belong to the unloaded tail, but never create a
    // downward action when the current snapshot already contains that tail.
    const count = below + (!historySnapshotAtTailRef.current ? Math.max(0, total - located) : 0);
    const distance = Math.max(0, container.scrollHeight - container.scrollTop - container.clientHeight);
    const mode = chatNavigationMode(count, distance, container.clientHeight);
    setPendingIncomingCount(mode === "unseen" ? count : 0);
    setShowJumpToLatest(mode === "jump");
  }

  function markVisibleIncomingMessages() {
    const container = messageScrollRef.current;
    if (!container || unseenIncomingKeysRef.current.size === 0 || !localViewAllowed()) return;
    const containerBox = container.getBoundingClientRect();
    const reading = readingLongIncomingRef.current;
    if (reading?.chatId === active.id && !reading.userScrolled) return;
    let changed = false;
    for (const key of [...unseenIncomingKeysRef.current]) {
      const element = messageElement(container, key);
      if (!element) continue;
      const box = element.getBoundingClientRect();
      if (!isMessageLocallySeen({ key, top: box.top, bottom: box.bottom }, containerBox.top, containerBox.height)) continue;
      unseenIncomingKeysRef.current.delete(key);
      locallySeenPendingRef.current.add(key);
      changed = true;
    }
    if (reading?.chatId === active.id && !unseenIncomingKeysRef.current.has(reading.boundaryMessageKey)) {
      readingLongIncomingRef.current = null;
    }
    if (changed) {
      syncUnseenIndicator();
      setMessageVisibilityRevision((revision) => revision + 1);
    }
  }

  function markAutomaticScroll() {
    automaticScrollUntilRef.current = Date.now() + 300;
  }

  function scrollToBottomGuaranteed(messageKey?: string) {
    followLatestRef.current = true;
    setWindowAnchorKey(null);
    if (historyHasAfter || historyRequest.rangeOffset !== undefined || historyRequest.targetMessageId) {
      setHistoryRequest({});
      if (latestHistoryMessageIdRef.current) {
        // Clearing a cached/ranged request is still a jump to the live end.
        // A plain message target would turn followLatest off during settlement.
        beginPendingMessageNavigation(latestHistoryMessageIdRef.current, {
          messageKey: latestHistoryMessageIdRef.current, offset: 0, atBottom: true,
        });
      }
    }
    const container = messageScrollRef.current;
    if (!container) return;
    if (messageKey) lastAutoScrollIntentRef.current = { chatId: active.id, messageKey, boundaryMessageKey: messageKey, intent: "outgoing" };
    setShowJumpToLatest(false);
    const apply = () => {
      markAutomaticScroll();
      container.scrollTop = container.scrollHeight;
      const anchor = captureCurrentAnchor();
      if (anchor) scrollAnchorsRef.current[active.id] = anchor;
    };
    apply();
    scheduleViewFrame(() => {
      apply();
      scheduleViewFrame(() => {
        apply();
        markVisibleIncomingMessages();
        syncUnseenIndicator();
      });
    });
    historyFarFromLatestRef.current = false;
  }

  function incomingContextPosition(container: HTMLDivElement, target: HTMLElement, messageKey: string, boundaryMessageKey = messageKey) {
    const containerBox = container.getBoundingClientRect();
    const targetBox = target.getBoundingClientRect();
    const scale = chatGeometryScale(container);
    const targetTop = container.scrollTop + (targetBox.top - containerBox.top) / scale;
    const renderedMessages = new Map(
      Array.from(container.querySelectorAll<HTMLElement>("[data-message-key]"))
        .map((element) => [element.dataset.messageKey, element] as const),
    );
    const targetIndex = messagesRef.current.findIndex((message) => (message.coreId ?? String(message.id)) === messageKey);
    const previousMine = targetIndex > 0
      ? messagesRef.current.slice(0, targetIndex).reverse().find((message) => message.mine)
      : undefined;
    let previousOwn: { bottom: number; height: number; lineHeight: number } | undefined;
    if (previousMine) {
      const ownKey = previousMine.coreId ?? String(previousMine.id);
      const ownElement = renderedMessages.get(ownKey);
      if (ownElement) {
        const ownBox = ownElement.getBoundingClientRect();
        const textElement = ownElement.querySelector<HTMLElement>(".message-text");
        const lineHeight = textElement ? Number.parseFloat(getComputedStyle(textElement).lineHeight) || 25 : 25;
        previousOwn = {
          bottom: container.scrollTop + (ownBox.bottom - containerBox.top) / scale,
          height: ownBox.height / scale,
          lineHeight,
        };
      }
    }
    const boundaryIndex = messagesRef.current.findIndex((message) => (message.coreId ?? String(message.id)) === boundaryMessageKey);
    const incoming: Array<{ key: string; bottom: number }> = [];
    for (const message of messagesRef.current.slice(Math.max(0, targetIndex), Math.max(targetIndex, boundaryIndex) + 1)) {
      if (message.mine) continue;
      const key = message.coreId ?? String(message.id);
      if (!unseenIncomingKeysRef.current.has(key)) continue;
      const element = renderedMessages.get(key);
      if (!element) continue;
      const box = element.getBoundingClientRect();
      incoming.push({ key, bottom: container.scrollTop + (box.bottom - containerBox.top) / scale });
    }
    return incomingContextMetrics({
      viewportHeight: container.clientHeight,
      targetKey: messageKey,
      targetTop,
      targetHeight: targetBox.height / scale,
      previousOwn,
      incoming,
    });
  }

  function maintainLongIncomingContext(reading: IncomingReadingState = readingLongIncomingRef.current!) {
    const container = messageScrollRef.current;
    if (!container || !reading || readingLongIncomingRef.current !== reading || reading.chatId !== active.id || reading.userScrolled) return false;
    const target = messageElement(container, reading.anchorMessageKey);
    if (!target) return false;
    const position = incomingContextPosition(container, target, reading.anchorMessageKey, reading.boundaryMessageKey);
    if (!position.long) {
      if (readingLongIncomingRef.current === reading) readingLongIncomingRef.current = null;
      markVisibleIncomingMessages();
      syncUnseenIndicator();
      return false;
    }
    reading.boundaryMessageKey = position.boundaryMessageKey;
    markAutomaticScroll();
    container.scrollTop = position.top;
    historyFarFromLatestRef.current = false;
    syncUnseenIndicator();
    return true;
  }

  function scrollToMessageIntent(intent: "incoming" | "outgoing", messageKey: string, boundaryMessageKey = messageKey) {
    const container = messageScrollRef.current;
    if (!container) return;
    lastAutoScrollIntentRef.current = { chatId: active.id, messageKey, boundaryMessageKey, intent };
    if (intent === "outgoing") {
      readingLongIncomingRef.current = null;
      scrollToBottomGuaranteed(messageKey);
      return;
    }
    const target = messageElement(container, messageKey);
    if (!target) {
      clearDeferredIncomingScroll();
      syncUnseenIndicator();
      return;
    }
    const position = incomingContextPosition(container, target, messageKey, boundaryMessageKey);
    if (position.long) {
      clearDeferredIncomingScroll();
      const reading = { chatId: active.id, anchorMessageKey: messageKey, boundaryMessageKey: position.boundaryMessageKey, userScrolled: false };
      readingLongIncomingRef.current = reading;
      maintainLongIncomingContext(reading);
      scheduleViewFrame(() => {
        maintainLongIncomingContext(reading);
        scheduleViewFrame(() => maintainLongIncomingContext(reading));
      });
      return;
    }
    clearDeferredIncomingScroll();
    scrollToBottomGuaranteed();
    scheduleViewFrame(() => {
      markVisibleIncomingMessages();
      syncUnseenIndicator();
    });
  }

  function positionPendingIncomingBeforePaint() {
    const pending = deferredIncomingScrollRef.current;
    const container = messageScrollRef.current;
    if (!pending || !container || pending.chatId !== active.id) return false;
    const target = messageElement(container, pending.messageKey);
    const position = target ? incomingContextPosition(container, target, pending.messageKey, pending.boundaryMessageKey) : null;
    const action = incomingPrepaintAction(
      pending.userScrolled,
      userScrollActiveRef.current || userScrollBlockedUntilRef.current > Date.now(),
      !!target,
      !!position?.long,
    );
    if (action === "hold" || !target || !position) return false;
    lastAutoScrollIntentRef.current = {
      chatId: active.id,
      messageKey: pending.messageKey,
      boundaryMessageKey: pending.boundaryMessageKey,
      intent: "incoming",
    };
    if (action === "context") {
      const reading = {
        chatId: active.id,
        anchorMessageKey: pending.messageKey,
        boundaryMessageKey: position.boundaryMessageKey,
        userScrolled: false,
      };
      readingLongIncomingRef.current = reading;
      markAutomaticScroll();
      container.scrollTop = position.top;
      historyFarFromLatestRef.current = false;
      syncUnseenIndicator();
      return true;
    }
    markAutomaticScroll();
    container.scrollTop = container.scrollHeight;
    historyFarFromLatestRef.current = false;
    return true;
  }

  function positionPendingOutgoingBeforePaint() {
    const pending = deferredOutgoingScrollRef.current;
    const container = messageScrollRef.current;
    if (!pending || !container || pending.chatId !== active.id) return false;
    if (!messageElement(container, pending.messageKey)) return false;
    // The measurement effect may have captured a stale position before this
    // near-tail outgoing prepaint. Its next pass must not restore that anchor.
    pendingPreserveAnchorRef.current = null;
    deferredOutgoingScrollRef.current = null;
    followLatestRef.current = true;
    setReturnAnchor(null);
    clearDeferredIncomingScroll();
    readingLongIncomingRef.current = null;
    lastAutoScrollIntentRef.current = {
      chatId: active.id,
      messageKey: pending.messageKey,
      boundaryMessageKey: pending.messageKey,
      intent: "outgoing",
    };
    markAutomaticScroll();
    container.scrollTop = container.scrollHeight;
    const settledAnchor = captureCurrentAnchor();
    if (settledAnchor) scrollAnchorsRef.current[active.id] = settledAnchor;
    historyFarFromLatestRef.current = false;
    setShowJumpToLatest(false);
    return true;
  }

  function armDeferredIncomingScroll(delay: number) {
    if (deferredIncomingTimerRef.current !== undefined) window.clearTimeout(deferredIncomingTimerRef.current);
    deferredIncomingTimerRef.current = window.setTimeout(() => {
      deferredIncomingTimerRef.current = undefined;
      flushDeferredIncomingScroll();
    }, Math.max(16, delay));
  }

  function flushDeferredIncomingScroll(force = false) {
    const pending = deferredIncomingScrollRef.current;
    const container = messageScrollRef.current;
    if (!pending || !container || pending.chatId !== active.id) return;
    const reading = readingLongIncomingRef.current;
    if (!force && reading?.chatId === active.id && unseenIncomingKeysRef.current.has(reading.boundaryMessageKey)) {
      if (maintainLongIncomingContext(reading)) {
        scheduleViewFrame(() => maintainLongIncomingContext(reading));
        syncUnseenIndicator();
        return;
      }
    }
    if (!force && pending.userScrolled) {
      historyFarFromLatestRef.current = true;
      clearDeferredIncomingScroll();
      syncUnseenIndicator();
      return;
    }
    const settleRemaining = pending.settleUntil - Date.now();
    if (!force && settleRemaining > 0) {
      armDeferredIncomingScroll(settleRemaining);
      return;
    }
    const remaining = userScrollBlockedUntilRef.current - Date.now();
    if (!force && (userScrollActiveRef.current || remaining > 0)) {
      armDeferredIncomingScroll(userScrollActiveRef.current ? 250 : remaining);
      return;
    }
    const targetRendered = messageElement(container, pending.messageKey);
    const boundaryRendered = messageElement(container, pending.boundaryMessageKey);
    if ((!targetRendered || !boundaryRendered) && pending.renderAttempts < 20) {
      pending.renderAttempts += 1;
      if (!targetRendered && !pending.userScrolled) setWindowAnchorKey(pending.messageKey);
      armDeferredIncomingScroll(32);
      return;
    }
    if (!targetRendered) {
      clearDeferredIncomingScroll();
      syncUnseenIndicator();
      return;
    }
    scrollToMessageIntent("incoming", pending.messageKey, pending.boundaryMessageKey);
  }

  function scheduleIncomingScroll(messageKey: string, previousDistance: number) {
    const container = messageScrollRef.current;
    if (!container || !active.id) return;
    const existing = deferredIncomingScrollRef.current?.chatId === active.id
      ? deferredIncomingScrollRef.current
      : null;
    const batch = incomingNavigationBatch(
      messagesRef.current.map((message) => {
        const key = message.coreId ?? String(message.id);
        return {
          key,
          incoming: !message.mine,
          unseen: unseenIncomingKeysRef.current.has(key),
          attachment: !!message.attachment,
        };
      }),
      messageKey,
      existing?.messageKey,
    );
    deferredIncomingScrollRef.current = {
      chatId: active.id,
      messageKey: batch.anchorKey,
      boundaryMessageKey: batch.boundaryKey,
      renderAttempts: 0,
      // A single long Tox message arrives as several history records. Wait for
      // the series to settle so it is positioned as one readable block rather
      // than repeatedly treating every fragment as a short message.
      settleUntil: Math.min(existing?.settleUntil ?? Number.POSITIVE_INFINITY, Date.now() + batch.settleMs),
      userScrolled: existing?.userScrolled ?? (
        !followLatestRef.current || messageSearchOpen
        || (previousDistance > 10 && (userScrollActiveRef.current || userScrollBlockedUntilRef.current > Date.now()))
      ),
    };
    const reading = readingLongIncomingRef.current;
    if (reading?.chatId === active.id && unseenIncomingKeysRef.current.has(reading.boundaryMessageKey)) {
      if (maintainLongIncomingContext(reading)) {
        clearDeferredIncomingScroll();
        scheduleViewFrame(() => maintainLongIncomingContext(reading));
        syncUnseenIndicator();
        return;
      }
    }
    if (deferredIncomingScrollRef.current.userScrolled) {
      syncUnseenIndicator();
      armDeferredIncomingScroll(16);
      return;
    }
    // Mount the incoming anchor before positioning; a burst may have pushed
    // its first row outside the bounded tail DOM window.
    setWindowAnchorKey(batch.anchorKey);
    const remaining = userScrollBlockedUntilRef.current - Date.now();
    if (userScrollActiveRef.current) {
      deferredIncomingScrollRef.current.userScrolled = true;
      syncUnseenIndicator();
      armDeferredIncomingScroll(16);
      return;
    }
    if (remaining > 0) {
      armDeferredIncomingScroll(remaining);
      return;
    }
    armDeferredIncomingScroll(Math.max(16, batch.settleMs));
  }

  function showMessageScrollbar() {
    setMessageScrollActive(true);
    if (messageScrollTimer.current !== undefined) window.clearTimeout(messageScrollTimer.current);
    messageScrollTimer.current = window.setTimeout(() => setMessageScrollActive(false), 1000);
  }

  function noteUserScrollActivity() {
    if (userScrollCancelsHistoryRestore(pendingScrollRestore.current, messageSnapshotChatRef.current, active.id, messagesRef.current.length)) pendingScrollRestore.current = null;
    cancelPendingMessageNavigation();
    pendingPreserveAnchorRef.current = null;
    lastAutoScrollIntentRef.current = null;
    deferredOutgoingScrollRef.current = null;
    automaticScrollUntilRef.current = 0;
    userScrollUiUntilRef.current = Date.now() + 1000;
    const reading = readingLongIncomingRef.current;
    if (reading?.chatId === active.id) reading.userScrolled = true;
    userScrollBlockedUntilRef.current = Date.now() + 5000;
    showMessageScrollbar();
    const pending = deferredIncomingScrollRef.current;
    if (pending?.chatId === active.id) {
      pending.userScrolled = true;
      armDeferredIncomingScroll(16);
    }
  }

  function startDirectScroll(event: React.PointerEvent<HTMLDivElement>) {
    const box = event.currentTarget.getBoundingClientRect();
    if (event.pointerType !== "touch" && event.clientX < box.right - 24) return;
    userScrollActiveRef.current = true;
    scrollPointerIdRef.current = event.pointerId;
    noteUserScrollActivity();
  }

  function finishDirectScroll(event: React.PointerEvent<HTMLDivElement>) {
    if (scrollPointerIdRef.current !== event.pointerId) return;
    scrollPointerIdRef.current = null;
    userScrollActiveRef.current = false;
    noteUserScrollActivity();
  }

  function noteScrollKey(event: React.KeyboardEvent<HTMLDivElement>) {
    if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) noteUserScrollActivity();
  }

  function correctScrollAfterMediaLoad(messageKey: string) {
    const reading = readingLongIncomingRef.current;
    if (reading?.chatId === active.id && !reading.userScrolled) {
      if (maintainLongIncomingContext(reading)) {
        scheduleViewFrame(() => maintainLongIncomingContext(reading));
        return;
      }
    }
    const remembered = lastAutoScrollIntentRef.current;
    if (!remembered || remembered.chatId !== active.id) return;
    const anchorIndex = messagesRef.current.findIndex((message) => (message.coreId ?? String(message.id)) === remembered.messageKey);
    const boundaryIndex = messagesRef.current.findIndex((message) => (message.coreId ?? String(message.id)) === remembered.boundaryMessageKey);
    const loadedIndex = messagesRef.current.findIndex((message) => (message.coreId ?? String(message.id)) === messageKey);
    if (!mediaLoadBelongsToIntent(remembered.intent, anchorIndex, boundaryIndex, loadedIndex)) return;
    if (userScrollActiveRef.current || userScrollBlockedUntilRef.current > Date.now()) return;
    // The image's intrinsic size is now part of layout. Correct synchronously
    // inside the load event so no frame can expose the card below the composer.
    scrollToMessageIntent(remembered.intent, remembered.messageKey, remembered.boundaryMessageKey);
    const correctedIntent = lastAutoScrollIntentRef.current;
    scheduleViewFrame(() => {
      if (lastAutoScrollIntentRef.current !== correctedIntent || userScrollActiveRef.current || userScrollBlockedUntilRef.current > Date.now()) return;
      scrollToMessageIntent(remembered.intent, remembered.messageKey, remembered.boundaryMessageKey);
    });
  }

  function updateLatestButton() {
    const container = messageScrollRef.current;
    if (!container) return;
    const anchor = captureCurrentAnchor();
    if (active.id && anchor) scrollAnchorsRef.current[active.id] = anchor;
    markVisibleIncomingMessages();
    syncReturnAnchor();
    const distance = Math.max(0, container.scrollHeight - container.scrollTop - container.clientHeight);
    historyFarFromLatestRef.current = distance > container.clientHeight * 2;
    const hasUnseen = unseenIncomingKeysRef.current.size > 0;
    const now = Date.now();
    const userInitiated = shouldPublishNavigationForScroll(
      now,
      automaticScrollUntilRef.current,
      userScrollActiveRef.current,
      userScrollUiUntilRef.current,
    );
    const fillVirtualGap = !anchor && messages.length > 0 && !pendingNavigationRef.current;
    if (userInitiated || fillVirtualGap) {
      if (userInitiated) followLatestRef.current = distance <= 10;
      let visibleIndex = anchor ? messageKeys.indexOf(anchor.messageKey) : -1;
      let scrollAnchor = anchor;
      const firstRow = container.querySelector<HTMLElement>("[data-message-key]");
      const dataOrigin = firstRow
        ? (firstRow.getBoundingClientRect().top - container.getBoundingClientRect().top) / chatGeometryScale(container) + container.scrollTop - historyOffsets[messageWindow.start]
        : Math.max(0, historyWindowStart - accessibleHistoryStart) * 64;
      const localOffset = container.scrollTop - dataOrigin;
      const dataHeight = historyOffsets[messages.length];
      if (visibleIndex < 0 && localOffset >= 0 && localOffset < dataHeight) {
        visibleIndex = historyIndexAtOffset(historyOffsets, localOffset);
        scrollAnchor = { messageKey: messageKeys[visibleIndex], offset: (historyOffsets[visibleIndex] - localOffset) * chatGeometryScale(container), atBottom: false };
      }
      const globalIndex = visibleIndex >= 0 ? historyWindowStart + visibleIndex
        : Math.max(0, Math.min(historyTotal - 1, localOffset < 0 ? historyWindowStart + Math.floor(localOffset / 64) : historyWindowStart + messages.length + Math.floor((localOffset - dataHeight) / 64)));
      if (followLatestRef.current && distance <= 10) {
        setWindowAnchorKey(null);
        if (historyHasAfter) { pendingHistoryIndexRef.current = Math.max(0, historyTotal - 1); setHistoryRequest({}); }
      } else {
        if (visibleIndex >= 0 && (visibleIndex < messageWindow.start + 12 || visibleIndex > messageWindow.end - 40)) {
          pendingPreserveAnchorRef.current = scrollAnchor;
          setWindowAnchorKey(messageKeys[visibleIndex]);
        }
        prefetchHistoryAround(globalIndex, scrollAnchor);
      }
      if (container.scrollTop <= 32) loadOlderHistory();
    }
    syncUnseenIndicator();
    if (distance <= 10 && !hasUnseen) clearDeferredIncomingScroll();
  }

  function jumpToLatest() {
    setReturnAnchor((current) => current ?? captureCurrentAnchor());
    cancelPendingMessageNavigation();
    pendingPreserveAnchorRef.current = null;
    followLatestRef.current = true;
    const reading = readingLongIncomingRef.current;
    if (reading?.chatId === active.id) {
      reading.userScrolled = true;
      scrollToBottomGuaranteed();
      return;
    }
    if (deferredIncomingScrollRef.current) {
      flushDeferredIncomingScroll(true);
      return;
    }
    scrollToBottomGuaranteed();
  }

  function renderSearchValue(message: Message, value: string, field: MessageSearchMatch["field"]) {
    const text = plainText(value);
    const key = message.coreId ?? String(message.id);
    const matches = searchMatchesByMessage.get(key)?.filter((match) => match.field === field);
    if (!messageSearchOpen || !matches?.length) return text;
    return searchTextSegments(text, matches, messageSearchIndex).map((segment) => {
      const formatting = field === "text" && message.protocolVersion === 1 ? message.formatting?.flatMap((span) => {
        const start = Math.max(segment.start, span.offsetUtf16);
        const end = Math.min(segment.end, span.offsetUtf16 + span.lengthUtf16);
        return end > start ? [{ kind: span.kind, offsetUtf16: start - segment.start, lengthUtf16: end - start }] : [];
      }) : undefined;
      const content = <FormattedMessageText text={segment.text} formatting={formatting} />;
      return segment.resultIndex === undefined ? <Fragment key={segment.start}>{content}</Fragment> : <mark
        className={`message-search-hit ${segment.resultIndex === messageSearchIndex ? "current" : ""}`}
        data-search-result={segment.resultIndex}
        key={segment.start}
      >{content}</mark>;
    });
  }

  const openChatLink = useCallback((url: string) => {
    void openUrl(url).catch((error) => showTransferNotice(formatUserFacingError(error,
      { ru: "Не удалось открыть ссылку", en: "Could not open the link" }, language)));
  }, [language]);

  function renderMessageText(message: Message) {
    return <ChatMessageText text={plainText(message.text)}
      formatting={message.protocolVersion === 1 ? message.formatting : undefined}
      matches={messageSearchOpen ? searchMatchesByMessage.get(message.coreId ?? String(message.id))?.filter((match) => match.field === "text") : undefined}
      selectedMatch={messageSearchIndex}
      onOpenLink={openChatLink}
    />;
  }

  function quoteForDisplay(message: Message): ChatQuote {
    const quote = message.quote!;
    if (quote.legacy || message.protocolVersion !== 1) return quote;
    return { ...quote, author: quote.author === "self" ? profileName : quote.author === "peer" ? activeName : quote.author };
  }

  function quoteMessage(message: Message) {
    setComposerFocusRequest((value) => value + 1);
    const quote: ChatQuote = {
      messageId: message.protocolVersion === 1 ? message.coreId : undefined,
      author: message.mine ? profileName : activeName,
      text: message.text || message.attachment?.name || "",
      legacy: message.protocolVersion !== 1,
    };
    draftQuotesRef.current[active.id] = quote;
    setReplyQuote(quote);
    setGeneralContext(null);
    scheduleDraftSave();
  }

  async function toggleReaction(message: Message, reaction: ChatReactionCode) {
    const messageId = message.coreId;
    if (!messageId || active.friendNumber === undefined || !chatCapabilities.reactions || !reactionEligibleKeys.has(messageId) || pendingReactionIdsRef.current.has(messageId)) return;
    const generation = viewOwnerRef.current.generation;
    const mine = message.reactions?.mine ?? [];
    const reactions = mine.includes(reaction) ? mine.filter((value) => value !== reaction) : [...mine, reaction];
    if (reactions.length > 3) return;
    pendingReactionIdsRef.current.add(messageId);
    setReactionErrors((current) => { const next = { ...current }; delete next[messageId]; return next; });
    try {
      await invoke<ChatMessageReactions>("set_message_reactions", { profileId: activeProfileId, friendNumber: active.friendNumber, messageId, reactions, operationId: crypto.randomUUID() });
      if (generation === viewOwnerRef.current.generation) setMessageRefreshRequest((value) => value + 1);
    } catch (error) {
      if (generation === viewOwnerRef.current.generation) setReactionErrors((current) => ({ ...current, [messageId]: /RATE|LIMIT/.test(String(error)) ? (language === "ru" ? "Не более 4 изменений реакций в минуту" : "Up to 4 reaction changes per minute") : formatUserFacingError(error, { ru: "Реакция не доставлена", en: "Reaction was not delivered" }, language) }));
    } finally { pendingReactionIdsRef.current.delete(messageId); }
  }

  function renderDeliveryState(message: Message) {
    if (!message.mine) return null;
    const label = message.delivery === "delivered" ? deliveryReceiptTitle(message)
      : message.delivery === "pending" ? (language === "ru" ? "В очереди отправки" : "Queued for sending")
      : message.delivery === "unknown" ? (language === "ru" ? "Результат доставки неизвестен после перезапуска" : "Delivery outcome unknown after restart")
      : message.delivery === "failed" ? (language === "ru" ? "Ошибка отправки" : "Sending failed")
      : language === "ru" ? "Ожидает подтверждения доставки от клиента" : "Awaiting delivery confirmation from the client";
    return <span className={`delivery-state delivery-${message.delivery ?? "sent"}`} title={label} aria-label={label}>{message.delivery === "delivered" ? "✓" : message.delivery === "pending" ? <i className="delivery-spinner" /> : message.delivery === "unknown" || message.delivery === "failed" ? "!" : "◷"}</span>;
  }

  function moveSearchResult(direction: -1 | 1) {
    if (!messageSearchMatches.length || messageSearchBusy) return;
    if (direction === 1 && messageSearchIndex === messageSearchMatches.length - 1 && searchNextCursor) {
      searchPreviousPagesRef.current.push({ cursor: searchPage.cursor, offset: searchPage.offset });
      if (searchPreviousPagesRef.current.length > 128) searchPreviousPagesRef.current.shift();
      setSearchPage({ cursor: searchNextCursor, offset: searchPage.offset + messageSearchMatches.length });
      return;
    }
    if (direction === -1 && messageSearchIndex === 0 && searchPreviousPagesRef.current.length) {
      const previous = searchPreviousPagesRef.current.pop()!;
      setSearchPage({ ...previous, selectLast: true });
      return;
    }
    if (direction === -1 && messageSearchIndex === 0 && searchPage.offset > 0) {
      searchSeekOffsetRef.current = searchPage.offset - 1;
      setSearchPage({ offset: 0 });
      return;
    }
    if (direction === 1 && messageSearchIndex === messageSearchMatches.length - 1 && searchPage.offset > 0) {
      searchPreviousPagesRef.current = [];
      setSearchPage({ offset: 0 });
      return;
    }
    setMessageSearchIndex((current) => {
      const base = current < 0 ? 0 : current;
      return Math.max(0, Math.min(messageSearchMatches.length - 1, base + direction));
    });
  }

  function closeMessageSearch() {
    searchRunRef.current += 1;
    setMessageSearchOpen(false);
    setMessageSearch("");
    setMessageSearchMatches([]);
    setMessageSearchIndex(-1);
    setMessageSearchBusy(false);
  }

  const statusText = userStatus === "online" ? "Онлайн — подключено к сети" : userStatus === "away" ? "Отошёл" : userStatus === "busy" ? "Занят" : "Отключено от сети";
  const displayedOwnStatusMessage = ownStatusMessage === "Готов к общению" || ownStatusMessage === "Ready to chat"
    ? t("Готов к общению")
    : ownStatusMessage;
  const contactActionChat = contactActionTarget ?? active;
  const contactActionName = contactActionChat.id ? displayName(contactActionChat) : activeName;
  const profileInitial = profileName.trim().charAt(0).toLocaleUpperCase() || "T";

  function exportHistory() {
    if (active.friendNumber === undefined) return;
    const coreName = coreFriends.find((friend) => friend.number === active.friendNumber)?.name.trim() ?? "";
    const exportName = contactNames[active.id]?.trim() || coreName;
    void invoke<string>("export_tox_history", { friendNumber: active.friendNumber, contactName: plainText(exportName), contactId: active.toxId })
      .then((path) => showTransferNotice(t("Полная история экспортирована"), path))
      .catch((error) => showTransferNotice(formatUserFacingError(error, { ru: "Не удалось экспортировать историю", en: "Could not export history" }, language)));
    setContactMenuOpen(false);
  }

  function copyOwnToxId() {
    if (!ownToxId) return;
    const showCopyNotice = () => {
      setCopyNotice(true);
      if (copyNoticeTimer.current !== undefined) window.clearTimeout(copyNoticeTimer.current);
      copyNoticeTimer.current = window.setTimeout(() => setCopyNotice(false), 1100);
    };
    const fallbackCopy = () => {
      const area = document.createElement("textarea");
      area.value = ownToxId;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.append(area);
      area.select();
      document.execCommand("copy");
      area.remove();
      showCopyNotice();
    };
    if (navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(ownToxId).then(showCopyNotice).catch(fallbackCopy);
    } else {
      fallbackCopy();
    }
  }

  function showTransferNotice(text: string, path?: string) {
    setTransferNotice({ text, path });
    if (transferNoticeTimer.current !== undefined) window.clearTimeout(transferNoticeTimer.current);
    transferNoticeTimer.current = window.setTimeout(() => setTransferNotice(null), 5000);
  }

  function renameContact() {
    const name = renameDraft.trim();
    const target = contactActionTarget ?? active;
    if (name && target.id) setContactNames((names) => ({ ...names, [target.id]: plainText(name) }));
    setContactAction(null);
    setContactActionTarget(null);
    setContactMenuOpen(false);
  }

  function deleteContact() {
    const target = contactActionTarget ?? active;
    if (target.friendNumber === undefined) return;
    void invoke("delete_tox_friend", { profileId: activeProfileId, friendNumber: target.friendNumber })
      .then(() => {
        discardCachedChatHistory(target.id, target.friendNumber);
        setCoreFriends((friends) => friends.filter((friend) => friend.number !== target.friendNumber));
        setUnreadFriendCounts((counts) => { const next = { ...counts }; delete next[String(target.friendNumber)]; return next; });
        if (target.id === active.id) {
          setMessages([]);
          setActiveChat("");
        }
      })
      .catch((error) => showTransferNotice(formatUserFacingError(error, { ru: "Не удалось удалить контакт", en: "Could not delete the contact" }, language)));
    setContactMenuOpen(false);
    setContactAction(null);
    setContactActionTarget(null);
  }

  function discardCachedChatHistory(chatId: string | null, friendNumber?: number) {
    if (chatId === null) {
      historyCacheRef.current.clear();
      historyCacheRangesRef.current.clear();
      reactionNoticeStoreRef.current = {};
      reactionNoticeDurableCursorRef.current = {};
      scrollAnchorsRef.current = {};
      releaseProfileTransferPreviews(activeProfileId);
    } else {
      historyCacheRef.current.delete(`${activeProfileId}:${chatId}`);
      historyCacheRangesRef.current.delete(`${activeProfileId}:${chatId}`);
      delete reactionNoticeStoreRef.current[chatId];
      delete reactionNoticeDurableCursorRef.current[chatId];
      delete scrollAnchorsRef.current[chatId];
      if (friendNumber !== undefined) releaseTransferPreviews(activeProfileId, friendNumber, true);
    }
    if (localStateSnapshotRef.current) {
      localStateSnapshotRef.current.peerReactionNotices = reactionNoticeStoreRef.current;
      localStateSnapshotRef.current.scrollAnchors = scrollAnchorsRef.current;
    }
    if (chatId === null || activeChatRef.current === chatId) {
      historyMutationRevisionRef.current += 1;
      historyRevisionRef.current = undefined;
      messagesRef.current = [];
      messageSnapshotChatRef.current = "";
      setMessages([]);
      setReactionNotices([]);
      setMessageSearchMatches([]);
      setHistoryTotal(0);
      setHistoryWindowStart(0);
      setHistoryRequest({});
      setMessageRefreshRequest((value) => value + 1);
    }
    void persistLocalState();
  }

  function clearContactHistory() {
    const target = active;
    setContactMenuOpen(false);
    if (target.friendNumber === undefined) return;
    void invoke("clear_tox_history", { profileId: activeProfileId, friendNumber: target.friendNumber })
      .then(() => discardCachedChatHistory(target.id, target.friendNumber))
      .catch((error) => showTransferNotice(formatUserFacingError(error, { ru: "Не удалось очистить историю", en: "Could not clear history" }, language)));
  }

  function copyText(value: string) {
    void navigator.clipboard.writeText(value).catch(() => {});
  }

  function openRestrictedContextMenu(event: React.MouseEvent<HTMLElement>) {
    if (isEditableTextTarget(event.target)) {
      setGeneralContext(null);
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const target = event.target instanceof Element ? event.target : event.currentTarget;
    if (target.closest('[role="menu"],.contact-context-menu')) return;
    openMessageContextAt(target, event.clientX, event.clientY);
  }

  function openMessageContextAt(target: Element, x: number, y: number) {
    dismissContextMenus();
    setContactContext(null);
    const linkUrl = chatLinkAtTarget(target);
    const selection = window.getSelection()?.toString() ?? "";
    const messageNode = target.closest<HTMLElement>("[data-message-key]");
    const messageKey = messageNode?.dataset.messageKey;
    const message = messageKey
      ? messagesRef.current.find((item) => (item.coreId ?? String(item.id)) === messageKey)
      : undefined;
    if (message?.attachment?.path) {
      setGeneralContext({
        x,
        y,
        kind: message.attachment.image ? "image" : "file",
        path: message.attachment.path,
        previewPath: message.attachment.url,
        showInFolder: !message.mine && message.attachment.completed === true,
        messageKey,
        linkUrl,
        copyValue: selection || message.text || message.attachment.name,
      });
      return;
    }
    if (!selection && !message) {
      setGeneralContext(null);
      return;
    }
    setGeneralContext({ x, y, kind: "copy", messageKey, linkUrl, copyValue: selection || message?.text });
  }

  function openContactContextAt(chat: Chat, x: number, y: number) {
    dismissContextMenus();
    setGeneralContext(null);
    setContactContext({ x: Math.min(x, window.innerWidth - 260), y: Math.min(y, window.innerHeight - 150), chat });
  }

  function cancelOutgoingFriendRequest(toxId: string) {
    const normalizedToxId = toxId.trim().toUpperCase();
    const pendingFriend = coreFriends.find((friend) => normalizedToxId.startsWith(friend.public_key));
    const removeFromRequests = () => {
      setOutgoingFriendRequests((requests) => requests.filter((request) => request.toxId !== toxId));
    };

    if (pendingFriend) {
      void invoke("delete_tox_friend", { friendNumber: pendingFriend.number })
        .then(() => {
          setCoreFriends((friends) => friends.filter((friend) => friend.number !== pendingFriend.number));
          removeFromRequests();
        })
        .catch((error) => showTransferNotice(formatUserFacingError(error, { ru: "Не удалось отменить запрос", en: "Could not cancel the request" }, language)));
      return;
    }

    removeFromRequests();
  }

  function submitFriendRequest(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAddContactStatus(null);
    void invoke<number>("add_tox_friend", { toxId: contactToxId, message: friendRequestMessage })
      .then(() => {
        setAddContactStatus(t("Запрос авторизации отправлен. Контакт появится после ответа."));
        setOutgoingFriendRequests((requests) => [...requests.filter((request) => request.toxId !== contactToxId), { toxId: contactToxId, message: friendRequestMessage }]);
        setContactToxId("");
      })
      .catch((error) => setAddContactStatus(formatUserFacingError(error, { ru: "Не удалось отправить запрос на переписку", en: "Could not send the chat request" }, language)));
  }

  const ownAvatarState: ProfileAvatarState = networkStatus === "connecting" || networkStatus === "connecting-tor"
    ? "connecting"
    : networkStatus === "online"
      ? userStatus
      : "offline";
  const interfaceTypography = getTypographyFont(appearance.interfaceFont, DEFAULT_APPEARANCE.interfaceFont);
  const chatTypography = getTypographyFont(appearance.chatFont, DEFAULT_APPEARANCE.chatFont);
  const placeholderTypography = getTypographyFont(appearance.profilePlaceholderFont, DEFAULT_APPEARANCE.profilePlaceholderFont);
  const hasProfileSwitcher = profiles.filter((profile) => profile.loaded).length >= 2;
  const profileSidebarHeader = <div className={`profile-sidebar-header ${hasProfileSwitcher ? "has-profile-switcher" : ""}`}>
    <ProfileSwitcher profiles={profiles.map((profile) => profile.id === activeProfileAtMount?.id && persistenceReady ? { ...profile, avatar: profileAvatar, name: profileName, userStatus } : profile)} profileOrder={profileOrder} onProfileOrderChange={setProfileOrder} onSwitch={switchProfileAfterDraftSave} switching={profileSwitching || profileSwitchPending} onStatusChange={changeProfileStatus} />
    <div className="own-meta-line own-tox-meta"><button className="own-tox-id" onClick={copyOwnToxId} title={ownToxId ? "Скопировать полный Tox ID" : "Загрузка Tox ID"}>Ваш Tox ID: <code>{ownToxId ? ownToxId.slice(0, 15) : "загрузка…"}</code></button><button className="own-meta-icon" onClick={copyOwnToxId} title="Скопировать полный Tox ID" aria-label="Скопировать полный Tox ID">⧉</button>{copyNotice && <span className="own-copy-notice" role="status">{t("Скопировано")}</span>}</div>
    <div className="own-status-message">{editingOwnStatusMessage ? <input autoFocus value={ownStatusMessage} onChange={(event) => setOwnStatusMessage(event.target.value)} onBlur={saveOwnStatusMessage} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); } }} aria-label="Ваш статус Tox" maxLength={100} /> : <div className="own-meta-line"><button className="own-status-trigger" onClick={() => setEditingOwnStatusMessage(true)} title="Изменить статус">Ваш статус: <em data-i18n-ignore translate="no">{displayedOwnStatusMessage}</em></button><button className="own-meta-icon" onClick={() => setEditingOwnStatusMessage(true)} title="Изменить статус" aria-label="Изменить статус">✎</button></div>}</div>
  </div>;

  return (
    <main className={`app-shell ${isResizingList ? "resizing" : ""} ${compactSidebar ? "sidebar-compact" : ""}`} onContextMenu={openRestrictedContextMenu} onClickCapture={(event) => { if (event.ctrlKey && /Mac/i.test(navigator.platform) && !isEditableTextTarget(event.target) && !(event.target instanceof Element && event.target.closest(".chat-item"))) { event.preventDefault(); event.stopPropagation(); openRestrictedContextMenu(event); } }} onKeyDown={(event) => { if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) { if (isEditableTextTarget(event.target)) return; event.preventDefault(); const target = event.target instanceof Element ? event.target : event.currentTarget; const bounds = target.getBoundingClientRect(); openMessageContextAt(target, bounds.left + 16, bounds.top + 16); } }} onClick={() => { setContactMenuOpen(false); setStatusMenuOpen(false); setProfileMenuOpen(false); setContactContext(null); setGeneralContext(null); }} style={{ "--interface-font": interfaceTypography.family, "--interface-font-size": `${appearance.interfaceFontSize}px`, "--interface-font-stretch": interfaceTypography.stretch, "--chat-font": chatTypography.family, "--chat-font-size": `${appearance.chatFontSize}px`, "--chat-font-stretch": chatTypography.stretch, "--profile-placeholder-font": placeholderTypography.family, "--profile-placeholder-font-scale": appearance.profilePlaceholderFontSize / 100, "--profile-placeholder-font-stretch": placeholderTypography.stretch, "--list-edge": `${listEdge}px`, "--profile-sidebar-width": `${sidebarWidth}px`, ...appShellScaleStyle(appearance.interfaceScale, platformCapabilities.containerRelativeLayout), gridTemplateColumns: gridColumns } as CSSProperties}>
      {transferNotice && <div className="copy-toast transfer-toast" role="status"><span>{transferNotice.text}</span>{transferNotice.path && <>: <span data-i18n-ignore translate="no">{transferNotice.path}</span></>}</div>}
      <div className="event-notices">{eventNotices.map((notice) => <article key={notice.id} className="event-notice" onClick={() => { setEventNotices((current) => current.filter((item) => item.id !== notice.id)); setScreen("chat"); if (notice.requests) { setIncomingRequestsOpen(true); setAddContactOpen(false); } else if (notice.friendPublicKey || notice.friendNumber !== undefined) { setIncomingRequestsOpen(false); setAddContactOpen(false); const chatId = resolveFriendChatId(notice.friendPublicKey, notice.friendNumber, coreFriends); if (chatId) setActiveChat(chatId); } }}><button onClick={(event) => { event.stopPropagation(); setEventNotices((current) => current.filter((item) => item.id !== notice.id)); }} aria-label="Закрыть">×</button><b data-i18n-ignore translate="no">{notice.title}</b><span data-i18n-ignore translate="no">{notice.body}</span></article>)}</div>
      {contactContext && <div ref={contactContextMenuRef} className="contact-context-menu" role="menu" aria-label={t("Меню")} style={{ left: contactContext.x, top: contactContext.y }} onClick={(event) => event.stopPropagation()} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); }}><button className="danger-menu" role="menuitem" onClick={() => { setContactActionTarget(contactContext.chat); setContactAction("delete"); setContactContext(null); }}>Удалить</button><button role="menuitem" onClick={() => { copyText(contactContext.chat.toxId); setContactContext(null); }}>Скопировать полный Tox ID</button><span>Последний онлайн: {contactContext.chat.lastOnline}</span></div>}
      {generalContext && <div ref={generalContextMenuRef} className="contact-context-menu restricted-context-menu" role="menu" onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); }} style={{ left: generalContext.x, top: generalContext.y }} onClick={(event) => event.stopPropagation()}>
        {contextMessage && !contextMessage.event && <button role="menuitem" data-kaigen-ui-id={APP_UI_IDS.main_message_menu_element_quote} onClick={() => quoteMessage(contextMessage)}>{language === "ru" ? "Цитировать" : "Quote"}</button>}
        {generalContext.kind === "image" && <button onClick={() => copyAttachmentToClipboard(generalContext.previewPath ?? generalContext.path, true)}>Скопировать изображение</button>}
        {generalContext.kind === "file" && platformCapabilities.nativeFilesystem && <button onClick={() => copyAttachmentToClipboard(generalContext.path, false)}>Скопировать файл</button>}
        {!platformCapabilities.nativeFilesystem && contextMessage?.attachment?.completed && contextMessage.attachment.path?.startsWith("browser-stream://") && <button role="menuitem" onClick={() => downloadWebAttachment(contextMessage)}>{language === "ru" ? "Скачать файл" : "Download file"}</button>}
        {generalContext.showInFolder && platformCapabilities.nativeFilesystem && <button onClick={() => showAttachmentInFolder(generalContext.path)}>Показать в папке</button>}
        {generalContext.kind === "copy" && <button onClick={() => { copyText(generalContext.copyValue ?? ""); setGeneralContext(null); }}>Скопировать</button>}
        {generalContext.linkUrl && <button role="menuitem" data-kaigen-ui-id={APP_UI_IDS.main_message_menu_element_copy_link} onClick={() => { copyText(generalContext.linkUrl!); setGeneralContext(null); }}>{t("Скопировать ссылку")}</button>}
        {contextReactionEligible && contextMessage && <ReactionPicker key={contextMessage.coreId} reactions={contextMessage.reactions} onToggle={(reaction) => { const pending = toggleReaction(contextMessage, reaction); setGeneralContext(null); return pending; }} />}
      </div>}
      {contactAction && <div className={`file-confirm-overlay ${contactAction === "delete" ? "contact-delete-overlay" : ""}`} role="dialog" aria-modal="true" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}><div className="file-confirm-card">{contactAction === "rename" ? <><b>Переименовать контакт</b><input autoFocus value={renameDraft} onChange={(event) => setRenameDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") renameContact(); }} /><div><button className="text-button" onClick={() => { setContactAction(null); setContactActionTarget(null); }}>Отмена</button><button className="send-file-button" onClick={renameContact}>Сохранить</button></div></> : <><b>Удалить контакт?</b><span>«<span data-i18n-ignore translate="no">{contactActionName}</span>» и вся локальная история переписки будут удалены.</span><div><button className="text-button" onClick={() => { setContactAction(null); setContactActionTarget(null); }}>Отмена</button><button className="danger-button" onClick={deleteContact}>Удалить</button></div></>}</div></div>}
      <aside className="rail" aria-label="Навигация" onClick={(event) => { event.stopPropagation(); setContactContext(null); setGeneralContext(null); }}>
        <div className="rail-profile-menu-host" ref={profileMenuRef}>
          <button type="button" className="rail-profile-menu-button" title={t("Управление активным профилем")} aria-label={t("Управление активным профилем")} aria-haspopup="menu" aria-expanded={profileMenuOpen} onClick={() => { const next = !profileMenuOpen; dismissContextMenus(); setProfileMenuOpen(next); }}><svg viewBox="0 0 42 24" aria-hidden="true"><circle cx="7" cy="12" r="4.5" /><circle cx="21" cy="12" r="4.5" /><circle cx="35" cy="12" r="4.5" /></svg></button>
          {profileMenuOpen && <div className="rail-profile-menu" role="menu"><button type="button" role="menuitem" onClick={() => openSettings("profiles")}>{t("Добавить профиль")}</button><button type="button" role="menuitem" onClick={() => openSettings("profile")}>{t("Настройки")}</button><button type="button" role="menuitem" onClick={exitApplication}>{t("Выход")}</button></div>}
        </div>
        <div className="status-control"><button type="button" className="rail-profile-button" onClick={openProfileSettings} title="Открыть настройки профиля" aria-label="Открыть настройки профиля"><ProfileAvatar src={profileAvatar} initial={profileInitial} state={ownAvatarState} connecting={ownAvatarState === "connecting"} className="rail-profile-avatar" alt="Ваш аватар" /></button><button className={`rail-status-label ${networkStatus === "online" ? userStatus : "offline"}`} onClick={() => { const next = !statusMenuOpen; dismissContextMenus(); setStatusMenuOpen(next); }} title={networkStatus === "online" ? statusText : networkStatus === "offline" ? "Отключено от сети Tox" : networkStatus === "connecting-tor" ? "Подключение к Tor…" : "Подключение к сети Tox…"} aria-label={`Статус: ${networkStatus === "online" ? statusText : networkStatus === "offline" ? "Отключено от сети Tox" : networkStatus === "connecting-tor" ? "Подключение к Tor…" : "Подключение к сети Tox…"}`} aria-expanded={statusMenuOpen}>{networkStatus === "connecting-tor" ? "Подключение к Tor…" : networkStatus === "connecting" ? "Подключение…" : networkStatus === "offline" ? "Отключен" : userStatus === "online" ? "Онлайн" : userStatus === "away" ? "Отошёл" : userStatus === "busy" ? "Занят" : "Отключен"}</button>{statusMenuOpen && <div className="status-menu" role="menu"><button onClick={() => changeUserStatus("online")} role="menuitem"><PresenceDot status="online" />Онлайн</button><button onClick={() => changeUserStatus("away")} role="menuitem"><PresenceDot status="away" />Отошёл</button><button onClick={() => changeUserStatus("busy")} role="menuitem"><PresenceDot status="busy" />Занят</button><button onClick={() => changeUserStatus("offline")} role="menuitem"><PresenceDot status="offline" />Отключиться от сети</button></div>}</div>
        <nav className="rail-navigation" aria-label="Основные разделы">
          <button className={`rail-button chats-button ${screen === "chat" && !incomingRequestsOpen && !addContactOpen ? "active" : ""}`} onClick={() => { setScreen("chat"); setIncomingRequestsOpen(false); setAddContactOpen(false); }} title="Чаты и контакты" aria-label="Чаты и контакты"><svg className="rail-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5h11A2.5 2.5 0 0 1 21.5 8v7a2.5 2.5 0 0 1-2.5 2.5h-8l-5.5 4V8A2.5 2.5 0 0 1 8 5.5Z" /></svg>{Object.values(unreadFriendCounts).reduce((sum, value) => sum + value, 0) > 0 && <span className="rail-badge">{Object.values(unreadFriendCounts).reduce((sum, value) => sum + value, 0)}</span>}</button>
          <button className={`rail-button add-contact-button ${addContactOpen ? "active" : ""}`} onClick={() => { setScreen("chat"); setActiveChat(""); setIncomingRequestsOpen(false); setAddContactOpen(true); setAddContactStatus(null); }} title="Добавить в контакты" aria-label="Добавить в контакты"><svg className="rail-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg></button>
          <button className={`rail-button requests-button ${incomingRequestsOpen ? "active" : ""}`} onClick={() => { setScreen("chat"); setActiveChat(""); setAddContactOpen(false); setIncomingRequestsOpen(true); }} title="Ожидающие авторизации" aria-label="Ожидающие авторизации"><svg className="rail-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="8.3" cy="6.8" r="3" /><path d="M3.4 18.5v-.8a5.1 5.1 0 0 1 5.1-5.1c1 0 2 .3 2.8.8" /><circle cx="16.6" cy="16.5" r="4.2" /><path d="M16.6 14v2.6l1.8 1" /><path className="rail-icon-accent" d="m18.9 5.1 1.25 1.25-1.25 1.25-1.25-1.25Z" /></svg>{unreadIncomingRequestKeys.length > 0 && <span className="rail-badge">{unreadIncomingRequestKeys.length}</span>}</button>
          {platformCapabilities.nativeFilesystem && <button className="rail-button downloads-button" onClick={openDownloadsFolder} title="Открыть папку загрузок" aria-label="Открыть папку загрузок"><DownloadIcon className="rail-icon" /></button>}
          <button type="button" className="rail-button group-chat-button" data-kaigen-ui-id={APP_UI_IDS.main_element_navigation_group_chat} disabled title={t("Групповой чат — скоро")} aria-label={t("Групповой чат")}><svg className="rail-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3.5h14a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-8l-5 3v-3H5a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2Z" /><circle cx="9" cy="8.5" r="1.8" /><path d="M5.9 14.7v-.5a3.1 3.1 0 0 1 6.2 0v.5M14.2 6.8a1.8 1.8 0 0 1 0 3.5M14.5 11.2a3.1 3.1 0 0 1 3.6 3v.5" /></svg></button>
        </nav>
        <div className="rail-footer">
          <button type="button" className={`tor-indicator ${customProxyActive ? "proxy" : torEnabled ? "enabled" : "disabled"} ${customProxyActive ? "" : torStatus.state}`} data-i18n-ignore translate="no" title={torIndicatorText} aria-label={`${torIndicatorText}. ${language === "ru" ? "Открыть настройки Tor" : "Open Tor settings"}`} onClick={() => openSettings("tor")}>
            <span className="tor-indicator-label" data-kaigen-ui-id={APP_UI_IDS.main_element_route_indicator_label} aria-hidden="true">TOR</span>
            <svg viewBox="0 0 48 48" aria-hidden="true">
              <path className="tor-shield-glow" d="M24 5.5 39 10.9v10.6c0 9.4-6.1 16.6-15 21-8.9-4.4-15-11.6-15-21V10.9L24 5.5Z" />
              <path className="tor-shield" d="M24 5.5 39 10.9v10.6c0 9.4-6.1 16.6-15 21-8.9-4.4-15-11.6-15-21V10.9L24 5.5Z" />
              <g className="tor-shield-ellipsis">
                <circle cx="18" cy="27" r="1.8" />
                <circle cx="24" cy="27" r="1.8" />
                <circle cx="30" cy="27" r="1.8" />
              </g>
              <g className="tor-lock-symbol">
                <rect className="tor-lock" x="16.5" y="22.2" width="15" height="11.5" rx="2.2" />
                <path className="tor-lock" d="M19.5 22.2v-2.1a4.5 4.5 0 0 1 9 0v2.1M24 26.2v3.4" />
              </g>
              <path className="tor-disabled-mark" d="M13.5 12.5 34.5 35.5M34.5 12.5 13.5 35.5" />
              <path className="tor-error-mark" d="M24 18.5v10.5M24 34h.01" />
            </svg>
            <span className={`tor-status-line ${torStatus.state} ${torStatusLine ? "visible" : ""}`} data-kaigen-ui-id={APP_UI_IDS.main_element_route_indicator_status_line} aria-hidden={!torStatusLine}>
              {torStatusLine}
              {torStatusDotsRunning ? (
                <span className="tor-status-running-dots" aria-hidden="true"><i>.</i><i>.</i><i>.</i></span>
              ) : null}
            </span>
          </button>
          <div className="theme-switch" role="group" aria-label="Переключение темы оформления">
            <button
              type="button"
              className={`theme-switch-button ${theme === "current" ? "active" : ""}`}
              data-theme="current"
              onClick={() => setTheme("current")}
              aria-label="Включить тёмную тему"
              title="Тёмная"
            >
              <svg className="theme-switch-icon" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M20 15.4A8.2 8.2 0 0 1 8.6 4 8.2 8.2 0 1 0 20 15.4Z" />
              </svg>
            </button>
            <button
              type="button"
              className={`theme-switch-button ${theme === "softlifegreen" ? "active" : ""}`}
              data-theme="softlifegreen"
              onClick={() => setTheme("softlifegreen")}
              aria-label="Включить светлую тему"
              title="Светлая"
            >
              <svg className="theme-switch-icon" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 21V11m0 0C8 11 6 9 6 5c4 0 6 2 6 6Zm0 0c0-4 2-6 6-6 0 4-2 6-6 6Z" />
                <path d="M8.8 15.1c.8 1.4 1.9 2.1 3.3 2.1 1.2 0 2.3-.5 3.2-1.5" />
              </svg>
            </button>
          </div>
        </div>
      </aside>

      {screen === "chat" && <aside className={`chat-list ${compactSidebar ? "compact" : ""}`}>
        {profileSidebarHeader}
        <label className="search"><span>⌕</span><input value={contactSearch} onChange={(event) => setContactSearch(event.target.value)} placeholder={t("Поиск")} aria-label={t("Фильтр контакт-листа")} /><button type="button" className="clear-contact-search" onClick={() => setContactSearch("")} disabled={!contactSearch} aria-label={t("Сбросить фильтр")} title={t("Сбросить фильтр")}>×</button></label>
        <div className="contact-list-heading">
          <p className="section-label">{t("Контакты")}</p>
          <div className="contact-list-controls" role="group" aria-label={t("Порядок и видимость контактов")}>
            <button type="button" className={`contact-list-control ${contactSort.mode === "activity" ? "active" : ""}`} onClick={() => setContactSort((current) => toggleContactSort(current, "activity"))} aria-pressed={contactSort.mode === "activity"} aria-label={activitySortLabel} title={activitySortLabel} data-kaigen-ui-id={APP_UI_IDS.main_contacts_element_sort_activity}>
              <ActivitySortIcon direction={contactSort.mode === "activity" ? contactSort.direction : "forward"} />
            </button>
            <button type="button" className={`contact-list-control ${contactSort.mode === "status" ? "active" : ""}`} onClick={() => setContactSort((current) => toggleContactSort(current, "status"))} aria-pressed={contactSort.mode === "status"} aria-label={statusSortLabel} title={statusSortLabel} data-kaigen-ui-id={APP_UI_IDS.main_contacts_element_sort_status}>
              <StatusSortIcon direction={contactSort.mode === "status" ? contactSort.direction : "forward"} />
            </button>
            <button type="button" className={`contact-list-control ${hideOfflineContacts ? "active" : ""}`} onClick={() => setHideOfflineContacts((current) => !current)} aria-pressed={hideOfflineContacts} aria-label={offlineVisibilityLabel} title={offlineVisibilityLabel} data-kaigen-ui-id={APP_UI_IDS.main_contacts_element_toggle_offline}>
              <OfflineVisibilityIcon hidden={hideOfflineContacts} />
            </button>
          </div>
        </div>
        <div className={`chat-items ${contactsScrollActive ? "scroll-active" : ""}`} onScroll={showContactsScrollbar}>
          {visibleChats.map((chat) => (
            <button className={`chat-item ${activeChat === chat.id ? "selected" : ""}`} data-kaigen-ui-entity-key={opaqueUiEntityKey("contact", chat.publicKey ?? chat.id)} key={chat.id} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); openContactContextAt(chat, event.clientX, event.clientY); }} onClick={(event) => { if (event.ctrlKey && /Mac/i.test(navigator.platform)) { event.preventDefault(); event.stopPropagation(); openContactContextAt(chat, event.clientX, event.clientY); return; } setIncomingRequestsOpen(false); setAddContactOpen(false); setActiveChat(chat.id); }}>
              <span className={`avatar ${chat.color} contact-status-${chat.status}`}>
                <AvatarImage path={chat.avatarPath} initial={chat.initial} />
                {chat.friendNumber !== undefined && (unreadFriendCounts[String(chat.friendNumber)] ?? 0) > 0 && <b className="contact-avatar-unread" title={t("Новые непрочитанные сообщения")} aria-label={formatUnreadMessagesLabel(unreadFriendCounts[String(chat.friendNumber)], language)}>{unreadFriendCounts[String(chat.friendNumber)]}</b>}
              </span>
              <span className="chat-copy">
                <span className="chat-name" data-i18n-ignore translate="no">{highlightContactName(displayName(chat))}</span>
                <span className={`chat-status ${chat.status}`}><span className="contact-status-dot-leading"><PresenceDot status={chat.status} className="contact-status-dot" /></span>{t(chat.status === "online" ? "Онлайн" : chat.status === "away" ? "Отошёл" : chat.status === "busy" ? "Занят" : "Отключен")}</span>
                <span className="contact-status-message" data-i18n-ignore translate="no">{chat.preview}</span>
              </span>
              <span className="chat-time"><span>{chat.time}</span>{chat.friendNumber !== undefined && (unreadFriendCounts[String(chat.friendNumber)] ?? 0) > 0 && <b className="contact-unread-count" title={t("Новые непрочитанные сообщения")} aria-label={formatUnreadMessagesLabel(unreadFriendCounts[String(chat.friendNumber)], language)}>{unreadFriendCounts[String(chat.friendNumber)]}</b>}</span>
            </button>
          ))}
        </div>
      </aside>}

      <div className="chat-list-splitter" role="separator" aria-label={screen === "settings" ? "Изменить ширину меню настроек" : "Изменить ширину списка контактов"} aria-orientation="vertical" onPointerDown={(event) => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); isResizingListRef.current = true; setIsResizingList(true); resizeChatList(event.clientX); }} onPointerMove={(event) => { if (isResizingListRef.current) resizeChatList(event.clientX); }} onPointerUp={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); finishChatListResize(); }} onPointerCancel={finishChatListResize} onLostPointerCapture={finishChatListResize} />

      {screen === "chat" ? <section className="conversation" onDragEnter={(event) => {
        if (platformCapabilities.nativeFilesystem || !hasFileDragType(event.dataTransfer.types)) return;
        event.preventDefault();
        event.stopPropagation();
        dragDepthRef.current += 1;
        if (canStageFileForActiveChat) keepFileDragReady();
      }} onDragOver={(event) => {
        if (platformCapabilities.nativeFilesystem || !hasFileDragType(event.dataTransfer.types)) return;
        event.preventDefault();
        event.stopPropagation();
        if (canStageFileForActiveChat) keepFileDragReady();
      }} onDragLeave={(event) => {
        if (platformCapabilities.nativeFilesystem) return;
        event.stopPropagation();
        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
        if (dragDepthRef.current === 0 || event.currentTarget === event.target) resetFileDrag();
      }} onDrop={(event) => {
        if (platformCapabilities.nativeFilesystem || !hasFileDragType(event.dataTransfer.types)) return;
        event.preventDefault();
        event.stopPropagation();
        resetFileDrag();
        if (canStageFileForActiveChat) stageFiles(event.dataTransfer.files);
      }}>
        {active.id && !incomingRequestsOpen && <header className="conversation-header">
          <span className={`avatar ${active.color} contact-status-${active.status}`}><AvatarImage path={active.avatarPath} initial={active.initial} /></span>
          <span className="header-copy"><strong className={activePqProtected ? "pq-name" : ""} data-i18n-ignore translate="no">{activeName}</strong><small><span className={`header-meta ${activePqProtected ? "pq-active" : ""}`}>{activePqProtected ? "Защищено пост-квантовым шифрованием" : "защищённый чат E2EE"}</span></small></span>
          <div className="header-actions" onClick={(event) => event.stopPropagation()}>{messageSearchOpen ? <div className="message-search"><input aria-label="Поиск в чате" autoFocus value={messageSearch} onChange={(event) => setMessageSearch(event.target.value)} placeholder="Поиск в чате" /><span className="message-search-count" aria-live="polite">{messageSearchBusy ? "…" : messageSearch.trim() ? messageSearchMatches.length ? `${searchPage.offset + messageSearchIndex + 1}/${searchPage.offset + messageSearchMatches.length}${searchNextCursor ? "+" : ""}` : "0/0" : ""}</span><button disabled={!messageSearchMatches.length} onClick={() => moveSearchResult(-1)} aria-label="Предыдущее совпадение" title="Предыдущее совпадение">‹</button><button disabled={!messageSearchMatches.length} onClick={() => moveSearchResult(1)} aria-label="Следующее совпадение" title="Следующее совпадение">›</button><button onClick={closeMessageSearch} aria-label="Закрыть поиск" title="Закрыть поиск">×</button></div> : <button onClick={() => setMessageSearchOpen(true)} aria-label="Поиск">⌕</button>}<span className="more-actions"><button onClick={() => { const next = !contactMenuOpen; dismissContextMenus(); setContactMenuOpen(next); }} aria-label="Меню">⋮</button>{contactMenuOpen && <div className="contact-menu"><button onClick={() => { setContactActionTarget(active); setRenameDraft(activeName); setContactAction("rename"); }}>Переименовать контакт</button><button onClick={exportHistory}>Экспорт истории чата</button><button onClick={clearContactHistory}>Очистить историю чата</button><PqSessionControl status={activePq} onCommand={(command) => { updatePqStatus(command); setContactMenuOpen(false); }} /><button className="danger-menu" onClick={() => { setContactMenuOpen(false); setContactActionTarget(active); setContactAction("delete"); }}>Удалить контакт</button></div>}</span></div>
        </header>}

        {addContactOpen && <section className="friend-requests-view add-contact-view">
          <header><h2>Отправить запрос на переписку</h2></header>
          <div className="add-contact-content"><form className="add-contact-card" onSubmit={submitFriendRequest}><label>Tox ID<input value={contactToxId} onChange={(event) => setContactToxId(event.target.value)} placeholder="76 символов" autoFocus required /></label><label>Сообщение для авторизации<textarea value={friendRequestMessage} onChange={(event) => { friendRequestCustomized.current = true; setFriendRequestMessage(event.target.value); }} data-i18n-ignore translate="no" required /></label>{addContactStatus && <p className="add-contact-status">{addContactStatus} <button type="button" className="request-status-link" onClick={() => { setAddContactOpen(false); setIncomingRequestsOpen(true); }}>Исходящие запросы доступны в разделе «Запросы на переписку».</button></p>}<div><button type="button" className="text-button" onClick={() => setAddContactOpen(false)}>Отмена</button><button className="send-file-button" type="submit">Отправить запрос</button></div></form></div>
        </section>}

        {incomingRequestsOpen && <section className="friend-requests-view">
          <header><h2>Запросы на переписку</h2></header>
          <div className="requests-content">
            <section className="request-section"><h3>Входящие</h3>{incomingFriendRequests.length ? <div className="incoming-request-list">{incomingFriendRequests.map((request) => <article className="incoming-request" data-kaigen-ui-entity-key={opaqueUiEntityKey("incoming-request", request.public_key)} key={request.public_key}><b>Контакт {request.public_key.slice(-6)}</b><code>{request.public_key}</code>{request.message ? <p data-i18n-ignore translate="no">{request.message}</p> : <p>{t("Без сообщения")}</p>}<button className="send-file-button" onClick={() => { void invoke<number>("accept_incoming_friend_request", { publicKey: request.public_key }).then(() => setIncomingFriendRequests((requests) => requests.filter((item) => item.public_key !== request.public_key))); }}>Принять</button></article>)}</div> : <p className="requests-note">Входящих запросов нет.</p>}</section>
            <section className="request-section"><h3>Исходящие</h3>{outgoingFriendRequests.length ? <div className="incoming-request-list">{outgoingFriendRequests.map((request) => <article className="incoming-request outgoing-request" data-kaigen-ui-entity-key={opaqueUiEntityKey("outgoing-request", request.toxId)} key={request.toxId}><b>Контакт {request.toxId.slice(-6)}</b><button type="button" className="cancel-request-button" onClick={() => cancelOutgoingFriendRequest(request.toxId)}>Отменить запрос</button><code>{request.toxId}</code>{request.message ? <p data-i18n-ignore translate="no">{request.message}</p> : <p>{t("Без сообщения")}</p>}<span className="request-pending">Ожидает авторизации</span></article>)}</div> : <p className="requests-note">Исходящих запросов нет.</p>}</section>
          </div>
        </section>}

        {canStageFileForActiveChat && isDraggingFile && <div className="file-drop-overlay" aria-hidden="true">Отпустите файл, чтобы отправить его в чат</div>}
        {pendingFileMatchesActiveTarget && pendingFiles.length > 0 && <div className="file-confirm-overlay" role="dialog" aria-modal="true" aria-label={t("Подтверждение отправки файлов")}><div className="file-confirm-card"><b>{pendingFiles.length === 1 ? t("Отправить файл?") : `${t("Отправить файлы")} (${pendingFiles.length})?`}</b><div className="file-confirm-list">{pendingFiles.map((selection, index) => <span data-i18n-ignore translate="no" key={`${selection.file.name}-${selection.size}-${index}`}>{selection.file.name} · {formatFileSize(selection.size)}</span>)}</div>{fileSendError && <small className="file-confirm-error">{fileSendError}</small>}<div><button className="text-button" disabled={fileSendBusy} onClick={clearPendingFile}>{t("Отмена")}</button><button className="send-file-button" disabled={fileSendBusy} onClick={() => void confirmFileSend()}>{fileSendBusy ? "…" : t("Отправить")}</button></div></div></div>}
        {fullImage?.url && <ChatImageViewer url={fullImage.url} name={fullImage.name} onClose={() => setFullImage(null)} />}

        <div className={`message-scroll ${messageScrollActive ? "scroll-active" : ""}`} ref={messageScrollRef} tabIndex={0} onWheel={noteUserScrollActivity} onPointerDown={startDirectScroll} onPointerUp={finishDirectScroll} onPointerCancel={finishDirectScroll} onKeyDown={noteScrollKey} onScroll={updateLatestButton}>
          {!active.id && <p className="empty-conversation">Выберите контакт из списка или добавьте новый по Tox ID.</p>}
          {searchError && <button className="history-action" onClick={() => { searchRecoveryAttemptsRef.current = 0; setSearchPage((current) => ({ ...current })); }}>{language === "ru" ? "Поиск не завершён · повторить" : "Search did not complete · retry"}</button>}
          {historyError && <button className="history-action" onClick={() => setMessageRefreshRequest((value) => value + 1)}>{language === "ru" ? "Не удалось загрузить историю · повторить" : "History could not load · retry"}</button>}
          {historyHasMore && <button className="history-action" disabled={historyLoading} onClick={loadOlderHistory}>{historyLoading ? "…" : language === "ru" ? "Загрузить предыдущие сообщения" : "Load earlier messages"}</button>}
          {renderedMessages.length > 0 && historySpaceBefore > 0 && <div className="history-space" aria-hidden="true" style={{ height: Math.max(0, historySpaceBefore - 8) }} />}
          {renderedMessages.map((message, windowIndex) => {
            const index = messageWindow.start + windowIndex;
            return (
            <Fragment key={message.coreId ?? message.id}>
            {(index === 0 || messageDayModelKey(messages[index - 1].timestamp) !== messageDayModelKey(message.timestamp)) && <span className="date-chip" data-kaigen-ui-entity-key={opaqueUiEntityKey("message-day", messageDayModelKey(message.timestamp))}>{formatMessageDay(message.timestamp, language)}</span>}
            {unseenBoundary === (message.coreId ?? String(message.id)) && <span className="chat-unseen-divider">{language === "ru" ? "Новые сообщения" : "New messages"}</span>}
            {message.event?.kind === "pq" ? <PqHistoryCard event={message.event} mine={!!message.mine} time={message.time} messageKey={message.coreId ?? String(message.id)} contactName={activeName} onWithdraw={() => updatePqStatus("withdraw_pq_session")} onReject={() => updatePqStatus("reject_pq_session")} onAccept={() => updatePqStatus("accept_pq_session")} /> : <article tabIndex={0} data-message-key={message.coreId ?? String(message.id)} data-kaigen-ui-entity-key={opaqueUiEntityKey("chat-message", message.coreId ?? String(message.id))} className={`message ${message.mine ? "mine" : ""} ${message.attachment?.url ? "has-image" : ""} ${message.attachment && !message.attachment.url ? "has-file" : ""}`}>
              {message.quote && <MessageQuotePreview quote={quoteForDisplay(message)} onActivate={(messageId) => jumpToMessageKey(messageId)} />}
              {message.attachment && <>
                {message.attachment.url && <div className="image-attachment"><button onClick={() => message.attachment?.completed && setFullImage(message.attachment)} title={message.attachment.completed ? "Открыть изображение" : "Изображение ещё передаётся"}><img src={message.attachment.url} alt={message.attachment.name} onLoad={() => correctScrollAfterMediaLoad(message.coreId ?? String(message.id))} /></button>{isTerminalTransferState(message.attachment.transferState) && !message.attachment.completed && <span className="image-transfer-terminal">{attachmentTransferTitle(message.attachment, !!message.mine)}</span>}<time className="image-attachment-time">{message.time}{message.mine && <span className="delivery-state">{message.delivery === "delivered" ? <span title={deliveryReceiptTitle(message)} aria-label={deliveryReceiptTitle(message)}>✓</span> : null}</span>}</time></div>}
                {!message.attachment.url && message.attachment.image && message.attachment.completed && <button className="hidden-image-card" onClick={() => revealAttachmentImage(message)}><span>{t(showReceivedImages || revealedImages.includes(message.coreId ?? "") ? "Восстановление изображения…" : "Изображение скрыто настройками приватности")}</span><small data-i18n-ignore translate="no">{renderSearchValue(message, message.attachment.name, "attachment")} · {formatFileSize(message.attachment.size)}</small><b>{t(showReceivedImages || revealedImages.includes(message.coreId ?? "") ? "Повторить показ" : "Показать")}</b></button>}
                {!message.attachment.url && !(message.attachment.image && message.attachment.completed) && <div className="file-attachment">
                  <span className="file-attachment-icon" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M3.5 1.5h5.25l3.75 3.75v9.25h-9z" /><path d="M8.75 1.5v3.75h3.75" /><path d="M5.75 8.25h4.5M5.75 10.75h4.5" /></svg></span><span data-i18n-ignore translate="no">{renderSearchValue(message, message.attachment.name, "attachment")}</span>
                  {message.attachment.completed || isTerminalTransferState(message.attachment.transferState) ? <small className="file-static-meta">{isTerminalTransferState(message.attachment.transferState) ? attachmentTransferTitle(message.attachment, !!message.mine) : formatFileSize(message.attachment.size)}{platformCapabilities.outgoingTransferRetry && message.mine && message.attachment.transferState === "failed" && <button className="transfer-control transfer-retry" aria-label="Повторить передачу" title="Повторить передачу" onClick={() => retryAttachmentTransfer(message)}>↻</button>}<time>{message.time}{message.mine && <span className="delivery-state">{shouldShowPendingDelivery(message.delivery, message.attachment.transferState) ? <i className="delivery-spinner" title="Ожидает отправки" aria-label="Ожидает отправки" /> : message.delivery === "delivered" ? <span title={deliveryReceiptTitle(message)} aria-label={deliveryReceiptTitle(message)}>✓</span> : null}</span>}</time></small> : <div className="attachment-transfer-actions attachment-transfer-actions-header">
                    {!message.mine && message.attachment.transferState === "awaiting_confirmation" && <button type="button" className="transfer-control transfer-retry transfer-accept" aria-label={t("Принять файл")} title={t("Принять файл")} onClick={() => controlAttachmentTransfer(message, "resume")}><svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d="m3.5 8 3 3 6-6" /></svg></button>}
                    {message.attachment.transferState !== "queued" && message.attachment.transferState !== "awaiting_confirmation" && <button className={`transfer-control ${message.attachment.transferState === "paused" ? "transfer-resume" : "transfer-pause"}`} aria-label={message.attachment.transferState === "paused" ? "Продолжить передачу" : "Приостановить передачу"} title={message.attachment.transferState === "paused" ? "Продолжить передачу" : "Приостановить передачу"} onClick={() => controlAttachmentTransfer(message, message.attachment?.transferState === "paused" ? "resume" : "pause")}>{message.attachment.transferState === "paused" ? "▶" : "Ⅱ"}</button>}
                    <button className="transfer-control transfer-cancel" aria-label="Отменить передачу" title="Отменить передачу" onClick={() => controlAttachmentTransfer(message, "cancel")}>×</button>
                  </div>}
                </div>}
                {shouldShowTransferActivity(message.attachment.completed, message.attachment.transferState) && <div className={`attachment-transfer ${message.attachment.url ? "attachment-transfer-image" : "attachment-transfer-file"}`} aria-label={attachmentTransferText(message.attachment, !!message.mine)}>
                  <div className="attachment-transfer-head"><b>{attachmentTransferTitle(message.attachment, !!message.mine)}</b>{message.attachment.url && <span>{attachmentProgress(message.attachment)}%</span>}</div>
                  <div className="attachment-progress"><i style={{ width: `${attachmentProgress(message.attachment)}%` }} /></div>
                  <small>{attachmentTransferText(message.attachment, !!message.mine)}</small>
                  {(message.attachment.error || (message.coreId && transferErrors[message.coreId])) && <small className="attachment-transfer-error">{formatUserFacingError(message.coreId && transferErrors[message.coreId] ? transferErrors[message.coreId] : message.attachment.error, { ru: "Передача файла завершилась ошибкой", en: "File transfer failed" }, language)}</small>}
                  <small className="file-transfer-meta">{message.attachment.url ? formatFileSize(message.attachment.size) : <span className="file-transfer-percent">{attachmentProgress(message.attachment)}%</span>}<time>{message.time}{message.mine && <span className="delivery-state">{shouldShowPendingDelivery(message.delivery, message.attachment.transferState) ? <i className="delivery-spinner" title="Ожидает отправки" aria-label="Ожидает отправки" /> : message.delivery === "delivered" ? <span title={deliveryReceiptTitle(message)} aria-label={deliveryReceiptTitle(message)}>✓</span> : null}</span>}</time></small>
                </div>}
              </>}
              {message.text ? <p><span className="message-text" data-i18n-ignore translate="no">{renderMessageText(message)}</span>{!message.attachment && <time>{message.time}{renderDeliveryState(message)}</time>}</p> : !message.attachment && <div className="attachment-message-meta"><time>{message.time}{renderDeliveryState(message)}</time></div>}
              {message.attachment && isTerminalTransferState(message.attachment.transferState) && (message.attachment.error || (message.coreId && transferErrors[message.coreId])) && <small className="attachment-transfer-error">{formatUserFacingError(message.coreId && transferErrors[message.coreId] ? transferErrors[message.coreId] : message.attachment.error, { ru: "Передача файла завершилась ошибкой", en: "File transfer failed" }, language)}</small>}
              <ReactionBar reactions={message.reactions} statusMessage={reactionErrors[message.coreId ?? ""]} />
            </article>}
            </Fragment>
          ); })}
          {renderedMessages.length > 0 && historySpaceAfter > 0 && <div className="history-space" aria-hidden="true" style={{ height: Math.max(0, historySpaceAfter - 8) }} />}
          {messageSearchOpen && messageSearch.trim() && !messageSearchBusy && messageSearchMatches.length === 0 && <p className="empty-search">Совпадений не найдено</p>}
        </div>

        <div className="chat-composer-section">
        {pendingIncomingCount > 0
          ? <button className="jump-latest has-new" onClick={jumpToLatest} aria-label="Перейти к последнему сообщению">{`↓ Новые сообщения${pendingIncomingCount > 1 ? ` · ${pendingIncomingCount}` : ""}`}</button>
          : showJumpToLatest
            ? <button className="jump-latest" onClick={jumpToLatest} aria-label="Перейти к последнему сообщению">↓ В конец</button>
            : null}

        {active.friendNumber !== undefined && activePqAwaitingDecision && <PqCapabilityWait key={`${activeProfileId}:${active.friendNumber}:capability`} friendNumber={active.friendNumber} reason={activePqCancelledAwaitingDecision ? "cancelled" : "checking"} onSkip={skipPqAuto} />}
        {active.friendNumber !== undefined && activePq?.identity_needs_entropy && activePq.identity_waiting && <PqEntropy key={`${activeProfileId}:${active.friendNumber}`} friendNumber={active.friendNumber} onBegin={beginPqEntropy} onComplete={completePqIdentity} />}
        {reactionNotices.length > 0 && <div className="chat-service-notices">{reactionNotices.map((notice) => <OffscreenReactionNotice key={`${notice.messageKey}:${notice.revision}`} reaction={notice.reaction} removed={notice.removed} onNavigate={() => navigateReactionNotice(notice.messageKey)} />)}</div>}
        {pendingSentMessage && <button className="chat-pending-send" onClick={() => { jumpToMessageKey(pendingSentMessage); setPendingSentMessage(null); }}>{language === "ru" ? "Сообщение отправлено в очередь · показать" : "Message queued · show"}</button>}
        {failedSends.filter((operation) => operation.chatId === active.id).map((operation) => <button key={operation.operationId} className="chat-send-retry" onClick={() => void submitSendOperation(operation)}><span data-i18n-ignore translate="no">{operation.text.slice(0, 160)}</span><b>{language === "ru" ? "Отправка не подтверждена · проверить и повторить" : "Send not confirmed · check and retry"}</b></button>)}
        {returnAnchor && <button className="chat-return-anchor" onClick={returnToReadingPosition}>{language === "ru" ? "Вернуться к месту чтения" : "Return to previous position"}</button>}
        {localPersistenceError && <button className="chat-save-error" onClick={() => void persistLocalState()}>{language === "ru" ? "Не удалось сохранить локальные данные · повторить" : "Local data could not be saved · retry"}</button>}
        <MessageComposer
          chatId={activeChat}
          focusRequest={composerFocusRequest}
          initialValue={draftsRef.current[activeChat] ?? ""}
          sendOnEnter={sendOnEnter}
          spellcheckEnabled={persistenceReady && spellcheckEnabled}
          spellcheckRussian={spellcheckRussian}
          spellcheckEnglish={spellcheckEnglish}
          formattingEnabled={chatCapabilities.formatting}
          initialFormatting={draftFormattingRef.current[activeChat] ?? []}
          onDraftFormattingChange={updateDraftFormatting}
          reply={replyQuote}
          onCancelReply={cancelReply}
          onDraftChange={updateDraft}
          onSend={stableSendMessage}
          onStageFiles={stageFiles}
          onPasteFiles={stagePastedFiles}
          onPickFile={platformCapabilities.nativeFilesystem ? pickNativeFile : undefined}
          fileActionsEnabled={canStageFileForActiveChat}
        />
        </div>
      </section> : <Settings profileId={activeProfileId} compact={compactSidebar} sidebarHeader={profileSidebarHeader} avatarState={ownAvatarState} openRequest={settingsOpenRequest} appearance={appearance} onAppearanceApply={setAppearance} avatarUrl={profileAvatar} onAvatarChange={updateProfileAvatar} nickname={profileName} onNicknameChange={setProfileName} sendOnEnter={sendOnEnter} onSendOnEnterChange={setSendOnEnter} historyMessageLimit={historyMessageLimit} onHistoryMessageLimitChange={setHistoryMessageLimit} onAutoDownloadImagesChange={setAutoDownloadImages} saveChatHistory={saveChatHistory} onSaveChatHistoryChange={setSaveChatHistory} notifyMessages={notifyMessages} onNotifyMessagesChange={setNotifyMessages} notifyRequests={notifyRequests} onNotifyRequestsChange={setNotifyRequests} spellcheckEnabled={spellcheckEnabled} onSpellcheckEnabledChange={setSpellcheckEnabled} spellcheckRussian={spellcheckRussian} onSpellcheckRussianChange={setSpellcheckRussian} spellcheckEnglish={spellcheckEnglish} onSpellcheckEnglishChange={setSpellcheckEnglish} toxId={ownToxId} />}
    </main>
  );
}

export default App;
