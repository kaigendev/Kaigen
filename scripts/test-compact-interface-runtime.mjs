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
  boundary: "Actual RootApp/App/settings/editor/tooltip and touch helper in headless Chromium using disposable mock backend. Sends terminate in synthetic fixture; no network messages, native Windows window or physical touch device proof." };
let browser, server, page;
try {
  for (const name of ["src/App.tsx", "src/App.css", "src/RootApp.tsx", "src/SpellcheckComposer.tsx", "src/platform/browser-input.ts", "src/touchContextMenu.ts",
    "src/Settings.tsx", "src/Settings.css", "src/ControlTooltip.tsx", "src/ControlTooltip.css", "src/contactGroups.ts", "src/contextMenuPlacement.ts", "src/ChatMessageEnhancements.tsx", "src/compactLayout.ts",
    "scripts/test-compact-interface-runtime.mjs", "scripts/fixtures/app-tablet-runtime/platform.ts", ...["index.html", "entry.tsx", "platform.ts"].map(name => "scripts/fixtures/compact-interface-runtime/" + name),
    ...["app-platform.ts", "onboarding-platform.ts", "qtox-export-platform.ts", "avatar-owner-platform.ts", "avatar-settings-platform.ts"].map(name => "scripts/fixtures/chat-geometry-runtime/" + name)]) {
    report.sources.push({ ...await identity(path.join(root, name)), path: name });
  }
  report.runner = { node: process.version, playwright: await identity(options.get("--playwright-module")), chromium: await identity(options.get("--chromium-executable")) };
  const require = createRequire(path.join(root, "package.json"));
  const { build } = await import(pathToFileURL(require.resolve("vite")).href);
  const react = (await import(pathToFileURL(require.resolve("@vitejs/plugin-react")).href)).default;
  const fixture = path.join(root, "scripts/fixtures/compact-interface-runtime"), dist = path.join(evidence, "dist");
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
    viewport: { width: 390, height: 844 }, locale: "ru" });
  await context.addInitScript(() => { Object.defineProperty(navigator, "platform", { get: () => "MacIntel" }); Object.defineProperty(navigator, "maxTouchPoints", { get: () => 5 }); });
  page = await context.newPage(); const errors = [];
  page.setDefaultTimeout(8000);
  page.on("pageerror", error => errors.push(String(error)));

  const editor = page.locator('[data-kaigen-composer-editor="true"]');
  const back = page.getByRole('button', { name: 'Назад', exact: true });
  const popup = page.locator('.contact-context-menu:not(.contact-group-submenu)');
  const check = (name, detail = {}) => report.cases.push({ name, ...detail, status: "PASS" });
  async function visibleBox(locator, label, requireHit = true) {
    await locator.waitFor({ state: "visible" });
    const result = await locator.evaluate(element => {
      const r = element.getBoundingClientRect();
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom,
        inside: r.x >= -1 && r.y >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1,
        reachable: element === hit || element.contains(hit) };
    });
    assert(result.inside && (!requireHit || result.reachable), label + ": " + JSON.stringify(result));
    return result;
  }
  async function home() {
    await page.locator('.compact-profile-trigger').waitFor({ state: 'visible' });
    await page.locator('.chat-item').first().waitFor({ state: 'visible' });
  }
  async function closeMenu() { await page.keyboard.press('Escape'); await popup.waitFor({ state: 'hidden' }); }
  await page.goto(url); await home();
  await page.waitForFunction(() => document.querySelector('.compact-own-status')?.textContent.includes('Alice status'));
  assert.equal(await page.locator('.profile-drawer').count(), 0);
  await page.getByRole('button', { name: 'Следующий профиль', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.compact-own-status')?.textContent.includes('Second status'));
  assert.match(await page.locator('.compact-profile-trigger').innerText(), /QA Second/);
  assert.match(await page.locator('.own-tox-id').innerText(), /E{15}/);
  await page.waitForFunction(() => document.querySelector('.compact-network-status')?.classList.contains('away'));
  assert.match(await page.locator('.chat-item').first().innerText(), /Second contact/);
  await page.getByRole('button', { name: 'Предыдущий профиль', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.compact-own-status')?.textContent.includes('Alice status'));
  await page.waitForFunction(() => document.querySelector('.compact-network-status')?.classList.contains('online'));
  assert.match(await page.locator('.chat-item').first().innerText(), /Alice contact/);
  check('profile arrows immediately replace nickname, Tox ID, user status and contact list');

  for (const size of [{ width: 390, height: 844 }, { width: 320, height: 401 }, { width: 800, height: 320 }]) {
    await page.setViewportSize(size); await home();
    await page.locator('.compact-avatar-trigger').click();
    await page.locator('.settings-content').waitFor({ state: 'visible' });
    await back.click(); await home();
    await page.locator('.tor-indicator').click();
    await page.locator('.settings-content').waitFor({ state: 'visible' });
    await back.click(); await home();
    await page.locator('.compact-nav-item.settings').click();
    await page.locator('.settings-tabs').waitFor({ state: 'visible' });
    await page.locator('.settings-tabs button').first().click();
    await page.locator('.settings-content').waitFor({ state: 'visible' });
    await visibleBox(page.locator('.save-button'), 'compact save action');
    const footer = await page.locator('.settings-footer').boundingBox();
    assert(footer.height <= 76, 'Save footer must remain compact');
    await back.click(); await page.locator('.settings-tabs').waitFor({ state: 'visible' });
    await back.click(); await home();
    await page.locator('.chat-item').first().click(); await editor.waitFor({ state: 'visible' });
    await visibleBox(editor, 'composer'); await visibleBox(page.locator('button.send'), 'send action');
    await visibleBox(page.locator('button.attach'), 'attachment action');
    await editor.fill('compact draft');
    assert.equal(await editor.innerText(), 'compact draft');
    const sent = await page.evaluate(() => window.appTabletFixture.sent.length);
    await page.locator('button.send').click();
    await page.waitForFunction(previous => window.appTabletFixture.sent.length === previous + 1, sent);
    assert.equal(await page.evaluate(() => window.appTabletFixture.sent.at(-1).text), 'compact draft');
    await back.click(); await home();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    check('direct settings Back, settings menu Back, save footer and composer geometry', size);
  }

  await page.setViewportSize({ width: 390, height: 844 }); await home();
  const toolbar = page.locator('[data-control-tooltip]');
  const count = await toolbar.count(); assert(count >= 5, 'Search and sorting controls participate');
  for (let pass = 0; pass < 2; pass++) {
    for (const index of [...Array(count).keys(), ...Array(count).keys()].map((i, n) => n < count ? i : count - 1 - i)) {
      const control = toolbar.nth(index);
      await control.hover();
      const tooltip = page.getByRole('tooltip');
      await tooltip.waitFor({ state: 'visible' });
      assert.equal(await tooltip.innerText(), await control.getAttribute('data-control-tooltip'));
      await visibleBox(tooltip, 'tooltip bounds', false);
      assert(await control.getAttribute('aria-describedby'), 'Tooltip describes its current control');
    }
  }
  await page.mouse.move(1, 1); await page.getByRole('tooltip').waitFor({ state: 'hidden' });
  check('search and toolbar tooltips survive repeated forward and reverse hover');

  for (const size of [{ width: 320, height: 401 }, { width: 390, height: 844 }, { width: 800, height: 320 }]) {
    await page.setViewportSize(size); await home();
    const contact = page.locator('.chat-item').first();
    await contact.click({ button: 'right' });
    const before = await visibleBox(popup, 'contact popup');
    assert(before.width <= size.width / 2 + 1 && before.height < size.height * .75, 'Contact popup stays compact');
    assert.equal(await page.locator('.compact-sheet').count(), 0, 'No full-screen action sheet');
    assert.match(await popup.innerText(), /Удалить[\s\S]*Скопировать полный Tox ID[\s\S]*Группа/);
    const trigger = popup.locator('.contact-group-menu-trigger');
    await trigger.focus(); await page.keyboard.press('ArrowRight');
    const submenu = page.locator('.contact-group-submenu');
    await visibleBox(submenu, 'group submenu');
    const after = await visibleBox(popup, 'stable parent popup');
    assert(Math.abs(before.x - after.x) < 1 && Math.abs(before.y - after.y) < 1, 'Parent must not jump when submenu opens');
    assert.equal(await submenu.getByRole('menuitemradio').count() > 0, true);
    await submenu.getByRole('menuitemradio').first().click(); await popup.waitFor({ state: 'hidden' });
    await page.waitForFunction(() => window.appTabletFixture.readSaved()?.contactGroups?.assignments?.['A'.repeat(64)] === 'compact-fixture-group');
    check('contact popup retains actions and stable accessible nested group menu', size);
  }
  await page.setViewportSize({ width: 390, height: 844 }); await home();
  const cdp = await context.newCDPSession(page);
  const contact = page.locator('.chat-item').first(); const box = await visibleBox(contact, 'touch contact');
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + 20, y: box.y + box.height / 2, id: 1 }] });
  await page.waitForTimeout(650); await popup.waitFor({ state: 'visible' });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await visibleBox(popup, 'long-tap contact popup');
  assert.equal(await page.locator('.app-shell.compact-chat-open').count(), 0, 'Hold does not activate contact');
  await closeMenu(); check('real CDP touch hold opens compact contact popup without accidental chat');
  await contact.click(); await editor.waitFor({ state: 'visible' });
  const touchMessage = page.locator('.message[data-message-key]').filter({ has: page.locator('.message-text') }).last();
  await touchMessage.scrollIntoViewIfNeeded();
  const messageBox = await visibleBox(touchMessage, 'touch message');
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: messageBox.x + 20, y: messageBox.y + messageBox.height / 2, id: 1 }] });
  await page.waitForTimeout(650); await popup.waitFor({ state: 'visible' });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await visibleBox(popup, 'long-tap message popup'); await closeMenu();
  await touchMessage.focus(); await page.keyboard.press('Shift+F10'); await popup.waitFor({ state: 'visible' }); await closeMenu();
  check('message real CDP touch hold and keyboard context route remain accessible');
  for (const size of [{ width: 320, height: 401 }, { width: 390, height: 844 }, { width: 800, height: 320 }]) {
    await page.setViewportSize(size);
    const message = page.locator('.message[data-message-key]').filter({ has: page.locator('.message-text') }).last();
    await message.scrollIntoViewIfNeeded(); await message.click({ button: 'right' });
    const bounds = await visibleBox(popup, 'message popup');
    assert(bounds.width <= size.width - 16 && bounds.height < size.height, 'Message popup fits viewport');
    assert.equal(await popup.getByRole('menuitem', { name: 'Цитировать', exact: true }).count(), 1);
    assert.equal(await popup.getByRole('menuitem', { name: 'Скопировать', exact: true }).count(), 1);
    await popup.getByRole('menuitem', { name: 'Цитировать', exact: true }).click();
    await popup.waitFor({ state: 'hidden' });
    assert(await page.locator('.composer-reply-preview').count() > 0, 'Quote action reaches composer');
    await page.locator('.composer-reply-preview button').click();
    check('message compact context actions fit and quoting remains functional', size);
  }
  assert.deepEqual(errors, []); await context.close(); report.status = 'PASS';
} catch (error) {
  report.status = 'FAIL'; report.error = String(error.stack ?? error); process.exitCode = 1;
  if (page) { report.dom = await page.locator('body').innerText().catch(() => ''); await page.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => {}); }
} finally {
  await browser?.close(); if (server) await new Promise(resolve => server.close(resolve));
  report.finishedAt = new Date().toISOString(); await fs.writeFile(path.join(evidence, 'results.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, cases: report.cases, error: report.error, evidence }, null, 2));
}
