import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicRoot = path.join(projectRoot, ".sites-public");
const publicAssets = path.join(publicRoot, "assets");

if (process.argv.includes("--clean-build")) {
  await rm(path.join(projectRoot, "dist"), { recursive: true, force: true });
}

await rm(publicRoot, { recursive: true, force: true });
await mkdir(publicAssets, { recursive: true });
await Promise.all([
  cp(path.join(projectRoot, "site.webmanifest"), path.join(publicRoot, "site.webmanifest")),
  cp(path.join(projectRoot, "robots.txt"), path.join(publicRoot, "robots.txt")),
  cp(path.join(projectRoot, "assets", "icon-192.png"), path.join(publicAssets, "icon-192.png")),
  cp(path.join(projectRoot, "assets", "icon-512.png"), path.join(publicAssets, "icon-512.png")),
  cp(path.join(projectRoot, "assets", "kaigen-splash.webp"), path.join(publicAssets, "kaigen-splash.webp")),
]);
