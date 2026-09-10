const NON_RETRYABLE_TRANSFER_FAILURES = new Set([
  "AUTH_INVALID",
  "PROFILE_ID_INVALID",
  "PROFILE_NOT_ACTIVE",
  "TRANSFER_ACK_RANGE_INVALID",
  "TRANSFER_BROWSER_SOURCE_UNAVAILABLE",
  "TRANSFER_BROWSER_STORAGE_REQUIRED",
  "TRANSFER_CANCELLED",
  "TRANSFER_CHUNK_GAP",
  "TRANSFER_CHUNK_RANGE_INVALID",
  "TRANSFER_DIRECTION_INVALID",
  "TRANSFER_EMPTY_FILE",
  "TRANSFER_FAILED",
  "TRANSFER_FILE_TOO_LARGE",
  "TRANSFER_HASH_MISMATCH",
  "TRANSFER_HASH_INVALID",
  "TRANSFER_ID_INVALID",
  "TRANSFER_NOT_FOUND",
  "TRANSFER_NOT_RESUMABLE",
  "TRANSFER_OPERATION_ID_INVALID",
  "TRANSFER_OPERATION_INVALID",
  "TRANSFER_PROFILE_MISMATCH",
  "TRANSFER_PUMP_STOPPED",
  "TRANSFER_SIZE_MISMATCH",
  "TRANSFER_SIZE_INVALID",
  "TRANSFER_STORAGE_CONFLICT",
  "TRANSFER_WORKSPACE_BOUNDARY",
  "UI_LEASE_TRANSFERRED",
  "UPGRADE_REQUIRED",
  "WORKSPACE_FROZEN",
  "WORKSPACE_LEASE_EXPIRED",
  "WORKSPACE_QUOTA_FULL",
]);

const RETRYABLE_TRANSFER_FAILURES = new Set([
  "PERSIST_FAILED",
  "RUNTIME_LOCKED",
  "RUNTIME_UNAVAILABLE",
  "STATE_UNAVAILABLE",
  "TOX_BUSY",
  "TRANSFER_BROWSER_NOT_COMPLETE",
  "TRANSFER_CHUNK_NOT_REQUESTED",
  "TRANSFER_CHUNK_REJECTED",
  "TRANSFER_CHUNK_STALE",
  "TRANSFER_NOT_STARTED",
  "TRANSFER_REMOTE_NOT_COMPLETE",
  "TRANSFER_STATE_UNAVAILABLE",
  "TRANSFER_STORAGE_BUSY",
  "TRANSFER_STORAGE_UNAVAILABLE",
]);

export function transferFailureCode(error: unknown) {
  if (error instanceof Error) return error.message.trim();
  return String(error).replace(/^Error:\s*/u, "").trim();
}

export function isRetryableTransferFailure(error: unknown) {
  const code = transferFailureCode(error);
  if (NON_RETRYABLE_TRANSFER_FAILURES.has(code)) return false;
  if (RETRYABLE_TRANSFER_FAILURES.has(code)) return true;
  if (/^(?:HTTP|TRANSFER_HTTP)_(?:408|425|429|5\d\d)$/u.test(code)) return true;
  if (/failed to fetch|networkerror|network request failed|load failed/iu.test(code)) return true;
  // An unknown transport failure must not be translated into a peer-visible
  // cancellation. Keep the same transfer alive and retry with bounded
  // backoff; explicit Cancel remains the only path that emits Tox CANCEL.
  return true;
}

export function transferRetryDelay(attempt: number) {
  return Math.min(2_000, 100 * (2 ** Math.min(Math.max(0, attempt), 5)));
}

export function incomingBrowserCommitComplete(
  receivedBytes: number,
  sizeBytes: number,
  payloadCommitted: boolean,
  payloadSha256: string | null,
) {
  return Number.isSafeInteger(sizeBytes) && sizeBytes > 0 && receivedBytes === sizeBytes
    && payloadCommitted === true && /^[A-Za-z0-9_-]{43}$/u.test(payloadSha256 ?? "");
}

export const TRANSFER_CHUNK_BYTES = 1024 * 1024;

export function outgoingUploadRange(uploadedBytes: number, sizeBytes: number) {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0 || !Number.isSafeInteger(uploadedBytes)
    || uploadedBytes < 0 || uploadedBytes > sizeBytes) throw new Error("TRANSFER_CHUNK_RANGE_INVALID");
  return uploadedBytes === sizeBytes ? null
    : { position: uploadedBytes, length: Math.min(TRANSFER_CHUNK_BYTES, sizeBytes - uploadedBytes) };
}

/** Native WebCrypto computes the digest asynchronously; chat files are size-bounded. */
export async function transferPayloadSha256(blob: Blob) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()));
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

export async function verifyTransferPayload(blob: Blob, sizeBytes: number, expectedSha256: string | null) {
  if (blob.size !== sizeBytes) throw new Error("TRANSFER_SIZE_MISMATCH");
  if (!/^[A-Za-z0-9_-]{43}$/u.test(expectedSha256 ?? "")
    || await transferPayloadSha256(blob) !== expectedSha256) throw new Error("TRANSFER_HASH_MISMATCH");
}

type RetryOptions = {
  active?: () => boolean;
  wait?: (milliseconds: number) => Promise<void>;
  onRetry?: (error: unknown, attempt: number) => void;
};

const defaultWait = (milliseconds: number) => new Promise<void>((resolve) => {
  globalThis.setTimeout(resolve, Math.max(0, milliseconds));
});

export async function retryTransferOperation<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
) {
  const active = options.active ?? (() => true);
  const wait = options.wait ?? defaultWait;
  let attempt = 0;
  while (active()) {
    try {
      const result = await operation();
      if (!active()) break;
      return result;
    } catch (error) {
      if (!isRetryableTransferFailure(error)) throw error;
      if (!active()) break;
      options.onRetry?.(error, attempt);
      await wait(transferRetryDelay(attempt));
      attempt += 1;
    }
  }
  throw new Error("TRANSFER_PUMP_STOPPED");
}
