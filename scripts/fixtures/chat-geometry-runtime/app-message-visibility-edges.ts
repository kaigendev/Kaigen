import {
  geometryAppendMessage,
  geometryAppendOutgoingText,
  geometryAcceptedSendResult,
  geometryDelayNextTailSnapshot,
  geometryDelayHistory,
  geometryFailNextTailSnapshot,
  geometryMessageId,
  geometryPrepareEmptyChat,
  geometrySnapshotCalls,
  geometrySnapshotEvidence,
  geometrySendAttempts,
} from "./app-platform";
import { composer, setComposerDraft } from "./composer-test-adapter";

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

    // A reader can stop just above the bottom. The cached range was a live
    // tail, but followLatest is now false; a new row must not become a spacer.
    const nearTailCases: Array<Record<string, unknown>> = [];
    for (const [spellcheck, mine] of [[false, false], [false, true], [true, false], [true, true]]) {
      if (spellcheck && !mine) {
        document.querySelector<HTMLButtonElement>(".rail-profile-button")!.click();
        const chatSettings = await waitFor(() => document.querySelector<HTMLButtonElement>(
          '.settings-tabs button[aria-label="Чаты"]') ?? undefined, "spellcheck chat settings");
        chatSettings.click();
        const switchFor = (name: string) => [...document.querySelectorAll<HTMLLabelElement>(".setting-switch")]
          .find((label) => label.querySelector("b")?.textContent === name)?.querySelector<HTMLInputElement>('input[type="checkbox"]');
        const enabled = await waitFor(() => switchFor("Проверять орфографию") ?? undefined, "spellcheck switch");
        if (!enabled.checked) enabled.click();
        await twoFrames();
        const russian = switchFor("Русский")!;
        if (russian.checked) russian.click();
        const english = switchFor("English")!;
        if (!english.checked) english.click();
        await twoFrames();
        check(enabled.checked && english.checked && !russian.checked, "enabled English worker configuration");
        document.querySelector<HTMLButtonElement>(".chats-button")!.click();
        await select("QA Dave");
      }
      await bottomByUi();
      await waitFor(() => geometrySnapshotEvidence(2)?.hasMoreAfter === false
        && geometrySnapshotEvidence(2)?.requestRange === null ? true : undefined, "near-tail live setup");
      await select("QA Carol");
      await select("QA Dave");
      await waitFor(() => geometrySnapshotEvidence(2)?.requestRange !== null
        && geometrySnapshotEvidence(2)?.hasMoreAfter === false ? true : undefined, "near-tail fixed setup");
      await twoFrames();
      const near = scroller()!;
      near.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -24 }));
      near.scrollTop = Math.max(0, near.scrollHeight - near.clientHeight - 24);
      near.dispatchEvent(new Event("scroll", { bubbles: true }));
      await twoFrames();
      const reader = visibleAnchor();
      let checkedDraftRanges = 0;
      if (spellcheck) {
        const editor = await waitFor(() => composer() ?? undefined, "busy spellcheck composer");
        setComposerDraft(editor, Array.from({ length: 300 }, () => "zzqxx").join(" "));
        checkedDraftRanges = await waitFor(() => {
          const highlights = (globalThis as unknown as { CSS?: { highlights?: Map<string, { size: number }> } }).CSS?.highlights;
          const count = highlights?.get("kaigen-spelling")?.size;
          return count && count >= 300 ? count : undefined;
        }, "real worker checked busy draft", 12_000);
        check(checkedDraftRanges >= 300, "real loaded worker returned misspellings rather than an error");
      }
      let appended: string;
      if (mine) {
        const editor = await waitFor(() => composer() ?? undefined, "near-tail actual composer");
        setComposerDraft(editor, "Near-tail outgoing card");
        const attemptsBefore = geometrySendAttempts.length;
        const send = await waitFor(() => {
          const button = document.querySelector<HTMLButtonElement>(".composer .send");
          return button && !button.disabled ? button : undefined;
        }, "near-tail enabled send");
        send.click();
        const attempt = await waitFor(() => geometrySendAttempts.length > attemptsBefore
          ? geometrySendAttempts.at(-1) : undefined, "near-tail accepted send attempt");
        appended = await waitFor(() => geometryAcceptedSendResult(attempt.operationId)?.messageId,
          "near-tail accepted outgoing identity");
      } else appended = geometryAppendMessage(2, "Near-tail incoming card");
      await waitFor(() => geometrySnapshotEvidence(2)?.latestMessageId === appended ? true : undefined,
        "near-tail new snapshot");
      await new Promise((resolve) => setTimeout(resolve, 1200));
      await twoFrames();
      const mountedWithoutScroll = !!row(appended);
      const readerAfter = anchorOffset(reader.id);
      const beforeScroll = geometrySnapshotEvidence(2);
      near.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 24 }));
      near.scrollTop = near.scrollHeight;
      near.dispatchEvent(new Event("scroll", { bubbles: true }));
      await waitFor(() => row(appended) ?? undefined, "near-tail manual-scroll recovery");
      nearTailCases.push({ spellcheck, checkedDraftRanges, mine, appended, mountedWithoutScroll, reader, readerAfter,
        beforeScroll, recoveredByScroll: !!row(appended) });
    }
    details.nearTail = nearTailCases;
    check(nearTailCases.every((item) => item.mountedWithoutScroll),
      `NEAR_TAIL_CARD_REPLACED_BY_SPACER ${JSON.stringify(nearTailCases)}`);
    check(nearTailCases.filter((item) => !item.mine).every((item) => item.readerAfter !== null
      && Math.abs(Number(item.readerAfter) - (item.reader as { offset: number }).offset) <= 4),
      "near-tail incoming row moved the reader's visible anchor");

    // Opening search while a ranged response is in flight must use the new
    // search intent, rather than the closed-search state captured by that poll.
    await bottomByUi();
    await select("QA Carol");
    await select("QA Dave");
    await waitFor(() => geometrySnapshotEvidence(2)?.requestRange !== null
      && geometrySnapshotEvidence(2)?.hasMoreAfter === false ? true : undefined, "search race fixed tail");
    const searchRaceScroll = scroller()!;
    searchRaceScroll.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -24 }));
    searchRaceScroll.scrollTop = Math.max(0, searchRaceScroll.scrollHeight - searchRaceScroll.clientHeight - 24);
    searchRaceScroll.dispatchEvent(new Event("scroll", { bubbles: true }));
    await twoFrames();
    await waitFor(() => geometrySnapshotCalls(2).every((call) => call.status !== "started") ? true : undefined,
      "search race previous poll settled");
    const searchRaceBaseline = geometrySnapshotCalls(2).at(-1)?.id ?? 0;
    geometryDelayHistory(650);
    const searchRaceId = geometryAppendMessage(2, "Search-open delayed ranged arrival");
    const searchRaceCall = await waitFor(() => geometrySnapshotCalls(2).find((call) => call.id > searchRaceBaseline
      && call.requestRange !== null && call.status === "started"), "search race delayed poll started");
    geometryDelayHistory(0);
    document.querySelector<HTMLButtonElement>('button[aria-label="Поиск"]')!.click();
    await waitFor(() => document.querySelector('input[aria-label="Поиск в чате"]') ?? undefined, "search opened during poll");
    const searchRaceAnchor = visibleAnchor();
    const searchRaceOpenedAt = performance.now();
    const searchRaceResolved = await waitFor(() => geometrySnapshotCalls(2).find((call) => call.id === searchRaceCall.id
      && call.status === "resolved"), "search race old poll resolved");
    await twoFrames();
    const searchRaceOffset = anchorOffset(searchRaceAnchor.id);
    const unintendedTail = geometrySnapshotCalls(2).filter((call) => call.id > searchRaceBaseline && call.requestRange === null);
    details.searchDuringRangedResponse = { id: searchRaceId, anchor: searchRaceAnchor, offset: searchRaceOffset,
      openedAt: searchRaceOpenedAt, oldResponse: searchRaceResolved, unintendedTail };
    check(searchRaceResolved.finishedAt! > searchRaceOpenedAt, "delayed range did not race search opening");
    check(unintendedTail.length === 0, "stale closed-search snapshot forced a live-tail request after search opened");
    check(searchRaceOffset !== null && Math.abs(searchRaceOffset - searchRaceAnchor.offset) <= 4,
      "search-open delayed range moved the reader anchor");
    document.querySelector<HTMLButtonElement>('button[aria-label="Закрыть поиск"]')!.click();

    return { ok: true, assertions, details };
  } catch (error) {
    return { ok: false, assertions, details,
      error: error instanceof Error ? error.stack ?? error.message : String(error) };
  }
}
