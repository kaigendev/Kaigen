import { geometryHoldPasswords, geometryPasswordCalls, geometryResolvePassword, geometrySetMenuProfiles } from "./app-platform";

const frames = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
async function waitFor<T>(read: () => T | undefined, label: string): Promise<T> {
  const deadline = performance.now() + 6000;
  while (performance.now() < deadline) { const result = read(); if (result !== undefined) return result; await new Promise((resolve) => setTimeout(resolve, 20)); }
  throw new Error(`${label} timed out`);
}
const button = (label: string, selector = ".settings-content button") => [...document.querySelectorAll<HTMLButtonElement>(selector)].find((item) => item.textContent?.trim() === label);
const form = () => document.querySelector<HTMLFieldSetElement>(".settings-password-form");
const input = async (label: string, value: string) => {
  const field = [...document.querySelectorAll<HTMLLabelElement>(".setting-field")].find((item) => item.querySelector("span")?.textContent === label)!.querySelector<HTMLInputElement>("input")!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true })); await frames();
};
async function openProfiles() {
  document.querySelector<HTMLButtonElement>(".rail-profile-menu-button")!.click();
  const menu = await waitFor(() => document.querySelector(".rail-profile-menu") ?? undefined, "profile menu");
  menu.querySelector<HTMLButtonElement>("button")!.click();
  await waitFor(() => button("Установить пароль") ?? button("Снять пароль"), "Settings profiles");
}

export async function runActualSettingsPasswordScenario() {
  let assertions = 0;
  const check = (value: unknown, label: string) => { assertions++; if (!value) throw new Error(label); };
  try {
    await waitFor(() => document.querySelector(".app-shell") ?? undefined, "App");
    geometrySetMenuProfiles(true);
    await waitFor(() => document.querySelector('.profile-switcher-item[data-profile-id="qa-profile-b"]') ?? undefined, "second profile");
    await openProfiles();
    button("Установить пароль")!.click(); await frames();
    await input("Новый пароль", "synthetic-A"); await input("Повторите пароль", "different");
    button("Применить")!.click(); await frames();
    check(geometryPasswordCalls.length === 0 && document.querySelector(".setting-error")?.textContent?.includes("не совпадают"), "mismatch stays in Settings without a backend command");
    await input("Повторите пароль", "synthetic-A");
    check([...form()!.querySelectorAll("input")].every((field) => field.type === "password"), "every set-password input is masked");
    geometryHoldPasswords(true);
    const apply = button("Применить")!; apply.click(); apply.click();
    await waitFor(() => geometryPasswordCalls.length === 1 ? true : undefined, "password request");
    check(geometryPasswordCalls[0].profileId === "qa-profile-a", "password command binds the exact Settings owner");
    check(form()?.disabled && !!document.querySelector(".profile-password-progress"), "pending password disables the form and exposes progress");
    check(geometryPasswordCalls.length === 1, "repeated click produces one backend request");
    geometryResolvePassword(0); await waitFor(() => button("Снять пароль"), "encrypted badge action");
    check(!form() && !!document.querySelector(".settings-password-success"), "success clears secret inputs and updates the encrypted action");
    button("Снять пароль")!.click(); await frames();
    check([...form()!.querySelectorAll("input")].every((field) => field.type === "password"), "current-password input is masked");
    await input("Текущий пароль", "wrong"); button("Применить")!.click();
    await waitFor(() => geometryPasswordCalls.length === 2 ? true : undefined, "wrong password request");
    geometryResolvePassword(1); await waitFor(() => document.querySelector(".setting-error") ?? undefined, "wrong password rejection");
    check(!!button("Снять пароль") && !form()?.disabled && !document.querySelector(".settings-password-success"), "wrong current password preserves encryption and permits retry");
    await input("Текущий пароль", "synthetic-A"); button("Применить")!.click();
    await waitFor(() => geometryPasswordCalls.length === 3 ? true : undefined, "retry request");
    geometryResolvePassword(2); await waitFor(() => button("Установить пароль"), "password removal");
    check(!form() && geometryPasswordCalls[2].newPassword === null, "removal clears secrets after the correct current password");
    button("Установить пароль")!.click(); await frames();
    await input("Новый пароль", "synthetic-B"); await input("Повторите пароль", "synthetic-B");
    button("Применить")!.click();
    await waitFor(() => geometryPasswordCalls.length === 4 ? true : undefined, "switch race request");
    document.querySelector<HTMLButtonElement>('.profile-switcher-item[data-profile-id="qa-profile-b"]')!.click();
    await waitFor(() => document.querySelector('.profile-switcher-item.active[data-profile-id="qa-profile-b"]') ?? undefined, "owner B");
    await frames();
    geometryResolvePassword(3, undefined, true); await frames();
    if (!document.querySelector(".settings-content")) await openProfiles();
    document.querySelector<HTMLButtonElement>('.settings-tabs button[aria-label="Управление профилями"]')!.click(); await frames();
    check(document.querySelector(".settings-active-profile-line strong")?.textContent === "second.kai", "late A reply cannot replace B's current profile metadata");
    check(!form() && !document.querySelector(".settings-password-success"), "owner switch clears secret form and suppresses A's late success notice");
    check(!!button("Установить пароль"), "B remains without a password");
    button("Установить пароль")!.click(); await frames();
    await input("Новый пароль", "synthetic-never-dispatched"); await input("Повторите пароль", "synthetic-never-dispatched");
    button("Применить")!.click();
    document.querySelector<HTMLButtonElement>('.profile-switcher-item[data-profile-id="qa-profile-a"]')!.click();
    await waitFor(() => document.querySelector('.profile-switcher-item.active[data-profile-id="qa-profile-a"]') ?? undefined, "switch before dispatch"); await frames();
    check(geometryPasswordCalls.length === 4, "owner switch before paint cancels the undispatched password request");
    check(!JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]).includes("synthetic-"), "synthetic passwords never enter browser persistence");
    return { ok: true, assertions, boundary: "actual-RootApp-and-Settings; deferred-disposable-platform" };
  } catch (error) { return { ok: false, assertions, error: error instanceof Error ? error.stack ?? error.message : String(error) }; }
  finally { geometryHoldPasswords(false); }
}
