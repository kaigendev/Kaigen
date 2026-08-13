# Самостоятельная сборка Kaigen для Windows, Debian и macOS

Kaigen использует одну кодовую базу. Отдельные форки для операционных систем не нужны: различаются только нативные зависимости, конфигурация Tauri и способ упаковки. Собирать пакет нужно на той ОС, для которой он предназначен. Это особенно важно для macOS: `.app` и `.dmg` создаются штатными инструментами Xcode и `hdiutil` только на macOS.

Сценарии фиксируют версии и проверяют SHA-256 загружаемых архивов `c-toxcore`, `cmp`, libsodium, Tor Expert Bundle и Windows WebView2. Исходники ML-KEM-768 уже вложены в `vendor/mlkem-native-1.3.0` и компилируются локально.

## Общие требования

- Git и доступ в интернет только для загрузки инструментов/зависимостей;
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
.\scripts\build-portable.ps1
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
./scripts/build-appimage.sh
```

Сценарий:

1. Собирает статическую libsodium 1.0.22 и динамическую `libtoxcore.so`.
2. Добавляет официальный Tor Expert Bundle Linux x86_64.
3. Выполняет frontend-сборку и Rust-тесты без запуска Tor.
4. Создаёт AppImage и распаковывает его во временный каталог для проверки `libtoxcore.so`, Tor и transport-плагинов.
5. Создаёт `artifacts/Kaigen-portable-debian-x64.zip`.

После распаковки архива разрешите запуск файла, если это право потерял файловый менеджер:

```bash
chmod +x Kaigen-portable-debian-x64/Kaigen-x86_64.AppImage
```

При запуске AppImage переменная `APPIMAGE` указывает на исходный файл. Kaigen сохраняет `data`, `profiles`, `downloads`, журналы, историю и настройки в той же папке, где лежит AppImage. Ничего не записывается в `$HOME/.config`, `$HOME/.local/share` или системные каталоги. Каталог должен быть доступен на запись. Если FUSE недоступен, AppImage можно запустить с `--appimage-extract-and-run`; portable-корень всё равно определяется по исходному AppImage.

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
./scripts/build-macos.sh
```

Сценарий собирает универсальные `x86_64 + arm64` версии libsodium, `libtoxcore.dylib`, Kaigen и компонентов Tor, проверяет обе архитектуры через `lipo`, исправляет portable `@rpath`, подписывает `.app`, проверяет подпись, создаёт и проверяет DMG, затем формирует:

- `artifacts/Kaigen-portable-macos-universal.zip`;
- внутри архива — `Kaigen.app`, `Kaigen-portable-data` и `Kaigen-portable-macos-universal.dmg`.

Без сертификата используется локальная ad-hoc подпись. Для Developer ID укажите точное имя сертификата:

```bash
KAIGEN_CODESIGN_IDENTITY='Developer ID Application: Example (TEAMID)' \
  ./scripts/build-macos.sh
```

Нотаризация намеренно не выполняется автоматически: для неё нужны Apple ID/App Store Connect credentials конкретного издателя. Ad-hoc пакет можно запускать локально после подтверждения Gatekeeper. Публичное распространение следует подписать Developer ID и нотарифицировать обычным процессом Apple.

Не запускайте приложение прямо из смонтированного DMG: он только для доставки и доступен на чтение. Скопируйте `Kaigen.app` и соседний `Kaigen-portable-data` в один доступный на запись каталог. Все профили и настройки будут находиться в `Kaigen-portable-data`; содержимое подписанного `.app` не изменяется.

## Автоматическая нативная сборка GitHub Actions

Workflow `.github/workflows/build-unix.yml` запускает те же сценарии на `ubuntu-22.04` и `macos-14` и публикует два готовых ZIP. Windows workflow находится в `.github/workflows/build-windows.yml`. Запуск вручную: **Actions → нужный workflow → Run workflow**.

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
