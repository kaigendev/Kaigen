import { composer as getComposer, setComposerDraft, type TestComposer } from "./composer-test-adapter";
import {
  geometryAppendUnreadMessage, geometryDelayAcknowledgements, geometryInjectPeerReaction,
  geometryEmitOwnStatus, geometryMessageId, geometrySentPayloads, geometryAcceptedSendResult, geometrySnapshotEvidence,
  invoke, prepareUnreadVisibilityScenario, unreadVisibilityEvidence,
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
function scrollAsUser(top: number, deltaY: number) {
  const container = scroller();
  container.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY }));
  container.scrollTop = top;
  container.dispatchEvent(new Event("scroll", { bubbles: true }));
}
function contactEventLabel(timestamp: number | null | undefined) {
  if (!timestamp) return "";
  const date = new Date(timestamp * 1000);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" }).format(date);
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return "Вчера";
  return new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", year: date.getFullYear() === today.getFullYear() ? undefined : "2-digit" }).format(date);
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
    type ColdFriend = { number: number; name: string; last_event?: number | null; lastEventSequence?: number; addedAt?: number };
    const coldFriends = await invoke<ColdFriend[]>("get_tox_friends");
    const contactRows = () => [...document.querySelectorAll<HTMLButtonElement>(".chat-item")];
    const contactNames = () => contactRows().map((item) => item.querySelector(".chat-name")?.textContent?.trim() ?? "");
    const coldRows = await waitFor(() => contactRows().length === coldFriends.length ? contactRows() : undefined, "cold contact rows");
    const newestFirst = [...coldFriends].sort((left, right) =>
      ((right.last_event ?? right.addedAt ?? 0) - (left.last_event ?? left.addedAt ?? 0))
      || ((right.lastEventSequence ?? 0) - (left.lastEventSequence ?? 0))
      || left.number - right.number);
    check(coldRows.length === coldFriends.length && coldRows.length > 1, "cold friends snapshot renders the complete contact list");

    const ownStatusLabel = await waitFor(() => {
      const label = document.querySelector<HTMLButtonElement>(".rail-status-label");
      return label?.textContent?.trim() === "Онлайн" ? label : undefined;
    }, "initial own-status label");
    geometryEmitOwnStatus("away");
    await frame(); await frame();
    check(ownStatusLabel.textContent?.trim() === "Отошёл" && ownStatusLabel.classList.contains("away"), "tray-style profiles-changed updates the visible Away label within two animation frames");
    check(document.querySelector(".rail-profile-avatar")?.classList.contains("profile-avatar-away"), "tray-style Away updates the profile avatar ring within the same event-driven render");
    geometryEmitOwnStatus("online");
    await frame(); await frame();
    check(ownStatusLabel.textContent?.trim() === "Онлайн" && ownStatusLabel.classList.contains("online"), "own-status fixture restores Online without waiting for a poll");

    check(coldFriends.filter((friend) => friend.number !== 0).every((friend) => geometrySnapshotEvidence(friend.number) === null), "cold contact metadata is visible before unopened chats request history");
    check(JSON.stringify(contactNames()) === JSON.stringify(newestFirst.map((friend) => friend.name)), "cold contacts are ordered newest-first from persisted last-event metadata");
    const displayedTimes = coldRows.map((item) => item.querySelector(".chat-time > span")?.textContent?.trim() ?? "");
    const expectedLastEventTimes = newestFirst.map((friend) => contactEventLabel(friend.last_event ?? friend.addedAt));
    const fallbackAddedTimes = newestFirst.map((friend) => contactEventLabel(friend.addedAt));
    check(displayedTimes.every(Boolean) && JSON.stringify(displayedTimes) === JSON.stringify(expectedLastEventTimes), "cold contact dates render from persisted last_event without opening each chat");
    check(expectedLastEventTimes.some((value, index) => value !== fallbackAddedTimes[index] && displayedTimes[index] === value), "cold contact date prefers persisted last_event over addedAt");
    const activitySort = await waitFor(() => [...document.querySelectorAll<HTMLButtonElement>(".contact-list-control")]
      .find((button) => button.getAttribute("aria-label")?.startsWith("Сортировка по событиям")), "activity sort control");
    activitySort.click();
    await waitFor(() => JSON.stringify(contactNames()) === JSON.stringify([...newestFirst].reverse().map((friend) => friend.name)) ? true : undefined, "cold oldest-first contact order");
    check(coldFriends.filter((friend) => friend.number !== 0).every((friend) => geometrySnapshotEvidence(friend.number) === null), "cold ordering in either direction does not hydrate unopened chats");
    activitySort.click();
    await waitFor(() => JSON.stringify(contactNames()) === JSON.stringify(newestFirst.map((friend) => friend.name)) ? true : undefined, "cold newest-first contact order restored");
    check(JSON.stringify(contactNames()) === JSON.stringify(newestFirst.map((friend) => friend.name)), "cold newest-first order remains available without per-chat hydration");

    const contactLabel = document.querySelector<HTMLElement>(".contact-list-heading .section-label")!;
    const contactAdd = await waitFor(() => document.querySelector<HTMLButtonElement>(".contact-list-add") ?? undefined, "contact-list add control");
    const contactLabelBounds = contactLabel.getBoundingClientRect();
    const contactAddBounds = contactAdd.getBoundingClientRect();
    const contactAddIconBounds = contactAdd.querySelector("svg")!.getBoundingClientRect();
    const contactLabelFontSize = Number.parseFloat(getComputedStyle(contactLabel).fontSize);
    check(Math.abs((contactLabelBounds.top + contactLabelBounds.bottom) / 2 - (contactAddBounds.top + contactAddBounds.bottom) / 2) <= 1, "contact add control is vertically aligned with the Contacts label");
    check(contactAddIconBounds.width >= contactLabelFontSize * 0.7 && contactAddIconBounds.width <= contactLabelFontSize * 1.05, "contact add glyph stays comparable to lowercase label text");
    check(contactAddBounds.left >= contactLabelBounds.right && contactAddBounds.left - contactLabelBounds.right <= contactLabelFontSize * 0.6, "contact add control stays adjacent to the Contacts label");
    check(contactAdd.getAttribute("aria-label") === "Добавить в контакты", "contact add control has the localized accessible name");
    contactAdd.click();
    const addContactView = await waitFor(() => document.querySelector<HTMLElement>(".add-contact-view") ?? undefined, "contact-list add view");
    check(!!addContactView.querySelector(".add-contact-card"), "contact-list plus opens the existing add-contact flow");
    const cancelAddContact = [...addContactView.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "Отмена");
    if (!cancelAddContact) throw new Error("add-contact cancel control is missing");
    cancelAddContact.click();
    await waitFor(() => !document.querySelector(".add-contact-view") ? true : undefined, "close contact-list add view");

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
    scrollAsUser(0, -5000);
    await waitFor(() => scroller().scrollTop <= 1 ? true : undefined, "quote navigation origin");
    quoteLink!.click();
    await waitFor(() => fullyVisible(source) ? true : undefined, "quote target navigation");
    check(!document.querySelector(".chat-return-anchor"), "quote navigation must not create a reading-position return marker");
    scrollAsUser(scroller().scrollHeight, 5000);
    await waitFor(() => scroller().scrollHeight - scroller().scrollTop - scroller().clientHeight <= 1 ? true : undefined, "return to live tail after quote navigation");

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

    scrollAsUser(0, -5000);
    await waitFor(() => scroller().scrollTop <= 1 ? true : undefined, "reading position before hidden unread");
    const readingPosition = scroller().scrollTop;
    const returnFlowIncoming = geometryAppendUnreadMessage(1, "hidden unread for return-position navigation");
    const unreadJump = await waitFor(() => {
      const target = row(returnFlowIncoming);
      const action = document.querySelector<HTMLButtonElement>(".jump-latest.has-new");
      return target && action ? action : undefined;
    }, "hidden unread jump action");
    unreadJump.click();
    const returnButton = await waitFor(() => {
      const target = row(returnFlowIncoming);
      const action = document.querySelector<HTMLButtonElement>(".chat-return-anchor");
      return target && fullyVisible(target) && action ? action : undefined;
    }, "reading-position return marker");
    await waitFor(() => unreadVisibilityEvidence(1).unreadCount === 0 ? true : undefined, "hidden unread acknowledgement");
    check(!!returnButton, "only the new-message jump creates a reading-position return marker");
    returnButton.click();
    await waitFor(() => !document.querySelector(".chat-return-anchor") && Math.abs(scroller().scrollTop - readingPosition) <= 2 ? true : undefined, "reading-position return completion");
    check(!document.querySelector(".chat-return-anchor"), "clicking the reading-position return removes its marker");
    const ordinaryEnd = await waitFor(() => document.querySelector<HTMLButtonElement>(".jump-latest:not(.has-new)") ?? undefined, "ordinary end action after reading-position return");
    ordinaryEnd.click();
    await waitFor(() => scroller().scrollHeight - scroller().scrollTop - scroller().clientHeight <= 1 && !document.querySelector(".chat-return-anchor") ? true : undefined, "ordinary end completion without return marker");
    check(!document.querySelector(".chat-return-anchor"), "ordinary end navigation must not recreate the reading-position return marker");

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
