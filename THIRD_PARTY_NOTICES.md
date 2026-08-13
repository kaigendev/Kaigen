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
- Версия в portable-сборке: 151.0.4129.59 x64

Этот runtime входит только в Windows-архив. Debian использует WebKitGTK, macOS — системный WebKit.

Файлы runtime сохраняют подписи, уведомления и лицензии Microsoft. Их нельзя выборочно удалять из portable-пакета.

## mlkem-native 1.3.0

- Источник: <https://github.com/pq-code-package/mlkem-native>
- Релиз: <https://github.com/pq-code-package/mlkem-native/releases/tag/v1.3.0>
- Лицензирование используемых исходников `mlkem/*`: Apache-2.0 OR ISC OR MIT.

Клиент статически включает переносимую C-реализацию ML-KEM-768. Полный исходный текст и оригинальный файл `LICENSE` входят в source-архив в каталоге `vendor/mlkem-native-1.3.0`.

## Tor Expert Bundle 15.0.19

- Официальная загрузка: <https://www.torproject.org/download/tor/>
- Архив Windows x64: <https://archive.torproject.org/tor-package-archive/torbrowser/15.0.19/tor-expert-bundle-windows-x86_64-15.0.19.tar.gz>
- Архив Linux x64: <https://archive.torproject.org/tor-package-archive/torbrowser/15.0.19/tor-expert-bundle-linux-x86_64-15.0.19.tar.gz>
- Архив macOS Intel: <https://archive.torproject.org/tor-package-archive/torbrowser/15.0.19/tor-expert-bundle-macos-x86_64-15.0.19.tar.gz>
- Архив macOS Apple Silicon: <https://archive.torproject.org/tor-package-archive/torbrowser/15.0.19/tor-expert-bundle-macos-aarch64-15.0.19.tar.gz>
- Tor: 0.4.9.11; транспорт lyrebird: 0.8.1.
- SHA-256 Windows x64: `6AC067402C7B4A3DC37887ED3754B3914B67FDC220C966190683E9CCF91ABF0F`
- SHA-256 Linux x64: `5A8F19F5F119B5FA2A8FD799A3A532E3236AD36164241800D6302E32F0E1C2A9`
- SHA-256 macOS Intel: `95243F76BCF05D6179D017C3F3E4ECE7B53CC58DFF1BA617B03A2FE2C8298B5B`
- SHA-256 macOS Apple Silicon: `C99CF6F69740A443C7FFFAF598CEB0952B3914041507C8AFE11BED84A3333EB1`

Вместе с приложением распространяется неизменённое содержимое `TorExpertBundle`, включая каталог `docs` с лицензиями и уведомлениями Tor Project и всех pluggable transports. Эти файлы являются частью portable-пакета и не должны удаляться.

## Rust и npm зависимости

Версии Rust-зависимостей зафиксированы в `src-tauri/Cargo.lock`, npm-зависимостей — в `package-lock.json`. Каждый компонент сохраняет собственную лицензию. Перед публичным релизом рекомендуется сформировать полный машинный отчёт лицензий с `cargo-about` и `license-checker` или эквивалентными инструментами.

## SQLCipher runtime для импорта qTox

Каталог `runtime/qtox-import` содержит неизменённые DLL из официальной Windows x64 сборки qTox, необходимые только для чтения зашифрованной базы истории при импорте:

- SQLCipher / SQLite — BSD-style license: <https://github.com/sqlcipher/sqlcipher>;
- OpenSSL 3 — Apache License 2.0: <https://www.openssl.org/source/license.html>;
- GCC/MinGW runtime (`libgcc`, `libstdc++`, `libwinpthread`) — GPL с GCC Runtime Library Exception и соответствующие лицензии MinGW-w64.

SHA-256 каждого распространяемого DLL зафиксирован и проверяется в `scripts/prepare-dependencies.ps1`.

## Проверка орфографии

- `nspell` — MIT: <https://github.com/wooorm/nspell>;
- английский и русский Hunspell-словари — <https://github.com/wooorm/dictionaries>.

Оригинальные тексты лицензий словарей входят в `runtime/dictionaries/LICENSE-en.txt` и `runtime/dictionaries/LICENSE-ru.txt`.

## Tauri plugins

Системный трей, открытие portable-каталогов и уведомления реализованы с Tauri 2 и официальными plugins. Исходники и лицензии: <https://github.com/tauri-apps/tauri> и <https://github.com/tauri-apps/plugins-workspace>.
