import { composer, setComposerDraft } from "./composer-test-adapter";
import { formatRichText, insertRichText, readRichTextEditor, readRichTextSelection, setRichTextSelection } from "../../../src/richTextEditor";
import { geometryDraftPersistenceEvidence, geometryMessageId, geometrySentPayloads } from "./app-platform";

declare const __KAIGEN_CHAT_GEOMETRY_TIMEOUT_SCALE__: number;
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
async function waitFor<T>(read: () => T | undefined, label: string, timeout = 4000): Promise<T> {
  const deadline = performance.now() + timeout * __KAIGEN_CHAT_GEOMETRY_TIMEOUT_SCALE__;
  while (performance.now() < deadline) {
    const result = read();
    if (result !== undefined) return result;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`${label} timed out`);
}
async function chooseContact(name: string) {
  const contact = await waitFor(() => [...document.querySelectorAll<HTMLButtonElement>(".chat-item")]
    .find((item) => item.textContent?.includes(name)), name);
  contact.click();
  await waitFor(() => contact.classList.contains("selected") && composer() ? true : undefined, "editor ownership");
  await frame(); await frame();
  return composer()!;
}

export async function runActualAppEditorScenario() {
  let assertions = 0;
  const cases: Record<string, unknown>[] = [];
  const check = (condition: unknown, message: string) => { assertions += 1; if (!condition) throw new Error(message); };
  try {
    let editor = await chooseContact("QA Carol");
    editor.focus({ preventScroll: true });
    setComposerDraft(editor, "");
    await frame();
    const value = "A🙂 e\u0301\nsecond line\n\nlast\n";
    check(insertRichText(editor, value), "native multiline insertion succeeds");
    await frame();
    check(editor.value === value, `native editor preserves UTF-16 and every newline: ${JSON.stringify(editor.value)}`);
    setRichTextSelection(editor, 1, 3, "backward");
    check(readRichTextSelection(editor).direction === "backward" && document.getSelection()?.toString() === "🙂", "backward selection keeps the complete emoji");

    const openFormatting = async (kind: string) => {
      editor.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "ContextMenu" }));
      const action = await waitFor(() => document.querySelector<HTMLButtonElement>(`[data-kaigen-format-kind="${kind}"]`) ?? undefined, `${kind} editor action`);
      action.click();
      await frame();
    };
    await openFormatting("bold");
    let state = readRichTextEditor(editor);
    check(state.formatting.some((span) => span.kind === "bold" && span.offsetUtf16 === 1 && span.lengthUtf16 === 2), "bold selection has exact emoji UTF-16 offsets");
    check(editor.selectionStart === 1 && editor.selectionEnd === 3 && editor.selectionDirection === "backward", "format action preserves directional selection");
    check(Number(getComputedStyle(editor.querySelector("b,strong")!).fontWeight) >= 750, "bold is visibly heavier in the editor");
    setRichTextSelection(editor, 4, 6);
    await openFormatting("italic");
    check(getComputedStyle(editor.querySelector("i,em")!).fontStyle === "italic", "italic renders inside the real editable DOM");
    check(getComputedStyle(editor).fontSynthesis.includes("style"), "normal-only fonts allow an italic face to be synthesized");
    check(document.execCommand("undo"), "native undo accepts the format operation");
    await frame();
    check(!readRichTextEditor(editor).formatting.some((span) => span.kind === "italic"), "undo removes the last style without replacing the draft");
    check(document.execCommand("redo"), "native redo accepts the format operation");
    await frame();
    check(readRichTextEditor(editor).formatting.some((span) => span.kind === "italic"), "redo restores the style");
    setRichTextSelection(editor, 0, 6);
    await openFormatting("underline");
    check(readRichTextEditor(editor).formatting.some((span) => span.kind === "underline" && span.lengthUtf16 === 6), "mixed formatted selection gains underline over its exact range");
    check(editor.value === value, "overlapping formatting preserves the original text and line breaks");
    check(document.querySelector(".composer textarea,.spellcheck-overlay") === null, "there is one visible editable text surface");

    setRichTextSelection(editor, value.length);
    const beforeTyping = editor.value;
    insertRichText(editor, " tail");
    await frame();
    check(editor.value === beforeTyping + " tail", "native insertion follows the true rich-text caret");
    document.execCommand("undo"); await frame();
    check(editor.value === beforeTyping, "native text undo restores the exact multiline draft");
    document.execCommand("redo"); await frame();
    check(editor.value === beforeTyping + " tail", "native text redo restores the insertion");

    setRichTextSelection(editor, editor.value.length);
    const pasted = "<img src=x onerror=throw(1)>\nplain paste";
    const clipboard = new DataTransfer();
    clipboard.setData("text/plain", pasted);
    clipboard.setData("text/html", '<img src="x" onerror="throw(1)"><b>untrusted markup</b>');
    const paste = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: clipboard });
    editor.dispatchEvent(paste); await frame();
    check(paste.defaultPrevented && editor.value.endsWith(pasted), "rich clipboard content is inserted as exact plain text");
    check(editor.querySelector("img,script,iframe,object") === null, "clipboard markup cannot create executable or resource nodes");
    document.execCommand("undo"); await frame();
    check(!editor.value.includes(pasted), "plain-text paste remains in native undo history");

    for (const kind of ["paste", "drop"] as const) {
      for (const htmlOnly of [true, false]) {
        const payload = new DataTransfer();
        if (htmlOnly) payload.setData("text/html", "<b>HTML without plain text</b>");
        setRichTextSelection(editor, 0, 3, "backward");
        const beforeEmpty = readRichTextEditor(editor);
        const event = kind === "paste"
          ? new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: payload })
          : new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: payload });
        editor.dispatchEvent(event); await frame();
        check(event.defaultPrevented && JSON.stringify(readRichTextEditor(editor)) === JSON.stringify(beforeEmpty), `${kind} with ${htmlOnly ? "HTML only" : "empty data"} preserves selected text and styles`);
        check(editor.selectionStart === 0 && editor.selectionEnd === 3, "ignored insertion preserves its selected range");
      }
    }

    const probe = document.createElement("div");
    probe.contentEditable = "true";
    probe.style.cssText = "position:fixed;left:-10000px;white-space:pre-wrap";
    const boldLine = document.createElement("b");
    boldLine.append(document.createTextNode("A"), document.createElement("br"));
    probe.append(boldLine, document.createTextNode("🙂B"));
    document.body.append(probe);
    check(readRichTextEditor(probe).value === "A\n🙂B", "a final BR in an inline formatting wrapper retains the break before following text");
    setRichTextSelection(probe, 2, 4, "backward");
    check(document.getSelection()?.toString() === "🙂" && readRichTextSelection(probe).start === 2, "selection offsets include the retained formatted line break");
    probe.replaceChildren(boldLine);
    check(readRichTextEditor(probe).value === "A", "a truly terminal BR remains a caret sentinel");
    const secondBlock = document.createElement("div");
    secondBlock.textContent = "B";
    probe.append(secondBlock);
    check(readRichTextEditor(probe).value === "A\nB", "block transition and trailing formatted BR create only one break");
    probe.remove();

    const beforeIme = geometrySentPayloads.length;
    setRichTextSelection(editor, editor.value.length);
    editor.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    insertRichText(editor, "漢");
    editor.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter", isComposing: true }));
    check(geometrySentPayloads.length === beforeIme && editor.value.endsWith("漢"), "IME Enter keeps composing text and cannot send");
    editor.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "漢" }));
    await frame();
    check(composer() === editor && editor.value.endsWith("漢"), "composition completion publishes without replacing the editor");

    // Native editor changes publish draft data through the actual App callbacks.
    const longDraft = Array.from({ length: 160 }, (_, index) => `row ${index}: responsive selection 🙂`).join("\n");
    setComposerDraft(editor, longDraft); await frame();
    setRichTextSelection(editor, 0, 300);
    formatRichText(editor, "bold"); await frame();
    const savedBefore = geometryDraftPersistenceEvidence().count;
    const inputSamples: number[] = [];
    for (let index = 0; index < 24; index += 1) {
      setRichTextSelection(editor, editor.value.length);
      const started = performance.now();
      insertRichText(editor, String(index % 10));
      inputSamples.push(performance.now() - started);
      await frame();
    }
    const selectionSamples: number[] = [];
    let selectionMutations = 0;
    const observer = new MutationObserver((records) => { selectionMutations += records.length; });
    observer.observe(editor, { subtree: true, childList: true, characterData: true });
    for (let index = 0; index < 50; index += 1) {
      const started = performance.now();
      setRichTextSelection(editor, index, index + 40, index % 2 ? "backward" : "forward");
      selectionSamples.push(performance.now() - started);
    }
    await frame(); observer.disconnect();
    check(selectionMutations === 0 && composer() === editor, "selection changes neither rewrite nor remount editable DOM");
    const maximumInput = Math.max(...inputSamples);
    const maximumSelection = Math.max(...selectionSamples);
    const p95Input = [...inputSamples].sort((left, right) => left - right)[Math.floor(inputSamples.length * .95)];
    check(maximumInput < 100 * __KAIGEN_CHAT_GEOMETRY_TIMEOUT_SCALE__, `native typing has no 100 ms input stall: ${maximumInput}`);
    check(maximumSelection < 50 * __KAIGEN_CHAT_GEOMETRY_TIMEOUT_SCALE__, `selection has no 50 ms input stall: ${maximumSelection}`);
    check(geometryDraftPersistenceEvidence().count <= savedBefore + 1, "typing a burst does not queue a persistence call per character");
    cases.push({ case: "native-editor-response", characters: editor.value.length, inputSamples: inputSamples.length, maximumInputMs: maximumInput, p95InputMs: p95Input, maximumSelectionMs: maximumSelection, selectionMutations });

    const quoteRow = await waitFor(() => document.querySelector<HTMLElement>(`[data-message-key="${geometryMessageId(1, 50)}"]`) ?? undefined, "quote source");
    const quoteText = editor.value;
    const startedQuote = performance.now();
    quoteRow.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: quoteRow.getBoundingClientRect().left + 20, clientY: quoteRow.getBoundingClientRect().top + 10 }));
    const quoteButton = await waitFor(() => [...document.querySelectorAll<HTMLButtonElement>(".restricted-context-menu button")].find((button) => button.textContent === "Цитировать"), "quote command");
    const quoteClick = performance.now();
    quoteButton.click(); await frame();
    const quoteFrameMs = performance.now() - quoteClick;
    check(composer() === editor && document.activeElement === editor && editor.value === quoteText, "quote focuses the same editor and preserves its entire rich draft");
    check(quoteFrameMs < 100 * __KAIGEN_CHAT_GEOMETRY_TIMEOUT_SCALE__, `quote paints its focused composer without a 100 ms stall: ${quoteFrameMs}`);
    cases.push({ case: "quote-response", quoteFrameMs, contextAndQuoteMs: performance.now() - startedQuote });

    // A different chat owns a different native undo domain and stale menu owner.
    setRichTextSelection(editor, 0, 3);
    editor.dispatchEvent(new KeyboardEvent("keydown", { key: "ContextMenu", bubbles: true, cancelable: true }));
    const stale = await waitFor(() => document.querySelector<HTMLButtonElement>('[data-kaigen-format-kind="bold"]') ?? undefined, "old owner style action");
    const oldEditor = editor;
    editor = await chooseContact("QA Dave");
    check(editor !== oldEditor && !oldEditor.isConnected, "chat change isolates the native editable owner");
    editor.focus({ preventScroll: true });
    document.execCommand("undo"); await frame();
    check(editor.value === "", "undo cannot restore another chat's draft");
    editor.dispatchEvent(new CustomEvent("kaigen:paste-files", { bubbles: true, detail: {
      files: [new File(["disposable clipboard fixture"], "pasted-after-chat-change.png", { type: "image/png" })],
    } }));
    const pastedFile = await waitFor(() => document.querySelector<HTMLElement>(".file-confirm-card") ?? undefined, "clipboard file on remounted editor");
    check(pastedFile.textContent?.includes("pasted-after-chat-change.png"), "clipboard-file fallback follows the newly selected chat editor");
    pastedFile.querySelector<HTMLButtonElement>(".text-button")!.click();
    await frame();
    stale.click(); await frame();
    check(editor.value === "", "stale formatting action cannot mutate the next owner");
    setComposerDraft(editor, "unsupported styles"); await frame();
    setRichTextSelection(editor, 0, editor.value.length);
    editor.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "i", ctrlKey: true }));
    check(readRichTextEditor(editor).formatting.length === 0, "an unsupported peer cannot enable formatting using keyboard shortcuts");

    editor = await chooseContact("QA Carol");
    const sentText = "exact 🙂\nquoted rich input";
    setComposerDraft(editor, sentText); await frame();
    setRichTextSelection(editor, 6, 8);
    await openFormatting("italic");
    const sentBefore = geometrySentPayloads.length;
    document.querySelector<HTMLButtonElement>(".composer .send")!.click();
    await waitFor(() => geometrySentPayloads.length > sentBefore ? true : undefined, "native rich submission");
    const payload = geometrySentPayloads[sentBefore];
    check(payload.text === sentText, "the send boundary receives exact multiline Unicode text");
    check(payload.formatting.some((span) => span.kind === "italic" && span.offsetUtf16 === 6 && span.lengthUtf16 === 2), "the send boundary receives the visible emoji formatting span");
    check(editor.value === "" && composer() === editor, "submission clears the draft without disrupting the next input owner");
    const preview = "Обычный текст · Жирный · Курсив\nПодчёркнутый · Зачёркнутый · 🙂";
    setComposerDraft(editor, preview); await frame();
    for (const [word, kind] of [["Жирный", "bold"], ["Курсив", "italic"], ["Подчёркнутый", "underline"], ["Зачёркнутый", "strikethrough"]] as const) {
      const start = preview.indexOf(word);
      setRichTextSelection(editor, start, start + word.length);
      formatRichText(editor, kind);
      await frame();
    }
    setRichTextSelection(editor, preview.length);
    await frame();
    return { ok: true, assertions, cases };
  } catch (error) {
    return { ok: false, assertions, cases, error: error instanceof Error ? error.stack ?? error.message : String(error) };
  }
}
