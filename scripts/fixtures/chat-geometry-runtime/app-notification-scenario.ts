import { geometryDelayFriendDiscovery, geometryEmitNativeEvent, geometryNativeListenerCount, geometryProfileLocalState, geometryProfileSwitches } from "./app-platform";
import { composer, setComposerDraft } from "./composer-test-adapter";
import { installDesktopNotifications } from "../../../src/desktopNotifications";

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const frames = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
async function waitFor<T>(read: () => T | undefined, label: string): Promise<T> {
  const deadline = performance.now() + 7000;
  while (performance.now() < deadline) { const value = read(); if (value !== undefined) return value; await delay(20); }
  throw new Error(`${label} timed out`);
}
const heading = () => document.querySelector(".conversation-header .header-copy strong")?.textContent;
const key = (letter: string) => `friend-key:${letter.repeat(64)}`;
const activate = (profileId: string, target: string) => geometryEmitNativeEvent("kaigen-notification-activate", { profileId, target });
const lease = () => sessionStorage.getItem("kaigen-open-unread-target");
async function openSettings() {
  document.querySelector<HTMLButtonElement>(".rail-profile-menu-button")!.click();
  const menu = await waitFor(() => document.querySelector(".rail-profile-menu") ?? undefined, "profile menu");
  menu.querySelectorAll<HTMLButtonElement>("button")[1].click();
  await waitFor(() => document.querySelector(".settings-view") ?? undefined, "settings");
}

export async function runActualAppNotificationScenario() {
  let assertions = 0;
  const check = (value: unknown, label: string) => { assertions++; if (!value) throw new Error(label); };
  try {
    await waitFor(() => composer() ?? undefined, "initial composer");
    await waitFor(() => geometryNativeListenerCount("kaigen-notification-activate") === 1 ? true : undefined, "one root notification subscription");
    check(geometryNativeListenerCount("kaigen-message-sound") === 1, "sound subscription belongs to the root rather than a chat or settings panel");
    setComposerDraft(composer()!, "same-profile notification draft");
    await frames();
    activate("qa-profile-a", key("B"));
    await waitFor(() => heading() === "QA Carol" ? true : undefined, "same-profile notification chat");
    await waitFor(() => lease() === null ? true : undefined, "same-profile opened lease consumption");
    await waitFor(() => geometryProfileLocalState("qa-profile-a")?.drafts?.[`tox-${"A".repeat(64)}`] === "same-profile notification draft" ? true : undefined, "same-profile draft persistence");
    check(geometryProfileSwitches.length === 0, "opening another chat in the same profile needs no profile switch");
    check(!document.querySelector(".event-notices,.profile-event-notices"), "there is no replacement in-window message banner");

    setComposerDraft(composer()!, "cross-profile notification draft");
    await frames();
    geometryDelayFriendDiscovery(400);
    activate("qa-profile-b", key("C"));
    await waitFor(() => geometryProfileSwitches.length ? true : undefined, "serialized profile switch");
    check(geometryProfileSwitches.length === 1 && geometryProfileSwitches[0].profileId === "qa-profile-b", "native click switches the exact loaded profile once");
    check(geometryProfileSwitches[0].previousState.drafts[`tox-${"B".repeat(64)}`] === "cross-profile notification draft", "the outgoing profile draft is durably saved before its switch command");
    check(lease() !== null, "the click lease survives the profile switch until delayed friend discovery resolves");
    await waitFor(() => heading() === "QA Dave" && document.title === "QA Second — Kaigen" ? true : undefined, "exact second-profile chat");
    await waitFor(() => lease() === null ? true : undefined, "cross-profile opened lease consumption");
    check(geometryProfileLocalState("qa-profile-a").drafts[`tox-${"B".repeat(64)}`] === "cross-profile notification draft", "remount does not replace the first profile's saved draft");
    geometryDelayFriendDiscovery(0);
    activate("missing-profile", key("A"));
    await frames();
    check(lease() === null && geometryProfileSwitches.length === 1 && heading() === "QA Dave", "a stale removed profile cannot retarget a different loaded profile");
    activate("qa-profile-a", "friend-number:0");
    await frames();
    check(lease() === null && geometryProfileSwitches.length === 1, "invalid unstable-number targets are rejected at the native listener boundary");
    sessionStorage.setItem("kaigen-open-unread-target", JSON.stringify({ profileId: "qa-profile-a", target: key("A"), createdAt: Date.now() - 300_001 }));
    window.dispatchEvent(new Event("kaigen-open-notification"));
    await frames();
    check(lease() === null && geometryProfileSwitches.length === 1, "expired handoff cannot switch a profile");

    await openSettings();
    const tab = document.querySelector<HTMLButtonElement>('.settings-tabs button[title="Уведомления"]');
    check(!!tab, "desktop settings expose notification preferences");
    tab!.click(); await frames();
    const switches = [...document.querySelectorAll<HTMLInputElement>('.settings-content input[type="checkbox"]')];
    const volume = document.querySelector<HTMLInputElement>('.settings-content input[type="range"]')!;
    check(switches.length === 3 && switches.every((input) => !input.checked) && volume.disabled && volume.value === "70", "new profile popup/request/sound settings are off and volume defaults to 70%");
    switches[2].click(); await frames();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(volume, "25");
    volume.dispatchEvent(new Event("input", { bubbles: true }));
    await waitFor(() => geometryProfileLocalState("qa-profile-b")?.notifySound === true && geometryProfileLocalState("qa-profile-b")?.notificationVolume === 0.25 ? true : undefined, "saved sound volume");
    check(!volume.disabled && !switches[0].checked, "sound can be enabled with a chosen volume independently of popup messages");
    activate("qa-profile-b", key("B"));
    await waitFor(() => heading() === "QA Carol" ? true : undefined, "notification while settings are open");
    check(!document.querySelector(".settings-view"), "native notifications remain active outside the chat view");

    const disposePendingSubscription = installDesktopNotifications();
    disposePendingSubscription();
    await frames();
    check(geometryNativeListenerCount("kaigen-notification-activate") === 1 && geometryNativeListenerCount("kaigen-message-sound") === 1, "late subscription completion after cleanup leaves no duplicate native listeners");
    return { ok: true, assertions };
  } catch (error) { return { ok: false, assertions, error: error instanceof Error ? error.stack ?? error.message : String(error) }; }
  finally { geometryDelayFriendDiscovery(0); }
}

export async function runActualAppWebNotificationScenario() {
  let assertions = 0;
  const check = (value: unknown, label: string) => { assertions++; if (!value) throw new Error(label); };
  try {
    await waitFor(() => composer() ?? undefined, "Web composer");
    check(geometryNativeListenerCount("kaigen-notification-activate") === 0 && geometryNativeListenerCount("kaigen-message-sound") === 0, "Web never subscribes to desktop notification or sound events");
    const originalHeading = heading();
    activate("qa-profile-a", key("B")); await frames();
    check(lease() === null && heading() === originalHeading, "an injected desktop event is unused in Web");
    await openSettings();
    check(!document.querySelector('.settings-tabs button[title="Уведомления"]') && !document.querySelector('input[aria-label="Громкость уведомлений"]'), "Web offers no desktop notification or sound settings");
    check(!document.querySelector(".event-notices,.profile-event-notices"), "Web renders no in-app notification substitute");
    return { ok: true, assertions };
  } catch (error) { return { ok: false, assertions, error: error instanceof Error ? error.stack ?? error.message : String(error) }; }
}
