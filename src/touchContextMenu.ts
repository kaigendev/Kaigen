import { isEditableTextTarget } from "./editableTextTarget";

const MENU_TARGETS = ".chat-item, [data-message-key], .profile-switcher-item";
const HOLD_MS = 550;
const MOVE_TOLERANCE = 10;
const CLICK_WINDOW_MS = 900;

/** Reuse the existing contextmenu route without taking ownership of scrolling. */
export function attachTouchContextMenu(root: HTMLElement): () => void {
  const document = root.ownerDocument;
  const view = document.defaultView;
  if (!view) return () => {};
  const touches = new Set<number>();
  let pending: {
    pointerId: number; target: Element; node: Element; x: number; y: number;
    timer: number | undefined; opened: boolean; addedClass: boolean;
  } | undefined;
  let suppressed: { node: Element; until: number } | undefined;
  let dispatching = false;
  const cancelPending = () => {
    if (pending?.timer !== undefined) view.clearTimeout(pending.timer);
    if (pending?.addedClass) pending.node.classList.remove("touch-context-press");
    pending = undefined;
  };
  const cancel = () => {
    if (pending?.opened && suppressed) suppressed.until = Date.now() + CLICK_WINDOW_MS;
    cancelPending();
  };
  const clear = () => { cancelPending(); touches.clear(); suppressed = undefined; };

  const onPointerDown = (event: PointerEvent) => {
    // Every new gesture, including a mouse click, can act normally.
    suppressed = undefined;
    if (event.pointerType !== "touch") { cancelPending(); return; }
    touches.add(event.pointerId);
    cancelPending();
    if (touches.size !== 1 || !event.isPrimary || event.button !== 0) return;
    const target = event.target;
    if (!(target instanceof Element) || !root.contains(target) || isEditableTextTarget(target)
      || target.closest('[role="menu"], .contact-context-menu')) return;
    const node = target.closest(MENU_TARGETS);
    if (!node || !root.contains(node)) return;
    const gesture = {
      pointerId: event.pointerId, target, node, x: event.clientX, y: event.clientY,
      timer: undefined as number | undefined, opened: false,
      addedClass: !node.classList.contains("touch-context-press"),
    };
    pending = gesture;
    if (gesture.addedClass) node.classList.add("touch-context-press");
    gesture.timer = view.setTimeout(() => {
      gesture.timer = undefined;
      if (pending !== gesture || touches.size !== 1 || !target.isConnected
        || !root.contains(target) || target.closest(MENU_TARGETS) !== node) return cancelPending();
      const contextEvent = new MouseEvent("contextmenu", {
        bubbles: true, cancelable: true, view,
        clientX: gesture.x, clientY: gesture.y, button: 2, buttons: 0,
      });
      dispatching = true;
      try { target.dispatchEvent(contextEvent); } finally { dispatching = false; }
      if (contextEvent.defaultPrevented) {
        gesture.opened = true;
        suppressed = { node, until: Number.POSITIVE_INFINITY };
      }
    }, HOLD_MS);
  };
  const onPointerMove = (event: PointerEvent) => {
    if (pending?.pointerId !== event.pointerId) return;
    if (Math.hypot(event.clientX - pending.x, event.clientY - pending.y) > MOVE_TOLERANCE) cancel();
  };
  const onPointerEnd = (event: PointerEvent) => {
    touches.delete(event.pointerId);
    if (pending?.pointerId === event.pointerId) cancel();
  };
  const onClick = (event: MouseEvent) => {
    if (!suppressed) return;
    if (Date.now() > suppressed.until || !suppressed.node.isConnected) { suppressed = undefined; return; }
    if (!(event.target instanceof Node) || !suppressed.node.contains(event.target)) return;
    if (event.detail === 0 && !(event instanceof PointerEvent && event.pointerType === "touch")) return;
    suppressed = undefined;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const onCompatibilityMouse = (event: MouseEvent) => {
    if (!suppressed || Date.now() > suppressed.until || !suppressed.node.isConnected
      || event.detail === 0 || !(event.target instanceof Node)
      || !suppressed.node.contains(event.target)) return;
    // Touch can generate mousedown/up before click-away handlers see click.
    // A deliberate mouse pointerdown has already cleared this suppression.
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const onContextMenu = (event: MouseEvent) => {
    if (dispatching) return;
    if (suppressed && Date.now() <= suppressed.until
      && event.target instanceof Node && suppressed.node.contains(event.target)) {
      event.preventDefault(); event.stopImmediatePropagation(); return;
    }
    // A browser that supplies its own touch contextmenu wins over the timer.
    const gesture = pending;
    if (!gesture || !(event.target instanceof Node) || !gesture.node.contains(event.target)) return;
    if (gesture.timer !== undefined) view.clearTimeout(gesture.timer);
    gesture.timer = undefined;
    queueMicrotask(() => {
      if (pending === gesture && event.defaultPrevented) {
        gesture.opened = true;
        suppressed = { node: gesture.node, until: Number.POSITIVE_INFINITY };
      }
    });
  };
  const onVisibilityChange = () => { if (document.hidden) clear(); };

  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("pointermove", onPointerMove, true);
  document.addEventListener("pointerup", onPointerEnd, true);
  document.addEventListener("pointercancel", onPointerEnd, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("mousedown", onCompatibilityMouse, true);
  document.addEventListener("mouseup", onCompatibilityMouse, true);
  document.addEventListener("contextmenu", onContextMenu, true);
  document.addEventListener("scroll", cancel, true);
  document.addEventListener("visibilitychange", onVisibilityChange);
  view.addEventListener("blur", clear);
  return () => {
    clear();
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("pointermove", onPointerMove, true);
    document.removeEventListener("pointerup", onPointerEnd, true);
    document.removeEventListener("pointercancel", onPointerEnd, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("mousedown", onCompatibilityMouse, true);
    document.removeEventListener("mouseup", onCompatibilityMouse, true);
    document.removeEventListener("contextmenu", onContextMenu, true);
    document.removeEventListener("scroll", cancel, true);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    view.removeEventListener("blur", clear);
  };
}
