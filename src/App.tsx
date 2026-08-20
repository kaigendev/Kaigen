import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { convertFileSrc } from "@tauri-apps/api/core";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import "./App.css";
import Settings, { type AppearanceSettings, type SettingsOpenRequest, type TorStatus } from "./Settings";
import MessageComposer, { clearSpellcheckMemory } from "./SpellcheckComposer";
import ProfileAvatar, { type ProfileAvatarState } from "./ProfileAvatar";
import type { ProfileSummary } from "./RootApp";
import { useI18n } from "./i18n";
import { profileAvatarToToxPng } from "./avatar";
import {
  migrateLegacyContactRecord,
  migrateLegacyToxChatId,
  resolveFriendChatId,
  toxChatId,
} from "./contactIdentity";
import {
  APP_RAIL_WIDTH,
  SIDEBAR_MAX_REQUESTED_WIDTH,
  SIDEBAR_MIN_REQUESTED_WIDTH,
  resolveAppLayout,
} from "./appLayout";
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
  chatNavigationMode,
  DEFAULT_NOTIFICATION_SETTINGS,
  incomingContextMetrics,
  incomingNavigationBatch,
  incomingPrepaintAction,
  mediaLoadBelongsToIntent,
  shouldPrepaintOutgoing,
  shouldPublishNavigationForScroll,
  shouldShowJumpToLatest,
} from "./chatNavigation";

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
  transferState?: "queued" | "sending" | "awaiting_confirmation" | "receiving" | "paused" | "cancelled" | "failed" | "complete";
  completed?: boolean; completedAt?: number | null; error?: string | null; retryCount?: number;
};

type PqHistoryEvent = { kind: "pq"; status: "offered" | "incoming_offer" | "accepting" | "active" | "rejected" | "withdrawn" | "superseded" | "close_pending" | "closed" | "error"; role: "initiator" | "responder"; local_fingerprint: string; peer_fingerprint?: string | null; fingerprint_changed?: boolean; error?: string | null };
type Message = { id: number; coreId?: string; text: string; mine?: boolean; timestamp: number; time: string; attachment?: Attachment; delivery?: "pending" | "awaiting_receipt" | "delivered" | "sent"; deliveredAt?: number | null; event?: PqHistoryEvent | null };
type UserStatus = "online" | "away" | "busy" | "offline";
type NetworkStatus = "connecting-tor" | "connecting" | "online" | "offline";
type HistoryMessageLimit = 20 | 50 | 100 | "all";
type CoreFriend = { number: number; public_key: string; tox_id: string; authorized: boolean; connection: "online" | "offline"; name: string; status: UserStatus; status_message: string; avatar_path?: string | null; last_online?: number | null; last_event?: number | null };
type IncomingFriendRequest = { public_key: string; message: string };
type OutgoingFriendRequest = { toxId: string; message: string };
type CoreMessage = { id?: string; friend_number: number; text: string; mine: boolean; timestamp: number; delivery?: "pending" | "awaiting_receipt" | "delivered" | "sent"; delivered_at?: number | null; attachment?: { name: string; size: number; mime: string; path: string; image: boolean; transferred?: number; speed_bytes_per_sec?: number; eta_seconds?: number | null; transfer_state?: "queued" | "sending" | "awaiting_confirmation" | "receiving" | "paused" | "cancelled" | "failed" | "complete"; completed?: boolean; completed_at?: number | null; transfer_error?: string | null; retry_count?: number } | null; event?: PqHistoryEvent | null };
type CoreMessagesSnapshot = { revision: number; messages?: CoreMessage[] | null };
type PqStatus = { supported: boolean; state: "unavailable" | "available" | "offered" | "incoming_offer" | "accepting" | "active" | "closing" | "closing_commit" | "closing_ack" | "closing_final" | "error"; local_fingerprint: string; peer_fingerprint?: string | null; fingerprint_changed: boolean; error?: string | null };
const PQ_PROTECTED_STATES = new Set<PqStatus["state"]>(["active", "closing", "closing_commit", "closing_ack", "closing_final"]);
const isPqTransportProtected = (status?: PqStatus) => !!status && PQ_PROTECTED_STATES.has(status.state);
type FileReceiveSettings = { denyAll: boolean; autoAcceptImages: boolean; showImages: boolean; autoAcceptAny: boolean; maxAutoBytes: number; maxConcurrent: number };
type ProxySettings = { mode: "none" | "socks5" | "http"; host: string; port: number; username: string; password: string };
type AppEventNotice = { id: number; title: string; body: string; friendNumber?: number; friendPublicKey?: string; requests?: boolean };
type UnreadState = { friends: Record<string, number>; requests: string[] };
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
type AttachmentContext = { x: number; y: number; kind: "copy" | "image" | "file"; path?: string; showInFolder?: boolean };
type LocalState = Partial<{
  activeChat: string;
  sendOnEnter: boolean;
  userStatus: UserStatus;
  profileAvatar: string | null;
  profileName: string;
  contactNames: Record<string, string>;
  autoDownloadImages: boolean;
  saveChatHistory: boolean;
  outgoingFriendRequests: OutgoingFriendRequest[];
  drafts: Record<string, string>;
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
};

const DEFAULT_APPEARANCE: AppearanceSettings = {
  chatFont: "Inter, Segoe UI, Arial, sans-serif",
  chatFontSize: 20,
  interfaceScale: 100,
};
let sharedLayoutState: LayoutState | null = null;
let sharedLayoutHydrated = false;
let sharedLayoutLoad: Promise<Partial<LayoutState> | null> | null = null;

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
  if (!source || currentState.failed) return <>{initial}</>;
  return <>{!currentState.loaded && initial}<img
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
  const locale = language === "en" ? "en-US" : "ru-RU";
  const sameDay = date.toDateString() === today.toDateString();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const day = sameDay ? (language === "en" ? "today" : "сегодня") : date.toDateString() === yesterday.toDateString()
    ? (language === "en" ? "yesterday" : "вчера")
    : new Intl.DateTimeFormat(locale, { day: "2-digit", month: "2-digit", year: date.getFullYear() === today.getFullYear() ? undefined : "numeric" }).format(date);
  return `${day}, ${new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(date)}`;
}

function formatMessageDay(timestamp: number, language: "ru" | "en"): string {
  const date = new Date(timestamp * 1000);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return language === "en" ? "Today" : "Сегодня";
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return language === "en" ? "Yesterday" : "Вчера";
  return new Intl.DateTimeFormat(language === "en" ? "en-US" : "ru-RU", {
    day: "2-digit",
    month: "long",
    year: date.getFullYear() === today.getFullYear() ? undefined : "numeric",
  }).format(date);
}

const emptyChat: Chat = { id: "", initial: "", name: "Выберите контакт", preview: "", time: "", color: "blue", status: "offline", lastOnline: "", toxId: "" };

function sameData(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
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

function ProfileSwitcher({ profiles, onSwitch, switching }: { profiles: ProfileSummary[]; onSwitch: (id: string) => void; switching: boolean }) {
  const { language } = useI18n();
  const available = Array.from(new Map(profiles.filter((profile) => profile.loaded).map((profile) => [profile.id, profile])).values());
  const hostRef = useRef<HTMLDivElement>(null);
  const [hostWidth, setHostWidth] = useState(0);
  const [startIndex, setStartIndex] = useState(0);
  const activeId = available.find((profile) => profile.active)?.id ?? "";
  const fullWidth = available.length * 46;
  const carousel = hostWidth > 0 && fullWidth > hostWidth;
  const visibleCount = carousel
    ? Math.max(1, Math.min(available.length, Math.floor((hostWidth - 32) / 46)))
    : available.length;

  useLayoutEffect(() => {
    if (!hostRef.current) return;
    const update = () => setHostWidth(hostRef.current?.clientWidth ?? 0);
    const observer = new ResizeObserver(update);
    observer.observe(hostRef.current);
    update();
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const activeIndex = available.findIndex((profile) => profile.id === activeId);
    if (activeIndex >= 0) setStartIndex(activeIndex);
  }, [activeId, available.length, visibleCount]);

  if (available.length < 2) return null;
  const visible = carousel
    ? Array.from({ length: visibleCount }, (_, offset) => available[(startIndex + offset) % available.length])
    : available;
  const move = (direction: number) => setStartIndex((current) => (current + direction + available.length) % available.length);

  return <div ref={hostRef} className={`profile-switcher ${carousel ? "carousel" : ""}`} aria-label="Доступные профили">
    {carousel && <button type="button" className="profile-carousel-arrow previous" onClick={() => move(-1)} title="Предыдущие профили" aria-label="Показать предыдущие профили">‹</button>}
    <div className="profile-switcher-track">
      {visible.map((profile) => {
        const avatarStatus = profile.loaded ? profile.userStatus : "offline";
        return <button type="button" key={profile.id} disabled={switching} className={`profile-switcher-item status-${avatarStatus} ${profile.active ? "active" : ""}`} data-i18n-ignore translate="no" onClick={() => { if (!profile.active && !switching) onSwitch(profile.id); }} title={formatProfileSwitcherTitle(profile.name, avatarStatus, language)} aria-label={formatProfileSwitcherAria(profile.name, language)}>
          <ProfileAvatar src={profile.avatar} initial={profile.name.charAt(0).toUpperCase()} state={avatarStatus} className="profile-switcher-avatar" />
          {profile.unread > 0 && <b>{profile.unread > 99 ? "99+" : profile.unread}</b>}
        </button>;
      })}
    </div>
    {carousel && <button type="button" className="profile-carousel-arrow next" onClick={() => move(1)} title="Следующие профили" aria-label="Показать следующие профили">›</button>}
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
  return <article data-message-key={messageKey} className={`pq-offer-message pq-history-message ${event.status} ${mine ? "mine" : ""}`}>
    <div className="pq-history-heading"><b data-i18n-ignore translate="no">{title}</b><time>{time}</time></div>
    <p data-i18n-ignore translate="no">{description}</p>
    <div className="pq-history-fingerprints">
      <label>{t("Ваш отпечаток")}<code>{event.local_fingerprint || "—"}</code></label>
      <label>{t("Отпечаток контакта")}<code>{event.peer_fingerprint || "—"}</code></label>
    </div>
    {event.fingerprint_changed && <em>{t("Отпечаток контакта изменился. Сверьте его по независимому каналу.")}</em>}
    {event.error && event.status === "error" && <em>{formatUserFacingError(event.error, { ru: "Не удалось завершить постквантовое согласование", en: "Post-quantum negotiation failed" }, language)}</em>}
    {(event.status === "offered" && mine) || (event.status === "incoming_offer" && !mine) ? <div className="pq-history-actions">
      {event.status === "offered" && mine && <button className="text-button" onClick={onWithdraw}>{t("Отозвать запрос")}</button>}
      {event.status === "incoming_offer" && !mine && <><button className="text-button" onClick={onReject}>{t("Отказаться")}</button><button className="pq-confirm-button" onClick={onAccept}>{t("Принять и продолжить")}</button></>}
    </div> : null}
  </article>;
}

function App({ profiles, onSwitchProfile, onDisableProfile, onDestroyActiveProfile, profileSwitching = false }: { profiles: ProfileSummary[]; onSwitchProfile: (id: string) => void; onDisableProfile: (id: string) => Promise<void>; onDestroyActiveProfile: () => Promise<void>; profileSwitching?: boolean }) {
  const { language, t } = useI18n();
  const activeProfileAtMount = profiles.find((profile) => profile.active && profile.loaded);
  const layoutAtMount = useRef(sharedLayoutState).current;
  const [transferUiStateOverrides, setTransferUiStateOverrides] = useState<
    Record<string, NonNullable<Attachment["transferState"]>>
  >({});
  const [screen, setScreen] = useState<"chat" | "settings">(() => sessionStorage.getItem("kaigen-active-screen") === "settings" ? "settings" : "chat");
  const [appearance, setAppearance] = useState<AppearanceSettings>(() => layoutAtMount?.appearance ?? DEFAULT_APPEARANCE);
  const [activeChat, setActiveChat] = useState("");
  const draftsRef = useRef<Record<string, string>>({});
  const draftCommitTimer = useRef<number | undefined>(undefined);
  const draftMaxCommitTimer = useRef<number | undefined>(undefined);
  const [sendOnEnter, setSendOnEnter] = useState(true);
  const [historyMessageLimit, setHistoryMessageLimit] = useState<HistoryMessageLimit>(50);
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
  const [profileActionBusy, setProfileActionBusy] = useState<"disable" | "destroy" | null>(null);
  const [confirmDestroyProfile, setConfirmDestroyProfile] = useState(false);
  const [profileAvatar, setProfileAvatar] = useState<string | null>(() => activeProfileAtMount?.avatar ?? null);
  const [profileName, setProfileName] = useState(() => activeProfileAtMount?.name ?? "Tox User");
  const [messageSearchOpen, setMessageSearchOpen] = useState(false);
  const [messageSearch, setMessageSearch] = useState("");
  const [messageSearchMatches, setMessageSearchMatches] = useState<MessageSearchMatch[]>([]);
  const [messageSearchIndex, setMessageSearchIndex] = useState(-1);
  const [messageSearchBusy, setMessageSearchBusy] = useState(false);
  const [contactSearch, setContactSearch] = useState("");
  const [contactMenuOpen, setContactMenuOpen] = useState(false);
  const [contactAction, setContactAction] = useState<"rename" | "delete" | null>(null);
  const [contactActionTarget, setContactActionTarget] = useState<Chat | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [contactContext, setContactContext] = useState<{ x: number; y: number; chat: Chat } | null>(null);
  const [generalContext, setGeneralContext] = useState<AttachmentContext | null>(null);
  const [eventNotices, setEventNotices] = useState<AppEventNotice[]>([]);
  const pendingUnreadFriendNumber = useRef<number | null>(null);
  const [contactNames, setContactNames] = useState<Record<string, string>>({});
  const [contactsScrollActive, setContactsScrollActive] = useState(false);
  const [messageScrollActive, setMessageScrollActive] = useState(false);
  const [chatListWidth, setChatListWidth] = useState(() => layoutAtMount?.chatListWidth ?? 360);
  const [isResizingList, setIsResizingList] = useState(false);
  const isResizingListRef = useRef(false);
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [nativeDropPath, setNativeDropPath] = useState<string | null>(null);
  const [nativeDropSize, setNativeDropSize] = useState<number | null>(null);
  const [fileSendError, setFileSendError] = useState<string | null>(null);
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
  const [ownStatusMessage, setOwnStatusMessage] = useState(() => language === "en" ? "Ready to chat" : "Готов к общению");
  const [editingOwnStatusMessage, setEditingOwnStatusMessage] = useState(false);
  const [addContactOpen, setAddContactOpen] = useState(false);
  const [contactToxId, setContactToxId] = useState("");
  const [friendRequestMessage, setFriendRequestMessage] = useState(() => formatFriendRequestDefault(language));
  const friendRequestCustomized = useRef(false);
  const [addContactStatus, setAddContactStatus] = useState<string | null>(null);
  const [incomingRequestsOpen, setIncomingRequestsOpen] = useState(false);
  const [persistenceReady, setPersistenceReady] = useState(false);
  const [settingsOpenRequest, setSettingsOpenRequest] = useState<SettingsOpenRequest>({ tab: "profile", nonce: 0 });
  sharedLayoutState = { appearance, chatListWidth };
  const [pqStatuses, setPqStatuses] = useState<Record<number, PqStatus>>({});
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const [torStatus, setTorStatus] = useState<TorStatus>({ state: "starting", progress: 0, message: "Запуск Tor", socksPort: null, controlPort: null, transport: "none" });
  const [proxySettings, setProxySettings] = useState<ProxySettings>({ mode: "none", host: "127.0.0.1", port: 9050, username: "", password: "" });
  const torEnabled = torStatus.state === "connected";
  const customProxyActive = torStatus.state === "disabled" && proxySettings.mode !== "none";
  const torIndicatorText = formatTorIndicator(torStatus, proxySettings, language);
  const messageScrollRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<Message[]>(initialMessages);
  const messageSnapshotChatRef = useRef("");
  const historyRevisionRef = useRef(0);
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
  const readingLongIncomingRef = useRef<IncomingReadingState | null>(null);
  const trackedUnreadCountRef = useRef(0);
  const scrollPositions = useRef(new Map<string, number>());
  const openedChats = useRef(new Set<string>());
  const pendingScrollRestore = useRef<string | null>(null);
  const [scrollRestoreTick, setScrollRestoreTick] = useState(0);
  const contactsScrollTimer = useRef<number | undefined>(undefined);
  const messageScrollTimer = useRef<number | undefined>(undefined);
  const searchRunRef = useRef(0);
  const seenIncomingMessageKeys = useRef(new Set<string>());
  const seenIncomingRequestKeys = useRef(new Set<string>());
  const messageBaselineReady = useRef(false);
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
  const sendMessageRef = useRef<(text: string) => Promise<boolean>>(async () => false);
  const stableSendMessage = useCallback((text: string) => sendMessageRef.current(text), []);

  persistenceReadyRef.current = persistenceReady;
  unreadFriendCountsRef.current = unreadFriendCounts;
  localStateSnapshotRef.current = {
    activeChat,
    sendOnEnter,
    userStatus,
    profileAvatar,
    profileName,
    contactNames,
    autoDownloadImages,
    saveChatHistory,
    outgoingFriendRequests,
    drafts: draftsRef.current,
    historyMessageLimit,
    notifyMessages,
    notifyRequests,
    spellcheckEnabled,
    spellcheckRussian,
    spellcheckEnglish,
  };

  const persistLocalState = useCallback(async () => {
    const state = localStateSnapshotRef.current;
    if (!persistenceReadyRef.current || !state) return;
    try {
      await invoke("save_local_state", { state });
    } catch (error) {
      console.error("Не удалось сохранить локальные данные", error);
    }
  }, []);

  const switchProfileAfterDraftSave = useCallback((profileId: string) => {
    void persistLocalState().then(() => onSwitchProfile(profileId));
  }, [onSwitchProfile, persistLocalState]);

  useEffect(() => {
    sessionStorage.setItem("kaigen-active-screen", screen);
  }, [screen]);

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
    if (!contactContext) return;
    const close = () => setContactContext(null);
    const closeOutside = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Node) || !contactContextMenuRef.current?.contains(target)) close();
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
  }, [contactContext]);

  useLayoutEffect(() => {
    setContactContext(null);
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
  }, [contactContext, generalContext]);
  useEffect(() => {
    const apply = (settings: FileReceiveSettings) => setShowReceivedImages(settings.showImages);
    void invoke<FileReceiveSettings>("get_file_receive_settings").then(apply).catch(() => {});
    const listener = (event: Event) => apply((event as CustomEvent<FileReceiveSettings>).detail);
    window.addEventListener("file-settings-changed", listener);
    return () => window.removeEventListener("file-settings-changed", listener);
  }, []);

  useEffect(() => {
    void invoke<ProxySettings>("get_proxy_settings").then(setProxySettings).catch(() => {});
    const listener = (event: Event) => setProxySettings((event as CustomEvent<ProxySettings>).detail);
    window.addEventListener("proxy-settings-changed", listener);
    return () => window.removeEventListener("proxy-settings-changed", listener);
  }, []);
  useEffect(() => {
    const target = sessionStorage.getItem("kaigen-open-unread-target");
    if (!target) return;
    sessionStorage.removeItem("kaigen-open-unread-target");
    setScreen("chat");
    if (target === "requests") {
      setAddContactOpen(false);
      setIncomingRequestsOpen(true);
      setActiveChat("");
    } else if (target.startsWith("friend:")) {
      setAddContactOpen(false);
      setIncomingRequestsOpen(false);
      const friendNumber = Number(target.slice("friend:".length));
      if (Number.isInteger(friendNumber) && friendNumber >= 0) {
        pendingUnreadFriendNumber.current = friendNumber;
      }
    }
  }, []);
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
    lastEvent: friend.last_event,
    }));
  const allChats = [...coreChats, ...chats];

  useEffect(() => {
    const pendingNumber = pendingUnreadFriendNumber.current;
    if (pendingNumber !== null) {
      const friend = coreFriends.find((candidate) => candidate.number === pendingNumber);
      if (friend) {
        setActiveChat(toxChatId(friend.public_key));
        pendingUnreadFriendNumber.current = null;
      }
    }
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
  const activeName = plainText(contactNames[active.id] ?? active.name);
  const activeUnreadCount = active.friendNumber === undefined ? 0 : unreadFriendCounts[String(active.friendNumber)] ?? 0;
  const activeStatusText = active.status === "online" ? "Онлайн" : active.status === "away" ? "Отошёл" : active.status === "busy" ? "Занят" : "Отключен";
  const activePq = active.friendNumber === undefined ? undefined : pqStatuses[active.friendNumber];
  const activePqProtected = isPqTransportProtected(activePq);
  const displayName = (chat: Chat) => plainText(contactNames[chat.id] ?? chat.name);
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
    const query = plainText(messageSearch).trim().toLocaleLowerCase(language === "en" ? "en-US" : "ru-RU");
    if (!messageSearchOpen || !query) {
      setMessageSearchMatches([]);
      setMessageSearchIndex(-1);
      setMessageSearchBusy(false);
      return;
    }

    setMessageSearchBusy(true);
    let cancelled = false;
    let cursor = 0;
    let timer: number | undefined;
    const snapshot = messages.flatMap((message) => {
      const messageKey = message.coreId ?? String(message.id);
      const fields: Array<{ messageKey: string; field: MessageSearchMatch["field"]; text: string }> = [];
      if (message.text) fields.push({ messageKey, field: "text", text: plainText(message.text) });
      if (message.attachment && !message.attachment.url) fields.push({ messageKey, field: "attachment", text: plainText(message.attachment.name) });
      return fields;
    });
    const matches: MessageSearchMatch[] = [];

    const scanChunk = () => {
      const deadline = performance.now() + 7;
      while (cursor < snapshot.length && performance.now() < deadline) {
        const item = snapshot[cursor++];
        const normalized = item.text.toLocaleLowerCase(language === "en" ? "en-US" : "ru-RU");
        let offset = 0;
        while (offset <= normalized.length - query.length) {
          const found = normalized.indexOf(query, offset);
          if (found < 0) break;
          matches.push({ messageKey: item.messageKey, field: item.field, start: found, end: found + query.length });
          offset = found + Math.max(1, query.length);
        }
      }
      if (cancelled || runId !== searchRunRef.current) return;
      if (cursor < snapshot.length) {
        timer = window.setTimeout(scanChunk, 0);
        return;
      }
      setMessageSearchMatches(matches);
      setMessageSearchIndex(matches.length ? 0 : -1);
      setMessageSearchBusy(false);
    };

    timer = window.setTimeout(scanChunk, 120);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [language, messageSearch, messageSearchOpen, messages]);

  useLayoutEffect(() => {
    if (!messageSearchOpen || messageSearchIndex < 0 || !messageSearchMatches[messageSearchIndex]) return;
    const frame = window.requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(`[data-search-result="${messageSearchIndex}"]`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [messageSearchIndex, messageSearchMatches, messageSearchOpen]);

  useEffect(() => {
    let mounted = true;
    let friendsRefreshPending = false;
    const refresh = () => {
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
    const timer = window.setInterval(refresh, 1500);
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
    const refresh = () => void invoke<UnreadState>("get_unread_state").then((state) => {
      if (!mounted) return;
      const signature = JSON.stringify(state);
      if (signature === lastUnreadSnapshot.current) return;
      lastUnreadSnapshot.current = signature;
      setUnreadFriendCounts(state.friends ?? {});
      setUnreadIncomingRequestKeys(state.requests ?? []);
      window.dispatchEvent(new Event("profiles-changed"));
    }).catch(() => {});
    refresh();
    const timer = window.setInterval(refresh, 1200);
    return () => { mounted = false; window.clearInterval(timer); };
  }, []);

  useEffect(() => {
    if (!coreFriends.length) return;
    let cancelled = false;
    void Promise.all(coreFriends.map(async (friend) => ({ friend, messages: await invoke<CoreMessage[]>("get_tox_messages", { friendNumber: friend.number }) })))
      .then((snapshots) => {
        if (cancelled) return;
        for (const { friend, messages: friendMessages } of snapshots) {
          for (const message of friendMessages) {
            if (message.mine) continue;
            const key = `${friend.public_key}:${message.id ?? `${message.timestamp}:${message.text}`}`;
            if (!messageBaselineReady.current) {
              seenIncomingMessageKeys.current.add(key);
            } else if (!seenIncomingMessageKeys.current.has(key)) {
              seenIncomingMessageKeys.current.add(key);
              if (activeChat !== toxChatId(friend.public_key)) {
                pushEventNotice({
                  ...formatChatMessageNotice(profileName, friend.name, message.text || message.attachment?.name, language),
                  friendNumber: friend.number,
                  friendPublicKey: friend.public_key,
                });
              }
            }
          }
        }
        if (!messageBaselineReady.current) {
          messageBaselineReady.current = true;
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [activeChat, coreFriends, language, profileName, pushEventNotice]);

  useEffect(() => {
    if (!coreFriends.length) {
      setPqStatuses({});
      return;
    }
    let mounted = true;
    const refresh = () => void Promise.all(coreFriends.map(async (friend) => [friend.number, await invoke<PqStatus>("get_pq_status", { friendNumber: friend.number })] as const))
      .then((statuses) => {
        if (mounted) {
          const nextStatuses = Object.fromEntries(statuses);
          setPqStatuses((current) => sameData(current, nextStatuses) ? current : nextStatuses);
        }
      })
      .catch(() => {});
    refresh();
    const timer = window.setInterval(refresh, 1000);
    return () => { mounted = false; window.clearInterval(timer); };
  }, [coreFriends]);

  useEffect(() => {
    if (active.friendNumber === undefined) {
      messagesRef.current = [];
      messageSnapshotChatRef.current = "";
      setMessages([]);
      return;
    }
    let mounted = true;
    historyRevisionRef.current = 0;
    const refresh = () => void invoke<CoreMessagesSnapshot>("get_tox_messages_snapshot", {
      friendNumber: active.friendNumber,
      limit: historyMessageLimit === "all" ? null : Math.max(historyMessageLimit, activeUnreadCount),
      knownRevision: historyRevisionRef.current,
    })
      .then((snapshot) => {
        if (!mounted) return;
        historyRevisionRef.current = snapshot.revision;
        if (!snapshot.messages) return;
        const items = snapshot.messages;
        const terminalTransferIds = items.flatMap((item) =>
          item.id && isTerminalTransferState(item.attachment?.transfer_state)
            ? [item.id]
            : [],
        );
        const nextMessages = items.map((item, index) => ({
          id: item.timestamp * 1000 + index,
          coreId: item.id,
          text: plainText(item.text),
          mine: item.mine,
          delivery: item.delivery || "sent",
          deliveredAt: item.delivered_at,
          event: item.event,
          timestamp: item.timestamp,
          time: new Date(item.timestamp * 1000).toLocaleTimeString(language === "en" ? "en-US" : "ru-RU", { hour: "2-digit", minute: "2-digit" }),
          attachment: item.attachment ? {
            name: plainText(item.attachment.name), size: item.attachment.size, type: plainText(item.attachment.mime), path: item.attachment.path,
            // A local sender can preview the original immediately. A received
            // image is exposed only after its final chunk has been written.
            url: item.attachment.image && (item.mine || item.attachment.completed !== false) && (item.mine || showReceivedImages || (item.id ? revealedImages.includes(item.id) : false)) ? convertFileSrc(item.attachment.path) : undefined,
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
        const sameChatSnapshot = messageSnapshotChatRef.current === active.id;
        const previousMessages = sameChatSnapshot ? messagesRef.current : [];
        const previousIds = new Set(previousMessages.map((message) => message.coreId ?? String(message.id)));
        const newMessages = sameChatSnapshot
          ? nextMessages.filter((message) => !previousIds.has(message.coreId ?? String(message.id)))
          : [];
        const unreadCount = unreadFriendCountsRef.current[String(active.friendNumber)] ?? 0;
        const newlyArrivedIncoming = newMessages.filter((message) => !message.mine);
        const unreadBackfill = unreadCount > trackedUnreadCountRef.current
          ? nextMessages.filter((message) => !message.mine).slice(-unreadCount)
          : [];
        const incomingToTrack = (sameChatSnapshot ? [...newlyArrivedIncoming, ...unreadBackfill] : unreadBackfill)
          .filter((message, index, candidates) => {
            const key = message.coreId ?? String(message.id);
            return !unseenIncomingKeysRef.current.has(key)
              && candidates.findIndex((candidate) => (candidate.coreId ?? String(candidate.id)) === key) === index;
          });
        const incomingKeys = incomingToTrack.map((message) => message.coreId ?? String(message.id));
        if (incomingKeys.length) {
          registerUnseenIncoming(incomingKeys);
          trackedUnreadCountRef.current = Math.max(trackedUnreadCountRef.current, unreadCount, incomingKeys.length);
        }
        const latestNewMessage = newMessages[newMessages.length - 1];
        const container = messageScrollRef.current;
        const previousDistance = container
          ? Math.max(0, container.scrollHeight - container.scrollTop - container.clientHeight)
          : 0;
        const changed = !sameData(previousMessages, nextMessages) || !sameChatSnapshot;
        messageSnapshotChatRef.current = active.id;
        messagesRef.current = nextMessages;
        if (incomingToTrack.length && changed) {
          const target = incomingToTrack[0];
          scheduleIncomingScroll(target.coreId ?? String(target.id), previousDistance);
        }
        if (latestNewMessage?.mine && changed) {
          const latestKey = latestNewMessage.coreId ?? String(latestNewMessage.id);
          if (container && shouldPrepaintOutgoing(previousDistance, container.clientHeight)) {
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
      .catch(() => {});
    refresh();
    const timer = window.setInterval(refresh, 700);
    return () => { mounted = false; window.clearInterval(timer); };
  }, [active.friendNumber, activeUnreadCount, historyMessageLimit, language, messageRefreshRequest, revealedImages, screen, showReceivedImages, transferUiStateOverrides]);

  useLayoutEffect(() => {
    if (screen !== "chat" || !active.id) return;
    if (deferredOutgoingScrollRef.current?.chatId === active.id) {
      positionPendingOutgoingBeforePaint();
    } else {
      const reading = readingLongIncomingRef.current;
      const maintained = reading?.chatId === active.id && !reading.userScrolled
        ? maintainLongIncomingContext(reading)
        : false;
      if (!maintained && deferredIncomingScrollRef.current?.chatId === active.id) positionPendingIncomingBeforePaint();
    }
    const frame = window.requestAnimationFrame(() => {
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
    return () => window.cancelAnimationFrame(frame);
  }, [active.id, messages, screen]);

  useEffect(() => {
    if (screen !== "chat" || active.friendNumber === undefined || messageSnapshotChatRef.current !== active.id || historyFarFromLatestRef.current || unseenIncomingKeysRef.current.size > 0) return;
    const currentUnread = unreadFriendCounts[String(active.friendNumber)] ?? 0;
    if (currentUnread <= 0 || trackedUnreadCountRef.current < currentUnread) return;
    const friendNumber = active.friendNumber;
    setUnreadFriendCounts((counts) => {
      if (!(String(friendNumber) in counts)) return counts;
      const next = { ...counts };
      delete next[String(friendNumber)];
      return next;
    });
    void invoke("mark_friend_read", { friendNumber })
      .then(() => {
        trackedUnreadCountRef.current = 0;
        window.dispatchEvent(new Event("profiles-changed"));
      })
      .catch(() => {});
  }, [active.friendNumber, messageVisibilityRevision, screen, unreadFriendCounts]);

  useEffect(() => {
    if (screen === "chat" && active.id && active.friendNumber !== undefined) {
      if (deferredIncomingTimerRef.current !== undefined) window.clearTimeout(deferredIncomingTimerRef.current);
      deferredIncomingTimerRef.current = undefined;
      deferredIncomingScrollRef.current = null;
      deferredOutgoingScrollRef.current = null;
      lastAutoScrollIntentRef.current = null;
      unseenIncomingKeysRef.current.clear();
      readingLongIncomingRef.current = null;
      trackedUnreadCountRef.current = 0;
      userScrollActiveRef.current = false;
      userScrollBlockedUntilRef.current = 0;
      userScrollUiUntilRef.current = 0;
      automaticScrollUntilRef.current = 0;
      pendingScrollRestore.current = active.id;
      setPendingIncomingCount(0);
      setShowJumpToLatest(false);
      historyFarFromLatestRef.current = false;
    }
  }, [active.id, active.friendNumber, screen]);

  useLayoutEffect(() => {
    if (screen !== "chat" || pendingScrollRestore.current !== active.id) return;
    const container = messageScrollRef.current;
    if (!container) return;
    const firstOpen = !openedChats.current.has(active.id);
    const target = firstOpen ? container.scrollHeight : (scrollPositions.current.get(active.id) ?? container.scrollHeight);
    markAutomaticScroll();
    container.scrollTop = target;
    openedChats.current.add(active.id);
    scrollPositions.current.set(active.id, container.scrollTop);
    pendingScrollRestore.current = null;
    const distance = container.scrollHeight - container.scrollTop - container.clientHeight;
    historyFarFromLatestRef.current = distance > container.clientHeight * 2;
    setShowJumpToLatest(shouldShowJumpToLatest(distance, container.clientHeight));
  }, [active.id, screen, scrollRestoreTick]);

  useEffect(() => () => {
    if (deferredIncomingTimerRef.current !== undefined) window.clearTimeout(deferredIncomingTimerRef.current);
    if (messageScrollTimer.current !== undefined) window.clearTimeout(messageScrollTimer.current);
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
      .then((message) => setOwnStatusMessage(message || (language === "en" ? "Ready to chat" : "Готов к общению")))
      .catch((error) => console.error("Не удалось получить текст статуса Tox", error));
  }, []);

  useEffect(() => {
    let mounted = true;
    const refresh = () => void invoke<NetworkStatus>("get_tox_network_status")
      .then((value) => {
        if (!mounted) return;
        // Switching profiles only changes the visible data. Display the actual
        // background connection immediately instead of faking a startup delay.
        const next = value === "offline" ? "offline" : value === "connecting-tor" ? "connecting-tor" : value === "online" ? "online" : "connecting";
        setNetworkStatus((current) => current === next ? current : next);
      })
      .catch(() => {});
    refresh();
    const timer = window.setInterval(refresh, 1000);
    return () => { mounted = false; window.clearInterval(timer); };
  }, []);

  useEffect(() => {
    let mounted = true;
    const refresh = () => void invoke<TorStatus>("get_tor_status")
      .then((status) => { if (mounted) setTorStatus((current) => sameData(current, status) ? current : status); })
      .catch((error) => {
        if (mounted) setTorStatus((current) => {
          const next: TorStatus = { ...current, state: "error", message: String(error), progress: 0 };
          return sameData(current, next) ? current : next;
        });
      });
    refresh();
    const timer = window.setInterval(refresh, 1000);
    return () => { mounted = false; window.clearInterval(timer); };
  }, []);

  useEffect(() => {
    let mounted = true;
    if (sharedLayoutHydrated) return () => { mounted = false; };
    if (!sharedLayoutLoad) {
      sharedLayoutLoad = invoke<Partial<LayoutState> | null>("load_layout_state")
        .catch((error) => {
          console.error("Не удалось загрузить общую компоновку интерфейса", error);
          return null;
        });
    }
    void sharedLayoutLoad.then((saved) => {
      sharedLayoutHydrated = true;
      if (!mounted || !saved) return;
      if (saved.appearance) setAppearance(saved.appearance);
      if (typeof saved.chatListWidth === "number") setChatListWidth(saved.chatListWidth);
    });
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    if (!sharedLayoutHydrated) return;
    sharedLayoutState = { appearance, chatListWidth };
    const timer = window.setTimeout(() => {
      void invoke("save_layout_state", { state: sharedLayoutState })
        .catch((error) => console.error("Не удалось сохранить общую компоновку интерфейса", error));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [appearance, chatListWidth]);

  useEffect(() => {
    void invoke<LocalState | null>("load_local_state")
      .then((saved) => {
        if (!saved) {
          setSpellcheckEnabled(true);
          setSpellcheckRussian(true);
          return;
        }
        if (saved.activeChat) setActiveChat(saved.activeChat);
        if (typeof saved.sendOnEnter === "boolean") setSendOnEnter(saved.sendOnEnter);
        if (typeof saved.profileAvatar === "string" || saved.profileAvatar === null) setProfileAvatar(saved.profileAvatar);
        if (typeof saved.profileName === "string" && saved.profileName.trim()) setProfileName(saved.profileName);
        if (saved.contactNames) setContactNames(saved.contactNames);
        if (typeof saved.autoDownloadImages === "boolean") setAutoDownloadImages(saved.autoDownloadImages);
        if (typeof saved.saveChatHistory === "boolean") setSaveChatHistory(saved.saveChatHistory);
        if (Array.isArray(saved.outgoingFriendRequests)) setOutgoingFriendRequests(saved.outgoingFriendRequests);
        if (saved.drafts && typeof saved.drafts === "object") draftsRef.current = { ...saved.drafts };
        if (saved.historyMessageLimit === "all" || saved.historyMessageLimit === 20 || saved.historyMessageLimit === 50 || saved.historyMessageLimit === 100) setHistoryMessageLimit(saved.historyMessageLimit);
        if (typeof saved.notifyMessages === "boolean") setNotifyMessages(saved.notifyMessages);
        if (typeof saved.notifyRequests === "boolean") setNotifyRequests(saved.notifyRequests);
        setSpellcheckEnabled(saved.spellcheckEnabled ?? true);
        setSpellcheckRussian(saved.spellcheckRussian ?? true);
        setSpellcheckEnglish(saved.spellcheckEnglish ?? false);
      })
      .catch((error) => console.error("Не удалось загрузить локальные данные", error))
      .finally(() => setPersistenceReady(true));
  }, []);

  useEffect(() => {
    if (!persistenceReady) return;
    const timer = window.setTimeout(() => {
      void persistLocalState();
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [activeChat, autoDownloadImages, contactNames, historyMessageLimit, notifyMessages, notifyRequests, outgoingFriendRequests, persistenceReady, persistLocalState, profileAvatar, profileName, saveChatHistory, sendOnEnter, spellcheckEnabled, spellcheckEnglish, spellcheckRussian, userStatus]);

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
    const value = ownStatusMessage.trim() || (language === "en" ? "Ready to chat" : "Готов к общению");
    setOwnStatusMessage(value);
    setEditingOwnStatusMessage(false);
    void invoke<string>("set_tox_status_message", { message: value })
      .then(setOwnStatusMessage)
      .catch((error) => console.error("Не удалось обновить текст статуса Tox", error));
  }

  function changeUserStatus(status: UserStatus) {
    void invoke<UserStatus>("set_tox_user_status", { status })
      .then((actual) => {
        setUserStatus(actual);
        setStatusMenuOpen(false);
        if (actual === "offline") {
          setNetworkStatus("offline");
        } else if (networkStatus === "offline") {
          setNetworkStatus("connecting");
        }
      })
      .catch((error) => console.error("Не удалось изменить статус Tox", error));
  }

  useEffect(() => {
    if (!persistenceReady) return;
    void invoke("set_tox_nickname", { nickname: profileName })
      .then(() => window.dispatchEvent(new Event("profiles-changed")))
      .catch((error) => console.error("Не удалось обновить ник Tox", error));
  }, [persistenceReady, profileName]);

  useEffect(() => {
    const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes("Files");
    const onDragOver = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      setIsDraggingFile(true);
    };
    const onDrop = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      setIsDraggingFile(false);
      const file = event.dataTransfer?.files[0];
      if (file) setPendingFile(file);
    };
    const onDragEnd = () => setIsDraggingFile(false);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    window.addEventListener("dragleave", onDragEnd);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
      window.removeEventListener("dragleave", onDragEnd);
    };
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    try {
      void getCurrentWindow().onDragDropEvent((event) => {
        if (event.payload.type === "enter" || event.payload.type === "over") {
          setIsDraggingFile(true);
        } else if (event.payload.type === "leave") {
          setIsDraggingFile(false);
        } else if (event.payload.type === "drop") {
          const path = event.payload.paths[0];
          if (!path) return;
          const name = path.split(/[/\\]/).pop() ?? "Файл";
          const type = /\.(png|jpe?g)$/i.test(name) ? `image/${name.toLowerCase().endsWith("png") ? "png" : "jpeg"}` : "application/octet-stream";
          setIsDraggingFile(false);
          void invoke<{ size: number }>("get_native_file_metadata", { path }).then((metadata) => {
            setNativeDropPath(path);
            setNativeDropSize(metadata.size);
            setPendingFile(new File([], name, { type }));
          }).catch((error) => {
            console.error("Не удалось подготовить файл для отправки", error);
            showTransferNotice(formatUserFacingError(error, { ru: "Не удалось подготовить файл", en: "Could not prepare the file" }, language));
          });
        }
      }).then((stop) => { unlisten = stop; }).catch(() => undefined);
    } catch {
      // Обычный браузер использует обработчики DataTransfer выше.
    }
    return () => unlisten?.();
  }, []);

  const updateDraft = useCallback((chatId: string, value: string) => {
    if (value) draftsRef.current[chatId] = value;
    else delete draftsRef.current[chatId];
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

  async function sendMessage(text: string): Promise<boolean> {
    const normalized = text.trim();
    if (!normalized || active.friendNumber === undefined) return false;
    try {
      await invoke<number>("send_tox_message", { friendNumber: active.friendNumber, text: normalized });
      delete draftsRef.current[activeChat];
      void persistLocalState();
      setMessageRefreshRequest((current) => current + 1);
      return true;
    } catch (error) {
      showTransferNotice(formatUserFacingError(error, { ru: "Не удалось отправить сообщение", en: "Could not send the message" }, language));
      return false;
    }
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

  const stageFile = useCallback((file: File | undefined) => {
    if (file) {
      setNativeDropPath(null);
      setNativeDropSize(null);
      setPendingFile(file);
    }
  }, []);

  function clearPendingFile() {
    setPendingFile(null);
    setNativeDropPath(null);
    setNativeDropSize(null);
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
    const timestamp = new Date((message.deliveredAt ?? 0) * 1000)
      .toLocaleString(language === "en" ? "en-US" : "ru-RU");
    return formatDeliveryReceiptTitle(message.attachment ? "file" : "message", timestamp, language);
  }

  function attachmentProgress(attachment: Attachment) {
    return Math.max(0, Math.min(100, Math.round(((attachment.transferred ?? 0) / Math.max(1, attachment.size)) * 100)));
  }

  function attachmentTransferText(attachment: Attachment, mine: boolean) {
    if (attachment.transferState === "queued") return "Ожидает отправки";
    if (attachment.transferState === "awaiting_confirmation") return "Файл отправлен, ожидается подтверждение получателя";
    if (attachment.transferState === "paused") return mine ? "Передача приостановлена" : "Получение приостановлено";
    if (attachment.transferState === "cancelled") return mine ? "Передача отменена" : "Получение отменено";
    if (attachment.transferState === "failed") return formatUserFacingError(attachment.error, { ru: "Передача не завершена", en: "File transfer failed" }, language);
    const action = t(mine ? "Отправка" : "Получение");
    const speed = attachment.speed ?? 0;
    const amount = `${formatFileSize(attachment.transferred ?? 0)} ${language === "en" ? "of" : "из"} ${formatFileSize(attachment.size)}`;
    return `${action} · ${amount}${speed ? ` · ${formatFileSize(speed)}/${language === "en" ? "s" : "с"} · ${formatTransferEta(attachment.eta)}` : t(" · ожидание данных…")}`;
  }

  function attachmentTransferTitle(attachment: Attachment, mine: boolean) {
    if (attachment.transferState === "queued") return "Ожидает отправки";
    if (attachment.transferState === "awaiting_confirmation") return "Ожидание подтверждения";
    if (attachment.transferState === "paused") return mine ? "Передача приостановлена" : "Получение приостановлено";
    if (attachment.transferState === "cancelled") return mine ? "Передача отменена" : "Получение отменено";
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
    setTransferUiStateOverrides((current) => {
      if (!(message.coreId! in current)) return current;
      const next = { ...current };
      delete next[message.coreId!];
      return next;
    });
    void invoke("retry_tox_file_transfer", {
      friendNumber: active.friendNumber,
      messageId: message.coreId,
    }).then(() => clearTransferError(message.coreId!)).catch((error) => setTransferError(message.coreId!, error));
  }

  function confirmFileSend() {
    if (!pendingFile) return;
    if (active.friendNumber === undefined) return;
    setFileSendError(null);
    const file = pendingFile;
    const send = nativeDropPath
      ? invoke("send_tox_file_from_path", {
          friendNumber: active.friendNumber,
          path: nativeDropPath,
          mime: file.type || "application/octet-stream",
        })
      : file.arrayBuffer().then((buffer) => invoke("send_tox_file", {
          friendNumber: active.friendNumber,
          filename: file.name,
          mime: file.type || "application/octet-stream",
          bytes: Array.from(new Uint8Array(buffer)),
        }));
    void send.then(() => {
      clearPendingFile();
      setMessageRefreshRequest((current) => current + 1);
    }).catch((error) => setFileSendError(formatUserFacingError(error, { ru: "Не удалось добавить файл в очередь", en: "Could not queue the file" }, language)));
  }

  function updateProfileAvatar(avatar: string | null) {
    setProfileAvatar(avatar);
    if (!avatar) return;
    void profileAvatarToToxPng(avatar)
      .then((bytes) => invoke("send_tox_avatar", { filename: "avatar.png", bytes }))
      .catch((error) => console.error("Не удалось отправить аватар", error));
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
      ? copyDecodedImage(path).catch(() => invoke("copy_attachment_to_clipboard", { path, image: true }))
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

  async function disableActiveProfile() {
    if (!activeProfileAtMount || profileActionBusy) return;
    setProfileMenuOpen(false);
    setProfileActionBusy("disable");
    try {
      await persistLocalState();
      await onDisableProfile(activeProfileAtMount.id);
    } catch (error) {
      showTransferNotice(formatUserFacingError(error, { ru: "Не удалось отключить профиль", en: "Could not disable the profile" }, language));
      setProfileActionBusy(null);
    }
  }

  async function destroyActiveProfile() {
    if (!activeProfileAtMount || profileActionBusy) return;
    setProfileActionBusy("destroy");
    try {
      await persistLocalState();
      await onDestroyActiveProfile();
    } catch (error) {
      showTransferNotice(formatUserFacingError(error, { ru: "Не удалось уничтожить профиль", en: "Could not permanently delete the profile" }, language));
      setProfileActionBusy(null);
      setConfirmDestroyProfile(false);
    }
  }

  function exitApplication() {
    setProfileMenuOpen(false);
    void persistLocalState()
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
            ...(current[friendNumber] ?? { supported: false, state: "error", local_fingerprint: "", peer_fingerprint: null, fingerprint_changed: false }),
            state: "error",
            error: String(error),
          },
        }));
        showTransferNotice(formatUserFacingError(error, { ru: "Не удалось изменить состояние PQ", en: "Could not change the PQ state" }, language));
      });
  }

  function clearDeferredIncomingScroll() {
    if (deferredIncomingTimerRef.current !== undefined) window.clearTimeout(deferredIncomingTimerRef.current);
    deferredIncomingTimerRef.current = undefined;
    deferredIncomingScrollRef.current = null;
  }

  function messageElement(container: HTMLDivElement, messageKey: string) {
    return Array.from(container.querySelectorAll<HTMLElement>("[data-message-key]"))
      .find((element) => element.dataset.messageKey === messageKey) ?? null;
  }

  function registerUnseenIncoming(messageKeys: string[]) {
    for (const key of messageKeys) unseenIncomingKeysRef.current.add(key);
  }

  function syncUnseenIndicator() {
    const container = messageScrollRef.current;
    const count = unseenIncomingKeysRef.current.size;
    const distance = container ? Math.max(0, container.scrollHeight - container.scrollTop - container.clientHeight) : 0;
    const mode = chatNavigationMode(count, distance, container?.clientHeight ?? 0);
    setPendingIncomingCount(count);
    setShowJumpToLatest(mode === "jump");
  }

  function markVisibleIncomingMessages() {
    const container = messageScrollRef.current;
    if (!container || unseenIncomingKeysRef.current.size === 0) return;
    const containerBox = container.getBoundingClientRect();
    const reading = readingLongIncomingRef.current;
    if (reading?.chatId === active.id && !reading.userScrolled) return;
    let changed = false;
    for (const key of [...unseenIncomingKeysRef.current]) {
      const element = messageElement(container, key);
      if (!element) continue;
      const box = element.getBoundingClientRect();
      const bottomWasSeen = box.bottom <= containerBox.bottom + 2;
      if (!bottomWasSeen) continue;
      unseenIncomingKeysRef.current.delete(key);
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
    const container = messageScrollRef.current;
    if (!container) return;
    if (messageKey) lastAutoScrollIntentRef.current = { chatId: active.id, messageKey, boundaryMessageKey: messageKey, intent: "outgoing" };
    setShowJumpToLatest(false);
    const apply = () => {
      markAutomaticScroll();
      container.scrollTop = container.scrollHeight;
    };
    apply();
    window.requestAnimationFrame(() => {
      apply();
      window.requestAnimationFrame(() => {
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
    const targetTop = container.scrollTop + targetBox.top - containerBox.top;
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
          bottom: container.scrollTop + ownBox.bottom - containerBox.top,
          height: ownBox.height,
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
      incoming.push({ key, bottom: container.scrollTop + box.bottom - containerBox.top });
    }
    return incomingContextMetrics({
      viewportHeight: container.clientHeight,
      targetKey: messageKey,
      targetTop,
      targetHeight: targetBox.height,
      previousOwn,
      incoming,
    });
  }

  function maintainLongIncomingContext(reading: IncomingReadingState = readingLongIncomingRef.current!) {
    const container = messageScrollRef.current;
    if (!container || reading.chatId !== active.id || reading.userScrolled) return false;
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
      armDeferredIncomingScroll(32);
      return;
    }
    const position = incomingContextPosition(container, target, messageKey, boundaryMessageKey);
    if (position.long) {
      clearDeferredIncomingScroll();
      const reading = { chatId: active.id, anchorMessageKey: messageKey, boundaryMessageKey: position.boundaryMessageKey, userScrolled: false };
      readingLongIncomingRef.current = reading;
      maintainLongIncomingContext(reading);
      window.requestAnimationFrame(() => {
        maintainLongIncomingContext(reading);
        window.requestAnimationFrame(() => maintainLongIncomingContext(reading));
      });
      return;
    }
    clearDeferredIncomingScroll();
    scrollToBottomGuaranteed();
    window.requestAnimationFrame(() => {
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
    deferredOutgoingScrollRef.current = null;
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
        window.requestAnimationFrame(() => maintainLongIncomingContext(reading));
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
      armDeferredIncomingScroll(32);
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
      settleUntil: Date.now() + batch.settleMs,
      userScrolled: existing?.userScrolled ?? (
        previousDistance > container.clientHeight * 2
        || (previousDistance > 10 && (userScrollActiveRef.current || userScrollBlockedUntilRef.current > Date.now()))
      ),
    };
    const reading = readingLongIncomingRef.current;
    if (reading?.chatId === active.id && unseenIncomingKeysRef.current.has(reading.boundaryMessageKey)) {
      if (maintainLongIncomingContext(reading)) {
        clearDeferredIncomingScroll();
        window.requestAnimationFrame(() => maintainLongIncomingContext(reading));
        syncUnseenIndicator();
        return;
      }
    }
    if (deferredIncomingScrollRef.current.userScrolled) {
      syncUnseenIndicator();
      armDeferredIncomingScroll(16);
      return;
    }
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
        window.requestAnimationFrame(() => maintainLongIncomingContext(reading));
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
    window.requestAnimationFrame(() => scrollToMessageIntent(remembered.intent, remembered.messageKey, remembered.boundaryMessageKey));
  }

  function updateLatestButton() {
    const container = messageScrollRef.current;
    if (!container) return;
    if (active.id) scrollPositions.current.set(active.id, container.scrollTop);
    markVisibleIncomingMessages();
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
    if (userInitiated) syncUnseenIndicator();
    if (distance <= 10 && !hasUnseen) clearDeferredIncomingScroll();
  }

  function jumpToLatest() {
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
    const parts: React.ReactNode[] = [];
    let offset = 0;
    for (const match of matches) {
      if (match.start > offset) parts.push(text.slice(offset, match.start));
      parts.push(<mark
        className={`message-search-hit ${match.resultIndex === messageSearchIndex ? "current" : ""}`}
        data-search-result={match.resultIndex}
        key={`${key}-${field}-${match.resultIndex}`}
      >{text.slice(match.start, match.end)}</mark>);
      offset = match.end;
    }
    if (offset < text.length) parts.push(text.slice(offset));
    return parts;
  }

  function renderMessageText(message: Message) {
    return renderSearchValue(message, message.text, "text");
  }

  function moveSearchResult(direction: -1 | 1) {
    if (!messageSearchMatches.length) return;
    setMessageSearchIndex((current) => {
      const base = current < 0 ? 0 : current;
      return (base + direction + messageSearchMatches.length) % messageSearchMatches.length;
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
      copyNoticeTimer.current = window.setTimeout(() => setCopyNotice(false), 2200);
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
    void invoke("delete_tox_friend", { friendNumber: target.friendNumber })
      .then(() => {
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

  function copyText(value: string) {
    void navigator.clipboard.writeText(value).then(() => showTransferNotice("Скопировано в буфер обмена")).catch(() => {});
  }

  function openRestrictedContextMenu(event: React.MouseEvent<HTMLElement>) {
    event.preventDefault();
    const target = event.target as HTMLElement;
    const selection = window.getSelection()?.toString() ?? "";
    const messageNode = target.closest<HTMLElement>("[data-message-key]");
    const messageKey = messageNode?.dataset.messageKey;
    const message = messageKey
      ? messagesRef.current.find((item) => (item.coreId ?? String(item.id)) === messageKey)
      : undefined;
    if (message?.attachment?.path) {
      setGeneralContext({
        x: event.clientX,
        y: event.clientY,
        kind: message.attachment.image ? "image" : "file",
        path: message.attachment.path,
        showInFolder: !message.mine && message.attachment.completed === true,
      });
      return;
    }
    if (!selection) {
      setGeneralContext(null);
      return;
    }
    setGeneralContext({ x: event.clientX, y: event.clientY, kind: "copy" });
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
  const hasProfileSwitcher = profiles.filter((profile) => profile.loaded).length >= 2;
  const profileSidebarHeader = <div className={`profile-sidebar-header ${hasProfileSwitcher ? "has-profile-switcher" : ""}`}>
    <ProfileSwitcher profiles={profiles.map((profile) => profile.id === activeProfileAtMount?.id && persistenceReady ? { ...profile, avatar: profileAvatar, name: profileName } : profile)} onSwitch={switchProfileAfterDraftSave} switching={profileSwitching} />
    <div className="own-meta-line"><button className="own-tox-id" onClick={copyOwnToxId} title={ownToxId ? "Скопировать полный Tox ID" : "Загрузка Tox ID"}>Ваш Tox ID: <code>{ownToxId ? ownToxId.slice(0, 15) : "загрузка…"}</code></button><button className="own-meta-icon" onClick={copyOwnToxId} title="Скопировать полный Tox ID" aria-label="Скопировать полный Tox ID">⧉</button></div>
    <div className="own-status-message">{editingOwnStatusMessage ? <input autoFocus value={ownStatusMessage} onChange={(event) => setOwnStatusMessage(event.target.value)} onBlur={saveOwnStatusMessage} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); } }} aria-label="Ваш статус Tox" maxLength={100} /> : <div className="own-meta-line"><button className="own-status-trigger" onClick={() => setEditingOwnStatusMessage(true)} title="Изменить статус">Ваш статус: <em data-i18n-ignore translate="no">{displayedOwnStatusMessage}</em></button><button className="own-meta-icon" onClick={() => setEditingOwnStatusMessage(true)} title="Изменить статус" aria-label="Изменить статус">✎</button></div>}</div>
  </div>;

  return (
    <main className={`app-shell ${isResizingList ? "resizing" : ""} ${compactSidebar ? "sidebar-compact" : ""}`} onContextMenu={openRestrictedContextMenu} onClick={() => { setContactMenuOpen(false); setStatusMenuOpen(false); setProfileMenuOpen(false); setContactContext(null); setGeneralContext(null); }} style={{ "--chat-font": appearance.chatFont, "--chat-font-size": `${appearance.chatFontSize}px`, "--list-edge": `${listEdge}px`, "--profile-sidebar-width": `${sidebarWidth}px`, width: `${100 / (appearance.interfaceScale / 100)}vw`, height: `${100 / (appearance.interfaceScale / 100)}vh`, zoom: appearance.interfaceScale / 100, gridTemplateColumns: gridColumns } as CSSProperties}>
      {copyNotice && <div className="copy-toast" role="status">Tox ID скопирован в буфер обмена</div>}
      {transferNotice && <div className="copy-toast transfer-toast" role="status"><span>{transferNotice.text}</span>{transferNotice.path && <>: <span data-i18n-ignore translate="no">{transferNotice.path}</span></>}</div>}
      <div className="event-notices">{eventNotices.map((notice) => <article key={notice.id} className="event-notice" onClick={() => { setEventNotices((current) => current.filter((item) => item.id !== notice.id)); setScreen("chat"); if (notice.requests) { setIncomingRequestsOpen(true); setAddContactOpen(false); } else if (notice.friendPublicKey || notice.friendNumber !== undefined) { setIncomingRequestsOpen(false); setAddContactOpen(false); const chatId = resolveFriendChatId(notice.friendPublicKey, notice.friendNumber, coreFriends); if (chatId) setActiveChat(chatId); } }}><button onClick={(event) => { event.stopPropagation(); setEventNotices((current) => current.filter((item) => item.id !== notice.id)); }} aria-label="Закрыть">×</button><b data-i18n-ignore translate="no">{notice.title}</b><span data-i18n-ignore translate="no">{notice.body}</span></article>)}</div>
      {contactContext && <div ref={contactContextMenuRef} className="contact-context-menu" role="menu" aria-label={t("Меню")} style={{ left: contactContext.x, top: contactContext.y }} onClick={(event) => event.stopPropagation()}><button className="danger-menu" role="menuitem" onClick={() => { setContactActionTarget(contactContext.chat); setContactAction("delete"); setContactContext(null); }}>Удалить</button><button role="menuitem" onClick={() => { copyText(contactContext.chat.toxId); setContactContext(null); }}>Скопировать полный Tox ID</button><span>Последний онлайн: {contactContext.chat.lastOnline}</span></div>}
      {generalContext && <div ref={generalContextMenuRef} className="contact-context-menu restricted-context-menu" style={{ left: generalContext.x, top: generalContext.y }} onClick={(event) => event.stopPropagation()}>{generalContext.kind === "image" && <button onClick={() => copyAttachmentToClipboard(generalContext.path, true)}>Скопировать изображение</button>}{generalContext.kind === "file" && <button onClick={() => copyAttachmentToClipboard(generalContext.path, false)}>Скопировать файл</button>}{generalContext.showInFolder && <button onClick={() => showAttachmentInFolder(generalContext.path)}>Показать в папке</button>}{generalContext.kind === "copy" && <button onClick={() => { copyText(window.getSelection()?.toString() ?? ""); setGeneralContext(null); }}>Скопировать</button>}</div>}
      {contactAction && <div className={`file-confirm-overlay ${contactAction === "delete" ? "contact-delete-overlay" : ""}`} role="dialog" aria-modal="true"><div className="file-confirm-card">{contactAction === "rename" ? <><b>Переименовать контакт</b><input autoFocus value={renameDraft} onChange={(event) => setRenameDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") renameContact(); }} /><div><button className="text-button" onClick={() => { setContactAction(null); setContactActionTarget(null); }}>Отмена</button><button className="send-file-button" onClick={renameContact}>Сохранить</button></div></> : <><b>Удалить контакт?</b><span>«<span data-i18n-ignore translate="no">{contactActionName}</span>» и вся локальная история переписки будут удалены.</span><div><button className="text-button" onClick={() => { setContactAction(null); setContactActionTarget(null); }}>Отмена</button><button className="danger-button" onClick={deleteContact}>Удалить</button></div></>}</div></div>}
      {confirmDestroyProfile && <div className="file-confirm-overlay profile-destroy-overlay" role="dialog" aria-modal="true" aria-labelledby="profile-destroy-title" onClick={(event) => event.stopPropagation()}><div className="file-confirm-card"><b id="profile-destroy-title">{t("Уничтожить профиль?")}</b><span>{t("Профиль")} «<strong data-i18n-ignore translate="no">{profileName}</strong>» — {t("все его локальные данные будут безвозвратно удалены.")}</span><div><button className="text-button" disabled={profileActionBusy === "destroy"} onClick={() => setConfirmDestroyProfile(false)}>{t("Отмена")}</button><button className="danger-button" disabled={profileActionBusy === "destroy"} onClick={() => void destroyActiveProfile()}>{profileActionBusy === "destroy" ? "…" : t("Уничтожить профиль")}</button></div></div></div>}
      <aside className="rail" aria-label="Навигация" onClick={(event) => { event.stopPropagation(); setContactContext(null); setGeneralContext(null); }}>
        <div className="rail-profile-menu-host" ref={profileMenuRef}>
          <button type="button" className="rail-profile-menu-button" title={t("Управление активным профилем")} aria-label={t("Управление активным профилем")} aria-haspopup="menu" aria-expanded={profileMenuOpen} onClick={() => { setStatusMenuOpen(false); setProfileMenuOpen((open) => !open); }}><svg viewBox="0 0 42 24" aria-hidden="true"><circle cx="7" cy="12" r="4.5" /><circle cx="21" cy="12" r="4.5" /><circle cx="35" cy="12" r="4.5" /></svg></button>
          {profileMenuOpen && <div className="rail-profile-menu" role="menu"><button type="button" role="menuitem" disabled={profileActionBusy !== null} onClick={() => openSettings("profiles")}>{t("Добавить профиль")}</button><button type="button" role="menuitem" disabled={profileActionBusy !== null} onClick={() => void disableActiveProfile()}>{profileActionBusy === "disable" ? "…" : t("Отключить профиль")}</button><button type="button" role="menuitem" onClick={exitApplication}>{t("Закрыть приложение")}</button><button type="button" className="danger" role="menuitem" disabled={profileActionBusy !== null} onClick={() => { setProfileMenuOpen(false); setConfirmDestroyProfile(true); }}>{t("Уничтожить профиль")}</button></div>}
        </div>
        <div className="status-control"><button type="button" className="rail-profile-button" onClick={openProfileSettings} title="Открыть настройки профиля" aria-label="Открыть настройки профиля"><ProfileAvatar src={profileAvatar} initial={profileInitial} state={ownAvatarState} connecting={ownAvatarState === "connecting"} className="rail-profile-avatar" alt="Ваш аватар" /></button><button className={`rail-status-label ${networkStatus === "online" ? userStatus : "offline"}`} onClick={() => setStatusMenuOpen((open) => !open)} title={networkStatus === "online" ? statusText : networkStatus === "offline" ? "Отключено от сети Tox" : networkStatus === "connecting-tor" ? "Подключение к Tor…" : "Подключение к сети Tox…"} aria-label={`Статус: ${networkStatus === "online" ? statusText : networkStatus === "offline" ? "Отключено от сети Tox" : networkStatus === "connecting-tor" ? "Подключение к Tor…" : "Подключение к сети Tox…"}`} aria-expanded={statusMenuOpen}>{networkStatus === "connecting-tor" ? "Подключение к Tor…" : networkStatus === "connecting" ? "Подключение…" : networkStatus === "offline" ? "Отключен" : userStatus === "online" ? "Онлайн" : userStatus === "away" ? "Отошёл" : userStatus === "busy" ? "Занят" : "Отключен"}</button>{statusMenuOpen && <div className="status-menu" role="menu"><button onClick={() => changeUserStatus("online")} role="menuitem"><span className="status-dot online" />Онлайн</button><button onClick={() => changeUserStatus("away")} role="menuitem"><span className="status-dot away" />Отошёл</button><button onClick={() => changeUserStatus("busy")} role="menuitem"><span className="status-dot busy" />Занят</button><button onClick={() => changeUserStatus("offline")} role="menuitem"><span className="status-dot offline" />Отключиться от сети</button></div>}</div>
        <nav className="rail-navigation" aria-label="Основные разделы">
          <button className={`rail-button chats-button ${screen === "chat" && !incomingRequestsOpen && !addContactOpen ? "active" : ""}`} onClick={() => { setScreen("chat"); setIncomingRequestsOpen(false); setAddContactOpen(false); }} title="Чаты и контакты" aria-label="Чаты и контакты"><svg className="rail-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5h11A2.5 2.5 0 0 1 21.5 8v7a2.5 2.5 0 0 1-2.5 2.5h-8l-5.5 4V8A2.5 2.5 0 0 1 8 5.5Z" /></svg>{Object.values(unreadFriendCounts).reduce((sum, value) => sum + value, 0) > 0 && <span className="rail-badge">{Object.values(unreadFriendCounts).reduce((sum, value) => sum + value, 0)}</span>}</button>
          <button className={`rail-button add-contact-button ${addContactOpen ? "active" : ""}`} onClick={() => { setScreen("chat"); setActiveChat(""); setIncomingRequestsOpen(false); setAddContactOpen(true); setAddContactStatus(null); }} title="Добавить в контакты" aria-label="Добавить в контакты"><svg className="rail-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg></button>
          <button className={`rail-button requests-button ${incomingRequestsOpen ? "active" : ""}`} onClick={() => { setScreen("chat"); setActiveChat(""); setAddContactOpen(false); setIncomingRequestsOpen(true); }} title="Ожидающие авторизации" aria-label="Ожидающие авторизации"><svg className="rail-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="8.3" cy="6.8" r="3" /><path d="M3.4 18.5v-.8a5.1 5.1 0 0 1 5.1-5.1c1 0 2 .3 2.8.8" /><circle cx="16.6" cy="16.5" r="4.2" /><path d="M16.6 14v2.6l1.8 1" /><path className="rail-icon-accent" d="m18.9 5.1 1.25 1.25-1.25 1.25-1.25-1.25Z" /></svg>{unreadIncomingRequestKeys.length > 0 && <span className="rail-badge">{unreadIncomingRequestKeys.length}</span>}</button>
          <button className="rail-button downloads-button" onClick={openDownloadsFolder} title="Открыть папку загрузок" aria-label="Открыть папку загрузок"><DownloadIcon className="rail-icon" /></button>
          <button className={`rail-button settings-button ${screen === "settings" ? "active" : ""}`} onClick={() => { setAddContactOpen(false); setIncomingRequestsOpen(false); setScreen("settings"); }} title="Настройки" aria-label="Настройки"><svg className="rail-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M19 12a7.2 7.2 0 0 0-.1-1.2l2-1.5-2-3.4-2.4 1a7.7 7.7 0 0 0-2-1.2L14.2 3h-4.1l-.4 2.6c-.7.3-1.4.7-2 1.2l-2.4-1-2 3.4 2 1.5A7.2 7.2 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.5 2 3.4 2.4-1c.6.5 1.3.9 2 1.2l.4 2.6h4.1l.4-2.6c.7-.3 1.4-.7 2-1.2l2.4 1 2-3.4-2-1.5c.1-.4.1-.8.1-1.2Z" /></svg></button>
        </nav>
        <span className={`tor-indicator ${customProxyActive ? "proxy" : torEnabled ? "enabled" : "disabled"} ${customProxyActive ? "" : torStatus.state}`} data-i18n-ignore translate="no" title={torIndicatorText} aria-label={torIndicatorText}>
          <svg viewBox="0 0 48 48" aria-hidden="true">
            <path className="tor-shield" d="M24 5.5 39 10.9v10.6c0 9.4-6.1 16.6-15 21-8.9-4.4-15-11.6-15-21V10.9L24 5.5Z" />
            <rect className="tor-lock" x="16.5" y="22.2" width="15" height="11.5" rx="2.2" />
            <path className="tor-lock" d="M19.5 22.2v-2.1a4.5 4.5 0 0 1 9 0v2.1M24 26.2v3.4" />
          </svg>
          <i className="tor-state-dot" aria-hidden="true" />
        </span>
      </aside>

      {screen === "chat" && <aside className={`chat-list ${compactSidebar ? "compact" : ""}`}>
        {profileSidebarHeader}
        <label className="search"><span>⌕</span><input value={contactSearch} onChange={(event) => setContactSearch(event.target.value)} placeholder="фильтр контакт-листа" aria-label="Фильтр контакт-листа" /><button type="button" className="clear-contact-search" onClick={() => setContactSearch("")} disabled={!contactSearch} aria-label="Сбросить фильтр" title="Сбросить фильтр">×</button></label>
        <p className="section-label">Контакты</p>
        <div className={`chat-items ${contactsScrollActive ? "scroll-active" : ""}`} onScroll={showContactsScrollbar}>
          {[...allChats].filter((chat) => displayName(chat).toLocaleLowerCase().includes(contactSearch.trim().toLocaleLowerCase())).sort((a, b) => (b.lastEvent ?? 0) - (a.lastEvent ?? 0)).map((chat) => (
            <button className={`chat-item ${activeChat === chat.id ? "selected" : ""}`} key={chat.id} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); setContactContext({ x: Math.min(event.clientX, window.innerWidth - 260), y: Math.min(event.clientY, window.innerHeight - 150), chat }); }} onClick={() => { setIncomingRequestsOpen(false); setAddContactOpen(false); setActiveChat(chat.id); }}>
              <span className={`avatar ${chat.color} contact-status-${chat.status}`}>
                <AvatarImage path={chat.avatarPath} initial={chat.initial} />
                {chat.friendNumber !== undefined && (unreadFriendCounts[String(chat.friendNumber)] ?? 0) > 0 && <b className="contact-avatar-unread" title={t("Новые непрочитанные сообщения")} aria-label={formatUnreadMessagesLabel(unreadFriendCounts[String(chat.friendNumber)], language)}>{unreadFriendCounts[String(chat.friendNumber)]}</b>}
              </span>
              <span className="chat-copy">
                <span className={`chat-name ${chat.pq ? "pq-name" : ""}`} data-i18n-ignore translate="no">{highlightContactName(displayName(chat))}</span>
                <span className={`chat-status ${chat.status}`}>{chat.status === "online" ? "Онлайн" : chat.status === "away" ? "Отошёл" : chat.status === "busy" ? "Занят" : "Отключен"}</span>
                <span className="chat-preview" data-i18n-ignore translate="no">{chat.preview}</span>
              </span>
              <span className="chat-time"><span>{chat.time}</span>{chat.friendNumber !== undefined && (unreadFriendCounts[String(chat.friendNumber)] ?? 0) > 0 && <b className="contact-unread-count" title={t("Новые непрочитанные сообщения")} aria-label={formatUnreadMessagesLabel(unreadFriendCounts[String(chat.friendNumber)], language)}>{unreadFriendCounts[String(chat.friendNumber)]}</b>}</span>
            </button>
          ))}
        </div>
      </aside>}

      <div className="chat-list-splitter" role="separator" aria-label={screen === "settings" ? "Изменить ширину меню настроек" : "Изменить ширину списка контактов"} aria-orientation="vertical" onPointerDown={(event) => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); isResizingListRef.current = true; setIsResizingList(true); resizeChatList(event.clientX); }} onPointerMove={(event) => { if (isResizingListRef.current) resizeChatList(event.clientX); }} onPointerUp={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); finishChatListResize(); }} onPointerCancel={finishChatListResize} onLostPointerCapture={finishChatListResize} />

      {screen === "chat" ? <section className="conversation" onDragEnter={(event) => { event.preventDefault(); setIsDraggingFile(true); }} onDragOver={(event) => event.preventDefault()} onDragLeave={(event) => { if (event.currentTarget === event.target) setIsDraggingFile(false); }} onDrop={(event) => { event.preventDefault(); setIsDraggingFile(false); stageFile(event.dataTransfer.files[0]); }}>
        {active.id && !incomingRequestsOpen && <header className="conversation-header">
          <span className={`avatar ${active.color}`}><AvatarImage path={active.avatarPath} initial={active.initial} /></span>
          <span className="header-copy"><strong data-i18n-ignore translate="no">{activeName}</strong><small><span className={`header-meta ${active.status} ${activePqProtected ? "pq-active" : ""}`}>{activeStatusText} · {activePqProtected ? "защищённый чат E2EE (пост-квантовое шифрование)" : "защищённый чат E2EE"}</span></small></span>
          <div className="header-actions" onClick={(event) => event.stopPropagation()}>{activePq?.supported && <button className={`pq-header-button ${activePq.state}`} onClick={() => { if (activePq.state === "available" || activePq.state === "error") updatePqStatus("request_pq_session"); else if (activePq.state === "offered") updatePqStatus("withdraw_pq_session"); else if (activePq.state === "active") updatePqStatus("request_pq_shutdown"); }} disabled={["incoming_offer", "accepting", "closing", "closing_commit", "closing_ack", "closing_final"].includes(activePq.state)} title={activePq.state === "offered" ? "Отозвать предложение постквантового шифрования" : activePq.state === "active" ? "Согласованно отключить постквантовый слой" : activePqProtected ? "Выполняется согласованное отключение постквантового слоя" : "Предложить постквантовое шифрование"}>PQ</button>}{messageSearchOpen ? <div className="message-search"><input aria-label="Поиск в чате" autoFocus value={messageSearch} onChange={(event) => setMessageSearch(event.target.value)} placeholder="Поиск в чате" /><span className="message-search-count" aria-live="polite">{messageSearchBusy ? "…" : messageSearch.trim() ? messageSearchMatches.length ? `${messageSearchIndex + 1}/${messageSearchMatches.length}` : "0/0" : ""}</span><button disabled={!messageSearchMatches.length} onClick={() => moveSearchResult(-1)} aria-label="Предыдущее совпадение" title="Предыдущее совпадение">‹</button><button disabled={!messageSearchMatches.length} onClick={() => moveSearchResult(1)} aria-label="Следующее совпадение" title="Следующее совпадение">›</button><button onClick={closeMessageSearch} aria-label="Закрыть поиск" title="Закрыть поиск">×</button></div> : <button onClick={() => setMessageSearchOpen(true)} aria-label="Поиск">⌕</button>}<span className="more-actions"><button onClick={() => setContactMenuOpen((open) => !open)} aria-label="Меню">⋮</button>{contactMenuOpen && <div className="contact-menu"><button onClick={() => { setContactActionTarget(active); setRenameDraft(activeName); setContactAction("rename"); }}>Переименовать контакт</button><button onClick={exportHistory}>Экспорт истории чата</button><button onClick={() => { if (active.friendNumber !== undefined) void invoke("clear_tox_history", { friendNumber: active.friendNumber }).then(() => setMessages([])); setContactMenuOpen(false); }}>Очистить историю чата</button><button className="danger-menu" onClick={() => { setContactActionTarget(active); setContactAction("delete"); }}>Удалить контакт</button></div>}</span></div>
        </header>}

        {addContactOpen && <section className="friend-requests-view add-contact-view">
          <header><h2>Отправить запрос на переписку</h2></header>
          <div className="add-contact-content"><form className="add-contact-card" onSubmit={submitFriendRequest}><label>Tox ID<input value={contactToxId} onChange={(event) => setContactToxId(event.target.value)} placeholder="76 символов" autoFocus required /></label><label>Сообщение для авторизации<textarea value={friendRequestMessage} onChange={(event) => { friendRequestCustomized.current = true; setFriendRequestMessage(event.target.value); }} data-i18n-ignore translate="no" required /></label>{addContactStatus && <p className="add-contact-status">{addContactStatus} <button type="button" className="request-status-link" onClick={() => { setAddContactOpen(false); setIncomingRequestsOpen(true); }}>Исходящие запросы доступны в разделе «Запросы на переписку».</button></p>}<div><button type="button" className="text-button" onClick={() => setAddContactOpen(false)}>Отмена</button><button className="send-file-button" type="submit">Отправить запрос</button></div></form></div>
        </section>}

        {incomingRequestsOpen && <section className="friend-requests-view">
          <header><h2>Запросы на переписку</h2></header>
          <div className="requests-content">
            <section className="request-section"><h3>Входящие</h3>{incomingFriendRequests.length ? <div className="incoming-request-list">{incomingFriendRequests.map((request) => <article className="incoming-request" key={request.public_key}><b>Контакт {request.public_key.slice(-6)}</b><code>{request.public_key}</code>{request.message ? <p data-i18n-ignore translate="no">{request.message}</p> : <p>{t("Без сообщения")}</p>}<button className="send-file-button" onClick={() => { void invoke<number>("accept_incoming_friend_request", { publicKey: request.public_key }).then(() => setIncomingFriendRequests((requests) => requests.filter((item) => item.public_key !== request.public_key))); }}>Принять</button></article>)}</div> : <p className="requests-note">Входящих запросов нет.</p>}</section>
            <section className="request-section"><h3>Исходящие</h3>{outgoingFriendRequests.length ? <div className="incoming-request-list">{outgoingFriendRequests.map((request) => <article className="incoming-request outgoing-request" key={request.toxId}><b>Контакт {request.toxId.slice(-6)}</b><button type="button" className="cancel-request-button" onClick={() => cancelOutgoingFriendRequest(request.toxId)}>Отменить запрос</button><code>{request.toxId}</code>{request.message ? <p data-i18n-ignore translate="no">{request.message}</p> : <p>{t("Без сообщения")}</p>}<span className="request-pending">Ожидает авторизации</span></article>)}</div> : <p className="requests-note">Исходящих запросов нет.</p>}</section>
          </div>
        </section>}

        {isDraggingFile && <div className="file-drop-overlay" aria-hidden="true">Отпустите файл, чтобы отправить его в чат</div>}
        {pendingFile && <div className="file-confirm-overlay" role="dialog" aria-modal="true" aria-label="Подтверждение отправки файла"><div className="file-confirm-card"><b>Отправить файл?</b><span data-i18n-ignore translate="no">{pendingFile.name}</span><small>{formatFileSize(nativeDropSize ?? pendingFile.size)}</small>{fileSendError && <small className="file-confirm-error">{fileSendError}</small>}<div><button className="text-button" onClick={clearPendingFile}>Отмена</button><button className="send-file-button" onClick={confirmFileSend}>Отправить</button></div></div></div>}
        {fullImage?.url && <div className="image-viewer" onClick={() => setFullImage(null)} role="dialog" aria-label="Полноразмерное изображение"><img src={fullImage.url} alt={fullImage.name} /></div>}

        <div className={`message-scroll ${messageScrollActive ? "scroll-active" : ""}`} ref={messageScrollRef} tabIndex={0} onWheel={noteUserScrollActivity} onPointerDown={startDirectScroll} onPointerUp={finishDirectScroll} onPointerCancel={finishDirectScroll} onKeyDown={noteScrollKey} onScroll={updateLatestButton}>
          {!active.id && <p className="empty-conversation">Выберите контакт из списка или добавьте новый по Tox ID.</p>}
          {messages.map((message, index) => (
            <Fragment key={message.coreId ?? message.id}>
            {(index === 0 || formatMessageDay(messages[index - 1].timestamp, language) !== formatMessageDay(message.timestamp, language)) && <span className="date-chip">{formatMessageDay(message.timestamp, language)}</span>}
            {message.event?.kind === "pq" ? <PqHistoryCard event={message.event} mine={!!message.mine} time={message.time} messageKey={message.coreId ?? String(message.id)} contactName={activeName} onWithdraw={() => updatePqStatus("withdraw_pq_session")} onReject={() => updatePqStatus("reject_pq_session")} onAccept={() => updatePqStatus("accept_pq_session")} /> : <article data-message-key={message.coreId ?? String(message.id)} className={`message ${message.mine ? "mine" : ""} ${message.attachment?.url ? "has-image" : ""} ${message.attachment && !message.attachment.url ? "has-file" : ""}`}>
              {message.attachment && <>
                {message.attachment.url && <div className="image-attachment"><button onClick={() => message.attachment?.completed && setFullImage(message.attachment)} title={message.attachment.completed ? "Открыть изображение" : "Изображение ещё передаётся"}><img src={message.attachment.url} alt={message.attachment.name} onLoad={() => correctScrollAfterMediaLoad(message.coreId ?? String(message.id))} /></button></div>}
                {!message.attachment.url && message.attachment.image && message.attachment.completed && <button className="hidden-image-card" onClick={() => message.coreId && setRevealedImages((current) => current.includes(message.coreId!) ? current : [...current, message.coreId!])}><span>Изображение скрыто настройками приватности</span><small data-i18n-ignore translate="no">{renderSearchValue(message, message.attachment.name, "attachment")} · {formatFileSize(message.attachment.size)}</small><b>Показать</b></button>}
                {!message.attachment.url && !(message.attachment.image && message.attachment.completed) && <div className="file-attachment"><span className="file-attachment-icon" aria-hidden="true">📎</span><span data-i18n-ignore translate="no">{renderSearchValue(message, message.attachment.name, "attachment")}</span><small>{formatFileSize(message.attachment.size)}</small></div>}
                {!message.attachment.completed && <div className={`attachment-transfer ${message.attachment.url ? "attachment-transfer-image" : "attachment-transfer-file"}`} aria-label={attachmentTransferText(message.attachment, !!message.mine)}>
                  <div className="attachment-transfer-head"><b>{attachmentTransferTitle(message.attachment, !!message.mine)}</b><span>{attachmentProgress(message.attachment)}%</span></div>
                  <div className="attachment-progress"><i style={{ width: `${attachmentProgress(message.attachment)}%` }} /></div>
                  <small>{attachmentTransferText(message.attachment, !!message.mine)}</small>
                  {(message.attachment.error || (message.coreId && transferErrors[message.coreId])) && <small className="attachment-transfer-error">{formatUserFacingError(message.coreId && transferErrors[message.coreId] ? transferErrors[message.coreId] : message.attachment.error, { ru: "Передача файла завершилась ошибкой", en: "File transfer failed" }, language)}</small>}
                  {message.attachment.transferState !== "cancelled" && <div className="attachment-transfer-actions">
                    {message.mine && message.attachment.transferState === "failed" && <button className="transfer-control transfer-retry" onClick={() => retryAttachmentTransfer(message)}>Повторить</button>}
                    {!message.mine && message.attachment.transferState === "awaiting_confirmation" && <button className="transfer-control transfer-retry" onClick={() => controlAttachmentTransfer(message, "resume")}>Принять файл</button>}
                    {message.attachment.transferState !== "queued" && message.attachment.transferState !== "failed" && message.attachment.transferState !== "awaiting_confirmation" && <button className="transfer-control" onClick={() => controlAttachmentTransfer(message, message.attachment?.transferState === "paused" ? "resume" : "pause")}>{message.attachment.transferState === "paused" ? "Продолжить" : "Пауза"}</button>}
                    <button className="transfer-control transfer-cancel" onClick={() => controlAttachmentTransfer(message, "cancel")}>Отменить</button>
                  </div>}
                </div>}
              </>}
              {message.text ? <p><span className="message-text" data-i18n-ignore translate="no">{renderMessageText(message)}</span><time>{message.time}{message.mine && <span className="delivery-state">{message.delivery === "pending" && !message.attachment ? <i className="delivery-spinner" title="Ожидает отправки" aria-label="Ожидает отправки" /> : message.delivery === "delivered" ? <span title={deliveryReceiptTitle(message)} aria-label={deliveryReceiptTitle(message)}>✓</span> : null}</span>}</time></p> : <div className="attachment-message-meta"><time>{message.time}{message.mine && <span className="delivery-state">{message.delivery === "pending" ? <i className="delivery-spinner" title="Ожидает отправки" aria-label="Ожидает отправки" /> : message.delivery === "delivered" ? <span title={deliveryReceiptTitle(message)} aria-label={deliveryReceiptTitle(message)}>✓</span> : null}</span>}</time></div>}
            </article>}
            </Fragment>
          ))}{messageSearchOpen && messageSearch.trim() && !messageSearchBusy && messageSearchMatches.length === 0 && <p className="empty-search">Совпадений не найдено</p>}
        </div>

        {pendingIncomingCount > 0
          ? <button className="jump-latest has-new" onClick={jumpToLatest} aria-label="Перейти к последнему сообщению">{`↓ Новые сообщения${pendingIncomingCount > 1 ? ` · ${pendingIncomingCount}` : ""}`}</button>
          : showJumpToLatest
            ? <button className="jump-latest" onClick={jumpToLatest} aria-label="Перейти к последнему сообщению">↓ В конец</button>
            : null}

        <MessageComposer
          chatId={activeChat}
          initialValue={draftsRef.current[activeChat] ?? ""}
          sendOnEnter={sendOnEnter}
          spellcheckEnabled={persistenceReady && spellcheckEnabled}
          spellcheckRussian={spellcheckRussian}
          spellcheckEnglish={spellcheckEnglish}
          onDraftChange={updateDraft}
          onSend={stableSendMessage}
          onStageFile={stageFile}
        />
      </section> : <Settings compact={compactSidebar} sidebarHeader={profileSidebarHeader} avatarState={ownAvatarState} openRequest={settingsOpenRequest} appearance={appearance} onAppearanceApply={setAppearance} avatarUrl={profileAvatar} onAvatarChange={updateProfileAvatar} nickname={profileName} onNicknameChange={setProfileName} sendOnEnter={sendOnEnter} onSendOnEnterChange={setSendOnEnter} historyMessageLimit={historyMessageLimit} onHistoryMessageLimitChange={setHistoryMessageLimit} onAutoDownloadImagesChange={setAutoDownloadImages} saveChatHistory={saveChatHistory} onSaveChatHistoryChange={setSaveChatHistory} notifyMessages={notifyMessages} onNotifyMessagesChange={setNotifyMessages} notifyRequests={notifyRequests} onNotifyRequestsChange={setNotifyRequests} spellcheckEnabled={spellcheckEnabled} onSpellcheckEnabledChange={setSpellcheckEnabled} spellcheckRussian={spellcheckRussian} onSpellcheckRussianChange={setSpellcheckRussian} spellcheckEnglish={spellcheckEnglish} onSpellcheckEnglishChange={setSpellcheckEnglish} toxId={ownToxId} />}
    </main>
  );
}

export default App;
