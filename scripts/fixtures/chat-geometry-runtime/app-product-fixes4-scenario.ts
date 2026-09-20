import {
  geometryAddFriendRequest, geometryAppendImage, geometryAppendUnreadMessage, geometryDelayHistory,
  geometryMessageId, geometryRequestActions, geometrySetMenuProfiles, geometrySetProfileConnection, geometrySentPayloads,
} from "./app-platform";
import { composer, setComposerDraft } from "./composer-test-adapter";

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
async function waitFor<T>(read: () => T | undefined, label: string, ms = 6000): Promise<T> {
  const end = performance.now() + ms;
  while (performance.now() < end) { const value = read(); if (value !== undefined) return value; await delay(20); }
  throw new Error(`${label} timed out`);
}
const scroller = () => document.querySelector<HTMLElement>(".message-scroll")!;
const row = (key: string) => document.querySelector<HTMLElement>(`[data-message-key="${key}"]`);
const offset = (key: string) => row(key) ? row(key)!.getBoundingClientRect().top - scroller().getBoundingClientRect().top : Number.NaN;
async function select(name: string) {
  const contact = await waitFor(() => [...document.querySelectorAll<HTMLButtonElement>(".chat-item")].find((button) => button.textContent?.includes(name)), name);
  contact.click(); await frame(); await frame();
}
function scrollAsUser(top: number) {
  const container = scroller();
  container.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -120 }));
  container.scrollTop = top;
  container.dispatchEvent(new Event("scroll", { bubbles: true }));
}

export async function runActualAppProductFixes4Scenario() {
  let assertions = 0;
  const cases: Record<string, unknown>[] = [];
  const check = (condition: unknown, label: string) => { assertions++; if (!condition) throw new Error(label); };
  try {
    await waitFor(() => document.querySelector(".app-shell") ?? undefined, "App");
    geometrySetMenuProfiles(true);
    const profiles = () => [...document.querySelectorAll<HTMLElement>(".profile-switcher-item")];
    await waitFor(() => profiles().length === 2 ? true : undefined, "two loaded profiles");
    geometrySetProfileConnection("offline", "away");
    await waitFor(() => profiles().every((profile) => profile.classList.contains("status-offline")) ? true : undefined, "transport disconnection is gray");
    check(profiles().every((profile) => profile.title.includes("Подключаюсь") && profile.querySelector(".profile-avatar-connecting")), "all loaded profiles show connecting while preserving desired Away");
    geometrySetProfileConnection("tcp", "away");
    await waitFor(() => profiles().every((profile) => profile.classList.contains("status-away")) ? true : undefined, "transport reconnection restores desired status");
    check(profiles().every((profile) => profile.title.includes("Отошёл")), "live transport restores Away labels");
    geometrySetProfileConnection("offline", "offline");
    await waitFor(() => profiles().every((profile) => profile.title.includes("Отключён")) ? true : undefined, "explicit Offline");
    check(profiles().every((profile) => !profile.querySelector(".profile-avatar-connecting")), "explicit offline does not claim connecting");
    geometrySetProfileConnection("udp");

    await select("QA Carol");
    await waitFor(() => row(geometryMessageId(1, 50)) ?? undefined, "Carol initial history");
    await delay(100);
    const anchorKey = geometryMessageId(1, 24);
    scrollAsUser(scroller().scrollTop + offset(anchorKey) - 27);
    await frame(); await frame();
    const savedOffset = offset(anchorKey);
    check(Math.abs(savedOffset - 27) <= 2, "reading position is an exact visible message and offset");
    await select("QA Dave");
    await waitFor(() => row(geometryMessageId(2, 7)) ?? undefined, "Dave initial history");
    geometryDelayHistory(350);
    await select("QA Carol");
    check(Math.abs(offset(anchorKey) - savedOffset) <= 2, `warm return restores before delayed history: ${offset(anchorKey)} vs ${savedOffset}`);
    await delay(550);
    check(Math.abs(offset(anchorKey) - savedOffset) <= 2, "disk refresh preserves the warm reading anchor");
    await select("QA Dave");
    geometryAppendUnreadMessage(1, "Background incoming must preserve warm reading position");
    await select("QA Carol");
    await delay(600);
    check(Math.abs(offset(anchorKey) - savedOffset) <= 2, "background incoming does not move the returning reader");
    const requestsButton = document.querySelector<HTMLButtonElement>(".requests-button")!;
    check(!!requestsButton, "incoming requests navigation exists");
    requestsButton.click(); await frame(); await frame();
    await select("QA Carol");
    await frame(); await frame(); await delay(550);
    check(Math.abs(offset(anchorKey) - savedOffset) <= 2, "requests view round trip restores the same chat reading position");
    scrollAsUser(scroller().scrollHeight);
    await frame(); await frame();
    const tailReadingRow = [...scroller().querySelectorAll<HTMLElement>("[data-message-key]")].find((item) => item.getBoundingClientRect().bottom > scroller().getBoundingClientRect().top)!;
    const tailReadingKey = tailReadingRow.dataset.messageKey!, tailReadingOffset = offset(tailReadingKey);
    await select("QA Dave");
    for (let index = 0; index < 4; index++) geometryAppendUnreadMessage(1, `Background tail addition ${index}`);
    await select("QA Carol");
    await delay(600);
    check(Math.abs(offset(tailReadingKey) - tailReadingOffset) <= 2, "return from a former tail keeps the last read position above background messages");

    scrollAsUser(scroller().scrollTop + offset(anchorKey) - 27);
    await frame(); await frame();
    await select("QA Dave");
    geometryAppendUnreadMessage(1, "Background item before an explicit end jump");
    await select("QA Carol");
    const jump = await waitFor(() => document.querySelector<HTMLButtonElement>(".jump-latest") ?? undefined, "explicit end jump before refresh");
    jump.click();
    await delay(750);
    check(scroller().scrollHeight - scroller().scrollTop - scroller().clientHeight <= 2, "explicit end jump wins over the delayed warm refresh");

    scrollAsUser(scroller().scrollTop + offset(anchorKey) - 27);
    await frame(); await frame();
    await select("QA Dave");
    geometryAppendUnreadMessage(1, "Background item before an explicit search");
    await select("QA Carol");
    document.querySelector<HTMLButtonElement>('.header-actions button[aria-label="Поиск"]')!.click();
    const search = await waitFor(() => document.querySelector<HTMLInputElement>(".message-search input") ?? undefined, "search field");
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "Carol synthetic message 000005");
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await waitFor(() => document.querySelector(".message-search-hit.current") ?? undefined, "explicit search target");
    await delay(750);
    const searchRect = row(geometryMessageId(1, 5))!.getBoundingClientRect(), searchView = scroller().getBoundingClientRect();
    check(searchRect.top >= searchView.top - 2 && searchRect.bottom <= searchView.bottom + 2, "explicit search target wins over the delayed warm refresh");
    document.querySelector<HTMLButtonElement>('.message-search button[aria-label="Закрыть поиск"]')!.click();

    scrollAsUser(scroller().scrollHeight - scroller().clientHeight - 80);
    await frame(); await frame();
    await select("QA Dave");
    await select("QA Carol");
    const editor = await waitFor(() => composer() ?? undefined, "warm composer");
    const sentBefore = geometrySentPayloads.length;
    editor.focus({ preventScroll: true });
    setComposerDraft(editor, "Local send after warm return has priority");
    document.querySelector<HTMLButtonElement>(".composer .send")!.click();
    await waitFor(() => geometrySentPayloads.length > sentBefore ? true : undefined, "local send accepted");
    await delay(900);
    check(scroller().scrollHeight - scroller().scrollTop - scroller().clientHeight <= 2, "local send near the tail wins over the delayed warm refresh");
    geometryDelayHistory(0);

    for (const [width, height] of [[1200, 900], [900, 1800]]) {
      const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
      canvas.getContext("2d")!.fillRect(0, 0, width, height);
      const key = geometryAppendImage(1, canvas.toDataURL("image/png"));
      const image = await waitFor(() => { const image = row(key)?.querySelector<HTMLImageElement>(".image-attachment img"); return image?.complete && image.naturalWidth ? image : undefined; }, "decoded image preview");
      await frame(); await frame();
      const imageFrame = image.closest<HTMLElement>(".image-attachment")!;
      const imageStyle = getComputedStyle(image), frameStyle = getComputedStyle(imageFrame), cardStyle = getComputedStyle(row(key)!);
      check(frameStyle.paddingTop === "0px" && frameStyle.paddingBottom === "0px" && cardStyle.paddingTop === "0px" && cardStyle.paddingBottom === "0px", "image cards have no empty top or bottom inset");
      check(Math.abs(imageFrame.getBoundingClientRect().height - image.getBoundingClientRect().height) <= 1, "image fills the full frame height");
      check(imageStyle.objectFit === (width >= height ? "cover" : "contain"), "landscape fills its area; portrait retains its full vertical extent");
      cases.push({ orientation: width >= height ? "landscape" : "portrait", width: image.width, height: image.height, objectFit: imageStyle.objectFit });
    }

    const deniedKey = "E".repeat(64), acceptedKey = "F".repeat(64);
    geometryAddFriendRequest(deniedKey, 1);
    requestsButton.click();
    const request = () => [...document.querySelectorAll<HTMLElement>(".incoming-request:not(.outgoing-request)")].find((item) => item.querySelector("code")?.textContent === deniedKey);
    const reject = await waitFor(() => request()?.querySelector<HTMLButtonElement>(".reject-request-button") ?? undefined, "reject request action");
    reject.click(); reject.click();
    await frame();
    check([...request()!.querySelectorAll<HTMLButtonElement>("button")].every((button) => button.disabled), "both decisions are disabled during a pending action");
    await waitFor(() => request()?.querySelector('[role="alert"]') ?? undefined, "durable rejection failure");
    check(geometryRequestActions.length === 1 && !!request(), "failed rejection remains retryable and duplicate clicks send one command");
    request()!.querySelector<HTMLButtonElement>(".reject-request-button")!.click();
    await waitFor(() => !request() ? true : undefined, "successful rejection removes the request");
    check(geometryRequestActions.at(-1)?.command === "reject_incoming_friend_request" && geometryRequestActions.at(-1)?.publicKey === deniedKey && geometryRequestActions.at(-1)?.profileId === "qa-profile-a", "Reject uses the original profile and public key");
    geometryAddFriendRequest(acceptedKey);
    const accept = await waitFor(() => document.querySelector<HTMLButtonElement>(".incoming-request-actions .send-file-button") ?? undefined, "accept action after rejection");
    accept.click();
    await waitFor(() => !document.querySelector(".incoming-request-actions") ? true : undefined, "accept removes the remaining request");
    check(geometryRequestActions.at(-1)?.command === "accept_incoming_friend_request", "Accept remains functional after Reject");
    return { ok: true, assertions, cases };
  } catch (error) { return { ok: false, assertions, cases, error: String(error) }; }
  finally { geometryDelayHistory(0); }
}
