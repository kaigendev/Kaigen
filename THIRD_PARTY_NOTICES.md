# Сторонние компоненты

## c-toxcore

- Источник: <https://github.com/TokTok/c-toxcore>
- Зафиксированный commit: `1d79022fb4e56dffe0bbd075d47e00f7a0b62ab3`
- Лицензия: GPL-3.0-or-later

Нативная библиотека `toxcore.dll`, `libtoxcore.so` или `libtoxcore.dylib` распространяется вместе с соответствующей сборкой и статически включает libsodium.

## pthreads4w 3.0.x

- Источник: <https://github.com/fwbuilder/pthreads4w>
- Зафиксированный commit: `44daa2441137b90477b449663abe9755b2c9a16b`
- Лицензия: Apache-2.0

MSVC-сборка `pthreadVC3.dll` с `/MT` поставляется рядом с `toxcore.dll`; устанавливать pthreads или Visual C++ Runtime на пользовательском ПК не требуется.

## libsodium 1.0.22

- Источник и бинарные пакеты: <https://download.libsodium.org/libsodium/releases/>
- Используемый source-архив 1.0.22: <https://github.com/jedisct1/libsodium/archive/refs/tags/1.0.22.tar.gz>
- SHA-256 source-архива: `729EFDB75BE22ABED3EF31824674976AF43008F900BAD9B576CE412D6F659175`
- Лицензия: ISC

## Microsoft Edge WebView2 Fixed Version Runtime

- Загрузка: <https://developer.microsoft.com/microsoft-edge/webview2/>
- Условия распространения: <https://www.microsoft.com/software-download/webview2>
- Версия в portable-сборке: 151.0.4129.93 x64
- SHA-256 CAB: `1CB7106545F5AEE92EE16496347A0E775A351CB5A3816D072F04323695899BDE`

Этот runtime входит только в Windows-архив. Debian использует WebKitGTK, macOS — системный WebKit.

Файлы runtime сохраняют подписи, уведомления и лицензии Microsoft. Их нельзя выборочно удалять из portable-пакета.

## mlkem-native 2.0.0

- Источник: <https://github.com/pq-code-package/mlkem-native>
- Релиз: <https://github.com/pq-code-package/mlkem-native/releases/tag/v2.0.0>
- SHA-256 source archive: `10D33BF60B7940EA812782DC89160154CC4A613BD2BEF5EC63EBE39A8B0EC8A4`
- Лицензирование используемых исходников `mlkem/*`: Apache-2.0 OR ISC OR MIT.

Клиент статически включает переносимую C-реализацию ML-KEM-768. Полный исходный текст и оригинальный файл `LICENSE` входят в source-архив в каталоге `vendor/mlkem-native-2.0.0`.

## Tor Expert Bundle 15.0.20

- Официальная загрузка: <https://www.torproject.org/download/tor/>
- Архив Windows x64: <https://archive.torproject.org/tor-package-archive/torbrowser/15.0.20/tor-expert-bundle-windows-x86_64-15.0.20.tar.gz>
- Архив Linux x64: <https://archive.torproject.org/tor-package-archive/torbrowser/15.0.20/tor-expert-bundle-linux-x86_64-15.0.20.tar.gz>
- Архив macOS Intel: <https://archive.torproject.org/tor-package-archive/torbrowser/15.0.20/tor-expert-bundle-macos-x86_64-15.0.20.tar.gz>
- Архив macOS Apple Silicon: <https://archive.torproject.org/tor-package-archive/torbrowser/15.0.20/tor-expert-bundle-macos-aarch64-15.0.20.tar.gz>
- Tor: 0.4.9.11; транспорт lyrebird: 0.8.1.
- GeoIP/GeoIPv6: IPFire Location Database export от 2026-06-25, CC BY-SA 4.0; встроены без отдельного сетевого обновления.
- SHA-256 GeoIP: `AF9CCD060A712D090EE07D5678B5D45B0038EC1573116FAE724A6695A8485703`.
- SHA-256 GeoIPv6: `2393124667BA2CCB4C806F226A33B2EF7A8188D1BA55831C1A5D3DCA2B062514`.
- SHA-256 Windows x64: `D59BFF934E3AD876E1623E24AE60C19AEEA56F50178093B9F86FBA230639F949`
- SHA-256 Linux x64: `3B39A2A7FBF43EF28B9AE0A6AFCA02A12935232F81769E4FEF7472D6B5676EAF`
- SHA-256 macOS Intel: `6EC3048B3A5D55E297F35D84830D0E338884D702AAC3DB49056633C1223841DF`
- SHA-256 macOS Apple Silicon: `73FDCCDE8136678E41A625160993E6A9DC4F4FF8CD376318B5E41E5627D55682`
- Signed checksum manifest: <https://archive.torproject.org/tor-package-archive/torbrowser/15.0.20/sha256sums-signed-build.txt> (Tor Browser Developers primary fingerprint `EF6E286DDA85EA2A4BA7DE684E2C6E8793298290`).

Вместе с приложением распространяется неизменённое содержимое `TorExpertBundle`, включая каталог `docs` с лицензиями и уведомлениями Tor Project и всех pluggable transports. Эти файлы являются частью portable-пакета и не должны удаляться.

## Rust и npm зависимости

Версии Rust-зависимостей зафиксированы в `src-tauri/Cargo.lock`, npm-зависимостей — в `package-lock.json`. Каждый компонент сохраняет собственную лицензию. Перед публичным релизом рекомендуется сформировать полный машинный отчёт лицензий с `cargo-about` и `license-checker` или эквивалентными инструментами.

## SQLCipher runtime для импорта qTox

Каталог `runtime/qtox-import` содержит одну воспроизводимо собранную MSVC x64 DLL, необходимую только для чтения зашифрованной базы истории при импорте. Два чистых дерева SQLCipher дали побайтно одинаковый результат. OpenSSL и статический MSVC CRT связаны внутри DLL; отдельные OpenSSL, MinGW и VC runtime DLL не распространяются:

- SQLCipher 4.18.0 / SQLite 3.53.4 — BSD-style/public-domain components: <https://github.com/sqlcipher/sqlcipher/releases/tag/v4.18.0>;
- OpenSSL 3.5.7 — Apache License 2.0: <https://github.com/openssl/openssl/releases/tag/openssl-3.5.7>;
- SQLCipher source archive SHA-256: `1DF02D1B346FA27FEAF2DA2CB2C0D8209E788248E461EC288718AA5D3E9643E5`;
- OpenSSL official source archive SHA-256: `A8C0D28A529CA480F9F36CF5792E2CD21984552A3C8E4AA11A24AA31AEAC98E8`.

SHA-256 распространяемой `libsqlcipher-0.dll` (`A69C768C63F8EF883419EB5B6C3CD41570A5D3F82650C6AC3E4A7F75BB4288D2`, 4 992 000 байт) зафиксирован и проверяется в `scripts/prepare-dependencies.ps1`. Два полностью независимых clean-run дали побайтно одинаковые DLL и import library; проверка также исключает build-host пути из бинарника.

## Linux AppImage packaging runtime

- AppImage type-2 runtime `runtime-x86_64` (immutable local snapshot of the upstream `continuous` asset) — MIT; SHA-256 `1CC49BCF1E2CCD593C379ADB17C9F85A36D619088296504DE95B1D06215AEBBF`, 944 632 байта: <https://github.com/AppImage/type2-runtime>;
- AppRun из `tauri-apps/binary-releases`, `linuxdeploy` и `linuxdeploy-plugin-appimage` — MIT: <https://github.com/tauri-apps/binary-releases>, <https://github.com/linuxdeploy/linuxdeploy>, <https://github.com/linuxdeploy/linuxdeploy-plugin-appimage>;
- `linuxdeploy-plugin-gtk` pin `b5eb8d05b4c0ed40107fe2158c5d8527f94568ef` — MIT: <https://github.com/tauri-apps/linuxdeploy-plugin-gtk>;
- `linuxdeploy-plugin-gstreamer` pin `2a2e67491c32995a3f279ad0ecbe77abd512b42a` используется как build-вход. В закреплённом upstream snapshot нет отдельного LICENSE-файла или license header, поэтому этому файлу здесь намеренно не приписывается лицензия.

Type-2 runtime статически включает собственные low-level runtime-компоненты AppImage (в частности musl, libfuse/squashfuse, zstd и zlib); их upstream license texts и notices применяются согласно репозиторию AppImage runtime.

## Проверка орфографии

- `nspell` — MIT: <https://github.com/wooorm/nspell>;
- английский и русский Hunspell-словари — <https://github.com/wooorm/dictionaries>, commit `8cfea406b505e4d7df52d5a19bce525df98c54ab`;
- English package 4.0.0 (`MIT AND BSD`), Russian package 3.0.0 (`BSD-3-Clause`).

SHA-256 встроенных словарей:

- `en-US.aff`: `8AE1F19D4840D957728AD90555D5A8DFF6CC5C046279C95FF0C00FC0A0136C7B`;
- `en-US.dic`: `F0B1A234BD178BDD01875B2A392A9647F888B8FE879F79C52AAE62C2759B3647`;
- `ru-RU.aff`: `38CE7D4AF78E211E9BAFE4BF7E3D6A2C420591136CB738EC6648F8FDF6524CD7`;
- `ru-RU.dic`: `F6047416A0204ADBECF3A451B874EC8A97EE37E2CBC714466EF04D8DBCC0D6FC`.

Оригинальные тексты лицензий словарей входят в `runtime/dictionaries/LICENSE-en.txt` и `runtime/dictionaries/LICENSE-ru.txt`.

## Tauri plugins

Системный трей, открытие portable-каталогов и уведомления реализованы с Tauri 2 и официальными plugins. Исходники и лицензии: <https://github.com/tauri-apps/tauri> и <https://github.com/tauri-apps/plugins-workspace>.
