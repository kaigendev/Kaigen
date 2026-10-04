# Design

## Context

См. proposal.md. Tag v0.2.9.8 разрешается в 724dea3b287f68d5d25700e6cda32b8f161a1296; текущий release 403141563 содержит семь ошибочно принятых локальных assets. Все три Actions этого SHA завершились до сборки. Source HEAD 6a8fc5caf736c52fbe998997363394c42447f55c содержит только последующее архивирование документации.

## Goals / Non-Goals

Финальные Windows ZIP/MSI, Debian ZIP, macOS ZIP, source ZIP и два Web файла создаются, проверяются и публикуются Actions. Используется существующий набор frontend/native/Rust проверок; новые пользовательские сценарии, qTox UI, сетевые матрицы и production не добавляются.

## Decisions

- Сохранить существующий tag и canonical source commit. CI build commit отдельно содержит только разрешённые pipeline/documentation изменения. Перед публикацией Actions сверяет полный Git diff от tag с точным allowlist; application и builder inputs должны совпадать. Реальный built-from новых binaries фиксируется как CI commit, а не подменяется tag SHA.
- Новый catalog 0.2.9.8 задаёт явный полный прогон существующих frontend/native/Rust проверок, без reuse старых passing checks. Прежняя проверенная публичная baseline остаётся проверяемой ссылкой и не объявляется текущим PASS. Старый 0.2.9.7 catalog не переписывается.
- Windows extended jobs получают prepared native cache через существующий native-only producer; MSI получает официальный WiX 3.14.1 с точным SHA-256. Managed component pins сохраняются.
- Первый Actions прогон выявил изменение файла по upstream continuous URL: Debian runner восстанавливает прежний pinned AppImage plugin из точного официального upstream Actions artifact. Фиксированный relay отдаёт только redirect; ZIP скачивается без credentials с проверенного GitHub storage, с проверкой producer, размеров и обоих SHA-256. Пин и product builder не меняются.
- Extended Windows jobs используют тот же static CRT флаг, что и подготовленный native cache. При ошибке компиляции существующие stdout/stderr включаются в evidence artifact; состав тестов сохраняется.
- Сохранённый stderr второго прогона подтвердил конкурирующую rustup-установку rust-src из package-local overrides quote/thiserror. Уже выбранный Rust 1.99.0 и rust-src подготавливаются одним Actions step до Cargo; explicit RUSTUP_TOOLCHAIN и RUSTUP_AUTO_INSTALL=0 исключают автоматическую установку внутри параллельных rustc. Версия compiler и dependency pins не обновляются.
- Windows сохраняет успешный Actions run 37232893084 и built-from 2625299/tree 68e1c76; Unix/Web — run 37235459220, ad6ff48/tree f73b466; native-проверки — run 37236924663, 486f2c3/tree a0b05cc. Publisher проверяет каждый source/tree, ancestor, current attempt, jobs, artifact digest и receipt отдельно. Reuse allowlist различается по producer; product, platform builder, locks/pins и catalog остаются неизменными.
- Два Windows FAIL сохраняются: production fixture ошибочно требовал requestRange=null, хотя App допускает cached tail с ranged request. Исправлена только readiness-предпосылка: actual latest row и нижняя граница. Исходные 17+23 assertions, четыре near-tail случая, worker/card/spacer/anchor/search проверки и deadlines сохранены. После локального production PASS этот же existing scenario выполняется Windows Actions job без write token; publisher принимает только его успешный current-attempt evidence и точный SHA-256 исправленной fixture.
- Публикация запускается official main push либо workflow_run трёх exact выбранных успешных producers. Все готовые artifacts переиспользуются; новые дублирующие build/native runs отменяются. Ранее полученные FAIL и PASS сохраняют собственные identities; новый targeted scenario не объявляется новым полным baseline.
- Только Actions переводит текущий release в draft, заменяет ровно семь файлов, публикует и проверяет public bytes. Canonical source ZIP создаётся штатным build-source-archive.ps1 -GitRevision tag-SHA внутри Actions. Web .sh обязан содержать SHA нового bundle.

## Risks / Trade-offs

- Actions artifacts отличаются от локальных candidate bytes: для финальных файлов нужны отдельные hash-bound packaging/smoke receipts. Локальные 14 leaf receipts сохраняются как candidate evidence.
- Частичная ошибка загрузки оставляет release в draft; другая версия и tag не изменяются. Исходные metadata и FAIL сохраняются.
- Повторный workflow_run проверяет уже опубликованную identity перед повторным изменением assets. Непроверенные fork/PR/artifact данные не получают contents-write исполнения.
