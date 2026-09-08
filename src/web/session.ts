import type {
  ApiErrorBody,
  BuildIdentityResponse,
  CreateWorkspaceRequest,
  CreateWorkspaceResponse,
  DeviceChallenge,
  InitializerChallenge,
  SessionResponse,
  StorageMode,
  WebEvent,
  WorkspaceView,
} from "./contracts";
import { WEB_BUILD_HEADER, WEB_BUILD_ID } from "./buildIdentity";
import { StreamingSha256 } from "./sha256-stream";
import {
  incomingBrowserCommitComplete,
  retryTransferOperation,
  transferFailureCode,
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

export type WebTransferView = {
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
};

const DATABASE_NAME = "kaigen-browser-auth-v1";
const STORE_NAME = "device-keys";
const LEGACY_DEVICE_RECORD_KEY = "active-device";
const DEVICE_RECORD_PREFIX = "workspace:";
const WORKSPACE_HEADER = "X-Kaigen-Workspace";
const WORKSPACE_PROTOCOL_PREFIX = "kaigen.workspace.";
const WORKSPACE_HASH_DOMAIN = "kaigen-workspace-identifier-v1";
const BROWSER_STREAM_PREFIX = "browser-stream://";
const TRANSFER_CACHE_DIRECTORY = ".kaigen-transfer-cache";
const IMAGE_PREVIEW_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);
const PERSISTENCE_COMMANDS = new Set(["save_layout_state", "save_local_state"]);
const textEncoder = new TextEncoder();

function isPreviewableImage(name: string) {
  return IMAGE_PREVIEW_EXTENSIONS.has(name.split(".").pop()?.toLowerCase() ?? "");
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

async function readDeviceRecordAtKey(key: string): Promise<DeviceRecord | null> {
  const database = await openDeviceDatabase();
  try {
    return await new Promise<DeviceRecord | null>((resolve, reject) => {
      const request = database.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(key);
      request.onsuccess = () => resolve((request.result as DeviceRecord | undefined) ?? null);
      request.onerror = () => reject(request.error ?? new Error("BROWSER_STORAGE_READ_FAILED"));
    });
  } finally {
    database.close();
  }
}

async function readDeviceRecord(workspaceDigest: string, legacyWorkspaceDigest: string): Promise<DeviceRecord | null> {
  const record = await readDeviceRecordAtKey(`${DEVICE_RECORD_PREFIX}${workspaceDigest}`);
  if (record?.workspaceDigest === workspaceDigest) return record;
  const legacy = await readDeviceRecordAtKey(LEGACY_DEVICE_RECORD_KEY);
  return legacy?.workspaceDigest === legacyWorkspaceDigest ? legacy : null;
}

async function writeDeviceRecord(record: DeviceRecord) {
  const database = await openDeviceDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const request = database
        .transaction(STORE_NAME, "readwrite")
        .objectStore(STORE_NAME)
        .put(record, `${DEVICE_RECORD_PREFIX}${record.workspaceDigest}`);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error ?? new Error("BROWSER_STORAGE_WRITE_FAILED"));
    });
  } finally {
    database.close();
  }
}

async function deleteDeviceRecord(workspaceDigest: string, legacyWorkspaceDigest: string) {
  const legacy = await readDeviceRecordAtKey(LEGACY_DEVICE_RECORD_KEY).catch(() => null);
  const database = await openDeviceDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const store = database.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME);
      const keys = [`${DEVICE_RECORD_PREFIX}${workspaceDigest}`];
      if (legacy?.workspaceDigest === legacyWorkspaceDigest) keys.push(LEGACY_DEVICE_RECORD_KEY);
      let pending = keys.length;
      for (const key of keys) {
        const request = store.delete(key);
        request.onsuccess = () => {
          pending -= 1;
          if (pending === 0) resolve();
        };
        request.onerror = () => reject(request.error ?? new Error("BROWSER_STORAGE_DELETE_FAILED"));
      }
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
  private readonly listeners = new Map<string, Set<EventHandler<unknown>>>();
  private readonly workspaceListeners = new Set<(workspace: WorkspaceView) => void>();
  private readonly upgradeRequiredListeners = new Set<() => void>();
  private readonly transferPumps = new Map<string, Promise<void>>();
  private readonly transferPreviews = new TransferPreviewRegistry({
    onInvalidate: ({ profileId, friendNumber, transferId }) => {
      window.dispatchEvent(new CustomEvent("kaigen:transfer-preview-invalidated", {
        detail: { profileId, friendNumber, transferId },
      }));
    },
  });
  private readonly pendingPersistenceCommands = new Set<Promise<unknown>>();
  private upgradeRequired = false;
  private sessionLifecycle: "active" | "tearing-down" | "closed" = "active";
  private readonly backgroundTransfers = new BackgroundTransferDiscovery({
    load: () => this.command<BackgroundTransferSnapshot>("get_background_transfer_work"),
    running: () => new Set(this.transferPumps.keys()),
    accept: (work) => this.command("control_tox_file_transfer", { profileId: work.profileId, friendNumber: work.friendNumber, messageId: work.messageId, action: "resume" }),
    recover: (work) => this.recoverIncomingTransfer(work.profileId, work.messageId, work.transferId, work.friendNumber),
    report: (work, error) => this.reportTransferPumpError(work.messageId, error),
    now: () => Date.now(),
  });

  setIdentifier(identifier: string) {
    this.identifier = identifier.trim();
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

  private retryTransfer<T>(operation: () => Promise<T>) {
    return retryTransferOperation(operation, { active: () => this.transferIsActive() });
  }

  private async transferCacheDirectory(create: boolean) {
    if (!navigator.storage.getDirectory) throw new Error("TRANSFER_BROWSER_STORAGE_REQUIRED");
    const root = await navigator.storage.getDirectory();
    const cache = await root.getDirectoryHandle(TRANSFER_CACHE_DIRECTORY, { create });
    return cache.getDirectoryHandle(await this.workspaceDigest(), { create });
  }

  private transferCacheName(transferId: string) {
    if (!/^[A-Za-z0-9_-]{32}$/u.test(transferId)) throw new Error("TRANSFER_ID_INVALID");
    return `${transferId}.payload`;
  }

  private async writeTransferCache(transferId: string, blob: Blob, mime: string) {
    const directory = await this.transferCacheDirectory(true);
    const handle = await directory.getFileHandle(this.transferCacheName(transferId), { create: true });
    const writable = await handle.createWritable();
    try {
      await writable.write(blob);
      await writable.close();
    } catch (error) {
      await writable.abort().catch(() => {});
      await directory.removeEntry(this.transferCacheName(transferId)).catch(() => {});
      throw error;
    }
    const stored = await handle.getFile();
    if (stored.size !== blob.size) {
      await directory.removeEntry(this.transferCacheName(transferId)).catch(() => {});
      throw new Error("TRANSFER_SIZE_MISMATCH");
    }
    return stored.slice(0, stored.size, mime || blob.type || "application/octet-stream");
  }

  private async readTransferCache(transfer: WebTransferView) {
    try {
      const directory = await this.transferCacheDirectory(false);
      const handle = await directory.getFileHandle(this.transferCacheName(transfer.id));
      const stored = await handle.getFile();
      if (stored.size !== transfer.sizeBytes) return null;
      return stored.slice(0, stored.size, transfer.mime || "application/octet-stream");
    } catch {
      return null;
    }
  }

  private async removeTransferCache(transferId: string) {
    const directory = await this.transferCacheDirectory(false);
    await directory.removeEntry(this.transferCacheName(transferId));
  }

  private async clearWorkspaceTransferCache(workspaceDigest: string) {
    if (!navigator.storage.getDirectory) return;
    const root = await navigator.storage.getDirectory();
    const cache = await root.getDirectoryHandle(TRANSFER_CACHE_DIRECTORY);
    await cache.removeEntry(workspaceDigest, { recursive: true });
  }

  private reportTransferPumpError(messageId: string, error: unknown) {
    if (["TRANSFER_CANCELLED", "TRANSFER_PUMP_STOPPED"].includes(transferFailureCode(error))) return;
    window.dispatchEvent(new CustomEvent("kaigen:transfer-pump-error", {
      detail: { messageId, code: transferFailureCode(error) },
    }));
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

  private requireUpgrade() {
    if (this.upgradeRequired) return;
    this.upgradeRequired = true;
    this.stopRealtime();
    for (const handler of this.upgradeRequiredListeners) handler();
  }

  private setWorkspace(workspace: WorkspaceView) {
    this.workspace = workspace;
    for (const handler of this.workspaceListeners) handler(workspace);
  }

  private async fetchResponse(path: string, init: RequestInit = {}, authenticated = false) {
    if (this.upgradeRequired) throw new Error("UPGRADE_REQUIRED");
    const send = async () => {
      const headers = authenticated ? await this.authenticatedHeaders(init.headers) : new Headers(init.headers);
      headers.set(WEB_BUILD_HEADER, WEB_BUILD_ID);
      if (init.body && !headers.has("Content-Type") && typeof init.body === "string") headers.set("Content-Type", "application/json");
      return fetch(path, { ...init, headers, credentials: "same-origin", cache: "no-store", referrerPolicy: "no-referrer" });
    };
    let response = await send();
    if (authenticated && response.status === 401) {
      const error = await response.clone().json().catch(() => null) as ApiErrorBody | null;
      if (error?.code === "CSRF_INVALID") {
        const restored = await this.restoreDeviceSession().catch(() => null);
        if (restored) response = await send();
      }
    }
    if (response.status === 426) {
      this.requireUpgrade();
      throw new Error("UPGRADE_REQUIRED");
    }
    return response;
  }

  private async request<T>(path: string, init: RequestInit = {}, authenticated = false): Promise<T> {
    const response = await this.fetchResponse(path, init, authenticated);
    const contentType = response.headers.get("content-type") ?? "";
    const body = contentType.includes("application/json") ? await response.json() as unknown : await response.text();
    if (!response.ok) {
      const error = body && typeof body === "object" ? body as ApiErrorBody : {};
      if (response.status === 426 || error.code === "UPGRADE_REQUIRED") this.requireUpgrade();
      throw new Error(response.status === 426 ? "UPGRADE_REQUIRED" : error.code ?? error.message ?? `HTTP_${response.status}`);
    }
    return body as T;
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
    return this.request<InitializerChallenge>("/api/v1/initializer/challenge", { method: "POST" });
  }

  async solveChallenge(challenge: InitializerChallenge) {
    const prefix = textEncoder.encode(`${challenge.salt}:`);
    for (let nonce = 0; nonce <= 0xffff_ffff; nonce += 1) {
      const suffix = textEncoder.encode(String(nonce));
      const bytes = new Uint8Array(prefix.length + suffix.length);
      bytes.set(prefix);
      bytes.set(suffix, prefix.length);
      if (leadingZeroBits(await sha256(bytes)) >= challenge.difficulty) return { challengeId: challenge.challengeId, nonce };
      if (nonce % 128 === 0) await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    }
    throw new Error("PROOF_NOT_SOLVED");
  }

  async createWorkspace(request: Omit<CreateWorkspaceRequest, "proof">) {
    const challenge = await this.initializerChallenge();
    const proof = await this.solveChallenge(challenge);
    const response = await this.request<CreateWorkspaceResponse>("/api/v1/workspaces", {
      method: "POST",
      body: JSON.stringify({ ...request, proof }),
    });
    this.setIdentifier(response.identifier);
    this.setWorkspace(response.workspace);
    return response;
  }

  async restoreWorkspaceArchive(
    file: File,
    storageMode: StorageMode,
    archivePassword: string,
    accessPassword: string,
    legacyIdentifier?: string,
  ) {
    if (!Number.isSafeInteger(file.size) || file.size <= 0) {
      throw new Error("WORKSPACE_IMPORT_SIZE_INVALID");
    }
    const challenge = await this.initializerChallenge();
    const proof = await this.solveChallenge(challenge);
    const started = await this.request<{ importId: string; chunkBytes: number }>("/api/v1/workspaces/import/start", {
      method: "POST",
      body: JSON.stringify({ storageMode, sizeBytes: file.size, proof }),
    });
    if (!/^[A-Za-z0-9_-]{32}$/u.test(started.importId)
      || !Number.isSafeInteger(started.chunkBytes) || started.chunkBytes <= 0 || started.chunkBytes > 1024 * 1024) {
      throw new Error("WORKSPACE_IMPORT_RESPONSE_INVALID");
    }
    const hasher = new StreamingSha256();
    try {
      for (let position = 0; position < file.size; position += started.chunkBytes) {
        const chunk = new Uint8Array(await file.slice(position, position + started.chunkBytes).arrayBuffer());
        hasher.update(chunk);
        const response = await this.fetchResponse("/api/v1/workspaces/import/upload", {
          method: "POST",
          body: chunk,
          headers: {
            "Content-Type": "application/octet-stream",
            "X-Kaigen-Import-Id": started.importId,
            "X-Kaigen-Import-Position": String(position),
          },
        });
        if (!response.ok) {
          const body = await response.json().catch(() => null) as ApiErrorBody | null;
          if (body?.code === "UPGRADE_REQUIRED") {
            this.requireUpgrade();
            throw new Error("UPGRADE_REQUIRED");
          }
          throw new Error(body?.code ?? `WORKSPACE_IMPORT_HTTP_${response.status}`);
        }
      }
      const restored = await this.request<CreateWorkspaceResponse>("/api/v1/workspaces/import/finish", {
        method: "POST",
        body: JSON.stringify({
          importId: started.importId,
          archivePassword,
          accessPassword,
          sha256: bytesToBase64Url(hasher.digest()),
          identifier: legacyIdentifier || undefined,
        }),
      });
      this.setIdentifier(restored.identifier);
      this.setWorkspace(restored.workspace);
      return restored;
    } catch (error) {
      await this.request("/api/v1/workspaces/import/cancel", {
        method: "POST",
        body: JSON.stringify({ importId: started.importId }),
      }).catch(() => {});
      throw error;
    }
  }

  async lookupWorkspace() {
    if (!this.identifier) throw new Error("WORKSPACE_IDENTIFIER_MISSING");
    return this.request<{ exists: boolean; provisional: boolean }>("/api/v1/workspaces/lookup", {
      method: "POST",
      body: JSON.stringify({ identifier: this.identifier }),
    });
  }

  private async workspaceDigest() {
    return bytesToBase64Url(await sha256(`${WORKSPACE_HASH_DOMAIN}${this.identifier}`));
  }

  private async legacyWorkspaceDigest() {
    return bytesToBase64Url(await sha256(this.identifier));
  }

  private async authenticatedHeaders(initial?: HeadersInit) {
    const headers = new Headers(initial);
    headers.set(WORKSPACE_HEADER, await this.workspaceDigest());
    if (this.csrfToken) headers.set("X-Kaigen-CSRF", this.csrfToken);
    return headers;
  }

  private async acceptSession(response: SessionResponse, keys: CryptoKeyPair) {
    this.sessionLifecycle = "active";
    this.csrfToken = response.csrfToken;
    this.setWorkspace(response.workspace);
    const workspaceDigest = await this.workspaceDigest();
    await writeDeviceRecord({
      workspaceDigest,
      deviceId: response.deviceId,
      privateKey: keys.privateKey,
      publicKey: keys.publicKey,
    });
    this.startRealtime();
    return response.workspace;
  }

  async login(password: string) {
    if (!this.identifier) throw new Error("WORKSPACE_IDENTIFIER_MISSING");
    const keys = await createDeviceKeys();
    const publicKey = await exportPublicKey(keys.publicKey);
    const submit = (proof?: { challengeId: string; nonce: number }) => this.request<SessionResponse>("/api/v1/auth/password", {
        method: "POST",
        body: JSON.stringify({ identifier: this.identifier, password, publicKey, proof }),
      });
    let response: SessionResponse;
    try {
      response = await submit();
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "CAPTCHA_REQUIRED") throw error;
      const challenge = await this.initializerChallenge();
      response = await submit(await this.solveChallenge(challenge));
    }
    return this.acceptSession(response, keys);
  }

  private async restoreDeviceSessionOnce() {
    if (!this.identifier) return null;
    const workspaceDigest = await this.workspaceDigest();
    const record = await readDeviceRecord(workspaceDigest, await this.legacyWorkspaceDigest()).catch(() => null);
    if (!record) return null;
    const challenge = await this.request<DeviceChallenge>("/api/v1/auth/device-challenge", {
      method: "POST",
      headers: { [WORKSPACE_HEADER]: workspaceDigest },
      body: JSON.stringify({ identifier: this.identifier, deviceId: record.deviceId }),
    });
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      record.privateKey,
      base64UrlToBytes(challenge.challenge),
    );
    const response = await this.request<SessionResponse>("/api/v1/auth/device", {
      method: "POST",
      headers: { [WORKSPACE_HEADER]: workspaceDigest },
      body: JSON.stringify({
        identifier: this.identifier,
        deviceId: record.deviceId,
        challenge: challenge.challenge,
        signature: bytesToBase64Url(new Uint8Array(signature)),
      }),
    });
    return this.acceptSession(response, { privateKey: record.privateKey, publicKey: record.publicKey });
  }

  async restoreDeviceSession() {
    if (this.sessionRefresh) return this.sessionRefresh;
    const refresh = this.restoreDeviceSessionOnce();
    this.sessionRefresh = refresh;
    try {
      return await refresh;
    } finally {
      if (this.sessionRefresh === refresh) this.sessionRefresh = null;
    }
  }

  async command<T>(command: string, args: Record<string, unknown> = {}) {
    const persistenceCommand = PERSISTENCE_COMMANDS.has(command);
    if (persistenceCommand && this.sessionLifecycle !== "active") return undefined as T;
    const request = this.request<T>(`/api/v1/commands/${encodeURIComponent(command)}`, {
      method: "POST",
      body: JSON.stringify(normalizedJson(args)),
    }, true);
    if (!persistenceCommand) return request;
    this.pendingPersistenceCommands.add(request);
    try {
      return await request;
    } finally {
      this.pendingPersistenceCommands.delete(request);
    }
  }

  async renewLease() {
    const response = await this.request<{ workspace: WorkspaceView }>("/api/v1/workspaces/renew", { method: "POST", body: "{}" }, true);
    this.setWorkspace(response.workspace);
    return response.workspace;
  }

  async lockWorkspace() {
    const workspaceDigest = await this.workspaceDigest();
    const legacyWorkspaceDigest = await this.legacyWorkspaceDigest();
    await this.request<{ locked: boolean }>("/api/v1/workspaces/lock", {
      method: "POST",
      body: "{}",
    }, true);
    this.stopRealtime();
    this.csrfToken = "";
    this.workspace = null;
    this.sessionRefresh = null;
    this.clearTransferPreviews();
    await this.clearWorkspaceTransferCache(workspaceDigest).catch(() => {});
    await deleteDeviceRecord(workspaceDigest, legacyWorkspaceDigest).catch(() => {});
  }

  async closeWorkspace() {
    this.sessionLifecycle = "tearing-down";
    let workspaceDigest: string;
    let legacyWorkspaceDigest: string;
    try {
      await Promise.allSettled([...this.pendingPersistenceCommands]);
      workspaceDigest = await this.workspaceDigest();
      legacyWorkspaceDigest = await this.legacyWorkspaceDigest();
      await this.request<{ closed: boolean }>("/api/v1/workspaces/close", {
        method: "POST",
        body: "{}",
      }, true);
    } catch (error) {
      this.sessionLifecycle = "active";
      throw error;
    }
    this.sessionLifecycle = "closed";
    this.stopRealtime();
    this.csrfToken = "";
    this.workspace = null;
    this.sessionRefresh = null;
    this.clearTransferPreviews();
    await this.clearWorkspaceTransferCache(workspaceDigest).catch(() => {});
    await deleteDeviceRecord(workspaceDigest, legacyWorkspaceDigest).catch(() => {});
  }

  async destroyWorkspace() {
    this.sessionLifecycle = "tearing-down";
    let workspaceDigest: string;
    let legacyWorkspaceDigest: string;
    let response: { destroyed: boolean };
    try {
      await Promise.allSettled([...this.pendingPersistenceCommands]);
      workspaceDigest = await this.workspaceDigest();
      legacyWorkspaceDigest = await this.legacyWorkspaceDigest();
      response = await this.request<{ destroyed: boolean }>("/api/v1/workspaces/destroy", {
        method: "POST",
        body: JSON.stringify({ explicitConfirmation: true }),
      }, true);
      if (!response.destroyed) throw new Error("WORKSPACE_DESTROY_NOT_CONFIRMED");
    } catch (error) {
      this.sessionLifecycle = "active";
      throw error;
    }
    this.sessionLifecycle = "closed";
    this.stopRealtime();
    this.csrfToken = "";
    this.workspace = null;
    this.sessionRefresh = null;
    this.clearTransferPreviews();
    await this.clearWorkspaceTransferCache(workspaceDigest).catch(() => {});
    await deleteDeviceRecord(workspaceDigest, legacyWorkspaceDigest).catch(() => {});
    this.identifier = "";
    return response;
  }

  async heartbeat() {
    const response = await this.request<{ workspace: WorkspaceView }>("/api/v1/lease/heartbeat", { method: "POST", body: "{}" }, true);
    this.setWorkspace(response.workspace);
  }

  async sendBrowserFile(profileId: string, friendNumber: number, file: File) {
    if (!file.size) throw new Error("TRANSFER_EMPTY_FILE");
    if (file.size > MAX_CHAT_FILE_BYTES) throw new Error("TRANSFER_FILE_TOO_LARGE");
    const previewOwner = this.transferPreviews.captureOwner(profileId, friendNumber);
    const transfer = await this.request<WebTransferView>("/api/v1/transfers/outgoing", {
      method: "POST",
      body: JSON.stringify({
        profileId,
        friendNumber,
        filename: file.name,
        mime: file.type || "application/octet-stream",
        sizeBytes: file.size,
      }),
    }, true);
    if (transfer.profileId !== profileId) throw new Error("TRANSFER_WORKSPACE_BOUNDARY");
    const source = await this.writeTransferCache(transfer.id, file, transfer.mime).catch(() => file);
    if (isPreviewableImage(file.name)) this.rememberTransferPreview(transfer.id, source, previewOwner);
    this.startOutgoingTransfer(transfer, source);
    return 0;
  }

  private startOutgoingTransfer(transfer: WebTransferView, source: Blob) {
    if (transfer.direction !== "outgoing" || this.transferPumps.has(transfer.id)) return;
    const pump = this.pumpOutgoingTransfer(transfer.profileId, transfer.id, source)
      .then(async (terminal) => {
        if (terminal.state !== "complete" || !isPreviewableImage(terminal.name)) {
          await this.removeTransferCache(terminal.id).catch(() => {});
        }
      })
      .catch((error) => this.reportTransferPumpError(transfer.messageId, error))
      .finally(() => this.transferPumps.delete(transfer.id));
    this.transferPumps.set(transfer.id, pump);
  }

  async startIncomingTransfer(
    transfer: WebTransferView,
    friendNumber?: number,
    previewOwner?: TransferPreviewOwnerLease | null,
  ) {
    if (transfer.direction !== "incoming" || this.transferPumps.has(transfer.id)) return;
    const owner = previewOwner ?? (friendNumber === undefined
      ? null
      : this.transferPreviews.captureOwner(transfer.profileId, friendNumber));
    const pump = this.pumpIncomingTransfer(transfer, owner)
      .then(() => {})
      .catch(async (error) => {
        if (transferFailureCode(error) === "TRANSFER_CANCELLED") {
          await this.removeTransferCache(transfer.id).catch(() => {});
        }
        this.reportTransferPumpError(transfer.messageId, error);
      })
      .finally(() => this.transferPumps.delete(transfer.id));
    this.transferPumps.set(transfer.id, pump);
  }

  async recoverIncomingTransfer(
    profileId: string,
    messageId: string,
    transferId: string,
    friendNumber?: number,
  ) {
    if (!transferId || this.transferPumps.has(transferId)) return false;
    const previewOwner = friendNumber === undefined
      ? null
      : this.transferPreviews.captureOwner(profileId, friendNumber);
    let transfer = await this.retryTransfer(() => this.transferStatus(transferId));
    if (transfer.profileId !== profileId || transfer.messageId !== messageId) {
      throw new Error("TRANSFER_WORKSPACE_BOUNDARY");
    }
    if (["cancelled", "failed"].includes(transfer.state)) {
      await this.removeTransferCache(transfer.id).catch(() => {});
      return false;
    }
    const cached = await this.readTransferCache(transfer);
    if (transfer.state === "complete") {
      if (cached && isPreviewableImage(transfer.name) && previewOwner) {
        return this.rememberTransferPreview(transfer.id, cached, previewOwner);
      }
      if (!isPreviewableImage(transfer.name)) {
        await this.removeTransferCache(transfer.id).catch(() => {});
        return true;
      }
      return false;
    }
    if (transfer.direction === "outgoing") {
      if (!cached) throw new Error("TRANSFER_BROWSER_SOURCE_UNAVAILABLE");
      if (isPreviewableImage(transfer.name) && previewOwner) {
        this.rememberTransferPreview(transfer.id, cached, previewOwner);
      }
      this.startOutgoingTransfer(transfer, cached);
      return true;
    }
    if (!["queued", "receiving", "backpressure"].includes(transfer.state)) {
      if (transfer.state === "paused") return false;
      transfer = await this.retryTransfer(() => this.command<WebTransferView>("control_tox_file_transfer", {
        profileId,
        messageId,
        action: "resume",
      }));
    }
    await this.startIncomingTransfer(transfer, friendNumber, previewOwner);
    return true;
  }

  private async transferStatus(transferId: string) {
    return this.request<WebTransferView>("/api/v1/transfers/status", {
      method: "POST",
      body: JSON.stringify({ transferId }),
    }, true);
  }

  private async pumpOutgoingTransfer(profileId: string, transferId: string, file: Blob) {
    while (true) {
      const transfer = await this.retryTransfer(() => this.transferStatus(transferId));
      if (transfer.profileId !== profileId) throw new Error("TRANSFER_WORKSPACE_BOUNDARY");
      if (transfer.state === "complete" || transfer.state === "cancelled") return transfer;
      if (transfer.state === "failed") throw new Error("TRANSFER_FAILED");
      if (transfer.state === "paused" || transfer.state === "queued" || transfer.state === "starting") {
        await wait(250);
        continue;
      }
      const position = transfer.requestedPosition;
      const length = transfer.requestedLength;
      if (position == null || length == null || length <= 0) {
        await wait(Math.max(50, transfer.retryAfterMs || 0));
        continue;
      }
      if (position + length > file.size) throw new Error("TRANSFER_CHUNK_RANGE_INVALID");
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
      });
      if (response.status === 409 && result?.code === "TRANSFER_CHUNK_STALE") continue;
      if ((result?.retryAfterMs ?? 0) > 0) await wait(result?.retryAfterMs ?? 0);
    }
  }

  private async pumpIncomingTransfer(
    initial: WebTransferView,
    previewOwner: TransferPreviewOwnerLease | null,
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
        temporaryName = this.transferCacheName(transfer.id);
        handle = await root.getFileHandle(temporaryName, { create: true });
        let partial = await handle.getFile();
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
        // A browser may have written the final bytes immediately before a
        // reload or before an ACK response was lost. The OPFS length alone is
        // therefore not a commit marker: keep draining/replaying server
        // chunks until the backend confirms that every byte was acknowledged.
        if (incomingBrowserCommitComplete(received, transfer.sizeBytes, transfer.acknowledgedBytes)) break;
        const response = await this.retryTransfer(async () => {
          const response = await this.fetchResponse("/api/v1/transfers/download", {
            method: "POST",
            body: JSON.stringify({ transferId: transfer.id }),
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
        });
        if (response.status === 200) {
          const position = Number(response.headers.get("X-Kaigen-Transfer-Position") ?? "NaN");
          const bytes = await response.arrayBuffer();
          const end = position + bytes.byteLength;
          if (!bytes.byteLength || !Number.isSafeInteger(position) || position < 0 || !Number.isSafeInteger(end) || end > transfer.sizeBytes) {
            throw new Error("TRANSFER_CHUNK_RANGE_INVALID");
          }
          if (position > received) throw new Error("TRANSFER_CHUNK_GAP");
          const overlap = Math.min(received - position, bytes.byteLength);
          const freshBytes = overlap > 0 ? bytes.slice(overlap) : bytes;
          if (freshBytes.byteLength) {
            const freshPosition = received;
            if (handle) {
              // createWritable commits its replacement file only on close.
              // Close every downloaded range before ACK so a reload can never
              // leave the server ahead of the durable OPFS prefix.
              const checkpoint = await handle.createWritable({ keepExistingData: true });
              try {
                await checkpoint.write({ type: "write", position: freshPosition, data: freshBytes });
                await checkpoint.close();
              } catch (error) {
                await checkpoint.abort().catch(() => {});
                throw error;
              }
            } else {
              if (transfer.sizeBytes > 512 * 1024 * 1024) throw new Error("TRANSFER_BROWSER_STORAGE_REQUIRED");
              chunks.push({ position: freshPosition, bytes: freshBytes });
            }
            received += freshBytes.byteLength;
          }
          transfer = await this.retryTransfer(() => this.command<WebTransferView>("acknowledge_web_incoming_chunk", {
            profileId: transfer.profileId,
            transferId: transfer.id,
            through: end,
          }));
          if (transfer.acknowledgedBytes > received || transfer.acknowledgedBytes > transfer.sizeBytes) {
            throw new Error("TRANSFER_ACK_RANGE_INVALID");
          }
        }
        if (response.status === 204) transfer = await this.retryTransfer(() => this.transferStatus(transfer.id));
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
      if (blob.size !== transfer.sizeBytes) throw new Error("TRANSFER_SIZE_MISMATCH");
      transfer = await this.retryTransfer(() => this.command<WebTransferView>("complete_web_incoming_transfer", {
        profileId: transfer.profileId,
        transferId: transfer.id,
      }));
      if (isPreviewableImage(transfer.name) && previewOwner) {
        this.rememberTransferPreview(transfer.id, blob, previewOwner);
      }
      triggerDownload(blob, safeDownloadName(transfer.name));
      if (!isPreviewableImage(transfer.name)) await this.removeTransferCache(transfer.id).catch(() => {});
      return transfer;
    } catch (error) {
      const code = transferFailureCode(error);
      const discard = [
        "TRANSFER_ACK_RANGE_INVALID",
        "TRANSFER_CANCELLED",
        "TRANSFER_CHUNK_GAP",
        "TRANSFER_CHUNK_RANGE_INVALID",
        "TRANSFER_FAILED",
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
    const workspaceDigest = await this.workspaceDigest();
    if (!this.realtimeActive || !this.csrfToken || this.hasLiveSocket()) return;
    const scheme = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${scheme}//${location.host}/ws/v1?build=${encodeURIComponent(WEB_BUILD_ID)}`, ["kaigen.v1", `${WORKSPACE_PROTOCOL_PREFIX}${workspaceDigest}`]);
    this.socket = socket;
    socket.onmessage = (event) => {
      try {
        this.dispatch(JSON.parse(String(event.data)) as WebEvent);
      } catch {
        // Invalid server events are ignored without exposing payloads to logs.
      }
    };
    socket.onclose = () => {
      if (this.socket === socket) this.socket = null;
      window.clearTimeout(this.reconnectTimer);
      if (!this.realtimeActive) return;
      const scheduleReconnect = () => {
        if (!this.upgradeRequired && this.realtimeActive) {
          this.reconnectTimer = window.setTimeout(() => void this.connectSocket(), 2000);
        }
      };
      void this.verifyBuildIdentity().then(scheduleReconnect, scheduleReconnect);
    };
  }

  private startRealtime() {
    if (this.upgradeRequired) return;
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
