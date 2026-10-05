# Spec Delta

## Purpose

Получать человекочитаемую версию релиза из уже существующей версии продукта и выявлять несогласованные manifests до дорогих операций.

## ADDED Requirements

### Requirement: Единое вычисление версии
Release label и tag SHALL вычисляться из package.json при проверке согласованности lock, Cargo и Tauri manifests; изменение SHALL NOT менять версию продукта.

#### Scenario: Согласованные manifests
- **WHEN** manifests содержат одну версию продукта
- **THEN** сценарии получают один release label, tag и package version.

#### Scenario: Несогласованность
- **WHEN** обязательный manifest отсутствует или содержит другую версию
- **THEN** операция завершается ошибкой до сборки либо публикации.

### Requirement: Исторические ограничения publisher
Исторический publisher MUST сохранять фиксированные доверенные producer runs, source identities, workflow, release и tag; вычисленная текущая версия MUST NOT расширять эти полномочия.

#### Scenario: Новая версия при старом publisher
- **WHEN** текущий tag не совпадает с разрешённым историческим tag или каталогом проверок
- **THEN** publisher отклоняет запуск, сохраняя прежние ограничения.
