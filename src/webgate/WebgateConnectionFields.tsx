import { useEffect, useRef, useState } from "react";
import { invoke } from "@kaigen/platform";
import type { TorSettings } from "../Settings";
import { formatUserFacingError } from "../localization";
import { initialTorStatus, retainTorStatus, type TorStatus } from "../torRuntimeState";
import { isOnionEndpoint, parseWebgateCard, type WebgateConnectionInput } from "./connectionCard";

type Props = {
  value: WebgateConnectionInput;
  onChange: (value: WebgateConnectionInput) => void;
  language: "ru" | "en";
  disabled?: boolean;
};

export function WebgateConnectionFields({ value, onChange, language, disabled = false }: Props) {
  const picker = useRef<HTMLInputElement>(null);
  const [error, setError] = useState("");
  const [torError, setTorError] = useState("");
  const [torBusy, setTorBusy] = useState(false);
  const [torStatus, setTorStatus] = useState(initialTorStatus);
  const alive = useRef(true);
  const torPending = useRef(false);
  const onion = isOnionEndpoint(value.endpoint);
  const ru = language === "ru";
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (!onion) return;
    let current = true;
    let pending = false;
    const refresh = () => {
      if (!current || pending || document.visibilityState !== "visible") return;
      pending = true;
      void invoke<TorStatus>("get_tor_status").then((status) => {
        retainTorStatus(status);
        if (current) setTorStatus(status);
      }).catch(() => {}).finally(() => { pending = false; });
    };
    refresh();
    // Local Tor bootstrap status is liveness; account data uses the push stream.
    const timer = window.setInterval(refresh, 1500);
    document.addEventListener("visibilitychange", refresh);
    return () => { current = false; window.clearInterval(timer); document.removeEventListener("visibilitychange", refresh); };
  }, [onion]);
  const enableTor = async () => {
    if (disabled || torPending.current) return;
    torPending.current = true; setTorBusy(true); setTorError("");
    try {
      const settings = await invoke<TorSettings>("get_tor_settings");
      const status = await invoke<TorStatus>("set_tor_settings", { settings: { ...settings, enabled: true } });
      retainTorStatus(status);
      if (alive.current) setTorStatus(status);
    } catch (error) {
      if (alive.current) setTorError(formatUserFacingError(error, { ru: "Не удалось включить Tor. Проверьте подключение или настройки мостов.", en: "Could not enable Tor. Check your connection or bridge settings." }, language));
    } finally { torPending.current = false; if (alive.current) setTorBusy(false); }
  };
  const update = (field: "endpoint" | "profileName" | "password", text: string) => {
    setError("");
    // A changed destination or account must not silently inherit a card's pin.
    onChange({ ...value, [field]: text, ...(field !== "password" ? { certificateSha256: undefined, identity: undefined, profileId: undefined } : {}) });
  };
  const acceptCard = (text: string) => {
    try { onChange(parseWebgateCard(text)); setError(""); }
    catch { setError(ru ? "Не удалось прочитать карточку Webgate. Проверьте формат файла или буфера." : "Could not read the Webgate card. Check the file or clipboard format."); }
  };
  const paste = async () => {
    try { acceptCard(await navigator.clipboard.readText()); }
    catch { setError(ru ? "Буфер недоступен. Используйте файл карточки или введите параметры вручную." : "Clipboard is unavailable. Import a card file or enter the connection details."); }
  };
  return <div className="webgate-connection-fields">
    <p className="startup-note">{ru
      ? "Webgate подключает существующий аккаунт веб-версии. Аккаунт и доступ сохраняются для следующих запусков; контейнер и Tox работают на сервере. Кеш сообщений и аватаров остаётся временным."
      : "Webgate connects an existing Web account. The account and access are saved for future launches; its container and Tox run on the server. Message and avatar caches remain temporary."}</p>
    <div className="folder-row">
      <button type="button" disabled={disabled} onClick={() => picker.current?.click()}>{ru ? "Импорт карточки" : "Import card"}</button>
      <button type="button" disabled={disabled} onClick={() => void paste()}>{ru ? "Вставить карточку" : "Paste card"}</button>
      <input ref={picker} type="file" accept=".json,.webgate,application/json" hidden disabled={disabled} onChange={(event) => {
        const file = event.target.files?.[0]; event.target.value = "";
        if (!file) return;
        if (file.size > 32768) { setError(ru ? "Карточка Webgate слишком велика." : "The Webgate card is too large."); return; }
        void file.text().then(acceptCard).catch(() => setError(ru ? "Не удалось прочитать файл карточки." : "Could not read the card file."));
      }} />
    </div>
    <label className="setting-field">{ru ? "Ссылка доступа к пространству" : "Workspace access link"}<input type="url" inputMode="url" autoComplete="off" spellCheck={false} value={value.endpoint} disabled={disabled} maxLength={8192} placeholder="https://…/#k=…" onChange={(event) => update("endpoint", event.target.value)} required /></label>
    <label className="setting-field">{ru ? "Имя удалённого аккаунта" : "Remote account name"}<input value={value.profileName} disabled={disabled} autoComplete="off" maxLength={256} onChange={(event) => update("profileName", event.target.value)} required /></label>
    <label className="setting-field">{ru ? "Пароль доступа к пространству" : "Workspace access password"}<input type="password" autoComplete="off" value={value.password} disabled={disabled} maxLength={4096} onChange={(event) => update("password", event.target.value)} required /></label>
    {onion && <><p className="startup-note" role="status">{ru
      ? "Для этого onion-адреса обязателен встроенный Tor. При его отключении аккаунт и синхронизация отключаются."
      : "This onion address requires built-in Tor. Turning Tor off disconnects this account and stops synchronization."}</p>
      {torStatus.state === "connected" ? <p className="startup-note" role="status">{ru ? "Tor подключён." : "Tor is connected."}</p>
        : torStatus.state === "starting" || torStatus.state === "connecting" || torBusy ? <p className="startup-note" role="status">{ru ? "Подключение Tor" : "Connecting Tor"}: {torStatus.progress}%</p>
          : <button type="button" className="outline-button" disabled={disabled || torBusy} onClick={() => void enableTor()}>{ru ? "Включить встроенный Tor" : "Enable built-in Tor"}</button>}
      {torError && <p className="startup-error" role="alert">{torError}</p>}
    </>}
    {value.certificateSha256 && <><p className="startup-note">{ru ? "Карточка закрепляет сертификат выбранного сервера." : "This card pins the selected server's certificate."}</p>
      <button type="button" className="text-button" disabled={disabled} onClick={() => onChange({ ...value, certificateSha256: undefined })}>{ru ? "Принять новый сертификат при подключении" : "Trust the next certificate on connection"}</button></>}
    {error && <p className="startup-error" role="alert">{error}</p>}
  </div>;
}
