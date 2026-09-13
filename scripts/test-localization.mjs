import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { importTypeScriptModule } from "./import-typescript-module.mjs";

const sourceUrl = new URL("../src/localization.ts", import.meta.url);
const i18nSource = await readFile(new URL("../src/i18n.tsx", import.meta.url), "utf8");
const appSource = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
const rootSource = await readFile(new URL("../src/RootApp.tsx", import.meta.url), "utf8");
const nativeNotificationSource = await readFile(new URL("../src-tauri/src/desktop_notifications.rs", import.meta.url), "utf8");
const startupCssSource = await readFile(new URL("../src/Startup.css", import.meta.url), "utf8");
const settingsSource = await readFile(new URL("../src/Settings.tsx", import.meta.url), "utf8");
const chatEnhancementsSource = await readFile(new URL("../src/ChatMessageEnhancements.tsx", import.meta.url), "utf8");
const webRootSource = await readFile(new URL("../src/web/WebRoot.tsx", import.meta.url), "utf8");
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
  ["FILE_RECEIVE_DENIED", "Приём файлов запрещён настройками.", "File reception is disabled in settings."],
  ["CHAT_REACTION_OWN_MESSAGE", "Реакции доступны только для входящих сообщений.", "Reactions are available only for incoming messages."],
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
ok(appSource.includes("message.quote") && appSource.includes("MessageQuotePreview"), "implemented quotes use the shared presentation component");
ok(chatEnhancementsSource.includes('data-i18n-ignore={author ? true : undefined}') && chatEnhancementsSource.includes('author || t("Цитата")'), "quote authors remain raw local identity while legacy quotes use a neutral localized label");
ok(nativeNotificationSource.includes('language != "en"') && /"Контакт"\s*\}\s*else\s*\{\s*"Contact"/u.test(nativeNotificationSource) && /"Запрос в контакты"\s*\}\s*else\s*\{\s*"Contact request"/u.test(nativeNotificationSource), "native notification labels use the current RU/EN setting before OS delivery");
ok(appSource.includes("formatDeliveryReceiptTitle"), "delivery receipts use the explicit locale formatter");
ok(appSource.includes('data-i18n-ignore translate="no">{transferNotice.path}'), "exported history path remains raw user data");
ok(appSource.includes('data-i18n-ignore translate="no">{contactActionName}'), "contact action preserves a user-defined contact name");
ok(settingsSource.includes('data-i18n-ignore translate="no">{activeProfile?.name}'), "profile deletion preserves a user-defined profile name");
ok(settingsSource.includes("languageRef.current") && settingsSource.includes("currentText("), "deferred network and proxy results use the current language");
ok(settingsSource.includes('currentText("Проверка подключения…")'), "proxy progress is explicitly localized before an ignored DOM node");
ok(rootSource.includes("useEffect(() => setError(\"\"), [language])"), "welcome errors cannot remain in the previous language");
ok(rootSource.includes("Record<string, LocalizedError | undefined>") && rootSource.includes("errors[profile.id]?.[language]") && !rootSource.includes("useEffect(() => setErrors({}), [language])"), "unlock errors survive a language switch and render in the current language");
ok(rootSource.includes('onClick={() => setFlow("import")}') && !rootSource.includes('setFlow("import"); void discover()') && !rootSource.includes("qtoxSearchComplete"), "opening qTox import never scans the standard user profile directory");
ok(rootSource.includes('extensions: ["kai", "zip"]') && rootSource.includes("browseFolder()") && rootSource.includes("browseFile()") && !rootSource.includes('extensions: ["kai", "tox"]') && !rootSource.includes('t("Найти")'), "qTox import exposes only an explicit folder or ZIP/.kai source");
ok(rootSource.includes('activity === "discovering"') && rootSource.includes('activity === "importing"'), "qTox discovery and import expose distinct progress states");
ok(rootSource.includes('protect ? "with-password" : ""') && startupCssSource.includes(".startup-form.create-flow.with-password") && startupCssSource.includes("min-height: 46px"), "password-protected profile creation uses a compact layout with a fully sized final action");
ok(webRootSource.includes("Идеально для одноразового чата без следов."), "RAM workspace description includes the approved Russian one-time-chat note");
ok(webRootSource.includes("Ideal for a one-time chat that leaves no trace."), "RAM workspace description includes the matching English one-time-chat note");
ok(webRootSource.includes("Пароль доступа к пространству") && webRootSource.includes("Workspace access password"), "workspace access password is explicit in both languages");
ok(!webRootSource.includes("Имя первого Tox-профиля") && !webRootSource.includes("First Tox profile name"), "the Web initializer does not create the first Tox profile");
ok(webRootSource.includes('menu: "Управление сеансом"') && webRootSource.includes('menu: "Session management"'), "session management menu is explicit in both languages");
ok(webRootSource.includes('lockSession: "Заблокировать сеанс"') && webRootSource.includes('lockSession: "Lock session"'), "immediate session lock is explicit in both languages");
ok(webRootSource.includes('destroyWorkspace: "Уничтожить пространство"') && webRootSource.includes('destroyWorkspace: "Destroy workspace"'), "workspace destruction is explicit in both languages");
ok(webRootSource.includes('copyLink: "Скопировать ссылку"') && webRootSource.includes('copyLink: "Copy link"') && webRootSource.includes('linkCopied: "Ссылка скопирована"') && webRootSource.includes('linkCopied: "Link copied"'), "the service-bar copy-link icon has localized labels and feedback");
ok(webRootSource.includes('renewLease: "Продлить срок хранения"') && webRootSource.includes('renewLease: "Extend retention"') && !webRootSource.includes('renew: "Продлить"') && !webRootSource.includes('renew: "Renew"'), "the text Renew button is replaced by a localized icon action");
ok(!webRootSource.includes("Экспортировать и уничтожить") && !webRootSource.includes("Export and destroy"), "obsolete export-before-destroy labels are absent");

for (const [code, ru, en] of [
  ["WORKSPACE_QUOTA_FULL", "В пространстве недостаточно места для файла. Удалите ненужные файлы и повторите попытку.", "The workspace does not have enough space for the file. Delete unneeded files and try again."],
  ["PROFILE_TRANSFER_CLEANUP_PENDING", "Профиль удалён, но очистка связанных файлов ещё не завершена.", "The profile was deleted, but cleanup of its files is still pending."],
  ["PROFILE_STATE_CHANGED", "Выбранный профиль изменился. Повторите действие для нужного профиля.", "The selected profile has changed. Repeat the action for the intended profile."],
]) {
  equal(localization.formatUserFacingError(code, { ru: "Ошибка", en: "Error" }, "ru"), ru, `${code} explains the recoverable state in Russian`);
  equal(localization.formatUserFacingError({ code }, { ru: "Ошибка", en: "Error" }, "en"), en, `${code} explains the recoverable state in English`);
}
ok(i18nSource.includes('"Скопировать ссылку": "Copy link"'), "the chat link context action has both labels");

// Exercise the production bridge with a deterministic DOM/observer/task queue.
// Counting visited nodes, instead of elapsed time, keeps the input-lag regression
// meaningful on both developer machines and slower CI runners.
function languageBridgeHarness() {
  const observers = new Set();
  const timers = new Map();
  const counts = { childReads: 0, textReads: 0, textWrites: 0, attributeWrites: 0 };
  let timerId = 0;
  let language = "en";
  let cleanup;
  const notify = (record) => {
    for (const observer of observers) {
      if (!observer.root?.contains(record.target)) continue;
      if (record.type === "attributes" && !observer.options.attributeFilter.includes(record.attributeName)) continue;
      observer.records.push({ addedNodes: [], removedNodes: [], ...record });
    }
  };
  class DomNode {
    static ELEMENT_NODE = 1;
    static TEXT_NODE = 3;
    constructor(nodeType) {
      this.nodeType = nodeType;
      this.parentNode = null;
      this.childNodes = [];
      this.rawText = "";
      this.textReads = 0;
    }
    get parentElement() { return this.parentNode; }
    get firstChild() { counts.childReads += 1; return this.childNodes[0] ?? null; }
    get nextSibling() {
      const siblings = this.parentNode?.childNodes ?? [];
      return siblings[siblings.indexOf(this) + 1] ?? null;
    }
    get nodeValue() { counts.textReads += 1; this.textReads += 1; return this.rawText; }
    set nodeValue(value) {
      this.rawText = value;
      counts.textWrites += 1;
      notify({ type: "characterData", target: this });
    }
    contains(node) {
      for (let current = node; current; current = current.parentNode) if (current === this) return true;
      return false;
    }
    append(node) {
      node.parentNode = this;
      this.childNodes.push(node);
      notify({ type: "childList", target: this, addedNodes: [node] });
      return node;
    }
    remove(node) {
      this.childNodes.splice(this.childNodes.indexOf(node), 1);
      node.parentNode = null;
      notify({ type: "childList", target: this, removedNodes: [node] });
    }
  }
  class DomElement extends DomNode {
    constructor() { super(DomNode.ELEMENT_NODE); this.attributes = new Map(); }
    hasAttribute(name) { return this.attributes.has(name); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    setAttribute(name, value) {
      this.attributes.set(name, value);
      counts.attributeWrites += 1;
      notify({ type: "attributes", target: this, attributeName: name });
    }
    removeAttribute(name) {
      this.attributes.delete(name);
      notify({ type: "attributes", target: this, attributeName: name });
    }
    closest() {
      for (let element = this; element; element = element.parentElement) {
        if (element.hasAttribute("data-i18n-ignore") || element.getAttribute("translate") === "no") return element;
      }
      return null;
    }
    querySelectorAll() {
      const matches = [];
      const walk = (node) => {
        for (let child = node.firstChild; child; child = child.nextSibling) {
          if (child instanceof DomElement) {
            if (["placeholder", "title", "aria-label"].some((name) => child.hasAttribute(name))) matches.push(child);
            walk(child);
          }
        }
      };
      walk(this);
      return matches;
    }
  }
  const body = new DomElement();
  const document = {
    body,
    documentElement: new DomElement(),
    createTreeWalker(root) {
      const nodes = [];
      const walk = (node) => {
        for (let child = node.firstChild; child; child = child.nextSibling) {
          if (child.nodeType === DomNode.TEXT_NODE) nodes.push(child);
          else walk(child);
        }
      };
      walk(root);
      let index = 0;
      return { currentNode: root, nextNode() { this.currentNode = nodes[index++]; return this.currentNode; } };
    },
  };
  class Observer {
    constructor(callback) { this.callback = callback; this.records = []; observers.add(this); }
    observe(root, options) { this.root = root; this.options = options; }
    disconnect() { this.root = null; this.records = []; observers.delete(this); }
  }
  const runtimeSource = i18nSource.slice(i18nSource.indexOf("const english:"), i18nSource.indexOf("type I18nValue"))
    + i18nSource.slice(i18nSource.indexOf("type AppliedText"));
  const runtimeCode = stripTypeScriptTypes(runtimeSource).replaceAll("export function ", "function ");
  const runtime = new Function("document", "Node", "Element", "Document", "DocumentFragment", "NodeFilter", "MutationObserver", "setTimeout", "clearTimeout", "performance", "useI18n", "useEffect",
    `${runtimeCode}\nreturn { translateText, GlobalLanguageBridge };`)(
    document, DomNode, DomElement, class {}, class {}, { SHOW_TEXT: 4 }, Observer,
    (callback) => { const id = ++timerId; timers.set(id, callback); return id; },
    (id) => timers.delete(id), { now: () => 0 }, () => ({ language }), (effect) => { cleanup = effect(); },
  );
  const deliver = () => {
    for (const observer of observers) {
      const records = observer.records.splice(0);
      if (records.length) observer.callback(records);
    }
  };
  const step = () => {
    deliver();
    const task = timers.entries().next().value;
    if (!task) return false;
    timers.delete(task[0]);
    task[1]();
    deliver();
    return true;
  };
  return {
    body, counts, timers, runtime,
    element: () => new DomElement(),
    text: (value) => { const node = new DomNode(DomNode.TEXT_NODE); node.rawText = value; return node; },
    start(value) { cleanup?.(); language = value; runtime.GlobalLanguageBridge(); },
    stop() { cleanup?.(); cleanup = undefined; },
    resetCounts() { for (const key of Object.keys(counts)) counts[key] = 0; },
    step,
    drain() {
      let tasks = 0;
      while (step()) {
        tasks += 1;
        assert.ok(tasks < 1000, "language observer must settle without self-triggered cycles");
      }
      return tasks;
    },
  };
}

const bridge = languageBridgeHarness();
for (const [ru, en] of [
  ["Групповой чат", "Group chat"],
  ["Групповой чат — скоро", "Group chat — coming soon"],
  ["Закрыть просмотр изображения", "Close image viewer"],
  ["Подключен", "Connected"],
  ["Выход", "Exit"],
]) {
  equal(bridge.runtime.translateText(ru, "ru"), ru, `${ru} remains Russian in Russian mode`);
  equal(bridge.runtime.translateText(ru, "en"), en, `${ru} has an exact English label`);
}
equal(bridge.runtime.translateText("  \n\t", "en"), "  \n\t", "English translation preserves whitespace-only text exactly");
equal(bridge.runtime.translateText("  Настройки \n", "en"), "  Settings \n", "exact translation preserves surrounding whitespace");
let dictionarySorts = 0;
const originalSort = Array.prototype.sort;
let mixedTranslation;
try {
  Array.prototype.sort = function (...args) { dictionarySorts += 1; return originalSort.apply(this, args); };
  mixedTranslation = bridge.runtime.translateText("Контакт ABC · Настройки", "en");
  bridge.runtime.translateText("Already translated title", "en");
} finally {
  Array.prototype.sort = originalSort;
}
equal(mixedTranslation, "Contact ABC · Settings", "mixed system copy keeps the existing replacement order");
equal(dictionarySorts, 0, "dynamic English labels do not rebuild and sort the dictionary per text node");

const panel = bridge.body.append(bridge.element());
const buttonTexts = Array.from({ length: 600 }, () => panel.append(bridge.element()).append(bridge.text("Настройки")));
bridge.start("en");
bridge.step();
equal(buttonTexts[0].rawText, "Settings", "the first translation slice makes progress");
equal(buttonTexts.at(-1).rawText, "Настройки", "a large translation batch yields before consuming the whole subtree");
ok(bridge.counts.textWrites < buttonTexts.length, "translation cannot block input while rewriting every button in one task");
ok(bridge.drain() > 1, "remaining translation work continues in bounded tasks");
ok(buttonTexts.every((node) => node.rawText === "Settings"), "bounded traversal eventually translates every dynamic button");
equal(bridge.timers.size, 0, "translated text mutations do not leave a repeating observer task");

panel.setAttribute("title", "Настройки");
bridge.drain();
bridge.resetCounts();
for (let index = 0; index < 250; index += 1) panel.setAttribute("title", "Профиль");
bridge.resetCounts();
bridge.drain();
equal(panel.getAttribute("title"), "Profile", "an attribute mutation burst translates its final value");
equal(bridge.counts.attributeWrites, 1, "duplicate attribute mutations apply one translated value");
equal(bridge.counts.childReads, 0, "changing a menu title never walks its hundreds of descendants");
equal(bridge.counts.textReads, 0, "changing an accessible label never revisits message or button text");
panel.removeAttribute("title");
bridge.drain();
panel.setAttribute("title", "Выход");
bridge.drain();
equal(panel.getAttribute("title"), "Exit", "removing and restoring an attribute does not revive a stale translation");
for (const attribute of ["placeholder", "aria-label"]) panel.setAttribute(attribute, "Сообщение…");
bridge.drain();
equal(panel.getAttribute("placeholder"), "Message…", "dynamic placeholders stay translated");
equal(panel.getAttribute("aria-label"), "Message…", "dynamic accessible labels stay translated");

const menu = bridge.body.append(bridge.element());
const menuButton = menu.append(bridge.element());
const menuText = menuButton.append(bridge.text("Цитата"));
bridge.drain();
equal(menuText.rawText, "Quote", "overlapping inserted menu/button/text roots translate correctly");
equal(menuText.textReads, 2, "overlapping mutation roots visit the text once plus its own mutation acknowledgement");
menuText.nodeValue = "Курсив";
bridge.drain();
equal(menuText.rawText, "Italic", "React character-data updates replace the original translation record");

const ignored = bridge.body.append(bridge.element());
ignored.setAttribute("data-i18n-ignore", "");
const ignoredTexts = Array.from({ length: 1800 }, () => ignored.append(bridge.element()).append(bridge.text(messageSentinel)));
const noTranslate = bridge.body.append(bridge.element());
noTranslate.setAttribute("translate", "no");
const rawIdentity = noTranslate.append(bridge.text(profileSentinel));
bridge.drain();
ok(ignoredTexts.every((node) => node.rawText === messageSentinel), "data-i18n-ignore preserves every user message verbatim");
equal(rawIdentity.rawText, profileSentinel, "translate=no preserves user identity text");
bridge.resetCounts();
ignoredTexts[0].nodeValue = "Настройки — выделенный пользовательский текст";
ignored.setAttribute("title", pathSentinel);
noTranslate.setAttribute("aria-label", contactSentinel);
bridge.resetCounts();
equal(bridge.drain(), 0, "editor and quote mutations inside ignored content schedule no translation work");
equal(bridge.counts.childReads, 0, "ignored editor mutations never enumerate their children");
equal(ignored.getAttribute("title"), pathSentinel, "ignored paths in attributes remain verbatim");
equal(noTranslate.getAttribute("aria-label"), contactSentinel, "ignored identity attributes remain verbatim");

bridge.start("ru");
bridge.drain();
ok(buttonTexts.every((node) => node.rawText === "Настройки"), "switching to Russian restores the original text after incremental translation");
equal(menuText.rawText, "Курсив", "switching languages preserves the latest React text update");
equal(panel.getAttribute("title"), "Выход", "switching languages restores the latest original attribute");
equal(ignoredTexts[0].rawText, "Настройки — выделенный пользовательский текст", "language switches leave edited user text untouched");
bridge.start("en");
bridge.step();
bridge.start("ru");
bridge.drain();
ok(buttonTexts.every((node) => node.rawText === "Настройки"), "a language switch cancels unfinished work from the previous language");
equal(bridge.timers.size, 0, "the cancelled language leaves no scheduled continuation");
bridge.stop();

const interruptedBridge = languageBridgeHarness();
const changingMenu = interruptedBridge.body.append(interruptedBridge.element());
const changingLabels = Array.from({ length: 300 }, () => changingMenu.append(interruptedBridge.element()).append(interruptedBridge.text("Настройки")));
interruptedBridge.start("en");
interruptedBridge.step();
const removedLabel = changingLabels.find((node) => node.rawText === "Настройки");
changingMenu.remove(removedLabel.parentNode);
interruptedBridge.drain();
equal(changingLabels.at(-1).rawText, "Settings", "removing a pending sibling between slices cannot strand the remaining translations");
equal(removedLabel.rawText, "Настройки", "a detached menu subtree is never translated after removal");
interruptedBridge.stop();

const expectedAssertions = 271;
assert.equal(assertions, expectedAssertions, "update the declared assertion count when localization coverage changes");
console.log(`localization rules: ${assertions} assertions passed`);
