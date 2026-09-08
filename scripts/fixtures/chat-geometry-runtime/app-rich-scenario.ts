import {
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

declare global {
  var __KAIGEN_ACTUAL_APP_RICH_RESULT__: RichUiResult | undefined;
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

function isVisible(scroller: HTMLElement, target: HTMLElement) {
  const viewport = scroller.getBoundingClientRect();
  const row = target.getBoundingClientRect();
  return row.bottom > viewport.top && row.top < viewport.bottom;
}

function contactButton(name: string) {
  return [...document.querySelectorAll<HTMLButtonElement>(".chat-item")]
    .find((button) => button.querySelector(".chat-name")?.textContent?.includes(name));
}

function formattingButton(label: string) {
  return document.querySelector<HTMLButtonElement>(`.composer-formatting-toolbar button[aria-label="${label}"]`);
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
    await waitFor(() => document.querySelector(".composer-formatting-toolbar") ? true : undefined, 2_000, "negotiated formatting toolbar");

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
    notice.click();
    await waitFor(() => isVisible(scroller, offscreen) ? true : undefined, 2_000, "offscreen reaction navigation");
    check(isVisible(scroller, offscreen), "clicking the reaction notice must reveal its exact message UID");
    await waitFor(() => document.querySelector(".offscreen-reaction-notice") ? undefined : true, 2_000, "visible reaction notice dismissal");
    check(document.querySelector(".offscreen-reaction-notice") === null, "a notice must dismiss after its target becomes visible");

    const text = "QA four styles";
    const textarea = document.querySelector<HTMLTextAreaElement>(".composer textarea")!;
    textarea.focus({ preventScroll: true });
    setInputValue(textarea, text);
    textarea.setSelectionRange(0, text.length);
    textarea.dispatchEvent(new Event("select", { bubbles: true }));
    textarea.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Shift" }));
    const labels = ["Жирный", "Подчёркнутый", "Курсив", "Зачёркнутый"];
    const formatButtons = await waitFor(() => {
      const buttons = labels.map(formattingButton);
      return buttons.every((button) => button && !button.disabled) ? buttons as HTMLButtonElement[] : undefined;
    }, 1_000, "four enabled formatting controls");
    check(formatButtons.length === 4, "negotiated Kaigen chat must expose all four formatting controls");
    for (const button of formatButtons) {
      button.click();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      check(button.getAttribute("aria-pressed") === "true", `${button.getAttribute("aria-label")} must retain the selected range before the next format is applied`);
    }

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

    const dave = await waitFor(() => contactButton("QA Dave"), 2_000, "Dave contact");
    dave.click();
    const legacyId = geometryMessageId(2, 7);
    const legacy = await waitFor(() => document.querySelector<HTMLElement>(`[data-message-key="${legacyId}"]`) ?? undefined, 3_000, "unsupported peer row");
    await new Promise((resolve) => setTimeout(resolve, 50));
    check(document.querySelector(".composer-formatting-toolbar") === null, "an unsupported peer must not expose formatting controls");
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
