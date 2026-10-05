# Proposal

## Why

Текущие наборы inputs нативных и Rust-проверок включают файлы интерфейса, поэтому правка Settings/i18n потребовала повторов неизменённых проверок. Нужно отделить доказанные зависимости этих проверок от входов финального приложения, сохранив полноту и неизменность исходных результатов.

## What Changes

- Проверить реальные транзитивные зависимости трёх Windows native-проверок и Rust library tests; использовать отдельные проверяемые наборы inputs вместо общего набора приложения.
- Сохранять консервативное поведение при неизвестной зависимости, изменении runner, окружения или обязательного требования свежего прогона.
- Подтвердить регрессиями: UI-only изменение не меняет совместимый native fingerprint, а native/Rust dependency, test runner, конфигурация или новый существенный файл меняют его либо блокируют reuse.
- Оставить прежние receipts, их inputs, hashes и timestamps неизменными. Переход на новые наборы не превращает старый несовместимый результат в reusable.
- Обновить относящееся к наборам inputs руководство; не менять продуктовый UI, версии, состав обязательных проверок или release/publication правила.

## Capabilities

### New Capabilities

- `native-verification-inputs`: проверяемые зависимости native/Rust evidence с консервативной инвалидацией и сохранением исходных доказательств.

### Modified Capabilities

Нет. Существующий `windows-ci-handoff` сохраняет свой контракт передачи и упаковки без изменений.

## Impact

Новый source-owned генератор ordinary verification inputs, `incremental-windows-verification.mjs` и соответствующие contract tests. Аудит установил: широкие наборы клонировал одноразовый producer, MAIN worker только принимал план. Существующие CI release catalogs и whole-run inventory в `current-verification.mjs` сохраняются. Проверки оптимизации используют disposable fixtures; действующие Windows/Web artifacts и старые evidence сохраняются.
