import { geometryAppendMessage, geometryOpenedUrls } from "./app-platform";

declare const __KAIGEN_CHAT_GEOMETRY_TIMEOUT_SCALE__: number;

type Gesture = "right" | "mac" | "click" | "middle" | "enter" | "context" | "shiftf10" | "capture";
type LinkStage = { id: number; kind: Gesture; x: number; y: number; done: boolean; name?: string };
type LinkResult = { ok: boolean; assertions: number; cases: Record<string, unknown>[]; error?: string };
declare global {
  var __KAIGEN_LINK_STAGE__: LinkStage | undefined;
  var __KAIGEN_LINK_RESULT__: LinkResult | undefined;
}

async function waitFor<T>(read: () => T | undefined, label: string, timeout = 3_000): Promise<T> {
  const budgetMs = timeout * __KAIGEN_CHAT_GEOMETRY_TIMEOUT_SCALE__;
  const deadline = performance.now() + budgetMs;
  while (performance.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${label} timed out after ${budgetMs}ms`);
}

function waitForOwner<T>(read: () => T | undefined, label: string): Promise<T> {
  // The owner may perform several CDP actions before acknowledging. Its parent
  // aggregate deadline remains the outer bound; waitFor applies the scale once.
  return waitFor(read, label, 30_000);
}

export async function runActualAppLinksScenario(): Promise<LinkResult> {
  let assertions = 0;
  const cases: Record<string, unknown>[] = [];
  const check = (value: unknown, label: string) => { assertions += 1; if (!value) throw new Error(label); };
  const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  const platformDescriptor = Object.getOwnPropertyDescriptor(navigator, "platform");
  const copied: string[] = [];
  let sequence = 0;
  let shell: HTMLElement | undefined;
  let scroller: HTMLElement | undefined;
  let previousFont = "";
  let previousWidth = "";
  const menu = () => document.querySelector<HTMLElement>(".restricted-context-menu");
  const menuButton = (text: string) => [...(menu()?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((button) => button.textContent === text);
  const closeMenu = async () => {
    document.querySelector<HTMLElement>(".conversation-header")!.click();
    await waitFor(() => !menu() ? true : undefined, "menu dismissed");
  };
  const gesture = async (kind: Gesture, target: HTMLElement, name?: string) => {
    target.scrollIntoView({ block: "nearest" });
    if (["enter", "context", "shiftf10"].includes(kind)) target.focus();
    const bounds = target.getBoundingClientRect();
    let trusted = false;
    const event = kind === "right" ? "contextmenu" : ["enter", "context", "shiftf10"].includes(kind) ? "keydown" : kind === "middle" ? "auxclick" : "click";
    const receive = (input: Event) => { trusted ||= input.isTrusted; };
    // The main capture handler consumes macOS Ctrl+click before the link target.
    document.addEventListener(event, receive, true);
    const stage = { id: ++sequence, kind, x: bounds.left + Math.min(8, bounds.width / 2), y: bounds.top + Math.min(8, bounds.height / 2), done: false, name };
    globalThis.__KAIGEN_LINK_STAGE__ = stage;
    try {
      await waitForOwner(() => stage.done ? true : undefined, `trusted ${kind} gesture`);
      if (kind !== "capture") check(trusted, `${kind} must use trusted browser input`);
    } finally { document.removeEventListener(event, receive, true); }
  };
  try {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => { copied.push(value); } } });
    const url = `https://example.test/${"long-path-segment/".repeat(100)}?query=${"0123456789".repeat(160)}!#complete-fragment!?`;
    const text = `Before (${url}). After`;
    const id = geometryAppendMessage(3, text, [{ kind: "bold", offsetUtf16: 8, lengthUtf16: 60 }, { kind: "italic", offsetUtf16: 16, lengthUtf16: 25 }]);
    const shortId = geometryAppendMessage(3, "Short https://x.io done; www.example.test/page.");
    const unsafeId = geometryAppendMessage(3, '<script>alert(1)</script> javascript:alert(1) file:///tmp/a https://user@example.test and plain text');
    shell = await waitFor(() => document.querySelector<HTMLElement>(".app-shell") ?? undefined, "actual App root", 5_000);
    const erin = await waitFor(() => [...document.querySelectorAll<HTMLButtonElement>(".chat-item")].find((button) => button.textContent?.includes("Erin")), "Erin contact");
    erin.click();
    const message = await waitFor(() => document.querySelector<HTMLElement>(`[data-message-key="${id}"]`) ?? undefined, "actual link message");
    const link = message.querySelector<HTMLAnchorElement>(".chat-message-link")!;
    const label = link.querySelector<HTMLElement>(".chat-message-link-label")!;
    const short = document.querySelector<HTMLAnchorElement>(`[data-message-key="${shortId}"] .chat-message-link`)!;
    scroller = document.querySelector<HTMLElement>(".message-scroll")!;
    previousFont = shell.style.getPropertyValue("--chat-font-size");
    previousWidth = scroller.style.width;
    check(link.getAttribute("href") === url && link.title === url && link.getAttribute("aria-label") === url, "href, title and accessible name retain the entire path, query and fragment");
    check(message.querySelector(".message-text")?.textContent === text, "rendering never changes the original text or its punctuation");
    check(link.textContent === url && !!link.querySelector("strong") && !!link.querySelector("em"), "one URL retains original text and overlapping formatting");
    check(document.querySelector(`[data-message-key="${unsafeId}"] .message-text`)?.querySelectorAll("a,script").length === 0, "untrusted HTML and unsafe addresses render only as text");
    check(document.querySelectorAll(`[data-message-key="${shortId}"] a`)[1]?.getAttribute("href") === "https://www.example.test/page", "www opens its complete HTTPS target without final punctuation");

    for (const width of [360, 760]) for (const font of [15, 28]) {
      scroller.style.width = `${width}px`;
      shell.style.setProperty("--chat-font-size", `${font}px`);
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const style = getComputedStyle(label);
      const rect = label.getBoundingClientRect();
      const lineHeight = parseFloat(style.lineHeight);
      const shortRect = short.getBoundingClientRect();
      const intrinsic = short.cloneNode(true) as HTMLElement;
      Object.assign(intrinsic.style, { position: "absolute", visibility: "hidden", width: "max-content", maxWidth: "none" });
      short.parentElement!.append(intrinsic);
      const intrinsicWidth = intrinsic.getBoundingClientRect().width;
      intrinsic.remove();
      const shortContentWidth = short.parentElement!.getBoundingClientRect().width;
      const contentRect = message.querySelector(".message-text")!.getBoundingClientRect();
      check(parseFloat(style.fontSize) === font, `real chat font is ${font}px`);
      check(rect.height > lineHeight && rect.height <= 2 * lineHeight + 1, `${width}/${font}: long URL is at most two actual lines, got ${rect.height}/${lineHeight}`);
      check(style.webkitLineClamp === "2" && style.overflow === "hidden" && label.scrollHeight > rect.height + lineHeight, `${width}/${font}: overflowing complete text is line-clamped with ellipsis`);
      check(rect.width <= contentRect.width + 1 && scroller.scrollWidth <= scroller.clientWidth + 1, `${width}/${font}: the link does not overflow the message or history horizontally`);
      check(shortRect.height <= (intrinsicWidth <= shortContentWidth + 1 ? lineHeight : 2 * lineHeight) + 1 && short.querySelector<HTMLElement>(".chat-message-link-label")!.scrollHeight <= shortRect.height + 1, `${width}/${font}: short URL is not clipped and stays on one line whenever it fits (${shortRect.width}x${shortRect.height}; intrinsic=${intrinsicWidth}; available=${shortContentWidth})`);
      check(link.href === url && link.textContent === url, `${width}/${font}: clamping does not shorten the target or message`);
      cases.push({ width, font, actualWidth: rect.width, height: rect.height, lineHeight, scrollHeight: label.scrollHeight, shortHeight: shortRect.height, shortIntrinsicWidth: intrinsicWidth, shortContentWidth });
      await gesture("capture", link, `chat-link-${width}-${font}.png`);
    }
    scroller.style.width = previousWidth;
    shell.style.setProperty("--chat-font-size", previousFont);

    document.querySelector<HTMLButtonElement>('button[aria-label="Поиск"]')!.click();
    const search = await waitFor(() => document.querySelector<HTMLInputElement>('input[aria-label="Поиск в чате"]') ?? undefined, "search control");
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "example");
    search.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "example" }));
    const marked = await waitFor(() => message.querySelector<HTMLElement>(".chat-message-link mark strong") ?? undefined, "formatted search hit within the link");
    check(message.querySelectorAll("a.chat-message-link").length === 1 && link.href === url && message.querySelector(".message-text")?.textContent === text, "search preserves a single complete link and message");

    for (const kind of ["right", "context", "shiftf10", "mac"] as const) {
      if (kind === "mac") Object.defineProperty(navigator, "platform", { configurable: true, value: "MacIntel" });
      await gesture(kind, kind === "right" ? marked : link);
      const copyLink = await waitFor(() => menuButton("Скопировать ссылку"), `${kind}: Copy link action`);
      check(!!menuButton("Скопировать") && !!menuButton("Цитировать") && menu()?.querySelectorAll(".reaction-palette > button").length === 6, `${kind}: existing copy, quote and reaction actions remain`);
      copyLink.click();
      await waitFor(() => !menu() ? true : undefined, `${kind}: copy dismisses menu`);
      check(copied.at(-1) === url, `${kind}: clipboard receives full original href, never the two-line label`);
      check(geometryOpenedUrls.length === 0, `${kind}: context gesture does not open the URL`);
    }
    if (platformDescriptor) Object.defineProperty(navigator, "platform", platformDescriptor); else delete (navigator as unknown as Record<string, unknown>).platform;
    const plain = document.querySelector<HTMLElement>(`[data-message-key="${unsafeId}"] .message-text`)!;
    await gesture("right", plain);
    await waitFor(() => menu() ?? undefined, "plain message menu");
    check(!menuButton("Скопировать ссылку") && !!menuButton("Скопировать") && !!menuButton("Цитировать"), "normal text retains its menu without Copy link");
    await closeMenu();
    for (const kind of ["click", "enter", "middle"] as const) {
      const before = geometryOpenedUrls.length;
      await gesture(kind, link);
      await waitFor(() => geometryOpenedUrls.length === before + 1 ? true : undefined, `${kind}: common platform opener`);
      check(geometryOpenedUrls.at(-1) === url, `${kind}: opener receives full URL`);
    }
    check(copied.length === 4 && location.pathname === "/app.html", "four exact copies and link activation preserve the chat document");
    const result = { ok: true, assertions, cases };
    globalThis.__KAIGEN_LINK_RESULT__ = result;
    return result;
  } catch (error) {
    const result = { ok: false, assertions, cases, error: error instanceof Error ? error.stack : String(error) };
    globalThis.__KAIGEN_LINK_RESULT__ = result;
    return result;
  } finally {
    if (clipboardDescriptor) Object.defineProperty(navigator, "clipboard", clipboardDescriptor); else delete (navigator as unknown as Record<string, unknown>).clipboard;
    if (platformDescriptor) Object.defineProperty(navigator, "platform", platformDescriptor); else delete (navigator as unknown as Record<string, unknown>).platform;
    if (shell && previousFont) shell.style.setProperty("--chat-font-size", previousFont);
    if (scroller) scroller.style.width = previousWidth;
    globalThis.__KAIGEN_LINK_STAGE__ = undefined;
  }
}
