type ListenerTarget = Pick<EventTarget, "addEventListener" | "removeEventListener">;

export type InputLanguageSyncOptions = {
  enabled: boolean;
  windowTarget: ListenerTarget;
  documentTarget: ListenerTarget & Pick<Document, "visibilityState" | "hasFocus">;
  timers: {
    set: (callback: () => void, delayMs: number) => number;
    clear: (timerId: number) => void;
  };
  notify: () => void;
};

const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta"]);
const BURST_DELAYS_MS = [0, 60, 160] as const;

/** Ask the native owner to sample its current input language; never handle text or layout here. */
export function installInputLanguageSync(options: InputLanguageSyncOptions): () => void {
  if (!options.enabled) return () => {};

  let disposed = false;
  let blurred = false;
  let composing = false;
  let burst: { timers: Set<number>; revision: number } | null = null;

  const cancelBurst = () => {
    if (!burst) return;
    burst.revision += 1;
    for (const timerId of burst.timers) options.timers.clear(timerId);
    burst = null;
  };

  const requestSample = () => {
    if (disposed || blurred || composing || !options.documentTarget.hasFocus()
      || options.documentTarget.visibilityState !== "visible") return;
    // Each release/focus edge needs two fresh post-edge samples, even when an
    // earlier edge already consumed part of its own burst while another key held.
    cancelBurst();
    const current = { timers: new Set<number>(), revision: 0 };
    burst = current;
    const revision = current.revision;
    for (const delayMs of BURST_DELAYS_MS) {
      const timerId = options.timers.set(() => {
        current.timers.delete(timerId);
        if (disposed || blurred || composing || !options.documentTarget.hasFocus()
          || options.documentTarget.visibilityState !== "visible"
          || burst !== current || current.revision !== revision) return;
        if (current.timers.size === 0) burst = null;
        options.notify();
      }, delayMs);
      current.timers.add(timerId);
    }
  };

  const onKeyDown: EventListener = (event) => {
    const keyEvent = event as KeyboardEvent;
    if (!MODIFIER_KEYS.has(keyEvent.key) || keyEvent.repeat) return;
    cancelBurst();
    if (keyEvent.isComposing || disposed || blurred || composing || !options.documentTarget.hasFocus()
      || options.documentTarget.visibilityState !== "visible") return;
    // Request a baseline sample at the start of the shortcut. No key is handled here.
    options.notify();
  };
  const onKeyUp: EventListener = (event) => {
    const keyEvent = event as KeyboardEvent;
    if (keyEvent.isComposing) {
      cancelBurst();
      return;
    }
    if (MODIFIER_KEYS.has(keyEvent.key)) requestSample();
  };
  const onFocusIn: EventListener = () => {
    if (!options.documentTarget.hasFocus()) return;
    blurred = false;
    requestSample();
  };
  const onFocus: EventListener = () => {
    if (!options.documentTarget.hasFocus()) return;
    blurred = false;
    requestSample();
  };
  const onBlur: EventListener = () => { blurred = true; composing = false; cancelBurst(); };
  const onVisibilityChange: EventListener = () => {
    if (options.documentTarget.visibilityState === "visible") requestSample();
    else { composing = false; cancelBurst(); }
  };
  const onCompositionStart: EventListener = () => { composing = true; cancelBurst(); };
  const onCompositionEnd: EventListener = () => { composing = false; requestSample(); };

  options.windowTarget.addEventListener("keydown", onKeyDown);
  options.windowTarget.addEventListener("keyup", onKeyUp);
  options.windowTarget.addEventListener("focus", onFocus);
  options.windowTarget.addEventListener("blur", onBlur);
  options.documentTarget.addEventListener("focusin", onFocusIn);
  options.documentTarget.addEventListener("visibilitychange", onVisibilityChange);
  options.documentTarget.addEventListener("compositionstart", onCompositionStart);
  options.documentTarget.addEventListener("compositionend", onCompositionEnd);
  requestSample();

  return () => {
    if (disposed) return;
    disposed = true;
    cancelBurst();
    options.windowTarget.removeEventListener("keydown", onKeyDown);
    options.windowTarget.removeEventListener("keyup", onKeyUp);
    options.windowTarget.removeEventListener("focus", onFocus);
    options.windowTarget.removeEventListener("blur", onBlur);
    options.documentTarget.removeEventListener("focusin", onFocusIn);
    options.documentTarget.removeEventListener("visibilitychange", onVisibilityChange);
    options.documentTarget.removeEventListener("compositionstart", onCompositionStart);
    options.documentTarget.removeEventListener("compositionend", onCompositionEnd);
  };
}
