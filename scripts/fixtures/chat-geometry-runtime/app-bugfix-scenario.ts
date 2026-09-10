import { composer as getComposer, setComposerDraft, type TestComposer } from "./composer-test-adapter";
import {
  geometryAppendUnreadMessage, geometryDelayAcknowledgements, geometryInjectPeerReaction,
  geometryMessageId, geometrySentPayloads, geometryAcceptedSendResult, geometrySnapshotEvidence,
  prepareUnreadVisibilityScenario, unreadVisibilityEvidence,
} from "./app-platform";

declare const __KAIGEN_CHAT_GEOMETRY_TIMEOUT_SCALE__: number;
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
async function waitFor<T>(read: () => T | undefined, label: string, ms = 5000): Promise<T> {
  const end = performance.now() + ms * __KAIGEN_CHAT_GEOMETRY_TIMEOUT_SCALE__;
  while (performance.now() < end) {
    const value = read();
    if (value !== undefined) return value;
    await delay(20);
  }
  throw new Error(`${label} timed out`);
}
function input(control: TestComposer, value: string) {
  setComposerDraft(control, value);
}
const row = (id: string) => document.querySelector<HTMLElement>(`[data-message-key="${id}"]`);
const scroller = () => document.querySelector<HTMLElement>(".message-scroll")!;
const field = () => getComposer()!;
function fullyVisible(element: HTMLElement) {
  const rect = element.getBoundingClientRect(), view = scroller().getBoundingClientRect();
  return rect.height > 0 && rect.top >= view.top - 2 && rect.bottom <= view.bottom + 2;
}
async function selectContact(prefix: string, lastId: string) {
  const button = await waitFor(() => [...document.querySelectorAll<HTMLButtonElement>(".chat-item")].find((item) => item.textContent?.includes(prefix)), prefix);
  button.click();
  await waitFor(() => row(lastId) && field() ? true : undefined, "selected history");
  field().focus({ preventScroll: true });
  await frame(); await frame();
}

export async function runActualAppBugfixScenario() {
  let assertions = 0;
  const check = (value: unknown, message: string) => { assertions += 1; if (!value) throw new Error(message); };
  try {
    await selectContact("QA Carol", geometryMessageId(1, 50));
    const source = row(geometryMessageId(1, 50))!;
    source.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: source.getBoundingClientRect().left + 25, clientY: source.getBoundingClientRect().top + 15 }));
    const quote = await waitFor(() => [...document.querySelectorAll<HTMLButtonElement>('.restricted-context-menu button')].find((button) => button.textContent === "Цитировать"), "quote command");
    quote.click();
    await waitFor(() => document.activeElement === field() ? true : undefined, "quote focus");
    check(document.activeElement === field(), "quoting must focus the actual composer");
    input(field(), "Quoted outgoing first frame\nsecond line\nthird line\nfourth line");
    await frame(); await frame();
    const before = geometrySentPayloads.length;
    const expected = geometryMessageId(1, 51);
    const frames: Array<{ top: number; bottom: number; height: number; text: boolean }> = [];
    let observe = true;
    const sample = () => {
      const element = row(expected);
      if (element) {
        const bounds = element.getBoundingClientRect(), view = scroller().getBoundingClientRect();
        frames.push({ top: bounds.top - view.top, bottom: bounds.bottom - view.bottom, height: bounds.height, text: !!element.querySelector(".message-text")?.textContent });
      }
      if (observe) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
    document.querySelector<HTMLButtonElement>(".composer .send")!.click();
    await waitFor(() => geometrySentPayloads.length > before && row(expected) ? true : undefined, "quoted send DOM");
    await delay(350);
    observe = false;
    check(geometryAcceptedSendResult(geometrySentPayloads[before].operationId)?.messageId === expected, "quoted send uses accepted stable ID");
    check(frames.length > 3 && frames.every((sample) => sample.text && sample.height > 0), "outgoing quoted text paints on every observed frame");
    check(frames.every((sample) => sample.top >= -2 && sample.bottom <= 2), `quoted outgoing must stay above composer from first frame: ${JSON.stringify(frames.slice(0, 4))}`);
    check(document.querySelectorAll(`[data-message-key="${expected}"]`).length === 1, "quoted send has exactly one rendered row");

    const quoteLink = row(expected)!.querySelector<HTMLButtonElement>(".message-quote-preview.actionable");
    check(!!quoteLink, "sent quote exposes real navigation");
    quoteLink!.click();
    await delay(200);
    scroller().dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 5000 }));
    scroller().scrollTop = scroller().scrollHeight;
    scroller().dispatchEvent(new Event("scroll", { bubbles: true }));
    await waitFor(() => !document.querySelector(".chat-return-anchor") ? true : undefined, "return marker reached manually");
    check(!document.querySelector(".chat-return-anchor"), "return marker expires when its saved end is reached");

    // Focus permission and spatial visibility are separate inputs. The real
    // unfocused iframe is also exercised by the permanent unread scenario.
    const focusDescriptor = Object.getOwnPropertyDescriptor(document, "hasFocus");
    Object.defineProperty(document, "hasFocus", { configurable: true, value: () => false });
    try {
      geometryInjectPeerReaction(1, 51);
      await waitFor(() => row(expected)?.querySelector(".message-reaction-bar") ? true : undefined, "visible reaction snapshot");
      await delay(100);
      check(!document.querySelector(".chat-service-notices"), "a visible reaction must not be classified as offscreen merely because focus is elsewhere");
    } finally {
      if (focusDescriptor) Object.defineProperty(document, "hasFocus", focusDescriptor);
      else delete (document as any).hasFocus;
    }

    const incoming = geometryAppendUnreadMessage(1, Array.from({ length: 45 }, (_, index) => `incoming line ${index}`).join("\n"));
    await waitFor(() => row(incoming) && document.querySelector(".jump-latest.has-new") ? true : undefined, "long unread arrival");
    input(field(), "draft line\n".repeat(7));
    await frame(); await frame();
    const jump = document.querySelector<HTMLElement>(".jump-latest.has-new")!.getBoundingClientRect();
    const composer = document.querySelector<HTMLElement>(".chat-composer-section")!.getBoundingClientRect();
    check(jump.bottom <= composer.top - 5, "new-message control must stay above the entire growing composer");
    const oldBottom = document.querySelector<HTMLElement>(".conversation")!.getBoundingClientRect().bottom - 94;
    check(oldBottom > composer.top, "this growing draft reproduces the former fixed-94px overlap");
    check(row(incoming)!.querySelector(".message-text")!.textContent!.length > 0, "incoming long message renders text immediately");

    geometryDelayAcknowledgements(1300, 1);
    prepareUnreadVisibilityScenario();
    await selectContact("QA Erin", geometryMessageId(3, 0));
    await waitFor(() => unreadVisibilityEvidence().acknowledgements.length > 0 ? true : undefined, "first ACK attempt");
    await waitFor(() => unreadVisibilityEvidence().unreadCount === 0 ? true : undefined, "automatic ACK failure recovery", 6500);
    check(unreadVisibilityEvidence().acknowledgements.length >= 2, "transient local-view ACK failure is retried without a scroll or focus event");

    geometryDelayAcknowledgements(2200);
    const second = geometryAppendUnreadMessage(3, "incoming while ACK is delayed");
    await waitFor(() => unreadVisibilityEvidence().acknowledgements.some((call) => call.messageIds.includes(second)) ? true : undefined, "delayed ACK starts");
    const third = geometryAppendUnreadMessage(3, "next incoming during pending ACK");
    await waitFor(() => row(third) && fullyVisible(row(third)!) ? true : undefined, "pending-ACK arrival paints");
    await waitFor(() => unreadVisibilityEvidence().unreadCount === 0 ? true : undefined, "ACK drains queued seen IDs", 7000);
    check(unreadVisibilityEvidence().acknowledgements.some((call) => call.messageIds.includes(third)), "IDs seen during in-flight ACK receive another batch");
    check(fullyVisible(row(third)!) && !!row(third)!.textContent, "short incoming row stays visible after ACK completion");
    check(!document.querySelector(".jump-latest"), "seen short messages leave no unread navigation control");

    // Erin's pending view IDs must never be routed to the warm Carol cache.
    // Cached hydration and all layout/passive effects run through actual App.
    geometryDelayAcknowledgements(1800);
    const switchOrigin = geometryAppendUnreadMessage(3, "seen in Erin while its ACK is pending");
    await waitFor(() => unreadVisibilityEvidence(3).acknowledgements.some((call) => call.messageIds.includes(switchOrigin)) ? true : undefined, "Erin ACK in flight before warm chat switch");
    const carolAckStart = unreadVisibilityEvidence(1).acknowledgements.length;
    await selectContact("QA Carol", incoming);
    check(unreadVisibilityEvidence(1).acknowledgements.slice(carolAckStart).every((call) => !call.messageIds.includes(switchOrigin)), "warm Carol hydration must not send Erin pending IDs with Carol's friend number");
    const whileAway = geometryAppendUnreadMessage(3, "new Erin ID received while Carol is selected");
    geometryDelayAcknowledgements(0);
    await selectContact("QA Erin", whileAway);
    await waitFor(() => unreadVisibilityEvidence(3).unreadCount === 0 ? true : undefined, "switch-back drains Erin IDs", 4000);
    check(unreadVisibilityEvidence(3).acknowledgements.some((call) => call.messageIds.includes(whileAway)), "switch-back acknowledges the real newly visible Erin ID");
    await delay(1850);
    check(unreadVisibilityEvidence(3).unreadCount === 0 && unreadVisibilityEvidence(1).acknowledgements.slice(carolAckStart).every((call) => !call.messageIds.includes(switchOrigin) && !call.messageIds.includes(whileAway)), "late Erin completion cannot reroute IDs through Carol or prevent the new Erin drain");

    geometryDelayAcknowledgements(0);
    const burstGeometry = () => {
      const container = scroller();
      const keys = [...container.querySelectorAll<HTMLElement>("[data-message-key]")].map((element) => element.dataset.messageKey);
      return { snapshot: geometrySnapshotEvidence(3), scrollTop: container.scrollTop, scrollHeight: container.scrollHeight,
        clientHeight: container.clientHeight, first: keys[0], last: keys.at(-1), domCount: keys.length,
        navigation: document.querySelector(".jump-latest")?.textContent ?? null };
    };
    const beforeBurst = burstGeometry();
    const burst: string[] = [];
    for (let index = 0; index < 130; index += 1) burst.push(geometryAppendUnreadMessage(3, `bounded window incoming ${index}`));
    try {
      await waitFor(() => row(burst[0]) ? true : undefined, "burst mounts its first incoming anchor");
    } catch (error) {
      throw new Error(`${String(error)}: ${JSON.stringify({ beforeBurst, afterBurst: burstGeometry() })}`);
    }
    await delay(800);
    const firstBurst = row(burst[0]);
    check(!!firstBurst && fullyVisible(firstBurst), "a burst exceeding the DOM window begins with a visible real row rather than a spacer");
    check(scroller().querySelectorAll("[data-message-key]").length <= 120, "repair preserves bounded history DOM");
    check(!!document.querySelector(".jump-latest.has-new"), "unseen remainder of a long burst retains its navigation action");
    return { ok: true, assertions, firstFrameCount: frames.length };
  } catch (error) {
    return { ok: false, assertions, error: String(error) };
  }
}
