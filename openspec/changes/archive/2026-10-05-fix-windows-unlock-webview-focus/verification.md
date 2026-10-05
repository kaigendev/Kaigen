# Verification

## Реализованное поведение

Production RootApp однократно сообщает `startupReady` существующим heartbeat после готовности интерфейса. Windows откладывает native WebView `MoveFocus(PROGRAMMATIC)` в UI-очередь. Callback повторно проверяет exact main HWND, foreground, visibility, minimized/stopped/recovering и generation; completion зависит от реального COM результата. Pending readiness сохраняется при background/recovery, отказ допускает повтор, устаревшая задача не изменяет состояние нового окна. HKL setters и AttachThreadInput не добавлены.

Независимый review актуальных native guards, callback completion и policy-регрессий не выявил actionable issues. Текущие product bytes совпадают с замороженным кандидатом; эта документация добавлена после freeze и не выдаётся за вход собранного артефакта.

## Exact candidate и автоматические проверки

- Frozen verification commit: `8a6f05794124556fafc40ac21474ad29fe3b5879`; tree: `5c24f3407315533be3de6f6d9dd9605ffef1f91d`.
- Source inventory: `17bcdebc192abc0e57558c04bd29d088d53cb7cef16859609d564db9e7a9bfaa`; build manifest: `682a59543c2a1b0f4eefd0b42f46a36265d940a8dc590f7d468a71079241e555`.
- Native source SHA-256: lib.rs `3b53f19ce582d1ea3c27750d6e3f012651bcc00374746502b426e78612481ac0`; webview_recovery.rs `4a20dc97de0aa128f152cd0009cde874e599c85075ff7f361c95085b3e51007a`; startup_focus.rs `7bf00c622b04d1eaf428eb180b0b4964706343bc4c1f97779b3d73690ac07671`.
- Current hash-bound Windows plan: `outputs/uifocus-20261005-r1/windows-verification-plan.json`, SHA-256 `b38c1687367dcff04f3b1c72c02580126b4b29fb4591d8ca3c5caf3e967a45c2`.
- Final verification receipt: `outputs/uifocus-20261005-r1/windows/verification-r1/windows-incremental-verification.json`, SHA-256 `a716bdce7ecbbf4e75502bc7f9bf429246e6691f6278f6067533ccf12ad3e85d`; registered runner FINALIZE и VERIFY_FINAL PASS.
- 48 учтённых checks: 42 новых запуска, 6 reuse по полным неизменным original fingerprints. Исходный `fullBaselineRerun=false` сохранён; это инкрементное покрытие с полным Rust run, не новый полностью повторённый baseline.
- Rust: 429 passed, 0 failed, 2 ignored. Включены 8 новых startup-focus policy-тестов и 6 существующих recovery-тестов. Cargo использовал подготовленный test target (0.52 s), offline inputs и expected-hit native cache.
- Frozen actual-App onboarding: create11/import15/unlock23/removedowner4 assertions PASS. Отрицательный контроль прежнего RootApp провалил readiness-контракт; он не воспроизвёл зависание системного индикатора. TypeScript, platform-runtime, rustfmt и diff checks PASS записаны отдельно.
- Три native автоматических проверки PASS. Первичный sandbox-отказ disposable loopback harness сохранён; точный pending runner продолжен scoped retry без переписывания PASS evidence.

## Native Windows и host-приёмка

Final portable ZIP: `outputs/uifocus-20261005-r1/final-portable/Kaigen-windows-portable.zip`, SHA-256 `3462c6ca8df05b998621334dd9c6d768c716a7d95afc30952c56f8e8d1539c29`, 448660961 bytes. Production EXE: `1bf7f7a44b1d08224e31d1f5a590a8c967cc5b791e8f1e16adc0fa76e4d4a7cf`.

Исходные passive PNG и synthetic glyph observations показали RU_A/РУС и EN_A/ENG при первых физических Ctrl+Shift на startup password field до minimize/tray. Own-tray return и обычный minimize return также PASS. Final-ZIP smoke: PASS, STOPPED, failureCode=null; runtime identity, DLL components и screenshot byte pins проверены. Native report: `context.local/work/20261005-unlock-focus/native/candidate-native-report.json`, SHA-256 `bf89628f3a236471b2b524cfd1c3bddb38dd8e3a7546af907c885a33928a22f3`.

Штатное program-only обновление рабочего Windows portable и relaunch завершены: transaction `3df26cf612404493bdc39ff6c4941a9b`, Windows finish PASS, защищённые profiles/data/downloads сохранены. После повторного явно запрошенного restart в `2026-10-05T17:31:12Z` пользователь подтвердил устранение исходного host-симптома: системный индикатор сразу переключается Ctrl+Shift после свежего запуска. Источник подтверждения — актуальный ответ пользователя `call_EJPmfbfVQGBcDquNpxl233sW`, переданный root; установлен тот же production EXE. Это подтверждение пользователя отдельно от VM evidence и автоматических тестов.

## Синхронизация прототипа

Штатный coordinator завершил PROTOTYPE_MAIN_SYNC_PASS с exit0 для transaction `3df26cf612404493bdc39ff6c4941a9b`. Baseline `main-20261005-ef421137-3df26cf6`: 92 source-файла, tree `ef421137580647a876bca1f96786483419bea910533f813a6fdefb9bacec0992`. Изменение RootApp входит в common inputs всех сцен; поэтому заново сформированы все 62 scene bundles и 124 clean theme images. VM contract tests: 132 passed, 0 failed. Vite build и проверки capture inputs завершились успешно внутри coordinator.

Независимый registered readback подтвердил clean=true, draft=null, pending=null. Итоговый activeRef: `context.local/work/runtime/prototype-sync/payloads/78a8ce2a284162495ae43e627479ed77.json`, SHA-256 `f42e5c0cb75f961ef9a38383fabaec57d83e3d84a1865262701a2c9e9ce2d5d5`. Исходный VM receipt SHA-256 `e33214ded6ae25b4ef03d769d3e75cd2c8ac0b3c2c52ae07719ebdf0a74fca14`; входы не изменились при проверке. Windows build/deploy повторно не выполнялись.

## Локальный Web Lab

Из того же source ZIP собран и активирован `uifocus-web-20261005-5c24f3407315-785c02f4d059-r1`. Browser/API, вход/блокировка, restart/persistence, rollback и cleanup завершились PASS. READY SHA-256 `0d7a5c35362a39a341c4da342db1c611bf79fce08e68fa0b1d7068743c7de466`; пакет `ddf54c6e1a94660433973ae9fdcf19fa66583b913b3ae62b03c309feeb266224`.

Отдельная штатная активация: nonce `6f26655fc0f341d2a76c1bf642d150a7`, receipt SHA-256 `92eac87098f3e60a59a1a863422a0f8eed563ced71cb98764eb60e6ae74a32af`. Обычный HTTPS `/api/v1/build-identity` на `https://kaigen.test` вернул HTTP200 и точный build ID с системной TLS-проверкой в `2026-10-05T18:10:15.4912232Z`. Original Lab receipt `context.local/work/uifocus-20261005/final-https-readback-receipt.json`, SHA-256 `0018ffb09844d9d274b83b8f72e251d85ea17b513fdd1035054d88bc8bd214c7`; response `a99498ba7d44fb2fc821121e0b7592d56ae4b6c2d1a290270cbec8d6fd9b5a01`. Root прочитал оригиналы, сверил hashes и просмотрел исходный functional PNG. VM оставлена работающей с проверенным кандидатом, slot a.

При подготовке исправлен только служебный Lab fixture `context.local/tools/Test-KaigenVmOfflineBuildInputs.ps1`: он теперь создаёт canonical JSON-контракт до вызова настоящего validator. Семь добавленных строк; framework guards/assertions сохранены. Focused self-test и непосредственно зависящий public aggregator PASS. SHA-256 helper `95e59ccd8fb11529c1b75f18523b214c85d66bef2bc8ab2cfa25067f29e55e25`; это отдельное изменение инструмента, не вход замороженного Windows-кандидата. Полная цепочка — Laboratory `context.local/work/uifocus-20261005/WEB-FINISH.md`.

## Ограничения и завершение

- Старый native baseline: NO_REPRODUCTION в трёх bounded controls; причинный native отрицательный контроль отсутствует. Host-подтверждение не меняет этот исторический результат.
- Native background startup и minimize во время pending repair: UNVERIFIED_NOT_EXECUTED. Восемь policy-тестов проверяют guards и races детерминированно, но не заменяют эти native timing случаи.
- Все обязательные product finish этапы завершены. Основная спецификация windows-input-focus синхронизирована и прошла strict validation. Оценка workflow отдельно охватывает Caveman, LeanCTX, Serena, context-mode, RTK и OpenViking; два ограниченных предложения сохранены без изменения глобальных skills или memory. Production/release/публикация этим кандидатом не выполнялись.
