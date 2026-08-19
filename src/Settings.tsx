import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { translateText, useI18n } from "./i18n";
import { COMPONENT_VERSIONS } from "./componentVersions";
import ProfileAvatar, { type ProfileAvatarState } from "./ProfileAvatar";
import { formatProxyTestSuccess, formatTorRuntimeMessage, formatUserFacingError } from "./localization";

type Tab = "profile" | "profiles" | "chat" | "privacy" | "network" | "tor" | "files" | "notifications" | "language" | "advanced" | "about";
export type SettingsOpenRequest = { tab: "profile" | "profiles"; nonce: number };
export type AppearanceSettings = { chatFont: string; chatFontSize: number; interfaceScale: number };
export type TorSettings = { enabled: boolean; transport: "none" | "snowflake" | "obfs4" | "custom"; bridgeLines: string };
export type TorStatus = { state: "disabled" | "starting" | "connecting" | "connected" | "error"; progress: number; message: string | null; socksPort: number | null; controlPort: number | null; transport: string };

const tabs: Array<[Tab, string]> = [
  ["profile", "Профиль"], ["profiles", "Управление профилями"], ["chat", "Чаты"], ["privacy", "Приватность"],
  ["network", "Сеть Tox"], ["tor", "Tor и мосты"], ["files", "Файлы"], ["notifications", "Уведомления"],
  ["language", "Язык"], ["advanced", "Расширенные"], ["about", "О программе"],
];

function SettingsTabIcon({ tab }: { tab: Tab }) {
  const path = tab === "profile" ? <><circle cx="12" cy="8" r="3.3" /><path d="M5.5 20c.6-4.7 2.8-7 6.5-7s5.9 2.3 6.5 7" /></>
    : tab === "profiles" ? <><circle cx="9" cy="8" r="3" /><circle cx="17" cy="10" r="2.4" /><path d="M3.5 20c.5-4.5 2.4-6.8 5.8-6.8 3.3 0 5.2 2.3 5.7 6.8M15 15c3.1-.3 4.9 1.4 5.4 5" /></>
      : tab === "chat" ? <path d="M4 5.5h16v11H10l-5.5 4v-15Z" />
        : tab === "privacy" ? <><path d="M12 3.5 20 6.4v5.7c0 4.7-3.2 8.2-8 10.4-4.8-2.2-8-5.7-8-10.4V6.4Z" /><path d="M9 12.2v-1.4a3 3 0 0 1 6 0v1.4M8.2 12.2h7.6v5.1H8.2Z" /></>
          : tab === "network" ? <><circle cx="5" cy="12" r="2.5" /><circle cx="19" cy="6" r="2.5" /><circle cx="19" cy="18" r="2.5" /><path d="m7.3 10.9 9.3-4M7.3 13.1l9.3 4" /></>
            : tab === "tor" ? <><circle cx="12" cy="12" r="8.5" /><path d="M12 3.5v17M12 7c3 0 5.5 2.2 5.5 5s-2.5 5-5.5 5M12 9.5c1.6 0 3 1.1 3 2.5s-1.4 2.5-3 2.5" /></>
              : tab === "files" ? <><path d="M6 3.5h8l4 4V21H6Z" /><path d="M14 3.5v4h4M9 12h6M9 16h6" /></>
                : tab === "notifications" ? <><path d="M5.5 17h13l-1.7-2.5V10a4.8 4.8 0 0 0-9.6 0v4.5ZM10 20h4" /></>
                  : tab === "language" ? <><circle cx="12" cy="12" r="9" /><path d="M3.5 12h17M12 3c2.4 2.5 3.6 5.5 3.6 9S14.4 18.5 12 21c-2.4-2.5-3.6-5.5-3.6-9S9.6 5.5 12 3Z" /></>
                    : tab === "advanced" ? <><path d="M4 7h16M4 17h16" /><circle cx="9" cy="7" r="2.2" /><circle cx="16" cy="17" r="2.2" /></>
                      : <><circle cx="12" cy="12" r="9" /><path d="M12 10v7M12 7h.01" /></>;
  return <span className="settings-tab-icon"><svg viewBox="0 0 24 24" aria-hidden="true">{path}</svg></span>;
}

type ProfileSummary = { id: string; name: string; fileName: string; encrypted: boolean; loaded: boolean; active: boolean; avatar?: string | null; error?: string | null };
type StartupState = { language: "ru" | "en"; closeToTray: boolean; profiles: ProfileSummary[] };
type FileReceiveSettings = { denyAll: boolean; autoAcceptImages: boolean; showImages: boolean; autoAcceptAny: boolean; maxAutoBytes: number; maxConcurrent: number };
type ProxySettings = { mode: "none" | "socks5" | "http"; host: string; port: number; username: string; password: string };
type NetworkSettings = { udpEnabled: boolean; ipv6Enabled: boolean; localDiscoveryEnabled: boolean };
type QtoxCandidate = { name: string; profilePath: string; historyPath?: string | null; encrypted: boolean };

function Switch({ label, description, initial = false, checked: controlledChecked, onCheckedChange, disabled = false }: { label: string; description?: string; initial?: boolean; checked?: boolean; onCheckedChange?: (checked: boolean) => void; disabled?: boolean }) {
  const [checked, setChecked] = useState(initial);
  const value = controlledChecked ?? checked;
  return <label className={`setting-switch ${disabled ? "disabled" : ""}`}><span><b>{label}</b>{description && <small>{description}</small>}</span><input type="checkbox" checked={value} disabled={disabled} onChange={(e) => { if (controlledChecked === undefined) setChecked(e.target.checked); onCheckedChange?.(e.target.checked); }} /><i aria-hidden="true" /></label>;
}

function Field({ label, value, hint, type = "text", onChange }: { label: string; value?: string; hint?: string; type?: string; onChange?: (value: string) => void }) {
  return <label className="setting-field"><span>{label}</span><input type={type} value={value} onChange={(event) => onChange?.(event.target.value)} readOnly={!onChange} />{hint && <small>{hint}</small>}</label>;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="settings-section"><h2>{title}</h2>{children}</section>;
}

function Settings({ compact, sidebarHeader, avatarState, openRequest, appearance, onAppearanceApply, avatarUrl, onAvatarChange, nickname, onNicknameChange, sendOnEnter, onSendOnEnterChange, historyMessageLimit, onHistoryMessageLimitChange, onAutoDownloadImagesChange, saveChatHistory, onSaveChatHistoryChange, notifyMessages, onNotifyMessagesChange, notifyRequests, onNotifyRequestsChange, spellcheckEnabled, onSpellcheckEnabledChange, spellcheckRussian, onSpellcheckRussianChange, spellcheckEnglish, onSpellcheckEnglishChange, toxId }: { compact: boolean; sidebarHeader: ReactNode; avatarState: ProfileAvatarState; openRequest: SettingsOpenRequest; appearance: AppearanceSettings; onAppearanceApply: (settings: AppearanceSettings) => void; avatarUrl: string | null; onAvatarChange: (avatar: string | null) => void; nickname: string; onNicknameChange: (nickname: string) => void; sendOnEnter: boolean; onSendOnEnterChange: (value: boolean) => void; historyMessageLimit: 20 | 50 | 100 | "all"; onHistoryMessageLimitChange: (value: 20 | 50 | 100 | "all") => void; onAutoDownloadImagesChange: (value: boolean) => void; saveChatHistory: boolean; onSaveChatHistoryChange: (value: boolean) => void; notifyMessages: boolean; onNotifyMessagesChange: (value: boolean) => void; notifyRequests: boolean; onNotifyRequestsChange: (value: boolean) => void; spellcheckEnabled: boolean; onSpellcheckEnabledChange: (value: boolean) => void; spellcheckRussian: boolean; onSpellcheckRussianChange: (value: boolean) => void; spellcheckEnglish: boolean; onSpellcheckEnglishChange: (value: boolean) => void; toxId: string }) {
  const { language, setLanguage, t } = useI18n();
  const qtoxHistoryImportSupported = /Windows/i.test(navigator.userAgent);
  const [tab, setTab] = useState<Tab>(openRequest.tab);
  const [saved, setSaved] = useState(false);
  const [proxySettings, setProxySettingsState] = useState<ProxySettings>({ mode: "none", host: "127.0.0.1", port: 9050, username: "", password: "" });
  const [proxyStatus, setProxyStatus] = useState("");
  const [proxyTesting, setProxyTesting] = useState(false);
  const [networkSettings, setNetworkSettingsState] = useState<NetworkSettings>({ udpEnabled: false, ipv6Enabled: false, localDiscoveryEnabled: false });
  const [networkStatus, setNetworkStatus] = useState("");
  const [networkApplying, setNetworkApplying] = useState(false);
  const [torEnabled, setTorEnabled] = useState(true);
  const [torTransport, setTorTransport] = useState<TorSettings["transport"]>("none");
  const [bridgeLines, setBridgeLines] = useState("");
  const [torStatus, setTorStatus] = useState<TorStatus>({ state: "starting", progress: 0, message: "Запуск встроенного Tor", socksPort: null, controlPort: null, transport: "none" });
  const [torError, setTorError] = useState<string | null>(null);
  const [torApplying, setTorApplying] = useState(false);
  const [scrollActive, setScrollActive] = useState(false);
  const [chatFont, setChatFont] = useState(appearance.chatFont);
  const [chatFontSize, setChatFontSize] = useState(appearance.chatFontSize);
  const [interfaceScale, setInterfaceScale] = useState(appearance.interfaceScale);
  const [profiles, setProfiles] = useState<ProfileSummary[]>([]);
  const [closeToTray, setCloseToTrayState] = useState(true);
  const [passwordAction, setPasswordAction] = useState<"" | "set" | "remove">("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [passwordSuccess, setPasswordSuccess] = useState("");
  const [profileError, setProfileError] = useState("");
  const [confirmDestroy, setConfirmDestroy] = useState(false);
  const [newProfileOpen, setNewProfileOpen] = useState(false);
  const [newProfileName, setNewProfileName] = useState("Tox User");
  const [newProfilePassword, setNewProfilePassword] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [importCandidates, setImportCandidates] = useState<QtoxCandidate[]>([]);
  const [importPasswords, setImportPasswords] = useState<Record<string, string>>({});
  const [importHistory, setImportHistory] = useState<Record<string, string>>({});
  const [importBusy, setImportBusy] = useState(false);
  const [managedProfilePasswords, setManagedProfilePasswords] = useState<Record<string, string>>({});
  const [copiedWallet, setCopiedWallet] = useState<"bitcoin" | "usdt" | null>(null);
  const [managedProfileBusy, setManagedProfileBusy] = useState<Record<string, boolean>>({});
  const [managedProfileErrors, setManagedProfileErrors] = useState<Record<string, string>>({});
  const [confirmClearHistory, setConfirmClearHistory] = useState(false);
  const [fileSettings, setFileSettings] = useState<FileReceiveSettings>({ denyAll: false, autoAcceptImages: true, showImages: true, autoAcceptAny: false, maxAutoBytes: 10 * 1024 * 1024, maxConcurrent: 1 });
  const scrollTimer = useRef<number | undefined>(undefined);
  const passwordNoticeTimer = useRef<number | undefined>(undefined);
  const languageRef = useRef(language);
  languageRef.current = language;
  const currentText = (source: string) => translateText(source, languageRef.current);
  useEffect(() => setTab(openRequest.tab), [openRequest]);
  useEffect(() => {
    setChatFont(appearance.chatFont);
    setChatFontSize(appearance.chatFontSize);
    setInterfaceScale(appearance.interfaceScale);
  }, [appearance.chatFont, appearance.chatFontSize, appearance.interfaceScale]);
  useEffect(() => () => window.clearTimeout(passwordNoticeTimer.current), []);
  useEffect(() => {
    setManagedProfileErrors({});
    setNetworkStatus("");
    setPasswordSuccess("");
    setProfileError("");
    setProxyStatus("");
    setTorError(null);
  }, [language]);
  const refreshProfiles = () => void invoke<StartupState>("get_startup_state").then((value) => { setProfiles(value.profiles); setCloseToTrayState(value.closeToTray); }).catch(() => {});
  useEffect(refreshProfiles, []);
  useEffect(() => { void invoke<FileReceiveSettings>("get_file_receive_settings").then((settings) => { setFileSettings(settings); onAutoDownloadImagesChange(settings.autoAcceptImages); }).catch(() => {}); }, []);
  useEffect(() => { void invoke<ProxySettings>("get_proxy_settings").then(setProxySettingsState).catch(() => {}); }, []);
  useEffect(() => { void invoke<NetworkSettings>("get_network_settings").then(setNetworkSettingsState).catch((error) => setNetworkStatus(formatUserFacingError(error, { ru: "Не удалось получить сетевые настройки", en: "Could not load network settings" }, languageRef.current))); }, []);
  useEffect(() => {
    let mounted = true;
    void invoke<TorSettings>("get_tor_settings").then((settings) => {
      if (!mounted) return;
      setTorEnabled(settings.enabled);
      setTorTransport(settings.transport);
      setBridgeLines(settings.bridgeLines);
    }).catch((error) => { if (mounted) setTorError(formatUserFacingError(error, { ru: "Не удалось получить настройки Tor", en: "Could not load Tor settings" }, languageRef.current)); });
    const refresh = () => void invoke<TorStatus>("get_tor_status").then((status) => { if (mounted) setTorStatus(status); }).catch((error) => { if (mounted) setTorError(formatUserFacingError(error, { ru: "Не удалось получить состояние Tor", en: "Could not load Tor status" }, languageRef.current)); });
    refresh();
    const timer = window.setInterval(refresh, 1000);
    return () => { mounted = false; window.clearInterval(timer); };
  }, []);
  const save = () => { onAppearanceApply({ chatFont, chatFontSize, interfaceScale }); setSaved(true); window.setTimeout(() => setSaved(false), 1500); };
  const updateFileSettings = (patch: Partial<FileReceiveSettings>) => {
    const next = { ...fileSettings, ...patch };
    setFileSettings(next);
    if (patch.autoAcceptImages !== undefined) onAutoDownloadImagesChange(patch.autoAcceptImages);
    void invoke<FileReceiveSettings>("set_file_receive_settings", { settings: next }).then((saved) => {
      setFileSettings(saved);
      window.dispatchEvent(new CustomEvent("file-settings-changed", { detail: saved }));
    }).catch((error) => setProfileError(formatUserFacingError(error, { ru: "Не удалось изменить настройки получения файлов", en: "Could not update file receive settings" }, languageRef.current)));
  };
  const saveProxy = (next: ProxySettings = proxySettings) => {
    setProxyStatus("");
    void invoke<ProxySettings>("set_proxy_settings", { settings: next }).then((saved) => {
      setProxySettingsState(saved); setProxyStatus(currentText(saved.mode === "none" ? "Прокси отключён. Применяются общие параметры прямого подключения Tox." : "Общие настройки прокси применены ко всем профилям. Прямой fallback запрещён."));
      window.dispatchEvent(new CustomEvent("proxy-settings-changed", { detail: saved }));
    }).catch((error) => {
      setProxyStatus(formatUserFacingError(error, { ru: "Не удалось применить настройки прокси", en: "Could not apply proxy settings" }, languageRef.current));
      void invoke<ProxySettings>("get_proxy_settings").then(setProxySettingsState).catch(() => {});
    });
  };
  const updateNetworkSettings = (patch: Partial<NetworkSettings>) => {
    const next = { ...networkSettings, ...patch };
    if (patch.localDiscoveryEnabled === true) next.udpEnabled = true;
    if (patch.udpEnabled === false) next.localDiscoveryEnabled = false;
    setNetworkSettingsState(next);
    setNetworkStatus(currentText("Применение сетевых параметров ко всем профилям…"));
    setNetworkApplying(true);
    void invoke<NetworkSettings>("set_network_settings", { settings: next }).then((saved) => {
      setNetworkSettingsState(saved);
      setNetworkStatus(currentText("Сетевые параметры применены ко всем профилям."));
    }).catch((error) => {
      setNetworkStatus(formatUserFacingError(error, { ru: "Не удалось применить сетевые настройки", en: "Could not apply network settings" }, languageRef.current));
      void invoke<NetworkSettings>("get_network_settings").then(setNetworkSettingsState).catch(() => {});
    }).finally(() => setNetworkApplying(false));
  };
  const testProxy = () => {
    setProxyTesting(true); setProxyStatus(currentText("Проверка подключения…"));
    void invoke<string>("test_proxy_connection", { settings: proxySettings })
      .then((message) => setProxyStatus(formatProxyTestSuccess(message, languageRef.current)))
      .catch((error) => setProxyStatus(formatUserFacingError(error, { ru: "Не удалось подключиться через прокси", en: "Could not connect through the proxy" }, languageRef.current)))
      .finally(() => setProxyTesting(false));
  };
  const loadAvatar = (file: File | undefined) => {
    if (!file) return;
    const reader = new FileReader();
    reader.addEventListener("load", () => onAvatarChange(typeof reader.result === "string" ? reader.result : null));
    reader.readAsDataURL(file);
  };
  const applyTorSettings = (next: Partial<TorSettings> = {}) => {
    const settings: TorSettings = { enabled: torEnabled, transport: torTransport, bridgeLines, ...next };
    setTorError(null);
    setTorApplying(true);
    setTorStatus((current) => ({ ...current, state: settings.enabled ? "starting" : "disabled", progress: 0, message: settings.enabled ? "Перезапуск Tor" : null }));
    void invoke<TorStatus>("set_tor_settings", { settings })
      .then((status) => { setTorEnabled(settings.enabled); setTorTransport(settings.transport); setBridgeLines(settings.bridgeLines); setTorStatus(status); })
      .catch((error) => setTorError(formatUserFacingError(error, { ru: "Не удалось применить настройки Tor", en: "Could not apply Tor settings" }, languageRef.current)))
      .finally(() => setTorApplying(false));
  };
  const restartTor = () => {
    setTorError(null);
    setTorApplying(true);
    setTorStatus((current) => ({ ...current, state: "starting", progress: 0, message: "Перезапуск Tor" }));
    void invoke<TorStatus>("restart_tor").then(setTorStatus).catch((error) => setTorError(formatUserFacingError(error, { ru: "Не удалось перезапустить Tor", en: "Could not restart Tor" }, languageRef.current))).finally(() => setTorApplying(false));
  };
  const showScrollbar = () => {
    setScrollActive(true);
    window.clearTimeout(scrollTimer.current);
    scrollTimer.current = window.setTimeout(() => setScrollActive(false), 900);
  };
  const activeProfile = profiles.find((profile) => profile.active);
  const applyProfilePassword = async () => {
    if (!activeProfile || passwordBusy || !passwordAction) return;
    setProfileError("");
    setPasswordSuccess("");
    if (passwordAction === "set" && !newPassword) { setProfileError(t("Введите новый пароль")); return; }
    if (passwordAction === "set" && newPassword !== confirmPassword) { setProfileError(t("Пароли не совпадают")); return; }
    const completedAction = passwordAction;
    setPasswordBusy(true);
    try {
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      const next = await invoke<ProfileSummary[]>("change_profile_password", { currentPassword: currentPassword || null, newPassword: passwordAction === "set" ? newPassword : null });
      setProfiles(next); setPasswordAction(""); setCurrentPassword(""); setNewPassword(""); setConfirmPassword("");
      setPasswordSuccess(currentText(completedAction === "set" ? "Пароль успешно установлен." : "Пароль успешно снят."));
      window.clearTimeout(passwordNoticeTimer.current);
      passwordNoticeTimer.current = window.setTimeout(() => setPasswordSuccess(""), 4500);
      window.dispatchEvent(new Event("profiles-changed"));
    } catch (error) { setProfileError(formatUserFacingError(error, { ru: "Не удалось изменить пароль профиля", en: "Could not change the profile password" }, languageRef.current)); }
    finally { setPasswordBusy(false); }
  };
  const destroyProfile = async () => {
    try {
      setProfiles(await invoke<ProfileSummary[]>("destroy_active_profile"));
      window.dispatchEvent(new Event("active-profile-changed"));
    } catch (error) { setProfileError(formatUserFacingError(error, { ru: "Не удалось уничтожить профиль", en: "Could not permanently delete the profile" }, languageRef.current)); }
  };
  const createAdditionalProfile = async () => {
    try {
      setProfiles(await invoke<ProfileSummary[]>("create_profile", { name: newProfileName, password: newProfilePassword || null }));
      window.dispatchEvent(new Event("active-profile-changed"));
    } catch (error) { setProfileError(formatUserFacingError(error, { ru: "Не удалось создать профиль", en: "Could not create the profile" }, languageRef.current)); }
  };
  const discoverAdditionalProfiles = async () => {
    setProfileError("");
    try {
      const folder = await openDialog({ directory: true, multiple: false, title: t("Выберите папку qTox или portable qTox") });
      if (typeof folder !== "string") return;
      setImportCandidates(await invoke<QtoxCandidate[]>("discover_qtox_profiles", { location: folder }));
      setImportOpen(true);
    } catch (error) { setProfileError(formatUserFacingError(error, { ru: "Не удалось найти профили qTox", en: "Could not find qTox profiles" }, languageRef.current)); }
  };
  const importAdditionalProfile = async (candidate: QtoxCandidate) => {
    setImportBusy(true); setProfileError("");
    try {
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      setProfiles(await invoke<ProfileSummary[]>("import_qtox_profile", {
        profilePath: candidate.profilePath,
        historyPath: qtoxHistoryImportSupported ? importHistory[candidate.profilePath]?.trim() || candidate.historyPath || null : null,
        password: candidate.encrypted ? importPasswords[candidate.profilePath] ?? "" : null,
      }));
      setImportCandidates((current) => current.filter((item) => item.profilePath !== candidate.profilePath));
      window.dispatchEvent(new Event("active-profile-changed"));
    } catch (error) { setProfileError(formatUserFacingError(error, { ru: "Не удалось импортировать профиль qTox", en: "Could not import the qTox profile" }, languageRef.current)); }
    finally { setImportBusy(false); }
  };
  const unlockManagedProfile = async (profile: ProfileSummary) => {
    const password = managedProfilePasswords[profile.id] ?? "";
    if (profile.loaded || managedProfileBusy[profile.id] || (profile.encrypted && !password)) return;
    setManagedProfileBusy((current) => ({ ...current, [profile.id]: true }));
    setManagedProfileErrors((current) => ({ ...current, [profile.id]: "" }));
    try {
      const next = await invoke<ProfileSummary[]>("unlock_profile", { profileId: profile.id, password });
      setProfiles(next);
      setManagedProfilePasswords((current) => {
        const updated = { ...current };
        delete updated[profile.id];
        return updated;
      });
      window.dispatchEvent(new Event("profiles-changed"));
    } catch (error) {
      setManagedProfileErrors((current) => ({ ...current, [profile.id]: formatUserFacingError(error, { ru: "Не удалось разблокировать профиль", en: "Could not unlock the profile" }, languageRef.current) }));
    } finally {
      setManagedProfileBusy((current) => ({ ...current, [profile.id]: false }));
    }
  };
  const disableManagedProfile = async (profile: ProfileSummary) => {
    if (managedProfileBusy[profile.id]) return;
    setManagedProfileBusy((current) => ({ ...current, [profile.id]: true }));
    setManagedProfileErrors((current) => ({ ...current, [profile.id]: "" }));
    try {
      const next = await invoke<ProfileSummary[]>("disable_profile", { profileId: profile.id });
      setProfiles(next);
      setManagedProfilePasswords((current) => {
        const updated = { ...current };
        delete updated[profile.id];
        return updated;
      });
      window.dispatchEvent(new Event(profile.active ? "active-profile-changed" : "profiles-changed"));
    } catch (error) {
      setManagedProfileErrors((current) => ({ ...current, [profile.id]: formatUserFacingError(error, { ru: "Не удалось отключить профиль", en: "Could not disable the profile" }, languageRef.current) }));
    } finally {
      setManagedProfileBusy((current) => ({ ...current, [profile.id]: false }));
    }
  };
  const clearAllHistory = async () => {
    try { await invoke("clear_tox_history", { friendNumber: null }); setConfirmClearHistory(false); }
    catch (error) { setProfileError(formatUserFacingError(error, { ru: "Не удалось очистить историю", en: "Could not clear history" }, languageRef.current)); }
  };
  const copyWallet = (kind: "bitcoin" | "usdt", value: string) => {
    void navigator.clipboard.writeText(value).then(() => {
      setCopiedWallet(kind);
      window.setTimeout(() => setCopiedWallet((current) => current === kind ? null : current), 1800);
    }).catch(() => {});
  };

  return <section className={`settings-view ${compact ? "compact" : ""}`}>
    <aside className="settings-nav">
      {sidebarHeader}
      <div className="settings-nav-heading"><h1>Настройки</h1><p>Локальный профиль и клиент</p></div>
      <nav className="settings-tabs" aria-label={t("Разделы настроек")}>{tabs.map(([id, label]) => <button key={id} className={tab === id ? "selected" : ""} title={t(label)} aria-label={t(label)} aria-current={tab === id ? "page" : undefined} onClick={() => setTab(id)}><SettingsTabIcon tab={id} /><span className="settings-tab-label">{t(label)}</span></button>)}</nav>
    </aside>
    <main className="settings-content">
      <div className={`settings-scroll ${scrollActive ? "scroll-active" : ""}`} onScroll={showScrollbar}>
      {tab === "profile" && <>
        <header><h1>Профиль</h1><p>Эти данные передаются только выбранным контактам через сеть Tox.</p></header>
        <Section title="Ваша личность"><div className="profile-row"><ProfileAvatar src={avatarUrl} initial={nickname.trim().charAt(0).toLocaleUpperCase() || "T"} state={avatarState} connecting={avatarState === "connecting"} className="settings-avatar" alt="Ваш аватар" /><label className="outline-button avatar-upload">Загрузить аватар<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(event) => loadAvatar(event.target.files?.[0])} /></label>{avatarUrl && <button className="text-button" onClick={() => onAvatarChange(null)}>Удалить</button>}</div><Field label="Ник" value={nickname} onChange={onNicknameChange} /><Field label="Tox ID" value={toxId || "Загрузка…"} hint="Публичный идентификатор. Его можно безопасно передавать для добавления в контакты." /></Section>
        <Section title="Удаление профиля">{!confirmDestroy ? <button className="danger-button" onClick={() => setConfirmDestroy(true)}>Уничтожить активный профиль</button> : <div className="destroy-confirm"><p>Будут безвозвратно удалены профиль «<span data-i18n-ignore translate="no">{activeProfile?.name}</span>», его контакты, история и индивидуальные настройки. Остальные профили не затрагиваются.</p><div className="button-row"><button className="text-button" onClick={() => setConfirmDestroy(false)}>Отмена</button><button className="danger-button" onClick={() => void destroyProfile()}>Подтвердить уничтожение</button></div></div>}{profileError && <p className="setting-error">{profileError}</p>}</Section>
      </>}
      {tab === "profiles" && <>
        <header><h1>Управление профилями</h1><p>Создание, импорт, подключение и отключение профилей.</p></header>
        <Section title="Активный профиль"><div className="settings-active-profile-line"><span>Активный профиль: <strong data-i18n-ignore translate="no">{activeProfile?.fileName ?? "—"}</strong></span><button className="outline-button settings-compact-action" disabled={!activeProfile || passwordBusy} onClick={() => { setProfileError(""); setPasswordSuccess(""); setPasswordAction(activeProfile?.encrypted ? "remove" : "set"); }}>{activeProfile?.encrypted ? "Снять пароль" : "Установить пароль"}</button></div><div className="settings-profile-actions"><button className="outline-button settings-compact-action" disabled={passwordBusy} onClick={() => setNewProfileOpen((value) => !value)}>Создать профиль</button><button className="outline-button settings-compact-action" disabled={passwordBusy} onClick={() => void discoverAdditionalProfiles()}>Импортировать профиль</button></div><p className="setting-note setting-warning">Один Tox-профиль нельзя одновременно запускать в нескольких экземплярах: копии имеют один Tox ID, поэтому имя и состояние такого контакта будут сменять друг друга.</p>
          {passwordAction && <fieldset className="inline-settings-form settings-password-form" disabled={passwordBusy} aria-busy={passwordBusy}>{passwordAction === "remove" && <Field label="Текущий пароль" type="password" value={currentPassword} onChange={setCurrentPassword} />}{passwordAction === "set" && <><Field label="Новый пароль" type="password" value={newPassword} onChange={setNewPassword} /><Field label="Повторите пароль" type="password" value={confirmPassword} onChange={setConfirmPassword} /></>}{passwordBusy && <div className="import-progress profile-password-progress" role="status" aria-live="polite"><progress /><span>{t(passwordAction === "set" ? "Установка пароля. Пожалуйста, подождите…" : "Снятие пароля. Пожалуйста, подождите…")}</span></div>}<div className="button-row"><button className="text-button settings-compact-action" disabled={passwordBusy} onClick={() => setPasswordAction("")}>Отмена</button><button className="save-button settings-compact-action" disabled={passwordBusy || (passwordAction === "set" ? !newPassword || !confirmPassword : !currentPassword)} onClick={() => void applyProfilePassword()}>{passwordBusy ? "…" : "Применить"}</button></div></fieldset>}
          {passwordSuccess && <p className="settings-password-success" role="status" aria-live="polite"><span aria-hidden="true">✓</span>{passwordSuccess}</p>}
          {newProfileOpen && <div className="inline-settings-form"><Field label="Имя профиля" value={newProfileName} onChange={setNewProfileName} /><Field label="Пароль (необязательно)" type="password" value={newProfilePassword} onChange={setNewProfilePassword} /><div className="button-row"><button className="text-button" onClick={() => setNewProfileOpen(false)}>Отмена</button><button className="save-button" onClick={() => void createAdditionalProfile()}>Создать профиль</button></div></div>}
          {importOpen && <fieldset className="inline-settings-form settings-import-fieldset" disabled={importBusy}><b>Найденные профили qTox</b>{!qtoxHistoryImportSupported && <p className="setting-note">На этой платформе импортируется профиль и список контактов; собственная история Kaigen продолжит храниться в portable-каталоге.</p>}{importBusy && <div className="import-progress" role="status" aria-live="polite"><progress /><span>Импорт профиля и истории. Пожалуйста, подождите…</span></div>}{importCandidates.length === 0 && <p className="setting-note">Подходящие профили не найдены или уже импортированы.</p>}{importCandidates.map((candidate) => <div className="settings-import-candidate" key={candidate.profilePath}><strong data-i18n-ignore translate="no">{candidate.name}</strong><small data-i18n-ignore translate="no">{candidate.profilePath}</small>{candidate.encrypted && <Field label="Пароль профиля" type="password" value={importPasswords[candidate.profilePath] ?? ""} onChange={(value) => setImportPasswords((current) => ({ ...current, [candidate.profilePath]: value }))} />}{qtoxHistoryImportSupported && !candidate.historyPath && <div className="field-with-action"><Field label="Файл истории qTox (необязательно)" value={importHistory[candidate.profilePath] ?? ""} onChange={(value) => setImportHistory((current) => ({ ...current, [candidate.profilePath]: value }))} /><button className="outline-button" onClick={async () => { const selected = await openDialog({ multiple: false, title: t("Выберите базу истории qTox"), filters: [{ name: "qTox history", extensions: ["db"] }] }); if (typeof selected === "string") setImportHistory((current) => ({ ...current, [candidate.profilePath]: selected })); }}>Обзор…</button></div>}<button className="save-button" disabled={importBusy || (candidate.encrypted && !(importPasswords[candidate.profilePath] ?? ""))} onClick={() => void importAdditionalProfile(candidate)}>Импортировать этот профиль{candidate.historyPath ? " вместе с историей" : ""}</button></div>)}<button className="text-button" onClick={() => setImportOpen(false)}>Закрыть</button></fieldset>}
          {profileError && <p className="setting-error">{profileError}</p>}
        </Section>
        <Section title="Доступные профили"><div className="settings-profile-list">{profiles.map((profile) => <article className={`settings-profile-card ${profile.loaded ? "unlocked" : "locked"}`} key={profile.id}>
          <div className="settings-profile-heading">
            <ProfileAvatar src={profile.avatar} initial={profile.name.trim().charAt(0).toLocaleUpperCase() || "T"} className="settings-managed-profile-avatar" alt={profile.name} />
            <span className="settings-profile-copy"><span className="settings-profile-title"><b data-i18n-ignore translate="no">{profile.name}</b>{profile.active && <span className="settings-profile-active">Активный</span>}{profile.loaded && <span className="settings-profile-success" role="status"><i aria-hidden="true">✓</i>разблокировано</span>}</span><small data-i18n-ignore translate="no">{profile.fileName}</small></span>
            <button type="button" className="settings-profile-disable" data-i18n-ignore translate="no" aria-label={`${t("Удалить профиль из списка")}: ${profile.name}`} title={t("Удалить профиль из списка")} disabled={managedProfileBusy[profile.id]} onClick={() => void disableManagedProfile(profile)}><span aria-hidden="true">×</span></button>
          </div>
          {!profile.loaded && <div className="settings-profile-connect">
            {profile.encrypted && <input type="password" data-i18n-ignore translate="no" aria-label={`${t("Пароль профиля")}: ${profile.name}`} placeholder={t("Пароль профиля")} value={managedProfilePasswords[profile.id] ?? ""} onChange={(event) => setManagedProfilePasswords((current) => ({ ...current, [profile.id]: event.target.value }))} onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); void unlockManagedProfile(profile); } }} />}
            <button className="save-button" disabled={managedProfileBusy[profile.id] || (profile.encrypted && !(managedProfilePasswords[profile.id] ?? ""))} onClick={() => void unlockManagedProfile(profile)}>{managedProfileBusy[profile.id] ? "…" : "Подключить"}</button>
          </div>}
          {(managedProfileErrors[profile.id] || profile.error) && <em>{managedProfileErrors[profile.id] || formatUserFacingError(profile.error, { ru: "Не удалось подключить профиль", en: "Could not connect the profile" }, language)}</em>}
        </article>)}</div></Section>
      </>}
      {tab === "chat" && <>
        <header><h1>Чаты</h1><p>Поведение диалогов, групп и оформления сообщений.</p></header>
        <Section title="Сообщения"><Switch label="Отправлять по Enter" description={sendOnEnter ? "Shift + Enter добавляет новую строку." : "Enter добавляет новую строку, Shift + Enter отправляет сообщение."} checked={sendOnEnter} onCheckedChange={onSendOnEnterChange} /><label className="setting-select"><span>Сообщений при открытии чата</span><select value={historyMessageLimit} onChange={(event) => onHistoryMessageLimitChange(event.target.value === "all" ? "all" : Number(event.target.value) as 20 | 50 | 100)}><option value="20">20</option><option value="50">50</option><option value="100">100</option><option value="all">Все сообщения (повышенный расход памяти)</option></select></label>{historyMessageLimit === "all" && <p className="setting-note setting-warning">Полная загрузка длинной переписки может заметно увеличить расход оперативной памяти. Экспорт истории всегда остаётся полным при любом выбранном лимите.</p>}<p className="setting-note">Время сообщений и подтверждения доставки показываются всегда.</p></Section>
        <Section title="Оформление"><label className="setting-select"><span>Шрифт сообщений</span><select value={chatFont} onChange={(event) => setChatFont(event.target.value)}><option value="Inter, Segoe UI, Arial, sans-serif">Inter</option><option value="Arial, sans-serif">Arial</option><option value="Verdana, sans-serif">Verdana</option><option value="Georgia, serif">Georgia</option><option value="'Times New Roman', serif">Times New Roman</option><option value="'Courier New', monospace">Courier New</option></select></label><label className="setting-select"><span>Размер текста сообщений</span><select value={chatFontSize} onChange={(event) => setChatFontSize(Number(event.target.value))}><option value="16">16 px</option><option value="18">18 px</option><option value="20">20 px</option><option value="22">22 px</option><option value="24">24 px</option><option value="26">26 px</option><option value="28">28 px</option></select></label><p className="setting-note">После сохранения шрифт и размер применяются к сообщениям и полю ввода открытого чата.</p></Section>
        <Section title="Проверка орфографии"><Switch label="Проверять орфографию" description="Используются встроенные portable-словари Hunspell; настройка действует только для активного профиля." checked={spellcheckEnabled} onCheckedChange={onSpellcheckEnabledChange} /><div className="language-list"><Switch label="Русский" checked={spellcheckRussian} onCheckedChange={onSpellcheckRussianChange} disabled={!spellcheckEnabled} /><Switch label="English" checked={spellcheckEnglish} onCheckedChange={onSpellcheckEnglishChange} disabled={!spellcheckEnabled} /></div>{spellcheckEnabled && !spellcheckRussian && !spellcheckEnglish && <p className="setting-note setting-warning">Не выбран ни один словарь — проверка фактически отключена.</p>}</Section>
      </>}
      {tab === "privacy" && <>
        <header><h1>Приватность</h1><p>Управляй информацией, которую видят собеседники.</p></header>
        <Section title="История"><Switch label="Сохранять историю чатов" description="История сообщений хранится локально в каталоге активного portable-профиля." checked={saveChatHistory} onCheckedChange={onSaveChatHistoryChange} />{!confirmClearHistory ? <button className="danger-button" onClick={() => setConfirmClearHistory(true)}>Очистить всю локальную историю</button> : <div className="destroy-confirm"><p>Будет удалена вся история активного профиля. Контакты и остальные профили не изменятся.</p><div className="button-row"><button className="text-button" onClick={() => setConfirmClearHistory(false)}>Отмена</button><button className="danger-button" onClick={() => void clearAllHistory()}>Очистить историю</button></div></div>}</Section>
      </>}
      {tab === "network" && <>
        <header><h1>Сеть Tox</h1><p>Подключение к распределённой сети, DHT и bootstrap-узлам.</p></header>
        <Section title="Подключение"><Switch label="Использовать UDP" description={networkSettings.udpEnabled ? "Включено для прямого подключения. При Tor или прокси toxcore автоматически использует TCP." : "Отключено: используется TCP-маршрут."} checked={networkSettings.udpEnabled} onCheckedChange={(udpEnabled) => updateNetworkSettings({ udpEnabled })} disabled={networkApplying} /><Switch label="Использовать IPv6" description={networkSettings.ipv6Enabled ? "Включено: toxcore использует IPv4 и IPv6." : "Отключено: toxcore использует IPv4."} checked={networkSettings.ipv6Enabled} onCheckedChange={(ipv6Enabled) => updateNetworkSettings({ ipv6Enabled })} disabled={networkApplying} /><Switch label="Обнаруживать локальных пиров" description={networkSettings.localDiscoveryEnabled ? "Включено вместе с UDP. При Tor или прокси локальное обнаружение не используется." : "Отключено."} checked={networkSettings.localDiscoveryEnabled} onCheckedChange={(localDiscoveryEnabled) => updateNetworkSettings({ localDiscoveryEnabled })} disabled={networkApplying} />{networkStatus && <p className="setting-note" data-i18n-ignore translate="no">{networkStatus}</p>}<p className="setting-note">Настройки общие для всех профилей. Все разблокированные профили подключаются одновременно и остаются в сети в фоне.</p></Section>
        <Section title="Прокси"><p className="setting-note">Настройки прокси общие для всех профилей. При включённом Tor пользовательский прокси сохраняется, но не используется: маршрут Tox идёт только через SOCKS5 встроенного Tor. Для SOCKS5 и HTTP с логином Kaigen поднимает локальный адаптер авторизации; прямой fallback запрещён.</p><label className="setting-select"><span>Режим прокси</span><select value={torEnabled ? "tor" : proxySettings.mode} disabled={torEnabled} onChange={(event) => { const next = { ...proxySettings, mode: event.target.value as ProxySettings["mode"] }; setProxySettingsState(next); if (next.mode === "none") saveProxy(next); }}>{torEnabled && <option value="tor">Встроенный Tor SOCKS5</option>}<option value="none">Не использовать</option><option value="socks5">SOCKS5</option><option value="http">HTTP</option></select></label>{torEnabled ? <div className="field-grid"><Field label="SOCKS-адрес" value="127.0.0.1" /><Field label="Динамический порт" value={torStatus.socksPort?.toString() ?? "ожидание"} /></div> : proxySettings.mode !== "none" && <><div className="field-grid"><Field label="Адрес сервера" value={proxySettings.host} onChange={(host) => setProxySettingsState((current) => ({ ...current, host }))} /><label className="setting-field"><span>Порт</span><input type="number" min="1" max="65535" value={proxySettings.port} onChange={(event) => setProxySettingsState((current) => ({ ...current, port: Number(event.target.value) }))} /></label><Field label="Логин (необязательно)" value={proxySettings.username} onChange={(username) => setProxySettingsState((current) => ({ ...current, username }))} /><Field label="Пароль (необязательно)" type="password" value={proxySettings.password} onChange={(password) => setProxySettingsState((current) => ({ ...current, password }))} /></div><div className="button-row"><button className="outline-button" onClick={testProxy} disabled={proxyTesting}>{proxyTesting ? "Проверка…" : "Проверить прокси"}</button><button className="save-button" onClick={() => saveProxy()}>Применить</button></div></>}{proxyStatus && <p className="setting-note" data-i18n-ignore translate="no">{proxyStatus}</p>}</Section>
      </>}
      {tab === "tor" && <>
        <header><h1>Tor и мосты</h1><p>Анонимный режим с единым для всех профилей процессом Tor Expert Bundle.</p></header>
        <Section title="Tor-режим"><Switch label="Включить Tor" description="Запускает встроенный Tor и направляет Tox только через его SOCKS5-прокси." checked={torEnabled} disabled={torApplying} onCheckedChange={(enabled) => { setTorEnabled(enabled); applyTorSettings({ enabled }); }} /><Switch label="Запретить прямое подключение при ошибке Tor" description="Kill switch обязателен: при остановке или ошибке Tor сеть Tox остаётся без маршрута." checked disabled /><div className="field-grid"><Field label="SOCKS-адрес" value="127.0.0.1" /><Field label="SOCKS-порт (динамический)" value={torStatus.socksPort?.toString() ?? "—"} /><Field label="Control-адрес" value="127.0.0.1" /><Field label="Control-порт (динамический)" value={torStatus.controlPort?.toString() ?? "—"} /></div><div className="tor-runtime-status"><span className={`tor-status ${torStatus.state}`}>{torApplying ? "применение сетевого маршрута" : torStatus.state === "disabled" ? "выключено" : torStatus.state === "starting" ? "запуск" : torStatus.state === "connecting" ? `подключение ${torStatus.progress}%` : torStatus.state === "connected" ? "подключено, маршрут защищён" : "ошибка"}</span>{torStatus.state !== "disabled" && <progress max="100" value={torStatus.progress} />}{(torError || torStatus.message) && <small className={torError || torStatus.state === "error" ? "tor-error-message" : ""}>{torError || formatTorRuntimeMessage(torStatus.message, torStatus.state, language)}</small>}</div><button className="outline-button" onClick={restartTor} disabled={!torEnabled || torApplying}>Перезапустить и проверить Tor</button></Section>
        <Section title="Мосты"><label className="setting-select"><span>Тип подключения</span><select value={torTransport} disabled={!torEnabled || torApplying} onChange={(event) => setTorTransport(event.target.value as TorSettings["transport"])}><option value="none">Без мостов</option><option value="snowflake">Встроенный Snowflake</option><option value="obfs4">Встроенный obfs4</option><option value="custom">Свои мосты</option></select></label>{torTransport === "custom" && <label className="setting-field"><span>Строки мостов (любой поддерживаемый тип, включая WebTunnel)</span><textarea placeholder="Одна строка моста на строку" value={bridgeLines} onChange={(event) => setBridgeLines(event.target.value)} /></label>}<div className="bridge-actions"><button className="outline-button" onClick={() => applyTorSettings()} disabled={!torEnabled || torApplying}>Применить и перезапустить Tor</button><span className="tor-status-label">Выбранный транспорт: {torTransport === "none" ? "без мостов" : torTransport}</span></div></Section>
      </>}
      {tab === "files" && <>
        <header><h1>Файлы</h1><p>Передача файлов между контактами напрямую через сеть Tox.</p></header>
        <Section title="Получение"><Field label="Папка загрузок" value="downloads" /><Switch label="Полный запрет приёма файлов" description="Перекрывает все настройки автоматического приёма и отклоняет входящие файлы." checked={fileSettings.denyAll} onCheckedChange={(denyAll) => updateFileSettings({ denyAll })} /><Switch label="Автоматически принимать изображения" description={fileSettings.autoAcceptImages ? "Автоматически принимаются PNG и JPG/JPEG в пределах лимита размера." : "Для каждого входящего PNG или JPG потребуется подтверждение."} checked={fileSettings.autoAcceptImages} onCheckedChange={(autoAcceptImages) => updateFileSettings({ autoAcceptImages })} disabled={fileSettings.denyAll} /><Switch label="Показывать изображения в окне чата" description="Если выключено, вместо изображения отображается нейтральная плашка с кнопкой показа." checked={fileSettings.showImages} onCheckedChange={(showImages) => updateFileSettings({ showImages })} /><Switch label="Автоматически принимать любые файлы от контактов" checked={fileSettings.autoAcceptAny} onCheckedChange={(autoAcceptAny) => updateFileSettings({ autoAcceptAny })} disabled={fileSettings.denyAll} /><label className="setting-field"><span>Лимит автоматического приёма, МБ</span><input type="number" min="0" max="8589934591" value={Math.floor(fileSettings.maxAutoBytes / 1024 / 1024)} onChange={(event) => updateFileSettings({ maxAutoBytes: Math.max(0, Number(event.target.value) || 0) * 1024 * 1024 })} /><small>Протокол Tox передаёт размер как 64-битное значение; интерфейс ограничивает ввод безопасным целым JavaScript.</small></label><label className="setting-select"><span>Одновременный приём файлов</span><select value={fileSettings.maxConcurrent} onChange={(event) => updateFileSettings({ maxConcurrent: Number(event.target.value) })}><option value="1">1</option><option value="2">2</option><option value="3">3</option><option value="5">5</option></select></label></Section>
        <Section title="Передача"><p className="setting-note">Очередь исходящих файлов сохраняется между запусками. Скорость и прогресс активной передачи показываются в карточке файла; входящая передача после разрыва запускается отправителем заново, поскольку протокол Tox не поддерживает продолжение между сеансами.</p></Section>
      </>}
      {tab === "notifications" && <>
        <header><h1>Уведомления</h1><p>Оповещения не изменяют сетевые или криптографические настройки.</p></header>
        <Section title="События"><Switch label="Уведомления о новых сообщениях" description="Показываются четыре секунды; нажатие открывает нужный профиль и чат." checked={notifyMessages} onCheckedChange={onNotifyMessagesChange} /><Switch label="Уведомления о запросах в друзья" description="В заголовке всегда указывается профиль, в котором произошло событие." checked={notifyRequests} onCheckedChange={onNotifyRequestsChange} /></Section>
      </>}
      {tab === "language" && <>
        <header><h1>Язык</h1><p>Язык меняется сразу во всём приложении, включая меню, подсказки и системный трей.</p></header>
        <Section title="Язык интерфейса"><label className="setting-select"><span>Язык</span><select value={language} onChange={(event) => setLanguage(event.target.value as "ru" | "en")}><option value="ru">Русский</option><option value="en">English</option></select></label></Section>
      </>}
      {tab === "advanced" && <>
        <header><h1>Расширенные</h1><p>Меняй эти параметры только если понимаешь их влияние на сеть и приватность.</p></header>
        <Section title="Масштаб интерфейса"><label className="setting-select"><span>Масштаб</span><select value={interfaceScale} onChange={(event) => setInterfaceScale(Number(event.target.value))}><option value="80">80%</option><option value="90">90%</option><option value="100">100%</option><option value="110">110%</option><option value="125">125%</option><option value="150">150%</option></select></label><p className="setting-note">После сохранения масштаб применяется ко всему окну приложения.</p></Section>
        <Section title="Системный трей"><Switch label="При закрытии сворачивать в системный трей" description="Если выключено, кнопка закрытия завершает Kaigen." checked={closeToTray} onCheckedChange={(enabled) => { setCloseToTrayState(enabled); void invoke("set_close_to_tray", { enabled }); }} /></Section>
        <Section title="Диагностика"><p className="setting-note">Сетевые события, передачи файлов и журнал встроенного Tor автоматически записываются в каталог активного portable-профиля. Секреты, тексты сообщений и содержимое файлов в журнал не попадают.</p><button className="outline-button" onClick={() => void invoke("open_logs_directory")}>Открыть папку журналов</button></Section>
        <Section title="Совместимость"><p className="setting-note">Обычные клиенты Tox поддерживаются всегда. После согласования PQ сообщения этому контакту автоматически получают дополнительный постквантовый слой; до согласования используется стандартное Tox E2EE.</p></Section>
      </>}
      {tab === "about" && <>
        <header><h1>О программе</h1><p>Kaigen — независимый кроссплатформенный Tox-мессенджер с опциональным постквантовым слоем.</p></header>
        <Section title="Версии и компоненты"><dl className="about-list"><div><dt>Приложение</dt><dd>Kaigen {COMPONENT_VERSIONS.app}</dd></div><div><dt>Интерфейс</dt><dd>Tauri {COMPONENT_VERSIONS.tauri} · React {COMPONENT_VERSIONS.react} · TypeScript {COMPONENT_VERSIONS.typescript}</dd></div><div><dt>Сетевой слой</dt><dd>c-toxcore {COMPONENT_VERSIONS.cToxcore} ({COMPONENT_VERSIONS.cToxcoreCommit.slice(0, 7)}) · Tox E2EE</dd></div><div><dt>Криптография</dt><dd>libsodium {COMPONENT_VERSIONS.libsodium} · ML-KEM native {COMPONENT_VERSIONS.mlkemNative} · AES-256-GCM · HKDF-SHA-256</dd></div><div><dt>Tor</dt><dd>Tor Expert Bundle {COMPONENT_VERSIONS.torExpertBundle} · Tor {COMPONENT_VERSIONS.tor} · lyrebird {COMPONENT_VERSIONS.lyrebird} · GeoIP {COMPONENT_VERSIONS.torGeoIpDataset}</dd></div><div><dt>Windows WebView</dt><dd>WebView2 Fixed {COMPONENT_VERSIONS.webView2}</dd></div><div><dt>Импорт истории qTox</dt><dd>SQLCipher {COMPONENT_VERSIONS.sqlcipherImportRuntime} / SQLite {COMPONENT_VERSIONS.sqliteImportRuntime} · OpenSSL {COMPONENT_VERSIONS.opensslImportRuntime}</dd></div><div><dt>Проверка орфографии</dt><dd>Hunspell en {COMPONENT_VERSIONS.hunspellEnglish} / ru {COMPONENT_VERSIONS.hunspellRussian} ({COMPONENT_VERSIONS.hunspellDictionariesCommit.slice(0, 7)}) · nspell {COMPONENT_VERSIONS.nspell}</dd></div></dl><button className="outline-button" onClick={() => void invoke("open_license_information")}>Открыть лицензионные сведения</button></Section>
        <Section title="Проект"><p className="setting-note">Исходный код, инструкции по сборке и готовые выпуски Kaigen опубликованы в репозитории проекта.</p><button className="outline-button" onClick={() => void openUrl("https://github.com/kaigendev/Kaigen")}>Открыть репозиторий Kaigen</button></Section>
        <Section title="Поддержать проект"><p className="setting-note">Если Kaigen оказался полезен, вы можете поддержать дальнейшую разработку.</p><div className="support-wallets"><div><span>Bitcoin</span><code>bc1q8xl8wjnldennqn8jpxywnskxn2t72nfhnsjhx9</code><button className="outline-button" onClick={() => copyWallet("bitcoin", "bc1q8xl8wjnldennqn8jpxywnskxn2t72nfhnsjhx9")}>{copiedWallet === "bitcoin" ? "Скопировано" : "Копировать"}</button></div><div><span>USDT-TRC20</span><code>TNErCzAjz34bDhBrioQycSrgaQs5kVYVA1</code><button className="outline-button" onClick={() => copyWallet("usdt", "TNErCzAjz34bDhBrioQycSrgaQs5kVYVA1")}>{copiedWallet === "usdt" ? "Скопировано" : "Копировать"}</button></div></div></Section>
      </>}
      </div>
      <footer className="settings-footer"><span>{saved ? "Настройки сохранены" : "Изменения сохраняются локально"}</span><button className="save-button" onClick={save}>Сохранить</button></footer>
    </main>
  </section>;
}

export default Settings;
