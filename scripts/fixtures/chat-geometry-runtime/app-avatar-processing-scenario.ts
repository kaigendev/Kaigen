import { normalizeProfileAvatar, profileAvatarToToxPng, readAvatarDataUrl, PROFILE_AVATAR_SOURCE_MAX_BYTES } from "../../../src/avatar";
import { avatarFixture } from "./avatar-fixture-images";
const sha = async (bytes: ArrayBuffer | Uint8Array) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(value => value.toString(16).padStart(2, "0")).join("");
const settled = async (promise: Promise<unknown>) => Promise.race([
  promise.then(value => ({ status: "resolved", value }), error => ({ status: "rejected", error: String(error) })),
  new Promise<{ status: string }>(resolve => setTimeout(() => resolve({ status: "timeout" }), 500)),
]);
export async function runActualAvatarProcessingScenario() {
  let assertions = 0; const failures: string[] = [], outputs: unknown[] = [];
  const check = (value: unknown, label: string) => { assertions++; if (!value) failures.push(label); };
  const nativeToBlob = HTMLCanvasElement.prototype.toBlob, nativeContext = HTMLCanvasElement.prototype.getContext;
  const nativeRead = FileReader.prototype.readAsDataURL, nativeDraw = CanvasRenderingContext2D.prototype.drawImage;
  const inputs = await Promise.all([
    avatarFixture("image/png", 80, 160), avatarFixture("image/jpeg", 640, 64), avatarFixture("image/webp", 128, 512),
    avatarFixture("image/gif", 240, 48), avatarFixture("image/png", 700, 700, true), avatarFixture("image/png", 1, 1), avatarFixture("image/png", 16, 16),
  ]);
  try {
    for (const source of inputs) {
      const label = source.mime + " " + source.width + "x" + source.height, passes: Array<{ width: number; height: number; bytes: number }> = [];
      HTMLCanvasElement.prototype.toBlob = function (callback, type, quality) {
        nativeToBlob.call(this, blob => { if (blob) passes.push({ width: this.width, height: this.height, bytes: blob.size }); callback(blob); }, type, quality);
      };
      try {
        const read = await readAvatarDataUrl(source.file); check(read === source.dataUrl, label + " actual FileReader preserves source data URL");
        const normalized = await normalizeProfileAvatar(read);
        const bytes = new Uint8Array(normalized.bytes), decoded = Uint8Array.from(atob(normalized.dataUrl.split(",")[1]), ch => ch.charCodeAt(0));
        check(bytes.length > 0 && bytes.length <= 65536 && [...bytes.subarray(0, 8)].join() === "137,80,78,71,13,10,26,10", label + " valid PNG signature within 64KiB");
        check(normalized.dataUrl.startsWith("data:image/png;base64,") && bytes.length === decoded.length && bytes.every((value,index) => value === decoded[index]), label + " exact dataURL-byte equality");
        const image = new Image(); image.src = normalized.dataUrl; await image.decode();
        const side = Math.max(image.naturalWidth, image.naturalHeight), scale = Math.min(1, side / Math.max(source.width, source.height));
        check(side <= 512 && image.naturalWidth === Math.max(1, Math.round(source.width * scale)) && image.naturalHeight === Math.max(1, Math.round(source.height * scale)), label + " preserves aspect without upscale");
        check(passes.length >= 1 && (source.width !== 700 || passes.length > 1), label + " executes real codec passes and noisy retry");
        outputs.push({ mime: source.mime, source: [source.width,source.height], output: [image.naturalWidth,image.naturalHeight],
          sourceBytes: source.file.size, bytes: bytes.length, sha256: await sha(bytes), passes, gif: source.mime === "image/gif" ? "static decoded frame" : undefined });
      } catch (error) { check(false, label + " pipeline succeeds: " + String(error)); }
      finally { HTMLCanvasElement.prototype.toBlob = nativeToBlob; }
    }
    const source = inputs[0];
    const tox = await profileAvatarToToxPng(source.dataUrl);
    check(tox.length <= 65536 && [...tox.slice(0,8)].join() === "137,80,78,71,13,10,26,10", "public Tox conversion returns a real bounded PNG");
    const corrupt = await settled(normalizeProfileAvatar("data:image/png;base64,AAAA"));
    check(corrupt.status === "rejected", "actual corrupt-image decode rejects");
    const empty = await settled(readAvatarDataUrl(new File([], "empty.png", { type:"image/png" })));
    const oversize = await settled(readAvatarDataUrl(new File([new Uint8Array(PROFILE_AVATAR_SOURCE_MAX_BYTES + 1)], "large.png", { type:"image/png" })));
    check(empty.status === "rejected" && oversize.status === "rejected", "source size guard rejects empty and >8MiB before decode");
    for (const mode of ["event-error", "abort", "throw"]) {
      FileReader.prototype.readAsDataURL = function (blob) {
        if (mode === "throw") throw new DOMException("Synthetic IO refusal", "NotReadableError");
        nativeRead.call(this,blob);
        if (mode === "abort") this.abort(); else this.dispatchEvent(new ProgressEvent("error"));
      };
      check((await settled(readAvatarDataUrl(source.file))).status === "rejected", mode + " source FileReader rejects rather than hanging");
      check((await settled(normalizeProfileAvatar(source.dataUrl))).status === "rejected", mode + " PNG dataURL FileReader rejects rather than hanging");
      FileReader.prototype.readAsDataURL = nativeRead;
    }
    for (const mode of ["context", "draw", "encode-null", "encode-throw", "always-large"]) {
      HTMLCanvasElement.prototype.getContext = function (...args) { return mode === "context" && args[0] === "2d" ? null : nativeContext.apply(this,args); } as typeof nativeContext;
      CanvasRenderingContext2D.prototype.drawImage = function (...args) { if (mode === "draw") throw Error("Synthetic draw refusal"); nativeDraw.apply(this,args); } as typeof nativeDraw;
      HTMLCanvasElement.prototype.toBlob = function (callback,type,quality) {
        if (mode === "encode-throw") throw Error("Synthetic encoding refusal");
        if (mode === "encode-null") { queueMicrotask(() => callback(null)); return; }
        if (mode === "always-large") { queueMicrotask(() => callback(new Blob([new Uint8Array(65537)], {type:"image/png"}))); return; }
        nativeToBlob.call(this,callback,type,quality);
      };
      check((await settled(normalizeProfileAvatar(source.dataUrl))).status === "rejected", mode + " canvas fault rejects safely");
      HTMLCanvasElement.prototype.getContext = nativeContext; CanvasRenderingContext2D.prototype.drawImage = nativeDraw; HTMLCanvasElement.prototype.toBlob = nativeToBlob;
    }
    return { ok: failures.length === 0, assertions, failures, outputs, boundary: "native browser Image/FileReader/canvas decode+PNG encode; injected IO/canvas faults; GIF static frame; UI owner/persistence separate" };
  } finally {
    HTMLCanvasElement.prototype.toBlob = nativeToBlob; HTMLCanvasElement.prototype.getContext = nativeContext;
    FileReader.prototype.readAsDataURL = nativeRead; CanvasRenderingContext2D.prototype.drawImage = nativeDraw;
  }
}
