import { geometryAppendMessage, geometrySnapshotEvidence } from "./app-platform";

declare const __KAIGEN_CHAT_GEOMETRY_TIMEOUT_SCALE__: number;
type WindowResult = { ok: boolean; assertions: number; details: Record<string, unknown>; error?: string };
declare global { var __KAIGEN_ACTUAL_APP_WINDOW_RESULT__: WindowResult | undefined; }

const frames = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
async function waitFor<T>(read: () => T | undefined, label: string): Promise<T> {
  const deadline = performance.now() + 3_000 * __KAIGEN_CHAT_GEOMETRY_TIMEOUT_SCALE__;
  while (performance.now() < deadline) {
    const result = read();
    if (result !== undefined) return result;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`${label} timed out`);
}

export async function runActualAppWindowScenario(): Promise<WindowResult> {
  let assertions = 0;
  const details: Record<string, unknown> = {};
  const check = (value: unknown, label: string) => { assertions += 1; if (!value) throw new Error(label); };
  let shell: HTMLElement | undefined;
  let previousZoom = "";
  try {
    shell = await waitFor(() => document.querySelector<HTMLElement>(".app-shell") ?? undefined, "actual App");
    previousZoom = shell.style.zoom;
    document.querySelector<HTMLButtonElement>('.message-search button[aria-label="Закрыть поиск"]')?.click();
    // These new IDs have never been rendered or measured. The loaded 500-row
    // window therefore contains an unmeasured gap before its 120-row tail.
    const ids = Array.from({ length: 500 }, (_, index) => geometryAppendMessage(2, `Virtual row ${index}\nSecond line\nThird line`));
    const contact = [...document.querySelectorAll<HTMLButtonElement>(".chat-item")].find((button) => button.textContent?.includes("QA Dave"))!;
    contact.click();
    await waitFor(() => document.querySelector(`[data-message-key="${ids.at(-1)}"]`) ?? undefined, "new disposable history tail");
    shell.style.zoom = "1.25";
    await frames();
    const scroller = document.querySelector<HTMLElement>(".message-scroll")!;
    const header = document.querySelector<HTMLElement>(".conversation-header")!;
    const composer = document.querySelector<HTMLElement>(".composer")!;
    const conversation = document.querySelector<HTMLElement>(".conversation")!;
    const original = { outer: conversation.scrollTop, header: header.getBoundingClientRect().top, composer: composer.getBoundingClientRect().top };
    const rows = () => [...scroller.querySelectorAll<HTMLElement>("[data-message-key]")];
    const visible = () => { const box = scroller.getBoundingClientRect(); return rows().filter((row) => { const rect = row.getBoundingClientRect(); return rect.bottom > box.top && rect.top < box.bottom; }); };
    const first = rows()[0];
    const firstIndex = ids.indexOf(first.dataset.messageKey!);
    check(firstIndex >= 300, "initial DOM is bounded to the new tail, leaving an unmeasured gap");
    const targetIndex = 180;
    const targetId = ids[targetIndex];
    check(!document.querySelector(`[data-message-key="${targetId}"]`), "the requested anchor begins outside the mounted DOM");
    const scale = scroller.getBoundingClientRect().height / scroller.offsetHeight;
    check(Math.abs(scale - 1.25) < 0.01, "the regression actually exercises zoom 1.25");
    const exactZoom = 1.25;
    const dataOrigin = (first.getBoundingClientRect().top - scroller.getBoundingClientRect().top) / exactZoom + scroller.scrollTop - firstIndex * 64;
    const offsetWithinEstimate = 30;
    const requestedTop = dataOrigin + targetIndex * 64 + offsetWithinEstimate;
    const expectedOffset = -offsetWithinEstimate * exactZoom;
    const style = getComputedStyle(scroller);
    details.geometry = { rectHeight: scroller.getBoundingClientRect().height, offsetHeight: scroller.offsetHeight,
      cssHeight: style.height, paddingTop: style.paddingTop, paddingBottom: style.paddingBottom,
      borderTop: style.borderTopWidth, borderBottom: style.borderBottomWidth, boxSizing: style.boxSizing,
      requestedTop, dataOrigin, initialScrollTop: scroller.scrollTop, firstIndex };
    scroller.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -1 }));
    scroller.scrollTop = requestedTop;
    check(visible().length === 0, "the scroll enters a real virtual gap before React mounts the target");
    scroller.dispatchEvent(new Event("scroll", { bubbles: false }));
    const target = await waitFor(() => document.querySelector<HTMLElement>(`[data-message-key="${targetId}"]`) ?? undefined, "gap anchor mounted by production windowing");
    await frames();
    const offset = () => target.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    details.scale = scale; details.expectedOffset = expectedOffset; details.actualOffset = offset(); details.domRows = rows().length;
    check(Math.abs(offset() - expectedOffset) <= 1.5, `the virtual-gap anchor retains its visual offset after measurement: expected ${expectedOffset}, got ${offset()}; geometry=${JSON.stringify(details.geometry)}`);
    check(visible().some((row) => row === target), "the newly mounted anchor is visibly rendered");
    check(rows().length <= 120, "gap recovery keeps the bounded 120-message DOM");

    const incomingId = geometryAppendMessage(2, "Incoming while the scaled virtual-gap anchor is being read");
    // Observe the existing IPC snapshot boundary, then allow the actual App to
    // render. No extra snapshot, DOM write or scroll may repair the position.
    await waitFor(() => geometrySnapshotEvidence(2)?.latestMessageId === incomingId ? true : undefined, "incoming snapshot applied");
    await frames();
    details.afterIncomingOffset = offset();
    check(Math.abs(offset() - expectedOffset) <= 1.5, "a subsequent incoming snapshot preserves the same anchor and offset");
    check(rows().length <= 120, "subsequent snapshots keep the DOM bounded");
    check(conversation.scrollTop === original.outer && Math.abs(header.getBoundingClientRect().top - original.header) < 0.5 && Math.abs(composer.getBoundingClientRect().top - original.composer) < 0.5, "virtual-gap recovery does not move the outer frame, header or composer");
    return globalThis.__KAIGEN_ACTUAL_APP_WINDOW_RESULT__ = { ok: true, assertions, details };
  } catch (error) {
    return globalThis.__KAIGEN_ACTUAL_APP_WINDOW_RESULT__ = { ok: false, assertions, details, error: error instanceof Error ? error.stack ?? error.message : String(error) };
  } finally {
    if (shell) shell.style.zoom = previousZoom;
  }
}
