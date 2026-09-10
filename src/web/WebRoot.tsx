import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import RootApp from "../RootApp";
import { webSession } from "./session";
import type { StorageMode, WorkspaceView } from "./contracts";
import { dismissContextMenus, registerContextMenuDismissal } from "../contextMenuCoordinator";
import "./WebRoot.css";

type Language = "ru" | "en";
type Stage = "loading" | "initializer" | "auth" | "ready" | "occupied" | "upgrade" | "error";

const MIN_VIEWPORT_WIDTH = 900;
const MIN_VIEWPORT_HEIGHT = 660;

const copy = {
  ru: {
    unsupported: "Web-версия Kaigen работает только в окне настольного размера.",
    required: `Минимальный размер браузера: ${MIN_VIEWPORT_WIDTH} × ${MIN_VIEWPORT_HEIGHT}.`,
    createTitle: "Новое приватное пространство",
    createNote: "Обычное открытие этой страницы ничего не создаёт. Пространство появится только после подтверждения и локальной проверки защиты от ботов.",
    disk: "На диске",
    diskNote: "Зашифрованные данные переживут перезапуск сервера. После рестарта потребуется пароль.",
    ram: "Оперативная память",
    ramNote: "Пространство исчезнет после перезапуска сервера. Риск принимается явно. Идеально для одноразового чата без следов.",
    accessPassword: "Пароль доступа к пространству",
    confirmAccessPassword: "Повторите пароль доступа",
    accessPasswordNote: "Это отдельный пароль пространства. Пароли Tox-профилей задаются позже и не заменяют его.",
    create: "Создать пространство",
    creating: "Создание и проверка…",
    loginTitle: "Открыть пространство Kaigen",
    loginNote: "Введите отдельный пароль доступа к пространству. Пароль не сохраняется в браузере.",
    login: "Открыть",
    loggingIn: "Проверка…",
    mismatch: "Пароли не совпадают.",
    missingLink: "Ссылка пространства отсутствует или повреждена.",
    occupiedTitle: "Приложение уже открыто в другой вкладке",
    occupiedNote: "Управление останется в активной вкладке. Зависшую вкладку можно будет заменить после истечения server lease.",
    retry: "Проверить снова",
    forever: "Бессрочно",
    remaining: "До удаления",
    renewLease: "Продлить срок хранения",
    copyLink: "Скопировать ссылку",
    linkCopied: "Ссылка скопирована",
    copyFailed: "Не удалось скопировать ссылку",
    storage: "Тип хранилища:",
    quotaFull: "Квота заполнена: новая история и кеш не сохраняются",
    maintenance: "Сервер готовится к обслуживанию",
    menu: "Управление сеансом",
    lockSession: "Заблокировать сеанс",
    destroyWorkspace: "Уничтожить пространство",
    destroyTitle: "Уничтожить пространство?",
    destroyNote: "Все данные пространства будут безвозвратно удалены. Экспорт данных выполняться не будет.",
    destroying: "Уничтожение…",
    destroy: "Уничтожить пространство",
    cancel: "Отмена",
    destroyed: "Пространство уничтожено.",
    upgradeTitle: "Требуется обновление Kaigen Web",
    upgradeNote: "Версия интерфейса не совпадает с активной версией сервиса. Старый интерфейс отключён до обновления страницы.",
    reload: "Обновить страницу",
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
    accessPassword: "Workspace access password",
    confirmAccessPassword: "Repeat access password",
    accessPasswordNote: "This password belongs to the workspace. Tox profile passwords are configured later and do not replace it.",
    create: "Create workspace",
    creating: "Creating and verifying…",
    loginTitle: "Open Kaigen workspace",
    loginNote: "Enter the separate workspace access password. The browser does not store it.",
    login: "Open",
    loggingIn: "Verifying…",
    mismatch: "Passwords do not match.",
    missingLink: "The workspace link is missing or invalid.",
    occupiedTitle: "The app is already open in another tab",
    occupiedNote: "Control stays in the active tab. A stale tab can be replaced after its server lease expires.",
    retry: "Check again",
    forever: "No expiry",
    remaining: "Until deletion",
    renewLease: "Extend retention",
    copyLink: "Copy link",
    linkCopied: "Link copied",
    copyFailed: "Could not copy link",
    storage: "Storage type:",
    quotaFull: "Quota full: new history and cache are not being saved",
    maintenance: "Server maintenance is being prepared",
    menu: "Session management",
    lockSession: "Lock session",
    destroyWorkspace: "Destroy workspace",
    destroyTitle: "Destroy workspace?",
    destroyNote: "All workspace data will be permanently deleted. No data export will be performed.",
    destroying: "Destroying…",
    destroy: "Destroy workspace",
    cancel: "Cancel",
    destroyed: "Workspace destroyed.",
    upgradeTitle: "Kaigen Web update required",
    upgradeNote: "The interface version does not match the active service. The stale interface is disabled until the page is reloaded.",
    reload: "Reload page",
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

export default function WebRoot() {
  const [language, setLanguage] = useState<Language>(() => navigator.language.toLowerCase().startsWith("ru") ? "ru" : "en");
  const t = copy[language];
  const [stage, setStage] = useState<Stage>("loading");
  const [storageMode, setStorageMode] = useState<StorageMode>("ram");
  const [accessPassword, setAccessPassword] = useState("");
  const [accessPasswordConfirm, setAccessPasswordConfirm] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [workspace, setWorkspace] = useState<WorkspaceView | null>(null);
  const [now, setNow] = useState(Date.now());
  const [workspaceDestroyed, setWorkspaceDestroyed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState<"idle" | "copied" | "failed">("idle");
  const [destroyOpen, setDestroyOpen] = useState(false);
  const [smallViewport, setSmallViewport] = useState(() => innerWidth < MIN_VIEWPORT_WIDTH || innerHeight < MIN_VIEWPORT_HEIGHT);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const copyResetTimer = useRef<number | null>(null);

  useLayoutEffect(() => registerContextMenuDismissal(() => setMenuOpen(false)), []);

  const toggleMenu = () => {
    const next = !menuOpen;
    dismissContextMenus();
    setMenuOpen(next);
  };

  const lockSession = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      await webSession.lockWorkspace();
      flushSync(() => {
        setWorkspace(null);
        setPassword("");
        setStage("auth");
      });
    } catch (value) {
      setError(String(value));
    } finally {
      setBusy(false);
    }
  }, []);

  const closeApplication = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      await webSession.closeWorkspace();
      flushSync(() => {
        setWorkspace(null);
        setPassword("");
        setStage("auth");
      });
    } catch (value) {
      setError(String(value));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => webSession.onWorkspace(setWorkspace), []);
  useEffect(() => webSession.onUpgradeRequired(() => {
    setWorkspace(null);
    setMenuOpen(false);
    setDestroyOpen(false);
    setBusy(false);
    setError("UPGRADE_REQUIRED");
    setStage("upgrade");
  }), []);
  useEffect(() => {
    if (!menuOpen) return;
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)) setMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [menuOpen]);
  useEffect(() => () => {
    if (copyResetTimer.current != null) window.clearTimeout(copyResetTimer.current);
  }, []);
  useEffect(() => {
    const requestClose = () => {
      setMenuOpen(false);
      void closeApplication();
    };
    window.addEventListener("kaigen:web-close-request", requestClose);
    return () => window.removeEventListener("kaigen:web-close-request", requestClose);
  }, [closeApplication]);
  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    const resize = () => {
      setSmallViewport(innerWidth < MIN_VIEWPORT_WIDTH || innerHeight < MIN_VIEWPORT_HEIGHT);
    };
    window.addEventListener("resize", resize);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("resize", resize);
    };
  }, []);

  const openWorkspace = async () => {
    try {
      await webSession.verifyBuildIdentity();
    } catch (value) {
      const code = String(value);
      if (code.includes("UPGRADE_REQUIRED")) setStage("upgrade");
      else {
        setError(code);
        setStage("error");
      }
      return;
    }
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
    if (!accessPassword || accessPassword !== accessPasswordConfirm) {
      setError(t.mismatch);
      return;
    }
    setBusy(true);
    setError("");
    setWorkspaceDestroyed(false);
    try {
      const created = await webSession.createWorkspace({ storageMode, accessPassword, language });
      history.replaceState(null, "", `${location.pathname}${location.search}#k=${created.identifier}`);
      await webSession.login(accessPassword);
      setAccessPassword("");
      setAccessPasswordConfirm("");
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

  const destroyWorkspace = async () => {
    setBusy(true);
    setError("");
    try {
      await webSession.destroyWorkspace();
      history.replaceState(null, "", `${location.pathname}${location.search}`);
      flushSync(() => {
        setWorkspace(null);
        setPassword("");
        setAccessPassword("");
        setAccessPasswordConfirm("");
        setWorkspaceDestroyed(true);
        setDestroyOpen(false);
        setStage("initializer");
      });
    } catch (value) {
      setError(String(value));
    } finally {
      setBusy(false);
    }
  };

  const copyLink = async () => {
    if (copyResetTimer.current != null) window.clearTimeout(copyResetTimer.current);
    try {
      await navigator.clipboard.writeText(location.href);
      setCopyFeedback("copied");
    } catch {
      setCopyFeedback("failed");
    }
    copyResetTimer.current = window.setTimeout(() => {
      setCopyFeedback("idle");
      copyResetTimer.current = null;
    }, 2000);
  };

  const remaining = useMemo(() => workspace?.expiresAt == null ? null : workspace.expiresAt - now, [now, workspace?.expiresAt]);

  if (stage === "upgrade") {
    return <main className="web-gate">
      <header className="web-gate-top"><div className="web-brand"><b>KAIGEN</b><span>WEB</span></div><nav><button className={language === "ru" ? "active" : ""} onClick={() => setLanguage("ru")}>ru</button><button className={language === "en" ? "active" : ""} onClick={() => setLanguage("en")}>en</button></nav></header>
      <section className="web-gate-card"><h1>{t.upgradeTitle}</h1><p>{t.upgradeNote}</p><button className="web-primary" onClick={() => location.reload()}>{t.reload}</button></section>
    </main>;
  }

  if (smallViewport) {
    return <main className="web-size-blocker"><div className="web-brand"><b>KAIGEN</b></div><h1>{t.unsupported}</h1><p>{t.required}</p></main>;
  }

  if (stage !== "ready") {
    return <main className="web-gate">
      <header className="web-gate-top"><div className="web-brand"><b>KAIGEN</b><span>WEB</span></div><nav><button className={language === "ru" ? "active" : ""} onClick={() => setLanguage("ru")}>ru</button><button className={language === "en" ? "active" : ""} onClick={() => setLanguage("en")}>en</button></nav></header>
      <section className="web-gate-card">
        {stage === "loading" && <div className="web-loader" aria-label="Loading" />}
        {stage === "initializer" && <form onSubmit={(event) => { event.preventDefault(); void createWorkspace(); }}>
          <h1>{t.createTitle}</h1><p>{t.createNote}</p>
          {workspaceDestroyed && <p className="web-success" role="status">{t.destroyed}</p>}
          <div className="web-storage-choice">
            <button type="button" className={storageMode === "ram" ? "selected" : ""} onClick={() => setStorageMode("ram")}><b>{t.ram}</b><span>{t.ramNote}</span></button>
            <button type="button" className={storageMode === "disk" ? "selected" : ""} onClick={() => setStorageMode("disk")}><b>{t.disk}</b><span>{t.diskNote}</span></button>
          </div>
          <label>{t.accessPassword}<input type="password" autoComplete="new-password" value={accessPassword} onChange={(event) => setAccessPassword(event.target.value)} /></label>
          <label>{t.confirmAccessPassword}<input type="password" autoComplete="new-password" value={accessPasswordConfirm} onChange={(event) => setAccessPasswordConfirm(event.target.value)} /></label>
          <small>{t.accessPasswordNote}</small>
          {error && <p className="web-error">{error}</p>}
          <button className="web-primary" disabled={busy || !accessPassword || !accessPasswordConfirm}>{busy ? t.creating : t.create}</button>
        </form>}
        {stage === "auth" && <form onSubmit={(event) => { event.preventDefault(); void login(); }}><h1>{t.loginTitle}</h1><p>{t.loginNote}</p><label>{t.accessPassword}<input autoFocus type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>{error && <p className="web-error">{error}</p>}<button className="web-primary" disabled={busy || !password}>{busy ? t.loggingIn : t.login}</button></form>}
        {stage === "occupied" && <div><h1>{t.occupiedTitle}</h1><p>{t.occupiedNote}</p><button className="web-primary" onClick={() => { setStage("loading"); void openWorkspace(); }}>{t.retry}</button></div>}
        {stage === "error" && <div><h1>{t.fatal}</h1><p className="web-error">{error || t.missingLink}</p><button className="web-primary" onClick={() => { setError(""); setStage(location.hash ? "loading" : "initializer"); void openWorkspace(); }}>{t.retry}</button></div>}
      </section>
    </main>;
  }

  return <main className={`web-shell${menuOpen ? " web-service-menu-open" : ""}`}>
    <header className="web-service-bar">
      <div className="web-brand"><b>KAIGEN</b><span>WEB</span></div>
      <div className="web-lease">
        <div className="web-lease-time"><small>{remaining == null ? t.forever : t.remaining}</small><strong>{remaining == null ? "∞" : formatDuration(remaining)}</strong></div>
        <div className="web-lease-actions">
          {remaining != null && <button type="button" className="web-lease-icon" disabled={busy} aria-label={t.renewLease} title={t.renewLease} onClick={() => void webSession.renewLease().catch((value) => setError(String(value)))}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.35 5.66" /><path d="M20 4v7h-7" /></svg></button>}
          <button type="button" className="web-lease-icon" aria-label={copyFeedback === "copied" ? t.linkCopied : copyFeedback === "failed" ? t.copyFailed : t.copyLink} title={copyFeedback === "copied" ? t.linkCopied : copyFeedback === "failed" ? t.copyFailed : t.copyLink} onClick={() => void copyLink()}>{copyFeedback === "copied" ? <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6" /></svg> : <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></svg>}</button>
        </div>
        <span className="web-sr-only" role="status" aria-live="polite">{copyFeedback === "copied" ? t.linkCopied : copyFeedback === "failed" ? t.copyFailed : ""}</span>
      </div>
      <div className="web-storage"><small>{t.storage}</small><span>{workspace?.storageMode === "ram" ? t.ram : t.disk} · {Math.ceil((workspace?.usedBytes ?? 0) / 1048576)}/{workspace?.quotaBytes == null ? "∞" : Math.ceil(workspace.quotaBytes / 1048576)} MiB</span></div>
      {workspace?.quotaBytes != null && (workspace.usedBytes ?? 0) >= workspace.quotaBytes && <div className="web-maintenance">{t.quotaFull}</div>}
      {workspace?.maintenance && <div className="web-maintenance">{t.maintenance}</div>}
      <div className="web-menu" ref={menuRef}><button type="button" aria-haspopup="menu" aria-expanded={menuOpen} onClick={toggleMenu}>{t.menu} ▾</button>{menuOpen && <nav role="menu"><button type="button" role="menuitem" disabled={busy} onClick={() => { setMenuOpen(false); void lockSession(); }}>{t.lockSession}</button><button type="button" role="menuitem" className="danger" disabled={busy} onClick={() => { setMenuOpen(false); setError(""); setDestroyOpen(true); }}>{t.destroyWorkspace}</button></nav>}</div>
    </header>
    <section className="web-app-window" inert={busy}>
      <div className="web-app-surface"><RootApp /></div>
    </section>
    {destroyOpen && <div className="web-modal-backdrop"><form className="web-close-modal" onSubmit={(event) => { event.preventDefault(); void destroyWorkspace(); }}><h2>{t.destroyTitle}</h2><p>{t.destroyNote}</p>{error && <p className="web-error">{error}</p>}<div><button type="button" disabled={busy} onClick={() => { setError(""); setDestroyOpen(false); }}>{t.cancel}</button><button className="danger" disabled={busy}>{busy ? t.destroying : t.destroy}</button></div></form></div>}
  </main>;
}
