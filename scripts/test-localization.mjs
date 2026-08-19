import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { importTypeScriptModule } from "./import-typescript-module.mjs";

const sourceUrl = new URL("../src/localization.ts", import.meta.url);
const i18nSource = await readFile(new URL("../src/i18n.tsx", import.meta.url), "utf8");
const appSource = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
const rootSource = await readFile(new URL("../src/RootApp.tsx", import.meta.url), "utf8");
const startupCssSource = await readFile(new URL("../src/Startup.css", import.meta.url), "utf8");
const settingsSource = await readFile(new URL("../src/Settings.tsx", import.meta.url), "utf8");
const localization = await importTypeScriptModule(sourceUrl);

let assertions = 0;
const equal = (actual, expected, message) => {
  assertions += 1;
  assert.equal(actual, expected, message);
};
const ok = (value, message) => {
  assertions += 1;
  assert.ok(value, message);
};

const profileSentinel = "Настройки/Контакт";
const contactSentinel = "Контакт/Настройки";
const messageSentinel = "Настройки/Контакт: сообщение";
const pathSentinel = "C:\\Настройки\\Контакт\\Файл.txt";

const profileEventEn = localization.formatProfileEventNotice(profileSentinel, 22, "en");
equal(profileEventEn.title, `${profileSentinel}: new event`, "profile-event title localizes only the system text");
equal(profileEventEn.body, "22 new messages or requests", "profile-event count is localized before native notification delivery");
equal(localization.formatProfileEventNotice(profileSentinel, 21, "ru").body, "21 новое сообщение или запрос", "profile-event Russian singular handles 21");

const requestNotice = localization.formatChatRequestNotice(profileSentinel, messageSentinel, "en");
equal(requestNotice.title, `${profileSentinel}: new chat request`, "chat-request title is localized before native notification delivery");
equal(requestNotice.body, messageSentinel, "chat-request body remains byte-for-byte user text");

const messageNotice = localization.formatChatMessageNotice(profileSentinel, contactSentinel, messageSentinel, "en");
equal(messageNotice.title, `${profileSentinel}: ${contactSentinel}`, "message notice preserves profile and contact names");
equal(messageNotice.body, messageSentinel, "message notice preserves remote message text");
equal(localization.formatChatMessageNotice(profileSentinel, "", messageSentinel, "en").title, `${profileSentinel}: new message`, "message notice localizes an empty contact fallback");
equal(localization.formatChatMessageNotice(profileSentinel, contactSentinel, "", "en").body, "Attachment", "message notice localizes an empty content fallback");
equal(localization.formatChatMessageNotice(profileSentinel, contactSentinel, pathSentinel, "en").body, pathSentinel, "message notice preserves file and path text");

const unreadCases = [
  [1, "1 новое непрочитанное сообщение", "1 new unread message"],
  [2, "2 новых непрочитанных сообщения", "2 new unread messages"],
  [5, "5 новых непрочитанных сообщений", "5 new unread messages"],
  [11, "11 новых непрочитанных сообщений", "11 new unread messages"],
  [21, "21 новое непрочитанное сообщение", "21 new unread messages"],
  [22, "22 новых непрочитанных сообщения", "22 new unread messages"],
  [25, "25 новых непрочитанных сообщений", "25 new unread messages"],
];
for (const [count, russian, english] of unreadCases) {
  equal(localization.formatUnreadMessagesLabel(count, "ru"), russian, `Russian unread plural is correct for ${count}`);
  equal(localization.formatUnreadMessagesLabel(count, "en"), english, `English unread plural is correct for ${count}`);
}

for (const [status, expected] of [
  ["online", "Online"],
  ["away", "Away"],
  ["busy", "Busy"],
  ["offline", "Offline"],
]) {
  equal(localization.formatProfileSwitcherTitle(profileSentinel, status, "en"), `${profileSentinel} · ${expected}`, `profile-switcher ${status} title preserves the name`);
}
equal(localization.formatProfileSwitcherAria(profileSentinel, "en"), `Switch to profile ${profileSentinel}`, "English profile-switcher aria preserves the name");
equal(localization.formatProfileSwitcherTitle(profileSentinel, "offline", "ru"), `${profileSentinel} · Отключён`, "Russian profile-switcher title preserves the name");
equal(localization.formatProfileSwitcherAria(profileSentinel, "ru"), `Переключиться на профиль ${profileSentinel}`, "Russian profile-switcher aria preserves the name");

const proxy = { mode: "socks5", host: profileSentinel, port: 9050 };
const proxyStatus = { state: "disabled", progress: 0 };
equal(localization.formatTorIndicator(proxyStatus, proxy, "en"), `SOCKS5 proxy ${profileSentinel}:9050; mandatory kill switch enabled`, "English custom-proxy indicator is fully localized");
equal(localization.formatTorIndicator(proxyStatus, proxy, "ru"), `SOCKS5-прокси ${profileSentinel}:9050; обязательный kill switch включён`, "Russian custom-proxy indicator preserves the host");
equal(localization.formatTorIndicator({ state: "connected", progress: 100, socksPort: 9150, controlPort: 9151 }, { ...proxy, mode: "none" }, "en"), "Tor connected: SOCKS 9150, Control 9151", "connected Tor indicator is English");
equal(localization.formatTorIndicator({ state: "connected", progress: 100, socksPort: 9150, controlPort: 9151 }, { ...proxy, mode: "none" }, "ru"), "Tor подключён: SOCKS 9150, Control 9151", "connected Tor indicator is Russian");
equal(localization.formatTorIndicator({ state: "error", progress: 0, message: "Состояние Tor недоступно" }, { ...proxy, mode: "none" }, "en"), "Tor error: Tor status is unavailable", "known Tor error is localized exactly");
equal(localization.formatTorIndicator({ state: "error", progress: 0, message: "Секретная техническая ошибка" }, { ...proxy, mode: "none" }, "en"), "Tor error: Tor route is unavailable", "unknown Tor error is not leaked into English UI");
equal(localization.formatTorIndicator({ state: "disabled", progress: 0 }, { ...proxy, mode: "none" }, "en"), "Tor was disabled by the user", "disabled Tor indicator is English");
equal(localization.formatTorIndicator({ state: "disabled", progress: 0 }, { ...proxy, mode: "none" }, "ru"), "Tor выключен пользователем", "disabled Tor indicator is Russian");
equal(localization.formatTorIndicator({ state: "connecting", progress: 37 }, { ...proxy, mode: "none" }, "en"), "Tor is connecting: 37%", "connecting Tor indicator carries progress in English");
equal(localization.formatTorIndicator({ state: "starting", progress: 4 }, { ...proxy, mode: "none" }, "ru"), "Tor подключается: 4%", "starting Tor indicator carries progress in Russian");
equal(localization.formatTorRuntimeMessage("Запуск встроенного Tor", "starting", "en"), "Starting built-in Tor", "known Tor runtime message is translated exactly");
equal(localization.formatTorRuntimeMessage("Bootstrapped 45%: Loading", "connecting", "en"), "Bootstrapped 45%: Loading", "English Tor bootstrap detail remains intact");
equal(localization.formatTorRuntimeMessage("Bootstrapped 45%: Loading", "connecting", "ru"), "Подключение Tor: 45%: Loading", "Russian Tor bootstrap prefix is localized without rewriting detail");
equal(localization.formatTorRuntimeMessage("Неизвестное состояние", "connecting", "en"), "Connecting to Tor…", "unknown connecting detail is not leaked into English UI");
equal(localization.formatTorRuntimeMessage("Неизвестное состояние", "error", "ru"), "Неизвестное состояние", "unknown Russian Tor detail remains intact");

equal(localization.formatProxyTestSuccess("Прокси отключён. Используются общие параметры прямого подключения Tox", "en"), "The proxy is disabled. Shared direct Tox connection settings are used.", "direct connection proxy-test result is English");
equal(localization.formatProxyTestSuccess("SOCKS5-прокси доступен, согласование авторизации успешно", "en"), "The SOCKS5 proxy is reachable; authentication negotiation succeeded.", "SOCKS5 proxy-test result is English");
equal(localization.formatProxyTestSuccess(`HTTP-прокси доступен: ${messageSentinel}`, "en"), `The HTTP proxy is reachable: ${messageSentinel}`, "HTTP response detail remains intact in English");
equal(localization.formatProxyTestSuccess(`HTTP-прокси доступен: ${messageSentinel}`, "ru"), `HTTP-прокси доступен: ${messageSentinel}`, "HTTP response detail remains intact in Russian");
equal(localization.formatProxyTestSuccess("Новый успешный ответ", "en"), "The proxy connection test succeeded.", "unknown proxy success text is not leaked into English UI");

const pqStatuses = [
  "unavailable",
  "available",
  "offered",
  "incoming_offer",
  "accepting",
  "active",
  "closing",
  "closing_commit",
  "closing_ack",
  "closing_final",
  "rejected",
  "withdrawn",
  "superseded",
  "close_pending",
  "closed",
  "error",
];
for (const status of pqStatuses) {
  for (const role of ["initiator", "responder"]) {
    const title = localization.formatPqTitle(status, role, "en");
    const description = localization.formatPqDescription(status, role, contactSentinel, "en");
    ok(title.length > 0, `${status}/${role} has a PQ title`);
    ok(description.length > 0, `${status}/${role} has a PQ description`);
    ok(!/[А-Яа-яЁё]/.test(`${title} ${description}`.replaceAll(contactSentinel, "")), `${status}/${role} has no Russian system copy in English mode`);
  }
}
ok(localization.formatPqDescription("offered", "initiator", contactSentinel, "en").includes(contactSentinel), "outgoing PQ offer preserves contact name");
ok(localization.formatPqDescription("rejected", "initiator", contactSentinel, "en").includes(contactSentinel), "PQ rejection preserves contact name");
ok(localization.formatPqDescription("close_pending", "responder", contactSentinel, "en").includes(contactSentinel), "PQ shutdown request preserves contact name");

equal(localization.formatDeliveryReceiptTitle("message", "08/16/2026, 12:30 PM", "en"), "Message delivered, delivery receipt: 08/16/2026, 12:30 PM", "message receipt is English");
equal(localization.formatDeliveryReceiptTitle("file", "08/16/2026, 12:30 PM", "en"), "File delivered, delivery receipt: 08/16/2026, 12:30 PM", "file receipt is English");
equal(localization.formatDeliveryReceiptTitle("message", "16.08.2026, 12:30", "ru"), "Сообщение получено, отчёт о доставке: 16.08.2026, 12:30", "message receipt is Russian");
equal(localization.formatDeliveryReceiptTitle("file", pathSentinel, "en"), `File delivered, delivery receipt: ${pathSentinel}`, "receipt formatter preserves its supplied timestamp label");

const stableErrors = [
  ["ACTIVE_PROFILE_LOCKED", "Активный профиль заблокирован.", "The active profile is locked."],
  ["ACTIVE_PROFILE_NOT_REGISTERED", "Активный профиль не зарегистрирован.", "The active profile is not registered."],
  ["NO_ACTIVE_PROFILE", "Активный профиль не выбран.", "No active profile is selected."],
  ["PROFILE_ACTION_BUSY", "Дождитесь завершения текущего действия с профилем.", "Wait for the current profile action to finish."],
  ["PROFILE_ALREADY_DISABLED", "Профиль уже отключён.", "The profile is already disabled."],
  ["PROFILE_DISABLED_REIMPORT_REQUIRED", "Профиль отключён; для повторного добавления импортируйте его снова.", "The profile is disabled; import it again to add it back."],
  ["PROFILE_LOCKED", "Профиль заблокирован.", "The profile is locked."],
  ["PROFILE_NOT_FOUND", "Профиль не найден.", "The profile was not found."],
  ["PROFILE_PASSWORD_INVALID", "Неверный пароль.", "Incorrect password."],
  ["PROFILE_PASSWORD_REQUIRED", "Требуется пароль профиля.", "The profile password is required."],
  ["QTOX_PROFILE_ALREADY_IMPORTED", "Этот профиль qTox уже импортирован.", "This qTox profile has already been imported."],
  ["QTOX_PROFILE_NOT_FOUND", "Профиль qTox не найден.", "The qTox profile was not found."],
  ["UNSUPPORTED_LANGUAGE", "Выбранный язык не поддерживается.", "The selected language is not supported."],
];
const operationFallback = { ru: "Не удалось выполнить действие", en: "The action could not be completed" };
for (const [code, russian, english] of stableErrors) {
  equal(localization.formatUserFacingError(code, operationFallback, "ru"), russian, `${code} has an exact Russian mapping`);
  equal(localization.formatUserFacingError(code, operationFallback, "en"), english, `${code} has an exact English mapping`);
}
equal(localization.formatUserFacingError("Неизвестная ошибка: Настройки", operationFallback, "en"), operationFallback.en, "unknown raw error is hidden in English mode");
ok(!localization.formatUserFacingError("Неизвестная ошибка: Настройки", operationFallback, "en").includes("Настройки"), "unknown Russian error text cannot leak into English UI");
equal(localization.formatUserFacingError("Неизвестная ошибка", operationFallback, "ru"), `${operationFallback.ru}: Неизвестная ошибка`, "unknown raw error remains available in Russian mode");
equal(localization.formatUserFacingError(new Error("PROFILE_PASSWORD_INVALID"), operationFallback, "en"), "Incorrect password.", "Error objects use the same exact stable-code mapping");

equal(localization.formatFriendRequestDefault("ru"), "Привет! Добавь меня, пожалуйста.", "friend-request default is Russian");
equal(localization.formatFriendRequestDefault("en"), "Hello! Please add me.", "friend-request default is English");

for (const obsoleteKey of ["Сохранить в downloads", "Сохранить изображение в downloads", "Сохранено в downloads"]) {
  ok(!i18nSource.includes(`\"${obsoleteKey}\"`), `obsolete localization key was removed: ${obsoleteKey}`);
}
equal((i18nSource.match(/\[\"Ошибка Tor: \"/g) ?? []).length, 1, "Tor error fragment is declared once");
equal((i18nSource.match(/\[\"Tor подключён: \"/g) ?? []).length, 1, "Tor connected fragment is declared once");
ok(!appSource.includes("message.quote") && !appSource.includes("formatQuoteAuthor"), "unimplemented quote rendering cannot expose mock author metadata");
ok(appSource.includes("formatChatRequestNotice") && appSource.includes("formatChatMessageNotice"), "native chat notices use explicit localization formatters");
ok(appSource.includes("formatDeliveryReceiptTitle"), "delivery receipts use the explicit locale formatter");
ok(appSource.includes('data-i18n-ignore translate="no">{transferNotice.path}'), "exported history path remains raw user data");
ok(appSource.includes('data-i18n-ignore translate="no">{contactActionName}'), "contact action preserves a user-defined contact name");
ok(settingsSource.includes('data-i18n-ignore translate="no">{activeProfile?.name}'), "profile deletion preserves a user-defined profile name");
ok(settingsSource.includes("languageRef.current") && settingsSource.includes("currentText("), "deferred network and proxy results use the current language");
ok(settingsSource.includes('currentText("Проверка подключения…")'), "proxy progress is explicitly localized before an ignored DOM node");
ok(rootSource.includes("useEffect(() => setError(\"\"), [language])"), "welcome errors cannot remain in the previous language");
ok(rootSource.includes("Record<string, LocalizedError | undefined>") && rootSource.includes("errors[profile.id]?.[language]") && !rootSource.includes("useEffect(() => setErrors({}), [language])"), "unlock errors survive a language switch and render in the current language");
ok(rootSource.includes('onClick={() => setFlow("import")}') && !rootSource.includes('setFlow("import"); void discover()'), "opening qTox import does not read the standard user profile directory");
ok(rootSource.includes("qtoxSearchComplete") && rootSource.includes("!busy && !qtoxSearchComplete"), "qTox import distinguishes an untouched form from an empty completed search");
ok(rootSource.includes('activity === "discovering"') && rootSource.includes('activity === "importing"'), "qTox discovery and import expose distinct progress states");
ok(rootSource.includes('protect ? "with-password" : ""') && startupCssSource.includes(".startup-form.create-flow.with-password") && startupCssSource.includes("min-height: 46px"), "password-protected profile creation uses a compact layout with a fully sized final action");

const expectedAssertions = 205;
assert.equal(assertions, expectedAssertions, "update the declared assertion count when localization coverage changes");
console.log(`localization rules: ${assertions} assertions passed`);
