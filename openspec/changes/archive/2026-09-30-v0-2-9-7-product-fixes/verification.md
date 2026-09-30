# Адресная проверка v0.2.9.7

Ниже сохранена адресная проверка до release-gate. Правка `web/installer/install-kaigen-web.sh` появилась после выпуска v0.2.9.6 в предыдущей задаче по прямому запросу установить 72-часовой срок на production. Тег и опубликованный Web-пакет v0.2.9.6 содержат 24 часа; после перезагрузки production прежняя задача подтвердила действующие 72 часа. Правка включена в единый кандидат v0.2.9.7, чтобы новая установка не вернула 24 часа.

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

## Итог выпуска и production — 30.09.2026

- Продукт собран из `ffc977091c6a8150e4911c01b1d24b246da26df6` (tree `a05a79128d14e9a91ea984e7a7ecc73651b1d556`); release commit `e7937c27d40ad7ba6112a7998a719e371dcbbc07` содержит только verification-правки сверх того же product/build input. Машинное доказательство эквивалентности: `../outputs/release-v0.2.9.7-ffc9770/verification-revision.json`.
- Инкрементный gate `../outputs/release-v0.2.9.7-ffc9770/phase2-green-checkpoint.json` — GREEN: 14 адресных Windows-проверок, нативные Debian/macOS smoke, Web Lab browser/backend, фактическая геометрия полосы. Квитанция Windows test set охватывает 9 клиентов; макет синхронизирован до публикации, `PROTOTYPE_MAIN_SYNC_PASS`. Неприменимые общая матрица и совместимость с qTox не запускались.
- [GitHub Release v0.2.9.7](https://github.com/kaigendev/Kaigen/releases/tag/v0.2.9.7) опубликован как Latest 30.09.2026 в 10:10:15 UTC. Семь обязательных assets проверены по имени, размеру и SHA-256; Windows Actions `36696057029` и Unix/Web Actions `36696057041` завершились PASS. После обновления сайта добавлен восьмой публичный asset `Kaigen-Site-0.2.9.7.tar.gz`, SHA-256 `72e3f4187b33d26d74e992aeb41bbc8501cf686e310d5810e8d22c62036ca456`; его GitHub digest совпал с пакетом.
- Web production самостоятельно скачал Web installer и bundle из этого GitHub Release. Проверены 91 установленный файл, HTTPS, readiness, build identity, 72-часовой срок и сохранность workspace; receipt в локальном operational-контуре Web, SHA-256 `18185D05017C59AC3C79AFDED388622C76EAA1FE679FA7BF0B62B5EAC88491F7`.
- Сайт production самостоятельно скачал публичный пакет из того же GitHub Release. После атомарного переключения 24/24 активных файлов и 24/24 файлов отката совпали с манифестами, nginx и внешний HTTPS HTML/JS прошли проверку; временный staging удалён. Source сайта зафиксирован коммитом `4aa214b39c52d1408e77b5ab8ebab71a1374323a`, рабочее дерево чистое. Обезличенный checkpoint в локальном operational-контуре сайта имеет SHA-256 `81203F0CB3C50BD5077B8AF5ED0BA09DF82D428A7D718FB9D5CFF1A4579B9C37`. Локальной передачи пакетов в production не было.
