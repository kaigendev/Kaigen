import coreScriptUrl from "@ffmpeg/core?url";
import coreWasmUrl from "@ffmpeg/core/wasm?url";
import { MAX_CHAT_FILE_BYTES } from "./chatFileBatch";

type FsStream = { path: string; position: number };
type CoreFileSystem = {
  writeFile: (path: string, data: Uint8Array) => void;
  readFile: (path: string, options?: { encoding: "utf8" }) => Uint8Array | string;
  stat: (path: string) => { size: number };
  unlink: (path: string) => void;
  write: (stream: FsStream, buffer: Uint8Array, offset: number, length: number, position?: number, canOwn?: boolean) => number;
};
type DecoderCore = {
  FS: CoreFileSystem;
  exec: (...args: string[]) => number;
  ffprobe: (...args: string[]) => number;
  reset: () => void;
  setTimeout: (milliseconds: number) => void;
  setLogger: (callback: (entry: { type: string; message: string }) => void) => void;
};
type CoreFactory = (options: { mainScriptUrlOrBlob: string }) => Promise<DecoderCore>;
type MediaStream = { index?: number; codec_type?: string; codec_name?: string; width?: number; height?: number; channels?: number };
type ProbeResult = { streams?: MediaStream[]; format?: { duration?: string } };
type DecoderRequest = { kind: "audio" | "video"; input: ArrayBuffer };
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<DecoderRequest>) => void) | null;
  postMessage: (value: unknown, transfer?: Transferable[]) => void;
};

const INPUT_PATH = "/input.media";
const OUTPUT_PATH = "/output.mp4";
const PROBE_PATH = "/probe.json";
const MAX_PROBE_BYTES = 64 * 1024;
const MAX_SINGLE_ALLOCATION = 64 * 1024 * 1024;
const MAX_VIDEO_PIXELS = 4096 * 2160;
const FORMAT_ALLOWLIST = "mov,matroska,webm,asf,mp3,flac,wav";

function inputArguments() {
  return [
    "-hide_banner", "-loglevel", "error", "-max_alloc", String(MAX_SINGLE_ALLOCATION),
    "-protocol_whitelist", "file", "-format_whitelist", FORMAT_ALLOWLIST,
    "-probesize", "1048576", "-analyzeduration", "5000000", "-max_streams", "16",
  ];
}

function readProbe(core: DecoderCore): ProbeResult {
  core.setTimeout(15_000);
  const exit = core.ffprobe(...inputArguments(), "-show_entries",
    "stream=index,codec_type,codec_name,width,height,channels:format=duration",
    "-of", "json", "-o", PROBE_PATH, INPUT_PATH);
  core.reset();
  if (exit !== 0 || core.FS.stat(PROBE_PATH).size > MAX_PROBE_BYTES) throw new Error("CHAT_MEDIA_UNSUPPORTED");
  const value = core.FS.readFile(PROBE_PATH, { encoding: "utf8" });
  if (typeof value !== "string") throw new Error("CHAT_MEDIA_UNSUPPORTED");
  return JSON.parse(value) as ProbeResult;
}

async function decode({ input, kind }: DecoderRequest) {
  if (!(input instanceof ArrayBuffer) || input.byteLength < 1 || input.byteLength > MAX_CHAT_FILE_BYTES) {
    throw new Error("CHAT_MEDIA_SIZE_LIMIT");
  }
  if (kind !== "audio" && kind !== "video") throw new Error("CHAT_MEDIA_UNSUPPORTED");
  // Both URLs are emitted from the pinned package into this build. No CDN,
  // caller URL, arbitrary path, network protocol or persistent filesystem is used.
  const scriptUrl = new URL(coreScriptUrl, self.location.href).href;
  const wasmUrl = new URL(coreWasmUrl, self.location.href).href;
  const factory = (await import(/* @vite-ignore */ scriptUrl) as { default: CoreFactory }).default;
  const core = await factory({ mainScriptUrlOrBlob: `${scriptUrl}#${btoa(JSON.stringify({ wasmURL: wasmUrl }))}` });
  core.setLogger(() => {});
  let outputLimitReached = false;
  const fsWrite = core.FS.write.bind(core.FS);
  core.FS.writeFile(INPUT_PATH, new Uint8Array(input));
  core.FS.write = (stream, buffer, offset, length, position, canOwn) => {
    const limit = stream.path === OUTPUT_PATH ? MAX_CHAT_FILE_BYTES
      : stream.path === PROBE_PATH ? MAX_PROBE_BYTES : undefined;
    const start = position ?? stream.position;
    if (limit !== undefined && (!Number.isSafeInteger(start) || start < 0 || length < 0 || start + length > limit)) {
      outputLimitReached = true;
      // -fs deliberately is not used: it can successfully return a shortened clip.
      throw new Error("CHAT_MEDIA_SIZE_LIMIT");
    }
    return fsWrite(stream, buffer, offset, length, position, canOwn);
  };
  try {
    const probe = readProbe(core);
    const streams = probe.streams;
    if (!Array.isArray(streams) || streams.length > 16) throw new Error("CHAT_MEDIA_UNSUPPORTED");
    const video = streams.find((stream) => stream.codec_type === "video");
    const audio = streams.find((stream) => stream.codec_type === "audio");
    if (kind === "video" && (!video || !Number.isSafeInteger(video.width) || !Number.isSafeInteger(video.height)
      || video.width! < 1 || video.height! < 1 || video.width! * video.height! > MAX_VIDEO_PIXELS)) {
      throw new Error("CHAT_MEDIA_UNSUPPORTED");
    }
    if (kind === "audio" && !audio) throw new Error("CHAT_MEDIA_UNSUPPORTED");
    if (audio && (!Number.isSafeInteger(audio.channels) || audio.channels! < 1 || audio.channels! > 8)) {
      throw new Error("CHAT_MEDIA_UNSUPPORTED");
    }
    const duration = Number(probe.format?.duration);
    const budgetBitsPerSecond = Number.isFinite(duration) && duration > 0
      ? Math.floor(MAX_CHAT_FILE_BYTES * 8 * 0.85 / duration) : undefined;
    const audioBitrate = Math.min(96_000, Math.max(32_000, budgetBitsPerSecond ?? 96_000));
    const args = [...inputArguments(), "-xerror", "-threads", "1", "-i", INPUT_PATH,
      "-map_metadata", "-1", "-map_chapters", "-1", "-sn", "-dn"];
    if (kind === "video") {
      const videoBitrate = Math.min(1_500_000, Math.max(96_000,
        (budgetBitsPerSecond ?? 1_596_000) - (audio ? audioBitrate : 0)));
      args.push("-map", "0:v:0", "-map", "0:a:0?", "-vf",
        "scale=w='min(1280,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1",
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-r", "30",
        "-b:v", String(videoBitrate), "-maxrate", String(videoBitrate), "-bufsize", String(videoBitrate * 2));
    } else {
      args.push("-map", "0:a:0", "-vn");
    }
    if (audio) args.push("-c:a", "aac", "-b:a", String(audioBitrate), "-ac", "2", "-ar", "48000");
    args.push("-threads", "1", "-movflags", "+faststart", "-f", "mp4", OUTPUT_PATH);
    core.setTimeout(110_000);
    const exit = core.exec(...args);
    if (outputLimitReached) throw new Error("CHAT_MEDIA_SIZE_LIMIT");
    if (exit !== 0) throw new Error("CHAT_MEDIA_DECODE_FAILED");
    const size = core.FS.stat(OUTPUT_PATH).size;
    if (size < 1 || size > MAX_CHAT_FILE_BYTES) throw new Error("CHAT_MEDIA_SIZE_LIMIT");
    const output = core.FS.readFile(OUTPUT_PATH);
    if (!(output instanceof Uint8Array)) throw new Error("CHAT_MEDIA_DECODE_FAILED");
    // readFile returns a copy outside WASM; transfer it, then the caller terminates us.
    const bytes = output.buffer instanceof ArrayBuffer && output.byteOffset === 0 && output.byteLength === output.buffer.byteLength
      ? output.buffer : output.slice().buffer as ArrayBuffer;
    scope.postMessage({ ok: true, bytes }, [bytes]);
  } catch (error) {
    if (outputLimitReached) throw new Error("CHAT_MEDIA_SIZE_LIMIT");
    throw error;
  } finally {
    for (const path of [INPUT_PATH, OUTPUT_PATH, PROBE_PATH]) {
      try { core.FS.unlink(path); } catch { /* A failed decode may not have produced this file. */ }
    }
  }
}

scope.onmessage = ({ data }) => {
  // Each worker accepts exactly one job; no other profile can reuse its memory.
  scope.onmessage = null;
  void decode(data).catch((error: unknown) => {
    const code = error instanceof Error && ["CHAT_MEDIA_SIZE_LIMIT", "CHAT_MEDIA_UNSUPPORTED"].includes(error.message)
      ? error.message : "CHAT_MEDIA_DECODE_FAILED";
    scope.postMessage({ ok: false, error: code });
  });
};
export {};
