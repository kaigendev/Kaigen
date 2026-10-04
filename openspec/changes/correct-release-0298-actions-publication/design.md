# Design

## Context

См. proposal.md. Tag v0.2.9.8 разрешается в 724dea3b287f68d5d25700e6cda32b8f161a1296; текущий release 403141563 содержит семь ошибочно принятых локальных assets. Все три Actions этого SHA завершились до сборки. Source HEAD 6a8fc5caf736c52fbe998997363394c42447f55c содержит только последующее архивирование документации.

## Goals / Non-Goals

Финальные Windows ZIP/MSI, Debian ZIP, macOS ZIP, source ZIP и два Web файла создаются, проверяются и публикуются Actions. Используется существующий набор frontend/native/Rust проверок; новые пользовательские сценарии, qTox UI, сетевые матрицы и production не добавляются.

## Decisions

- Сохранить существующий tag и canonical source commit. CI build commit отдельно содержит только разрешённые pipeline/documentation изменения. Перед публикацией Actions сверяет полный Git diff от tag с точным allowlist; application и builder inputs должны совпадать. Реальный built-from новых binaries фиксируется как CI commit, а не подменяется tag SHA.
- Новый catalog 0.2.9.8 задаёт явный полный прогон существующих frontend/native/Rust проверок, без reuse старых passing checks. Прежняя проверенная публичная baseline остаётся проверяемой ссылкой и не объявляется текущим PASS. Старый 0.2.9.7 catalog не переписывается.
- Windows extended jobs получают prepared native cache через существующий native-only producer; MSI получает официальный WiX 3.14.1 с точным SHA-256. Managed component pins сохраняются.
- Публикация запускается доверенным workflow_run только для официального main push и exact CI SHA. Проверяются успешные Windows, Unix/Web и extended runs, их attempts, jobs и artifact IDs/digests; незавершённые runs оставляют выпуск открытым.
- Только Actions переводит текущий release в draft, заменяет ровно семь файлов, публикует и проверяет public bytes. Canonical source ZIP создаётся штатным build-source-archive.ps1 -GitRevision tag-SHA внутри Actions. Web .sh обязан содержать SHA нового bundle.

## Risks / Trade-offs

- Actions artifacts отличаются от локальных candidate bytes: для финальных файлов нужны отдельные hash-bound packaging/smoke receipts. Локальные 14 leaf receipts сохраняются как candidate evidence.
- Частичная ошибка загрузки оставляет release в draft; другая версия и tag не изменяются. Исходные metadata и FAIL сохраняются.
- Повторный workflow_run проверяет уже опубликованную identity перед повторным изменением assets. Непроверенные fork/PR/artifact данные не получают contents-write исполнения.
