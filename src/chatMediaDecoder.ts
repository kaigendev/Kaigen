import decoderWorkerUrl from "./chatMediaDecoder.worker.ts?worker&url";
import { MAX_CHAT_FILE_BYTES } from "./chatFileBatch";

type MediaKind = "audio" | "video";
type ScriptPolicy = { createScriptURL: (value: string) => unknown };
type QueuedJob = { start: () => void; cancel: () => void };

const MAX_QUEUED_JOBS = 8;
const DECODE_TIMEOUT_MS = 120_000;
const queuedJobs: QueuedJob[] = [];
let decoderBusy = false;
let workerPolicy: ScriptPolicy | undefined;

function abortError() {
  return new DOMException("Media preparation cancelled", "AbortError");
}

function workerScriptUrl() {
  const exactUrl = new URL(decoderWorkerUrl, location.href).href;
  const factory = (globalThis as typeof globalThis & {
    trustedTypes?: {
      createPolicy: (name: string, rules: { createScriptURL: (value: string) => string }) => ScriptPolicy;
    };
  }).trustedTypes;
  if (!factory) return exactUrl;
  workerPolicy ??= factory.createPolicy("kaigen-chat-media-worker", {
    createScriptURL: (value) => {
      if (new URL(value, location.href).href !== exactUrl) throw new TypeError("Unexpected media worker URL");
      return exactUrl;
    },
  });
  return workerPolicy.createScriptURL(exactUrl) as string;
}

function acquireDecoder(signal: AbortSignal): Promise<() => void> {
  if (signal.aborted) return Promise.reject(abortError());
  if (decoderBusy && queuedJobs.length >= MAX_QUEUED_JOBS) return Promise.reject(new Error("CHAT_MEDIA_BUSY"));
  return new Promise((resolve, reject) => {
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      decoderBusy = false;
      queuedJobs.shift()?.start();
    };
    const job: QueuedJob = {
      start: () => {
        signal.removeEventListener("abort", job.cancel);
        decoderBusy = true;
        resolve(release);
      },
      cancel: () => {
        const index = queuedJobs.indexOf(job);
        if (index >= 0) queuedJobs.splice(index, 1);
        signal.removeEventListener("abort", job.cancel);
        reject(abortError());
      },
    };
    if (decoderBusy) {
      queuedJobs.push(job);
      signal.addEventListener("abort", job.cancel, { once: true });
    } else {
      job.start();
    }
  });
}

/** Prepare only an already-authorized local Blob. The caller owns any resulting object URL. */
export async function prepareChatMedia(original: Blob, kind: MediaKind, signal: AbortSignal): Promise<Blob> {
  if (signal.aborted) throw abortError();
  if (!(original instanceof Blob) || original.size < 1 || original.size > MAX_CHAT_FILE_BYTES) {
    throw new Error("CHAT_MEDIA_SIZE_LIMIT");
  }
  if (kind !== "audio" && kind !== "video") throw new Error("CHAT_MEDIA_UNSUPPORTED");
  const release = await acquireDecoder(signal);
  try {
    if (signal.aborted) throw abortError();
    const input = await original.arrayBuffer();
    if (signal.aborted) throw abortError();
    return await new Promise<Blob>((resolve, reject) => {
      const worker = new Worker(workerScriptUrl(), { type: "module", name: "kaigen-chat-media" });
      let settled = false;
      const finish = (result: Blob | Error | DOMException) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", cancel);
        worker.onmessage = null;
        worker.onerror = null;
        worker.onmessageerror = null;
        // A fresh worker per job prevents prior files, decoder state and WASM memory
        // from surviving success, error, timeout or a profile/chat cancellation.
        worker.terminate();
        if (result instanceof Blob) resolve(result);
        else reject(result);
      };
      const cancel = () => finish(abortError());
      const timer = setTimeout(() => finish(new Error("CHAT_MEDIA_TIMEOUT")), DECODE_TIMEOUT_MS);
      signal.addEventListener("abort", cancel, { once: true });
      worker.onerror = (event) => {
        event.preventDefault();
        finish(new Error("CHAT_MEDIA_DECODE_FAILED"));
      };
      worker.onmessageerror = () => finish(new Error("CHAT_MEDIA_DECODE_FAILED"));
      worker.onmessage = ({ data }: MessageEvent<unknown>) => {
        if (signal.aborted) return cancel();
        const result = data as { ok?: unknown; bytes?: unknown; error?: unknown } | null;
        if (result?.ok === true && result.bytes instanceof ArrayBuffer) {
          if (result.bytes.byteLength < 1 || result.bytes.byteLength > MAX_CHAT_FILE_BYTES) {
            finish(new Error("CHAT_MEDIA_SIZE_LIMIT"));
          } else {
            finish(new Blob([result.bytes], { type: kind === "video" ? "video/mp4" : "audio/mp4" }));
          }
        } else {
          const code = result?.error === "CHAT_MEDIA_SIZE_LIMIT" || result?.error === "CHAT_MEDIA_UNSUPPORTED"
            ? result.error : "CHAT_MEDIA_DECODE_FAILED";
          finish(new Error(code));
        }
      };
      try {
        worker.postMessage({ kind, input }, [input]);
      } catch {
        finish(new Error("CHAT_MEDIA_DECODE_FAILED"));
      }
    });
  } finally {
    release();
  }
}
