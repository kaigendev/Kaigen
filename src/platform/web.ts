import type { OpenDialogOptions, PlatformCapabilities, NotificationOptions, NotificationPermission } from "./types";
import { webSession } from "../web/session";
import type { WebTransferView } from "../web/session";

const pendingFiles = new Map<string, File>();

type ExportableMessage = {
  text?: string;
  mine?: boolean;
  timestamp?: number;
  attachment?: { name?: string } | null;
};

function safeDownloadName(value: string) {
  const cleaned = value.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "_").replace(/[. ]+$/u, "");
  return (cleaned || "contact").slice(0, 96);
}

function downloadText(text: string, filename: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
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
  const messages = await webSession.command<ExportableMessage[]>("get_tox_messages", { friendNumber });
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
  const text = [...messages]
    .sort((left, right) => Number(left.timestamp ?? 0) - Number(right.timestamp ?? 0))
    .map((message) => {
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
  downloadText(text, filename);
  return filename;
}

function browserFileHandle(file: File) {
  const id = crypto.randomUUID();
  pendingFiles.set(id, file);
  return `browser-file://${id}`;
}

export const platformCapabilities: PlatformCapabilities = Object.freeze({
  product: "web",
  nativeFilesystem: false,
  systemTray: false,
  browserAuthorization: true,
});

export async function invoke<T>(command: string, args: Record<string, unknown> = {}) {
  if (command === "exit_application") {
    window.dispatchEvent(new Event("kaigen:web-close-request"));
    return null as T;
  }
  if (command === "export_tox_history") {
    return await exportChatHistory(args) as T;
  }
  const result = await webSession.command<T>(command, args);
  if (command === "control_tox_file_transfer" && args.action === "resume") {
    await webSession.startIncomingTransfer(result as Awaited<T> & WebTransferView);
  }
  return result;
}

export function sendFile(friendNumber: number, file: File, _nativePath?: string | null) {
  return webSession.sendBrowserFile(friendNumber, file);
}

export function listen<T>(event: string, handler: (event: { event: string; id: number; payload: T }) => void) {
  return webSession.listen(event, handler);
}

export function convertFileSrc(path: string) {
  if (/^(?:blob:|data:|https?:)/u.test(path)) return path;
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
  if (options.directory) return Promise.resolve(null);
  return new Promise<string | string[] | null>((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = options.multiple === true;
    input.accept = options.filters?.flatMap((filter) => filter.extensions.map((extension) => `.${extension}`)).join(",") ?? "";
    input.addEventListener("change", () => {
      const handles = Array.from(input.files ?? []).map(browserFileHandle);
      resolve(options.multiple ? handles : handles[0] ?? null);
    }, { once: true });
    input.click();
  });
}

export function openUrl(url: string) {
  window.open(url, "_blank", "noopener,noreferrer");
  return Promise.resolve();
}

export async function isPermissionGranted() {
  return "Notification" in window && Notification.permission === "granted";
}

export async function requestPermission(): Promise<NotificationPermission> {
  if (!("Notification" in window)) return "denied";
  return Notification.requestPermission();
}

export function sendNotification(options: NotificationOptions) {
  if ("Notification" in window && Notification.permission === "granted") {
    new Notification(options.title, { body: options.body });
  }
}

export function takePendingBrowserFile(handle: string) {
  if (!handle.startsWith("browser-file://")) return null;
  const id = handle.slice("browser-file://".length);
  const file = pendingFiles.get(id) ?? null;
  pendingFiles.delete(id);
  return file;
}
