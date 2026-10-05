# Tasks

## 1. Повторяемая упаковка Windows

- [x] 1.1 Реализовать узкую hash-bound передачу внутри одного Actions run; проверить tampering, identity, пути, полноту, producer/consumer attempts на изолированных fixtures.
- [x] 1.2 Разделить Windows workflow и согласовать CI contract; проверить структуру, прежние artifacts, PR packaging и существующие связанные pipeline-тесты.

## 2. Единая версия

- [x] 2.1 Добавить helper существующей версии и согласованности manifests; проверить положительные и отрицательные fixtures.
- [x] 2.2 Подключить helper к Windows/publisher workflows, сохранив historical trust pins; проверить expected-tag/catalog guard и неизменность publisher trust.

## 3. Интеграция

- [x] 3.1 Проверить итоговый diff, OpenSpec и связанные контракты; записать результаты и отсутствие remote CI proof без отдельного разрешённого запуска.
