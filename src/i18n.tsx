import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";

export type Language = "ru" | "en";

const english: Record<string, string> = {
  "Настройки": "Settings",
  "Локальный профиль и клиент": "Active profile and client",
  "Профиль": "Profile",
  "Управление профилями": "Profile management",
  "Чаты": "Chats",
  "Групповой чат": "Group chat",
  "Групповой чат — скоро": "Group chat — coming soon",
  "Приватность": "Privacy",
  "Сеть Tox": "Tox network",
  "Tor и мосты": "Tor and bridges",
  "Файлы": "Files",
  "Уведомления": "Notifications",
  "Расширенные": "Advanced",
  "О программе": "About",
  "Язык": "Language",
  "Русский": "Russian",
  "Английский": "English",
  "Сохранить": "Save",
  "Отмена": "Cancel",
  "Удалить": "Delete",
  "Закрыть": "Close",
  "Выход": "Exit",
  "Повторить": "Retry",
  "Продолжить": "Resume",
  "Пауза": "Pause",
  "Отменить": "Cancel",
  "Принять": "Accept",
  "Загрузка…": "Loading…",
  "Подключение…": "Connecting…",
  "Подключение к Tor…": "Connecting to Tor…",
  "В сети": "Online",
  "Онлайн": "Online",
  "Отошёл": "Away",
  "Занят": "Busy",
  "Отключен": "Offline",
  "Подключен": "Connected",
  "Не в сети": "Offline",
  "данных нет": "no data",
  "сегодня": "today",
  "вчера": "yesterday",
  "Сегодня": "Today",
  "Вчера": "Yesterday",
  "Контакты": "Contacts",
  "Порядок и видимость контактов": "Contact order and visibility",
  "Сортировка по событиям: новые сначала": "Sorted by activity: newest first",
  "Сортировка по событиям: старые сначала": "Sorted by activity: oldest first",
  "Сортировать по событиям: новые сначала": "Sort by activity: newest first",
  "Сортировка по статусу: онлайн сначала": "Sorted by status: online first",
  "Сортировка по статусу: отключённые сначала": "Sorted by status: offline first",
  "Сортировать по статусу: онлайн сначала": "Sort by status: online first",
  "Скрыть отключённые контакты": "Hide offline contacts",
  "Показать отключённые контакты": "Show offline contacts",
  "Выберите контакт": "Select a contact",
  "Сообщение…": "Message…",
  "Отправить": "Send",
  "Прикрепить файл": "Attach file",
  "Редактирование текста": "Edit text",
  "Отменить действие": "Undo",
  "Повторить действие": "Redo",
  "Выделить всё": "Select all",
  "Не удалось получить доступ к буферу обмена": "Could not access the clipboard",
  "Форматирование текста": "Text formatting",
  "Жирный": "Bold",
  "Подчёркнутый": "Underline",
  "Курсив": "Italic",
  "Зачёркнутый": "Strikethrough",
  "Цитата": "Quote",
  "Перейти к цитируемому сообщению": "Go to quoted message",
  "Отменить цитирование": "Cancel reply",
  "Нравится": "Like",
  "Не нравится": "Dislike",
  "Радость": "Happy",
  "Грусть": "Sad",
  "Сердце": "Heart",
  "Ракета": "Rocket",
  "Добавить реакцию": "Add reaction",
  "Выберите реакцию": "Choose a reaction",
  "Можно выбрать не более трёх реакций": "You can select up to three reactions",
  "Реакцию на это сообщение уже нельзя изменить": "This message's reaction can no longer be changed",
  "Реакция отправляется": "Sending reaction",
  "Реакция не доставлена": "Reaction was not delivered",
  "Собеседник убрал реакцию": "The contact removed a reaction",
  "Получена реакция вне видимой области": "A reaction was received outside the visible area",
  "Показать сообщение": "Show message",
  "Поиск": "Search",
  "Поиск в чате": "Search this chat",
  "Закрыть поиск": "Close search",
  "Предыдущее совпадение": "Previous match",
  "Следующее совпадение": "Next match",
  "Информация": "Information",
  "Меню": "Menu",
  "Новое непрочитанное сообщение": "New unread message",
  "Совпадений не найдено": "No matches found",
  "Новые сообщения": "New messages",
  "В конец": "To latest",
  "Ожидает отправки": "Waiting to send",
  "Постквантовое шифрование активно": "Post-quantum encryption is active",
  "защищённый чат E2EE": "secure E2EE chat",
  "защищённый чат E2EE (пост-квантовое шифрование)": "secure E2EE chat (post-quantum encryption)",
  "PQ активно": "PQ active",
  "Принять PQ": "Accept PQ",
  "PQ предложено": "PQ offered",
  "Согласование PQ…": "Negotiating PQ…",
  "Включить PQ": "Enable PQ",
  "Отозвать предложение PQ": "Withdraw PQ offer",
  "Отменить PQ": "Turn off PQ",
  "Инициация PQ": "Starting PQ",
  "Отключение PQ…": "Turning off PQ…",
  "Дополнительная случайность для нового PQ-ключа": "Additional randomness for the new PQ key",
  "Проведите курсором или пальцем по созвездию. Системный генератор уже защищает ключ; движения добавятся как дополнительный шум.": "Move the pointer or your finger through the constellation. The system generator already protects the key; your movements are added as extra noise.",
  "Созвездие для дополнительной случайности": "Constellation for additional randomness",
  "Не удалось передать дополнительный шум. Повторите или используйте системную случайность.": "The additional noise could not be submitted. Retry or use system randomness.",
  "Подготавливаем новый PQ-ключ…": "Preparing the new PQ key…",
  "Движения добавляются только локально": "Movements are added locally only",
  "Ключ будет создан автоматически через несколько секунд.": "The key will be created automatically in a few seconds.",
  "Только системная случайность": "Use system randomness only",
  "Проверяем поддержку PQ…": "Checking PQ support…",
  "Согласование PQ остановлено": "PQ negotiation stopped",
  "Сообщения ожидают. Включите PQ в меню чата или продолжите без него.": "Messages are waiting. Enable PQ in the chat menu or continue without it.",
  "Клиент собеседника остановил согласование PQ. Сообщения ожидают: включите PQ в меню чата или продолжите без него.": "The peer's client stopped PQ negotiation. Messages are waiting: enable PQ in the chat menu or continue without it.",
  "Согласование PQ остановлено. Сообщения ожидают: включите PQ в меню чата или продолжите без него.": "PQ negotiation stopped. Messages are waiting: enable PQ in the chat menu or continue without it.",
  "Сообщения сохранены и ждут ответа клиента. Продолжение без PQ отключит автоматическое включение PQ для этого контакта.": "Messages are saved and waiting for the client to reply. Continuing without PQ disables automatic PQ setup for this contact.",
  "Продолжить без PQ": "Continue without PQ",
  "Подождите…": "Please wait…",
  "Не удалось применить выбор. Повторите.": "The choice could not be applied. Try again.",
  "Согласование PQ уже выполняется. Сообщение сохранено и будет отправлено после завершения.": "PQ negotiation is already in progress. The message is saved and will be sent when it finishes.",
  "PQ-идентичность контакта изменилась. Сверьте отпечаток перед продолжением.": "The contact's PQ identity changed. Verify the fingerprint before continuing.",
  "Очередь защищённых сообщений временно заполнена. Сообщение сохранено локально и будет повторно отправлено.": "The protected-message queue is temporarily full. The message is saved locally and will be retried.",
  "Сообщение сохранено и ждёт завершения согласования защищённой сессии.": "The message is saved and waiting for secure-session negotiation to finish.",
  "Переименовать контакт": "Rename contact",
  "Экспорт истории чата": "Export chat history",
  "Очистить историю чата": "Clear chat history",
  "Удалить контакт": "Delete contact",
  "Постквантовый слой": "Post-quantum layer",
  "Ваш отпечаток": "Your fingerprint",
  "Отпечаток контакта": "Contact fingerprint",
  "Принять и сохранить отпечаток": "Accept and save fingerprint",
  "Выключить PQ для этого сеанса": "Disable PQ for this session",
  "Последний онлайн:": "Last online:",
  "Отправить запрос на переписку": "Send chat request",
  "Сообщение для авторизации": "Authorization message",
  "76 символов": "76 characters",
  "Исходящие запросы доступны в разделе «Запросы на переписку».": "Outgoing requests are available under “Chat requests”.",
  "Отправить запрос": "Send request",
  "Запросы на переписку": "Chat requests",
  "Входящие": "Incoming",
  "Исходящие": "Outgoing",
  "Без сообщения": "No message",
  "Входящих запросов нет.": "No incoming requests.",
  "Исходящих запросов нет.": "No outgoing requests.",
  "Ожидает авторизации": "Waiting for authorization",
  "Отменить запрос": "Cancel request",
  "Отпустите файл, чтобы отправить его в чат": "Drop the file to send it to the chat",
  "Подтверждение отправки файла": "Confirm file send",
  "Подтверждение отправки файлов": "Confirm file send",
  "Отправить файл?": "Send this file?",
  "Отправить файлы": "Send files",
  "Не удалось добавить в очередь:": "Could not add to the queue:",
  "Полноразмерное изображение": "Full-size image",
  "Открыть изображение": "Open image",
  "Закрыть просмотр изображения": "Close image viewer",
  "Изображение ещё передаётся": "Image is still transferring",
  "Выберите контакт из списка или добавьте новый по Tox ID.": "Select a contact or add a new one by Tox ID.",
  "Ваша личность": "Your identity",
  "Эти данные передаются только выбранным контактам через сеть Tox.": "This information is shared only with selected contacts over the Tox network.",
  "Ваш аватар": "Your avatar",
  "Загрузить аватар": "Upload avatar",
  "Выбрать аватар": "Choose avatar",
  "Изображения": "Images",
  "Не удалось установить аватар": "Could not set the avatar",
  "Размер выбранного аватара недопустим": "The selected avatar has an invalid size",
  "Ник": "Nickname",
  "Публичный идентификатор. Его можно безопасно передавать для добавления в контакты.": "Public identifier. It can be safely shared so others can add you.",
  "Активный профиль": "Active profile",
  "Активный": "Active",
  "Доступные профили": "Available profiles",
  "Создание, импорт, подключение и отключение профилей.": "Create, import, connect, and disconnect profiles.",
  "Имя файла профиля": "Profile file name",
  "Установить пароль": "Set password",
  "Снять пароль": "Remove password",
  "Введите новый пароль": "Enter a new password",
  "Установка пароля. Пожалуйста, подождите…": "Setting the password. Please wait…",
  "Снятие пароля. Пожалуйста, подождите…": "Removing the password. Please wait…",
  "Пароль успешно установлен.": "Password set successfully.",
  "Пароль успешно снят.": "Password removed successfully.",
  "Уничтожить активный профиль": "Destroy active profile",
  "Сообщения": "Messages",
  "Отправлять по Enter": "Send with Enter",
  "Shift + Enter добавляет новую строку.": "Shift + Enter inserts a new line.",
  "Enter добавляет новую строку, Shift + Enter отправляет сообщение.": "Enter inserts a new line; Shift + Enter sends.",
  "Показывать время сообщений": "Show message times",
  "Показывать подтверждения доставки": "Show delivery receipts",
  "Оформление": "Appearance",
  "Шрифт интерфейса": "Interface font",
  "Размер шрифта интерфейса": "Interface font size",
  "Шрифт чата": "Chat font",
  "Размер шрифта чата": "Chat font size",
  "Буквенные заглушки": "Letter placeholders",
  "Шрифт буквенных заглушек": "Placeholder font",
  "Размер шрифта буквенных заглушек": "Placeholder font size",
  "Три пары настроек шрифта применяются независимо после сохранения.": "The three font and size pairs apply independently after saving.",
  "Тема применяется сразу. Три пары настроек шрифта применяются независимо после сохранения.": "The theme applies immediately. The three font and size pairs apply independently after saving.",
  "Шрифт сообщений": "Message font",
  "Размер текста сообщений": "Message text size",
  "Проверка орфографии": "Spell checking",
  "Проверять орфографию": "Check spelling",
  "Для проверки используются словари Firefox.": "Firefox dictionaries are used for spell checking.",
  "Добавить свой язык": "Add custom language",
  "Название языка": "Language name",
  "Словарь": "Dictionary",
  "Видимость": "Visibility",
  "Показывать статус «печатает…»": "Show typing status",

  "История": "History",
  "Сохранять историю чатов": "Save chat history",
  "История сообщений хранится локально на этом устройстве.": "Message history is stored locally on this device.",
  "Очищать буфер обмена после копирования Tox ID": "Clear clipboard after copying a Tox ID",
  "Очистить всю локальную историю": "Clear all local history",
  "Постквантовое шифрование": "Post-quantum encryption",
  "Гибридный режим готов": "Hybrid mode is ready",
  "Ваш отпечаток ML-KEM-768": "Your ML-KEM-768 fingerprint",
  "Подключение": "Connection",
  "Подключаться к сети при запуске": "Connect to the network on startup",
  "Использовать UDP": "Use UDP",
  "Использовать IPv6": "Use IPv6",
  "Обнаруживать локальных пиров": "Discover local peers",
  "Узел bootstrap": "Bootstrap node",
  "Добавить узел": "Add node",
  "Сбросить список": "Reset list",
  "Прокси": "Proxy",
  "Режим прокси": "Proxy mode",
  "Не использовать": "Do not use",
  "Встроенный Tor SOCKS5": "Built-in Tor SOCKS5",
  "Tor-режим": "Tor mode",
  "Включить Tor": "Enable Tor",
  "Запретить прямое подключение при ошибке Tor": "Block direct connections when Tor fails",
  "Перезапустить и проверить Tor": "Restart and test Tor",
  "Мосты": "Bridges",
  "Тип подключения": "Connection type",
  "Без мостов": "No bridges",
  "Встроенный Snowflake": "Built-in Snowflake",
  "Встроенный obfs4": "Built-in obfs4",
  "Свои мосты": "Custom bridges",
  "Применить и перезапустить Tor": "Apply and restart Tor",
  "Папка загрузок": "Downloads folder",
  "Получение": "Receiving",
  "Автоматически принимать изображения": "Automatically accept images",
  "Включено: автоматически принимаются PNG и JPG/JPEG в пределах лимита размера.": "Enabled: PNG and JPG/JPEG files within the size limit are accepted automatically.",
  "Отключено: для каждого входящего PNG или JPG/JPEG потребуется подтверждение.": "Disabled: every incoming PNG or JPG/JPEG file requires confirmation.",
  "Показывать изображения в окне чата": "Show images in chat",
  "Автоматически принимать любые файлы от контактов": "Automatically accept any files from contacts",
  "Полный запрет приёма файлов": "Block all incoming files",
  "Лимит автоматического приёма": "Automatic acceptance limit",
  "Одновременный приём файлов": "Concurrent incoming files",
  "Передача": "Transfer",
  "Продолжать передачи после перезапуска": "Resume transfers after restart",
  "Показывать скорость передачи": "Show transfer speed",
  "События": "Events",
  "Уведомления о новых сообщениях": "New message notifications",
  "Уведомления о запросах в друзья": "Chat request notifications",
  "Масштаб интерфейса": "Interface scale",
  "Масштаб": "Scale",
  "Диагностика": "Diagnostics",
  "Вести журнал работы сети": "Log network activity",
  "Включить подробный журнал Tor": "Enable verbose Tor log",
  "Открыть папку журналов": "Open logs folder",
  "Совместимость": "Compatibility",
  "Разрешать сообщения от обычных клиентов Tox": "Allow messages from standard Tox clients",
  "Отправлять сообщения в PQ-контакт только с PQ-слоем": "Send to PQ contacts only with the PQ layer",
  "Сбросить сетевые настройки": "Reset network settings",
  "Версии": "Versions",
  "Приложение": "Application",
  "Интерфейс": "Interface",
  "Сетевой слой": "Network layer",
  "Открыть лицензионные сведения": "Open license information",
  "Версии и компоненты": "Versions and components",
  "Kaigen — независимый кроссплатформенный Tox-мессенджер с опциональным постквантовым слоем.": "Kaigen is an independent cross-platform Tox messenger with an optional post-quantum layer.",
  "Криптография": "Cryptography",
  "Проект": "Project",
  "Исходный код, инструкции по сборке и готовые выпуски Kaigen опубликованы в репозитории проекта.": "Kaigen source code, build instructions, and ready-to-run releases are published in the project repository.",
  "Открыть репозиторий Kaigen": "Open the Kaigen repository",
  "Поддержать проект": "Support the project",
  "Если Kaigen оказался полезен, вы можете поддержать дальнейшую разработку.": "If you find Kaigen useful, you can support its continued development.",
  "Скопировано": "Copied",
  "Настройки сохранены": "Settings saved",
  "Изменения сохраняются локально": "Changes are saved locally",
  "Системный трей": "System tray",
  "При закрытии сворачивать в системный трей": "Minimize to the system tray when closing",
  "Добавить профиль": "Add profile",
  "Подключить": "Connect",
  "Удалить профиль из списка": "Remove profile from the list",
  "Импортировать профиль": "Import profile",
  "Экспорт qTox (.zip)": "Export qTox (.zip)",
  "Экспорт профиля для qTox": "Export profile for qTox",
  "ZIP-архив содержит совместимый файл .tox и аватары без контейнера .kai. Для защищённого профиля используется его текущий пароль.": "The ZIP archive contains a compatible .tox file and avatars without the .kai container. A protected profile uses its current password.",
  "Текущий пароль профиля": "Current profile password",
  "Сохранить ZIP": "Save ZIP",
  "Найденные профили qTox": "Discovered qTox profiles",
  "Подходящие профили не найдены или уже импортированы.": "No suitable profiles were found, or they have already been imported.",
  "Пароль профиля": "Profile password",
  "Пароль (необязательно)": "Password (optional)",
  "Файл истории qTox (необязательно)": "qTox history file (optional)",
  "Импортировать этот профиль": "Import this profile",
  "вместе с историей": "with history",
  "Создать профиль": "Create profile",
  "Создать новый профиль": "Create a new profile",
  "Новый профиль": "New profile",
  "Имя профиля": "Profile name",
  "Защитить профиль паролем": "Protect profile with a password",
  "Пароль": "Password",
  "Повторите пароль": "Repeat password",
  "Текущий пароль": "Current password",
  "Новый пароль": "New password",
  "Пароли не совпадают": "Passwords do not match",
  "Неверный пароль": "Incorrect password",
  "Неверный пароль или профиль повреждён": "Incorrect password or damaged profile",
  "Неверный пароль. Повторите ввод или пропустите этот профиль.": "Incorrect password. Try again or skip this profile.",
  "Без этого пароля восстановить профиль будет невозможно.": "The profile cannot be recovered without this password.",
  "Подключение профилей": "Connect profiles",
  "Открыть": "Unlock",
  "Введите пароли только для тех профилей, которые хотите подключить сейчас.": "Enter passwords only for the profiles you want to connect now.",
  "Добавить ещё один профиль": "Add another profile",
  "Вернуться к подключению профилей": "Back to profile connection",
  "Продолжить с открытыми профилями": "Continue with unlocked profiles",
  "разблокировано": "Unlocked",
  "Отключить профиль": "Disable profile",
  "Не удалось отключить профиль": "Could not disable profile",
  "Закрыть приложение": "Close application",
  "Уничтожить профиль": "Destroy profile",
  "Уничтожить профиль?": "Destroy profile?",
  "Управление активным профилем": "Manage active profile",
  "все его локальные данные будут безвозвратно удалены.": "all of its local data will be permanently deleted.",
  "Не удалось уничтожить профиль": "Could not destroy profile",
  "Пропустить и вернуться": "Skip and return",
  "Добро пожаловать в Kaigen": "Welcome to Kaigen",
  "Выберите, что вы хотите сделать для начала работы": "Choose how you want to get started",
  "Начните с чистого листа. Создайте новый профиль и настройте свой аккаунт.": "Start fresh by creating and configuring a new profile.",
  "Импортировать из qTox": "Import from qTox",
  "Импорт из qTox": "Import from qTox",
  "Импортировать": "Import",
  "Перенесите контакты и историю сообщений из существующего qTox-профиля.": "Transfer contacts and message history from an existing qTox profile.",
  "Нажмите «Найти», чтобы проверить стандартную папку qTox, или выберите каталог портативной копии.": "Select Find to check the standard qTox folder, or choose the folder of a portable copy.",
  "Поиск начнётся только после вашего действия.": "The search starts only after you choose to run it.",
  "Поиск профилей qTox. Пожалуйста, подождите…": "Searching for qTox profiles. Please wait…",
  "Папка портативного qTox": "Portable qTox folder",
  "Выберите папку qTox или portable qTox": "Select the qTox or portable qTox folder",
  "Выберите базу истории qTox": "Select the qTox history database",
  "Обзор…": "Browse…",
  "Найти": "Find",
  "История найдена": "History found",
  "История не найдена": "History not found",
  "Файл истории (необязательно)": "History file (optional)",
  "Профили qTox не найдены. Укажите папку вручную или создайте новый профиль.": "No qTox profiles were found. Select a folder manually or create a new profile.",
  "Назад": "Back",
  "Создание…": "Creating…",
  "Все данные хранятся рядом с программой. Сетевой маршрут может быть защищён встроенным Tor, а сообщения — дополнительным постквантовым слоем.": "All data is stored beside the application. The network route can use built-in Tor, while messages can use an additional post-quantum layer.",
  "Удаление профиля": "Profile deletion",
  "Подтвердить уничтожение": "Confirm destruction",
  "Применить": "Apply",
  "Полная загрузка длинной переписки может заметно увеличить расход оперативной памяти. Экспорт истории всегда остаётся полным при любом выбранном лимите.": "Loading a long conversation in full may noticeably increase memory use. History export is always complete regardless of this limit.",
  "Время сообщений и подтверждения доставки показываются всегда.": "Message times and delivery receipts are always shown.",
  "Сообщений при открытии чата": "Messages loaded when opening a chat",
  "500 (по умолчанию)": "500 (default)",
  "Вся история": "All history",
  "Выбранный объём загружается при открытии чата. При достижении начала история последовательно догружается до 500, 1000 и затем полностью; спустя 2 часа без открытого чата она выгружается из памяти.": "The selected amount loads when the chat opens. Reaching the beginning progressively loads 500, 1,000 and then the full history; after two hours without an open chat it is unloaded from memory.",
  "Все сообщения (повышенный расход памяти)": "All messages (higher memory use)",
  "После сохранения шрифт и размер применяются к сообщениям и полю ввода открытого чата.": "After saving, the font and size are applied to messages and the composer.",
  "Используются встроенные portable-словари Hunspell; настройка действует только для активного профиля.": "Built-in portable Hunspell dictionaries are used; this setting belongs to the active profile.",
  "Не выбран ни один словарь — проверка фактически отключена.": "No dictionary is selected, so spell checking is effectively disabled.",
  "Предложения проверки орфографии": "Spelling suggestions",
  "возможно, опечатка": "possibly misspelled",
  "История сообщений хранится локально в каталоге активного portable-профиля.": "Message history is stored locally in the active portable profile folder.",
  "Очистить историю": "Clear history",
  "Будет удалена вся история активного профиля. Контакты и остальные профили не изменятся.": "All history for the active profile will be deleted. Contacts and other profiles will not be changed.",
  "Настройки защиты профиля и дополнительного постквантового слоя.": "Profile protection and additional post-quantum layer settings.",
  "Клиенты узнают друг друга служебным Tox-пакетом, не используя пользовательский статус. PQ включается отдельно для каждого контакта из заголовка чата.": "Clients identify each other with a service Tox packet without using the user status. PQ is enabled per contact from the chat header.",
  "Сверяйте отпечатки с собеседником по независимому каналу перед доверием новому или изменившемуся ключу.": "Compare fingerprints over an independent channel before trusting a new or changed key.",
  "После взаимного согласия сообщения получают дополнительный слой ML-KEM-768, HKDF-SHA-256 и AES-256-GCM поверх стандартного Tox E2EE.": "After mutual consent, messages receive an ML-KEM-768, HKDF-SHA-256 and AES-256-GCM layer over standard Tox E2EE.",
  "Подключение к распределённой сети, DHT и bootstrap-узлам.": "Connection to the distributed network, DHT and bootstrap nodes.",
  "Отключено: Kaigen использует TCP-маршрут, совместимый с Tor и прокси.": "Disabled: Kaigen uses a TCP route compatible with Tor and proxies.",
  "Отключено для предсказуемого portable-маршрута.": "Disabled for a predictable portable network route.",
  "Отключено, чтобы исключить обход выбранного прокси или Tor.": "Disabled to prevent bypassing the selected proxy or Tor.",
  "Отключено: используется TCP-маршрут.": "Disabled: the TCP route is used.",
  "Включено для прямого подключения. При Tor или прокси toxcore автоматически использует TCP.": "Enabled for direct connections. With Tor or a proxy, toxcore automatically uses TCP.",
  "Отключено: toxcore использует IPv4.": "Disabled: toxcore uses IPv4.",
  "Включено: toxcore использует IPv4 и IPv6.": "Enabled: toxcore uses IPv4 and IPv6.",
  "Отключено.": "Disabled.",
  "Включено вместе с UDP. При Tor или прокси локальное обнаружение не используется.": "Enabled together with UDP. Local discovery is not used with Tor or a proxy.",
  "Применение сетевых параметров ко всем профилям…": "Applying network settings to all profiles…",
  "Сетевые параметры применены ко всем профилям.": "Network settings were applied to all profiles.",
  "Настройки общие для всех профилей. Все разблокированные профили подключаются одновременно и остаются в сети в фоне.": "Settings are shared by all profiles. All unlocked profiles connect simultaneously and stay online in the background.",
  "Один Tox-профиль нельзя одновременно запускать в нескольких экземплярах: копии имеют один Tox ID, поэтому имя и состояние такого контакта будут сменять друг друга.": "Do not run one Tox profile in multiple app instances at the same time: the copies share one Tox ID, so that contact's name and presence will replace each other.",
  "Прокси отключён. Применяются общие параметры прямого подключения Tox.": "The proxy is disabled. Shared direct Tox connection settings are used.",
  "Общие настройки прокси применены ко всем профилям. Прямой fallback запрещён.": "Shared proxy settings were applied to all profiles. Direct fallback is blocked.",
  "Активный профиль подключается при запуске, если пользователь не отключил его через статус «Отключиться от сети».": "The active profile connects at startup unless it was explicitly disconnected using the Offline status.",
  "При включённом Tor пользовательский прокси сохраняется, но не используется: маршрут Tox идёт только через SOCKS5 встроенного Tor. Для SOCKS5 и HTTP с логином Kaigen поднимает локальный адаптер авторизации; прямой fallback запрещён.": "When Tor is enabled, the custom proxy is retained but not used: Tox is routed only through built-in Tor SOCKS5. For authenticated SOCKS5 and HTTP, Kaigen runs a local authentication adapter; direct fallback is blocked.",
  "Адрес сервера": "Server address",
  "Порт": "Port",
  "Логин (необязательно)": "Username (optional)",
  "Проверить прокси": "Test proxy",
  "Проверка…": "Testing…",
  "Проверка подключения…": "Testing connection…",
  "Настройки прокси применены. Kill switch активен: прямой fallback запрещён.": "Proxy settings applied. Kill switch is active: direct fallback is blocked.",
  "Анонимный режим с отдельным процессом Tor Expert Bundle.": "Anonymous mode using a dedicated Tor Expert Bundle process.",
  "Запускает встроенный Tor и направляет Tox только через его SOCKS5-прокси.": "Starts built-in Tor and routes Tox only through its SOCKS5 proxy.",
  "Kill switch обязателен: при остановке или ошибке Tor сеть Tox остаётся без маршрута.": "The kill switch is mandatory: if Tor stops or fails, Tox remains without a route.",
  "SOCKS-адрес": "SOCKS address",
  "SOCKS-порт (динамический)": "SOCKS port (dynamic)",
  "Control-адрес": "Control address",
  "Control-порт (динамический)": "Control port (dynamic)",
  "запуск": "starting",
  "выключено": "disabled",
  "подключено, маршрут защищён": "connected, route protected",
  "ошибка": "error",
  "Запуск встроенного Tor": "Starting built-in Tor",
  "Запуск Tor": "Starting Tor",
  "Перезапуск Tor": "Restarting Tor",
  "Строки мостов (любой поддерживаемый тип, включая WebTunnel)": "Bridge lines (any supported type, including WebTunnel)",
  "Одна строка моста на строку": "One bridge per line",
  "Выбранный транспорт:": "Selected transport:",
  "без мостов": "no bridges",
  "Передача файлов между контактами напрямую через сеть Tox.": "File transfers between contacts over the Tox network.",
  "Перекрывает все настройки автоматического приёма и отклоняет входящие файлы.": "Overrides all automatic acceptance settings and rejects incoming files.",
  "Приём файлов запрещён настройками.": "File reception is disabled in settings.",
  "Автоматически принимаются PNG и JPG/JPEG в пределах лимита размера.": "PNG and JPG/JPEG files are accepted automatically within the size limit.",
  "Для каждого входящего PNG или JPG потребуется подтверждение.": "Each incoming PNG or JPG requires confirmation.",
  "Если выключено, вместо изображения отображается нейтральная плашка с кнопкой показа.": "When disabled, a neutral card with a Show button is displayed instead of the image.",
  "Лимит автоматического приёма, МБ": "Automatic acceptance limit, MB",
  "Протокол Tox передаёт размер как 64-битное значение; интерфейс ограничивает ввод безопасным целым JavaScript.": "Tox uses a 64-bit file size; the interface limits input to a JavaScript safe integer.",
  "Общий лимит одного файла — 25 МБ.": "The total limit for one file is 25 MB.",
  "Очередь исходящих файлов сохраняется между запусками. Скорость и прогресс активной передачи показываются в карточке файла; входящая передача после разрыва запускается отправителем заново, поскольку протокол Tox не поддерживает продолжение между сеансами.": "The outgoing queue is retained between runs. Speed and progress are shown on the file card; after a disconnect, an incoming transfer must be restarted by the sender because Tox cannot resume it across sessions.",
  "Оповещения не изменяют сетевые или криптографические настройки.": "Notifications do not change network or cryptographic settings.",
  "Показываются четыре секунды; нажатие открывает нужный профиль и чат.": "Shown for four seconds; clicking opens the relevant profile and chat.",
  "В заголовке всегда указывается профиль, в котором произошло событие.": "The title always names the profile where the event occurred.",
  "Язык интерфейса": "Interface language",
  "Язык меняется сразу во всём приложении, включая меню, подсказки и системный трей.": "The language changes immediately throughout the application, including menus, tooltips and the system tray.",
  "Если выключено, кнопка закрытия завершает Kaigen.": "When disabled, the close button exits Kaigen.",
  "Меняй эти параметры только если понимаешь их влияние на сеть и приватность.": "Change these options only if you understand their effect on networking and privacy.",
  "После сохранения масштаб применяется ко всему окну приложения.": "After saving, the scale is applied to the entire application window.",
  "Сетевые события, передачи файлов и журнал встроенного Tor автоматически записываются в каталог активного portable-профиля. Секреты, тексты сообщений и содержимое файлов в журнал не попадают.": "Network events, file transfers and the built-in Tor log are written automatically to the active portable profile folder. Secrets, message text and file contents are not logged.",
  "Обычные клиенты Tox поддерживаются всегда. После согласования PQ сообщения этому контакту автоматически получают дополнительный постквантовый слой; до согласования используется стандартное Tox E2EE.": "Standard Tox clients are always supported. After PQ negotiation, messages to that contact automatically receive the additional post-quantum layer; standard Tox E2EE is used before negotiation.",
  "Разделы настроек": "Settings sections",
  "Навигация": "Navigation",
  "Добавить в контакты": "Add contact",
  "Открыть настройки профиля": "Open profile settings",
  "Отключиться от сети": "Disconnect from network",
  "Отключено от сети Tox": "Disconnected from the Tox network",
  "Подключение к сети Tox…": "Connecting to the Tox network…",
  "Открыть папку загрузок": "Open downloads folder",
  "Ваш Tox ID:": "Your Tox ID:",
  "Ваш статус:": "Your status:",
  "Ваш статус Tox": "Your Tox status",
  "Изменить статус": "Edit status",
  "фильтр контакт-листа": "filter contacts",
  "Фильтр контакт-листа": "Filter contacts",
  "Сбросить фильтр": "Clear filter",
  "Новые непрочитанные сообщения": "New unread messages",
  "Скопировать полный Tox ID": "Copy full Tox ID",
  "Копировать": "Copy",
  "Вставить": "Paste",
  "Вырезать": "Cut",
  "Скопировать": "Copy",
  "Скопировать ссылку": "Copy link",
  "Скопировать изображение": "Copy image",
  "Скопировать файл": "Copy file",
  "Показать в папке": "Show in folder",
  "Изображение скопировано в буфер обмена": "Image copied to clipboard",
  "Файл скопирован в буфер обмена": "File copied to clipboard",
  "Не удалось показать файл в папке": "Could not show the file in its folder",
  "Не удалось скопировать изображение": "Could not copy the image",
  "Не удалось скопировать файл": "Could not copy the file",
  "Скопировано в буфер обмена": "Copied to clipboard",
  "Tox ID скопирован в буфер обмена": "Tox ID copied to clipboard",
  "Удалить контакт?": "Delete contact?",
  "Изменить ширину списка контактов": "Resize contact list",
  "Принять файл": "Accept file",
  "Изображение скрыто настройками приватности": "Image hidden by privacy settings",
  "Восстановление изображения…": "Restoring image…",
  "Показать": "Show",
  "Повторить показ": "Retry preview",
  "Передача не завершена": "Transfer incomplete",
  "Ожидание подтверждения": "Awaiting confirmation",
  "Отправка файла": "Sending file",
  "Получение файла": "Receiving file",
  "Передача приостановлена": "Transfer paused",
  "Получение приостановлено": "Receiving paused",
  "Передача отменена": "Transfer cancelled",
  "Получение отменено": "Receiving cancelled",
  "Ошибка передачи": "Transfer error",
  "Отправка": "Sending",
  "Вложение": "Attachment",
  "Файл": "File",
  "оценка времени…": "estimating time…",
  "Файл отправлен, ожидается подтверждение получателя": "File sent, awaiting recipient confirmation",
  "Файл ожидает вашего подтверждения": "File awaiting your confirmation",
  "Перейти к последнему сообщению": "Jump to latest message",
  "↓ Новые сообщения": "↓ New messages",
  "Контакт предлагает включить постквантовое шифрование": "Contact offers to enable post-quantum encryption",
  "Предложение постквантового шифрования": "Post-quantum encryption offer",
  "Отказаться": "Decline",
  "Поддержка подтверждена; можно начать согласование": "Support confirmed; negotiation can begin",
  "Ожидается завершение взаимного согласования": "Waiting for mutual negotiation to complete",
  "Внимание: PQ-отпечаток контакта изменился. Сверьте его по независимому каналу.": "Warning: the contact's PQ fingerprint changed. Verify it over an independent channel.",
  "Активен: ML-KEM-768 + AES-256-GCM поверх Tox E2EE": "Active: ML-KEM-768 + AES-256-GCM over Tox E2EE",
  "Загрузка Tox ID": "Loading Tox ID",
  "загрузка…": "loading…",
  "Отключено от сети": "Disconnected",
  "Онлайн — подключено к сети": "Online — connected",
  "сейчас в сети": "online now",
  "0 Б": "0 B",
  "Поведение диалогов, групп и оформления сообщений.": "Chat, group and message appearance behavior.",
  "Управляй информацией, которую видят собеседники.": "Manage the information visible to your contacts.",
  "Tox PQ Client — независимый клиент сети Tox.": "Kaigen is an independent client for the Tox network.",
  "Динамический порт": "Dynamic port",
  "В сети Tox": "Online on Tox",
  "Tor выключен пользователем": "Tor was disabled by the user",
  "маршрут недоступен": "route unavailable",
  "ожидание": "waiting",
  "защищён паролем": "password protected",
  "Контакт": "Contact",
  "новое сообщение": "new message",
  "Сообщение получено": "Message received",
  "Файл получен": "File received",
  "Файл отправлен": "File sent",
  "Запрос авторизации отправлен. Контакт появится после ответа.": "Authorization request sent. The contact will appear after they accept it.",
  "Привет! Добавь меня, пожалуйста.": "Hello! Please add me.",
  "Не удалось подготовить файл для отправки": "Could not prepare the file for sending",
  "Не удалось отправить аватар": "Could not send the avatar",
  "Не удалось загрузить локальные данные": "Could not load local data",
  "Не удалось сохранить локальные данные": "Could not save local data",
  "Не удалось применить настройку истории": "Could not apply the history setting",
  "Не удалось получить Tox ID": "Could not retrieve the Tox ID",
  "Не удалось получить статус Tox": "Could not retrieve the Tox status",
  "Не удалось изменить статус Tox": "Could not change the Tox status",
  "Не удалось получить текст статуса Tox": "Could not retrieve the Tox status message",
  "Не удалось обновить текст статуса Tox": "Could not update the Tox status message",
  "Не удалось обновить ник Tox": "Could not update the Tox nickname",
  "Не удалось обновить счётчик событий": "Could not update the event counter",
  "новое событие": "new event",
  "1 новое сообщение или запрос": "1 new message or request",
  "новых сообщений или запросов": "new messages or requests",
  "· ожидание данных…": "· waiting for data…",
  "Чаты и контакты": "Chats and contacts",
  "Ожидающие авторизации": "Pending authorizations",
  "Основные разделы": "Main sections",
  "Изменить ширину меню настроек": "Resize settings menu",
  "Готов к общению": "Ready to chat",
  "Статус:": "Status:",
  "Отключён": "Offline",
  "Показать предыдущие профили": "Show previous profiles",
  "Показать следующие профили": "Show next profiles",
  "Предыдущие профили": "Previous profiles",
  "Следующие профили": "Next profiles",
  "Постквантовое шифрование включено": "Post-quantum encryption enabled",
  "Запрос на постквантовое шифрование отклонён": "Post-quantum encryption request declined",
  "Предложение постквантового шифрования отозвано": "Post-quantum encryption offer withdrawn",
  "Одновременные предложения объединены": "Simultaneous offers merged",
  "Отключение постквантового слоя запланировано": "Post-quantum layer shutdown scheduled",
  "Постквантовый слой отключён": "Post-quantum layer disabled",
  "Постквантовое согласование": "Post-quantum negotiation",
  "Запрос на постквантовое шифрование отправлен": "Post-quantum encryption request sent",
  "Стороны успешно завершили согласование ML-KEM-768. Постквантовый слой активен поверх Tox E2EE.": "Both sides completed ML-KEM-768 negotiation. The post-quantum layer is active over Tox E2EE.",
  "Вы отказались от перехода на постквантовый слой.": "You declined the post-quantum layer.",
  "Вы отозвали предложение постквантового шифрования.": "You withdrew the post-quantum encryption offer.",
  "Контакт отозвал предложение постквантового шифрования.": "The contact withdrew the post-quantum encryption offer.",
  "Оба контакта отправили предложение одновременно. Продолжено одно согласование; ответьте на актуальное предложение ниже.": "Both contacts sent an offer simultaneously. One negotiation continues; respond to the current offer below.",
  "Запрос на согласованное отключение отправлен. Все уже поставленные в очередь сообщения будут доставлены с PQ-защитой до обратного хендшейка.": "A coordinated shutdown request was sent. All queued messages will retain PQ protection until the reverse handshake completes.",
  "Очередь сообщений доставлена, обратный хендшейк завершён обеими сторонами. Дальнейшие сообщения используют стандартное Tox E2EE.": "The message queue was delivered and both sides completed the reverse handshake. Further messages use standard Tox E2EE.",
  "Запрос принят. Завершается взаимное подтверждение ключей.": "The request was accepted. Mutual key confirmation is completing.",
  "Отпечаток контакта изменился. Сверьте его по независимому каналу.": "The contact fingerprint changed. Verify it over an independent channel.",
  "Отозвать запрос": "Withdraw request",
  "Принять и продолжить": "Accept and continue",
  "Отозвать предложение постквантового шифрования": "Withdraw the post-quantum encryption offer",
  "Согласованно отключить постквантовый слой": "Coordinate post-quantum layer shutdown",
  "Выполняется согласованное отключение постквантового слоя": "Coordinated post-quantum layer shutdown is in progress",
  "Предложить постквантовое шифрование": "Offer post-quantum encryption",
  "Подбираю варианты…": "Finding suggestions…",
  "Вариантов замены нет": "No replacement suggestions",
  "Импорт профиля и истории. Пожалуйста, подождите…": "Importing the profile and history. Please wait…",
  "Импорт профиля, аватаров и истории. Пожалуйста, подождите…": "Importing the profile, avatars, and history. Please wait…",
  "На этой платформе импортируется профиль и список контактов; собственная история Kaigen продолжит храниться в portable-каталоге.": "On this platform, the profile and contact list are imported; Kaigen history remains in the portable directory.",
  "Настройки прокси общие для всех профилей. При включённом Tor пользовательский прокси сохраняется, но не используется: маршрут Tox идёт только через SOCKS5 встроенного Tor. Для SOCKS5 и HTTP с логином Kaigen поднимает локальный адаптер авторизации; прямой fallback запрещён.": "Proxy settings are shared by all profiles. When Tor is enabled, the custom proxy is retained but not used: Tox is routed only through built-in Tor SOCKS5. For authenticated SOCKS5 and HTTP, Kaigen runs a local authentication adapter; direct fallback is blocked.",
  "Анонимный режим с единым для всех профилей процессом Tor Expert Bundle.": "Anonymous mode using one Tor Expert Bundle process shared by all profiles.",
  "применение сетевого маршрута": "applying network route",
  "Kill switch включён. Прокси вручную не задавал — используется локальный Tor SOCKS5.": "The kill switch is enabled. No manual proxy is configured; local Tor SOCKS5 is used.",
  "Не удалось загрузить общую компоновку интерфейса": "Could not load the shared interface layout",
  "Не удалось сохранить общую компоновку интерфейса": "Could not save the shared interface layout",
  "Не удалось изменить состояние PQ": "Could not change the PQ state",
  "Не удалось открыть папку downloads": "Could not open the downloads folder",
  "Не удалось отменить запрос": "Could not cancel the request",
  "Не удалось отправить сообщение": "Could not send the message",
  "Не удалось подготовить файл": "Could not prepare the file",
  "Не удалось сохранить файл": "Could not save the file",
  "Не удалось удалить контакт": "Could not delete the contact",
  "Не удалось экспортировать историю": "Could not export history",
  "Полная история экспортирована": "Full history exported",
  "сейчас": "now",
};

const fragments: Array<[string, string]> = [
  ["Контакт ", "Contact "],
  ["Последний онлайн: ", "Last online: "],
  ["Tor подключается: ", "Tor is connecting: "],
  ["Ошибка Tor: ", "Tor error: "],
  ["Tor подключён: ", "Tor connected: "],
  ["Выбранный транспорт: ", "Selected transport: "],
  ["отчёт о доставке: ", "delivery receipt: "],
  ["Будут безвозвратно удалены профиль «", "The profile “"],
  ["» и вся локальная история переписки будут удалены.", "” and all local chat history will be deleted."],
  ["», его контакты, история и индивидуальные настройки. Остальные профили не затрагиваются.", "”, its contacts, history and individual settings will be permanently deleted. Other profiles are unaffected."],
  ["Контакт предлагает включить ", "Contact offers to enable "],
  ["подключение ", "connecting "],
  ["Переключиться на профиль ", "Switch to profile "],
  [" отказался от перехода на постквантовый слой.", " declined the post-quantum layer."],
  [" запросил согласованное отключение. PQ остаётся активным до доставки очереди и завершения обратного хендшейка.", " requested a coordinated shutdown. PQ remains active until the queue is delivered and the reverse handshake completes."],
  [" предлагает добавить к Tox E2EE постквантовый слой ML-KEM-768.", " offers to add an ML-KEM-768 post-quantum layer to Tox E2EE."],
  ["Ожидается решение ", "Waiting for a decision from "],
  [". До подтверждения сообщения продолжают защищаться обычным Tox E2EE.", ". Until confirmation, messages remain protected by standard Tox E2EE."],
];

const replacements = [
  ...Object.entries(english).sort((left, right) => right[0].length - left[0].length),
  ...fragments,
];

export function translateText(value: string, language: Language): string {
  if (language === "ru" || !value || !/[А-Яа-яЁё]/.test(value)) return value;
  const leading = value.match(/^\s*/)?.[0] ?? "";
  const trailing = value.match(/\s*$/)?.[0] ?? "";
  const core = value.slice(leading.length, value.length - trailing.length);
  if (english[core]) return `${leading}${english[core]}${trailing}`;
  let translated = core;
  for (const [source, target] of replacements) {
    if (translated.includes(source)) translated = translated.split(source).join(target);
  }
  return `${leading}${translated}${trailing}`;
}

type I18nValue = {
  language: Language;
  setLanguage: (language: Language) => void;
  t: (value: string) => string;
};

const I18nContext = createContext<I18nValue>({ language: "ru", setLanguage: () => {}, t: (value) => value });

export function I18nProvider({ language, setLanguage, children }: { language: Language; setLanguage: (language: Language) => void; children: ReactNode }) {
  const value = useMemo<I18nValue>(() => ({ language, setLanguage, t: (text) => translateText(text, language) }), [language, setLanguage]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  return useContext(I18nContext);
}

type AppliedText = { original: string; applied: string; language: Language };
const appliedText = new WeakMap<Text, AppliedText>();
const appliedAttributes = new WeakMap<Element, Map<string, AppliedText>>();
const translatedAttributes = ["placeholder", "title", "aria-label"];
const ignoredContent = "[data-i18n-ignore], [translate='no']";

function ignoresTranslation(node: Node) {
  const element = node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement;
  return Boolean(element?.closest(ignoredContent));
}

function translateTextNode(node: Text, language: Language) {
  const current = node.nodeValue ?? "";
  const previous = appliedText.get(node);
  if (previous?.language === language && current === previous.applied) return;
  const original = previous && current === previous.applied ? previous.original : current;
  const applied = translateText(original, language);
  appliedText.set(node, { original, applied, language });
  if (current !== applied) node.nodeValue = applied;
}

function translateAttribute(element: Element, attribute: string, language: Language) {
  let records = appliedAttributes.get(element);
  if (!element.hasAttribute(attribute)) {
    records?.delete(attribute);
    return;
  }
  const current = element.getAttribute(attribute) ?? "";
  const previous = records?.get(attribute);
  if (previous?.language === language && current === previous.applied) return;
  const original = previous && current === previous.applied ? previous.original : current;
  const applied = translateText(original, language);
  if (!records) {
    records = new Map();
    appliedAttributes.set(element, records);
  }
  records.set(attribute, { original, applied, language });
  if (current !== applied) element.setAttribute(attribute, applied);
}

type TranslationWork = { node: Node; attribute?: string };

function* translationWork(roots: Set<Node>, texts: Set<Text>, attributes: Map<Element, Set<string>>): Generator<TranslationWork> {
  const visited = new WeakSet<Node>();
  for (const root of roots) {
    if (ignoresTranslation(root)) continue;
    const pending = [{ node: root, siblings: false }];
    while (pending.length) {
      const { node, siblings } = pending.pop()!;
      if (siblings && node.nextSibling) pending.push({ node: node.nextSibling, siblings: true });
      if (visited.has(node)) continue;
      visited.add(node);
      if (!ignoresTranslation(node) && node.firstChild) pending.push({ node: node.firstChild, siblings: true });
      yield { node };
    }
  }
  for (const node of texts) {
    if (!visited.has(node)) yield { node };
  }
  for (const [node, names] of attributes) {
    if (!visited.has(node)) {
      for (const attribute of names) yield { node, attribute };
    }
  }
}

function observeLanguageChanges(root: HTMLElement, language: Language) {
  let roots = new Set<Node>([root]);
  let texts = new Set<Text>();
  let attributes = new Map<Element, Set<string>>();
  let work: Generator<TranslationWork> | undefined;
  let activeRoots: Set<Node> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const schedule = () => {
    if (!stopped && timer === undefined) timer = setTimeout(flush, 0);
  };
  const flush = () => {
    timer = undefined;
    const started = performance.now();
    // Yield to input and paint even when a large settings/menu subtree arrives.
    for (let processed = 0; processed < 160 && performance.now() - started < 4; processed += 1) {
      if (!work) {
        if (!roots.size && !texts.size && !attributes.size) return;
        activeRoots = roots;
        work = translationWork(roots, texts, attributes);
        roots = new Set();
        texts = new Set();
        attributes = new Map();
      }
      const next = work.next();
      if (next.done) {
        work = undefined;
        activeRoots = undefined;
        continue;
      }
      const { node, attribute } = next.value;
      if (!root.contains(node) || ignoresTranslation(node)) continue;
      if (node.nodeType === Node.TEXT_NODE) translateTextNode(node as Text, language);
      else if (node.nodeType === Node.ELEMENT_NODE) {
        for (const name of attribute ? [attribute] : translatedAttributes) translateAttribute(node as Element, name, language);
      }
    }
    schedule();
  };
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (ignoresTranslation(record.target)) continue;
      if (record.type === "characterData") {
        const node = record.target as Text;
        const previous = appliedText.get(node);
        if (previous?.language !== language || node.nodeValue !== previous.applied) texts.add(node);
      } else if (record.type === "attributes" && record.attributeName) {
        const element = record.target as Element;
        const previous = appliedAttributes.get(element)?.get(record.attributeName);
        if (previous?.language === language && element.getAttribute(record.attributeName) === previous.applied) continue;
        let names = attributes.get(element);
        if (!names) attributes.set(element, names = new Set());
        names.add(record.attributeName);
      } else {
        for (const node of record.addedNodes) roots.add(node);
        // A removed sibling can invalidate a paused traversal cursor. Revisit
        // only its parent when that parent belongs to the active traversal.
        if (record.removedNodes.length && activeRoots && [...activeRoots].some((active) => active.contains(record.target))) roots.add(record.target);
      }
    }
    if (roots.size || texts.size || attributes.size) schedule();
  });
  observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: translatedAttributes });
  schedule();
  return () => {
    stopped = true;
    observer.disconnect();
    if (timer !== undefined) clearTimeout(timer);
    roots.clear();
    texts.clear();
    attributes.clear();
    work = undefined;
    activeRoots = undefined;
  };
}

export function GlobalLanguageBridge() {
  const { language } = useI18n();
  useEffect(() => {
    document.documentElement.lang = language;
    return observeLanguageChanges(document.body, language);
  }, [language]);
  return null;
}
