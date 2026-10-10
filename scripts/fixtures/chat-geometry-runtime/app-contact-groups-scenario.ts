import { contactGroupsEvidence, contactGroupsInjectEvent, contactGroupsHoldSave, contactGroupsReleaseSaves } from "./app-contact-groups-platform";

type Stage = { id: number; kind: string; x?: number; y?: number; key?: string; text?: string; name?: string; done?: boolean };
declare global { var __KAIGEN_CONTACT_GROUPS_STAGE__: Stage | undefined; }
let sequence = 0;
let assertions = 0;
const cases: any[] = [];
const U = "__ungrouped__";
const A = "A".repeat(64), B = "B".repeat(64), C = "C".repeat(64), D = "D".repeat(64);
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function wait<T>(read: () => T | undefined, label: string, timeout = 8_000): Promise<T> {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) { const value = read(); if (value !== undefined) return value; await delay(25); }
  throw new Error(label + " timed out");
}
function check(value: unknown, label: string) { assertions++; if (!value) throw new Error(label); }
async function input(stage: Omit<Stage, "id">) {
  const current = { ...stage, id: ++sequence };
  globalThis.__KAIGEN_CONTACT_GROUPS_STAGE__ = current;
  await wait(() => current.done ? true : undefined, "trusted " + stage.kind);
  await delay(60);
}
const buttons = (selector: string) => [...document.querySelectorAll<HTMLButtonElement>(selector)];
async function button(selector: string, text?: string) {
  return wait(() => buttons(selector).find(element => !text || element.textContent?.trim() === text), selector + " " + text);
}
async function click(element: HTMLElement, kind = "click") {
  element.scrollIntoView({ block: "nearest" });
  await delay(40);
  const box = element.getBoundingClientRect();
  await input({ kind, x: box.left + Math.min(24, box.width / 2), y: box.top + box.height / 2 });
}
const headers = () => buttons(".contact-group-header");
const groupNames = () => headers().map(header => header.querySelector(".contact-group-name")?.textContent);
const state = (id = "qa-profile-a") => contactGroupsEvidence().saved[id]?.contactGroups;
async function persisted(predicate: (value: any) => boolean, label: string, id = "qa-profile-a") {
  return wait(() => predicate(state(id)) ? state(id) : undefined, label);
}
async function contact(name: string) {
  return wait(() => buttons(".chat-item").find(element => element.querySelector(".chat-name")?.textContent?.includes(name)), "contact " + name);
}
async function contextContact(name: string) {
  await click(await contact(name), "right");
  await button(".contact-group-menu-trigger");
}
async function submenu(hover = false) {
  const trigger = await button(".contact-group-menu-trigger");
  if (hover && !document.querySelector(".app-shell.ultra-compact")) { const box = trigger.getBoundingClientRect(); await input({kind:"move",x:box.right-12,y:box.top+box.height/2}); }
  else await click(trigger);
  await button(".contact-group-submenu button");
}
async function create(name: string, group: string) {
  await contextContact(name); await submenu();
  await click(await button(".contact-group-submenu button", "Создать группу…"));
  await wait(() => document.querySelector<HTMLInputElement>("#contact-group-name-input") ?? undefined, "group dialog");
  await input({ kind: "text", text: group });
  await click(await button(".file-confirm-card button[type=submit]"));
  return persisted(value => value?.groups.some((item: any) => item.name === group), "created group " + group, contactGroupsEvidence().activeProfileId);
}
async function assign(name: string, group: string) {
  await contextContact(name); await submenu();
  await click(await button(".contact-group-submenu button", group));
  await wait(() => !document.querySelector(".contact-group-submenu") ? true : undefined, "assignment closes menu");
}
async function header(name: string) { return wait(() => headers().find(element => element.querySelector(".contact-group-name")?.textContent === name), "group header " + name); }
async function capture(name: string) { await input({ kind: "capture", name }); }
async function closeMenu() { await input({ kind: "key", key: "Escape" }); }

async function keyboardCancellation(name: string) {
  const target = await header(name);
  const box = target.getBoundingClientRect();
  const expanded = target.getAttribute("aria-expanded");
  const events: any[] = [];
  const record = (event: Event) => events.push({type:event.type,trusted:event.isTrusted,key:(event as KeyboardEvent).key});
  for (const type of ["pointercancel", "keydown", "click"]) target.addEventListener(type, record);
  cases.push({kind:"pointercancel-keyboard",events});
  try {
    await input({kind:"pointercancel",x:box.left+12,y:box.top+box.height/2});
    target.focus({preventScroll:true});
    await input({kind:"key",key:"Enter"});
    await wait(()=>target.getAttribute("aria-expanded")!==expanded?true:undefined,"first Enter after pointercancel toggles header");
    check(events.some(event=>event.type==="pointercancel"&&event.trusted),"pointercancel originates from trusted touch cancellation");
    check(events.some(event=>event.type==="click"&&event.trusted),"Enter produces native trusted button activation");
    check(target.getAttribute("aria-expanded")!==expanded,"pointercancel cannot swallow next keyboard toggle");
    await input({kind:"key",key:"Enter"});
  } finally { for(const type of ["pointercancel","keydown","click"]) target.removeEventListener(type,record); }
}

export async function runContactGroupsKeyboardScenario() {
  try { await keyboardCancellation("Keyboard"); return {ok:true,assertions,cases}; }
  catch(error) {await capture("groups-keyboard-failure.png");return {ok:false,assertions,cases,error:error instanceof Error?error.stack:String(error)};}
}

export async function runContactGroupsScenario() {
  try {
    const toggle = await button(".contact-groups-toggle");
    await wait(() => !toggle.disabled ? true : undefined, "profile persistence ready");
    check(toggle.getAttribute("aria-pressed") === "false" && headers().length === 0, "first-run groups remain off");
    check(buttons(".chat-item").length === 4, "flat list keeps existing contacts");
    await capture("groups-off-current.png");
    await click(toggle);
    await wait(() => headers().length === 1 ? true : undefined, "first enable system header");
    check(groupNames().join() === "Без группы", "first enable creates only system header");
    check(document.querySelector('[data-contact-group-region="' + U + '"]')?.querySelectorAll(".chat-item").length === 4, "existing contacts begin ungrouped");
    await capture("groups-first-enable.png");
    await create("Carol", "Работа");
    await create("Dave", "Друзья");
    let snapshot = await persisted(value => value?.groups.length === 2, "two groups persisted");
    const work = snapshot.groups.find((item: any) => item.name === "Работа").id;
    const friends = snapshot.groups.find((item: any) => item.name === "Друзья").id;
    check(snapshot.assignments[B] === work && snapshot.assignments[C] === friends, "atomic creation assigns first contact by public key");
    await assign("Erin", "Друзья");
    await persisted(value => value?.assignments[D] === friends, "Erin assignment");
    await contextContact("Erin");
    await submenu();
    await click(await button(".contact-group-submenu button", "Убрать из группы"));
    await persisted(value => !value?.assignments[D], "remove assignment");
    check(state().groups.length === 2, "removing one contact keeps nonempty group");
    await assign("Carol", "Друзья");
    await persisted(value => value?.groups.length === 1 && value.assignments[B] === friends, "moving last work contact auto deletes group");
    check(!headers().some(element => element.dataset.contactGroupId === work), "empty group header disappears");
    await create("Carol", "Работа");
    snapshot = await persisted(value => value?.groups.length === 2, "restored Work");
    const work2 = snapshot.groups.find((item: any) => item.name === "Работа").id;
    await click(await header("Работа"), "right");
    await click(await button(".contact-group-context-menu button", "Переименовать группу…"));
    await input({ kind: "selectall" }); await input({ kind: "text", text: "Проект" });
    await click(await button(".file-confirm-card button[type=submit]"));
    await persisted(value => value?.groups.some((item: any) => item.id === work2 && item.name === "Проект"), "rename persisted");
    await click(await header("Без группы"), "right");
    check(!document.querySelector(".contact-group-context-menu"), "system group context cannot rename or delete");
    await input({ kind: "platform", text: "MacIntel" });
    await click(await header("Проект"), "mac");
    check(!!document.querySelector(".contact-group-context-menu") && buttons(".contact-group-context-menu button").length === 2, "macOS Control click opens custom group rename/delete menu");
    await capture("groups-mac-control-header.png");
    await closeMenu();
    await click(await header("Без группы"), "mac");
    check(!document.querySelector(".contact-group-context-menu"), "macOS Control click preserves system group guard");
    await input({ kind: "platform", text: "Win32" });
    await keyboardCancellation("Проект");
    const beforeFlat = JSON.stringify(state().assignments);
    await click(toggle); await wait(() => headers().length === 0 ? true : undefined, "flat toggle");
    await persisted(value => value?.enabled === false, "disabled saved");
    check(JSON.stringify(state().assignments) === beforeFlat, "flat toggle retains assignments");
    await click(toggle); await wait(() => headers().length === 3 ? true : undefined, "groups restored");
    await assign("Erin", "Друзья");
    await persisted(value => value?.assignments[D] === friends, "counter group assignment");
    check(buttons('[data-contact-group-region="' + friends + '"] .chat-item')[0]?.textContent?.includes("Dave"), "existing activity sorting runs inside Friends");
    const orderBeforeEvent = JSON.stringify(state().order);
    await click(await header("Друзья"));
    await wait(() => (document.querySelector('[data-contact-group-id="' + friends + '"]')?.getAttribute("aria-expanded") === "false") ? true : undefined, "collapse Friends");
    contactGroupsInjectEvent(2, "Groups Dave new event");
    contactGroupsInjectEvent(3, "Groups Erin new event");
    await wait(() => document.querySelector('[data-contact-group-id="' + friends + '"] .contact-unread-count')?.textContent === "2" ? true : undefined, "collapsed unread aggregate", 12_000);
    check(JSON.stringify(state().order) === orderBeforeEvent, "new events never reorder groups");
    await click(await header("Друзья"));
    await wait(() => buttons('[data-contact-group-region="' + friends + '"] .chat-item').length === 2 ? true : undefined, "Friends expanded");
    await wait(() => buttons('[data-contact-group-region="' + friends + '"] .chat-item')[0]?.textContent?.includes("Erin") ? true : undefined, "event friend snapshot refresh", 12_000);
    check(buttons('[data-contact-group-region="' + friends + '"] .chat-item')[0]?.textContent?.includes("Erin"), "latest event promotes Erin within Friends only");
    check(!document.querySelector('[data-contact-group-id="' + friends + '"] .contact-unread-count'), "expanded group hides aggregate counter");
    await click(await contact("Erin"));
    await wait(() => !buttons(".chat-item").find(element => element.textContent?.includes("Erin"))?.querySelector(".contact-unread-count") ? true : undefined, "read Erin clears unread", 12_000);
    await click(await header("Друзья"));
    await wait(() => document.querySelector('[data-contact-group-id="' + friends + '"] .contact-unread-count')?.textContent === "1" ? true : undefined, "read updates collapsed aggregate", 12_000);
    await capture("groups-collapsed-counter.png");
    await click(await header("Друзья"));
    await assign("Dave", "Проект");
    await persisted(value=>value?.assignments[C]===work2,"unread contact moved to Project");
    await click(await header("Друзья"));
    check(!document.querySelector('[data-contact-group-id="'+friends+'"] .contact-unread-count'),"moving unread contact clears source aggregate");
    await click(await header("Проект"));
    await wait(()=>document.querySelector('[data-contact-group-id="'+work2+'"] .contact-unread-count')?.textContent==="1"?true:undefined,"unread follows moved contact");
    check(document.querySelector('[data-contact-group-id="'+work2+'"] .contact-unread-count')?.textContent==="1","moved contact updates collapsed destination aggregate");
    await capture("groups-unread-moved.png");
    await click(await header("Проект"));
    await assign("Dave", "Друзья");
    await click(await header("Друзья"));
    // Trusted drag across threshold moves the system group, without toggling it.
    const system = await header("Без группы"), target = await header("Проект");
    const sourceBox = system.getBoundingClientRect(), targetBox = target.closest('[data-contact-group-region]')!.getBoundingClientRect();
    const expandedBefore = system.getAttribute("aria-expanded");
    await input({ kind: "dragstart", x: sourceBox.left + 20, y: sourceBox.top + sourceBox.height / 2 });
    await input({ kind: "dragmove", x: targetBox.left + 20, y: targetBox.bottom - 2 });
    await input({ kind: "dragend", x: targetBox.left + 20, y: targetBox.bottom - 2 });
    await persisted(value => value?.order.indexOf(U) > value.order.indexOf(work2), "system group dragged after Project");
    check((await header("Без группы")).getAttribute("aria-expanded") === expandedBefore, "drag completion does not collapse group");
    await capture("groups-reordered.png");
    // Real explicit-profile save contract and independent second profile.
    const profileAState = JSON.stringify(state());
    const collapseBeforeSwitch = (await header("Друзья")).getAttribute("aria-expanded");
    contactGroupsHoldSave("qa-profile-a");
    await click(await button('.profile-switcher-item[data-profile-id="qa-profile-b"]'));
    await wait(() => contactGroupsEvidence().saves.some(call => call.profileId === "qa-profile-a" && call.status === "pending") ? true : undefined, "deferred save during profile switch");
    check(contactGroupsEvidence().activeProfileId === "qa-profile-a", "switch waits for owned profile save");
    check((await button(".contact-groups-toggle")).disabled, "group toggle disabled during pending profile switch");
    await click(await button(".contact-groups-toggle"));
    await click(await header("Друзья"));
    check((await header("Друзья")).getAttribute("aria-expanded") === collapseBeforeSwitch, "group header cannot mutate after switch snapshot");
    contactGroupsReleaseSaves();
    await wait(() => contactGroupsEvidence().activeProfileId === "qa-profile-b" && headers().length === 0 ? true : undefined, "second profile default off");
    await click(await button(".contact-groups-toggle"));
    await create("Carol", "Second profile");
    await persisted(value => value?.groups.some((item: any) => item.name === "Second profile"), "second profile saved", "qa-profile-b");
    check(JSON.stringify(state()) === profileAState, "second profile operations preserve first profile state");
    await click(await button('.profile-switcher-item[data-profile-id="qa-profile-a"]'));
    await wait(() => groupNames().includes("Проект") ? true : undefined, "first profile restored");
    check(!groupNames().includes("Second profile"), "profile group names do not leak");
    check(contactGroupsEvidence().saves.every(call => ["qa-profile-a", "qa-profile-b"].includes(call.profileId)), "every save targets explicit profile");
    await click(await header("Проект"), "right");
    await click(await button(".contact-group-context-menu button", "Удалить группу"));
    await persisted(value => !value?.groups.some((item: any) => item.id === work2) && !value.assignments[B], "delete group unassigns its contacts");
    check(!!(await contact("Carol")), "deleted group contacts remain visible");
    return { ok: true, assertions, cases, evidence: contactGroupsEvidence(), restartState: state() };
  } catch (error) { contactGroupsReleaseSaves(); await capture("groups-failure.png"); return { ok: false, assertions, cases, error: error instanceof Error ? error.stack : String(error), evidence: contactGroupsEvidence() }; }
}

export async function runContactGroupsReloadScenario() {
  await wait(() => headers().length >= 2 ? true : undefined, "reload persisted groups");
  check(groupNames().includes("Друзья") && !groupNames().includes("Second profile"), "reload restores active profile groups only");
  check(state().enabled === true, "reload retains enabled flag");
  check(headers().map(element => element.dataset.contactGroupId).join() === state().order.join(), "reload retains system position and user order");
  await capture("groups-restart.png");
  return { ok: true, assertions, evidence: contactGroupsEvidence() };
}

export async function runContactGroupsGeometryScenario(scale: number, height: number, width: number) {
  const geometryCases: any[] = [];
  const bounds = (element: Element) => { const b = element.getBoundingClientRect(); return { left: b.left, top: b.top, right: b.right, bottom: b.bottom, width: b.width, height: b.height }; };
  const inside = (b: ReturnType<typeof bounds>) => b.left >= 6 && b.top >= 6 && b.right <= innerWidth - 6 && b.bottom <= innerHeight - 6;
  const near = (menu: ReturnType<typeof bounds>, point: {x:number;y:number}) => Math.abs(menu.left - Math.max(8, Math.min(point.x, innerWidth - menu.width - 8))) <= 4 && Math.abs(menu.top - Math.max(8, Math.min(point.y, innerHeight - menu.height - 8))) <= 4;
  try {
    await wait(() => headers().length >= 2 ? true : undefined, "geometry saved groups");
    const shell = document.querySelector<HTMLElement>(".app-shell")!;
    await wait(()=>Math.abs(Number(getComputedStyle(shell).zoom)-scale/100)<0.001?true:undefined,"actual requested interface scale");
    check(Math.abs(Number(getComputedStyle(shell).zoom)-scale/100)<0.001,"actual interface zoom equals requested scale");
    check(Math.abs(shell.getBoundingClientRect().width - innerWidth) <= 2, "scaled app shell fills viewport");
    const group = await header("Друзья");
    if (group.getAttribute("aria-expanded") === "false") await click(group);
    const item = await contact("Dave");
    item.scrollIntoView({ block: height < 500 ? "end" : "center" });
    await delay(80);
    const itemBox = bounds(item);
    const contactPoint = {x:width<800?itemBox.right-4:itemBox.left+Math.min(30,itemBox.width/2), y:itemBox.bottom-4};
    await input({ kind: "right", ...contactPoint });
    const menu = await wait(() => document.querySelector<HTMLElement>(".contact-context-menu:not(.contact-group-submenu):not(.contact-group-context-menu)") ?? undefined, "geometry contact menu");
    await delay(100);
    const contactBounds = bounds(menu);
    geometryCases.push({scale,height,width,kind:"contact-initial",invocation:contactPoint,menu:contactBounds});
    check(inside(contactBounds), "contact menu inside viewport at scale/height " + scale + "/" + height);
    const contactAnchor = shell.classList.contains("ultra-compact") ? {x:contactPoint.x<=innerWidth/2?0:innerWidth,y:contactPoint.y} : contactPoint;
    check(near(contactBounds,contactAnchor), "contact menu follows current desktop invocation or compact edge anchor with necessary clamp");
    await capture("groups-contact-" + scale + "-" + height + ".png");
    await submenu(true);
    await delay(100);
    const parent = bounds(document.querySelector(".contact-group-menu-trigger")!);
    const child = bounds(document.querySelector(".contact-group-submenu")!);
    const settledContactBounds = bounds(menu);
    geometryCases.push({scale,actualZoom:Number(getComputedStyle(shell).zoom),height,width,kind:"contact/submenu",invocation:contactPoint,initialMenu:contactBounds,menu:settledContactBounds,parent,submenu:child,scrollTop:document.querySelector(".chat-items")?.scrollTop});
    await capture("groups-submenu-" + scale + "-" + height + ".png");
    check(inside(child), "submenu stays inside viewport");
    check(Math.min(Math.abs(child.left-settledContactBounds.right-2),Math.abs(child.right-settledContactBounds.left+2)) <= 5, "submenu remains next to settled parent menu edge");
    check(inside(settledContactBounds),"parent pair correction remains inside viewport");
    check(settledContactBounds.width+child.width+2>innerWidth-16 || (contactPoint.x>=settledContactBounds.left&&contactPoint.x<=settledContactBounds.right),"fitting pair correction preserves invocation inside parent");
    check(Math.abs(child.top-Math.max(8,Math.min(parent.top,innerHeight-child.height-8))) <= 4, "submenu vertical placement follows its parent with necessary clamp");
    await click(await button(".contact-group-menu-trigger"));
    check(!!document.querySelector(".contact-group-submenu"),"trusted trigger click cannot hit an overlapping submenu item or dismiss the pair");
    await closeMenu();
    group.scrollIntoView({ block: height < 500 ? "end" : "center" });
    await delay(80);
    const headerBox=bounds(group), headerPoint={x:width<800?headerBox.right-4:headerBox.left+30,y:headerBox.bottom-3};
    await input({kind:"right",...headerPoint});
    await wait(()=>document.querySelector(".contact-group-context-menu") ?? undefined,"geometry header menu");
    await delay(100);
    const headerMenu=bounds(document.querySelector(".contact-group-context-menu")!);
    check(inside(headerMenu),"header menu stays inside viewport");
    if (document.querySelector(".app-shell.ultra-compact")) {
      const modal=document.querySelector<HTMLElement>(".contact-group-context-menu")!.closest<HTMLElement>(".compact-modal")!;
      const sheet=bounds(modal), backdrop=bounds(modal.parentElement!);
      check(modal.getAttribute("role")==="dialog" && modal.getAttribute("aria-modal")==="true" && !!modal.getAttribute("aria-label"),"compact header menu retains accessible modality");
      check(Math.abs(sheet.bottom-backdrop.bottom)<=4 && Math.abs((sheet.left+sheet.right)-(backdrop.left+backdrop.right))<=4,"compact header menu sheet stays bottom aligned and centered");
      check(headerMenu.left>=sheet.left && headerMenu.right<=sheet.right && headerMenu.top>=sheet.top && headerMenu.bottom<=sheet.bottom,"compact header menu stays contained in its sheet");
    } else check(near(headerMenu,headerPoint),"header menu stays at invocation except necessary clamp");
    await capture("groups-header-"+scale+"-"+height+".png");
    geometryCases.push({scale,height,width,kind:"header",invocation:headerPoint,menu:headerMenu,scrollTop:document.querySelector(".chat-items")?.scrollTop});
    await closeMenu();
    check(buttons(".chat-item").every(item=>getComputedStyle(item).borderBottomWidth==="0px"),"grouping adds no contact separators");
    return {ok:true,assertions,cases:geometryCases};
  } catch(error) {await capture("groups-geometry-failure-"+scale+"-"+height+".png");return {ok:false,assertions,cases:geometryCases,error:error instanceof Error?error.stack:String(error)};}
}


export async function runContactGroupsManyScenario() {
  const rect = (element: Element) => { const b = element.getBoundingClientRect(); return {left:b.left,top:b.top,right:b.right,bottom:b.bottom,width:b.width,height:b.height}; };
  const inside = (b: ReturnType<typeof rect>) => b.left >= 6 && b.top >= 6 && b.right <= innerWidth - 6 && b.bottom <= innerHeight - 6;
  const snapshot = (menu: HTMLElement) => ({bounds:rect(menu),scrollTop:menu.scrollTop,scrollHeight:menu.scrollHeight,clientHeight:menu.clientHeight,last:rect(menu.querySelector('button:last-child')!)});
  try {
    await wait(()=>headers().length===14?true:undefined,"many assigned groups loaded");
    check(Number(getComputedStyle(document.querySelector('.app-shell')!).zoom)===1.25,"many-group case uses actual 125 percent zoom");
    check(buttons('.chat-item').length===16,"twelve disposable contacts own twelve extra groups");
    const item=await contact('Dave'); item.scrollIntoView({block:'nearest'}); await delay(40);
    const itemBounds=rect(item), invocation={x:itemBounds.left+Math.min(24,itemBounds.width/2),y:itemBounds.top+itemBounds.height/2};
    await input({kind:'right',...invocation}); await submenu(true); await delay(150);
    const child=document.querySelector<HTMLElement>('.contact-group-submenu')!;
    const parent=document.querySelector<HTMLElement>('.contact-context-menu:not(.contact-group-submenu):not(.contact-group-context-menu)')!;
    const before=snapshot(child), parentBounds=rect(parent);
    cases.push({kind:'many-before',invocation,viewport:{width:innerWidth,height:innerHeight},parent:parentBounds,...before});
    await capture('groups-many-before-scroll.png');
    check(inside(parentBounds)&&inside(before.bounds),"long submenu and parent fit viewport at actual 125 percent");
    check(Math.min(Math.abs(before.bounds.left-parentBounds.right-2),Math.abs(before.bounds.right-parentBounds.left+2))<=5,"long submenu retains adjacent nonoverlapping pair gap");
    check(parentBounds.width+before.bounds.width+2>innerWidth-16 || (invocation.x>=parentBounds.left&&invocation.x<=parentBounds.right),"fitting many-group pair preserves invocation inside parent");
    check(child.scrollHeight>child.clientHeight,"many-group menu provides internal scrolling");
    await input({kind:'wheel',x:before.bounds.right-20,y:before.bounds.bottom-20});
    await delay(150);
    const after=snapshot(child);cases.push({kind:'many-after',...after});
    await capture('groups-many-after-scroll.png');
    check(after.scrollTop>0,"trusted wheel scrolls long submenu");
    check(inside(after.bounds)&&after.last.top>=after.bounds.top&&after.last.bottom<=after.bounds.bottom,"Create is visible inside viewport after internal scroll");
    const createButton=await button('.contact-group-submenu button','Создать группу…');
    const eventTrust:boolean[]=[];createButton.addEventListener('click',event=>eventTrust.push(event.isTrusted),{once:true});
    await click(createButton);
    await wait(()=>document.querySelector('#contact-group-name-input')?true:undefined,"trusted visible Create opens dialog");
    check(eventTrust.includes(true),"Create activation comes from trusted CDP pointer input");
    await capture('groups-many-create-dialog.png');
    return {ok:true,assertions,cases};
  } catch(error) {await capture('groups-many-failure.png');return {ok:false,assertions,cases,error:error instanceof Error?error.stack:String(error)};}
}
