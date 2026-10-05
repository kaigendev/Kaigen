# Tasks

## 1. Воспроизведение

- [x] 1.1 Сохранить native baseline последнего рабочего EXE: первый запуск, тестовое поле пароля, фактические RU/EN символы, системный индикатор до сворачивания и отдельный minimize/restore контроль с исходными screenshots и identity. Три варианта не воспроизвели сбой; это baseline без native отрицательного контроля.

## 2. Исправление и автоматическая регрессия

- [x] 2.1 Добавить ограниченное восстановление нативного фокуса после готовности startup; проверить unit-тестами однократность, background/hidden/minimized, смену окна, ошибки очереди и повторные события. Восемь новых policy-тестов PASS; шесть сохраняемых recovery-тестов PASS.
- [x] 2.2 Покрыть production RootApp startup-ready уведомление и сохраняемый native сценарий первого запуска; отдельно зафиксировать отрицательный контроль контракта и положительный результат кандидата, не смешивая их с доказательством причины системного индикатора. Frozen onboarding: create11/import15/unlock23/removedowner4 PASS; native startup glyph/indicator PASS.
- [x] 2.3 Выполнить применимые frontend/Rust/format/diff проверки и независимый review; записать source/runner identities и новые либо переиспользованные результаты. Frozen plan: 42 новых запуска, 6 точных reuse; Rust429 PASS/2 ignored; FINALIZE и VERIFY_FINAL PASS. Независимый review не выявил actionable issues; см. verification.md.

## 3. Проверка и локальная поставка

- [x] 3.1 Собрать Windows portable из проверенных offline inputs и проверить startup glyph/indicator, own-tray/minimize return и final-ZIP portable/runtime smoke; сохранить hashes и исходные screenshots. Safety guards подтверждены deterministic policy-тестами; native background/minimized pending timing не выполнялся и не объявляется PASS.
- [x] 3.2 Выполнить штатное program-only обновление точного рабочего portable, явный relaunch; проверить неизменность profiles/data/downloads и receipt. Windows finish PASS; transaction3df26cf612404493bdc39ff6c4941a9b. Пользователь подтвердил устранение исходного host-симптома после повторного явно запрошенного restart.
- [x] 3.3 Завершить отдельный local Web Lab READY/activation/readback по текущему owner-маршруту; сохранить точный build identity без production действий. Build uifocus-web-20261005-5c24f3407315-785c02f4d059-r1: READY, browser/restart/rollback/cleanup, activation и normal TLS HTTPS readback PASS.
- [x] 3.4 Сверить итог с уточнённым симптомом, завершить OpenSpec и обязательную оценку workflow; подтвердить оставшиеся ограничения и отсутствие незавершённых обязательных шагов. Host-приёмка подтверждена; основная спецификация синхронизирована, оценка шести инструментов и два предложения сохранены; change готов к штатному архивированию.
- [x] 3.5 Завершить применимый prototype sync после Windows finish; сохранить receipt текущего owner-маршрута. PROTOTYPE_MAIN_SYNC_PASS, baseline main-20261005-ef421137-3df26cf6, 62 сцены/124 снимка, 132 VM contract tests PASS; независимый readback clean=true/draft=null/pending=null.
