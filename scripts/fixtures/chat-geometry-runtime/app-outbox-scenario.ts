import {
  geometryAppendOutgoingText, geometryCancellationCalls, geometryDelayFriendDiscovery,
  geometryDeleteCalls, geometryEmitFriendStatus, geometryFailNextCancellation,
  geometryFailNextSend, geometryFriendDiscoveryPending, geometryFriendKey,
  geometryPendingRequestFriendNumber, geometryPendingRequestKey,
  geometryProfileLocalState, geometryReuseFriendSlot, geometrySendAttempts,
} from "./app-platform";
import { composer, setComposerDraft } from "./composer-test-adapter";

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
    await waitFor(() => document.querySelector<HTMLElement>(".add-contact-status")?.textContent?.includes("Запрос авторизации отправлен") ? true : undefined, "outgoing request accepted");
    document.querySelector<HTMLButtonElement>(".add-contact-card .text-button")!.click();
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

    document.querySelector<HTMLButtonElement>(".requests-button")!.click();
    const pendingRequestCard = await waitFor(() => [...document.querySelectorAll<HTMLElement>(".outgoing-request")]
      .find((card) => card.querySelector("code")?.textContent?.startsWith(pendingRequestKey)), "pending request card");
    pendingRequestCard.querySelector<HTMLButtonElement>(".cancel-request-button")!.click();
    const pendingFriendNumber = geometryPendingRequestFriendNumber();
    await waitFor(() => geometryDeleteCalls.some((call) => call.friendNumber === pendingFriendNumber && call.expectedPublicKey === pendingRequestKey) ? true : undefined, "pending friend backend deletion");
    await waitFor(() => !geometryProfileLocalState("qa-profile-a")?.outgoingFriendRequests?.some((request: any) => request.toxId.startsWith(pendingRequestKey)) ? true : undefined, "pending request durable cancellation");
    check(!geometryProfileLocalState("qa-profile-a")?.outgoingFriendRequests?.some((request: any) => request.toxId.startsWith(pendingRequestKey)), "cancelling pending peer request removes only its durable record");
    cases.push({ name: "pending-request-cancel", friendNumber: pendingFriendNumber, removed: true });
    document.querySelector<HTMLButtonElement>(".chats-button")!.click();

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
    geometryDelayFriendDiscovery(0);
  }
}
