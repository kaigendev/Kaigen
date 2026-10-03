# Tasks

Для каждого пункта: сверить существующее покрытие, реализовать пробел, исполнить тесты, исправить подтверждённые defects, получить независимый самоконтроль и сохранить `evidence/NN.md` с файлами, сценариями, командами, identities, фактическими результатами и нерешённым. Переход допускается только после этого; неполный результат не отмечается выполненным.

## 1. Готовые регрессии
- [x] 1.1 Подключить notification sound и product fixes #3 к npm/регулярному агрегатору; проверить полноту регистрации и реальное распространение failure каждого набора.

## 2. Пароль
- [x] 2.1 Исполнить backend смену без пароля/A/B/без пароля, checkpoint/registry/rollback failures, холодное открытие и retry с identity/history/PQ; исполнить Settings mismatch/current-password/double-submit/секреты/badge/profile-switch.

## 3. История
- [x] 3.1 Проверить missing/truncated/corrupt chunks и manifest после удаления legacy, fault cuts chunk/manifest/readback/retirement, целостное поколение и соседние контакты.

## 4. Приём файлов
- [x] 4.1 Исполнить desktop callback EOF/I/O/final KAI/avatar failures, durable failed, partial cleanup, старый avatar, slot и единственный dequeue; отличить пустой файл.

## 5. Общие network настройки
- [x] 5.1 Проверить отказ второго профиля/settings/rollback и disk/memory/Tox options/identity/offline/очереди/restart; исполнить Settings late GET/reversed SET/reject/readback/remount.

## 6. Очистка истории
- [x] 6.1 Исполнить Settings cancel/confirm/reject/retry, точного владельца A/B, cached chat/reply/search и switch до ответа с сохранением другого профиля.

## 7. Onboarding
- [x] 7.1 Исполнить create mismatch, picker cancel, empty discovery, encrypted import wrong/right password/failure/retry и параллельный unlock в обратном порядке с secrets/pending/route/list.

## 8. PQ и масштаб
- [x] 8.1 Подключить и реально исполнить существующие pq-fault-tests и выбранные ignored/scale сценарии именованными jobs с discovered/executed/skipped и resource bounds без дублирования PQ crash/replay.

## 9. Каталог
- [x] 9.1 Реализовать универсальный полный режим и проверить unknown input/new module/new suite/shared contracts/features/platforms, исполняемые routes и сохранение identity guards исторических receipts.

## 10. Spellcheck
- [x] 10.1 Исполнить stale text/config/suggestion после смены языка/чата и Worker/dictionary failures/recovery; проверить draft/caret/send.

## 11. Tor
- [x] 11.1 Исполнить fake process/pipes/clock exit/bootstrap и generation/restart/disable/fallback races, единственный fallback и точное освобождение портов без внешней Tor-сети.

## 12. Browser engines
- [x] 12.1 Реально исполнить поддерживаемые Firefox/WebKit Worker/auth/reload/clipboard/OPFS recovery/teardown/fallback через backend; сохранить Chromium.

## 13. qTox export
- [x] 13.1 Исполнить Settings encrypted/wrong password/repeated click/reject/retry/switch/remount; проверить bytes/fileName/owner/secrets/Blob URL cleanup.

## 14. Avatar
- [x] 14.1 Исполнить decode/resize/encode PNG/JPEG/WebP/GIF/small/noisy/corrupt/FileReader/canvas, PNG <=64 KiB/dataUrl/bytes/aspect/owner и сохранение старого avatar при отказе.

## 15. MSI
- [ ] 15.1 Реально исполнить предыдущая версия -> candidate, failure/rollback с disposable profiles/data/downloads canaries, Finish checked/unchecked, version и точный launch count/time.

Отложено прямым указанием пользователя от 03.10.2026 (02:04:17 МСК). Пункт не закрыт и не возобновляется без новой явной команды. Обычная финализация пунктов 1–14 продолжается отдельно; это исключение заменяет прежнее требование завершить каждый пункт до перехода.

## 16. Завершение
- [ ] 16.1 Исполнить применимые общие проверки и обязательный локальный finish только для фактических product changes; сохранить итоговый статус 1–15, defects, blockers и identities.
- [ ] 16.2 Провести post-completion workflow review, отдельно оценить Caveman/LeanCTX/Serena/context-mode/RTK и представить обоснованные предложения.
