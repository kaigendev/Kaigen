import {
  onboardingCalls, onboardingCommit, onboardingHoldStartup, onboardingPending, onboardingPick, onboardingPickerCalls,
  onboardingProfiles, onboardingReleaseStartup, onboardingRemoveOwner, onboardingResolve, onboardingStartupReads,
} from "./onboarding-platform";

const frames = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
async function waitFor<T>(read: () => T | undefined, label: string): Promise<T> {
  const deadline = performance.now() + 6000;
  while (performance.now() < deadline) { const value = read(); if (value !== undefined) return value; await new Promise((resolve) => setTimeout(resolve, 20)); }
  throw new Error(label + " timed out");
}
const button = (text: string, selector = ".welcome-screen button") => [...document.querySelectorAll<HTMLButtonElement>(selector)].find((item) => item.textContent?.replace(/[›‹]/g, "").trim() === text);
function input(field: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
}
const passwords = (scope = document) => [...scope.querySelectorAll<HTMLInputElement>('input[type="password"]')];
const calls = (command: string) => onboardingCalls.map((call, index) => ({...call,index})).filter((call) => call.command === command);
function resolvePending(command: string, error?: string) { calls(command).forEach((call) => { if (call.status === "pending") onboardingResolve(call.index,error); }); }
async function pending(command: string, count: number) { await waitFor(() => calls(command).length >= count ? true : undefined, command); await frames(); }
async function run(body: (check: (value: unknown, label: string) => void) => Promise<void>) {
  let assertions = 0; const failures: string[] = [];
  const check = (value: unknown, label: string) => { assertions++; if (!value) failures.push(label); };
  try {
    await body(check);
    check(onboardingPending() === 0, "all mutation and startup calls drain");
    return { ok: failures.length === 0, assertions, failures, boundary: "actual-RootApp/Welcome/Unlock; deferred-disposable-platform",
      calls: onboardingCalls, pickers: onboardingPickerCalls, startupReads: onboardingStartupReads };
  } catch (error) { return { ok:false,assertions,failures,error:error instanceof Error ? error.stack : String(error) }; }
  finally { onboardingReleaseStartup(); }
}
async function welcome() { await waitFor(() => document.querySelector(".welcome-cards") ?? undefined,"Welcome"); }
export const runActualOnboardingCreateScenario = () => run(async (check) => {
  await welcome(); button("Создать профиль")!.click(); await frames();
  const form = document.querySelector<HTMLFormElement>(".create-flow")!;
  input(form.querySelector<HTMLInputElement>('input[type="text"],input:not([type])')!,"Synthetic Created");
  form.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(); await frames();
  input(passwords(form)[0],"synthetic-create-key"); input(passwords(form)[1],"different"); await frames();
  form.querySelector<HTMLButtonElement>(".startup-primary")!.click(); await frames();
  check(calls("create_profile").length === 0 && document.querySelector(".startup-error")?.textContent?.includes("совпадают"),"create mismatch is rejected before invoke");
  form.querySelector<HTMLButtonElement>(".startup-back")!.click(); await frames(); button("Создать профиль")!.click(); await frames();
  check(passwords().every((field) => !field.value),"leaving and reentering create removes secrets");
  const current = document.querySelector<HTMLFormElement>(".create-flow")!;
  if (!current.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked) { current.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(); await frames(); }
  input(passwords(current)[0],"synthetic-create-key"); input(passwords(current)[1],"synthetic-create-key"); await frames();
  current.querySelector<HTMLButtonElement>(".startup-primary")!.click(); await pending("create_profile",1);
  check(current.querySelector<HTMLButtonElement>(".startup-primary")!.disabled,"create pending disables submission");
  check(current.querySelector<HTMLButtonElement>(".startup-back")!.disabled,"create pending keeps the committing route mounted");
  check(onboardingCalls[0].passwordLength === "synthetic-create-key".length,"create captures protected password input");
  resolvePending("create_profile","SYNTHETIC_CREATE_REFUSED"); await frames();
  check(!!document.querySelector(".startup-error") && onboardingProfiles().length === 0,"create refusal stays on Welcome with no profile");
  check(passwords().every((field) => !field.value),"create refusal clears secret inputs");
  input(passwords()[0],"synthetic-create-key"); input(passwords()[1],"synthetic-create-key"); await frames();
  const retry = document.querySelector<HTMLButtonElement>(".create-flow .startup-primary")!;
  retry.click(); retry.click(); await pending("create_profile",2);
  check(calls("create_profile").length === 2,"create retry repeated click dispatches once");
  resolvePending("create_profile"); await waitFor(() => document.querySelector(".app-shell") ?? undefined,"created Messenger");
  check(onboardingProfiles().length === 1 && document.title.includes("Synthetic Created"),"created owner list/title and Messenger route are correct");
  check(!passwords().length && !document.querySelector(".startup-form"),"created route retains no Welcome secret inputs");
});
export const runActualOnboardingImportScenario = () => run(async (check) => {
  await welcome(); button("Импортировать")!.click(); await frames();
  onboardingPick(null); button("Выбрать папку qTox")!.click(); await frames();
  check(onboardingPickerCalls.length === 1 && calls("discover_qtox_profiles").length === 0,"cancelled picker never discovers or imports");
  check(!document.querySelector(".startup-error") && document.querySelector(".import-flow")?.getAttribute("aria-busy") === "false","picker cancel leaves an idle clean import route");
  onboardingPick(new Error("SYNTHETIC_PICKER_REFUSED")); button("Выбрать ZIP или .kai")!.click(); await frames();
  check(!!document.querySelector(".startup-error") && calls("discover_qtox_profiles").length === 0,"picker refusal is visible and does not discover");
  onboardingPick("synthetic-empty.zip"); button("Выбрать ZIP или .kai")!.click(); await pending("discover_qtox_profiles",1);
  check(document.querySelector<HTMLButtonElement>(".import-flow .startup-back")!.disabled,"discovery pending keeps the route mounted");
  resolvePending("discover_qtox_profiles"); await frames();
  check(document.querySelector(".startup-note")?.textContent?.includes("нет пригодных") && !document.querySelector(".qtox-candidates article"),"empty discovery shows the inspected empty state");
  onboardingPick("synthetic-profiles.zip"); button("Выбрать ZIP или .kai")!.click(); await pending("discover_qtox_profiles",2);
  resolvePending("discover_qtox_profiles","SYNTHETIC_DISCOVERY_REFUSED"); await frames();
  check(!!document.querySelector(".startup-error") && document.querySelector(".import-flow")?.getAttribute("aria-busy") === "false","discovery refusal drains pending and supports retry");
  onboardingPick("synthetic-profiles.zip"); button("Выбрать ZIP или .kai")!.click(); await pending("discover_qtox_profiles",3);
  resolvePending("discover_qtox_profiles"); await frames();
  let rows = [...document.querySelectorAll<HTMLElement>(".qtox-candidates article")];
  check(rows.length === 2 && rows.every((row) => row.querySelector<HTMLButtonElement>(".startup-primary")!.disabled),"encrypted candidates require independent nonempty passwords");
  input(passwords(rows[0] as any)[0],"wrong-import-key"); input(passwords(rows[1] as any)[0],"synthetic-neighbor-canary"); await frames();
  rows[0].querySelector<HTMLButtonElement>(".startup-primary")!.click(); await pending("import_qtox_profile",1);
  check(rows.every((row) => row.querySelector<HTMLButtonElement>(".startup-primary")!.disabled),"import pending blocks all candidate submissions");
  resolvePending("import_qtox_profile"); await frames();
  check(onboardingProfiles().length === 0 && !!document.querySelector(".startup-error"),"wrong encrypted import fails without changing profile list/route");
  check(!passwords(rows[0] as any)[0].value && passwords(rows[1] as any)[0].value === "synthetic-neighbor-canary","wrong import clears only its captured secret");
  input(passwords(rows[0] as any)[0],"synthetic-import-key"); await frames();
  rows[0].querySelector<HTMLButtonElement>(".startup-primary")!.click(); await pending("import_qtox_profile",2);
  resolvePending("import_qtox_profile","SYNTHETIC_IMPORT_REFUSED"); await frames();
  check(onboardingProfiles().length === 0 && !passwords(rows[0] as any)[0].value && document.querySelector(".import-flow")?.getAttribute("aria-busy") === "false","correct-password IO refusal clears its secret/pending and permits retry");
  input(passwords(rows[0] as any)[0],"synthetic-import-key"); await frames();
  const retry = rows[0].querySelector<HTMLButtonElement>(".startup-primary")!; retry.click(); retry.click();
  await pending("import_qtox_profile",3);
  check(calls("import_qtox_profile").length === 3,"import retry repeated click invokes only once");
  resolvePending("import_qtox_profile"); await waitFor(() => document.querySelector(".app-shell") ?? undefined,"imported Messenger");
  check(onboardingProfiles().length === 1 && document.title.includes("Synthetic imported Alpha"),"encrypted import selects the imported owner and Messenger route");
  check(!passwords().length && !document.querySelector(".qtox-candidates"),"successful import removes all source-secret fields");
});
export const runActualOnboardingUnlockScenario = () => run(async (check) => {
  await waitFor(() => document.querySelector(".unlock-screen") ?? undefined,"Unlock");
  const row = (name: string) => [...document.querySelectorAll<HTMLElement>(".unlock-list article")].find((item) => item.textContent?.includes(name))!;
  const connect = (item: HTMLElement) => [...item.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "Подключить" || button.textContent?.trim() === "…")!;
  check(document.querySelectorAll(".unlock-list article").length === 2 && connect(row("Alpha")).disabled && connect(row("Beta")).disabled,"locked profiles start independently gated by passwords");
  input(passwords(row("Alpha") as any)[0],"wrong-key"); await frames(); connect(row("Alpha")).click(); await pending("unlock_profile",1);
  check(connect(row("Alpha")).disabled && !row("Beta").querySelector("em"),"A pending does not alter B error state");
  resolvePending("unlock_profile"); await frames();
  check(!!row("Alpha").querySelector("em") && !row("Alpha").classList.contains("unlocked") && !row("Beta").querySelector("em"),"wrong A password shows only A failure and leaves both locked");
  check(!passwords(row("Alpha") as any)[0].value && !passwords(row("Beta") as any)[0].value,"failed unlock clears only its source secret and releases pending");
  input(passwords(row("Alpha") as any)[0],"synthetic-key-a"); await frames();
  const aButton = connect(row("Alpha")); aButton.click(); aButton.click(); await pending("unlock_profile",2);
  check(calls("unlock_profile").filter((call) => call.owner === "qa-profile-a").length === 2,"A repeated retry dispatches a single unlock");
  const pendingA = calls("unlock_profile").filter((call) => call.owner === "qa-profile-a" && call.status === "pending");
  pendingA.forEach((call) => onboardingCommit(call.index));
  input(passwords(row("Beta") as any)[0],"synthetic-key-b"); await frames(); connect(row("Beta")).click(); await pending("unlock_profile",3);
  const pendingB = calls("unlock_profile").find((call) => call.owner === "qa-profile-b" && call.status === "pending")!;
  onboardingCommit(pendingB.index);
  check(pendingA.length > 0 && pendingB.returnedLoaded.length === 0 && onboardingProfiles().every((profile) => profile.loaded),"both native-style commits finish before either reversed response");
  onboardingHoldStartup(true); onboardingResolve(pendingB.index);
  await waitFor(() => document.querySelector(".app-shell") ?? undefined,"B first Messenger"); await frames();
  check(document.querySelectorAll(".profile-switcher-item").length === 2,"B's later committed full snapshot includes both loaded owners");
  pendingA.forEach((call) => onboardingResolve(call.index)); await frames();
  check(document.querySelectorAll(".profile-switcher-item").length === 2 && !!document.querySelector('.profile-switcher-item[data-profile-id="qa-profile-b"]'),"late A snapshot cannot relock or remove successfully unlocked B");
  check(!document.querySelector(".unlock-screen") && !passwords().length,"reversed successful unlocks keep Messenger route and remove secret controls");
  check(onboardingCalls.filter((call) => call.command === "unlock_profile" && call.status === "resolved").every((call) => call.owner === "qa-profile-a" || call.owner === "qa-profile-b"),"responses remain attributed to their captured owners");
  onboardingReleaseStartup(); await frames();
  check(onboardingProfiles().every((profile) => profile.loaded) && document.querySelectorAll(".profile-switcher-item").length === 2,"fresh readback preserves both unlocked owners");
});
export const runActualOnboardingRemovedownerScenario = () => run(async (check) => {
  await waitFor(() => document.querySelector(".unlock-screen") ?? undefined,"Unlock for removal race");
  const row = (name: string) => [...document.querySelectorAll<HTMLElement>(".unlock-list article")].find((item) => item.textContent?.includes(name))!;
  const connect = (item: HTMLElement) => [...item.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "Подключить")!;
  input(passwords(row("Alpha") as any)[0],"synthetic-key-a"); await frames(); connect(row("Alpha")).click(); await pending("unlock_profile",1);
  onboardingCommit(0);
  input(passwords(row("Beta") as any)[0],"synthetic-key-b"); await frames(); connect(row("Beta")).click(); await pending("unlock_profile",2);
  onboardingResolve(1); await waitFor(() => document.querySelector(".app-shell") ?? undefined,"B route before owner removal");
  onboardingRemoveOwner("qa-profile-a"); await waitFor(() => document.title.includes("Synthetic Beta") ? true : undefined,"removed owner readback");
  check(onboardingProfiles().length === 1 && onboardingProfiles()[0].id === "qa-profile-b","actual Root refresh publishes the removed owner list");
  window.dispatchEvent(new Event("kaigen:add-profile-request")); await welcome(); button("Создать профиль")!.click(); await frames();
  const draft = document.querySelector<HTMLInputElement>('.create-flow input:not([type])')!; input(draft,"Synthetic add draft"); await frames();
  onboardingResolve(0); await frames();
  check(!!document.querySelector(".create-flow") && document.querySelector<HTMLInputElement>('.create-flow input:not([type])')?.value === "Synthetic add draft","late unlock of removed A cannot close or replace the current Add Profile route");
  check(!document.querySelector(".app-shell") && onboardingProfiles().length === 1,"missing-owner completion does not remount Messenger or restore A");
});
