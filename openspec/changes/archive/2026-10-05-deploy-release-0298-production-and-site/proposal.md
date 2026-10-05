# Proposal

## Why

Опубликованный через Actions Kaigen 0.2.9.8 ещё не развёрнут на Web production, а официальный сайт показывает 0.2.9.7. Пользователь прямо поручил обновить оба объекта.

## What Changes

- Развернуть exact опубликованные Web installer/TAR 0.2.9.8 штатным A/B route после подтверждения artifact/runtime compatibility.
- Обновить версию, загрузки и историю сайта, сохранив все прежние milestones и фильтр.
- Доставить public site package через GitHub Actions/GitHub download и подтвердить live readback.
- Сохранить production settings/user data, прежний active release/route и secret-free receipts.

## Capabilities

### New Capabilities

Нет: новая продуктовая функция не добавляется; используются ранее выпущенные спецификации и operational delivery.

### Modified Capabilities

Нет: skip_specs=true; изменяются deployment, public release content и при необходимости точный publication tooling.

## Impact

Web operational owner, site source owner, https://web.kaigen.one/, https://kaigen.one/, exact GitHub release403141563 и только необходимый Actions site publication. Canonical product source, pins, VM/tools, исторические releases и содержимое workspaces не меняются.
