  const results = [], started = Date.now();
  const evaluate = async (fn, ...args) => {
    const reply = await cdp.send("Runtime.evaluate", { expression:"("+fn.toString()+")(..."+JSON.stringify(args)+")", awaitPromise:true, returnByValue:true, userGesture:true }, 8000);
    if(reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text);
    return reply.result?.value;
  };
  const test = async (id, name, operation) => {
    if (!selectedApprovedPoints.includes(id)) return;
    enterPhase(name); await operation(); results.push({id,name,status:"PASS"});
    await writeFile(path.join(evidenceDirectory,"results.json"),JSON.stringify({results,browser:version.product,elapsedMs:Date.now()-started},null,2)+"\n");
    console.log("APPROVED_POINT_CLOSED "+id+" "+name);
  };
  const exists = selector => evaluate(s=>!!document.querySelector(s),selector);
  const ready = selector => waitFor(async()=>await exists(selector)?true:undefined,8000,selector);
  const point = async selector => { await ready(selector); return evaluate(s=>{
    const element=document.querySelector(s);element.scrollIntoView({block:"nearest"});
    const b=element.getBoundingClientRect();return {x:b.left+b.width/2,y:b.top+b.height/2};
  },selector); };
  const mouse = (type,p,button="left",buttons=0)=>cdp.send("Input.dispatchMouseEvent",{type,...p,button,buttons,clickCount:type==="mouseMoved"?0:1});
  const click = async (selector,button="left") => {
    let p=await point(selector);await mouse("mouseMoved",p);await new Promise(r=>setTimeout(r,40));p=await point(selector);
    await mouse("mousePressed",p,button,button==="left"?1:2);await mouse("mouseReleased",p,button);await new Promise(r=>setTimeout(r,60));
  };
  const key = async (key,code,virtual,modifiers=0,commands) => {
    for(const type of ["keyDown","keyUp"]) await cdp.send("Input.dispatchKeyEvent",{type,key,code,windowsVirtualKeyCode:virtual,modifiers,...(commands&&type==="keyDown"?{commands}: {})});
    await new Promise(r=>setTimeout(r,40));
  };
  const escape = ()=>key("Escape","Escape",27);
  const type = text=>cdp.send("Input.insertText",{text});
  const checked = async (fn,message,...args)=>assert.equal(await evaluate(fn,...args),true,message);
  const B="B".repeat(64),C="C".repeat(64),D="D".repeat(64),U="__ungrouped__";
  const bytes=Array.from({length:36},(_,i)=>(3+i*7)%256),sum=[0,0];bytes.forEach((v,i)=>sum[i%2]^=v);
  const address=[...bytes,...sum].map(v=>v.toString(16).padStart(2,"0")).join("").toUpperCase();
  const saved={"qa-profile-a":{spellcheckEnabled:false,contactGroups:{version:1,enabled:true,groups:[{id:"work",name:"Работа"},{id:"friends",name:"Друзья"}],assignments:{[B]:"work",[C]:"friends",[D]:"friends"},order:[U,"work","friends"],collapsed:[]}}};
  await cdp.send("Page.addScriptToEvaluateOnNewDocument",{source:
    "sessionStorage.setItem('kaigen-active-screen','chat');sessionStorage.setItem('kaigen-contact-groups-runtime-profiles',"+JSON.stringify(JSON.stringify(saved))+");"+
    "window.__clipboardReads=0;Object.defineProperty(navigator.clipboard,'readText',{configurable:true,value:()=>{window.__clipboardReads++;return Promise.resolve("+JSON.stringify(address)+")}});"+
    "Object.defineProperty(navigator.clipboard,'read',{configurable:true,value:()=>{window.__clipboardReads++;return Promise.reject(Error('Read denied in disposable fixture'))}});"+
    "document.addEventListener('contextmenu',e=>{window.__lastContext={trusted:e.isTrusted,get prevented(){return e.defaultPrevented}}});document.addEventListener('paste',e=>{window.__lastPaste={trusted:e.isTrusted,text:e.clipboardData.getData('text/plain')}});"+
    "document.addEventListener('pointerdown',e=>window.__pointerId=e.pointerId);document.addEventListener('lostpointercapture',e=>window.__lostCapture={trusted:e.isTrusted,pointerId:e.pointerId});"});
  const navigate=async product=>{const url=origin+"/app.html?product="+product;const next=await cdp.send("Page.navigate",{url});await waitForDocument(url,next,product+" App");await ready(".contact-list-add");};

  await navigate("web");
  await test(1,"web-contact-clipboard",async()=>{
    await click(".contact-list-add");await ready(".add-contact-view input");
    await checked(()=>window.__clipboardReads===0&&document.activeElement===document.querySelector(".add-contact-view input"),"Web opening does not request clipboard or steal focus");
    // Chromium headless uses its own in-memory clipboard, independent of Windows.
    await evaluate(async text=>{await navigator.clipboard.writeText(text);},address);
    await key("v","KeyV",86,2);
    await checked(text=>document.querySelector(".add-contact-view input").value===text&&window.__lastPaste?.trusted&&window.__lastPaste.text===text&&window.__clipboardReads===0,"trusted Ctrl+V uses native clipboard",address);
    await click(".add-contact-view input","right");
    await checked(()=>window.__lastContext?.trusted&&!window.__lastContext.prevented&&!document.querySelector(".text-edit-context-menu"),"native context menu is not intercepted");
    await escape();await evaluate(()=>window.__lastContext=null);await key("ContextMenu","ContextMenu",93);
    await checked(()=>window.__lastContext?.trusted&&!window.__lastContext.prevented&&!document.querySelector(".text-edit-context-menu")&&window.__clipboardReads===0,"keyboard menu does not intercept native context event or invoke custom read");await escape();
    await click(".add-contact-view textarea");await key("a","KeyA",65,2);
    await evaluate(async()=>{await navigator.clipboard.writeText("Paste message");});
    await key("Unidentified","",0,0,["paste"]);
    await checked(()=>document.querySelector(".add-contact-view textarea").value==="Paste message"&&window.__lastPaste?.trusted&&window.__clipboardReads===0,"browser paste edit command keeps controlled message value");
    await key("v","KeyV",86,2);await checked(()=>document.querySelector(".add-contact-view textarea").value==="Paste messagePaste message","second native paste preserves new state");
  });

  await navigate("desktop");
  await test(2,"desktop-contact-clipboard-compatibility",async()=>{
    await click(".contact-list-add");await ready(".add-contact-view input");
    await checked(text=>window.__clipboardReads===1&&document.querySelector(".add-contact-view input").value===text&&!document.querySelector("[data-kaigen-native-text-menu]"),"desktop retains clipboard prefill",address);
    await click(".add-contact-view input","right");await ready(".text-edit-context-menu");
    await checked(()=>window.__lastContext.prevented,"desktop retains custom text menu");await escape();
    const settingsText = '.settings-content .setting-field input[type="text"]';
    await click(".rail-profile-button");await ready(settingsText);
    await click(settingsText,"right");await ready(".text-edit-context-menu");await escape();
    await navigate("web");await click(".rail-profile-button");await ready(settingsText);
    await checked(s=>!document.querySelector(s).closest('[data-kaigen-native-text-menu]'),"Web settings stays outside Add Contact native-menu marker",settingsText);
    await click(settingsText,"right");await ready(".text-edit-context-menu");await escape();
  });

  await navigate("desktop");
  const header=id=>'.contact-group-header[data-contact-group-id="'+id+'"]';
  const chat=name=>evaluate(n=>{document.querySelectorAll('[data-approved-contact]').forEach(e=>delete e.dataset.approvedContact);const item=[...document.querySelectorAll('.chat-item')].find(e=>e.querySelector('.chat-name')?.textContent.includes(n));if(!item)throw Error('Missing contact '+n);item.dataset.approvedContact="selected";return '[data-approved-contact="selected"]';},name);
  await ready(header("work"));
  await test(5,"contact-group-drag",async()=>{
    const from=await evaluate(s=>{const b=document.querySelector(s).getBoundingClientRect();return{x:b.right-8,y:b.top+b.height/2}},header("work"));
    const to=await evaluate(()=>{const b=document.querySelector('[data-contact-group-region="friends"]').getBoundingClientRect();return{x:b.left+30,y:b.bottom-2}});
    const expanded=await evaluate(s=>document.querySelector(s).getAttribute("aria-expanded"),header("work"));
    await mouse("mousePressed",from,"left",1);await mouse("mouseMoved",to,"left",1);
    await ready('[data-contact-group-region="friends"].drop-after');
    await checked(()=>getComputedStyle(document.querySelector('.drop-after'),'::after').height==='2px',"phantom line exists at after position");
    await mouse("mouseReleased",to);await new Promise(r=>setTimeout(r,100));
    await checked((s,e)=>{const groups=[...document.querySelectorAll('.contact-group-header')].map(g=>g.dataset.contactGroupId);return groups.indexOf('work')>groups.indexOf('friends')&&document.querySelector(s).getAttribute('aria-expanded')===e&&!document.querySelector('.drop-after,.drop-before')},"drop applies displayed order without folding",header("work"),expanded);
    const cancelFrom=await point(header("work")),cancelTo=await point(header("friends"));
    await mouse("mousePressed",cancelFrom,"left",1);await mouse("mouseMoved",cancelTo,"left",1);
    await ready('[data-contact-group-region="friends"].drop-before');
    await checked(()=>getComputedStyle(document.querySelector('.drop-before'),'::before').height==='2px',"phantom line exists at before position");
    await key("Escape","Escape",27);await mouse("mouseReleased",cancelTo);
    await checked(()=>!document.querySelector('.drop-after,.drop-before')&&[...document.querySelectorAll('.contact-group-header')].map(g=>g.dataset.contactGroupId).join(',')==='__ungrouped__,friends,work',"Escape cancels reorder and phantom line");
    await mouse("mousePressed",cancelFrom,"left",1);await mouse("mouseMoved",cancelTo,"left",1);await ready('.drop-before');
    await evaluate(s=>{window.__lostCapture=null;document.querySelector(s).releasePointerCapture(window.__pointerId)},header("work"));
    await mouse("mouseMoved",{x:cancelTo.x+1,y:cancelTo.y},"left",1);
    await waitFor(async()=>await evaluate(()=>window.__lostCapture?.trusted&&!document.querySelector('.drop-before,.drop-after'))?true:undefined,8000,'lost capture clears phantom');
    await mouse("mouseReleased",cancelTo);
    await checked(()=>[...document.querySelectorAll('.contact-group-header')].map(g=>g.dataset.contactGroupId).join(',')==='__ungrouped__,friends,work',"lost capture cancels reorder");
  });

  await test(6,"contact-group-name-input",async()=>{
    await click(header("work"),"right");await click('.contact-group-context-menu button:first-child');await ready('#contact-group-name-input');
    await checked(()=>{const e=document.querySelector('#contact-group-name-input');return e.type==='text'&&e.autocomplete==='off'&&e.form.autocomplete==='off'&&document.activeElement===e&&getComputedStyle(e).borderRadius==='9px'},"name is focused text field without autocomplete");
    await key("a","KeyA",65,2);await type("Проект");
    await captureFixtureEvidence("group-name-input.png");
    await click('.file-confirm-card button[type="submit"]');
    await checked(()=>document.querySelector('.contact-group-header[data-contact-group-id="work"] .contact-group-name').textContent==='Проект',"rename saves name");
    await click(header("work"),"right");await click('.contact-group-context-menu button:first-child');await ready('#contact-group-name-input');await key("a","KeyA",65,2);await type("Discarded");await click('.file-confirm-card button[type="button"]');
    await checked(()=>!document.querySelector('#contact-group-name-input')&&document.querySelector('.contact-group-header[data-contact-group-id="work"] .contact-group-name').textContent==='Проект',"cancel preserves saved name");
    await click(await chat('Bob'),'right');await click('.contact-group-menu-trigger');await ready('.contact-group-submenu');
    const createSelector=await evaluate(()=>{const b=[...document.querySelectorAll('.contact-group-submenu button')].find(e=>e.textContent.trim()==='Создать группу…');b.dataset.approvedCreate='true';return '[data-approved-create]';});
    await click(createSelector);await ready('#contact-group-name-input');
    await checked(()=>{const e=document.querySelector('#contact-group-name-input');return e.value===''&&e.type==='text'&&e.autocomplete==='off'&&e.form.autocomplete==='off'&&document.activeElement===e},"create uses the same empty focused text field");
    await type('Temporary');await click('.file-confirm-card button[type="button"]');
    await checked(()=>!document.querySelector('#contact-group-name-input')&&![...document.querySelectorAll('.contact-group-name')].some(e=>e.textContent==='Temporary'),"create cancellation preserves groups");
    // Browser password/save/autofill chrome is outside CDP page screenshot coverage.
  });

  await test(4,"contact-groups-menu",async()=>{
    await evaluate(()=>sessionStorage.setItem('kaigen-contact-groups-runtime-scale','125'));
    await cdp.send('Emulation.setDeviceMetricsOverride',{width:640,height:420,deviceScaleFactor:1,mobile:false});
    const url=origin+'/app.html?product=desktop';const nav=await cdp.send('Page.navigate',{url});await waitForDocument(url,nav,'narrow groups');await ready(header('friends'));
    await click(await chat('Dave'),'right');await click('.contact-group-menu-trigger');await ready('.contact-group-submenu');
    await checked(()=>{const a=document.querySelector('.contact-context-menu:not(.contact-group-submenu)'),b=document.querySelector('.contact-group-submenu');const x=a.getBoundingClientRect(),y=b.getBoundingClientRect();return (x.right<=y.left+.5||y.right<=x.left+.5)&&x.left>=7&&y.left>=7&&x.right<=innerWidth-7&&y.right<=innerWidth-7&&[...b.querySelectorAll('button')].some(e=>e.textContent==='Убрать из группы')&&![...a.querySelectorAll('button')].some(e=>e.textContent==='Убрать из группы')},"removal is in adjacent submenu at 125% narrow width");
    await click('[data-kaigen-ui-id="kaigen.main.contacts.element.remove-from-group"]');
    await checked(()=>!document.querySelector('.contact-group-submenu'),"removal closes menu");
    await waitFor(async()=>await evaluate(()=>JSON.parse(sessionStorage.getItem('kaigen-contact-groups-runtime-profiles'))['qa-profile-a'].contactGroups.assignments['C'.repeat(64)]===undefined)?true:undefined,8000,'removal persisted');
  });

  await test(9,"changed-registration-ui-contracts",async()=>{
    await click(await chat('Carol'),'right');await click('.contact-group-menu-trigger');await ready('.contact-group-submenu');
    await checked(()=>[...document.querySelectorAll('.contact-group-header,.contact-group-submenu button[role="menuitemradio"]')].every(e=>e.dataset.kaigenUiId&&e.dataset.kaigenUiEntityKey),"rendered group families have IDs and entity keys");
    const settingsTrigger = await evaluate(() => document.querySelector('.app-shell.ultra-compact') ? '.compact-avatar-trigger' : '.rail-profile-button');
    await click(settingsTrigger);await ready('.settings-content');
    await checked(()=>!document.querySelector('.contact-group-submenu,.contact-group-context-menu,.contact-context-menu'),"navigation closes contact and group submenu");
  });
  assert.deepEqual(cdp.diagnostics().runtimeErrors,[],"approved UI cases have no unhandled errors");
  console.log("CONTACT_CHANGE_UI_PASS points="+selectedApprovedPoints.join(',')+" elapsedMs="+(Date.now()-started));
