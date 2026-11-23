import {
  geometryAppendOutgoingText, geometryCancellationCalls, geometryDelayFriendDiscovery,
  geometryDeferNextContactDeletion, geometryDeleteCalls, geometryEmitFriendStatus, geometryFailNextCancellation,
  geometryFailNextSend, geometryFriendDiscoveryPending, geometryFriendKey,
  geometryPendingRequestFriendNumber, geometryPendingRequestKey,
  geometryProfileLocalState, geometryReuseFriendSlot, geometrySendAttempts,
  geometryHoldNextLocalStateSave, geometryHeldLocalStateSave, geometryReleaseLocalStateSave,
} from "./app-platform";
import { composer, setComposerDraft } from "./composer-test-adapter";
import { opaqueUiEntityKey } from "../../../src/uiIdentity";

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const frames = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
async function waitFor<T>(read: () => T | undefined, label: string, ms = 6000): Promise<T> {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    const value = read();
    if (value !== undefined) return value;
    await delay(20);
  }
  throw new Error(`${label} timed out`);
}
const messageRow = (id: string) => document.querySelector<HTMLElement>(`[data-message-key="${id}"]`);
function openContext(target: HTMLElement) {
  const rect = target.getBoundingClientRect();
  target.dispatchEvent(new MouseEvent("contextmenu", {
    bubbles: true, cancelable: true, button: 2,
    clientX: rect.left + Math.min(20, rect.width / 2), clientY: rect.top + Math.min(20, rect.height / 2),
  }));
}
async function appendOutgoingAndAwaitLayout(friend: number, text: string, delivery: "pending" | "delivered" = "pending") {
  const scroll = document.querySelector<HTMLElement>(".message-scroll");
  if (!scroll) throw new Error("message scroll container is missing");
  const id = geometryAppendOutgoingText(friend, text, delivery);
  const row = await waitFor(() => messageRow(id) ?? undefined, `${delivery} outgoing row`);
  await waitFor(() => row.querySelector(`.delivery-${delivery}`) ?? undefined, `${delivery} delivery marker`);
  let previous: { top: number; scrollTop: number; scrollHeight: number } | null = null;
  const deadline = performance.now() + 6000;
  while (performance.now() < deadline) {
    await frames();
    const rowRect = row.getBoundingClientRect();
    const scrollRect = scroll.getBoundingClientRect();
    const current = { top: rowRect.top, scrollTop: scroll.scrollTop, scrollHeight: scroll.scrollHeight };
    const atLatest = Math.abs(scroll.scrollTop - Math.max(0, scroll.scrollHeight - scroll.clientHeight)) <= 2;
    const visible = row.isConnected && rowRect.top >= scrollRect.top - 2 && rowRect.bottom <= scrollRect.bottom + 2;
    if (previous && atLatest && visible && Math.abs(current.top - previous.top) <= 1
      && Math.abs(current.scrollTop - previous.scrollTop) <= 1 && current.scrollHeight === previous.scrollHeight) {
      return { id, row };
    }
    previous = current;
  }
  throw new Error(`${delivery} outgoing row did not settle at the latest-message viewport`);
}
const cancellationAction = () => [...document.querySelectorAll<HTMLButtonElement>('.restricted-context-menu [role="menuitem"]')]
  .find((button) => button.textContent?.includes("Отменить отправку") || button.textContent?.includes("Cancel sending"));
const contact = (name: string) => [...document.querySelectorAll<HTMLButtonElement>(".chat-item")]
  .find((button) => button.textContent?.includes(name));

type PendingViewportStage = { id: number; kind: "resize" | "capture"; width: number; height: number; name: string; done?: boolean };
declare global { var __KAIGEN_OUTBOX_VIEWPORT_STAGE__: PendingViewportStage | undefined; }
let pendingViewportSequence = 0;
async function pendingViewportStage(kind: PendingViewportStage["kind"], width: number, height: number, name: string) {
  const stage = { id: ++pendingViewportSequence, kind, width, height, name };
  globalThis.__KAIGEN_OUTBOX_VIEWPORT_STAGE__ = stage;
  await waitFor(() => globalThis.__KAIGEN_OUTBOX_VIEWPORT_STAGE__?.id === stage.id
    && globalThis.__KAIGEN_OUTBOX_VIEWPORT_STAGE__.done ? true : undefined, "pending contact " + kind);
}

async function pendingContactGeometry(key: string, check: (condition: unknown, label: string) => void, cases: Record<string, unknown>[]) {
  const originalViewport = { width: innerWidth, height: innerHeight };
  const preferenceKey = "kaigen.interface-layout";
  const oldPreference = localStorage.getItem(preferenceKey);
  const applyPreference = (value: string | null) => {
    const before = localStorage.getItem(preferenceKey);
    if (value === null) localStorage.removeItem(preferenceKey); else localStorage.setItem(preferenceKey, value);
    window.dispatchEvent(new StorageEvent("storage", { key: preferenceKey, oldValue: before, newValue: value, storageArea: localStorage }));
  };
  const pendingRow = () => document.querySelector<HTMLButtonElement>(`[data-kaigen-ui-entity-key="${opaqueUiEntityKey("contact", key)}"]`);
  const resize = async (width: number, height: number, name: string) => {
    await pendingViewportStage("resize", width, height, name);
    await waitFor(() => innerWidth === width && innerHeight === height ? true : undefined, "actual pending viewport");
    await frames();
  };
  const language = async (value: "ru" | "en") => {
    if (document.documentElement.lang === value) return;
    document.querySelector<HTMLButtonElement>(".rail-profile-menu-button")!.click();
    (await waitFor(() => document.querySelectorAll<HTMLButtonElement>(".rail-profile-menu button")[1] ?? undefined, "pending settings menu")).click();
    (await waitFor(() => document.querySelector<HTMLButtonElement>('.settings-nav button[title="Язык"], .settings-nav button[title="Language"]') ?? undefined, "pending language tab")).click();
    const select = await waitFor(() => [...document.querySelectorAll<HTMLSelectElement>(".settings-content select")]
      .find((field) => field.querySelector('option[value="en"]')), "pending language selection");
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await waitFor(() => document.documentElement.lang === value ? true : undefined, "pending translated language");
    document.querySelector<HTMLButtonElement>(".rail-button.chats-button")!.click();
    await frames();
  };
  try {
    applyPreference("auto");
    for (const lang of ["ru", "en"] as const) {
      await resize(1440, 1000, "language-" + lang);
      await waitFor(() => !document.querySelector(".app-shell.ultra-compact") ? true : undefined, "full pending language controls");
      await language(lang);
      for (const [mode, width, height] of [["full", 1440, 1000], ["tablet", 1024, 768], ["mobile", 390, 844]] as const) {
        await resize(width, height, lang + "-" + mode);
        await waitFor(() => !!document.querySelector(".app-shell.ultra-compact") === (mode === "mobile") ? true : undefined, "pending layout " + mode);
        document.querySelector<HTMLButtonElement>(".compact-chat-back")?.click();
        const row = await waitFor(() => { const candidate = pendingRow(); return candidate && candidate.getBoundingClientRect().height > 0 ? candidate : undefined; }, "visible pending row");
        row.scrollIntoView({ block: "nearest" });
        await frames();
        const status = [...row.querySelectorAll<HTMLElement>(".chat-status.pending, .compact-presence.pending")]
          .find((element) => element.getBoundingClientRect().height > 0 && getComputedStyle(element).visibility !== "hidden");
        const copy = row.querySelector<HTMLElement>(".chat-copy")!;
        const avatarOnly = getComputedStyle(copy).display === "none";
        const avatar = row.querySelector<HTMLElement>(".contact-status-pending");
        const indicator = avatarOnly ? avatar : status;
        const box = row.getBoundingClientRect(), statusBox = indicator?.getBoundingClientRect();
        const expected = lang === "ru" ? "ожидает авторизации" : "waiting for authorization";
        cases.push({ name: "pending-contact-geometry", lang, mode, viewport: { width: innerWidth, height: innerHeight },
          row: { left: box.left, right: box.right, top: box.top, bottom: box.bottom }, status: statusBox ? { left: statusBox.left, right: statusBox.right, top: statusBox.top, bottom: statusBox.bottom } : null,
          label: avatarOnly ? row.title : status?.textContent?.trim(), presentation: avatarOnly ? "avatar" : "text", shellClasses: document.querySelector(".app-shell")?.className });
        await pendingViewportStage("capture", width, height, "pending-contact-" + lang + "-" + mode);
        check(avatarOnly ? !!avatar && getComputedStyle(avatar, "::after").borderTopStyle === "dashed"
          && row.title.toLocaleLowerCase(lang).includes(expected) && row.getAttribute("aria-label")?.toLocaleLowerCase(lang).includes(expected)
          : !!status && status.textContent?.toLocaleLowerCase(lang).includes(expected), mode + "/" + lang + " pending status is visible and translated in its list presentation");
        check(box.width > 0 && box.left >= -1 && box.right <= innerWidth + 1, mode + "/" + lang + " pending contact stays inside viewport");
        check(!!statusBox && statusBox.left >= box.left - 1 && statusBox.right <= box.right + 1
          && statusBox.top >= box.top - 1 && statusBox.bottom <= box.bottom + 1, mode + "/" + lang + " pending status fits its row");
        check(document.documentElement.scrollWidth <= innerWidth + 1 && row.scrollWidth <= row.clientWidth + 1, mode + "/" + lang + " pending row has no horizontal overflow");
        check(!row.disabled && !!row.closest(".contact-row"), mode + "/" + lang + " pending contact retains its action target");
      }
    }
  } finally {
    await resize(1440, 1000, "restore-language");
    await waitFor(() => !document.querySelector(".app-shell.ultra-compact") ? true : undefined, "restore full pending controls");
    await language("ru");
    applyPreference(oldPreference);
    await resize(originalViewport.width, originalViewport.height, "restore-viewport");
    globalThis.__KAIGEN_OUTBOX_VIEWPORT_STAGE__ = undefined;
  }
}

export async function runActualAppOutboxScenario() {
  let assertions = 0;
  const cases: Record<string, unknown>[] = [];
  const check = (condition: unknown, label: string) => { assertions++; if (!condition) throw new Error(label); };
  try {
    await waitFor(() => document.querySelector(".app-shell") ?? undefined, "App");
    await waitFor(() => contact("QA Bob") ?? undefined, "Bob contact");
    const originalKey = geometryFriendKey(0);
    check(new URLSearchParams(location.search).has("outbox-fixture"), "isolated outbox fixture is enabled");
    geometryEmitFriendStatus(0, "offline");

    const { id: queuedId, row: queuedRow } = await appendOutgoingAndAwaitLayout(0, "Disposable offline queued cancellation");
    openContext(queuedRow);
    const cancel = await waitFor(() => cancellationAction(), "queued cancel action");
    cancel.click();
    await waitFor(() => messageRow(queuedId)?.querySelector(".delivery-cancelled") ?? undefined, "cancelled delivery marker");
    const acceptedCancel = geometryCancellationCalls.at(-1);
    check(acceptedCancel?.profileId === "qa-profile-a" && acceptedCancel.friendNumber === 0 && acceptedCancel.expectedPublicKey === originalKey && acceptedCancel.messageId === queuedId, "cancel API carries exact profile, stable key, and durable message ID");
    openContext(messageRow(queuedId)!);
    await frames();
    check(!cancellationAction(), "cancelled message no longer offers another cancel action");
    cases.push({ name: "offline-queued-cancel", messageId: queuedId, delivery: "cancelled" });

    const { id: rejectedId, row: rejectedRow } = await appendOutgoingAndAwaitLayout(0, "Disposable rejected cancellation");
    geometryFailNextCancellation();
    openContext(rejectedRow);
    (await waitFor(() => cancellationAction(), "rejected cancel action")).click();
    await waitFor(() => document.querySelector<HTMLElement>(".transfer-toast")?.textContent?.includes("Отправка уже началась") ? true : undefined, "already-transmitted notice");
    check(!!messageRow(rejectedId)?.querySelector(".delivery-pending") && !messageRow(rejectedId)?.querySelector(".delivery-cancelled"), "backend rejection keeps pending delivery unchanged");
    check(geometryCancellationCalls.at(-1)?.messageId === rejectedId, "rejected cancel was sent for the correct queued item");
    cases.push({ name: "cancel-rejected", messageId: rejectedId, delivery: "pending" });

    const { id: deliveredId, row: deliveredRow } = await appendOutgoingAndAwaitLayout(0, "Disposable already delivered", "delivered");
    openContext(deliveredRow);
    await frames();
    check(!cancellationAction(), "delivered message never offers cancellation");
    cases.push({ name: "delivered-menu", messageId: deliveredId });

    geometryFailNextSend();
    const editor = await waitFor(() => composer() ?? undefined, "message composer");
    setComposerDraft(editor, "Disposable failed send awaiting retry");
    const attemptsBefore = geometrySendAttempts.length;
    document.querySelector<HTMLButtonElement>(".composer .send")!.click();
    await waitFor(() => geometrySendAttempts.length > attemptsBefore ? true : undefined, "failed send reaches API");
    await waitFor(() => document.querySelector(".chat-send-retry") ?? undefined, "retry card");
    const persisted = await waitFor(() => {
      const operations = geometryProfileLocalState("qa-profile-a")?.pendingSendOperations;
      return operations && Object.keys(operations).length > 0 ? operations : undefined;
    }, "persisted retry operation");
    const operation = Object.values(persisted)[0] as any;
    check(operation.profileId === "qa-profile-a" && operation.friendNumber === 0 && operation.expectedPublicKey === originalKey && operation.chatId === `tox-${originalKey}`, "pending retry is bound to original profile and stable peer");

    document.querySelector<HTMLButtonElement>(".contact-list-add")!.click();
    const requestInput = await waitFor(() => document.querySelector<HTMLInputElement>(".add-contact-card input") ?? undefined, "outgoing request form");
    const pendingRequestKey = geometryPendingRequestKey();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(requestInput, `${pendingRequestKey}${"0".repeat(12)}`);
    requestInput.dispatchEvent(new Event("input", { bubbles: true }));
    document.querySelector<HTMLFormElement>(".add-contact-card")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await waitFor(() => document.querySelector<HTMLElement>(".add-contact-status")?.textContent?.includes("Контакт добавлен. Ожидает авторизации.") ? true : undefined, "outgoing request accepted");
    const pendingContact = document.querySelector<HTMLElement>(`[data-kaigen-ui-entity-key="${opaqueUiEntityKey("contact", pendingRequestKey)}"]`);
    check(!!pendingContact?.querySelector(".chat-status.pending, .compact-presence.pending"), "accepted contact is immediately visible with its pending authorization status");
    document.querySelector<HTMLButtonElement>(".add-contact-card .text-button")!.click();
    await pendingContactGeometry(pendingRequestKey, check, cases);
    await waitFor(() => geometryProfileLocalState("qa-profile-a")?.outgoingFriendRequests?.some((request: any) => request.toxId.startsWith(pendingRequestKey)) ? true : undefined, "persisted outgoing authorization request");
    check(geometryPendingRequestFriendNumber() !== null, "request created a separate unauthorized pending friend");
    check(!!geometryProfileLocalState("qa-profile-a")?.outgoingFriendRequests?.some((request: any) => request.toxId.startsWith(pendingRequestKey)), "pending peer request is durable before unrelated contact deletion");

    // A poll captured before deletion must not reinsert the old contact after
    // the delete succeeds. The fixture holds its pre-delete snapshot in flight.
    geometryDelayFriendDiscovery(1500);
    for (let attempt = 0; attempt < 3 && geometryFriendDiscoveryPending() === 0; attempt++) {
      geometryEmitFriendStatus(1, "online");
      await delay(60);
    }
    const stalePoll = await waitFor(() => geometryFriendDiscoveryPending() > 0 ? true : undefined, "in-flight stale friend poll", 3000);
    check(stalePoll, "pre-delete friend snapshot is in flight");
    check(!!geometryProfileLocalState("qa-profile-a")?.outgoingFriendRequests?.some((request: any) => request.toxId.startsWith(pendingRequestKey)), "unrelated pending request still exists when Bob deletion begins");
    openContext(contact("QA Bob")!);
    const deleteAction = await waitFor(() => document.querySelector<HTMLButtonElement>(".contact-context-menu .danger-menu") ?? undefined, "contact delete action");
    deleteAction.click();
    const confirm = await waitFor(() => document.querySelector<HTMLButtonElement>(".contact-delete-overlay .danger-button") ?? undefined, "contact delete confirmation");
    confirm.click();
    await waitFor(() => geometryDeleteCalls.length > 0 ? true : undefined, "delete API call");
    check(geometryFriendDiscoveryPending() > 0, "stale friend result is still in flight during deletion");
    await waitFor(() => !contact("QA Bob") ? true : undefined, "deleted contact removed");
    const deleteCall = geometryDeleteCalls.at(-1);
    check(deleteCall?.profileId === "qa-profile-a" && deleteCall.friendNumber === 0 && deleteCall.expectedPublicKey === originalKey, "delete API is bound to the captured stable peer");
    await waitFor(() => {
      const saved = geometryProfileLocalState("qa-profile-a");
      return !saved?.pendingSendOperations?.[operation.operationId] && !!saved?.outgoingFriendRequests?.some((request: any) => request.toxId.startsWith(pendingRequestKey)) ? true : undefined;
    }, "deleted contact local-state cleanup");
    check(!geometryProfileLocalState("qa-profile-a")?.pendingSendOperations?.[operation.operationId], "deleted peer retry is removed from durable local state");
    check(!!geometryProfileLocalState("qa-profile-a")?.outgoingFriendRequests?.some((request: any) => request.toxId.startsWith(pendingRequestKey)), "deleting Bob preserves an unrelated pending authorization request");
    await waitFor(() => geometryFriendDiscoveryPending() === 0 ? true : undefined, "stale poll completion");
    check(!contact("QA Bob"), "pre-delete friend poll cannot resurrect removed peer");
    geometryDelayFriendDiscovery(0);

    const pendingFriendNumber = geometryPendingRequestFriendNumber();
    const pendingChatId = `tox-${pendingRequestKey}`;
    const pendingRow = await waitFor(() => document.querySelector<HTMLButtonElement>(`[data-kaigen-ui-entity-key="${opaqueUiEntityKey("contact", pendingRequestKey)}"]`) ?? undefined, "pending contact before save race");
    pendingRow.click(); await frames();
    const pendingEditor = await waitFor(() => composer() ?? undefined, "pending contact composer");
    geometryFailNextSend();
    setComposerDraft(pendingEditor, "Pending retry operation before deletion");
    const pendingAttemptsBefore = geometrySendAttempts.length;
    document.querySelector<HTMLButtonElement>(".composer .send")!.click();
    await waitFor(() => geometrySendAttempts.length > pendingAttemptsBefore ? true : undefined, "pending failed send reaches actual API");
    await waitFor(() => document.querySelector(".chat-send-retry") ?? undefined, "pending failed send retry card");
    const pendingOperation = await waitFor(() => Object.values(geometryProfileLocalState("qa-profile-a")?.pendingSendOperations ?? {})
      .find((item: any) => item.expectedPublicKey === pendingRequestKey) as any, "pending operation is durably captured");
    const pendingDraft = "Pending in-flight draft must not survive deletion";
    geometryHoldNextLocalStateSave("qa-profile-a", pendingChatId, pendingDraft);
    setComposerDraft(pendingEditor, pendingDraft);
    const heldSave = await waitFor(() => { const held = geometryHeldLocalStateSave(); return held?.receivedAt !== null && held?.state?.drafts?.[pendingChatId] === pendingDraft ? held : undefined; }, "actual UI local-state save held before backend commit");
    const saveRace: Record<string, unknown> = { name: "pending-delete-inflight-save", friendNumber: pendingFriendNumber, operationId: pendingOperation.operationId, receivedAt: heldSave.receivedAt };
    cases.push(saveRace);
    check(heldSave.committedAt === null && heldSave.releasedAt === null, "actual UI save is held before backend commit");
    check(!!heldSave.state.pendingSendOperations?.[pendingOperation.operationId], "held UI snapshot includes pending peer operation metadata");
    const pendingDeletesBefore = geometryDeleteCalls.filter((call) => call.expectedPublicKey === pendingRequestKey).length;

    geometryDeferNextContactDeletion();
    document.querySelector<HTMLButtonElement>(".requests-button")!.click();
    const pendingRequestCard = await waitFor(() => [...document.querySelectorAll<HTMLElement>(".outgoing-request")]
      .find((card) => card.querySelector("code")?.textContent?.startsWith(pendingRequestKey)), "pending request card");
    pendingRequestCard.querySelector<HTMLButtonElement>(".cancel-request-button")!.click();
    await frames();
    saveRace.deleteCallsBeforeRelease = geometryDeleteCalls.filter((call) => call.expectedPublicKey === pendingRequestKey).length - pendingDeletesBefore;
    check(saveRace.deleteCallsBeforeRelease === 0 && geometryHeldLocalStateSave()?.committedAt === null, "pending delete Native RPC waits for the held UI save to commit");
    geometryReleaseLocalStateSave();
    await waitFor(() => geometryHeldLocalStateSave()?.committedAt !== null ? true : undefined, "held UI save commits before contact mutation");
    saveRace.releasedAt = geometryHeldLocalStateSave()?.releasedAt;
    saveRace.committedAt = geometryHeldLocalStateSave()?.committedAt;
    await waitFor(() => geometryDeleteCalls.some((call) => call.friendNumber === pendingFriendNumber && call.expectedPublicKey === pendingRequestKey) ? true : undefined, "pending friend backend deletion");
    await waitFor(() => !geometryProfileLocalState("qa-profile-a")?.outgoingFriendRequests?.some((request: any) => request.toxId.startsWith(pendingRequestKey)) ? true : undefined, "pending request durable cancellation");
    check(!geometryProfileLocalState("qa-profile-a")?.outgoingFriendRequests?.some((request: any) => request.toxId.startsWith(pendingRequestKey)), "cancelling pending peer request removes only its durable record");
    const attempts = geometryDeleteCalls.filter((call) => call.expectedPublicKey === pendingRequestKey).slice(pendingDeletesBefore);
    check(attempts.length === 2 && JSON.stringify(attempts[0]) === JSON.stringify(attempts[1]), "one cancellation retries storage contention with the same captured contact identity");
    cases.push({ name: "pending-request-cancel", friendNumber: pendingFriendNumber, removed: true });
    document.querySelector<HTMLButtonElement>(".chats-button")!.click();

    document.querySelector<HTMLButtonElement>(".contact-list-add")!.click();
    const readdInput = await waitFor(() => document.querySelector<HTMLInputElement>(".add-contact-card input") ?? undefined, "same-key readd form");
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(readdInput, `${pendingRequestKey}${"0".repeat(12)}`);
    readdInput.dispatchEvent(new Event("input", { bubbles: true }));
    document.querySelector<HTMLFormElement>(".add-contact-card")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await waitFor(() => document.querySelector<HTMLElement>(".add-contact-status")?.textContent?.includes("Контакт добавлен. Ожидает авторизации.") ? true : undefined, "same-key pending readd accepted");
    document.querySelector<HTMLButtonElement>(".add-contact-card .text-button")!.click();
    const readded = await waitFor(() => document.querySelector<HTMLButtonElement>(`[data-kaigen-ui-entity-key="${opaqueUiEntityKey("contact", pendingRequestKey)}"]`) ?? undefined, "same pending key reappears");
    readded.click(); await frames();
    await waitFor(() => geometryProfileLocalState("qa-profile-a")?.outgoingFriendRequests?.some((request: any) => request.toxId.startsWith(pendingRequestKey)) ? true : undefined, "same-key readd is durable");
    const afterReadd = geometryProfileLocalState("qa-profile-a");
    check(!afterReadd?.drafts?.[pendingChatId] && !(composer()?.value ?? ""), "same-key readd cannot restore the deleted pending draft in storage or composer");
    check(!afterReadd?.pendingSendOperations?.[pendingOperation.operationId]
      && !Object.values(afterReadd?.pendingSendOperations ?? {}).some((item: any) => item.expectedPublicKey === pendingRequestKey || item.chatId === pendingChatId), "same-key readd cannot restore old pending operation metadata");
    saveRace.readded = true;

    const attemptsAfterDelete = geometrySendAttempts.length;
    const replacementKey = "E".repeat(64);
    geometryReuseFriendSlot(0, replacementKey);
    await waitFor(() => contact("QA Replacement") ?? undefined, "reused numeric slot");
    contact("QA Replacement")!.click();
    await frames();
    await delay(450);
    check(!document.querySelector(".chat-send-retry") && geometrySendAttempts.length === attemptsAfterDelete, "numeric slot reuse does not retry deleted peer's operation");
    check(!geometryProfileLocalState("qa-profile-a")?.pendingSendOperations?.[operation.operationId], "old operation remains absent after slot reuse");
    cases.push({ name: "delete-readd", oldKey: originalKey, newKey: replacementKey, stalePoll });
    return { ok: true, assertions, cases };
  } catch (error) {
    return { ok: false, assertions, cases, error: error instanceof Error ? error.stack ?? error.message : String(error) };
  } finally {
    geometryReleaseLocalStateSave();
    geometryDelayFriendDiscovery(0);
  }
}
