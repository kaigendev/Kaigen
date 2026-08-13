// Tox avatars are PNG files limited to 64 KiB. The profile image can remain
// full quality locally; this creates a separate compatible copy for Tox.
const TOX_AVATAR_MAX_BYTES = 64 * 1024;

export function readAvatarDataUrl(file: File): Promise<string> {
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

export async function profileAvatarToToxPng(avatar: string): Promise<number[]> {
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
    if (bytes.byteLength <= TOX_AVATAR_MAX_BYTES) return Array.from(bytes);
    maxSide = Math.floor(maxSide * 0.75);
  }
  throw new Error("Avatar could not be reduced below the Tox 64 KiB limit");
}
