import { useEffect, useRef, useState } from "react";
import { bindBrowserNotificationClicks, bindBrowserNotificationView, browserNotificationPermission, cancelBrowserPushEnable, disableBrowserPush, enableBrowserPush, NATIVE_PUSH_SUBSCRIPTION_UNAVAILABLE, watchBrowserPush } from "./browserNotifications";
import type { BrowserPushView } from "./browserNotifications";
import "./BrowserFeatures.css";

const notificationStatusMessages = {
  unavailable: { ru: "Сервис уведомлений сейчас недоступен. Повторите после подключения.", en: "The notification service is unavailable. Try again after connecting." },
  workerUnavailable: { ru: "Браузер не подготовил уведомления. Повторите подключение. Если ошибка сохраняется, обновите страницу.", en: "The browser could not prepare notifications. Retry the connection. If it still fails, reload the page." },
  configurationUnavailable: { ru: "Не удалось подключиться к сервису уведомлений. Повторите подключение.", en: "Could not connect to the notification service. Retry the connection." },
  storageUnavailable: { ru: "Не удалось сохранить переход из уведомления. Проверьте доступ сайта к хранилищу и повторите подключение.", en: "Could not save the notification destination. Check this site's storage access and retry the connection." },
  subscriptionUnavailable: { ru: "Не удалось проверить подписку браузера. Повторите подключение.", en: "Could not check the browser subscription. Retry the connection." },
  enabled: { ru: "Уведомления разрешены", en: "Notifications enabled" },
  nativeSubscriptionUnavailable: { ru: "Браузер не выдал рабочую подписку. Push на этом устройстве недоступен.", en: "The browser did not provide a working subscription. Push is unavailable on this device." },
  enableFailed: { ru: "Не удалось включить уведомления. Повторите попытку.", en: "Could not enable notifications. Try again." },
  permissionDenied: { ru: "Браузер или ОС не разрешили уведомления.", en: "The browser or OS did not allow notifications." },
  enableCancelled: { ru: "Включение отменено. Если запрос браузера или ОС остаётся открытым, закройте его.", en: "Enabling notifications was cancelled. Dismiss the browser or OS prompt if it is still open." },
  reenableRequired: { ru: "Подписка истекла. Нажмите «Включить уведомления» ещё раз.", en: "The subscription expired. Click Enable notifications again." },
  disableSyncFailed: { ru: "Не удалось отключить уведомления на сервере. Повторите после подключения.", en: "Could not disable notifications on the server. Try again after connecting." },
  disableFailed: { ru: "Не удалось отключить уведомления", en: "Could not disable notifications" },
} as const;
type NotificationStatus = keyof typeof notificationStatusMessages | "";

export default function BrowserFeatures({ language, controlsOnly = false }: { language: "ru" | "en"; controlsOnly?: boolean }) {
  const ru = language === "ru";
  const installed = matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  const [view, setView] = useState<BrowserPushView>({ registration: null, publicKey: "", enabled: false, busy: false, error: false });
  const [status, setStatus] = useState<NotificationStatus>("");
  const mounted = useRef(true);
  const { registration, enabled, busy, publicKey: key } = view;
  const controlBusy = view.controlBusy ?? busy;
  const permission = browserNotificationPermission();
  // A cleared browser grant needs a new click even if server consent remains enabled.
  const showDisable = enabled && permission !== "default";
  const ios = /iPad|iPhone|iPod/u.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  useEffect(() => {
    let alive = true;
    mounted.current = true;
    const stopClicks = controlsOnly ? () => {} : bindBrowserNotificationClicks();
    const stopView = controlsOnly ? () => {} : bindBrowserNotificationView();
    const stop = watchBrowserPush(language, (next) => {
      if (!alive) return;
      setView(next);
      if (next.consentPending) { setStatus(""); return; }
      if (next.enableFailure) { setStatus(""); return; }
      if (!next.binding && !next.error) { setStatus(""); return; }
      if (next.error) setStatus(current => current === "enableFailed" || current === "reenableRequired" ? current : next.error === NATIVE_PUSH_SUBSCRIPTION_UNAVAILABLE ? "nativeSubscriptionUnavailable"
        : next.failure?.stage === "worker" ? "workerUnavailable"
        : next.failure?.stage === "configuration" ? "configurationUnavailable"
        : next.failure?.stage === "storage" ? "storageUnavailable"
        : next.failure?.stage === "subscription" ? "subscriptionUnavailable" : "unavailable");
      else setStatus(current => (!next.enabled && current === "enabled")
        || ["enableFailed", "reenableRequired", "unavailable", "nativeSubscriptionUnavailable", "workerUnavailable", "configurationUnavailable", "storageUnavailable", "subscriptionUnavailable"].includes(current) ? "" : current);
    });
    return () => { alive = false; mounted.current = false; stop(); stopClicks(); stopView(); };
  }, [language, controlsOnly, ru]);

  const enable = () => {
    const binding = view.binding;
    setStatus("");
    // enableBrowserPush starts subscribe synchronously in THIS click gesture.
    try {
      const operation = enableBrowserPush(view, language);
      const revision = binding?.state.revision;
      void operation.then(() => {
        if (mounted.current && binding?.session.isCurrent() && binding.state.revision === revision) setStatus("enabled");
      }).catch(() => { /* The controller publishes the current decision's failure; a late completion must not replace Cancel/Disable. */ });
    } catch { if (binding?.session.isCurrent()) setStatus("enableFailed"); }
  };
  const disable = () => {
    const binding = view.binding;
    setStatus("");
    try {
      void disableBrowserPush(view).catch(() => {
        if (mounted.current && binding?.session.isCurrent()) setStatus("disableSyncFailed");
      });
    } catch { setStatus("disableFailed"); }
  };
  const cancelEnable = () => {
    const binding = view.binding;
    setStatus("enableCancelled");
    void cancelBrowserPushEnable(view).catch(() => {
      if (mounted.current && binding?.session.isCurrent()) setStatus("disableSyncFailed");
    });
  };

  const actionStatus = view.consentPending ? "" : view.enableFailure ?? status;
  const renderedStatus = permission === "denied" && actionStatus === "enableFailed" ? "permissionDenied"
    : permission !== "granted" && actionStatus === "enabled" ? "" : actionStatus;
  if (!controlsOnly) return null;

  return <div className="web-notification-settings">
      <p>{ru ? "Настройка действует для этого пространства на этом устройстве. Сообщения и запросы включаются отдельно для каждого профиля выше." : "This setting applies to this workspace on this device. Enable messages and requests separately for each profile above."}</p>
      {ios && !installed && <p>{ru ? "Чтобы установить Kaigen: меню браузера → «На экран Домой». Затем откройте приложение и разрешите уведомления." : "To install Kaigen: browser menu → Add to Home Screen. Then open the app and enable notifications."}</p>}
      {(permission === "unsupported" || (ios && !installed)) && <p>{ru ? "Уведомления недоступны в этом режиме браузера." : "Notifications are unavailable in this browser mode."}</p>}
      {(enabled || (permission !== "unsupported" && (!ios || installed))) && <>
        {registration && !registration.pushManager && <p>{ru ? "Браузер не поддерживает уведомления закрытого приложения." : "This browser does not support notifications while the app is closed."}</p>}
        <button type="button" className="outline-button" disabled={showDisable ? controlBusy : busy || !registration?.pushManager || !key || permission === "denied"} onClick={() => { if (showDisable) void disable(); else enable(); }}>{showDisable ? (ru ? "Отключить для этого пространства" : "Disable for this workspace") : (ru ? "Включить уведомления" : "Enable notifications")}</button>
        {permission === "denied" && !view.consentPending && <p>{ios && installed
          ? (ru ? "Проверьте разрешение уведомлений Kaigen в настройках устройства." : "Check Kaigen notification permission in device settings.")
          : (ru ? "Проверьте разрешение уведомлений для сайта в настройках браузера." : "Check this site notification permission in browser settings.")}</p>}
      </>}
      {!showDisable && (enabled || view.optedIn) && <button type="button" className="outline-button" disabled={controlBusy} onClick={disable}>{ru ? "Отключить для этого пространства" : "Disable for this workspace"}</button>}
      {!view.consentPending && view.error && view.retry && <button type="button" className="outline-button" disabled={busy} onClick={() => view.retry?.()}>{ru ? "Повторить подключение" : "Retry connection"}</button>}
      {!view.consentPending && view.error && view.failure?.stage === "worker" && <button type="button" className="outline-button" disabled={busy} onClick={() => location.reload()}>{ru ? "Обновить страницу" : "Reload page"}</button>}
      {view.consentPending && <>
        <p role="status">{ru ? "Настраиваем уведомления. Если браузер или ОС запросят разрешение, подтвердите его. Вы можете отменить включение." : "Setting up notifications. Allow them if your browser or OS asks. You can cancel."}</p>
        <button type="button" className="outline-button" onClick={cancelEnable}>{ru ? "Отменить включение" : "Cancel enabling notifications"}</button>
      </>}
      {busy && !view.consentPending && <p role="status">{ru ? "Настройка уведомлений…" : "Preparing notifications…"}</p>}
      {renderedStatus && <p role="status">{notificationStatusMessages[renderedStatus][language]}</p>}
    </div>;
}
