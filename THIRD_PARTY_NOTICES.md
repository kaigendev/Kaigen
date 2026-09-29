# Сторонние компоненты

## c-toxcore

- Источник сборки: <https://github.com/kaigendev/kaigen-toxcore>.
- Базовая версия: 0.2.23; форк Kaigen: 0.2.23-kaigen.1.
- Зафиксированный commit: `b89934a6c152e5645697ee2974c9a5859855ad7c`.
- Форк включает ограничение повторных запросов, исправления безопасности 1–8, а также исправления наследования сокетов Windows и HTTP CONNECT. История исправлений хранится в `patches/c-toxcore`; сборка не накладывает их повторно.
- Исходное авторство и лицензии сохранены в репозитории форка, включая `UPSTREAM.md` и файлы лицензий.
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
- Версия в portable-сборке: 154.0.4258.37 x64
- SHA-256 CAB: `143DA7F7C4939FDDD3875ED918E44022D7EB87063BF912FE3E32DF37C6B0B8C3`

Этот runtime входит только в Windows-архив. Debian использует WebKitGTK, macOS — системный WebKit.

Файлы runtime сохраняют подписи, уведомления и лицензии Microsoft. Их нельзя выборочно удалять из portable-пакета.

## mlkem-native 2.0.0

- Источник: <https://github.com/pq-code-package/mlkem-native>
- Релиз: <https://github.com/pq-code-package/mlkem-native/releases/tag/v2.0.0>
- SHA-256 source archive: `10D33BF60B7940EA812782DC89160154CC4A613BD2BEF5EC63EBE39A8B0EC8A4`
- Лицензирование используемых исходников `mlkem/*`: Apache-2.0 OR ISC OR MIT.

Клиент статически включает переносимую C-реализацию ML-KEM-768. Полный исходный текст и оригинальный файл `LICENSE` входят в source-архив в каталоге `vendor/mlkem-native-2.0.0`.

## Tor Expert Bundle 15.0.23

- Официальная загрузка: <https://www.torproject.org/download/tor/>
- Архив Windows x64: <https://archive.torproject.org/tor-package-archive/torbrowser/15.0.23/tor-expert-bundle-windows-x86_64-15.0.23.tar.gz>
- Архив Linux x64: <https://archive.torproject.org/tor-package-archive/torbrowser/15.0.23/tor-expert-bundle-linux-x86_64-15.0.23.tar.gz>
- Архив macOS Intel: <https://archive.torproject.org/tor-package-archive/torbrowser/15.0.23/tor-expert-bundle-macos-x86_64-15.0.23.tar.gz>
- Архив macOS Apple Silicon: <https://archive.torproject.org/tor-package-archive/torbrowser/15.0.23/tor-expert-bundle-macos-aarch64-15.0.23.tar.gz>
- Tor: 0.4.9.12; транспорт lyrebird: 0.8.1.
- GeoIP/GeoIPv6: IPFire Location Database export от 2026-09-08, CC BY-SA 4.0; встроены без отдельного сетевого обновления.
- SHA-256 GeoIP: `25A69C1DC1D946BFDB0B1BA628DB36E9668C51639963C2EE2AFDA7DC857F66A5`.
- SHA-256 GeoIPv6: `0A3B61BA326550D66A4C805563BE25E28F1D59E5CDFC06B091BFDD9EA2C8F998`.
- SHA-256 Windows x64: `231DAD6B9CB401A54C260DB7046965EF04E4F72FF071B140D423FB5DA281AB1E`
- SHA-256 Linux x64: `08D49DE27F542B8F73E2014E064D8320562B5D20019C03D4725C5A5249D97985`
- SHA-256 macOS Intel: `BE1BE1CB13CD093713F02A0BEADE0D2471B61119011BFEB0EFC08353EADF2E4E`
- SHA-256 macOS Apple Silicon: `E8EA3F667C83309ABAD34280F0F9E1CFAE52843DA6B8DB111CA15D6221051DB5`
- Signed checksum manifest: <https://archive.torproject.org/tor-package-archive/torbrowser/15.0.23/sha256sums-signed-build.txt> (Tor Browser Developers primary fingerprint `EF6E286DDA85EA2A4BA7DE684E2C6E8793298290`).

Вместе с приложением распространяется неизменённое содержимое `TorExpertBundle`, включая каталог `docs` с лицензиями и уведомлениями Tor Project и всех pluggable transports. Эти файлы являются частью portable-пакета и не должны удаляться.

## Rust и npm зависимости

Версии Rust-зависимостей зафиксированы в `src-tauri/Cargo.lock`, npm-зависимостей — в `package-lock.json`. Каждый компонент сохраняет собственную лицензию. Перед публичным релизом рекомендуется сформировать полный машинный отчёт лицензий с `cargo-about` и `license-checker` или эквивалентными инструментами.

## Встроенные шрифты

Portable-сборка включает локальные WOFF2-наборы Latin/Cyrillic начертаний 400 и 500 и не требует установки шрифтов в операционной системе:

- IBM Plex Sans Condensed 2.0.0 — Copyright © 2017 IBM Corp.; SIL Open Font License 1.1; <https://github.com/IBM/plex>;
- Fira Sans Condensed 5.3.0 — Copyright 2012–2015 The Mozilla Foundation and Telefonica S.A.; SIL Open Font License 1.1; <https://github.com/mozilla/Fira>;
- Noto Sans 5.3.0 — Copyright 2022 The Noto Project Authors; SIL Open Font License 1.1; <https://github.com/notofonts/latin-greek-cyrillic>;
- Source Sans 3 5.3.0 — Copyright 2010, 2012 Adobe Systems Incorporated; SIL Open Font License 1.1; <https://github.com/adobe-fonts/source-sans>;
- Golos Text 5.3.0 — Copyright 2019 The Golos Text Project Authors; SIL Open Font License 1.1; <https://github.com/googlefonts/golos-text>;
- Martian Mono 5.3.0 — Copyright 2020 The Martian Mono Project Authors; SIL Open Font License 1.1; <https://github.com/evilmartians/mono>;
- Inter 5.3.0 — Copyright 2016 The Inter Project Authors; SIL Open Font License 1.1; <https://github.com/rsms/inter>;
- Onest 5.3.1 — Copyright 2021 The Onest Project Authors; SIL Open Font License 1.1; <https://github.com/simpals/onest>.

Полные тексты OFL поставляются npm-пакетами исходного дерева; этот файл с уведомлениями входит в каждую portable-сборку рядом с приложением.

## SQLCipher runtime для импорта qTox

Каталог `runtime/qtox-import` содержит одну воспроизводимо собранную MSVC x64 DLL, необходимую только для чтения зашифрованной базы истории при импорте. Два чистых дерева SQLCipher дали побайтно одинаковый результат. OpenSSL и статический MSVC CRT связаны внутри DLL; отдельные OpenSSL, MinGW и VC runtime DLL не распространяются:

- SQLCipher 4.19.0 / SQLite 3.53.4 — BSD-style/public-domain components: <https://github.com/sqlcipher/sqlcipher/releases/tag/v4.19.0>;
- OpenSSL 3.5.8 LTS — Apache License 2.0: <https://github.com/openssl/openssl/releases/tag/openssl-3.5.8>;
- SQLCipher source archive SHA-256: `7075F96CBABE45B4ECFC2E6B1745A625F856F695B0827A5506CE9ED85B906AA0`;
- OpenSSL official source archive SHA-256: `A8F84A39918EC6415CE765D9B429D313BA97B8143169C172E734B9514464F5B2`.

SHA-256 распространяемой `libsqlcipher-0.dll` (`4C5B3A4433C8882040050E77260E4D0CF4971916B7160E1DAE0DA2B078F3C4B6`, 4 996 608 байт) зафиксирован и проверяется в `scripts/prepare-dependencies.ps1`. Два полностью независимых clean-run дали побайтно одинаковые DLL и import library; проверка также исключает build-host пути из бинарника.

## Linux AppImage packaging runtime

- AppImage type-2 runtime `runtime-x86_64` (immutable local snapshot of the upstream `continuous` asset updated 2026-09-28) — MIT; SHA-256 `156F4BDBDE9C52D01814600013E0A273F0118DC2DE98975F3C8C63427EC79074`, 944 632 байта: <https://github.com/AppImage/type2-runtime>;
- AppRun из `tauri-apps/binary-releases`, `linuxdeploy-07333c6` и `linuxdeploy-plugin-appimage` — MIT: <https://github.com/tauri-apps/binary-releases>, <https://github.com/linuxdeploy/linuxdeploy>, <https://github.com/linuxdeploy/linuxdeploy-plugin-appimage>;
- `linuxdeploy-plugin-gtk` — встроенный файл `tauri-bundler-v2.10.0`, SHA-256 `EF6B9A980417243BC62E0241B51DC49876032AFD1BAB9B4762389F961B406D9B`; исходный проект MIT: <https://github.com/tauri-apps/tauri/tree/tauri-bundler-v2.10.0/crates/tauri-bundler/src/bundle/linux/appimage>, <https://github.com/tauri-apps/linuxdeploy-plugin-gtk>;
- `linuxdeploy-plugin-gstreamer` — встроенный файл `tauri-bundler-v2.10.0`, SHA-256 `2A15CE9DA8DE6E20159E1AB27861A7A5EF8758C81A6278BA4AB30CEFA1D74C9F`, используется как build-вход. В закреплённом upstream snapshot нет отдельного LICENSE-файла или license header, поэтому этому файлу здесь намеренно не приписывается лицензия.

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
