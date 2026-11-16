import { listen } from "@kaigen/platform";
import { isWebgateProfileId } from "./platformRouter";

type ProfileEvent = { profileId?: string; event?: unknown };

/** Local profiles keep their existing cadence; Webgate waits for actual events. */
export function watchProfileUpdates(
  profileId: string | null | undefined,
  refresh: () => unknown | Promise<unknown>,
  localIntervalMs: number,
  onResync?: () => void,
): () => void {
  const remote = isWebgateProfileId(profileId);
  let disposed = false;
  let running = false;
  let dirty = false;
  const run = () => {
    dirty = true;
    if (disposed || running || document.visibilityState !== "visible") return;
    running = true;
    void (async () => {
      try {
        while (!disposed && dirty && document.visibilityState === "visible") {
          dirty = false;
          try { await refresh(); } catch { /* The owning view displays its error. */ }
        }
      } finally {
        running = false;
        if (!disposed && dirty && document.visibilityState === "visible") run();
      }
    })();
  };
  const unlisten = remote
    ? listen<ProfileEvent>("webgate-event", ({ payload }) => {
      if (payload.profileId !== profileId) return;
      if (payload.event && typeof payload.event === "object"
        && (payload.event as { event?: unknown }).event === "resync-required") onResync?.();
      run();
    })
    : listen<string>("profiles-changed", ({ payload }) => { if (payload === profileId) run(); });
  const timer = remote ? undefined : window.setInterval(run, localIntervalMs);
  const visible = () => { if (document.visibilityState === "visible") run(); };
  document.addEventListener("visibilitychange", visible);
  window.addEventListener("focus", visible);
  window.addEventListener("online", visible);
  run();
  return () => {
    disposed = true;
    if (timer !== undefined) window.clearInterval(timer);
    document.removeEventListener("visibilitychange", visible);
    window.removeEventListener("focus", visible);
    window.removeEventListener("online", visible);
    void unlisten.then((stop) => stop());
  };
}
