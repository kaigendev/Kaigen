import { geometrySetMenuProfiles } from "./app-platform";
import { geometryQtoxCalls, geometryResolveQtox, qtoxPayload } from "./qtox-export-platform";

const A = "qa-profile-a", B = "qa-profile-b";
const frames = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
async function waitFor<T>(read: () => T | undefined, label: string): Promise<T> {
  const deadline = performance.now() + 6000;
  while (performance.now() < deadline) { const value = read(); if (value !== undefined) return value; await new Promise((resolve) => setTimeout(resolve, 20)); }
  throw new Error(label + " timed out");
}
const button = (label: string, selector = ".settings-content button") => [...document.querySelectorAll<HTMLButtonElement>(selector)].find((item) => item.textContent?.trim() === label);
const exportForm = () => [...document.querySelectorAll<HTMLFieldSetElement>(".settings-password-form")].find((item) => item.querySelector("b")?.textContent === "Экспорт профиля для qTox");
const password = () => exportForm()?.querySelector<HTMLInputElement>("input");
const exportButton = () => document.querySelector<HTMLButtonElement>('[data-kaigen-ui-id="settings.profiles.element.aktivnyy-profil-eksport-qtox"]') ?? button("Экспорт qTox (.zip)");
async function input(label: string, value: string) {
  const field = [...document.querySelectorAll<HTMLLabelElement>(".setting-field")].find((item) => item.querySelector("span")?.textContent === label)?.querySelector<HTMLInputElement>("input");
  if (!field) throw new Error("Missing input " + label);
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true })); await frames();
}
async function profiles() {
  if (!document.querySelector(".settings-content")) {
    document.querySelector<HTMLButtonElement>(".rail-profile-menu-button")!.click();
    const menu = await waitFor(() => document.querySelector(".rail-profile-menu") ?? undefined, "profile menu");
    menu.querySelector<HTMLButtonElement>("button")!.click();
  }
  const tab = await waitFor(() => document.querySelector<HTMLButtonElement>('.settings-tabs button[aria-label="Управление профилями"]') ?? undefined, "profile settings");
  tab.click(); await waitFor(() => exportButton(), "qTox action"); await frames();
}
async function switchTo(owner: string) {
  document.querySelector<HTMLButtonElement>('.profile-switcher-item[data-profile-id="' + owner + '"]')!.click();
  await waitFor(() => document.querySelector('.profile-switcher-item.active[data-profile-id="' + owner + '"]') ?? undefined, "profile " + owner);
  await frames(); await profiles();
}
async function openExport(secret?: string) {
  if (!exportForm()) { exportButton()!.click(); await frames(); }
  if (secret !== undefined) await input("Текущий пароль профиля", secret);
}
function resolvePending(start: number, error?: string) {
  geometryQtoxCalls.forEach((call, index) => { if (index >= start && call.status === "pending") geometryResolveQtox(index, error); });
}
async function dispatched(start: number) {
  await waitFor(() => geometryQtoxCalls.length > start ? true : undefined, "export dispatch"); await frames();
}
export async function runActualSettingsExportScenario() {
  let assertions = 0;
  const failures: string[] = [];
  const check = (value: unknown, label: string) => { assertions++; if (!value) failures.push(label); };
  const nativeCreate = URL.createObjectURL, nativeRevoke = URL.revokeObjectURL, nativeClick = HTMLAnchorElement.prototype.click;
  const blobs: Array<{ url: string; blob: Blob; revoked: number }> = [];
  const links: Array<{ href: string; fileName: string }> = [];
  const unmountProbes: Array<{ mode: string; outcome: string; committedAtResolution: boolean }> = [];
  let refuseClick = false, refuseCreate = false;
  URL.createObjectURL = (blob: Blob | MediaSource) => {
    if (refuseCreate) throw new Error("Synthetic object URL refusal");
    const url = nativeCreate.call(URL, blob); if (blob instanceof Blob) blobs.push({ url, blob, revoked: 0 }); return url;
  };
  URL.revokeObjectURL = (url: string) => { const entry = blobs.find((item) => item.url === url); if (entry) entry.revoked++; nativeRevoke.call(URL, url); };
  HTMLAnchorElement.prototype.click = function () {
    if (!this.href.startsWith("blob:")) { nativeClick.call(this); return; }
    if (refuseClick) throw new Error("Synthetic anchor handoff refusal");
    links.push({ href: this.href, fileName: this.download });
  };
  async function verifyCopy(start: number, owner: string) {
    const expected = qtoxPayload(owner), copies = links.slice(start);
    check(copies.length === 1, "one exact Blob handoff for " + owner);
    for (const link of copies) {
      const entry = blobs.find((item) => item.url === link.href)!;
      check(link.fileName === expected.fileName && entry.blob.type === "application/zip", "exact filename and ZIP MIME for " + owner);
      check(JSON.stringify([...new Uint8Array(await entry.blob.arrayBuffer())]) === JSON.stringify(expected.bytes), "exact opaque platform bytes for " + owner);
    }
    await new Promise((resolve) => setTimeout(resolve, 1150));
    check(blobs.every((entry) => entry.revoked === 1), "every completed Blob URL is revoked once");
  }
  try {
    await waitFor(() => document.querySelector(".app-shell") ?? undefined, "actual App");
    geometrySetMenuProfiles(true);
    await waitFor(() => document.querySelector('.profile-switcher-item[data-profile-id="' + B + '"]') ?? undefined, "second profile");
    await profiles();
    button("Установить пароль")!.click(); await frames();
    await input("Новый пароль", "synthetic-export-A"); await input("Повторите пароль", "synthetic-export-A");
    button("Применить")!.click(); await waitFor(() => button("Снять пароль"), "encrypted A"); await frames();

    await openExport();
    check(password()?.type === "password" && button("Сохранить ZIP")?.disabled, "encrypted form masks secret and refuses blank");
    const blank = geometryQtoxCalls.length; button("Сохранить ZIP")!.click(); await frames();
    check(geometryQtoxCalls.length === blank && blobs.length === 0, "blank password never dispatches or creates a Blob");

    await input("Текущий пароль профиля", "synthetic-wrong-export");
    const wrong = geometryQtoxCalls.length; button("Сохранить ZIP")!.click(); await dispatched(wrong);
    check(exportForm()?.disabled && password()?.value === "", "pending export disables form and clears dispatched secret");
    resolvePending(wrong); await frames();
    check(!!document.querySelector(".setting-error") && !exportForm()?.disabled && password()?.value === "" && blobs.length === 0, "wrong password clears secret, preserves encrypted profile and permits retry");

    await input("Текущий пароль профиля", "synthetic-export-A");
    const delayed = geometryQtoxCalls.length, firstCopy = links.length;
    const save = button("Сохранить ZIP")!; save.click(); save.click(); await dispatched(delayed);
    check(geometryQtoxCalls.length === delayed + 1, "same-turn repeated click starts one export");
    check(geometryQtoxCalls.slice(delayed).every((call) => call.requestedProfileId === A), "dispatch includes exact captured A owner");
    resolvePending(delayed); await frames();
    check(!exportForm() && !document.querySelector(".setting-error"), "success closes the secret form and clears prior error");
    await verifyCopy(firstCopy, A);

    await openExport("synthetic-export-A");
    const rejected = geometryQtoxCalls.length, rejectedCopies = links.length;
    button("Сохранить ZIP")!.click(); await dispatched(rejected); resolvePending(rejected, "SYNTHETIC_QTOX_REFUSED synthetic-export-A"); await frames();
    check(!!document.querySelector(".setting-error") && password()?.value === "" && links.length === rejectedCopies, "backend refusal clears secret and makes no download");
    check(!document.querySelector(".setting-error")?.textContent?.includes("synthetic-export-A"), "backend error cannot echo the captured secret");
    await input("Текущий пароль профиля", "synthetic-export-A");
    const retry = geometryQtoxCalls.length; button("Сохранить ZIP")!.click(); await dispatched(retry); resolvePending(retry); await frames();
    await verifyCopy(rejectedCopies, A);
    await openExport("synthetic-cancel-canary"); button("Отмена", ".settings-password-form button")!.click(); await frames(); await openExport();
    check(password()?.value === "", "cancel and reopen clear undispatched secret");
    button("Отмена", ".settings-password-form button")!.click(); await frames();

    await switchTo(B);
    const plain = geometryQtoxCalls.length, plainCopy = links.length;
    const action = exportButton()!; action.click(); action.click(); await dispatched(plain);
    check(geometryQtoxCalls.length === plain + 1 && geometryQtoxCalls.slice(plain).every((call) => call.requestedProfileId === B && !call.passwordPresent), "plaintext B uses one exact-owner export with null secret");
    resolvePending(plain); await frames(); await verifyCopy(plainCopy, B);
    button("Установить пароль")!.click(); await frames();
    await input("Новый пароль", "synthetic-export-B"); await input("Повторите пароль", "synthetic-export-B");
    button("Применить")!.click(); await waitFor(() => button("Снять пароль"), "encrypted B"); await frames();

    for (const outcome of ["success", "reject"]) {
      await switchTo(A); await openExport("synthetic-export-A");
      const late = geometryQtoxCalls.length, copies = links.length;
      button("Сохранить ZIP")!.click(); await dispatched(late);
      await switchTo(B); await openExport("synthetic-B-form-canary");
      resolvePending(late, outcome === "reject" ? "SYNTHETIC_LATE_A_REFUSED" : undefined); await frames();
      check(links.length === copies && password()?.value === "synthetic-B-form-canary" && !document.querySelector(".setting-error"), "late A " + outcome + " cannot download, clear B form or show B error");
      check(!JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]).includes("synthetic-export"), "export secrets stay out of persistence");
      button("Отмена", ".settings-password-form button")!.click(); await frames();
    }

    await switchTo(A); await openExport("synthetic-export-A");
    const remount = geometryQtoxCalls.length, remountCopy = links.length;
    button("Сохранить ZIP")!.click(); await dispatched(remount);
    document.querySelector<HTMLButtonElement>(".chats-button")!.click(); await frames(); await profiles();
    check(exportButton()?.disabled, "remounted Settings observes the existing owner operation");
    exportButton()!.click(); await frames();
    check(geometryQtoxCalls.length === remount + 1, "remount cannot dispatch a duplicate export");
    resolvePending(remount); await frames();
    check(links.length === remountCopy && !exportButton()?.disabled && !exportForm() && !document.querySelector(".setting-error"), "late unmounted result creates no URL and releases remount busy state");

    for (const fault of ["click", "create"]) {
      await openExport("synthetic-export-A");
      const pending = geometryQtoxCalls.length, copies = links.length, objects = blobs.length;
      refuseClick = fault === "click"; refuseCreate = fault === "create";
      button("Сохранить ZIP")!.click(); await dispatched(pending); resolvePending(pending); await frames();
      check(links.length === copies && !!document.querySelector(".setting-error") && !exportForm()?.disabled && password()?.value === "", fault + " failure exposes retry and clears secret without handoff");
      check(fault === "create" ? blobs.length === objects : blobs.slice(objects).every((entry) => entry.revoked === 1), fault + " failure leaks no object URL");
      refuseClick = false; refuseCreate = false;
      await input("Текущий пароль профиля", "synthetic-export-A");
      const recover = geometryQtoxCalls.length; button("Сохранить ZIP")!.click(); await dispatched(recover); resolvePending(recover); await frames(); await verifyCopy(copies, A);
    }

    for (const leave of ["switch", "unmount"]) {
      await openExport("synthetic-export-A");
      const pending = geometryQtoxCalls.length, copies = links.length, objects = blobs.length;
      button("Сохранить ZIP")!.click(); await dispatched(pending); resolvePending(pending); await frames();
      check(blobs.length === objects + 1 && blobs[objects].revoked === 0, "successful handoff retains URL until " + leave);
      if (leave === "switch") await switchTo(B);
      else { document.querySelector<HTMLButtonElement>(".chats-button")!.click(); await frames(); }
      check(blobs[objects]?.revoked === 1, leave + " immediately revokes the completed export URL");
      await verifyCopy(copies, A);
      if (leave === "switch") await switchTo(A); else await profiles();
    }

    for (const outcome of ["success", "reject"]) {
      await openExport("synthetic-export-A");
      const pending = geometryQtoxCalls.length, copies = links.length;
      button("Сохранить ZIP")!.click(); await dispatched(pending);
      await switchTo(B); await switchTo(A);
      check(exportButton()?.disabled, "A-B-A observes the original owner reservation");
      resolvePending(pending, outcome === "reject" ? "SYNTHETIC_A_B_A_REFUSED" : undefined); await frames();
      check(links.length === copies && !exportButton()?.disabled && !exportForm() && !document.querySelector(".setting-error"), "A-B-A " + outcome + " stays invalid after returning to the same owner");
    }

    await openExport("synthetic-export-A");
    const remountRejected = geometryQtoxCalls.length, remountRejectedCopy = links.length;
    button("Сохранить ZIP")!.click(); await dispatched(remountRejected);
    document.querySelector<HTMLButtonElement>(".chats-button")!.click(); await frames(); await profiles();
    resolvePending(remountRejected, "SYNTHETIC_UNMOUNTED_REFUSED"); await frames();
    check(links.length === remountRejectedCopy && !exportButton()?.disabled && !document.querySelector(".setting-error"), "remount ignores the old refusal and releases owner reservation");

    for (const mode of ["same-turn", "commit-microtask"]) for (const outcome of ["success", "reject"]) {
      await openExport("synthetic-export-A");
      const pending = geometryQtoxCalls.length, copies = links.length, objects = blobs.length;
      button("Сохранить ZIP")!.click(); await dispatched(pending);
      let resolved = false;
      const resolveAfterLeave = () => {
        const committedAtResolution = !document.querySelector(".settings-content");
        unmountProbes.push({ mode, outcome, committedAtResolution });
        resolvePending(pending, outcome === "reject" ? "SYNTHETIC_COMMIT_REFUSED" : undefined); resolved = true;
      };
      const observer = new MutationObserver(() => {
        if (!document.querySelector(".settings-content")) { observer.disconnect(); resolveAfterLeave(); }
      });
      if (mode === "commit-microtask") observer.observe(document.body, { childList: true, subtree: true });
      try {
        document.querySelector<HTMLButtonElement>(".chats-button")!.click();
        if (mode === "same-turn") resolveAfterLeave();
        await waitFor(() => resolved ? true : undefined, "commit microtask export settlement"); await frames();
        check(links.length === copies && blobs.length === objects, mode + " " + outcome + " cannot hand off after leaving Settings");
        if (mode === "commit-microtask") check(unmountProbes.at(-1)?.committedAtResolution, "microtask probe settles after actual Settings DOM unmount");
        await profiles();
        check(!exportButton()?.disabled && !exportForm() && !document.querySelector(".setting-error"), mode + " " + outcome + " releases busy without remount effects");
      } finally { observer.disconnect(); }
    }

    await openExport("synthetic-never-dispatched");
    const beforeSwitch = geometryQtoxCalls.length;
    button("Сохранить ZIP")!.click();
    document.querySelector<HTMLButtonElement>('.profile-switcher-item[data-profile-id="' + B + '"]')!.click();
    await frames(); await frames();
    check(geometryQtoxCalls.length === beforeSwitch, "switch before dispatch cancels captured-owner operation");
    resolvePending(beforeSwitch); await frames();
    check(!exportForm(), "profile switch clears the old export form and secret");

    document.querySelector<HTMLButtonElement>('.settings-tabs button[aria-label="Язык"]')!.click(); await frames();
    const language = document.querySelector<HTMLSelectElement>(".settings-content select")!;
    language.value = "en"; language.dispatchEvent(new Event("change", { bubbles: true }));
    const enProfiles = await waitFor(() => document.querySelector<HTMLButtonElement>('.settings-tabs button[aria-label="Profile management"]') ?? undefined, "English settings");
    enProfiles.click(); await frames(); button("Export qTox (.zip)")!.click(); await frames();
    await input("Current profile password", "synthetic-en-wrong");
    const enWrong = geometryQtoxCalls.length; button("Save ZIP")!.click(); await dispatched(enWrong); resolvePending(enWrong); await frames();
    check(document.querySelector(".setting-error")?.textContent === "Incorrect password.", "English wrong-password message uses current language");
    await input("Current profile password", "synthetic-export-B");
    const enReject = geometryQtoxCalls.length; button("Save ZIP")!.click(); await dispatched(enReject); resolvePending(enReject, "SYNTHETIC_REFUSED synthetic-export-B"); await frames();
    check(document.querySelector(".setting-error")?.textContent === "Could not export the qTox profile", "English unknown error is a safe localized fallback");
    await input("Current profile password", "synthetic-export-B");
    const enRetry = geometryQtoxCalls.length, enCopy = links.length; button("Save ZIP")!.click(); await dispatched(enRetry); resolvePending(enRetry); await frames();
    await verifyCopy(enCopy, B);
    check(!JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]).includes("synthetic-"), "no synthetic secrets enter local or session storage");
    check(blobs.every((entry) => entry.revoked === 1), "no outstanding URL after all cases");
    return { ok: failures.length === 0, assertions, failures, calls: geometryQtoxCalls, copies: links.length, unmountProbes,
      blobUrls: blobs.length, boundary: "actual-RootApp-and-Settings; deferred-platform; real-Blob-URL; anchor-handoff-observed; native-ZIP-proof-separate" };
  } catch (error) { return { ok: false, assertions, failures, error: error instanceof Error ? error.stack ?? error.message : String(error) }; }
  finally {
    geometryQtoxCalls.forEach((call, index) => { if (call.status === "pending") geometryResolveQtox(index, "SYNTHETIC_FIXTURE_CLEANUP"); });
    for (const entry of blobs) if (!entry.revoked) nativeRevoke.call(URL, entry.url);
    URL.createObjectURL = nativeCreate; URL.revokeObjectURL = nativeRevoke; HTMLAnchorElement.prototype.click = nativeClick;
  }
}
