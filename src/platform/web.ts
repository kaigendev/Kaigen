import type { OpenDialogOptions, PlatformCapabilities, NotificationOptions, NotificationPermission } from "./types";
import { webSession } from "../web/session";
import type { WebTransferView } from "../web/session";
import { createStoredQtoxZip, listQtoxFolderProfiles, MAX_QTOX_FOLDER_BYTES } from "./browser-profile-import";
import { normalizeChatLink } from "../chatLinks";

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

async function exportChatHistory(args: Record<string, unknown>) {
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
      const page = await webSession.command<ExportMessagePage>("get_tox_messages_page", {
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

export async function invoke<T>(command: string, args: Record<string, unknown> = {}) {
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
  if (command === "download_web_transfer") {
    const { profileId, messageId, path, friendNumber } = args;
    if (typeof profileId !== "string" || typeof messageId !== "string" || typeof path !== "string"
      || !path.startsWith("browser-stream://") || !Number.isSafeInteger(friendNumber) || Number(friendNumber) < 0) {
      throw new Error("COMMAND_ARGUMENT_INVALID");
    }
    return await webSession.downloadTransfer(profileId, messageId, path.slice("browser-stream://".length), Number(friendNumber)) as T;
  }
  const result = await webSession.command<T>(command, args);
  if (command === "control_tox_file_transfer" && args.action === "resume") {
    const friendNumber = Number(args.friendNumber);
    if (!Number.isSafeInteger(friendNumber) || friendNumber < 0) throw new Error("COMMAND_ARGUMENT_INVALID");
    await webSession.startIncomingTransfer(result as Awaited<T> & WebTransferView, friendNumber);
  }
  return result;
}

export function sendFile(profileId: string, friendNumber: number, file: File, _nativePath?: string | null) {
  return webSession.sendBrowserFile(profileId, friendNumber, file);
}

export function recoverIncomingTransfer(profileId: string, messageId: string, path: string, friendNumber?: number) {
  const prefix = "browser-stream://";
  if (!path.startsWith(prefix)) return Promise.resolve(false);
  return webSession.recoverIncomingTransfer(profileId, messageId, path.slice(prefix.length), friendNumber);
}

export function setTransferPreviewChatActive(profileId: string, friendNumber: number, active: boolean) {
  webSession.setTransferPreviewChatActive(profileId, friendNumber, active);
}

export function setTransferPreviewPins(profileId: string, friendNumber: number, paths: Iterable<string>) {
  webSession.setTransferPreviewPins(profileId, friendNumber, paths);
}

export function releaseTransferPreviews(profileId: string, friendNumber: number, force = false) {
  return webSession.releaseTransferPreviews(profileId, friendNumber, force);
}

export function releaseProfileTransferPreviews(profileId: string) {
  return webSession.releaseProfileTransferPreviews(profileId);
}

export function transferPreviewSource(path: string, profileId: string, friendNumber: number) {
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

export function openDialog(options: OpenDialogOptions = {}) {
  return new Promise<string | string[] | null>((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = options.directory === true || options.multiple === true;
    if (options.directory) {
      input.webkitdirectory = true;
      input.setAttribute("webkitdirectory", "");
    } else {
      input.accept = options.filters?.flatMap((filter) => filter.extensions.map((extension) => `.${extension}`)).join(",") ?? "";
    }
    input.addEventListener("change", () => {
      const files = Array.from(input.files ?? []);
      if (options.directory) {
        resolve(files.length ? browserDirectoryHandle(files) : null);
        return;
      }
      const handles = files.map(browserFileHandle);
      resolve(options.multiple ? handles : handles[0] ?? null);
    }, { once: true });
    input.addEventListener("cancel", () => resolve(null), { once: true });
    input.click();
  });
}

export function openUrl(url: string) {
  const target = normalizeChatLink(url);
  if (!target) return Promise.reject(new Error("EXTERNAL_URL_NOT_ALLOWED"));
  window.open(target, "_blank", "noopener,noreferrer");
  return Promise.resolve();
}

export async function isPermissionGranted() {
  return false;
}

export async function requestPermission(): Promise<NotificationPermission> {
  return "denied";
}

export function sendNotification(_options: NotificationOptions) {}

export function takePendingBrowserFile(handle: string) {
  if (!handle.startsWith("browser-file://")) return null;
  const id = handle.slice("browser-file://".length);
  const file = pendingFiles.get(id) ?? null;
  pendingFiles.delete(id);
  return file;
}
