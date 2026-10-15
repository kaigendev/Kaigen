import { useEffect, useState } from "react";
import { applicationServerKey, bindBrowserNotificationClicks, browserNotificationPermission, notificationWorker } from "./browserNotifications";
import { webSession } from "./session";
import "./BrowserFeatures.css";

export default function BrowserFeatures({ language, controlsOnly = false }: { language: "ru" | "en"; controlsOnly?: boolean }) {
  const ru = language === "ru";
  const installed = matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  const [registration, setRegistration] = useState<ServiceWorkerRegistration | null>(null);
  const [key, setKey] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const permission = browserNotificationPermission();
  const ios = /iPad|iPhone|iPod/u.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  useEffect(() => {
    let alive = true;
    // The shell owns background registration/routing. The Settings instance
    // only reads its control state and acts on explicit user gestures.
    const stop = controlsOnly ? () => {} : bindBrowserNotificationClicks();
    void notificationWorker().then(async (worker) => {
      const subscription = await worker.pushManager?.getSubscription();
      const config = await webSession.command<{ publicKey: string; enabled: boolean }>("web_push_config", { endpoint: subscription?.endpoint });
      if (!alive) return;
      setRegistration(worker); setKey(config.publicKey);
      setEnabled(config.enabled);
      if (controlsOnly || !config.enabled || !subscription || browserNotificationPermission() !== "granted" || !alive) return;
      await webSession.command("web_push_subscribe", { subscription: subscription.toJSON(), language });
      if (alive) setEnabled(true);
    }).catch(() => { if (alive) setStatus(ru ? "Сервис уведомлений сейчас недоступен. Повторите после подключения." : "The notification service is unavailable. Try again after connecting."); });
    return () => { alive = false; stop(); };
  }, [language, controlsOnly]);

  const enable = () => {
    if (!registration?.pushManager || !key) return;
    setBusy(true); setStatus("");
    // Start subscribe in this gesture, before any asynchronous request: Safari
    // requires the user's action to authorize Home Screen notifications.
    let request: Promise<PushSubscription>;
    try {
      request = registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: applicationServerKey(key) });
    } catch {
      setStatus(ru ? "Не удалось включить уведомления. Проверьте разрешение в браузере." : "Could not enable notifications. Check your browser permission.");
      setBusy(false);
      return;
    }
    void request.then((subscription) => webSession.command("web_push_subscribe", { subscription: subscription.toJSON(), language }))
      .then(() => { setEnabled(true); setStatus(ru ? "Уведомления разрешены" : "Notifications enabled"); })
      .catch(() => setStatus(ru ? "Не удалось включить уведомления. Проверьте разрешение в браузере." : "Could not enable notifications. Check your browser permission."))
      .finally(() => setBusy(false));
  };
  const disable = async () => {
    if (!registration?.pushManager) return;
    setBusy(true); setStatus("");
    try {
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) await webSession.command("web_push_unsubscribe", { endpoint: subscription.endpoint });
      // Other workspaces may share this device subscription. Unbind only this
      // authorized workspace; do not revoke the browser's origin-wide endpoint.
      setEnabled(false);
    } catch { setStatus(ru ? "Не удалось отключить уведомления" : "Could not disable notifications"); }
    finally { setBusy(false); }
  };

  if (!controlsOnly) return null;

  return <div className="web-notification-settings">
      <p>{ru ? "Настройка действует для этого пространства на этом устройстве. Сообщения и запросы включаются отдельно для каждого профиля выше." : "This setting applies to this workspace on this device. Enable messages and requests separately for each profile above."}</p>
      {ios && !installed && <p>{ru ? "Чтобы установить Kaigen: меню браузера → «На экран Домой». Затем откройте приложение и разрешите уведомления." : "To install Kaigen: browser menu → Add to Home Screen. Then open the app and enable notifications."}</p>}
      {permission === "unsupported" || (ios && !installed) ? <p>{ru ? "Уведомления недоступны в этом режиме браузера." : "Notifications are unavailable in this browser mode."}</p> : <>
        {registration && !registration.pushManager && <p>{ru ? "Браузер не поддерживает уведомления закрытого приложения." : "This browser does not support notifications while the app is closed."}</p>}
        <button type="button" className="outline-button" disabled={busy || (!enabled && (!registration?.pushManager || !key || permission === "denied"))} onClick={() => { if (enabled) void disable(); else enable(); }}>{enabled ? (ru ? "Отключить для этого пространства" : "Disable for this workspace") : (ru ? "Включить уведомления" : "Enable notifications")}</button>
        {permission === "denied" && <p>{ru ? "Разрешите уведомления для сайта в настройках браузера." : "Allow notifications for this site in browser settings."}</p>}
      </>}
      {status && <p role="status">{status}</p>}
    </div>;
}
