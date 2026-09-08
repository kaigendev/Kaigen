export const TRANSFER_PREVIEW_TTL_MS = 2 * 60 * 60 * 1000;
export const TRANSFER_PREVIEW_MAX_ENTRIES = 64;
export const TRANSFER_PREVIEW_MAX_BYTES = 128 * 1024 * 1024;

type PreviewOwner = Readonly<{
  profileId: string;
  friendNumber: number;
}>;

export type TransferPreviewOwnerLease = PreviewOwner & Readonly<{
  registryEpoch: number;
  ownerGeneration: number;
}>;

type PreviewEntry = PreviewOwner & {
  transferId: string;
  url: string;
  bytes: number;
  lastUsedAt: number;
  expiresAt: number | null;
};

type PreviewRegistryOptions = Readonly<{
  ttlMs?: number;
  maxEntries?: number;
  maxBytes?: number;
  now?: () => number;
  createObjectURL?: (blob: Blob) => string;
  revokeObjectURL?: (url: string) => void;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancel?: (timer: unknown) => void;
  onInvalidate?: (preview: PreviewOwner & { transferId: string }) => void;
}>;

const TRANSFER_ID_PATTERN = /^[A-Za-z0-9_-]{32}$/u;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

function checkedOwner(profileId: string, friendNumber: number): PreviewOwner {
  if (!profileId.trim() || !Number.isSafeInteger(friendNumber) || friendNumber < 0) {
    throw new Error("TRANSFER_PREVIEW_OWNER_INVALID");
  }
  return { profileId, friendNumber };
}

function ownerKey(owner: PreviewOwner) {
  return `${owner.profileId.length}:${owner.profileId}:${owner.friendNumber}`;
}

function previewKey(owner: PreviewOwner, transferId: string) {
  return `${ownerKey(owner)}:${transferId}`;
}

/** Owns the short-lived Blob URLs only. Durable file bytes remain in OPFS. */
export class TransferPreviewRegistry {
  private readonly entries = new Map<string, PreviewEntry>();
  private readonly activeOwners = new Set<string>();
  private readonly pinnedTransfers = new Map<string, Set<string>>();
  private readonly ownerGenerations = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly now: () => number;
  private readonly createObjectURL: (blob: Blob) => string;
  private readonly revokeObjectURL: (url: string) => void;
  private readonly schedule: (callback: () => void, delayMs: number) => unknown;
  private readonly cancel: (timer: unknown) => void;
  private readonly onInvalidate: (preview: PreviewOwner & { transferId: string }) => void;
  private timer: unknown = null;
  private bytes = 0;
  private registryEpoch = 1;

  constructor(options: PreviewRegistryOptions = {}) {
    this.ttlMs = Math.max(1, Math.floor(options.ttlMs ?? TRANSFER_PREVIEW_TTL_MS));
    this.maxEntries = Math.max(1, Math.floor(options.maxEntries ?? TRANSFER_PREVIEW_MAX_ENTRIES));
    this.maxBytes = Math.max(1, Math.floor(options.maxBytes ?? TRANSFER_PREVIEW_MAX_BYTES));
    this.now = options.now ?? Date.now;
    this.createObjectURL = options.createObjectURL ?? ((blob) => URL.createObjectURL(blob));
    this.revokeObjectURL = options.revokeObjectURL ?? ((url) => URL.revokeObjectURL(url));
    this.schedule = options.schedule ?? ((callback, delayMs) => window.setTimeout(callback, delayMs));
    this.cancel = options.cancel ?? ((timer) => window.clearTimeout(timer as number));
    this.onInvalidate = options.onInvalidate ?? (() => {});
  }

  get entryCount() {
    return this.entries.size;
  }

  get retainedBytes() {
    return this.bytes;
  }

  captureOwner(profileId: string, friendNumber: number): TransferPreviewOwnerLease {
    const owner = checkedOwner(profileId, friendNumber);
    const key = ownerKey(owner);
    const ownerGeneration = this.ownerGenerations.get(key) ?? 1;
    this.ownerGenerations.set(key, ownerGeneration);
    return { ...owner, registryEpoch: this.registryEpoch, ownerGeneration };
  }

  remember(transferId: string, blob: Blob, lease: TransferPreviewOwnerLease) {
    if (!TRANSFER_ID_PATTERN.test(transferId)) throw new Error("TRANSFER_ID_INVALID");
    if (!Number.isSafeInteger(blob.size) || blob.size < 0) throw new Error("TRANSFER_PREVIEW_SIZE_INVALID");
    const owner = checkedOwner(lease.profileId, lease.friendNumber);
    const key = ownerKey(owner);
    if (lease.registryEpoch !== this.registryEpoch
      || lease.ownerGeneration !== (this.ownerGenerations.get(key) ?? 1)) return "";
    const storageKey = previewKey(owner, transferId);
    const previous = this.entries.get(storageKey);

    const now = this.now();
    const url = this.createObjectURL(blob);
    if (previous) {
      this.bytes = Math.max(0, this.bytes - previous.bytes);
      this.revokeObjectURL(previous.url);
      this.onInvalidate(previous);
    }
    this.entries.set(storageKey, {
      ...owner,
      transferId,
      url,
      bytes: blob.size,
      lastUsedAt: now,
      expiresAt: this.activeOwners.has(key) ? null : now + this.ttlMs,
    });
    this.bytes += blob.size;
    this.sweep(now);
    return this.entries.get(storageKey)?.url ?? "";
  }

  source(profileId: string, friendNumber: number, transferId: string) {
    if (!TRANSFER_ID_PATTERN.test(transferId)) return "";
    const owner = checkedOwner(profileId, friendNumber);
    const now = this.now();
    const entry = this.entries.get(previewKey(owner, transferId));
    if (!entry) return "";
    // This lookup runs while React creates a message snapshot. Expiration is
    // enforced by the scheduled sweep; never dispatch invalidation from a
    // render-time source lookup.
    if (entry.expiresAt !== null && entry.expiresAt <= now && !this.activeOwners.has(ownerKey(owner))) return "";
    entry.lastUsedAt = now;
    return entry.url;
  }

  setOwnerActive(profileId: string, friendNumber: number, active: boolean) {
    const owner = checkedOwner(profileId, friendNumber);
    const key = ownerKey(owner);
    const now = this.now();
    if (active) {
      if (!this.ownerGenerations.has(key)) this.ownerGenerations.set(key, 1);
      this.activeOwners.add(key);
      for (const entry of this.entries.values()) {
        if (ownerKey(entry) !== key) continue;
        entry.expiresAt = null;
      }
    } else {
      const wasActive = this.activeOwners.delete(key);
      this.pinnedTransfers.delete(key);
      if (wasActive) {
        for (const entry of this.entries.values()) {
          if (ownerKey(entry) === key && entry.expiresAt === null) entry.expiresAt = now + this.ttlMs;
        }
      }
    }
    this.sweep(now);
  }

  setPins(profileId: string, friendNumber: number, transferIds: Iterable<string>) {
    const owner = checkedOwner(profileId, friendNumber);
    const key = ownerKey(owner);
    const pins = new Set<string>();
    for (const transferId of transferIds) {
      if (TRANSFER_ID_PATTERN.test(transferId)) pins.add(transferId);
      if (pins.size >= this.maxEntries) break;
    }
    if (pins.size) this.pinnedTransfers.set(key, pins);
    else this.pinnedTransfers.delete(key);
    this.sweep(this.now());
  }

  releaseOwner(profileId: string, friendNumber: number, force = false) {
    const owner = checkedOwner(profileId, friendNumber);
    const key = ownerKey(owner);
    if (this.activeOwners.has(key) && !force) return 0;
    if (force) {
      this.activeOwners.delete(key);
      this.ownerGenerations.set(key, (this.ownerGenerations.get(key) ?? 1) + 1);
    }
    this.pinnedTransfers.delete(key);
    const entries = [...this.entries.values()].filter((entry) => ownerKey(entry) === key);
    for (const entry of entries) this.remove(entry);
    this.reschedule(this.now());
    return entries.length;
  }

  releaseProfile(profileId: string) {
    if (!profileId.trim()) throw new Error("TRANSFER_PREVIEW_OWNER_INVALID");
    const prefix = `${profileId.length}:${profileId}:`;
    for (const key of [...this.activeOwners]) {
      if (key.startsWith(prefix)) this.activeOwners.delete(key);
    }
    for (const key of [...this.pinnedTransfers.keys()]) {
      if (key.startsWith(prefix)) this.pinnedTransfers.delete(key);
    }
    for (const [key, generation] of this.ownerGenerations) {
      if (key.startsWith(prefix)) this.ownerGenerations.set(key, generation + 1);
    }
    const entries = [...this.entries.values()].filter((entry) => entry.profileId === profileId);
    for (const entry of entries) this.remove(entry);
    this.reschedule(this.now());
    return entries.length;
  }

  clear() {
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null;
    for (const entry of this.entries.values()) {
      this.revokeObjectURL(entry.url);
      this.onInvalidate(entry);
    }
    this.entries.clear();
    this.activeOwners.clear();
    this.pinnedTransfers.clear();
    this.ownerGenerations.clear();
    this.bytes = 0;
    this.registryEpoch += 1;
  }

  sweep(now = this.now()) {
    for (const entry of [...this.entries.values()]) {
      if (entry.expiresAt !== null
        && entry.expiresAt <= now
        && !this.activeOwners.has(ownerKey(entry))) {
        this.remove(entry);
      }
    }
    if (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      const evictable = [...this.entries.values()]
        .filter((entry) => !this.isPinned(entry))
        .sort((left, right) => left.lastUsedAt - right.lastUsedAt || left.transferId.localeCompare(right.transferId));
      for (const entry of evictable) {
        if (this.entries.size <= this.maxEntries && this.bytes <= this.maxBytes) break;
        this.remove(entry);
      }
    }
    this.reschedule(now);
  }

  private remove(entry: PreviewEntry) {
    const key = previewKey(entry, entry.transferId);
    if (this.entries.get(key) !== entry) return;
    this.entries.delete(key);
    this.bytes = Math.max(0, this.bytes - entry.bytes);
    this.revokeObjectURL(entry.url);
    this.onInvalidate(entry);
  }

  private isPinned(entry: PreviewEntry) {
    const key = ownerKey(entry);
    return this.activeOwners.has(key) && this.pinnedTransfers.get(key)?.has(entry.transferId) === true;
  }

  private reschedule(now: number) {
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null;
    let earliest = Number.POSITIVE_INFINITY;
    for (const entry of this.entries.values()) {
      if (entry.expiresAt !== null && !this.activeOwners.has(ownerKey(entry))) {
        earliest = Math.min(earliest, entry.expiresAt);
      }
    }
    if (!Number.isFinite(earliest)) return;
    const delay = Math.max(0, Math.min(MAX_TIMER_DELAY_MS, earliest - now));
    this.timer = this.schedule(() => {
      this.timer = null;
      this.sweep(this.now());
    }, delay);
  }
}
