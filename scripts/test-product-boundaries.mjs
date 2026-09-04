import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const projectRoot = new URL("../", import.meta.url);

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const url = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, directory);
    if (entry.isDirectory()) return sourceFiles(url);
    return /\.(?:ts|tsx)$/u.test(entry.name) ? [url] : [];
  }));
  return nested.flat();
}

const files = await sourceFiles(new URL("src/", projectRoot));
const sources = await Promise.all(files.map(async (url) => [fileURLToPath(url), await readFile(url, "utf8")]));
const tauriImports = sources.filter(([, source]) => source.includes("@tauri-apps/"));
assert.deepEqual(
  tauriImports.map(([path]) => path.replaceAll("\\", "/").split("/src/")[1]),
  ["platform/desktop.ts"],
  "only the compile-time desktop adapter may import Tauri JavaScript packages",
);

const read = (path) => readFile(new URL(path, projectRoot), "utf8");
const [vite, main, desktop, web, webRoot, webSession, packageText] = await Promise.all([
  read("vite.config.ts"),
  read("src/main.tsx"),
  read("src/platform/desktop.ts"),
  read("src/platform/web.ts"),
  read("src/web/WebRoot.tsx"),
  read("src/web/session.ts"),
  read("package.json"),
]);

assert.match(vite, /mode === "web" \? "web" : "desktop"/u);
assert.match(vite, /"@kaigen\/platform"[^]*platform\/\$\{product\}\.ts/u);
assert.match(vite, /"@kaigen\/root"[^]*WebRoot\.tsx[^]*RootApp\.tsx/u);
assert.match(main, /import ProductRoot from "@kaigen\/root"/u);
for (const capability of [
  "nativeFilesystem: true",
  "systemTray: true",
  "browserAuthorization: false",
  "containerRelativeLayout: false",
  "outgoingTransferRetry: true",
  "proxyConnectivityTest: true",
]) assert.ok(desktop.includes(capability), `desktop adapter must declare ${capability}`);
assert.doesNotMatch(desktop, /@tauri-apps\/plugin-(?:dialog|opener)/u);
for (const capability of [
  "nativeFilesystem: false",
  "systemTray: false",
  "browserAuthorization: true",
  "containerRelativeLayout: true",
  "outgoingTransferRetry: false",
  "proxyConnectivityTest: false",
]) assert.ok(web.includes(capability), `web adapter must declare ${capability}`);
assert.doesNotMatch(web, /@tauri-apps/u);
assert.doesNotMatch(`${desktop}\n${web}`, /\bproduct:\s*"(?:desktop|web)"|platformCapabilities\.product/u);
assert.match(webRoot, /web-service-bar/u);
assert.match(webRoot, /MIN_VIEWPORT_WIDTH = 900/u);
assert.match(webRoot, /MIN_VIEWPORT_HEIGHT = 660/u);
assert.match(webRoot, /menu: "Управление сеансом"/u);
assert.match(webRoot, /lockSession: "Заблокировать сеанс"/u);
assert.match(webRoot, /destroyTitle: "Уничтожить пространство\?"/u);
assert.match(webRoot, /Экспорт данных выполняться не будет/u);
assert.match(webRoot, /copyLink: "Скопировать ссылку"/u);
assert.match(webRoot, /navigator\.clipboard\.writeText\(location\.href\)/u);
assert.doesNotMatch(webRoot, /Экспортировать и уничтожить пространство/u);
assert.match(webSession, /indexedDB\.open/u);
assert.match(webSession, /generateKey\([^]*false,[^]*\["sign", "verify"\]/u);
assert.match(webSession, /20_000/u);
assert.match(webSession, /5 \* 60_000/u);
assert.doesNotMatch(webSession, /localStorage/u);
assert.doesNotMatch(webRoot, /https?:\/\//u, "the web-only shell must not request third-party resources");

const packageJson = JSON.parse(packageText);
assert.equal(
  packageJson.scripts["build:web"],
  "node scripts/test-ui-identity-contract.mjs && tsc -p tsconfig.web.json && vite build --mode web --outDir dist-web --configLoader runner && node scripts/test-theme-bundle.mjs dist-web",
);
assert.equal(packageJson.scripts["test:product-bundles"], "node scripts/test-product-bundles.mjs");

console.log("product target boundaries: 28 assertions passed");
