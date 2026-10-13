import signal from "../assets/signal.wav";
import { parseChatNotificationTarget } from "../chatNotificationTarget";
import { NOTIFICATION_OPEN_EVENT } from "../desktopNotifications";
import { webSession } from "./session";

let worker: Promise<ServiceWorkerRegistration> | undefined;
let audio: HTMLAudioElement | undefined;
type ScriptPolicy = { createScriptURL: (value: string) => unknown };
let scriptPolicy: ScriptPolicy | undefined;
export type InstallPrompt = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };
let installOffer: InstallPrompt | null = null;
window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault(); installOffer = event as InstallPrompt;
  window.dispatchEvent(new Event("kaigen-install-offer"));
});
window.addEventListener("appinstalled", () => { installOffer = null; });
export function currentInstallOffer() { return installOffer; }

function workerScriptUrl() {
  const path = new URL("/kaigen-notifications-sw.js", location.origin).href;
  const factory = (globalThis as typeof globalThis & { trustedTypes?: { createPolicy: (name: string, rules: { createScriptURL: (value: string) => string }) => ScriptPolicy } }).trustedTypes;
  if (!factory) return path;
  scriptPolicy ??= factory.createPolicy("kaigen-notifications-worker", { createScriptURL: (value) => {
    if (value !== path) throw new TypeError("Unexpected notification worker URL");
    return path;
  } });
  return scriptPolicy.createScriptURL(path) as string;
}

export function browserNotificationPermission(): NotificationPermission | "unsupported" {
  return window.isSecureContext && "Notification" in window ? Notification.permission : "unsupported";
}

export function notificationWorker() {
  if (!window.isSecureContext || !("serviceWorker" in navigator)) return Promise.reject(new Error("WEB_NOTIFICATIONS_UNAVAILABLE"));
  worker ??= navigator.serviceWorker.register(workerScriptUrl(), { scope: "/", updateViaCache: "none" })
    .then(() => navigator.serviceWorker.ready).catch((error: unknown) => { worker = undefined; throw error; });
  return worker;
}

export function previewBrowserSound() {
  audio ??= new Audio(signal);
  audio.volume = 0.7;
  audio.currentTime = 0;
  return audio.play();
}

export async function displayBrowserNotification(options: { title: string; body?: string }) {
  if (browserNotificationPermission() !== "granted") return;
  const registration = await notificationWorker();
  await registration.showNotification(options.title, { body: options.body, icon: "/kaigen-icon.png", tag: "kaigen-events" });
}

export function bindBrowserNotificationClicks() {
  if (!("serviceWorker" in navigator)) return () => {};
  const handle = (event: MessageEvent) => {
    if (event.source !== navigator.serviceWorker.controller || !event.data || typeof event.data !== "object") return;
    if (event.data.type === "kaigen-notification-query") {
      void webSession.command<{ matched: boolean }>("web_push_target", { routingHint: event.data.routingHint })
        .then((value) => event.ports[0]?.postMessage({ matched: value.matched })).catch(() => event.ports[0]?.postMessage({ matched: false }));
      return;
    }
    if (event.data.type !== "kaigen-notification-open") return;
    void webSession.command<{ matched: boolean; target: { profileId: string; target: string } | null }>("web_push_target", { routingHint: event.data.routingHint }).then((value) => {
      if (!value.matched) return;
      const target = parseChatNotificationTarget(JSON.stringify({ ...value.target, createdAt: Date.now() }), Date.now());
      if (!target) return;
      sessionStorage.setItem("kaigen-open-unread-target", JSON.stringify(target));
      window.dispatchEvent(new Event(NOTIFICATION_OPEN_EVENT));
    }).catch(() => {});
  };
  const stopSound = () => audio?.pause();
  navigator.serviceWorker.addEventListener("message", handle);
  window.addEventListener("focus", stopSound);
  return () => {
    navigator.serviceWorker.removeEventListener("message", handle);
    window.removeEventListener("focus", stopSound);
    stopSound();
  };
}

export function applicationServerKey(value: string): Uint8Array<ArrayBuffer> {
  const bytes = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bytes, (char) => char.charCodeAt(0));
}
