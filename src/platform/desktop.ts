import { convertFileSrc as tauriConvertFileSrc, invoke as nativeInvoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import type { PlatformCapabilities } from "./types";
import type { AttachmentFileRequest, AttachmentMediaSource } from "./types";
import type { FileCopyResult } from "../browserFileCopy";
import { chatMediaMime } from "../chatAttachmentMedia";
import { normalizeChatLink } from "../chatLinks";
import { createWebgatePlatformRouter, exportWebgateHistory, isWebgateProfileId, webgateTransferWake,
  type ProfilesView, type WebgateHistoryWriter } from "../webgate/platformRouter";
import { createWebgateTransfers } from "../webgate/transfers";
import { transferPayloadSha256 } from "../web/transferPump";
import type { WebTransferView } from "../web/session";

const remoteProfileIds = new Map<string, string | null>();
const remoteDownloadBindings = new Map<string, string>();
const transferWakes = new Map<string, Set<() => void>>();
const downloadEpochs = new Map<string, number>();
const savedDownloads = new Map<string, Promise<void>>();
const nativeEventsReady = listen<unknown>("webgate-event", ({ payload }) => {
  const id = webgateTransferWake(payload);
  if (id) for (const wake of transferWakes.get(id) ?? []) wake();
});
void nativeEventsReady.catch(() => {});

function subscribeTransfers(profileId: string, wake: () => void) {
  const listeners = transferWakes.get(profileId) ?? new Set<() => void>();
  listeners.add(wake);
  transferWakes.set(profileId, listeners);
  return () => { listeners.delete(wake); if (!listeners.size) transferWakes.delete(profileId); };
}

function base64Chunk(bytes: Uint8Array) {
  let binary = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

function assertDownload(profileId: string, epoch: number) {
  if (!remoteProfileIds.has(profileId) || (downloadEpochs.get(profileId) ?? 0) !== epoch) throw new Error("TRANSFER_PUMP_STOPPED");
}

async function nativeWriter(profileId: string, name: string, file?: { sizeBytes: number; sha256: string; messageId: string; transferId: string; expectedBinding: string }): Promise<WebgateHistoryWriter> {
  const epoch = downloadEpochs.get(profileId) ?? 0;
  assertDownload(profileId, epoch);
  const token = await nativeInvoke<string>(file ? "begin_webgate_download" : "begin_webgate_history_export", { profileId, name, ...file });
  let position = 0;
  return {
    write: async (bytes) => {
      assertDownload(profileId, epoch);
      const written = await nativeInvoke<number>("write_webgate_download", { profileId, token, position, data: base64Chunk(bytes) });
      if (written !== position + bytes.byteLength) throw new Error("TRANSFER_CHUNK_RANGE_INVALID");
      position = written;
    },
    finish: async () => {
      assertDownload(profileId, epoch);
      await nativeInvoke<string>("finish_webgate_download", { profileId, token });
      assertDownload(profileId, epoch);
      if (file) window.dispatchEvent(new Event("webgate-local-downloads-changed"));
    },
    abort: async () => { await nativeInvoke("cancel_webgate_download", { profileId, token }); },
  };
}

async function saveRemoteDownload(blob: Blob, name: string, profileId: string, transferId: string,
  transfer: WebTransferView, expectedBinding?: string) {
  const epoch = downloadEpochs.get(profileId) ?? 0;
  if (!expectedBinding || expectedBinding !== remoteDownloadBindings.get(profileId)
    || transfer.id !== transferId || !transfer.messageId || transfer.profileId !== remoteProfileIds.get(profileId)) {
    throw new Error("TRANSFER_WORKSPACE_BOUNDARY");
  }
  const sha256 = await transferPayloadSha256(blob);
  assertDownload(profileId, epoch);
  if (transfer.sizeBytes !== blob.size || transfer.payloadSha256 !== sha256) throw new Error("TRANSFER_HASH_MISMATCH");
  const metadata = { sizeBytes: blob.size, sha256, messageId: transfer.messageId, transferId, expectedBinding };
  const existing = await nativeInvoke<string | null>("webgate_resolve_download", { profileId, ...metadata });
  assertDownload(profileId, epoch);
  if (existing) return;
  const key = JSON.stringify([profileId, expectedBinding, transferId, sha256]);
  const previous = savedDownloads.get(key);
  if (previous) return previous;
  const work = Promise.resolve().then(async () => {
    assertDownload(profileId, epoch);
    const writer = await nativeWriter(profileId, name, metadata);
    try {
      for (let position = 0; position < blob.size; position += 256 * 1024) {
        const bytes = new Uint8Array(await blob.slice(position, position + 256 * 1024).arrayBuffer());
        try { await writer.write(bytes); } finally { bytes.fill(0); }
      }
      await writer.finish();
    } catch (error) { await writer.abort().catch(() => {}); throw error; }
  });
  savedDownloads.set(key, work);
  try { await work; }
  finally { if (savedDownloads.get(key) === work) savedDownloads.delete(key); }
}

async function hasLocalRemoteDownload(profileId: string, transfer: WebTransferView, expectedBinding?: string) {
  const epoch = downloadEpochs.get(profileId) ?? 0;
  if (!expectedBinding || expectedBinding !== remoteDownloadBindings.get(profileId)) throw new Error("TRANSFER_WORKSPACE_BOUNDARY");
  if (!transfer.payloadCommitted || !transfer.payloadSha256) return false;
  const saved = await nativeInvoke<string | null>("webgate_resolve_download", { profileId,
    messageId: transfer.messageId, transferId: transfer.id, sizeBytes: transfer.sizeBytes,
    sha256: transfer.payloadSha256, expectedBinding });
  assertDownload(profileId, epoch);
  return saved !== null;
}

const remoteTransfers = createWebgateTransfers({
  persistentReplica: true,
  call: async (profileId, operation, args) => {
    await nativeEventsReady;
    return nativeInvoke("webgate_file_operation", { profileId, operation, args });
  },
  subscribe: subscribeTransfers,
  remoteProfileId: (id) => remoteProfileIds.get(id),
  download: saveRemoteDownload,
  downloadBinding: (id) => remoteDownloadBindings.get(id),
  hasLocalDownload: hasLocalRemoteDownload,
});

function clearRemoteProfile(id: string) {
  downloadEpochs.set(id, (downloadEpochs.get(id) ?? 0) + 1);
  remoteTransfers.clearProfile(id);
  remoteProfileIds.delete(id);
  remoteDownloadBindings.delete(id);
}

function acceptRemoteProfiles(view: ProfilesView) {
  const current = new Map<string, { upstream: string; binding: string }>();
  for (const profile of view.profiles) {
    if (!isWebgateProfileId(profile.id) || profile.loaded === false) continue;
    const metadata = profile as typeof profile & { toxId?: unknown; trace?: unknown };
    const upstream = profile.profileId ?? profile.metadata?.profileId;
    const root = Array.isArray(metadata.trace) ? metadata.trace[0] as Record<string, unknown> | undefined : undefined;
    const fields = [profile.id, upstream, metadata.toxId, root?.serverId, root?.workspaceId, root?.profileId];
    if (fields.some((field) => typeof field !== "string" || !field)) continue;
    current.set(profile.id, { upstream: String(upstream), binding: JSON.stringify(fields) });
  }
  for (const [id, upstream] of remoteProfileIds) {
    if (!current.has(id) || current.get(id)!.upstream !== upstream || current.get(id)!.binding !== remoteDownloadBindings.get(id)) clearRemoteProfile(id);
  }
  for (const [id, value] of current) {
    const added = !remoteProfileIds.has(id);
    remoteProfileIds.set(id, value.upstream);
    remoteDownloadBindings.set(id, value.binding);
    if (added) remoteTransfers.trackProfile(id);
  }
}

async function localRemoteCommand(command: string, args: Record<string, unknown>, profileId: string) {
  if (command === "export_tox_history") return exportWebgateHistory(profileId, args, invoke, (name) => nativeWriter(profileId, name));
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

const invoke = createWebgatePlatformRouter(nativeInvoke, {
  onProfiles: acceptRemoteProfiles,
  onProfileReplaced: clearRemoteProfile,
  localInvoke: (command, args, profileId) => ["set_native_file_drop_target", "read_webgate_file_grant"].includes(command)
    ? nativeInvoke(command, args) : ["download_web_transfer", "open_web_video", "export_tox_history"].includes(command)
    ? localRemoteCommand(command, args, profileId) : undefined,
});

let profileRefreshRunning = false;
let profileRefreshDirty = false;
function refreshRemoteProfiles() {
  profileRefreshDirty = true;
  if (profileRefreshRunning) return;
  profileRefreshRunning = true;
  void (async () => {
    try {
      while (profileRefreshDirty) { profileRefreshDirty = false; await invoke<ProfilesView>("webgate_profiles"); }
    } catch { /* Startup or the owning profile view reports the failure. */ }
    finally { profileRefreshRunning = false; if (profileRefreshDirty) refreshRemoteProfiles(); }
  })();
}
void listen("profiles-changed", refreshRemoteProfiles).catch(() => {});
window.addEventListener("beforeunload", () => { for (const id of [...remoteProfileIds.keys()]) clearRemoteProfile(id); });

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

export async function loadAttachmentMedia(request: AttachmentFileRequest, signal: AbortSignal): Promise<AttachmentMediaSource> {
  signal.throwIfAborted();
  const blob = request.path.startsWith("browser-stream://")
    ? await remoteTransfers.originalBlob(request.profileId, request.messageId, request.path.slice("browser-stream://".length), signal)
    : new Blob([await nativeInvoke<ArrayBuffer>("read_attachment_media", { ...request })], { type: chatMediaMime(request.name) });
  signal.throwIfAborted();
  const original = blob.slice(0, blob.size, chatMediaMime(request.name));
  const url = URL.createObjectURL(original);
  return { url, blob: original, release: () => URL.revokeObjectURL(url) };
}

export async function saveAttachmentCopy(request: AttachmentFileRequest, title: string, signal: AbortSignal, _language?: "ru" | "en"): Promise<FileCopyResult> {
  signal.throwIfAborted();
  if (!request.path.startsWith("browser-stream://")) {
    return await nativeInvoke<boolean>("save_attachment_copy", { ...request, title }) ? "saved" : "cancelled";
  }
  const args = { profileId: request.profileId, messageId: request.messageId,
    transferId: request.path.slice("browser-stream://".length), title };
  try {
    return await nativeInvoke<boolean>("webgate_save_download_copy", args) ? "saved" : "cancelled";
  } catch (error) {
    if (!String(error).includes("WEBGATE_LOCAL_DOWNLOAD_UNAVAILABLE")) throw error;
  }
  await remoteTransfers.downloadTransfer(request.profileId, request.messageId, args.transferId, request.friendNumber);
  signal.throwIfAborted();
  return await nativeInvoke<boolean>("webgate_save_download_copy", args) ? "saved" : "cancelled";
}

export async function openDialog(options: import("./types").OpenDialogOptions = {}, _signal?: AbortSignal) {
  // Native Rust owns the picker. Unlike the JavaScript dialog plugin, this
  // does not add the selected host path to WebView asset-protocol scope.
  return invoke<string | string[] | null>("open_native_dialog", { options });
}

export async function sendFile(
  profileId: string,
  friendNumber: number,
  file: File,
  expectedPublicKey: string,
  nativeGrantToken?: string | null,
) {
  if (isWebgateProfileId(profileId)) return remoteTransfers.sendFile(profileId, friendNumber, file, expectedPublicKey);
  if (nativeGrantToken) {
    return invoke("send_tox_file_from_grant", {
      profileId,
      friendNumber,
      grantToken: nativeGrantToken,
      expectedPublicKey,
    });
  }
  void profileId;
  void friendNumber;
  void file;
  throw new Error("NATIVE_FILE_GRANT_REQUIRED");
}

export function recoverIncomingTransfer(
  profileId: string,
  messageId: string,
  path: string,
  friendNumber?: number,
) {
  if (isWebgateProfileId(profileId) && path.startsWith("browser-stream://")) {
    return remoteTransfers.recoverIncomingTransfer(profileId, messageId, path.slice("browser-stream://".length), friendNumber);
  }
  return Promise.resolve(false);
}

export function setTransferPreviewChatActive(profileId: string, friendNumber: number, active: boolean) {
  if (isWebgateProfileId(profileId)) remoteTransfers.setPreviewChatActive(profileId, friendNumber, active);
}

export function setTransferPreviewPins(
  profileId: string,
  friendNumber: number,
  paths: Iterable<string>,
) { if (isWebgateProfileId(profileId)) remoteTransfers.setPreviewPins(profileId, friendNumber, paths); }

export function releaseTransferPreviews(
  profileId: string,
  friendNumber: number,
  force = false,
) {
  if (isWebgateProfileId(profileId)) return remoteTransfers.releasePreviews(profileId, friendNumber, force);
  return 0;
}

export function releaseProfileTransferPreviews(profileId: string) {
  if (isWebgateProfileId(profileId)) return remoteTransfers.releaseProfilePreviews(profileId);
  return 0;
}

export function transferPreviewSource(path: string, profileId: string, friendNumber: number) {
  if (isWebgateProfileId(profileId)) return remoteTransfers.preview(path, profileId, friendNumber);
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
