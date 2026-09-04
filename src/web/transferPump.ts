const NON_RETRYABLE_TRANSFER_FAILURES = new Set([
  "AUTH_INVALID",
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
  "TRANSFER_ID_INVALID",
  "TRANSFER_NOT_FOUND",
  "TRANSFER_NOT_RESUMABLE",
  "TRANSFER_PROFILE_MISMATCH",
  "TRANSFER_PUMP_STOPPED",
  "TRANSFER_SIZE_MISMATCH",
  "TRANSFER_WORKSPACE_BOUNDARY",
  "UI_LEASE_TRANSFERRED",
  "UPGRADE_REQUIRED",
  "WORKSPACE_FROZEN",
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
  acknowledgedBytes: number,
) {
  return receivedBytes === sizeBytes && acknowledgedBytes === sizeBytes;
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
      return await operation();
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
