# Design

## Context

См. proposal.md. Сейчас один Windows job содержит сборку, MSI и finalizer. Версия package.json имеет формат 0.2.9+8, а release label — 0.2.9.8. Исторический publisher закреплён за конкретными run и SHA.

## Goals / Non-Goals

**Goals:** повторять поздний этап и устранить описательные дубликаты версии.
**Non-Goals:** импорт локальных сборок, перенос произвольных чужих runs, изменение опубликованной версии или обобщение исторического publisher.

Граница повторного использования — готовый portable-продукт. MSI сам компилирует маленький shutdown helper; для него package сохраняет прежний Rust toolchain. Это не повтор Cargo/Tauri-сборки приложения.

## Decisions

Сохранить job build и добавить package с needs: build. Передавать узкий набор portable/source ZIP, плана и его check receipts, CI evidence через immutable Actions artifact. Идентификатор artifact, digest manifest и producer attempt передаются outputs; download не принимает внешний run или token. Manifest проверяет полный набор файлов, безопасные пути и provenance перед восстановлением. При повторе producer attempt может быть меньше consumer attempt того же run. Существующий finalizer проверяет доказательства заново.

Новый release-version helper читает package.json и сверяет обязательные manifests. CLI экспортирует KAIGEN_PACKAGE_VERSION, KAIGEN_RELEASE_LABEL, KAIGEN_RELEASE_TAG; historical режим дополнительно проверяет фиксированный tag и verification catalog. Не менять доверенные константы исторического publisher. CI_PATHS дополняется только необходимыми CI helper-файлами.

## Risks / Trade-offs

- [Подмена переданного результата] → тот же run, artifact ID из outputs, manifest SHA, проверки набора и всех файлов, fail closed.
- [Разные hosted runner paths] → сохранять точные pinned paths и отклонять несовместимые; не переписывать доказательства.
- [Новая версия запускает старый publisher] → ранний expected-tag/catalog guard и сохранённые trust allowlists.
- [Локальная проверка не доказывает hosted CI] → отдельная честная отметка; удалённый Actions не запускать без точной команды.

## Migration Plan

Проверить изолированные негативные fixtures, существующие связанные контрактные тесты и workflow. Изменение вступает в CI после отдельно разрешённых commit/push; откат — обычный scoped diff без удаления истории artifacts.
