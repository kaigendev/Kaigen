# Проверка исправления невидимых сообщений

## Scope и исходная identity

- Запрос: устранить невидимые входящие, отдельно проверить исходящие и остальные связанные правила чата, обновить рабочий клиент.
- Source HEAD: `937e5f4`; owner: `KaigenToxClient`; workflow owner: непосредственный parent. Admission: `TASK_ADMISSION_OPEN`.
- Существующие изменения CI/release сохранены: `.github/workflows/{build-unix,build-windows,publish-release-0298}.yml`, `ci/{test-entrypoints,verification-v0.2.9.8}.json`, `scripts/{ci-incremental-verification,test-build-pipeline}.mjs`; существующие untracked release-version/windows-ci-handoff и их tests, change `split-windows-ci-and-centralize-release-version`.
- Новый change: `fix-invisible-live-chat-messages`, `spec-driven`, strict validation PASS, apply READY.
- Рабочий executable до изменения: версия `0.2.9+8`, 23003648 байт, SHA-256 `8EBB87D5255867F7218A97AE7AC24F33BDED929B21DE086A6EEBEA1D455339B7`. Прочитаны только метаданные программного файла; пользовательские данные не использованы.

## Предыдущее доказательство и его пределы

- `eda43992da9af6907a691c5211deb5c29f2a3f20` подтверждён ancestor текущего HEAD. Ветка cached near-tail присутствует в текущем App.
- Старое воспроизведение: 650 строк, A→B→A, 24 px выше конца, `followLatest=false`; карточки отсутствовали в DOM через snapshot+1200 ms и появлялись после прокрутки.
- Исторический native receipt `outputs/di26/evidence/native-visibility-r2/report.json`, SHA-256 `536D404742B44473C5EC1A1C8A8B0E80DCD5D653A3DE4F4E54E3B05976D6ADAE`: реальные два клиента, 520 строк, OFF/ON. Incoming mounted через 464/529 ms, но оба `firstVisibleUtc` и `firstVisibleGeometry` равны null. Outgoing visibility подтверждена. Поэтому incoming PASS не подтверждает видимость в положении, где она требуется.
- DI33 переиспользовал прежние message inputs/results. Это исторические результаты, а не текущий запуск. Старый portable receipt `032da88889c945648c4b4a7eb265580d` подтверждал установку и relaunch; нынешняя identity клиента им не устанавливается.
- Сохранение ручного якоря в 24 px от конца само по себе не дефект: новая проверка различает намеренно невидимую строку и пустое видимое место вместо доступной карточки.

## Карта поведения и evidence

| Область | Статус | Нужное доказательство |
| --- | --- | --- |
| История прежнего исправления | rerun read-only | Git ancestry и исходный native receipt прочитаны; ограничение PASS установлено |
| Текущий симптом | negative reproduced → automatic PASS | actual-App restoration race до recovery input; исходный FAIL сохранён |
| Incoming / outgoing | automatic и native PASS | отдельная ожидаемая видимость OFF/ON; намеренно offscreen manual incoming — mounting/anchor |
| Cached/обычный/пустой хвост, границы DOM/data | automatic PASS | новые actual-App scenarios и canonical chat runtime families |
| Ручной якорь, длинный текст, вложения, resize | automatic PASS | canonical chat navigation/geometry/enhancements и byte-budget fallback |
| Unread/search/owner/races | automatic PASS | актуальные chat runtime suites, stale-owner guards и restoration race |
| Frontend baseline/build | current frozen PASS | 43 frontend families и production compilation; прежний failed aggregate сохранён |
| Windows artifact | current candidate verified | новый EXE/ZIP, 288 hash-verified program files, отдельные compile/package receipts |
| Native pixels/client update | PASS | восемь native cases, шесть passive pixel reviews и exact program-only deployment/relaunch |
| Prototype/local Web Lab | PASS | clean принятого baseline; отдельный Web READY/activation/HTTPS build-id |

## Инструменты и незавершённые действия

Семь health routes подтверждены после разрешённого запуска существующих процессов: песочница первоначально блокировала runtime locks. Source и parent LeanCTX имеют отдельные точные roots. Serena source activation/config и реальный символ App подтверждены. Context-mode выполнил scoped индекс/поиск нормативных chat-документов.

Parent OpenViking: exact-owner/hash task-local grant устранил admission отказ без изменения глобальных exclusions. Лимит четырёх summary batches потребовал двух cumulative стадий с сохранением кеша. Итоговая generation `d74f3aa857004130b23cd24dc2a5db75`, 5 документов, 910 chunks, `pending:null`, `outcome:searched`. Уточнённый русский запрос нашёл исходный контракт cached-tail в CHAT-BEHAVIOR:136; оригинал проверен LeanCTX. Transport: существующие LeanCTX, ChatGPT-auth ephemeral Codex и локальный pinned E5. Успешные summary стадии: 5 LLM calls, 54844 input tokens (15616 cached), 1093 output tokens, 43140 ms; это не измерение экономии задачи. Поиск дополнительных LLM calls не делал.

| Parent corpus | SHA-256 |
| --- | --- |
| `AGENTS.md` | `0a1443844c1b7aff1fa2369dfb13e7e70f0a64b733b4e649df8c19a9b95faab4` |
| `context.local/workflows/ORDINARY-CHANGE.md` | `da160b237da035d9d02f458035aaca6e3f474fe6be02842a84af62cbcd620911` |
| `context.local/specs/CHAT-BEHAVIOR.md` | `e7fa36ec88c51934e60e81478dfd671094c20f17a852c04de5bc9404595b8d2d` |
| `context.local/testing/CHAT.md` | `46a5396827cc286be7ad4189572c80cd79dae854c3d2d03ebb8c060400334ac4` |
| `context.local/testing/INCREMENTAL.md` | `bd0951f77c79b3688b40be612e1539fe080ce659991551f517e1863fff6ea25a` |

Private evidence: parent `context.local/work/current-invisible-chat/ov-task.result.json` SHA-256 `c789f8d8dc8f716e49109e06ee8d1577b2e09d4125983eac55db6b3feb464d92`; `ov-task.search.json` SHA-256 `4ac620105d734c3337855e305e696200efb416f9fc557c29576dcfbf66fcb250`. Структурированный результат сохранился до ошибки cp1251 вывода; UTF-8 вывод helper исправлен без повторной индексации.

## Checkpoint реализации перед Windows finish

Цель и authority прежние: исправление, проверка и рабочий portable; публикация и production не разрешены. Правка ограничена `src/App.tsx` и существующим `app-message-visibility-edges.ts`; новая зависимость отсутствует. Native runner подготовлен отдельно на disposable данных. Реализация не меняет сохранение ручной позиции при первом снимке восстановления.

- Исходный App: 17+23 существующих проверки PASS; усиленный отрицательный сценарий FAIL `RESTORE_RACE_CARD_REPLACED_BY_SPACER`: metadata продвинулась, карточки нет через 1300 ms без ручного воздействия. Evidence: parent `outputs/invisible-live-chat-20261005/{baseline,negative-restoration-race}`.
- Причина: первый ответ при восстановлении содержит выросший total; прежний guard отвергает hydration, публикует нижний spacer и снимает `historySnapshotAtTailRef`. Следующие polling replies уже не проходят тот же guard.
- Исправление: ограниченно догрузить хвост с сохранением resumed metadata/якоря, а при реальном вытеснении якоря байтовым бюджетом запросить его точный target перед публикацией. Owner/mutation guards сохранены.
- Новый App: финальные 17 основных +38 граничных assertions PASS, включая `outputs/invisible-live-chat-20261005/fixed-byte-budget`; incoming/outgoing, сохранённый bottom/24px, closed520, manual/search, delayed burst/retry/stale owner и one-shot byte-budget fallback. Steady true-bottom incoming/outgoing полностью видны. При первом restored incoming якорь намеренно сохраняется: mounting PASS, full visibility отдельно не заявлена. Outgoing fully visible до recovery input.
- `npm run build` PASS, оригинальный `frontend-build.log` SHA-256 `9EA4389A3ABF7091DA173976E9C21736E70C73CC0D5409934FD2A77F11B149B0`.
- Первый полный `npm run test:frontend` остановился на устаревшем nested-leaf assertion: registry уже содержал пять объявленных CI leaves, test ожидал три. Оригинальный FAIL `full-frontend.log` SHA-256 `e2596f30624ceddfa63cbfb5777ca51add5bab2a878ad40e3a967593dfec80e6` сохранён. Только `test-current-verification-contract.mjs` адаптирован к точным пяти leaves без ослабления execution checks; targeted 41 PASS, лог SHA-256 `9ca3ea886e90649093939b215499dec938d38f457e8eb778474dee9135ee1fa8`. Это test-only адаптация к прежней CI-правке, а не исправление чата. Финальный frozen canonical frontend PASS указан ниже.
- Runner: установленный Edge SHA-256 `39966F2799D3503E74871C945BA1C4877F38426D1C28756AB1545AD7C3DE8907`. Независимый review diff не нашёл actionable ошибки.

## Frozen Windows artifact и завершённая автоматическая проверка

Build root относительно workflow owner: `outputs/invisible-chat-windows-20261005-r1`. Snapshot commit `e00d72173734ae85d7c60793acbc256590787784`, tree `104627c93d92a6f2e8af99a28575d9096c7861d5`, 1771 source files. Текущий `src/App.tsx` SHA-256 `82a36a4b91843071535650b4e94149f608f420211811ea847a130be115b06948`. Product/test inputs заморожены; этот отчёт и tasks обновляются только в live OpenSpec, immutable snapshot не меняется.

| Exact evidence | SHA-256 / результат |
| --- | --- |
| `snapshot/build.json` | `b8f7f2dea7cf085d8bf0612092c15d76e11d5249c6829387bf81788a1bd6d5f3` |
| `snapshot/Kaigen-source-snapshot.zip` | `13b36593c601651a951fb00158897cd3933b58f63be72970a44db3f1f541d405` |
| Compiler source inventory | `c117a3ff16245fb61f79277b52be66441de57ecf186d11bc677bc44955be52ff` |
| `windows/compile-r2/compile-only.json` | `1c812f3d836fff4580ba129a81e940f9a09b1438ce7be1cfd6dd671740a36d5e`, COMPILED_ONLY |
| `windows/compile-r2/production/Kaigen.exe` | `6e47b31344c06ad07b2133a95bc9702fa9daec693a931edf0c20023caeb37390` |
| `final-portable/Kaigen-windows-portable.zip` | `116cb71efdb99dc6e916639fd3fff4afeb02ba209c8230d3844cac913fb644a5`, 448612978 bytes |
| `final-portable/payload/pack-manifest.json` | `36884256b8a84b599115cc6daadbeb06e93d9d31f455742f6483995f2aa685f7`, 288 program files |
| `final-portable/final-portable-receipt.json` | `1c510d706d333b2a374f2e860824e955356e0ac3c67bd1f5111f481fa44f5831`, PACKAGED_NOT_RUNTIME_VERIFIED |
| `windows-verification-plan.json` | `8d2c9988e575f007b807c334e5e56ef073779438944bff1756ddefbc17c524f7` |
| `windows/verification-r1/windows-incremental-verification.json` | `4b8530853cc397041089e5f7c63a9a32a05c83a5934a9b23c09b21055cd52dfe`, PASS |

Все 48 planned checks фактически выполнены: 43 frontend families, 3 native checks, Rust library suite и driver self-test; каждый итоговый disposition — `rerun`. Canonical finalize и verify-final прошли для exact неизменённого final ZIP. Исходный canonical `fullBaselineRerun:false` сохранён; он не переписан в вымышленный полный-baseline receipt. Historical baseline служил планированию/identity, а не заменял новые 48 результатов.

Rust: 421 passed, 0 failed, 2 явно ignored: отдельный 100k encrypted-container scenario и миллионный qTox import. Отдельный disk-store 100k test и real two-Tox chat loopback выполнены и прошли. Оригинальный `incremental-checks/rust_all.log` SHA-256 `bcdf3090576ae3b27aa8db40cd6012130b644d6b6882dbd780b21d436c944b91`; ignored строки 298/555, фактический 100k store — 759, итог — 767. Ignored сценарии не объявляются выполненными.

R1 compile FAIL сохранён: diagnostic при 266 UTF-16 units probe output path воспроизводит linker LNK1104. Task-local helper изменяет только ASCII alias на exact build root; inventory/manifest/cache guards сохранены, frozen source и cache recipes не менялись. R2 compilation PASS. Offline-friend-request сначала получил sandbox denial для пяти fixed disposable harness files; исходный FAIL сохранён. После scoped escalation и сохранения занятого failed output canonical pending-stage resume завершился; ранее полученные PASS checks не повторялись без причины.

## Завершённые Windows native и delivery gates

Native r2 получил DOM/geometry PASS, но sender window закрывал receiver: его pixel proof не принят. Task-local harness r3 подготовил реальный foreground receiver до arrival и только прочитал HWND/PID после наблюдения. Восемь комбинаций incoming/outgoing × true bottom/manual24 × spell OFF/ON прошли на real disposable двух клиентах WindowsLab. Шесть подтвердили полный видимый текст; два manual incoming подтвердили mounting и reader-anchor retention и допускают offscreen card. После arrival recovery scroll/input отсутствуют. Actual-App browser negative control отдельно покрывает in-flight first-range restoration race; native setup ждёт восстановления до arrival.

DOM/geometry report подкреплён шестью просмотренными passive console PNG: полный текст каждого обязательного case виден. Frames связаны с exact EXE, observation markers, image hashes и host/guest clock bracket. Для всех шести также подтверждён строгий конец окна: верхняя guest-time граница frame не позже `settled.latest.utc`; запас 130/171/166/150/260/130 ms. Сам capture не вызывает paint или восстановительную прокрутку. Native report: parent `context.local/work/current-invisible-chat/native-r3/report.json`, SHA-256 `b50d77c0661a3f17eb5607410c41fb3df1709a24b4b19032335ab2b8abb04de7`; pixel review: соседний `pixel-review.json`, SHA-256 `7880d87de04b2ca45e0634c21c06e5a036880983efcf631789f9d85dc7066467`, PASS, тот же EXE `6e47b31344c06ad07b2133a95bc9702fa9daec693a931edf0c20023caeb37390`.

Exact `C:\Desktop\Kaigen-portable` обновлён program-only из указанного final ZIP. Receipt parent `outputs/invisible-chat-windows-20261005-r1/evidence/local-portable/main-change-677cf9814a9d4d59ae8586644f4f4148-PASS.json`, SHA-256 `cde5daf54b883565af98476780908e5c5131be6b1810105ec5813b1987620b6e`, завершён `2026-10-05T12:42:56.9716797Z`. Transaction `677cf9814a9d4d59ae8586644f4f4148`: 288 program files, installed EXE 22952960 bytes с тем же candidate SHA-256; profiles/data/downloads до/после идентичны (561 files, 330944879 bytes, digest `cb0abd4babaed35d07bbefff774616fbec0a2ff921ab8e64f8deb71075e1b6e5`). Explicit relaunch: PID 78048, running/responding/windowReady=true, testOnly=false.

Отдельный final-ZIP smoke на pristine extraction того же ZIP: parent `context.local/work/current-invisible-chat/portable-smoke-r1/portable-smoke-receipt.json`, SHA-256 `fd838b73941a2fb8a2f00d5080f43cf1ef704e53451dd73f8a6383fd9f85ad45`, `final-zip-direct-portable-smoke-v1` PASS/STOPPED. Medium runtime, own fixed runtime/internal user data, native window и реальные toxcore/pthread components подтверждены; PNG сохранён. Registered prebuilt import manifest: `outputs/invisible-chat-windows-20261005-r1/evidence/prebuilt-import/current-chat-677cf9814a9d4d59ae8586644f4f4148.json`, SHA-256 `ba76714dd703fa3577f96789f33c38ac48dfcc7e1e8dd677479f57e746c7a947`; Windows projection после coordinator commit: `context.local/work/runtime/local-portable/payloads/windows-finish/374cb65da470c22b497a3746421c31a7.json`, SHA-256 `6a2bcd98e921cf76076ba9b42638a2f9fed52a0da809abb973e950e7f7e4f399`. Import/projection identities сообщены workflow owner; frozen inputs и coverage map не изменялись.

## Завершённая prototype synchronization

Registered main sync завершён `2026-10-05T14:04:32.062Z` для transaction `677cf9814a9d4d59ae8586644f4f4148`. CURRENT generation 192, pendingRef=null; active receipt parent `context.local/work/runtime/prototype-sync/payloads/436f37d984b84fea4ce1438f2cf41343.json`, SHA-256 `985dc74ef96633eb62225df3cd8ab0c2108caa359f5cbf03add1f004b13e6e39`, COMPLETE/mainSync PASS. Принят baseline `main-20261005-2fdfcf18-677cf981`, source HEAD `937e5f4001c47c1c74b9b8233802060ffe73c610`, 92 source files/tree `2fdfcf18fb5eaf065bf904faf604238d7e2899dfdb2447077f6972c853a20fcd`. Независимый `prototype:baseline:status` подтвердил clean=true, draft=null, drift empty, currentHash=baselineHash=`fccfd390cb07efa5f68a5e1b713505abb61c4815527859968caa4eefe4c50df6`.

Requested `main-chat,main-chat-history` штатно расширены input graph: 62 scenarios ×2 themes, 124 captures, reused=0. Capture receipt physical SHA-256 `4411806c9a502cce4a75ce2e6afd75d1a1dc43c4e10b2df589d64c02c8de4b16`; declared/pinned manifest digest `4d562053c9b7464d23c3feac835e2aa89fd6566bd93e74302f667f92ed8dd90d`, физический `screenshots/capture-manifest-v2.json` SHA-256 `da906828148fd71d296ef99c9cf2ec9270fa7cf25b54b5d78fe26b371ee59562`; capture contract digest `d2b0766072b95c48f7d4e9f9e4f3a3dba2597d86f776647af05266d5745ee19a`. Prototype pin SHA-256 `184755cec6eef0a1801b1f51e2e94d0006d01e968f55fcf040f9d2a9eb56088c` связывает exact baseline/source/receipt/manifest digest. Registry physical hashes: parent `context.local/ui/CANONICAL-UI-IDS.json`=`c55b81852218679786adca53b6e9e827551233827043bcb3a10dc6dc03bb89d2`; prototype accepted=`5c7ac9f759a8d0f6e429f834fb2ca072b605fb3bb83cf391be1488f3180a0217`, runtime canonical=`b7bde515f5c0d997feacdb9079ef7cd697f9f7ab4fe3cf61ee4fc8bfb8b1106f`.

Текущий VM verification receipt parent `context.local/work/20260927-pq-notice-image-reactions/prototype-vm-verification/141facc19de64d4f922c96956ec729f8/receipt.json`, SHA-256 `8b1f155da4317351c1414dafaf80bf27b354bea488ec301ce912ee1e7c0efddb`: PASS/exit0, 3148 inputs неизменны, input manifest `d53f5cde5df8b29a6226e73554749f671a8da6f6279f8a8c235670aeb69fca06`, log `33e5d60f280159b9c82197494ed060817f0629cdaf580ef8eec5883fb990e9cb`. Workflow owner подтвердил 132/132 contracts и build PASS. Test-only support repair четырёх assertions reviewed workflow owner: `context.local/work/20260927-pq-notice-image-reactions/invisible-chat-677cf981-support/support.json` SHA-256 `337a04197a3a2aa78e660f1cc99bdc86c714e53e268585db7f2af4f868e527bf`, только destination `tests/prototype-contract.test.mjs` SHA-256 `b90497ae31a59b6f2a77b94eeb625749545459ca6e0986b64babdc0d75c76af8`; registry upsert/remove пусты, product inputs не менялись. Отдельный preflight receipt `invisible-chat-677cf981-support/preflight/receipt.json` SHA-256 `bd7e6a2b52ccf5b30e8e26c0542ae00fdf988562adf0f4427ef2cf3769d53f48` PASS, 132 contracts по workflow owner.

Предыдущие failures сохранены: первоначальный EPERM lstat; coordinator response timeout после captures до adoption; исходный VM run `73b5acea4043425c9a7e8f31fc11a6dd` с 130/132 вместо PASS. До успешного retry штатный recovery восстановил прежний baseline/registry, pending state очищен. Новая попытка использовала registered route, guards не обходились.

Workflow owner отдельно проверил фактический UTF-16LE `tests.log` текущего run `141facc19de64d4f922c96956ec729f8`: строки 206/208–212 — tests=132, pass=132, fail/cancelled/skipped/todo=0. Это итоговый actual sync run, отдельный от preflight.

## Завершённый local Web Lab finish и итоговый scope

Exact Laboratory owner: `D:\Kaigen\Тестовая среда для отладки приложений - лаборатория Kaigen`. Delegated Lab owner подтвердил fresh r2 public run PASS, READY, rollback/persistence и cleanup; source candidate совпадает с frozen Windows source tree/ZIP. Build ID `invisible-chat-web-20261005-104627c93d92-13b36593c601-r2`. Evidence base внутри Lab: `artifacts/invisible-chat-web-20261005-104627c93d92-13b36593c601-r2/web`.

| Lab evidence относительно base | SHA-256 / результат |
| --- | --- |
| `candidate/web-lab-contract.json` | `75d285aa884aaa59d1933f90492f900c9df66707c075aa40a0c5503d3bf27e0a` |
| `attempts/20261005T142304412Z-a1eba204f6974754ad33dfc99e983412/ready.json` | `5f8067f55b09854b59791b997c602407db7605c0d619593a2a866ce482a4bc3e`, READY |
| Candidate package | `08a780b15a11dbd59a4617ceb8aafa9e0b40e7ce69da0302c0e6af2693da557c` |
| `interop/cb22450e324b48f797a061ff7965c295/web-candidate-activated.json` | `84a8a9a2333c9d294fb02aa7090c437f85c8d7dfe9171545fa553bb09becc516`, activation exit0 |
| Installed release manifest | `c1687b14db9c4fa335516a4c554f9826b812ebe2d9f7d18c7f9bfdd689e1a114` |

Nonce `cb22450e324b48f797a061ff7965c295`: slot b selected, service active, VM running намеренно. Final normal HTTPS `https://kaigen.test/api/v1/build-identity` вернул HTTP200 с system TLS verification без bypass в `2026-10-05T14:35:49.223Z`; status=ok и exact r2 build ID. Lab `context.local/work/invisible-chat-20261005/final-https-readback-receipt.json` SHA-256 `68905b55a7ecd75e844f086f6e962ac19bd85545791860c86de3edc90827efbe`; sibling `final-https-build-identity.json` SHA-256 `23b579f26743239e5ffa54a7010a380d778118e135845403cc7529fac87447f7`. Workflow owner просмотрел functional PNG с видимыми сообщениями, цитатой и deleted-original fallback. Исходный четырёх-test Lab contract отклонён allowlist до VM mutation; r2 выбирает текущие два canonical targeted tests. Исходный отказ сохранён, не объявлен product failure.

Фиксированный механизм VM IP сохранён: IP/DHCP/NIC/hosts и persistent SSH/network settings не менялись; проверен тот же public key для task-temporary SSH alias. Protected working-client data сохранены. Commit/push/Release/production/девять test clients не входят в authority и не выполнялись.

Post-completion review завершён: parent `context.local/work/current-invisible-chat/workflow-review-20261005.md`, SHA-256 `625ff9a268ddfcd5dc34bfaf47fa12f9c8e5e1d98fcdbb56fcff2523c2c43369`. Caveman, LeanCTX, Serena, context-mode, RTK и OpenViking оценены отдельно; семь обоснованных предложений оставлены для отдельной реализации. Новые pilots, global tool/skill changes и измеренная экономия не заявлены. Все обязательные product finish gates завершены, tasks 3.1–3.4 закрыты. Sole delta `live-message-visibility` синхронизируется последовательно перед архивом; immutable snapshot, pinned coverage и unrelated dirty work сохраняются.
