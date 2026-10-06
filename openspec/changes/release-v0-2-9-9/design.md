# Design

## Context

См. proposal.md. Исходный HEAD содержит пять подготовленных коммитов после текущего remote main. Версия 0.2.9.8 уже опубликована. Generic Windows/Unix producers получают текущую manifest-версию; исторический publisher и CI catalog привязаны к 0.2.9.8. Windows producer теперь разделён на build и package jobs.

## Goals / Non-Goals

**Goals:** сохранить точную identity на этапах version freeze, CI controller, локальной проверки и Actions publication; завершить полный release route существующих workflow owners.

**Non-Goals:** расширять полномочия исторического publisher, менять managed dependencies, переименовывать или переписывать старые receipts. Production и незавершённый interface change остаются вне релиза.

## Decisions

1. Релиз готовится в отдельном Git worktree от проверенного HEAD. Основной каталог и untracked interface plan сохраняются. Альтернатива изменения основного каталога мешает строгой проверке чистого release tree.
2. Версия обновляется в восьми manifest/lock/About файлах. Статическая сверка компонентов предшествует freeze; artifact/runtime identity проверяется отдельно. Автоматической загрузки managed components нет.
3. Создаётся общий publisher и отдельный release manifest/CI catalog для 0.2.9.9. Код хранит правила доверия и проверки, манифест — version/tag, точные source/run/artifact identities и evidence bindings. CI controller выбирает catalog по canonical release label. Изменение только номера следующей версии не требует новой ветки кода. Исторические .8 workflow/script/catalog сохраняют ограничения. Одноразовый .9 script отклонён после замечания пользователя о повторяющихся правках при каждом выпуске.
4. Сначала фиксируется product/version commit, затем verification/controller revision с проверяемой неизменностью product/build inputs. До первой candidate-сборки окончательное проверяемое дерево должно быть локально закоммичено; proof различает built-from и verification revisions.
5. Общий publisher получает точные producer run/artifact IDs и receipts из проверенного манифеста целевой версии. Он проверяет официальный repository, разрешённые producer workflows, исходники, успешные обязательные jobs, комплект и SHA-256; Windows требует build и package. Манифест не разрешает произвольные команды, paths/endpoints или замену опубликованной истории. Только Actions создаёт tag/draft/assets/publication. Независимый review проверяет эту границу до запуска.
6. После freeze выполняются четыре независимых units, integral и matrix. Достаточное покрытие определяется действующим release route и изменённым поведением. Reuse допускается только по полному совпадению inputs; новые версии и source changes не маскируются старыми receipts.
7. Каждый unit сохраняет собственные фактические built-from commit/tree, build ID и source archive hash. Verification revision записывается отдельно. Для совместимого готового artifact publisher заново вычисляет точный Git diff, mode/object/hash изменённых записей и digest неизменённых inputs; разрешены только явно перечисленные проверочные файлы. Изменение product/build input, mode или неполный diff запрещает reuse. Свежий validator выполняется на сохранённом artifact; прежние test receipts не получают новые source identities или timestamps. Совместимость приложения сама по себе не доказывает совместимость старого теста.
8. Windows и Web сохраняют согласованные фактические identities для общего qTox gate. Если новый build ID меняет Web payload, создаётся и проверяется новый Web package; metadata готового старого пакета не переписывается. Неподдерживаемый платформой тест учитывается как неприменимый по source cfg, а не как успешное выполнение нуля тестов.
9. Publication controller может следовать за неизменным producer commit. Publisher заново вычисляет immutable Git proof между producer и controller, включая полный diff и неизменённые product/build inputs. Допускаются только перечисленные verification files и существующие release documents; добавление разрешено лишь для `ci/releases/v<version>.json` и `ci/releases/evidence/v<version>/gate.json` как обычных Git blobs `100644`, с отсутствующим исходным файлом и зафиксированными OID, SHA-256 и размером нового. Прочие additions, removals и изменения mode/type запрещены. Catalog SHA сверяется с producer blob; source в manifest, Actions artifacts и qTox gate остаётся фактическим producer source. Publication report сохраняет отдельный controllerEquivalence.

## Risks / Trade-offs

- Старые fixed IDs или catalog version могут выпустить неправильные файлы → отдельный новый route, негативные tests и независимый review.
- Verification revision может скрыть изменённый product/build input → проверка точного diff и отказ при несовместимости.
- Старый artifact может пройти поверхностный metadata check → сохраняются исходные receipts, hashes и обязательное runtime покрытие.
- Неуспешный Actions job → исправление конкретного workflow/inputs с сохранением годных producer outputs; локального publication fallback нет.

## Migration Plan

Подготовить и проверить source/version/controller commits локально; выполнить required candidate gates; отправить точный commit в main и выполнить producers; проверить финальные artifacts и Actions publisher; сверить опубликованные hashes. Старый 0.2.9.8 остаётся доступен. Ошибка до publication сохраняет draft и receipts для точного продолжения без переписывания истории.
