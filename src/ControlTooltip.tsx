import { useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import "./ControlTooltip.css";

type Tooltip = { target: HTMLButtonElement; text: string };
type Props = { className?: string; children: ReactNode };

/** Opt in toolbar buttons with data-control-tooltip; keep their aria-labels. */
export default function ControlTooltip({ className, children }: Props) {
  const id = useId();
  const scopeRef = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const pressedRef = useRef<HTMLButtonElement | null>(null);
  const [tooltip, setTooltip] = useState<Tooltip | null>(null);
  const [position, setPosition] = useState<CSSProperties | null>(null);

  const targetFor = (node: EventTarget | null) => {
    if (!(node instanceof Element)) return null;
    const button = node.closest<HTMLButtonElement>("button[data-control-tooltip]");
    return button && scopeRef.current?.contains(button) ? button : null;
  };

  const close = () => setTooltip(null);
  const show = (target: HTMLButtonElement) => {
    const text = target.dataset.controlTooltip?.trim();
    if (!text) return close();
    setPosition(null);
    setTooltip({ target, text });
  };

  // Inspect committed attributes, including changed language/action labels.
  useLayoutEffect(() => {
    if (!tooltip) return;
    const text = tooltip.target.dataset.controlTooltip?.trim();
    if (!tooltip.target.isConnected || !text) setTooltip(null);
    else if (text !== tooltip.text) setTooltip({ target: tooltip.target, text });
  }, [children, tooltip]);

  useLayoutEffect(() => {
    const popup = popupRef.current;
    if (!tooltip || !popup || !tooltip.target.isConnected) return;
    const target = tooltip.target;
    const previousDescription = target.getAttribute("aria-describedby");
    const descriptions = previousDescription?.split(/\s+/).filter(Boolean) ?? [];
    target.setAttribute("aria-describedby", [...descriptions, id].join(" "));

    const theme = getComputedStyle(target);
    const typography = getComputedStyle(scopeRef.current ?? target);
    const fontSize = `${Math.max(12, parseFloat(typography.fontSize) * 0.875)}px`;
    // Toolbar typography keeps icon buttons from changing the tooltip size.
    popup.style.fontFamily = typography.fontFamily;
    popup.style.fontSize = fontSize;
    const anchor = target.getBoundingClientRect();
    const bounds = popup.getBoundingClientRect();
    const inset = 8;
    const gap = 6;
    const width = document.documentElement.clientWidth;
    const height = document.documentElement.clientHeight;
    const left = Math.max(inset, Math.min(anchor.left + (anchor.width - bounds.width) / 2, width - bounds.width - inset));
    const below = anchor.bottom + gap;
    const top = Math.max(inset, Math.min(below + bounds.height <= height - inset ? below : anchor.top - gap - bounds.height, height - bounds.height - inset));
    setPosition({
      left,
      top,
      color: theme.getPropertyValue("--kaigen-color-text").trim() || theme.color,
      backgroundColor: theme.getPropertyValue("--kaigen-color-panel").trim() || theme.getPropertyValue("--kaigen-color-background").trim() || "#202837",
      borderColor: theme.getPropertyValue("--ui-border").trim() || "#6b7280",
      fontFamily: typography.fontFamily,
      fontSize,
    });

    const dismiss = () => setTooltip(null);
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") dismiss(); };
    window.addEventListener("blur", dismiss);
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("pointerdown", dismiss, true);
    window.addEventListener("keydown", escape);
    return () => {
      // Remove only our token if another owner changed the description meanwhile.
      const current = target.getAttribute("aria-describedby");
      const expected = [...descriptions, id].join(" ");
      if (current === expected) {
        if (previousDescription === null) target.removeAttribute("aria-describedby");
        else target.setAttribute("aria-describedby", previousDescription);
      } else if (current) {
        const remaining = current.split(/\s+/).filter((token) => token && token !== id).join(" ");
        if (remaining) target.setAttribute("aria-describedby", remaining);
        else target.removeAttribute("aria-describedby");
      }
      window.removeEventListener("blur", dismiss);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("pointerdown", dismiss, true);
      window.removeEventListener("keydown", escape);
    };
  }, [tooltip, id]);

  return <div className={className} ref={scopeRef}
    onPointerOverCapture={(event) => {
      if (event.pointerType === "touch") return;
      const target = targetFor(event.target);
      if (!target || targetFor(event.relatedTarget) === target) return;
      pressedRef.current = null;
      show(target);
    }}
    onPointerOutCapture={(event) => {
      const target = targetFor(event.target);
      if (!target || targetFor(event.relatedTarget) === target) return;
      if (pressedRef.current === target) pressedRef.current = null;
      close();
    }}
    onFocusCapture={(event) => {
      const target = targetFor(event.target);
      if (target && pressedRef.current !== target) show(target);
    }}
    onBlurCapture={() => { pressedRef.current = null; close(); }}
    onPointerDownCapture={(event) => { pressedRef.current = targetFor(event.target); close(); }}
    onKeyDownCapture={(event) => {
      if (event.key === "Escape" || event.key === "Enter" || event.key === " ") close();
    }}
  >
    {children}
    {tooltip && createPortal(<div ref={popupRef} id={id} role="tooltip" className="control-tooltip"
      style={{ ...position, visibility: position ? "visible" : "hidden" }}>{tooltip.text}</div>, document.body)}
  </div>;
}
