import { readRichTextEditor, readRichTextSelection, setRichTextSelection, writeRichTextEditor } from "../../../src/richTextEditor";

export type TestComposer = HTMLDivElement & {
  readonly value: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
  readonly selectionDirection: "forward" | "backward" | "none";
  setSelectionRange(start: number, end: number, direction?: string): void;
};

/** Fixture-only conveniences; the product uses the browser Selection API. */
export function composer(): TestComposer | null {
  const editor = document.querySelector<HTMLDivElement>("[data-kaigen-composer-editor]");
  if (!editor) return null;
  if (!Object.getOwnPropertyDescriptor(editor, "value")) {
    Object.defineProperties(editor, {
      value: { get: () => readRichTextEditor(editor).value },
      selectionStart: { get: () => readRichTextSelection(editor).start },
      selectionEnd: { get: () => readRichTextSelection(editor).end },
      selectionDirection: { get: () => readRichTextSelection(editor).direction },
      setSelectionRange: { value: (start: number, end: number, direction?: string) => setRichTextSelection(editor, start, end, direction) },
    });
  }
  return editor as TestComposer;
}

export function setComposerDraft(editor: TestComposer, value: string) {
  writeRichTextEditor(editor, value);
  editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
}
