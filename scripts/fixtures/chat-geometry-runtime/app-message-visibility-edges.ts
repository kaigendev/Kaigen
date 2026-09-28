import {
  geometryAppendMessage,
  geometryAppendOutgoingText,
  geometryDelayNextTailSnapshot,
  geometryDelayHistory,
  geometryFailNextTailSnapshot,
  geometryMessageId,
  geometryPrepareEmptyChat,
  geometrySnapshotCalls,
  geometrySnapshotEvidence,
} from "./app-platform";

type Result = { ok: boolean; assertions: number; details: Record<string, unknown>; error?: string };
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const twoFrames = async () => { await frame(); await frame(); };

async function waitFor<T>(read: () => T | undefined, label: string, timeoutMs = 4500): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(`${label} timed out`);
}

const scroller = () => document.querySelector<HTMLElement>(".message-scroll");
const row = (id: string) => document.querySelector<HTMLElement>(`.message-scroll [data-message-key="${id}"]`);
const contact = (name: string) => [...document.querySelectorAll<HTMLButtonElement>(".chat-item")]
  .find((button) => button.textContent?.includes(name));

async function select(name: string) {
  const button = await waitFor(() => contact(name), `${name} contact`);
  button.click();
  await waitFor(() => document.querySelector(".conversation-header")?.textContent?.includes(name) ? true : undefined,
    `${name} active chat`);
  await waitFor(() => scroller() ?? undefined, `${name} scroller`);
}

function visibleAnchor() {
  const container = scroller();
  if (!container) throw new Error("message scroller absent");
  const viewport = container.getBoundingClientRect();
  const element = [...container.querySelectorAll<HTMLElement>("[data-message-key]")].find((candidate) => {
    const box = candidate.getBoundingClientRect();
    return box.bottom > viewport.top && box.top < viewport.bottom;
  });
  if (!element?.dataset.messageKey) throw new Error("visible message anchor absent");
  return { id: element.dataset.messageKey, offset: element.getBoundingClientRect().top - viewport.top };
}

function anchorOffset(id: string) {
  const element = row(id);
  const container = scroller();
  return element && container ? element.getBoundingClientRect().top - container.getBoundingClientRect().top : null;
}

async function bottomByUi() {
  const button = document.querySelector<HTMLButtonElement>(".jump-latest");
  if (button) button.click();
  else {
    const container = scroller();
    if (!container) throw new Error("message scroller absent");
    container.scrollTop = container.scrollHeight;
    container.dispatchEvent(new Event("scroll", { bubbles: true }));
  }
  await twoFrames();
}

export async function runMessageVisibilityEdges(): Promise<Result> {
  const details: Record<string, unknown> = {};
  let assertions = 0;
  const check = (condition: unknown, label: string) => { assertions += 1; if (!condition) throw new Error(label); };
  try {
    await waitFor(() => document.querySelector<HTMLElement>(".app-shell") ?? undefined, "actual App");

    // Synthetic empty chat: first outgoing row has no previous message key.
    geometryPrepareEmptyChat(3);
    await select("QA Erin");
    await waitFor(() => geometrySnapshotEvidence(3)?.total === 0 ? true : undefined, "empty chat snapshot");
    check(scroller()!.querySelectorAll("[data-message-key]").length === 0, "empty fixture has a message row");
    const firstOutgoing = geometryAppendOutgoingText(3, "Visibility first outgoing", "delivered");
    await waitFor(() => row(firstOutgoing) ?? undefined, "first outgoing card");
    await twoFrames();
    check(row(firstOutgoing)?.textContent?.includes("Visibility first outgoing"), "first outgoing text missing");
    details.empty = { id: firstOutgoing, snapshot: geometrySnapshotEvidence(3) };

    // Closing an old, bounded chat while >500 messages arrive must keep its
    // saved visible row in the same viewport position when it reopens.
    await select("QA Dave");
    const originalTail = geometryMessageId(2, 7);
    await waitFor(() => row(originalTail) ?? undefined, "Dave original tail");
    await bottomByUi();
    const savedAnchor = visibleAnchor();
    await select("QA Carol");
    let whileClosed = "";
    for (let index = 0; index < 520; index += 1) whileClosed = geometryAppendMessage(2, `While closed ${index}`);
    await select("QA Dave");
    await waitFor(() => geometrySnapshotEvidence(2)?.latestMessageId === whileClosed
      && geometrySnapshotEvidence(2)?.requestRange !== null ? true : undefined, "closed-chat fixed snapshot");
    await twoFrames();
    const restoredOffset = anchorOffset(savedAnchor.id);
    check(restoredOffset !== null && Math.abs(restoredOffset - savedAnchor.offset) <= 4,
      "closed-chat visible anchor moved after >500 arrivals");
    check(geometrySnapshotEvidence(2)?.hasMoreAfter, "closed-chat old position lost its history tail gap");
    details.closed = { savedAnchor, restoredOffset, snapshot: geometrySnapshotEvidence(2) };

    // Manual history stays with the reader even as more live rows arrive.
    const manual = scroller()!;
    manual.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -1 }));
    manual.scrollTop = Math.max(0, manual.scrollTop - Math.max(80, manual.clientHeight / 2));
    manual.dispatchEvent(new Event("scroll", { bubbles: true }));
    await twoFrames();
    const manualAnchor = visibleAnchor();
    const manualArrival = geometryAppendMessage(2, "Manual history owner arrival");
    await waitFor(() => geometrySnapshotEvidence(2)?.latestMessageId === manualArrival ? true : undefined,
      "manual history snapshot");
    await twoFrames();
    const manualOffset = anchorOffset(manualAnchor.id);
    check(manualOffset !== null && Math.abs(manualOffset - manualAnchor.offset) <= 4,
      "manual history owner anchor moved");
    details.manual = { anchor: manualAnchor, offset: manualOffset, snapshot: geometrySnapshotEvidence(2) };

    // A selected search result is another explicit owner position.
    await select("QA Carol");
    await waitFor(() => row(geometryMessageId(1, 50)) ?? undefined, "Carol original tail");
    document.querySelector<HTMLButtonElement>('button[aria-label="Поиск"]')?.click();
    const search = await waitFor(() => document.querySelector<HTMLInputElement>('input[aria-label="Поиск в чате"]') ?? undefined,
      "chat search input");
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "Carol synthetic message 000005");
    search.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "Carol synthetic message 000005" }));
    const searchRowId = geometryMessageId(1, 5);
    await waitFor(() => row(searchRowId)?.querySelector(".message-search-hit.current") ? true : undefined,
      "selected search result");
    await twoFrames();
    const searchAnchor = { id: searchRowId, offset: anchorOffset(searchRowId) };
    check(searchAnchor.offset !== null, "search owner anchor absent");
    const searchArrival = geometryAppendMessage(1, "Search owner arrival");
    await waitFor(() => geometrySnapshotEvidence(1)?.latestMessageId === searchArrival ? true : undefined,
      "search owner snapshot");
    await twoFrames();
    const searchOffset = anchorOffset(searchRowId);
    check(searchOffset !== null && Math.abs(searchOffset - searchAnchor.offset!) <= 4,
      "search result anchor moved after arrival");
    details.search = { anchor: searchAnchor, offset: searchOffset };
    document.querySelector<HTMLButtonElement>('button[aria-label="Закрыть поиск"]')?.click();

    // A late response for an old chat must not replace current-chat rows.
    await select("QA Erin");
    await waitFor(() => row(firstOutgoing) ?? undefined, "Erin loaded before delayed poll");
    await waitFor(() => geometrySnapshotCalls(3).every((call) => call.status !== "started") ? true : undefined,
      "Erin previous snapshots settled");
    const oldCallId = geometrySnapshotCalls(3).at(-1)?.id ?? 0;
    geometryDelayHistory(650);
    const delayedOld = await waitFor(() => geometrySnapshotCalls(3).find((call) => call.id > oldCallId
      && call.requestRange !== null && call.status === "started"), "delayed fixed old-chat request started", 2500);
    geometryDelayHistory(0);
    await select("QA Carol");
    const currentRow = await waitFor(() => [...(scroller()?.querySelectorAll<HTMLElement>("[data-message-key]") ?? [])]
      .find((candidate) => {
        const id = Number.parseInt(candidate.dataset.messageKey ?? "", 16);
        return id >= 2_000_000 && id < 3_000_000;
      }), "current-chat row after switch");
    const currentRowId = currentRow.dataset.messageKey!;
    const destinationMountedAt = performance.now();
    const oldResolved = await waitFor(() => geometrySnapshotCalls(3).find((call) => call.id === delayedOld.id
      && call.status === "resolved"), "exact delayed old-chat response resolved");
    await twoFrames();
    check(oldResolved.finishedAt !== null && oldResolved.finishedAt > destinationMountedAt
      && oldResolved.finishedAt - oldResolved.startedAt >= 600, "old-chat response did not race the new owner");
    check(document.querySelector(".conversation-header")?.textContent?.includes("QA Carol"),
      "late old-chat response changed owner header");
    check(!!row(currentRowId) && !row(firstOutgoing), "late old-chat response replaced current rows");
    details.stale = { oldCallId, currentRowId, destinationMountedAt, delayedOld: oldResolved };

    // A transient failure of the forced tail retry must recover on the next
    // poll without a second append or a new revision.
    await select("QA Dave");
    await bottomByUi();
    await waitFor(() => geometrySnapshotEvidence(2)?.requestRange === null
      && geometrySnapshotEvidence(2)?.lastMessageId === manualArrival ? true : undefined,
      "Dave live tail before retry");
    await waitFor(() => row(manualArrival) ?? undefined, "Dave live tail applied before cache leave");
    await twoFrames();
    const beforeRevisitCallId = geometrySnapshotCalls(2).at(-1)?.id ?? 0;
    await select("QA Carol");
    await select("QA Dave");
    const cachedRetrySetup = await waitFor(() => geometrySnapshotCalls(2).find((call) => call.id > beforeRevisitCallId
      && call.requestRange !== null && call.lastMessageId === manualArrival && call.status === "resolved"),
      "Dave cached fixed range before retry");
    await waitFor(() => row(manualArrival) ?? undefined, "Dave cached tail applied before retry");
    details.retrySetup = cachedRetrySetup;
    const retryCallId = geometrySnapshotCalls(2).at(-1)?.id ?? 0;
    geometryFailNextTailSnapshot(2);
    const retryId = geometryAppendMessage(2, "Tail retry same identity");
    const fixed = await waitFor(() => geometrySnapshotCalls(2).find((call) => call.id > retryCallId
      && call.requestRange !== null && call.latestMessageId === retryId && call.status === "resolved"),
      "fixed snapshot sees retry message");
    const failed = await waitFor(() => geometrySnapshotCalls(2).find((call) => call.id > fixed.id
      && call.requestRange === null && call.status === "failed"), "forced tail retry failed");
    const recovered = await waitFor(() => geometrySnapshotCalls(2).find((call) => call.id > failed.id
      && call.requestRange === null && call.status === "resolved" && call.latestMessageId === retryId),
      "tail retry recovered", 5500);
    await waitFor(() => row(retryId) ?? undefined, "same-ID retry card");
    await twoFrames();
    check(recovered.revision === fixed.revision, "tail retry required a new history revision");
    check(row(retryId)?.textContent?.includes("Tail retry same identity"), "tail retry card text missing");
    details.retry = { id: retryId, fixed, failed, recovered };

    // The tail response can arrive after a large burst and after the reader
    // manually moves into still-visible older rows. Keep that owner anchor.
    await select("QA Carol");
    await select("QA Dave");
    await waitFor(() => geometrySnapshotEvidence(2)?.requestRange !== null
      && geometrySnapshotEvidence(2)?.lastMessageId === retryId ? true : undefined,
      "Dave cached range before delayed burst");
    const burstBaseline = geometrySnapshotCalls(2).at(-1)?.id ?? 0;
    geometryDelayNextTailSnapshot(2, 650);
    let burstLastId = "";
    for (let index = 0; index < 120; index += 1) burstLastId = geometryAppendMessage(2, `Delayed burst ${index}`);
    const burstFixed = await waitFor(() => geometrySnapshotCalls(2).find((call) => call.id > burstBaseline
      && call.requestRange !== null && call.latestMessageId === burstLastId && call.status === "resolved"),
      "delayed burst fixed snapshot");
    const delayedTail = await waitFor(() => geometrySnapshotCalls(2).find((call) => call.id > burstFixed.id
      && call.requestRange === null && call.status === "started"), "delayed burst tail request started");
    const burstScroll = scroller()!;
    burstScroll.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -1 }));
    burstScroll.scrollTop = Math.max(0, burstScroll.scrollTop - Math.max(120, burstScroll.clientHeight));
    burstScroll.dispatchEvent(new Event("scroll", { bubbles: true }));
    await twoFrames();
    const burstAnchor = visibleAnchor();
    const manuallyPositionedAt = performance.now();
    const burstResolved = await waitFor(() => geometrySnapshotCalls(2).find((call) => call.id === delayedTail.id
      && call.status === "resolved" && call.latestMessageId === burstLastId), "delayed burst tail resolved");
    await twoFrames();
    const burstOffset = anchorOffset(burstAnchor.id);
    check(burstResolved.finishedAt !== null && burstResolved.finishedAt > manuallyPositionedAt
      && burstResolved.finishedAt - burstResolved.startedAt >= 600, "tail response did not race manual reading");
    check(burstOffset !== null && Math.abs(burstOffset - burstAnchor.offset) <= 4,
      "delayed burst moved manual owner anchor");
    check(Number.parseInt(burstAnchor.id, 16) < Number.parseInt(burstLastId, 16),
      "manual anchor was not an older message");
    details.burst = { firstOldId: burstAnchor.id, oldOffset: burstAnchor.offset, newOffset: burstOffset,
      lastId: burstLastId, fixed: burstFixed, tail: burstResolved };

    return { ok: true, assertions, details };
  } catch (error) {
    return { ok: false, assertions, details,
      error: error instanceof Error ? error.stack ?? error.message : String(error) };
  }
}
