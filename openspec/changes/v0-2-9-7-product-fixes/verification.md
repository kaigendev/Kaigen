# Адресная проверка v0.2.9.7

Состояние до release-gate; итоговые identity и receipts вносятся после сборки и публикации. Правка `web/installer/install-kaigen-web.sh` появилась после выпуска v0.2.9.6 в предыдущей задаче по прямому запросу установить 72-часовой срок на production. Тег и опубликованный Web-пакет v0.2.9.6 содержат 24 часа; после перезагрузки production прежняя задача подтвердила действующие 72 часа. Правка включается в единый кандидат v0.2.9.7, чтобы новая установка не вернула 24 часа.

| Изменение | Проверка | Результат |
| --- | --- | --- |
| Геометрия полосы настроек | Chromium fixture с фактическим `App.css`: выбранный пункт сохранил координаты, полоса сместилась на 12 CSS px в правый отступ | PASS только для изолированной геометрии CSS; полный Web ещё не проверен |
| Язык Web-оболочки и порог окна | `node scripts/test-product-boundaries.mjs` (28 утверждений), `tsc -p tsconfig.web.json --noEmit` | PASS статический контракт и типы; готовый Web-кандидат ещё не проверен |
| Срок жизни Web-пространства | Сверка точной строки установщика v0.2.9.7, `bash -n` и содержимого собираемого Web-пакета | Проверка строки и синтаксиса до нового снимка; Web-пакет и production readback ожидаются |
| Удалённая цитата | Адресный SSR-рендер `MessageQuotePreview` в RU/EN: заглушка видна, кнопки перехода и имени удалённой цели нет | PASS |
| Дополнительная энтропия | `node scripts/test-pq-entropy-ui.mjs`: срок сбора 15 с, срок успеха 5+2 с, очистка при смене чата | PASS статический контракт; живой таймер ещё не проверен |
| История и очереди | `cargo test --offline --locked --manifest-path src-tauri/Cargo.toml --lib local_message_deletion --no-default-features --features web-core -- --nocapture`; `cargo check --offline --locked --manifest-path src-tauri/Cargo.toml --lib`; `rustfmt --edition 2021 --check src/message_deletion.rs src/pq_delivery_tests.rs` | 14 адресных сценариев PASS; Desktop check и формат затронутых файлов PASS. Включены восстановление незарегистрированной истории и защита чужого кеша при коллизии ID |
| Версия и компоненты | `node scripts/test-component-inventory.mjs`, сверка package/lock/Cargo/Tauri/About/CI labels | PASS для v0.2.9.7; сторонние pins и hashes не менялись |

Совместимость с qTox функционально не тестируется по явному указанию пользователя. Полная общая матрица не запускается; каждый следующий gate выбирается по точному diff и `context.local/testing/INCREMENTAL.md`.
