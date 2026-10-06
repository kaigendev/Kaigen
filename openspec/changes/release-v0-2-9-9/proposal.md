# Proposal

## Why

Пользователь поручил выпустить Kaigen 0.2.9.9 с уже подготовленными исправлениями сообщений, фокуса Windows и настроек. Версия 0.2.9.8 опубликована; её tag, assets и исторический publisher должны остаться неизменными.

## What Changes

- Согласовать manifest-версию `0.2.9+9` и отображаемую `0.2.9.9` в desktop, Web backend и About.
- Подготовить общий publisher с отдельным манифестом 0.2.9.9, проверяемыми Actions producer artifacts и точной source identity, сохранив ограничения исторического publisher 0.2.9.8. Номер следующей версии не должен требовать изменения кода publisher.
- Зафиксировать immutable candidate, выполнить обязательные Windows, Debian, macOS и Web Lab units, compatibility gate и release matrix.
- Устранить подтверждённый release-блокер раннего ручного приёма файла: metadata-only карточка не должна позволять Accept до появления реального transfer binding. После изменения общего frontend сформировать новый immutable candidate и свежие четыре пакета; исторические результаты B3/B4 сохранить отдельно.
- Собрать и опубликовать семь обязательных assets через GitHub Actions; сохранить hashes, producer/publisher receipts и локальные копии.

## Capabilities

### New Capabilities

- `release-publication`: публикация новой версии из проверенных GitHub Actions artifacts с сохранением ранее опубликованной истории.

### Modified Capabilities

Нет. Существующие требования `release-version-identity` и `windows-ci-handoff` сохраняются.

## Impact

Восемь version manifests/locks и About inventory, новый общий release publisher/workflow, данные конкретного релиза, релизные проверки и OpenSpec. Существующие исправления входят из проверенного исходного HEAD `3e4939e5a0d3cf07631e6daaea3a6a3f87e5b8e5`. Подтверждённый на B4 дефект требует узкого исправления общего UI/политики ручного приёма и связанных regression checks; Rust, managed dependencies и версия остаются прежними.

## Non-goals

Production сайта/Web, изменение опубликованного 0.2.9.8, разработка компактного интерфейса, новые функции и обновление managed components не входят в задачу. Незавершённый план интерфейса сохраняется в основном source owner; релиз готовится в отдельном Git worktree.
