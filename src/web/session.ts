import type {
  ApiErrorBody,
  BuildIdentityResponse,
  CreateWorkspaceRequest,
  CreateWorkspaceResponse,
  DeviceChallenge,
  InitializerChallenge,
  SessionResponse,
  WebEvent,
  WorkspaceView,
  WorkspaceLinkPreparation,
} from "./contracts";
import { WEB_BUILD_HEADER, WEB_BUILD_ID } from "./buildIdentity";
import { canonicalWorkspaceUrl, clearNotificationLaunch, pendingNotificationEvent, pendingNotificationLaunch, rotateWorkspaceLaunch } from "./workspaceLaunch";
import { NOTIFICATION_OPEN_EVENT, parseChatNotificationTarget } from "../chatNotificationTarget";
import { chatMediaKind } from "../chatAttachmentMedia";
import { StreamingSha256 } from "./sha256-stream";
import {
  incomingBrowserCommitComplete,
  isRetiredContactTransferFailure,
  outgoingUploadRange,
  retryTransferOperation,
  TRANSFER_CHUNK_BYTES,
  transferFailureCode,
  transferPayloadSha256,
  verifyTransferPayload,
} from "./transferPump";
import { MAX_CHAT_FILE_BYTES } from "../fileReceiveSettings";
import { BackgroundTransferDiscovery, type BackgroundTransferSnapshot } from "./backgroundTransfers";
import { TransferPreviewRegistry, type TransferPreviewOwnerLease } from "./transferPreviewRegistry";

type DeviceRecord = {
  workspaceDigest: string;
  deviceId: string;
  privateKey: CryptoKey;
  publicKey: CryptoKey;
};

type EventHandler<T> = (event: { event: string; id: number; payload: T }) => void;

export type WorkspaceCreationProgress = {
  stage: "challenge" | "proof" | "creating";
  attempts?: number;
};

export type WebTransferView = {
  retainedForMirrors?: boolean;
  id: string;
  messageId: string;
  profileId: string;
  direction: "incoming" | "outgoing";
  name: string;
  mime: string;
  sizeBytes: number;
  transferredBytes: number;
  acknowledgedBytes: number;
  speedBytesPerSec: number;
  etaSeconds?: number | null;
  state: string;
  requestedPosition?: number | null;
  requestedLength?: number | null;
  bufferedBytes: number;
  retryAfterMs: number;
  operationId: string | null;
  uploadedBytes: number;
  persistedBytes: number;
  payloadCommitted: boolean;
  payloadSha256: string | null;
  downloadAvailable: boolean;
};

type IncomingTransferCompletion = WebTransferView | { completion: "pending"; retryAfterMs: number };

type TransferCopyIntent = "automatic" | "preview" | "download" | "open-video" | "read-copy";
type SessionRequestLease = { generation: number };
type SessionTeardown = {
  outcome: Promise<"active" | "closed">;
  finish: (outcome: "active" | "closed") => void;
  realtimeWasActive: boolean;
};

const DATABASE_NAME = "kaigen-browser-auth-v1";
const STORE_NAME = "device-keys";
const DEVICE_RECORD_PREFIX = "workspace:";
const WORKSPACE_HEADER = "X-Kaigen-Workspace";
const WORKSPACE_PROTOCOL_PREFIX = "kaigen.workspace.";
const WORKSPACE_HASH_DOMAIN = "kaigen-workspace-identifier-v1";
const BROWSER_STREAM_PREFIX = "browser-stream://";
const TRANSFER_CACHE_DIRECTORY = ".kaigen-transfer-cache";
const TRANSFER_CACHE_WORKER_PATH = "/transfer-cache-worker.js";
type TransferWorkerPolicy = { createScriptURL: (value: string) => unknown };
let transferWorkerPolicy: TransferWorkerPolicy | undefined;
const IMAGE_PREVIEW_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);
const PERSISTENCE_COMMANDS = new Set(["save_layout_state", "save_local_state"]);
const textEncoder = new TextEncoder();

function transferCacheWorkerScriptUrl() {
  const url = new URL(TRANSFER_CACHE_WORKER_PATH, location.origin).href;
  const factory = (globalThis as typeof globalThis & { trustedTypes?: {
    createPolicy: (name: string, rules: { createScriptURL: (value: string) => string }) => TransferWorkerPolicy;
  } }).trustedTypes;
  if (!factory) return url;
  transferWorkerPolicy ??= factory.createPolicy("kaigen-transfer-cache-worker", {
    createScriptURL: (value) => {
      if (value !== url) throw new TypeError("Unexpected transfer cache worker URL");
      return url;
    },
  });
  return transferWorkerPolicy.createScriptURL(url) as string;
}

function isPreviewableImage(name: string) {
  return IMAGE_PREVIEW_EXTENSIONS.has(name.split(".").pop()?.toLowerCase() ?? "");
}

function keepsOutgoingTransferSource(name: string) {
  return isPreviewableImage(name) || chatMediaKind(name) !== undefined;
}

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

function base64UrlToBytes(value: string) {
  const padded = value.replace(/-/gu, "+").replace(/_/gu, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function sha256(value: string | Uint8Array) {
  const bytes = Uint8Array.from(typeof value === "string" ? textEncoder.encode(value) : value);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

function leadingZeroBits(bytes: Uint8Array) {
  let bits = 0;
  for (const byte of bytes) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    bits += Math.clz32(byte) - 24;
    break;
  }
  return bits;
}

function openDeviceDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("BROWSER_STORAGE_UNAVAILABLE"));
  });
}

async function readDeviceRecord(workspaceDigest: string): Promise<DeviceRecord | null> {
  const database = await openDeviceDatabase();
  try {
    return await new Promise<DeviceRecord | null>((resolve, reject) => {
      const request = database.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME)
        .get(DEVICE_RECORD_PREFIX + workspaceDigest);
      request.onsuccess = () => {
        const record = request.result as DeviceRecord | undefined;
        resolve(record?.workspaceDigest === workspaceDigest ? record : null);
      };
      request.onerror = () => reject(request.error ?? new Error("BROWSER_STORAGE_READ_FAILED"));
    });
  } finally {
    database.close();
  }
}

async function writeDeviceRecord(record: DeviceRecord, assertCurrent?: () => void, signal?: AbortSignal) {
  const database = await openDeviceDatabase();
  try {
    assertCurrent?.();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      const abort = () => { try { transaction.abort(); } catch { /* Already committed/aborted. */ } };
      const cleanup = () => signal?.removeEventListener("abort", abort);
      transaction.oncomplete = () => { cleanup(); try { assertCurrent?.(); resolve(); } catch (error) { reject(error); } };
      transaction.onabort = () => { cleanup(); reject(signal?.reason ?? transaction.error ?? new Error("BROWSER_STORAGE_WRITE_FAILED")); };
      transaction.onerror = () => { cleanup(); reject(transaction.error ?? new Error("BROWSER_STORAGE_WRITE_FAILED")); };
      if (signal?.aborted) { abort(); reject(signal.reason); return; }
      signal?.addEventListener("abort", abort, { once: true });
      try { transaction.objectStore(STORE_NAME).put(record, DEVICE_RECORD_PREFIX + record.workspaceDigest); }
      catch (error) { cleanup(); abort(); reject(error); }
    });
  } finally {
    database.close();
  }
}

async function deleteDeviceRecord(workspaceDigest: string) {
  const database = await openDeviceDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error ?? new Error("BROWSER_STORAGE_DELETE_FAILED"));
      transaction.objectStore(STORE_NAME).delete(DEVICE_RECORD_PREFIX + workspaceDigest);
    });
  } finally {
    database.close();
  }
}

async function createDeviceKeys() {
  return crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
}

async function exportPublicKey(publicKey: CryptoKey) {
  return bytesToBase64Url(new Uint8Array(await crypto.subtle.exportKey("spki", publicKey)));
}

function normalizedJson(value: unknown): unknown {
  if (value instanceof Uint8Array) return Array.from(value);
  if (value instanceof ArrayBuffer) return Array.from(new Uint8Array(value));
  if (Array.isArray(value)) return value.map(normalizedJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizedJson(item)]));
  }
  return value;
}

class WebSession {
  private identifier = "";
  private csrfToken = "";
  private workspace: WorkspaceView | null = null;
  private socket: WebSocket | null = null;
  private heartbeatTimer = 0;
  private verificationTimer = 0;
  private transferDiscoveryTimer = 0;
  private reconnectTimer = 0;
  private realtimeActive = false;
  private eventSequence = 0;
  private sessionRefresh: Promise<WorkspaceView | null> | null = null;
  private sessionRefreshController: AbortController | null = null;
  private readonly listeners = new Map<string, Set<EventHandler<unknown>>>();
  private readonly workspaceListeners = new Set<(workspace: WorkspaceView) => void>();
  private readonly upgradeRequiredListeners = new Set<() => void>();
  private readonly sessionUnavailableListeners = new Set<(reload: boolean) => void>();
  private sessionUnavailable = false;
  private passwordReloadReady = false;
  private currentWorkspaceDigest = "";
  private authenticatedWorkspaceSelector = "";
  private workspaceControlBusy = false;
  private linkRotationActive = false;
  private pendingLinkRotation: (WorkspaceLinkPreparation & {
    previousIdentifier: string;
    previousDigest: string;
  }) | null = null;
  private authenticationRevision = 0;
  private readonly transferPumps = new Map<string, Promise<void>>();
  private readonly transferDownloads = new Map<string, Promise<void>>();
  private transferGeneration = 0;
  private readonly consumedTransfers = new Map<string, { binding: string; state: "memory" | "pending" | "durable" }>();
  private readonly transferPreviews = new TransferPreviewRegistry({
    onInvalidate: ({ profileId, friendNumber, transferId }) => {
      window.dispatchEvent(new CustomEvent("kaigen:transfer-preview-invalidated", {
        detail: { profileId, friendNumber, transferId },
      }));
    },
  });
  private readonly pendingPersistenceCommands = new Set<Promise<unknown>>();
  private readonly pendingSessionRequests = new Set<Promise<void>>();
  private sessionRequestGeneration = 0;
  private workspaceOpeningGeneration = 0;
  private workspaceCreationPending = false;
  private sessionTeardown: SessionTeardown | null = null;
  private upgradeRequired = false;
  private sessionLifecycle: "active" | "tearing-down" | "closed" = "active";
  private readonly backgroundTransfers = new BackgroundTransferDiscovery({
    load: () => this.command<BackgroundTransferSnapshot>("get_background_transfer_work"),
    running: () => new Set(this.transferPumps.keys()),
    needed: async (work) => {
      if (work.direction === "outgoing") return true;
      const transfer = { id: work.transferId, profileId: work.profileId, messageId: work.messageId,
        sizeBytes: work.size, payloadSha256: work.payloadSha256 };
      // A durable local copy may still need its server acknowledgement after a
      // lost reply or reload. Memory-only downloads leave the server copy intact.
      return !await this.transferWasConsumed(transfer) || this.consumedTransfers.get(transfer.id)?.state !== "memory";
    },
    recover: (work) => this.recoverIncomingTransfer(work.profileId, work.messageId, work.transferId, work.friendNumber, "automatic"),
    report: (work, error) => this.reportTransferPumpError(work.messageId, error),
    now: () => Date.now(),
  });

  setIdentifier(identifier: string) {
    const next = identifier.trim();
    if (this.identifier !== next) {
      this.workspace = null;
      this.currentWorkspaceDigest = "";
      this.authenticatedWorkspaceSelector = "";
      this.pendingLinkRotation = null;
      this.transferGeneration += 1;
      this.sessionRequestGeneration += 1;
      this.cancelSessionRefresh();
      this.stopRealtime();
    }
    this.identifier = next;
  }

  getIdentifier() {
    return this.identifier;
  }

  getWorkspace() {
    return this.workspace;
  }

  transferPreviewSource(profileId: string, friendNumber: number, path: string) {
    if (!path.startsWith(BROWSER_STREAM_PREFIX)) return "";
    return this.transferPreviews.source(profileId, friendNumber, path.slice(BROWSER_STREAM_PREFIX.length));
  }

  setTransferPreviewChatActive(profileId: string, friendNumber: number, active: boolean) {
    this.transferPreviews.setOwnerActive(profileId, friendNumber, active);
  }

  setTransferPreviewPins(profileId: string, friendNumber: number, paths: Iterable<string>) {
    this.transferPreviews.setPins(profileId, friendNumber, [...paths].flatMap((path) => (
      path.startsWith(BROWSER_STREAM_PREFIX) ? [path.slice(BROWSER_STREAM_PREFIX.length)] : []
    )));
  }

  releaseTransferPreviews(profileId: string, friendNumber: number, force = false) {
    return this.transferPreviews.releaseOwner(profileId, friendNumber, force);
  }

  releaseProfileTransferPreviews(profileId: string) {
    return this.transferPreviews.releaseProfile(profileId);
  }

  private rememberTransferPreview(transferId: string, blob: Blob, owner: TransferPreviewOwnerLease) {
    const url = this.transferPreviews.remember(transferId, blob, owner);
    if (!url) return false;
    window.dispatchEvent(new CustomEvent("kaigen:transfer-preview-ready", {
      detail: { transferId },
    }));
    return true;
  }

  private clearTransferPreviews() {
    this.transferPreviews.clear();
  }

  private transferIsActive() {
    return this.sessionLifecycle === "active" && !this.upgradeRequired;
  }

  private assertTransferActive(generation: number) {
    if (generation !== this.transferGeneration || !this.transferIsActive()) throw new Error("TRANSFER_PUMP_STOPPED");
  }

  private retryTransfer<T>(operation: () => Promise<T>, generation = this.transferGeneration) {
    return retryTransferOperation(operation, {
      active: () => generation === this.transferGeneration && this.transferIsActive(),
    });
  }

  private async transferCacheDirectory(create: boolean) {
    if (!navigator.storage?.getDirectory) throw new Error("TRANSFER_BROWSER_STORAGE_REQUIRED");
    let root: FileSystemDirectoryHandle;
    try { root = await navigator.storage.getDirectory(); }
    catch (cause) {
      const error = new Error("TRANSFER_BROWSER_STORAGE_REQUIRED");
      Object.defineProperty(error, "cause", { value: cause, configurable: true });
      throw error;
    }
    const cache = await root.getDirectoryHandle(TRANSFER_CACHE_DIRECTORY, { create });
    return cache.getDirectoryHandle(this.authenticatedWorkspaceSelector || await this.workspaceDigest(), { create });
  }

  private transferCacheName(transferId: string) {
    if (!/^[A-Za-z0-9_-]{32}$/u.test(transferId)) throw new Error("TRANSFER_ID_INVALID");
    return `${transferId}.payload`;
  }

  private async writeTransferCache(transferId: string, blob: Blob, mime: string) {
    const directory = await this.transferCacheDirectory(true);
    const name = this.transferCacheName(transferId);
    const handle = await directory.getFileHandle(name, { create: true });
    let writable: FileSystemWritableFileStream | undefined;
    try {
      if (typeof handle.createWritable === "function") {
        writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
      } else {
        await this.writeTransferCacheInWorker(directory.name, name, blob);
      }
      const stored = await handle.getFile();
      if (stored.size !== blob.size) throw new Error("TRANSFER_SIZE_MISMATCH");
      return {
        source: stored.slice(0, stored.size, mime || blob.type || "application/octet-stream"),
        discard: () => directory.removeEntry(name),
      };
    } catch (error) {
      await writable?.abort().catch(() => {});
      await directory.removeEntry(name).catch(() => {});
      throw error;
    }
  }

  private async writeTransferCacheInWorker(workspace: string, name: string, blob: Blob) {
    let worker: Worker | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      worker = new Worker(transferCacheWorkerScriptUrl());
      const writer = worker;
      await new Promise<void>((resolve, reject) => {
        const fail = () => reject(new Error("TRANSFER_BROWSER_STORAGE_REQUIRED"));
        deadline = setTimeout(fail, 60_000);
        writer.onmessage = (event) => { if (event.data === true) resolve(); else fail(); };
        writer.onerror = fail;
        writer.onmessageerror = fail;
        // Safari supports OPFS in workers but cannot reliably clone its file handles.
        writer.postMessage({ workspace, name, blob, chunkBytes: TRANSFER_CHUNK_BYTES });
      });
    } catch (cause) {
      const error = new Error("TRANSFER_BROWSER_STORAGE_REQUIRED");
      Object.defineProperty(error, "cause", { value: cause, configurable: true });
      throw error;
    } finally {
      clearTimeout(deadline);
      worker?.terminate();
    }
  }

  private async readTransferCache(transfer: WebTransferView) {
    try {
      const directory = await this.transferCacheDirectory(false);
      const handle = await directory.getFileHandle(this.transferCacheName(this.transferSourceId(transfer)));
      const stored = await handle.getFile();
      if (stored.size !== transfer.sizeBytes) return null;
      // A same-size stale or damaged OPFS file is not a verified source.
      if (transfer.payloadSha256) await verifyTransferPayload(stored, transfer.sizeBytes, transfer.payloadSha256);
      return stored.slice(0, stored.size, transfer.mime || "application/octet-stream");
    } catch {
      return null;
    }
  }

  private async removeTransferCache(transferId: string) {
    const directory = await this.transferCacheDirectory(false);
    await directory.removeEntry(this.transferCacheName(transferId));
  }

  private transferSourceId(transfer: WebTransferView) {
    return transfer.direction === "outgoing" ? transfer.operationId ?? transfer.id : transfer.id;
  }

  private transferConsumedBinding(transfer: Pick<WebTransferView, "id" | "profileId" | "messageId" | "sizeBytes" | "payloadSha256">) {
    if (!transfer.payloadSha256) return "";
    return JSON.stringify([transfer.profileId, transfer.messageId, transfer.id, transfer.sizeBytes, transfer.payloadSha256]);
  }

  private async transferWasConsumed(transfer: Pick<WebTransferView, "id" | "profileId" | "messageId" | "sizeBytes" | "payloadSha256">, durableOnly = false) {
    const binding = this.transferConsumedBinding(transfer);
    if (!binding) return false;
    const remembered = this.consumedTransfers.get(transfer.id);
    if (remembered?.binding === binding) return !durableOnly || remembered.state === "durable";
    try {
      const directory = await this.transferCacheDirectory(false);
      const handle = await directory.getFileHandle(`${this.transferCacheName(transfer.id)}.consumed`);
      if (await (await handle.getFile()).text() !== binding) return false;
      this.consumedTransfers.set(transfer.id, { binding, state: "durable" });
      return true;
    } catch { return false; }
  }

  private async markTransferConsumed(transfer: WebTransferView, generation: number, durable: boolean) {
    this.assertTransferActive(generation);
    const binding = this.transferConsumedBinding(transfer);
    if (!binding) throw new Error("TRANSFER_HASH_MISMATCH");
    // Remember the verified copy before disk awaits so a receipt retry can
    // reuse it without fetching the file again.
    this.consumedTransfers.set(transfer.id, { binding, state: durable ? "pending" : "memory" });
    if (!durable) return;
    const directory = await this.transferCacheDirectory(true);
    this.assertTransferActive(generation);
    const handle = await directory.getFileHandle(`${this.transferCacheName(transfer.id)}.consumed`, { create: true });
    this.assertTransferActive(generation);
    const writable = await handle.createWritable();
    try {
      this.assertTransferActive(generation);
      await writable.write(binding);
      this.assertTransferActive(generation);
      await writable.close();
      this.assertTransferActive(generation);
      this.consumedTransfers.set(transfer.id, { binding, state: "durable" });
    } catch (error) {
      await writable.abort().catch(() => {});
      throw error;
    }
  }

  private async clearWorkspaceTransferCache(workspaceDigest: string) {
    this.consumedTransfers.clear();
    if (!navigator.storage?.getDirectory) return;
    const root = await navigator.storage.getDirectory();
    const cache = await root.getDirectoryHandle(TRANSFER_CACHE_DIRECTORY);
    await cache.removeEntry(this.authenticatedWorkspaceSelector || workspaceDigest, { recursive: true });
  }

  private reportTransferPumpError(messageId: string, error: unknown) {
    if (["TRANSFER_CANCELLED", "TRANSFER_PUMP_STOPPED", "SESSION_NOT_ACTIVE", "UI_LEASE_TRANSFERRED"].includes(transferFailureCode(error))) return;
    window.dispatchEvent(new CustomEvent("kaigen:transfer-pump-error", {
      detail: { messageId, code: transferFailureCode(error) },
    }));
  }

  // A notification preference is data, never authority. Expose only a hashed
  // workspace namespace and an exact-session predicate, not device keys/CSRF.
  captureNotificationSession() {
    if (this.sessionLifecycle !== "active" || !this.workspace || !this.csrfToken || !this.authenticatedWorkspaceSelector) return null;
    const generation = this.sessionRequestGeneration;
    const selector = this.authenticatedWorkspaceSelector;
    return {
      // CSRF/device-token rotation keeps this authenticated workspace alive.
      // Login, teardown and workspace changes still retire its generation or
      // selector; they must cancel consent and notification routing immediately.
      epoch: generation + ":" + selector,
      namespace: sha256("kaigen-notification-intent/v1\0" + selector).then(bytesToBase64Url),
      isCurrent: () => this.sessionLifecycle === "active" && !!this.workspace && !!this.csrfToken
        && this.sessionRequestGeneration === generation
        && this.authenticatedWorkspaceSelector === selector,
    };
  }

  onWorkspace(handler: (workspace: WorkspaceView) => void) {
    this.workspaceListeners.add(handler);
    if (this.workspace) handler(this.workspace);
    return () => {
      this.workspaceListeners.delete(handler);
    };
  }

  onUpgradeRequired(handler: () => void) {
    this.upgradeRequiredListeners.add(handler);
    if (this.upgradeRequired) handler();
    return () => {
      this.upgradeRequiredListeners.delete(handler);
    };
  }

  onSessionUnavailable(handler: (reload: boolean) => void) {
    this.sessionUnavailableListeners.add(handler);
    if (this.sessionUnavailable) handler(this.passwordReloadReady);
    return () => {
      this.sessionUnavailableListeners.delete(handler);
    };
  }

  private suspendSession(lease: SessionRequestLease): never {
    this.assertSessionRequest(lease);
    const transition = this.sessionTeardown;
    this.sessionLifecycle = "closed";
    this.sessionRequestGeneration += 1;
    this.transferGeneration += 1;
    this.sessionUnavailable = true;
    this.passwordReloadReady = this.persistPasswordRequirement(true);
    this.csrfToken = "";
    this.workspace = null;
    this.cancelSessionRefresh();
    this.sessionTeardown = null;
    this.stopRealtime();
    // Consumers must leave the old session before its rejected requests settle.
    // This suspends only the local view; server state and saved device keys stay intact.
    try {
      for (const handler of this.sessionUnavailableListeners) handler(this.passwordReloadReady);
    } finally {
      transition?.finish("closed");
    }
    throw new Error("SESSION_NOT_ACTIVE");
  }

  private persistPasswordRequirement(required: boolean) {
    const digest = this.currentWorkspaceDigest;
    if (!digest) return false;
    let persisted = false;
    try {
      const key = `kaigen.web.password-required:${digest}`;
      if (required) sessionStorage.setItem(key, "1");
      else sessionStorage.removeItem(key);
      persisted = true;
    } catch { /* Keep the password gate usable when browser storage is unavailable. */ }
    try {
      if (required && !persisted) {
        history.replaceState({ ...history.state, kaigenWebPasswordRequired: digest }, "");
        persisted = true;
      } else if (!required && history.state?.kaigenWebPasswordRequired === digest) {
        const state = { ...history.state };
        delete state.kaigenWebPasswordRequired;
        history.replaceState(state, "");
      }
    } catch { /* Without a durable flag, stay at the local password gate. */ }
    return persisted;
  }

  async requiresPassword() {
    const digest = await this.workspaceDigest();
    if (this.sessionUnavailable) return true;
    try {
      if (sessionStorage.getItem(`kaigen.web.password-required:${digest}`) === "1") return true;
    } catch { /* The current history entry is the fallback for blocked storage. */ }
    return history.state?.kaigenWebPasswordRequired === digest;
  }

  private requireUpgrade() {
    if (this.upgradeRequired) return;
    this.upgradeRequired = true;
    this.stopRealtime();
    for (const handler of this.upgradeRequiredListeners) handler();
  }

  private setWorkspace(workspace: WorkspaceView) {
    // A delayed heartbeat or session refresh must not undo a confirmed toggle.
    if (this.workspace && (workspace.retentionSettingsRevision ?? 0)
      < (this.workspace.retentionSettingsRevision ?? 0)) return;
    this.workspace = workspace;
    for (const handler of this.workspaceListeners) handler(workspace);
  }

  private async sessionRequest<T>(operation: (lease: SessionRequestLease) => Promise<T>): Promise<T> {
    const transition = this.sessionTeardown;
    if (transition && await transition.outcome === "closed") throw new Error("SESSION_NOT_ACTIVE");
    if (this.sessionLifecycle !== "active") throw new Error("SESSION_NOT_ACTIVE");
    const lease = { generation: this.sessionRequestGeneration };
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    // Admission is recorded before operation can await headers or dispatch fetch.
    this.pendingSessionRequests.add(pending);
    try {
      const result = await operation(lease);
      this.assertSessionRequest(lease);
      return result;
    } finally {
      this.pendingSessionRequests.delete(pending);
      finish();
    }
  }

  private assertSessionRequest(lease: SessionRequestLease) {
    // Admitted work may finish while teardown drains it, before auth is revoked.
    if (this.sessionLifecycle === "closed" || lease.generation !== this.sessionRequestGeneration) {
      throw new Error("SESSION_NOT_ACTIVE");
    }
  }

  private beginSessionTeardown() {
    if (this.sessionLifecycle !== "active" || this.sessionTeardown) throw new Error("SESSION_NOT_ACTIVE");
    let finish!: SessionTeardown["finish"];
    const transition: SessionTeardown = {
      outcome: new Promise((resolve) => { finish = resolve; }),
      finish: (outcome) => finish(outcome),
      realtimeWasActive: this.realtimeActive,
    };
    this.sessionTeardown = transition;
    this.sessionLifecycle = "tearing-down";
    this.transferGeneration += 1;
    this.stopRealtime();
    return transition;
  }

  private async drainSessionRequests() {
    const pending = [...this.pendingSessionRequests, ...this.pendingPersistenceCommands,
      ...(this.sessionRefresh ? [this.sessionRefresh] : [])];
    if (!pending.length) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled(pending),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("SESSION_DRAIN_TIMEOUT")), 30_000);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private rollbackSessionTeardown(transition: SessionTeardown) {
    if (this.sessionTeardown !== transition || this.sessionLifecycle !== "tearing-down") return;
    this.sessionLifecycle = "active";
    if (this.sessionTeardown === transition) this.sessionTeardown = null;
    transition.finish("active");
    if (transition.realtimeWasActive) this.startRealtime();
  }

  private finishSessionTeardown(transition: SessionTeardown) {
    this.sessionRequestGeneration += 1;
    // This is the last operation of each public teardown method. Its awaiting
    // WebRoot continuation synchronously unmounts consumers before this task.
    setTimeout(() => {
      if (this.sessionTeardown === transition) this.sessionTeardown = null;
      transition.finish("closed");
    }, 0);
  }

  private async fetchResponse(path: string, init: RequestInit = {}, authenticated = false,
    lease?: SessionRequestLease | "teardown"): Promise<Response> {
    if (authenticated && lease === undefined) {
      return this.sessionRequest((admitted) => this.fetchResponse(path, init, true, admitted));
    }
    if (this.upgradeRequired) throw new Error("UPGRADE_REQUIRED");
    const deviceRefresh = this.workspace !== null
      && (path === "/api/v1/auth/device-challenge" || path === "/api/v1/auth/device");
    const requestLease = lease === "teardown" || deviceRefresh
      ? { generation: this.sessionRequestGeneration } : lease;
    const transition = lease === "teardown" ? this.sessionTeardown : null;
    const assertCurrent = () => {
      init.signal?.throwIfAborted();
      if (requestLease) this.assertSessionRequest(requestLease);
      if (lease === "teardown" && (!transition || transition !== this.sessionTeardown
        || this.sessionLifecycle !== "tearing-down")) throw new Error("SESSION_NOT_ACTIVE");
    };
    let sentRevision = this.authenticationRevision;
    const send = async () => {
      assertCurrent();
      sentRevision = this.authenticationRevision;
      const headers = authenticated ? await this.authenticatedHeaders(init.headers) : new Headers(init.headers);
      assertCurrent();
      headers.set(WEB_BUILD_HEADER, WEB_BUILD_ID);
      if (init.body && !headers.has("Content-Type") && typeof init.body === "string") headers.set("Content-Type", "application/json");
      return fetch(path, { ...init, headers, credentials: "same-origin", cache: "no-store", referrerPolicy: "no-referrer" });
    };
    let response = await send();
    assertCurrent();
    const authenticationError = async () => {
      if (!requestLease || (response.status !== 400 && response.status !== 401)) return null;
      const error = await response.clone().json().catch(() => null) as ApiErrorBody | null;
      if (response.status === 400) return error?.code === "PASSWORD_REAUTH_REQUIRED" ? error.code : null;
      return error?.code === "AUTH_INVALID" || error?.code === "DEVICE_AUTH_INVALID"
        || error?.code === "PASSWORD_REAUTH_REQUIRED" || error?.code === "CSRF_INVALID" ? error.code : null;
    };
    const code = await authenticationError();
    assertCurrent();
    if (code && code !== "CSRF_INVALID" && requestLease) this.suspendSession(requestLease);
    if (code === "CSRF_INVALID" && lease && lease !== "teardown" && !this.linkRotationActive) {
      if (this.sessionLifecycle !== "active" || this.sessionTeardown) throw new Error("SESSION_NOT_ACTIVE");
      // CSRF rotation is recoverable; an expired authorization always needs a password.
      if (sentRevision === this.authenticationRevision) await this.restoreDeviceSession().catch(() => null);
      assertCurrent();
      if (this.upgradeRequired) throw new Error("UPGRADE_REQUIRED");
      if (this.sessionLifecycle !== "active" || this.sessionTeardown) throw new Error("SESSION_NOT_ACTIVE");
      if (sentRevision !== this.authenticationRevision) {
        response = await send();
        const retryCode = await authenticationError();
        assertCurrent();
        if (retryCode && retryCode !== "CSRF_INVALID") this.suspendSession(lease);
      }
    }
    assertCurrent();
    if (response.status === 426) {
      this.requireUpgrade();
      throw new Error("UPGRADE_REQUIRED");
    }
    return response;
  }

  private request<T>(path: string, init: RequestInit, authenticated: boolean, admission: boolean | SessionRequestLease, withStatus: true): Promise<{ status: number; body: T }>;
  private request<T>(path: string, init?: RequestInit, authenticated?: boolean, admission?: boolean | SessionRequestLease): Promise<T>;
  private async request<T>(path: string, init: RequestInit = {}, authenticated = false, admission: boolean | SessionRequestLease = false, withStatus = false): Promise<T | { status: number; body: T }> {
    const teardown = admission === true;
    const generation = this.sessionRequestGeneration;
    const transition = teardown ? this.sessionTeardown : null;
    const receive = async (lease?: SessionRequestLease | "teardown") => {
      init.signal?.throwIfAborted();
      const response = await this.fetchResponse(path, init, authenticated, lease);
      const contentType = response.headers.get("content-type") ?? "";
      const body = contentType.includes("application/json") ? await response.json() as unknown : await response.text();
      init.signal?.throwIfAborted();
      if (teardown && (generation !== this.sessionRequestGeneration || transition !== this.sessionTeardown
        || this.sessionLifecycle !== "tearing-down")) throw new Error("SESSION_NOT_ACTIVE");
      if (!response.ok) {
        const error = body && typeof body === "object" ? body as ApiErrorBody : {};
        if (response.status === 426 || error.code === "UPGRADE_REQUIRED") this.requireUpgrade();
        throw new Error(response.status === 426 ? "UPGRADE_REQUIRED" : error.code ?? error.message ?? `HTTP_${response.status}`);
      }
      return withStatus ? { status: response.status, body: body as T } : body as T;
    };
    if (typeof admission === "object") return receive(admission);
    if (authenticated && !teardown) return this.sessionRequest(receive);
    return receive(teardown ? "teardown" : undefined);
  }

  async verifyBuildIdentity() {
    const identity = await this.request<BuildIdentityResponse>("/api/v1/build-identity", { method: "GET" });
    if (identity.status !== "ok" || identity.buildId !== WEB_BUILD_ID) {
      this.requireUpgrade();
      throw new Error("UPGRADE_REQUIRED");
    }
    return identity;
  }

  async initializerChallenge() {
    const controller = new AbortController();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.request<InitializerChallenge>("/api/v1/initializer/challenge", { method: "POST", signal: controller.signal }),
        new Promise<never>((_, reject) => {
          deadline = setTimeout(() => {
            const error = new Error("INITIALIZER_CHALLENGE_TIMEOUT");
            reject(error);
            controller.abort(error);
          }, 30_000);
        }),
      ]);
    } finally {
      clearTimeout(deadline);
    }
  }

  async solveChallenge(challenge: InitializerChallenge, onProgress?: (attempts: number) => void) {
    const prefix = textEncoder.encode(`${challenge.salt}:`);
    for (let nonce = 0; nonce <= 0xffff_ffff; nonce += 1) {
      const suffix = textEncoder.encode(String(nonce));
      const bytes = new Uint8Array(prefix.length + suffix.length);
      bytes.set(prefix);
      bytes.set(suffix, prefix.length);
      if (leadingZeroBits(await sha256(bytes)) >= challenge.difficulty) return { challengeId: challenge.challengeId, nonce };
      // SubtleCrypto already yields between digests. Chained timers can stall hidden windows.
      if (nonce % 128 === 0) onProgress?.(nonce + 1);
    }
    throw new Error("PROOF_NOT_SOLVED");
  }

  async createWorkspace(request: Omit<CreateWorkspaceRequest, "proof">, onProgress?: (progress: WorkspaceCreationProgress) => void, isCurrent: () => boolean = () => true) {
    const generation = this.workspaceOpeningGeneration;
    const assertCurrent = () => {
      if (generation !== this.workspaceOpeningGeneration || !isCurrent()) throw new Error("SESSION_NOT_ACTIVE");
    };
    const progress = (value: WorkspaceCreationProgress) => { assertCurrent(); onProgress?.(value); };
    progress({ stage: "challenge" });
    const challenge = await this.initializerChallenge();
    progress({ stage: "proof", attempts: 0 });
    const proof = await this.solveChallenge(challenge, (attempts) => progress({ stage: "proof", attempts }));
    progress({ stage: "creating" });
    this.workspaceCreationPending = true;
    try {
      const response = await this.request<CreateWorkspaceResponse>("/api/v1/workspaces", {
        method: "POST",
        body: JSON.stringify({ ...request, proof }),
      });
      // Once allocation was submitted, navigation waits until WebRoot records
      // the confirmed link. Discarding this response would orphan the workspace.
      this.setIdentifier(response.identifier);
      this.setWorkspace(response.workspace);
      return response;
    } catch (error) {
      this.workspaceCreationPending = false;
      throw error;
    }
  }

  async lookupWorkspace() {
    if (!this.identifier) throw new Error("WORKSPACE_IDENTIFIER_MISSING");
    return this.request<{ exists: boolean; provisional: boolean; pendingAccessLink?: boolean }>("/api/v1/workspaces/lookup", {
      method: "POST",
      body: JSON.stringify({ identifier: this.identifier }),
    });
  }

  private async workspaceDigest() {
    const generation = this.sessionRequestGeneration;
    const digest = bytesToBase64Url(await sha256(`${WORKSPACE_HASH_DOMAIN}${this.identifier}`));
    if (generation === this.sessionRequestGeneration) this.currentWorkspaceDigest = digest;
    return digest;
  }

  private async authenticatedHeaders(initial?: HeadersInit) {
    const headers = new Headers(initial);
    headers.set(WORKSPACE_HEADER, this.authenticatedWorkspaceSelector || await this.workspaceDigest());
    if (this.csrfToken) headers.set("X-Kaigen-CSRF", this.csrfToken);
    return headers;
  }

  private async acceptSession(response: SessionResponse, keys: CryptoKeyPair, lease: SessionRequestLease, refreshing = false, refresh?: { signal: AbortSignal; assertCurrent: () => void }, notification?: { routingHint: string; eventToken: string }, assertOpening?: () => void) {
    const assertCurrent = () => {
      assertOpening?.();
      refresh?.assertCurrent();
      if (lease.generation !== this.sessionRequestGeneration
        || (refreshing ? this.sessionLifecycle === "closed" : this.sessionTeardown !== null)) {
        throw new Error("SESSION_NOT_ACTIVE");
      }
    };
    assertCurrent();
    if (refreshing) {
      // The browser already accepted Set-Cookie. A draining teardown needs its
      // matching CSRF token, but must not reopen the workspace or realtime.
      this.csrfToken = response.csrfToken;
      this.authenticationRevision += 1;
      if (this.sessionLifecycle !== "active") return response.workspace;
    }
    const workspaceDigest = await this.workspaceDigest();
    assertCurrent();
    this.authenticatedWorkspaceSelector = response.workspaceSelector || workspaceDigest;
    await writeDeviceRecord({
      workspaceDigest,
      deviceId: response.deviceId,
      privateKey: keys.privateKey,
      publicKey: keys.publicKey,
    }, assertCurrent, refresh?.signal);
    assertCurrent();
    if (refreshing && this.sessionLifecycle !== "active") return response.workspace;
    if (!refreshing) {
      this.sessionLifecycle = "active";
      this.csrfToken = response.csrfToken;
      this.authenticationRevision += 1;
      this.persistPasswordRequirement(false);
    }
    this.sessionUnavailable = false;
    this.passwordReloadReady = false;
    if (response.accessLinkPending) {
      if (this.sessionLifecycle !== "active" || this.sessionTeardown) throw new Error("SESSION_NOT_ACTIVE");
      const wasRotating = this.linkRotationActive;
      this.linkRotationActive = true;
      try {
        await this.request("/api/v1/workspaces/access-link/activate", {
          method: "POST",
          signal: refresh?.signal,
          body: JSON.stringify({ identifier: this.identifier, expectedRevision: response.accessLinkRevision }),
        }, true, lease);
        assertCurrent();
      } finally {
        this.linkRotationActive = wasRotating;
      }
    }
    if (response.previousAccessHash) {
      const remembered = await rotateWorkspaceLaunch(response.previousAccessHash, this.identifier, assertCurrent);
      assertCurrent();
      if (!remembered) throw new Error("WORKSPACE_LINK_RECOVERY_REQUIRED");
    }
    // Consume only the exact launch submitted by this password request. Queue
    // before workspace listeners resume, so they cannot resolve its old-device
    // event again after enrollment has rotated the device.
    let notificationQueued = false;
    const handoff = !refreshing ? response.notificationHandoff : null;
    if (notification && handoff
      && handoff.routingHint === notification.routingHint && handoff.eventToken === notification.eventToken
      && pendingNotificationLaunch() === notification.routingHint && pendingNotificationEvent() === notification.eventToken) {
      assertCurrent();
      const now = Date.now();
      const target = parseChatNotificationTarget(JSON.stringify({
        profileId: handoff.profileId, target: handoff.target, createdAt: now,
      }), now);
      if (target) {
        try {
          sessionStorage.setItem("kaigen-open-unread-target", JSON.stringify(target));
          clearNotificationLaunch(notification.routingHint);
          notificationQueued = true;
        } catch { /* Unavailable notification storage must not fail successful authentication. */ }
      }
    }
    this.setWorkspace(response.workspace);
    assertCurrent();
    if (notificationQueued) window.dispatchEvent(new Event(NOTIFICATION_OPEN_EVENT));
    if (!this.realtimeActive) this.startRealtime();
    return response.workspace;
  }

  async login(password: string, isCurrent: () => boolean = () => true) {
    if (!this.identifier) throw new Error("WORKSPACE_IDENTIFIER_MISSING");
    if (this.sessionTeardown) throw new Error("SESSION_NOT_ACTIVE");
    const lease = { generation: ++this.sessionRequestGeneration };
    const identifier = this.identifier;
    const openingGeneration = this.workspaceOpeningGeneration;
    const routingHint = pendingNotificationLaunch(), eventToken = pendingNotificationEvent();
    const notification = routingHint && eventToken ? { routingHint, eventToken } : undefined;
    this.cancelSessionRefresh();
    this.stopRealtime();
    const assertCurrent = () => {
      if (!isCurrent() || openingGeneration !== this.workspaceOpeningGeneration
        || lease.generation !== this.sessionRequestGeneration || this.sessionTeardown) throw new Error("SESSION_NOT_ACTIVE");
    };
    const keys = await createDeviceKeys();
    const publicKey = await exportPublicKey(keys.publicKey);
    const submit = (proof?: { challengeId: string; nonce: number }) => {
      assertCurrent();
      return this.request<SessionResponse>("/api/v1/auth/password", {
        method: "POST",
        body: JSON.stringify({ identifier, password, publicKey, proof, notification }),
      });
    };
    let response: SessionResponse;
    try {
      response = await submit();
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "CAPTCHA_REQUIRED") throw error;
      const challenge = await this.initializerChallenge();
      response = await submit(await this.solveChallenge(challenge));
    }
    return this.acceptSession(response, keys, lease, false, undefined, notification, assertCurrent);
  }

  private async restoreDeviceSessionOnce(signal: AbortSignal, assertRefresh: () => void) {
    if (!this.identifier) return null;
    const lease = { generation: this.sessionRequestGeneration };
    const identifier = this.identifier;
    const assertActive = () => {
      assertRefresh();
      this.assertSessionRequest(lease);
      if (this.sessionLifecycle !== "active" || this.sessionTeardown) throw new Error("SESSION_NOT_ACTIVE");
    };
    assertActive();
    const workspaceDigest = await this.workspaceDigest();
    assertActive();
    const record = await readDeviceRecord(workspaceDigest).catch(() => null);
    assertActive();
    if (!record) return null;
    const challenge = await this.request<DeviceChallenge>("/api/v1/auth/device-challenge", {
      method: "POST",
      signal,
      headers: { [WORKSPACE_HEADER]: workspaceDigest },
      body: JSON.stringify({ identifier, deviceId: record.deviceId }),
    });
    assertActive();
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      record.privateKey,
      base64UrlToBytes(challenge.challenge),
    );
    assertActive();
    const response = await this.request<SessionResponse>("/api/v1/auth/device", {
      method: "POST",
      signal,
      headers: { [WORKSPACE_HEADER]: workspaceDigest },
      body: JSON.stringify({
        identifier,
        deviceId: record.deviceId,
        challenge: challenge.challenge,
        signature: bytesToBase64Url(new Uint8Array(signature)),
      }),
    });
    assertRefresh();
    this.assertSessionRequest(lease);
    return this.acceptSession(response, { privateKey: record.privateKey, publicKey: record.publicKey }, lease, true, { signal, assertCurrent: assertRefresh });
  }

  private cancelSessionRefresh(expected?: Promise<WorkspaceView | null>) {
    if (expected && this.sessionRefresh !== expected) return;
    const controller = this.sessionRefreshController;
    this.sessionRefresh = null; this.sessionRefreshController = null;
    controller?.abort(new Error("SESSION_NOT_ACTIVE"));
  }

  async restoreDeviceSession() {
    if (this.sessionLifecycle !== "active" || this.sessionTeardown) return null;
    if (this.sessionRefresh) return this.sessionRefresh;
    if (this.linkRotationActive) return null;
    const controller = new AbortController();
    this.sessionRefreshController = controller;
    const generation = this.sessionRequestGeneration, previousRevision = this.authenticationRevision;
    const assertRefresh = () => {
      if (controller.signal.aborted || this.sessionRefreshController !== controller) throw controller.signal.reason ?? new Error("SESSION_NOT_ACTIVE");
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = Promise.race([
      this.restoreDeviceSessionOnce(controller.signal, assertRefresh),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { const error = new Error("SESSION_REFRESH_TIMEOUT"); reject(error); controller.abort(error); }, 20_000);
      }),
    ]);
    this.sessionRefresh = refresh;
    let completed = false;
    try { const value = await refresh; completed = true; return value; }
    finally {
      clearTimeout(timer);
      if (this.sessionRefresh === refresh) {
        this.cancelSessionRefresh(refresh);
        // A received auth response may already have rotated Cookie/CSRF before
        // later storage failed. Publish its current epoch without reopening auth.
        if (!completed && generation === this.sessionRequestGeneration && previousRevision !== this.authenticationRevision
          && this.sessionLifecycle === "active" && this.workspace) this.setWorkspace(this.workspace);
      }
    }
  }

  async command<T>(command: string, args: Record<string, unknown> = {}, options: { signal?: AbortSignal } = {}) {
    const persistenceCommand = PERSISTENCE_COMMANDS.has(command);
    if (persistenceCommand && this.sessionLifecycle !== "active") return undefined as T;
    const request = this.request<T>(`/api/v1/commands/${encodeURIComponent(command)}`, {
      method: "POST",
      body: JSON.stringify(normalizedJson(args)),
      signal: options.signal ?? (command === "send_tox_message" ? AbortSignal.timeout?.(15_000) : undefined),
    }, true);
    if (!persistenceCommand) return request;
    this.pendingPersistenceCommands.add(request);
    try {
      return await request;
    } finally {
      this.pendingPersistenceCommands.delete(request);
    }
  }

  private commandWithStatus<T>(command: string, args: Record<string, unknown>) {
    return this.request<T>(`/api/v1/commands/${encodeURIComponent(command)}`, {
      method: "POST",
      body: JSON.stringify(normalizedJson(args)),
    }, true, false, true);
  }

  async renewLease() {
    const response = await this.request<{ workspace: WorkspaceView }>("/api/v1/workspaces/renew", { method: "POST", body: "{}" }, true);
    if (this.sessionLifecycle === "active") this.setWorkspace(response.workspace);
    return response.workspace;
  }

  async setAutoRenewOnHeartbeat(enabled: boolean, expectedRevision: number) {
    const generation = this.sessionRequestGeneration;
    const response = await this.request<{ workspace: WorkspaceView }>("/api/v1/workspaces/auto-renew", {
      method: "POST",
      body: JSON.stringify({ enabled, expectedRevision }),
    }, true);
    if (generation !== this.sessionRequestGeneration || this.sessionLifecycle !== "active") {
      throw new Error("SESSION_NOT_ACTIVE");
    }
    this.setWorkspace(response.workspace);
  }

  async changeWorkspacePassword(currentPassword: string, newPassword: string): Promise<void> {
    if (this.workspaceControlBusy) throw new Error("WORKSPACE_CONTROL_BUSY");
    if (!newPassword) throw new Error("WORKSPACE_PASSWORD_REQUIRED");
    if (textEncoder.encode(currentPassword).length > 1024 || textEncoder.encode(newPassword).length > 1024) {
      throw new Error("WORKSPACE_PASSWORD_TOO_LONG");
    }
    this.workspaceControlBusy = true;
    try {
      await this.request("/api/v1/workspaces/password", {
        method: "POST", body: JSON.stringify({ currentPassword, newPassword }),
      }, true);
    } finally {
      this.workspaceControlBusy = false;
    }
  }

  async rotateWorkspaceLink(): Promise<string> {
    if (this.workspaceControlBusy) throw new Error("WORKSPACE_CONTROL_BUSY");
    this.workspaceControlBusy = true;
    try {
      return await this.sessionRequest(async (lease) => {
        const assertCurrent = () => {
          this.assertSessionRequest(lease);
          if (this.sessionLifecycle !== "active" || this.sessionTeardown) throw new Error("SESSION_NOT_ACTIVE");
        };
        // Finish an earlier device refresh before switching its key binding.
        // New refreshes are held until activation finishes; ordinary requests
        // and the existing socket keep their stable authenticated selector.
        if (!await this.restoreDeviceSession()) throw new Error("SESSION_NOT_ACTIVE");
        assertCurrent();
        this.linkRotationActive = true;
        if (!this.pendingLinkRotation) {
          const previousIdentifier = this.identifier;
          const previousDigest = await this.workspaceDigest();
          const prepared = await this.request<WorkspaceLinkPreparation>("/api/v1/workspaces/access-link/prepare", {
            method: "POST", body: JSON.stringify({ identifier: previousIdentifier }),
          }, true, lease);
          assertCurrent();
          canonicalWorkspaceUrl(prepared.identifier);
          if (!Number.isSafeInteger(prepared.revision) || prepared.revision < 1) throw new Error("WORKSPACE_LINK_CHANGED");
          this.pendingLinkRotation = { ...prepared, previousIdentifier, previousDigest };
        }
        const pending = this.pendingLinkRotation;
        const nextDigest = bytesToBase64Url(await sha256(`${WORKSPACE_HASH_DOMAIN}${pending.identifier}`));
        const record = await readDeviceRecord(nextDigest).catch(() => null)
          ?? await readDeviceRecord(pending.previousDigest).catch(() => null);
        assertCurrent();
        if (!record) throw new Error("WORKSPACE_LINK_BROWSER_STORAGE_UNAVAILABLE");
        try {
          await writeDeviceRecord({ ...record, workspaceDigest: nextDigest }, assertCurrent);
          assertCurrent();
          history.replaceState(history.state, "", canonicalWorkspaceUrl(pending.identifier));
        } catch {
          assertCurrent();
          throw new Error("WORKSPACE_LINK_BROWSER_STORAGE_UNAVAILABLE");
        }
        // Navigation precedes activation. A lost reply or a reload retains the
        // new key, whose staged or committed entry can still complete login.
        this.identifier = pending.identifier;
        this.currentWorkspaceDigest = nextDigest;
        const activate = () => this.request<{ workspace: WorkspaceView }>("/api/v1/workspaces/access-link/activate", {
          method: "POST", body: JSON.stringify({ identifier: pending.identifier, expectedRevision: pending.revision }),
        }, true, lease);
        let activated: { workspace: WorkspaceView };
        try {
          try { activated = await activate(); }
          catch (error) {
            assertCurrent();
            // Only this exact idempotent activation may reconcile a lost reply.
            if (error instanceof Error && /^[A-Z][A-Z_0-9]*$/.test(error.message)) throw error;
            activated = await activate();
          }
        } catch (error) {
          assertCurrent();
          if (error instanceof Error && error.message === "WORKSPACE_CREDENTIAL_STORAGE_UNAVAILABLE") {
            this.identifier = pending.previousIdentifier;
            this.currentWorkspaceDigest = pending.previousDigest;
            history.replaceState(history.state, "", canonicalWorkspaceUrl(pending.previousIdentifier));
            throw error;
          }
          if (error instanceof Error && error.message === "WORKSPACE_LINK_CHANGED") {
            // Another tab may have replaced this staged generation. Return to
            // the previous URL only when it is still a confirmed current link.
            const previous = await this.request<{ exists: boolean; pendingAccessLink?: boolean }>(
              "/api/v1/workspaces/lookup", {
                method: "POST", body: JSON.stringify({ identifier: pending.previousIdentifier }),
              }, false, lease).catch(() => null);
            assertCurrent();
            if (previous?.exists && !previous.pendingAccessLink) {
              history.replaceState(history.state, "", canonicalWorkspaceUrl(pending.previousIdentifier));
              this.identifier = pending.previousIdentifier;
              this.currentWorkspaceDigest = pending.previousDigest;
              this.pendingLinkRotation = null;
            }
            throw error;
          }
          throw new Error("WORKSPACE_LINK_RECOVERY_REQUIRED");
        }
        assertCurrent();
        this.setWorkspace(activated.workspace);
        this.persistPasswordRequirement(false);
        if (!await rotateWorkspaceLaunch(pending.previousDigest, pending.identifier)) {
          throw new Error("WORKSPACE_LINK_RECOVERY_REQUIRED");
        }
        assertCurrent();
        await deleteDeviceRecord(pending.previousDigest).catch(() => {});
        assertCurrent();
        this.pendingLinkRotation = null;
        return pending.identifier;
      });
    } finally {
      this.linkRotationActive = false;
      this.workspaceControlBusy = false;
    }
  }

  isWorkspaceCreationPending() { return this.workspaceCreationPending; }

  finishWorkspaceCreation() { this.workspaceCreationPending = false; }

  cancelWorkspaceOpening() {
    if (this.workspaceCreationPending) throw new Error("WORKSPACE_CONTROL_BUSY");
    // Cancel creation/password continuations without invalidating the current
    // workspace's admitted saves or its device refresh while they drain.
    this.workspaceOpeningGeneration += 1;
  }

  async leaveWorkspace() {
    if (this.workspaceCreationPending) throw new Error("WORKSPACE_CONTROL_BUSY");
    if (this.sessionTeardown) throw new Error("SESSION_NOT_ACTIVE");
    const transition = this.sessionLifecycle === "active" ? this.beginSessionTeardown() : null;
    try {
      await this.drainSessionRequests();
    } catch (error) {
      if (transition) this.rollbackSessionTeardown(transition);
      throw error;
    }
    // Navigation only retires this document. Other clients and unlocked
    // profiles keep running; saved device keys and transfer caches survive.
    this.sessionLifecycle = "closed";
    this.stopRealtime();
    this.cancelSessionRefresh();
    this.csrfToken = "";
    this.workspace = null;
    this.clearTransferPreviews();
    if (transition) this.finishSessionTeardown(transition);
  }

  async lockWorkspace() {
    const transition = this.beginSessionTeardown();
    let workspaceDigest: string;
    try {
      await this.drainSessionRequests();
      workspaceDigest = await this.workspaceDigest();
      await this.request<{ locked: boolean }>("/api/v1/workspaces/lock", {
        method: "POST",
        body: "{}",
      }, true, true);
    } catch (error) {
      this.rollbackSessionTeardown(transition);
      throw error;
    }
    this.sessionLifecycle = "closed";
    this.stopRealtime();
    this.csrfToken = "";
    this.workspace = null;
    this.cancelSessionRefresh();
    this.clearTransferPreviews();
    await this.clearWorkspaceTransferCache(workspaceDigest).catch(() => {});
    await deleteDeviceRecord(workspaceDigest).catch(() => {});
    this.finishSessionTeardown(transition);
  }

  async closeWorkspace() {
    const transition = this.beginSessionTeardown();
    let workspaceDigest: string;
    try {
      await this.drainSessionRequests();
      workspaceDigest = await this.workspaceDigest();
      await this.request<{ closed: boolean }>("/api/v1/workspaces/close", {
        method: "POST",
        body: "{}",
      }, true, true);
    } catch (error) {
      this.rollbackSessionTeardown(transition);
      throw error;
    }
    this.sessionLifecycle = "closed";
    this.stopRealtime();
    this.csrfToken = "";
    this.workspace = null;
    this.cancelSessionRefresh();
    this.clearTransferPreviews();
    await this.clearWorkspaceTransferCache(workspaceDigest).catch(() => {});
    await deleteDeviceRecord(workspaceDigest).catch(() => {});
    this.finishSessionTeardown(transition);
  }

  async destroyWorkspace() {
    const transition = this.beginSessionTeardown();
    let workspaceDigest: string;
    let response: { destroyed: boolean };
    try {
      await this.drainSessionRequests();
      workspaceDigest = await this.workspaceDigest();
      response = await this.request<{ destroyed: boolean }>("/api/v1/workspaces/destroy", {
        method: "POST",
        body: JSON.stringify({ explicitConfirmation: true }),
      }, true, true);
      if (!response.destroyed) throw new Error("WORKSPACE_DESTROY_NOT_CONFIRMED");
    } catch (error) {
      this.rollbackSessionTeardown(transition);
      throw error;
    }
    this.sessionLifecycle = "closed";
    this.stopRealtime();
    this.csrfToken = "";
    this.workspace = null;
    this.cancelSessionRefresh();
    this.clearTransferPreviews();
    await this.clearWorkspaceTransferCache(workspaceDigest).catch(() => {});
    await deleteDeviceRecord(workspaceDigest).catch(() => {});
    this.identifier = "";
    this.finishSessionTeardown(transition);
    return response;
  }

  async heartbeat() {
    const response = await this.request<{ workspace: WorkspaceView }>("/api/v1/lease/heartbeat", { method: "POST", body: "{}" }, true);
    if (this.sessionLifecycle === "active") this.setWorkspace(response.workspace);
  }

  async sendBrowserFile(profileId: string, friendNumber: number, file: File, expectedPublicKey: string, expectedContactIncarnation?: number) {
    if (!/^[0-9A-F]{64}$/i.test(expectedPublicKey)) throw new Error("CHAT_CONTACT_IDENTITY_CHANGED");
    const generation = this.transferGeneration;
    this.assertTransferActive(generation);
    if (!file.size) throw new Error("TRANSFER_EMPTY_FILE");
    if (file.size > MAX_CHAT_FILE_BYTES) throw new Error("TRANSFER_FILE_TOO_LARGE");
    const previewOwner = this.transferPreviews.captureOwner(profileId, friendNumber);
    const operationId = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(24)));
    // Persist the full source before the first begin request. A lost response
    // can then be rebound by operationId from background discovery after reload.
    const { source, discard } = await this.writeTransferCache(operationId, file, file.type);
    const digest = await transferPayloadSha256(source);
    this.assertTransferActive(generation);
    let transfer: WebTransferView;
    try {
      transfer = await this.retryTransfer(() => this.request<WebTransferView>("/api/v1/transfers/outgoing", {
        method: "POST",
        body: JSON.stringify({
          profileId,
          friendNumber,
          expectedPublicKey,
          expectedContactIncarnation,
          filename: file.name,
          mime: file.type || "application/octet-stream",
          sizeBytes: file.size,
          operationId,
          sha256: digest,
        }),
      }, true), generation);
    } catch (error) {
      if (isRetiredContactTransferFailure(transferFailureCode(error))) await discard().catch(() => {});
      throw error;
    }
    if (transfer.profileId !== profileId || transfer.operationId !== operationId || transfer.direction !== "outgoing") {
      throw new Error("TRANSFER_WORKSPACE_BOUNDARY");
    }
    if (transfer.sizeBytes !== source.size) throw new Error("TRANSFER_SIZE_MISMATCH");
    if (transfer.payloadSha256 && transfer.payloadSha256 !== digest) throw new Error("TRANSFER_HASH_MISMATCH");
    if (isPreviewableImage(file.name)) this.rememberTransferPreview(transfer.id, source, previewOwner);
    this.startOutgoingTransfer(transfer, source, discard);
    return 0;
  }

  private startOutgoingTransfer(transfer: WebTransferView, source: Blob, discard = () => this.removeTransferCache(this.transferSourceId(transfer))) {
    if (transfer.direction !== "outgoing" || this.transferPumps.has(transfer.id)) return;
    const pump = this.pumpOutgoingTransfer(transfer, source)
      .then(async (terminal) => {
        if (terminal.state === "cancelled" || terminal.payloadCommitted && !keepsOutgoingTransferSource(terminal.name)) {
          await discard().catch(() => {});
        }
      })
      .catch(async (error) => {
        const code = transferFailureCode(error);
        if (code === "TRANSFER_NOT_FOUND" || code === "TRANSFER_CANCELLED" || isRetiredContactTransferFailure(code)) {
          await discard().catch(() => {});
        }
        this.reportTransferPumpError(transfer.messageId, error);
      })
      .finally(() => { if (this.transferPumps.get(transfer.id) === pump) this.transferPumps.delete(transfer.id); });
    this.transferPumps.set(transfer.id, pump);
  }

  async startIncomingTransfer(
    transfer: WebTransferView,
    friendNumber?: number,
    previewOwner?: TransferPreviewOwnerLease | null,
    intent: TransferCopyIntent = "automatic",
  ) {
    // Manual accept/resume authorizes the server. Its unfinished receive must
    // not occupy a browser-copy slot while other profiles have retained files.
    if (transfer.direction !== "incoming" || this.transferPumps.has(transfer.id)
      || !transfer.payloadCommitted || !transfer.downloadAvailable) return;
    const owner = previewOwner ?? (friendNumber === undefined
      ? null
      : this.transferPreviews.captureOwner(transfer.profileId, friendNumber));
    const pump = this.pumpIncomingTransfer(transfer, owner, intent)
      .then(() => {})
      .catch(async (error) => {
        if (transferFailureCode(error) === "TRANSFER_CANCELLED") {
          await this.removeTransferCache(transfer.id).catch(() => {});
        }
        this.reportTransferPumpError(transfer.messageId, error);
      })
      .finally(() => { if (this.transferPumps.get(transfer.id) === pump) this.transferPumps.delete(transfer.id); });
    this.transferPumps.set(transfer.id, pump);
  }

  async recoverIncomingTransfer(
    profileId: string,
    messageId: string,
    transferId: string,
    friendNumber?: number,
    intent: TransferCopyIntent = "preview",
  ) {
    if (!transferId || this.transferPumps.has(transferId)) return false;
    const generation = this.transferGeneration;
    const previewOwner = friendNumber === undefined
      ? null
      : this.transferPreviews.captureOwner(profileId, friendNumber);
    const transfer = await this.retryTransfer(() => this.transferStatus(transferId), generation);
    if (transfer.profileId !== profileId || transfer.messageId !== messageId) {
      throw new Error("TRANSFER_WORKSPACE_BOUNDARY");
    }
    if (["cancelled", "failed"].includes(transfer.state)) {
      await this.removeTransferCache(this.transferSourceId(transfer)).catch(() => {});
      return false;
    }
    const cached = await this.readTransferCache(transfer);
    this.assertTransferActive(generation);
    if (intent === "preview" && cached && isPreviewableImage(transfer.name) && previewOwner) {
      return this.rememberTransferPreview(transfer.id, cached, previewOwner);
    }
    if (transfer.direction === "outgoing" && !transfer.payloadCommitted) {
      if (!cached) throw new Error("TRANSFER_BROWSER_SOURCE_UNAVAILABLE");
      if (isPreviewableImage(transfer.name) && previewOwner) {
        this.rememberTransferPreview(transfer.id, cached, previewOwner);
      }
      this.startOutgoingTransfer(transfer, cached);
      return true;
    }
    if (!transfer.payloadCommitted || !transfer.downloadAvailable) return false;
    if (intent === "automatic" && await this.transferWasConsumed(transfer)
      && this.consumedTransfers.get(transfer.id)?.state === "memory") return true;
    this.assertTransferActive(generation);
    if (this.transferPumps.has(transferId)) return false;
    if (transfer.direction === "outgoing") {
      // Rehydrate an outgoing image from the same retained payload without
      // creating a second transfer or repeating an automatic browser download.
      if (intent === "automatic") return true;
      const pump = this.pumpIncomingTransfer(transfer, previewOwner, intent, generation)
        .then(() => {})
        .catch((error) => this.reportTransferPumpError(messageId, error))
        .finally(() => { if (this.transferPumps.get(transferId) === pump) this.transferPumps.delete(transferId); });
      this.transferPumps.set(transferId, pump);
      return true;
    }
    await this.startIncomingTransfer(transfer, friendNumber, previewOwner, intent);
    return true;
  }

  async originalBlob(profileId: string, messageId: string, transferId: string, signal?: AbortSignal, direction: WebTransferView["direction"] = "incoming"): Promise<Blob> {
    signal?.throwIfAborted();
    const generation = this.transferGeneration;
    const previous = this.transferPumps.get(transferId);
    let original: Blob | null = null;
    const pump = Promise.resolve().then(async () => {
      await previous?.catch(() => {});
      signal?.throwIfAborted();
      const transfer = await this.retryTransfer(() => this.transferStatus(transferId), generation);
      if (transfer.profileId !== profileId || transfer.messageId !== messageId
        || transfer.direction !== direction || !transfer.payloadCommitted) throw new Error("TRANSFER_WORKSPACE_BOUNDARY");
      original = await this.readTransferCache(transfer);
      this.assertTransferActive(generation);
      signal?.throwIfAborted();
      if (original) return;
      if (!transfer.downloadAvailable) throw new Error("TRANSFER_NOT_RESUMABLE");
      await this.pumpIncomingTransfer(transfer, null, "read-copy", generation, (blob) => { original = blob; }, signal);
    });
    this.transferPumps.set(transferId, pump);
    try { await pump; }
    finally { if (this.transferPumps.get(transferId) === pump) this.transferPumps.delete(transferId); }
    signal?.throwIfAborted();
    this.assertTransferActive(generation);
    if (!original) throw new Error("TRANSFER_ORIGINAL_UNAVAILABLE");
    return original;
  }

  async downloadTransfer(profileId: string, messageId: string, transferId: string, friendNumber?: number, intent: "download" | "open-video" = "download") {
    const generation = this.transferGeneration;
    const downloadKey = JSON.stringify([generation, profileId, messageId, transferId, intent]);
    const existingDownload = this.transferDownloads.get(downloadKey);
    if (existingDownload) return existingDownload;
    const owner = friendNumber === undefined ? null : this.transferPreviews.captureOwner(profileId, friendNumber);
    const previous = this.transferPumps.get(transferId);
    // Reserve ownership before status/OPFS awaits. Concurrent explicit requests
    // share this copy; an existing automatic/preview copy finishes first.
    const pump = Promise.resolve().then(async () => {
      await previous?.catch(() => {});
      const transfer = await this.retryTransfer(() => this.transferStatus(transferId), generation);
      if (transfer.profileId !== profileId || transfer.messageId !== messageId) throw new Error("TRANSFER_WORKSPACE_BOUNDARY");
      if (!transfer.payloadCommitted) throw new Error("TRANSFER_NOT_RESUMABLE");
      if (intent === "open-video" && (transfer.direction !== "incoming" || !/\.(?:mov|mp4)$/iu.test(transfer.name) || !owner)) {
        throw new Error("TRANSFER_VIDEO_PREVIEW_UNSUPPORTED");
      }
      await this.pumpIncomingTransfer(transfer, owner, intent, generation);
    });
    this.transferDownloads.set(downloadKey, pump);
    this.transferPumps.set(transferId, pump);
    try { await pump; }
    finally {
      if (this.transferPumps.get(transferId) === pump) this.transferPumps.delete(transferId);
      if (this.transferDownloads.get(downloadKey) === pump) this.transferDownloads.delete(downloadKey);
    }
  }

  private async transferStatus(transferId: string) {
    return this.request<WebTransferView>("/api/v1/transfers/status", {
      method: "POST",
      body: JSON.stringify({ transferId }),
    }, true);
  }

  private async pumpOutgoingTransfer(initial: WebTransferView, file: Blob, generation = this.transferGeneration) {
    const profileId = initial.profileId;
    const transferId = initial.id;
    const digest = await transferPayloadSha256(file);
    this.assertTransferActive(generation);
    if (initial.sizeBytes !== file.size) throw new Error("TRANSFER_SIZE_MISMATCH");
    if (initial.payloadSha256 && initial.payloadSha256 !== digest) throw new Error("TRANSFER_HASH_MISMATCH");
    while (true) {
      const transfer = await this.retryTransfer(() => this.transferStatus(transferId), generation);
      if (transfer.profileId !== profileId || transfer.messageId !== initial.messageId || transfer.operationId !== initial.operationId) {
        throw new Error("TRANSFER_WORKSPACE_BOUNDARY");
      }
      if (transfer.sizeBytes !== file.size) throw new Error("TRANSFER_SIZE_MISMATCH");
      if (transfer.payloadSha256 && transfer.payloadSha256 !== digest) throw new Error("TRANSFER_HASH_MISMATCH");
      if (transfer.state === "cancelled") return transfer;
      if (transfer.state === "failed") throw new Error("TRANSFER_FAILED");
      if (transfer.payloadCommitted) {
        if (transfer.uploadedBytes !== file.size || transfer.payloadSha256 !== digest) throw new Error("TRANSFER_HASH_MISMATCH");
        return transfer;
      }
      if (transfer.state === "paused") {
        await wait(250);
        continue;
      }
      const range = outgoingUploadRange(transfer.uploadedBytes, file.size);
      if (!range) {
        await wait(Math.max(50, transfer.retryAfterMs || 0));
        continue;
      }
      const { position, length } = range;
      const body = await file.slice(position, position + length).arrayBuffer();
      const { response, result } = await this.retryTransfer(async () => {
        const response = await this.fetchResponse("/api/v1/transfers/upload", {
          method: "POST",
          body,
          headers: {
            "Content-Type": "application/octet-stream",
            "X-Kaigen-Profile-Id": profileId,
            "X-Kaigen-Transfer-Id": transferId,
            "X-Kaigen-Transfer-Position": String(position),
          },
          credentials: "same-origin",
          cache: "no-store",
          referrerPolicy: "no-referrer",
        }, true);
        const result = await response.json().catch(() => null) as ({ retryAfterMs?: number } & ApiErrorBody) | null;
        if (response.status !== 409 || result?.code !== "TRANSFER_CHUNK_STALE") {
          if (!response.ok) throw new Error(result?.code ?? `TRANSFER_HTTP_${response.status}`);
        }
        return { response, result };
      }, generation);
      if (response.status === 409 && result?.code === "TRANSFER_CHUNK_STALE") continue;
      if ((result?.retryAfterMs ?? 0) > 0) await wait(result?.retryAfterMs ?? 0);
    }
  }

  private async pumpIncomingTransfer(
    initial: WebTransferView,
    previewOwner: TransferPreviewOwnerLease | null,
    intent: TransferCopyIntent,
    generation = this.transferGeneration,
    receiveOriginal?: (blob: Blob) => void,
    signal?: AbortSignal,
  ) {
    let transfer = initial;
    let received = 0;
    const chunks: Array<{ position: number; bytes: ArrayBuffer }> = [];
    let root: FileSystemDirectoryHandle | null = null;
    let handle: FileSystemFileHandle | null = null;
    let temporaryName = "";
    try {
      try {
        root = await this.transferCacheDirectory(true);
        this.assertTransferActive(generation);
        temporaryName = this.transferCacheName(this.transferSourceId(transfer));
        handle = await root.getFileHandle(temporaryName, { create: true });
        if (typeof handle.createWritable !== "function") throw new Error("TRANSFER_BROWSER_STORAGE_REQUIRED");
        this.assertTransferActive(generation);
        let partial = await handle.getFile();
        this.assertTransferActive(generation);
        if (partial.size > transfer.sizeBytes) {
          await root.removeEntry(temporaryName);
          handle = await root.getFileHandle(temporaryName, { create: true });
          partial = await handle.getFile();
        }
        received = partial.size;
      } catch {
        root = null;
        handle = null;
      }
      while (true) {
        signal?.throwIfAborted();
        this.assertTransferActive(generation);
        if (transfer.profileId !== initial.profileId || transfer.messageId !== initial.messageId || transfer.id !== initial.id) {
          throw new Error("TRANSFER_WORKSPACE_BOUNDARY");
        }
        if (transfer.state === "cancelled" || transfer.state === "failed") throw new Error("TRANSFER_CANCELLED");
        if (transfer.state === "paused") return transfer;
        if (incomingBrowserCommitComplete(received, transfer.sizeBytes, transfer.payloadCommitted, transfer.payloadSha256)) break;
        if (transfer.payloadCommitted && !transfer.downloadAvailable) throw new Error("TRANSFER_NOT_RESUMABLE");
        // The server completes its own receive and commit even if this loop
        // never runs. Browser copies only read retained, authenticated ranges.
        if (!transfer.payloadCommitted || !transfer.downloadAvailable || received === transfer.sizeBytes) {
          await wait(Math.max(100, transfer.retryAfterMs || 0));
          transfer = await this.retryTransfer(() => this.transferStatus(initial.id), generation);
          continue;
        }
        const response = await this.retryTransfer(async () => {
          const response = await this.fetchResponse("/api/v1/transfers/download", {
            method: "POST",
            signal,
            body: JSON.stringify({ transferId: transfer.id, position: received, length: Math.min(TRANSFER_CHUNK_BYTES, transfer.sizeBytes - received) }),
            headers: { "Content-Type": "application/json" },
            credentials: "same-origin",
            cache: "no-store",
            referrerPolicy: "no-referrer",
          }, true);
          if (response.status !== 200 && response.status !== 204) {
            const body = await response.json().catch(() => null) as ApiErrorBody | null;
            throw new Error(body?.code ?? `TRANSFER_HTTP_${response.status}`);
          }
          return response;
        }, generation);
        if (response.status === 200) {
          const position = Number(response.headers.get("X-Kaigen-Transfer-Position") ?? "NaN");
          const bytes = await response.arrayBuffer();
          const end = position + bytes.byteLength;
          if (!bytes.byteLength || bytes.byteLength > TRANSFER_CHUNK_BYTES || !Number.isSafeInteger(position) || position < 0 || !Number.isSafeInteger(end) || end > transfer.sizeBytes) {
            throw new Error("TRANSFER_CHUNK_RANGE_INVALID");
          }
          if (position !== received) throw new Error("TRANSFER_CHUNK_GAP");
          const freshBytes = bytes;
          if (freshBytes.byteLength) {
            const freshPosition = received;
            if (handle) {
              // Close every local range so a reload can resume this browser's
              // copy. This receipt has no effect on native transfer progress.
              const checkpoint = await handle.createWritable({ keepExistingData: true });
              try {
                await checkpoint.write({ type: "write", position: freshPosition, data: freshBytes });
                this.assertTransferActive(generation);
                await checkpoint.close();
              } catch (error) {
                await checkpoint.abort().catch(() => {});
                throw error;
              }
            } else {
              if (transfer.sizeBytes > MAX_CHAT_FILE_BYTES) throw new Error("TRANSFER_BROWSER_STORAGE_REQUIRED");
              chunks.push({ position: freshPosition, bytes: freshBytes });
            }
            received += freshBytes.byteLength;
          }
        }
        if (response.status === 204) transfer = await this.retryTransfer(() => this.transferStatus(transfer.id), generation);
        if (transfer.state === "cancelled" || transfer.state === "failed") throw new Error("TRANSFER_CANCELLED");
        if (transfer.state === "paused") {
          return transfer;
        }
        if (response.status === 204) await wait(75);
      }
      if (received !== transfer.sizeBytes) throw new Error("TRANSFER_SIZE_MISMATCH");
      let blob: Blob;
      if (root && temporaryName) {
        const stored = await (await root.getFileHandle(temporaryName)).getFile();
        blob = stored.slice(0, stored.size, transfer.mime || "application/octet-stream");
      } else {
        chunks.sort((left, right) => left.position - right.position);
        blob = new Blob(chunks.map((chunk) => chunk.bytes), { type: transfer.mime });
      }
      await verifyTransferPayload(blob, transfer.sizeBytes, transfer.payloadSha256);
      this.assertTransferActive(generation);
      if (previewOwner && intent === "open-video") {
        const mediaType = /\.mov$/iu.test(transfer.name) ? "video/quicktime" : "video/mp4";
        this.rememberTransferPreview(transfer.id, blob.slice(0, blob.size, mediaType), previewOwner);
      } else if (isPreviewableImage(transfer.name) && previewOwner) {
        this.rememberTransferPreview(transfer.id, blob, previewOwner);
      }
      if (intent === "download") {
        this.assertTransferActive(generation);
        triggerDownload(blob, safeDownloadName(transfer.name));
        await this.markTransferConsumed(transfer, generation, handle !== null);
      } else if ((intent === "automatic" && !await this.transferWasConsumed(transfer))
        || (handle && this.consumedTransfers.get(transfer.id)?.state === "pending")) {
        await this.markTransferConsumed(transfer, generation, handle !== null);
      }
      if (transfer.direction === "incoming" && handle && await this.transferWasConsumed(transfer, true)) {
        // The verified OPFS payload and local receipt survive a lost reply or
        // document reload. Only this durable copy authorizes server cleanup.
        while (true) {
          this.assertTransferActive(generation);
          const response = await this.retryTransfer(() => this.commandWithStatus<IncomingTransferCompletion>("complete_web_incoming_transfer", {
            profileId: transfer.profileId,
            transferId: transfer.id,
            sizeBytes: blob.size,
            sha256: transfer.payloadSha256,
          }), generation);
          this.assertTransferActive(generation);
          const completion = response.body;
          if (response.status === 202) {
            if (!completion || typeof completion !== "object" || Array.isArray(completion)
              || Object.keys(completion).length !== 2 || !("completion" in completion)
              || completion.completion !== "pending" || completion.retryAfterMs !== 100) {
              throw new Error("TRANSFER_COMPLETION_INVALID");
            }
            await wait(completion.retryAfterMs);
            continue;
          }
          if (response.status !== 200) throw new Error("TRANSFER_COMPLETION_INVALID");
          const confirmed = completion as WebTransferView;
          if (!confirmed || typeof confirmed !== "object" || Array.isArray(confirmed)
            || "completion" in confirmed
            || confirmed.id !== transfer.id || confirmed.messageId !== transfer.messageId
            || confirmed.profileId !== transfer.profileId || confirmed.direction !== "incoming"
            || confirmed.sizeBytes !== blob.size || confirmed.payloadSha256 !== transfer.payloadSha256
            || confirmed.persistedBytes !== blob.size || confirmed.payloadCommitted !== true
            || confirmed.state !== "complete" || confirmed.downloadAvailable !== (confirmed.retainedForMirrors === true)) {
            throw new Error("TRANSFER_COMPLETION_INVALID");
          }
          break;
        }
      }
      // Incoming files remain available for repeated downloads after the
      // server releases its payload. Session teardown still clears this cache.
      if (transfer.direction === "outgoing" && !keepsOutgoingTransferSource(transfer.name)) {
        await this.removeTransferCache(this.transferSourceId(transfer)).catch(() => {});
      }
      signal?.throwIfAborted();
      receiveOriginal?.(blob);
      return transfer;
    } catch (error) {
      const code = transferFailureCode(error);
      const discard = [
        "TRANSFER_ACK_RANGE_INVALID",
        "TRANSFER_CANCELLED",
        "TRANSFER_CHUNK_GAP",
        "TRANSFER_CHUNK_RANGE_INVALID",
        "TRANSFER_FAILED",
        "TRANSFER_HASH_MISMATCH",
        "TRANSFER_SIZE_MISMATCH",
      ].includes(code);
      if (discard && root && temporaryName) await root.removeEntry(temporaryName).catch(() => {});
      throw error;
    }
  }

  async importProfile(
    file: Blob,
    kind: "qtoxZip" | "kai" | "package",
    name: string,
    password: string,
  ) {
    const started = await this.request<{ importId: string; chunkBytes: number }>("/api/v1/profiles/import/start", {
      method: "POST",
      body: JSON.stringify({ kind, sizeBytes: file.size }),
    }, true);
    if (!/^[A-Za-z0-9_-]{32}$/u.test(started.importId)
      || !Number.isSafeInteger(started.chunkBytes) || started.chunkBytes <= 0 || started.chunkBytes > 1024 * 1024) {
      throw new Error("PROFILE_IMPORT_RESPONSE_INVALID");
    }
    const hasher = new StreamingSha256();
    try {
      for (let position = 0; position < file.size; position += started.chunkBytes) {
        const chunk = new Uint8Array(await file.slice(position, position + started.chunkBytes).arrayBuffer());
        hasher.update(chunk);
        const response = await this.fetchResponse("/api/v1/profiles/import/upload", {
          method: "POST",
          body: chunk,
          headers: {
            "Content-Type": "application/octet-stream",
            "X-Kaigen-Import-Id": started.importId,
            "X-Kaigen-Import-Position": String(position),
          },
          credentials: "same-origin",
          cache: "no-store",
          referrerPolicy: "no-referrer",
        }, true);
        if (!response.ok) {
          const body = await response.json().catch(() => null) as ApiErrorBody | null;
          throw new Error(body?.code ?? `PROFILE_IMPORT_HTTP_${response.status}`);
        }
      }
      const profiles = await this.request<unknown[]>("/api/v1/profiles/import/finish", {
        method: "POST",
        body: JSON.stringify({
          importId: started.importId,
          name: kind === "package" ? "" : name,
          password,
          sha256: bytesToBase64Url(hasher.digest()),
        }),
      }, true);
      window.dispatchEvent(new Event("profiles-changed"));
      return profiles;
    } catch (error) {
      await this.request("/api/v1/profiles/import/cancel", {
        method: "POST",
        body: JSON.stringify({ importId: started.importId }),
      }, true).catch(() => {});
      throw error;
    }
  }

  listen<T>(event: string, handler: EventHandler<T>) {
    const handlers = this.listeners.get(event) ?? new Set<EventHandler<unknown>>();
    handlers.add(handler as EventHandler<unknown>);
    this.listeners.set(event, handlers);
    return Promise.resolve(() => {
      handlers.delete(handler as EventHandler<unknown>);
      if (handlers.size === 0) this.listeners.delete(event);
    });
  }

  private dispatch(message: WebEvent) {
    this.eventSequence += 1;
    for (const handler of this.listeners.get(message.event) ?? []) {
      handler({ event: message.event, id: this.eventSequence, payload: message.payload });
    }
  }

  private hasLiveSocket() {
    return this.socket?.readyState === WebSocket.OPEN || this.socket?.readyState === WebSocket.CONNECTING;
  }

  private async connectSocket() {
    if (this.upgradeRequired || !this.realtimeActive || !this.csrfToken || this.hasLiveSocket()) return;
    const generation = this.sessionRequestGeneration;
    const workspaceDigest = this.authenticatedWorkspaceSelector || await this.workspaceDigest();
    if (generation !== this.sessionRequestGeneration || !this.realtimeActive || !this.csrfToken || this.hasLiveSocket()) return;
    const scheme = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${scheme}//${location.host}/ws/v1?build=${encodeURIComponent(WEB_BUILD_ID)}`, ["kaigen.v1", `${WORKSPACE_PROTOCOL_PREFIX}${workspaceDigest}`]);
    this.socket = socket;
    socket.onopen = () => {
      if (generation === this.sessionRequestGeneration && this.socket === socket && this.realtimeActive) {
        window.dispatchEvent(new Event("kaigen:web-connection-ready"));
      }
    };
    socket.onmessage = (event) => {
      if (generation !== this.sessionRequestGeneration || this.socket !== socket || !this.realtimeActive) return;
      try {
        const message = JSON.parse(String(event.data)) as WebEvent;
        this.dispatch(message);
        if (message.event === "profile-changed" && message.payload && typeof message.payload === "object") {
          const payload = message.payload as { profileId?: unknown; change?: unknown };
          if (typeof payload.profileId === "string") {
            this.dispatch({ event: "profiles-changed", payload: payload.profileId });
            if (payload.profileId.startsWith("wg-")) {
              this.dispatch({ event: "webgate-event", payload: { profileId: payload.profileId, event: payload.change } });
            }
          }
        }
      } catch {
        // Invalid server events are ignored without exposing payloads to logs.
      }
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      window.clearTimeout(this.reconnectTimer);
      if (!this.realtimeActive) return;
      const scheduleReconnect = () => {
        if (generation === this.sessionRequestGeneration && !this.upgradeRequired && this.realtimeActive) {
          this.reconnectTimer = window.setTimeout(() => void this.connectSocket(), 2000);
        }
      };
      void this.verifyBuildIdentity().then(scheduleReconnect, scheduleReconnect);
    };
  }

  private startRealtime() {
    if (this.upgradeRequired || this.sessionLifecycle !== "active") return;
    this.stopRealtime();
    this.realtimeActive = true;
    void this.connectSocket();
    void this.backgroundTransfers.run().catch(() => {});
    this.transferDiscoveryTimer = window.setInterval(() => void this.backgroundTransfers.run().catch(() => {}), 2000);
    this.heartbeatTimer = window.setInterval(() => void this.heartbeat().catch(() => {}), 20_000);
    this.verificationTimer = window.setInterval(() => void this.restoreDeviceSession().catch(() => {}), 5 * 60_000);
  }

  private stopRealtime() {
    this.realtimeActive = false;
    this.backgroundTransfers.reset();
    window.clearInterval(this.transferDiscoveryTimer);
    window.clearInterval(this.heartbeatTimer);
    window.clearInterval(this.verificationTimer);
    window.clearTimeout(this.reconnectTimer);
    this.socket?.close(1000, "client stop");
    this.socket = null;
  }
}

function wait(milliseconds: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, Math.max(0, milliseconds)));
}

function safeDownloadName(value: string) {
  const safe = value.replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "_").trim();
  return safe || "kaigen-file";
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 120_000);
}

export const webSession = new WebSession();
