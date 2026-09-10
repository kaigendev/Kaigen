import { geometryAppendImage, geometrySetTorState } from "./app-platform";

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
async function waitFor<T>(read: () => T | undefined, label: string, ms = 6000): Promise<T> {
  const deadline = performance.now() + ms;
  while (performance.now() < deadline) {
    const result = read();
    if (result !== undefined) return result;
    await delay(20);
  }
  throw new Error(`${label} timed out`);
}

export async function runActualAppAdditionsScenario() {
  let assertions = 0;
  const cases: Record<string, unknown>[] = [];
  const check = (condition: unknown, label: string) => { assertions++; if (!condition) throw new Error(label); };
  const menu = () => document.querySelector<HTMLElement>(".rail-profile-menu");
  const openMenu = async () => {
    document.querySelector<HTMLButtonElement>(".rail-profile-menu-button")!.click();
    return waitFor(() => menu() ?? undefined, "profile menu");
  };
  const torCaption = () => document.querySelector(".tor-status-line")?.textContent?.trim();
  try {
    await waitFor(() => document.querySelector(".app-shell") ?? undefined, "actual App");
    const russianMenu = await openMenu();
    check(JSON.stringify([...russianMenu.querySelectorAll("button")].map((button) => button.textContent)) === JSON.stringify(["Добавить профиль", "Настройки", "Выход"]), "profile menu has exactly the three requested actions");
    const group = document.querySelector<HTMLButtonElement>(".group-chat-button")!;
    check(group.disabled && !!group.querySelector("svg") && group.getAttribute("aria-label") === "Групповой чат", "group-chat icon is visible, named and disabled");
    check(!document.querySelector(".rail-navigation .settings-button"), "settings gear is removed from navigation");
    group.click();
    check(!!menu() && !document.querySelector(".settings-view"), "disabled group action does not navigate or dismiss the current menu");
    russianMenu.querySelectorAll<HTMLButtonElement>("button")[1].click();
    await waitFor(() => document.querySelector(".settings-view") ?? undefined, "settings from profile menu");
    check(!menu(), "settings command closes the profile menu");

    const avatarInput = document.querySelector<HTMLInputElement>('.settings-view input[type="file"]')!;
    check(!!avatarInput, "actual profile settings avatar input exists");
    const files = new DataTransfer();
    files.items.add(new File([], "empty-image.png", { type: "image/png" }));
    avatarInput.files = files.files;
    avatarInput.dispatchEvent(new Event("change", { bubbles: true }));
    const error = await waitFor(() => document.querySelector<HTMLElement>(".setting-error") ?? undefined, "actual avatar size failure");
    for (const theme of ["current", "softlifegreen"] as const) {
      document.querySelector<HTMLButtonElement>(`.theme-switch-button[data-theme="${theme}"]`)!.click();
      await frame(); await frame();
      const style = getComputedStyle(error);
      const reference = document.createElement("span");
      reference.style.cssText = "color:var(--kaigen-color-text);background:var(--kaigen-color-control)";
      error.append(reference);
      const semantic = getComputedStyle(reference);
      check(style.color === semantic.color && style.backgroundColor === semantic.backgroundColor, `${theme}: actual error uses the current semantic surface and readable text`);
      check(style.borderLeftWidth === "3px" && style.borderLeftStyle === "solid", `${theme}: error retains its distinguishing accent`);
      cases.push({ theme, errorColor: style.color, errorBackground: style.backgroundColor, errorAccent: style.borderLeftColor });
      reference.remove();
    }

    document.querySelector<HTMLButtonElement>(".chats-button")!.click();
    await waitFor(() => document.querySelector(".conversation") ?? undefined, "return to chat");
    const carol = await waitFor(() => [...document.querySelectorAll<HTMLButtonElement>(".chat-item")].find((button) => button.textContent?.includes("QA Carol")), "Carol contact");
    carol.click();
    await waitFor(() => document.querySelector('[data-kaigen-composer-editor]') ?? undefined, "Carol editor");
    geometrySetTorState("connecting", 75);
    await waitFor(() => torCaption() === "Connecting..." ? true : undefined, "Tor connecting animation");
    geometrySetTorState("connected", 100);
    await waitFor(() => torCaption() === "Done!" ? true : undefined, "Tor completion animation");
    await waitFor(() => torCaption() === "Подключен" ? true : undefined, "persistent Tor connected caption");
    await delay(1500);
    check(torCaption() === "Подключен" && document.querySelector(".tor-status-line")?.classList.contains("visible"), "connected caption stays visible after every animation and another polling tick");
    geometrySetTorState("disabled");
    await waitFor(() => torCaption() === "Отключен" ? true : undefined, "Tor disabled caption");
    check(!document.querySelector(".tor-status-running-dots"), "disabled state leaves no animated dots");

    const conversation = document.querySelector<HTMLElement>(".conversation")!;
    for (const [naturalWidth, naturalHeight, width, height] of [[6000, 1200, 760, 520], [1200, 6000, 360, 320], [120, 80, 360, 320]]) {
      const canvas = document.createElement("canvas");
      canvas.width = naturalWidth; canvas.height = naturalHeight;
      const context = canvas.getContext("2d")!;
      context.fillStyle = "#456875"; context.fillRect(0, 0, naturalWidth, naturalHeight);
      context.fillStyle = "#d4e5d8"; context.fillRect(naturalWidth / 4, naturalHeight / 4, naturalWidth / 2, naturalHeight / 2);
      const id = geometryAppendImage(1, canvas.toDataURL("image/png"));
      canvas.width = 0; canvas.height = 0;
      const imageButton = await waitFor(() => document.querySelector<HTMLButtonElement>(`[data-message-key="${id}"] .image-attachment > button`) ?? undefined, "image attachment");
      conversation.style.width = `${width}px`;
      conversation.style.height = `${height}px`;
      imageButton.focus({ preventScroll: true }); imageButton.click();
      const image = await waitFor(() => {
        const image = document.querySelector<HTMLImageElement>(".image-viewer img");
        return image?.complete && image.naturalWidth ? image : undefined;
      }, "decoded viewer image");
      await frame(); await frame();
      const bounds = image.getBoundingClientRect(), chat = conversation.getBoundingClientRect();
      check(bounds.left >= chat.left && bounds.right <= chat.right && bounds.top >= chat.top && bounds.bottom <= chat.bottom, "large image fits entirely inside the chat");
      check(Math.abs(bounds.width / bounds.height - naturalWidth / naturalHeight) < .02, "viewer preserves image aspect ratio");
      check(bounds.width <= naturalWidth && bounds.height <= naturalHeight, "small image is not enlarged");
      const viewer = document.querySelector<HTMLElement>(".image-viewer")!;
      check(viewer.scrollHeight === viewer.clientHeight && viewer.scrollWidth === viewer.clientWidth, "viewer has no clipped scrollable overflow");
      cases.push({ naturalWidth, naturalHeight, chatWidth: chat.width, chatHeight: chat.height, imageWidth: bounds.width, imageHeight: bounds.height });
      viewer.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" }));
      await frame();
      check(!document.querySelector(".image-viewer") && document.activeElement === imageButton, "Escape closes the viewer and restores focus without moving the outer frame");
    }
    conversation.style.removeProperty("width"); conversation.style.removeProperty("height");
    const finalImage = document.querySelector<HTMLButtonElement>(".image-attachment > button")!;
    finalImage.click(); await frame();
    [...document.querySelectorAll<HTMLButtonElement>(".chat-item")].find((button) => button.textContent?.includes("QA Dave"))!.click();
    await frame(); await frame();
    check(!document.querySelector(".image-viewer"), "changing chat closes the previous chat image");

    (await openMenu()).querySelectorAll<HTMLButtonElement>("button")[1].click();
    const languageTab = await waitFor(() => document.querySelector<HTMLButtonElement>('.settings-nav button[title="Язык"]') ?? undefined, "language settings tab");
    languageTab.click();
    const languageSelect = await waitFor(() => [...document.querySelectorAll<HTMLSelectElement>(".settings-content select")].find((select) => select.querySelector('option[value="en"]')), "language selection");
    languageSelect.value = "en";
    languageSelect.dispatchEvent(new Event("change", { bubbles: true }));
    await waitFor(() => group.getAttribute("aria-label") === "Group chat" ? true : undefined, "English navigation");
    const englishMenu = await openMenu();
    check(JSON.stringify([...englishMenu.querySelectorAll("button")].map((button) => button.textContent)) === JSON.stringify(["Add profile", "Settings", "Exit"]), "English profile menu has the same three actions");
    check(group.title === "Group chat — coming soon" && group.disabled, "English group icon retains its disabled affordance and explanation");
    geometrySetTorState("connected", 100);
    await waitFor(() => torCaption() === "Connected" ? true : undefined, "English connected caption after animation");
    check(document.querySelector(".tor-status-line")?.classList.contains("visible"), "English connected caption remains visible");
    return { ok: true, assertions, cases };
  } catch (error) {
    return { ok: false, assertions, cases, error: error instanceof Error ? error.stack ?? error.message : String(error) };
  } finally {
    geometrySetTorState("disabled");
  }
}
