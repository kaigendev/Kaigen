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
assert([undefined, "layout", "workspace-navigation", "workspace-link-recovery"].includes(options.get("--scenario")), "Unknown scenario");
const evidence = path.resolve(options.get("--evidence-root"));
assert(!await fs.stat(evidence).catch(() => null), "Fresh evidence directory required");
await fs.mkdir(evidence, { recursive: true });
const identity = async (filename) => {
  const bytes = await fs.readFile(filename);
  return { path: filename, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
};
async function workspaceNavigationScenarios(browser, url, report) {
  const a = "a".repeat(48), b = "b".repeat(48), c = "c".repeat(48);
  const ready = (page, identifier) => page.locator(`[data-fixture-identity="${identifier}"]`).waitFor();
  const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const log = page => page.evaluate(() => JSON.parse(sessionStorage.getItem("fixture-navigation-log") ?? "[]"));
  const context = await browser.newContext({ locale: "en", viewport: { width: 390, height: 844 } });
  await context.addInitScript(() => {
    window.navigationDocumentId = crypto.randomUUID();
    // Installed before the product listener, so a persisted restore is kept
    // even when WebRoot immediately reloads its retired document.
    window.addEventListener("pageshow", event => {
      if (!event.isTrusted) return;
      const events = JSON.parse(sessionStorage.getItem("fixture-pageshow-log") ?? "[]");
      events.push({ persisted: event.persisted, hash: location.hash, documentId: window.navigationDocumentId });
      sessionStorage.setItem("fixture-pageshow-log", JSON.stringify(events.slice(-64)));
    });
  });
  const page = await context.newPage(), errors = [];
  page.on("pageerror", error => errors.push(String(error)));
  try {
    const base = url + "/?navigation=1";
    await page.goto(base + "#k=" + a); await ready(page, a);
    const initialDocumentId = await page.evaluate(() => window.navigationDocumentId);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: false })));
    await settle(page);
    assert.equal(await page.evaluate(() => window.navigationDocumentId), initialDocumentId, "Normal pageshow must not reload the document");
    await page.evaluate(() => {
      window.oldNavigationDocument = true;
      window.workspaceNavigationFixture.hold("prepare");
      window.workspaceNavigationFixture.hold("leave");
    });
    // A real anchor performs normal same-document navigation. No reload or
    // direct controller call is issued by this test.
    await page.locator("#fixture-link-b").click();
    await page.waitForFunction(() => document.body.inert);
    assert.equal(await page.locator(`[data-fixture-identity="${a}"]`).count(), 1, "Old app remains mounted while its save drains");
    assert.equal(await page.evaluate(() => { const button = document.querySelector("#fixture-portal-action"); button.focus(); return document.activeElement === button; }), false, "Body portals cannot receive focus during navigation");
    await page.keyboard.press("Enter");
    assert(!(await log(page)).includes("portal-action"), "Inert portal cannot issue a user action");
    await page.goto(base + "#k=" + c);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
    await settle(page);
    assert.equal(await page.evaluate(() => window.oldNavigationDocument), true, "Rapid hash selection and cache resume wait for the old save before retirement");
    await page.evaluate(() => window.workspaceNavigationFixture.release("prepare"));
    await page.waitForFunction(() => JSON.parse(sessionStorage.getItem("fixture-navigation-log") ?? "[]").includes("leave"));
    assert.equal(await page.evaluate(() => window.oldNavigationDocument), true, "Document remains until local drain finishes");
    await page.evaluate(() => window.workspaceNavigationFixture.release("leave"));
    await ready(page, c);
    assert.equal(await page.evaluate(() => !!window.oldNavigationDocument), false, "Product router replaces the document");
    const events = await log(page);
    assert(events.indexOf("prepare") < events.indexOf("prepared") && events.indexOf("prepared") < events.indexOf("leave"));
    assert(!events.includes("lock") && !events.includes("close"), "Navigation does not revoke the shared workspace");
    report.cases.push({ scenario: "ordinary-anchor-latest-target", status: "PASS", preservedMountedSave: true, blockedPortal: true });
    await page.goBack(); await ready(page, b);
    assert.equal(await page.evaluate(() => document.body.inert), false, "Back cannot revive an inert retired document");
    await page.goForward(); await ready(page, c);
    assert.equal(await page.evaluate(() => document.body.inert), false, "Forward cannot revive an inert retired document");
    const pageshowEvents = await page.evaluate(() => JSON.parse(sessionStorage.getItem("fixture-pageshow-log") ?? "[]"));
    const persistedRestores = pageshowEvents.filter(event => event.persisted);
    report.backForwardCache = { requestedEnabled: true, persistedRestores, pageshowEvents,
      coverage: persistedRestores.length ? "OBSERVED" : "NOT_OBSERVED",
      boundary: "Only trusted browser pageshow events count; synthetic event branch checks are not actual BFCache proof." };
    report.cases.push({ scenario: "browser-back-forward-workspace", status: "PASS" });

    await page.locator("#fixture-link-a").click(); await ready(page, a);
    await page.evaluate(() => { window.oldNavigationDocument = true; window.workspaceNavigationFixture.failPrepare = true; });
    await page.locator("#fixture-link-b").click();
    await page.locator('.web-workspace-notice[role="alert"]').waitFor();
    assert.equal(new URL(page.url()).hash, "#k=" + a, "Failed save restores the old workspace address");
    assert.equal(await page.evaluate(() => window.oldNavigationDocument && !document.body.inert), true, "Failed save restores the same interactive document");
    await ready(page, a);
    await page.locator("#fixture-portal-action").click();
    assert.equal((await log(page)).at(-1), "portal-action", "Portal interaction is restored on failure");
    report.cases.push({ scenario: "failed-prepare-restores-url-and-ui", status: "PASS" });
    assert.deepEqual(errors, []);
  } finally { await context.close(); }

  for (const pending of ["lookup", "login", "create", "create-post"]) {
    const context = await browser.newContext({ locale: "en", viewport: { width: 390, height: 844 } });
    const page = await context.newPage(), errors = [];
    page.on("pageerror", error => errors.push(String(error)));
    try {
      const base = url + "/?navigation=1" + (pending === "lookup" ? "&hold=lookup" : pending === "login" ? "&auth=1" : "");
      await page.goto(base + (pending.startsWith("create") ? "" : "#k=" + a));
      await page.waitForFunction(() => !!window.workspaceNavigationFixture);
      await page.evaluate(name => { window.workspaceNavigationFixture.hold("leave"); if (name !== "lookup") window.workspaceNavigationFixture.hold(name); }, pending);
      if (pending === "login") {
        await page.locator('.web-gate-card input[type="password"]').fill("disposable-password");
        await page.locator(".web-gate-card .web-primary").click();
      } else if (pending.startsWith("create")) {
        const passwords = page.locator('.web-gate-card input[type="password"]');
        await passwords.nth(0).fill("disposable-password"); await passwords.nth(1).fill("disposable-password");
        await page.locator(".web-gate-card > form:not(.web-existing-workspace) > .web-primary").click();
      }
      await page.waitForFunction(name => JSON.parse(sessionStorage.getItem("fixture-navigation-log") ?? "[]").includes(name), pending);
      await page.goto(base + "#k=" + b);
      if (pending === "create-post") {
        await page.waitForFunction(() => location.hash === "" && !document.body.inert);
        await page.locator(".web-error").waitFor();
        assert.match(await page.locator(".web-error").textContent(), /Wait for the current action/u);
        assert(!(await log(page)).includes("cancel-opening"), "A submitted allocation keeps its original operation alive");
        await page.evaluate(() => window.workspaceNavigationFixture.release("create-post"));
        await ready(page, a);
        assert.equal(new URL(page.url()).hash, "#k=" + a, "Created workspace remains reachable after rejected navigation");
        assert.deepEqual(errors, []);
        report.cases.push({ scenario: "submitted-create-preserves-confirmed-link", status: "PASS" });
        continue;
      }
      await page.waitForFunction(() => document.body.inert);
      await page.evaluate(name => window.workspaceNavigationFixture.release(name), pending);
      await settle(page);
      assert.equal(new URL(page.url()).hash, "#k=" + b, `${pending}: late completion cannot replace the selected URL`);
      assert.equal(await page.locator("[data-created-workspace]").count(), 0, `${pending}: late completion cannot mount the previous workspace`);
      await page.evaluate(() => window.workspaceNavigationFixture.release("leave"));
      await ready(page, b);
      assert.deepEqual(errors, []);
      report.cases.push({ scenario: "late-" + pending + "-completion", status: "PASS" });
    } finally { await context.close(); }
  }
}
async function workspaceLinkRecoveryScenario(browser, url, report) {
  const stale = "d".repeat(48), valid = "a".repeat(48), token = "c".repeat(32);
  const key = "kaigen.web.launch.token.v1." + token;
  const entry = `${url}/?navigation=1&auth=1&launchRecovery=1&kaigen-launch=${token}`;
  const context = await browser.newContext({ locale: "en", viewport: { width: 390, height: 844 }, hasTouch: true });
  try {
    await context.addInitScript(({ key, stale }) => {
      Object.defineProperty(navigator, "standalone", { value: true });
      if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ v: 1, identifier: stale }));
    }, { key, stale });
    const page = await context.newPage();
    await page.goto(entry);
    await page.getByText("The workspace link is missing or invalid.", { exact: true }).waitFor();
    const form = page.locator(".web-existing-workspace");
    const link = form.locator("input");
    const submit = form.getByRole("button", { name: "Open workspace" });
    const readBinding = () => page.evaluate(key => JSON.parse(localStorage.getItem(key)).identifier, key);
    assert.equal(await readBinding(), stale);
    await link.fill(`https://other.invalid/#k=${valid}`);
    await submit.click();
    await form.getByRole("alert").waitFor();
    assert.equal(await readBinding(), stale, "Rejected links must preserve the install binding");
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await link.fill(`${url}/#k=${valid}`);
    await submit.click();
    await page.locator('input[autocomplete="current-password"]').waitFor();
    assert.equal(new URL(page.url()).hash, `#k=${valid}`);
    assert.equal(await readBinding(), valid, "Only the confirmed replacement is persisted");
    await page.goto(entry);
    await page.locator('input[autocomplete="current-password"]').waitFor();
    assert.equal(new URL(page.url()).hash, `#k=${valid}`, "The installed selector uses the recovered link on its next launch");
    report.cases.push({ scenario: "workspace-link-recovery", status: "PASS", viewportWidth: 390, passwordRequired: true });
  } finally { await context.close(); }
}

const report = { startedAt: new Date().toISOString(), status: "RUNNING", sources: [], cases: [],
  boundary: "Actual WebRoot/CSS and browser-input in disposable Chromium; controlled service fixture verifies actual WebRoot UI, not live backend admission; live workspace creation is separate evidence." };
let browser, server;
try {
  for (const name of ["src/web/WebRoot.tsx", "src/web/workspaceLaunch.ts", "src/web/workspaceNavigation.ts", "src/web/WebRoot.css", "src/App.css", "src/theme.css", "src/platform/browser-input.ts", "src/contextMenuCoordinator.ts",
    "scripts/test-web-service-panel-runtime.mjs", ...["index.html", "entry.tsx", "session.ts", "RootApp.tsx"].map(name => "scripts/fixtures/web-service-panel-runtime/" + name)]) {
    report.sources.push({ ...await identity(path.join(root, name)), path: name });
  }
  report.runner = { node: process.version, playwright: await identity(options.get("--playwright-module")), chromium: await identity(options.get("--chromium-executable")) };
  const require = createRequire(path.join(root, "package.json"));
  const { build } = await import(pathToFileURL(require.resolve("vite")).href);
  const react = (await import(pathToFileURL(require.resolve("@vitejs/plugin-react")).href)).default;
  const fixture = path.join(root, "scripts/fixtures/web-service-panel-runtime");
  const dist = path.join(evidence, "dist");
  await build({ configFile: false, root: fixture, publicDir: false, logLevel: "warn",
    plugins: [{ name: "exact-tablet-fixture", enforce: "pre", resolveId(source, importer) {
      const importedFrom = importer?.replaceAll("\\", "/");
      if (source === "./session" && importedFrom?.includes("/src/web/")) return path.join(fixture, "session.ts");
      if (importedFrom?.endsWith("/src/web/WebRoot.tsx")) {
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
  browser = await chromium.launch({ executablePath: options.get("--chromium-executable"), headless: true,
    ...(options.get("--scenario") === "workspace-navigation" ? { ignoreDefaultArgs: ["--disable-back-forward-cache"] } : {}),
  });
  if (options.get("--scenario") === "workspace-navigation") await workspaceNavigationScenarios(browser, url, report);
  else if (options.get("--scenario") === "workspace-link-recovery") await workspaceLinkRecoveryScenario(browser, url, report);
  else for (const language of ['ru', 'en']) for (const viewport of [{width:320,height:401},{width:390,height:844},{width:800,height:320},{width:1280,height:800}]) {
    const context = await browser.newContext({ locale: language, viewport, hasTouch: true });
    const page = await context.newPage();
    const errors=[]; page.on('pageerror', error=>errors.push(String(error)));
    await page.goto(url+'/?fail=1');
    const fields=page.locator('.web-gate-card input[type="password"]');
    await fields.nth(0).fill('disposable-password'); await fields.nth(1).fill('disposable-password');
    await page.locator('.web-gate-card > form:not(.web-existing-workspace) > .web-primary').click();
    await page.locator('.web-error').waitFor();
    assert.equal(await page.locator('.web-shell').count(),0,'Admission failure must not enter workspace');
    assert.equal(await page.locator('.web-gate-card > form:not(.web-existing-workspace) > .web-primary').isEnabled(),true,'Creation failure permits retry');
    assert.equal(await fields.nth(0).inputValue(),'disposable-password','Failure retains entered password');
    assert.equal(await fields.nth(1).inputValue(),'disposable-password','Failure retains confirmation');
    assert.equal(await page.evaluate(()=>window.workspaceCalls.length),1,'First failing submit called once');
    await page.evaluate(()=>{window.retryDocument=window.document;history.replaceState(history.state,'',location.pathname);});
    await page.locator('.web-gate-card > form:not(.web-existing-workspace) > .web-primary').click();
    await page.locator('[data-created-workspace="true"]').waitFor();
    assert.equal(await page.evaluate(()=>window.retryDocument===document),true,'Retry keeps same document');
    assert.equal(await page.evaluate(()=>window.workspaceCalls.length),2,'One failed allocation followed by one successful retry');
    const compact=await page.locator('.web-shell').evaluate(el=>el.classList.contains('web-shell-compact'));
    const app=page.locator('.web-app-window'); const original=await app.boundingBox();
    const hit=async locator=>locator.evaluate(el=>{const r=el.getBoundingClientRect();return r.width>0&&r.height>0&&r.left>=-0.5&&r.right<=innerWidth+0.5&&r.top>=-0.5&&r.bottom<=innerHeight+0.5&&el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'No horizontal overflow');
    if(compact){
      const handle=page.locator('.web-service-handle'); await page.waitForFunction(()=>!document.querySelector('.web-service-handle').disabled); assert(await hit(handle),'Handle reachable '+JSON.stringify(await handle.evaluate(el=>{const r=el.getBoundingClientRect();return {rect:r.toJSON(),width:innerWidth,height:innerHeight,hit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.outerHTML};})));
      const handleBox=await handle.boundingBox(); assert(original.y>=handleBox.y+handleBox.height-1,'Handle does not cover App');
      for(const dismiss of ['escape','close','back']){
        await handle.click(); const panel=page.locator('#web-service-panel');
        await page.waitForFunction(()=>document.querySelector('#web-service-panel').getAttribute('aria-modal')==='true');
        assert(await app.evaluate(el=>el.inert),'Open panel blocks App');
        const controls=panel.locator('button');
        for(let i=0;i<await controls.count();i++){await controls.nth(i).scrollIntoViewIfNeeded(); assert(await hit(controls.nth(i)),'All controls remain reachable after scrolling');}
        if(dismiss==='escape') await page.screenshot({path:path.join(evidence,language+'-'+viewport.width+'x'+viewport.height+'-panel.png')});
        await page.keyboard.press('Tab');
        assert(await page.evaluate(()=>document.querySelector('#web-service-panel').contains(document.activeElement)),'Tab focus contained');
        await page.keyboard.press('Shift+Tab');
        assert(await page.evaluate(()=>document.querySelector('#web-service-panel').contains(document.activeElement)),'Reverse Tab contained');
        if(dismiss==='escape')await page.keyboard.press('Escape');
        else if(dismiss==='close')await page.locator('.web-service-close').click();
        else await page.goBack();
        await page.waitForFunction(()=>document.querySelector('#web-service-panel').hidden&&!document.querySelector('.web-app-window').inert);
        assert.deepEqual(await app.boundingBox(),original,'Closing restores exact App geometry');
        assert(await handle.evaluate(el=>document.activeElement===el),'Closing restores handle focus');
        assert.equal(await page.locator('.web-service-backdrop').count(),0,'Backdrop removed');
        assert(await hit(page.getByRole('button',{name:'App action'})),'App action restored');
        assert(await hit(page.getByRole('textbox',{name:'Composer'})),'Composer remains uncovered');
      }
    } else {
      assert.equal(await page.locator('.web-service-handle').count(),0);
      assert(await page.locator('#web-service-panel').isVisible());
      const bar=await page.locator('#web-service-panel').boundingBox(); assert(original.y>=bar.y+bar.height-0.5,'Wide panel does not cover App');
      await page.locator('.web-menu > button').click();
      for(const control of await page.locator('.web-menu nav button').all()) assert(await hit(control),'Wide session actions reachable');
      await page.keyboard.press('Escape');
      assert(await hit(page.getByRole('textbox',{name:'Composer'})),'Wide composer uncovered');
    }
    await page.screenshot({path:path.join(evidence,language+'-'+viewport.width+'x'+viewport.height+'.png')});
    assert.deepEqual(errors,[]); report.cases.push({language,viewport,compact,status:'PASS',creationErrorRetry:'PASS',geometry:'PASS',controlsFocusClose:'PASS'});
    await context.close();
  }
  report.status='PASS';
} catch(error){report.status='FAIL';report.error=String(error.stack??error);process.exitCode=1;}
finally{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));report.finishedAt=new Date().toISOString();await fs.writeFile(path.join(evidence,'results.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));}
