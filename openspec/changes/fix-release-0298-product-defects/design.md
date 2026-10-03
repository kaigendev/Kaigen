# Design

## Context

См. proposal.md. `sendOnEnter` в App начинается с true и затем восстанавливает сохранённый boolean. WebRoot имеет ограниченную карточку внутри обрезающего viewport. App вызывает меню через contextmenu, macOS Ctrl-click и клавиатуру; touch удержание отсутствует. Защищённая pending запись принимается до асинхронного согласования PQ; active notice позднее добавляется в конец. Простая перестановка Vec не сохраняет порядок: durable store добавляет новый ID в chunks. Windows reveal передаёт canonical path непосредственно в команду Explorer.

## Goals / Non-Goals

**Goals:** сохранить реальные гарантии PQ и согласовать in-memory/durable порядок; исправить tablet ввод и доступность через общую оболочку; сохранить существующие menu actions, paths и настройки; связать полный регрессионный контур с immutable candidate.

**Non-Goals:** новый протокол PQ, изменение обычной offline/qTox доставки, новые mobile targets, обновление managed компонентов, изменение раскладки интерфейса вне формы и production Web/site deployment.

## Decisions

1. После genuine Active вставлять active notice перед earliest ожидающим protected ID через bounded durable insert-before operation. Сохранить prefix chunks и атомарно опубликовать suffix generation/revision. Дубли и failure/retry контролировать по ID; required notice persistence предшествует payload release. Предварительная фиктивная active карточка и перестановка только Vec отвергнуты: первая ложно подтверждает защиту, вторая не переживает чтение с диска.
2. Tablet default вычислять лениво из Web/native и browser device признаков. iPad mobile/desktop UA и Android tablet учитывать; Windows/Linux touch компьютер не менять. Сохранённый boolean и существующий Enter/Shift+Enter контракт выше default.
3. Web gate получает одну ограниченную viewport область вертикального скролла; card следует естественной высоте. Это устраняет clipping без второй вложенной scroll области и учитывает dynamic viewport.
4. Touch helper использует неподвижное удержание и существующие context routes. Не запрещать исходный pointerdown/scroll; отменять по движению, scroll, multitouch/cancel и lifecycle. После открытия подавлять только click данного gesture. Исключить editable/menu elements; сохранить right click/keyboard и menu coordinator.
5. Reveal проверяет canonical containment существующего downloads файла. Windows использует ограниченный native FFI `SHParseDisplayName` и `SHOpenFolderAndSelectItems` с точным item PIDL, UTF-16 и преобразованием verbatim Disk/UNC prefix только после security validation. COM init/uninit и освобождение PIDL сбалансированы; ошибка возвращается явно. Shell вызов выполняется через spawn_blocking, без изменения dependencies. Фактическая папка и selected item проверяются native, включая Unicode/пробелы; ошибку не маскировать fallback папкой.
6. Один writer на файл: PQ worker владеет Rust history/reveal; Web worker WebRoot/CSS/default helper и dedicated runtime fixture; координатор App/touch integration, версии, OpenSpec и release. Полный scope проверки включает предыдущие локальные изменения от последнего опубликованного release, особенно MSI rollback acceptance.

## Risks / Trade-offs

- Durable insertion, queued snapshots и concurrent send: проверить порядок, revisions, cold read, failure/retry и стабильность IDs; не ослаблять transport fences.
- Touch удержание и browser selection: не перехватывать editable controls, отменять при scroll/movement, проверять настоящий touch route и synthetic click.
- Device detection: проверить iPad desktop UA, Android tablet и Windows touch компьютер, а также explicit preference/reload.
- Размер формы и keyboard viewport: functional scroll/submit при RU/EN, errors и portrait/landscape/малой высоте.
- Existing MSI FAIL: релизный gate остаётся открытым до актуального реального PASS; прошлые metadata и driver self-tests недостаточны.

## Migration Plan

Настройки и portable data не мигрируют. Сначала весь пакет исправлений и ранние регрессии; затем согласование версии/inventory и immutable candidate. Полный Windows/Debian/Web Lab/macOS + integral/matrix контур предшествует push/tag/draft, проверке семи assets и publish. Local clients/prototype/Web Lab обновляются только штатными stage-bound wrappers. Production остаётся отдельным этапом.
