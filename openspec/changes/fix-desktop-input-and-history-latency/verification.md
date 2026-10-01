# Verification checkpoint

## Scope and history

Два независимых дефекта: RU/EN ввод и видимый Windows indicator после восстановления из трея; пустое место вместо новых incoming/outgoing. Язык UI исключён последним уточнением. Исходный HEAD 1060a86d6f0a997fb3db510baf98716ce6f24219, исходное дерево чистое. Commit/release/production и девять постоянных клиентов не входят в scope.

3fc57ad647dead133e6f1e083b12a28a1c9286f3 добавил layout bridge и live-tail guard в v0.2.9.6, сохранённые до исходного HEAD. KEYBOARD-FIX-R6.md подтверждал HKL convergence, но исходный rollback не был воспроизведён. Исторический rendering test начинал visibility clock после полного tail response и не покрывал cached near-tail/followLatest=false. Прежние результаты не доказывали устранение этих симптомов.

## Keyboard: causal evidence and final fix

При native-owned tray restore top-level foreground уже принадлежал клиенту, focus — WebView, но первый Ctrl+Shift не менял символ. Обычное minimize/restore исправляло. DI31 без layout synchronization оставил FAIL; DI32 minimize-before-hide также FAIL и удалён. DI33 добавляет штатный Windows native WebView set_focus после top-level window restoration. Layout setters, frontend bridge, native IPC и недоказанный AttachThreadInput удалены.

DI33 PASS: unlock normal RU → first post-tray EN; composer normal EN → first post-tray RU; titlebar-close/own-tray restore normal RU → first EN. Везде проверены own PID 972/EXE, IsWindowVisible false→true, настоящий символ, WebView HKL. Оригинальные screenshots 05-after-tray-switch.png просмотрены: ENG / РУС / ENG. Fixture COMPLETED, nativeStopped=true, оба phaseSignals присутствуют. Synthetic profiles остались только в disposable VM для triage; в ZIP их нет.

Derived report outputs/di33/evidence/native-tray/keyboard-report.json, SHA-256 04edf6820b4d067658d80210c71705fb7ab00afcb0269a747293b6e6dfc22e81, оформлен из оригиналов; генератор не выполнял новых runtime тестов. Ранние fixed-coordinate tray clicks по другой иконке полностью исключены.

## Messages: independent cause and fix

FAIL-before: actual production App fixture, 650 строк, A→B→A, cached range, 24 px от конца, followLatest=false. Incoming/outgoing продвигали metadata, но cached range оставался прежним; карточки отсутствовали в DOM спустя snapshot+1200 ms, прокрутка показывала их. Орфография OFF и ON отдельно воспроизводили дефект.

Исправлен refresh cached near-tail до публикации spacer с сохранением ручного anchor и search/navigation/owner guards. Media IO не изменён: причинной связи не доказано. Focused App suite 40 assertions, chat navigation 87 и view-state/outgoing PASS; их исходные identities сохранены.

Native DI26 visibility R2: реальные два Tox клиента, четыре сценария PASS без ручной прокрутки. OFF incoming DOM +464 ms / anchor drift 0.259 px; OFF outgoing -16 ms с peer delivery; ON incoming +529 ms / drift 0.259 px и 300 spelling ranges; ON outgoing -20 ms с delivery и 300 ranges. Отрицательные времена относительно concurrent backend observation, не отрицательная абсолютная задержка. Original report SHA-256 536d404742b44473c5ec1a1c8a8b0e80dcd5d653a3de4f4e54e3b05976d6adae. App/message/spelling inputs неизменны в DI33: evidence REUSED, не новый native прогон DI33.

## Exact artifact and delivery

DI33 frozen tree 790ae06be511a38762ef95c275bf9a8066665e7e, verification commit 8008e671aec2d0bf9842da6ea90a7ac6b9a40b91, 1633 files. Inventory 36715a0a133767162e8b4b7ef523fb59d08a604eeec49024ff1221a559b79dfb. Compile COMPILED_ONLY / production-only, testsExecuted=false/runtimeVerified=false. Packaging отдельно PACKAGED_NOT_RUNTIME_VERIFIED.

EXE SHA-256 02105196298244417613bedb86910a74e97a781c4d91afee8eb93f95fe458513. ZIP outputs/di33/final-portable/Kaigen-windows-portable.zip: 448508181 bytes, SHA-256 c6b4cae4217ee1778163b3823031b72df8ea35e4d9d4fbc7f2fc4a2c8c433338; 288 program files. Guest static PASS связан с ZIP; отдельный native portable smoke PASS/STOPPED с actual Medium console и own WebView/native components.

C:\Desktop\Kaigen-portable обновлён и явно перезапущен: transaction 032da88889c945648c4b4a7eb265580d, receipt PASS, protectedUnchanged=true, 288 files, new EXE, PID 97328/running/responding/windowReady=true. Первый updater отказал до mutation из-за ArtifactsRoot; повтор с exact root успешен. Повторять обновление не нужно.

## Incremental map and remaining finish

EXECUTED: DI33 native keyboard/OS screenshots; ZIP static; native portable smoke; transactional host update/relaunch. REUSED: DI26 native messages и неизменные focused checks. INVALIDATED: удалённые layout-policy tests, wrong-icon tray probes, failed minimize candidate. OMITTED: unrelated release/platform/qTox matrices. Документы не меняют built-from identity.

Карта и manifest: outputs/di33/evidence/incremental-coverage.json и prebuilt-windows-finish.json сохраняют состояние на момент Windows import; их исходные bytes не менялись.

## Ordinary finish completed

Prototype main sync PASS: transaction 032da88889c945648c4b4a7eb265580d, baseline main-20261001-be76f432-032da888, captured=62/reused=0/draft=none. Browser capture и prototype tests выполнялись в WindowsLab VM; host Vite build допустимая orchestration. VM verification receipt 5d0a23c496514408b24d6d0c4e61fad8, SHA-256 7d08b22cc245ce349e2231dd19250f8d0c4328aadc3e0d01ac524237f7d5d258d. Первая попытка sync прервалась по служебному live-attestation timeout и штатно восстановила прежний prototype; успешная повторная попытка не повторяла product compilation/deploy.

Separate Web Lab candidate desktop-input-790ae06be511-80373bf3dcd4-r3 использует тот же DI33 source ZIP/tree. Native groups libsodium/c-toxcore/tor-universal — три exact cache hits. Scoped Rust и VM Edge browser/API/restart/rollback/cleanup PASS; READY v2 SHA-256 d722374cc19f04c2ad6284764b862eb7e2a961c94e8c616c7b3fafc99fe761ad. Public activate nonce 7273b4bac849489da570812865c83a26: PASS, candidate-active, service active, slot b, release manifest f586e44144b59fbe422826e3293d96bef0478d72a151f03a5b8efe4271bf2067. Final HTTPS https://kaigen.test/api/v1/build-identity возвращает exact candidate build-id; original readback SHA-256 4b6cb79ae4de5546b1144baa2694f02dfab65fdeea85f87860f0a75fabe51ed8.

Два не допущенных Web contract attempts и retained-only Lock selector отказали до VM mutation; не выданы за PASS. Fresh candidate прошёл поддерживаемый targeted gate без расширения framework. Не запускался host browser, не загружались компоненты, не менялись production, canonical Git HEAD, девять постоянных клиентов или реальные profiles/data/downloads. Complete proof: outputs/di33/evidence/final-finish.json; обязательных открытых finish шагов нет. OpenSpec остаётся локальным active change до отдельно разрешённого release/archive lifecycle.
