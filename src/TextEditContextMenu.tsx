import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { isEditableTextTarget } from "./editableTextTarget";
import { CHAT_FORMAT_KINDS, type ChatFormattingKind } from "./chatRichText";
import { snapshotTextEditFormatting, type TextEditFormattingSnapshot } from "./textEditFormatting";
import { insertRichText, readRichTextSelection, setRichTextSelection } from "./richTextEditor";
import { dismissContextMenus, registerContextMenuDismissal } from "./contextMenuCoordinator";
import {
  KAIGEN_PASTE_FILES_EVENT,
  applyPlainTextEdit,
  clampContextMenuPoint,
  clipboardImageExtension,
  isKeyboardContextMenuGesture,
  keyboardContextMenuPoint,
  normalizeTextEditSelection,
  selectedText,
  type TextEditCommand,
  type TextEditSelection,
} from "./textEditCommands";
import { useI18n } from "./i18n";
import "./ChatEnhancements.css";

type EditableControl = HTMLInputElement | HTMLTextAreaElement;
type EditableElement = EditableControl | HTMLElement;

type ControlSnapshot = Readonly<{
  kind: "control";
  target: EditableControl;
  targetId: string;
  selection: TextEditSelection;
  password: boolean;
  writable: boolean;
}>;

type ContentSnapshot = Readonly<{
  kind: "content";
  target: HTMLElement;
  targetId: string;
  ranges: readonly Range[];
  selectionText: string;
  selection: TextEditSelection;
  writable: boolean;
}>;

type EditSnapshot = ControlSnapshot | ContentSnapshot;

type MenuState = Readonly<{
  x: number;
  y: number;
  keyboard: boolean;
  snapshot: EditSnapshot;
  formatting: TextEditFormattingSnapshot | null;
}>;

type ClipboardReadItem = Readonly<{
  types: readonly string[];
  getType: (type: string) => Promise<Blob>;
}>;

let nextEditTargetId = 0;

function editableElement(target: EventTarget | null): EditableElement | null {
  if (!(target instanceof Element)) return null;
  const candidate = target.closest("input, textarea, [contenteditable]");
  if (!candidate || !isEditableTextTarget(candidate)) return null;
  if (candidate instanceof HTMLInputElement || candidate instanceof HTMLTextAreaElement) return candidate;
  return candidate instanceof HTMLElement ? candidate : null;
}

function stableTargetId(target: EditableElement) {
  const current = target.dataset.kaigenEditTargetId;
  if (current) return current;
  nextEditTargetId += 1;
  const id = `kaigen-edit-${nextEditTargetId}`;
  target.dataset.kaigenEditTargetId = id;
  return id;
}

function snapshotEditable(target: EditableElement): EditSnapshot {
  const targetId = stableTargetId(target);
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    return {
      kind: "control",
      target,
      targetId,
      selection: normalizeTextEditSelection(target.value, target.selectionStart, target.selectionEnd, target.selectionDirection),
      password: target instanceof HTMLInputElement && target.type === "password",
      writable: !target.disabled && !target.readOnly,
    };
  }

  const selection = document.getSelection();
  const ranges: Range[] = [];
  if (selection) {
    for (let index = 0; index < selection.rangeCount; index += 1) {
      const range = selection.getRangeAt(index);
      if (target.contains(range.commonAncestorContainer)) ranges.push(range.cloneRange());
    }
  }
  return {
    kind: "content",
    target,
    targetId,
    ranges,
    selectionText: ranges.length ? selection?.toString() ?? "" : "",
    selection: readRichTextSelection(target),
    writable: target.isContentEditable,
  };
}

function resolveTarget(snapshot: EditSnapshot): EditableElement | null {
  if (snapshot.target.isConnected && snapshot.target.dataset.kaigenEditTargetId === snapshot.targetId) {
    return snapshot.target;
  }
  const target = document.querySelector<HTMLElement>(`[data-kaigen-edit-target-id="${snapshot.targetId}"]`);
  return target && isEditableTextTarget(target) ? target : null;
}

function restoreSelection(snapshot: EditSnapshot) {
  const target = resolveTarget(snapshot);
  if (!target) return null;
  target.focus({ preventScroll: true });
  if (snapshot.kind === "control" && (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) {
    const selection = normalizeTextEditSelection(
      target.value,
      snapshot.selection.start,
      snapshot.selection.end,
      snapshot.selection.direction,
    );
    target.setSelectionRange(selection.start, selection.end, selection.direction);
    return target;
  }
  if (snapshot.kind === "content" && target instanceof HTMLElement) {
    if (target.hasAttribute("data-kaigen-composer-editor")) {
      if (readRichTextSelection(target).value !== snapshot.selection.value) return null;
      setRichTextSelection(target, snapshot.selection.start, snapshot.selection.end, snapshot.selection.direction);
      return target;
    }
    const selection = document.getSelection();
    selection?.removeAllRanges();
    for (const range of snapshot.ranges) {
      try {
        selection?.addRange(range.cloneRange());
      } catch {
        // The editable subtree may have been replaced while clipboard access
        // was pending. Keeping focus is safer than applying to a stale range.
      }
    }
  }
  return target;
}

function dispatchTextInput(target: EditableElement, inputType: string, data: string | null) {
  let event: Event;
  try {
    event = new InputEvent("input", { bubbles: true, composed: true, inputType, data });
  } catch {
    event = new Event("input", { bubbles: true, composed: true });
  }
  target.dispatchEvent(event);
}

function setNativeControlValue(target: EditableControl, value: string) {
  const prototype = target instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  if (setter) setter.call(target, value);
  else target.value = value;
}

function replaceSelection(snapshot: EditSnapshot, text: string, inputType: string) {
  const target = restoreSelection(snapshot);
  if (!target) return false;
  if (snapshot.kind === "control" && (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) {
    const current = normalizeTextEditSelection(
      target.value,
      snapshot.selection.start,
      snapshot.selection.end,
      snapshot.selection.direction,
    );
    const next = applyPlainTextEdit(current, text ? "paste" : "cut", text);
    setNativeControlValue(target, next.value);
    target.setSelectionRange(next.start, next.end, next.direction);
    dispatchTextInput(target, inputType, text || null);
    return true;
  }
  if (snapshot.kind !== "content" || !(target instanceof HTMLElement)) return false;
  if (target.hasAttribute("data-kaigen-composer-editor")) return insertRichText(target, text);
  const selection = document.getSelection();
  const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
  if (!range || !target.contains(range.commonAncestorContainer)) return false;
  range.deleteContents();
  if (text) {
    const node = document.createTextNode(text);
    range.insertNode(node);
    range.setStartAfter(node);
  }
  range.collapse(true);
  selection?.removeAllRanges();
  selection?.addRange(range);
  dispatchTextInput(target, inputType, text || null);
  return true;
}

function selectAll(snapshot: EditSnapshot) {
  const target = restoreSelection(snapshot);
  if (!target) return false;
  if (snapshot.kind === "control" && (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) {
    const next = applyPlainTextEdit(
      normalizeTextEditSelection(target.value, 0, 0, "none"),
      "selectAll",
    );
    target.setSelectionRange(next.start, next.end, next.direction);
    return true;
  }
  if (target instanceof HTMLElement) {
    const range = document.createRange();
    range.selectNodeContents(target);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    return true;
  }
  return false;
}

function execEditCommand(snapshot: EditSnapshot, command: "undo" | "redo" | "copy" | "cut" | "paste") {
  if (!restoreSelection(snapshot) || typeof document.execCommand !== "function") return false;
  try {
    return document.execCommand(command);
  } catch {
    return false;
  }
}

function snapshotText(snapshot: EditSnapshot) {
  return snapshot.kind === "control"
    ? selectedText(snapshot.selection, snapshot.password)
    : snapshot.selectionText;
}

async function clipboardImagesAndText() {
  const clipboard = navigator.clipboard as Clipboard & { read?: () => Promise<ClipboardReadItem[]> };
  if (typeof clipboard?.read === "function") {
    const items = await clipboard.read();
    const images: File[] = [];
    let text: string | null = null;
    for (const item of items) {
      const imageType = item.types.find((type) => type.startsWith("image/"));
      if (imageType) {
        const blob = await item.getType(imageType);
        images.push(new File(
          [blob],
          `clipboard-image-${Date.now()}.${clipboardImageExtension(imageType)}`,
          { type: imageType, lastModified: Date.now() },
        ));
        continue;
      }
      if (text === null && item.types.includes("text/plain")) {
        text = await (await item.getType("text/plain")).text();
      }
    }
    if (images.length || text !== null) return { images, text };
  }
  if (typeof clipboard?.readText === "function") return { images: [] as File[], text: await clipboard.readText() };
  throw new Error("CLIPBOARD_READ_UNAVAILABLE");
}

function dispatchPastedFiles(snapshot: EditSnapshot, files: readonly File[]) {
  const target = restoreSelection(snapshot);
  if (!target || !files.length) return false;
  target.dispatchEvent(new CustomEvent(KAIGEN_PASTE_FILES_EVENT, {
    bubbles: true,
    detail: { files },
  }));
  return true;
}

export default function TextEditContextMenu() {
  const { t } = useI18n();
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [busy, setBusy] = useState<TextEditCommand | null>(null);
  const [error, setError] = useState("");
  const menuStateRef = useRef<MenuState | null>(menu);
  const menuRef = useRef<HTMLDivElement>(null);
  const firstButtonRef = useRef<HTMLButtonElement>(null);
  const mountedRef = useRef(true);

  const closeMenu = useCallback((restore = false) => {
    const current = menuStateRef.current;
    menuStateRef.current = null;
    if (restore && current) restoreSelection(current.snapshot);
    setMenu(null);
    setBusy(null);
    setError("");
  }, []);

  const openMenu = useCallback((target: EditableElement, x: number, y: number, keyboard: boolean) => {
    dismissContextMenus();
    setBusy(null);
    setError("");
    const snapshot = snapshotEditable(target);
    const formatting = snapshot.writable && !(snapshot.kind === "control" && snapshot.password)
      ? snapshotTextEditFormatting(target, snapshot.selection)
      : null;
    const next = { x, y, keyboard, snapshot, formatting };
    menuStateRef.current = next;
    setMenu(next);
  }, []);

  useLayoutEffect(() => registerContextMenuDismissal(() => closeMenu(false)), [closeMenu]);

  useEffect(() => {
    mountedRef.current = true;
    const onContextMenu = (event: MouseEvent) => {
      if (event.defaultPrevented) return;
      if (event.target instanceof Element && event.target.closest("[data-kaigen-text-edit-menu]")) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      const target = editableElement(event.target);
      if (!target) {
        event.preventDefault();
        closeMenu(false);
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      openMenu(target, event.clientX, event.clientY, false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && menuRef.current) {
        event.preventDefault();
        closeMenu(true);
        return;
      }
      if (!isKeyboardContextMenuGesture(event)) return;
      const target = editableElement(event.target);
      if (!target) return;
      event.preventDefault();
      event.stopPropagation();
      const point = keyboardContextMenuPoint(target.getBoundingClientRect());
      openMenu(target, point.x, point.y, true);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current || menuRef.current.contains(event.target as Node)) return;
      closeMenu(false);
    };
    const onMouseDown = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || !event.ctrlKey || !/Mac/i.test(navigator.platform)) return;
      const target = editableElement(event.target);
      if (!target || !snapshotText(snapshotEditable(target))) return;
      // macOS Control-click must capture the selected range before the primary
      // button's default action can collapse it to a caret.
      event.preventDefault();
      event.stopPropagation();
      openMenu(target, event.clientX, event.clientY, false);
    };
    const onScroll = (event: Event) => {
      const state = menuStateRef.current;
      if (!state) return;
      const owner = resolveTarget(state.snapshot);
      const scrolled = event.target;
      // History can move while the fixed composer stays in place. Only the
      // editable owner, its contents, or its scroll ancestors move this menu.
      if (owner && scrolled instanceof Node && !scrolled.contains(owner) && !owner.contains(scrolled)) return;
      closeMenu(false);
    };
    document.addEventListener("contextmenu", onContextMenu);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("mousedown", onMouseDown, true);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      mountedRef.current = false;
      document.removeEventListener("contextmenu", onContextMenu);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("mousedown", onMouseDown, true);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [closeMenu, openMenu]);

  useLayoutEffect(() => {
    if (!menu || !menuRef.current) return;
    const element = menuRef.current;
    const point = clampContextMenuPoint(
      menu,
      { width: element.offsetWidth, height: element.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight },
    );
    element.style.left = `${point.x}px`;
    element.style.top = `${point.y}px`;
    if (menu.keyboard) firstButtonRef.current?.focus({ preventScroll: true });
  }, [menu]);

  const run = useCallback(async (command: TextEditCommand) => {
    if (!menu || busy) return;
    const { snapshot } = menu;
    setBusy(command);
    setError("");
    try {
      if (command === "undo" || command === "redo") {
        execEditCommand(snapshot, command);
        closeMenu(true);
        return;
      }
      if (command === "selectAll") {
        selectAll(snapshot);
        closeMenu(false);
        return;
      }
      if (command === "paste") {
        if (!snapshot.writable) return;
        if (execEditCommand(snapshot, "paste")) {
          closeMenu(true);
          return;
        }
        const payload = await clipboardImagesAndText();
        if (!mountedRef.current || menuStateRef.current !== menu) return;
        if (payload.images.length) dispatchPastedFiles(snapshot, payload.images);
        else replaceSelection(snapshot, payload.text ?? "", "insertFromPaste");
        closeMenu(true);
        return;
      }

      const text = snapshotText(snapshot);
      if (!text || (command === "cut" && !snapshot.writable)) return;
      if (execEditCommand(snapshot, command)) {
        closeMenu(true);
        return;
      }
      if (typeof navigator.clipboard?.writeText !== "function") throw new Error("CLIPBOARD_WRITE_UNAVAILABLE");
      await navigator.clipboard.writeText(text);
      if (!mountedRef.current || menuStateRef.current !== menu) return;
      if (command === "cut") replaceSelection(snapshot, "", "deleteByCut");
      closeMenu(true);
    } catch {
      if (!mountedRef.current || menuStateRef.current !== menu) return;
      setBusy(null);
      setError(t("Не удалось получить доступ к буферу обмена"));
      restoreSelection(snapshot);
    }
  }, [busy, closeMenu, menu, t]);

  const runFormatting = useCallback((kind: ChatFormattingKind) => {
    if (!menu || busy) return;
    if (!menu.formatting?.isCurrent() || !resolveTarget(menu.snapshot)) {
      closeMenu(false);
      return;
    }
    restoreSelection(menu.snapshot);
    const applied = menu.formatting.apply(kind);
    closeMenu(applied);
  }, [busy, closeMenu, menu]);

  if (!menu || typeof document === "undefined") return null;
  const selected = snapshotText(menu.snapshot);
  const canCopy = selected.length > 0;
  const canCut = canCopy && menu.snapshot.writable;
  const canPaste = menu.snapshot.writable;
  const items: Array<{ command: TextEditCommand; label: string; disabled?: boolean; separator?: boolean }> = [
    { command: "undo", label: t("Отменить действие") },
    { command: "redo", label: t("Повторить действие") },
    { command: "cut", label: t("Вырезать"), disabled: !canCut, separator: true },
    { command: "copy", label: t("Копировать"), disabled: !canCopy },
    { command: "paste", label: t("Вставить"), disabled: !canPaste },
    { command: "selectAll", label: t("Выделить всё"), separator: true },
  ];

  return createPortal(
    <div
      ref={menuRef}
      className="text-edit-context-menu"
      data-kaigen-text-edit-menu="true"
      role="menu"
      aria-label={t("Редактирование текста")}
      style={{ left: menu.x, top: menu.y }}
      onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); }}
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.preventDefault()}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        event.preventDefault();
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const delta = event.key === "ArrowDown" ? 1 : -1;
        buttons[(current + delta + buttons.length) % buttons.length]?.focus();
      }}
    >
      {menu.formatting && <div className="text-edit-formatting-group" role="group" aria-label={t("Форматирование текста")}>
        {CHAT_FORMAT_KINDS.map((kind, index) => {
          const label = kind === "bold" ? t("Жирный")
            : kind === "underline" ? t("Подчёркнутый")
              : kind === "italic" ? t("Курсив") : t("Зачёркнутый");
          const active = menu.formatting!.activeKinds.includes(kind);
          return <button
            ref={index === 0 ? firstButtonRef : undefined}
            type="button"
            role="menuitemcheckbox"
            aria-label={label}
            aria-checked={active}
            data-kaigen-format-kind={kind}
            disabled={busy !== null}
            key={kind}
            onClick={() => runFormatting(kind)}
          >
            <span className="text-edit-format-icon" aria-hidden="true">{kind === "bold" ? <strong>B</strong> : kind === "underline" ? <u>U</u> : kind === "italic" ? <em>I</em> : <s>S</s>}</span>
            {label}
            <span className="text-edit-format-check" aria-hidden="true">{active ? "✓" : ""}</span>
          </button>;
        })}
      </div>}
      {items.map((item, index) => <span className={item.separator || (index === 0 && menu.formatting) ? "menu-separator" : ""} key={item.command}>
        <button
          ref={index === 0 && !menu.formatting ? firstButtonRef : undefined}
          type="button"
          role="menuitem"
          disabled={busy !== null || item.disabled}
          onClick={() => void run(item.command)}
        >{busy === item.command ? `${item.label}…` : item.label}</button>
      </span>)}
      {error && <small role="status" aria-live="polite">{error}</small>}
    </div>,
    document.body,
  );
}
