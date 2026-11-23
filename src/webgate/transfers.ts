import { MAX_CHAT_FILE_BYTES } from "../fileReceiveSettings";
import type { WebTransferView } from "../web/session";
import { outgoingUploadRange, retryTransferOperation, transferFailureCode, transferPayloadSha256, verifyTransferPayload } from "../web/transferPump";
import { TransferPreviewRegistry, type TransferPreviewOwnerLease } from "../web/transferPreviewRegistry";
import { EncryptedFileCache, WEBGATE_FILE_CHUNK_BYTES } from "./encryptedFileCache";

export type WebgateFileOperation = "start" | "chunk" | "finish" | "status" | "cancel" | "snapshot";
export type WebgateTransferIntent = "automatic" | "preview" | "download" | "open-video";
export type WebgateTransfersOptions = {
  /** Desktop saves verified replicas to normal Downloads before durable ACK. */
  persistentReplica: boolean;
  call: (profileId: string, operation: WebgateFileOperation, args: Record<string, unknown>) => Promise<unknown>;
  subscribe: (profileId: string, wake: () => void) => () => void;
  download: (blob: Blob, name: string, profileId: string, transferId: string, transfer: WebTransferView, expectedBinding: string | undefined) => Promise<void>;
  downloadBinding?: (profileId: string) => string | undefined;
  hasLocalDownload?: (profileId: string, transfer: WebTransferView, expectedBinding: string | undefined) => Promise<boolean>;
  remoteProfileId?: (profileId: string) => string | null | undefined;
  onChange?: (profileId: string, transferId: string) => void;
  onError?: (profileId: string, messageId: string, error: unknown) => void;
};

const PREFIX = "browser-stream://";
const ID = /^[A-Za-z0-9_-]{32}$/u;
const HASH = /^[A-Za-z0-9_-]{43}$/u;
const PUSH_RETRY = new Set(["TRANSFER_CHUNK_NOT_REQUESTED", "TRANSFER_CHUNK_REJECTED", "TRANSFER_NOT_STARTED",
  "TRANSFER_REMOTE_NOT_COMPLETE", "TRANSFER_BROWSER_NOT_COMPLETE", "WEBGATE_TOR_REQUIRED",
  "WEBGATE_PROFILE_OFFLINE", "WEBGATE_PROFILE_CONNECTING"]);
const TERMINAL = new Set(["WEBGATE_CLOSED", "WEBGATE_SESSION_REVOKED", "SESSION_REVOKED", "AUTH_INVALID",
  "WEBGATE_AUTH_INVALID", "WEBGATE_ACCOUNT_IDENTITY_CHANGED", "WEBGATE_CERTIFICATE_CHANGED",
  "WEBGATE_PROXY_INVALID", "WEBGATE_PROXY_UNSUPPORTED", "WEBGATE_PROXY_AUTH_FAILED", "WEBGATE_ADDRESS_DENIED",
  "WEBGATE_PROFILE_NOT_FOUND", "WEBGATE_PROFILE_LOCKED", "PROFILE_IDENTITY_CHANGED", "WORKSPACE_CLOSED", "WORKSPACE_LOCKED",
  "TRANSFER_REPLICATION_RANGE_INCOMPLETE"]);

class WakeSignal {
  version = 0;
  private readonly waiters = new Set<() => void>();
  wake() { this.version += 1; for (const finish of [...this.waiters]) finish(); }
  wait(after: number, delay?: number) {
    if (this.version !== after) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = () => { if (timer !== undefined) clearTimeout(timer); this.waiters.delete(finish); resolve(); };
      this.waiters.add(finish);
      if (delay !== undefined) timer = setTimeout(finish, delay);
      if (this.version !== after) finish();
    });
  }
}

type Profile = {
  id: string; remoteId: string | null; downloadBinding: string | undefined; closed: boolean; signal: WakeSignal; unsubscribe: () => void;
  sources: Map<string, string>; outgoing: Map<string, Promise<void>>;
  sourcePins: Map<string, () => void>; receipts: Set<string>;
  tracked: boolean; replication: Promise<void> | null; capacityBlocked: boolean;
  downloaded: Set<string>; saved: Set<string>; replicated: Set<string>;
  copies: Map<string, Promise<{ blob: Blob; transfer: WebTransferView }>>;
  recoveries: Map<string, Promise<void>>; downloads: Map<string, Promise<void>>;
};

/** Platform adapters inject transport/save operations; this module never imports @platform. */
export class WebgateTransfers {
  private readonly profiles = new Map<string, Profile>();
  private readonly cache = new EncryptedFileCache();
  private readonly previews: TransferPreviewRegistry;

  constructor(private readonly options: WebgateTransfersOptions) {
    this.previews = new TransferPreviewRegistry({ onInvalidate: ({ profileId, friendNumber, transferId }) => {
      window.dispatchEvent(new CustomEvent("kaigen:transfer-preview-invalidated", { detail: { profileId, friendNumber, transferId } }));
      options.onChange?.(profileId, transferId);
    } });
  }

  async sendFile(profileId: string, friendNumber: number, file: File, expectedPublicKey: string, expectedContactIncarnation?: number): Promise<number> {
    if (!/^[0-9A-F]{64}$/i.test(expectedPublicKey)) throw new Error("CHAT_CONTACT_IDENTITY_CHANGED");
    const profile = this.profile(profileId);
    if (!Number.isSafeInteger(friendNumber) || friendNumber < 0) throw new Error("TRANSFER_PROFILE_MISMATCH");
    if (!file.size) throw new Error("TRANSFER_EMPTY_FILE");
    if (file.size > MAX_CHAT_FILE_BYTES) throw new Error("TRANSFER_FILE_TOO_LARGE");
    const owner = this.previews.captureOwner(profileId, friendNumber);
    const operationId = encode(crypto.getRandomValues(new Uint8Array(24))).replace(/\+/gu, "-").replace(/\//gu, "_");
    const digest = await transferPayloadSha256(file);
    this.active(profile);
    // Stage source ciphertext before opening a transfer. The operation ID also
    // binds this pre-server staging object's AAD and survives a lost start reply.
    this.cache.create(profileId, operationId, file.size, file.type);
    const release = this.cache.pin(profileId, operationId);
    let transferred = false;
    try {
      for (let position = 0; position < file.size; position += WEBGATE_FILE_CHUNK_BYTES) {
        const bytes = new Uint8Array(await file.slice(position, position + WEBGATE_FILE_CHUNK_BYTES).arrayBuffer());
        try { this.active(profile); await this.cache.append(profileId, operationId, position, bytes); }
        finally { bytes.fill(0); }
      }
      this.cache.markVerified(profileId, operationId, digest);
      const transfer = this.view(await this.rpc(profile, "start", { operationId, friendNumber, expectedPublicKey, expectedContactIncarnation,
        filename: file.name, mime: file.type || "application/octet-stream", sizeBytes: file.size, sha256: digest }), profile);
      if (transfer.direction !== "outgoing" || transfer.operationId !== operationId) throw new Error("TRANSFER_WORKSPACE_BOUNDARY");
      if (transfer.sizeBytes !== file.size) throw new Error("TRANSFER_SIZE_MISMATCH");
      if (transfer.payloadSha256 && transfer.payloadSha256 !== digest) throw new Error("TRANSFER_HASH_MISMATCH");
      profile.sources.set(transfer.id, operationId);
      if (image(file.name)) this.remember(transfer.id, file, owner);
      this.startOutgoing(profile, transfer, operationId, digest, release);
      transferred = true;
      return 0;
    } finally { if (!transferred) { release(); this.cache.remove(profileId, operationId); } }
  }

  async recoverIncomingTransfer(profileId: string, messageId: string, transferId: string, friendNumber?: number,
    intent: "automatic" | "preview" = "preview"): Promise<boolean> {
    const profile = this.profile(profileId);
    checkedId(transferId);
    const key = `${transferId}:${intent}`;
    if (profile.recoveries.has(key)) return false;
    const owner = friendNumber === undefined ? null : this.previews.captureOwner(profileId, friendNumber);
    const recovery = Promise.resolve().then(async () => {
      const transfer = await this.status(profile, transferId);
      if (transfer.messageId !== messageId) throw new Error("TRANSFER_WORKSPACE_BOUNDARY");
      if (transfer.direction === "outgoing" && !transfer.payloadCommitted) {
        const source = profile.sources.get(transferId);
        if (source && this.cache.has(profileId, source)) {
          const digest = this.cache.hash(profileId, source);
          if (digest) this.startOutgoing(profile, transfer, source, digest, this.cache.pin(profileId, source));
        }
        return;
      }
      // An automatic background pass must not duplicate an outgoing copy/save.
      if (intent === "automatic" && transfer.direction === "outgoing") return;
      const copied = await this.copy(profile, transfer);
      this.active(profile);
      if (owner && image(copied.transfer.name)) this.remember(transferId, copied.blob, owner);
    }).catch((error) => this.report(profileId, messageId, error)).finally(() => {
      if (profile.recoveries.get(key) === recovery) profile.recoveries.delete(key);
    });
    profile.recoveries.set(key, recovery);
    return true;
  }

  async originalBlob(profileId: string, messageId: string, transferId: string, signal?: AbortSignal, direction: WebTransferView["direction"] = "incoming"): Promise<Blob> {
    signal?.throwIfAborted();
    const profile = this.profile(profileId);
    checkedId(transferId);
    const transfer = await this.status(profile, transferId);
    if (transfer.messageId !== messageId || transfer.direction !== direction || !transfer.payloadCommitted) {
      throw new Error("TRANSFER_WORKSPACE_BOUNDARY");
    }
    const copied = await this.copy(profile, transfer);
    this.active(profile);
    signal?.throwIfAborted();
    return copied.blob;
  }

  async downloadTransfer(profileId: string, messageId: string, transferId: string, friendNumber?: number,
    intent: "download" | "open-video" = "download"): Promise<void> {
    const profile = this.profile(profileId);
    checkedId(transferId);
    const key = `${transferId}:${intent}`;
    const previous = profile.downloads.get(key);
    if (previous) return previous;
    const owner = friendNumber === undefined ? null : this.previews.captureOwner(profileId, friendNumber);
    const work = Promise.resolve().then(async () => {
      const transfer = await this.status(profile, transferId);
      if (transfer.messageId !== messageId) throw new Error("TRANSFER_WORKSPACE_BOUNDARY");
      if (intent === "open-video" && (!owner || !/\.(?:mov|mp4)$/iu.test(transfer.name))) {
        throw new Error("TRANSFER_VIDEO_PREVIEW_UNSUPPORTED");
      }
      const copied = await this.copy(profile, transfer);
      this.active(profile);
      if (intent === "download") {
        await this.options.download(copied.blob, safeName(copied.transfer.name), profileId, transferId, copied.transfer, profile.downloadBinding);
        this.active(profile);
        if (this.options.persistentReplica) {
          profile.saved.add(replicaKey(copied.transfer));
          await this.replicate(profile, copied.transfer);
        }
      } else if (owner) {
        const mime = /\.mov$/iu.test(copied.transfer.name) ? "video/quicktime" : "video/mp4";
        this.remember(transferId, copied.blob.slice(0, copied.blob.size, mime), owner);
      }
    }).finally(() => { if (profile.downloads.get(key) === work) profile.downloads.delete(key); });
    profile.downloads.set(key, work);
    return work;
  }

  preview(path: string, profileId: string, friendNumber: number) {
    return path.startsWith(PREFIX) ? this.previews.source(profileId, friendNumber, path.slice(PREFIX.length)) : "";
  }
  setPreviewChatActive(profileId: string, friendNumber: number, active: boolean) {
    this.previews.setOwnerActive(profileId, friendNumber, active);
    // Plaintext Blob URLs belong to the live view. Ciphertext survives this
    // release and is decrypted again only when that view requests a preview.
    if (!active) this.previews.releaseOwner(profileId, friendNumber, true);
  }
  setPreviewPins(profileId: string, friendNumber: number, paths: Iterable<string>) {
    this.previews.setPins(profileId, friendNumber, [...paths].flatMap((path) => path.startsWith(PREFIX) ? [path.slice(PREFIX.length)] : []));
  }
  releasePreviews(profileId: string, friendNumber: number, force = false) { return this.previews.releaseOwner(profileId, friendNumber, force); }
  releaseProfilePreviews(profileId: string) { return this.previews.releaseProfile(profileId); }

  clearProfile(profileId: string) {
    const profile = this.profiles.get(profileId);
    if (profile) {
      profile.closed = true; profile.signal.wake();
      try { profile.unsubscribe(); } catch { /* Cleanup must still erase keys. */ }
      for (const release of profile.sourcePins.values()) release();
      profile.sourcePins.clear();
      this.profiles.delete(profileId);
    }
    this.cache.clearProfile(profileId);
    this.previews.releaseProfile(profileId);
  }
  clear() { for (const id of [...this.profiles.keys()]) this.clearProfile(id); this.cache.clear(); this.previews.clear(); }

  /** Subscribe before the first snapshot. Background profiles use this too. */
  trackProfile(profileId: string) {
    const profile = this.profile(profileId);
    profile.tracked = true;
    this.scheduleReplication(profile);
  }

  private profile(id: string) {
    const previous = this.profiles.get(id);
    if (previous) return previous;
    this.cache.open(id);
    const profile: Profile = { id, remoteId: this.options.remoteProfileId?.(id) ?? null,
      downloadBinding: this.options.downloadBinding?.(id), closed: false, signal: new WakeSignal(),
      unsubscribe: () => {}, sources: new Map(), sourcePins: new Map(), receipts: new Set(),
      tracked: false, replication: null, capacityBlocked: false, downloaded: new Set(), saved: new Set(), replicated: new Set(),
      outgoing: new Map(), copies: new Map(), recoveries: new Map(), downloads: new Map() };
    this.profiles.set(id, profile);
    try { profile.unsubscribe = this.options.subscribe(id, () => {
      profile.signal.wake();
      if (profile.tracked) this.scheduleReplication(profile);
    }); }
    catch (error) { this.clearProfile(id); throw error; }
    return profile;
  }

  private active(profile: Profile) {
    if (profile.closed || this.profiles.get(profile.id) !== profile) throw new Error("TRANSFER_PUMP_STOPPED");
    const current = this.options.remoteProfileId?.(profile.id);
    if (current && profile.remoteId && current !== profile.remoteId) throw new Error("TRANSFER_WORKSPACE_BOUNDARY");
  }

  private async rpc(profile: Profile, operation: WebgateFileOperation, args: Record<string, unknown>) {
    let fatal: unknown;
    let push = false;
    let version = profile.signal.version;
    try {
      return await retryTransferOperation(async () => {
        this.active(profile);
        version = profile.signal.version;
        try { const result = await this.options.call(profile.id, operation, args); this.active(profile); return result; }
        catch (error) {
          const code = transferFailureCode(error);
          if (TERMINAL.has(code) || code === "TRANSFER_CHUNK_STALE" || code === "TRANSFER_WORKSPACE_BOUNDARY") fatal = error;
          push = PUSH_RETRY.has(code);
          throw error;
        }
      }, { active: () => !profile.closed && fatal === undefined,
        wait: (delay) => profile.signal.wait(version, push ? undefined : delay) });
    } catch (error) { throw fatal ?? error; }
  }

  private view(raw: unknown, profile: Profile, initial?: WebTransferView): WebTransferView {
    this.active(profile);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("TRANSFER_STATE_UNAVAILABLE");
    const value = raw as WebTransferView;
    checkedId(value.id);
    if (typeof value.profileId !== "string" || !value.profileId || typeof value.messageId !== "string" || !value.messageId
      || !["incoming", "outgoing"].includes(value.direction) || typeof value.name !== "string" || typeof value.mime !== "string"
      || typeof value.state !== "string" || typeof value.payloadCommitted !== "boolean" || typeof value.downloadAvailable !== "boolean"
      || !Number.isSafeInteger(value.sizeBytes) || value.sizeBytes <= 0 || value.sizeBytes > MAX_CHAT_FILE_BYTES
      || !Number.isSafeInteger(value.uploadedBytes) || value.uploadedBytes < 0 || value.uploadedBytes > value.sizeBytes
      || (value.payloadSha256 !== null && !HASH.test(value.payloadSha256))) throw new Error("TRANSFER_STATE_UNAVAILABLE");
    profile.remoteId ??= value.profileId;
    if (profile.remoteId !== value.profileId || (initial && (value.id !== initial.id || value.messageId !== initial.messageId
      || value.profileId !== initial.profileId || value.direction !== initial.direction || value.operationId !== initial.operationId))) {
      throw new Error("TRANSFER_WORKSPACE_BOUNDARY");
    }
    if (initial && value.sizeBytes !== initial.sizeBytes) throw new Error("TRANSFER_SIZE_MISMATCH");
    if (initial?.payloadSha256 && value.payloadSha256 !== initial.payloadSha256) throw new Error("TRANSFER_HASH_MISMATCH");
    return value;
  }

  private async status(profile: Profile, id: string, initial?: WebTransferView) {
    checkedId(id);
    const view = this.view(await this.rpc(profile, "status", { transferId: id }), profile, initial);
    if (view.id !== id) throw new Error("TRANSFER_WORKSPACE_BOUNDARY");
    return view;
  }

  private startOutgoing(profile: Profile, initial: WebTransferView, source: string, digest: string, release: () => void) {
    if (profile.outgoing.has(initial.id)) { release(); return; }
    if (profile.sourcePins.has(initial.id)) release();
    else profile.sourcePins.set(initial.id, release);
    const unpin = () => { profile.sourcePins.get(initial.id)?.(); profile.sourcePins.delete(initial.id); };
    const work = this.upload(profile, initial, source, digest).then(unpin).catch((error) => {
      // A failed/paused transport must not evict the only source of an upload
      // which has not committed remotely. Reconnect reuses this exact ciphertext.
      if (["TRANSFER_CANCELLED", "TRANSFER_FAILED"].includes(transferFailureCode(error))) {
        unpin(); this.cache.remove(profile.id, source); profile.sources.delete(initial.id);
      }
      this.report(profile.id, initial.messageId, error);
    }).finally(() => { if (profile.outgoing.get(initial.id) === work) profile.outgoing.delete(initial.id); });
    profile.outgoing.set(initial.id, work);
  }

  private async upload(profile: Profile, initial: WebTransferView, source: string, digest: string) {
    // Capture before the request: an event received while its response is in
    // flight must wake a later wait even if that response still has old state.
    let observed = profile.signal.version;
    let transfer = await this.status(profile, initial.id, initial);
    while (true) {
      this.active(profile);
      terminalState(transfer);
      if (transfer.payloadSha256 && transfer.payloadSha256 !== digest) throw new Error("TRANSFER_HASH_MISMATCH");
      if (transfer.payloadCommitted) {
        if (transfer.uploadedBytes !== transfer.sizeBytes || transfer.payloadSha256 !== digest) throw new Error("TRANSFER_HASH_MISMATCH");
        return;
      }
      const range = outgoingUploadRange(transfer.uploadedBytes, transfer.sizeBytes);
      if (transfer.state === "paused" || !range) {
        await profile.signal.wait(observed);
        observed = profile.signal.version;
        transfer = await this.status(profile, initial.id, initial);
        continue;
      }
      const bytes = await this.cache.readRange(profile.id, source, range.position, Math.min(range.length, WEBGATE_FILE_CHUNK_BYTES));
      try {
        observed = profile.signal.version;
        transfer = this.view(await this.rpc(profile, "chunk", { transferId: initial.id, position: range.position, data: encode(bytes) }), profile, initial);
      } catch (error) {
        if (transferFailureCode(error) !== "TRANSFER_CHUNK_STALE") throw error;
        observed = profile.signal.version;
        transfer = await this.status(profile, initial.id, initial);
      } finally { bytes.fill(0); }
      if (transfer.uploadedBytes === transfer.sizeBytes && !transfer.payloadCommitted) {
        observed = profile.signal.version;
        const finished = await this.rpc(profile, "finish", { transferId: initial.id });
        if (isView(finished)) transfer = this.view(finished, profile, initial);
      }
    }
  }

  private copy(profile: Profile, initial: WebTransferView, forceNetwork = false): Promise<{ blob: Blob; transfer: WebTransferView }> {
    const existing = profile.copies.get(initial.id);
    if (existing) return forceNetwork
      ? existing.catch(() => {}).then(() => this.copy(profile, initial, true)) : existing;
    const work = this.receive(profile, initial, forceNetwork).finally(() => { if (profile.copies.get(initial.id) === work) profile.copies.delete(initial.id); });
    profile.copies.set(initial.id, work);
    return work;
  }

  private async receive(profile: Profile, initial: WebTransferView, forceNetwork: boolean): Promise<{ blob: Blob; transfer: WebTransferView }> {
    let transfer = initial;
    const localSource = profile.sources.get(initial.id);
    if (!forceNetwork && localSource && transfer.payloadSha256) {
      const local = await this.cache.read(profile.id, localSource, transfer.payloadSha256).catch(() => null);
      this.active(profile);
      if (local) return { blob: local, transfer };
    }
    if (forceNetwork) this.cache.remove(profile.id, initial.id);
    let cached = forceNetwork ? null : await this.cache.read(profile.id, initial.id, transfer.payloadSha256).catch(() => null);
    this.active(profile);
    if (cached && transfer.payloadSha256) {
      if (!this.options.persistentReplica && transfer.direction === "incoming" && !profile.receipts.has(initial.id)) await this.receipt(profile, transfer);
      return { blob: cached, transfer };
    }
    this.cache.create(profile.id, initial.id, initial.sizeBytes, initial.mime);
    const release = this.cache.pin(profile.id, initial.id);
    try {
      let observed = profile.signal.version;
      transfer = await this.status(profile, initial.id, initial);
      while (true) {
        this.active(profile);
        terminalState(transfer);
        const received = this.cache.received(profile.id, initial.id);
        if (received === transfer.sizeBytes && transfer.payloadCommitted && transfer.payloadSha256) break;
        if (transfer.state === "paused" || !transfer.payloadCommitted || !transfer.downloadAvailable || received === transfer.sizeBytes) {
          if (transfer.payloadCommitted && !transfer.downloadAvailable) throw new Error("TRANSFER_NOT_RESUMABLE");
          await profile.signal.wait(observed);
          observed = profile.signal.version;
          transfer = await this.status(profile, initial.id, initial);
          continue;
        }
        const length = Math.min(WEBGATE_FILE_CHUNK_BYTES, transfer.sizeBytes - received);
        observed = profile.signal.version;
        const raw = await this.rpc(profile, "chunk", { transferId: initial.id, position: received, length });
        if (raw === null) {
          await profile.signal.wait(observed);
          observed = profile.signal.version;
          transfer = await this.status(profile, initial.id, initial);
          continue;
        }
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("TRANSFER_CHUNK_RANGE_INVALID");
        const chunk = raw as { position: number; data: string; transfer: unknown };
        if (chunk.position !== received) throw new Error("TRANSFER_CHUNK_GAP");
        const bytes = decode(chunk.data);
        try {
          if (!bytes.byteLength || bytes.byteLength > length) throw new Error("TRANSFER_CHUNK_RANGE_INVALID");
          transfer = this.view(chunk.transfer, profile, initial);
          await this.cache.append(profile.id, initial.id, received, bytes);
        } finally { bytes.fill(0); }
      }
      cached = await this.cache.read(profile.id, initial.id);
      if (!cached) throw new Error("TRANSFER_SIZE_MISMATCH");
      await verifyTransferPayload(cached, transfer.sizeBytes, transfer.payloadSha256);
      this.active(profile);
      this.cache.markVerified(profile.id, initial.id, transfer.payloadSha256!);
      profile.downloaded.add(replicaKey(transfer));
      if (!this.options.persistentReplica && transfer.direction === "incoming") await this.receipt(profile, transfer);
      return { blob: cached, transfer };
    } catch (error) {
      if (["TRANSFER_HASH_MISMATCH", "TRANSFER_SIZE_MISMATCH", "TRANSFER_CHUNK_GAP", "TRANSFER_CHUNK_RANGE_INVALID", "TRANSFER_CANCELLED", "TRANSFER_FAILED"]
        .includes(transferFailureCode(error))) this.cache.remove(profile.id, initial.id);
      throw error;
    } finally { release(); }
  }

  private async receipt(profile: Profile, transfer: WebTransferView) {
    while (true) {
      const version = profile.signal.version;
      const result = await this.rpc(profile, "finish", { transferId: transfer.id, sizeBytes: transfer.sizeBytes, sha256: transfer.payloadSha256 });
      if (isView(result)) {
        const confirmed = this.view(result, profile, transfer);
        if (!confirmed.payloadCommitted || confirmed.payloadSha256 !== transfer.payloadSha256) throw new Error("TRANSFER_COMPLETION_INVALID");
        profile.receipts.add(transfer.id);
        return;
      }
      if (!result || typeof result !== "object" || (result as { completion?: string }).completion !== "pending") {
        throw new Error("TRANSFER_COMPLETION_INVALID");
      }
      await profile.signal.wait(version);
      this.active(profile);
    }
  }

  private scheduleReplication(profile: Profile) {
    if (!this.options.persistentReplica || profile.closed || profile.replication) return;
    let observed = profile.signal.version;
    const work = Promise.resolve().then(async () => {
      do {
        this.active(profile);
        observed = profile.signal.version;
        const raw = await this.rpc(profile, "snapshot", {});
        if (!raw || typeof raw !== "object" || !Array.isArray((raw as { entries?: unknown }).entries)) {
          throw new Error("TRANSFER_STATE_UNAVAILABLE");
        }
        for (const item of (raw as { entries: unknown[] }).entries) {
          const transfer = this.view(item, profile);
          if (!transfer.payloadCommitted || !transfer.payloadSha256 || !transfer.downloadAvailable
            || ["cancelled", "failed"].includes(transfer.state)) continue;
          try { await this.replicate(profile, transfer); profile.capacityBlocked = false; }
          catch (error) {
            if (transferFailureCode(error) === "TRANSFER_CACHE_FULL") {
              profile.capacityBlocked = true;
              continue;
            }
            this.report(profile.id, transfer.messageId, error);
            if (profile.closed || TERMINAL.has(transferFailureCode(error))) throw error;
          }
        }
        // Events arriving during snapshot/copy/save are drained before sleeping.
      } while (!profile.closed && profile.signal.version !== observed);
    }).catch((error) => this.report(profile.id, "", error)).finally(() => {
      if (profile.replication === work) profile.replication = null;
      if (!profile.closed && profile.signal.version !== observed) this.scheduleReplication(profile);
    });
    profile.replication = work;
  }

  private async replicate(profile: Profile, transfer: WebTransferView) {
    const key = replicaKey(transfer);
    if (profile.replicated.has(key)) return;
    if (!profile.saved.has(key) && this.options.hasLocalDownload) {
      const saved = await this.options.hasLocalDownload(profile.id, transfer, profile.downloadBinding);
      this.active(profile);
      if (saved) {
        // An existing durable local receipt needs no second download. A fresh
        // server session has no range proof, so do not manufacture another ACK.
        profile.saved.add(key);
        profile.replicated.add(key);
        return;
      }
    }
    // Even the desktop which sent an outgoing file receives the retained Web
    // payload. A prior preview download can supply these verified same bytes.
    if (!profile.saved.has(key)) {
      const copied = await this.copy(profile, transfer, !profile.downloaded.has(key));
      this.active(profile);
      await this.options.download(copied.blob, safeName(transfer.name), profile.id, transfer.id, copied.transfer, profile.downloadBinding);
      this.active(profile);
      // The desktop callback returns only after the normal Downloads file
      // and its bound local receipt have been durably committed.
      // Ciphertext cache alone never reaches here.
      profile.saved.add(key);
    }
    try { await this.durableReceipt(profile, transfer); }
    catch (error) {
      if (transferFailureCode(error) !== "TRANSFER_REPLICATION_RANGE_INCOMPLETE") throw error;
      // A server/session restart may lose its range proof. Re-read and verify,
      // but do not write a second normal Downloads copy after a lost ACK.
      await this.copy(profile, transfer, true);
      await this.durableReceipt(profile, transfer);
    }
    profile.replicated.add(key);
    // A completed copy releases its cache pin. Wake only transfers which were
    // waiting for this local capacity; no timer or idle file polling is needed.
    for (const waiting of this.profiles.values()) {
      if (waiting.capacityBlocked && !waiting.closed) {
        waiting.capacityBlocked = false;
        waiting.signal.wake();
        this.scheduleReplication(waiting);
      }
    }
  }

  private async durableReceipt(profile: Profile, transfer: WebTransferView) {
    if (!this.options.persistentReplica || !profile.saved.has(replicaKey(transfer))) {
      throw new Error("TRANSFER_COMPLETION_INVALID");
    }
    const result = await this.rpc(profile, "finish", { transferId: transfer.id, sizeBytes: transfer.sizeBytes,
      sha256: transfer.payloadSha256, replicated: true, durable: true });
    const confirmed = this.view(result, profile, transfer);
    if (!confirmed.payloadCommitted || confirmed.payloadSha256 !== transfer.payloadSha256) throw new Error("TRANSFER_COMPLETION_INVALID");
  }

  private remember(id: string, blob: Blob, owner: TransferPreviewOwnerLease) {
    const url = this.previews.remember(id, blob, owner);
    if (url) { window.dispatchEvent(new CustomEvent("kaigen:transfer-preview-ready", { detail: { transferId: id } })); this.options.onChange?.(owner.profileId, id); }
  }

  private report(profileId: string, messageId: string, error: unknown) {
    if (["TRANSFER_PUMP_STOPPED", "TRANSFER_CANCELLED"].includes(transferFailureCode(error))) return;
    this.options.onError?.(profileId, messageId, error);
    window.dispatchEvent(new CustomEvent("kaigen:transfer-pump-error", { detail: { profileId, messageId, code: transferFailureCode(error) } }));
  }
}

function checkedId(id: string) { if (!ID.test(id)) throw new Error("TRANSFER_ID_INVALID"); }
function image(name: string) { return /\.(?:png|jpe?g|gif|webp)$/iu.test(name); }
function terminalState(transfer: WebTransferView) {
  if (transfer.state === "cancelled") throw new Error("TRANSFER_CANCELLED");
  if (transfer.state === "failed") throw new Error("TRANSFER_FAILED");
}
function replicaKey(transfer: WebTransferView) { return JSON.stringify([transfer.profileId, transfer.id, transfer.payloadSha256]); }
function isView(value: unknown): value is WebTransferView { return !!value && typeof value === "object" && "id" in value; }
function safeName(name: string) { return name.replace(/[\\/\u0000-\u001f\u007f]/gu, "_").replace(/[. ]+$/u, "").slice(0, 180) || "download"; }
function encode(bytes: Uint8Array) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}
function decode(value: string) {
  if (typeof value !== "string" || value.length > Math.ceil(WEBGATE_FILE_CHUNK_BYTES / 3) * 4
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) throw new Error("TRANSFER_CHUNK_RANGE_INVALID");
  try { return Uint8Array.from(atob(value), (character) => character.charCodeAt(0)); }
  catch { throw new Error("TRANSFER_CHUNK_RANGE_INVALID"); }
}

export function createWebgateTransfers(options: WebgateTransfersOptions) { return new WebgateTransfers(options); }
