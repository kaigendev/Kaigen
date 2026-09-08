export type TextEditCommand = "undo" | "redo" | "cut" | "copy" | "paste" | "selectAll";

export const KAIGEN_PASTE_FILES_EVENT = "kaigen:paste-files";

export type TextEditSelection = Readonly<{
  value: string;
  start: number;
  end: number;
  direction: "forward" | "backward" | "none";
}>;

export function normalizeTextEditSelection(
  value: string,
  start: number | null | undefined,
  end: number | null | undefined,
  direction: string | null | undefined,
): TextEditSelection {
  const numericStart = typeof start === "number" && Number.isFinite(start) ? Math.trunc(start) : 0;
  const numericEnd = typeof end === "number" && Number.isFinite(end) ? Math.trunc(end) : numericStart;
  const clampedStart = Math.max(0, Math.min(value.length, numericStart));
  const clampedEnd = Math.max(clampedStart, Math.min(value.length, numericEnd));
  return {
    value,
    start: clampedStart,
    end: clampedEnd,
    direction: direction === "backward" || direction === "forward" ? direction : "none",
  };
}

export function selectedText(selection: TextEditSelection, password = false) {
  if (password) return "";
  return selection.value.slice(selection.start, selection.end);
}

export function applyPlainTextEdit(
  selection: TextEditSelection,
  command: "cut" | "paste" | "selectAll",
  clipboardText = "",
): TextEditSelection {
  if (command === "selectAll") {
    return { ...selection, start: 0, end: selection.value.length, direction: "none" };
  }
  const inserted = command === "paste" ? clipboardText : "";
  const value = selection.value.slice(0, selection.start) + inserted + selection.value.slice(selection.end);
  const caret = selection.start + inserted.length;
  return { value, start: caret, end: caret, direction: "none" };
}

export function isKeyboardContextMenuGesture(event: Readonly<{ key: string; shiftKey: boolean }>) {
  return event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey);
}

export function keyboardContextMenuPoint(rect: Readonly<{ left: number; bottom: number }>) {
  return { x: Math.round(rect.left + 8), y: Math.round(rect.bottom - 4) };
}

export function clampContextMenuPoint(
  requested: Readonly<{ x: number; y: number }>,
  menu: Readonly<{ width: number; height: number }>,
  viewport: Readonly<{ width: number; height: number }>,
  margin = 8,
) {
  return {
    x: Math.max(margin, Math.min(requested.x, viewport.width - menu.width - margin)),
    y: Math.max(margin, Math.min(requested.y, viewport.height - menu.height - margin)),
  };
}

export function clipboardImageExtension(mimeType: string) {
  switch (mimeType.toLowerCase()) {
    case "image/jpeg": return "jpg";
    case "image/gif": return "gif";
    case "image/webp": return "webp";
    case "image/bmp": return "bmp";
    case "image/tiff": return "tiff";
    case "image/svg+xml": return "svg";
    default: return "png";
  }
}
