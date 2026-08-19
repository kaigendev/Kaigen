export type Language = "ru" | "en";

export type LocalizedText = Readonly<{
  ru: string;
  en: string;
}>;

export type LocalizedNotice = Readonly<{
  title: string;
  body: string;
}>;

export type ProfileStatus = "online" | "away" | "busy" | "offline";
export type TorRuntimeState = "disabled" | "starting" | "connecting" | "connected" | "error";
export type TorStatusInput = Readonly<{
  state: TorRuntimeState;
  progress: number;
  message?: string | null;
  socksPort?: number | null;
  controlPort?: number | null;
}>;
export type ProxySettingsInput = Readonly<{
  mode: "none" | "socks5" | "http";
  host: string;
  port: number;
}>;

export type PqRole = "initiator" | "responder";
export type PqCopyStatus =
  | "unavailable"
  | "available"
  | "offered"
  | "incoming_offer"
  | "accepting"
  | "active"
  | "closing"
  | "closing_commit"
  | "closing_ack"
  | "closing_final"
  | "rejected"
  | "withdrawn"
  | "superseded"
  | "close_pending"
  | "closed"
  | "error";

export type DeliveryReceiptKind = "message" | "file";

function localized(value: LocalizedText, language: Language): string {
  return value[language];
}

function normalizedCount(count: number): number {
  return Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0;
}

function russianPlural(count: number): "one" | "few" | "many" {
  const lastTwo = count % 100;
  if (lastTwo >= 11 && lastTwo <= 14) return "many";
  const last = count % 10;
  if (last === 1) return "one";
  if (last >= 2 && last <= 4) return "few";
  return "many";
}

function formatUnreadEventsLabel(count: number, language: Language): string {
  const value = normalizedCount(count);
  if (language === "en") return value === 1 ? "1 new message or request" : `${value} new messages or requests`;
  const plural = russianPlural(value);
  if (plural === "one") return `${value} новое сообщение или запрос`;
  if (plural === "few") return `${value} новых сообщения или запроса`;
  return `${value} новых сообщений или запросов`;
}

export function formatProfileEventNotice(profileName: string, count: number, language: Language): LocalizedNotice {
  return {
    title: `${profileName}: ${language === "en" ? "new event" : "новое событие"}`,
    body: formatUnreadEventsLabel(count, language),
  };
}

export function formatChatRequestNotice(profileName: string, requestBody: string, language: Language): LocalizedNotice {
  return {
    title: `${profileName}: ${language === "en" ? "new chat request" : "новый запрос на переписку"}`,
    body: requestBody,
  };
}

export function formatChatMessageNotice(
  profileName: string,
  contactName: string | null | undefined,
  content: string | null | undefined,
  language: Language,
): LocalizedNotice {
  const displayedContact = contactName || (language === "en" ? "new message" : "новое сообщение");
  return {
    title: `${profileName}: ${displayedContact}`,
    body: content || (language === "en" ? "Attachment" : "Вложение"),
  };
}

export function formatUnreadMessagesLabel(count: number, language: Language): string {
  const value = normalizedCount(count);
  if (language === "en") return value === 1 ? "1 new unread message" : `${value} new unread messages`;
  const plural = russianPlural(value);
  if (plural === "one") return `${value} новое непрочитанное сообщение`;
  if (plural === "few") return `${value} новых непрочитанных сообщения`;
  return `${value} новых непрочитанных сообщений`;
}

const profileStatusText: Readonly<Record<ProfileStatus, LocalizedText>> = {
  online: { ru: "Онлайн", en: "Online" },
  away: { ru: "Отошёл", en: "Away" },
  busy: { ru: "Занят", en: "Busy" },
  offline: { ru: "Отключён", en: "Offline" },
};

export function formatProfileSwitcherTitle(profileName: string, status: ProfileStatus, language: Language): string {
  return `${profileName} · ${localized(profileStatusText[status], language)}`;
}

export function formatProfileSwitcherAria(profileName: string, language: Language): string {
  return language === "en" ? `Switch to profile ${profileName}` : `Переключиться на профиль ${profileName}`;
}

const torRuntimeMessages: Readonly<Record<string, LocalizedText>> = {
  "Состояние Tor недоступно": { ru: "Состояние Tor недоступно", en: "Tor status is unavailable" },
  "Запуск встроенного Tor": { ru: "Запуск встроенного Tor", en: "Starting built-in Tor" },
  "Запуск Tor": { ru: "Запуск Tor", en: "Starting Tor" },
  "Перезапуск Tor": { ru: "Перезапуск Tor", en: "Restarting Tor" },
  "Tor выключен пользователем": { ru: "Tor выключен пользователем", en: "Tor was disabled by the user" },
  "маршрут недоступен": { ru: "маршрут недоступен", en: "route unavailable" },
  "применение сетевого маршрута": { ru: "применение сетевого маршрута", en: "applying network route" },
  "выключено": { ru: "выключено", en: "disabled" },
  "запуск": { ru: "запуск", en: "starting" },
  "подключено, маршрут защищён": { ru: "подключено, маршрут защищён", en: "connected, route protected" },
  "ошибка": { ru: "ошибка", en: "error" },
};

export function formatTorRuntimeMessage(
  message: string | null | undefined,
  state: TorRuntimeState,
  language: Language,
): string {
  const raw = message?.trim() ?? "";
  const known = torRuntimeMessages[raw];
  if (known) return localized(known, language);
  if (raw.startsWith("Bootstrapped ")) {
    return language === "en" ? raw : `Подключение Tor: ${raw.slice("Bootstrapped ".length)}`;
  }
  if (language === "ru" && raw) return raw;
  if (state === "error") return language === "en" ? "Tor route is unavailable" : "Маршрут Tor недоступен";
  if (state === "connected") return language === "en" ? "Tor connected" : "Tor подключён";
  if (state === "disabled") return language === "en" ? "Tor is disabled" : "Tor выключен";
  return language === "en" ? "Connecting to Tor…" : "Подключение к Tor…";
}

export function formatTorIndicator(
  status: TorStatusInput,
  proxy: ProxySettingsInput,
  language: Language,
): string {
  const customProxyActive = status.state === "disabled" && proxy.mode !== "none";
  if (customProxyActive) {
    return language === "en"
      ? `${proxy.mode.toUpperCase()} proxy ${proxy.host}:${proxy.port}; mandatory kill switch enabled`
      : `${proxy.mode.toUpperCase()}-прокси ${proxy.host}:${proxy.port}; обязательный kill switch включён`;
  }
  if (status.state === "connected") {
    return language === "en"
      ? `Tor connected: SOCKS ${status.socksPort ?? "—"}, Control ${status.controlPort ?? "—"}`
      : `Tor подключён: SOCKS ${status.socksPort ?? "—"}, Control ${status.controlPort ?? "—"}`;
  }
  if (status.state === "error") {
    const detail = formatTorRuntimeMessage(status.message, status.state, language);
    return language === "en" ? `Tor error: ${detail}` : `Ошибка Tor: ${detail}`;
  }
  if (status.state === "disabled") return language === "en" ? "Tor was disabled by the user" : "Tor выключен пользователем";
  const progress = Math.max(0, Math.min(100, Math.round(status.progress)));
  return language === "en" ? `Tor is connecting: ${progress}%` : `Tor подключается: ${progress}%`;
}

export function formatProxyTestSuccess(message: string | null | undefined, language: Language): string {
  const raw = message?.trim() ?? "";
  if (raw === "Прокси отключён. Используются общие параметры прямого подключения Tox") {
    return language === "en"
      ? "The proxy is disabled. Shared direct Tox connection settings are used."
      : "Прокси отключён. Используются общие параметры прямого подключения Tox";
  }
  if (raw === "SOCKS5-прокси доступен, согласование авторизации успешно") {
    return language === "en"
      ? "The SOCKS5 proxy is reachable; authentication negotiation succeeded."
      : raw;
  }
  const httpPrefix = "HTTP-прокси доступен: ";
  if (raw.startsWith(httpPrefix)) {
    const responseLine = raw.slice(httpPrefix.length);
    return language === "en" ? `The HTTP proxy is reachable: ${responseLine}` : `${httpPrefix}${responseLine}`;
  }
  return language === "en" ? "The proxy connection test succeeded." : (raw || "Проверка подключения к прокси успешно завершена.");
}

export function formatPqTitle(status: PqCopyStatus, role: PqRole, language: Language): string {
  if (status === "unavailable") return language === "en" ? "Post-quantum encryption unavailable" : "Постквантовое шифрование недоступно";
  if (status === "available") return language === "en" ? "Post-quantum encryption available" : "Постквантовое шифрование доступно";
  if (status === "offered" || status === "incoming_offer") {
    return role === "initiator"
      ? (language === "en" ? "Post-quantum encryption request sent" : "Запрос на постквантовое шифрование отправлен")
      : (language === "en" ? "Post-quantum encryption offer" : "Предложение постквантового шифрования");
  }
  if (status === "accepting") return language === "en" ? "Post-quantum negotiation" : "Постквантовое согласование";
  if (status === "active") return language === "en" ? "Post-quantum encryption enabled" : "Постквантовое шифрование включено";
  if (["closing", "closing_commit", "closing_ack", "closing_final", "close_pending"].includes(status)) {
    return language === "en" ? "Post-quantum layer shutdown in progress" : "Выполняется отключение постквантового слоя";
  }
  if (status === "rejected") return language === "en" ? "Post-quantum encryption request declined" : "Запрос на постквантовое шифрование отклонён";
  if (status === "withdrawn") return language === "en" ? "Post-quantum encryption offer withdrawn" : "Предложение постквантового шифрования отозвано";
  if (status === "superseded") return language === "en" ? "Simultaneous offers merged" : "Одновременные предложения объединены";
  if (status === "closed") return language === "en" ? "Post-quantum layer disabled" : "Постквантовый слой отключён";
  return language === "en" ? "Post-quantum negotiation failed" : "Ошибка постквантового согласования";
}

export function formatPqDescription(
  status: PqCopyStatus,
  role: PqRole,
  contactName: string,
  language: Language,
): string {
  if (status === "unavailable") {
    return language === "en"
      ? "The contact has not confirmed post-quantum encryption support."
      : "Контакт не подтвердил поддержку постквантового шифрования.";
  }
  if (status === "available") {
    return language === "en"
      ? "Support is confirmed; negotiation can begin."
      : "Поддержка подтверждена; можно начать согласование.";
  }
  if (status === "offered" || status === "incoming_offer") {
    return role === "initiator"
      ? (language === "en"
        ? `Waiting for a decision from ${contactName}. Until confirmation, messages remain protected by standard Tox E2EE.`
        : `Ожидается решение ${contactName}. До подтверждения сообщения продолжают защищаться обычным Tox E2EE.`)
      : (language === "en"
        ? `${contactName} offers to add an ML-KEM-768 post-quantum layer to Tox E2EE.`
        : `${contactName} предлагает добавить к Tox E2EE постквантовый слой ML-KEM-768.`);
  }
  if (status === "accepting") {
    return language === "en"
      ? "The request was accepted. Mutual key confirmation is completing."
      : "Запрос принят. Завершается взаимное подтверждение ключей.";
  }
  if (status === "active") {
    return language === "en"
      ? "Both sides completed ML-KEM-768 negotiation. The post-quantum layer is active over Tox E2EE."
      : "Стороны успешно завершили согласование ML-KEM-768. Постквантовый слой активен поверх Tox E2EE.";
  }
  if (["closing", "closing_commit", "closing_ack", "closing_final"].includes(status)) {
    return language === "en"
      ? "Coordinated shutdown is in progress. Queued messages remain protected until the reverse handshake completes."
      : "Выполняется согласованное отключение. Сообщения в очереди остаются защищены до завершения обратного хендшейка.";
  }
  if (status === "rejected") {
    return role === "initiator"
      ? (language === "en" ? `${contactName} declined the post-quantum layer.` : `${contactName} отказался от перехода на постквантовый слой.`)
      : (language === "en" ? "You declined the post-quantum layer." : "Вы отказались от перехода на постквантовый слой.");
  }
  if (status === "withdrawn") {
    return role === "initiator"
      ? (language === "en" ? "You withdrew the post-quantum encryption offer." : "Вы отозвали предложение постквантового шифрования.")
      : (language === "en" ? `${contactName} withdrew the post-quantum encryption offer.` : `${contactName} отозвал предложение постквантового шифрования.`);
  }
  if (status === "superseded") {
    return language === "en"
      ? "Both contacts sent an offer simultaneously. One negotiation continues; respond to the current offer below."
      : "Оба контакта отправили предложение одновременно. Продолжено одно согласование; ответьте на актуальное предложение ниже.";
  }
  if (status === "close_pending") {
    return role === "initiator"
      ? (language === "en"
        ? "A coordinated shutdown request was sent. All queued messages retain PQ protection until the reverse handshake completes."
        : "Запрос на согласованное отключение отправлен. Все поставленные в очередь сообщения сохраняют PQ-защиту до завершения обратного хендшейка.")
      : (language === "en"
        ? `${contactName} requested a coordinated shutdown. PQ remains active until the queue is delivered and the reverse handshake completes.`
        : `${contactName} запросил согласованное отключение. PQ остаётся активным до доставки очереди и завершения обратного хендшейка.`);
  }
  if (status === "closed") {
    return language === "en"
      ? "The message queue was delivered and both sides completed the reverse handshake. Further messages use standard Tox E2EE."
      : "Очередь сообщений доставлена, обратный хендшейк завершён обеими сторонами. Дальнейшие сообщения используют стандартное Tox E2EE.";
  }
  return language === "en"
    ? "Post-quantum negotiation could not be completed. Retry when the contact is available."
    : "Не удалось завершить постквантовое согласование. Повторите попытку, когда контакт будет доступен.";
}

export function formatDeliveryReceiptTitle(
  kind: DeliveryReceiptKind,
  timestampLabel: string,
  language: Language,
): string {
  if (language === "en") {
    return `${kind === "file" ? "File" : "Message"} delivered, delivery receipt: ${timestampLabel}`;
  }
  return `${kind === "file" ? "Файл получен" : "Сообщение получено"}, отчёт о доставке: ${timestampLabel}`;
}

const stableErrorMessages: Readonly<Record<string, LocalizedText>> = {
  ACTIVE_PROFILE_LOCKED: { ru: "Активный профиль заблокирован.", en: "The active profile is locked." },
  ACTIVE_PROFILE_NOT_REGISTERED: { ru: "Активный профиль не зарегистрирован.", en: "The active profile is not registered." },
  NO_ACTIVE_PROFILE: { ru: "Активный профиль не выбран.", en: "No active profile is selected." },
  PROFILE_ACTION_BUSY: { ru: "Дождитесь завершения текущего действия с профилем.", en: "Wait for the current profile action to finish." },
  PROFILE_ALREADY_DISABLED: { ru: "Профиль уже отключён.", en: "The profile is already disabled." },
  PROFILE_DISABLED_REIMPORT_REQUIRED: { ru: "Профиль отключён; для повторного добавления импортируйте его снова.", en: "The profile is disabled; import it again to add it back." },
  PROFILE_LOCKED: { ru: "Профиль заблокирован.", en: "The profile is locked." },
  PROFILE_NOT_FOUND: { ru: "Профиль не найден.", en: "The profile was not found." },
  PROFILE_PASSWORD_INVALID: { ru: "Неверный пароль.", en: "Incorrect password." },
  PROFILE_PASSWORD_REQUIRED: { ru: "Требуется пароль профиля.", en: "The profile password is required." },
  QTOX_PROFILE_ALREADY_IMPORTED: { ru: "Этот профиль qTox уже импортирован.", en: "This qTox profile has already been imported." },
  TOX_PROFILE_IDENTITY_ALREADY_LOADED: {
    ru: "Профиль с тем же Tox ID уже подключён. Одновременный запуск копий одной Tox-идентичности приводит к подмене имени и состояния контакта.",
    en: "A profile with the same Tox ID is already connected. Running copies of one Tox identity at the same time makes its contact name and presence replace each other.",
  },
  QTOX_PROFILE_NOT_FOUND: { ru: "Профиль qTox не найден.", en: "The qTox profile was not found." },
  UNSUPPORTED_LANGUAGE: { ru: "Выбранный язык не поддерживается.", en: "The selected language is not supported." },
};

function errorText(error: unknown): string {
  if (typeof error === "string") return error.trim();
  if (error instanceof Error) return error.message.trim();
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code.trim();
  return String(error ?? "").trim();
}

export function formatUserFacingError(error: unknown, fallback: LocalizedText, language: Language): string {
  const raw = errorText(error);
  const known = stableErrorMessages[raw];
  if (known) return localized(known, language);
  if (language === "en" || !raw) return fallback[language];
  return `${fallback.ru}: ${raw}`;
}

export function formatFriendRequestDefault(language: Language): string {
  return language === "en" ? "Hello! Please add me." : "Привет! Добавь меня, пожалуйста.";
}
