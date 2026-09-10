import { convertFileSrc as tauriConvertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import type { PlatformCapabilities } from "./types";
import { normalizeChatLink } from "../chatLinks";

export const platformCapabilities: PlatformCapabilities = Object.freeze({
  nativeFilesystem: true,
  systemTray: true,
  browserAuthorization: false,
  containerRelativeLayout: false,
  outgoingTransferRetry: true,
  proxyConnectivityTest: true,
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
  profileId: string,
  friendNumber: number,
  file: File,
  nativeGrantToken?: string | null,
) {
  if (nativeGrantToken) {
    return invoke("send_tox_file_from_grant", {
      profileId,
      friendNumber,
      grantToken: nativeGrantToken,
    });
  }
  void profileId;
  void friendNumber;
  void file;
  throw new Error("NATIVE_FILE_GRANT_REQUIRED");
}

export function recoverIncomingTransfer(
  _profileId: string,
  _messageId: string,
  _path: string,
  _friendNumber?: number,
) {
  return Promise.resolve(false);
}

export function setTransferPreviewChatActive(_profileId: string, _friendNumber: number, _active: boolean) {}

export function setTransferPreviewPins(
  _profileId: string,
  _friendNumber: number,
  _paths: Iterable<string>,
) {}

export function releaseTransferPreviews(
  _profileId: string,
  _friendNumber: number,
  _force = false,
) {
  return 0;
}

export function releaseProfileTransferPreviews(_profileId: string) {
  return 0;
}

export function transferPreviewSource(path: string, _profileId: string, _friendNumber: number) {
  return convertFileSrc(path);
}

export function openUrl(url: string) {
  if (url === "https://github.com/kaigendev/Kaigen") return invoke("open_project_repository");
  const target = normalizeChatLink(url);
  if (!target) return Promise.reject(new Error("EXTERNAL_URL_NOT_ALLOWED"));
  return invoke("open_external_url", { url: target });
}

export {
  getCurrentWindow,
  invoke,
  isPermissionGranted,
  listen,
  requestPermission,
  sendNotification,
};
