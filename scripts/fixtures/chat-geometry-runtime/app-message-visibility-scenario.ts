import { geometryAcceptedSendResult, geometryAppendMessage, geometryMessageId, geometryPrepareEmptyChat, geometrySendAttempts,
  geometrySnapshotEvidence } from "./app-platform";
import { composer, setComposerDraft } from "./composer-test-adapter";

type Observation = { case: string; id: string; appendAt: number; snapshotAt: number | null; frameAt: number;
  firstDomAt: number | null; firstVisibleAt: number | null; snapshot: ReturnType<typeof geometrySnapshotEvidence>;
  row: null | { top: number; bottom: number; height: number; visible: boolean }; scroll: { top: number; height: number; scrollHeight: number } };
type Result = { ok: boolean; assertions: number; observations: Observation[]; details: Record<string, unknown>; error?: string };
declare global {
  var __KAIGEN_MESSAGE_VISIBILITY_RESULT__: Result | undefined;
  var __KAIGEN_MESSAGE_VISIBILITY_STAGE__: { id: number; name: string; done?: boolean } | undefined;
}

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const twoFrames = async () => { await frame(); await frame(); };
async function waitFor<T>(read: () => T | undefined, label: string, milliseconds = 3000): Promise<T> {
  const end = performance.now() + milliseconds;
  while (performance.now() < end) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`${label} timed out`);
}
const contact = (name: string) => [...document.querySelectorAll<HTMLButtonElement>(".chat-item")]
  .find((button) => button.textContent?.includes(name));
const row = (id: string) => document.querySelector<HTMLElement>(`.message-scroll [data-message-key="${id}"]`);
const scroller = () => document.querySelector<HTMLElement>(".message-scroll");
const snapshot = (friend: number) => geometrySnapshotEvidence(friend);
type IncomingTailSnapshot = Pick<NonNullable<ReturnType<typeof snapshot>>,
  "returnedMessages" | "hasMoreAfter" | "latestMessageId" | "lastMessageId">;
function containsIncomingTail(evidence: IncomingTailSnapshot | null, id: string) {
  // A fixed-range reply can advertise a newer latest ID without containing it.
  // Only the complete tail response can start the subsequent DOM latency budget.
  return evidence?.returnedMessages === true && evidence.hasMoreAfter === false
    && evidence.latestMessageId === id && evidence.lastMessageId === id;
}
async function select(name: string, friend: number, id: string | null) {
  const button = await waitFor(() => contact(name), `${name} contact`);
  button.click();
  await waitFor(() => document.querySelector(".conversation-header")?.textContent?.includes(name) ? true : undefined,
    `${name} active conversation header`);
  await waitFor(() => snapshot(friend)?.latestMessageId === id && scroller() ? true : undefined, `${name} snapshot`);
}
async function stage(name: string) {
  const value: { id: number; name: string; done?: boolean } = {
    id: (globalThis.__KAIGEN_MESSAGE_VISIBILITY_STAGE__?.id ?? 0) + 1, name,
  };
  globalThis.__KAIGEN_MESSAGE_VISIBILITY_STAGE__ = value;
  // A CDP observer captures this exact state. A standalone run remains usable.
  const end = performance.now() + 2500;
  while (!value.done && performance.now() < end) await new Promise((resolve) => setTimeout(resolve, 10));
}
async function observe(label: string, friend: number, id: string, appendAt: number): Promise<Observation> {
  let firstDomAt: number | null = null;
  const scan = () => { if (firstDomAt === null && row(id)) firstDomAt = performance.now(); };
  let snapshotAt: number | null = null;
  while (performance.now() - appendAt < 1800) {
    scan();
    const evidence = snapshot(friend);
    if (containsIncomingTail(evidence, id)) { snapshotAt = performance.now(); break; }
    await frame();
  }
  await twoFrames();
  scan();
  const scroll = scroller();
  if (!scroll) throw new Error(`${label}: scroller absent`);
  const readVisible = () => {
    scan();
    const bounds = row(id)?.getBoundingClientRect();
    const area = scroll.getBoundingClientRect();
    return bounds && bounds.height > 0 && bounds.top >= area.top - 1 && bounds.bottom <= area.bottom + 1 ? bounds : null;
  };
  // The snapshot boundary can precede React commit; sample visible geometry per
  // RAF, then capture pixels at the stage boundary. Never wait multiple seconds.
  const paintDeadline = Math.min(appendAt + 1500, (snapshotAt ?? performance.now()) + 350);
  let bounds = readVisible();
  while (!bounds && performance.now() < paintDeadline) { await frame(); bounds = readVisible(); }
  const firstVisibleAt = bounds ? performance.now() : null;
  return { case: label, id, appendAt, snapshotAt, frameAt: performance.now(), firstDomAt, firstVisibleAt,
    snapshot: snapshot(friend), row: bounds ? { top: bounds.top, bottom: bounds.bottom, height: bounds.height,
      visible: true } : null,
    scroll: { top: scroll.scrollTop, height: scroll.clientHeight, scrollHeight: scroll.scrollHeight } };
}

export async function runActualAppMessageVisibilityScenario(): Promise<Result> {
  const observations: Observation[] = [];
  const details: Record<string, unknown> = {};
  let assertions = 0;
  const check = (value: unknown, label: string) => { assertions += 1; if (!value) throw new Error(label); };
  try {
    const eligibleTail = { returnedMessages: true, hasMoreAfter: false, latestMessageId: "new", lastMessageId: "new" };
    check(containsIncomingTail(eligibleTail, "new"), "complete incoming tail starts DOM measurement");
    check(!containsIncomingTail({ ...eligibleTail, hasMoreAfter: true, lastMessageId: "old" }, "new"),
      "partial fixed-range reply must not start DOM measurement");
    check(!containsIncomingTail({ ...eligibleTail, lastMessageId: "old" }, "new"),
      "wrong tail must not start DOM measurement");
    check(!containsIncomingTail({ ...eligibleTail, returnedMessages: false }, "new"),
      "metadata-only reply must not start DOM measurement");
    check(!containsIncomingTail({ ...eligibleTail, latestMessageId: "old" }, "new"),
      "stale latest ID must not start DOM measurement");
    check(!containsIncomingTail(null, "new"), "absent snapshot must not start DOM measurement");
    await waitFor(() => document.querySelector<HTMLElement>(".app-shell") ?? undefined, "actual App");
    // Control: the first row in a genuinely empty disposable chat.
    geometryPrepareEmptyChat(3);
    await select("QA Erin", 3, null);
    check(snapshot(3)?.total === 0, "empty-first setup must have zero messages");
    const emptyAt = performance.now();
    const emptyId = geometryAppendMessage(3, "Visibility empty-first incoming");
    const empty = await observe("empty-first-incoming", 3, emptyId, emptyAt);
    observations.push(empty);
    await stage("empty-first-incoming");
    check(empty.snapshotAt !== null && empty.row?.visible, "MESSAGE_CARD_ABSENT empty-first-incoming");

    // >=500 is essential: restore of a fixed range can omit subsequent tail rows.
    const history = Array.from({ length: 620 }, (_, i) => geometryAppendMessage(2, `Visibility history ${i}`));
    const oldTail = history.at(-1)!;
    await select("QA Dave", 2, oldTail);
    await waitFor(() => row(oldTail) ?? undefined, "620-row tail DOM");
    const tailScroll = scroller()!;
    tailScroll.scrollTop = tailScroll.scrollHeight;
    tailScroll.dispatchEvent(new Event("scroll"));
    await twoFrames();
    details.beforeRevisit = snapshot(2);
    check((details.beforeRevisit as NonNullable<ReturnType<typeof snapshot>>).total >= 500,
      "fixed-range setup must exceed snapshot limit");
    check(row(oldTail), "old tail must be mounted before revisit");

    // No append while closed: the cached bottom itself must restore first.
    await select("QA Carol", 1, geometryMessageId(1, 50));
    await select("QA Dave", 2, oldTail);
    await waitFor(() => snapshot(2)?.requestRange !== null && snapshot(2)?.lastMessageId === oldTail ? true : undefined,
      "cached fixed-range revisit");
    details.revisit = snapshot(2);
    check(row(oldTail), "cached revisit retains old visible tail");

    const incomingAt = performance.now();
    const incomingId = geometryAppendMessage(2, "Visibility cached incoming");
    const incoming = await observe("cached-revisit-incoming", 2, incomingId, incomingAt);
    observations.push(incoming);
    await stage("cached-revisit-incoming");
    check(incoming.snapshotAt !== null, "incoming snapshot not applied");
    check(incoming.row?.visible, `MESSAGE_CARD_ABSENT cached-revisit-incoming ${JSON.stringify(incoming.snapshot)}`);
    check(incoming.firstDomAt !== null && incoming.snapshotAt !== null && incoming.firstDomAt - incoming.snapshotAt < 350,
      "incoming DOM lags applied snapshot by over 350ms");

    // Re-enter a fixed range independently; send through the real composer and
    // wait for the disposable backend's accepted operation, not a direct append.
    await select("QA Carol", 1, geometryMessageId(1, 50));
    await select("QA Dave", 2, incomingId);
    await waitFor(() => snapshot(2)?.requestRange !== null && snapshot(2)?.lastMessageId === incomingId ? true : undefined,
      "cached fixed-range revisit before composer send");
    details.outgoingRevisit = snapshot(2);
    const editor = await waitFor(() => composer() ?? undefined, "real composer");
    setComposerDraft(editor, "Visibility cached outgoing");
    const send = await waitFor(() => {
      const button = document.querySelector<HTMLButtonElement>(".composer .send");
      return button && !button.disabled ? button : undefined;
    }, "enabled send button");
    const attemptsBefore = geometrySendAttempts.length;
    const outgoingAt = performance.now();
    send.click();
    const attempt = await waitFor(() => geometrySendAttempts.length > attemptsBefore ? geometrySendAttempts.at(-1) : undefined,
      "real send reaches backend");
    const outgoingId = await waitFor(() => geometryAcceptedSendResult(attempt.operationId)?.messageId,
      "real send accepted by backend");
    const outgoing = await observe("cached-revisit-composer-outgoing", 2, outgoingId, outgoingAt);
    observations.push(outgoing);
    await stage("cached-revisit-composer-outgoing");
    check(outgoing.snapshotAt !== null && outgoing.row?.visible, "MESSAGE_CARD_ABSENT cached-revisit-composer-outgoing");

    // A manual, non-tail position must remain stable on another append.
    const manual = scroller()!;
    manual.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -1 }));
    manual.scrollTop = Math.max(0, manual.scrollTop - Math.max(120, manual.clientHeight));
    manual.dispatchEvent(new Event("scroll"));
    await twoFrames();
    const manualTop = manual.scrollTop;
    const areaBefore = manual.getBoundingClientRect();
    const anchor = [...manual.querySelectorAll<HTMLElement>("[data-message-key]")].find((candidate) => {
      const box = candidate.getBoundingClientRect();
      return box.top >= areaBefore.top && box.bottom <= areaBefore.bottom;
    });
    check(anchor?.dataset.messageKey, "manual-history visible anchor absent");
    const anchorId = anchor!.dataset.messageKey!;
    const anchorOffset = anchor!.getBoundingClientRect().top - areaBefore.top;
    const manualAt = performance.now();
    const manualId = geometryAppendMessage(2, "Visibility manual-history incoming");
    await waitFor(() => snapshot(2)?.latestMessageId === manualId ? true : undefined, "manual history snapshot");
    await twoFrames();
    const anchorAfter = row(anchorId);
    const afterOffset = anchorAfter ? anchorAfter.getBoundingClientRect().top - manual.getBoundingClientRect().top : null;
    details.manualHistory = { before: manualTop, after: manual.scrollTop, anchorId, anchorOffset, afterOffset, snapshot: snapshot(2) };
    check(afterOffset !== null && Math.abs(afterOffset - anchorOffset) < 2,
      "manual history visible anchor changed after append");
    details.manualHistoryElapsedMs = performance.now() - manualAt;
    return globalThis.__KAIGEN_MESSAGE_VISIBILITY_RESULT__ = { ok: true, assertions, observations, details };
  } catch (error) {
    return globalThis.__KAIGEN_MESSAGE_VISIBILITY_RESULT__ = { ok: false, assertions, observations, details,
      error: error instanceof Error ? error.stack ?? error.message : String(error) };
  }
}
