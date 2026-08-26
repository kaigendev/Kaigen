import { convertFileSrc as tauriConvertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as tauriOpenDialog } from "@tauri-apps/plugin-dialog";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { PlatformCapabilities } from "./types";

export const platformCapabilities: PlatformCapabilities = Object.freeze({
  product: "desktop",
  nativeFilesystem: true,
  systemTray: true,
  browserAuthorization: false,
});

export function convertFileSrc(path: string) {
  if (/^(?:blob:|data:|https?:)/u.test(path)) return path;
  return tauriConvertFileSrc(path);
}

export async function openDialog(options: import("./types").OpenDialogOptions = {}) {
  // The plugin's frontend command uses a blocking NSOpenPanel path. On macOS
  // that can abort the process before JavaScript receives an error, so route
  // it through our callback-based native command. The Rust side schedules the
  // panel on the main thread and attaches it to the Kaigen window.
  if (/Macintosh|Mac OS X/i.test(navigator.userAgent)) {
    return invoke<string | null>("open_macos_dialog", { options });
  }
  return tauriOpenDialog(options);
}

export async function sendFile(
  friendNumber: number,
  file: File,
  nativePath?: string | null,
) {
  if (nativePath) {
    return invoke("send_tox_file_from_path", {
      friendNumber,
      path: nativePath,
      mime: file.type || "application/octet-stream",
    });
  }
  const buffer = await file.arrayBuffer();
  return invoke("send_tox_file", {
    friendNumber,
    filename: file.name,
    mime: file.type || "application/octet-stream",
    bytes: Array.from(new Uint8Array(buffer)),
  });
}

export {
  getCurrentWindow,
  invoke,
  isPermissionGranted,
  listen,
  openUrl,
  requestPermission,
  sendNotification,
};
