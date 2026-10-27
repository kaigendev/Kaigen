import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow, invoke, listen, openDialog, platformCapabilities } from "@kaigen/platform";
import MessengerApp from "./App";
import { CompactModal } from "./CompactModal";
import { isProfileAvatarPending, observeProfileAvatarRequests, releaseProfileAvatar, reserveProfileAvatar } from "./profileAvatarRequests";
import ProfileAvatar from "./ProfileAvatar";
import TextEditContextMenu from "./TextEditContextMenu";
import { GlobalLanguageBridge, I18nProvider, useI18n, type Language } from "./i18n";
import { normalizeProfileAvatar, readAvatarDataUrl } from "./avatar";
import { formatUserFacingError } from "./localization";
import rootAppUiCatalog from "./RootApp.ui-ids.json" with { type: "json" };
import { opaqueUiEntityKey } from "./uiIdentity";
import { useKaigenTheme } from "@kaigen/theme";
import { canLeaveStartupSplash } from "./layoutPersistence";
import { brandImageUrl, prepareBrandImage } from "./brandImage";
import "./Startup.css";
import { installDesktopNotifications } from "./desktopNotifications";

const ROOT_APP_UI_IDS = rootAppUiCatalog.ids;

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
  initialConnectionPresetRequired: boolean;
  profiles: ProfileSummary[];
};
type CreatedProfileResult = {
  profiles: ProfileSummary[];
  initialConnectionPresetRequired: boolean;
};

type InitialConnectionPreset = "safe" | "fast";

type LocalizedError = Record<Language, string>;

type QtoxCandidate = {
  name: string;
  profilePath: string;
  sourceLabel?: string;
  historyPath?: string | null;
  settingsPath?: string | null;
  encrypted: boolean;
  passwordMode?: "required" | "optional";
};

function qtoxCandidatePasswordMode(candidate: QtoxCandidate) {
  if (candidate.passwordMode) return candidate.passwordMode;
  if (candidate.encrypted) return "required" as const;
  const sourceName = (candidate.sourceLabel ?? candidate.profilePath).toLocaleLowerCase("en-US");
  return sourceName.endsWith(".kai") || sourceName.endsWith(".zip") ? "optional" as const : "none" as const;
}

function Splash() {
  return <section className="splash-screen" aria-label="Kaigen is loading">
    <div className="splash-brand" aria-label="Kaigen"><img src={brandImageUrl} alt="" /><strong>KAIGEN</strong></div>
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
    <img src={brandImageUrl} alt="" />
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

function SafeConnectionIcon() {
  return <svg viewBox="0 0 64 64" aria-hidden="true"><path d="M32 6 52 13v14c0 13-8 23-20 30C20 50 12 40 12 27V13Z" /><path d="M23 31h18v14H23Z" /><path d="M27 31v-4a5 5 0 0 1 10 0v4" /></svg>;
}

function FastConnectionIcon() {
  return <svg viewBox="0 0 64 64" aria-hidden="true"><path d="M36 5 15 36h15l-2 23 21-32H34Z" /></svg>;
}

function InitialConnectionPresetDialog({ busy, error, onSelect }: { busy: InitialConnectionPreset | null; error: string; onSelect: (preset: InitialConnectionPreset) => void }) {
  const { language, t } = useI18n();
  const dialogRef = useRef<HTMLElement>(null);
  const safeChoiceRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    safeChoiceRef.current?.focus({ preventScroll: true });
    const keepFocusInside = (event: FocusEvent) => {
      const dialog = dialogRef.current;
      if (!dialog || dialog.contains(event.target as Node)) return;
      const available = [...dialog.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
      (available[0] ?? dialog).focus({ preventScroll: true });
    };
    const trapKeyboard = (event: KeyboardEvent) => {
      const dialog = dialogRef.current;
      if (!dialog) return;
      if (event.key === "Escape") {
        event.preventDefault();
        return;
      }
      if (event.key !== "Tab") return;
      const available = [...dialog.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
      if (available.length === 0) {
        event.preventDefault();
        dialog.focus({ preventScroll: true });
        return;
      }
      const first = available[0];
      const last = available[available.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus({ preventScroll: true });
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    };
    document.addEventListener("focusin", keepFocusInside);
    document.addEventListener("keydown", trapKeyboard);
    return () => {
      document.removeEventListener("focusin", keepFocusInside);
      document.removeEventListener("keydown", trapKeyboard);
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, []);
  return <div className="initial-connection-preset-backdrop" data-kaigen-ui-id={ROOT_APP_UI_IDS.startup_first_run_preset_group_overlay}>
    <section ref={dialogRef} className="initial-connection-preset" role="dialog" tabIndex={-1} aria-modal="true" aria-labelledby="initial-connection-preset-title" aria-busy={busy !== null} data-kaigen-ui-id={ROOT_APP_UI_IDS.startup_first_run_preset_group_dialog}>
      <header><h2 id="initial-connection-preset-title" data-kaigen-ui-id={ROOT_APP_UI_IDS.startup_first_run_preset_element_title}>{t("Выберите режим подключения")}</h2><p>{t("Выбор изменит только существующие сетевые настройки. Позже их можно настроить вручную.")}</p></header>
      <div className="initial-connection-preset-options">
        <button ref={safeChoiceRef} type="button" className="initial-connection-preset-option safe" disabled={busy !== null} onClick={() => onSelect("safe")} data-kaigen-ui-id={ROOT_APP_UI_IDS.startup_first_run_preset_element_safe_choice}>
          <span className="initial-connection-preset-icon"><SafeConnectionIcon /></span>
          <strong>{t("Безопасный")}</strong>
          <p>{t("Соединение через встроенный Tor с отключёнными прямыми сетевыми возможностями.")}</p>
          <ul><li>{t("Tor: включён")}</li><li>{t("UDP: выключен")}</li><li>{t("IPv6: выключен")}</li><li>{t("Локальные пиры: выключены")}</li></ul>
          <span className="initial-connection-preset-action">{busy === "safe" ? t("Применение…") : t("Выбрать безопасный")}</span>
        </button>
        <button type="button" className="initial-connection-preset-option fast" disabled={busy !== null} onClick={() => onSelect("fast")} data-kaigen-ui-id={ROOT_APP_UI_IDS.startup_first_run_preset_element_fast_choice}>
          <span className="initial-connection-preset-icon"><FastConnectionIcon /></span>
          <strong>{t("Быстрый")}</strong>
          <p>{t("Прямое подключение без Tor с доступными быстрыми маршрутами и локальным обнаружением.")}</p>
          <ul><li>{t("Tor: выключен")}</li><li>{t("UDP: включён")}</li><li>{t("IPv6: включён")}</li><li>{t("Локальные пиры: включены")}</li></ul>
          <span className="initial-connection-preset-action">{busy === "fast" ? t("Применение…") : t("Выбрать быстрый")}</span>
        </button>
      </div>
      <p className="initial-connection-preset-note" data-i18n-ignore translate="no">{language === "ru" ? "Провайдер может блокировать Tor. Kaigen перебирает варианты подключения, но обход блокировок не гарантируется. Могут понадобиться Tor-мосты." : "Your provider may block Tor. Kaigen tries different connection options, but bypassing blocks is not guaranteed. You may need Tor bridges."}</p>
      {error && <p className="initial-connection-preset-error" role="alert" data-kaigen-ui-id={ROOT_APP_UI_IDS.startup_first_run_preset_element_status}>{error}</p>}
    </section>
  </div>;
}

function Welcome({ onProfiles, onBackToProfiles }: { onProfiles: (profiles: ProfileSummary[], source: "create" | "import", initialConnectionPresetRequired?: boolean) => void | Promise<void>; onBackToProfiles?: () => void }) {
  const { language, t } = useI18n();
  const [flow, setFlow] = useState<"choice" | "create" | "import">("choice");
  const [name, setName] = useState("Tox User");
  const [protect, setProtect] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [candidates, setCandidates] = useState<QtoxCandidate[]>([]);
  const [sourceInspected, setSourceInspected] = useState(false);
  const [candidatePasswords, setCandidatePasswords] = useState<Record<string, string>>({});
  type Activity = "idle" | "choosing" | "creating" | "discovering" | "importing";
  const [activity, setActivity] = useState<Activity>("idle");
  const activityRef = useRef<Activity>("idle");
  const pickerAbort = useRef<AbortController | null>(null);
  useEffect(() => () => { pickerAbort.current?.abort(); }, []);
  const beginActivity = (next: Activity) => {
    if (activityRef.current !== "idle") return false;
    activityRef.current = next; setActivity(next); return true;
  };
  const finishActivity = () => { activityRef.current = "idle"; setActivity("idle"); };
  const [error, setError] = useState("");
  const busy = activity !== "idle";
  const languageRef = useRef(language);
  languageRef.current = language;
  useEffect(() => setError(""), [language]);
  useEffect(() => { setPassword(""); setConfirm(""); setCandidatePasswords({}); setError(""); }, [flow]);

  const create = async () => {
    if (activityRef.current !== "idle") return;
    if (protect && (!password || password !== confirm)) {
      setError(t("Пароли не совпадают"));
      return;
    }
    if (!beginActivity("creating")) return;
    setError("");
    try {
      const created = await invoke<CreatedProfileResult>("create_profile", { name, password: protect ? password : null });
      await onProfiles(created.profiles, "create", created.initialConnectionPresetRequired);
    } catch (value) {
      setError(formatUserFacingError(value, { ru: "Не удалось создать профиль", en: "Could not create the profile" }, languageRef.current));
    } finally { setPassword(""); setConfirm(""); finishActivity(); }
  };

  const discover = async (location: string) => {
    if (!beginActivity("discovering")) return;
    setError(""); setCandidates([]); setCandidatePasswords({}); setSourceInspected(false);
    try {
      setCandidates(await invoke<QtoxCandidate[]>("discover_qtox_profiles", { location }));
      setSourceInspected(true);
    } catch (value) { setError(formatUserFacingError(value, { ru: "Не удалось найти профили qTox", en: "Could not find qTox profiles" }, languageRef.current)); }
    finally { finishActivity(); }
  };

  const browseFile = async () => {
    if (!beginActivity("choosing")) return;
    const picker = !platformCapabilities.nativeFilesystem ? new AbortController() : null;
    pickerAbort.current = picker;
    try {
      const selected = await openDialog({
        multiple: false,
        title: languageRef.current === "ru" ? "Выберите контейнер .kai или ZIP qTox" : "Choose a .kai container or qTox ZIP",
        filters: [{ name: "Kaigen / qTox", extensions: ["kai", "zip"] }],
      }, picker?.signal);
      if (typeof selected === "string") { activityRef.current = "idle"; await discover(selected); }
    } catch (value) { setError(formatUserFacingError(value, { ru: "Не удалось открыть файл импорта", en: "Could not open the import file" }, languageRef.current)); }
    finally {
      if (pickerAbort.current === picker) pickerAbort.current = null;
      if (activityRef.current === "choosing") finishActivity();
    }
  };

  const browseFolder = async () => {
    if (!beginActivity("choosing")) return;
    const picker = !platformCapabilities.nativeFilesystem ? new AbortController() : null;
    pickerAbort.current = picker;
    try {
      const selected = await openDialog({ directory: true, multiple: false, title: t("Выберите папку qTox или portable qTox") }, picker?.signal);
      if (typeof selected === "string") { activityRef.current = "idle"; await discover(selected); }
    } catch (value) { setError(formatUserFacingError(value, { ru: "Не удалось открыть папку qTox", en: "Could not open the qTox folder" }, languageRef.current)); }
    finally {
      if (pickerAbort.current === picker) pickerAbort.current = null;
      if (activityRef.current === "choosing") finishActivity();
    }
  };

  const importProfile = async (candidate: QtoxCandidate) => {
    const passwordMode = qtoxCandidatePasswordMode(candidate);
    if (!beginActivity("importing")) return;
    setError("");
    try {
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      await onProfiles(await invoke<ProfileSummary[]>("import_qtox_profile", {
        profilePath: candidate.profilePath,
        historyPath: candidate.historyPath || null,
        password: passwordMode === "none" ? null : candidatePasswords[candidate.profilePath] || null,
      }), "import");
    } catch (value) {
      setError(formatUserFacingError(value, { ru: "Не удалось импортировать профиль qTox", en: "Could not import the qTox profile" }, languageRef.current));
    } finally {
      setCandidatePasswords((current) => { const next = { ...current }; delete next[candidate.profilePath]; return next; });
      finishActivity();
    }
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
      <button className="startup-back" type="button" disabled={busy} onClick={() => setFlow("choice")}>‹ {t("Назад")}</button>
      <h2>{t("Новый профиль")}</h2>
      <label>{t("Имя профиля")}<input value={name} maxLength={64} onChange={(event) => setName(event.target.value)} autoFocus /></label>
      <label className="startup-check"><input type="checkbox" checked={protect} onChange={(event) => setProtect(event.target.checked)} /><span>{t("Защитить профиль паролем")}</span></label>
      {protect && <div className="startup-passwords"><label>{t("Пароль")}<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" /></label><label>{t("Повторите пароль")}<input type="password" value={confirm} onChange={(event) => setConfirm(event.target.value)} autoComplete="new-password" /></label><small>{t("Без этого пароля восстановить профиль будет невозможно.")}</small></div>}
      {error && <p className="startup-error">{error}</p>}
      <button className="startup-primary" disabled={busy || !name.trim() || (protect && !password)}>{activity === "creating" ? t("Создание…") : t("Создать профиль")}</button>
    </form>}
    {flow === "import" && <div className={`startup-form import-flow ${busy ? "busy" : ""}`} aria-busy={busy}>
      <button className="startup-back" type="button" disabled={busy} onClick={() => setFlow("choice")}>‹ {t("Назад")}</button>
      <h2>{language === "ru" ? "Импорт .kai или qTox" : "Import .kai or qTox"}</h2>
      <p>{language === "ru" ? "Выберите папку qTox либо готовый ZIP qTox или контейнер .kai. Kaigen скопирует импортированные данные в собственный .kai." : "Choose a qTox folder, a ready qTox ZIP, or a .kai container. Kaigen copies imported data into its own .kai."}</p>
      <div className="folder-row"><button type="button" disabled={busy} onClick={() => void browseFolder()}>{language === "ru" ? "Выбрать папку qTox" : "Choose qTox folder"}</button><button type="button" disabled={busy} onClick={() => void browseFile()}>{language === "ru" ? "Выбрать ZIP или .kai" : "Choose ZIP or .kai"}</button></div>
      {activity === "choosing" && !platformCapabilities.nativeFilesystem && <div className="import-progress" role="status"><span>{language === "ru" ? "Выберите файл в диалоге. Если он уже закрыт, отмените ожидание и повторите выбор." : "Choose a file in the dialog. If it has closed, cancel waiting and choose again."}</span><button type="button" onClick={() => pickerAbort.current?.abort()}>{language === "ru" ? "Отменить ожидание" : "Cancel waiting"}</button></div>}
      {(activity === "discovering" || activity === "importing") && <div className="import-progress" role="status" aria-live="polite"><progress /><span>{activity === "discovering" ? t("Поиск профилей qTox. Пожалуйста, подождите…") : t("Импорт профиля, аватаров и истории. Пожалуйста, подождите…")}</span></div>}
      <div className="qtox-candidates">{candidates.map((candidate) => {
        const passwordMode = qtoxCandidatePasswordMode(candidate);
        const enteredPassword = candidatePasswords[candidate.profilePath] ?? "";
        const sourceName = (candidate.sourceLabel ?? candidate.profilePath).toLocaleLowerCase("en-US");
        const sourceStatus = sourceName.endsWith(".kai")
          ? (language === "ru" ? "Контейнер .kai выбран" : ".kai container selected")
          : sourceName.endsWith(".zip")
            ? (language === "ru" ? "ZIP qTox выбран" : "qTox ZIP selected")
            : candidate.historyPath ? t("История найдена") : t("История не найдена");
        return <article key={candidate.profilePath} data-kaigen-ui-entity-key={opaqueUiEntityKey("qtox-candidate", candidate.profilePath)}>
          <div><b data-i18n-ignore translate="no">{candidate.name}</b><small data-i18n-ignore translate="no">{candidate.sourceLabel ?? candidate.profilePath}</small><span>{sourceStatus}{candidate.encrypted ? ` · ${t("защищён паролем")}` : ""}</span></div>
          {passwordMode !== "none" && <label>{passwordMode === "optional" ? (language === "ru" ? "Пароль источника (если установлен)" : "Source password (if set)") : t("Пароль")}<input type="password" value={enteredPassword} onChange={(event) => setCandidatePasswords((current) => ({ ...current, [candidate.profilePath]: event.target.value }))} onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing && !busy && (passwordMode !== "required" || enteredPassword)) { event.preventDefault(); void importProfile(candidate); } }} /></label>}
          <button className="startup-primary" type="button" disabled={busy || (passwordMode === "required" && !enteredPassword)} onClick={() => void importProfile(candidate)}>{t("Импортировать")}</button>
        </article>;
      })}</div>
      {!busy && !sourceInspected && <p className="startup-note">{language === "ru" ? "Kaigen откроет только выбранную вами папку или файл." : "Kaigen opens only the folder or file you select."}</p>}
      {!busy && sourceInspected && candidates.length === 0 && <p className="startup-note">{language === "ru" ? "В выбранном источнике нет пригодных профилей qTox." : "The selected source contains no usable qTox profiles."}</p>}
      {error && <p className="startup-error">{error}</p>}
    </div>}
    <footer><span className="welcome-shield"><PrivacyShieldIcon /></span><p>{t("Все данные хранятся рядом с программой. Сетевой маршрут может быть защищён встроенным Tor, а сообщения — дополнительным постквантовым слоем.")}</p></footer>
  </section>;
}

function UnlockProfiles({ profiles, onProfiles, onConnected, onDisableProfile, onAddProfile, onContinue }: { profiles: ProfileSummary[]; onProfiles: (profiles: ProfileSummary[]) => void; onConnected: (profiles: ProfileSummary[], profileId: string) => void; onDisableProfile: (profileId: string) => Promise<void>; onAddProfile: () => void; onContinue: () => void }) {
  const { language, t } = useI18n();
  const [passwords, setPasswords] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, LocalizedError | undefined>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const pendingProfiles = useRef(new Map<string, ProfileSummary>());
  const [disabling, setDisabling] = useState<Record<string, boolean>>({});
  const [avatarBusy, setAvatarBusy] = useState<Record<string, boolean>>({});
  const [, setAvatarRequestRevision] = useState(0);
  const avatarRequests = useRef(new Map<string, { fileName: string }>());
  const avatarMounted = useRef(false);
  const avatarProfiles = useRef(profiles);
  avatarProfiles.current = profiles;
  useLayoutEffect(() => {
    avatarMounted.current = true;
    return () => { avatarMounted.current = false; avatarRequests.current.clear(); pendingProfiles.current.clear(); };
  }, []);
  useLayoutEffect(() => observeProfileAvatarRequests(() => setAvatarRequestRevision(value => value + 1)), []);
  useLayoutEffect(() => {
    const invalidated: string[] = [];
    for (const [owner, request] of avatarRequests.current) {
      if (!profiles.some((profile) => profile.id === owner && profile.loaded && profile.fileName === request.fileName)) {
        avatarRequests.current.delete(owner); invalidated.push(owner);
      }
    }
    if (invalidated.length) setAvatarBusy((value) => {
      const next = { ...value }; for (const owner of invalidated) delete next[owner]; return next;
    });
  }, [profiles]);
  const profileActionIsCurrent = (profile: ProfileSummary) => avatarMounted.current
    && pendingProfiles.current.get(profile.id) === profile
    && avatarProfiles.current.some((current) => current.id === profile.id && current.fileName === profile.fileName);
  const profileActionError = (error: unknown, fallback: LocalizedError): LocalizedError => ({
    ru: formatUserFacingError(error, fallback, "ru", false),
    en: formatUserFacingError(error, fallback, "en", false),
  });
  const unlock = async (profile: ProfileSummary) => {
    const password = passwords[profile.id] ?? "";
    if (profile.loaded || profile.error === "PROFILE_FINALIZATION_REQUIRED"
      || pendingProfiles.current.has(profile.id) || (profile.encrypted && !password)) return;
    pendingProfiles.current.set(profile.id, profile);
    setBusy((value) => ({ ...value, [profile.id]: true }));
    setErrors((value) => ({ ...value, [profile.id]: undefined }));
    try {
      const nextProfiles = await invoke<ProfileSummary[]>("unlock_profile", { profileId: profile.id, password });
      if (profileActionIsCurrent(profile)) onConnected(nextProfiles, profile.id);
    } catch (error) {
      if (profileActionIsCurrent(profile)) setErrors((value) => ({ ...value, [profile.id]: profileActionError(error, {
        ru: "Не удалось открыть профиль. Проверьте доступность сохранённых данных и повторите попытку.",
        en: "The profile could not be opened. Check that its saved data is available and try again.",
      }) }));
    } finally {
      if (profileActionIsCurrent(profile)) {
        setPasswords((value) => { const next = { ...value }; delete next[profile.id]; return next; });
        setBusy((value) => ({ ...value, [profile.id]: false }));
      }
      if (pendingProfiles.current.get(profile.id) === profile) pendingProfiles.current.delete(profile.id);
    }
  };
  const disable = async (profile: ProfileSummary) => {
    if (pendingProfiles.current.has(profile.id)) return;
    pendingProfiles.current.set(profile.id, profile);
    setDisabling((value) => ({ ...value, [profile.id]: true }));
    setErrors((value) => ({ ...value, [profile.id]: undefined }));
    try {
      await onDisableProfile(profile.id);
    } catch (error) {
      if (profileActionIsCurrent(profile)) setErrors((value) => ({ ...value, [profile.id]: profileActionError(error, {
        ru: "Не удалось сохранить и отключить профиль. Повторите попытку.",
        en: "The profile could not be saved and disconnected. Try again.",
      }) }));
    } finally {
      if (profileActionIsCurrent(profile)) setDisabling((value) => ({ ...value, [profile.id]: false }));
      if (pendingProfiles.current.get(profile.id) === profile) pendingProfiles.current.delete(profile.id);
    }
  };
  const updateAvatar = async (profile: ProfileSummary, file: File | undefined) => {
    if (!file || !avatarMounted.current || avatarRequests.current.has(profile.id) || isProfileAvatarPending(profile.id)
      || !avatarProfiles.current.some((current) => current.id === profile.id && current.loaded && current.fileName === profile.fileName)) return;
    const request = { fileName: profile.fileName };
    let backendToken: symbol | null = null;
    avatarRequests.current.set(profile.id, request);
    const isCurrent = () => avatarMounted.current && avatarRequests.current.get(profile.id) === request
      && avatarProfiles.current.some((current) => current.id === profile.id && current.loaded && current.fileName === request.fileName);
    setAvatarBusy((value) => ({ ...value, [profile.id]: true }));
    setErrors((value) => ({ ...value, [profile.id]: undefined }));
    try {
      const sourceDataUrl = await readAvatarDataUrl(file);
      if (!isCurrent()) return;
      const avatar = await normalizeProfileAvatar(sourceDataUrl);
      if (!isCurrent()) return;
      backendToken = reserveProfileAvatar(profile.id);
      if (!backendToken) return;
      const returned = await invoke<ProfileSummary[]>("set_profile_avatar", {
        profileId: profile.id,
        dataUrl: avatar.dataUrl,
        filename: "avatar.png",
        bytes: avatar.bytes,
      });
      if (!isCurrent()) return;
      const updated = returned.find((current) => current.id === profile.id && current.loaded && current.fileName === request.fileName);
      if (!updated) throw new Error("PROFILE_NOT_LOADED");
      // An avatar response owns one field on one profile. Its full snapshot
      // can predate another upload, a profile switch or a removed neighbour.
      const next = avatarProfiles.current.map((current) => current.id === profile.id ? { ...current, avatar: updated.avatar } : current);
      avatarProfiles.current = next;
      onProfiles(next);
    } catch (error) {
      if (!isCurrent()) return;
      setErrors((value) => ({ ...value, [profile.id]: {
        ru: formatUserFacingError(error, { ru: "Не удалось установить аватар", en: "Could not set the avatar" }, "ru"),
        en: formatUserFacingError(error, { ru: "Не удалось установить аватар", en: "Could not set the avatar" }, "en"),
      } }));
    } finally {
      if (backendToken) {
        releaseProfileAvatar(profile.id, backendToken);
        // The backend can commit after this row or view disappears. Refresh the
        // current view from the owner instead of forwarding the old snapshot.
        window.dispatchEvent(new Event("profiles-changed"));
      }
      if (avatarRequests.current.get(profile.id) === request) {
        avatarRequests.current.delete(profile.id);
        if (avatarMounted.current) setAvatarBusy((value) => ({ ...value, [profile.id]: false }));
      }
    }
  };
  return <section className="unlock-screen"><LanguageChoice /><Brand /><header><h1>{t("Подключение профилей")}</h1><p>{t("Введите пароли только для тех профилей, которые хотите подключить сейчас.")}</p></header><div className="unlock-list">{profiles.map((profile) => <article className={profile.loaded ? "unlocked" : ""} data-kaigen-ui-entity-key={opaqueUiEntityKey("profile", profile.id)} key={profile.id}>
    <div className="unlock-profile-heading">
      <label className={`unlock-profile-avatar-picker ${profile.loaded ? "enabled" : "disabled"}`} title={profile.loaded ? t("Выбрать аватар") : undefined}>
        <ProfileAvatar src={profile.avatar} initial={profile.name.trim().charAt(0).toLocaleUpperCase() || "T"} className="unlock-profile-avatar" alt={profile.name} />
        {profile.loaded && <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" disabled={avatarBusy[profile.id] || isProfileAvatarPending(profile.id)} onChange={(event) => { void updateAvatar(profile, event.target.files?.[0]); event.currentTarget.value = ""; }} />}
      </label>
      <span className="unlock-profile-copy"><span className="unlock-profile-title"><b data-i18n-ignore translate="no">{profile.name}</b>{profile.loaded && <span className="unlock-profile-success" role="status"><i aria-hidden="true">✓</i>{t("разблокировано")}</span>}</span><small data-i18n-ignore translate="no">{profile.fileName}</small></span>
      <button type="button" className="unlock-profile-disable" data-i18n-ignore translate="no" aria-label={`${t("Отключить профиль")}: ${profile.name}`} title={t("Отключить профиль")} disabled={disabling[profile.id] || busy[profile.id]} onClick={() => void disable(profile)}><span aria-hidden="true">×</span></button>
    </div>
    {!profile.loaded && profile.error !== "PROFILE_FINALIZATION_REQUIRED" && <>{profile.encrypted && <input type="password" data-i18n-ignore translate="no" aria-label={`${t("Пароль профиля")}: ${profile.name}`} placeholder={t("Пароль профиля")} value={passwords[profile.id] ?? ""} onChange={(event) => setPasswords((value) => ({ ...value, [profile.id]: event.target.value }))} onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); void unlock(profile); } }} />}<button disabled={busy[profile.id] || (profile.encrypted && !passwords[profile.id])} onClick={() => void unlock(profile)}>{busy[profile.id] ? "…" : t("Подключить")}</button></>}
    {profile.error === "PROFILE_FINALIZATION_REQUIRED" && <button type="button" disabled={disabling[profile.id] || busy[profile.id]} onClick={() => void disable(profile)}>{disabling[profile.id] ? "…" : language === "ru" ? "Повторить сохранение и отключение" : "Retry saving and disconnecting"}</button>}
    {(errors[profile.id] || profile.error) && <em role="alert">{errors[profile.id]?.[language] ?? formatUserFacingError(profile.error, { ru: "Профиль недоступен. Повторите действие.", en: "The profile is unavailable. Try again." }, language, false)}</em>}
  </article>)}</div><div className="unlock-actions"><button className="startup-primary" onClick={onContinue}>{profiles.some((profile) => profile.loaded) ? t("Продолжить с открытыми профилями") : t("Пропустить и вернуться")}</button><button className="unlock-add-profile" type="button" onClick={onAddProfile}><span aria-hidden="true" />{t("Добавить ещё один профиль")}</button></div></section>;
}

export default function RootApp({ onLanguageChange, registerBeforeWorkspaceLock }: { onLanguageChange?: (language: Language) => void; registerBeforeWorkspaceLock?: (handler: () => Promise<void>) => () => void } = {}) {
  const { ready: themeReady } = useKaigenTheme();
  const [language, setLanguageState] = useState<Language>("ru");
  const [startup, setStartup] = useState<StartupState | null>(null);
  const startupRef = useRef(startup);
  startupRef.current = startup;
  const [splashDone, setSplashDone] = useState(false);
  const [brandReady, setBrandReady] = useState(false);
  const [skipLocks, setSkipLocks] = useState(false);
  const [unlockFlowOpen, setUnlockFlowOpen] = useState(false);
  const [showWelcome, setShowWelcome] = useState(false);
  const [messengerKey, setMessengerKey] = useState(0);
  const [profileSwitching, setProfileSwitching] = useState(false);
  const [initialPresetBusy, setInitialPresetBusy] = useState<InitialConnectionPreset | null>(null);
  const [initialPresetError, setInitialPresetError] = useState("");
  const [statusAttention, setStatusAttention] = useState(false);
  const statusAttentionShown = useRef(false);
  const completeStatusAttention = useCallback(() => setStatusAttention(false), []);
  const profileSwitchingRef = useRef(false);
  const startupRefreshRevision = useRef(0);
  const rootAliveRef = useRef(true);
  useEffect(() => {
    rootAliveRef.current = true;
    return () => { rootAliveRef.current = false; startupRefreshRevision.current += 1; };
  }, []);
  const initialStartupRouteResolved = useRef(false);
  const [fatal, setFatal] = useState("");
  useEffect(installDesktopNotifications, []);

  useEffect(() => {
    let active = true;
    void prepareBrandImage().then(() => { if (active) setBrandReady(true); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const heartbeat = () => {
      if (document.visibilityState !== "visible") return;
      void invoke("report_webview_heartbeat").catch(() => {});
    };
    heartbeat();
    const timer = window.setInterval(heartbeat, 15_000);
    document.addEventListener("visibilitychange", heartbeat);
    window.addEventListener("focus", heartbeat);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", heartbeat);
      window.removeEventListener("focus", heartbeat);
    };
  }, []);

  const refresh = useCallback(async () => {
    if (profileSwitchingRef.current) return false;
    const revision = ++startupRefreshRevision.current;
    const value = await invoke<StartupState>("get_startup_state");
    if (!rootAliveRef.current || revision !== startupRefreshRevision.current || profileSwitchingRef.current) return false;
    if (!initialStartupRouteResolved.current) {
      initialStartupRouteResolved.current = true;
      const hasLockedPasswordProfile = value.profiles.some((profile) => !profile.loaded && (profile.encrypted || profile.error === "PROFILE_FINALIZATION_REQUIRED"));
      // On subsequent application launches the connection screen is useful only
      // when at least one enabled password-protected profile actually needs to be
      // unlocked. Explicitly pin the direct route for passwordless profiles so a
      // background profiles-changed refresh cannot reopen the startup flow.
      setSkipLocks(!hasLockedPasswordProfile);
      setUnlockFlowOpen(hasLockedPasswordProfile);
    }
    setStartup((current) => JSON.stringify(current) === JSON.stringify(value) ? current : value);
    setLanguageState((current) => current === value.language ? current : value.language);
    return true;
  }, []);
  useEffect(() => {
    const started = performance.now();
    void refresh()
      .catch((error) => setFatal(String(error)))
      .finally(() => {
        const elapsed = performance.now() - started;
        const minimumVisible = elapsed < 1500 ? 2000 : elapsed;
        window.setTimeout(() => setSplashDone(true), Math.max(0, minimumVisible - elapsed));
      });
  }, [refresh]);
  useEffect(() => {
    const handler = () => void refresh().catch(() => {});
    const activeHandler = () => void refresh().then((applied) => { if (applied) setMessengerKey((value) => value + 1); }).catch(() => {});
    const stopBackendListener = listen<string>("profiles-changed", handler);
    window.addEventListener("profiles-changed", handler);
    window.addEventListener("active-profile-changed", activeHandler);
    return () => {
      window.removeEventListener("profiles-changed", handler);
      window.removeEventListener("active-profile-changed", activeHandler);
      void stopBackendListener.then((unlisten) => unlisten());
    };
  }, [refresh]);

  useEffect(() => {
    if (!platformCapabilities.browserAuthorization) return;
    let pending = false;
    let disposed = false;
    const refreshBackgroundProfiles = () => {
      if (disposed || pending || document.visibilityState !== "visible" || profileSwitchingRef.current
        || !startupRef.current?.profiles.some((profile) => profile.loaded && !profile.active)) return;
      pending = true;
      // Web heartbeat events do not carry changes from inactive profiles.
      // Refresh summaries without remounting the messenger or opening a chat.
      void refresh().catch(() => {}).finally(() => { pending = false; });
    };
    const timer = window.setInterval(refreshBackgroundProfiles, 3_000);
    document.addEventListener("visibilitychange", refreshBackgroundProfiles);
    window.addEventListener("focus", refreshBackgroundProfiles);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshBackgroundProfiles);
      window.removeEventListener("focus", refreshBackgroundProfiles);
    };
  }, [refresh]);

  const changeLanguage = useCallback((next: Language) => {
    setLanguageState(next);
    void invoke("set_app_language", { language: next });
  }, []);
  useEffect(() => {
    if (startup) onLanguageChange?.(language);
  }, [language, onLanguageChange, startup]);
  const storeProfiles = (profiles: ProfileSummary[], initialConnectionPresetRequired?: boolean) => {
    startupRefreshRevision.current += 1;
    const uniqueProfiles = Array.from(new Map(profiles.map((profile) => [profile.id, profile])).values());
    setStartup((current) => current ? {
      ...current,
      firstRun: uniqueProfiles.length === 0,
      profiles: uniqueProfiles,
      ...(initialConnectionPresetRequired === undefined ? {} : { initialConnectionPresetRequired }),
    } : current);
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
  const acceptUnlockedProfiles = (profiles: ProfileSummary[], profileId: string) => {
    if (!rootAliveRef.current || !startupRef.current?.profiles.some((profile) => profile.id === profileId)
      || !profiles.some((profile) => profile.id === profileId && profile.loaded)) return;
    startupRefreshRevision.current += 1;
    setStartup((current) => {
      if (!current || !current.profiles.some((profile) => profile.id === profileId)) return current;
      const received = new Map(profiles.map((profile) => [profile.id, profile]));
      const merged = current.profiles.map((profile) => {
        const next = received.get(profile.id);
        // Unlock only adds loaded profiles. An earlier response cannot relock
        // a completed neighbour or replace its later metadata/settings.
        return next && (!profile.loaded || profile.id === profileId) ? next : profile;
      });
      const activeId = current.profiles.find((profile) => profile.loaded && profile.active)?.id
        ?? merged.find((profile) => profile.loaded && profile.active)?.id
        ?? merged.find((profile) => profile.loaded)?.id;
      return { ...current, profiles: merged.map((profile) => ({ ...profile, active: profile.id === activeId })) };
    });
    setMessengerKey((value) => value + 1);
    setSkipLocks(true); setUnlockFlowOpen(false); setShowWelcome(false);
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
  const reviewCreatedOrImportedProfiles = (profiles: ProfileSummary[], source: "create" | "import", initialConnectionPresetRequired?: boolean) => {
    if (source === "create") setInitialPresetError("");
    // The backend owns the durable one-shot flag. Do not infer it from an empty
    // profile list: after the user has chosen a preset, deleting every profile
    // and creating another one must never reopen the chooser.
    // Creation returns the committed flag and profiles atomically, so there is
    // no intermediate Messenger route and no fallible post-commit readback that
    // could invite the user to create the same profile twice.
    storeProfiles(profiles, source === "create" ? initialConnectionPresetRequired : undefined);
    if (profiles.some((profile) => profile.loaded && profile.active)) {
      setSkipLocks(true);
      setUnlockFlowOpen(false);
      setShowWelcome(false);
    } else {
      setSkipLocks(false);
      setShowWelcome(false);
      setUnlockFlowOpen(true);
    }
  };
  const addAnotherProfile = useCallback(() => {
    setSkipLocks(false);
    setUnlockFlowOpen(true);
    setShowWelcome(true);
  }, []);
  useEffect(() => {
    window.addEventListener("kaigen:add-profile-request", addAnotherProfile);
    return () => window.removeEventListener("kaigen:add-profile-request", addAnotherProfile);
  }, [addAnotherProfile]);
  const returnToProfileConnection = () => {
    setSkipLocks(false);
    setUnlockFlowOpen(true);
    setShowWelcome(false);
  };
  const switchProfile = async (id: string) => {
    if (profileSwitchingRef.current) return;
    const target = startupRef.current?.profiles.find((profile) => profile.id === id);
    if (target && !target.loaded) { setSkipLocks(false); setUnlockFlowOpen(true); return; }
    profileSwitchingRef.current = true;
    startupRefreshRevision.current += 1;
    setProfileSwitching(true);
    try { updateMainWindowProfiles(await invoke<ProfileSummary[]>("switch_profile", { profileId: id })); }
    catch (error) { setFatal(String(error)); }
    finally {
      profileSwitchingRef.current = false;
      setProfileSwitching(false);
    }
  };
  const changeProfileStatus = useCallback(async (profileId: string, status: ProfileSummary["userStatus"]) => {
    await invoke("set_profile_user_status", { profileId, status });
    await refresh();
  }, [refresh]);
  const applyInitialConnectionPreset = useCallback(async (preset: InitialConnectionPreset) => {
    if (initialPresetBusy) return;
    setInitialPresetBusy(preset);
    setInitialPresetError("");
    try {
      await invoke("apply_initial_connection_preset", { preset });
      setStartup((current) => current ? { ...current, initialConnectionPresetRequired: false } : current);
      void refresh().catch(() => {});
    } catch (error) {
      setInitialPresetError(formatUserFacingError(error, {
        ru: "Не удалось применить режим подключения",
        en: "Could not apply the connection mode",
      }, language));
    } finally {
      setInitialPresetBusy(null);
    }
  }, [initialPresetBusy, language, refresh]);
  const runProfileRemoval = async (command: "disable_profile" | "destroy_active_profile", profileId?: string) => {
    if (profileSwitchingRef.current) throw new Error("PROFILE_ACTION_BUSY");
    const capturedProfileId = command === "destroy_active_profile"
      ? startup?.profiles.find((profile) => profile.active)?.id
      : profileId;
    if (!capturedProfileId) throw new Error("NO_ACTIVE_PROFILE");
    profileSwitchingRef.current = true;
    startupRefreshRevision.current += 1;
    setProfileSwitching(true);
    try {
      const profiles = await invoke<ProfileSummary[]>(command, { profileId: capturedProfileId });
      if (rootAliveRef.current) routeAfterProfileRemoval(profiles);
    } catch (error) {
      // A rejected response can follow a committed removal whose retained-file
      // cleanup is still pending. Refresh before enabling another action so
      // the old profile UI cannot target its newly selected neighbour.
      try {
        const actual = await invoke<StartupState>("get_startup_state");
        if (rootAliveRef.current) {
          if (actual.profiles.some((profile) => profile.id === capturedProfileId && profile.error === "PROFILE_FINALIZATION_REQUIRED")) {
            // Preserve the mounted neighbour's messenger while exposing this
            // profile's retained-save retry in the existing connection view.
            startupRefreshRevision.current += 1;
            setStartup((current) => current ? { ...current, profiles: actual.profiles } : current);
            returnToProfileConnection();
          } else {
            routeAfterProfileRemoval(actual.profiles);
          }
        }
      } catch {
        // Keep the original action failure when authentication also changed.
      }
      throw error;
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
  const hasFinalizationError = startup?.profiles.some((profile) => profile.error === "PROFILE_FINALIZATION_REQUIRED") ?? false;
  useEffect(() => {
    if (lockedRemain && !skipLocks) setUnlockFlowOpen(true);
  }, [lockedRemain, skipLocks]);
  useEffect(() => {
    const active = startup?.profiles.find((profile) => profile.active);
    const title = active?.loaded ? `${active.name} — Kaigen` : "Kaigen";
    document.title = title;
    void getCurrentWindow().setTitle(title).catch(() => {});
  }, [startup]);

  const startupReady = brandReady && canLeaveStartupSplash(themeReady, splashDone, startup);
  const startupFocusReported = useRef(false);
  useEffect(() => {
    if (!startupReady || startupFocusReported.current) return;
    startupFocusReported.current = true;
    // Native WebView focus must be refreshed after the startup route is committed,
    // not while the controller is still displaying the splash screen.
    void invoke("report_webview_heartbeat", { startupReady: true }).catch(() => {});
  }, [startupReady]);
  const initialConnectionPresetRequired = Boolean(
    startupReady
    && !fatal
    && startup
    && startup.profiles.length > 0
    && startup.initialConnectionPresetRequired,
  );
  const messengerVisible = Boolean(
    startupReady && startup && !fatal && !startup.firstRun && loaded
    && skipLocks && !showWelcome && !initialConnectionPresetRequired,
  );
  useEffect(() => {
    if (!messengerVisible || statusAttentionShown.current) return;
    const drawAttention = () => {
      if (document.visibilityState !== "visible" || statusAttentionShown.current) return;
      statusAttentionShown.current = true;
      setStatusAttention(true);
    };
    drawAttention();
    document.addEventListener("visibilitychange", drawAttention);
    return () => document.removeEventListener("visibilitychange", drawAttention);
  }, [messengerVisible]);
  const messengerWasVisible = useRef(false);
  if (loaded && skipLocks && !showWelcome) messengerWasVisible.current = true;
  const route = !startupReady || !startup
    ? <Splash />
    : fatal
      ? <section className="startup-fatal"><Brand /><h2>Kaigen</h2><p>{formatUserFacingError(fatal, { ru: "Не удалось запустить Kaigen", en: "Could not start Kaigen" }, language)}</p><button onClick={() => { setFatal(""); void refresh(); }}>Retry</button></section>
      : startup.firstRun || showWelcome
        ? <Welcome onProfiles={reviewCreatedOrImportedProfiles} onBackToProfiles={startup.profiles.length > 0 ? returnToProfileConnection : undefined} />
        : !skipLocks && (lockedRemain || unlockFlowOpen) && (!messengerWasVisible.current || hasFinalizationError && !loaded)
          ? <UnlockProfiles profiles={startup.profiles} onProfiles={onProfiles} onConnected={acceptUnlockedProfiles} onDisableProfile={(id) => runProfileRemoval("disable_profile", id)} onAddProfile={addAnotherProfile} onContinue={() => void continueUnlocked()} />
          : loaded
            ? <>
              <div className="messenger-root" inert={!skipLocks && unlockFlowOpen || undefined}><MessengerApp registerBeforeWorkspaceLock={registerBeforeWorkspaceLock} statusAttention={statusAttention} onStatusAttentionComplete={completeStatusAttention} key={messengerKey} profiles={startup.profiles} profileSwitching={profileSwitching} onSwitchProfile={switchProfile} onDisableProfile={(id) => runProfileRemoval("disable_profile", id)} onDestroyActiveProfile={() => runProfileRemoval("destroy_active_profile")} onProfileStatusChange={changeProfileStatus} /></div>
              {!skipLocks && unlockFlowOpen && <CompactModal className="startup-profiles-overlay" label={language === "ru" ? "Подключение профилей" : "Connect profiles"} onClose={() => void continueUnlocked()}><UnlockProfiles profiles={startup.profiles} onProfiles={onProfiles} onConnected={acceptUnlockedProfiles} onDisableProfile={(id) => runProfileRemoval("disable_profile", id)} onAddProfile={addAnotherProfile} onContinue={() => void continueUnlocked()} /></CompactModal>}
            </>
            : <Welcome onProfiles={reviewCreatedOrImportedProfiles} onBackToProfiles={startup.profiles.length > 0 ? returnToProfileConnection : undefined} />;

  return <I18nProvider language={language} setLanguage={changeLanguage}><GlobalLanguageBridge /><TextEditContextMenu />
    <div className="startup-route-layer" inert={initialConnectionPresetRequired || undefined} aria-hidden={initialConnectionPresetRequired || undefined}>
      {brandReady ? route : <section className="splash-screen" aria-hidden="true" />}
    </div>
    {initialConnectionPresetRequired && <InitialConnectionPresetDialog busy={initialPresetBusy} error={initialPresetError} onSelect={(preset) => void applyInitialConnectionPreset(preset)} />}
  </I18nProvider>;
}
