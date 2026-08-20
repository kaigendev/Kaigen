# Самостоятельная сборка Kaigen для Windows, Debian и macOS

Kaigen использует одну кодовую базу. Отдельные форки для операционных систем не нужны: различаются только нативные зависимости, конфигурация Tauri и способ упаковки. Собирать пакет нужно на той ОС, для которой он предназначен. Это особенно важно для macOS: `.app` и `.dmg` создаются штатными инструментами Xcode и `hdiutil` только на macOS.

Сценарии фиксируют версии и проверяют размер/SHA-256 локальных копий архивов `c-toxcore`, `cmp`, libsodium, Tor Expert Bundle и Windows WebView2. Исходники ML-KEM-768 уже вложены в `vendor/mlkem-native-2.0.0` и компилируются локально. Ordinary build/test/release работают offline; отсутствие точной копии блокирует сборку и никогда не включает сетевой fallback.

## Общие требования

- Git; доступ в интернет при обычной сборке не используется;
- Node.js 20.19+, 22.12+ или новее и `npm`;
- стабильный Rust, установленный через `rustup`;
- CMake, Ninja, C/C++ toolchain;
- не менее 12 ГБ свободного места;
- исходный архив должен быть полностью распакован в каталог с правом записи.

Не запускайте сборочные сценарии от имени `root`/Administrator без необходимости. Каталоги `work`, `node_modules`, `dist`, `src-tauri/target` и `artifacts` создаются локально и не входят в архив исходников.

## Windows 10/11 x64

Установите Visual Studio 2022 Build Tools с компонентами **Desktop development with C++**, Windows SDK, CMake и Ninja. Установите Rust target:

```powershell
rustup target add x86_64-pc-windows-msvc
```

В PowerShell из корня исходников выполните:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
$env:KAIGEN_COMPONENT_CACHE_ROOT = '<canonical-windows-component-cache>'
.\scripts\build-portable.ps1 -ComponentCacheRoot $env:KAIGEN_COMPONENT_CACHE_ROOT
```

Сценарий собирает `c-toxcore`, тестирует Rust backend и frontend, создаёт чистую portable-папку и два архива:

- `artifacts\Kaigen-portable-windows-x64.zip`;
- `artifacts\Kaigen-source-github.zip`.

Расширенное описание Windows-зависимостей, зафиксированных версий и диагностики находится в [BUILDING.md](BUILDING.md).

## Debian 12 x64 / совместимый Linux

AppImage собирается и проверяется на Debian 12 или Ubuntu 22.04 x64. Установите зависимости Tauri 2 и упаковки:

```bash
sudo apt update
sudo apt install -y \
  build-essential curl file pkg-config unzip zip cmake ninja-build libfuse2 \
  libwebkit2gtk-4.1-dev libssl-dev libayatana-appindicator3-dev \
  librsvg2-dev libxdo-dev
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
. "$HOME/.cargo/env"
```

Запустите:

```bash
chmod +x scripts/*.sh
KAIGEN_COMPONENT_CACHE_ROOT='<verified-debian-sha-cache>' ./scripts/build-appimage.sh
```

Сценарий:

1. Собирает статическую libsodium 1.0.22 и динамическую `libtoxcore.so`.
2. Добавляет официальный Tor Expert Bundle Linux x86_64.
3. Выполняет frontend-сборку и Rust-тесты без запуска Tor.
4. До любой дорогой сборки проверяет канонические локальные копии всех linuxdeploy/AppRun/plugin-файлов и закреплённого AppImage type-2 runtime. Missing/mismatch сразу останавливает процесс; ordinary release не читает mutable global cache и ничего не скачивает. `LDAI_RUNTIME_FILE` передаёт проверенный runtime упаковщику до создания первого AppImage. После упаковки допускается изменение только проверенной 16-байтовой ELF-секции `.digest_md5`, которую appimagetool вычисляет для конкретного payload; после восстановления этой секции оба runtime-prefix обязаны побайтно совпасть с закреплённым файлом. Изолированный execution-cache повторно проверяется после сборки.
5. Создаёт AppImage, заменяет сгенерированный `AppRun` на отслеживаемый launcher Kaigen и атомарно принимает перепакованный файл только после повторного извлечения и проверки ELF, `libtoxcore.so`, WebKitGTK, Tor, transport-плагинов и AppIndicator runtime.
6. Создаёт `artifacts/Kaigen-portable-debian-x64.zip`.

Verified Tauri cache обязан быть подготовлен заранее полным маршрутом «обновить компоненты Kaigen». Type-2 runtime — локально сохранённый immutable snapshot upstream-asset `continuous`, 944 632 байта, SHA-256 `1CC49BCF1E2CCD593C379ADB17C9F85A36D619088296504DE95B1D06215AEBBF`; первичная упаковка и детерминированная перепаковка используют одну и ту же проверенную копию. Для `linuxdeploy` перед проверкой воспроизводится точное преобразование Tauri CLI 2.11.4 (три нулевых байта с offset 8). Один сетевой флаг без `KAIGEN_COMPONENT_UPDATE_SCOPE=all-managed-components` отвергается; ordinary build этот маркер никогда не выставляет.

После распаковки архива разрешите запуск файла, если это право потерял файловый менеджер:

```bash
chmod +x Kaigen-portable-debian-x64/Kaigen-x86_64.AppImage
```

При запуске AppImage переменная `APPIMAGE` указывает на исходный файл. Kaigen сохраняет `data`, `profiles`, `downloads`, журналы, историю и настройки в той же папке, где лежит AppImage. Ничего не записывается в `$HOME/.config`, `$HOME/.local/share` или системные каталоги. Каталог должен быть доступен на запись. Если FUSE недоступен, AppImage можно запустить с `--appimage-extract-and-run`; portable-корень всё равно определяется по исходному AppImage. Отслеживаемый `AppRun` сохраняет явно заданные пользователем значения `GDK_BACKEND` и `WEBKIT_DISABLE_DMABUF_RENDERER` (включая пустую строку и `0`), а без override выбирает native Wayland только для полноценной Wayland-сессии и заранее включает DMABUF fallback. Поэтому отдельный terminal-launch для обхода пустого окна не нужен.

AppImage содержит AppIndicator runtime и Kaigen использует отдельный прозрачный tray icon. GNOME Shell дополнительно требует включённое расширение AppIndicator/KStatusNotifierItem (`gnome-shell-extension-appindicator` в Debian); приложение не может добавить системную область индикаторов в GNOME без поддержки самой desktop-среды.

## macOS 11+ (Intel и Apple Silicon)

Установите полный Xcode и активируйте command line tools:

```bash
xcode-select --install
sudo xcodebuild -license accept
```

Установите инструменты сборки, например через Homebrew:

```bash
brew install node cmake ninja pkg-config autoconf automake libtool
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
. "$HOME/.cargo/env"
```

Запустите:

```bash
chmod +x scripts/*.sh
KAIGEN_COMPONENT_CACHE_ROOT='<verified-macos-sha-cache>' ./scripts/build-macos.sh
```

Сценарий собирает универсальные `x86_64 + arm64` версии libsodium, `libtoxcore.dylib`, Kaigen и всех компонентов Tor, переносит Mach-O Tor в стандартные `Contents/Helpers`/`Contents/Frameworks`, исправляет portable load paths, подписывает вложенный код изнутри наружу, проверяет подпись, создаёт и проверяет DMG. По умолчанию это явно маркированная тестовая сборка:

- `artifacts/Kaigen-portable-macos-universal-UNSIGNED-TEST.zip`;
- внутри архива и DMG есть `UNSIGNED-TEST.txt`, а имена архива и DMG содержат `UNSIGNED-TEST`.

Тестовый пакет подписывается ad-hoc и не является готовым к распространению. Для совместимого с прежними GitHub-выпусками ad-hoc релиза можно явно задать `KAIGEN_MACOS_DISTRIBUTION_MODE=adhoc-release`: сценарий создаст архив со стандартным именем и `ADHOC-SIGNATURE.txt`, но не будет выдавать его за нотарифицированный click-to-run пакет. Для полноценного дистрибутивного пакета сначала сохраните credentials нотарификации в Keychain через `xcrun notarytool store-credentials`, затем явно включите distribution mode и передайте Developer ID вместе с именем профиля:

```bash
KAIGEN_CODESIGN_IDENTITY='Developer ID Application: Example (TEAMID)' \
KAIGEN_NOTARYTOOL_PROFILE='kaigen-notary' \
KAIGEN_MACOS_DISTRIBUTION_MODE='distribution' \
  ./scripts/build-macos.sh
```

Distribution mode завершается ошибкой без Developer ID или профиля нотарификации и формирует `artifacts/Kaigen-portable-macos-universal.zip` только после подписи, нотарификации и stapling `.app` и DMG. Секреты не передаются аргументами и не сохраняются в проекте.

GitHub Actions использует Developer ID и нотарификацию, когда задан полный набор repository secrets: `KAIGEN_MACOS_CERTIFICATE_P12_BASE64`, `KAIGEN_MACOS_CERTIFICATE_PASSWORD`, `KAIGEN_MACOS_KEYCHAIN_PASSWORD`, `KAIGEN_MACOS_CODESIGN_IDENTITY`, `KAIGEN_MACOS_NOTARY_KEY_P8_BASE64`, `KAIGEN_MACOS_NOTARY_KEY_ID`, `KAIGEN_MACOS_NOTARY_ISSUER_ID`. `pull_request` всегда создаёт только `UNSIGNED-TEST` артефакт. Для `push` и ручного non-PR запуска полный набор включает distribution mode, полное отсутствие всех семи secrets — совместимый с `v0.2.0` `adhoc-release`, а частичный набор завершается fail-closed, чтобы не смешивать недонастроенные credentials с ad-hoc fallback.

Не запускайте приложение прямо из смонтированного DMG: он только для доставки и доступен на чтение. Скопируйте из него целую папку `Kaigen-portable` в `~/Applications` или другой доступный на запись каталог; можно перетащить её целиком на ссылку `Applications` в DMG. Все профили и настройки останутся в `Kaigen-portable-data` рядом с приложением; содержимое подписанного `.app` не изменяется. Ошибка writable-root при Finder launch показывается нативным системным сообщением. Сценарий также проверяет, что `CFBundleExecutable` и внутренний бинарник называются `Kaigen`.

## GitHub Actions

Обычный release не запускает GitHub Actions: release commit отправляется с официальной skip-аннотацией, а публикуются только локально/в лаборатории проверенные архивы одного immutable tree. Ручной запуск workflow допустим только по новой явной команде пользователя и не заменяет обязательную native-проверку.

CI не отменяет нативную проверку интерфейса на реальном GNOME/KDE и Aqua. Перед публичным выпуском распакуйте каждый архив в новый каталог, проверьте запуск, создание профиля, смену каталога вместе с данными, tray и закрытие дочернего Tor-процесса.

## Portable-границы и совместимость

- Windows: пользовательские каталоги находятся рядом с `Kaigen.exe`.
- Linux AppImage: пользовательские каталоги находятся рядом с файлом `.AppImage`, а не во временной точке монтирования.
- macOS: пользовательские каталоги находятся в `Kaigen-portable-data` рядом с `Kaigen.app`.
- Все разблокированные профили работают одновременно и используют один общий Tor/маршрут внутри экземпляра приложения.
- Повторный экземпляр с тем же portable-корнем блокируется; копии в разных каталогах независимы.
- Импорт профиля qTox доступен на всех ОС. Импорт зашифрованной SQLCipher-истории qTox в этой версии комплектуется собственным runtime только в Windows-сборке; это ограничение не влияет на обычную историю Kaigen.

## Контроль результата

После сборки вычислите хэши и сохраните их рядом с выпуском:

```bash
sha256sum artifacts/*.zip                 # Linux
shasum -a 256 artifacts/*.zip             # macOS
```

```powershell
Get-FileHash -Algorithm SHA256 artifacts\*.zip
```

Готовый архив не должен содержать пользовательских `.tox`, `.db`, журналов или кэша WebView. Пустые `profiles`, `data`, `downloads` являются только точками начала portable-хранилища.
