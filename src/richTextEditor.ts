import {
  formattedTextSegments,
  normalizeFormattingSpans,
  type ChatFormattingKind,
  type ChatFormattingSpan,
} from "./chatRichText";
import { normalizeTextEditSelection, type TextEditSelection } from "./textEditCommands";

type Point = { node: Node; offset: number };
type Piece = { start: number; end: number; from: Point; to: Point; text: boolean };
type EditorDocument = {
  value: string;
  formatting: ChatFormattingSpan[];
  pieces: Piece[];
  offsets: Map<Node, number[]>;
};

const blocks = new Set(["DIV", "P", "LI", "PRE", "BLOCKQUOTE"]);
const excluded = new Set(["SCRIPT", "STYLE", "TEMPLATE", "IMG", "IFRAME", "OBJECT"]);

function hasFollowingInlineContent(node: Node, target: HTMLElement): boolean {
  let current: Node | null = node;
  while (current && current !== target) {
    for (let sibling = current.nextSibling; sibling; sibling = sibling.nextSibling) {
      if (sibling.nodeType === Node.TEXT_NODE && sibling.nodeValue) return true;
      if (!(sibling instanceof Element) || excluded.has(sibling.tagName)) continue;
      if (blocks.has(sibling.tagName)) return false;
      if (sibling.tagName === "BR" || sibling.textContent || sibling.querySelector("br")) return true;
    }
    current = current.parentNode;
    if (current instanceof Element && blocks.has(current.tagName)) return false;
  }
  return false;
}

function inheritedKinds(element: Element, inherited: readonly ChatFormattingKind[]) {
  const kinds = new Set(inherited);
  const tag = element.tagName;
  if (tag === "B" || tag === "STRONG") kinds.add("bold");
  if (tag === "I" || tag === "EM") kinds.add("italic");
  if (tag === "U") kinds.add("underline");
  if (tag === "S" || tag === "STRIKE" || tag === "DEL") kinds.add("strikethrough");
  // Native editing can use inline CSS when it removes one style from a mixed
  // selection. Read only the four protocol styles, without a layout/style read.
  const style = (element as HTMLElement).style;
  if (style?.fontWeight) {
    if (style.fontWeight === "bold" || Number(style.fontWeight) >= 600) kinds.add("bold");
    else kinds.delete("bold");
  }
  if (style?.fontStyle) {
    if (/italic|oblique/.test(style.fontStyle)) kinds.add("italic");
    else kinds.delete("italic");
  }
  const decoration = style?.textDecorationLine || style?.textDecoration;
  if (decoration) {
    if (decoration.includes("underline")) kinds.add("underline");
    if (decoration.includes("line-through")) kinds.add("strikethrough");
    if (decoration === "none") { kinds.delete("underline"); kinds.delete("strikethrough"); }
  }
  return [...kinds];
}

/** Linearize native editable nodes without innerText, layout, or HTML parsing. */
function editorDocument(target: HTMLElement, includeFormatting = true): EditorDocument {
  let value = "";
  const formatting: ChatFormattingSpan[] = [];
  const pieces: Piece[] = [];
  const offsets = new Map<Node, number[]>();
  const append = (text: string, from: Point, to: Point, kinds: readonly ChatFormattingKind[], literal: boolean) => {
    const start = value.length;
    value += text;
    pieces.push({ start, end: value.length, from, to, text: literal });
    for (const kind of kinds) formatting.push({ kind, offsetUtf16: start, lengthUtf16: text.length });
  };
  const walk = (node: Node, inherited: readonly ChatFormattingKind[]) => {
    if (node.nodeType === Node.TEXT_NODE) {
      offsets.set(node, [value.length]);
      const text = node.nodeValue ?? "";
      append(text, { node, offset: 0 }, { node, offset: text.length }, inherited, true);
      return;
    }
    if (!(node instanceof Element) || excluded.has(node.tagName)) return;
    const kinds = includeFormatting ? inheritedKinds(node, inherited) : [];
    const children = [...node.childNodes];
    const positions: number[] = [];
    offsets.set(node, positions);
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index];
      positions[index] = value.length;
      const previous = children[index - 1];
      const block = child instanceof Element && blocks.has(child.tagName);
      const previousBlock = previous instanceof Element && blocks.has(previous.tagName);
      if (index > 0 && (block || previousBlock)) {
        append("\n", { node, offset: index }, { node: child, offset: 0 }, kinds, false);
      }
      if (child instanceof Element && child.tagName === "BR") {
        offsets.set(child, [value.length]);
        // Chromium/WebKit keep a final BR as the caret's empty-line sentinel.
        if (hasFollowingInlineContent(child, target)) {
          append("\n", { node, offset: index }, { node, offset: index + 1 }, kinds, false);
        }
      } else walk(child, kinds);
    }
    positions[children.length] = value.length;
  };
  walk(target, []);
  return { value, formatting: normalizeFormattingSpans(value, formatting), pieces, offsets };
}

export function readRichTextEditor(target: HTMLElement) {
  const { value, formatting } = editorDocument(target);
  return { value, formatting };
}

function offsetAt(document: EditorDocument, node: Node | null, offset: number) {
  if (!node) return 0;
  const positions = document.offsets.get(node);
  if (!positions) return 0;
  return node.nodeType === Node.TEXT_NODE
    ? positions[0] + Math.max(0, Math.min(node.nodeValue?.length ?? 0, offset))
    : positions[Math.max(0, Math.min(positions.length - 1, offset))] ?? 0;
}

export function readRichTextSelection(target: HTMLElement): TextEditSelection {
  const parsed = editorDocument(target, false);
  const selection = target.ownerDocument.getSelection();
  if (!selection || !target.contains(selection.anchorNode) || !target.contains(selection.focusNode)) {
    return normalizeTextEditSelection(parsed.value, 0, 0, "none");
  }
  const anchor = offsetAt(parsed, selection.anchorNode, selection.anchorOffset);
  const focus = offsetAt(parsed, selection.focusNode, selection.focusOffset);
  return normalizeTextEditSelection(parsed.value, Math.min(anchor, focus), Math.max(anchor, focus),
    anchor > focus ? "backward" : anchor < focus ? "forward" : "none");
}

function pointAt(target: HTMLElement, parsed: EditorDocument, requested: number): Point {
  const offset = Math.max(0, Math.min(parsed.value.length, requested));
  for (const piece of parsed.pieces) {
    if (piece.text && offset >= piece.start && offset <= piece.end) {
      return { node: piece.from.node, offset: offset - piece.start };
    }
    if (offset === piece.start) return piece.from;
    if (offset < piece.end) return piece.to;
  }
  return parsed.pieces[parsed.pieces.length - 1]?.to ?? { node: target, offset: 0 };
}

export function richTextRange(target: HTMLElement, start: number, end: number) {
  return richTextRanges(target, [{ start, end }])[0];
}

export function richTextRanges(target: HTMLElement, positions: readonly { start: number; end: number }[]) {
  const parsed = editorDocument(target, false);
  return positions.map(({ start, end }) => {
    const from = pointAt(target, parsed, start);
    const to = pointAt(target, parsed, end);
    const range = target.ownerDocument.createRange();
    range.setStart(from.node, from.offset);
    range.setEnd(to.node, to.offset);
    return range;
  });
}

export function setRichTextSelection(target: HTMLElement, start: number, end = start, direction = "none") {
  const parsed = editorDocument(target, false);
  const from = pointAt(target, parsed, start);
  const to = pointAt(target, parsed, end);
  const selection = target.ownerDocument.getSelection();
  if (!selection) return;
  if (direction === "backward") selection.setBaseAndExtent(to.node, to.offset, from.node, from.offset);
  else selection.setBaseAndExtent(from.node, from.offset, to.node, to.offset);
}

/** Only draft ownership changes/reset may replace the editable subtree. */
export function writeRichTextEditor(target: HTMLElement, value: string, formatting: readonly ChatFormattingSpan[] = []) {
  const document = target.ownerDocument;
  const fragment = document.createDocumentFragment();
  for (const segment of formattedTextSegments(value, formatting)) {
    let content: Node = document.createTextNode(segment.text);
    for (const kind of segment.kinds) {
      const wrapper = kind === "bold" ? document.createElement("strong")
        : kind === "italic" ? document.createElement("em")
        : kind === "underline" ? document.createElement("u")
        : document.createElement("s");
      wrapper.append(content);
      content = wrapper;
    }
    fragment.append(content);
  }
  target.replaceChildren(fragment);
}

/** Native commands retain the browser's undo stack; external HTML never enters. */
export function insertRichText(target: HTMLElement, text: string) {
  target.focus({ preventScroll: true });
  return target.ownerDocument.execCommand(text ? "insertText" : "delete", false, text);
}

export function formatRichText(target: HTMLElement, kind: ChatFormattingKind) {
  target.focus({ preventScroll: true });
  target.ownerDocument.execCommand("styleWithCSS", false, "false");
  return target.ownerDocument.execCommand(kind === "strikethrough" ? "strikeThrough" : kind);
}
