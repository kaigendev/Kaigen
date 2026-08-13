import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "./i18n";

type TextControl = HTMLInputElement | HTMLTextAreaElement;

type MenuState = {
  target: TextControl;
  start: number;
  end: number;
  x: number;
  y: number;
};

const TEXT_INPUT_TYPES = new Set(["text", "search", "email", "url", "tel", "password"]);

function textControlAt(target: EventTarget | null): TextControl | null {
  if (target instanceof HTMLTextAreaElement) return target;
  if (target instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(target.type)) return target;
  return null;
}

function selectRange(target: TextControl, start: number, end: number) {
  target.focus({ preventScroll: true });
  target.setSelectionRange(start, end);
}

function replaceRange(target: TextControl, start: number, end: number, replacement: string) {
  const next = target.value.slice(0, start) + replacement + target.value.slice(end);
  const prototype = target instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(target, next);
  target.dispatchEvent(new InputEvent("input", {
    bubbles: true,
    data: replacement,
    inputType: replacement ? "insertFromPaste" : "deleteByCut",
  }));
  const caret = start + replacement.length;
  requestAnimationFrame(() => {
    if (!target.isConnected) return;
    target.focus({ preventScroll: true });
    target.setSelectionRange(caret, caret);
  });
}

export default function TextEditContextMenu() {
  const { t } = useI18n();
  const [menu, setMenu] = useState<MenuState | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const open = (event: MouseEvent) => {
      // Custom menus own the event before it reaches document. Everywhere else
      // the native WebView menu stays disabled by design.
      event.preventDefault();
      const target = textControlAt(event.target);
      if (!target || target.disabled) {
        setMenu(null);
        return;
      }
      setMenu({
        target,
        start: target.selectionStart ?? 0,
        end: target.selectionEnd ?? target.selectionStart ?? 0,
        x: event.clientX,
        y: event.clientY,
      });
    };
    const close = () => setMenu(null);
    const closeOnKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("contextmenu", open);
    document.addEventListener("pointerdown", close);
    document.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    document.addEventListener("keydown", closeOnKey);
    return () => {
      document.removeEventListener("contextmenu", open);
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
      document.removeEventListener("keydown", closeOnKey);
    };
  }, []);

  useLayoutEffect(() => {
    if (!menu || !menuRef.current) return;
    const element = menuRef.current;
    const margin = 8;
    const x = Math.max(margin, Math.min(menu.x, window.innerWidth - element.offsetWidth - margin));
    const y = Math.max(margin, Math.min(menu.y, window.innerHeight - element.offsetHeight - margin));
    element.style.left = `${x}px`;
    element.style.top = `${y}px`;
  }, [menu]);

  if (!menu) return null;
  const hasSelection = menu.end > menu.start;
  const writable = !menu.target.readOnly && !menu.target.disabled;

  const copy = async () => {
    if (!hasSelection || !menu.target.isConnected) return;
    selectRange(menu.target, menu.start, menu.end);
    const selected = menu.target.value.slice(menu.start, menu.end);
    try {
      await navigator.clipboard.writeText(selected);
    } catch {
      document.execCommand("copy");
    }
    setMenu(null);
  };

  const cut = async () => {
    if (!hasSelection || !writable || !menu.target.isConnected) return;
    const selected = menu.target.value.slice(menu.start, menu.end);
    try {
      await navigator.clipboard.writeText(selected);
      replaceRange(menu.target, menu.start, menu.end, "");
    } catch {
      selectRange(menu.target, menu.start, menu.end);
      document.execCommand("cut");
    }
    setMenu(null);
  };

  const paste = async () => {
    if (!writable || !menu.target.isConnected) return;
    try {
      const text = await navigator.clipboard.readText();
      replaceRange(menu.target, menu.start, menu.end, text);
    } catch {
      selectRange(menu.target, menu.start, menu.end);
      document.execCommand("paste");
    }
    setMenu(null);
  };

  return createPortal(
    <div
      ref={menuRef}
      className="spellcheck-context-menu text-edit-context-menu"
      style={{ left: menu.x, top: menu.y }}
      role="menu"
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.preventDefault()}
      onClick={(event) => event.stopPropagation()}
    >
      <button type="button" disabled={!hasSelection} onClick={() => void copy()}>{t("Копировать")}</button>
      <button type="button" disabled={!hasSelection || !writable} onClick={() => void cut()}>{t("Вырезать")}</button>
      <button type="button" disabled={!writable} onClick={() => void paste()}>{t("Вставить")}</button>
    </div>,
    document.body,
  );
}
