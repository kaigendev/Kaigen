import {
  geometryAppendMessage,
  geometryAppendOutgoingText,
  geometryAcceptedSendResult,
  geometryDelayNextTailSnapshot,
  geometryDelayHistory,
  geometryLimitNextTailSnapshot,
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
    document.querySelector<HTMLButtonElement>('.conversation-header .header-actions button[aria-label="Поиск"]')?.click();
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

    const beforeConditionalFailure = geometrySnapshotCalls(2).at(-1)?.id ?? 0;
    const historyRetryVisible = () => [...document.querySelectorAll<HTMLButtonElement>(".history-action")]
      .some((button) => /не удалось загрузить историю|history could not load/i.test(button.textContent ?? ""));
    geometryFailNextTailSnapshot(2);
    const conditionalFailure = await waitFor(() => geometrySnapshotCalls(2).find((call) =>
      call.id > beforeConditionalFailure && call.status === "failed" && call.requestKnownRevision === recovered.revision),
    "failed poll with the known live revision");
    await waitFor(() => historyRetryVisible() ? true : undefined, "history retry after the failed poll");
    const conditionalRecovery = await waitFor(() => {
      const snapshot = geometrySnapshotEvidence(2);
      const poll = geometrySnapshotCalls(2).find((call) => call.id > conditionalFailure.id && call.status === "resolved"
        && call.requestKnownRevision === recovered.revision && call.revision === recovered.revision);
      return poll && snapshot?.returnedMessages === false && snapshot.latestMessageId === retryId ? poll : undefined;
    }, "successful unchanged snapshot after the failed poll", 5500);
    await twoFrames();
    details.conditionalRecovery = { failed: conditionalFailure, recovered: conditionalRecovery };
    check(!historyRetryVisible(), "an unchanged successful snapshot leaves the history retry visible");
    check(row(retryId)?.textContent?.includes("Tail retry same identity"), "an unchanged successful snapshot drops the cached card");

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

    // Arrival after the cached chat is visibly reopened, but before its first
    // delayed range response, must not leave a reserved history spacer forever.
    const restoreRaces: Array<Record<string, unknown>> = [];
    details.restoreRace = restoreRaces;
    for (const [manualDistance, mine] of [[0, false], [0, true], [24, false], [24, true]] as const) {
      await bottomByUi();
      const previousTail = await waitFor(() => {
        const snapshot = geometrySnapshotEvidence(2);
        const container = scroller()!;
        return snapshot?.hasMoreAfter === false && snapshot.latestMessageId
          && snapshot.lastMessageId === snapshot.latestMessageId && row(snapshot.latestMessageId)
          && Math.abs(container.scrollHeight - container.scrollTop - container.clientHeight) <= 1
          ? snapshot.latestMessageId : undefined;
      }, "restore-race original live tail");
      if (manualDistance) {
        const container = scroller()!;
        container.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -manualDistance }));
        container.scrollTop -= manualDistance;
        container.dispatchEvent(new Event("scroll", { bubbles: true }));
        await twoFrames();
      }
      const savedReader = visibleAnchor();
      await select("QA Carol");
      const restoreBaseline = geometrySnapshotCalls(2).at(-1)?.id ?? 0;
      geometryDelayHistory(650);
      await select("QA Dave");
      const restoringCall = await waitFor(() => geometrySnapshotCalls(2).find((call) => call.id > restoreBaseline
        && call.requestRange !== null && call.status === "started"), "restore-race range started");
      geometryDelayHistory(0);
      check(!!row(previousTail), "restore-race cached tail mounted before open-chat arrival");
      const restoreAppendAt = performance.now();
      let restoreArrival: string;
      if (mine) {
        const editor = await waitFor(() => composer() ?? undefined, "restore-race actual composer");
        setComposerDraft(editor, "Outgoing while cached restoration is in flight");
        const attemptsBefore = geometrySendAttempts.length;
        const send = await waitFor(() => {
          const button = document.querySelector<HTMLButtonElement>(".composer .send");
          return button && !button.disabled ? button : undefined;
        }, "restore-race enabled send");
        send.click();
        const attempt = await waitFor(() => geometrySendAttempts.length > attemptsBefore
          ? geometrySendAttempts.at(-1) : undefined, "restore-race accepted send attempt");
        restoreArrival = await waitFor(() => geometryAcceptedSendResult(attempt.operationId)?.messageId,
          "restore-race accepted outgoing identity");
      } else restoreArrival = geometryAppendMessage(2, "Incoming after cached chat became visible");
      await waitFor(() => geometrySnapshotCalls(2).some((call) => call.id === restoringCall.id
        && call.status === "resolved" && call.latestMessageId === restoreArrival) ? true : undefined,
        "restore-race response advertises open-chat arrival");
      await new Promise((resolve) => setTimeout(resolve, 1300));
      await twoFrames();
      const card = row(restoreArrival);
      const bounds = card?.getBoundingClientRect();
      const viewport = scroller()!.getBoundingClientRect();
      const fullyVisible = !!bounds && bounds.height > 0 && bounds.top >= viewport.top - 1
        && bounds.bottom <= viewport.bottom + 1;
      const readerAfter = anchorOffset(savedReader.id);
      restoreRaces.push({ id: restoreArrival, mine, manualDistance, appendAt: restoreAppendAt, restoringCall,
        savedReader, readerAfter, snapshot: geometrySnapshotEvidence(2), mountedWithoutScroll: !!card,
        fullyVisible, card: bounds ? { top: bounds.top, bottom: bounds.bottom, height: bounds.height } : null,
        viewport: { top: viewport.top, bottom: viewport.bottom },
        calls: geometrySnapshotCalls(2).filter((call) => call.id > restoreBaseline) });
      check(!!card, "RESTORE_RACE_CARD_REPLACED_BY_SPACER");
      if (mine) check(fullyVisible, "restore-race accepted outgoing card is not fully visible");
      else check(readerAfter !== null && Math.abs(readerAfter - savedReader.offset) <= 4,
        "restore-race incoming hydration moved the saved reader anchor");
    }

    // The backend can return fewer rows than requested because of its byte
    // budget. Reject a truncated live tail which drops the restored reader.
    await bottomByUi();
    await waitFor(() => {
      const snapshot = geometrySnapshotEvidence(2);
      return snapshot?.hasMoreAfter === false && snapshot.latestMessageId && row(snapshot.latestMessageId)
        ? true : undefined;
    }, "byte-budget live tail");
    const budgetContainer = scroller()!;
    budgetContainer.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -24 }));
    budgetContainer.scrollTop -= 24;
    budgetContainer.dispatchEvent(new Event("scroll", { bubbles: true }));
    await twoFrames();
    const budgetReader = visibleAnchor();
    await select("QA Carol");
    const budgetBaseline = geometrySnapshotCalls(2).at(-1)?.id ?? 0;
    geometryDelayHistory(650);
    await select("QA Dave");
    await waitFor(() => geometrySnapshotCalls(2).some((call) => call.id > budgetBaseline
      && call.requestRange !== null && call.status === "started") ? true : undefined,
      "byte-budget restored range started");
    geometryDelayHistory(0);
    geometryLimitNextTailSnapshot(2, 2);
    const budgetArrival = geometryAppendMessage(2, "Byte-budget restored tail arrival");
    const budgetTarget = await waitFor(() => geometrySnapshotCalls(2).find((call) => call.id > budgetBaseline
      && call.requestTarget === budgetReader.id && call.status === "resolved"),
      "byte-budget anchor fallback resolved");
    await twoFrames();
    const budgetReaderAfter = anchorOffset(budgetReader.id);
    details.byteBudget = { reader: budgetReader, readerAfter: budgetReaderAfter, arrival: budgetArrival,
      target: budgetTarget, snapshot: geometrySnapshotEvidence(2),
      calls: geometrySnapshotCalls(2).filter((call) => call.id > budgetBaseline) };
    check(budgetReaderAfter !== null && Math.abs(budgetReaderAfter - budgetReader.offset) <= 4,
      "byte-budget fallback moved the restored reader anchor");
    check(!!row(budgetArrival), "byte-budget fallback lost nearby incoming card");
    await new Promise((resolve) => setTimeout(resolve, 1100));
    check(geometrySnapshotCalls(2).filter((call) => call.id > budgetBaseline
      && call.requestTarget === budgetReader.id).length <= 2,
      "byte-budget fallback kept resetting the target request");

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
        const setSpellcheckSwitch = async (name: string, checked: boolean) => {
          const input = await waitFor(() => {
            const control = switchFor(name);
            return control && !control.disabled ? control : undefined;
          }, `available ${name} spellcheck switch`);
          if (input.checked !== checked) input.click();
          await waitFor(() => {
            const control = switchFor(name);
            return control && !control.disabled && control.checked === checked ? true : undefined;
          }, `saved ${name} spellcheck switch`);
        };
        await setSpellcheckSwitch("Проверять орфографию", true);
        await setSpellcheckSwitch("English", true);
        await setSpellcheckSwitch("Русский", false);
        check(switchFor("Проверять орфографию")?.checked && switchFor("English")?.checked
          && !switchFor("Русский")?.checked, "enabled English worker configuration");
        document.querySelector<HTMLButtonElement>(".chats-button")!.click();
        await select("QA Dave");
      }
      details.nearTailSetup = { spellcheck, mine, snapshot: geometrySnapshotEvidence(2),
        jumpButton: document.querySelector(".jump-latest")?.textContent ?? null };
      await bottomByUi();
      // A cached tail uses a ranged request too. Require the rendered live end,
      // rather than a particular transport mode in the last backend response.
      const liveSetup = await waitFor(() => {
        const snapshot = geometrySnapshotEvidence(2);
        const container = scroller();
        const distance = container ? container.scrollHeight - container.scrollTop - container.clientHeight : null;
        return snapshot?.hasMoreAfter === false && snapshot.latestMessageId
          && snapshot.lastMessageId === snapshot.latestMessageId && row(snapshot.latestMessageId)
          && distance !== null && Math.abs(distance) <= 1 ? { snapshot, distance } : undefined;
      }, "near-tail live setup");
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
      nearTailCases.push({ spellcheck, checkedDraftRanges, mine, liveSetup, appended, mountedWithoutScroll, reader, readerAfter,
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
    document.querySelector<HTMLButtonElement>('.conversation-header .header-actions button[aria-label="Поиск"]')!.click();
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

    // A native scroll notification can be missed while a loaded tail remains
    // virtualized. A settled snapshot must reveal the reader's actual viewport.
    geometryPrepareEmptyChat(3);
    for (let index = 0; index < 160; index += 1) geometryAppendMessage(3, `Loaded spacer recovery ${index}`);
    await select("QA Erin");
    await waitFor(() => {
      const snapshot = geometrySnapshotEvidence(3);
      return snapshot?.total === 160 && !snapshot.hasMoreBefore && !snapshot.hasMoreAfter ? true : undefined;
    }, "fully loaded spacer-recovery history");
    await bottomByUi();
    const gapScroll = scroller()!;
    gapScroll.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -24 }));
    gapScroll.scrollTop = Math.max(0, gapScroll.scrollHeight - gapScroll.clientHeight - 24);
    gapScroll.dispatchEvent(new Event("scroll", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await twoFrames();
    let suppressedNativeScrolls = 0;
    const suppressNativeScroll = (event: Event) => {
      if (event.target === gapScroll && event.isTrusted) {
        suppressedNativeScrolls += 1;
        event.stopImmediatePropagation();
      }
    };
    document.addEventListener("scroll", suppressNativeScroll, true);
    try {
      gapScroll.scrollTop = 0;
      await twoFrames();
    } finally {
      document.removeEventListener("scroll", suppressNativeScroll, true);
    }
    const gapViewport = gapScroll.getBoundingClientRect();
    const gapRows = [...gapScroll.querySelectorAll<HTMLElement>("[data-message-key]")];
    const leadingSpace = gapScroll.querySelector<HTMLElement>(".history-space");
    details.loadedSpacerBefore = { suppressedNativeScrolls, scrollTop: gapScroll.scrollTop,
      leadingSpace: leadingSpace?.getBoundingClientRect().height ?? 0, mountedRows: gapRows.length,
      firstRowOffset: gapRows[0]?.getBoundingClientRect().top - gapViewport.top,
      snapshot: geometrySnapshotEvidence(3) };
    check(suppressedNativeScrolls > 0, "native scroll notification was not suppressed");
    check(!!leadingSpace && leadingSpace.getBoundingClientRect().height > gapScroll.clientHeight
      && gapRows.length > 0 && gapRows.every((element) => element.getBoundingClientRect().top >= gapViewport.bottom),
    "spacer-recovery setup did not leave the whole viewport in leading padding");
    const settledOutgoing = geometryAppendOutgoingText(3, "Settled outgoing spacer recovery", "delivered");
    await waitFor(() => geometrySnapshotEvidence(3)?.latestMessageId === settledOutgoing ? true : undefined,
      "settled spacer-recovery snapshot");
    const recoveredFirst = await waitFor(() => {
      const element = row(geometryMessageId(3, 0));
      const bounds = element?.getBoundingClientRect();
      const viewport = gapScroll.getBoundingClientRect();
      return bounds && bounds.bottom > viewport.top && bounds.top < viewport.bottom ? element : undefined;
    }, "first loaded row overlaps recovered viewport");
    await twoFrames();
    details.loadedSpacerAfter = { scrollTop: gapScroll.scrollTop,
      firstRowOffset: recoveredFirst.getBoundingClientRect().top - gapScroll.getBoundingClientRect().top,
      snapshot: geometrySnapshotEvidence(3) };
    check(gapScroll.scrollTop <= 1, "spacer recovery forced the reader to another scroll position");
    check(recoveredFirst.getBoundingClientRect().bottom > gapScroll.getBoundingClientRect().top
      && recoveredFirst.getBoundingClientRect().top < gapScroll.getBoundingClientRect().bottom,
    "recovered loaded row vanished from the unchanged viewport");

    return { ok: true, assertions, details };
  } catch (error) {
    const container = scroller();
    details.failureState = { snapshot: geometrySnapshotEvidence(2), calls: geometrySnapshotCalls(2).slice(-16),
      scroll: container ? { top: container.scrollTop, height: container.scrollHeight, viewport: container.clientHeight } : null,
      jumpButton: document.querySelector(".jump-latest")?.textContent ?? null };
    return { ok: false, assertions, details,
      error: error instanceof Error ? error.stack ?? error.message : String(error) };
  }
}
