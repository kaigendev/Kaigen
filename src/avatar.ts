// Tox avatars are PNG files limited to 64 KiB. Keep one normalized PNG for
// local display, persistence, and transfer so every client renders the same file.
const TOX_AVATAR_MAX_BYTES = 64 * 1024;
export const PROFILE_AVATAR_SOURCE_MAX_BYTES = 8 * 1024 * 1024;

export type NormalizedProfileAvatar = {
  dataUrl: string;
  bytes: number[];
};

export function readAvatarDataUrl(file: File): Promise<string> {
  if (file.size <= 0 || file.size > PROFILE_AVATAR_SOURCE_MAX_BYTES) {
    return Promise.reject(new Error("PROFILE_AVATAR_SIZE_INVALID"));
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("Could not read avatar"));
    });
    reader.addEventListener("error", () => reject(reader.error ?? new Error("Could not read avatar")));
    reader.readAsDataURL(file);
  });
}

function blobDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("Could not encode avatar"));
    });
    reader.addEventListener("error", () => reject(reader.error ?? new Error("Could not encode avatar")));
    reader.readAsDataURL(blob);
  });
}

export async function normalizeProfileAvatar(avatar: string): Promise<NormalizedProfileAvatar> {
  const image = new Image();
  image.src = avatar;
  await image.decode();
  let maxSide = Math.min(Math.max(image.naturalWidth, image.naturalHeight), 512);
  while (maxSide >= 24) {
    const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas is unavailable");
    context.drawImage(image, 0, 0, width, height);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((result) => result ? resolve(result) : reject(new Error("Could not encode avatar")), "image/png");
    });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (bytes.byteLength <= TOX_AVATAR_MAX_BYTES) {
      return {
        dataUrl: await blobDataUrl(blob),
        bytes: Array.from(bytes),
      };
    }
    maxSide = Math.floor(maxSide * 0.75);
  }
  throw new Error("Avatar could not be reduced below the Tox 64 KiB limit");
}

export async function profileAvatarToToxPng(avatar: string): Promise<number[]> {
  return (await normalizeProfileAvatar(avatar)).bytes;
}
