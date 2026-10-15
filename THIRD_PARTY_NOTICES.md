# Сторонние компоненты

## c-toxcore

- Источник сборки: <https://github.com/kaigendev/kaigen-toxcore>.
- Базовая версия: upstream v0.2.24-rc.2 (API 0.2.24); форк Kaigen.
- Зафиксированный commit: `ec7bd2cce618ed6542fbc55b84574704eb380ef2`.
- Форк включает ограничение повторных запросов, исправления безопасности 1–8, а также исправления наследования сокетов Windows и HTTP CONNECT. История исправлений хранится в `patches/c-toxcore`; сборка не накладывает их повторно.
- Исходное авторство и лицензии сохранены в репозитории форка, включая `UPSTREAM.md` и файлы лицензий.
- Лицензия: GPL-3.0-or-later

Нативная библиотека `toxcore.dll`, `libtoxcore.so` или `libtoxcore.dylib` распространяется вместе с соответствующей сборкой и статически включает libsodium.

Внутри принятого fork находится cmp v20 (MessagePack v5) с сохранёнными fork patches. Это vendored часть указанного c-toxcore commit, лицензия MIT, upstream <https://github.com/camgunz/cmp/releases/tag/v20>. Она не загружается отдельным runtime и не заменяется произвольным upstream HEAD.

## pthreads4w 3.0.x

- Источник: <https://github.com/fwbuilder/pthreads4w>
- Зафиксированный commit: `44daa2441137b90477b449663abe9755b2c9a16b`
- Лицензия: Apache-2.0

MSVC-сборка `pthreadVC3.dll` с `/MT` поставляется рядом с `toxcore.dll`; устанавливать pthreads или Visual C++ Runtime на пользовательском ПК не требуется.

## libsodium 1.0.22-stable

- Источник и бинарные пакеты: <https://download.libsodium.org/libsodium/releases/>
- Используемые immutable stable snapshots: source от 2026-10-13 и MSVC от 2026-10-15: <https://download.libsodium.org/libsodium/releases/libsodium-1.0.22-stable.tar.gz> и <https://download.libsodium.org/libsodium/releases/libsodium-1.0.22-stable-msvc.zip>.
- SHA-256 source-архива: `EB9873CC5CCD7B26EF058394264663C99E9C047B423BE1FFD484071774198F26`; 2 099 899 байт.
- SHA-256 MSVC-архива: `24EEB847B38C9DF0C54652FC70C90A5EBB1E6ED5E9B7174F08DE0415ECFA7971`; 26 199 211 байт.
- Detached minisign-подписи обоих официальных архивов проверены ключом из <https://doc.libsodium.org/installation>.
- Лицензия: ISC

## Microsoft Edge WebView2 Fixed Version Runtime

- Загрузка: <https://developer.microsoft.com/microsoft-edge/webview2/>
- Условия распространения: <https://www.microsoft.com/software-download/webview2>
- Версия в portable-сборке: 155.0.4283.45 x64
- SHA-256 CAB: `EC533BF1B7354D288703CF821A2D640D0130108224F93E330BB9C09FAF3F8010`; 310 544 938 байт. Подпись распакованного `msedgewebview2.exe`: Microsoft Corporation, Valid.

Этот runtime входит только в Windows-архив. Debian использует WebKitGTK, macOS — системный WebKit.

Файлы runtime сохраняют подписи, уведомления и лицензии Microsoft. Их нельзя выборочно удалять из portable-пакета.

## mlkem-native 2.0.0

- Источник: <https://github.com/pq-code-package/mlkem-native>
- Релиз: <https://github.com/pq-code-package/mlkem-native/releases/tag/v2.0.0>
- SHA-256 source archive: `10D33BF60B7940EA812782DC89160154CC4A613BD2BEF5EC63EBE39A8B0EC8A4`
- Лицензирование используемых исходников `mlkem/*`: Apache-2.0 OR ISC OR MIT.

Клиент статически включает переносимую C-реализацию ML-KEM-768. Полный исходный текст и оригинальный файл `LICENSE` входят в source-архив в каталоге `vendor/mlkem-native-2.0.0`.

## Tor Expert Bundle 15.0.25

- Официальная загрузка: <https://www.torproject.org/download/tor/>
- Архив Windows x64: <https://archive.torproject.org/tor-package-archive/torbrowser/15.0.25/tor-expert-bundle-windows-x86_64-15.0.25.tar.gz>
- Архив Linux x64: <https://archive.torproject.org/tor-package-archive/torbrowser/15.0.25/tor-expert-bundle-linux-x86_64-15.0.25.tar.gz>
- Архив macOS Intel: <https://archive.torproject.org/tor-package-archive/torbrowser/15.0.25/tor-expert-bundle-macos-x86_64-15.0.25.tar.gz>
- Архив macOS Apple Silicon: <https://archive.torproject.org/tor-package-archive/torbrowser/15.0.25/tor-expert-bundle-macos-aarch64-15.0.25.tar.gz>
- Tor: 0.4.9.14. Исходные официальные bundle включают lyrebird 0.8.1.
- GeoIP/GeoIPv6: IPFire Location Database export от 2026-10-15, CC BY-SA 4.0. Подпись исходной IPFire database проверена; формат Tor получен штатным `geoip-db-tool` из Tor commit `8fe2745aee2c3511`.
- SHA-256 GeoIP: `9EEFC7CBF75278DEAF70B877E41761170CFEE8FA81754BCF23EF9159262FD30F`; 9 786 103 байта.
- SHA-256 GeoIPv6: `6C936FC6A1D655D92CA5B01DA9F3E8D7246CB569E35BFCDC3C8645D495E5C2F4`; 16 706 218 байт.
- SHA-256 Windows x64: `C1988C701DE2F24F7D098D1D6D7F507B58F27740D097F29C246E0524D639B252`
- SHA-256 Linux x64: `19CF18726EECB362E0F21D27AFA9EA9EFE5DA928BFDFBB1CEB5FE54519E87F4A`
- SHA-256 macOS Intel: `E1AE4D4A734D28BB590839188511DEB3CEBC26FCBCE9DF66D01B2C452060FE95`
- SHA-256 macOS Apple Silicon: `A3FEBB6179152B0B4F56A0F5CC57BF5CC8ECEF7DB35E7C3E9D5A044C8158C26C`
- Signed checksum manifest: <https://archive.torproject.org/tor-package-archive/torbrowser/15.0.25/sha256sums-signed-build.txt> (Tor Browser Developers primary fingerprint `EF6E286DDA85EA2A4BA7DE684E2C6E8793298290`).

Официальные архивы сохраняются неизменными как base inputs. Windows, Debian, macOS и Web используют отдельно собранный lyrebird 0.9.0; Mac universal overlay поддерживает macOS 12 и новее. Все платформы получают указанный GeoIP dataset. Каталог `docs` с лицензиями Tor Project и transport-компонентов сохраняется в portable-пакете.

Conjure — отдельный helper overlay поверх неизменённого официального Tor Expert Bundle 15.0.25: Tor PT fork snapshot `0090962226b82aa4a8fc38506f9b98de67d0781e`, <https://gitlab.torproject.org/tpo/anti-censorship/pluggable-transports/conjure/-/tree/0090962226b82aa4a8fc38506f9b98de67d0781e>. Вложенная Conjure остаётся 0.9.1; uTLS обновлена до 1.8.2, Snowflake — до 2.15.1. Conjure использует Snowflake common/certs; Pion WebRTC 4.2.23 и DTLS 3.1.12 закреплены в module graph, но не входят в этот бинарник. Прежний DTLS v2 fork сохранён. Windows/Linux helpers собраны Go 1.27.2, macOS universal — Go 1.26.8 для minimum macOS 12; CGO выключен. Рабочий torrc Kaigen сохранён, upstream example torrc не импортирован. Лицензия BSD-3-Clause сохранена в CONJURE-LICENSE. Exact source/toolchain/module/archive/binary hashes — runtime-manifests/vendor-inputs/provenance.json.

## lyrebird 0.9.0 + Kaigen Snowflake 2.15.1 patch для Windows, Debian, macOS и Web

- Источник: <https://gitlab.torproject.org/tpo/anti-censorship/pluggable-transports/lyrebird>; signed tag `0.9.0`, commit `89d54872b176f936232ff39f7a8189b77d83d65e`.
- SHA-256 source archive: `5CCF068125CC81A1ED13D66E1412BD4B944D1D4746C7026120403BF93C7FA831`; 118 046 байт.
- Snowflake target commit `4f0256ed4f948d1c90fef465466c6b1e252cb3c4`; patch manifest — patches/lyrebird/manifest.json. Lyrebird base 0.9.0 изменён ограниченным patch-set; Pion WebRTC 4.2.23 / DTLS 3.1.12 сохраняют необходимые nonce epoch/sequence securityfix semantics. Upstream base binary не заявляется неизменённым. Совместимость Snowflake 2.15.1 с transport/v5 обеспечена минимальным исправлением импортов: `patches/snowflake-2.15.1-transport-v5`; manifests обоих helpers закрепляют точный patch и module inputs.
- Лицензия: BSD-3-Clause. Исходный LICENSE включён в отдельные локальные archives и сохраняется рядом с runtime.
- Pure Go build: `CGO_ENABLED=0`, Go 1.27.2 для Windows/Linux и Go 1.26.8 для macOS, patched `go.mod`/`go.sum`, полный locked offline module graph; Snowflake 2.15.1, WebTunnel 0.0.7, uTLS 1.8.2.
- SHA-256 Mac universal archive `lyrebird-0.9.0-kaigen-snowflake2.15.1-pion4.2.23-dtls3.1.12-macos-universal-go1.26.8.tar.gz`: `E692B6AF603F409B9C8306ADC5ACB763F9FD3CEF76BD76D5541D37004AED69B3`; 26 234 544 байт. SHA-256 universal binary: `3CB91C10829E0875ED2EF13B6062D1B9746C9AE884B7B54DE6CC65B5CAC25B80`; 52 032 226 байт.
- На macOS обе архитектуры `x86_64` и `arm64` объединены в universal binary, собранный закреплённым Go 1.26.8. Минимальная версия продукта — macOS 12. Go 1.27 требует macOS 13 и для этого overlay не используется. Исходные `LICENSE` и `LICENSE-GPL3.txt` сохранены рядом с runtime.

## Rust и npm зависимости

Версии Rust-зависимостей зафиксированы в `src-tauri/Cargo.lock` и `web/kaigen-webd/Cargo.lock`, npm-зависимостей — в `package-lock.json`. React/React DOM 19.3.1 (MIT), Tauri/API 2.12.4, tauri-build 2.7.3 и официальный CLI 2.12.3 сохраняют собственные лицензии. Linux packaging использует отдельный managed CLI 2.12.3 с bundler 2.10.3 (Apache-2.0 OR MIT); официальный исходный manifest уже содержит этот bundler и не требует прежнего patch. Исходный archive, полный Cargo.lock, features и binary provenance закреплены в patches/tauri-cli/manifest.json. Активная Windows-сборка использует `windows-core` 0.100.0 с `windows` 0.62.2 и `webview2-com` 0.39.1 через закреплённые исправления совместимости. Оригинальные архивы, лицензии, SHA-256 и точные изменения сохранены в `runtime-manifests/vendor-inputs/windows-core-0100` и `patches/windows-core-0100`; исходники `windows-core` 0.100.0 не изменены. Каждый компонент сохраняет собственную лицензию.

## Встроенные шрифты

Portable-сборка включает локальные WOFF2-наборы Latin/Cyrillic начертаний 400 и 500 и не требует установки шрифтов в операционной системе:

- IBM Plex Sans Condensed 2.0.0 — Copyright © 2017 IBM Corp.; SIL Open Font License 1.1; <https://github.com/IBM/plex>;
- Fira Sans Condensed 5.3.0 — Copyright 2012–2015 The Mozilla Foundation and Telefonica S.A.; SIL Open Font License 1.1; <https://github.com/mozilla/Fira>;
- Noto Sans 5.3.0 — Copyright 2022 The Noto Project Authors; SIL Open Font License 1.1; <https://github.com/notofonts/latin-greek-cyrillic>;
- Source Sans 3 5.3.1 — Copyright 2010, 2012 Adobe Systems Incorporated; SIL Open Font License 1.1; <https://github.com/adobe-fonts/source-sans>;
- Golos Text 5.3.0 — Copyright 2019 The Golos Text Project Authors; SIL Open Font License 1.1; <https://github.com/googlefonts/golos-text>;
- Martian Mono 5.3.0 — Copyright 2020 The Martian Mono Project Authors; SIL Open Font License 1.1; <https://github.com/evilmartians/mono>;
- Inter 5.3.0 — Copyright 2016 The Inter Project Authors; SIL Open Font License 1.1; <https://github.com/rsms/inter>;
- Onest 5.3.1 — Copyright 2021 The Onest Project Authors; SIL Open Font License 1.1; <https://github.com/simpals/onest>.

Полные тексты OFL поставляются npm-пакетами исходного дерева; этот файл с уведомлениями входит в каждую portable-сборку рядом с приложением.

## SQLCipher runtime для импорта qTox

Каталог `runtime/qtox-import` содержит одну воспроизводимо собранную MSVC x64 DLL, необходимую только для чтения зашифрованной базы истории при импорте. Два чистых дерева SQLCipher с собственным full-source портом SQLite 3.54.0 для Kaigen дали побайтно одинаковые DLL и import-библиотеки. OpenSSL и статический MSVC CRT связаны внутри DLL; отдельные OpenSSL, MinGW и VC runtime DLL не распространяются:

- SQLCipher 4.19.0 / SQLite 3.54.0 — BSD-style/public-domain components; SQLite перенесена полным source patch-set Kaigen на базу SQLCipher 4.19.0, а не взята из официального upstream SQLCipher-релиза с этой парой версий: <https://github.com/sqlcipher/sqlcipher/releases/tag/v4.19.0>, <https://www.sqlite.org/2026/sqlite-src-3540000.zip>;
- OpenSSL 4.0.3 — Apache License 2.0: <https://github.com/openssl/openssl/releases/tag/openssl-4.0.3>;
- SQLCipher source archive SHA-256: `7075F96CBABE45B4ECFC2E6B1745A625F856F695B0827A5506CE9ED85B906AA0`;
- SQLite 3.54.0 source archive SHA-256: `8847659821E0C5116BD14A94644C82BA932B2D9A05AC81AF2E34AF814AAD7C58`, 14 881 448 байт;
- OpenSSL official source archive SHA-256: `325B5C806167C13B40B1FFEADFE0248197C00ECCC4CF123EC1E28D2D2FD216D9`; 55 235 667 байт. Detached release signature проверена.

SHA-256 распространяемой `libsqlcipher-0.dll` (`91D26CAB5D2B43D39CB5BD53A865B7FBD7EC4D051A57239B06703C2C433A5D51`, 4 882 944 байта) зафиксирован и проверяется в `scripts/prepare-dependencies.ps1`. Две независимые сборки дали побайтно одинаковые DLL и import-библиотеки; проверка также исключает build-host пути из бинарника. Полные source/patch/build bindings находятся в `patches/sqlcipher/manifest.json` и `runtime/qtox-import/provenance.json`.

Новая DLL прочитала три синтетических codec fixture, созданных baseline DLL SQLCipher 4.19.0 / SQLite 3.53.4. Keyed SQLite health, отклонение неверного ключа и production qTox history SELECT прошли; hashes fixture не изменились. Это доказательство для синтетических данных, без утверждения о проверке реальных qTox-профилей.

## Linux AppImage packaging runtime

- AppImage type-2 runtime `runtime-x86_64` (immutable local snapshot of the upstream `continuous` asset updated 2026-09-28) — MIT; SHA-256 `156F4BDBDE9C52D01814600013E0A273F0118DC2DE98975F3C8C63427EC79074`, 944 632 байта: <https://github.com/AppImage/type2-runtime>;
- AppRun `apprun-old` из `tauri-apps/binary-releases` и `linuxdeploy-07333c6` — закреплённые inputs bundler 2.10.3, MIT: <https://github.com/tauri-apps/binary-releases>, <https://github.com/linuxdeploy/linuxdeploy>;
- `linuxdeploy-plugin-appimage` — текущий upstream continuous snapshot от 2026-10-01, SHA-256 `49D6A17160675A6BD1781699AAE6BDF7692D98552E02A3671D2183D10547842E`, 16 488 952 байта, MIT: <https://github.com/linuxdeploy/linuxdeploy-plugin-appimage>. Вложенный appimagetool SHA-256 `58D3047A420E1DFA365EF0AD495B728B56627803CB6B75ED816B7A4FA9713720`.
- `linuxdeploy-plugin-gtk` — встроенный файл `tauri-bundler-v2.10.3`, SHA-256 `EF6B9A980417243BC62E0241B51DC49876032AFD1BAB9B4762389F961B406D9B`; исходный проект MIT: <https://github.com/tauri-apps/tauri/tree/tauri-bundler-v2.10.3/crates/tauri-bundler/src/bundle/linux/appimage>, <https://github.com/tauri-apps/linuxdeploy-plugin-gtk>;
- `linuxdeploy-plugin-gstreamer` — встроенный файл `tauri-bundler-v2.10.3`, SHA-256 `2A15CE9DA8DE6E20159E1AB27861A7A5EF8758C81A6278BA4AB30CEFA1D74C9F`, используется как build-вход. В закреплённом upstream snapshot нет отдельного LICENSE-файла или license header, поэтому этому файлу здесь намеренно не приписывается лицензия.

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
