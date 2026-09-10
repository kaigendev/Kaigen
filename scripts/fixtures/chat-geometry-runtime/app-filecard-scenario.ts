import { geometryAppendFileAttachment, geometryUpdateFileAttachment } from "./app-platform";

declare const __KAIGEN_CHAT_GEOMETRY_TIMEOUT_SCALE__: number;
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function waitFor<T>(read: () => T | undefined, label: string): Promise<T> {
  const deadline = performance.now() + 5000 * __KAIGEN_CHAT_GEOMETRY_TIMEOUT_SCALE__;
  while (performance.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await delay(20);
  }
  throw new Error(`${label} timed out`);
}
const row = (id: string) => document.querySelector<HTMLElement>(`[data-message-key="${id}"]`);
function caption(id: string, selector: string) {
  const element = row(id)?.querySelector(selector);
  return element ? [...element.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE)
    .map((node) => node.textContent).join("").trim() : null;
}

export async function runActualAppFilecardScenario() {
  let assertions = 0;
  const cases: Array<{ language: string; direction: string; state: string; title: string | null }> = [];
  const check = (value: unknown, message: string) => { assertions += 1; if (!value) throw new Error(message); };
  try {
    const ids = [false, true].map((mine) => geometryAppendFileAttachment(2, mine, {
      name: `filecard-${mine ? "outgoing" : "incoming"}.bin`, size: 65536, mime: "application/octet-stream",
      path: "fixture.bin", image: false, transferred: 32768, speed_bytes_per_sec: 4096,
      transfer_state: mine ? "sending" : "receiving", completed: false,
    }));
    const contact = await waitFor(() => [...document.querySelectorAll<HTMLButtonElement>(".chat-item")]
      .find((item) => item.textContent?.includes("QA Dave")), "filecard contact");
    contact.click();
    await waitFor(() => ids.every((id) => row(id)) ? true : undefined, "actual App file rows");

    for (const language of ["ru", "en"] as const) {
      if (language === "en") {
        document.querySelector<HTMLButtonElement>(".rail-profile-menu-button")!.click();
        const menu = await waitFor(() => document.querySelector(".rail-profile-menu") ?? undefined, "profile menu");
        [...menu.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Настройки")!.click();
        (await waitFor(() => document.querySelector<HTMLButtonElement>('.settings-nav button[title="Язык"]') ?? undefined, "language tab")).click();
        const select = await waitFor(() => [...document.querySelectorAll<HTMLSelectElement>(".settings-content select")]
          .find((item) => item.querySelector('option[value="en"]')), "language select");
        select.value = "en";
        select.dispatchEvent(new Event("change", { bubbles: true }));
        await waitFor(() => document.querySelector('.settings-nav button[title="Language"]') ? true : undefined, "English settings");
        document.querySelector<HTMLButtonElement>(".chats-button")!.click();
        await waitFor(() => ids.every((id) => row(id)) ? true : undefined, "English file rows");
      }
      for (const [index, id] of ids.entries()) {
        const mine = index === 1;
        geometryUpdateFileAttachment(id, { transfer_state: mine ? "sending" : "receiving", completed: false, transferred: 32768 });
      }
      await waitFor(() => ids.every((id) => row(id)?.querySelector(".attachment-transfer")) ? true : undefined, "active transfer state");
      for (const [index, id] of ids.entries()) {
        check(!!row(id)?.querySelector<HTMLButtonElement>(".transfer-cancel:not(:disabled)"), `${language} active file keeps cancel`);
        check(!!row(id)?.querySelector(".attachment-progress"), `${language} active file keeps progress`);
        cases.push({ language, direction: index ? "outgoing" : "incoming", state: "active", title: caption(id, ".attachment-transfer-head b") });
        geometryUpdateFileAttachment(id, { transfer_state: "complete", completed: true, transferred: 65536, completed_at: 1788800000 });
      }
      await waitFor(() => ids.every((id) => row(id)?.querySelector(".file-static-meta") && !row(id)?.querySelector(".attachment-transfer")) ? true : undefined, "completed file DOM");
      await delay(80);
      for (const [index, id] of ids.entries()) {
        const expected = language === "ru" ? (index ? "Файл отправлен" : "Файл получен") : (index ? "File sent" : "File received");
        const actual = caption(id, ".file-static-meta");
        check(actual === expected, `${language} completed ${index ? "outgoing" : "incoming"} title: expected ${expected}, got ${actual}`);
        check(!row(id)?.querySelector(".transfer-cancel, .attachment-progress"), `${language} completed file has no cancel/progress`);
        check(document.querySelectorAll(`[data-message-key="${id}"]`).length === 1, "completion updates the same stable row once");
        cases.push({ language, direction: index ? "outgoing" : "incoming", state: "complete", title: actual });
      }
      for (const state of ["failed", "cancelled"] as const) {
        for (const id of ids) geometryUpdateFileAttachment(id, { transfer_state: state, completed: false, transfer_error: null });
        const expected = ids.map((_, index) => state === "failed"
          ? (language === "ru" ? "Ошибка передачи" : "Transfer error")
          : language === "ru" ? (index ? "Передача отменена" : "Получение отменено")
            : (index ? "Transfer cancelled" : "Receiving cancelled"));
        await waitFor(() => ids.every((id, index) => caption(id, ".file-static-meta") === expected[index]) ? true : undefined, `${language} ${state} labels`);
        for (const [index, id] of ids.entries()) {
          check(caption(id, ".file-static-meta") === expected[index], `${language} ${state} label retained`);
          check(!row(id)?.querySelector(".transfer-cancel, .attachment-progress"), `${language} ${state} remains terminal`);
          cases.push({ language, direction: index ? "outgoing" : "incoming", state, title: caption(id, ".file-static-meta") });
        }
      }
    }
    return { ok: true, assertions, cases };
  } catch (error) {
    return { ok: false, assertions, cases, error: error instanceof Error ? error.message : String(error) };
  }
}
