import type { OpenDialogOptions, PlatformCapabilities, NotificationOptions, NotificationPermission } from "./types";
import type { AttachmentFileRequest, AttachmentMediaSource } from "./types";
import { saveBrowserFileCopy } from "../browserFileCopy";
import { chatMediaMime } from "../chatAttachmentMedia";
import { webSession } from "../web/session";
import type { WebTransferView } from "../web/session";
import { createStoredQtoxZip, listQtoxFolderProfiles, MAX_QTOX_FOLDER_BYTES } from "./browser-profile-import";
import { normalizeChatLink } from "../chatLinks";
import { browserNotificationPermission, displayBrowserNotification } from "../web/browserNotifications";
import { createWebgatePlatformRouter, webgateTransferWake, type ProfilesView, type RawInvoke } from "../webgate/platformRouter";
import { createWebgateTransfers } from "../webgate/transfers";
import { makeWebgateCard, parseWebgateCard, serializeWebgateCard } from "../webgate/connectionCard";
import { isWebgateProfileId } from "../webgate/platformRouter";

const remoteProfileIds = new Map<string, string | null>();

async function attachmentOriginal(request: AttachmentFileRequest, signal: AbortSignal) {
  if (!request.path.startsWith("browser-stream://")) throw new Error("TRANSFER_WORKSPACE_BOUNDARY");
  const transferId = request.path.slice("browser-stream://".length);
  return isWebgateProfileId(request.profileId)
    ? remoteTransfers.originalBlob(request.profileId, request.messageId, transferId, signal)
    : webSession.originalBlob(request.profileId, request.messageId, transferId, signal);
}

export async function loadAttachmentMedia(request: AttachmentFileRequest, signal: AbortSignal): Promise<AttachmentMediaSource> {
  const blob = await attachmentOriginal(request, signal);
  signal.throwIfAborted();
  const original = blob.slice(0, blob.size, chatMediaMime(request.name));
  const url = URL.createObjectURL(original);
  return { url, blob: original, release: () => URL.revokeObjectURL(url) };
}

export function saveAttachmentCopy(request: AttachmentFileRequest, _title: string, signal: AbortSignal, language: "ru" | "en" = "en") {
  return saveBrowserFileCopy(request.name, async () => {
    const blob = await attachmentOriginal(request, signal);
    return blob.slice(0, blob.size, chatMediaMime(request.name));
  }, signal, language);
}
const transferWakes = new Map<string, Set<() => void>>();
const webgateEventsReady = Promise.all([
  webSession.listen<unknown>("webgate-event", ({ payload }) => {
    const id = webgateTransferWake(payload);
    if (id) for (const wake of transferWakes.get(id) ?? []) wake();
  }),
  webSession.listen<{ resyncRequired?: boolean }>("profile-changed", ({ payload }) => {
    if (payload.resyncRequired) for (const listeners of transferWakes.values()) for (const wake of listeners) wake();
  }),
]);
void webgateEventsReady.catch(() => {});
const remoteTransfers = createWebgateTransfers({
  persistentReplica: false,
  call: async (profileId, operation, args) => {
    await webgateEventsReady;
    return webSession.command("webgate_file_operation", { profileId, operation, args });
  },
  subscribe: (profileId, wake) => {
    const listeners = transferWakes.get(profileId) ?? new Set<() => void>();
    listeners.add(wake); transferWakes.set(profileId, listeners);
    return () => { listeners.delete(wake); if (!listeners.size) transferWakes.delete(profileId); };
  },
  remoteProfileId: (id) => remoteProfileIds.get(id),
  download: async (blob, name) => { downloadBlob(blob, safeDownloadName(name)); },
});

function clearRemoteProfile(id: string) { remoteTransfers.clearProfile(id); remoteProfileIds.delete(id); }
function acceptRemoteProfiles(view: ProfilesView) {
  const current = new Map(view.profiles.filter((profile) => isWebgateProfileId(profile.id) && profile.loaded !== false)
    .map((profile) => [profile.id, profile.profileId ?? profile.metadata?.profileId ?? null] as const));
  for (const [id, upstream] of remoteProfileIds) if (!current.has(id) || current.get(id) !== upstream) clearRemoteProfile(id);
  for (const [id, upstream] of current) {
    const added = !remoteProfileIds.has(id);
    remoteProfileIds.set(id, upstream);
    if (added) remoteTransfers.trackProfile(id);
  }
}

async function localRemoteCommand(command: string, args: Record<string, unknown>, profileId: string) {
  if (command === "export_tox_history") return exportChatHistory({ ...args, profileId }, invoke);
  const { messageId, path, friendNumber } = args;
  if (typeof messageId !== "string" || typeof path !== "string" || !path.startsWith("browser-stream://")
    || !Number.isSafeInteger(friendNumber) || Number(friendNumber) < 0) throw new Error("COMMAND_ARGUMENT_INVALID");
  await remoteTransfers.downloadTransfer(profileId, messageId, path.slice("browser-stream://".length), Number(friendNumber),
    command === "open_web_video" ? "open-video" : "download");
  if (command === "open_web_video") {
    const url = remoteTransfers.preview(path, profileId, Number(friendNumber));
    if (!url) throw new Error("TRANSFER_VIDEO_PREVIEW_UNAVAILABLE");
    return url;
  }
}

export const invoke = createWebgatePlatformRouter(invokeWebPlatform, {
  onProfiles: acceptRemoteProfiles,
  onProfileReplaced: clearRemoteProfile,
  localInvoke: (command, args, profileId) => ["download_web_transfer", "open_web_video", "export_tox_history"].includes(command)
    ? localRemoteCommand(command, args, profileId) : undefined,
});
let profileRefreshRunning = false;
let profileRefreshDirty = false;
function refreshRemoteProfiles() {
  profileRefreshDirty = true;
  if (profileRefreshRunning) return;
  profileRefreshRunning = true;
  void (async () => {
    try { while (profileRefreshDirty) { profileRefreshDirty = false; await invoke<ProfilesView>("webgate_profiles"); } }
    catch { /* The session/startup owner reports authorization failures. */ }
    finally { profileRefreshRunning = false; if (profileRefreshDirty) refreshRemoteProfiles(); }
  })();
}
void webSession.listen("profiles-changed", refreshRemoteProfiles);
webSession.onSessionUnavailable(() => { for (const id of [...remoteProfileIds.keys()]) clearRemoteProfile(id); });
window.addEventListener("beforeunload", () => { for (const id of [...remoteProfileIds.keys()]) clearRemoteProfile(id); });

const pendingFiles = new Map<string, File>();
const pendingProfileFileIds = new Set<string>();
const pendingDirectories = new Map<string, File[]>();
const pendingQtoxProfiles = new Map<string, { directoryId: string; relativePath: string; name: string }>();

type BrowserQtoxCandidate = {
  name: string;
  profilePath: string;
  sourceLabel: string;
  historyPath: null;
  settingsPath: null;
  encrypted: false;
  passwordMode: "optional";
};

type ExportableMessage = {
  text?: string;
  mine?: boolean;
  timestamp?: number;
  attachment?: { name?: string } | null;
};

type ExportMessagePage = {
  messages: ExportableMessage[];
  nextOffset: number;
  done: boolean;
};

function safeDownloadName(value: string) {
  const cleaned = value.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "_").replace(/[. ]+$/u, "");
  return (cleaned || "contact").slice(0, 96);
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

async function exportChatHistory(args: Record<string, unknown>, request: RawInvoke = (command, input) => webSession.command(command, input)) {
  const friendNumber = Number(args.friendNumber);
  if (!Number.isInteger(friendNumber) || friendNumber < 0) throw new Error("COMMAND_ARGUMENT_INVALID");
  const contactName = String(args.contactName ?? "").trim();
  const contactId = String(args.contactId ?? "").trim();
  const language = document.documentElement.lang === "en" ? "en" : "ru";
  const formatter = new Intl.DateTimeFormat(language === "ru" ? "ru-RU" : "en-GB", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const formatPage = (messages: ExportableMessage[]) => messages.map((message) => {
      const timestamp = formatter.format(new Date(Number(message.timestamp ?? 0) * 1000));
      const author = message.mine ? (language === "ru" ? "Я" : "Me") : contactName || contactId || "Contact";
      const body = message.attachment?.name
        ? `${language === "ru" ? "Вложение" : "Attachment"}: ${message.attachment.name}`
        : String(message.text ?? "");
      return `${timestamp}\r\n${author}: ${body}`;
    })
    .join("\r\n\r\n");
  const date = new Date().toISOString().slice(0, 10);
  const filename = `${safeDownloadName(contactName || contactId)}-${date}.txt`;
  const storage = navigator.storage as StorageManager & {
    getDirectory?: () => Promise<FileSystemDirectoryHandle>;
  };
  if (!storage.getDirectory) throw new Error("HISTORY_EXPORT_STORAGE_UNAVAILABLE");
  const root = await storage.getDirectory();
  const temporaryName = `.kaigen-history-export-${crypto.randomUUID()}.tmp`;
  const handle = await root.getFileHandle(temporaryName, { create: true });
  const writer = await handle.createWritable();
  let closed = false;
  try {
    let offset = 0;
    let wroteMessages = false;
    while (true) {
      const page = await request<ExportMessagePage>("get_tox_messages_page", {
        ...(typeof args.profileId === "string" ? { profileId: args.profileId } : {}),
        friendNumber,
        offset,
        limit: 256,
      });
      if (page.messages.length) {
        if (wroteMessages) await writer.write("\r\n\r\n");
        await writer.write(formatPage(page.messages));
        wroteMessages = true;
      }
      if (page.done) break;
      if (!Number.isSafeInteger(page.nextOffset) || page.nextOffset <= offset) {
        throw new Error("HISTORY_EXPORT_CURSOR_INVALID");
      }
      offset = page.nextOffset;
    }
    await writer.close();
    closed = true;
    const file = await handle.getFile();
    downloadBlob(file, filename);
    window.setTimeout(() => void root.removeEntry(temporaryName).catch(() => {}), 30_000);
  } catch (error) {
    if (!closed) await writer.abort().catch(() => {});
    await root.removeEntry(temporaryName).catch(() => {});
    throw error;
  }
  return filename;
}

function browserFileHandle(file: File) {
  const id = crypto.randomUUID();
  pendingFiles.set(id, file);
  return `browser-file://${id}`;
}

function clearPendingQtoxDirectories() {
  pendingDirectories.clear();
  pendingQtoxProfiles.clear();
}

function retainPendingProfileFile(id: string) {
  for (const previousId of pendingProfileFileIds) {
    if (previousId !== id) pendingFiles.delete(previousId);
  }
  pendingProfileFileIds.clear();
  pendingProfileFileIds.add(id);
}

function clearPendingProfileFiles() {
  for (const id of pendingProfileFileIds) pendingFiles.delete(id);
  pendingProfileFileIds.clear();
}

function browserDirectoryHandle(files: File[]) {
  clearPendingQtoxDirectories();
  clearPendingProfileFiles();
  const id = crypto.randomUUID();
  pendingDirectories.set(id, files);
  return `browser-directory://${id}`;
}

function browserSourceId(handle: string, prefix: string) {
  const id = handle.slice(prefix.length);
  return /^[0-9a-f-]{36}$/iu.test(id) ? id : "";
}

function browserFileCandidate(handle: string): BrowserQtoxCandidate[] {
  const id = browserSourceId(handle, "browser-file://");
  const file = pendingFiles.get(id);
  if (!file) throw new Error("BROWSER_PROFILE_FILE_INVALID");
  clearPendingQtoxDirectories();
  retainPendingProfileFile(id);
  if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > MAX_QTOX_FOLDER_BYTES) {
    throw new Error("BROWSER_PROFILE_FILE_INVALID");
  }
  const lower = file.name.toLocaleLowerCase("en-US");
  if (!lower.endsWith(".kai") && !lower.endsWith(".zip")) throw new Error("BROWSER_PROFILE_FILE_TYPE_INVALID");
  const name = file.name.replace(/\.(?:kai|zip)$/iu, "").slice(0, 64) || "Imported profile";
  return [{ name, profilePath: handle, sourceLabel: file.name, historyPath: null, settingsPath: null, encrypted: false, passwordMode: "optional" }];
}

function browserDirectoryCandidates(handle: string): BrowserQtoxCandidate[] {
  const directoryId = browserSourceId(handle, "browser-directory://");
  const files = pendingDirectories.get(directoryId);
  if (!files) throw new Error("BROWSER_QTOX_FOLDER_INVALID");
  for (const [id, source] of pendingQtoxProfiles) {
    if (source.directoryId === directoryId) pendingQtoxProfiles.delete(id);
  }
  return listQtoxFolderProfiles(files).map((profile) => {
    const id = crypto.randomUUID();
    pendingQtoxProfiles.set(id, { directoryId, relativePath: profile.relativePath, name: profile.name });
    return {
      name: profile.name,
      profilePath: `browser-qtox://${id}`,
      sourceLabel: profile.relativePath,
      historyPath: null,
      settingsPath: null,
      encrypted: false,
      passwordMode: "optional",
    };
  });
}

function discoverBrowserProfiles(args: Record<string, unknown>) {
  const location = typeof args.location === "string" ? args.location : "";
  if (location.startsWith("browser-file://")) return browserFileCandidate(location);
  if (location.startsWith("browser-directory://")) return browserDirectoryCandidates(location);
  throw new Error("BROWSER_PROFILE_SOURCE_REQUIRED");
}

async function importBrowserProfile(args: Record<string, unknown>) {
  const profilePath = typeof args.profilePath === "string" ? args.profilePath : "";
  const password = typeof args.password === "string" ? args.password : "";
  if (profilePath.startsWith("browser-file://")) {
    const id = browserSourceId(profilePath, "browser-file://");
    const file = pendingFiles.get(id);
    if (!file) throw new Error("BROWSER_PROFILE_FILE_INVALID");
    const lower = file.name.toLocaleLowerCase("en-US");
    const kind = lower.endsWith(".kai") ? "kai" : lower.endsWith(".zip") ? "qtoxZip" : null;
    if (!kind) throw new Error("BROWSER_PROFILE_FILE_TYPE_INVALID");
    const name = file.name.replace(/\.(?:kai|zip)$/iu, "").slice(0, 64) || "Imported profile";
    const profiles = await webSession.importProfile(file, kind, name, password);
    pendingFiles.delete(id);
    pendingProfileFileIds.delete(id);
    return profiles;
  }
  if (profilePath.startsWith("browser-qtox://")) {
    const id = browserSourceId(profilePath, "browser-qtox://");
    const source = pendingQtoxProfiles.get(id);
    const files = source ? pendingDirectories.get(source.directoryId) : null;
    if (!source || !files) throw new Error("BROWSER_QTOX_FOLDER_INVALID");
    const archive = await createStoredQtoxZip(files, source.relativePath);
    const profiles = await webSession.importProfile(archive, "qtoxZip", source.name, password);
    pendingQtoxProfiles.delete(id);
    if (![...pendingQtoxProfiles.values()].some((candidate) => candidate.directoryId === source.directoryId)) {
      pendingDirectories.delete(source.directoryId);
    }
    return profiles;
  }
  throw new Error("BROWSER_PROFILE_SOURCE_REQUIRED");
}

export const platformCapabilities: PlatformCapabilities = Object.freeze({
  nativeFilesystem: false,
  systemTray: false,
  browserAuthorization: true,
  containerRelativeLayout: true,
  outgoingTransferRetry: false,
  proxyConnectivityTest: false,
});

async function invokeWebPlatform<T>(command: string, args: Record<string, unknown> = {}) {
  if (command === "get_webgate_connection_card" && (args.purpose === "export" || !isWebgateProfileId(args.profileId))) {
    const identifier = webSession.getIdentifier();
    if (!identifier || typeof args.profileId !== "string") throw new Error("WEBGATE_PROFILE_NOT_FOUND");
    const view = await webSession.command<{ profiles: { id: string; name: string }[] }>("webgate_profiles");
    const profile = view.profiles.find((profile) => profile.id === args.profileId);
    if (!profile) throw new Error("WEBGATE_PROFILE_NOT_FOUND");
    const binding = await webSession.command<{ profileId: string; identity: { serverId: string; workspaceId: string; profileId: string } }>(
      "get_webgate_profile_identity", { profileId: args.profileId });
    if (binding.profileId !== args.profileId) throw new Error("WEBGATE_ACCOUNT_IDENTITY_CHANGED");
    const link = new URL(location.href);
    link.search = "";
    link.hash = `k=${identifier}`;
    return makeWebgateCard({ endpoint: link.href, profileName: profile.name, profileId: binding.profileId, identity: binding.identity, password: "" }) as T;
  }
  if (command === "save_webgate_connection_card") {
    if (typeof args.card !== "string") throw new Error("WEBGATE_CARD_INVALID");
    const input = parseWebgateCard(args.card);
    const card = makeWebgateCard(input);
    const name = `${safeDownloadName(card.profileName)}.webgate.json`;
    downloadBlob(new Blob([serializeWebgateCard(card, input.password || undefined)], { type: "application/json" }), name);
    return name as T;
  }
  if (command === "report_webview_heartbeat") {
    return null as T;
  }
  if (command === "exit_application") {
    window.dispatchEvent(new Event("kaigen:web-close-request"));
    return null as T;
  }
  if (command === "export_tox_history") {
    return await exportChatHistory(args) as T;
  }
  if (command === "discover_qtox_profiles") {
    return discoverBrowserProfiles(args) as T;
  }
  if (command === "import_qtox_profile") {
    return await importBrowserProfile(args) as T;
  }
  if (command === "download_web_transfer" || command === "open_web_video") {
    const { profileId, messageId, path, friendNumber } = args;
    if (typeof profileId !== "string" || typeof messageId !== "string" || typeof path !== "string"
      || !path.startsWith("browser-stream://") || !Number.isSafeInteger(friendNumber) || Number(friendNumber) < 0) {
      throw new Error("COMMAND_ARGUMENT_INVALID");
    }
    const transferId = path.slice("browser-stream://".length);
    if (command === "download_web_transfer") {
      return await webSession.downloadTransfer(profileId, messageId, transferId, Number(friendNumber)) as T;
    }
    await webSession.downloadTransfer(profileId, messageId, transferId, Number(friendNumber), "open-video");
    const url = webSession.transferPreviewSource(profileId, Number(friendNumber), path);
    if (!url) throw new Error("TRANSFER_VIDEO_PREVIEW_UNAVAILABLE");
    return url as T;
  }
  const result = await webSession.command<T>(command, args);
  if (command === "control_tox_file_transfer" && args.action === "resume") {
    const friendNumber = Number(args.friendNumber);
    if (!Number.isSafeInteger(friendNumber) || friendNumber < 0) throw new Error("COMMAND_ARGUMENT_INVALID");
    await webSession.startIncomingTransfer(result as Awaited<T> & WebTransferView, friendNumber);
  }
  return result;
}

export function sendFile(profileId: string, friendNumber: number, file: File, expectedPublicKey: string, _nativePath?: string | null) {
  if (isWebgateProfileId(profileId)) return remoteTransfers.sendFile(profileId, friendNumber, file, expectedPublicKey);
  return webSession.sendBrowserFile(profileId, friendNumber, file, expectedPublicKey);
}

export function recoverIncomingTransfer(profileId: string, messageId: string, path: string, friendNumber?: number) {
  const prefix = "browser-stream://";
  if (!path.startsWith(prefix)) return Promise.resolve(false);
  if (isWebgateProfileId(profileId)) return remoteTransfers.recoverIncomingTransfer(profileId, messageId, path.slice(prefix.length), friendNumber);
  return webSession.recoverIncomingTransfer(profileId, messageId, path.slice(prefix.length), friendNumber);
}

export function setTransferPreviewChatActive(profileId: string, friendNumber: number, active: boolean) {
  if (isWebgateProfileId(profileId)) { remoteTransfers.setPreviewChatActive(profileId, friendNumber, active); return; }
  webSession.setTransferPreviewChatActive(profileId, friendNumber, active);
}

export function setTransferPreviewPins(profileId: string, friendNumber: number, paths: Iterable<string>) {
  if (isWebgateProfileId(profileId)) { remoteTransfers.setPreviewPins(profileId, friendNumber, paths); return; }
  webSession.setTransferPreviewPins(profileId, friendNumber, paths);
}

export function releaseTransferPreviews(profileId: string, friendNumber: number, force = false) {
  if (isWebgateProfileId(profileId)) return remoteTransfers.releasePreviews(profileId, friendNumber, force);
  return webSession.releaseTransferPreviews(profileId, friendNumber, force);
}

export function releaseProfileTransferPreviews(profileId: string) {
  if (isWebgateProfileId(profileId)) return remoteTransfers.releaseProfilePreviews(profileId);
  return webSession.releaseProfileTransferPreviews(profileId);
}

export function transferPreviewSource(path: string, profileId: string, friendNumber: number) {
  if (isWebgateProfileId(profileId)) return remoteTransfers.preview(path, profileId, friendNumber);
  const prefix = "browser-stream://";
  if (!path.startsWith(prefix)) return "";
  return webSession.transferPreviewSource(profileId, friendNumber, path);
}

export function listen<T>(event: string, handler: (event: { event: string; id: number; payload: T }) => void) {
  return webSession.listen(event, handler);
}

export function convertFileSrc(path: string) {
  if (/^(?:blob:|data:|https?:)/u.test(path)) return path;
  if (path.startsWith("browser-stream://")) return "";
  return `/api/v1/files/${encodeURIComponent(path)}`;
}

export function getCurrentWindow() {
  return {
    setTitle: async (title: string) => {
      document.title = title;
    },
    onDragDropEvent: async (_handler: (event: { payload: { type: "enter" | "over" | "leave"; paths?: string[] } | { type: "drop"; paths: string[] } }) => void) => {
      const dragover = (event: DragEvent) => event.preventDefault();
      window.addEventListener("dragover", dragover);
      return () => {
        window.removeEventListener("dragover", dragover);
      };
    },
  };
}

export function openDialog(options: OpenDialogOptions = {}, signal?: AbortSignal) {
  return new Promise<string | string[] | null>((resolve, reject) => {
    if (signal?.aborted) { resolve(null); return; }
    const input = document.createElement("input");
    input.type = "file";
    input.tabIndex = -1;
    input.setAttribute("aria-hidden", "true");
    // Keep the input alive and attached while Safari's native picker is open.
    Object.assign(input.style, { position: "fixed", left: "-10000px", width: "1px", height: "1px", opacity: "0" });
    input.multiple = options.directory === true || options.multiple === true;
    if (options.directory) {
      input.webkitdirectory = true;
      input.setAttribute("webkitdirectory", "");
    } else {
      input.accept = options.filters?.flatMap((filter) => filter.extensions.map((extension) => `.${extension}`)).join(",") ?? "";
    }
    let settled = false;
    const cleanup = () => {
      input.removeEventListener("change", selected);
      input.removeEventListener("cancel", cancelled);
      window.removeEventListener("focus", returned);
      document.removeEventListener("visibilitychange", returned);
      signal?.removeEventListener("abort", cancelled);
      input.remove();
    };
    const finish = (files: File[] | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        if (!files?.length) { resolve(null); return; }
        if (options.directory) { resolve(browserDirectoryHandle(files)); return; }
        const handles = files.map(browserFileHandle);
        resolve(options.multiple ? handles : handles[0] ?? null);
      } catch (error) { reject(error); }
    };
    const selected = () => finish(Array.from(input.files ?? []));
    const cancelled = () => finish(null);
    const returned = () => {
      // A return event can precede iOS's change event. Never infer cancellation
      // from focus or an empty FileList; the UI offers explicit cancellation.
      if (!document.hidden && input.files?.length) selected();
    };
    input.addEventListener("change", selected);
    input.addEventListener("cancel", cancelled);
    window.addEventListener("focus", returned);
    document.addEventListener("visibilitychange", returned);
    signal?.addEventListener("abort", cancelled, { once: true });
    document.body.append(input);
    try { input.click(); }
    catch (error) { settled = true; cleanup(); reject(error); }
  });
}

export function openUrl(url: string) {
  const target = normalizeChatLink(url);
  if (!target) return Promise.reject(new Error("EXTERNAL_URL_NOT_ALLOWED"));
  window.open(target, "_blank", "noopener,noreferrer");
  return Promise.resolve();
}

export async function isPermissionGranted() {
  return browserNotificationPermission() === "granted";
}

export async function requestPermission(): Promise<NotificationPermission> {
  if (browserNotificationPermission() === "unsupported") return "denied";
  return Notification.requestPermission();
}

export function sendNotification(options: NotificationOptions) {
  void displayBrowserNotification(options).catch(() => {});
}
