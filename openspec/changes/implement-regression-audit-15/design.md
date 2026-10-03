# Design

## Context

См. proposal.md и исходный аудит. Существуют исполняемые TypeScript-модули через `import-typescript-module.mjs`, Chromium React runtime fixture, Rust unit/integration/fault tests и платформенные scripts. Текущий агрегатор содержит 38 npm-семейств; две готовые регрессии отсутствуют. Исторический selector привязан к release-0297 и не служит универсальным каталогом.

## Goals / Non-Goals

**Goals:** дополнить ближайшие существующие production-тесты, управлять отказами и порядком ответов, выполнять проверки и сохранять evidence по каждому пункту.

**Non-Goals:** переписывание рабочих тестов, произвольный аудит, изменение frozen proof ради PASS, доступ к приватным данным, release/publication или новая managed dependency.

## Decisions

1. Порядок 1–15 фиксирован. Перед каждым пунктом сверяются действующее покрытие и точные source paths; глубокое чтение будущих фаз откладывается. Альтернатива раннего объединения 1/8/9 отклонена прямым указанием пользователя.
2. Пункт 1 сохраняет npm `&&` агрегатор и исторический selector. Небольшой каталог классифицирует тестовые entrypoints; проверка отказа запускает копию текущего npm-агрегатора в disposable каталоге с контролируемым отказом настоящего набора.
3. Backend проверки используют существующие Rust fixtures и ограниченный fault injection. UI проверки исполняют реальные React components с deferred backend responses, disposable state и управляемыми failure paths. Source assertions сохраняются только как вспомогательные contracts.
4. Один read-only контролёр независимо принимает evidence текущего пункта. Основной исполнитель остаётся единственным писателем; подтверждённые defects получают bounded repair и отрицательный контроль, где он воспроизводим.
5. Source, runner и artifact hashes записываются отдельно. Новый app build нужен только при изменении влияющих product inputs; test-only change не требует повторной компиляции неизменного приложения.

## Risks / Trade-offs

- Неполная simulation backend может скрыть дефект: UI fixture не заменяет backend transaction tests; обе стороны проверяются отдельно.
- Платформенные предпосылки могут отсутствовать: сначала используются существующие локальные runners/artifacts, отсутствующие результаты фиксируются как blocker.
- Ошибки в harness могут имитировать product failures: сохраняется первый вывод и отдельно проверяется ограниченная причина перед ремонтом.
- Fault injection не должен попадать в production: test-only hooks ограничены тестовой конфигурацией; реальная production-функция остаётся исполняемым subject.

## Migration Plan

Изменения остаются локальными. Per-point evidence хранится рядом с change, сырые disposable test outputs — в локальном evidence каталоге. При product fixes применяются обязательные локальные finish steps текущего owner; публикация не запускается.
