export type ChatMediaKind = "audio" | "video";

const mediaTypes: Record<string, { kind: ChatMediaKind; mime: string }> = {
  mov: { kind: "video", mime: "video/quicktime" },
  mp4: { kind: "video", mime: "video/mp4" },
  mkv: { kind: "video", mime: "video/x-matroska" },
  wmv: { kind: "video", mime: "video/x-ms-wmv" },
  mp3: { kind: "audio", mime: "audio/mpeg" },
  flac: { kind: "audio", mime: "audio/flac" },
  m4a: { kind: "audio", mime: "audio/mp4" },
  wma: { kind: "audio", mime: "audio/x-ms-wma" },
  wav: { kind: "audio", mime: "audio/wav" },
};

export function chatMediaKind(name: string): ChatMediaKind | undefined {
  return mediaTypes[name.split(".").pop()?.toLowerCase() ?? ""]?.kind;
}

export function chatMediaMime(name: string): string {
  return mediaTypes[name.split(".").pop()?.toLowerCase() ?? ""]?.mime ?? "application/octet-stream";
}
