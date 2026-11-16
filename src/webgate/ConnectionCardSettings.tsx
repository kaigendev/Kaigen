import { useEffect, useRef, useState } from "react";
import { invoke } from "@kaigen/platform";
import { formatUserFacingError } from "../localization";
import { WebgateConnectionFields } from "./WebgateConnectionFields";
import { emptyWebgateConnection, makeWebgateCard, serializeWebgateCard, type WebgateConnectionCard } from "./connectionCard";
import { isWebgateProfileId } from "./platformRouter";

export function ConnectionCardSettings({ profileId, language }: { profileId: string; language: "ru" | "en" }) {
  const [busy, setBusy] = useState(false);
  const [includePassword, setIncludePassword] = useState(false);
  const [password, setPassword] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);
  const [connection, setConnection] = useState(emptyWebgateConnection);
  const owner = useRef(profileId);
  owner.current = profileId;
  useEffect(() => { owner.current = profileId; return () => { owner.current = ""; }; }, [profileId]);
  const actionPending = useRef(false);
  const ru = language === "ru";
  useEffect(() => { setPassword(""); setIncludePassword(false); setNotice(""); setError(""); setEditing(false); setConnection(emptyWebgateConnection()); }, [profileId]);
  const run = async (action: () => Promise<void>) => {
    if (actionPending.current) return;
    actionPending.current = true; setBusy(true); setNotice(""); setError("");
    const captured = profileId;
    try { await action(); }
    catch (error) { if (owner.current === captured) setError(formatUserFacingError(error, { ru: "Не удалось выполнить действие Webgate. Проверьте параметры подключения.", en: "Could not complete the Webgate action. Check the connection details." }, language)); }
    finally { actionPending.current = false; if (owner.current === captured) { setBusy(false); setPassword(""); } }
  };
  const exportCard = async (save: boolean) => {
    const captured = profileId;
    const card = await invoke<WebgateConnectionCard>("get_webgate_connection_card", { profileId: captured, purpose: "export" });
    if (owner.current !== captured) return;
    const text = serializeWebgateCard(card, includePassword ? password : undefined);
    let saved = "";
    if (save) {
      saved = await invoke<string>("save_webgate_connection_card", { profileId: captured, card: text });
    } else {
      await navigator.clipboard.writeText(text);
    }
    if (owner.current === captured) setNotice(save ? `${ru ? "Карточка сохранена:" : "Connection card saved:"} ${saved}` : (ru ? "Карточка скопирована." : "Connection card copied."));
  };
  const edit = async () => {
    const captured = profileId;
    const card = await invoke<WebgateConnectionCard>("get_webgate_connection_card", { profileId: captured, purpose: "edit" });
    if (owner.current !== captured) return;
    setConnection({ endpoint: card.endpoint, profileName: card.profileName, profileId: card.profileId, password: "", certificateSha256: card.certificateSha256, identity: card.identity });
    setEditing(true);
  };
  const reconnect = async () => {
    const captured = profileId;
    await invoke("update_webgate_profile", { profileId: captured, card: makeWebgateCard(connection), password: connection.password });
    window.dispatchEvent(new Event("profiles-changed"));
    if (owner.current === captured) { setEditing(false); setConnection(emptyWebgateConnection()); setNotice(ru ? "Подключение обновлено." : "Connection updated."); }
  };
  return <section className="settings-section">
    <h2>{ru ? "Карточка подключения Webgate" : "Webgate connection card"}</h2>
    <p className="setting-note">{ru ? "Сохраните карточку для подключения этого аккаунта из другого клиента. По умолчанию пароль в неё не входит." : "Save a card to connect this account from another client. The password is excluded by default."}</p>
    <label className={`setting-switch ${busy ? "disabled" : ""}`}><span><b>{ru ? "Включить пароль доступа" : "Include access password"}</b></span><input type="checkbox" checked={includePassword} disabled={busy} onChange={(event) => { setIncludePassword(event.target.checked); setPassword(""); }} /><i aria-hidden="true" /></label>
    {includePassword && <label className="setting-field"><span>{ru ? "Пароль для карточки" : "Password to include"}</span><input type="password" autoComplete="off" value={password} disabled={busy} onChange={(event) => setPassword(event.target.value)} /></label>}
    <div className="button-row">
      <button type="button" className="outline-button" disabled={busy || includePassword && !password} onClick={() => void run(() => exportCard(false))}>{ru ? "Копировать карточку" : "Copy card"}</button>
      <button type="button" className="outline-button" disabled={busy || includePassword && !password} onClick={() => void run(() => exportCard(true))}>{ru ? "Сохранить карточку" : "Save card"}</button>
      {isWebgateProfileId(profileId) && <button type="button" className="text-button" disabled={busy} onClick={() => void run(edit)}>{ru ? "Изменить подключение" : "Edit connection"}</button>}
    </div>
    {editing && <fieldset className="inline-settings-form" disabled={busy}>
      <WebgateConnectionFields value={connection} onChange={setConnection} language={language} disabled={busy} />
      <div className="button-row"><button type="button" className="text-button" onClick={() => { setEditing(false); setConnection(emptyWebgateConnection()); }}>{ru ? "Отмена" : "Cancel"}</button><button type="button" className="save-button" disabled={!connection.endpoint.trim() || !connection.profileName.trim() || !connection.password || busy} onClick={() => void run(reconnect)}>{busy ? "…" : ru ? "Подключить" : "Connect"}</button></div>
    </fieldset>}
    {notice && <p className="setting-note" role="status">{notice}</p>}
    {error && <p className="setting-error" role="alert">{error}</p>}
  </section>;
}
