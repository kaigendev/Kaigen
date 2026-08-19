import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import ProfileAvatar from "./ProfileAvatar";
import TextEditContextMenu from "./TextEditContextMenu";
import { GlobalLanguageBridge, I18nProvider, useI18n, type Language } from "./i18n";
import { profileAvatarToToxPng, readAvatarDataUrl } from "./avatar";
import { formatProfileEventNotice, formatUserFacingError } from "./localization";
import "./Startup.css";

let messengerModulePromise: Promise<typeof import("./App")> | undefined;
const loadMessengerModule = () => (messengerModulePromise ??= import("./App"));
const MessengerApp = lazy(loadMessengerModule);

export type ProfileSummary = {
  id: string;
  name: string;
  fileName: string;
  encrypted: boolean;
  loaded: boolean;
  active: boolean;
  connection: "offline" | "tcp" | "udp" | "locked";
  userStatus: "online" | "away" | "busy" | "offline";
  unread: number;
  avatar?: string | null;
  notificationsEnabled: boolean;
  unreadTarget?: string | null;
  error?: string | null;
};

type StartupState = {
  firstRun: boolean;
  language: Language;
  closeToTray: boolean;
  profiles: ProfileSummary[];
};

type LocalizedError = Record<Language, string>;

type QtoxCandidate = {
  name: string;
  profilePath: string;
  historyPath?: string | null;
  settingsPath?: string | null;
  encrypted: boolean;
};

function Splash() {
  return <section className="splash-screen" aria-label="Kaigen is loading">
    <div className="splash-brand" aria-label="Kaigen"><img src="/kaigen-icon.png" alt="" /><strong>KAIGEN</strong></div>
    <div className="splash-progress" aria-hidden="true"><i /></div>
  </section>;
}

function LanguageChoice() {
  const { language, setLanguage } = useI18n();
  return <div className="startup-language" role="group" aria-label="Language">
    <button className={language === "ru" ? "active" : ""} onClick={() => setLanguage("ru")}>ru</button>
    <button className={language === "en" ? "active" : ""} onClick={() => setLanguage("en")}>en</button>
  </div>;
}

function Brand() {
  return <div className="startup-brand" aria-label="Kaigen">
    <img src="/kaigen-icon.png" alt="" />
    <strong>KAIGEN</strong>
  </div>;
}

function CreateProfileIcon() {
  return <svg viewBox="0 0 96 96" aria-hidden="true"><circle cx="38" cy="32" r="13" /><path d="M17 69c2-16 10-24 22-24 7 0 13 3 17 8" /><path d="M68 48v26M55 61h26" /></svg>;
}

function ImportProfileIcon() {
  return <svg viewBox="0 0 96 96" aria-hidden="true"><path d="M15 27h27l9 9h30v35H15Z" /><path d="M52 54h27M69 43l11 11-11 11" /></svg>;
}

function PrivacyShieldIcon() {
  return <svg viewBox="0 0 48 48" aria-hidden="true"><path d="M24 5.5 39 10.9v10.6c0 9.4-6.1 16.6-15 21-8.9-4.4-15-11.6-15-21V10.9L24 5.5Z" /><rect x="16.5" y="22.2" width="15" height="11.5" rx="2.2" /><path d="M19.5 22.2v-2.1a4.5 4.5 0 0 1 9 0v2.1M24 26.2v3.4" /></svg>;
}

function Welcome({ onProfiles, onBackToProfiles }: { onProfiles: (profiles: ProfileSummary[]) => void; onBackToProfiles?: () => void }) {
  const { language, t } = useI18n();
  const [flow, setFlow] = useState<"choice" | "create" | "import">("choice");
  const [name, setName] = useState("Tox User");
  const [protect, setProtect] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [folder, setFolder] = useState("");
  const [candidates, setCandidates] = useState<QtoxCandidate[]>([]);
  const [qtoxSearchComplete, setQtoxSearchComplete] = useState(false);
  const [candidatePasswords, setCandidatePasswords] = useState<Record<string, string>>({});
  const [historyOverrides, setHistoryOverrides] = useState<Record<string, string>>({});
  const [activity, setActivity] = useState<"idle" | "creating" | "discovering" | "importing">("idle");
  const [error, setError] = useState("");
  const busy = activity !== "idle";
  const languageRef = useRef(language);
  languageRef.current = language;
  useEffect(() => setError(""), [language]);

  const create = async () => {
    if (protect && password !== confirm) {
      setError(t("Пароли не совпадают"));
      return;
    }
    setActivity("creating"); setError("");
    try {
      onProfiles(await invoke<ProfileSummary[]>("create_profile", { name, password: protect ? password : null }));
    } catch (value) {
      setError(formatUserFacingError(value, { ru: "Не удалось создать профиль", en: "Could not create the profile" }, languageRef.current));
    } finally { setActivity("idle"); }
  };

  const discover = async (location?: string) => {
    setActivity("discovering"); setError(""); setCandidates([]); setQtoxSearchComplete(false);
    try {
      setCandidates(await invoke<QtoxCandidate[]>("discover_qtox_profiles", { location: location?.trim() || null }));
      setQtoxSearchComplete(true);
    } catch (value) { setError(formatUserFacingError(value, { ru: "Не удалось найти профили qTox", en: "Could not find qTox profiles" }, languageRef.current)); }
    finally { setActivity("idle"); }
  };

  const browse = async () => {
    try {
      const selected = await openDialog({ directory: true, multiple: false, title: t("Выберите папку qTox или portable qTox") });
      if (typeof selected === "string") { setFolder(selected); await discover(selected); }
    } catch (value) { setError(formatUserFacingError(value, { ru: "Не удалось открыть папку qTox", en: "Could not open the qTox folder" }, languageRef.current)); }
  };

  const importProfile = async (candidate: QtoxCandidate) => {
    setActivity("importing"); setError("");
    try {
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      onProfiles(await invoke<ProfileSummary[]>("import_qtox_profile", {
        profilePath: candidate.profilePath,
        historyPath: historyOverrides[candidate.profilePath]?.trim() || candidate.historyPath || null,
        password: candidate.encrypted ? candidatePasswords[candidate.profilePath] ?? "" : null,
      }));
    } catch (value) {
      setError(formatUserFacingError(value, { ru: "Не удалось импортировать профиль qTox", en: "Could not import the qTox profile" }, languageRef.current));
    } finally { setActivity("idle"); }
  };

  return <section className="welcome-screen">
    <LanguageChoice />
    <Brand />
    <header><h1>{t("Добро пожаловать в Kaigen")}</h1><p>{t("Выберите, что вы хотите сделать для начала работы")}</p></header>
    {flow === "choice" && <div className="welcome-cards">
      <article className="welcome-card create-card"><span className="welcome-card-icon"><CreateProfileIcon /></span><h2>{t("Создать новый профиль")}</h2><p>{t("Начните с чистого листа. Создайте новый профиль и настройте свой аккаунт.")}</p><button onClick={() => setFlow("create")}>{t("Создать профиль")} <b>›</b></button></article>
      <article className="welcome-card import-card"><span className="welcome-card-icon"><ImportProfileIcon /></span><h2>{t("Импортировать из qTox")}</h2><p>{t("Перенесите контакты и историю сообщений из существующего qTox-профиля.")}</p><button onClick={() => setFlow("import")}>{t("Импортировать")} <b>›</b></button></article>
      {onBackToProfiles && <button className="welcome-profile-back" type="button" onClick={onBackToProfiles}>‹ {t("Вернуться к подключению профилей")}</button>}
    </div>}
    {flow === "create" && <form className={`startup-form create-flow ${protect ? "with-password" : ""}`} onSubmit={(event) => { event.preventDefault(); void create(); }}>
      <button className="startup-back" type="button" onClick={() => setFlow("choice")}>‹ {t("Назад")}</button>
      <h2>{t("Новый профиль")}</h2>
      <label>{t("Имя профиля")}<input value={name} maxLength={64} onChange={(event) => setName(event.target.value)} autoFocus /></label>
      <label className="startup-check"><input type="checkbox" checked={protect} onChange={(event) => setProtect(event.target.checked)} /><span>{t("Защитить профиль паролем")}</span></label>
      {protect && <div className="startup-passwords"><label>{t("Пароль")}<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" /></label><label>{t("Повторите пароль")}<input type="password" value={confirm} onChange={(event) => setConfirm(event.target.value)} autoComplete="new-password" /></label><small>{t("Без этого пароля восстановить профиль будет невозможно.")}</small></div>}
      {error && <p className="startup-error">{error}</p>}
      <button className="startup-primary" disabled={busy || !name.trim() || (protect && !password)}>{activity === "creating" ? t("Создание…") : t("Создать профиль")}</button>
    </form>}
    {flow === "import" && <div className={`startup-form import-flow ${busy ? "busy" : ""}`} aria-busy={busy}>
      <button className="startup-back" type="button" onClick={() => setFlow("choice")}>‹ {t("Назад")}</button>
      <h2>{t("Импорт из qTox")}</h2>
      <p>{t("Нажмите «Найти», чтобы проверить стандартную папку qTox, или выберите каталог портативной копии.")}</p>
      <div className="folder-row"><input disabled={busy} value={folder} onChange={(event) => setFolder(event.target.value)} placeholder={t("Папка портативного qTox")} /><button type="button" disabled={busy} onClick={() => void browse()}>{t("Обзор…")}</button><button type="button" disabled={busy} onClick={() => void discover(folder)}>{t("Найти")}</button></div>
      {(activity === "discovering" || activity === "importing") && <div className="import-progress" role="status" aria-live="polite"><progress /><span>{activity === "discovering" ? t("Поиск профилей qTox. Пожалуйста, подождите…") : t("Импорт профиля, аватаров и истории. Пожалуйста, подождите…")}</span></div>}
      <div className="qtox-candidates">{candidates.map((candidate) => <article key={candidate.profilePath}>
        <div><b data-i18n-ignore translate="no">{candidate.name}</b><small data-i18n-ignore translate="no">{candidate.profilePath}</small><span>{candidate.historyPath ? t("История найдена") : t("История не найдена")}{candidate.encrypted ? ` · ${t("защищён паролем")}` : ""}</span></div>
        {candidate.encrypted && <label>{t("Пароль")}<input type="password" value={candidatePasswords[candidate.profilePath] ?? ""} onChange={(event) => setCandidatePasswords((current) => ({ ...current, [candidate.profilePath]: event.target.value }))} onKeyDown={(event) => { const enteredPassword = candidatePasswords[candidate.profilePath] ?? ""; if (event.key === "Enter" && !event.nativeEvent.isComposing && !busy && enteredPassword) { event.preventDefault(); void importProfile(candidate); } }} /></label>}
        {!candidate.historyPath && <label>{t("Файл истории (необязательно)")}<span className="folder-row"><input value={historyOverrides[candidate.profilePath] ?? ""} onChange={(event) => setHistoryOverrides((current) => ({ ...current, [candidate.profilePath]: event.target.value }))} /><button type="button" onClick={async () => { const selected = await openDialog({ multiple: false, title: t("Выберите базу истории qTox"), filters: [{ name: "qTox history", extensions: ["db"] }] }); if (typeof selected === "string") setHistoryOverrides((current) => ({ ...current, [candidate.profilePath]: selected })); }}>{t("Обзор…")}</button></span></label>}
        <button className="startup-primary" type="button" disabled={busy || (candidate.encrypted && !(candidatePasswords[candidate.profilePath] ?? ""))} onClick={() => void importProfile(candidate)}>{t("Импортировать")}</button>
      </article>)}</div>
      {!busy && !qtoxSearchComplete && <p className="startup-note">{t("Поиск начнётся только после вашего действия.")}</p>}
      {!busy && qtoxSearchComplete && candidates.length === 0 && <p className="startup-note">{t("Профили qTox не найдены. Укажите папку вручную или создайте новый профиль.")}</p>}
      {error && <p className="startup-error">{error}</p>}
    </div>}
    <footer><span className="welcome-shield"><PrivacyShieldIcon /></span><p>{t("Все данные хранятся рядом с программой. Сетевой маршрут может быть защищён встроенным Tor, а сообщения — дополнительным постквантовым слоем.")}</p></footer>
  </section>;
}

function UnlockProfiles({ profiles, onProfiles, onAddProfile, onContinue }: { profiles: ProfileSummary[]; onProfiles: (profiles: ProfileSummary[]) => void; onAddProfile: () => void; onContinue: () => void }) {
  const { language, t } = useI18n();
  const [passwords, setPasswords] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, LocalizedError | undefined>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [disabling, setDisabling] = useState<Record<string, boolean>>({});
  const [avatarBusy, setAvatarBusy] = useState<Record<string, boolean>>({});
  const unlock = async (profile: ProfileSummary) => {
    if (profile.loaded || busy[profile.id] || !passwords[profile.id]) return;
    setBusy((value) => ({ ...value, [profile.id]: true }));
    setErrors((value) => ({ ...value, [profile.id]: undefined }));
    try {
      const nextProfiles = await invoke<ProfileSummary[]>("unlock_profile", { profileId: profile.id, password: passwords[profile.id] ?? "" });
      setPasswords((value) => {
        const next = { ...value };
        delete next[profile.id];
        return next;
      });
      onProfiles(nextProfiles);
    } catch {
      setErrors((value) => ({ ...value, [profile.id]: {
        ru: "Неверный пароль. Повторите ввод или пропустите этот профиль.",
        en: "Incorrect password. Try again or skip this profile.",
      } }));
    } finally { setBusy((value) => ({ ...value, [profile.id]: false })); }
  };
  const disable = async (profile: ProfileSummary) => {
    if (disabling[profile.id] || busy[profile.id]) return;
    setDisabling((value) => ({ ...value, [profile.id]: true }));
    setErrors((value) => ({ ...value, [profile.id]: undefined }));
    try {
      onProfiles(await invoke<ProfileSummary[]>("disable_profile", { profileId: profile.id }));
    } catch {
      setErrors((value) => ({ ...value, [profile.id]: {
        ru: "Не удалось отключить профиль",
        en: "Could not disable the profile",
      } }));
    } finally {
      setDisabling((value) => ({ ...value, [profile.id]: false }));
    }
  };
  const updateAvatar = async (profile: ProfileSummary, file: File | undefined) => {
    if (!file || !profile.loaded || avatarBusy[profile.id]) return;
    setAvatarBusy((value) => ({ ...value, [profile.id]: true }));
    setErrors((value) => ({ ...value, [profile.id]: undefined }));
    try {
      const dataUrl = await readAvatarDataUrl(file);
      const toxBytes = await profileAvatarToToxPng(dataUrl);
      onProfiles(await invoke<ProfileSummary[]>("set_profile_avatar", {
        profileId: profile.id,
        dataUrl,
        filename: "avatar.png",
        bytes: toxBytes,
      }));
    } catch (error) {
      setErrors((value) => ({ ...value, [profile.id]: {
        ru: formatUserFacingError(error, { ru: "Не удалось установить аватар", en: "Could not set the avatar" }, "ru"),
        en: formatUserFacingError(error, { ru: "Не удалось установить аватар", en: "Could not set the avatar" }, "en"),
      } }));
    } finally {
      setAvatarBusy((value) => ({ ...value, [profile.id]: false }));
    }
  };
  return <section className="unlock-screen"><LanguageChoice /><Brand /><header><h1>{t("Подключение профилей")}</h1><p>{t("Введите пароли только для тех профилей, которые хотите подключить сейчас.")}</p></header><div className="unlock-list">{profiles.map((profile) => <article className={profile.loaded ? "unlocked" : ""} key={profile.id}>
    <div className="unlock-profile-heading">
      <label className={`unlock-profile-avatar-picker ${profile.loaded ? "enabled" : "disabled"}`} title={profile.loaded ? t("Выбрать аватар") : undefined}>
        <ProfileAvatar src={profile.avatar} initial={profile.name.trim().charAt(0).toLocaleUpperCase() || "T"} className="unlock-profile-avatar" alt={profile.name} />
        {profile.loaded && <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" disabled={avatarBusy[profile.id]} onChange={(event) => { void updateAvatar(profile, event.target.files?.[0]); event.currentTarget.value = ""; }} />}
      </label>
      <span className="unlock-profile-copy"><span className="unlock-profile-title"><b data-i18n-ignore translate="no">{profile.name}</b>{profile.loaded && <span className="unlock-profile-success" role="status"><i aria-hidden="true">✓</i>{t("разблокировано")}</span>}</span><small data-i18n-ignore translate="no">{profile.fileName}</small></span>
      <button type="button" className="unlock-profile-disable" data-i18n-ignore translate="no" aria-label={`${t("Отключить профиль")}: ${profile.name}`} title={t("Отключить профиль")} disabled={disabling[profile.id] || busy[profile.id]} onClick={() => void disable(profile)}><span aria-hidden="true">×</span></button>
    </div>
    {!profile.loaded && profile.encrypted && <><input type="password" data-i18n-ignore translate="no" aria-label={`${t("Пароль профиля")}: ${profile.name}`} placeholder={t("Пароль профиля")} value={passwords[profile.id] ?? ""} onChange={(event) => setPasswords((value) => ({ ...value, [profile.id]: event.target.value }))} onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); void unlock(profile); } }} /><button disabled={busy[profile.id] || !passwords[profile.id]} onClick={() => void unlock(profile)}>{busy[profile.id] ? "…" : t("Открыть")}</button></>}
    {errors[profile.id] && <em>{errors[profile.id]?.[language]}</em>}
  </article>)}</div><div className="unlock-actions"><button className="startup-primary" onClick={onContinue}>{profiles.some((profile) => profile.loaded) ? t("Продолжить с открытыми профилями") : t("Пропустить и вернуться")}</button><button className="unlock-add-profile" type="button" onClick={onAddProfile}><span aria-hidden="true" />{t("Добавить ещё один профиль")}</button></div></section>;
}

export default function RootApp() {
  const [language, setLanguageState] = useState<Language>("ru");
  const [startup, setStartup] = useState<StartupState | null>(null);
  const [splashDone, setSplashDone] = useState(false);
  const [skipLocks, setSkipLocks] = useState(false);
  const [unlockFlowOpen, setUnlockFlowOpen] = useState(false);
  const [showWelcome, setShowWelcome] = useState(false);
  const [messengerKey, setMessengerKey] = useState(0);
  const [profileSwitching, setProfileSwitching] = useState(false);
  const profileSwitchingRef = useRef(false);
  const initialStartupRouteResolved = useRef(false);
  const [fatal, setFatal] = useState("");
  const [profileNotices, setProfileNotices] = useState<Array<{ id: number; profileId: string; target?: string | null; title: string; body: string }>>([]);
  const previousUnread = useRef<Record<string, number> | null>(null);

  useEffect(() => setProfileNotices([]), [language]);

  const refresh = useCallback(async () => {
    const value = await invoke<StartupState>("get_startup_state");
    if (!initialStartupRouteResolved.current) {
      initialStartupRouteResolved.current = true;
      const hasLockedPasswordProfile = value.profiles.some((profile) => profile.encrypted && !profile.loaded);
      // On subsequent application launches the connection screen is useful only
      // when at least one enabled password-protected profile actually needs to be
      // unlocked. Explicitly pin the direct route for passwordless profiles so a
      // background profiles-changed refresh cannot reopen the startup flow.
      setSkipLocks(!hasLockedPasswordProfile);
      setUnlockFlowOpen(hasLockedPasswordProfile);
    }
    setStartup((current) => JSON.stringify(current) === JSON.stringify(value) ? current : value);
    setLanguageState((current) => current === value.language ? current : value.language);
  }, []);
  useEffect(() => {
    const started = performance.now();
    let preloadFrame = 0;
    const messengerReady = new Promise<void>((resolve, reject) => {
      preloadFrame = window.requestAnimationFrame(() => {
        void loadMessengerModule().then(() => resolve()).catch(reject);
      });
    });
    void Promise.all([refresh(), messengerReady])
      .catch((error) => setFatal(String(error)))
      .finally(() => {
        const elapsed = performance.now() - started;
        const minimumVisible = elapsed < 1500 ? 2000 : elapsed;
        window.setTimeout(() => setSplashDone(true), Math.max(0, minimumVisible - elapsed));
      });
    return () => window.cancelAnimationFrame(preloadFrame);
  }, [refresh]);
  useEffect(() => {
    const handler = () => void refresh();
    const activeHandler = () => void refresh().then(() => setMessengerKey((value) => value + 1));
    const stopBackendListener = listen<string>("profiles-changed", handler);
    window.addEventListener("profiles-changed", handler);
    window.addEventListener("active-profile-changed", activeHandler);
    return () => {
      window.removeEventListener("profiles-changed", handler);
      window.removeEventListener("active-profile-changed", activeHandler);
      void stopBackendListener.then((unlisten) => unlisten());
    };
  }, [refresh]);

  const changeLanguage = useCallback((next: Language) => {
    setLanguageState(next);
    void invoke("set_app_language", { language: next });
  }, []);
  const storeProfiles = (profiles: ProfileSummary[]) => {
    const uniqueProfiles = Array.from(new Map(profiles.map((profile) => [profile.id, profile])).values());
    setStartup((current) => current ? { ...current, firstRun: uniqueProfiles.length === 0, profiles: uniqueProfiles } : current);
    setMessengerKey((value) => value + 1);
  };
  const onProfiles = (profiles: ProfileSummary[]) => {
    storeProfiles(profiles);
    setSkipLocks(false);
    setShowWelcome(false);
  };
  const updateMainWindowProfiles = (profiles: ProfileSummary[]) => {
    storeProfiles(profiles);
    setSkipLocks(true);
    setUnlockFlowOpen(false);
    setShowWelcome(false);
  };
  const routeAfterProfileRemoval = (profiles: ProfileSummary[]) => {
    storeProfiles(profiles);
    if (profiles.some((profile) => profile.loaded)) {
      setSkipLocks(true);
      setUnlockFlowOpen(false);
      setShowWelcome(false);
    } else if (profiles.length > 0) {
      setSkipLocks(false);
      setUnlockFlowOpen(true);
      setShowWelcome(false);
    } else {
      setSkipLocks(false);
      setUnlockFlowOpen(false);
      setShowWelcome(true);
    }
  };
  const reviewCreatedOrImportedProfiles = (profiles: ProfileSummary[]) => {
    onProfiles(profiles);
    setUnlockFlowOpen(true);
  };
  const addAnotherProfile = () => {
    setSkipLocks(false);
    setUnlockFlowOpen(true);
    setShowWelcome(true);
  };
  const returnToProfileConnection = () => {
    setSkipLocks(false);
    setUnlockFlowOpen(true);
    setShowWelcome(false);
  };
  const switchProfile = async (id: string) => {
    if (profileSwitchingRef.current) return;
    profileSwitchingRef.current = true;
    setProfileSwitching(true);
    try { updateMainWindowProfiles(await invoke<ProfileSummary[]>("switch_profile", { profileId: id })); }
    catch (error) { setFatal(String(error)); }
    finally {
      profileSwitchingRef.current = false;
      setProfileSwitching(false);
    }
  };
  const runProfileRemoval = async (command: "disable_profile" | "destroy_active_profile", profileId?: string) => {
    if (profileSwitchingRef.current) throw new Error("PROFILE_ACTION_BUSY");
    profileSwitchingRef.current = true;
    setProfileSwitching(true);
    try {
      const profiles = command === "disable_profile"
        ? await invoke<ProfileSummary[]>(command, { profileId })
        : await invoke<ProfileSummary[]>(command);
      routeAfterProfileRemoval(profiles);
    } finally {
      profileSwitchingRef.current = false;
      setProfileSwitching(false);
    }
  };
  const continueUnlocked = async () => {
    try {
      const profiles = await invoke<ProfileSummary[]>("continue_with_loaded_profiles");
      const hasLoadedProfile = profiles.some((profile) => profile.loaded);
      onProfiles(profiles);
      setSkipLocks(true);
      setUnlockFlowOpen(false);
      setShowWelcome(!hasLoadedProfile);
    }
    catch (error) { setFatal(String(error)); }
  };
  const lockedRemain = useMemo(() => startup?.profiles.some((profile) => profile.encrypted && !profile.loaded) ?? false, [startup]);
  const loaded = startup?.profiles.some((profile) => profile.loaded) ?? false;
  useEffect(() => {
    if (lockedRemain && !skipLocks) setUnlockFlowOpen(true);
  }, [lockedRemain, skipLocks]);
  useEffect(() => {
    if (!startup) return;
    const current = Object.fromEntries(startup.profiles.map((profile) => [profile.id, profile.unread]));
    if (previousUnread.current) {
      for (const profile of startup.profiles) {
        const increase = profile.unread - (previousUnread.current[profile.id] ?? 0);
        if (increase <= 0 || profile.active || !profile.notificationsEnabled) continue;
        const notice = {
          id: Date.now() + Math.random(),
          profileId: profile.id,
          target: profile.unreadTarget,
          ...formatProfileEventNotice(profile.name, increase, language),
        };
        setProfileNotices((items) => [...items, notice]);
        window.setTimeout(() => setProfileNotices((items) => items.filter((item) => item.id !== notice.id)), 4000);
        void (async () => {
          let allowed = await isPermissionGranted();
          if (!allowed) allowed = (await requestPermission()) === "granted";
          if (allowed) sendNotification({ title: notice.title, body: notice.body });
        })();
      }
    }
    previousUnread.current = current;
  }, [language, startup]);
  useEffect(() => {
    const active = startup?.profiles.find((profile) => profile.active);
    const title = active?.loaded ? `Kaigen — ${active.name}` : "Kaigen";
    document.title = title;
    void getCurrentWindow().setTitle(title);
  }, [startup]);

  return <I18nProvider language={language} setLanguage={changeLanguage}><GlobalLanguageBridge /><TextEditContextMenu />
    <div className="profile-event-notices">{profileNotices.map((notice) => <article key={notice.id} onClick={() => { setProfileNotices((items) => items.filter((item) => item.id !== notice.id)); if (notice.target) sessionStorage.setItem("kaigen-open-unread-target", notice.target); void switchProfile(notice.profileId); }}><button onClick={(event) => { event.stopPropagation(); setProfileNotices((items) => items.filter((item) => item.id !== notice.id)); }} aria-label="Закрыть">×</button><b data-i18n-ignore translate="no">{notice.title}</b><span data-i18n-ignore translate="no">{notice.body}</span></article>)}</div>
    {!splashDone || !startup ? <Splash /> : fatal ? <section className="startup-fatal"><Brand /><h2>Kaigen</h2><p>{formatUserFacingError(fatal, { ru: "Не удалось запустить Kaigen", en: "Could not start Kaigen" }, language)}</p><button onClick={() => { setFatal(""); void refresh(); }}>Retry</button></section> : startup.firstRun || showWelcome ? <Welcome onProfiles={reviewCreatedOrImportedProfiles} onBackToProfiles={startup.profiles.length > 0 ? returnToProfileConnection : undefined} /> : !skipLocks && (lockedRemain || unlockFlowOpen) ? <UnlockProfiles profiles={startup.profiles} onProfiles={onProfiles} onAddProfile={addAnotherProfile} onContinue={() => void continueUnlocked()} /> : loaded ? <div className="messenger-root"><Suspense fallback={null}><MessengerApp key={messengerKey} profiles={startup.profiles} profileSwitching={profileSwitching} onSwitchProfile={(id) => void switchProfile(id)} onDisableProfile={(id) => runProfileRemoval("disable_profile", id)} onDestroyActiveProfile={() => runProfileRemoval("destroy_active_profile")} /></Suspense></div> : <Welcome onProfiles={reviewCreatedOrImportedProfiles} onBackToProfiles={startup.profiles.length > 0 ? returnToProfileConnection : undefined} />}
  </I18nProvider>;
}
