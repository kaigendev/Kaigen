import { useLayoutEffect, useSyncExternalStore } from "react";

export type CompactLayoutPreference = "auto" | "compact" | "desktop";
type LayoutSnapshot = { compact: boolean; preference: CompactLayoutPreference; availableHeight: number };
const PREFERENCE_KEY = "kaigen.interface-layout";
const CHANGE_EVENT = "kaigen-compact-layout-change";
const listeners = new Set<() => void>();
let interfaceScale = 100;
let automaticCompact: boolean | null = null;
let baselineHeight = 0;
let previousWidth = 0;
let previousOrientation = "";
let keyboardBaselineLocked = false;
let focusBaselineHeight = 0;
let exitTimer: number | undefined;
let stopObserving: (() => void) | undefined;

function readPreference(): CompactLayoutPreference {
  if (typeof window === "undefined") return "auto";
  try {
    const saved = window.localStorage.getItem(PREFERENCE_KEY);
    return saved === "compact" || saved === "desktop" ? saved : "auto";
  } catch { return "auto"; }
}

const initialPreference = readPreference();
let snapshot: LayoutSnapshot = { compact: initialPreference === "compact", preference: initialPreference, availableHeight: 0 };
const serverSnapshot: LayoutSnapshot = { compact: false, preference: "auto", availableHeight: 0 };
function publish(next: LayoutSnapshot) {
  if (next.compact === snapshot.compact && next.preference === snapshot.preference && next.availableHeight === snapshot.availableHeight) return;
  snapshot = next;
  listeners.forEach((listener) => listener());
}

function editingText() {
  const target = document.activeElement;
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement) return !target.readOnly && !target.disabled;
  return target instanceof HTMLInputElement && !target.readOnly && !target.disabled && !["button", "checkbox", "radio", "range", "file", "submit", "reset", "color", "hidden"].includes(target.type);
}

function deviceKind(): "phone" | "tablet" | "desktop" {
  const touch = navigator.maxTouchPoints > 0;
  const coarse = window.matchMedia("(pointer: coarse)").matches;
  const shortSide = Math.min(window.screen.width, window.screen.height);
  if (!touch || !coarse || !Number.isFinite(shortSide) || shortSide <= 0) return "desktop";
  if (shortSide < 600) return "phone";
  // Touch alone must not turn a Windows/Linux laptop into a tablet. Screen
  // geometry is the primary signal; mobile OS hints only disambiguate devices.
  const ua = navigator.userAgent;
  const tabletOS = /Android|iPad|iPhone|iPod/iu.test(ua)
    || /Mac/iu.test(navigator.platform) && navigator.maxTouchPoints > 1;
  return tabletOS ? "tablet" : "desktop";
}

function orientationIdentity() {
  return window.screen.orientation?.type ?? String((window as Window & { orientation?: number }).orientation ?? "unknown");
}

function measure(forceBaseline = false, applyExit = false) {
  if (typeof window === "undefined") return;
  const container = document.querySelector<HTMLElement>(".kaigen-web-app, .web-app-surface");
  // client dimensions are CSS pixels before Kaigen's own inner-shell zoom.
  // Browser/OS DPI already affects these dimensions; never divide by DPR.
  const width = container ? container.clientWidth : document.documentElement.clientWidth || window.innerWidth;
  const height = container ? container.clientHeight : document.documentElement.clientHeight || window.innerHeight;
  const orientation = orientationIdentity();
  if (!(width > 0 && height > 0)) return; // Detached/hidden container has no usable geometry.
  const widthChanged = Math.abs(width - previousWidth) > 1;
  const orientationChanged = orientation !== previousOrientation;
  const visual = window.visualViewport;
  const editing = editingText();
  const touch = navigator.maxTouchPoints > 0;
  const mobileOS = /Android|iPad|iPhone|iPod/iu.test(navigator.userAgent)
    || /Mac/iu.test(navigator.platform) && navigator.maxTouchPoints > 1;
  const mobileKeyboard = touch && mobileOS && window.matchMedia("(pointer: coarse)").matches;
  const layoutViewportHeight = document.documentElement.clientHeight || window.innerHeight;
  // An overlay keyboard shrinks visualViewport while layout geometry stays
  // intact. A normal desktop resize shrinks both, so focus cannot freeze it.
  const keyboardOverlay = touch && !!visual && Math.abs(visual.scale - 1) < .05
    && visual.height < layoutViewportHeight - 80;
  if (forceBaseline || baselineHeight <= 0 || widthChanged || orientationChanged) {
    baselineHeight = height;
    focusBaselineHeight = editing && mobileKeyboard ? height : 0;
    keyboardBaselineLocked = false;
  } else {
    if (editing && (mobileKeyboard || keyboardOverlay) && focusBaselineHeight <= 0) focusBaselineHeight = baselineHeight;
    const keyboardContracted = editing && (keyboardOverlay
      || mobileKeyboard && focusBaselineHeight > 0 && height < focusBaselineHeight - 1);
    if (keyboardContracted) {
      baselineHeight = Math.max(baselineHeight, focusBaselineHeight);
      keyboardBaselineLocked = true;
    } else if (!keyboardBaselineLocked || height >= baselineHeight - 1) {
      baselineHeight = height;
      keyboardBaselineLocked = false;
      if (!editing) focusBaselineHeight = 0;
      else if (mobileKeyboard) focusBaselineHeight = Math.max(focusBaselineHeight, height);
    }
  }
  previousWidth = width;
  previousOrientation = orientation;

  let availableHeight = height;
  if (visual) {
    const top = container ? container.getBoundingClientRect().top : 0;
    availableHeight = Math.max(0, Math.min(top + height, visual.offsetTop + visual.height) - Math.max(top, visual.offsetTop));
  }
  availableHeight = Math.round(availableHeight);
  const scale = interfaceScale / 100;
  const layoutWidth = width / scale;
  const layoutHeight = baselineHeight / scale;
  const kind = deviceKind();
  const initialCompact = kind === "phone" || (kind === "tablet"
    ? layoutWidth < 768 || layoutHeight < 500
    : layoutWidth < 900 || layoutHeight < 600);
  const enterCompact = kind === "phone" || (kind === "tablet"
    ? layoutWidth < 600 || layoutHeight < 480
    : layoutWidth < 900 || layoutHeight < 600);
  const canExit = kind !== "phone" && (kind === "tablet"
    ? layoutWidth >= 768 && layoutHeight >= 504
    : layoutWidth >= 924 && layoutHeight >= 624);

  if (automaticCompact === null) automaticCompact = initialCompact;
  if (enterCompact) automaticCompact = true;
  else if (applyExit && canExit) automaticCompact = false;
  const manual = snapshot.preference;
  const compact = manual === "auto" ? automaticCompact : manual === "compact";
  publish({ compact, preference: manual, availableHeight });
  if (automaticCompact && canExit) {
    if (exitTimer === undefined) exitTimer = window.setTimeout(() => {
      exitTimer = undefined;
      // Recheck live geometry before applying a delayed hysteresis transition.
      measure(false, true);
    }, 250);
  } else if (exitTimer !== undefined) {
    window.clearTimeout(exitTimer);
    exitTimer = undefined;
  }
}

function setPreference(preference: CompactLayoutPreference) {
  if (!["auto", "compact", "desktop"].includes(preference)) return;
  try { window.localStorage.setItem(PREFERENCE_KEY, preference); } catch { /* Session-local choice still works when storage is unavailable. */ }
  if (preference === "auto") automaticCompact = null;
  publish({ ...snapshot, preference });
  measure();
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!stopObserving && typeof window !== "undefined") {
    const resize = () => measure();
    const orient = () => measure(true);
    const focus = () => measure();
    const blur = () => window.setTimeout(resize, 0);
    const preferenceChanged = () => measure();
    const storageChanged = (event: StorageEvent) => {
      if (event.key !== PREFERENCE_KEY && event.key !== null) return;
      const preference = readPreference();
      if (preference !== snapshot.preference) { automaticCompact = null; publish({ ...snapshot, preference }); }
      measure();
    };
    const coarse = window.matchMedia("(pointer: coarse)");
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
    observer?.observe(document.querySelector(".kaigen-web-app, .web-app-surface") ?? document.documentElement);
    window.addEventListener("resize", resize);
    window.addEventListener("orientationchange", orient);
    window.addEventListener(CHANGE_EVENT, preferenceChanged);
    window.addEventListener("storage", storageChanged);
    document.addEventListener("focusin", focus);
    document.addEventListener("focusout", blur);
    coarse.addEventListener("change", resize);
    window.visualViewport?.addEventListener("resize", resize);
    window.visualViewport?.addEventListener("scroll", resize);
    measure();
    stopObserving = () => {
      observer?.disconnect();
      window.removeEventListener("resize", resize);
      window.removeEventListener("orientationchange", orient);
      window.removeEventListener(CHANGE_EVENT, preferenceChanged);
      window.removeEventListener("storage", storageChanged);
      document.removeEventListener("focusin", focus);
      document.removeEventListener("focusout", blur);
      coarse.removeEventListener("change", resize);
      window.visualViewport?.removeEventListener("resize", resize);
      window.visualViewport?.removeEventListener("scroll", resize);
      window.clearTimeout(exitTimer);
      exitTimer = undefined;
    };
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) { stopObserving?.(); stopObserving = undefined; }
  };
}

/** Explicit App scale publishes the committed appearance scale. Default callers
 * (WebRoot/Settings) subscribe without overwriting it with their default 100%. */
export function useCompactLayout(scale?: number) {
  useLayoutEffect(() => {
    if (scale === undefined || !Number.isFinite(scale) || scale <= 0 || interfaceScale === scale) return;
    interfaceScale = scale;
    measure();
  }, [scale]);
  const state = useSyncExternalStore(subscribe, () => snapshot, () => serverSnapshot);
  return { ...state, setPreference };
}
