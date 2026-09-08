import {
  geometryEmitFriendStatus,
  geometryMessageId,
  prepareRichUiScenario,
  richUiEvidence,
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

declare global {
  var __KAIGEN_ACTUAL_APP_RICH_RESULT__: RichUiResult | undefined;
  var __KAIGEN_MAC_CTRL_CLICK_STAGE__: MacControlClickStage | undefined;
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
    const eligibleId = geometryMessageId(1, 2);
    const frozen = await waitFor(() => document.querySelector<HTMLElement>(`[data-message-key="${frozenId}"]`) ?? undefined, 3_000, "51st frozen reaction row");
    const offscreen = await waitFor(() => document.querySelector<HTMLElement>(`[data-message-key="${offscreenId}"]`) ?? undefined, 2_000, "offscreen reaction target");
    const eligible = await waitFor(() => document.querySelector<HTMLElement>(`[data-message-key="${eligibleId}"]`) ?? undefined, 2_000, "eligible reaction row");
    check(document.querySelector(".composer-formatting-toolbar") === null, "formatting must not occupy the composer toolbar");

    const frozenHeart = frozen.querySelector<HTMLButtonElement>('button[aria-label^="Сердце:"]');
    check(frozenHeart !== null, "the 51st message must retain its already received reaction");
    check(frozenHeart.disabled, "the retained reaction on the 51st message must be immutable");
    check(frozen.querySelector(".reaction-add") === null, "the 51st message must not offer a new reaction");
    const eligibleAdd = eligible.querySelector<HTMLButtonElement>(".reaction-add");
    check(eligibleAdd !== null && !eligibleAdd.disabled, "a message inside the last 50 must offer reactions");
    check(document.querySelectorAll(".message-reaction-bar .reaction-add").length === 50, "exactly the latest 50 of 51 messages must offer reaction mutation");

    eligibleAdd.click();
    const like = await waitFor(() => [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemcheckbox"]')]
      .find((button) => button.textContent?.includes("Нравится")), 1_000, "reaction palette Like option");
    like.click();
    await waitFor(() => {
      const state = richUiEvidence().reactions[eligibleId];
      return state?.mine?.includes("thumbs_up") ? true : undefined;
    }, 2_000, "eligible reaction mutation");
    check(richUiEvidence().reactions[eligibleId]?.mine?.includes("thumbs_up"), "the eligible reaction control must reach the App platform adapter");

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
    await waitFor(() => {
      const heart = offscreen.querySelector<HTMLButtonElement>('button[aria-label^="Сердце:"]');
      return offscreen.querySelector(".reaction-add") === null && heart?.disabled ? true : undefined;
    }, 2_000, "reaction age-out after append");
    check(offscreen.querySelector(".reaction-add") === null, "appending a message must remove mutation controls from the previous last-50 edge");
    check(offscreen.querySelector<HTMLButtonElement>('button[aria-label^="Сердце:"]')?.disabled, "an aged-out existing reaction must remain visible but immutable");

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
    check(document.querySelector(".message-reaction-bar .reaction-add") === null, "an unsupported peer must not expose reaction controls");
    check(legacy.querySelector("strong, u, em, s") === null, "legacy content must ignore unsupported formatting metadata");

    globalThis.__KAIGEN_ACTUAL_APP_RICH_RESULT__ = {
      ok: true,
      assertions,
      details: {
        reactionAdds: 50,
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
