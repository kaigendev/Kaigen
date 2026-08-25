import type {
  ApiErrorBody,
  CreateWorkspaceRequest,
  CreateWorkspaceResponse,
  DeviceChallenge,
  InitializerChallenge,
  SessionResponse,
  StorageMode,
  WebEvent,
  WorkspaceView,
} from "./contracts";
import { StreamingSha256 } from "./sha256-stream";

type DeviceRecord = {
  workspaceDigest: string;
  deviceId: string;
  privateKey: CryptoKey;
  publicKey: CryptoKey;
};

type EventHandler<T> = (event: { event: string; id: number; payload: T }) => void;

export type ReceivedArchive = {
  blob: Blob;
  hash: string;
  bytes: number;
  transactionId: string;
  cleanup: () => Promise<void>;
};

export type WebTransferView = {
  id: string;
  messageId: string;
  profileId: string;
  direction: "incoming" | "outgoing";
  name: string;
  mime: string;
  sizeBytes: number;
  transferredBytes: number;
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
const textEncoder = new TextEncoder();

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
  private reconnectTimer = 0;
  private realtimeActive = false;
  private eventSequence = 0;
  private sessionRefresh: Promise<WorkspaceView | null> | null = null;
  private readonly listeners = new Map<string, Set<EventHandler<unknown>>>();
  private readonly workspaceListeners = new Set<(workspace: WorkspaceView) => void>();
  private readonly transferPumps = new Map<string, Promise<void>>();

  setIdentifier(identifier: string) {
    this.identifier = identifier.trim();
  }

  getIdentifier() {
    return this.identifier;
  }

  getWorkspace() {
    return this.workspace;
  }

  onWorkspace(handler: (workspace: WorkspaceView) => void) {
    this.workspaceListeners.add(handler);
    if (this.workspace) handler(this.workspace);
    return () => {
      this.workspaceListeners.delete(handler);
    };
  }

  private setWorkspace(workspace: WorkspaceView) {
    this.workspace = workspace;
    for (const handler of this.workspaceListeners) handler(workspace);
  }

  private async fetchResponse(path: string, init: RequestInit = {}, authenticated = false) {
    const send = async () => {
      const headers = authenticated ? await this.authenticatedHeaders(init.headers) : new Headers(init.headers);
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
    return response;
  }

  private async request<T>(path: string, init: RequestInit = {}, authenticated = false): Promise<T> {
    const response = await this.fetchResponse(path, init, authenticated);
    const contentType = response.headers.get("content-type") ?? "";
    const body = contentType.includes("application/json") ? await response.json() as unknown : await response.text();
    if (!response.ok) {
      const error = body && typeof body === "object" ? body as ApiErrorBody : {};
      throw new Error(error.code ?? error.message ?? `HTTP_${response.status}`);
    }
    return body as T;
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
    profilePassword: string,
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
        const response = await fetch("/api/v1/workspaces/import/upload", {
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
        });
        if (!response.ok) {
          const body = await response.json().catch(() => null) as ApiErrorBody | null;
          throw new Error(body?.code ?? `WORKSPACE_IMPORT_HTTP_${response.status}`);
        }
      }
      const restored = await this.request<CreateWorkspaceResponse>("/api/v1/workspaces/import/finish", {
        method: "POST",
        body: JSON.stringify({
          importId: started.importId,
          archivePassword,
          profilePassword,
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
    return this.request<T>(`/api/v1/commands/${encodeURIComponent(command)}`, {
      method: "POST",
      body: JSON.stringify(normalizedJson(args)),
    }, true);
  }

  async renewLease() {
    const response = await this.request<{ workspace: WorkspaceView }>("/api/v1/workspaces/renew", { method: "POST", body: "{}" }, true);
    this.setWorkspace(response.workspace);
    return response.workspace;
  }

  async closeWorkspace() {
    const workspaceDigest = await this.workspaceDigest();
    const legacyWorkspaceDigest = await this.legacyWorkspaceDigest();
    await this.request<{ closed: boolean }>("/api/v1/workspaces/close", {
      method: "POST",
      body: "{}",
    }, true);
    this.stopRealtime();
    this.csrfToken = "";
    this.workspace = null;
    this.sessionRefresh = null;
    await deleteDeviceRecord(workspaceDigest, legacyWorkspaceDigest).catch(() => {});
  }

  async heartbeat() {
    const response = await this.request<{ workspace: WorkspaceView }>("/api/v1/lease/heartbeat", { method: "POST", body: "{}" }, true);
    this.setWorkspace(response.workspace);
  }

  async sendBrowserFile(friendNumber: number, file: File) {
    if (!file.size) throw new Error("TRANSFER_EMPTY_FILE");
    const transfer = await this.request<WebTransferView>("/api/v1/transfers/outgoing", {
      method: "POST",
      body: JSON.stringify({
        friendNumber,
        filename: file.name,
        mime: file.type || "application/octet-stream",
        sizeBytes: file.size,
      }),
    }, true);
    const pump = this.pumpOutgoingTransfer(transfer.id, file)
      .catch(async () => {
        await this.command("control_tox_file_transfer", {
          messageId: transfer.messageId,
          action: "cancel",
        }).catch(() => {});
      })
      .finally(() => this.transferPumps.delete(transfer.id));
    this.transferPumps.set(transfer.id, pump);
    return 0;
  }

  async startIncomingTransfer(transfer: WebTransferView) {
    if (transfer.direction !== "incoming" || this.transferPumps.has(transfer.id)) return;
    const pump = this.pumpIncomingTransfer(transfer)
      .catch(async () => {
        await this.command("control_tox_file_transfer", {
          messageId: transfer.messageId,
          action: "pause",
        }).catch(() => {});
      })
      .finally(() => this.transferPumps.delete(transfer.id));
    this.transferPumps.set(transfer.id, pump);
  }

  private async transferStatus(transferId: string) {
    return this.request<WebTransferView>("/api/v1/transfers/status", {
      method: "POST",
      body: JSON.stringify({ transferId }),
    }, true);
  }

  private async pumpOutgoingTransfer(transferId: string, file: File) {
    while (true) {
      const transfer = await this.transferStatus(transferId);
      if (transfer.state === "complete" || transfer.state === "cancelled") return;
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
      const response = await this.fetchResponse("/api/v1/transfers/upload", {
        method: "POST",
        body,
        headers: {
          "Content-Type": "application/octet-stream",
          "X-Kaigen-Transfer-Id": transferId,
          "X-Kaigen-Transfer-Position": String(position),
        },
        credentials: "same-origin",
        cache: "no-store",
        referrerPolicy: "no-referrer",
      }, true);
      const result = await response.json().catch(() => null) as ({ retryAfterMs?: number } & ApiErrorBody) | null;
      if (response.status === 409 && result?.code === "TRANSFER_CHUNK_STALE") continue;
      if (!response.ok) throw new Error(result?.code ?? `TRANSFER_HTTP_${response.status}`);
      if ((result?.retryAfterMs ?? 0) > 0) await wait(result?.retryAfterMs ?? 0);
    }
  }

  private async pumpIncomingTransfer(initial: WebTransferView) {
    let transfer = initial;
    let received = 0;
    const chunks: Array<{ position: number; bytes: ArrayBuffer }> = [];
    let root: FileSystemDirectoryHandle | null = null;
    let temporaryName = "";
    let writable: FileSystemWritableFileStream | null = null;
    try {
      try {
        if (navigator.storage.getDirectory) {
          root = await navigator.storage.getDirectory();
          temporaryName = `.kaigen-incoming-${transfer.id}.partial`;
          const handle = await root.getFileHandle(temporaryName, { create: true });
          writable = await handle.createWritable();
        }
      } catch {
        root = null;
        writable = null;
      }
      while (true) {
        const response = await this.fetchResponse("/api/v1/transfers/download", {
          method: "POST",
          body: JSON.stringify({ transferId: transfer.id }),
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          cache: "no-store",
          referrerPolicy: "no-referrer",
        }, true);
        if (response.status === 200) {
          const position = Number(response.headers.get("X-Kaigen-Transfer-Position") ?? "NaN");
          const bytes = await response.arrayBuffer();
          if (!Number.isSafeInteger(position) || position < 0 || position + bytes.byteLength > transfer.sizeBytes) {
            throw new Error("TRANSFER_CHUNK_RANGE_INVALID");
          }
          if (writable) {
            await writable.write({ type: "write", position, data: bytes });
          } else {
            if (transfer.sizeBytes > 512 * 1024 * 1024) throw new Error("TRANSFER_BROWSER_STORAGE_REQUIRED");
            chunks.push({ position, bytes });
          }
          received += bytes.byteLength;
        } else if (response.status !== 204) {
          const body = await response.json().catch(() => null) as ApiErrorBody | null;
          throw new Error(body?.code ?? `TRANSFER_HTTP_${response.status}`);
        }
        transfer = await this.transferStatus(transfer.id);
        if (transfer.state === "complete") break;
        if (transfer.state === "cancelled" || transfer.state === "failed") throw new Error("TRANSFER_CANCELLED");
        if (transfer.state === "paused") return;
        if (response.status === 204) await wait(75);
      }
      if (received !== transfer.sizeBytes) throw new Error("TRANSFER_SIZE_MISMATCH");
      if (writable) {
        await writable.close();
        writable = null;
      }
      let blob: Blob;
      if (root && temporaryName) {
        blob = await (await root.getFileHandle(temporaryName)).getFile();
      } else {
        chunks.sort((left, right) => left.position - right.position);
        blob = new Blob(chunks.map((chunk) => chunk.bytes), { type: transfer.mime });
      }
      triggerDownload(blob, safeDownloadName(transfer.name));
      if (root && temporaryName) window.setTimeout(() => void root?.removeEntry(temporaryName).catch(() => {}), 120_000);
    } catch (error) {
      await writable?.abort().catch(() => {});
      if (root && temporaryName) await root.removeEntry(temporaryName).catch(() => {});
      throw error;
    }
  }

  async requestArchive(password: string) {
    const response = await this.fetchResponse("/api/v1/workspaces/archive", {
      method: "POST",
      body: JSON.stringify({ password, identifier: this.identifier }),
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      cache: "no-store",
      referrerPolicy: "no-referrer",
    }, true);
    if (!response.ok) {
      const body = await response.json().catch(() => null) as ApiErrorBody | null;
      throw new Error(body?.code ?? `ARCHIVE_HTTP_${response.status}`);
    }
    const expectedHash = response.headers.get("X-Kaigen-Archive-SHA256") ?? "";
    const transactionId = response.headers.get("X-Kaigen-Archive-Transaction") ?? "";
    const expectedBytes = Number(response.headers.get("Content-Length") ?? "NaN");
    if (!expectedHash || !/^[A-Za-z0-9_-]{43}$/u.test(expectedHash)
      || !/^[A-Za-z0-9_-]{32}$/u.test(transactionId)
      || !Number.isSafeInteger(expectedBytes) || expectedBytes <= 0 || !response.body) {
      await this.cancelArchive().catch(() => {});
      throw new Error("ARCHIVE_RESPONSE_INVALID");
    }
    try {
      return await receiveArchive(response.body, expectedHash, expectedBytes, transactionId);
    } catch (error) {
      await this.cancelArchive().catch(() => {});
      throw error;
    }
  }

  async downloadProfileExport(kind: "package" | "tox", password: string) {
    const response = await this.fetchResponse(`/api/v1/profiles/export/${kind}`, {
      method: "POST",
      body: JSON.stringify({ password }),
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      cache: "no-store",
      referrerPolicy: "no-referrer",
    }, true);
    if (!response.ok) {
      const body = await response.json().catch(() => null) as ApiErrorBody | null;
      throw new Error(body?.code ?? `PROFILE_EXPORT_HTTP_${response.status}`);
    }
    if (kind === "tox") {
      const blob = await response.blob();
      if (blob.size === 0) throw new Error("PROFILE_EXPORT_EMPTY");
      triggerDownload(blob, "kaigen-profile-qtox.zip");
      return;
    }

    const expectedHash = response.headers.get("X-Kaigen-Export-SHA256") ?? "";
    const expectedBytes = Number(response.headers.get("Content-Length") ?? "NaN");
    if (!/^[A-Za-z0-9_-]{43}$/u.test(expectedHash)
      || !Number.isSafeInteger(expectedBytes) || expectedBytes <= 0 || !response.body) {
      throw new Error("PROFILE_EXPORT_RESPONSE_INVALID");
    }
    const received = await receiveArchive(
      response.body,
      expectedHash,
      expectedBytes,
      expectedHash.slice(0, 32),
    );
    triggerDownload(received.blob, "kaigen-profile.kaigen-profile");
    window.setTimeout(() => void received.cleanup(), 120_000);
  }

  async importProfile(
    file: File,
    kind: "tox" | "kai" | "package",
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

  async cancelArchive() {
    await this.request("/api/v1/workspaces/archive/cancel", {
      method: "POST",
      body: "{}",
    }, true);
  }

  async confirmErasure(archive: Pick<ReceivedArchive, "hash" | "bytes" | "transactionId">) {
    await this.request("/api/v1/workspaces/erase", {
      method: "POST",
      body: JSON.stringify({
        archiveHash: archive.hash,
        archiveBytes: archive.bytes,
        transactionId: archive.transactionId,
        explicitConfirmation: true,
      }),
    }, true);
    this.stopRealtime();
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
    if (!this.realtimeActive || !this.csrfToken || this.hasLiveSocket()) return;
    const workspaceDigest = await this.workspaceDigest();
    if (!this.realtimeActive || !this.csrfToken || this.hasLiveSocket()) return;
    const scheme = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${scheme}//${location.host}/ws/v1`, ["kaigen.v1", `${WORKSPACE_PROTOCOL_PREFIX}${workspaceDigest}`]);
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
      if (this.realtimeActive) {
        this.reconnectTimer = window.setTimeout(() => void this.connectSocket(), 2000);
      }
    };
  }

  private startRealtime() {
    this.stopRealtime();
    this.realtimeActive = true;
    void this.connectSocket();
    this.heartbeatTimer = window.setInterval(() => void this.heartbeat().catch(() => {}), 20_000);
    this.verificationTimer = window.setInterval(() => void this.restoreDeviceSession().catch(() => {}), 5 * 60_000);
  }

  private stopRealtime() {
    this.realtimeActive = false;
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

async function receiveArchive(
  stream: ReadableStream<Uint8Array>,
  expectedHash: string,
  expectedBytes: number,
  transactionId: string,
): Promise<ReceivedArchive> {
  const reader = stream.getReader();
  const hasher = new StreamingSha256();
  let bytes = 0;
  let opfsRoot: FileSystemDirectoryHandle | null = null;
  let opfsName = "";
  let writable: FileSystemWritableFileStream | null = null;
  const chunks: ArrayBuffer[] = [];
  try {
    if (navigator.storage.getDirectory) {
      opfsRoot = await navigator.storage.getDirectory();
      opfsName = `.kaigen-export-${transactionId}.partial`;
      const handle = await opfsRoot.getFileHandle(opfsName, { create: true });
      writable = await handle.createWritable();
    }
  } catch {
    opfsRoot = null;
    writable = null;
  }
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.length === 0) continue;
      bytes += value.length;
      if (bytes > expectedBytes) throw new Error("ARCHIVE_SIZE_MISMATCH");
      hasher.update(value);
      if (writable) {
        await writable.write(Uint8Array.from(value).buffer);
      } else {
        if (expectedBytes > 512 * 1024 * 1024) throw new Error("ARCHIVE_BROWSER_STORAGE_REQUIRED");
        chunks.push(Uint8Array.from(value).buffer);
      }
    }
    if (bytes !== expectedBytes) throw new Error("ARCHIVE_SIZE_MISMATCH");
    if (writable) {
      await writable.close();
      writable = null;
    }
    const actualHash = bytesToBase64Url(hasher.digest());
    if (actualHash !== expectedHash) throw new Error("ARCHIVE_HASH_MISMATCH");
    if (opfsRoot && opfsName) {
      const handle = await opfsRoot.getFileHandle(opfsName);
      const blob = await handle.getFile();
      return {
        blob,
        hash: actualHash,
        bytes,
        transactionId,
        cleanup: async () => opfsRoot?.removeEntry(opfsName).catch(() => {}),
      };
    }
    return {
      blob: new Blob(chunks, { type: "application/vnd.kaigen.workspace+encrypted" }),
      hash: actualHash,
      bytes,
      transactionId,
      cleanup: async () => {},
    };
  } catch (error) {
    await writable?.abort().catch(() => {});
    if (opfsRoot && opfsName) await opfsRoot.removeEntry(opfsName).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export const webSession = new WebSession();
