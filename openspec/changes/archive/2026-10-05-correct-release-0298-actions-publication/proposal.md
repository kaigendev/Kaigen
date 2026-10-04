# Proposal

## Why

Релиз 0.2.9.8 ошибочно опубликован из локальных сборок после остановки GitHub Actions до сборки. Пользователь подтвердил обязательное получение финальных файлов и публикацию через Actions; необходимо исправить текущий выпуск, сохранив фактическую историю проверок.

## What Changes

- Актуализировать CI verification для версии 0.2.9.8 и явно выполнить существующие проверки на финальных Actions сборках.
- Подготовить pinned native Windows inputs до расширенных PQ jobs и pinned WiX перед MSI.
- Добавить Actions публикацию семи обязательных файлов с проверкой доверенных runs, SHA-256, source/build identities и точного существующего release.
- Сохранить тег v0.2.9.8 на исходном commit; отдельно фиксировать реальный CI build commit и допустимые отличия CI/documentation.

## Capabilities

### New Capabilities

Нет: исправляется CI и доставка существующего релиза, продуктовые требования не меняются.

### Modified Capabilities

Нет; change использует `skip_specs: true` как tooling-only исправление.

## Impact

GitHub Actions workflows, публичный CI selection/validator, release publication helper. Пять продуктовых исправлений, версии и managed component pins сохраняются. Текущий ошибочный выпуск корректируется только через Actions; другие версии и production не входят в scope. Прежние локальные receipts и исходные Actions FAIL сохраняются.
