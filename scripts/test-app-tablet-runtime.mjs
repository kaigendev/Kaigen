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
const identity = async filename => {
  const bytes = await fs.readFile(filename);
  return { path: filename, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
};
const report = { status: "RUNNING", startedAt: new Date().toISOString(), cases: [], sources: [],
  boundary: "Actual RootApp/App/editor and touch helper in Chromium using disposable mock backend and sessionStorage persistence. Real CDP touch events; no true webd or real tablet OS keyboard proof." };
let browser, server, page;
try {
  for (const name of ["src/App.tsx", "src/App.css", "src/RootApp.tsx", "src/SpellcheckComposer.tsx", "src/platform/browser-input.ts", "src/touchContextMenu.ts",
    "scripts/test-app-tablet-runtime.mjs", ...["index.html", "entry.tsx", "platform.ts"].map(name => "scripts/fixtures/app-tablet-runtime/" + name),
    ...["app-platform.ts", "onboarding-platform.ts", "qtox-export-platform.ts", "avatar-owner-platform.ts", "avatar-settings-platform.ts"].map(name => "scripts/fixtures/chat-geometry-runtime/" + name)]) {
    report.sources.push({ ...await identity(path.join(root, name)), path: name });
  }
  report.runner = { node: process.version, playwright: await identity(options.get("--playwright-module")), chromium: await identity(options.get("--chromium-executable")) };
  const require = createRequire(path.join(root, "package.json"));
  const { build } = await import(pathToFileURL(require.resolve("vite")).href);
  const react = (await import(pathToFileURL(require.resolve("@vitejs/plugin-react")).href)).default;
  const fixture = path.join(root, "scripts/fixtures/app-tablet-runtime"), dist = path.join(evidence, "dist");
  await build({ configFile: false, root: fixture, publicDir: path.join(root, "public"), logLevel: "warn", plugins: [react()],
    resolve: { dedupe: ["react", "react-dom"], alias: {
      "@kaigen/platform": path.join(fixture, "platform.ts"), "@kaigen/theme": path.join(root, "src/theme.tsx"),
    } }, define: { __KAIGEN_PRODUCT__: JSON.stringify("web") }, build: { outDir: dist, emptyOutDir: false } });
  server = http.createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url, "http://127.0.0.1").pathname;
      const filename = path.resolve(dist, pathname === "/" ? "index.html" : "." + pathname);
      assert(filename.startsWith(dist + path.sep));
      res.setHeader("Content-Type", ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml" })[path.extname(filename)] ?? "application/octet-stream");
      res.end(await fs.readFile(filename));
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = "http://127.0.0.1:" + server.address().port;
  const { chromium } = await import(pathToFileURL(options.get("--playwright-module")).href);
  browser = await chromium.launch({ executablePath: options.get("--chromium-executable"), headless: true });
  const context = await browser.newContext({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15", hasTouch: true, isMobile: true,
    viewport: { width: 1280, height: 900 }, locale: "ru" });
  await context.addInitScript(() => { Object.defineProperty(navigator, "platform", { get: () => "MacIntel" }); Object.defineProperty(navigator, "maxTouchPoints", { get: () => 5 }); });
  page = await context.newPage(); const errors = [];
  page.on("pageerror", error => errors.push(String(error)));
  const editor = page.locator('[data-kaigen-composer-editor="true"]');
  async function ready(route = "") {
    await page.goto(url + route);
    await editor.waitFor();
    await page.locator("[data-message-key]").first().waitFor();
    await page.waitForFunction(() => window.appTabletFixture.readSaved()?.activeChat);
  }
  async function countSent() { return page.evaluate(() => window.appTabletFixture.sent.length); }
  await ready();
  assert.equal(await page.evaluate(() => window.appTabletFixture.readSaved().sendOnEnter), false);
  await editor.fill("first line"); await editor.press("Enter"); await page.keyboard.type("second line");
  assert.equal(await countSent(), 0, "Tablet Enter never sends");
  assert((await editor.innerText()).includes("\n"), "Enter inserted actual newline");
  await editor.press("Shift+Enter"); await page.waitForFunction(() => window.appTabletFixture.sent.length === 1);
  assert.equal(await page.evaluate(() => window.appTabletFixture.sent[0].text), "first line\nsecond line");
  await editor.fill("button send"); await page.locator("button.send").click();
  await page.waitForFunction(() => window.appTabletFixture.sent.length === 2);
  report.cases.push({ name: "tablet default actual Enter/newline Shift-send/button", status: "PASS" });
  for (const saved of [true, false]) {
    await page.evaluate(() => sessionStorage.clear());
    await ready("/?saved=" + saved);
    assert.equal(await page.evaluate(() => window.appTabletFixture.readSaved().sendOnEnter), saved);
    await page.evaluate(() => history.replaceState(null, "", "/"));
    await page.reload(); await editor.waitFor();
    await page.waitForFunction(value => window.appTabletFixture.readSaved()?.sendOnEnter === value, saved);
    await editor.fill("restored choice"); await editor.press("Enter");
    if (saved) await page.waitForFunction(() => window.appTabletFixture.sent.length === 1);
    else { assert.equal(await countSent(), 0); assert((await editor.innerText()).includes("\n")); }
    report.cases.push({ name: "saved choice reload", saved, status: "PASS" });
  }
  await page.evaluate(() => sessionStorage.clear()); await ready();
  await page.evaluate(() => {
    window.tabletEventTrace = [];
    for (const name of ["pointerdown", "pointerup", "pointercancel", "mousedown", "mouseup", "click", "contextmenu", "scroll"]) document.addEventListener(name, event => {
      const target = event.target;
      window.tabletEventTrace.push({ type: event.type, pointerType: event.pointerType, detail: event.detail, defaultPrevented: event.defaultPrevented, target: target?.className, menu: document.querySelectorAll(".contact-context-menu").length, at: performance.now() });
    }, true);
  });
  const cdp = await context.newCDPSession(page);
  const menu = page.locator(".contact-context-menu");
  const contact = page.locator(".chat-item").nth(2);
  const initialChat = await page.locator(".chat-item.selected").innerText();
  async function point(locator) { await locator.scrollIntoViewIfNeeded(); const b = await locator.boundingBox(); assert(b); return { x: b.x + Math.min(30, b.width / 2), y: b.y + b.height / 2, id: 1 }; }
  async function touch(type, points = []) { await cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points }); }
  async function clearMenus() { await page.keyboard.press("Escape"); await page.mouse.click(1220, 60); }
  async function noMenu(name) { await page.waitForTimeout(650); assert.equal(await menu.count(), 0, name); report.cases.push({ name, status: "PASS" }); }
  const p = await point(contact);
  await touch("touchStart", [p]); await page.waitForTimeout(650); await menu.waitFor();
  await touch("touchEnd"); await page.waitForTimeout(150);
  assert.equal(await menu.count(), 1); assert.equal(await page.locator(".chat-item.selected").innerText(), initialChat, "Hold must not switch chat");
  report.cases.push({ name: "contact real touch hold/release suppress click", status: "PASS" });
  await clearMenus();
  const row = page.locator("[data-message-key]").filter({ has: page.locator(".message-text") }).last();
  // Message rows may expose text through inline enhancements; use a non-file row.
  const message = await row.count() ? row : page.locator("[data-message-key]").nth(-2);
  await touch("touchStart", [await point(message)]); await page.waitForTimeout(650); await menu.waitFor(); await touch("touchEnd");
  assert.equal(await menu.count(), 1); report.cases.push({ name: "message real touch hold", status: "PASS" });
  await clearMenus();
  const imageRow = page.locator("[data-message-key]").filter({ has: page.locator(".image-attachment") }).last();
  assert.equal(await imageRow.count(), 1, "Image fixture exists");
  const imageButton = imageRow.locator(".image-attachment button");
  await touch("touchStart", [await point(imageButton)]); await page.waitForTimeout(650); await menu.waitFor(); await touch("touchEnd");
  assert.equal(await menu.count(), 1); assert.equal(await page.locator(".image-viewer").count(), 0);
  report.cases.push({ name: "attachment hold suppress image open", status: "PASS" });
  await clearMenus();
  await imageButton.tap(); await page.locator(".image-viewer").waitFor();
  await page.locator(".image-viewer-close").click();
  report.cases.push({ name: "attachment normal tap still opens image", status: "PASS" });
  await touch("touchStart", [p]); await touch("touchEnd"); await noMenu("short tap normal");
  assert.notEqual(await page.locator(".chat-item.selected").innerText(), initialChat);
  await page.locator(".chat-item").nth(1).click(); await editor.waitFor();
  await touch("touchStart", [p]); await touch("touchMove", [{ ...p, x: p.x + 30 }]); await touch("touchEnd"); await noMenu("motion cancels hold");
  await touch("touchStart", [p]); await touch("touchStart", [p, { ...p, x: p.x + 50, id: 2 }]); await touch("touchEnd"); await noMenu("multitouch cancels hold");
  await touch("touchStart", [p]); await touch("touchCancel"); await noMenu("pointer cancel aborts hold");
  const scroll = page.locator(".message-scroll"), messagePoint = await point(page.locator("[data-message-key]").last());
  await touch("touchStart", [messagePoint]);
  await scroll.evaluate(element => { element.scrollTop -= 200; });
  await page.waitForTimeout(650); await touch("touchEnd"); await noMenu("scroll aborts hold");
  await touch("touchStart", [p]); await page.locator(".chat-item").nth(0).evaluate(element => element.click()); await page.waitForTimeout(650); await touch("touchEnd"); await noMenu("chat lifecycle cancels hold");
  await editor.fill("editable preserved"); const editPoint = await point(editor);
  await touch("touchStart", [editPoint]); await page.waitForTimeout(650); await touch("touchEnd");
  assert.equal(await menu.count(), 0); assert.equal(await editor.innerText(), "editable preserved");
  report.cases.push({ name: "editable hold preserves input", status: "PASS" });
  await contact.click({ button: "right" }); await menu.waitFor(); await clearMenus();
  await page.locator(".message[data-message-key]").last().focus(); await page.keyboard.press("Shift+F10"); await menu.waitFor(); await clearMenus();
  report.cases.push({ name: "mouse and keyboard existing context routes", status: "PASS" });
  assert.deepEqual(errors, []); await context.close(); report.status = "PASS";
} catch (error) {
  report.status = "FAIL"; report.error = String(error.stack ?? error); process.exitCode = 1;
  if (page) {
    report.events = await page.evaluate(() => window.tabletEventTrace ?? []).catch(() => []);
    report.dom = await page.locator("body").innerText().catch(() => "");
    await page.screenshot({ path: path.join(evidence, "failure.png") }).catch(() => {});
  }
}
finally {
  await browser?.close(); if (server) await new Promise(resolve => server.close(resolve));
  report.finishedAt = new Date().toISOString(); await fs.writeFile(path.join(evidence, "results.json"), JSON.stringify(report, null, 2) + "\n"); console.log(JSON.stringify(report, null, 2));
}
