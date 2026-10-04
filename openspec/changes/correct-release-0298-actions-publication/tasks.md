# Tasks

## 1. Correct CI inputs

- [x] 1.1 Подтвердить latest Actions-only grant, exact Source owner, исходный release/tag и три фактических Actions FAIL; сохранить исходные результаты без переименования в PASS.
- [x] 1.2 Добавить catalog 0.2.9.8 и поддержку явных existing full checks; проверить source/input identities, полноту selection и существующие validator regressions.
- [ ] 1.3 Подготовить pinned Windows native inputs и WiX до зависимых jobs; проверить существующие pipeline/extended contracts и фактические runner результаты.

## 2. Actions publication

- [x] 2.1 Реализовать Actions-only доставку для exact release 403141563/tag/source с доверенными run/artifact gates; пройти независимый review и negative provenance checks до push.
- [ ] 2.2 Выполнить normal push и получить успешные Windows, Debian/macOS/Web и extended Actions; проверить семь новых assets и отдельные final artifact receipts.
- [ ] 2.3 Через Actions исправить текущий draft, заменить семь assets и опубликовать; сверить public SHA-256, Web installer/bundle binding и неизменность tag.

## 3. Finish

- [ ] 3.1 Сохранить финальные Actions assets/identities в outputs/0.2.9.8 и выполнить требуемое обновление локального клиента/Web Lab с сохранением данных и actual PASS receipts.
- [ ] 3.2 Завершить независимый самоконтроль, corrective workflow review и архивирование после фактической Actions публикации; явно сохранить прежний ошибочный release receipt.
