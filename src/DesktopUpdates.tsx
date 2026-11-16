import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { invoke, listen, platformCapabilities } from "@kaigen/platform";
import { CompactModal } from "./CompactModal";
import { useI18n } from "./i18n";
import "./DesktopUpdates.css";

type Candidate = { id: string; version: string; releaseName: string; sizeBytes: number };
type UpdateView = {
  enabled: boolean; lastCheckedAt: number | null; candidate: Candidate | null;
  phase: string; jobId: string | null; downloadedBytes: number; downloadTotal: number;
  installCompleted: number; installTotal: number; blocking: boolean; cancellable: boolean;
  errorCode: string | null; retryable: boolean;
};
type UpdateContextValue = {
  view: UpdateView | null; pending: boolean; error: boolean; noUpdates: boolean;
  setEnabled: (enabled: boolean) => Promise<void>; check: () => Promise<void>; open: () => void;
};
const UpdateContext = createContext<UpdateContextValue | null>(null);

export function DesktopUpdateProvider({ children }: { children: ReactNode }) {
  const { language } = useI18n();
  const ru = language === "ru";
  const [view, setView] = useState<UpdateView | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const [noUpdates, setNoUpdates] = useState(false);
  const [open, setOpen] = useState(false);
  const alive = useRef(true);
  const busyRequest = useRef(false);
  const manualCheck = useRef(false);
  useEffect(() => {
    alive.current = true;
    if (!platformCapabilities.nativeFilesystem) return () => { alive.current = false; };
    let disposed = false;
    let unlisten: (() => void) | undefined;
    let revision = 0;
    void (async () => {
      try {
        const stop = await listen<UpdateView>("desktop-update-state", ({ payload }) => {
          if (!disposed) {
            revision += 1; setView(payload); setError(false);
            if (payload.phase === "checking" || payload.candidate || payload.errorCode || payload.phase === "failed") setNoUpdates(false);
            if (manualCheck.current && payload.phase !== "checking") {
              setNoUpdates(payload.phase === "idle" && !payload.candidate && !payload.errorCode);
              manualCheck.current = false;
            }
          }
        });
        if (disposed) { stop(); return; }
        unlisten = stop;
        const requestedAt = revision;
        const current = await invoke<UpdateView>("get_desktop_update_state");
        if (!disposed && requestedAt === revision) setView(current);
        if (!disposed) await invoke("acknowledge_desktop_update_renderer");
      } catch { if (!disposed) setError(true); }
    })();
    return () => { disposed = true; alive.current = false; unlisten?.(); };
  }, []);
  const request = useCallback(async (command: string, args?: Record<string, unknown>) => {
    if (busyRequest.current) return;
    if (command === "check_desktop_update") { manualCheck.current = true; setNoUpdates(false); }
    busyRequest.current = true; setPending(true); setError(false);
    try { await invoke(command, args); }
    catch {
      manualCheck.current = false;
      if (alive.current) { setError(true); setNoUpdates(false); }
    }
    finally { busyRequest.current = false; if (alive.current) setPending(false); }
  }, []);
  const value: UpdateContextValue = {
    view, pending, error, noUpdates,
    setEnabled: (enabled) => request("set_desktop_auto_update", { enabled }),
    check: () => request("check_desktop_update"),
    open: () => { setError(false); setOpen(true); },
  };
  const blocking = view?.blocking === true;
  const downloadDone = view && ["extracting", "closing", "installing", "restarting"].includes(view.phase);
  const label = ru ? "Обновление Kaigen" : "Kaigen update";
  const phase = view?.phase;
  const phaseText = phase === "downloading" ? (ru ? "Загрузка обновления…" : "Downloading update…")
    : phase === "verifying" ? (ru ? "Проверка архива…" : "Checking archive…")
    : phase === "extracting" || phase === "installing" ? (ru ? "Установка обновления…" : "Installing update…")
    : phase === "closing" ? (ru ? "Сохранение данных…" : "Saving your data…")
    : phase === "restarting" ? (ru ? "Перезапуск…" : "Restarting…")
    : phase === "checking" ? (ru ? "Проверка новых версий…" : "Checking for updates…") : label;
  return <UpdateContext.Provider value={value}>
    {children}
    {(blocking || open) && platformCapabilities.nativeFilesystem && <CompactModal className="desktop-update-dialog" label={label}
      historyLayer={false} onClose={() => { if (!blocking && !pending) setOpen(false); }}>
      <div data-i18n-ignore translate="no">
        <h2>{blocking ? phaseText : label}</h2>
        {view?.candidate && <p>{ru ? "Доступна версия" : "Available version"} {view.candidate.version}
          {view.candidate.sizeBytes > 0 && <> · {(view.candidate.sizeBytes / 1048576).toLocaleString(language, { maximumFractionDigits: 1 })} {ru ? "МиБ" : "MiB"}</>}</p>}
        {blocking ? <div className="desktop-update-progress" role="status" aria-live="polite">
          <label>{ru ? "Загрузка" : "Download"}<progress max={Math.max(1, view?.downloadTotal ?? 0)}
            value={downloadDone ? Math.max(1, view?.downloadTotal ?? 0) : view?.downloadTotal ? view.downloadedBytes : undefined} /></label>
          <label>{ru ? "Обновление" : "Installation"}<progress max={Math.max(1, view?.installTotal ?? 0)}
            value={view?.installTotal ? view.installCompleted : phase === "downloading" ? 0 : undefined} /></label>
          <p>{ru ? "После обновления Kaigen перезапустится. Профили и данные сохранятся." : "Kaigen will restart after updating. Your profiles and data will be preserved."}</p>
        </div> : !error && phase !== "failed" && (noUpdates
          ? <p role="status" aria-live="polite">{ru ? "Новых обновлений нет" : "No new updates"}</p>
          : <p>{ru ? "Установить обновление и перезапустить Kaigen? Профили и данные сохранятся." : "Install the update and restart Kaigen? Your profiles and data will be preserved."}</p>)}
        {(error || phase === "failed") && <p role="alert">{ru ? "Не удалось завершить обновление. Можно повторить попытку или продолжить работу." : "The update could not be completed. You can try again or continue using Kaigen."}</p>}
        <div className="button-row">
          {!blocking && <button type="button" className="outline-button" disabled={pending} onClick={() => setOpen(false)}>{ru ? "Позже" : "Later"}</button>}
          {blocking && view?.cancellable && <button type="button" className="outline-button" disabled={pending}
            onClick={() => void request("cancel_desktop_update", { jobId: view.jobId })}>{ru ? "Отмена" : "Cancel"}</button>}
          {!blocking && view?.candidate && <button type="button" className="primary-button" disabled={pending || phase === "checking"}
            onClick={() => void request("install_desktop_update", { candidateId: view.candidate!.id })}>{ru ? "Обновить" : "Update"}</button>}
          {!blocking && !view?.candidate && <button type="button" className="primary-button" disabled={pending}
            onClick={() => void value.check()}>{ru ? "Проверить снова" : "Check again"}</button>}
        </div>
      </div>
    </CompactModal>}
  </UpdateContext.Provider>;
}

export function DesktopUpdateNotice({ children }: { children: ReactNode }) {
  const updates = useContext(UpdateContext);
  const { language } = useI18n();
  if (!updates?.view?.candidate) return <>{children}</>;
  const label = language === "ru" ? "Доступно обновление" : "Update available";
  return <button type="button" className="desktop-update-notice" onClick={updates.open} title={`${label}: ${updates.view.candidate.version}`} aria-label={label}>
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V3m-4 4 4-4 4 4M4 14v6h16v-6" /></svg>
    <span data-i18n-ignore translate="no">{label}</span>
  </button>;
}

export function DesktopUpdateSettings() {
  const updates = useContext(UpdateContext);
  const { language } = useI18n();
  if (!platformCapabilities.nativeFilesystem || !updates) return null;
  const ru = language === "ru";
  const disabled = !updates.view || updates.pending || updates.view.blocking;
  return <div className="desktop-update-settings" data-i18n-ignore translate="no">
    <label className={`setting-switch ${disabled ? "disabled" : ""}`}>
      <span><b>{ru ? "Автоматическое обновление" : "Automatic updates"}</b><small>{ru ? "Проверять стабильные версии раз в сутки. Установка — после подтверждения." : "Check for stable versions once a day. Ask before installing."}</small></span>
      <input type="checkbox" checked={updates.view?.enabled ?? true} disabled={disabled}
        onChange={(event) => void updates.setEnabled(event.target.checked)} /><i aria-hidden="true" />
    </label>
    <button type="button" className="outline-button" disabled={updates.pending || updates.view?.blocking || updates.view?.phase === "checking"}
      onClick={() => void updates.check()}>{updates.view?.phase === "checking" ? (ru ? "Проверка…" : "Checking…") : (ru ? "Проверить обновления" : "Check for updates")}</button>
    {updates.view?.candidate && <button type="button" className="outline-button" onClick={updates.open}>{ru ? "Доступна версия" : "Version available"} {updates.view.candidate.version}</button>}
    {updates.noUpdates && !updates.error && updates.view?.phase === "idle" && !updates.view.candidate &&
      <p role="status" aria-live="polite" style={{ margin: 0 }}>{ru ? "Новых обновлений нет" : "No new updates"}</p>}
    {(updates.error || updates.view?.phase === "failed") && <p role="alert">{ru ? "Проверка не завершилась. Повторите попытку." : "The check did not complete. Please try again."}</p>}
  </div>;
}
