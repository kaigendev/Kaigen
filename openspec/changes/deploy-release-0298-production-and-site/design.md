# Design

## Context

См. proposal.md. Web production и site показывают0.2.9.7; release0.2.9.8 уже опубликован Actions run37240536775. Site-source исправление готовится только в его owner; Web operational owner принимает immutable main-to-web-client packet.

## Goals / Non-Goals

**Goals:** GitHub-only delivery, сохранённые данные/settings/history, точные payload hashes, live HTTPS/API identity и разрешённый scope двух объектов.

**Non-Goals:** product rebuild, изменение pins/VM/tools/DNS/Tor settings, workspace reset, новый test matrix, перепубликация исходных семи assets.

## Decisions

- Web: прежний функциональный proof переиспользуется только после сравнения package/runtime compatibility; разные compiler versions не называются identical. Проверены87 byte-identical файлов из94; mainJS равен после build-id injection; native ABI общий GLIBC≤2.34. Свежий сервер Debian13/glibc2.41; service loader/cwd/settings и final installed identity проверяются отдельно.
- Delivery: production server скачивает unmodified bootstrap/TAR с GitHub и проверяет pinnedSHA. Обновление A/B сохраняет прежний active release и route snapshot; кандидат должен пройти штатные health/readiness до переключения.
- Site: версия/links/новый milestone во всех7 языках;210 старых локализованных records, UTC-calendar и filterall сохранены. Сборка existing npm dependencies, публичный immutable пакет23files; site package добавляется отдельным manual Actions workflow в тот же published release. Исходные7assets/tag/body/dates не изменяются.
- Opaque SSH: existing site connection/key используются только consumer, PuTTY cached hostkey+batch. Helper отправляет LF UTF8 напрямую в stdin, private stderr/logs остаются local.

## Risks / Trade-offs

- Final native bytes отличаются от Lab: подтверждаются ABI/loader/env compatibility и штатная candidate readiness, без объявления нового Lab runtimePASS.
- Новая публикация сайта может задеть прежние assets: whitelist одного дополнительного имени, fail при differentexistingbytes и before/after guards семи исходных digests.
- Live user data могут меняться параллельно: сверяются только aggregate directory/inode/settings, содержимое не открывается; сам update не выполняет reset/reboot.

## Migration Plan

Readonlypreflight, package/loader closure, inactive-slot update, installed/publicreadback; site reviewedpackage publicationActions, server download/pinnedSHA/public manifestcheck, atomicexchange с сохранённым прежним каталогом. ПослеPASS сохранитьreceipts, taskclosure иархивOpenSpec.
