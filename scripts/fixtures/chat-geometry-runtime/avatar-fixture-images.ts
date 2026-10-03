// Synthetic input images; every codec/decode/PNG normalization uses the browser.
export type AvatarFixture = { file: File; dataUrl: string; width: number; height: number; mime: string };
const dataUrl = async (blob: Blob) => {
  const bytes = new Uint8Array(await blob.arrayBuffer()); let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 4096) binary += String.fromCharCode(...bytes.subarray(offset, offset + 4096));
  return "data:" + blob.type + ";base64," + btoa(binary);
};
function gif(width: number, height: number) {
  const bytes = [...new TextEncoder().encode("GIF89a"), width & 255, width >> 8, height & 255, height >> 8,
    128, 0, 0, 22, 66, 110, 230, 190, 70, 44, 0, 0, 0, 0, width & 255, width >> 8, height & 255, height >> 8, 0, 2];
  const encoded: number[] = []; let packed = 0, bits = 0;
  const code = (value: number) => { packed |= value << bits; bits += 3;
    while (bits >= 8) { encoded.push(packed & 255); packed >>= 8; bits -= 8; } };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { code(4); code((x + y) % 2); }
  code(5); if (bits) encoded.push(packed & 255);
  for (let offset = 0; offset < encoded.length; offset += 255) {
    const block = encoded.slice(offset, offset + 255); bytes.push(block.length, ...block);
  }
  bytes.push(0, 59); return new Blob([new Uint8Array(bytes)], { type: "image/gif" });
}
export async function avatarFixture(mime = "image/png", width = 80, height = 160, noise = false): Promise<AvatarFixture> {
  let blob: Blob;
  if (mime === "image/gif") blob = gif(width, height);
  else {
    const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
    const context = canvas.getContext("2d")!;
    if (noise) {
      const pixels = context.createImageData(width, height); let seed = 0x1a7a14;
      for (let offset = 0; offset < pixels.data.length; offset += 4) {
        for (let channel = 0; channel < 3; channel++) { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; pixels.data[offset + channel] = seed & 255; }
        pixels.data[offset + 3] = 255;
      }
      context.putImageData(pixels, 0, 0);
    } else {
      context.fillStyle = "#194568"; context.fillRect(0, 0, width, height);
      context.fillStyle = "#e6be46"; context.fillRect(0, 0, Math.max(1, width / 3), Math.max(1, height / 3));
    }
    blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(Error("Fixture codec unavailable")), mime, .91));
  }
  if (blob.type !== mime) throw Error("Fixture requested codec not supported: " + mime);
  return { file: new File([blob], "synthetic-avatar." + mime.split("/")[1], { type: mime }), dataUrl: await dataUrl(blob), width, height, mime };
}
