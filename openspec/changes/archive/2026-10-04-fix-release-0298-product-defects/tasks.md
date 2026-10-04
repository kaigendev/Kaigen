# Tasks

## 1. Scope and planning

- [x] 1.1 Зафиксировать пять дефектов, точный owner, чистый исходный HEAD и release authority; проверить OpenSpec strict validate и apply-ready.
- [x] 1.2 Получить полные raw/fresh preimages; сверить план рисков всего кандидата от опубликованного v0.2.9.7, включая локальные runtime fixes и незакрытую MSI acceptance.

## 2. Product fixes

- [x] 2.1 Реализовать genuine PQ active-before-first durable ordering; проверить queue, cold read/restart, same-second/multirows, idempotence/failure/retry, incoming/outgoing и offline/qTox границы причинными Rust регрессиями.
- [x] 2.2 Исправить native reveal точного downloads файла; проверить path normalization/Unicode/пробелы и отрицательные containment/missing-file случаи. Native selected-item proof включить в 4.2.
- [x] 2.3 Добавить lazy tablet default Enter-newline с приоритетом сохранённой настройки; проверить iPad mobile/desktop UA, Android tablet, Windows touch PC, native и reload в реальном browser runtime.
- [x] 2.4 Сделать кнопку создания пространства достижимой через scroll; проверить реальные WebRoot submit flows при малой высоте, RU/EN, errors и смене viewport.
- [x] 2.5 Добавить touch long press в существующие menu routes; проверить hold, tap, movement/scroll/multitouch/cancel, synthetic click, editable controls и lifecycle в browser runtime.
- [x] 2.6 Актуализировать локальную chat specification и зарегистрировать достаточные causal regressions; проверить полный ранний frontend baseline, Rust fmt/test и diff check.

## 3. Immutable candidate

- [x] 3.1 Согласовать 0.2.9.8 в package/locks/Cargo/Tauri, inventory/About/notices; проверить version/component identities без сетевой загрузки managed components.
- [x] 3.2 Создать ровно scope-bound локальный candidate commit до первой candidate сборки; подтвердить clean worktree, tree/diff digest и checkpoint.

## 4. Full functional and release verification

- [x] 4.0 Исправить Desktop↔Web READY/restore route compatibility с independently approved immutable inputs; проверить 37 driver/proof controls, parser и canonical host self-test. Проверить фактический Edge pipe startup/close и failure lifecycle без ослабления assertions. Реальный full runtime остаётся в 4.4.
- [x] 4.1 Выполнить применимые автоматические, regression, build и security/package проверки, включая npm audit; сохранить реальные source/artifact/runner identities и разграничение reused/new/excluded. Согласованный 2026-10-04 scope указан в design.md.
- [x] 4.2 Завершить Windows unit: точный portable/MSI, реальные два PQ инстанса, first-order/restart/fault/rotation/entropy/formatting/About, native reveal selection, пять ordinary MSI сценариев, девять release test clients и prototype sync.
- [x] 4.3 Завершить Debian desktop unit с реальным runtime и native artifact/hash-bound receipt из того же source identity.
- [x] 4.4 Завершить Web Lab unit на exact candidate bundle: backend/browser flows, PQ/attachments, планшетный ввод/создание/menus, полный WebTunnel runtime и installer/hash-bound receipt.
- [x] 4.5 Завершить macOS desktop unit с runtime receipt и universal adhoc-release artifact из того же source identity.
- [x] 4.6 Подтвердить работу Kaigen по фактической доставке сообщений и сверить четырнадцать необходимых leaf receipts с текущими source/artifact/runner bytes. Дополнительные матрицы настроек сети, новая native pair обвязка и проверки собственного хранилища/поведения qTox исключены прямым изменением scope 2026-10-04; их исходные частичные результаты и FAIL сохраняются, PASS им не присваивается.

## 5. Package and publish

- [x] 5.1 После green gate создать canonical source ZIP, отправить exact release commit в main и проверить push-triggered Actions для exact SHA.
- [x] 5.2 Проверить семь финальных assets, их composition/privacy/hash/input identity и runtime smoke; создать tag/draft, загрузить, проверить links/Web receipt и опубликовать 0.2.9.8.
- [x] 5.3 Скопировать семь финальных assets в outputs/0.2.9.8; проверить SHA-256 и выдать Release URL.

## 6. Completion

- [x] 6.1 Закрыть обязательные post-release sync и OpenSpec задачи; проверить scope и архивировать change после фактического релиза.
- [x] 6.2 Выполнить независимый финальный самоконтроль и workflow-optimization review, отдельно Caveman/LeanCTX/Serena/context-mode/RTK; представить только обоснованные numbered proposals.
