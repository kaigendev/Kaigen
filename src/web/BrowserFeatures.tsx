import { useEffect, useState } from "react";
import { applicationServerKey, bindBrowserNotificationClicks, browserNotificationPermission, currentInstallOffer, notificationWorker, previewBrowserSound, type InstallPrompt } from "./browserNotifications";
import { webSession } from "./session";
import "./BrowserFeatures.css";

export default function BrowserFeatures({ language }: { language: "ru" | "en" }) {
  const ru = language === "ru";
  const [install, setInstall] = useState<InstallPrompt | null>(currentInstallOffer);
  const [installed, setInstalled] = useState(() => matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true);
  const [registration, setRegistration] = useState<ServiceWorkerRegistration | null>(null);
  const [key, setKey] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const permission = browserNotificationPermission();
  const ios = /iPad|iPhone|iPod/u.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  useEffect(() => {
    let alive = true;
    const installReady = () => setInstall(currentInstallOffer());
    const installedNow = () => { setInstalled(true); setInstall(null); };
    window.addEventListener("kaigen-install-offer", installReady);
    window.addEventListener("appinstalled", installedNow);
    const stop = bindBrowserNotificationClicks();
    void notificationWorker().then(async (worker) => {
      const subscription = await worker.pushManager?.getSubscription();
      const config = await webSession.command<{ publicKey: string; enabled: boolean }>("web_push_config", { endpoint: subscription?.endpoint });
      if (!alive) return;
      setRegistration(worker); setKey(config.publicKey);
      setEnabled(config.enabled);
      if (!config.enabled || !subscription || browserNotificationPermission() !== "granted" || !alive) return;
      await webSession.command("web_push_subscribe", { subscription: subscription.toJSON(), language });
      if (alive) setEnabled(true);
    }).catch(() => { if (alive) setStatus(ru ? "Сервис уведомлений сейчас недоступен. Повторите после подключения." : "The notification service is unavailable. Try again after connecting."); });
    return () => { alive = false; stop(); window.removeEventListener("kaigen-install-offer", installReady); window.removeEventListener("appinstalled", installedNow); };
  }, [language]);

  const enable = () => {
    if (!registration?.pushManager || !key) return;
    setBusy(true); setStatus("");
    // Start subscribe in this gesture, before any asynchronous request: Safari
    // requires the user's action to authorize Home Screen notifications.
    const request = registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: applicationServerKey(key) });
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

  return <details className="web-browser-features">
    <summary>{ru ? "Уведомления и приложение" : "Notifications and app"}</summary>
    <div className="web-browser-features-body">
      {install && !installed && <button type="button" onClick={() => { const prompt = install; setInstall(null); void prompt.prompt().then(() => prompt.userChoice).then((choice) => { if (choice.outcome === "accepted") setInstalled(true); }).catch(() => {}); }}>{ru ? "Установить Kaigen" : "Install Kaigen"}</button>}
      {ios && !installed && <p>{ru ? "Чтобы установить Kaigen: меню браузера → «На экран Домой». Затем откройте приложение и разрешите уведомления." : "To install Kaigen: browser menu → Add to Home Screen. Then open the app and enable notifications."}</p>}
      {permission === "unsupported" || (ios && !installed) ? <p>{ru ? "Уведомления недоступны в этом режиме браузера." : "Notifications are unavailable in this browser mode."}</p> : <>
        {registration && !registration.pushManager && <p>{ru ? "Браузер не поддерживает уведомления закрытого приложения." : "This browser does not support notifications while the app is closed."}</p>}
        <button type="button" disabled={busy || (!enabled && (!registration?.pushManager || !key || permission === "denied"))} onClick={() => { if (enabled) void disable(); else enable(); }}>{enabled ? (ru ? "Отключить для этого пространства" : "Disable for this workspace") : (ru ? "Включить уведомления" : "Enable notifications")}</button>
        {permission === "denied" && <p>{ru ? "Разрешите уведомления для сайта в настройках браузера." : "Allow notifications for this site in browser settings."}</p>}
      </>}
      <button type="button" onClick={() => { void previewBrowserSound().then(() => setStatus(ru ? "Звук проверен" : "Sound checked")).catch(() => setStatus(ru ? "Браузер заблокировал звук" : "The browser blocked sound")); }}>{ru ? "Проверить звук" : "Check sound"}</button>
      <p>{ru ? "Сообщения, запросы и звук включаются в настройках каждого профиля. В закрытом приложении звук зависит от настроек телефона. Уведомления приходят, пока профиль подключён на сервере и пространство действует." : "Enable messages, requests and sound in each profile’s settings. With the app closed, sound follows your phone settings. Notifications arrive while the server keeps the profile connected and the workspace is valid."}</p>
      <p>{ru ? "Если приложение закрыто, нажатие на уведомление открывает вход. Понадобится ваша ссылка на пространство." : "If the app is closed, tapping a notification opens sign-in. You will need your workspace link."}</p>
      {status && <p role="status">{status}</p>}
    </div>
  </details>;
}
