import {
  geometryClearHistoryCalls, geometryHistoryReads, geometryHistoryTotal, geometryHoldClearHistory, geometryHoldLocalState,
  geometryHoldNextHistoryRead, geometryMessageId, geometryProfileLocalState, geometryResolveClearHistory,
  geometryResolveHistoryRead, geometryRestoreProfileHistory, geometrySetMenuProfiles, geometrySnapshotEvidence,
} from "./app-platform";
import { composer, setComposerDraft } from "./composer-test-adapter";

const A = "qa-profile-a", B = "qa-profile-b";
const frames = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
async function waitFor<T>(read: () => T | undefined, label: string): Promise<T> {
  const deadline = performance.now() + 6000;
  while (performance.now() < deadline) { const value = read(); if (value !== undefined) return value; await new Promise((resolve) => setTimeout(resolve, 20)); }
  throw new Error(`${label} timed out`);
}
const button = (text: string, selector = ".settings-content button") => [...document.querySelectorAll<HTMLButtonElement>(selector)].find((item) => item.textContent?.trim() === text);
const rows = () => document.querySelectorAll(".message[data-message-key]");
const input = (field: HTMLInputElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
};
async function chat() {
  document.querySelector<HTMLButtonElement>(".chats-button")!.click();
  await waitFor(() => composer() ?? undefined, "chat composer"); await frames();
}
async function contact(name: string, friend: number, empty = false) {
  await chat();
  const item = await waitFor(() => [...document.querySelectorAll<HTMLButtonElement>(".chat-item")].find((row) => row.textContent?.includes(name)), name);
  item.click();
  await waitFor(() => item.classList.contains("selected") && (empty ? geometrySnapshotEvidence(friend)?.total === 0 : document.querySelector(`[data-message-key="${geometryMessageId(friend, friend === 0 ? 99999 : 50)}"]`)) ? true : undefined, "contact history");
  await frames();
}
async function search(query: string, wait = true) {
  if (!document.querySelector(".message-search input")) document.querySelector<HTMLButtonElement>('.header-actions > button[aria-label="Поиск"]')!.click();
  const field = await waitFor(() => document.querySelector<HTMLInputElement>(".message-search input") ?? undefined, "search input");
  input(field, query);
  if (wait) await waitFor(() => /^\d+\/\d+/.test(document.querySelector(".message-search-count")?.textContent ?? "") && !document.querySelector(".message-search-count")?.textContent?.startsWith("0/") ? true : undefined, "search results");
  await frames();
}
async function quote(friend: number) {
  const message = await waitFor(() => document.querySelector<HTMLElement>(`[data-message-key="${geometryMessageId(friend, 50)}"]`) ?? undefined, "quote row");
  const bounds = message.getBoundingClientRect();
  message.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: Math.max(10, bounds.left + 40), clientY: Math.max(10, Math.min(innerHeight - 40, bounds.top + 10)) }));
  const action = await waitFor(() => button("Цитировать", ".restricted-context-menu button"), "quote action");
  action.click(); await waitFor(() => document.querySelector(".composer-reply-preview") ?? undefined, "reply preview");
}
async function privacy() {
  document.querySelector<HTMLButtonElement>(".rail-profile-menu-button")!.click();
  const menu = await waitFor(() => document.querySelector(".rail-profile-menu") ?? undefined, "profile menu");
  menu.querySelector<HTMLButtonElement>("button")!.click();
  const tab = await waitFor(() => document.querySelector<HTMLButtonElement>('.settings-tabs button[aria-label="Приватность"]') ?? undefined, "privacy tab");
  tab.click(); await waitFor(() => button("Очистить всю локальную историю") ?? document.querySelector(".destroy-confirm"), "clear control");
}
async function confirm() {
  button("Очистить всю локальную историю")?.click(); await frames();
  return waitFor(() => document.querySelector<HTMLButtonElement>(".destroy-confirm .danger-button") ?? undefined, "clear confirmation");
}
async function switchTo(id: string) {
  document.querySelector<HTMLButtonElement>(`.profile-switcher-item[data-profile-id="${id}"]`)!.click();
  await waitFor(() => document.querySelector(`.profile-switcher-item.active[data-profile-id="${id}"]`) ?? undefined, "profile switch");
  await frames();
}
function resolveClears(start: number, error?: string) {
  for (let index = start; index < geometryClearHistoryCalls.length; index++) if (geometryClearHistoryCalls[index].status === "pending") geometryResolveClearHistory(index, error);
}
export async function runActualSettingsHistoryScenario() {
  let assertions = 0;
  const failures: string[] = [], events: string[] = [];
  const check = (value: unknown, label: string) => { assertions++; if (!value) failures.push(label); };
  const cleared = (event: Event) => events.push((event as CustomEvent).detail?.profileId);
  window.addEventListener("kaigen:chat-history-cleared", cleared);
  try {
    await waitFor(() => document.querySelector(".app-shell") ?? undefined, "App");
    geometrySetMenuProfiles(true); geometryHoldClearHistory();
    await waitFor(() => document.querySelector(`.profile-switcher-item[data-profile-id="${B}"]`) ?? undefined, "owner B");
    await contact("QA Bob", 0); await search("Needle");
    await waitFor(() => document.querySelector(`[data-message-key="${geometryMessageId(0, 1000)}"]`) ?? undefined, "far cached range");
    check((geometrySnapshotEvidence(0)?.windowStart ?? 99999) < 1500, "A has an actual ranged history cache before clear");
    document.querySelector<HTMLButtonElement>('[aria-label="Закрыть поиск"]')!.click();
    await contact("QA Carol", 1); setComposerDraft(composer()!, "synthetic draft A retained"); await frames();
    await quote(1); await search("Carol synthetic");
    check(!!document.querySelector(".composer-reply-preview") && rows().length > 0, "A has actual history, reply and search state");
    await privacy(); (await confirm()); button("Отмена", ".destroy-confirm button")!.click(); await frames();
    check(geometryClearHistoryCalls.length === 0 && geometryHistoryTotal(A, 1) === 51, "cancel issues no clear command and preserves A");
    const action = await confirm(); action.click(); action.click();
    await waitFor(() => geometryClearHistoryCalls.length > 0 ? true : undefined, "clear dispatch");
    check(geometryClearHistoryCalls.length === 1, "confirmation double-click dispatches exactly one clear");
    check(geometryClearHistoryCalls.every((call) => call.profileId === A && call.friendNumber === null), "clear command captures exact owner A");
    check(action.disabled, "pending clear exposes a disabled confirmation");
    resolveClears(0, "SYNTHETIC_CLEAR_REFUSED"); await frames();
    check([...document.querySelectorAll(".settings-content .setting-error")].some((item) => item.textContent?.includes("историю")), "reject shows a visible error in the History tab");
    check(geometryHistoryTotal(A, 1) === 51 && geometryHistoryTotal(B, 1) === 51 && events.length === 0, "reject changes neither owner's data and emits no success event");
    await chat();
    check(rows().length > 0 && !!document.querySelector(".composer-reply-preview") && document.querySelector<HTMLInputElement>(".message-search input")?.value === "Carol synthetic" && composer()?.value === "synthetic draft A retained", "reject preserves chat/reply/search/plain draft");
    geometryHoldNextHistoryRead("snapshot"); geometryRestoreProfileHistory(A);
    await waitFor(() => geometryHistoryReads.some((call) => call.kind === "snapshot" && call.status === "pending") ? true : undefined, "held pre-clear history snapshot");
    geometryHoldNextHistoryRead("search"); await search("Carol synthetic message", false);
    await waitFor(() => geometryHistoryReads.some((call) => call.kind === "search" && call.status === "pending") ? true : undefined, "held pre-clear search result");
    check(geometryHistoryReads.every((call) => call.profileId === A && call.rows > 0), "both delayed reads captured actual A rows/results before clear");
    await privacy();
    const retryStart = geometryClearHistoryCalls.length; (await confirm()).click();
    await waitFor(() => geometryClearHistoryCalls.length > retryStart ? true : undefined, "retry dispatch");
    resolveClears(retryStart); await waitFor(() => button("Очистить всю локальную историю"), "clear success");
    check(!document.querySelector(".settings-content .setting-error"), "successful retry removes the earlier error");
    check(geometryHistoryTotal(A, 1) === 0 && geometryHistoryTotal(B, 1) === 51 && events.every((owner) => owner === A), "success clears only A and signals its owner");
    await chat(); await frames();
    check(rows().length === 0 && !document.querySelector(".composer-reply-preview"), "success removes visible history and reply");
    check(!document.querySelector(".message-search") && !document.querySelector(".empty-search"), "success resets search query/results/cursor UI");
    check(composer()?.value === "synthetic draft A retained", "clear preserves the plain unsent draft");
    geometryHistoryReads.forEach((call, index) => { if (call.status === "pending") geometryResolveHistoryRead(index); }); await frames();
    check(rows().length === 0 && !document.querySelector(".message-search mark"), "late pre-clear history/search replies cannot revive rows/results");
    await contact("QA Bob", 0, true);
    check(rows().length === 0, "opening A's previous ranged cache cannot restore cleared rows");
    await switchTo(B); await contact("QA Carol", 1);
    check(rows().length > 0 && geometryHistoryTotal(B, 1) === 51, "B history remains readable after A clear");
    setComposerDraft(composer()!, "synthetic draft B canary"); await frames(); await quote(1); await search("Carol synthetic");
    await switchTo(A); geometryRestoreProfileHistory(A); await contact("QA Carol", 1);
    setComposerDraft(composer()!, "synthetic late A retained"); await frames(); await quote(1); await search("Carol synthetic");
    await privacy(); const lateReject = geometryClearHistoryCalls.length; (await confirm()).click();
    await waitFor(() => geometryClearHistoryCalls.length > lateReject ? true : undefined, "late A reject request");
    await switchTo(B); await privacy();
    check(!document.querySelector(".destroy-confirm"), "switch to B removes A's destructive confirmation");
    resolveClears(lateReject, "SYNTHETIC_LATE_A_CLEAR_REFUSED"); await frames();
    check(!document.querySelector(".settings-content .setting-error") && geometryHistoryTotal(A, 1) === 51 && geometryHistoryTotal(B, 1) === 51, "late A rejection cannot paint B error or clear either owner");
    await switchTo(A); await privacy();
    const lateSuccess = geometryClearHistoryCalls.length; (await confirm()).click();
    await waitFor(() => geometryClearHistoryCalls.length > lateSuccess ? true : undefined, "late A success request");
    await switchTo(B); await contact("QA Carol", 1);
    await search("Carol synthetic");
    check(rows().length > 0 && !!document.querySelector(".composer-reply-preview") && composer()?.value === "synthetic draft B canary", "B history/reply/plain draft are restored before A's late clear completes");
    const beforeB = geometryProfileLocalState(B);
    resolveClears(lateSuccess); await frames();
    check(geometryClearHistoryCalls.slice(lateSuccess).every((call) => call.profileId === A) && events.at(-1) === A, "late clear keeps the captured A command/event owner");
    check(rows().length > 0 && !!document.querySelector(".composer-reply-preview") && composer()?.value === "synthetic draft B canary" && document.querySelector<HTMLInputElement>(".message-search input")?.value === "Carol synthetic", "late A success preserves B history/reply/search/plain draft");
    const afterB = geometryProfileLocalState(B);
    check(JSON.stringify(beforeB?.drafts) === JSON.stringify(afterB?.drafts) && JSON.stringify(beforeB?.draftQuotes) === JSON.stringify(afterB?.draftQuotes), "late A clear preserves B's persisted draft and reply canaries");
    await switchTo(A); await contact("QA Carol", 1, true);
    check(rows().length === 0 && !document.querySelector(".composer-reply-preview") && !document.querySelector(".message-search"), "switching back to A cannot resurrect cleared history/reply/search");
    check(composer()?.value === "synthetic late A retained", "inactive-owner clear preserves A's plain draft");
    check(!Object.keys(geometryProfileLocalState(A)?.draftQuotes ?? {}).length, "cleared A's persisted reply cache is empty");
    geometryRestoreProfileHistory(A); await contact("QA Carol", 1); await quote(1);
    await privacy(); const remounted = geometryClearHistoryCalls.length; (await confirm()).click();
    await waitFor(() => geometryClearHistoryCalls.length > remounted ? true : undefined, "clear before same-owner remount");
    await switchTo(B); geometryHoldLocalState(A); await switchTo(A);
    const heldLocal = await waitFor(() => geometryHistoryReads.findIndex((call) => call.kind === "local" && call.status === "pending") >= 0 ? geometryHistoryReads.findIndex((call) => call.kind === "local" && call.status === "pending") : undefined, "held pre-clear local-state hydration");
    check(geometryHistoryReads[heldLocal].profileId === A && geometryHistoryReads[heldLocal].rows > 0, "remount captures A's old quote state before completion");
    await privacy(); const remountButton = button("Очистить всю локальную историю");
    check(remountButton?.disabled, "same-owner remount observes pending clear and blocks repeat submission");
    remountButton?.click(); await frames();
    check(geometryClearHistoryCalls.length === remounted + 1, "same-owner remount cannot dispatch a second clear");
    resolveClears(remounted); await frames(); geometryHoldLocalState(A, false);
    geometryHistoryReads.forEach((call, index) => { if (call.kind === "local" && call.status === "pending") geometryResolveHistoryRead(index); });
    await contact("QA Carol", 1, true); await frames();
    check(!document.querySelector(".composer-reply-preview"), "pre-clear local-state hydration cannot restore a quote after remounted clear");
    check(composer()?.value === "synthetic late A retained" && !Object.keys(geometryProfileLocalState(A)?.draftQuotes ?? {}).length, "late hydration preserves plain draft and persisted clear epoch");
    geometryRestoreProfileHistory(A); await contact("QA Carol", 1); await quote(1); await switchTo(B);
    check(Object.keys(geometryProfileLocalState(A)?.draftQuotes ?? {}).length > 0, "new quotes after clear and late hydration remain persistable");
    check(geometryHistoryTotal(B, 1) === 51 && geometryClearHistoryCalls.every((call) => call.profileId === A) && geometryClearHistoryCalls.every((call) => call.status !== "pending"), "all clear outcomes drain and B remains untouched");
    return { ok: failures.length === 0, assertions, failures, boundary: "actual-RootApp/Settings/cache/reply/search; deferred-disposable-platform", calls: geometryClearHistoryCalls, staleReads: geometryHistoryReads, events };
  } catch (error) { return { ok: false, assertions, failures, error: error instanceof Error ? error.stack ?? error.message : String(error) }; }
  finally { geometryHoldClearHistory(false); window.removeEventListener("kaigen:chat-history-cleared", cleared); }
}
