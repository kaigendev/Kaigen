import { composer as getComposer, setComposerDraft, type TestComposer } from "./composer-test-adapter";
import { geometryAppendImage, geometryAppendMessage, geometrySetMenuProfiles } from "./app-platform";

declare const __KAIGEN_CHAT_GEOMETRY_TIMEOUT_SCALE__: number;

type MenuResult = { ok: boolean; assertions: number; cases: Record<string, unknown>[]; error?: string };
declare global { var __KAIGEN_ACTUAL_APP_MENU_RESULT__: MenuResult | undefined; }

const menuSelector = ".rail-profile-menu,.status-menu,.inactive-profile-status-menu,.contact-menu,.contact-context-menu,.text-edit-context-menu,.spellcheck-context-menu,.web-menu nav";
const twoFrames = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

async function waitFor<T>(read: () => T | undefined, label: string, timeout = 3_000): Promise<T> {
  const deadline = performance.now() + timeout * __KAIGEN_CHAT_GEOMETRY_TIMEOUT_SCALE__;
  while (performance.now() < deadline) {
    const result = read();
    if (result !== undefined) return result;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`${label} timed out`);
}

function context(target: HTMLElement, point?: { x: number; y: number }) {
  const bounds = target.getBoundingClientRect();
  // Deliberately omit pointerdown: keyboard/platform context entry points must
  // close the old owner themselves, independent of outside-click listeners.
  target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true,
    button: 2, clientX: point?.x ?? bounds.left + 8, clientY: point?.y ?? bounds.top + 8 }));
}

async function setDraft(textarea: TestComposer, value: string) {
  textarea.focus({ preventScroll: true });
  setComposerDraft(textarea, value);
  await waitFor(() => textarea.value === value ? true : undefined, "draft render");
}

export async function runActualAppMenuScenario(): Promise<MenuResult> {
  let assertions = 0;
  const cases: Record<string, unknown>[] = [];
  const check = (value: unknown, label: string) => { assertions += 1; if (!value) throw new Error(label); };
  const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  const execCommandDescriptor = Object.getOwnPropertyDescriptor(document, "execCommand");
  let shell: HTMLElement | undefined;
  let scroller: HTMLElement | undefined;
  let previousFont = "";
  let previousWidth = "";
  let originalDraft: string | undefined;
  const oneMenu = async (selector: string, label: string) => {
    const element = await waitFor(() => document.querySelector<HTMLElement>(selector) ?? undefined, label);
    await twoFrames();
    check(document.querySelectorAll(menuSelector).length === 1, `${label}: only the newly opened menu remains`);
    return element;
  };
  try {
    shell = await waitFor(() => document.querySelector<HTMLElement>(".app-shell") ?? undefined, "actual App");
    previousFont = shell.style.getPropertyValue("--chat-font-size");
    geometrySetMenuProfiles(true);
    const profile = await waitFor(() => document.querySelector<HTMLButtonElement>('.profile-switcher-item[data-profile-id="qa-profile-b"]') ?? undefined, "second disposable profile");
    const carol = await waitFor(() => [...document.querySelectorAll<HTMLButtonElement>(".chat-item")].find((button) => button.textContent?.includes("QA Carol")), "Carol contact");
    const textId = geometryAppendMessage(1, "Quote focus and exclusive menu fixture");
    carol.click();
    const message = await waitFor(() => document.querySelector<HTMLElement>(`[data-message-key="${textId}"]`) ?? undefined, "fresh negotiated message");
    scroller = document.querySelector<HTMLElement>(".message-scroll")!;
    previousWidth = scroller.style.width;
    const textarea = getComposer()!;
    originalDraft = textarea.value;
    const status = document.querySelector<HTMLButtonElement>(".rail-status-label")!;
    const profileMenu = document.querySelector<HTMLButtonElement>(".rail-profile-menu-button")!;
    const contactMenu = document.querySelector<HTMLButtonElement>(".header-actions .more-actions > button")!;

    status.click();
    await oneMenu(".status-menu", "status menu");
    status.click();
    await twoFrames();
    check(document.querySelectorAll(menuSelector).length === 0, "repeated activation closes the current status toggle");
    status.click();
    await oneMenu(".status-menu", "status reopens after its toggle closed");
    context(profile);
    await oneMenu(".inactive-profile-status-menu", "profile context replaces status");
    profile.focus({ preventScroll: true });
    profile.dispatchEvent(new KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true, cancelable: true }));
    await oneMenu(".inactive-profile-status-menu", "profile keyboard context survives ancestor handlers");
    status.click();
    await oneMenu(".status-menu", "status replaces profile portal");
    profileMenu.click();
    await oneMenu(".rail-profile-menu", "profile management replaces status");
    context(carol);
    await oneMenu(".contact-context-menu:not(.restricted-context-menu)", "contact context replaces management");
    contactMenu.click();
    await oneMenu(".contact-menu", "contact actions replace context");

    await setDraft(textarea, "Keep this draft");
    textarea.setSelectionRange(5, 9, "backward");
    textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "ContextMenu", bubbles: true, cancelable: true }));
    await oneMenu(".text-edit-context-menu", "keyboard editor replaces contact actions");
    context(message, { x: innerWidth - 2, y: innerHeight - 2 });
    let current = await oneMenu(".restricted-context-menu", "message context replaces editor portal");
    const palette = current.querySelector<HTMLElement>(".reaction-palette")!;
    check(palette && current.lastElementChild === palette, "reaction palette is the last child after every menu action");
    check(palette.querySelectorAll('button[role="menuitemcheckbox"]').length === 6, "all six reactions remain available");
    const actions = [...current.children].filter((child) => child instanceof HTMLButtonElement) as HTMLButtonElement[];
    check(actions.length > 0 && palette.getBoundingClientRect().top >= Math.max(...actions.map((action) => action.getBoundingClientRect().bottom)) - 1, "palette is visually below all action rows");
    const menuBounds = current.getBoundingClientRect();
    check(menuBounds.top >= 0 && menuBounds.left >= 0 && menuBounds.right <= innerWidth && menuBounds.bottom <= innerHeight, "bottom-corner invocation keeps the complete menu inside the viewport");

    const headerTop = document.querySelector(".conversation-header")!.getBoundingClientRect().top;
    const outerTop = shell.scrollTop;
    for (let repeated = 0; repeated < 2; repeated += 1) {
      if (repeated) { context(message); current = await oneMenu(".restricted-context-menu", "repeat quote menu"); }
      const quote = [...current.querySelectorAll<HTMLButtonElement>("button")].find((button) => /^(Цитировать|Quote)$/u.test(button.textContent ?? ""))!;
      quote.focus({ preventScroll: true });
      check(document.activeElement === quote, "quote action begins with focus outside the composer");
      quote.click();
      await waitFor(() => !document.querySelector(".restricted-context-menu") ? true : undefined, "quoted menu closes");
      check(document.activeElement === textarea, "quote and repeated quote transfer focus into the message input");
      check(textarea.value === "Keep this draft", "quoting preserves the existing draft");
    }
    check(!!document.querySelector(".composer-reply-preview"), "the quoted message remains in the composer");
    check(shell.scrollTop === outerTop && document.querySelector(".conversation-header")!.getBoundingClientRect().top === headerTop, "quote focus never scrolls the outer application or header");

    // A late clipboard request from a dismissed menu must not edit the draft,
    // restore its old focus, display an error, or close the replacement menu.
    Object.defineProperty(document, "execCommand", { configurable: true, value: () => false });
    for (const command of ["paste", "cut", "reject"] as const) {
      let finish: ((value: string) => void) | undefined;
      let fail: ((reason: Error) => void) | undefined;
      const pending = new Promise<string>((resolve, reject) => { finish = resolve; fail = reject; });
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
        readText: () => pending, writeText: () => pending,
      } });
      textarea.focus({ preventScroll: true });
      textarea.setSelectionRange(0, 4, "backward");
      context(textarea);
      const editor = await oneMenu(".text-edit-context-menu", `pending ${command} menu`);
      const action = [...editor.querySelectorAll<HTMLButtonElement>("button")].find((button) => command === "paste"
        ? /^(Вставить|Paste)$/u.test(button.textContent ?? "") : /^(Вырезать|Cut)$/u.test(button.textContent ?? ""))!;
      action.click();
      await twoFrames();
      context(message);
      const replacement = await oneMenu(".restricted-context-menu", `replace pending ${command}`);
      if (command === "reject") fail!(new Error("disposable clipboard rejection"));
      else finish!("late clipboard value");
      await twoFrames();
      check(textarea.value === "Keep this draft", `${command}: obsolete clipboard completion cannot change the draft`);
      check(document.querySelector(".restricted-context-menu") === replacement && document.querySelectorAll(menuSelector).length === 1, `${command}: obsolete completion cannot close or replace the new menu`);
    }
    document.querySelector<HTMLElement>(".conversation-header")!.click();
    document.querySelector<HTMLButtonElement>(".composer-reply-preview > button")?.click();

    // Render genuine App attachment rows, including their delivery state, at
    // both font sizes and widths. No copied markup or synthetic CSS fixture.
    const canvas = document.createElement("canvas");
    canvas.width = 320; canvas.height = 60;
    const drawing = canvas.getContext("2d")!;
    drawing.fillStyle = "#273b43"; drawing.fillRect(0, 0, 320, 60);
    drawing.fillStyle = "#8fceb0"; drawing.font = "24px sans-serif"; drawing.fillText("Full image remains visible", 10, 39);
    const imageIds = [geometryAppendImage(1, canvas.toDataURL("image/png"), true), geometryAppendImage(1, canvas.toDataURL("image/png"), false)];
    for (const id of imageIds) await waitFor(() => {
      const image = document.querySelector<HTMLImageElement>(`[data-message-key="${id}"] img`);
      return image?.complete && image.naturalWidth > 0 ? image : undefined;
    }, "rendered complete image");
    for (const width of [360, 760]) for (const font of [15, 28]) {
      scroller.style.width = `${width}px`;
      shell.style.setProperty("--chat-font-size", `${font}px`);
      await twoFrames();
      for (const [index, id] of imageIds.entries()) {
        const row = document.querySelector<HTMLElement>(`[data-message-key="${id}"]`)!;
        const image = row.querySelector("img")!.getBoundingClientRect();
        const meta = row.querySelector(".image-attachment-time")!.getBoundingClientRect();
        const card = row.getBoundingClientRect();
        check(meta.top >= image.bottom && meta.bottom <= card.bottom + 1, `image ${index}/${width}/${font}: time and delivery occupy their own row beneath the image`);
        check(meta.right <= card.right + 1 && meta.left >= card.left - 1, `image ${index}/${width}/${font}: right-aligned metadata stays inside the card`);
        cases.push({ width, font, mine: index === 0, gap: meta.top - image.bottom, footerHeight: meta.height });
      }
    }
    check(document.querySelector(`[data-message-key="${imageIds[0]}"] .image-attachment-time`)?.textContent?.includes("✓"), "delivered outgoing image keeps its factual delivery marker");
    check(!document.querySelector(`[data-message-key="${imageIds[1]}"] .image-attachment-time .delivery-state`), "incoming image receives no invented delivery marker");
    return globalThis.__KAIGEN_ACTUAL_APP_MENU_RESULT__ = { ok: true, assertions, cases };
  } catch (error) {
    return globalThis.__KAIGEN_ACTUAL_APP_MENU_RESULT__ = { ok: false, assertions, cases, error: error instanceof Error ? error.stack ?? error.message : String(error) };
  } finally {
    if (clipboardDescriptor) Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
    else delete (navigator as any).clipboard;
    if (execCommandDescriptor) Object.defineProperty(document, "execCommand", execCommandDescriptor);
    else delete (document as any).execCommand;
    if (shell) shell.style.setProperty("--chat-font-size", previousFont);
    if (scroller) scroller.style.width = previousWidth;
    const textarea = getComposer();
    if (textarea && originalDraft !== undefined) await setDraft(textarea, originalDraft);
    document.querySelector<HTMLElement>(".conversation-header")?.click();
    geometrySetMenuProfiles(false);
  }
}
