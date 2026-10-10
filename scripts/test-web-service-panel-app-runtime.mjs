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
  boundary: "Actual WebRoot/CSS and browser-input in disposable Chromium; Actual WebRoot plus actual RootApp/App/composer with disposable backend adapter; verifies integrated layout, not live admission/native OS." };
let browser, server;
try {
  for (const name of ["src/web/WebRoot.tsx", "src/web/WebRoot.css", "src/App.css", "src/theme.css", "src/App.tsx", "src/RootApp.tsx", "src/platform/web.ts", "src/appLayout.ts", "src/SpellcheckComposer.tsx", "src/compactLayout.ts", "scripts/fixtures/compact-interface-runtime/platform.ts", "scripts/fixtures/app-tablet-runtime/platform.ts", "src/platform/browser-input.ts", "src/contextMenuCoordinator.ts",
    "scripts/test-web-service-panel-app-runtime.mjs", ...["index.html", "entry.tsx", "session.ts", "platform.ts"].map(name => "scripts/fixtures/web-service-panel-app-runtime/" + name)]) {
    report.sources.push({ ...await identity(path.join(root, name)), path: name });
  }
  report.runner = { node: process.version, playwright: await identity(options.get("--playwright-module")), chromium: await identity(options.get("--chromium-executable")) };
  const platformSource=await fs.readFile(path.join(root,"src/platform/web.ts"),"utf8");
  const capabilitiesBody=platformSource.match(/export const platformCapabilities[^=]*= Object\.freeze\((\{[\s\S]*?\n\})\);/);assert(capabilitiesBody,"Current Web capabilities");
  const capabilities=JSON.parse(capabilitiesBody[1].replace(/^(\s*)([A-Za-z][A-Za-z0-9]*):/gm,'$1"$2":').replace(/,\s*([}\]])/g,'$1'));
  report.webCapabilities=capabilities;
  const require = createRequire(path.join(root, "package.json"));
  const { build } = await import(pathToFileURL(require.resolve("vite")).href);
  const react = (await import(pathToFileURL(require.resolve("@vitejs/plugin-react")).href)).default;
  const fixture = path.join(root, "scripts/fixtures/web-service-panel-app-runtime");
  const dist = path.join(evidence, "dist");
  await build({ configFile: false, root: fixture, publicDir: path.join(root, "public"), logLevel: "warn",
    plugins: [{ name: "exact-tablet-fixture", enforce: "pre", resolveId(source, importer) {
      if (importer?.replaceAll("\\", "/").endsWith("/src/web/WebRoot.tsx")) {
        if (source === "./session") return path.join(fixture, "session.ts");
      }
    } }, react()], resolve: { dedupe: ["react", "react-dom"], alias: { "@kaigen/platform": path.join(fixture,"platform.ts"), "@kaigen/theme": path.join(root,"src/theme.tsx") } }, define: { __KAIGEN_PRODUCT__: JSON.stringify("web"), __DISPOSABLE_WEB_CAPABILITIES__: JSON.stringify(capabilities) }, build: { outDir: dist, emptyOutDir: false } });
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
  for (const viewport of [{width:320,height:401},{width:390,height:844}]) {
    const context=await browser.newContext({locale:'ru',viewport,hasTouch:true});const page=await context.newPage();page.setDefaultTimeout(8000);
    const errors=[];page.on('pageerror',error=>errors.push(String(error)));
    await page.goto(url);
    const fields=page.locator('.web-gate-card input[type="password"]');await fields.nth(0).fill('disposable-password');await fields.nth(1).fill('disposable-password');await page.locator('.web-gate-card .web-primary').click();
    await page.locator('.chat-item').first().waitFor({state:'visible'});
    await page.locator('.chat-item').first().click();
    const editor=page.locator('[data-kaigen-composer-editor="true"]');await editor.waitFor({state:'visible'});
    const app=page.locator('.web-app-window'),handle=page.locator('.web-service-handle');
    const visible=async locator=>{await locator.waitFor({state:'visible'});return locator.evaluate(el=>{const r=el.getBoundingClientRect();const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {rect:r.toJSON(),inside:r.left>=-0.5&&r.right<=innerWidth+0.5&&r.top>=-0.5&&r.bottom<=innerHeight+0.5,hit:el===hit||el.contains(hit)};});};
    const layout=await page.evaluate(()=>Object.fromEntries(['.web-shell','.web-app-window','.web-app-surface','.app-shell'].map(selector=>{const el=document.querySelector(selector),style=getComputedStyle(el);return [selector,{rect:el.getBoundingClientRect().toJSON(),clientHeight:el.clientHeight,cssHeight:style.height,availableHeight:style.getPropertyValue('--compact-available-height')}];})));
    report.cases.push({viewport,phase:'layout',layout});
    const original=await app.boundingBox(),handleBox=await handle.boundingBox();assert(original.y>=handleBox.y+handleBox.height-0.5,'Service handle reserves separate row');
    for(const [name,control] of [['handle',handle],['editor',editor],['send',page.getByRole('button',{name:'Отправить',exact:true})],['attachment',page.getByRole('button',{name:'Прикрепить файл',exact:true})]]) {const result=await visible(control);assert(result.inside&&result.hit,name+' reachable '+JSON.stringify(result));}
    await editor.fill('Disposable draft');
    await handle.click();await page.waitForFunction(()=>document.querySelector('.web-app-window').inert);
    await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.querySelector('.web-app-window').inert&&document.querySelector('#web-service-panel').hidden);
    assert.deepEqual(await app.boundingBox(),original,'Panel closes without shifting actual App');
    assert.equal(await editor.innerText(),'Disposable draft','Actual composer draft survives panel');
    const restored=await visible(editor);assert(restored.inside&&restored.hit,'Actual composer remains uncovered after closing');await editor.fill('');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'No horizontal overflow');
    await page.screenshot({path:path.join(evidence,'ru-'+viewport.width+'x'+viewport.height+'-actual-chat.png')});assert.deepEqual(errors,[]);report.cases.push({viewport,status:'PASS',integratedRootApp:true,handleAndComposer:'PASS',draftPreservation:'PASS'});await context.close();
  }
  report.status='PASS';
}catch(error){report.status='FAIL';report.error=String(error.stack??error);process.exitCode=1;}
finally{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));report.finishedAt=new Date().toISOString();await fs.writeFile(path.join(evidence,'results.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));}
