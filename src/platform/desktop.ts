import { convertFileSrc as tauriConvertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
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
  // Native Rust owns the picker. Unlike the JavaScript dialog plugin, this
  // does not add the selected host path to WebView asset-protocol scope.
  return invoke<string | string[] | null>("open_native_dialog", { options });
}

export async function sendFile(
  friendNumber: number,
  file: File,
  nativeGrantToken?: string | null,
) {
  if (nativeGrantToken) {
    return invoke("send_tox_file_from_grant", {
      friendNumber,
      grantToken: nativeGrantToken,
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

export function openUrl(url: string) {
  if (url !== "https://github.com/kaigendev/Kaigen") {
    return Promise.reject(new Error("EXTERNAL_URL_NOT_ALLOWED"));
  }
  return invoke("open_project_repository");
}

export {
  getCurrentWindow,
  invoke,
  isPermissionGranted,
  listen,
  requestPermission,
  sendNotification,
};
