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
  boundary: "Actual WebRoot/CSS and browser-input in disposable Chromium; controlled service fixture verifies actual WebRoot UI, not live backend admission; live workspace creation is separate evidence." };
let browser, server;
try {
  for (const name of ["src/web/WebRoot.tsx", "src/web/WebRoot.css", "src/App.css", "src/theme.css", "src/platform/browser-input.ts", "src/contextMenuCoordinator.ts",
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
  for (const language of ['ru', 'en']) for (const viewport of [{width:320,height:401},{width:390,height:844},{width:800,height:320},{width:1280,height:800}]) {
    const context = await browser.newContext({ locale: language, viewport, hasTouch: true });
    const page = await context.newPage();
    const errors=[]; page.on('pageerror', error=>errors.push(String(error)));
    await page.goto(url+'/?fail=1');
    const fields=page.locator('.web-gate-card input[type="password"]');
    await fields.nth(0).fill('disposable-password'); await fields.nth(1).fill('disposable-password');
    await page.locator('.web-gate-card .web-primary').click();
    await page.locator('.web-error').waitFor();
    assert.equal(await page.locator('.web-shell').count(),0,'Admission failure must not enter workspace');
    assert.equal(await page.locator('.web-gate-card .web-primary').isEnabled(),true,'Creation failure permits retry');
    assert.equal(await fields.nth(0).inputValue(),'disposable-password','Failure retains entered password');
    assert.equal(await fields.nth(1).inputValue(),'disposable-password','Failure retains confirmation');
    assert.equal(await page.evaluate(()=>window.workspaceCalls.length),1,'First failing submit called once');
    await page.evaluate(()=>{window.retryDocument=window.document;history.replaceState(history.state,'',location.pathname);});
    await page.locator('.web-gate-card .web-primary').click();
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
