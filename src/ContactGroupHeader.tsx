import { useEffect, useRef } from "react";
import { ProfileReorderGesture } from "./profileReorderGesture";
import { useI18n } from "./i18n";

type DropTarget = { id: string; edge: "before" | "after" };
type Props = {
  disabled: boolean;
  uiId: string;
  entityKey: string;
  id: string;
  name: string;
  collapsed: boolean;
  unread: number;
  onToggle: () => void;
  onReorder: (targetId: string, edge: "before" | "after") => void;
  onDragChange: (dragging: boolean, target: DropTarget | null) => void;
  onMove: (direction: -1 | 1) => void;
  onContext: (x: number, y: number) => void;
};

/** Share the profile gesture threshold; contacts retain their own row markup. */
export function ContactGroupHeader({ disabled, uiId, entityKey, id, name, collapsed, unread, onToggle, onReorder, onDragChange, onMove, onContext }: Props) {
  const { t } = useI18n();
  const gesture = useRef(new ProfileReorderGesture());
  const capture = useRef<{ element: HTMLButtonElement; pointerId: number } | null>(null);
  const suppressClick = useRef(false);
  const dragChange = useRef(onDragChange);
  dragChange.current = onDragChange;
  const cancelDrag = () => {
    gesture.current.cancel();
    const ownedCapture = capture.current;
    capture.current = null;
    if (ownedCapture) {
      if (ownedCapture.element.hasPointerCapture(ownedCapture.pointerId)) ownedCapture.element.releasePointerCapture(ownedCapture.pointerId);
      dragChange.current(false, null);
    }
  };
  const dropAtPoint = (x: number, y: number): DropTarget | null => {
    const target = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-contact-group-region]");
    const targetId = target?.dataset.contactGroupRegion;
    const list = capture.current?.element.closest(".chat-items");
    if (!target || !list?.contains(target) || !targetId || targetId === id) return null;
    const bounds = target.getBoundingClientRect();
    return { id: targetId, edge: y < bounds.top + bounds.height / 2 ? "before" : "after" };
  };
  useEffect(() => () => cancelDrag(), []);
  useEffect(() => { if (disabled) cancelDrag(); }, [disabled]);
  return <button disabled={disabled} type="button" draggable={false} className="contact-group-header" data-contact-group-id={id} data-kaigen-ui-id={uiId} data-kaigen-ui-entity-key={entityKey}
    aria-expanded={!collapsed} aria-label={name} title={name}
    onDragStart={(event) => event.preventDefault()}
    onPointerDown={(event) => {
      suppressClick.current = false;
      if (disabled || event.button !== 0 || !event.isPrimary || event.ctrlKey || (event.pointerType === "touch" && event.currentTarget.closest(".ultra-compact"))) return;
      if (!gesture.current.begin(event.pointerId, id, event.clientX, event.clientY)) return;
      capture.current = { element: event.currentTarget, pointerId: event.pointerId };
      event.currentTarget.setPointerCapture(event.pointerId);
    }}
    onPointerMove={(event) => {
      if (!gesture.current.move(event.pointerId, event.clientX, event.clientY)) return;
      event.preventDefault();
      suppressClick.current = true;
      dragChange.current(true, dropAtPoint(event.clientX, event.clientY));
    }}
    onPointerUp={(event) => {
      if (!gesture.current.owns(event.pointerId)) return;
      const dragged = gesture.current.finish(event.pointerId);
      const target = dragged ? dropAtPoint(event.clientX, event.clientY) : null;
      if (dragged) suppressClick.current = true;
      if (!disabled && dragged && target) onReorder(target.id, target.edge);
      cancelDrag();
    }}
    onPointerCancel={(event) => { if (gesture.current.owns(event.pointerId)) { suppressClick.current = true; cancelDrag(); } }}
    onLostPointerCapture={(event) => { if (gesture.current.owns(event.pointerId)) cancelDrag(); }}
    onClick={(event) => {
      event.stopPropagation();
      if (suppressClick.current) { suppressClick.current = false; return; }
      if (event.ctrlKey && /Mac/i.test(navigator.platform)) { onContext(event.clientX, event.clientY); return; }
      onToggle();
    }}
    onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); cancelDrag(); onContext(event.clientX, event.clientY); }}
    onKeyDown={(event) => {
      const activePointer = capture.current !== null;
      const contextKey = event.key === "ContextMenu" || (event.shiftKey && event.key === "F10");
      const moveKey = event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown");
      if (contextKey || moveKey || (event.key === "Escape" && activePointer)) {
        cancelDrag();
        suppressClick.current = activePointer;
      } else if (!activePointer) suppressClick.current = false;
      if (contextKey) {
        event.preventDefault(); event.stopPropagation();
        const bounds = event.currentTarget.getBoundingClientRect(); onContext(bounds.left + 16, bounds.top + 16);
      } else if (moveKey) {
        event.preventDefault(); event.stopPropagation(); onMove(event.key === "ArrowUp" ? -1 : 1);
      } else if (event.key === "Escape" && activePointer) {
        event.preventDefault(); event.stopPropagation();
      }
    }}>
    <svg className="contact-group-symbol" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 4h5l2 2h5v7H2z" /></svg>
    <svg className={`contact-group-chevron ${collapsed ? "" : "expanded"}`} viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3 5 5-5 5" /></svg>
    <strong className="contact-group-name" data-i18n-ignore translate="no">{name}</strong>
    {collapsed && unread > 0 && <b className="contact-unread-count" title={t("Новые события группы")} aria-label={`${t("Новые события группы")}: ${unread}`}>{unread}</b>}
  </button>;
}
