import { listen, platformCapabilities } from "@kaigen/platform";
import signal from "./assets/signal.wav";
import { parseChatNotificationTarget } from "./chatNotificationTarget";
import { createNotificationSoundPlayer } from "./notificationSound";

export const NOTIFICATION_OPEN_EVENT = "kaigen-open-notification";

export function installDesktopNotifications() {
  if (!platformCapabilities.nativeFilesystem) return () => {};
  let disposed = false;
  const unlisteners: Array<() => void> = [];
  const sound = createNotificationSoundPlayer(
    () => new Audio(signal),
    () => document.visibilityState === "visible" && document.hasFocus(),
  );
  const stopOnFocus = () => sound.stop();
  window.addEventListener("focus", stopOnFocus);
  const keep = (subscription: Promise<() => void>) => {
    void subscription.then((unlisten) => disposed ? unlisten() : unlisteners.push(unlisten)).catch(() => {});
  };
  keep(listen<number>("kaigen-message-sound", (event) => { if (!disposed) sound.play(event.payload); }));
  keep(listen<{ profileId: string; target: string }>("kaigen-notification-activate", (event) => {
    if (disposed) return;
    const now = Date.now();
    const target = parseChatNotificationTarget(JSON.stringify({ ...event.payload, createdAt: now }), now);
    if (!target) return;
    // The navigation lease begins on the user's click, not when the OS showed
    // the banner. App keeps this handoff until the exact chat is open.
    sessionStorage.setItem("kaigen-open-unread-target", JSON.stringify(target));
    window.dispatchEvent(new Event(NOTIFICATION_OPEN_EVENT));
  }));
  return () => {
    disposed = true;
    window.removeEventListener("focus", stopOnFocus);
    unlisteners.forEach((unlisten) => unlisten());
    sound.dispose();
  };
}
