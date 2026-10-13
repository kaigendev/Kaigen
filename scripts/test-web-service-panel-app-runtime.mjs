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
const scenario=options.get('--scenario')??'full';
assert(['full','composer-geometry','tor-settings-font'].includes(scenario));
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
      if (importer?.replaceAll("\\", "/").includes("/src/web/")) {
        if (source === "./session") return path.join(fixture, "session.ts");
      }
    } }, react(), {name:'exact-owned-inputs',async generateBundle(){for(const id of this.getModuleIds()){const filename=path.normalize(id.split('?')[0]);if(filename.startsWith(path.resolve(root)+path.sep)&&await fs.stat(filename).then(s=>s.isFile()).catch(()=>false)){const relative=path.relative(root,filename).replaceAll('\\','/');if(!report.sources.some(item=>item.path===relative))report.sources.push({...await identity(filename),path:relative});}}}}], resolve: { dedupe: ["react", "react-dom"], alias: { "@kaigen/platform": path.join(fixture,"platform.ts"), "@kaigen/theme": path.join(root,"src/theme.tsx") } }, define: { __KAIGEN_PRODUCT__: JSON.stringify("web"), __DISPOSABLE_WEB_CAPABILITIES__: JSON.stringify(capabilities) }, build: { outDir: dist, emptyOutDir: false } });
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
  const selectedViewports=scenario!=='full'?[{width:320,height:401},{width:402,height:874},{width:874,height:320}]:[{width:320,height:401},{width:390,height:844}];
  const selectedCases=(scenario!=='full'?['ru','en']:['ru']).flatMap(language=>selectedViewports.map(viewport=>({language,viewport})));
  report.scenario=scenario;
  for (const {viewport,language} of selectedCases) {
    const context=await browser.newContext({locale:'ru',viewport,hasTouch:true});const page=await context.newPage();page.setDefaultTimeout(8000);
    const errors=[];report.browserErrors=errors;page.on('pageerror',error=>errors.push(String(error)));
    await page.goto(url);
    const fields=page.locator('.web-gate-card input[type="password"]');await fields.nth(0).fill('disposable-password');await fields.nth(1).fill('disposable-password');await page.locator('.web-gate-card').getByRole('button',{name:'Создать пространство',exact:true}).click();
    await page.locator('.chat-item').first().waitFor({state:'visible'});
    if(language==='en'){
      await page.locator('.compact-profile-menu-host .rail-profile-menu-button').click();
      await page.locator('.compact-profile-menu-host [role="menuitem"]').nth(1).click();
      await page.locator('.settings-tabs').getByRole('button',{name:'Язык',exact:true}).click();
      await page.locator('.settings-content select').selectOption('en');
      await page.locator('.compact-nav-item.chats').click();
      await page.locator('.chat-item').first().waitFor({state:'visible'});
    }
    if(scenario==='tor-settings-font'){
      await page.evaluate(()=>{window.compactTorFixture.setSettings({enabled:true,transport:'custom',bridgeLines:''});window.compactTorFixture.setState('connected',100);});
      for(const enlarged of [false,true]){
        await page.locator('.compact-profile-menu-host .rail-profile-menu-button').click();await page.locator('.compact-profile-menu-host [role="menuitem"]').nth(1).click();
        await page.locator('.settings-tabs').getByRole('button',{name:language==='ru'?'Чаты':'Chats',exact:true}).click();
        const fontControl=page.locator('.typography-settings fieldset').first().locator('select').nth(1);
        const userFont=enlarged?await fontControl.locator('option').evaluateAll(items=>Math.max(...items.map(item=>Number(item.value)))):16;
        await fontControl.selectOption(String(userFont));
        await page.locator('.compact-nav-item.chats').click();await page.locator('.compact-header .tor-indicator').click();
        const textarea=page.locator('.settings-content textarea');await textarea.waitFor({state:'visible'});await textarea.focus();
        await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
        const fields=await page.locator('.settings-content input, .settings-content textarea, .settings-content select').evaluateAll(elements=>elements.map(el=>{const r=el.getBoundingClientRect(),pane=el.closest('.settings-content').getBoundingClientRect();return {tag:el.tagName,type:el.getAttribute('type'),font:parseFloat(getComputedStyle(el).fontSize),rect:r.toJSON(),pane:pane.toJSON(),insideWidth:r.left>=pane.left-.5&&r.right<=pane.right+.5&&r.left>=-.5&&r.right<=innerWidth+.5};}));
        assert(fields.some(field=>field.tag==='TEXTAREA')&&fields.some(field=>field.tag==='INPUT')&&fields.some(field=>field.tag==='SELECT'),'Actual Tor settings exposes textarea/input/select');
        for(const field of fields){assert(field.font>=Math.max(16,userFont*.95)-.1,'Field preserves >=16px and larger user font: '+JSON.stringify(field));assert(field.insideWidth,'Actual field width contained: '+JSON.stringify(field));}
        assert.deepEqual(errors,[]);report.cases.push({status:'PASS',phase:'tor-settings-font',language,viewport,userFont,fields});
        await page.screenshot({path:path.join(evidence,`tor-settings-font-${language}-${userFont}-${viewport.width}x${viewport.height}.png`)});
        await page.locator('.compact-nav-item.chats').click();
      }
      await context.close();continue;
    }
    await page.locator('.chat-item').first().click();
    const editor=page.locator('[data-kaigen-composer-editor="true"]');await editor.waitFor({state:'visible'});
    const app=page.locator('.web-app-window'),handle=page.locator('.web-service-handle');
    const visible=async locator=>{await locator.waitFor({state:'visible'});return locator.evaluate(el=>{const r=el.getBoundingClientRect();const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {rect:r.toJSON(),inside:r.left>=-0.5&&r.right<=innerWidth+0.5&&r.top>=-0.5&&r.bottom<=innerHeight+0.5,hit:el===hit||el.contains(hit)};});};
    const layout=await page.evaluate(()=>Object.fromEntries(['.web-shell','.web-app-window','.web-app-surface','.app-shell'].map(selector=>{const el=document.querySelector(selector),style=getComputedStyle(el);return [selector,{rect:el.getBoundingClientRect().toJSON(),clientHeight:el.clientHeight,cssHeight:style.height,availableHeight:style.getPropertyValue('--compact-available-height')}];})));
    report.cases.push({viewport,phase:'layout',layout});
    const original=await app.boundingBox(),handleBox=await handle.boundingBox();assert(original.y>=handleBox.y+handleBox.height-0.5,'Service handle reserves separate row');
    const composerRects={};
    for(const [name,control] of [['handle',handle],['editor',editor],['send',page.locator('button.send')],['attachment',page.locator('button.attach')]]) {const result=await visible(control);assert(result.inside&&result.hit,name+' reachable '+JSON.stringify(result));composerRects[name]=result.rect;}
    if(scenario==='composer-geometry'){
      for(const [a,b] of [['editor','send'],['editor','attachment'],['send','attachment']]){const first=composerRects[a],second=composerRects[b];assert(Math.min(first.right,second.right)-Math.max(first.left,second.left)<=.5||Math.min(first.bottom,second.bottom)-Math.max(first.top,second.top)<=.5,a+'/'+b+' do not overlap');}
      const settled=await editor.boundingBox();await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));assert.deepEqual(await editor.boundingBox(),settled,'Composer geometry stable across frames');
      assert.deepEqual(errors,[]);report.cases.push({status:'PASS',phase:'composer-geometry',viewport,language,layout,composerRects});
      await page.screenshot({path:path.join(evidence,`composer-${language}-${viewport.width}x${viewport.height}.png`)});
      if(viewport.width===402){
        await editor.focus();
        await page.evaluate(()=>{window.narrowViewportDescriptors={};for(const [key,value]of Object.entries({height:55,offsetTop:0,offsetLeft:0})){window.narrowViewportDescriptors[key]=Object.getOwnPropertyDescriptor(visualViewport,key);Object.defineProperty(visualViewport,key,{value,configurable:true});}visualViewport.dispatchEvent(new Event('resize'));});
        await page.waitForFunction(()=>Math.abs(document.querySelector('.web-shell').getBoundingClientRect().height-55)<1);
        const tightRects={};for(const [name,control]of [['editor',editor],['send',page.locator('button.send')],['attachment',page.locator('button.attach')]]){const result=await visible(control);assert(result.inside&&result.hit,name+' reachable in focused 55px viewport');tightRects[name]=result.rect;}
        report.cases.push({phase:'55px-diagnostic',language,viewport,tightRects,environment:await page.evaluate(()=>({coarse:matchMedia('(pointer: coarse)').matches,touch:navigator.maxTouchPoints,focused:document.activeElement?.className,shellClass:document.querySelector('.web-shell').className,shell:document.querySelector('.web-shell').getBoundingClientRect().toJSON(),visualViewport:{height:visualViewport.height,offsetTop:visualViewport.offsetTop,scale:visualViewport.scale}}))});
        for(const rect of Object.values(tightRects))assert(rect.top>=-.5&&rect.bottom<=55.5,'Every composer control is inside actual 55px visual viewport: '+JSON.stringify(tightRects));
        for(const [a,b]of [['editor','send'],['editor','attachment'],['send','attachment']]){const first=tightRects[a],second=tightRects[b];assert(Math.min(first.right,second.right)-Math.max(first.left,second.left)<=.5||Math.min(first.bottom,second.bottom)-Math.max(first.top,second.top)<=.5,a+'/'+b+' stay separate in 55px');}
        report.cases.push({status:'PASS',phase:'focused-55px-composer',viewport,language,tightRects});await page.screenshot({path:path.join(evidence,`composer-${language}-55px.png`)});
        await page.evaluate(()=>{for(const [key,descriptor]of Object.entries(window.narrowViewportDescriptors)){if(descriptor)Object.defineProperty(visualViewport,key,descriptor);else delete visualViewport[key];}visualViewport.dispatchEvent(new Event('resize'));});
        await page.waitForFunction(()=>Math.abs(document.querySelector('.web-shell').getBoundingClientRect().height-874)<1);
        await editor.evaluate(el=>el.blur());
        for(const [name,control]of [['handle',handle],['editor',editor],['send',page.locator('button.send')],['attachment',page.locator('button.attach')]]){const restored=await visible(control);assert(restored.inside&&restored.hit,name+' remains reachable after IME close/blur');for(const key of ['x','y','width','height'])assert(Math.abs(restored.rect[key]-composerRects[name][key])<.5,name+' restores '+key);}
        report.cases.push({status:'PASS',phase:'55px-ime-close-and-blur-restored',viewport,language});
      }
      await context.close();continue;
    }
    await editor.fill('Disposable draft');
    await handle.click();await page.waitForFunction(()=>document.querySelector('.web-app-window').inert);
    await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.querySelector('.web-app-window').inert&&document.querySelector('#web-service-panel').hidden);
    assert.deepEqual(await app.boundingBox(),original,'Panel closes without shifting actual App');
    assert.equal(await editor.innerText(),'Disposable draft','Actual composer draft survives panel');
    const restored=await visible(editor);assert(restored.inside&&restored.hit,'Actual composer remains uncovered after closing');await editor.fill('');
    if(viewport.width===390){
      const cdp=await context.newCDPSession(page);
      await page.evaluate(()=>{window.originalMenuViewportDescriptors={};for(const [key,value]of Object.entries({width:374,height:500,offsetLeft:8,offsetTop:120})){window.originalMenuViewportDescriptors[key]=Object.getOwnPropertyDescriptor(visualViewport,key);Object.defineProperty(visualViewport,key,{value,configurable:true});}visualViewport.dispatchEvent(new Event('resize'));});
      await page.waitForFunction(()=>Math.abs(document.querySelector('.web-shell').getBoundingClientRect().height-500)<1);
      await editor.focus();
      const message=page.locator('.message[data-message-key]:not(.mine)').filter({has:page.locator('.message-text')}).last();await message.scrollIntoViewIfNeeded();
      const touchPoint=await message.evaluate(el=>{const r=el.getBoundingClientRect(),s=el.closest('.message-scroll').getBoundingClientRect();return{x:r.left+20,y:(Math.max(r.top,s.top)+Math.min(r.bottom,s.bottom))/2,id:1};});
      await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[touchPoint]});await new Promise(resolve=>setTimeout(resolve,650));
      const popup=page.locator('.restricted-context-menu');await popup.waitFor({state:'visible'});
      assert(await editor.evaluate(el=>document.activeElement===el),'Touch hold keeps focused composer and IME');
      const popupBounds=await popup.boundingBox();assert(popupBounds.x>=16-.5&&popupBounds.x+popupBounds.width<=382-8+.5&&popupBounds.y>=128-.5&&popupBounds.y+popupBounds.height<=620-8+.5,'Touch menu fits offset visual viewport '+JSON.stringify(popupBounds));
      assert.equal(await popup.locator('.reaction-palette button').count(),6,'Incoming menu includes all reactions');
      const appBounds=await app.boundingBox();assert(popupBounds.y>=appBounds.y+8-.5&&popupBounds.y+popupBounds.height<=appBounds.y+appBounds.height-8+.5,'Full incoming menu fits actual clipping App surface');
      await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
      await page.screenshot({path:path.join(evidence,'touch-menu-focused-offset-viewport.png')});
      const quote=popup.getByRole('menuitem',{name:'Цитировать',exact:true});const quoteBounds=await quote.boundingBox();
      await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:quoteBounds.x+quoteBounds.width/2,y:quoteBounds.y+quoteBounds.height/2,id:1}]});
      assert(await editor.evaluate(el=>document.activeElement===el),'Touch menu action down preserves composer focus');
      await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await page.locator('.composer-reply-preview').waitFor({state:'visible'});
      assert.equal(await popup.count(),0,'Touch Quote action dismisses popup normally');
      await page.locator('.composer-reply-preview button').click();
      // Model a final keyboard size exposed after the resize notification. The
      // cached App/WebRoot dimensions remain larger until another event arrives.
      await editor.focus();
      await page.evaluate(()=>Object.defineProperty(visualViewport,'height',{value:320,configurable:true}));
      await message.evaluate(el=>el.dispatchEvent(new PointerEvent('contextmenu',{bubbles:true,cancelable:true,pointerType:'touch',isPrimary:true,clientX:60,clientY:420})));
      await popup.waitFor({state:'visible'});
      const settledBounds=await popup.boundingBox();assert(settledBounds.y>=appBounds.y+8-.5&&settledBounds.y+settledBounds.height<=440-8+.5,'Menu opening reads settled viewport without another resize '+JSON.stringify(settledBounds));
      assert.equal(await popup.locator('.reaction-palette button').count(),6,'Settled viewport retains complete incoming menu');
      for(const action of await popup.locator('button').all())assert(await action.evaluate(el=>{const r=el.getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===el;}),'Every incoming action remains reachable');
      assert(await editor.evaluate(el=>document.activeElement===el),'Settled menu geometry preserves composer focus');
      await page.screenshot({path:path.join(evidence,'incoming-menu-settled-viewport.png')});
      const settledQuote=await quote.boundingBox();
      await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:settledQuote.x+settledQuote.width/2,y:settledQuote.y+settledQuote.height/2,id:1}]});
      await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await page.locator('.composer-reply-preview').waitFor({state:'visible'});
      assert(await editor.evaluate(el=>document.activeElement===el),'Settled viewport Quote tap keeps composer focus');
      await page.locator('.composer-reply-preview button').click();
      await editor.focus();await page.evaluate(()=>Object.defineProperty(visualViewport,'height',{value:250,configurable:true}));
      await message.evaluate(el=>el.dispatchEvent(new PointerEvent('contextmenu',{bubbles:true,cancelable:true,pointerType:'touch',isPrimary:true,clientX:60,clientY:350})));
      await popup.waitFor({state:'visible'});
      const shortBounds=await popup.boundingBox();assert(shortBounds.y>=appBounds.y+8-.5&&shortBounds.y+shortBounds.height<=370-8+.5,'Oversized incoming menu fits clipped surface');
      const beforeInnerScroll=await app.boundingBox();assert(await popup.evaluate(el=>el.scrollHeight>el.clientHeight),'Short viewport menu scrolls internally');
      await popup.evaluate(el=>{el.scrollTop=el.scrollHeight;el.dispatchEvent(new Event('scroll'));});
      assert.equal(await popup.count(),1,'Inner-menu scroll does not dismiss context');assert.deepEqual(await app.boundingBox(),beforeInnerScroll,'Inner-menu scroll keeps app geometry');
      assert(await popup.locator('.reaction-palette button').last().evaluate(el=>{const r=el.getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===el;}),'Last reaction reachable through internal scrolling');
      assert(await editor.evaluate(el=>document.activeElement===el),'Internal menu scroll preserves composer focus');
      await page.screenshot({path:path.join(evidence,'incoming-menu-short-viewport-scroll.png')});
      await popup.evaluate(el=>{el.scrollTop=0;});await quote.click();await page.locator('.composer-reply-preview').waitFor({state:'visible'});await page.locator('.composer-reply-preview button').click();
      await page.evaluate(()=>{for(const [key,descriptor]of Object.entries(window.originalMenuViewportDescriptors)){if(descriptor)Object.defineProperty(visualViewport,key,descriptor);else delete visualViewport[key];}visualViewport.dispatchEvent(new Event('resize'));});
      await page.waitForFunction(()=>Math.abs(document.querySelector('.web-shell').getBoundingClientRect().height-844)<1);
      report.cases.push({viewport,phase:'touch-menu-focused-visual-viewport',status:'PASS',composerFocus:'PASS',quoteTouchAction:'PASS',visibleBounds:{left:8,top:120,width:374,height:500},popupBounds});
      report.cases.push({viewport,phase:'incoming-menu-settled-viewport',status:'PASS',allActionsReachable:'PASS',quoteTouchAction:'PASS',popupBounds:settledBounds});
      report.cases.push({viewport,phase:'incoming-menu-short-viewport',status:'PASS',internalScroll:'PASS',lastReactionReachable:'PASS',popupBounds:shortBounds});
      for(const route of ['chat','main','settings']){
      if(route==='main'){await page.locator('.compact-chat-back').click();await page.locator('.chat-item').first().waitFor({state:'visible'});}
      if(route==='settings'){await page.locator('.compact-profile-menu-host .rail-profile-menu-button').click();await page.locator('.compact-profile-menu-host [role="menuitem"]').nth(1).click();await page.locator('.compact-secondary-header').waitFor({state:'visible'});}
      await page.screenshot({path:path.join(evidence,route+'-narrow-before-resize.png')});
      await page.setViewportSize({width:1280,height:844});
      await page.waitForFunction(()=>!document.querySelector('.web-shell').classList.contains('web-shell-compact'));
      assert.equal(await handle.count(),0,'Maximize exits compact without interaction');
      await page.screenshot({path:path.join(evidence,route+'-desktop-1280-after-maximize.png')});
      await page.setViewportSize(viewport);
      await handle.waitFor({state:'visible'});
      const hoverBox=await handle.boundingBox();await page.mouse.move(hoverBox.x+hoverBox.width/2,hoverBox.y+hoverBox.height/2);await page.mouse.move(hoverBox.x+hoverBox.width/2,hoverBox.y+hoverBox.height/2+220,{steps:12});
      assert.equal(await page.locator('#web-service-panel').isVisible(),false,'Hover cannot capture closed curtain');
      await page.evaluate(()=>{window.drawerPointerLog=[];for(const type of ['pointerdown','pointermove','pointerup','pointercancel','lostpointercapture'])document.addEventListener(type,event=>window.drawerPointerLog.push({type,target:event.target.className,pointerType:event.pointerType,pointerId:event.pointerId,buttons:event.buttons,clientY:event.clientY,handle:document.querySelector('.web-service-handle')?.getBoundingClientRect().toJSON(),shell:document.querySelector('.web-shell').className}),true);});
      const box=await handle.boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width/2,box.y+box.height/2+220,{steps:12});
      const panel=page.locator('#web-service-panel');await panel.waitFor({state:'visible'});
      const during=await panel.boundingBox();assert(during.height>150&&during.height<500,'Mouse drag opens partial curtain');
      await page.screenshot({path:path.join(evidence,route+'-mouse-drag-before-release.png')});await page.mouse.up();
      assert.equal(await panel.isVisible(),true,'Partial curtain survives mouse release');
      assert(Math.abs((await panel.boundingBox()).height-during.height)<1,'Release preserves partial height');
      assert(await handle.evaluate(el=>document.activeElement===el),'Release gives stable focus to curtain handle');
      await page.keyboard.press('Tab');assert(await panel.evaluate(el=>el.contains(document.activeElement)),'Tab reaches dialog after drag release');
      const releasedHandle=await handle.boundingBox();await page.mouse.move(releasedHandle.x+releasedHandle.width/2,releasedHandle.y+releasedHandle.height/2);
      await page.mouse.move(box.x+box.width/2,box.y+box.height/2+350,{steps:6});
      assert(Math.abs((await panel.boundingBox()).height-during.height)<1,'Move without pressed button cannot extend released curtain');
      await page.screenshot({path:path.join(evidence,route+'-mouse-drag-after-release.png')});
      report.cases.push({viewport,route,phase:'resize-and-mouse-drag',status:'PASS',partialHeight:during.height,pointerLog:await page.evaluate(()=>window.drawerPointerLog)});
      await page.keyboard.press('Escape');await page.waitForFunction(()=>document.querySelector('#web-service-panel').hidden);
      for(const cancellation of ['lostcapture','blur','resize','no-buttons','pointercancel','escape','back']){
        const start=await handle.boundingBox();await page.mouse.move(start.x+start.width/2,start.y+start.height/2);await page.mouse.down();await page.mouse.move(start.x+start.width/2,start.y+start.height/2+140,{steps:6});await panel.waitFor({state:'visible'});
        const reachedHeight=(await panel.boundingBox()).height;
        if(cancellation==='lostcapture')await handle.evaluate(el=>{const down=window.drawerPointerLog.findLast(event=>event.type==='pointerdown');el.releasePointerCapture(down.pointerId);});
        else if(cancellation==='blur')await page.evaluate(()=>window.dispatchEvent(new Event('blur')));
        else if(cancellation==='escape')await page.keyboard.press('Escape');
        else if(cancellation==='back')await page.goBack();
        else if(cancellation==='resize'){await page.setViewportSize({width:1280,height:844});await page.waitForFunction(()=>!document.querySelector('.web-shell').classList.contains('web-shell-compact'));await page.setViewportSize(viewport);await handle.waitFor({state:'visible'});}
        else await handle.evaluate((el,type)=>{const down=window.drawerPointerLog.findLast(event=>event.type==='pointerdown');el.dispatchEvent(new PointerEvent(type,{bubbles:true,pointerId:down.pointerId,pointerType:'mouse',isPrimary:true,buttons:0,clientY:200}));},cancellation==='no-buttons'?'pointermove':'pointercancel');
        await page.mouse.up();await page.mouse.move(start.x+start.width/2,start.y+start.height/2+240,{steps:6});
        if(cancellation==='no-buttons'){assert.equal(await panel.isVisible(),true,'Missed mouseup preserves partial curtain');assert(Math.abs((await panel.boundingBox()).height-reachedHeight)<1,'No-buttons preserves reached drag height');await page.keyboard.press('Escape');}
        await page.waitForFunction(()=>document.querySelector('#web-service-panel').hidden);
        assert.equal(await app.evaluate(el=>el.inert),false,cancellation+' restores App focus access');
      }
      report.cases.push({viewport,route,phase:'mouse-gesture-cancellation',status:'PASS',hover:'PASS',releaseFocus:'PASS',cancellations:['lostcapture','blur','resize','no-buttons','pointercancel','escape','back'],pointerLog:await page.evaluate(()=>window.drawerPointerLog)});
      }
    }
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'No horizontal overflow');
    await page.screenshot({path:path.join(evidence,'ru-'+viewport.width+'x'+viewport.height+'-actual-chat.png')});assert.deepEqual(errors,[]);report.cases.push({viewport,status:'PASS',integratedRootApp:true,handleAndComposer:'PASS',draftPreservation:'PASS'});await context.close();
  }
  report.status='PASS';
}catch(error){report.status='FAIL';report.error=String(error.stack??error);process.exitCode=1;}
finally{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));report.finishedAt=new Date().toISOString();await fs.writeFile(path.join(evidence,'results.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));}
