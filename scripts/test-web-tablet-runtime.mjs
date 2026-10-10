import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const options = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  assert(["--playwright-module", "--chromium-executable", "--evidence-root"].includes(process.argv[i]));
  assert(process.argv[i + 1] && !options.has(process.argv[i]));
  options.set(process.argv[i], process.argv[i + 1]);
}
for (const key of ["--playwright-module", "--chromium-executable", "--evidence-root"]) assert(options.has(key), key);
const evidence = path.resolve(options.get("--evidence-root"));
assert(!await fs.stat(evidence).catch(() => null), "Fresh evidence directory required");
await fs.mkdir(evidence, { recursive: true });
const identity = async (filename) => {
  const bytes = await fs.readFile(filename);
  return { path: filename, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
};
const report = { startedAt: new Date().toISOString(), status: "RUNNING", sources: [], cases: [],
  boundary: "Actual WebRoot/CSS and browser-input in disposable Chromium; stub workspace service verifies UI submit, not backend allocation. App saved preference integration has a separate test." };
let browser, server;
try {
  for (const name of ["src/web/WebRoot.tsx", "src/web/WebRoot.css", "src/platform/browser-input.ts", "src/contextMenuCoordinator.ts",
    "scripts/test-web-tablet-runtime.mjs", ...["index.html", "entry.tsx", "session.ts", "RootApp.tsx"].map(name => "scripts/fixtures/web-tablet-runtime/" + name)]) {
    report.sources.push({ ...await identity(path.join(root, name)), path: name });
  }
  report.runner = { node: process.version, playwright: await identity(options.get("--playwright-module")), chromium: await identity(options.get("--chromium-executable")) };
  const require = createRequire(path.join(root, "package.json"));
  const { build } = await import(pathToFileURL(require.resolve("vite")).href);
  const react = (await import(pathToFileURL(require.resolve("@vitejs/plugin-react")).href)).default;
  const fixture = path.join(root, "scripts/fixtures/web-tablet-runtime");
  const dist = path.join(evidence, "dist");
  await build({ configFile: false, root: fixture, publicDir: false, logLevel: "warn",
    plugins: [{ name: "exact-tablet-fixture", enforce: "pre", resolveId(source, importer) {
      if (importer?.replaceAll("\\", "/").endsWith("/src/web/WebRoot.tsx")) {
        if (source === "./session") return path.join(fixture, "session.ts");
        if (source === "../RootApp") return path.join(fixture, "RootApp.tsx");
      }
    } }, react()], resolve: { dedupe: ["react", "react-dom"] }, build: { outDir: dist, emptyOutDir: false } });
  server = http.createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url, "http://127.0.0.1").pathname;
      const filename = path.resolve(dist, pathname === "/" ? "index.html" : "." + pathname);
      assert(filename.startsWith(dist + path.sep));
      res.setHeader("Content-Type", ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" })[path.extname(filename)] ?? "application/octet-stream");
      res.end(await fs.readFile(filename));
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = "http://127.0.0.1:" + server.address().port;
  const { chromium } = await import(pathToFileURL(options.get("--playwright-module")).href);
  browser = await chromium.launch({ executablePath: options.get("--chromium-executable"), headless: true });
  const deviceCases = [
    ["iPad", "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)", "iPad", 5, true, false],
    ["iPad desktop UA", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)", "MacIntel", 5, true, false],
    ["Android tablet", "Mozilla/5.0 (Linux; Android 15; Tablet)", "Linux armv8l", 5, true, false],
    ["Windows touch PC", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "Win32", 10, true, true],
    ["Linux touch PC", "Mozilla/5.0 (X11; Linux x86_64)", "Linux x86_64", 10, true, true],
    ["Mac desktop", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)", "MacIntel", 0, false, true],
  ];
  for (const [name, userAgent, platform, maxTouchPoints, coarse, expected] of deviceCases) {
    const context = await browser.newContext({ userAgent, hasTouch: coarse, isMobile: coarse && expected === false, viewport: { width: 768, height: 480 } });
    await context.addInitScript(({ platform, maxTouchPoints }) => {
      Object.defineProperty(navigator, "platform", { get: () => platform });
      Object.defineProperty(navigator, "maxTouchPoints", { get: () => maxTouchPoints });
    }, { platform, maxTouchPoints });
    const page = await context.newPage();
    await page.goto(url);
    await page.waitForFunction(() => window.tabletRuntime);
    assert.equal(await page.evaluate(() => window.tabletRuntime.getDefaultSendOnEnter(false)), expected, name);
    assert.equal(await page.evaluate(() => window.tabletRuntime.getDefaultSendOnEnter(true)), true, name + " native");
    report.cases.push({ name, status: "PASS", defaultSendOnEnter: expected });
    await context.close();
  }
  for (const language of ["ru", "en"]) for (const viewport of [{ width: 768, height: 480 }, { width: 1024, height: 600 }, { width: 800, height: 360 }, { width: 390, height: 300 }]) {
    const context = await browser.newContext({ locale: language, viewport, hasTouch: true, isMobile: true });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(String(error)));
    await page.goto(url + "/?fail=1");
    const fields = page.locator('.web-gate-card input[type="password"]');
    await fields.nth(0).fill("disposable-password");
    await fields.nth(1).fill("different-password");
    const submit = page.locator(".web-gate-card .web-primary");
    await submit.scrollIntoViewIfNeeded();
    const bounds = await submit.boundingBox();
    assert(bounds.y >= 0 && bounds.y + bounds.height <= viewport.height, "Reachable submit " + JSON.stringify(viewport));
    await submit.tap();
    await page.locator(".web-error").waitFor();
    assert.equal(await page.evaluate(() => window.workspaceCalls.length), 0, "Mismatch must not allocate");
    await fields.nth(1).fill("disposable-password");
    await submit.tap();
    await page.waitForFunction(() => document.querySelector(".web-error")?.textContent?.includes("DISPOSABLE_CREATION_FAILURE"));
    await submit.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(evidence, `${language}-${viewport.width}x${viewport.height}-error.png`) });
    // Simulate the visible viewport shrinking when a software keyboard opens.
    await page.setViewportSize({ width: viewport.width, height: Math.min(240, viewport.height) });
    await submit.scrollIntoViewIfNeeded();
    const reduced = await submit.boundingBox();
    assert(reduced.y >= 0 && reduced.y + reduced.height <= Math.min(240, viewport.height));
    await page.goto(url);
    await fields.nth(0).fill("disposable-password");
    await fields.nth(1).fill("disposable-password");
    await submit.tap();
    await page.locator('[data-created-workspace="true"]').waitFor();
    assert.equal(await page.evaluate(() => window.workspaceCalls.length), 1);
    assert.equal(await page.evaluate(() => window.workspaceCalls[0].language), language);
    assert.deepEqual(errors, []);
    report.cases.push({ language, viewport, mismatch: "PASS", serviceError: "PASS", reducedViewport: "PASS", submit: "PASS" });
    await context.close();
  }
  for (const language of ["ru", "en"]) {
    const context = await browser.newContext({ locale: language, viewport: { width: 768, height: 480 }, hasTouch: true, isMobile: true });
    await context.addInitScript(() => {
      const viewport = new EventTarget();
      const listeners = new Set();
      const removed = [];
      const add = viewport.addEventListener.bind(viewport), remove = viewport.removeEventListener.bind(viewport);
      viewport.addEventListener = (name, callback) => { listeners.add(callback); add(name, callback); };
      viewport.removeEventListener = (name, callback) => { remove(name, callback); listeners.delete(callback); removed.push({ name, callback }); };
      Object.assign(viewport, { height: 480, offsetTop: 0, scale: 1 });
      Object.defineProperty(window, "visualViewport", { value: viewport });
      window.visualViewportTest = { set(values, event = "resize") { Object.assign(viewport, values); viewport.dispatchEvent(new Event(event)); }, listeners, removed };
    });
    const page = await context.newPage();
    await page.goto(url);
    await page.locator('.web-gate-card input[type="password"]').nth(0).fill("disposable-password");
    await page.locator('.web-gate-card input[type="password"]').nth(1).fill("disposable-password");
    await page.evaluate(() => window.visualViewportTest.set({ height: 180, offsetTop: 40 }));
    await page.waitForFunction(() => document.querySelector(".web-gate").style.height === "180px");
    const submit = page.locator(".web-gate-card .web-primary");
    await submit.scrollIntoViewIfNeeded();
    const bounds = await submit.boundingBox();
    assert(bounds.y >= 40 && bounds.y + bounds.height <= 220, "Visual viewport reachability");
    await page.evaluate(() => window.visualViewportTest.set({ scale: 2 }));
    await page.waitForFunction(() => document.querySelector(".web-gate").style.height === "");
    await page.evaluate(() => window.visualViewportTest.set({ scale: 1, height: 200, offsetTop: 30 }, "scroll"));
    await page.waitForFunction(() => document.querySelector(".web-gate").style.height === "200px");
    const listenerCount = await page.evaluate(() => {
      window.visualViewportTest.beforeReady = new Set(window.visualViewportTest.listeners);
      window.visualViewportTest.removed.length = 0;
      return window.visualViewportTest.listeners.size;
    });
    await submit.tap();
    await page.locator('[data-created-workspace="true"]').waitFor();
    assert.equal(await page.evaluate(() => window.visualViewportTest.listeners.size), listenerCount, "Ready viewport consumers do not accumulate listeners");
    assert.equal(await page.evaluate(() => {
      const { beforeReady, removed, listeners } = window.visualViewportTest;
      return [...beforeReady].some(callback => !listeners.has(callback)
        && ["resize", "scroll"].every(name => removed.some(item => item.name === name && item.callback === callback)));
    }), true, "Ready transition releases the previous stage viewport callback");
    assert.equal(await page.locator(".web-shell").evaluate(element => element.style.height), "", "Ready App keeps own layout");
    report.cases.push({ language, visualViewportResize: "PASS", visualViewportScroll: "PASS", scaleFallback: "PASS", submit: "PASS", cleanup: "PASS" });
    await context.close();
  }
  report.status = "PASS";
} catch (error) {
  report.status = "FAIL"; report.error = String(error.stack ?? error); process.exitCode = 1;
} finally {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(evidence, "results.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}
