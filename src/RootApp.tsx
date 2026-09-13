import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow, invoke, listen, openDialog } from "@kaigen/platform";
import MessengerApp from "./App";
import ProfileAvatar from "./ProfileAvatar";
import TextEditContextMenu from "./TextEditContextMenu";
import { GlobalLanguageBridge, I18nProvider, useI18n, type Language } from "./i18n";
import { normalizeProfileAvatar, readAvatarDataUrl } from "./avatar";
import { formatUserFacingError } from "./localization";
import rootAppUiCatalog from "./RootApp.ui-ids.json" with { type: "json" };
import { opaqueUiEntityKey } from "./uiIdentity";
import { useKaigenTheme } from "@kaigen/theme";
import { canLeaveStartupSplash } from "./layoutPersistence";
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
  const [activity, setActivity] = useState<"idle" | "creating" | "discovering" | "importing">("idle");
  const [error, setError] = useState("");
  const busy = activity !== "idle";
  const languageRef = useRef(language);
  languageRef.current = language;
  useEffect(() => setError(""), [language]);

  const create = async () => {
    if (protect && (!password || password !== confirm)) {
      setError(t("Пароли не совпадают"));
      return;
    }
    setActivity("creating"); setError("");
    try {
      const created = await invoke<CreatedProfileResult>("create_profile", { name, password: protect ? password : null });
      await onProfiles(created.profiles, "create", created.initialConnectionPresetRequired);
    } catch (value) {
      setError(formatUserFacingError(value, { ru: "Не удалось создать профиль", en: "Could not create the profile" }, languageRef.current));
    } finally { setActivity("idle"); }
  };

  const discover = async (location: string) => {
    setActivity("discovering"); setError(""); setCandidates([]); setSourceInspected(false);
    try {
      setCandidates(await invoke<QtoxCandidate[]>("discover_qtox_profiles", { location }));
      setSourceInspected(true);
    } catch (value) { setError(formatUserFacingError(value, { ru: "Не удалось найти профили qTox", en: "Could not find qTox profiles" }, languageRef.current)); }
    finally { setActivity("idle"); }
  };

  const browseFile = async () => {
    try {
      const selected = await openDialog({
        multiple: false,
        title: languageRef.current === "ru" ? "Выберите контейнер .kai или ZIP qTox" : "Choose a .kai container or qTox ZIP",
        filters: [{ name: "Kaigen / qTox", extensions: ["kai", "zip"] }],
      });
      if (typeof selected === "string") await discover(selected);
    } catch (value) { setError(formatUserFacingError(value, { ru: "Не удалось открыть файл импорта", en: "Could not open the import file" }, languageRef.current)); }
  };

  const browseFolder = async () => {
    try {
      const selected = await openDialog({ directory: true, multiple: false, title: t("Выберите папку qTox или portable qTox") });
      if (typeof selected === "string") await discover(selected);
    } catch (value) { setError(formatUserFacingError(value, { ru: "Не удалось открыть папку qTox", en: "Could not open the qTox folder" }, languageRef.current)); }
  };

  const importProfile = async (candidate: QtoxCandidate) => {
    const passwordMode = qtoxCandidatePasswordMode(candidate);
    setActivity("importing"); setError("");
    try {
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      await onProfiles(await invoke<ProfileSummary[]>("import_qtox_profile", {
        profilePath: candidate.profilePath,
        historyPath: candidate.historyPath || null,
        password: passwordMode === "none" ? null : candidatePasswords[candidate.profilePath] || null,
      }), "import");
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
      <h2>{language === "ru" ? "Импорт .kai или qTox" : "Import .kai or qTox"}</h2>
      <p>{language === "ru" ? "Выберите папку qTox либо готовый ZIP qTox или контейнер .kai. Kaigen скопирует импортированные данные в собственный .kai." : "Choose a qTox folder, a ready qTox ZIP, or a .kai container. Kaigen copies imported data into its own .kai."}</p>
      <div className="folder-row"><button type="button" disabled={busy} onClick={() => void browseFolder()}>{language === "ru" ? "Выбрать папку qTox" : "Choose qTox folder"}</button><button type="button" disabled={busy} onClick={() => void browseFile()}>{language === "ru" ? "Выбрать ZIP или .kai" : "Choose ZIP or .kai"}</button></div>
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

function UnlockProfiles({ profiles, onProfiles, onConnected, onAddProfile, onContinue }: { profiles: ProfileSummary[]; onProfiles: (profiles: ProfileSummary[]) => void; onConnected: (profiles: ProfileSummary[]) => void; onAddProfile: () => void; onContinue: () => void }) {
  const { language, t } = useI18n();
  const [passwords, setPasswords] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, LocalizedError | undefined>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [disabling, setDisabling] = useState<Record<string, boolean>>({});
  const [avatarBusy, setAvatarBusy] = useState<Record<string, boolean>>({});
  const unlock = async (profile: ProfileSummary) => {
    const password = passwords[profile.id] ?? "";
    if (profile.loaded || busy[profile.id] || (profile.encrypted && !password)) return;
    setBusy((value) => ({ ...value, [profile.id]: true }));
    setErrors((value) => ({ ...value, [profile.id]: undefined }));
    try {
      const nextProfiles = await invoke<ProfileSummary[]>("unlock_profile", { profileId: profile.id, password });
      setPasswords((value) => {
        const next = { ...value };
        delete next[profile.id];
        return next;
      });
      onConnected(nextProfiles);
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
      const sourceDataUrl = await readAvatarDataUrl(file);
      const avatar = await normalizeProfileAvatar(sourceDataUrl);
      onProfiles(await invoke<ProfileSummary[]>("set_profile_avatar", {
        profileId: profile.id,
        dataUrl: avatar.dataUrl,
        filename: "avatar.png",
        bytes: avatar.bytes,
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
  return <section className="unlock-screen"><LanguageChoice /><Brand /><header><h1>{t("Подключение профилей")}</h1><p>{t("Введите пароли только для тех профилей, которые хотите подключить сейчас.")}</p></header><div className="unlock-list">{profiles.map((profile) => <article className={profile.loaded ? "unlocked" : ""} data-kaigen-ui-entity-key={opaqueUiEntityKey("profile", profile.id)} key={profile.id}>
    <div className="unlock-profile-heading">
      <label className={`unlock-profile-avatar-picker ${profile.loaded ? "enabled" : "disabled"}`} title={profile.loaded ? t("Выбрать аватар") : undefined}>
        <ProfileAvatar src={profile.avatar} initial={profile.name.trim().charAt(0).toLocaleUpperCase() || "T"} className="unlock-profile-avatar" alt={profile.name} />
        {profile.loaded && <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" disabled={avatarBusy[profile.id]} onChange={(event) => { void updateAvatar(profile, event.target.files?.[0]); event.currentTarget.value = ""; }} />}
      </label>
      <span className="unlock-profile-copy"><span className="unlock-profile-title"><b data-i18n-ignore translate="no">{profile.name}</b>{profile.loaded && <span className="unlock-profile-success" role="status"><i aria-hidden="true">✓</i>{t("разблокировано")}</span>}</span><small data-i18n-ignore translate="no">{profile.fileName}</small></span>
      <button type="button" className="unlock-profile-disable" data-i18n-ignore translate="no" aria-label={`${t("Отключить профиль")}: ${profile.name}`} title={t("Отключить профиль")} disabled={disabling[profile.id] || busy[profile.id]} onClick={() => void disable(profile)}><span aria-hidden="true">×</span></button>
    </div>
    {!profile.loaded && <>{profile.encrypted && <input type="password" data-i18n-ignore translate="no" aria-label={`${t("Пароль профиля")}: ${profile.name}`} placeholder={t("Пароль профиля")} value={passwords[profile.id] ?? ""} onChange={(event) => setPasswords((value) => ({ ...value, [profile.id]: event.target.value }))} onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); void unlock(profile); } }} />}<button disabled={busy[profile.id] || (profile.encrypted && !passwords[profile.id])} onClick={() => void unlock(profile)}>{busy[profile.id] ? "…" : t("Подключить")}</button></>}
    {errors[profile.id] && <em>{errors[profile.id]?.[language]}</em>}
  </article>)}</div><div className="unlock-actions"><button className="startup-primary" onClick={onContinue}>{profiles.some((profile) => profile.loaded) ? t("Продолжить с открытыми профилями") : t("Пропустить и вернуться")}</button><button className="unlock-add-profile" type="button" onClick={onAddProfile}><span aria-hidden="true" />{t("Добавить ещё один профиль")}</button></div></section>;
}

export default function RootApp() {
  const { ready: themeReady } = useKaigenTheme();
  const [language, setLanguageState] = useState<Language>("ru");
  const [startup, setStartup] = useState<StartupState | null>(null);
  const [splashDone, setSplashDone] = useState(false);
  const [skipLocks, setSkipLocks] = useState(false);
  const [unlockFlowOpen, setUnlockFlowOpen] = useState(false);
  const [showWelcome, setShowWelcome] = useState(false);
  const [messengerKey, setMessengerKey] = useState(0);
  const [profileSwitching, setProfileSwitching] = useState(false);
  const [initialPresetBusy, setInitialPresetBusy] = useState<InitialConnectionPreset | null>(null);
  const [initialPresetError, setInitialPresetError] = useState("");
  const [statusAttention, setStatusAttention] = useState(false);
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

  const changeLanguage = useCallback((next: Language) => {
    setLanguageState(next);
    void invoke("set_app_language", { language: next });
  }, []);
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
      setStatusAttention(true);
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
      routeAfterProfileRemoval(profiles);
    } catch (error) {
      // A rejected response can follow a committed removal whose retained-file
      // cleanup is still pending. Refresh before enabling another action so
      // the old profile UI cannot target its newly selected neighbour.
      try {
        const actual = await invoke<StartupState>("get_startup_state");
        if (rootAliveRef.current) routeAfterProfileRemoval(actual.profiles);
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
  useEffect(() => {
    if (lockedRemain && !skipLocks) setUnlockFlowOpen(true);
  }, [lockedRemain, skipLocks]);
  useEffect(() => {
    const active = startup?.profiles.find((profile) => profile.active);
    const title = active?.loaded ? `${active.name} — Kaigen` : "Kaigen";
    document.title = title;
    void getCurrentWindow().setTitle(title).catch(() => {});
  }, [startup]);

  const startupReady = canLeaveStartupSplash(themeReady, splashDone, startup);
  const initialConnectionPresetRequired = Boolean(
    startupReady
    && !fatal
    && startup
    && startup.profiles.length > 0
    && startup.initialConnectionPresetRequired,
  );
  const route = !startupReady || !startup
    ? <Splash />
    : fatal
      ? <section className="startup-fatal"><Brand /><h2>Kaigen</h2><p>{formatUserFacingError(fatal, { ru: "Не удалось запустить Kaigen", en: "Could not start Kaigen" }, language)}</p><button onClick={() => { setFatal(""); void refresh(); }}>Retry</button></section>
      : startup.firstRun || showWelcome
        ? <Welcome onProfiles={reviewCreatedOrImportedProfiles} onBackToProfiles={startup.profiles.length > 0 ? returnToProfileConnection : undefined} />
        : !skipLocks && (lockedRemain || unlockFlowOpen)
          ? <UnlockProfiles profiles={startup.profiles} onProfiles={onProfiles} onConnected={updateMainWindowProfiles} onAddProfile={addAnotherProfile} onContinue={() => void continueUnlocked()} />
          : loaded
            ? <div className="messenger-root"><MessengerApp statusAttention={statusAttention} onStatusAttentionComplete={completeStatusAttention} key={messengerKey} profiles={startup.profiles} profileSwitching={profileSwitching} onSwitchProfile={switchProfile} onDisableProfile={(id) => runProfileRemoval("disable_profile", id)} onDestroyActiveProfile={() => runProfileRemoval("destroy_active_profile")} onProfileStatusChange={changeProfileStatus} /></div>
            : <Welcome onProfiles={reviewCreatedOrImportedProfiles} onBackToProfiles={startup.profiles.length > 0 ? returnToProfileConnection : undefined} />;

  return <I18nProvider language={language} setLanguage={changeLanguage}><GlobalLanguageBridge /><TextEditContextMenu />
    <div className="startup-route-layer" inert={initialConnectionPresetRequired || undefined} aria-hidden={initialConnectionPresetRequired || undefined}>
      {route}
    </div>
    {initialConnectionPresetRequired && <InitialConnectionPresetDialog busy={initialPresetBusy} error={initialPresetError} onSelect={(preset) => void applyInitialConnectionPreset(preset)} />}
  </I18nProvider>;
}
