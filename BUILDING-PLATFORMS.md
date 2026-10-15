# Самостоятельная сборка Kaigen для Windows, Debian и macOS

Kaigen использует одну кодовую базу. Отдельные форки для операционных систем не нужны: различаются только нативные зависимости, конфигурация Tauri и способ упаковки. Собирать пакет нужно на той ОС, для которой он предназначен. Это особенно важно для macOS: `.app` и `.dmg` создаются штатными инструментами Xcode и `hdiutil` только на macOS.

Сценарии фиксируют версии и проверяют размер/SHA-256 локальных копий архивов `c-toxcore`, `cmp`, libsodium, Tor Expert Bundle и Windows WebView2. Исходники ML-KEM-768 уже вложены в `vendor/mlkem-native-2.0.0` и компилируются локально. Ordinary build/test/release работают offline; отсутствие точной копии блокирует сборку и никогда не включает сетевой fallback.

## Общие требования

- Git; доступ в интернет при обычной сборке не используется;
- Node.js 20.19+, 22.12+ или новее и `npm`;
- стабильный Rust, установленный через `rustup`;
- PowerShell 7.6.5 (`pwsh`) как единый orchestration entrypoint;
- CMake, Ninja, C/C++ toolchain;
- не менее 12 ГБ свободного места;
- исходный архив должен быть полностью распакован в каталог с правом записи.

Не запускайте сборочные сценарии от имени `root`/Administrator без необходимости. Каталоги `work`, `node_modules`, `dist`, `src-tauri/target` и `artifacts` создаются локально и не входят в архив исходников.

## Windows 10/11 x64

Установите Visual Studio 2022 Build Tools с компонентами **Desktop development with C++**, Windows SDK, CMake и Ninja. Установите Rust target:

```powershell
rustup target add x86_64-pc-windows-msvc
```

В PowerShell 7.6.5 из корня исходников выполните:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
$env:KAIGEN_COMPONENT_CACHE_ROOT = '<canonical-windows-component-cache>'
.\scripts\Invoke-KaigenAutomation.ps1 `
  -Task windows-portable `
  -ComponentCacheRoot $env:KAIGEN_COMPONENT_CACHE_ROOT
```

Сценарий собирает `c-toxcore`, frontend и Rust backend, создаёт чистую portable-папку и два архива; тесты автоматически не выполняются:

- `artifacts\Kaigen-portable-windows-x64.zip`;
- `artifacts\Kaigen-source-github.zip`.

Расширенное описание Windows-зависимостей, зафиксированных версий и диагностики находится в [BUILDING.md](BUILDING.md).

## Debian 13 x64 / совместимый Linux

AppImage собирается и проверяется на Debian 13 x64. Установите зависимости Tauri 2 и упаковки:

```bash
sudo apt update
sudo apt install -y \
  build-essential curl file pkg-config unzip zip cmake ninja-build libfuse2 \
  libwebkit2gtk-4.1-dev libssl-dev libayatana-appindicator3-dev \
  librsvg2-dev libxdo-dev
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
. "$HOME/.cargo/env"
```

Запустите через единый PowerShell 7.6.5 entrypoint:

```powershell
$env:KAIGEN_COMPONENT_CACHE_ROOT = '<verified-debian-sha-cache>'
pwsh -NoLogo -NoProfile -File ./scripts/Invoke-KaigenAutomation.ps1 -Task debian-build
```

Сценарий:

1. Собирает статическую libsodium 1.0.22-stable из immutable snapshot 2026-10-13 и динамическую `libtoxcore.so`.
2. Добавляет официальный Tor Expert Bundle 15.0.25 Linux x86_64, verified lyrebird 0.9.0 + Kaigen Snowflake 2.15.1 patch overlay и GeoIP dataset 2026-10-14.
3. Выполняет frontend- и Rust-сборку без запуска Tor; тесты включаются только явно выбранным test mode.
4. До любой дорогой сборки проверяет канонические локальные копии всех linuxdeploy/AppRun/plugin-файлов и закреплённого AppImage type-2 runtime. Missing/mismatch сразу останавливает процесс; ordinary release не читает mutable global cache и ничего не скачивает. `LDAI_RUNTIME_FILE` передаёт проверенный runtime упаковщику до создания первого AppImage. После упаковки допускается изменение только проверенной 16-байтовой ELF-секции `.digest_md5`, которую appimagetool вычисляет для конкретного payload; после восстановления этой секции оба runtime-prefix обязаны побайтно совпасть с закреплённым файлом. Изолированный execution-cache повторно проверяется после сборки.
5. Создаёт AppImage, заменяет сгенерированный `AppRun` на отслеживаемый launcher Kaigen и атомарно принимает перепакованный файл только после повторного извлечения и проверки ELF, `libtoxcore.so`, WebKitGTK, Tor, transport-плагинов и AppIndicator runtime.
6. Создаёт `artifacts/Kaigen-portable-debian-x64.zip`.

Verified Tauri cache обязан быть подготовлен заранее полным маршрутом «обновить компоненты Kaigen». Type-2 runtime — локально сохранённый immutable snapshot upstream-asset `continuous` от 28.09.2026, 944 632 байта, SHA-256 `156F4BDBDE9C52D01814600013E0A273F0118DC2DE98975F3C8C63427EC79074`; первичная упаковка и детерминированная перепаковка используют одну и ту же проверенную копию. Для `linuxdeploy-07333c6` перед проверкой воспроизводится точное преобразование Tauri bundler 2.10.3 (три нулевых байта с offset 8). GTK/GStreamer hooks должны побайтно совпадать со встроенными в этот bundler файлами. Один сетевой флаг без `KAIGEN_COMPONENT_UPDATE_SCOPE=all-managed-components` отвергается; ordinary build этот маркер никогда не выставляет. Запуск Tauri packaging получает недействительный локальный HTTP(S) proxy, чтобы при ошибке pin не скачивать инструменты в обход кеша.

Linux AppImage producer — отдельный managed CLI 2.12.2 с bundler 2.10.3; официальный npm CLI остаётся 2.12.2. Exact archive `kaigen-tauri-cli-2.12.2-bundler-2.10.3-linux-x64-bd95bb9cfb6d.tar.gz` (16 026 591 байт, SHA-256 `2F0738A4D1FECE2784D66B49F812A5BC470177F3DF574E37CECD8937F42E00FE`) должен находиться в canonical SHA component cache. `scripts/prepare-managed-tauri-cli.mjs materialize` проверяет archive, binary и source/patch/lock provenance до упаковки; отсутствие exact object останавливает сборку. Offline build recipe использует Linux x64 Rust/Cargo 1.97.1, pinned rustls/platform-certs features и полный vendor. `patches/tauri-cli/manifest.json` сохраняет source, lock, patch, binary и offline-input identities. GTK/GStreamer 2.10.3 побайтно совпадают с предыдущими files; AppRun/linuxdeploy/AppImage plugin/type2-runtime сохранены. Перед новым лабораторным Debian candidate этот standalone managed-tool object передаётся в его собственный SHA cache отдельно от native library outputs. Этот Debian-built tool требует GLIBC 2.39 и liblzma.so.5; его binary не подставляется в Ubuntu 22.04 Actions runner.

GitHub Actions Linux jobs `debian-appimage` и `web-debian13-nginx` работают внутри pinned Debian 13 container `debian:13-slim@sha256:a29215f6a35e51e22adffa17f89e9d2ef06214e64a2bad10d765c46aea49f11f`; hosted runner — Ubuntu 24.04, libc контейнера — 2.41. Managed CLI собирается внутри этого container с exact Rust/Cargo 1.97.1. `build-seeded` соединяет два закреплённых source/vendor parts в archive SHA-256 `73557585FB089D14A871FCC0B25B40939463DD8A4EED4E401CEDB8236B5E0A07`, атомарно сохраняет его в runner cache, проверяет исходный официальный CLI crate и полные source/vendor tree hashes, затем компилирует offline/locked. Parts и официальный crate находятся в `runtime-manifests/vendor-inputs`; их sizes/hashes закреплены в `patches/tauri-cli/manifest.json`. `admit-built` проверяет source/patch/lock/features/recipe, compiler target, output fingerprint и binary hash; Actions admission дополнительно связывает tool с текущими run/attempt/job/workspace/runnerTemp. `build-appimage.sh` вызывает именно same-job executable. Локальный готовый CLI archive не является fallback для Actions. Container bootstrap работает от root до checkout, устанавливает Git/CA/curl/bash/Python и native prerequisites; `run` steps явно используют bash. AppImage tools работают с `APPIMAGE_EXTRACT_AND_RUN=1`, без host FUSE mounts или privileged container options. Web job устанавливает exact PowerShell 7.6.5 из официального Linux x64 tar с закреплёнными size/SHA вместо зависимости от host dotnet SDK. Код маршрута подготовлен; реальный Actions/container build receipt появляется только после отдельно порученного релиза.

После распаковки архива разрешите запуск файла, если это право потерял файловый менеджер:

```bash
chmod +x Kaigen-portable-debian-x64/Kaigen-x86_64.AppImage
```

При запуске AppImage переменная `APPIMAGE` указывает на исходный файл. Kaigen сохраняет `data`, `profiles`, `downloads`, журналы, историю и настройки в той же папке, где лежит AppImage. Ничего не записывается в `$HOME/.config`, `$HOME/.local/share` или системные каталоги. Каталог должен быть доступен на запись. Если FUSE недоступен, AppImage можно запустить с `--appimage-extract-and-run`; portable-корень всё равно определяется по исходному AppImage. Отслеживаемый `AppRun` сохраняет явно заданные пользователем значения `GDK_BACKEND` и `WEBKIT_DISABLE_DMABUF_RENDERER` (включая пустую строку и `0`), а без override выбирает native Wayland только для полноценной Wayland-сессии и заранее включает DMABUF fallback. Поэтому отдельный terminal-launch для обхода пустого окна не нужен.

AppImage содержит AppIndicator runtime и Kaigen использует отдельный прозрачный tray icon. GNOME Shell дополнительно требует включённое расширение AppIndicator/KStatusNotifierItem (`gnome-shell-extension-appindicator` в Debian); приложение не может добавить системную область индикаторов в GNOME без поддержки самой desktop-среды.

Tor helpers используют отдельные provenance-bound overlays: Lyrebird 0.9.0 с Snowflake 2.15.1 patch и Conjure Tor PT snapshot `0090962226b82aa4a8fc38506f9b98de67d0781e`. Base Tor Expert Bundle 15.0.25 и torrc сохраняются. Внутри Conjure остаются Conjure 0.9.1 / uTLS 1.6.7 / Snowflake 2.11.0; новые snapshot commits не означают обновление этих версий.

## macOS 12+ (Intel и Apple Silicon)

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

Запустите через единый PowerShell 7.6.5 entrypoint:

```powershell
$env:KAIGEN_COMPONENT_CACHE_ROOT = '<verified-macos-sha-cache>'
pwsh -NoLogo -NoProfile -File ./scripts/Invoke-KaigenAutomation.ps1 -Task macos-build
```

Сценарий собирает универсальные `x86_64 + arm64` версии libsodium, `libtoxcore.dylib` и Kaigen, объединяет официальные Tor 15.0.25 slices, переносит Mach-O Tor в стандартные `Contents/Helpers`/`Contents/Frameworks`, исправляет portable load paths, подписывает вложенный код изнутри наружу, проверяет подпись, создаёт и проверяет DMG. По умолчанию это явно маркированная тестовая сборка:

- `artifacts/Kaigen-portable-macos-universal-UNSIGNED-TEST.zip`;
- внутри архива и DMG есть `UNSIGNED-TEST.txt`, а имена архива и DMG содержат `UNSIGNED-TEST`.

Windows, Debian, macOS и Web используют lyrebird 0.9.0 + Kaigen Snowflake 2.15.1 patch. macOS получает отдельно собранный universal overlay из закреплённого source commit `89d54872b176f936232ff39f7a8189b77d83d65e`; обе архитектуры собраны offline с `CGO_ENABLED=0` и закреплённым Go 1.26.8. Go 1.26 поддерживает macOS 12; Go 1.27 требует macOS 13, поэтому для Mac overlay сохраняется совместимая ветка 1.26. Глобальные toolchains и гостевая macOS не обновляются. Ordinary build проверяет локальный overlay archive по exact filename/size/SHA-256 и не устанавливает Go или компоненты через сеть. GeoIP dataset 2026-10-14 одинаков для всех платформ.

Закреплённый Mac overlay: `lyrebird-0.9.0-kaigen-snowflake2.15.1-macos-universal-go1.26.8.tar.gz`, 25 753 968 байт, SHA-256 `96CD7CEB88D28B5B6B5C390A8CDF3AD5CDFDE7B97FC575F224E283DCC4482006`. Он содержит universal `lyrebird` и исходные `LICENSE`/`LICENSE-GPL3.txt`. Prepared Tor cache проверяет сам бинарник и оба license-файла; fingerprint включает новый overlay, его source/module/toolchain identity и deployment target `12.0`. Прежние immutable entries сохраняются.

Тестовый пакет подписывается ad-hoc и не является готовым к распространению. Для совместимого с прежними GitHub-выпусками ad-hoc релиза можно явно задать `KAIGEN_MACOS_DISTRIBUTION_MODE=adhoc-release`: сценарий создаст архив со стандартным именем и `ADHOC-SIGNATURE.txt`, но не будет выдавать его за нотарифицированный click-to-run пакет. Для полноценного дистрибутивного пакета сначала сохраните credentials нотарификации в Keychain через `xcrun notarytool store-credentials`, затем явно включите distribution mode и передайте Developer ID вместе с именем профиля:

```powershell
$env:KAIGEN_CODESIGN_IDENTITY = 'Developer ID Application: Example (TEAMID)'
$env:KAIGEN_NOTARYTOOL_PROFILE = 'kaigen-notary'
$env:KAIGEN_MACOS_DISTRIBUTION_MODE = 'distribution'
pwsh -NoLogo -NoProfile -File ./scripts/Invoke-KaigenAutomation.ps1 -Task macos-build
```

Distribution mode завершается ошибкой без Developer ID или профиля нотарификации и формирует `artifacts/Kaigen-portable-macos-universal.zip` только после подписи, нотарификации и stapling `.app` и DMG. Секреты не передаются аргументами и не сохраняются в проекте.

GitHub Actions использует Developer ID и нотарификацию, когда задан полный набор repository secrets: `KAIGEN_MACOS_CERTIFICATE_P12_BASE64`, `KAIGEN_MACOS_CERTIFICATE_PASSWORD`, `KAIGEN_MACOS_KEYCHAIN_PASSWORD`, `KAIGEN_MACOS_CODESIGN_IDENTITY`, `KAIGEN_MACOS_NOTARY_KEY_P8_BASE64`, `KAIGEN_MACOS_NOTARY_KEY_ID`, `KAIGEN_MACOS_NOTARY_ISSUER_ID`. `pull_request` всегда создаёт только `UNSIGNED-TEST` артефакт. Для `push` и ручного non-PR запуска полный набор включает distribution mode, полное отсутствие всех семи secrets — совместимый с `v0.2.0` `adhoc-release`, а частичный набор завершается fail-closed, чтобы не смешивать недонастроенные credentials с ad-hoc fallback.

Не запускайте приложение прямо из смонтированного DMG: он только для доставки и доступен на чтение. Скопируйте из него целую папку `Kaigen-portable` в `~/Applications` или другой доступный на запись каталог; можно перетащить её целиком на ссылку `Applications` в DMG. Все профили и настройки останутся в `Kaigen-portable-data` рядом с приложением; содержимое подписанного `.app` не изменяется. Ошибка writable-root при Finder launch показывается нативным системным сообщением. Сценарий также проверяет, что `CFBundleExecutable` и внутренний бинарник называются `Kaigen`.

## GitHub Actions

GitHub Actions запускаются штатно после разрешённого release push. Windows workflow устанавливает PowerShell 7.6.5 отдельно от локального cache-policy и использует временный runner cache только в bootstrap-шаге. Skip-аннотация допускается лишь по отдельной прямой команде или независимо доказанной причине. CI не заменяет проверенные локально/в лаборатории архивы одного immutable tree.

Нативные `build-appimage.sh`, `build-macos.sh`, AppRun и их Bash-проверки сохраняются как неизбежные OS/toolchain runners: единый PS7 entrypoint вызывает их точными argument arrays и проверяет exit code. CI не отменяет нативную проверку интерфейса на реальном GNOME/KDE и Aqua. Перед публичным выпуском распакуйте каждый архив в новый каталог, проверьте запуск, создание профиля, смену каталога вместе с данными, tray и закрытие дочернего Tor-процесса.

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

Kaigen 0.3 uses the public release label `0.3`, tag `v0.3`, package/Cargo/Tauri version `0.3.0`, and Web build ID `kaigen-0.3.0`.
