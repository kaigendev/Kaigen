import { MAX_CHAT_FILE_BYTES } from "../fileReceiveSettings";

export const WEBGATE_FILE_CHUNK_BYTES = 256 * 1024;
const encoder = new TextEncoder();

type Chunk = { position: number; length: number; iv: Uint8Array<ArrayBuffer>; ciphertext: ArrayBuffer };
type CachedFile = {
  id: string; size: number; mime: string; received: number; hash: string | null;
  chunks: Chunk[]; cipherBytes: number; pins: number; used: number;
};
type Account = { key: Promise<CryptoKey> | null; files: Map<string, CachedFile> };

/** Ciphertext only between operations. No browser database or plaintext file is written. */
export class EncryptedFileCache {
  private readonly accounts = new Map<string, Account>();
  private bytes = 0;

  constructor(private readonly maxBytes = 256 * 1024 * 1024) {}

  open(profileId: string) {
    if (!profileId) throw new Error("TRANSFER_PROFILE_MISMATCH");
    if (!this.accounts.has(profileId)) {
      this.accounts.set(profileId, {
        key: crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]),
        files: new Map(),
      });
    }
  }

  create(profileId: string, id: string, size: number, mime: string) {
    const account = this.account(profileId);
    if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_CHAT_FILE_BYTES) {
      throw new Error("TRANSFER_SIZE_INVALID");
    }
    const previous = account.files.get(id);
    if (previous) {
      if (previous.size !== size) throw new Error("TRANSFER_SIZE_MISMATCH");
      return;
    }
    account.files.set(id, { id, size, mime, received: 0, hash: null, chunks: [], cipherBytes: 0, pins: 0, used: Date.now() });
  }

  received(profileId: string, id: string) { return this.file(profileId, id).received; }
  hash(profileId: string, id: string) { return this.file(profileId, id).hash; }

  has(profileId: string, id: string) { return this.accounts.get(profileId)?.files.has(id) === true; }

  pin(profileId: string, id: string) {
    const file = this.file(profileId, id);
    file.pins += 1;
    let released = false;
    return () => { if (!released) { released = true; file.pins = Math.max(0, file.pins - 1); } };
  }

  async append(profileId: string, id: string, position: number, bytes: Uint8Array<ArrayBuffer>) {
    const account = this.account(profileId);
    const file = this.file(profileId, id);
    if (position !== file.received || !bytes.byteLength || bytes.byteLength > WEBGATE_FILE_CHUNK_BYTES
      || position + bytes.byteLength > file.size) throw new Error("TRANSFER_CHUNK_RANGE_INVALID");
    const index = file.chunks.length;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await account.key!;
    this.assertCurrent(profileId, account, file);
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv,
      additionalData: this.aad(profileId, file, index, position, bytes.byteLength) }, key, bytes);
    this.assertCurrent(profileId, account, file);
    if (position !== file.received) throw new Error("TRANSFER_CHUNK_GAP");
    this.reserve(ciphertext.byteLength, file);
    file.chunks.push({ position, length: bytes.byteLength, iv, ciphertext });
    file.received += bytes.byteLength;
    file.cipherBytes += ciphertext.byteLength;
    file.used = Date.now();
    this.bytes += ciphertext.byteLength;
  }

  async readRange(profileId: string, id: string, position: number, length: number) {
    const account = this.account(profileId);
    const file = this.file(profileId, id);
    if (!Number.isSafeInteger(position) || !Number.isSafeInteger(length) || position < 0
      || length <= 0 || length > WEBGATE_FILE_CHUNK_BYTES || position + length > file.received) {
      throw new Error("TRANSFER_CHUNK_RANGE_INVALID");
    }
    const release = this.pin(profileId, id);
    try {
      const key = await account.key!;
      this.assertCurrent(profileId, account, file);
      const result = new Uint8Array(length);
      let copied = 0;
      for (let index = 0; index < file.chunks.length; index += 1) {
        const chunk = file.chunks[index];
        const start = Math.max(position, chunk.position);
        const end = Math.min(position + length, chunk.position + chunk.length);
        if (start >= end) continue;
        const plaintext = await this.decrypt(profileId, account, file, index, key);
        result.set(plaintext.subarray(start - chunk.position, end - chunk.position), start - position);
        copied += end - start;
        plaintext.fill(0);
      }
      if (copied !== length) throw new Error("TRANSFER_CHUNK_GAP");
      return result;
    } finally { release(); }
  }

  async read(profileId: string, id: string, expectedHash: string | null = null): Promise<Blob | null> {
    const account = this.account(profileId);
    const file = account.files.get(id);
    if (!file || file.received !== file.size || (expectedHash && file.hash !== expectedHash)) return null;
    const release = this.pin(profileId, id);
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    try {
      const key = await account.key!;
      this.assertCurrent(profileId, account, file);
      for (let index = 0; index < file.chunks.length; index += 1) {
        chunks.push(await this.decrypt(profileId, account, file, index, key));
      }
      const blob = new Blob(chunks, { type: file.mime || "application/octet-stream" });
      if (blob.size !== file.size) throw new Error("TRANSFER_SIZE_MISMATCH");
      return blob;
    } finally { for (const chunk of chunks) chunk.fill(0); release(); }
  }

  markVerified(profileId: string, id: string, hash: string) {
    const file = this.file(profileId, id);
    if (file.received !== file.size || !/^[A-Za-z0-9_-]{43}$/u.test(hash)) throw new Error("TRANSFER_HASH_INVALID");
    file.hash = hash;
  }

  remove(profileId: string, id: string) {
    const account = this.accounts.get(profileId);
    const file = account?.files.get(id);
    if (!file) return;
    this.bytes = Math.max(0, this.bytes - file.cipherBytes);
    account!.files.delete(id);
    file.chunks.length = 0;
  }

  clearProfile(profileId: string) {
    const account = this.accounts.get(profileId);
    if (!account) return;
    this.accounts.delete(profileId);
    account.key = null;
    for (const file of account.files.values()) { this.bytes -= file.cipherBytes; file.chunks.length = 0; }
    account.files.clear();
    this.bytes = Math.max(0, this.bytes);
  }

  clear() { for (const id of [...this.accounts.keys()]) this.clearProfile(id); }

  private account(profileId: string) {
    const account = this.accounts.get(profileId);
    if (!account?.key) throw new Error("TRANSFER_PUMP_STOPPED");
    return account;
  }

  private file(profileId: string, id: string) {
    const file = this.account(profileId).files.get(id);
    if (!file) throw new Error("TRANSFER_BROWSER_SOURCE_UNAVAILABLE");
    file.used = Date.now();
    return file;
  }

  private assertCurrent(profileId: string, account: Account, file: CachedFile) {
    if (this.accounts.get(profileId) !== account || !account.key || account.files.get(file.id) !== file) {
      throw new Error("TRANSFER_PUMP_STOPPED");
    }
  }

  private aad(profileId: string, file: CachedFile, index: number, position: number, length: number) {
    return encoder.encode(JSON.stringify(["kaigen-webgate-file-v1", profileId, file.id, file.size, index, position, length]));
  }

  private async decrypt(profileId: string, account: Account, file: CachedFile, index: number, key: CryptoKey) {
    const chunk = file.chunks[index];
    try {
      const bytes = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: chunk.iv,
        additionalData: this.aad(profileId, file, index, chunk.position, chunk.length) }, key, chunk.ciphertext));
      this.assertCurrent(profileId, account, file);
      if (bytes.byteLength !== chunk.length) throw new Error("TRANSFER_SIZE_MISMATCH");
      return bytes;
    } catch (error) {
      if (this.accounts.get(profileId) !== account) throw new Error("TRANSFER_PUMP_STOPPED");
      this.remove(profileId, file.id);
      throw error instanceof Error && error.message.startsWith("TRANSFER_") ? error : new Error("TRANSFER_CACHE_INVALID");
    }
  }

  private reserve(length: number, protectedFile: CachedFile) {
    const evictable = [...this.accounts.entries()].flatMap(([profileId, account]) => [...account.files.values()]
      .filter((file) => file !== protectedFile && file.pins === 0)
      .map((file) => ({ profileId, file }))).sort((left, right) => left.file.used - right.file.used);
    for (const entry of evictable) {
      if (this.bytes + length <= this.maxBytes) break;
      this.remove(entry.profileId, entry.file.id);
    }
    if (this.bytes + length > this.maxBytes) throw new Error("TRANSFER_CACHE_FULL");
  }
}
