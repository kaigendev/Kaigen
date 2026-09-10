import { geometryAppendOutgoingFile } from "./app-platform";

type ActualAppResult = {
  ok: boolean;
  assertions: number;
  details?: Record<string, number | string>;
  error?: string;
};

declare global {
  var __KAIGEN_ACTUAL_APP_GEOMETRY_RESULT__: ActualAppResult | undefined;
}

let assertions = 0;
function check(value: unknown, message: string): asserts value {
  assertions += 1;
  if (!value) throw new Error(message);
}

async function waitFor<T>(read: () => T | undefined, timeoutMs: number, label: string): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${label} timed out`);
}

function setInputValue(control: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = control instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(control, value);
  control.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
}

function visibleRange(scroller: HTMLElement) {
  const bounds = scroller.getBoundingClientRect();
  const visible = [...scroller.querySelectorAll<HTMLElement>("[data-message-key]")]
    .filter((row) => row.getBoundingClientRect().bottom > bounds.top && row.getBoundingClientRect().top < bounds.bottom);
  return `${visible.at(0)?.innerText.slice(0, 28) ?? "none"}..${visible.at(-1)?.innerText.slice(0, 28) ?? "none"}`;
}

function targetIsVisible(scroller: HTMLElement, target: HTMLElement) {
  const bounds = scroller.getBoundingClientRect();
  const row = target.getBoundingClientRect();
  return row.bottom > bounds.top && row.top < bounds.bottom;
}

export async function runActualAppGeometryScenario() {
  try {
    const conversation = await waitFor(() => document.querySelector<HTMLElement>(".conversation") ?? undefined, 4_000, "actual App conversation");
    const scroller = await waitFor(() => document.querySelector<HTMLElement>(".message-scroll") ?? undefined, 2_000, "actual App message scroller");
    await waitFor(() => scroller.querySelector("[data-message-key]") ? true : undefined, 2_000, "initial history window");
    await waitFor(() => document.querySelector(".composer textarea") && document.querySelector(".composer .send") ? true : undefined, 2_000, "actual composer controls");
    await new Promise((resolve) => setTimeout(resolve, 200));
    const header = document.querySelector<HTMLElement>(".conversation-header")!;
    const composer = document.querySelector<HTMLElement>(".composer")!;
    const original = { outer: conversation.scrollTop, header: header.getBoundingClientRect().top, composer: composer.getBoundingClientRect().top };

    const searchButton = document.querySelector<HTMLButtonElement>('button[aria-label="Поиск"]')!;
    searchButton.click();
    const search = await waitFor(() => document.querySelector<HTMLInputElement>('input[aria-label="Поиск в чате"]') ?? undefined, 1_000, "chat search input");
    setInputValue(search, "Needle");
    await waitFor(() => document.querySelector<HTMLElement>(".message-search-count")?.textContent?.startsWith("1/1") ? true : undefined, 2_000, "one distant search result");
    const searchId = (1_000_000 + 1000).toString(16).padStart(32, "0");
    const searchTarget = await waitFor(() => document.querySelector<HTMLElement>(`[data-message-key="${searchId}"]`) ?? undefined, 2_000, "distant search target row");
    await new Promise((resolve) => setTimeout(resolve, 350));
    const searchRange = visibleRange(scroller);
    const searchVisible = targetIsVisible(scroller, searchTarget);

    const searchTopBeforeSend = searchTarget.getBoundingClientRect().top;
    const textarea = document.querySelector<HTMLTextAreaElement>('.composer textarea')!;
    setInputValue(textarea, "queued from deep history");
    document.querySelector<HTMLButtonElement>(".composer .send")!.click();
    const pending = await waitFor(() => document.querySelector<HTMLButtonElement>(".chat-pending-send") ?? undefined, 2_000, "queued-message notice");
    check(targetIsVisible(scroller, searchTarget) && Math.abs(searchTarget.getBoundingClientRect().top - searchTopBeforeSend) < 2, "outgoing send from deep history must preserve the actual reading anchor");
    pending.click();
    const queuedId = (1_000_000 + 100_000).toString(16).padStart(32, "0");
    const queuedTarget = await waitFor(() => document.querySelector<HTMLElement>(`[data-message-key="${queuedId}"]`) ?? undefined, 2_000, "queued target row");
    await new Promise((resolve) => setTimeout(resolve, 350));
    const queuedRange = visibleRange(scroller);
    const queuedVisible = targetIsVisible(scroller, queuedTarget);

    check(searchVisible, `distant search target is outside viewport; visible=${searchRange}`);
    check(queuedVisible, `queued target is outside viewport; visible=${queuedRange}`);
    check(conversation.scrollTop === original.outer, `outer conversation moved from ${original.outer} to ${conversation.scrollTop}`);
    check(Math.abs(header.getBoundingClientRect().top - original.header) < 0.5, "header moved during actual App navigation");
    check(Math.abs(composer.getBoundingClientRect().top - original.composer) < 0.5, `composer moved from ${original.composer} to ${composer.getBoundingClientRect().top} during actual App navigation`);

    // Grow a new outgoing row beyond the initial 64px estimate. The actual
    // composer and history snapshot exercise production measurement/prepaint;
    // no DOM message insertion or scrollTop write establishes the outcome.
    document.querySelector<HTMLButtonElement>('.message-search button[aria-label="Закрыть поиск"]')!.click();
    await waitFor(() => !document.querySelector(".message-search") ? true : undefined, 1_000, "closed search before near-tail outgoing");
    await waitFor(() => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 3 ? true : undefined, 2_000, "actual near-tail outgoing precondition");
    const tailBefore = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    check(tailBefore <= 3, "multiline outgoing starts at the actual latest position");
    const lineHeight = parseFloat(getComputedStyle(queuedTarget.querySelector<HTMLElement>(".message-text")!).lineHeight) || 25;
    const lines = Math.max(6, Math.min(16, Math.floor((scroller.clientHeight - 90) / lineHeight)));
    const multiline = "near-tail outgoing height fixture\n" + Array.from({ length: lines }, (_, index) => "Height measurement line " + String(index + 1).padStart(2, "0")).join("\n");
    setInputValue(textarea, multiline);
    const multilineSend = await waitFor(() => document.querySelector<HTMLButtonElement>(".composer .send:not(:disabled)") ?? undefined, 1_000, "multiline send enabled");
    multilineSend.click();
    const multilineId = (1_000_000 + 100_001).toString(16).padStart(32, "0");
    const multilineRow = await waitFor(() => document.querySelector<HTMLElement>('[data-message-key="' + multilineId + '"]') ?? undefined, 2_000, "actual multiline outgoing row");
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    await new Promise((resolve) => setTimeout(resolve, 350));
    const multilineBounds = multilineRow.getBoundingClientRect();
    const multilineViewport = scroller.getBoundingClientRect();
    const multilineDistance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    check(multilineBounds.height > 128 && multilineBounds.height < scroller.clientHeight, "multiline row must grow beyond the estimate while fitting the viewport");
    check(multilineDistance <= 3, "measured outgoing height must not restore the stale prepaint anchor; distance=" + multilineDistance);
    check(multilineBounds.top >= multilineViewport.top - 2 && multilineBounds.bottom <= multilineViewport.bottom + 2, "newest multiline outgoing is fully visible after layout settles");
    check(conversation.scrollTop === original.outer && Math.abs(header.getBoundingClientRect().top - original.header) < 0.5 && Math.abs(composer.getBoundingClientRect().top - original.composer) < 0.5, "multiline tail following preserves the outer frame");

    // The same mine/near-tail branch, using the real file-card renderer.
    // Backend metadata is synthetic; these assertions claim geometry only.
    const fileId = geometryAppendOutgoingFile(0);
    const fileRow = await waitFor(() => document.querySelector<HTMLElement>('[data-message-key="' + fileId + '"]') ?? undefined, 2_000, "actual outgoing file-card row");
    await waitFor(() => fileRow.querySelector(".file-attachment") ? true : undefined, 1_000, "actual outgoing file-card rendering");
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    await new Promise((resolve) => setTimeout(resolve, 350));
    const fileBounds = fileRow.getBoundingClientRect();
    const fileViewport = scroller.getBoundingClientRect();
    const fileDistance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    check(fileBounds.height > 0 && fileBounds.height < scroller.clientHeight && fileDistance <= 3 && fileBounds.top >= fileViewport.top - 2 && fileBounds.bottom <= fileViewport.bottom + 2, "newest outgoing file card is fully visible after layout settles; distance=" + fileDistance);
    check(conversation.scrollTop === original.outer && Math.abs(header.getBoundingClientRect().top - original.header) < 0.5 && Math.abs(composer.getBoundingClientRect().top - original.composer) < 0.5, "outgoing file tail following preserves the outer frame");

    globalThis.__KAIGEN_ACTUAL_APP_GEOMETRY_RESULT__ = {
      ok: true,
      assertions,
      details: { searchRange, queuedRange, outer: conversation.scrollTop, multilineDistance, multilineHeight: multilineBounds.height, fileDistance, fileHeight: fileBounds.height },
    };
  } catch (error) {
    globalThis.__KAIGEN_ACTUAL_APP_GEOMETRY_RESULT__ = {
      ok: false,
      assertions,
      error: error instanceof Error ? error.stack ?? error.message : String(error),
    };
  }
  return globalThis.__KAIGEN_ACTUAL_APP_GEOMETRY_RESULT__;
}
