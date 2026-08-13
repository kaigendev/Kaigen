# Самостоятельная сборка для Windows x64

## 1. Требования к компьютеру сборки

Установите:

1. Windows 10/11 x64.
2. [Git for Windows](https://git-scm.com/download/win).
3. [Node.js](https://nodejs.org/) версии 20.19+, 22.12+ или новее. Vite 7 не поддерживает более старые версии.
4. [Rust через rustup](https://rustup.rs/) с target `x86_64-pc-windows-msvc`.
5. [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) с workload **Desktop development with C++**, Windows SDK, CMake и Ninja.

Полный официальный перечень требований Tauri для Windows: <https://v2.tauri.app/start/prerequisites/>.

Инструменты разработки нужны только на машине сборки. Пользователю готового portable-архива Node.js, Rust, Visual Studio, CMake и Visual C++ Redistributable не требуются.

## 2. Автоматическая сборка

Откройте PowerShell в корне репозитория и выполните:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\build-portable.ps1
```

Сценарий:

- скачивает и фиксирует `c-toxcore` на commit `1d79022fb4e56dffe0bbd075d47e00f7a0b62ab3`;
- скачивает официальный libsodium 1.0.22 MSVC и проверяет SHA-256;
- скачивает Microsoft WebView2 Fixed Version 151.0.4129.59 x64 и проверяет SHA-256;
- скачивает официальный Tor Expert Bundle 15.0.19 для Windows x64 и проверяет SHA-256;
- собирает `toxcore.dll` с libsodium и MSVC runtime, связанными статически (`/MT`);
- использует небольшой `scripts\pkg-config-stub.cmd`, потому что c-toxcore формально требует pkg-config и на MSVC, хотя нужный libsodium подключается нативным CMake config, а toxav/bootstrapd отключены;
- статически собирает вложенный исходный код `mlkem-native 1.3.0` для ML-KEM-768;
- выполняет `npm ci`, тесты Rust и production-сборку Tauri;
- проверяет и включает SQLCipher/OpenSSL runtime для импорта истории qTox и встроенные RU/EN Hunspell-словари;
- создаёт чистую portable-папку без пользовательских профилей, `Kaigen-portable-windows-x64.zip` и отдельный GitHub-ready `Kaigen-source-github.zip` в `artifacts`.

Для загрузки зависимостей интернет нужен только во время сборки.

Исходный код `mlkem-native` уже включён в каталог `vendor` и не скачивается во время сборки. Он нужен и не должен удаляться из клона или source-архива.

## 3. Зафиксированные внешние файлы

### libsodium

- Страница релизов: <https://download.libsodium.org/libsodium/releases/>
- Архив: <https://download.libsodium.org/libsodium/releases/libsodium-1.0.22-msvc.zip>
- SHA-256: `3E03A726FAC4BC09CB61D8F29D658EF7A5ECA0811DE59082130414F7CA2E4279`

Используется `x64\Release\v143\static\libsodium.lib`. Официальные MSVC-сборки libsodium уже собраны с `/MT`; при статической линковке обязательно определение `SODIUM_STATIC`, что учтено в `cmake/libsodium/libsodiumConfig.cmake`.

### c-toxcore

- Репозиторий: <https://github.com/TokTok/c-toxcore>
- Commit: `1d79022fb4e56dffe0bbd075d47e00f7a0b62ab3`
- Архив commit: <https://codeload.github.com/TokTok/c-toxcore/zip/1d79022fb4e56dffe0bbd075d47e00f7a0b62ab3>
- SHA-256: `8764EC0E15448F2F76E1E0DCAC15BBDAC959D8519BD3E274D1126C302FB56506`
- Подмодуль `TokTok/cmp`: commit `52bfcfa17d2eb4322da2037ad625f5575129cece`, SHA-256 архива `281BB25882E4186187DF555775DD3CD57943ECFAFC70B5D5076BEC9DEE02672D`.

Фиксация commit важна: сборка произвольного `master` позднее может изменить ABI и поведение клиента. Сценарий использует проверяемый commit-архив и поэтому не зависит от наличия `git-remote-https` в локальной поставке Git.

При сборке MSVC сценарий обязательно задаёт `CMAKE_WINDOWS_EXPORT_ALL_SYMBOLS=ON`. Без этого c-toxcore создаёт DLL без таблицы экспортов; такой файл может формально слинковаться через устаревшую import-библиотеку, но завершит запуск Windows ошибкой `0xc000007b`.

### pthreads4w

- Источник: <https://github.com/fwbuilder/pthreads4w>
- Commit: `44daa2441137b90477b449663abe9755b2c9a16b` (ветка 3.0.x).
- Архив commit: <https://codeload.github.com/fwbuilder/pthreads4w/zip/44daa2441137b90477b449663abe9755b2c9a16b>
- SHA-256: `159919A823800CB594E598D504B6C01397C0CB88DF3E3791BF529BD68FFDC67E`.

Сценарий собирает app-local `pthreadVC3.dll` с `/MT` и кладёт её рядом с `toxcore.dll`. Это исключает конфликт ранней статической инициализации; на конечном ПК установка pthreads или Visual C++ Runtime не требуется.

### Microsoft WebView2 Fixed Version

- Официальная страница загрузки: <https://developer.microsoft.com/microsoft-edge/webview2/>
- Документация распространения: <https://learn.microsoft.com/microsoft-edge/webview2/concepts/distribution>
- Используемая версия: `151.0.4129.59`, архитектура x64.
- SHA-256 CAB: `056858A027A7BF29893B6013C0EB0C6EA7E29755A20C9D043BE469D9D78657DC`

Microsoft показывает для скачивания только актуальные основные версии. Если зафиксированная прямая ссылка перестала работать, скачайте на официальной странице новый **Fixed Version — x64** CAB и передайте его сценарию:

```powershell
.\scripts\build-portable.ps1 -WebView2CabPath "C:\Downloads\Microsoft.WebView2.FixedVersionRuntime.VERSION.x64.cab"
```

Код клиента автоматически находит версионный подкаталог, содержащий `msedgewebview2.exe`, поэтому переименование каталога не требуется.

### Tor Expert Bundle

- Официальная страница: <https://www.torproject.org/download/tor/>
- Архив: <https://archive.torproject.org/tor-package-archive/torbrowser/15.0.19/tor-expert-bundle-windows-x86_64-15.0.19.tar.gz>
- Tor: `0.4.9.11`; комплект Tor Browser/Expert Bundle: `15.0.19`.
- SHA-256 архива: `6AC067402C7B4A3DC37887ED3754B3914B67FDC220C966190683E9CCF91ABF0F`

Используется именно Expert Bundle, не Tor Browser. В portable-пакет копируется весь каталог `TorExpertBundle`: кроме `tor.exe` он содержит GeoIP, лицензии, `lyrebird.exe`, встроенные obfs4/Snowflake-мосты и поддержку пользовательских WebTunnel-мостов. Не удаляйте отдельные файлы из этого каталога.

### mlkem-native 1.3.0

- Репозиторий: <https://github.com/pq-code-package/mlkem-native>
- Релиз: <https://github.com/pq-code-package/mlkem-native/releases/tag/v1.3.0>
- Алгоритм: ML-KEM-768 по NIST FIPS 203.

Исходники находятся в `vendor\mlkem-native-1.3.0` и компилируются `cc` как статическая C-библиотека. Отдельной PQ DLL и Visual C++ Redistributable на пользовательском ПК не требуется. Полное описание протокола находится в `POST_QUANTUM.txt`.

### Импорт истории qTox и словари

- `runtime\qtox-import` содержит зафиксированный Windows x64 SQLCipher runtime из официальной сборки qTox: `libsqlcipher-0.dll`, OpenSSL 3 и необходимые MinGW runtime DLL. Сценарий проверяет SHA-256 каждого файла до сборки.
- `runtime\dictionaries` содержит русские и английские Hunspell-словари проекта `wooorm/dictionaries` вместе с исходными файлами лицензий. Эти же словари встраиваются Vite в интерфейс.
- Эти каталоги входят и в source-архив: после распаковки он готов к сборке без поиска бинарной SQLCipher-зависимости вручную.
- Источники: <https://github.com/qTox/qTox>, <https://github.com/sqlcipher/sqlcipher>, <https://github.com/wooorm/dictionaries>.

## 4. Важные нюансы portable-сборки

- Поддерживается только Windows x64. Для x86 и ARM64 нужны отдельные Rust target, toxcore, libsodium и WebView2 соответствующей архитектуры.
- Fixed Version WebView2 занимает более 250 МБ и не обновляется автоматически. При обновлении клиента следует обновлять и runtime.
- Fixed Version нельзя запускать с UNC/сетевого пути. Распакуйте приложение на локальный диск или переносной накопитель.
- На Windows 10 WebView2 Fixed Version 120+ требует права чтения для AppContainer. Клиент перед созданием окна применяет рекомендованные Microsoft ACL через штатный `icacls.exe`.
- При первом запуске Windows Firewall может показать диалог для сетевой работы Tox. Пока пользователь не ответил, приложение может выглядеть приостановленным.
- Tor включён по умолчанию. Приложение запускает только вложенный `TorExpertBundle\tor\tor.exe`; системный Tor и Tor Browser не используются.
- SOCKS5 и ControlPort выбираются при каждом запуске из свободных нестандартных локальных портов. Порты 9050, 9051, 9150 и 9151 исключены, чтобы не конфликтовать с пользовательскими службами Tor.
- Повторный запуск EXE из того же portable-каталога не создаёт второй backend и второй Tor: уже открытое окно восстанавливается и получает фокус. Копии из разных каталогов работают независимо.
- Вложенный Tor назначается отдельному Windows Job Object с `KILL_ON_JOB_CLOSE`; при штатном или аварийном завершении Kaigen ОС уничтожает только принадлежащий этому экземпляру Tor и его дочерние транспорты.
- Tox начинает сетевую работу только после реального `Bootstrapped 100%`. При ошибке Tor kill switch не допускает автоматический прямой маршрут.
- Не запускайте EXE прямо внутри ZIP: распакуйте всю папку, сохранив `toxcore.dll`, `WebView2Runtime` и `TorExpertBundle` рядом с приложением.
- `Kaigen.exe.WebView2` — служебный кэш интерфейса. Его можно не переносить; он будет создан снова.
- `profiles`, `data`, `downloads` и `history_export` являются переносимыми пользовательскими данными и не должны попадать в публичный репозиторий или release с чистой установкой.

## 5. Проверка результата

После сборки распакуйте `artifacts\Kaigen-portable-windows-x64.zip` в новый локальный каталог и запустите `Kaigen.exe`.

Проверьте:

1. После выбора «Создать профиль» создан каталог `profiles\<id>` с файлом профиля и его собственным каталогом `data`; до завершения приветственного сценария закрытый ключ не создаётся.
2. Ник нового профиля — `Tox User`.
3. Кнопка загрузок под «Настройки» открывает локальную папку `downloads` этого экземпляра клиента.
4. В диспетчере модулей процесса `EmbeddedBrowserWebView.dll` загружен из вложенного `WebView2Runtime`, а не из системной установки.
5. В настройках Tor показаны два разных динамических порта, не равные 9050/9051/9150/9151, а защита IP отмечена только после 100% bootstrap.
6. При завершении `TorExpertBundle\tor\tor.exe` Tox переходит в offline и не подключается напрямую.
7. После закрытия и переноса всей папки все профили, контакты, история, непрочитанные события, черновики и настройки Tor сохраняются.
8. Два экземпляра Tox-PQ-Client распознают поддержку PQ без изменения пользовательского статуса; после взаимного согласия в заголовке появляется строка «защищённый чат E2EE (пост-квантовое шифрование)».
9. Импорт тестового qTox-профиля переносит контакты и всю найденную SQLCipher-историю; лимит сообщений в интерфейсе не уменьшает экспортированный файл.
10. Два разблокированных профиля одновременно выполняют независимые циклы `tox_iterate`, используют один процесс Tor и одни настройки прокси; переключение активного профиля не меняет их сетевой жизненный цикл.
11. Повторный запуск `Kaigen.exe` из того же каталога оставляет один процесс приложения и один Tor, восстанавливая свёрнутое окно.
12. Две распакованные копии в разных каталогах одновременно используют разные `DataDirectory`, SOCKS5/ControlPort и Tor-процессы; принудительное завершение одной копии удаляет только её Tor.
