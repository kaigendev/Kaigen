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
  assert(["--playwright-module", "--chromium-executable", "--evidence-root", "--scenario"].includes(process.argv[i]));
  assert(process.argv[i + 1] && !options.has(process.argv[i]));
  options.set(process.argv[i], process.argv[i + 1]);
}
for (const key of ["--playwright-module", "--chromium-executable", "--evidence-root"]) assert(options.has(key), key);
const scenario = options.get("--scenario") ?? "full";
assert(["full", "tor-geometry"].includes(scenario));
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
    "src/Settings.tsx", "src/Settings.css", "src/Compact.css", "src/i18n.tsx", "src/ControlTooltip.tsx", "src/ControlTooltip.css", "src/contactGroups.ts", "src/contextMenuPlacement.ts", "src/ChatMessageEnhancements.tsx", "src/compactLayout.ts",
    "scripts/test-compact-interface-runtime.mjs", "scripts/fixtures/app-tablet-runtime/platform.ts", ...["index.html", "entry.tsx", "platform.ts"].map(name => "scripts/fixtures/compact-interface-runtime/" + name),
    ...["app-platform.ts", "onboarding-platform.ts", "qtox-export-platform.ts", "avatar-owner-platform.ts", "avatar-settings-platform.ts"].map(name => "scripts/fixtures/chat-geometry-runtime/" + name)]) {
    report.sources.push({ ...await identity(path.join(root, name)), path: name });
  }
  report.runner = { node: process.version, playwright: await identity(options.get("--playwright-module")), chromium: await identity(options.get("--chromium-executable")) };
  const require = createRequire(path.join(root, "package.json"));
  const { build } = await import(pathToFileURL(require.resolve("vite")).href);
  const react = (await import(pathToFileURL(require.resolve("@vitejs/plugin-react")).href)).default;
  const fixture = path.join(root, "scripts/fixtures/compact-interface-runtime"), dist = path.join(evidence, "dist");
  await build({ configFile: false, root: fixture, publicDir: path.join(root, "public"), logLevel: "warn", plugins: [react(), {name:'exact-owned-inputs',async generateBundle(){for(const id of this.getModuleIds()){const filename=path.normalize(id.split('?')[0]);if(filename.startsWith(path.resolve(root)+path.sep)&&await fs.stat(filename).then(s=>s.isFile()).catch(()=>false)){const relative=path.relative(root,filename).replaceAll('\\','/');if(!report.sources.some(item=>item.path===relative))report.sources.push({...await identity(filename),path:relative});}}}}],
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
    const result = await locator.evaluate(async (element, requireHit) => {
      let previous, result;
      const deadline = performance.now() + 2000;
      do {
        await new Promise(resolve => requestAnimationFrame(resolve));
        const r = element.getBoundingClientRect();
        const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        result = { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom,
          inside: r.x >= -1 && r.y >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1,
          reachable: element === hit || element.contains(hit) };
        const geometry = JSON.stringify([r.x, r.y, r.width, r.height]);
        if (result.inside && (!requireHit || result.reachable) && geometry === previous) return { ...result, stable: true };
        previous = geometry;
      } while (performance.now() < deadline);
      return { ...result, stable: false };
    }, requireHit);
    assert(result.stable && result.inside && (!requireHit || result.reachable), label + ": " + JSON.stringify(result));
    return result;
  }
  async function home() {
    await page.locator('.compact-profile-trigger').waitFor({ state: 'visible' });
    await page.locator('.chat-item').first().waitFor({ state: 'visible' });
  }
  async function contactToolbar() {
    const controls = page.locator('.contact-list-heading button');
    assert.equal(await controls.count(), 6, 'All six contact actions remain mounted');
    for (let index = 0; index < 6; index++) await visibleBox(controls.nth(index), 'contact action ' + index);
    const label = page.locator('.contact-list-heading .section-label');
    if (await label.isVisible()) {
      const whole = await label.evaluate(element => element.scrollWidth <= element.clientWidth + 1);
      assert(whole, 'Contacts label is shown whole, never truncated');
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  }
  async function settingsNavigation() {
    const navigation = page.locator('.compact-bottom-nav');
    await visibleBox(navigation, 'bottom navigation in Settings', false);
    const controls = navigation.locator('button');
    const logicalWidth = await page.locator('.app-shell').evaluate(element => element.clientWidth);
    for (let index = 0; index < await controls.count(); index++) {
      await visibleBox(controls.nth(index), 'bottom navigation action ' + index);
      const caption = await controls.nth(index).locator('span').evaluate(element => {
        const range = document.createRange(); range.selectNodeContents(element);
        const lines = [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0);
        const box = element.getBoundingClientRect();
        return { text: element.textContent, lines: lines.length, whole: element.scrollWidth <= element.clientWidth + 1,
          fontSize: parseFloat(getComputedStyle(element).fontSize),
          inside: lines.every(rect => rect.left >= box.left - 1 && rect.right <= box.right + 1 && rect.top >= box.top - 1 && rect.bottom <= box.bottom + 1) };
      });
      assert((logicalWidth >= 320 ? caption.lines === 1 : caption.lines >= 1 && caption.lines <= 3 && caption.fontSize >= 10) && caption.whole && caption.inside,
        'Whole bottom navigation caption: ' + JSON.stringify({ ...caption, logicalWidth }));
    }
    assert.deepEqual(await controls.evaluateAll(buttons => buttons.map(button => [...button.classList].find(name => name !== 'compact-nav-item'))),
      ['chats', 'requests', 'groups', 'publications'], 'Bottom navigation retains exactly the four ordered sections without Settings');
    assert.equal(await navigation.locator('[aria-current="page"]').count(), 0, 'Settings is outside the bottom navigation sections');
    await visibleBox(page.locator('.compact-secondary-header .compact-action'), 'Settings Back');
    await page.locator('.settings-content').waitFor({ state: 'visible' });
    assert.equal(await page.locator('.settings-tabs [aria-current="page"]').count(), 1, 'The opened Settings section remains selected');
    assert.equal(await page.locator('.compact-profile-menu-host [role="menu"]').count(), 0, 'Opening Settings dismisses the profile actions menu');
    assert.equal(await page.locator('.save-button, .settings-footer').count(), 0, 'Global Save and footer are absent');
  }
  async function closeMenu() { await page.keyboard.press('Escape'); await popup.waitFor({ state: 'hidden' }); }
  await page.goto(url); await home();
  if (scenario === 'tor-geometry') {
    report.scenario = scenario;
    const states = [['disabled', 0], ['starting', 0], ['connecting', 0], ['connecting', 75], ['connecting', 100], ['connected', 100], ['error', 0]];
    const noOverlap = (a, b, label) => assert(Math.min(a.right, b.right) - Math.max(a.x, b.x) <= .5 || Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y) <= .5, label);
    const unchanged = (actual, baseline, label) => {
      for (const key of ['x', 'y', 'width', 'height']) assert(Math.abs(actual[key] - baseline[key]) <= .5, label + ': ' + key);
    };
    for (const language of ['ru', 'en']) {
      await home();
      await page.locator('.compact-profile-menu-host .rail-profile-menu-button').click();
      await page.locator('.compact-profile-menu-host [role="menuitem"]').nth(1).click();
      await page.locator('.settings-tabs').getByRole('button', { name: 'Язык', exact: true }).click();
      await page.locator('.settings-content select').selectOption(language);
      await page.locator('.compact-nav-item.chats').click(); await home();
      for (const viewport of [{ width: 320, height: 401 }, { width: 402, height: 874 }, { width: 874, height: 320 }]) {
        await page.setViewportSize(viewport); await home();
        let baselineHome, baselineComposer;
        for (const [state, progress] of states) {
          await page.evaluate(({state, progress}) => window.compactTorFixture.setState(state, progress), {state, progress});
          const caption = state === 'connecting' ? `${progress}%` : ({ru:{disabled:'Отключен',starting:'Запуск',connected:'Подключен',error:'Ошибка'},en:{disabled:'Offline',starting:'Starting',connected:'Connected',error:'Error'}})[language][state];
          await page.waitForFunction(({state, caption}) => document.querySelector('.compact-header .tor-indicator')?.classList.contains(state) && document.querySelector('.compact-header .tor-status-line')?.textContent.trim() === caption, {state, caption});
          const observation=await page.evaluate(()=>({caption:document.querySelector('.compact-header .tor-status-line').textContent.trim(),indicatorClass:document.querySelector('.compact-header .tor-indicator').className}));
          const homeRects = {};
          for (const [name, selector] of Object.entries({avatar:'.compact-avatar-trigger',profile:'.compact-profile-trigger',menu:'.compact-profile-menu-host .rail-profile-menu-button',switcher:'.compact-profile-selector',tor:'.compact-header .tor-indicator',caption:'.compact-header .tor-status-line',nav:'.compact-bottom-nav'})) homeRects[name] = await visibleBox(page.locator(selector), name, !['switcher','caption','nav'].includes(name));
          const interactive = page.locator('.compact-profile-selector button:enabled, .compact-bottom-nav button:enabled');
          const controls=[]; for(let i=0;i<await interactive.count();i++) controls.push(await visibleBox(interactive.nth(i),'profile/nav control '+i));
          for(let i=0;i<controls.length;i++) for(let j=i+1;j<controls.length;j++) noOverlap(controls[i],controls[j],'profile/nav controls do not overlap');
          for(const name of ['avatar','profile','menu','switcher','nav']) noOverlap(homeRects.tor,homeRects[name],'Tor does not overlap '+name);
          assert(await page.locator('.compact-header .tor-status-line').evaluate(el=>el.scrollWidth<=el.clientWidth+1),'Tor caption is not truncated');
          if(baselineHome) for(const name of Object.keys(homeRects)) unchanged(homeRects[name],baselineHome[name],'Tor state does not move '+name); else baselineHome=homeRects;
          await page.locator('.chat-item').first().click(); await editor.waitFor({state:'visible'});
          const composer={editor:await visibleBox(editor,'composer'),send:await visibleBox(page.locator('button.send'),'send'),attach:await visibleBox(page.locator('button.attach'),'attachment')};
          noOverlap(composer.editor,composer.send,'Editor/send do not overlap'); noOverlap(composer.editor,composer.attach,'Editor/attach do not overlap'); noOverlap(composer.send,composer.attach,'Composer buttons do not overlap');
          if(baselineComposer) for(const name of Object.keys(composer)) unchanged(composer[name],baselineComposer[name],'Tor state does not move composer '+name); else baselineComposer=composer;
          await page.locator('.compact-chat-back').click(); await home();
          check('Tor status geometry and composer remain stable', {language,viewport,state,progress,caption,observation,homeRects,composer});
        }
        await page.screenshot({path:path.join(evidence,`tor-geometry-${language}-${viewport.width}x${viewport.height}.png`)});
      }
    }
  } else {
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
    await contactToolbar();
    await page.locator('.compact-avatar-trigger').click();
    await page.locator('.settings-content').waitFor({ state: 'visible' });
    await back.click(); await home();
    await page.locator('.tor-indicator').click();
    await page.locator('.settings-content').waitFor({ state: 'visible' });
    await back.click(); await home();
    await page.locator('.compact-profile-menu-host .rail-profile-menu-button').click();
    await page.locator('.compact-profile-menu-host [role="menuitem"]').nth(1).click();
    await page.locator('.settings-tabs').waitFor({ state: 'visible' });
    await page.locator('.settings-tabs button').first().click();
    await page.locator('.settings-content').waitFor({ state: 'visible' });
    await settingsNavigation();
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
    check('direct settings Back, settings menu Back, bottom navigation without Save and composer geometry', size);
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
  await editor.focus();
  await editor.evaluate(el=>{const range=document.createRange();range.selectNodeContents(el);range.collapse(false);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);});
  const composerCaret=()=>editor.evaluate(el=>{const selection=getSelection();return document.activeElement===el&&selection.rangeCount>0&&selection.isCollapsed&&el.contains(selection.anchorNode)&&el.contains(selection.focusNode);});
  assert(await composerCaret(),'Composer has a real caret before message double tap');
  const focusedMessage=await visibleBox(touchMessage,'focused composer message target');
  const tapPoint={x:focusedMessage.x+20,y:focusedMessage.y+focusedMessage.height/2,id:1};
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[tapPoint]});await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  assert(await editor.evaluate(el=>document.activeElement===el),'First message tap preserves composer focus');
  assert(await composerCaret(),'First message tap preserves composer caret');
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[tapPoint]});await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await page.locator('.composer-reply-preview').waitFor({state:'visible'});
  assert(await composerCaret(),'Message double tap preserves active composer caret like context Quote');
  assert.equal(await popup.count(),0,'Focused double tap quotes directly without context popup');
  await page.locator('.composer-reply-preview button').click();await editor.focus();
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[tapPoint]});await page.waitForTimeout(650);await popup.waitFor({state:'visible'});await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await closeMenu();
  assert.equal(await page.locator('.composer-reply-preview').count(),0,'Focused long press does not quote');
  await touchMessage.scrollIntoViewIfNeeded();await editor.focus();
  const panBox=await visibleBox(touchMessage,'focused composer pan target');const panPoint={x:panBox.x+20,y:panBox.y+panBox.height/2,id:1};
  const scrollBefore=await page.locator('.message-scroll').evaluate(el=>el.scrollTop);
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[panPoint]});
  for(const distance of [20,40,60,80])await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{...panPoint,y:panPoint.y+distance}]});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  assert(Math.abs(await page.locator('.message-scroll').evaluate(el=>el.scrollTop)-scrollBefore)>1,'Preventing compatibility focus preserves native touch pan');
  assert.equal(await page.locator('.composer-reply-preview').count(),0,'Native pan never quotes');
  await page.waitForFunction(()=>{const top=document.querySelector('.message-scroll').scrollTop;if(window.focusedPanTop!==top){window.focusedPanTop=top;window.focusedPanChanged=performance.now();return false;}return performance.now()-window.focusedPanChanged>150;});
  check('focused composer touch first tap preserves focus, double tap quotes, long press and native pan remain functional');
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
  await back.click(); await home();
  const settingsBack = page.locator('.compact-secondary-header .compact-action');
  async function settingsTab(name) {
    await page.locator('.compact-profile-menu-host .rail-profile-menu-button').click();
    await page.locator('.compact-profile-menu-host [role="menuitem"]').nth(1).click();
    const tabs = page.locator('.settings-tabs');
    await tabs.waitFor({ state: 'visible' });
    await tabs.getByRole('button', { name, exact: true }).click();
    await page.locator('.settings-content').waitFor({ state: 'visible' });
  }
  async function returnHome() {
    await page.locator('.compact-nav-item.chats').click(); await home();
    assert.equal(await page.locator('.compact-nav-item.chats').getAttribute('aria-current'), 'page');
  }
  async function lastSettingsControl() {
    const controls = page.locator('.settings-scroll button:visible:not(:disabled), .settings-scroll input:visible:not(:disabled), .settings-scroll select:visible:not(:disabled)');
    assert(await controls.count() > 0, 'Settings section has reachable controls');
    const last = controls.last();
    await last.scrollIntoViewIfNeeded();
    await visibleBox(last, 'last Settings control after scrolling');
    const scrolling = await page.evaluate(() => ({ app: document.querySelector('.app-shell').scrollTop,
      content: document.querySelector('.settings-scroll').scrollTop,
      required: document.querySelector('.settings-scroll').scrollHeight > document.querySelector('.settings-scroll').clientHeight + 1 }));
    assert.equal(scrolling.app, 0, 'Settings controls never scroll the outer app shell');
    if (scrolling.required) assert(scrolling.content > 0, 'Long Settings content scrolls its own container');
    await settingsNavigation();
  }
  for (const language of ['ru', 'en']) {
    // The first pass keeps Russian; the second selects English through the same real control.
    await settingsTab('Язык');
    await page.locator('.settings-content select').selectOption(language);
    await returnHome();
    for (const enlarged of [false, true]) {
      await settingsTab(language === 'ru' ? 'Чаты' : 'Chats');
      const font = page.locator('.typography-settings fieldset').first().locator('select').nth(1);
      const fontSize = enlarged ? await font.locator('option').evaluateAll(options => Math.max(...options.map(option => Number(option.value)))) : 16;
      await font.scrollIntoViewIfNeeded(); await visibleBox(font, 'interface font setting');
      await font.selectOption(String(fontSize));
      await page.waitForFunction(size => Math.abs(parseFloat(getComputedStyle(document.querySelector('.app-shell')).fontSize) - size) < .1, fontSize);
      await settingsNavigation();
      await returnHome();
      await settingsTab(language === 'ru' ? 'Чаты' : 'Chats');
      assert.equal(await page.locator('.typography-settings fieldset').first().locator('select').nth(1).inputValue(), String(fontSize), 'Appearance change survives reopening without Save');
      await returnHome();
      for (const size of [{ width: 320, height: 401 }, { width: 390, height: 844 }, { width: 800, height: 320 }]) {
        await page.setViewportSize(size); await home();
        if (size.width === 320) await page.locator('.contact-list-heading .section-label').waitFor({ state: 'hidden' });
        await contactToolbar();
        await settingsTab(language === 'ru' ? 'Чаты' : 'Chats');
        await settingsNavigation();
        const setting = page.locator('.typography-settings fieldset').first().locator('select').nth(1);
        await setting.scrollIntoViewIfNeeded(); await visibleBox(setting, 'scrollable Settings control');
        await visibleBox(settingsBack, 'Settings Back');
        await lastSettingsControl();
        await page.screenshot({ path: path.join(evidence, `settings-${language}-${fontSize}-${size.width}x${size.height}.png`) });
        await returnHome();
        await page.screenshot({ path: path.join(evidence, `contacts-${language}-${fontSize}-${size.width}x${size.height}.png`) });
        check('responsive contact actions, whole label, Settings navigation and immediate appearance', { ...size, language, fontSize });
      }
      await page.setViewportSize({ width: 320, height: 401 }); await home();
      await page.locator('.contact-list-heading .section-label').waitFor({ state: 'hidden' });
      await page.setViewportSize({ width: 800, height: 320 }); await home();
      await page.locator('.contact-list-heading .section-label').waitFor({ state: 'visible' });
      await contactToolbar();
      check('Contacts label returns when width becomes available', { language, fontSize });
    }
  }
  await settingsTab('Advanced');
  const scale = page.locator('.settings-content select:has(option[value="150"])');
  assert.equal(await scale.count(), 1, 'Actual interface scale control');
  await scale.scrollIntoViewIfNeeded(); await visibleBox(scale, 'interface scale setting');
  await scale.selectOption('150');
  await returnHome();
  for (const size of [{ width: 320, height: 401 }, { width: 390, height: 844 }, { width: 800, height: 320 }]) {
    await page.setViewportSize(size); await home(); await contactToolbar();
    await settingsTab('Advanced');
    assert.equal(await page.locator('.settings-content select:has(option[value="150"])').inputValue(), '150', 'Scale survives reopening without Save');
    await lastSettingsControl();
    await page.screenshot({ path: path.join(evidence, `settings-en-20-scale150-${size.width}x${size.height}.png`) });
    await returnHome();
    await page.screenshot({ path: path.join(evidence, `contacts-en-20-scale150-${size.width}x${size.height}.png`) });
    check('large interface scale keeps wrapped contact toolbar and Settings controls reachable', { ...size, language: 'en', fontSize: 20, interfaceScale: 150 });
  }
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
