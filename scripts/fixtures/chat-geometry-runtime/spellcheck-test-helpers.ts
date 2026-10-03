import { composer, setComposerDraft } from "./composer-test-adapter";
import { readRichTextSelection, setRichTextSelection } from "../../../src/richTextEditor";
import { geometrySentPayloads } from "./app-platform";
import { spellcheckProbe, type WorkerRecord } from "./spellcheck-control";

export const frames = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
export const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export async function waitFor<T>(read: () => T | undefined, label: string, timeout = 6000): Promise<T> {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) { const value = read(); if (value !== undefined) return value; await delay(20); }
  throw new Error(label + " timed out");
}
export async function chooseContact(name: string) {
  document.querySelector<HTMLButtonElement>(".chats-button")?.click();
  const item = await waitFor(() => [...document.querySelectorAll<HTMLButtonElement>(".chat-item")].find((row) => row.textContent?.includes(name)), name);
  item.click();
  await waitFor(() => item.classList.contains("selected") && composer() ? true : undefined, "composer ownership");
  await frames();
  return composer()!;
}
export async function settings() {
  if (!document.querySelector(".settings-content")) {
    document.querySelector<HTMLButtonElement>(".rail-profile-menu-button")!.click();
    const menu = await waitFor(() => document.querySelector(".rail-profile-menu") ?? undefined, "profile menu");
    menu.querySelector<HTMLButtonElement>("button")!.click();
  }
  const tab = await waitFor(() => document.querySelector<HTMLButtonElement>('.settings-tabs button[aria-label="Чаты"]') ?? undefined, "chat settings");
  tab.click(); await waitFor(() => toggle("Проверять орфографию"), "spellcheck control"); await frames();
}
export function toggle(label: string) {
  return [...document.querySelectorAll<HTMLLabelElement>(".setting-switch")].find((row) => row.querySelector("b")?.textContent === label)?.querySelector<HTMLInputElement>("input") ?? undefined;
}
export async function setToggle(label: string, enabled: boolean) {
  const control = await waitFor(() => toggle(label), label);
  if (control.checked !== enabled) control.click();
  await waitFor(() => toggle(label)?.checked === enabled ? true : undefined, label + " applied"); await frames();
}
export const worker = () => spellcheckProbe.workers.at(-1)!;
export const config = (record = worker()) => record.outgoing.filter((item) => item.type === "configure").at(-1)!;
export async function checkRequest(text: string, record = worker(), after = 0) {
  return waitFor(() => record.outgoing.slice(after).findLast((item) => item.type === "check" && item.text === text), "check " + text);
}
export function checked(request: Record<string, any>, wrong = true) {
  return { type: "checked", configId: request.configId, revision: request.revision,
    results: [...String(request.text).matchAll(/[\p{L}’'-]{2,}/gu)].map((match, index) => ({
      id: request.revision * 1_000_000 + index, start: match.index, end: match.index + match[0].length,
      text: match[0], correct: !wrong,
    })) };
}
export function ranges(): Range[] {
  const highlights = (CSS as unknown as { highlights: Map<string, Iterable<Range>> }).highlights;
  return [...(highlights.get("kaigen-spelling") ?? [])];
}
export async function draft(value: string, caret = value.length) {
  const editor = composer()!; editor.focus(); setComposerDraft(editor, value); setRichTextSelection(editor, caret); await frames();
  return editor;
}
export async function openSuggestion(record = worker(), token = 0) {
  const range = ranges()[token]; if (!range) throw new Error("No misspelling range");
  const rect = range.getClientRects()[0]; if (!rect) throw new Error("No visible misspelling");
  const editor = composer()!; setRichTextSelection(editor, 0);
  const after = record.outgoing.length;
  editor.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }));
  return waitFor(() => record.outgoing.slice(after).find((item) => item.type === "suggest"), "suggest request");
}
export const suggestion = (request: Record<string, any>, text: string) => ({
  type: "suggestions", configId: request.configId, requestId: request.requestId, tokenId: request.tokenId, suggestions: [text],
});
export function selection() { return readRichTextSelection(composer()!); }
export async function send(value: string) {
  await draft(value, 2);
  const before = geometrySentPayloads.length;
  composer()!.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter", code: "Enter" }));
  await waitFor(() => geometrySentPayloads.length > before ? true : undefined, "send while spellcheck unavailable");
  await waitFor(() => composer()?.value === "" ? true : undefined, "sent composer cleared");
  return geometrySentPayloads.at(-1);
}
