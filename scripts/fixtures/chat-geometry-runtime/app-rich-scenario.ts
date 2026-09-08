import {
  geometryAppendUnreadMessage,
  geometryEmitFriendStatus,
  geometryMessageId,
  prepareRichUiScenario,
  prepareUnreadVisibilityScenario,
  richUiEvidence,
  unreadVisibilityEvidence,
} from "./app-platform";

type RichUiResult = {
  ok: boolean;
  assertions: number;
  details?: Record<string, unknown>;
  error?: string;
};

type MacControlClickStage = {
  phase: "ready" | "complete";
  x: number;
  y: number;
  value: string;
  start: number;
  end: number;
  direction: "forward" | "backward" | "none";
  trustedPress: boolean;
  trustedRelease: boolean;
};

type UnreadGeometryStage = {
  phase: "request-unfocus" | "unfocused" | "short-fit" | "short-captured" | "request-large" | "large" | "request-small" | "small" | "request-top-scroll" | "top-scrolled";
  width: number;
  height: number;
  x?: number;
  y?: number;
};

type MessageContextGestureStage = {
  phase: "right-ready" | "right-complete" | "mac-ready" | "mac-complete";
  x: number;
  y: number;
  trustedPress: boolean;
  trustedRelease: boolean;
  trustedContextMenu: boolean;
};

declare global {
  var __KAIGEN_ACTUAL_APP_RICH_RESULT__: RichUiResult | undefined;
  var __KAIGEN_ACTUAL_APP_UNREAD_RESULT__: RichUiResult | undefined;
  var __KAIGEN_MAC_CTRL_CLICK_STAGE__: MacControlClickStage | undefined;
  var __KAIGEN_UNREAD_GEOMETRY_STAGE__: UnreadGeometryStage | undefined;
  var __KAIGEN_MESSAGE_CONTEXT_STAGE__: MessageContextGestureStage | undefined;
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

function observeScrollEnd(target: HTMLElement, timeoutMs: number, label: string) {
  let cleanup = () => {};
  const promise = new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onScrollEnd = () => finish();
    const timer = window.setTimeout(() => finish(new Error(`${label} timed out`)), timeoutMs);
    cleanup = () => {
      window.clearTimeout(timer);
      target.removeEventListener("scrollend", onScrollEnd);
    };
    target.addEventListener("scrollend", onScrollEnd);
  });
  // The caller first performs the existing navigation assertions. Keep a
  // rejection observed if one of those assertions exits before awaiting us.
  promise.catch(() => {});
  return { promise, cleanup };
}

function waitForTwoFrames() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

function setInputValue(control: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = control instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(control, value);
  control.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
}

function isVisible(scroller: HTMLElement, target: HTMLElement) {
  const viewport = scroller.getBoundingClientRect();
  const row = target.getBoundingClientRect();
  return row.bottom > viewport.top && row.top < viewport.bottom;
}

function isFullyVisible(scroller: HTMLElement, target: HTMLElement) {
  const viewport = scroller.getBoundingClientRect();
  const row = target.getBoundingClientRect();
  return row.top >= viewport.top - 1 && row.bottom <= viewport.bottom + 1;
}

function contactButton(name: string) {
  return [...document.querySelectorAll<HTMLButtonElement>(".chat-item")]
    .find((button) => button.querySelector(".chat-name")?.textContent?.includes(name));
}

const formatKinds = ["bold", "underline", "italic", "strikethrough"] as const;
type FormatKind = typeof formatKinds[number];
const formatLabels: Record<FormatKind, string> = {
  bold: "Жирный",
  underline: "Подчёркнутый",
  italic: "Курсив",
  strikethrough: "Зачёркнутый",
};

function formattingButton(kind: FormatKind) {
  return document.querySelector<HTMLButtonElement>(`.text-edit-context-menu [data-kaigen-format-kind="${kind}"]`);
}

function selectComposerRange(textarea: HTMLTextAreaElement, start: number, end: number, direction: "forward" | "backward" = "forward") {
  textarea.focus({ preventScroll: true });
  textarea.setSelectionRange(start, end, direction);
  textarea.dispatchEvent(new Event("select", { bubbles: true }));
  textarea.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Shift" }));
}

async function openPointerTextEditMenu(textarea: HTMLTextAreaElement) {
  const event = new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    button: 2,
    clientX: 480,
    clientY: 620,
  });
  textarea.dispatchEvent(event);
  const menu = await waitFor(() => document.querySelector<HTMLElement>(".text-edit-context-menu") ?? undefined, 1_000, "text edit context menu");
  return { event, menu };
}

async function closeTextEditMenu() {
  document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" }));
  await waitFor(() => document.querySelector(".text-edit-context-menu") ? undefined : true, 1_000, "text edit context menu close");
}

async function openMessageContextMenu(target: HTMLElement, label: string) {
  const bounds = target.getBoundingClientRect();
  const event = new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    button: 2,
    clientX: Math.max(16, Math.min(window.innerWidth - 16, bounds.left + Math.min(48, Math.max(8, bounds.width / 2)))),
    clientY: Math.max(16, Math.min(window.innerHeight - 16, bounds.top + Math.min(24, Math.max(8, bounds.height / 2)))),
  });
  target.dispatchEvent(event);
  const menu = await waitFor(() => document.querySelector<HTMLElement>(".restricted-context-menu") ?? undefined, 1_000, `${label} context menu`);
  await waitForTwoFrames();
  return { event, menu };
}

async function closeMessageContextMenu(label: string) {
  document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" }));
  await waitFor(() => document.querySelector(".restricted-context-menu") ? undefined : true, 1_000, `${label} context menu close`);
}

function quoteAction(menu: HTMLElement) {
  return [...menu.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]')]
    .find((button) => ["Цитировать", "Quote"].includes(button.textContent?.trim() ?? ""));
}

function reactionActions(menu: HTMLElement) {
  return [...menu.querySelectorAll<HTMLButtonElement>(':scope > .reaction-palette > button[role="menuitemcheckbox"]')];
}

export async function runActualAppUnreadGeometryScenario(): Promise<RichUiResult> {
  assertions = 0;
  try {
    await waitFor(() => document.querySelector(".app-shell") ? true : undefined, 4_000, "unread App shell");
    check(document.visibilityState === "visible", "the iframe App document must be genuinely visible");

    const erin = await waitFor(() => contactButton("QA Erin"), 2_000, "Erin unread geometry contact");
    erin.click();
    await waitFor(() => erin.classList.contains("selected") ? true : undefined, 2_000, "Erin chat selection");
    const focusedComposer = await waitFor(() => {
      const composer = document.querySelector<HTMLTextAreaElement>(".composer textarea");
      return composer && document.activeElement === composer && document.hasFocus() ? composer : undefined;
    }, 2_000, "Erin composer focus after chat selection");
    await waitForTwoFrames();
    check(document.activeElement === focusedComposer && document.hasFocus(), "chat selection must establish real child composer focus before the parent focus transfer");
    const stage: UnreadGeometryStage = { phase: "request-unfocus", width: window.innerWidth, height: window.innerHeight };
    globalThis.__KAIGEN_UNREAD_GEOMETRY_STAGE__ = stage;
    await waitFor(() => stage.phase === "unfocused" ? true : undefined, 3_000, "trusted parent focus transfer");
    check(document.visibilityState === "visible", "the selected iframe App document must remain genuinely visible after the trusted parent focus transfer");
    check(!document.hasFocus(), "the selected iframe App document must be genuinely unfocused before unread state is introduced");

    const unreadFixture = prepareUnreadVisibilityScenario();
    const scroller = await waitFor(() => document.querySelector<HTMLElement>(".message-scroll") ?? undefined, 2_000, "unread geometry scroller");
    const shortUnread = await waitFor(() => document.querySelector<HTMLElement>(`[data-message-key="${unreadFixture.messageId}"]`) ?? undefined, 3_000, "short unread row");
    await waitFor(() => document.querySelector(".chat-unseen-divider") ? true : undefined, 3_000, "short unread snapshot boundary");
    await waitFor(() => [...erin.querySelectorAll(".contact-unread-count,.contact-avatar-unread")]
      .some((badge) => badge.textContent?.trim() === "1") ? true : undefined, 4_000, "short unread contact count");
    await waitForTwoFrames();
    check(isFullyVisible(scroller, shortUnread), "a short unread message must fit fully inside the chat viewport");
    check(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 1, "the short unread chat must have no downward scroll range");
    check(document.querySelector(".jump-latest") === null, "a fully visible unread message must not show the new-message jump action");
    check(unreadVisibilityEvidence().unreadCount === 1, "an unfocused visible short chat must retain its unread counter");
    check(document.visibilityState === "visible" && !document.hasFocus() && unreadVisibilityEvidence().acknowledgements.length === 0, "the short chat must stay visibly unfocused and issue zero local acknowledgement commands");

    stage.phase = "short-fit";
    await waitFor(() => stage.phase === "short-captured" ? true : undefined, 3_000, "short-fit evidence capture");

    const longUnreadText = Array.from({ length: 48 }, (_, index) => `Unread geometry line ${String(index + 1).padStart(2, "0")}`).join("\n");
    const longUnreadId = geometryAppendUnreadMessage(unreadFixture.friendNumber, longUnreadText);
    const longUnread = await waitFor(() => document.querySelector<HTMLElement>(`[data-message-key="${longUnreadId}"]`) ?? undefined, 3_000, "long unread row");
    const hiddenLongGeometry = await waitFor(() => {
      const viewport = scroller.getBoundingClientRect();
      const row = longUnread.getBoundingClientRect();
      const distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
      return row.top < viewport.bottom && row.bottom > viewport.bottom + 1 && distance > 1 ? { viewport, row, distance } : undefined;
    }, 4_000, "partially hidden long unread geometry");
    await waitFor(() => document.querySelector<HTMLButtonElement>(".jump-latest.has-new") ?? undefined, 2_000, "long unread jump action");
    check(hiddenLongGeometry.row.bottom > hiddenLongGeometry.viewport.bottom + 1, "a partially visible long unread message must extend below the viewport");
    check(hiddenLongGeometry.distance > 1, "a partially visible long unread message must leave real downward scroll range");
    check(document.querySelector(".jump-latest.has-new") !== null, "a partially hidden long unread message must show the new-message jump action");
    check(unreadVisibilityEvidence().unreadCount === 2, "the long incoming message must increment the durable unread counter");
    check(document.visibilityState === "visible" && !document.hasFocus() && unreadVisibilityEvidence().acknowledgements.length === 0, "the long incoming message must remain visibly unfocused and unacknowledged");

    stage.phase = "request-large";
    stage.width = 1280;
    stage.height = 1800;
    await waitFor(() => stage.phase === "large" ? true : undefined, 3_000, "large unread iframe viewport");
    await waitFor(() => isFullyVisible(scroller, shortUnread) && isFullyVisible(scroller, longUnread) ? true : undefined, 3_000, "all unread rows in the enlarged viewport");
    await waitFor(() => document.querySelector(".jump-latest") ? undefined : true, 2_000, "enlarged unread jump dismissal");
    check(isFullyVisible(scroller, shortUnread) && isFullyVisible(scroller, longUnread), "growing the iframe viewport must make every unread row fully visible");
    check(document.querySelector(".jump-latest") === null && document.visibilityState === "visible" && !document.hasFocus(), "growing until all unread rows fit must remove the jump action while the child remains visibly unfocused");

    stage.phase = "request-small";
    stage.width = 1280;
    stage.height = 520;
    await waitFor(() => stage.phase === "small" ? true : undefined, 3_000, "small unread iframe viewport");
    const shrinkGeometry = await waitFor(() => {
      const viewport = scroller.getBoundingClientRect();
      const rows = [shortUnread, longUnread].map((row) => {
        const bounds = row.getBoundingClientRect();
        return { top: bounds.top, bottom: bounds.bottom };
      });
      const distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
      const unreadBelow = distance > 1 && rows.some((row) => row.bottom > viewport.bottom + 1);
      const ctaVisible = document.querySelector(".jump-latest.has-new") !== null;
      const anyJumpVisible = document.querySelector(".jump-latest") !== null;
      return (unreadBelow ? ctaVisible : !anyJumpVisible)
        ? { viewport: { top: viewport.top, bottom: viewport.bottom }, rows, distance, unreadBelow, ctaVisible }
        : undefined;
    }, 2_000, "settled shrink unread navigation state");
    check(shrinkGeometry.ctaVisible === shrinkGeometry.unreadBelow, "the shrunken viewport must show the jump action exactly when an unread target remains below it");
    check(document.visibilityState === "visible", "the shrunken iframe App document must remain genuinely visible");
    check(!document.hasFocus(), "the shrunken iframe App document must remain genuinely unfocused");
    check(unreadVisibilityEvidence().unreadCount === 2, "the settled iframe resize must retain the durable unread count");
    check(unreadVisibilityEvidence().acknowledgements.length === 0, "the unfocused settled resize must issue zero local acknowledgement commands");

    const wheelViewport = scroller.getBoundingClientRect();
    stage.x = wheelViewport.left + wheelViewport.width / 2;
    stage.y = wheelViewport.top + wheelViewport.height / 2;
    stage.phase = "request-top-scroll";
    await waitFor(() => stage.phase === "top-scrolled" ? true : undefined, 3_000, "trusted wheel-up completion");
    const wheelHiddenGeometry = await waitFor(() => {
      const viewport = scroller.getBoundingClientRect();
      const row = document.querySelector<HTMLElement>(`[data-message-key="${longUnreadId}"]`)?.getBoundingClientRect();
      const distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
      return row && scroller.scrollTop <= 1 && row.bottom > viewport.bottom + 1 && distance > 1 ? { viewport, row, distance } : undefined;
    }, 3_000, "wheel-hidden unread geometry");
    await waitFor(() => document.querySelector<HTMLButtonElement>(".jump-latest.has-new") ?? undefined, 2_000, "wheel-hidden unread jump action");
    check(scroller.scrollTop <= 1, "the trusted wheel-up must establish a real top scroll position");
    check(wheelHiddenGeometry.row.bottom > wheelHiddenGeometry.viewport.bottom + 1, "the trusted wheel-up must leave unread message content below the viewport");
    check(wheelHiddenGeometry.distance > 1, "the trusted wheel-up must establish real downward scroll range");
    check(document.querySelector(".jump-latest.has-new") !== null, "a real below-viewport unread target after trusted wheel-up must show the jump action");
    check(document.visibilityState === "visible", "the wheel-scrolled iframe App document must remain genuinely visible");
    check(!document.hasFocus(), "the wheel-scrolled iframe App document must remain genuinely unfocused");
    check(unreadVisibilityEvidence().unreadCount === 2, "trusted wheel scrolling must not forge a local unread acknowledgement");
    check(unreadVisibilityEvidence().acknowledgements.length === 0, "the unfocused wheel-scroll sequence must issue zero local acknowledgement commands");

    globalThis.__KAIGEN_UNREAD_GEOMETRY_STAGE__ = undefined;
    globalThis.__KAIGEN_ACTUAL_APP_UNREAD_RESULT__ = {
      ok: true,
      assertions,
      details: {
        unreadCount: 2,
        shortMessageId: unreadFixture.messageId,
        longMessageId: longUnreadId,
        shrink: shrinkGeometry,
      },
    };
  } catch (error) {
    globalThis.__KAIGEN_ACTUAL_APP_UNREAD_RESULT__ = {
      ok: false,
      assertions,
      error: error instanceof Error ? error.stack ?? error.message : String(error),
    };
  }
  return globalThis.__KAIGEN_ACTUAL_APP_UNREAD_RESULT__;
}

export async function runActualAppRichScenario(): Promise<RichUiResult> {
  assertions = 0;
  try {
    document.querySelector<HTMLButtonElement>('button[aria-label="Закрыть поиск"]')?.click();
    prepareRichUiScenario();

    const carol = await waitFor(() => contactButton("QA Carol"), 2_000, "Carol contact");
    carol.click();
    await waitFor(() => carol.classList.contains("selected") ? true : undefined, 2_000, "Carol chat selection");

    const scroller = await waitFor(() => document.querySelector<HTMLElement>(".message-scroll") ?? undefined, 2_000, "message scroller");
    const frozenId = geometryMessageId(1, 0);
    const offscreenId = geometryMessageId(1, 1);
    const eligibleId = geometryMessageId(1, 50);
    const frozen = await waitFor(() => document.querySelector<HTMLElement>(`[data-message-key="${frozenId}"]`) ?? undefined, 3_000, "51st frozen reaction row");
    const offscreen = await waitFor(() => document.querySelector<HTMLElement>(`[data-message-key="${offscreenId}"]`) ?? undefined, 2_000, "offscreen reaction target");
    const eligible = await waitFor(() => document.querySelector<HTMLElement>(`[data-message-key="${eligibleId}"]`) ?? undefined, 2_000, "eligible reaction row");
    check(document.querySelector(".composer-formatting-toolbar") === null, "formatting must not occupy the composer toolbar");

    const frozenHeart = frozen.querySelector<HTMLElement>('.reaction-chip[aria-label^="Сердце:"]');
    check(frozenHeart !== null, "the 51st message must retain its already received reaction");
    check(frozen.querySelector(".message-reaction-bar button") === null, "the retained reaction on the 51st message must be display-only");
    check(document.querySelector(".reaction-add") === null, "reaction mutation must not expose an inline plus anywhere in the chat");
    check(document.querySelector(".message-reaction-bar button") === null, "all visible reaction bars must remain noninteractive");

    let eligibleMenuCount = 0;
    let quoteMenuCount = 0;
    let frozenPickerVisible = false;
    for (let index = 0; index < 51; index += 1) {
      const row = document.querySelector<HTMLElement>(`[data-message-key="${geometryMessageId(1, index)}"]`);
      if (!row) throw new Error(`reaction eligibility row ${index} is not rendered`);
      const { menu } = await openMessageContextMenu(row, `reaction eligibility row ${index}`);
      const actions = reactionActions(menu);
      if (quoteAction(menu)) quoteMenuCount += 1;
      if (actions.length) {
        if (actions.length !== 6 || actions.some((button) => !button.getAttribute("aria-label") || button.getAttribute("aria-checked") !== "false")) {
          throw new Error(`reaction eligibility row ${index} exposed an invalid six-action picker`);
        }
        eligibleMenuCount += 1;
      }
      if (index === 0) frozenPickerVisible = actions.length > 0;
      await closeMessageContextMenu(`reaction eligibility row ${index}`);
    }
    check(eligibleMenuCount === 50, "exactly the latest 50 of 51 messages must expose reaction actions through their context menus");
    check(quoteMenuCount === 51, "the Quote action must remain available in every message context menu");
    check(!frozenPickerVisible, "the 51st message must not expose a reaction picker in its context menu");

    await waitFor(() => isFullyVisible(scroller, eligible) ? true : undefined, 2_000, "visible trusted reaction target");
    let messageGestureStage: MessageContextGestureStage | undefined;
    const observeMessageGesture = (event: MouseEvent) => {
      if (!messageGestureStage || !(event.target instanceof Node) || !eligible.contains(event.target)) return;
      if (event.type === "mousedown") messageGestureStage.trustedPress = event.isTrusted;
      if (event.type === "mouseup") messageGestureStage.trustedRelease = event.isTrusted;
      if (event.type === "contextmenu") messageGestureStage.trustedContextMenu = event.isTrusted;
    };
    const messageTargetBounds = eligible.getBoundingClientRect();
    const messageTargetPoint = {
      x: messageTargetBounds.left + Math.min(80, messageTargetBounds.width / 2),
      y: messageTargetBounds.top + Math.min(24, messageTargetBounds.height / 2),
    };
    const ownMessagePlatform = Object.getOwnPropertyDescriptor(navigator, "platform");
    document.addEventListener("mousedown", observeMessageGesture, true);
    document.addEventListener("mouseup", observeMessageGesture, true);
    document.addEventListener("contextmenu", observeMessageGesture, true);
    try {
      messageGestureStage = { phase: "right-ready", ...messageTargetPoint, trustedPress: false, trustedRelease: false, trustedContextMenu: false };
      globalThis.__KAIGEN_MESSAGE_CONTEXT_STAGE__ = messageGestureStage;
      await waitFor(() => messageGestureStage?.phase === "right-complete" ? true : undefined, 3_000, "trusted message right-click input");
      const rightMenu = await waitFor(() => document.querySelector<HTMLElement>(".restricted-context-menu") ?? undefined, 1_000, "trusted message right-click menu");
      const rightActions = reactionActions(rightMenu);
      check(messageGestureStage.trustedPress && messageGestureStage.trustedRelease && messageGestureStage.trustedContextMenu, "CDP must deliver a trusted message right-click sequence");
      check(quoteAction(rightMenu) !== undefined, "trusted message right-click must preserve Quote");
      check(rightActions.length === 6, "trusted message right-click must expose exactly six reaction actions");
      check(new Set(rightActions.map((button) => button.getAttribute("aria-label"))).size === 6, "the six reaction actions must have distinct localized accessible names");
      rightActions[0].click();
      await waitFor(() => document.querySelector(".restricted-context-menu") ? undefined : true, 1_000, "reaction mutation menu close");
      await waitFor(() => richUiEvidence().reactions[eligibleId]?.mine?.includes("thumbs_up") ? true : undefined, 2_000, "eligible reaction mutation");
      check(richUiEvidence().reactions[eligibleId]?.mine?.includes("thumbs_up"), "the context-menu reaction action must reach the App platform adapter");

      await waitFor(() => {
        const current = document.querySelector<HTMLElement>(`[data-message-key="${eligibleId}"]`);
        return current?.querySelector('.reaction-chip.mine[aria-label^="Нравится:"]') && isFullyVisible(scroller, current) ? current : undefined;
      }, 2_000, "selected reaction chip in the current eligible row");
      await waitForTwoFrames();
      const currentEligible = document.querySelector<HTMLElement>(`[data-message-key="${eligibleId}"]`);
      if (!currentEligible?.querySelector('.reaction-chip.mine[aria-label^="Нравится:"]')) throw new Error("the selected reaction chip disappeared before trusted Control+click targeting");
      const currentEligibleBounds = currentEligible.getBoundingClientRect();
      const macMessageTargetPoint = {
        x: currentEligibleBounds.left + Math.min(80, currentEligibleBounds.width / 2),
        y: currentEligibleBounds.top + Math.min(24, currentEligibleBounds.height / 2),
      };
      const currentHit = document.elementFromPoint(macMessageTargetPoint.x, macMessageTargetPoint.y);
      if (!(currentHit instanceof Node) || !currentEligible.contains(currentHit)) throw new Error("the trusted Control+click point does not belong to the current eligible message row");

      Object.defineProperty(navigator, "platform", { configurable: true, value: "MacIntel" });
      messageGestureStage = { phase: "mac-ready", ...macMessageTargetPoint, trustedPress: false, trustedRelease: false, trustedContextMenu: false };
      globalThis.__KAIGEN_MESSAGE_CONTEXT_STAGE__ = messageGestureStage;
      await waitFor(() => messageGestureStage?.phase === "mac-complete" ? true : undefined, 3_000, "trusted message macOS control-click input");
      const macMessageMenu = await waitFor(() => document.querySelector<HTMLElement>(".restricted-context-menu") ?? undefined, 1_000, "trusted message macOS control-click menu");
      const macMessageActions = reactionActions(macMessageMenu);
      check(messageGestureStage.trustedPress && messageGestureStage.trustedRelease, "CDP must deliver a trusted Control+primary message click");
      check(quoteAction(macMessageMenu) !== undefined, "message Control-click must preserve Quote");
      check(macMessageActions.length === 6, "message Control-click must expose the same six reaction actions");
      check(macMessageActions[0]?.getAttribute("aria-checked") === "true", "message Control-click must read back the reaction selected through right-click");
      await closeMessageContextMenu("trusted message macOS control-click");
    } finally {
      document.removeEventListener("mousedown", observeMessageGesture, true);
      document.removeEventListener("mouseup", observeMessageGesture, true);
      document.removeEventListener("contextmenu", observeMessageGesture, true);
      globalThis.__KAIGEN_MESSAGE_CONTEXT_STAGE__ = undefined;
      if (ownMessagePlatform) Object.defineProperty(navigator, "platform", ownMessagePlatform);
      else delete (navigator as Navigator & { platform?: string }).platform;
    }

    const notice = await waitFor(() => document.querySelector<HTMLButtonElement>(".offscreen-reaction-notice") ?? undefined, 2_000, "offscreen reaction notice");
    check(!isVisible(scroller, offscreen), "the peer reaction fixture target must start outside the viewport");
    const navigationScroll = observeScrollEnd(scroller, 2_000, "offscreen reaction navigation scroll");
    try {
      notice.click();
      await waitFor(() => isVisible(scroller, offscreen) ? true : undefined, 2_000, "offscreen reaction navigation");
      check(isVisible(scroller, offscreen), "clicking the reaction notice must reveal its exact message UID");
      await waitFor(() => document.querySelector(".offscreen-reaction-notice") ? undefined : true, 2_000, "visible reaction notice dismissal");
      check(document.querySelector(".offscreen-reaction-notice") === null, "a notice must dismiss after its target becomes visible");
      await navigationScroll.promise;
    } finally {
      navigationScroll.cleanup();
    }
    await waitForTwoFrames();

    const text = "QA four styles";
    const textarea = document.querySelector<HTMLTextAreaElement>(".composer textarea")!;
    textarea.focus({ preventScroll: true });
    setInputValue(textarea, text);
    selectComposerRange(textarea, text.length, text.length);
    const collapsed = await openPointerTextEditMenu(textarea);
    check(collapsed.event.defaultPrevented, "secondary click must suppress the native menu");
    check(collapsed.menu.querySelector(".text-edit-formatting-group") === null, "a collapsed composer selection must not expose formatting");
    check(collapsed.menu.querySelector("[data-kaigen-format-kind]") === null, "a collapsed selection must not retain hidden formatting actions");
    await closeTextEditMenu();

    selectComposerRange(textarea, 0, text.length);
    const keyboardEvent = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "ContextMenu" });
    textarea.dispatchEvent(keyboardEvent);
    const keyboardMenu = await waitFor(() => document.querySelector<HTMLElement>(".text-edit-context-menu") ?? undefined, 1_000, "keyboard text edit menu");
    check(keyboardEvent.defaultPrevented, "keyboard context-menu invocation must suppress the browser default");
    check(keyboardMenu.querySelector(".text-edit-formatting-group") !== null, "keyboard invocation must expose selected composer formatting");
    const keyboardButtons = formatKinds.map(formattingButton);
    check(keyboardButtons.every(Boolean), "keyboard invocation must expose all four negotiated formatting actions");
    check(document.activeElement === keyboardButtons[0], "keyboard invocation must focus the first bold formatting action");
    for (let index = 0; index < formatKinds.length; index += 1) {
      const button = keyboardButtons[index]!;
      check(button?.getAttribute("role") === "menuitemcheckbox", `${formatKinds[index]} must use menuitemcheckbox semantics`);
      check(button?.getAttribute("aria-checked") === "false", `${formatKinds[index]} must start unchecked`);
      check(button?.getAttribute("aria-label") === formatLabels[formatKinds[index]], `${formatKinds[index]} must expose its full localized label`);
    }
    await closeTextEditMenu();
    check(textarea.selectionStart === 0 && textarea.selectionEnd === text.length, "keyboard menu dismissal must preserve the selected range");

    const ownPlatform = Object.getOwnPropertyDescriptor(navigator, "platform");
    Object.defineProperty(navigator, "platform", { configurable: true, value: "MacIntel" });
    let macStage: MacControlClickStage | undefined;
    const observeMacMouse = (event: MouseEvent) => {
      if (!event.ctrlKey || event.button !== 0 || !macStage) return;
      if (event.type === "mousedown" && event.target === textarea) macStage.trustedPress = event.isTrusted;
      if (event.type === "mouseup") macStage.trustedRelease = event.isTrusted;
    };
    try {
      selectComposerRange(textarea, 0, text.length, "backward");
      const bounds = textarea.getBoundingClientRect();
      macStage = {
        phase: "ready",
        x: bounds.left + Math.min(120, bounds.width / 2),
        y: bounds.top + Math.min(18, bounds.height / 2),
        value: textarea.value,
        start: textarea.selectionStart,
        end: textarea.selectionEnd,
        direction: textarea.selectionDirection,
        trustedPress: false,
        trustedRelease: false,
      };
      globalThis.__KAIGEN_MAC_CTRL_CLICK_STAGE__ = macStage;
      document.addEventListener("mousedown", observeMacMouse, true);
      document.addEventListener("mouseup", observeMacMouse, true);
      await waitFor(() => macStage?.phase === "complete" ? true : undefined, 3_000, "trusted macOS control-click input");
      await waitFor(() => document.querySelector(".text-edit-formatting-group") ? true : undefined, 1_000, "macOS control-click formatting menu");
      const nativeFollowup = new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        button: 0,
        ctrlKey: true,
        clientX: 480,
        clientY: 620,
      });
      textarea.dispatchEvent(nativeFollowup);
      check(nativeFollowup.defaultPrevented, "the native contextmenu follow-up must remain suppressed");
      check(document.querySelectorAll(".text-edit-context-menu").length === 1, "macOS control-click and native follow-up must share one menu portal");
      check(document.querySelectorAll(".text-edit-formatting-group").length === 1, "macOS control-click must not duplicate formatting actions");
    } finally {
      document.removeEventListener("mousedown", observeMacMouse, true);
      document.removeEventListener("mouseup", observeMacMouse, true);
      globalThis.__KAIGEN_MAC_CTRL_CLICK_STAGE__ = undefined;
      if (ownPlatform) Object.defineProperty(navigator, "platform", ownPlatform);
      else delete (navigator as Navigator & { platform?: string }).platform;
    }
    await closeTextEditMenu();
    check(textarea.selectionStart === 0 && textarea.selectionEnd === text.length, "macOS control-click must preserve the selected range");
    check(textarea.value === text, "macOS control-click must not mutate the draft before a formatting action");

    selectComposerRange(textarea, 0, text.length);
    const backgroundMenu = await openPointerTextEditMenu(textarea);
    const backgroundBold = formattingButton("bold");
    check(backgroundMenu.menu.querySelector(".text-edit-formatting-group") !== null && backgroundBold !== null, "same-chat rerender fixture must capture the bold formatting action");
    geometryEmitFriendStatus(1, "away");
    await waitFor(() => contactButton("QA Carol")?.querySelector(".chat-status.away") ? true : undefined, 1_000, "same-chat backend status rerender");
    check(document.querySelector(".text-edit-context-menu") === backgroundMenu.menu, "a same-chat backend rerender must keep the selected text-edit menu open");
    check(backgroundBold.isConnected, "a same-chat backend rerender must preserve the formatting owner");
    check(textarea.selectionStart === 0 && textarea.selectionEnd === text.length, "a same-chat backend rerender must preserve the selected range");
    backgroundBold.click();
    await waitFor(() => document.querySelector(".text-edit-context-menu") ? undefined : true, 1_000, "same-chat rerender formatting close");
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    check(textarea.selectionStart === 0 && textarea.selectionEnd === text.length, "formatting after a same-chat rerender must restore the exact range");
    const afterBackground = await openPointerTextEditMenu(textarea);
    check(formattingButton("bold")?.getAttribute("aria-checked") === "true", "formatting must apply after a same-chat backend rerender");
    await closeTextEditMenu();
    geometryEmitFriendStatus(1, "online");
    await waitFor(() => contactButton("QA Carol")?.querySelector(".chat-status.online") ? true : undefined, 1_000, "same-chat backend status restore");

    for (const kind of formatKinds.slice(1)) {
      selectComposerRange(textarea, 0, text.length);
      const { menu } = await openPointerTextEditMenu(textarea);
      check(menu.querySelector(".text-edit-formatting-group") !== null, "a selected negotiated composer must expose formatting in the text-edit menu");
      const button = formattingButton(kind);
      check(button !== null && !button.disabled, `${kind} formatting action must be enabled for a nonempty selection`);
      check(button.getAttribute("aria-checked") === "false", `${kind} must be unchecked before applying`);
      button.click();
      await waitFor(() => document.querySelector(".text-edit-context-menu") ? undefined : true, 1_000, `${kind} menu close`);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      check(textarea.selectionStart === 0 && textarea.selectionEnd === text.length, `${kind} must restore the exact selected range`);
    }

    const fullyFormatted = await openPointerTextEditMenu(textarea);
    const finalButtons = formatKinds.map(formattingButton);
    check(finalButtons.every((button) => button?.getAttribute("aria-checked") === "true"), "the reopened menu must report all four applied formats");
    check(fullyFormatted.menu.querySelectorAll("[data-kaigen-format-kind]").length === 4, "the formatting group must contain exactly four actions");
    await closeTextEditMenu();

    const send = document.querySelector<HTMLButtonElement>(".composer .send")!;
    send.click();
    await new Promise(requestAnimationFrame);
    check(textarea.value === "", "submit must clear the only draft synchronously");
    check(send.disabled, "the cleared composer must remain guarded while the immutable send operation is pending");
    check(richUiEvidence().latestSendArgs === undefined, "draft clear must precede backend completion");

    const sent = await waitFor(() => richUiEvidence().latestSendArgs, 2_000, "formatted send payload");
    check(sent.text === text, "formatted submit must preserve the plain message text");
    check(Array.isArray(sent.formatting) && sent.formatting.length === 4, "formatted submit must send exactly four spans");
    const kinds = sent.formatting.map((span: { kind: string }) => span.kind).sort();
    check(JSON.stringify(kinds) === JSON.stringify(["bold", "italic", "strikethrough", "underline"]), "formatted submit must send bold, underline, italic and strike codes");
    check(sent.formatting.every((span: { offsetUtf16: number; lengthUtf16: number }) => span.offsetUtf16 === 0 && span.lengthUtf16 === text.length), "every formatting span must address the selected UTF-16 range");

    const formattedId = geometryMessageId(1, 51);
    const formatted = await waitFor(() => document.querySelector<HTMLElement>(`[data-message-key="${formattedId}"]`) ?? undefined, 3_000, "formatted message bubble");
    const semanticFormatting = ["strong", "u", "em", "s"].map((tag) => formatted.querySelector<HTMLElement>(tag));
    check(semanticFormatting.every(Boolean), "the App bubble must render safe strong/u/em/s elements");
    check(semanticFormatting.every((element) => element?.textContent === text), "every formatted element must retain exact plaintext");
    const agedOutMenu = (await openMessageContextMenu(offscreen, "aged-out reaction row")).menu;
    await waitFor(() => reactionActions(agedOutMenu).length === 0 ? true : undefined, 2_000, "reaction age-out after append");
    check(reactionActions(agedOutMenu).length === 0, "appending a message must remove reaction actions from the previous last-50 edge");
    check(quoteAction(agedOutMenu) !== undefined, "an aged-out message must keep Quote in its context menu");
    check(offscreen.querySelector<HTMLElement>('.reaction-chip[aria-label^="Сердце:"]') !== null, "an aged-out existing reaction must remain visible");
    check(offscreen.querySelector(".message-reaction-bar button") === null, "an aged-out existing reaction must remain display-only");
    await closeMessageContextMenu("aged-out reaction row");

    const staleOwnerText = "stale formatting owner";
    setInputValue(textarea, staleOwnerText);
    selectComposerRange(textarea, 0, staleOwnerText.length);
    await openPointerTextEditMenu(textarea);
    const staleBold = formattingButton("bold");
    check(staleBold !== null, "owner-change fixture must capture the old composer formatting action");
    const bob = await waitFor(() => contactButton("QA Bob"), 2_000, "Bob contact");
    bob.click();
    await waitFor(() => bob.classList.contains("selected") && textarea.value === "" ? true : undefined, 2_000, "Bob chat selection");
    const nextOwnerText = "new formatting owner";
    setInputValue(textarea, nextOwnerText);
    selectComposerRange(textarea, 0, nextOwnerText.length);
    if (staleBold.isConnected) staleBold.click();
    await waitFor(() => document.querySelector(".text-edit-context-menu") ? undefined : true, 1_000, "stale owner menu close");
    check(!staleBold.isConnected, "an owner change must retire the old formatting action");
    check(textarea.value === nextOwnerText, "a stale formatting action must not alter the new chat draft");
    check(textarea.selectionStart === 0 && textarea.selectionEnd === nextOwnerText.length, "a stale action must not restore the previous owner's selection");
    await openPointerTextEditMenu(textarea);
    check(formattingButton("bold")?.getAttribute("aria-checked") === "false", "a stale formatting action must not mutate the new owner's formatting");
    await closeTextEditMenu();

    const dave = await waitFor(() => contactButton("QA Dave"), 2_000, "Dave contact");
    dave.click();
    const legacyId = geometryMessageId(2, 7);
    const legacy = await waitFor(() => document.querySelector<HTMLElement>(`[data-message-key="${legacyId}"]`) ?? undefined, 3_000, "unsupported peer row");
    await waitFor(() => dave.classList.contains("selected") && textarea.isConnected && textarea.value === "" ? true : undefined, 2_000, "unsupported composer ownership");
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const unsupportedText = "unsupported formatting";
    setInputValue(textarea, unsupportedText);
    selectComposerRange(textarea, 0, unsupportedText.length);
    const unsupportedMenu = await openPointerTextEditMenu(textarea);
    check(unsupportedMenu.menu.querySelector(".text-edit-formatting-group") === null, "an unsupported peer must not expose a formatting group");
    check(unsupportedMenu.menu.querySelector("[data-kaigen-format-kind]") === null, "an unsupported peer must not expose formatting actions");
    await closeTextEditMenu();
    check(document.querySelector(".composer-formatting-toolbar") === null, "an unsupported peer must not restore toolbar formatting controls");
    const unsupportedMessageMenu = (await openMessageContextMenu(legacy, "unsupported peer row")).menu;
    check(reactionActions(unsupportedMessageMenu).length === 0, "an unsupported peer must not expose reaction actions in the message context menu");
    check(quoteAction(unsupportedMessageMenu) !== undefined, "an unsupported peer message must keep Quote");
    check(document.querySelector(".reaction-add") === null, "an unsupported peer must not restore any inline reaction control");
    await closeMessageContextMenu("unsupported peer row");
    check(legacy.querySelector("strong, u, em, s") === null, "legacy content must ignore unsupported formatting metadata");

    globalThis.__KAIGEN_ACTUAL_APP_RICH_RESULT__ = {
      ok: true,
      assertions,
      details: {
        reactionContextMenus: 50,
        frozenId,
        offscreenId,
        formattedId,
        formattingKinds: kinds.join(","),
      },
    };
  } catch (error) {
    globalThis.__KAIGEN_ACTUAL_APP_RICH_RESULT__ = {
      ok: false,
      assertions,
      error: error instanceof Error ? error.stack ?? error.message : String(error),
    };
  }
  return globalThis.__KAIGEN_ACTUAL_APP_RICH_RESULT__;
}
