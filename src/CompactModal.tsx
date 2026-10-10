import { useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import { platformCapabilities } from "@kaigen/platform";
import { useI18n } from "./i18n";

type LayerGroup = { roots: HTMLElement[]; original: Map<HTMLElement, boolean> };
const groups = new Map<HTMLElement, LayerGroup>();
const historyLayers = new Map<string, { previous: string | undefined; closed: boolean }>();
let historyCleanupQueued = false;
function releaseHistoryLayer(id: string) {
  const layer = historyLayers.get(id);
  if (layer) layer.closed = true;
  if (historyCleanupQueued) return;
  historyCleanupQueued = true;
  queueMicrotask(() => {
    historyCleanupQueued = false;
    let current = history.state?.kaigenModalLayer as string | undefined;
    let count = 0;
    while (current && historyLayers.get(current)?.closed) {
      const prior = historyLayers.get(current)!.previous;
      historyLayers.delete(current);
      current = prior;
      count += 1;
    }
    // Back already traversed a layer when popstate caused its dismissal.
    for (const [key, value] of historyLayers) if (value.closed) historyLayers.delete(key);
    if (count) history.go(-count);
  });
}
function updateLayers(parent: HTMLElement, group: LayerGroup) {
  const top = group.roots[group.roots.length - 1];
  for (const child of Array.from(parent.children)) {
    if (!(child instanceof HTMLElement)) continue;
    if (!group.original.has(child)) group.original.set(child, child.inert);
    child.inert = top ? child !== top : group.original.get(child)!;
  }
  if (!top) groups.delete(parent);
}

export function CompactModal({ children, label, onClose, className = "", returnFocus, historyLayer = true }: {
  children: ReactNode; label: string; onClose: () => void; className?: string;
  returnFocus?: RefObject<HTMLElement | null>; historyLayer?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const close = useRef(onClose); close.current = onClose;
  const requestClose = useRef(onClose);
  useLayoutEffect(() => {
    const root = host.current;
    const parent = root?.parentElement;
    if (!root || !parent) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const group = groups.get(parent) ?? { roots: [], original: new Map<HTMLElement, boolean>() };
    groups.set(parent, group);
    group.roots.push(root); updateLayers(parent, group);
    const topmost = () => group.roots[group.roots.length - 1] === root;
    const targets = () => Array.from(root.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href],[tabindex]:not([tabindex="-1"])')).filter((node) => node.getClientRects().length > 0 && !node.closest("[inert]"));
    (targets()[0] ?? root).focus();
    const layerId = historyLayer && platformCapabilities.browserAuthorization ? crypto.randomUUID() : null;
    if (layerId) {
      historyLayers.set(layerId, { previous: history.state?.kaigenModalLayer, closed: false });
      history.pushState({ ...history.state, kaigenModalLayer: layerId }, "");
    }
    requestClose.current = () => close.current();
    const pop = (event: PopStateEvent) => {
      if (layerId && topmost() && event.state?.kaigenModalLayer !== layerId) close.current();
    };
    const keys = (event: KeyboardEvent) => {
      if (!topmost()) return;
      if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); requestClose.current(); return; }
      if (event.key !== "Tab") return;
      const focusable = targets(); const first = focusable[0]; const last = focusable[focusable.length - 1];
      if (!first) { event.preventDefault(); root.focus(); return; }
      if (event.shiftKey && (document.activeElement === first || !root.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !root.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    const focus = (event: FocusEvent) => { if (topmost() && event.target instanceof Node && !root.contains(event.target)) (targets()[0] ?? root).focus(); };
    document.addEventListener("keydown", keys); document.addEventListener("focusin", focus);
    window.addEventListener("popstate", pop);
    return () => {
      document.removeEventListener("keydown", keys); document.removeEventListener("focusin", focus);
      window.removeEventListener("popstate", pop);
      const index = group.roots.indexOf(root);
      if (index >= 0) group.roots.splice(index, 1);
      updateLayers(parent, group);
      // Action buttons may dismiss a sheet directly. Remove only its own entry.
      if (layerId) releaseHistoryLayer(layerId);
      const target = returnFocus?.current ?? previous;
      if (target?.isConnected && !target.closest("[inert]")) target.focus();
    };
  }, [returnFocus, historyLayer]);
  return <div ref={host} className="compact-modal-backdrop" tabIndex={-1} onPointerDown={(event) => { if (event.target === event.currentTarget) requestClose.current(); }} onClick={(event) => event.stopPropagation()}>
    <div className={`compact-modal ${className}`} role="dialog" aria-modal="true" aria-label={label}>{children}</div>
  </div>;
}

export function CompactMenu({ compact, children, label, onClose }: { compact: boolean; children: ReactNode; label: string; onClose: () => void }) {
  const { t } = useI18n();
  return compact ? <CompactModal label={label} onClose={onClose}>
    <button type="button" className="compact-sheet-close compact-action" onClick={onClose} aria-label={t("Закрыть")}>×</button>
    {children}
  </CompactModal> : <>{children}</>;
}
