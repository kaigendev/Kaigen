import { geometryProfileActions, geometrySavedProfileOrder, geometrySetMenuProfiles } from "./app-platform";

type PointerStage = { id: number; x: number; y: number; endX: number; endY: number; cancel?: "escape" | "blur"; done: boolean };
declare global { var __KAIGEN_PRODUCT_POINTER_STAGE__: PointerStage | undefined; }
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const frames = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
async function waitFor<T>(read: () => T | undefined, label: string): Promise<T> {
  const deadline = performance.now() + 6000;
  while (performance.now() < deadline) { const value = read(); if (value !== undefined) return value; await delay(20); }
  throw new Error(`${label} timed out`);
}

export async function runActualAppProductFixes3Scenario() {
  let assertions = 0;
  const check = (value: unknown, label: string) => { assertions++; if (!value) throw new Error(label); };
  const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  let sequence = 0;
  const profile = (id: string) => document.querySelector<HTMLButtonElement>(`.profile-switcher-item[data-profile-id="${id}"]`)!;
  const order = () => [...document.querySelectorAll<HTMLElement>(".profile-switcher-item")].map((element) => element.dataset.profileId).join(",");
  const drag = async (source: string, target: string, edge: "before" | "after", cancel?: "escape" | "blur") => {
    const start = profile(source).getBoundingClientRect(), end = profile(target).getBoundingClientRect();
    const stage = { id: ++sequence, x: start.left + start.width / 2, y: start.top + start.height / 2, endX: edge === "before" ? end.left + 3 : end.right - 3, endY: end.top + end.height / 2, cancel, done: false };
    globalThis.__KAIGEN_PRODUCT_POINTER_STAGE__ = stage;
    await waitFor(() => stage.done ? true : undefined, "trusted pointer gesture");
    await frames();
  };
  try {
    await waitFor(() => document.querySelector(".app-shell") ?? undefined, "App");
    geometrySetMenuProfiles(true);
    await waitFor(() => profile("qa-profile-b") ?? undefined, "second profile");
    check(!profile("qa-profile-b").draggable, "profile buttons do not start HTML5/OLE drag");
    await drag("qa-profile-b", "qa-profile-a", "before");
    check(order() === "qa-profile-b,qa-profile-a", "trusted pointer drag moves the second profile before the first");
    await waitFor(() => geometrySavedProfileOrder().join(",") === order() ? true : undefined, "durable profile order");
    check(geometrySavedProfileOrder()[0] === "qa-profile-b", "new order crosses the existing portable persistence boundary");
    for (const cancel of ["escape", "blur"] as const) {
      await drag("qa-profile-b", "qa-profile-a", "after", cancel);
      check(order() === "qa-profile-b,qa-profile-a" && !document.querySelector(".profile-switcher-item.dragging"), `${cancel} cancels without a stale drop or stuck UI`);
    }
    profile("qa-profile-b").dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight", altKey: true, cancelable: true }));
    await frames();
    check(order() === "qa-profile-a,qa-profile-b", "Alt+Arrow ordering still works after pointer cancellation");
    profile("qa-profile-a").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 }));
    await waitFor(() => document.querySelector(".inactive-profile-status-menu") ?? undefined, "context after drag");
    check(!!document.querySelector(".inactive-profile-status-menu"), "profile context controls remain responsive");

    const validId = "03".repeat(36) + "0000";
    let completeRead: ((text: string) => void) | undefined;
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { readText: () => new Promise<string>((resolve) => { completeRead = resolve; }) } });
    const add = document.querySelector<HTMLButtonElement>(".contact-list-add")!;
    add.click();
    let input = await waitFor(() => document.querySelector<HTMLInputElement>(".add-contact-card input") ?? undefined, "contact form");
    check(!!completeRead, "clipboard read begins with the add-contact click");
    completeRead!(validId);
    await waitFor(() => input.value === validId ? true : undefined, "clipboard prefill");
    check(input.value === validId, "a complete checksum-valid clipboard Tox ID fills the actual input");
    add.click(); await frames();
    input = document.querySelector<HTMLInputElement>(".add-contact-card input")!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "manual value");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    completeRead!(validId); await frames();
    check(input.value === "manual value", "late clipboard resolution preserves actual user input");
    check(!document.querySelector(".rail-navigation .add-contact-button"), "only the contact-heading add control remains");

    document.querySelector<HTMLButtonElement>(".rail-profile-menu-button")!.click();
    const menu = await waitFor(() => document.querySelector(".rail-profile-menu") ?? undefined, "profile menu");
    menu.querySelector<HTMLButtonElement>("button")!.click();
    const cross = await waitFor(() => [...document.querySelectorAll<HTMLButtonElement>(".settings-profile-disable")].find((button) => button.getAttribute("aria-label")?.includes("QA Second")), "profile disable cross");
    cross.click();
    let dialog = await waitFor(() => document.querySelector<HTMLDialogElement>(".settings-disable-dialog[open]") ?? undefined, "disable confirmation");
    check(geometryProfileActions.length === 0 && dialog.textContent?.includes("QA Second") && dialog.textContent?.includes("повторного импорта"), "confirmation captures the exact profile and explains retained files before any command");
    check(document.activeElement === dialog.querySelector(".text-button"), "cancel receives the initial modal focus");
    dialog.querySelector<HTMLButtonElement>(".text-button")!.click(); await frames();
    check(!document.querySelector(".settings-disable-dialog") && geometryProfileActions.length === 0, "cancelling leaves the profile registered");
    cross.click();
    dialog = await waitFor(() => document.querySelector<HTMLDialogElement>(".settings-disable-dialog[open]") ?? undefined, "second disable confirmation");
    dialog.querySelector<HTMLButtonElement>(".save-button")!.click();
    await waitFor(() => geometryProfileActions.length ? true : undefined, "confirmed disable");
    check(geometryProfileActions.length === 1 && geometryProfileActions[0].profileId === "qa-profile-b", "one confirmed removal reaches the serialized root callback with the captured profile ID");
    return { ok: true, assertions };
  } catch (error) {
    return { ok: false, assertions, error: error instanceof Error ? error.stack ?? error.message : String(error) };
  } finally {
    delete globalThis.__KAIGEN_PRODUCT_POINTER_STAGE__;
    if (clipboardDescriptor) Object.defineProperty(navigator, "clipboard", clipboardDescriptor); else delete (navigator as any).clipboard;
  }
}
