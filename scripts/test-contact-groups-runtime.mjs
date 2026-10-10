import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

const repository = path.resolve(import.meta.dirname, "..");
const manyOnly = process.argv.includes("--many-only");
const keyboardOnly = process.argv.includes("--keyboard-only");
const geometryOnly = process.argv.includes("--geometry-only");
const requestedGeometry = process.argv.find(argument => argument.startsWith("--geometry-case="))?.slice("--geometry-case=".length);
const geometryCases = [80,100,125].flatMap(scale => [[scale,1280,720],[scale,640,420]])
  .filter(([scale,,height]) => !requestedGeometry || requestedGeometry === String(scale) || requestedGeometry === scale + "-" + height);
assert.ok(geometryCases.length, "requested geometry case must name an existing scale-height pair");
const evidenceDirectory = process.env.KAIGEN_CONTACT_GROUPS_EVIDENCE_DIR
  ? path.resolve(process.env.KAIGEN_CONTACT_GROUPS_EVIDENCE_DIR)
  : path.resolve(repository, "../outputs/contact-groups-runtime-20261007", "run-" + Date.now());
const require = createRequire(path.join(repository, "package.json"));
const original = await readFile(path.join(repository, "scripts/test-chat-geometry-runtime.mjs"), "utf8");
const marker = "  if (imageReactionsOnly) {";
assert.ok(original.includes(marker), "existing geometry runner setup marker is available");
let driver = original.slice(0, original.indexOf(marker));
driver = driver.replace('from "vite"', 'from ' + JSON.stringify(pathToFileURL(require.resolve("vite")).href));
driver = driver.replace('from "@vitejs/plugin-react"', 'from ' + JSON.stringify(pathToFileURL(require.resolve("@vitejs/plugin-react")).href));
driver = driver.replace('path.resolve(import.meta.dirname, "..")', JSON.stringify(repository));
driver = driver.replace('path.join(import.meta.dirname, "fixtures", "chat-geometry-runtime")', 'path.join(repository,"scripts","fixtures","chat-geometry-runtime")');
driver = driver.replace('path.join(fixture, "app-platform.ts")', 'path.join(fixture, "app-contact-groups-platform.ts")');
driver = driver.replace('await mkdtemp(path.join(os.tmpdir(), "kaigen-chat-geometry-"))', 'await mkdtemp(path.join(evidenceDirectory, "disposable-browser-"))');
driver = driver.replace('  configFile: false,', '  configFile: false,\n  cacheDir: path.join(profile,"vite-cache"),');
const moduleStart = driver.indexOf("    const fixtureModules =");
const moduleEnd = driver.indexOf("  await within((async () => {", moduleStart);
assert.ok(moduleStart > 0 && moduleEnd > moduleStart);
driver = driver.slice(0, moduleStart) + '  const fixtureModules = ["/app-entry.tsx","/app-contact-groups-scenario.ts"];\n' + driver.slice(moduleEnd);
driver += String.raw`
  const scenarioUrl = origin + '/app.html';
  const run = async(method,name,args=[]) => {
    let finished = false;
    const evaluation = cdp.send('Runtime.evaluate', {
      expression: "import('/app-contact-groups-scenario.ts').then(module => module." + method + "(..." + JSON.stringify(args) + "))",
      awaitPromise: true, returnByValue: true,
    }, 180000);
    evaluation.finally(()=>{finished=true;}).catch(()=>{});
    let handled = 0;
    while(!finished) {
      const reply = await cdp.send('Runtime.evaluate',{expression:'globalThis.__KAIGEN_CONTACT_GROUPS_STAGE__',returnByValue:true});
      const stage = reply.result?.value;
      if(!stage || stage.id <= handled) { await new Promise(resolve=>setTimeout(resolve,20)); continue; }
      handled = stage.id;
      if(stage.kind === 'capture') await captureFixtureEvidence(stage.name);
      else if(stage.kind === 'platform') await cdp.send('Emulation.setUserAgentOverride',{userAgent:version.userAgent,platform:stage.text});
      else if(stage.kind === 'wheel') await cdp.send('Input.dispatchMouseEvent',{type:'mouseWheel',x:stage.x,y:stage.y,deltaX:0,deltaY:1200});
      else if(stage.kind === 'move') await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:stage.x,y:stage.y,buttons:0});
      else if(stage.kind === 'pointercancel') {
        await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1});
        await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:stage.x,y:stage.y,id:1}]});
        await cdp.send('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]});
        await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:false});
      }
      else if(stage.kind === 'text') await cdp.send('Input.insertText',{text:stage.text});
      else if(stage.kind === 'selectall') {
        for(const type of ['keyDown','keyUp']) await cdp.send('Input.dispatchKeyEvent',{type,key:'a',code:'KeyA',windowsVirtualKeyCode:65,modifiers:2});
      } else if(stage.kind === 'key') {
        const codes={Escape:27,Enter:13,ArrowRight:39,ArrowLeft:37};
        for(const type of ['keyDown','keyUp']) await cdp.send('Input.dispatchKeyEvent',{type,key:stage.key,code:stage.key,windowsVirtualKeyCode:codes[stage.key],...(type==='keyDown'&&stage.key==='Enter'?{text:'\r',unmodifiedText:'\r'}:{})});
      } else if(stage.kind.startsWith('drag')) {
        const type=stage.kind==='dragstart'?'mousePressed':stage.kind==='dragmove'?'mouseMoved':'mouseReleased';
        await cdp.send('Input.dispatchMouseEvent',{type,x:stage.x,y:stage.y,button:'left',buttons:type==='mouseReleased'?0:1,clickCount:1});
      } else {
        const button=stage.kind==='right'?'right':'left';
        for(const type of ['mousePressed','mouseReleased']) await cdp.send('Input.dispatchMouseEvent',{type,x:stage.x,y:stage.y,button,buttons:type==='mousePressed'?(button==='right'?2:1):0,modifiers:stage.kind==='mac'?2:0,clickCount:1});
      }
      await cdp.send('Runtime.evaluate',{expression:'if(globalThis.__KAIGEN_CONTACT_GROUPS_STAGE__?.id === '+stage.id+') globalThis.__KAIGEN_CONTACT_GROUPS_STAGE__.done = true'});
    }
    const evaluated=await evaluation;
    if(evaluated.exceptionDetails) throw new Error(evaluated.exceptionDetails.exception?.description ?? 'groups evaluation failed');
    const result=evaluated.result?.value;
    await writeFile(path.join(evidenceDirectory,name+'.json'),JSON.stringify(result,null,2)+'\n');
    assert.equal(result?.ok,true,result?.error ?? 'groups runtime scenario failed');
    console.log(name+': '+result.assertions+' actual-App assertions passed');
    return result;
  };
  const navigation=await cdp.send('Page.navigate',{url:scenarioUrl});
  await waitForDocument(scenarioUrl,navigation,'contact groups actual App');

  const runMany = async() => {
    await cdp.send('Runtime.evaluate',{expression:"import('/app-contact-groups-platform.ts').then(async module=>{module.contactGroupsEnableMany();module.contactGroupsSetScale(125);await module.invoke('save_local_state',{profileId:'qa-profile-a',state:{activeChat:'tox-'+ 'A'.repeat(64),drafts:{},spellcheckEnabled:false,contactGroups:{version:1,enabled:true,groups:[{id:'friends',name:'Друзья'},...Array.from({length:12},(_,i)=>({id:'many-'+i,name:'Group '+(i+1)}))],assignments:{['C'.repeat(64)]:'friends',['D'.repeat(64)]:'friends',...Object.fromEntries(Array.from({length:12},(_,i)=>[(i+1).toString(16).toUpperCase().padStart(64,'0'),'many-'+i]))},order:['friends','__ungrouped__',...Array.from({length:12},(_,i)=>'many-'+i)],collapsed:[]}}});})",awaitPromise:true});
    await cdp.send('Emulation.setDeviceMetricsOverride',{width:640,height:420,deviceScaleFactor:1,mobile:false});
    const next=await cdp.send('Page.navigate',{url:scenarioUrl});
    await waitForDocument(scenarioUrl,next,'many group submenu');
    await run('runContactGroupsManyScenario','contact-groups-many-125-420');
  };
  if(MANY_ONLY) { await runMany(); } else if(KEYBOARD_ONLY) {
    await cdp.send('Runtime.evaluate',{expression:"import('/app-contact-groups-platform.ts').then(module=>module.invoke('save_local_state',{profileId:'qa-profile-a',state:{activeChat:'tox-'+ 'A'.repeat(64),drafts:{},spellcheckEnabled:false,contactGroups:{version:1,enabled:true,groups:[{id:'keyboard',name:'Keyboard'}],assignments:{['B'.repeat(64)]:'keyboard'},order:['__ungrouped__','keyboard'],collapsed:[]}}}))",awaitPromise:true});
    const next=await cdp.send('Page.navigate',{url:scenarioUrl});
    await waitForDocument(scenarioUrl,next,'keyboard-only fixture');
    await run('runContactGroupsKeyboardScenario','contact-groups-keyboard');
  } else {
  if(!GEOMETRY_ONLY) {
  await run('runContactGroupsScenario','contact-groups-lifecycle');
  const reload=await cdp.send('Page.navigate',{url:scenarioUrl});
  await waitForDocument(scenarioUrl,reload,'contact groups restart');
  await run('runContactGroupsReloadScenario','contact-groups-reload');
  } else {
    await cdp.send('Runtime.evaluate',{expression:"import('/app-contact-groups-platform.ts').then(module=>module.invoke('save_local_state',{profileId:'qa-profile-a',state:{activeChat:'tox-'+ 'A'.repeat(64),drafts:{},spellcheckEnabled:false,contactGroups:{version:1,enabled:true,groups:[{id:'friends',name:'Друзья'}],assignments:{['C'.repeat(64)]:'friends',['D'.repeat(64)]:'friends'},order:['friends','__ungrouped__'],collapsed:[]}}}))",awaitPromise:true});
  }
  for(const [scale,width,height] of GEOMETRY_CASES) {
    await cdp.send('Runtime.evaluate',{expression:"import('/app-contact-groups-platform.ts').then(module=>module.contactGroupsSetScale("+scale+"))",awaitPromise:true});
    await cdp.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
    const next=await cdp.send('Page.navigate',{url:scenarioUrl});
    await waitForDocument(scenarioUrl,next,'group menus scale '+scale+' height '+height);
    await run('runContactGroupsGeometryScenario','contact-groups-geometry-'+scale+'-'+height,[scale,height,width]);
  }
  if(!GEOMETRY_ONLY) await runMany();
  }
`;
driver = driver.replace("if(MANY_ONLY)", "if(" + JSON.stringify(manyOnly) + ")");
driver = driver.replace("if(KEYBOARD_ONLY)", "if(" + JSON.stringify(keyboardOnly) + ")");
driver = driver.replaceAll("if(!GEOMETRY_ONLY)", "if(!" + JSON.stringify(geometryOnly) + ")");
driver = driver.replace("of GEOMETRY_CASES", "of " + JSON.stringify(geometryCases));
const cleanupStart = original.indexOf("} catch (error) {\n  primaryError = error;");
const cleanupEnd = original.indexOf("// The default geometry check includes");
assert.ok(cleanupStart > 0 && cleanupEnd > cleanupStart);
driver += original.slice(cleanupStart, cleanupEnd).replace('  if (cleanupErrors.length) {', '  await writeFile(path.join(evidenceDirectory,"contact-groups-runtime-cleanup.json"),JSON.stringify({browserStopped,serverClosed:!server.httpServer?.listening,disposableProfileRemoved:!existsSync(profile),errors:cleanupErrors},null,2)+"\\n");\n  if (cleanupErrors.length) {');
await mkdir(evidenceDirectory, { recursive: true });
const driverPath = path.join(evidenceDirectory, "contact-groups-runtime-driver.mjs");
await writeFile(driverPath, driver);
const sources = await Promise.all(["src/App.tsx", "src/contactGroups.ts", "src/ContactGroupHeader.tsx", "src/ContactGroups.css", "src/contextMenuPlacement.ts", "src/interfaceScale.ts", "src/touchContextMenu.ts", "src/App.css", "scripts/test-chat-geometry-runtime.mjs", "scripts/test-contact-groups-runtime.mjs", "scripts/fixtures/chat-geometry-runtime/app-contact-groups-platform.ts", "scripts/fixtures/chat-geometry-runtime/app-contact-groups-scenario.ts"].map(async relative => {
  const bytes = await readFile(path.join(repository, relative));
  return { path: relative, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}));
await writeFile(path.join(evidenceDirectory, "contact-groups-runtime-inputs.json"), JSON.stringify({ sources, generatedDriverSha256: createHash("sha256").update(driver).digest("hex"), runtime: "existing actual App headless Chromium/Vite fixture; not native Windows acceptance", node: process.version }, null, 2) + "\n");
const child = spawn(process.execPath, [driverPath, "--menus-only"], {
  cwd: repository, windowsHide: true, stdio: "inherit",
  env: { ...process.env, KAIGEN_CHAT_GEOMETRY_EVIDENCE_DIR: evidenceDirectory },
});
await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("close", (code, signal) => code === 0 ? resolve() : reject(new Error("Contact groups runtime failed: exit=" + code + "; signal=" + signal)));
});
