import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { useCompactLayout } from "../compactLayout";
import RootApp from "../RootApp";
import { webSession } from "./session";
import { canonicalWorkspaceUrl, forgetWorkspaceLaunch, needsWorkspaceManifestReload, rememberWorkspaceLaunch } from "./workspaceLaunch";
import type { WorkspaceCreationProgress } from "./session";
import type { StorageMode, WorkspaceView } from "./contracts";
import { dismissContextMenus, registerContextMenuDismissal } from "../contextMenuCoordinator";
import BrowserFeatures from "./BrowserFeatures";
import "./WebRoot.css";

type Language = "ru" | "en";
type Stage = "loading" | "initializer" | "auth" | "ready" | "occupied" | "upgrade" | "error";
type RetentionChange = { enabled: boolean; expectedRevision: number; identifier: string };

const copy = {
  ru: {
    createTitle: "Новое приватное пространство",
    createNote: "На этой странице создается приватное пространство, в котором будут храниться ваши профили и настройки. Выберите метод хранения данных.",
    disk: "На диске",
    diskNote: "Зашифрованные данные переживут перезапуск сервера. После рестарта потребуется пароль.",
    ram: "Оперативная память",
    ramNote: "Пространство исчезнет после перезапуска сервера. Риск принимается явно. Идеально для одноразового чата без следов.",
    accessPassword: "Пароль доступа к пространству",
    confirmAccessPassword: "Повторите пароль доступа",
    accessPasswordNote: "Это отдельный пароль пространства. Пароли Tox-профилей задаются позже и не заменяют его.",
    create: "Создать пространство",
    creating: "Создание и проверка…",
    creationChallenge: "1 из 4 · Подготовка",
    creationProof: "2 из 4 · Проверка запроса",
    creationServer: "3 из 4 · Создание пространства",
    creationOpening: "4 из 4 · Открытие пространства",
    existingTitle: "Открыть существующее пространство",
    existingNote: "Введите ключ пространства. Также можно вставить полную ссылку. Затем введите пароль доступа.",
    workspaceLink: "Ключ пространства",
    openExisting: "Открыть пространство",
    invalidWorkspaceLink: "Введите действительный ключ пространства или полную ссылку этого приложения.",
    loginTitle: "Открыть пространство Kaigen",
    loginNote: "Введите отдельный пароль доступа к пространству. Пароль не сохраняется в браузере.",
    sessionUnavailable: "Сеанс завершён. Введите пароль пространства снова.",
    login: "Открыть",
    loggingIn: "Проверка…",
    mismatch: "Пароли не совпадают.",
    creationLimit: "Достигнут лимит пространств на сервере. Попробуйте позже, когда освободится место для нового пространства.",
    creationImportLimit: "Достигнут лимит одновременных импортов пространств. Дождитесь завершения импорта и попробуйте снова.",
    creationDiskLimit: "На сервере недостаточно свободного места для нового пространства. Попробуйте позже или обратитесь к администратору сервиса.",
    creationMemoryLimit: "На сервере недостаточно свободной памяти для нового пространства. Попробуйте позже.",
    creationCpuLimit: "Сервер перегружен и временно не создаёт новые пространства. Попробуйте позже.",
    creationRuntimeLimit: "На сервере недостаточно ресурсов для запуска нового пространства. Попробуйте позже.",
    creationRecoveryWait: "Сервер восстанавливает доступность создания пространств. Попробуйте немного позже.",
    creationUnavailable: "Не удалось создать пространство. Попробуйте снова; если ошибка повторяется, обратитесь к администратору сервиса.",
    creationMaintenance: "Сервис временно недоступен из-за обслуживания сервера. Попробуйте позже.",
    missingLink: "Ссылка пространства отсутствует или повреждена.",
    occupiedTitle: "Приложение уже открыто в другой вкладке",
    occupiedNote: "Управление останется в активной вкладке. Зависшую вкладку можно будет заменить после истечения server lease.",
    retry: "Проверить снова",
    forever: "Бессрочно",
    remaining: "До удаления",
    renewLease: "Продлить срок хранения",
    autoRenew: "Продлевать, пока онлайн",
    autoRenewNote: "Каждый heartbeat начинает полный срок хранения заново, пока хотя бы один профиль подключён. После отключения или блокировки таймер продолжает отсчёт.",
    retentionStorageError: "Не удалось сохранить настройку или продлить срок. Попробуйте снова.",
    retentionSaving: "Сохранение…",
    retentionUnconfirmed: "Состояние настройки не подтверждено",
    retentionRetry: "Повторить изменение",
    retentionChanged: "Настройка уже изменилась. Показано актуальное значение.",
    copyLink: "Скопировать ссылку",
    linkCopied: "Ссылка скопирована",
    copyFailed: "Не удалось скопировать ссылку",
    storage: "Тип хранилища:",
    quotaFull: "Квота заполнена: новая история и кеш не сохраняются",
    maintenance: "Сервер готовится к обслуживанию",
    menu: "Управление сеансом",
    servicePanel: "Служебная панель Web",
    closePanel: "Закрыть панель",
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
    createTitle: "New private workspace",
    createNote: "Create a private workspace on this page to store your profiles and settings. Choose how to store your data.",
    disk: "On disk",
    diskNote: "Encrypted data survives a server restart. A password is required after restart.",
    ram: "In memory",
    ramNote: "The workspace disappears when the server restarts. This risk is accepted explicitly. Ideal for a one-time chat that leaves no trace.",
    accessPassword: "Workspace access password",
    confirmAccessPassword: "Repeat access password",
    accessPasswordNote: "This password belongs to the workspace. Tox profile passwords are configured later and do not replace it.",
    create: "Create workspace",
    creating: "Creating and verifying…",
    creationChallenge: "1 of 4 · Preparing",
    creationProof: "2 of 4 · Verifying request",
    creationServer: "3 of 4 · Creating workspace",
    creationOpening: "4 of 4 · Opening workspace",
    existingTitle: "Open an existing workspace",
    existingNote: "Enter your workspace key. You can also paste the full link. Then enter its access password.",
    workspaceLink: "Workspace key",
    openExisting: "Open workspace",
    invalidWorkspaceLink: "Enter a valid workspace key or a full link for this app.",
    loginTitle: "Open Kaigen workspace",
    loginNote: "Enter the separate workspace access password. The browser does not store it.",
    sessionUnavailable: "Your session has ended. Enter the workspace password again.",
    login: "Open",
    loggingIn: "Verifying…",
    mismatch: "Passwords do not match.",
    creationLimit: "The server workspace limit has been reached. Try again later when capacity for a new workspace becomes available.",
    creationImportLimit: "The limit for simultaneous workspace imports has been reached. Wait for an import to finish, then try again.",
    creationDiskLimit: "The server does not have enough free disk space for a new workspace. Try again later or contact the service administrator.",
    creationMemoryLimit: "The server does not have enough free memory for a new workspace. Try again later.",
    creationCpuLimit: "The server is overloaded and cannot create new workspaces right now. Try again later.",
    creationRuntimeLimit: "The server does not have enough resources to start a new workspace. Try again later.",
    creationRecoveryWait: "The server is restoring workspace creation availability. Try again shortly.",
    creationUnavailable: "Could not create the workspace. Try again; if the error persists, contact the service administrator.",
    creationMaintenance: "The service is temporarily unavailable during server maintenance. Try again later.",
    missingLink: "The workspace link is missing or invalid.",
    occupiedTitle: "The app is already open in another tab",
    occupiedNote: "Control stays in the active tab. A stale tab can be replaced after its server lease expires.",
    retry: "Check again",
    forever: "No expiry",
    remaining: "Until deletion",
    renewLease: "Extend retention",
    autoRenew: "Extend while online",
    autoRenewNote: "Each heartbeat restarts the full retention period while at least one profile is connected. The timer keeps counting down after disconnecting or locking.",
    retentionStorageError: "Could not save the setting or extend retention. Try again.",
    retentionSaving: "Saving…",
    retentionUnconfirmed: "Setting not confirmed",
    retentionRetry: "Retry change",
    retentionChanged: "The setting has already changed. Its current value is shown.",
    copyLink: "Copy link",
    linkCopied: "Link copied",
    copyFailed: "Could not copy link",
    storage: "Storage type:",
    quotaFull: "Quota full: new history and cache are not being saved",
    maintenance: "Server maintenance is being prepared",
    menu: "Session management",
    servicePanel: "Web service panel",
    closePanel: "Close panel",
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
  const { compact, availableHeight } = useCompactLayout();
  const [serviceOpen, setServiceOpen] = useState(false);
  const [serviceHeight, setServiceHeight] = useState<number | null>(null);
  const [serviceDragging, setServiceDragging] = useState(false);
  const [stage, setStage] = useState<Stage>(() => location.hash ? "loading" : "initializer");
  const [buildReady, setBuildReady] = useState(false);
  const [storageMode, setStorageMode] = useState<StorageMode>("ram");
  const [accessPassword, setAccessPassword] = useState("");
  const [accessPasswordConfirm, setAccessPasswordConfirm] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [retentionBusy, setRetentionBusy] = useState(false);
  const [pendingRetentionChange, setPendingRetentionChange] = useState<RetentionChange | null>(null);
  const [creationProgress, setCreationProgress] = useState<WorkspaceCreationProgress | { stage: "opening" } | null>(null);
  const [workspaceLink, setWorkspaceLink] = useState("");
  const [workspaceLinkError, setWorkspaceLinkError] = useState(false);
  const [error, setError] = useState("");
  const creationErrorMessages: Record<string, string> = {
    CREATION_LIMIT_REACHED: t.creationLimit,
    CREATION_IMPORT_LIMIT_REACHED: t.creationImportLimit,
    CREATION_DISK_LIMIT: t.creationDiskLimit,
    CREATION_MEMORY_LIMIT: t.creationMemoryLimit,
    CREATION_CPU_LIMIT: t.creationCpuLimit,
    CREATION_RUNTIME_LIMIT: t.creationRuntimeLimit,
    CREATION_RECOVERY_WAIT: t.creationRecoveryWait,
    CREATION_UNAVAILABLE: t.creationUnavailable,
    MAINTENANCE: t.creationMaintenance,
    SESSION_UNAVAILABLE: t.sessionUnavailable,
    SESSION_NOT_ACTIVE: t.sessionUnavailable,
    RETENTION_STORAGE_UNAVAILABLE: t.retentionStorageError,
    RETENTION_SETTINGS_CHANGED: t.retentionChanged,
  };
  const errorCode = error.replace(/^Error:\s*/u, "");
  const displayError = Object.prototype.hasOwnProperty.call(creationErrorMessages, errorCode)
    ? creationErrorMessages[errorCode] : error;
  const [workspace, setWorkspace] = useState<WorkspaceView | null>(null);
  const [now, setNow] = useState(Date.now());
  const [workspaceDestroyed, setWorkspaceDestroyed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState<"idle" | "copied" | "failed">("idle");
  const [destroyOpen, setDestroyOpen] = useState(false);
  const [gateViewport, setGateViewport] = useState<{ height: number; width: number; offsetTop: number; offsetLeft: number } | null>(null);
  const [composerKeyboardTight, setComposerKeyboardTight] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const gateRef = useRef<HTMLElement | null>(null);
  const copyResetTimer = useRef<number | null>(null);
  const serviceRef = useRef<HTMLElement | null>(null);
  const serviceFrameRef = useRef<HTMLDivElement | null>(null);
  const serviceHandleRef = useRef<HTMLButtonElement | null>(null);
  const destroyRef = useRef<HTMLFormElement | null>(null);
  const serviceHistoryToken = useRef<string | null>(null);
  const sessionReloadStarted = useRef(false);
  const serviceDrag = useRef<{ pointerId: number; startY: number; startHeight: number; height: number; wasOpen: boolean; moved: boolean } | null>(null);
  const serviceClickBlockedUntil = useRef(0);

  const closeServicePanel = useCallback(() => {
    const drag = serviceDrag.current;
    serviceDrag.current = null;
    if (drag) {
      serviceClickBlockedUntil.current = Date.now() + 400;
      const handle = serviceHandleRef.current;
      if (handle?.hasPointerCapture(drag.pointerId)) handle.releasePointerCapture(drag.pointerId);
    }
    setServiceOpen(false);
    setServiceHeight(null);
    setServiceDragging(false);
    setMenuOpen(false);
    if (serviceHistoryToken.current && history.state?.kaigenWebServicePanel === serviceHistoryToken.current) {
      history.back();
    }
    serviceHistoryToken.current = null;
  }, []);

  const openServicePanel = (height: number | null = null) => {
    dismissContextMenus();
    if (document.activeElement instanceof HTMLElement && document.activeElement.matches('input, textarea, [contenteditable="true"]')) document.activeElement.blur();
    if (!serviceHistoryToken.current) {
      const token = `web-service-${Date.now()}`;
      serviceHistoryToken.current = token;
      history.pushState({ ...history.state, kaigenWebServicePanel: token }, "", location.href);
    }
    setServiceHeight(height);
    setServiceOpen(true);
  };

  const serviceHeightLimit = () => {
    const maximum = serviceFrameRef.current ? Number.parseFloat(getComputedStyle(serviceFrameRef.current).maxHeight) : NaN;
    return Number.isFinite(maximum) ? maximum : Math.max(44, (gateViewport?.height ?? availableHeight) - 8);
  };

  const startServiceDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!event.isPrimary || event.button !== 0 || busy || (event.pointerType === "mouse" && !(event.buttons & 1))) return;
    event.preventDefault();
    const height = serviceFrameRef.current?.getBoundingClientRect().height ?? 44;
    serviceDrag.current = { pointerId: event.pointerId, startY: event.clientY, startHeight: height, height, wasOpen: serviceOpen, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
    setServiceDragging(true);
  };

  const moveServiceDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = serviceDrag.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (event.pointerType === "mouse" && !(event.buttons & 1)) {
      finishServiceDrag(event);
      return;
    }
    const distance = event.clientY - drag.startY;
    if (distance === 0 && !drag.moved) return;
    drag.moved = true;
    event.preventDefault();
    if (!drag.wasOpen && distance <= 0 && !serviceHistoryToken.current) return;
    const height = Math.max(44, Math.min(serviceHeightLimit(), drag.startHeight + distance));
    drag.height = height;
    if (!serviceHistoryToken.current) openServicePanel(height);
    else setServiceHeight(height);
    setServiceDragging(true);
  };

  const finishServiceDrag = (event: ReactPointerEvent<HTMLButtonElement>, cancelled = false) => {
    const drag = serviceDrag.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    serviceDrag.current = null;
    setServiceDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (!drag.moved) {
      if (cancelled) serviceClickBlockedUntil.current = Date.now() + 400;
      return;
    }
    serviceClickBlockedUntil.current = Date.now() + 400;
    if (cancelled) {
      if (drag.wasOpen) setServiceHeight(drag.startHeight);
      else closeServicePanel();
    } else if (serviceHistoryToken.current && drag.height <= 72) closeServicePanel();
    else event.currentTarget.focus({ preventScroll: true });
  };

  useEffect(() => {
    if (!compact || stage !== "ready") closeServicePanel();
  }, [compact, stage, closeServicePanel]);

  useEffect(() => {
    const cancelDrag = () => {
      const drag = serviceDrag.current;
      if (!drag) return;
      serviceDrag.current = null;
      setServiceDragging(false);
      serviceClickBlockedUntil.current = Date.now() + 400;
      const handle = serviceHandleRef.current;
      if (handle?.hasPointerCapture(drag.pointerId)) handle.releasePointerCapture(drag.pointerId);
      if (drag.wasOpen) setServiceHeight(drag.startHeight);
      else if (drag.moved) closeServicePanel();
    };
    const visibility = () => { if (document.hidden) cancelDrag(); };
    window.addEventListener("blur", cancelDrag);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.removeEventListener("blur", cancelDrag);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [closeServicePanel]);

  useEffect(() => {
    const closeOnBack = () => {
      if (serviceHistoryToken.current && history.state?.kaigenWebServicePanel !== serviceHistoryToken.current) {
        serviceHistoryToken.current = null;
        const drag = serviceDrag.current;
        serviceDrag.current = null;
        if (drag) {
          serviceClickBlockedUntil.current = Date.now() + 400;
          const handle = serviceHandleRef.current;
          if (handle?.hasPointerCapture(drag.pointerId)) handle.releasePointerCapture(drag.pointerId);
        }
        setServiceOpen(false);
        setServiceHeight(null);
        setServiceDragging(false);
        setMenuOpen(false);
      }
    };
    window.addEventListener("popstate", closeOnBack);
    return () => window.removeEventListener("popstate", closeOnBack);
  }, []);

  useLayoutEffect(() => {
    const dialog = destroyOpen ? destroyRef.current : compact && serviceOpen && stage === "ready" ? serviceRef.current : null;
    if (!dialog) return;
    const previousFocus = document.activeElement instanceof HTMLElement && document.activeElement !== document.body
      ? document.activeElement : compact ? serviceHandleRef.current : menuRef.current?.querySelector<HTMLButtonElement>("button") ?? null;
    const contains = (node: Node | null) => dialog.contains(node) || (!destroyOpen && node === serviceHandleRef.current);
    const focusable = () => [...Array.from(dialog.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), a[href], select:not(:disabled), textarea:not(:disabled), [tabindex="0"]',
    )), ...(!destroyOpen && serviceHandleRef.current ? [serviceHandleRef.current] : [])].filter((element) => !element.hidden && element.getClientRects().length > 0);
    if (destroyOpen || !serviceDrag.current?.moved) (focusable()[0] ?? dialog).focus({ preventScroll: true });
    const trapKeys = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (destroyOpen) {
          if (!busy) { setError(""); setDestroyOpen(false); }
        } else closeServicePanel();
      } else if (event.key === "Tab") {
        const items = focusable();
        const first = items[0] ?? dialog;
        const last = items[items.length - 1] ?? dialog;
        if (!items.length || (event.shiftKey && (document.activeElement === first || !contains(document.activeElement)))) {
          event.preventDefault(); last.focus();
        } else if (!event.shiftKey && (document.activeElement === last || !contains(document.activeElement))) {
          event.preventDefault(); first.focus();
        }
      }
    };
    const containFocus = (event: FocusEvent) => {
      if (event.target instanceof Node && !contains(event.target)) (focusable()[0] ?? dialog).focus({ preventScroll: true });
    };
    document.addEventListener("keydown", trapKeys, true);
    document.addEventListener("focusin", containFocus);
    return () => {
      document.removeEventListener("keydown", trapKeys, true);
      document.removeEventListener("focusin", containFocus);
      if (previousFocus?.isConnected && previousFocus.getClientRects().length > 0 && !previousFocus.closest("[inert]")) previousFocus.focus({ preventScroll: true });
      else if (serviceHandleRef.current?.isConnected) serviceHandleRef.current.focus({ preventScroll: true });
      else menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
    };
  }, [compact, serviceOpen, stage, destroyOpen, busy, closeServicePanel]);

  useLayoutEffect(() => registerContextMenuDismissal(() => setMenuOpen(false)), []);

  useLayoutEffect(() => {
    if (typeof window === "undefined" || !window.visualViewport) return;
    const viewport = window.visualViewport;
    let disposed = false;
    let unfocusedHeight = viewport.height;
    let composerFocusHeight: number | null = null;
    const update = () => {
      if (disposed) return;
      // Pinch zoom keeps normal document navigation; only keyboard/panning at
      // normal scale changes the available app and gate surfaces.
      if (Math.abs(viewport.scale - 1) > 0.01 || !Number.isFinite(viewport.height) || viewport.height <= 0
        || !Number.isFinite(viewport.width) || viewport.width <= 0) {
        setGateViewport(null);
        setComposerKeyboardTight(false);
        return;
      }
      // Safari can shrink innerHeight and pan the visual viewport at once.
      // visualViewport.height already excludes the keyboard; subtracting its
      // offset from innerHeight would cut the usable surface a second time.
      const offsetTop = Number.isFinite(viewport.offsetTop) ? Math.max(0, viewport.offsetTop) : 0;
      const offsetLeft = Number.isFinite(viewport.offsetLeft) ? Math.max(0, viewport.offsetLeft) : 0;
      const height = viewport.height;
      const width = viewport.width;
      const composerFocused = document.activeElement instanceof HTMLElement
        && document.activeElement.matches(".rich-composer-editor[contenteditable='true']");
      if (!composerFocused) {
        composerFocusHeight = null;
        unfocusedHeight = height;
      } else if (composerFocusHeight == null) {
        composerFocusHeight = unfocusedHeight;
      }
      // Use the browser viewport, never the app surface altered by this mode.
      setComposerKeyboardTight(navigator.maxTouchPoints > 0 && window.matchMedia("(pointer: coarse)").matches
        && composerFocused && height < 160 && (composerFocusHeight ?? height) - height >= 80);
      setGateViewport((previous) => previous?.height === height && previous.width === width
        && previous.offsetTop === offsetTop && previous.offsetLeft === offsetLeft
        ? previous : { height, width, offsetTop, offsetLeft });
    };
    const focusChanged = () => {
      setComposerKeyboardTight(false);
      queueMicrotask(update);
    };
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    document.addEventListener("focusin", focusChanged);
    document.addEventListener("focusout", focusChanged);
    return () => {
      disposed = true;
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      document.removeEventListener("focusin", focusChanged);
      document.removeEventListener("focusout", focusChanged);
    };
  }, [stage]);

  useLayoutEffect(() => {
    // The compact-layout listener can run before these fixed viewport dimensions
    // reach the App surface. Remeasure the committed geometry, including when
    // the ready surface replaces the initial gate observed at subscription time.
    window.dispatchEvent(new Event("kaigen-compact-layout-change"));
  }, [stage, compact, gateViewport]);

  const revealGateFocus = useCallback(() => {
    const gate = gateRef.current;
    const focused = document.activeElement;
    if (!gate || !(focused instanceof HTMLElement) || !gate.contains(focused)
      || !focused.matches("input, textarea, select, button")) return;
    const surface = gate.getBoundingClientRect();
    const control = focused.getBoundingClientRect();
    if (control.bottom > surface.bottom - 16) gate.scrollTop += control.bottom - surface.bottom + 16;
    else if (control.top < surface.top + 16) gate.scrollTop -= surface.top + 16 - control.top;
  }, []);

  useLayoutEffect(() => {
    if (stage !== "ready") revealGateFocus();
  }, [stage, gateViewport, revealGateFocus]);

  const gateViewportStyle = gateViewport ? {
    height: `${gateViewport.height}px`, width: `${gateViewport.width}px`, position: "fixed" as const,
    top: `${gateViewport.offsetTop}px`, left: `${gateViewport.offsetLeft}px`, right: "auto" as const,
  } : undefined;

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
  useEffect(() => {
    if (stage !== "ready") {
      setPendingRetentionChange(null);
      setRetentionBusy(false);
    }
  }, [stage]);
  useEffect(() => webSession.onSessionUnavailable((reload) => {
    if (sessionReloadStarted.current) return;
    sessionReloadStarted.current = true;
    // A terminal auth transition must reload this page, not navigate history.back().
    serviceHistoryToken.current = null;
    flushSync(() => {
      setWorkspace(null);
      setPassword("");
      setMenuOpen(false);
      closeServicePanel();
      setDestroyOpen(false);
      setBusy(false);
      setError("SESSION_UNAVAILABLE");
      setStage("auth");
    });
    if (reload) window.location.reload();
  }), [closeServicePanel]);
  useEffect(() => webSession.onUpgradeRequired(() => {
    setWorkspace(null);
    setMenuOpen(false);
    closeServicePanel();
    setDestroyOpen(false);
    setBusy(false);
    setError("UPGRADE_REQUIRED");
    setStage("upgrade");
  }), [closeServicePanel]);
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
      closeServicePanel();
      void closeApplication();
    };
    window.addEventListener("kaigen:web-close-request", requestClose);
    return () => window.removeEventListener("kaigen:web-close-request", requestClose);
  }, [closeApplication, closeServicePanel]);
  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      window.clearInterval(interval);
    };
  }, []);

  const openWorkspace = async () => {
    setBuildReady(false);
    try {
      await webSession.verifyBuildIdentity();
      setBuildReady(true);
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
      rememberWorkspaceLaunch(identifier);
      if (await webSession.requiresPassword()) {
        setError("SESSION_UNAVAILABLE");
        setStage("auth");
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
    if (busy || !buildReady) return;
    if (!accessPassword || accessPassword !== accessPasswordConfirm) {
      setError(t.mismatch);
      return;
    }
    setBusy(true);
    setError("");
    setWorkspaceDestroyed(false);
    let workspaceCreated = false;
    try {
      const created = await webSession.createWorkspace({ storageMode, accessPassword, language }, setCreationProgress);
      workspaceCreated = true;
      history.replaceState(history.state, "", `${location.pathname}${location.search}#k=${created.identifier}`);
      rememberWorkspaceLaunch(created.identifier);
      setCreationProgress({ stage: "opening" });
      await webSession.login(accessPassword);
      setAccessPassword("");
      setAccessPasswordConfirm("");
      setStage("ready");
    } catch (value) {
      setError(String(value));
      // A created workspace must remain reachable even if its first login
      // fails. Retrying creation would allocate another workspace.
      if (workspaceCreated) {
        setAccessPassword("");
        setAccessPasswordConfirm("");
        setStage("auth");
      }
    } finally {
      setCreationProgress(null);
      setBusy(false);
      // A fresh WebKit document lets installation read the newly created URL,
      // even when its share sheet had already cached the previous manifest.
      if (workspaceCreated && needsWorkspaceManifestReload()) location.reload();
    }
  };

  const openExistingWorkspace = () => {
    if (busy) return;
    try {
      const value = workspaceLink.trim();
      let identifier = /^[A-Za-z0-9_-]{40,80}$/u.test(value) ? value : "";
      if (!identifier) {
        const target = new URL(value, location.href);
        identifier = /^#(?:k=)?([A-Za-z0-9_-]{40,80})$/u.exec(target.hash)?.[1] ?? "";
        const appPath = location.pathname.replace(/\/+$/u, "") || "/";
        const targetPath = target.pathname.replace(/\/+$/u, "") || "/";
        if (target.origin !== location.origin || targetPath !== appPath
          || target.username || target.password || !identifier) throw new Error("INVALID_WORKSPACE_LINK");
      }
      // An explicit key takes priority over the installed app's launch target.
      // The target is remembered only after the next lookup confirms it exists.
      history.replaceState(history.state, "", canonicalWorkspaceUrl(identifier));
      // The initial fragment is consumed once, so a same-document hash change
      // must reload before the existing session bootstrap can consume it.
      location.reload();
    } catch {
      setWorkspaceLinkError(true);
    }
  };

  const login = async () => {
    if (!password) return;
    setBusy(true);
    setError("");
    try {
      await webSession.login(password);
      sessionReloadStarted.current = false;
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
    const identifier = webSession.getIdentifier();
    try {
      await webSession.destroyWorkspace();
      forgetWorkspaceLaunch(identifier);
      history.replaceState(history.state, "", `${location.pathname}${location.search}`);
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
      await navigator.clipboard.writeText(canonicalWorkspaceUrl(webSession.getIdentifier()));
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

  const changeAutoRenew = async (change: RetentionChange) => {
    if (change.identifier !== webSession.getIdentifier()) return;
    setPendingRetentionChange(change);
    setRetentionBusy(true);
    setError("");
    try {
      await webSession.setAutoRenewOnHeartbeat(change.enabled, change.expectedRevision);
      if (change.identifier === webSession.getIdentifier()) setPendingRetentionChange(null);
    } catch (value) {
      if (change.identifier !== webSession.getIdentifier()) return;
      if (String(value).replace(/^Error:\s*/u, "") === "RETENTION_SETTINGS_CHANGED") {
        try {
          // A newer revision makes the old mutation harmless, including retries.
          await webSession.heartbeat();
          if (change.identifier === webSession.getIdentifier()) setPendingRetentionChange(null);
        } catch { /* Keep the unknown state until an explicit retry succeeds. */ }
      }
      if (change.identifier === webSession.getIdentifier()) setError(String(value));
    } finally {
      if (change.identifier === webSession.getIdentifier()) setRetentionBusy(false);
    }
  };

  if (stage === "upgrade") {
    return <main ref={gateRef} className="web-gate" style={gateViewportStyle} onFocusCapture={() => window.requestAnimationFrame(revealGateFocus)}>
      <header className="web-gate-top"><div className="web-brand"><b>KAIGEN</b><span>WEB</span></div><nav><button className={language === "ru" ? "active" : ""} onClick={() => setLanguage("ru")}>ru</button><button className={language === "en" ? "active" : ""} onClick={() => setLanguage("en")}>en</button></nav></header>
      <section className="web-gate-card"><h1>{t.upgradeTitle}</h1><p>{t.upgradeNote}</p><button className="web-primary" onClick={() => location.reload()}>{t.reload}</button></section>
    </main>;
  }

  if (stage !== "ready") {
    return <main ref={gateRef} className="web-gate" style={gateViewportStyle} onFocusCapture={() => window.requestAnimationFrame(revealGateFocus)}>
      <header className="web-gate-top"><div className="web-brand"><b>KAIGEN</b><span>WEB</span></div><nav><button className={language === "ru" ? "active" : ""} onClick={() => setLanguage("ru")}>ru</button><button className={language === "en" ? "active" : ""} onClick={() => setLanguage("en")}>en</button></nav></header>
      <section className="web-gate-card">
        {stage === "loading" && <div className="web-loader" aria-label="Loading" />}
        {stage === "initializer" && <>
          <form onSubmit={(event) => { event.preventDefault(); void createWorkspace(); }}>
          <h1>{t.createTitle}</h1><p>{t.createNote}</p>
          {workspaceDestroyed && <p className="web-success" role="status">{t.destroyed}</p>}
          <div className="web-storage-choice">
            <button type="button" disabled={busy} className={storageMode === "ram" ? "selected" : ""} onClick={() => setStorageMode("ram")}><b>{t.ram}</b><span>{t.ramNote}</span></button>
            <button type="button" disabled={busy} className={storageMode === "disk" ? "selected" : ""} onClick={() => setStorageMode("disk")}><b>{t.disk}</b><span>{t.diskNote}</span></button>
          </div>
          <label>{t.accessPassword}<input disabled={busy} type="password" autoComplete="new-password" value={accessPassword} onChange={(event) => setAccessPassword(event.target.value)} /></label>
          <label>{t.confirmAccessPassword}<input disabled={busy} type="password" autoComplete="new-password" value={accessPasswordConfirm} onChange={(event) => setAccessPasswordConfirm(event.target.value)} /></label>
          <small>{t.accessPasswordNote}</small>
          {error && <p className="web-error">{displayError}</p>}
          <button className="web-primary" disabled={busy || !buildReady || !accessPassword || !accessPasswordConfirm}>{busy ? <>{t.creating.replace(/…$/u, "")}<span className="web-running-dots" aria-hidden="true"><span>.</span><span>.</span><span>.</span></span></> : t.create}</button>
          {creationProgress && <div className="web-creation-progress" role="status" aria-live="polite" aria-atomic="true"><span>{creationProgress.stage === "challenge" ? t.creationChallenge : creationProgress.stage === "proof" ? t.creationProof : creationProgress.stage === "creating" ? t.creationServer : t.creationOpening}</span><progress aria-label={t.creating} /></div>}
        </form>
        <form className="web-existing-workspace" onSubmit={(event) => { event.preventDefault(); openExistingWorkspace(); }}>
          <h2>{t.existingTitle}</h2><p>{t.existingNote}</p>
          <label>{t.workspaceLink}<input type="text" inputMode="text" autoCapitalize="none" autoComplete="off" spellCheck={false} disabled={busy} value={workspaceLink} onChange={(event) => { setWorkspaceLink(event.target.value); setWorkspaceLinkError(false); }} aria-invalid={workspaceLinkError} aria-describedby={workspaceLinkError ? "web-workspace-link-error" : undefined} /></label>
          {workspaceLinkError && <p id="web-workspace-link-error" className="web-error" role="alert">{t.invalidWorkspaceLink}</p>}
          <button className="web-primary" disabled={busy || !workspaceLink.trim()}>{t.openExisting}</button>
        </form></>}
        {stage === "auth" && <form onSubmit={(event) => { event.preventDefault(); void login(); }}><h1>{t.loginTitle}</h1><p>{t.loginNote}</p><label>{t.accessPassword}<input autoFocus={!compact} type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>{error && <p className="web-error">{displayError}</p>}<button className="web-primary" disabled={busy || !password}>{busy ? t.loggingIn : t.login}</button></form>}
        {stage === "occupied" && <div><h1>{t.occupiedTitle}</h1><p>{t.occupiedNote}</p><button className="web-primary" onClick={() => { setStage("loading"); void openWorkspace(); }}>{t.retry}</button></div>}
        {stage === "error" && <div><h1>{t.fatal}</h1><p className="web-error">{displayError || t.missingLink}</p><button className="web-primary" onClick={() => { setError(""); setStage(location.hash ? "loading" : "initializer"); void openWorkspace(); }}>{t.retry}</button></div>}
      </section>
    </main>;
  }

  const overlayViewportStyle = gateViewport ? {
    top: `${gateViewport.offsetTop}px`, left: `${gateViewport.offsetLeft}px`, right: "auto", bottom: "auto",
    width: `${gateViewport.width}px`, height: `${gateViewport.height}px`,
  } : undefined;
  const shellStyle = {
    ...(compact && gateViewport ? {
      position: "fixed", top: `${gateViewport.offsetTop}px`, left: `${gateViewport.offsetLeft}px`,
      width: `${gateViewport.width}px`, height: `${gateViewport.height}px`,
    } : {}),
    "--web-panel-available-height": `${gateViewport?.height ?? availableHeight}px`,
    // Firefox on Android excludes the system navigation bar from visualViewport
    // but still reports its inset. Reserving it again leaves a gap below the app.
    "--web-safe-area-inset-bottom": compact && gateViewport && window.matchMedia("(display-mode: browser)").matches
      && /Android/iu.test(navigator.userAgent) && /Firefox\//iu.test(navigator.userAgent)
      ? "0px" : "env(safe-area-inset-bottom, 0px)",
    "--web-viewport-offset-top": `${gateViewport?.offsetTop ?? 0}px`,
    "--web-viewport-offset-left": `${gateViewport?.offsetLeft ?? 0}px`,
    "--web-viewport-offset-right": `${gateViewport ? Math.max(0, window.innerWidth - gateViewport.offsetLeft - gateViewport.width) : 0}px`,
    "--web-service-height": serviceHeight == null ? "var(--web-service-max-height)" : `${serviceHeight}px`,
  } as CSSProperties;

  return <main className={`web-shell${compact ? " web-shell-compact" : ""}${compact && composerKeyboardTight ? " web-composer-keyboard-tight" : ""}${menuOpen ? " web-service-menu-open" : ""}${serviceOpen ? " web-service-panel-open" : ""}${serviceDragging ? " web-service-dragging" : ""}`} style={shellStyle}>
    <div className="web-service-region">
      {compact && (serviceOpen || serviceDragging) && <div className="web-service-backdrop" style={overlayViewportStyle} onPointerDown={closeServicePanel} aria-hidden="true" />}
      <div className="web-service-frame" ref={serviceFrameRef}>
      <header id="web-service-panel" ref={serviceRef} className="web-service-bar" hidden={compact && !serviceOpen} inert={destroyOpen} role={compact && serviceOpen ? "dialog" : undefined} aria-modal={compact && serviceOpen ? true : undefined} aria-label={t.servicePanel} tabIndex={compact ? -1 : undefined}>
      <div className="web-service-content">
      <div className="web-brand"><b>KAIGEN</b><span>WEB</span></div>
      {compact && <button type="button" className="web-service-close" aria-label={t.closePanel} onClick={closeServicePanel}>×</button>}
      <div className="web-lease">
        <div className="web-lease-time"><small>{remaining == null ? t.forever : t.remaining}</small><strong>{remaining == null ? "∞" : formatDuration(remaining)}</strong></div>
        <div className="web-lease-actions">
          {remaining != null && <button type="button" className="web-lease-icon" disabled={busy} aria-label={t.renewLease} title={t.renewLease} onClick={() => void webSession.renewLease().catch((value) => setError(String(value)))}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.35 5.66" /><path d="M20 4v7h-7" /></svg></button>}
          <button type="button" className="web-lease-icon" aria-label={copyFeedback === "copied" ? t.linkCopied : copyFeedback === "failed" ? t.copyFailed : t.copyLink} title={copyFeedback === "copied" ? t.linkCopied : copyFeedback === "failed" ? t.copyFailed : t.copyLink} onClick={() => void copyLink()}>{copyFeedback === "copied" ? <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6" /></svg> : <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></svg>}</button>
        </div>
        <span className="web-sr-only" role="status" aria-live="polite">{copyFeedback === "copied" ? t.linkCopied : copyFeedback === "failed" ? t.copyFailed : ""}</span>
        {workspace?.leaseSeconds != null && <label className="web-lease-auto" title={t.autoRenewNote}>
          <input type="checkbox" ref={(element) => { if (element) element.indeterminate = pendingRetentionChange !== null; }} checked={!pendingRetentionChange && (workspace.autoRenewOnHeartbeat ?? false)} disabled={busy || retentionBusy || pendingRetentionChange !== null} aria-describedby="web-auto-renew-note" onChange={(event) => void changeAutoRenew({ enabled: event.target.checked, expectedRevision: workspace.retentionSettingsRevision ?? 0, identifier: webSession.getIdentifier() })} />
          <span>{t.autoRenew}</span><span id="web-auto-renew-note" className="web-sr-only">{t.autoRenewNote}</span>
        </label>}
        {pendingRetentionChange && <div className="web-retention-pending" role="status"><span>{retentionBusy ? t.retentionSaving : t.retentionUnconfirmed}</span>{!retentionBusy && <button type="button" disabled={busy} onClick={() => void changeAutoRenew(pendingRetentionChange)}>{t.retentionRetry}</button>}</div>}
      </div>
      <div className="web-storage"><small>{t.storage}</small><span>{workspace?.storageMode === "ram" ? t.ram : t.disk} · {Math.ceil((workspace?.usedBytes ?? 0) / 1048576)}/{workspace?.quotaBytes == null ? "∞" : Math.ceil(workspace.quotaBytes / 1048576)} MiB</span></div>
      {workspace?.quotaBytes != null && (workspace.usedBytes ?? 0) >= workspace.quotaBytes && <div className="web-maintenance">{t.quotaFull}</div>}
      {workspace?.maintenance && <div className="web-maintenance">{t.maintenance}</div>}
      {error && !destroyOpen && <p className="web-service-error web-error" role="alert">{displayError}</p>}
      <BrowserFeatures language={language} />
      <div className="web-menu" ref={menuRef}>{!compact && <button type="button" aria-haspopup="menu" aria-expanded={menuOpen} onClick={toggleMenu}>{t.menu} ▾</button>}{(compact || menuOpen) && <nav role={compact ? undefined : "menu"} aria-label={t.menu}><button type="button" role={compact ? undefined : "menuitem"} disabled={busy} onClick={() => { setMenuOpen(false); closeServicePanel(); void lockSession(); }}>{t.lockSession}</button><button type="button" role={compact ? undefined : "menuitem"} className="danger" disabled={busy} onClick={() => { setMenuOpen(false); closeServicePanel(); setError(""); setDestroyOpen(true); }}>{t.destroyWorkspace}</button></nav>}</div>
      </div>
      </header>
      {compact && <button type="button" className="web-service-handle" ref={serviceHandleRef} aria-label={t.servicePanel} aria-haspopup="dialog" aria-controls="web-service-panel" aria-expanded={serviceOpen} inert={destroyOpen} disabled={busy} onPointerDown={startServiceDrag} onPointerMove={moveServiceDrag} onPointerUp={(event) => finishServiceDrag(event)} onPointerCancel={(event) => finishServiceDrag(event, true)} onLostPointerCapture={(event) => finishServiceDrag(event, true)} onClick={() => { if (Date.now() >= serviceClickBlockedUntil.current) { if (serviceOpen) closeServicePanel(); else openServicePanel(); } }} onKeyDown={(event) => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const height = Math.max(44, Math.min(serviceHeightLimit(), (serviceOpen ? serviceFrameRef.current?.getBoundingClientRect().height ?? 44 : 44) + (event.key === "ArrowDown" ? 48 : -48)));
          if (height <= 72) closeServicePanel(); else openServicePanel(height);
        } else if (event.key === "Home") { event.preventDefault(); closeServicePanel(); }
        else if (event.key === "End") { event.preventDefault(); openServicePanel(); }
      }}><span aria-hidden="true" /><span className="web-sr-only">{t.servicePanel}</span></button>}
      </div>
    </div>
    <section className="web-app-window" inert={busy || destroyOpen || (compact && (serviceOpen || serviceDragging))}>
      <div className="web-app-surface"><RootApp onLanguageChange={setLanguage} /></div>
    </section>
    {destroyOpen && <div className="web-modal-backdrop" style={overlayViewportStyle} onPointerDown={(event) => { if (event.target === event.currentTarget && !busy) { setError(""); setDestroyOpen(false); } }}><form ref={destroyRef} className="web-close-modal" role="dialog" aria-modal="true" aria-labelledby="web-destroy-title" tabIndex={-1} onSubmit={(event) => { event.preventDefault(); void destroyWorkspace(); }}><h2 id="web-destroy-title">{t.destroyTitle}</h2><p>{t.destroyNote}</p>{error && <p className="web-error">{displayError}</p>}<div><button type="button" disabled={busy} onClick={() => { setError(""); setDestroyOpen(false); }}>{t.cancel}</button><button className="danger" disabled={busy}>{busy ? t.destroying : t.destroy}</button></div></form></div>}
  </main>;
}
