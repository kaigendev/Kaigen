# Spec Delta

## Purpose

Публиковать новую версию Kaigen из проверенных GitHub Actions artifacts с точной привязкой исходников, обязательных проверок и файлов, сохраняя уже опубликованную историю.

## ADDED Requirements

### Requirement: Проверяемое происхождение каждого asset

Publisher MUST принимать только artifacts официальных producer workflows с успешными обязательными jobs, подтверждёнными repository, commit/tree, run и artifact identities. Все семь обязательных assets MUST связываться с точным release candidate; verification-only revision допускается только при машинном доказательстве неизменности product/build inputs. Локальные builds MUST NOT становиться источником публичных assets.

#### Scenario: Согласованный комплект
- **WHEN** producer runs, artifact IDs, hashes и source identities соответствуют проверенному кандидату
- **THEN** publisher получает семь проверенных assets и сохраняет provenance каждого файла.

#### Scenario: Подмена или неполный результат
- **WHEN** отсутствует обязательный job/asset либо не совпадают source identity, repository, workflow, artifact ID или hash
- **THEN** publisher завершает работу до создания публичного релиза.

### Requirement: Полный release gate

Публикация MUST требовать успешные Windows, Debian, macOS и Web Lab units, применимую release matrix, Windows/Web qTox compatibility и привязанный к Web bundle receipt. Отсутствующее доказательство MUST оставаться незакрытым gate; прежний PASS не является новым выполнением.

#### Scenario: Gate не завершён
- **WHEN** обязательный receipt отсутствует или несовместим с candidate inputs
- **THEN** публикация не выполняется и сохраняется конкретная причина отказа.

### Requirement: Сохранение опубликованной истории

Новый publisher MUST создавать только целевой tag/release из проверенного манифеста текущей разрешённой версии, сохранять ограничения исторического publisher 0.2.9.8 и отклонять изменение существующего опубликованного релиза. Повтор MUST быть безопасным для уже созданного тем же запуском draft и точных assets; конфликтующие данные не перезаписываются автоматически.

#### Scenario: Конфликт существующего tag или release
- **WHEN** целевой tag/release уже существует с несовместимой identity либо уже опубликован
- **THEN** publisher останавливается без замены tag и опубликованных assets.

### Requirement: Данные релиза отделены от кода

Номер версии, tag и точные identities конкретного выпуска MUST задаваться проверяемым манифестом. Смена только версии MUST NOT требовать новой копии publisher или новой версии-специфичной ветки кода. Правила доверия к repository/workflows и обязательным проверкам MUST оставаться в коде и не ослабляться манифестом.

#### Scenario: Следующая согласованная версия
- **WHEN** новый манифест соответствует canonical product version и всем правилам доверия
- **THEN** тот же publisher обрабатывает его без изменения исходного кода.

#### Scenario: Манифест расширяет доверие
- **WHEN** манифест указывает другой repository/workflow, произвольную команду либо путь вне разрешённого комплекта
- **THEN** publisher отклоняет данные до внешней записи.

### Requirement: Итоговая проверка публикации

Успешный результат MUST содержать Release URL, tag/commit, успешный publisher run и проверенные опубликованные hashes всех семи assets. Публичный macOS asset MUST явно сообщать ad-hoc signature и отсутствие notarization.

#### Scenario: Завершённая публикация
- **WHEN** GitHub API/download подтверждают опубликованный комплект и его hashes
- **THEN** релиз считается опубликованным и финальные файлы сохраняются в локальном version output.
