# Tasks

## 1. Причины и история

- [x] 1.1 Зафиксировать прежние диагностику, исправления и границы тестов по историческим чатам и Git; различить регрессию и неполное исправление.
- [x] 1.2 Раздельно воспроизвести откат раскладки в composer/разблокировке и пустое место при новых входящих/исходящих на точном коде; проверить гипотезу орфографии без предположения общей причины, зафиксировать FAIL до исправления. Tray evidence принимается только с native ownership и подтверждённым hide/restore; ранние прогоны с другой иконкой исключены.

## 2. Исправления

- [x] 2.1 Удалить автоматическое вмешательство в раскладку: frontend bridge, native IPC, ActivateKeyboardLayout и недоказанный дополнительный focus fallback. После завершённого клика трея штатно восстановить окно и native WebView focus на Windows.
- [x] 2.2 Проверить оба поля без layout bridge: composer и password unlock, первое переключение после собственного hide/restore из трея, обычное восстановление и системный индикатор; не читать пароль. DI33: три native-owned сценария PASS, включая titlebar-close/restore; оригинальные OS screenshots просмотрены.
- [x] 2.3 Исправить подтверждённый механизм пустого места при новых сообщениях; проверить incoming/outgoing live tail, ручную прокрутку, границу диапазона, поздний ответ и смену чата. Изменять media route только при подтверждённой причинной связи, с проверкой Astra/xhigh owner/path/resource boundary и encrypted image coverage.

## 3. Интеграция и desktop

- [x] 3.1 Обновить дизайн, CHAT-BEHAVIOR и карту diff -> reused/rerun/invalidated/missing; выполнить затронутые регрессии, diff-check и форматирование, сохранить exact identities. Strict OpenSpec и diff-check PASS; obsolete layout tests исключены, unrelated Rust formatting не менялся.
- [x] 3.2 На изменённом artifact выполнить два независимых Windows native disposable сценария: реальные chords раскладки в composer/password unlock; новые incoming/outgoing с орфографией on/off и без ручной прокрутки. DI33 keyboard PASS; DI26 message PASS переиспользован по неизменным message inputs, а не выдан за новый прогон. DOM/visual/timing originals и ограничения сохранены.
- [x] 3.3 Завершить Windows portable и program-only обновление C:\Desktop\Kaigen-portable с protected-root/readback/relaunch receipt; затем обязательный prototype sync по owner route и отдельный local Web Lab READY/activate/readback receipt. DI33 deploy PASS, prototype main-20261001-be76f432-032da888/62 scenes PASS, Web candidate desktop-input-790ae06be511-80373bf3dcd4-r3 READY/activate/HTTPS identity PASS. Commit, release и production не выполнялись.
