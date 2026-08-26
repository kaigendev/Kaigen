import { useEffect, useMemo, useRef, useState } from "react";
import RootApp from "../RootApp";
import { webSession } from "./session";
import type { ReceivedArchive } from "./session";
import type { StorageMode, WorkspaceView } from "./contracts";
import "./WebRoot.css";

type Language = "ru" | "en";
type Stage = "loading" | "initializer" | "auth" | "ready" | "occupied" | "error" | "erased";
type ProfileExportKind = "package" | "tox";
type ProfileImportKind = "kai" | "package" | "tox";

const MIN_APP_WIDTH = 860;
const MIN_APP_HEIGHT = 560;
const MIN_VIEWPORT_WIDTH = 900;
const MIN_VIEWPORT_HEIGHT = 660;
const SERVICE_BAR_BOTTOM = 64;

function initialAppPosition() {
  const width = Math.max(MIN_APP_WIDTH, innerWidth * 0.95);
  const availableHeight = Math.max(0, innerHeight - SERVICE_BAR_BOTTOM);
  const height = Math.max(MIN_APP_HEIGHT, availableHeight * 0.95);
  return {
    x: Math.max(0, (innerWidth - width) / 2),
    y: SERVICE_BAR_BOTTOM + Math.max(0, (availableHeight - height) / 2),
  };
}

const copy = {
  ru: {
    unsupported: "Web-версия Kaigen работает только в окне настольного размера.",
    required: `Минимальный размер браузера: ${MIN_VIEWPORT_WIDTH} × ${MIN_VIEWPORT_HEIGHT}.`,
    createTitle: "Новое приватное пространство",
    createNote: "Обычное открытие этой страницы ничего не создаёт. Пространство появится только после подтверждения и локальной проверки защиты от ботов.",
    disk: "На диске",
    diskNote: "Зашифрованные данные переживут перезапуск сервера. После рестарта потребуется пароль.",
    ram: "В оперативной памяти",
    ramNote: "Пространство исчезнет после перезапуска сервера. Риск принимается явно. Идеально для одноразового чата без следов.",
    profileName: "Имя первого Tox-профиля",
    password: "Пароль профиля и пространства",
    confirm: "Повторите пароль",
    weak: "Любой добавленный профиль сможет открыть всё пространство. Самый слабый пароль определяет его стойкость.",
    create: "Создать пространство",
    creating: "Создание и проверка…",
    restore: "Восстановить полный архив",
    restoreTitle: "Восстановить пространство",
    restoreNote: "Архив расшифровывается локальным сервисом Kaigen. Нужны отдельный пароль архива и пароль любого профиля внутри него.",
    restoreFile: "Полный зашифрованный архив .kaigen",
    restoreArchivePassword: "Пароль архива",
    restoreProfilePassword: "Пароль любого профиля пространства",
    restoring: "Проверка и восстановление…",
    backToCreate: "Создать новое пространство",
    loginTitle: "Открыть пространство Kaigen",
    loginNote: "Введите пароль любого сохранённого профиля. Пароль не сохраняется в браузере.",
    login: "Открыть",
    loggingIn: "Проверка…",
    mismatch: "Пароли не совпадают.",
    missingLink: "Ссылка пространства отсутствует или повреждена.",
    occupiedTitle: "Приложение уже открыто в другой вкладке",
    occupiedNote: "Управление останется в активной вкладке. Зависшую вкладку можно будет заменить после истечения server lease.",
    retry: "Проверить снова",
    forever: "Бессрочно",
    remaining: "До удаления",
    renew: "Продлить",
    copyLink: "Копировать ссылку",
    copied: "Ссылка скопирована",
    storage: "Хранилище",
    quotaFull: "Квота заполнена: новая история и кеш не сохраняются",
    maintenance: "Сервер готовится к обслуживанию",
    menu: "Сохранение и закрытие",
    importProfile: "Импорт профиля",
    importProfileTitle: "Добавить Tox-профиль",
    importProfileNote: "Для .tox принимается только уже защищённый паролем профиль; .kai импортируется целиком. Указанный пароль станет ещё одним паролем всего пространства.",
    importPackageNote: "Зашифрованный пакет Kaigen восстановит профиль вместе с его историей и PQ-данными. Пароль пакета станет ещё одним паролем всего пространства.",
    importProfileName: "Имя профиля в Kaigen",
    importProfileFile: "Зашифрованный .tox, контейнер .kai или пакет .kaigen-profile",
    importProfilePassword: "Текущий пароль файла",
    importNow: "Импортировать профиль",
    importing: "Проверка и импорт…",
    exportProfile: "Экспорт профиля Kaigen",
    exportTox: "Экспорт ZIP для qTox",
    exportProfileTitle: "Зашифрованный пакет профиля Kaigen",
    exportToxTitle: "Защищённый профиль в ZIP для qTox",
    profileExportNote: "Экспортирует выбранный профиль и не удаляет его из пространства.",
    profileExportPassword: "Отдельный пароль экспортируемого файла",
    exportNow: "Сохранить профиль",
    exporting: "Шифрование и получение…",
    close: "Закрыть приложение полностью",
    closeTitle: "Закрыть пространство?",
    closeNote: "Активные профили, Tox и Tor будут остановлены. Зашифрованные данные останутся в пространстве; для следующего открытия снова потребуется пароль профиля.",
    closeNow: "Закрыть пространство",
    closing: "Сохранение и закрытие…",
    destroyWorkspace: "Экспортировать и уничтожить пространство",
    destroyTitle: "Экспорт и уничтожение пространства",
    exportPassword: "Отдельный пароль архива",
    prepareArchive: "Сформировать зашифрованный архив",
    preparing: "Получение и проверка архива…",
    archiveReady: "Архив полностью получен и проверен. Убедитесь, что файл сохранён, затем отдельно подтвердите уничтожение.",
    destroy: "Архив получен — уничтожить",
    cancel: "Отмена",
    erased: "Пространство криптографически удалено.",
    fatal: "Не удалось открыть web-приложение.",
  },
  en: {
    unsupported: "Kaigen Web works only in a desktop-sized window.",
    required: `Minimum browser size: ${MIN_VIEWPORT_WIDTH} × ${MIN_VIEWPORT_HEIGHT}.`,
    createTitle: "New private workspace",
    createNote: "Opening this page does not allocate anything. A workspace is created only after explicit confirmation and a local anti-bot proof.",
    disk: "On disk",
    diskNote: "Encrypted data survives a server restart. A password is required after restart.",
    ram: "In memory",
    ramNote: "The workspace disappears when the server restarts. This risk is accepted explicitly. Ideal for a one-time chat that leaves no trace.",
    profileName: "First Tox profile name",
    password: "Profile and workspace password",
    confirm: "Repeat password",
    weak: "Every added profile can unlock the whole workspace. Its weakest password determines the workspace strength.",
    create: "Create workspace",
    creating: "Creating and verifying…",
    restore: "Restore full archive",
    restoreTitle: "Restore workspace",
    restoreNote: "The archive is decrypted by the local Kaigen service. You need its separate archive password and the password of any profile inside it.",
    restoreFile: "Full encrypted .kaigen archive",
    restoreArchivePassword: "Archive password",
    restoreProfilePassword: "Password of any workspace profile",
    restoring: "Verifying and restoring…",
    backToCreate: "Create a new workspace",
    loginTitle: "Open Kaigen workspace",
    loginNote: "Enter the password of any saved profile. The browser does not store the password.",
    login: "Open",
    loggingIn: "Verifying…",
    mismatch: "Passwords do not match.",
    missingLink: "The workspace link is missing or invalid.",
    occupiedTitle: "The app is already open in another tab",
    occupiedNote: "Control stays in the active tab. A stale tab can be replaced after its server lease expires.",
    retry: "Check again",
    forever: "No expiry",
    remaining: "Until deletion",
    renew: "Renew",
    copyLink: "Copy link",
    copied: "Link copied",
    storage: "Storage",
    quotaFull: "Quota full: new history and cache are not being saved",
    maintenance: "Server maintenance is being prepared",
    menu: "Save and close",
    importProfile: "Import profile",
    importProfileTitle: "Add a Tox profile",
    importProfileNote: "A .tox file must already be password-protected; a .kai container is imported in full. The supplied password becomes another password for the workspace.",
    importPackageNote: "An encrypted Kaigen package restores the profile with its history and PQ data. The package password becomes another password for the whole workspace.",
    importProfileName: "Profile name in Kaigen",
    importProfileFile: "Encrypted .tox, .kai container, or .kaigen-profile package",
    importProfilePassword: "Current file password",
    importNow: "Import profile",
    importing: "Verifying and importing…",
    exportProfile: "Export Kaigen profile",
    exportTox: "Export qTox ZIP",
    exportProfileTitle: "Encrypted Kaigen profile package",
    exportToxTitle: "Protected profile in a qTox ZIP",
    profileExportNote: "Exports the selected profile without removing it from the workspace.",
    profileExportPassword: "Separate password for the exported file",
    exportNow: "Save profile",
    exporting: "Encrypting and receiving…",
    close: "Close the app completely",
    closeTitle: "Close this workspace?",
    closeNote: "Active profiles, Tox, and Tor will stop. Encrypted workspace data will remain; a profile password will be required to open it again.",
    closeNow: "Close workspace",
    closing: "Saving and closing…",
    destroyWorkspace: "Export and destroy workspace",
    destroyTitle: "Export and destroy workspace",
    exportPassword: "Separate archive password",
    prepareArchive: "Create encrypted archive",
    preparing: "Receiving and verifying archive…",
    archiveReady: "The complete archive was received and verified. Make sure the file is saved, then confirm destruction separately.",
    destroy: "Archive received — destroy",
    cancel: "Cancel",
    erased: "The workspace was cryptographically erased.",
    fatal: "Could not open the web app.",
  },
} as const;

function identifierFromFragment() {
  const fragment = location.hash.slice(1);
  const candidate = new URLSearchParams(fragment).get("k") ?? fragment;
  return /^[A-Za-z0-9_-]{40,80}$/u.test(candidate) ? candidate : "";
}

function formatDuration(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export default function WebRoot() {
  const [language, setLanguage] = useState<Language>(() => navigator.language.toLowerCase().startsWith("ru") ? "ru" : "en");
  const t = copy[language];
  const [stage, setStage] = useState<Stage>("loading");
  const [storageMode, setStorageMode] = useState<StorageMode>("disk");
  const [profileName, setProfileName] = useState("Tox User");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [workspace, setWorkspace] = useState<WorkspaceView | null>(null);
  const [now, setNow] = useState(Date.now());
  const [copied, setCopied] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [profileExportKind, setProfileExportKind] = useState<ProfileExportKind | null>(null);
  const [profileExportPassword, setProfileExportPassword] = useState("");
  const [profileImportOpen, setProfileImportOpen] = useState(false);
  const [profileImportFile, setProfileImportFile] = useState<File | null>(null);
  const [profileImportName, setProfileImportName] = useState("");
  const [profileImportPassword, setProfileImportPassword] = useState("");
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [restoreArchivePassword, setRestoreArchivePassword] = useState("");
  const [restoreProfilePassword, setRestoreProfilePassword] = useState("");
  const [closeOpen, setCloseOpen] = useState(false);
  const [eraseOpen, setEraseOpen] = useState(false);
  const [archivePassword, setArchivePassword] = useState("");
  const [archive, setArchive] = useState<ReceivedArchive | null>(null);
  const [smallViewport, setSmallViewport] = useState(() => innerWidth < MIN_VIEWPORT_WIDTH || innerHeight < MIN_VIEWPORT_HEIGHT);
  const [position, setPosition] = useState(initialAppPosition);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);

  useEffect(() => webSession.onWorkspace(setWorkspace), []);
  useEffect(() => {
    const requestClose = () => {
      setMenuOpen(false);
      setError("");
      setCloseOpen(true);
    };
    window.addEventListener("kaigen:web-close-request", requestClose);
    return () => window.removeEventListener("kaigen:web-close-request", requestClose);
  }, []);
  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    const resize = () => {
      setSmallViewport(innerWidth < MIN_VIEWPORT_WIDTH || innerHeight < MIN_VIEWPORT_HEIGHT);
      setPosition((value) => ({
        x: Math.max(0, Math.min(value.x, innerWidth - MIN_APP_WIDTH)),
        y: Math.max(64, Math.min(value.y, innerHeight - MIN_APP_HEIGHT)),
      }));
    };
    window.addEventListener("resize", resize);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("resize", resize);
    };
  }, []);

  const openWorkspace = async () => {
    const identifier = identifierFromFragment();
    if (!identifier) {
      setStage(location.hash ? "error" : "initializer");
      if (location.hash) setError(t.missingLink);
      return;
    }
    webSession.setIdentifier(identifier);
    try {
      const lookup = await webSession.lookupWorkspace();
      if (!lookup.exists) {
        setError(t.missingLink);
        setStage("error");
        return;
      }
      const restored = await webSession.restoreDeviceSession();
      setStage(restored ? "ready" : "auth");
    } catch (value) {
      const code = String(value);
      if (code.includes("UI_LEASE_OCCUPIED")) setStage("occupied");
      else if (code.includes("DEVICE_") || code.includes("AUTH_")) setStage("auth");
      else {
        setError(code);
        setStage("error");
      }
    }
  };

  useEffect(() => {
    void openWorkspace();
    // The initial fragment is intentionally consumed only once. A different
    // workspace must be opened through normal navigation, not injected state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const createWorkspace = async () => {
    if (!password || password !== confirm) {
      setError(t.mismatch);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const created = await webSession.createWorkspace({ storageMode, profileName: profileName.trim(), password, language });
      history.replaceState(null, "", `${location.pathname}${location.search}#k=${created.identifier}`);
      await webSession.login(password);
      setPassword("");
      setConfirm("");
      setStage("ready");
    } catch (value) {
      setError(String(value));
    } finally {
      setBusy(false);
    }
  };

  const restoreWorkspace = async () => {
    if (!restoreFile || !restoreArchivePassword || !restoreProfilePassword) return;
    setBusy(true);
    setError("");
    const archiveSecret = restoreArchivePassword;
    const profileSecret = restoreProfilePassword;
    setRestoreArchivePassword("");
    setRestoreProfilePassword("");
    try {
      const restored = await webSession.restoreWorkspaceArchive(
        restoreFile,
        storageMode,
        archiveSecret,
        profileSecret,
      );
      history.replaceState(null, "", `${location.pathname}${location.search}#k=${restored.identifier}`);
      await webSession.login(profileSecret);
      setRestoreFile(null);
      setRestoreOpen(false);
      setStage("ready");
    } catch (value) {
      setError(String(value));
    } finally {
      setBusy(false);
    }
  };

  const login = async () => {
    if (!password) return;
    setBusy(true);
    setError("");
    try {
      await webSession.login(password);
      setPassword("");
      setStage("ready");
    } catch (value) {
      const code = String(value);
      if (code.includes("UI_LEASE_OCCUPIED")) setStage("occupied");
      else if (code.includes("WORKSPACE_NOT_FOUND")) {
        setError(t.missingLink);
        setStage("error");
      } else setError(code);
    } finally {
      setBusy(false);
    }
  };

  const copyLink = async () => {
    await navigator.clipboard.writeText(location.href);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  const prepareArchive = async () => {
    if (!archivePassword) return;
    setBusy(true);
    setError("");
    const exportPassword = archivePassword;
    setArchivePassword("");
    try {
      const received = await webSession.requestArchive(exportPassword);
      downloadBlob(received.blob, `kaigen-workspace-${new Date().toISOString().slice(0, 10)}.kaigen`);
      setArchive(received);
    } catch (value) {
      setError(String(value));
    } finally {
      setBusy(false);
    }
  };

  const exportProfile = async () => {
    if (!profileExportKind || !profileExportPassword) return;
    setBusy(true);
    setError("");
    const exportPassword = profileExportPassword;
    setProfileExportPassword("");
    try {
      await webSession.downloadProfileExport(profileExportKind, exportPassword);
      setProfileExportKind(null);
    } catch (value) {
      setError(String(value));
    } finally {
      setBusy(false);
    }
  };

  const importProfile = async () => {
    const kind: ProfileImportKind = profileImportFile?.name.toLowerCase().endsWith(".kaigen-profile")
      ? "package"
      : profileImportFile?.name.toLowerCase().endsWith(".kai")
        ? "kai"
        : "tox";
    if (!profileImportFile || (kind === "tox" && !profileImportName.trim()) || !profileImportPassword) return;
    setBusy(true);
    setError("");
    const importPassword = profileImportPassword;
    setProfileImportPassword("");
    try {
      await webSession.importProfile(profileImportFile, kind, profileImportName.trim(), importPassword);
      setProfileImportFile(null);
      setProfileImportName("");
      setProfileImportOpen(false);
    } catch (value) {
      setError(String(value));
    } finally {
      setBusy(false);
    }
  };

  const erase = async () => {
    if (!archive) return;
    setBusy(true);
    try {
      await webSession.confirmErasure(archive);
      await archive.cleanup();
      history.replaceState(null, "", `${location.pathname}${location.search}`);
      setStage("erased");
      setEraseOpen(false);
    } catch (value) {
      setError(String(value));
    } finally {
      setBusy(false);
    }
  };

  const cancelErase = async () => {
    setBusy(true);
    setError("");
    try {
      if (archive) {
        await webSession.cancelArchive();
        await archive.cleanup();
      }
      setArchive(null);
      setArchivePassword("");
      setEraseOpen(false);
    } catch (value) {
      setError(String(value));
    } finally {
      setBusy(false);
    }
  };

  const closeWorkspace = async () => {
    setBusy(true);
    setError("");
    try {
      await webSession.closeWorkspace();
      setWorkspace(null);
      setCloseOpen(false);
      setStage("auth");
    } catch (value) {
      setError(String(value));
    } finally {
      setBusy(false);
    }
  };

  const remaining = useMemo(() => workspace?.expiresAt == null ? null : workspace.expiresAt - now, [now, workspace?.expiresAt]);
  const profileImportKind: ProfileImportKind = profileImportFile?.name.toLowerCase().endsWith(".kaigen-profile")
    ? "package"
    : profileImportFile?.name.toLowerCase().endsWith(".kai")
      ? "kai"
      : "tox";

  if (smallViewport) {
    return <main className="web-size-blocker"><div className="web-brand"><img src="/kaigen-icon.png" alt="" /><b>KAIGEN</b></div><h1>{t.unsupported}</h1><p>{t.required}</p></main>;
  }

  if (stage !== "ready") {
    return <main className="web-gate">
      <header className="web-gate-top"><div className="web-brand"><img src="/kaigen-icon.png" alt="" /><b>KAIGEN</b><span>WEB</span></div><nav><button className={language === "ru" ? "active" : ""} onClick={() => setLanguage("ru")}>ru</button><button className={language === "en" ? "active" : ""} onClick={() => setLanguage("en")}>en</button></nav></header>
      <section className="web-gate-card">
        {stage === "loading" && <div className="web-loader" aria-label="Loading" />}
        {stage === "initializer" && <form onSubmit={(event) => { event.preventDefault(); void (restoreOpen ? restoreWorkspace() : createWorkspace()); }}>
          <h1>{restoreOpen ? t.restoreTitle : t.createTitle}</h1><p>{restoreOpen ? t.restoreNote : t.createNote}</p>
          <div className="web-storage-choice">
            <button type="button" className={storageMode === "disk" ? "selected" : ""} onClick={() => setStorageMode("disk")}><b>{t.disk}</b><span>{t.diskNote}</span></button>
            <button type="button" className={storageMode === "ram" ? "selected" : ""} onClick={() => setStorageMode("ram")}><b>{t.ram}</b><span>{t.ramNote}</span></button>
          </div>
          {restoreOpen ? <>
            <label>{t.restoreFile}<input type="file" accept=".kaigen,application/vnd.kaigen.workspace+encrypted,application/octet-stream" onChange={(event) => setRestoreFile(event.target.files?.[0] ?? null)} /></label>
            <label>{t.restoreArchivePassword}<input type="password" autoComplete="current-password" value={restoreArchivePassword} onChange={(event) => setRestoreArchivePassword(event.target.value)} /></label>
            <label>{t.restoreProfilePassword}<input type="password" autoComplete="current-password" value={restoreProfilePassword} onChange={(event) => setRestoreProfilePassword(event.target.value)} /></label>
          </> : <>
            <label>{t.profileName}<input value={profileName} maxLength={64} onChange={(event) => setProfileName(event.target.value)} /></label>
            <label>{t.password}<input type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
            <label>{t.confirm}<input type="password" autoComplete="new-password" value={confirm} onChange={(event) => setConfirm(event.target.value)} /></label>
            <small>{t.weak}</small>
          </>}
          {error && <p className="web-error">{error}</p>}
          <button className="web-primary" disabled={busy || (restoreOpen ? !restoreFile || !restoreArchivePassword || !restoreProfilePassword : !profileName.trim() || !password)}>{busy ? (restoreOpen ? t.restoring : t.creating) : (restoreOpen ? t.restore : t.create)}</button>
          <button type="button" disabled={busy} onClick={() => { setError(""); setRestoreOpen((value) => !value); }}>{restoreOpen ? t.backToCreate : t.restore}</button>
        </form>}
        {stage === "auth" && <form onSubmit={(event) => { event.preventDefault(); void login(); }}><h1>{t.loginTitle}</h1><p>{t.loginNote}</p><label>{t.password}<input autoFocus type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>{error && <p className="web-error">{error}</p>}<button className="web-primary" disabled={busy || !password}>{busy ? t.loggingIn : t.login}</button></form>}
        {stage === "occupied" && <div><h1>{t.occupiedTitle}</h1><p>{t.occupiedNote}</p><button className="web-primary" onClick={() => { setStage("loading"); void openWorkspace(); }}>{t.retry}</button></div>}
        {stage === "error" && <div><h1>{t.fatal}</h1><p className="web-error">{error || t.missingLink}</p><button className="web-primary" onClick={() => { setError(""); setStage(location.hash ? "loading" : "initializer"); void openWorkspace(); }}>{t.retry}</button></div>}
        {stage === "erased" && <div><h1>{t.erased}</h1></div>}
      </section>
    </main>;
  }

  return <main className="web-shell">
    <header className="web-service-bar">
      <div className="web-brand"><img src="/kaigen-icon.png" alt="" /><b>KAIGEN</b><span>WEB</span></div>
      <div className="web-lease"><small>{remaining == null ? t.forever : t.remaining}</small><strong>{remaining == null ? "∞" : formatDuration(remaining)}</strong>{remaining != null && <button onClick={() => void webSession.renewLease()}>{t.renew}</button>}</div>
      <div className="web-storage"><small>{t.storage}</small><span>{workspace?.storageMode === "ram" ? t.ram : t.disk} · {Math.ceil((workspace?.usedBytes ?? 0) / 1048576)}/{workspace?.quotaBytes == null ? "∞" : Math.ceil(workspace.quotaBytes / 1048576)} MiB</span></div>
      {workspace?.quotaBytes != null && (workspace.usedBytes ?? 0) >= workspace.quotaBytes && <div className="web-maintenance">{t.quotaFull}</div>}
      {workspace?.maintenance && <div className="web-maintenance">{t.maintenance}</div>}
      <button className="web-copy" onClick={() => void copyLink()}>{copied ? t.copied : t.copyLink}</button>
      <div className="web-menu"><button aria-expanded={menuOpen} onClick={() => setMenuOpen((value) => !value)}>{t.menu} ▾</button>{menuOpen && <nav><button onClick={() => { setMenuOpen(false); setError(""); setProfileImportFile(null); setProfileImportName(""); setProfileImportPassword(""); setProfileImportOpen(true); }}>{t.importProfile}</button><button onClick={() => { setMenuOpen(false); setError(""); setProfileExportPassword(""); setProfileExportKind("package"); }}>{t.exportProfile}</button><button onClick={() => { setMenuOpen(false); setError(""); setProfileExportPassword(""); setProfileExportKind("tox"); }}>{t.exportTox}</button><button onClick={() => { setMenuOpen(false); setError(""); setCloseOpen(true); }}>{t.close}</button><button className="danger" onClick={() => { setMenuOpen(false); setError(""); setArchive(null); setArchivePassword(""); setEraseOpen(true); }}>{t.destroyWorkspace}</button></nav>}</div>
    </header>
    <section className="web-app-window" style={{ left: position.x, top: position.y }}>
      <div className="web-window-handle" onPointerDown={(event) => {
        drag.current = { x: event.clientX, y: event.clientY, left: position.x, top: position.y };
        event.currentTarget.setPointerCapture(event.pointerId);
      }} onPointerMove={(event) => {
        if (!drag.current) return;
        setPosition({
          x: Math.max(0, Math.min(innerWidth - MIN_APP_WIDTH, drag.current.left + event.clientX - drag.current.x)),
          y: Math.max(64, Math.min(innerHeight - MIN_APP_HEIGHT, drag.current.top + event.clientY - drag.current.y)),
        });
      }} onPointerUp={() => { drag.current = null; }}><span /></div>
      <div className="web-app-surface"><RootApp /></div>
    </section>
    {profileImportOpen && <div className="web-modal-backdrop"><form className="web-close-modal" onSubmit={(event) => { event.preventDefault(); void importProfile(); }}><h2>{t.importProfileTitle}</h2><p>{profileImportKind === "package" ? t.importPackageNote : t.importProfileNote}</p><label>{t.importProfileFile}<input autoFocus type="file" accept=".tox,.kai,.kaigen-profile,application/octet-stream,application/vnd.kaigen.profile+encrypted" onChange={(event) => { const file = event.target.files?.[0] ?? null; setProfileImportFile(file); if (file?.name.toLowerCase().endsWith(".kaigen-profile")) setProfileImportName(""); else if (file && !profileImportName) setProfileImportName(file.name.replace(/\.(?:tox|kai)$/iu, "").slice(0, 64)); }} /></label>{profileImportKind !== "package" && <label>{t.importProfileName}<input maxLength={64} value={profileImportName} onChange={(event) => setProfileImportName(event.target.value)} /></label>}<label>{t.importProfilePassword}<input type="password" autoComplete="current-password" value={profileImportPassword} onChange={(event) => setProfileImportPassword(event.target.value)} /></label>{error && <p className="web-error">{error}</p>}<div><button type="button" disabled={busy} onClick={() => { setError(""); setProfileImportFile(null); setProfileImportName(""); setProfileImportPassword(""); setProfileImportOpen(false); }}>{t.cancel}</button><button className="web-primary" disabled={busy || !profileImportFile || (profileImportKind !== "package" && !profileImportName.trim()) || !profileImportPassword}>{busy ? t.importing : t.importNow}</button></div></form></div>}
    {profileExportKind && <div className="web-modal-backdrop"><form className="web-close-modal" onSubmit={(event) => { event.preventDefault(); void exportProfile(); }}><h2>{profileExportKind === "package" ? t.exportProfileTitle : t.exportToxTitle}</h2><p>{t.profileExportNote}</p><label>{t.profileExportPassword}<input autoFocus type="password" autoComplete="new-password" value={profileExportPassword} onChange={(event) => setProfileExportPassword(event.target.value)} /></label>{error && <p className="web-error">{error}</p>}<div><button type="button" disabled={busy} onClick={() => { setError(""); setProfileExportPassword(""); setProfileExportKind(null); }}>{t.cancel}</button><button className="web-primary" disabled={busy || !profileExportPassword}>{busy ? t.exporting : t.exportNow}</button></div></form></div>}
    {closeOpen && <div className="web-modal-backdrop"><form className="web-close-modal" onSubmit={(event) => { event.preventDefault(); void closeWorkspace(); }}><h2>{t.closeTitle}</h2><p>{t.closeNote}</p>{error && <p className="web-error">{error}</p>}<div><button type="button" disabled={busy} onClick={() => { setError(""); setCloseOpen(false); }}>{t.cancel}</button><button className="danger" disabled={busy}>{busy ? t.closing : t.closeNow}</button></div></form></div>}
    {eraseOpen && <div className="web-modal-backdrop"><form className="web-close-modal" onSubmit={(event) => { event.preventDefault(); void (archive ? erase() : prepareArchive()); }}><h2>{t.destroyTitle}</h2>{archive ? <p>{t.archiveReady}</p> : <label>{t.exportPassword}<input autoFocus type="password" autoComplete="new-password" value={archivePassword} onChange={(event) => setArchivePassword(event.target.value)} /></label>}{error && <p className="web-error">{error}</p>}<div><button type="button" disabled={busy} onClick={() => void cancelErase()}>{t.cancel}</button><button className={archive ? "danger" : "web-primary"} disabled={busy || (!archive && !archivePassword)}>{busy ? t.preparing : archive ? t.destroy : t.prepareArchive}</button></div></form></div>}
  </main>;
}
