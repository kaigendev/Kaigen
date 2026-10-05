# Проверка локальной реализации

Дата: 05.10.2026. Owner: KaigenToxClient. Исходный HEAD: `937e5f4001c47c1c74b9b8233802060ffe73c610`; изменения остаются локальными, без commit/push/Actions.

## Результат

1. Windows workflow разделён на build и package. Передаются portable/source ZIP, план, exact receipts/logs через artifact того же run. Проверяются ID до download, repository/SHA/run/producer attempt, manifest SHA, полный набор и хеши файлов, отсутствие ссылок и выходов за границы. Попытка consumer может быть позже producer. Передача хранится 7 дней; несовместимые абсолютные runner paths отклоняются.
2. MSI, финализация и четыре публичных artifact сохраняют прежние контракты. Только частичные публичные outputs того же run заменяются при повторе package; внутренний producer artifact неизменяем. Portable/Cargo/Tauri не пересобирается в package. Небольшой shutdown helper по-прежнему создаётся MSI через прежний Rust toolchain.
3. Общая версия из package.json проверяется по npm/Cargo/Tauri manifests/locks до дорогой работы. Windows/Unix/Web/publisher используют её labels. Исторические publisher tag/run/SHA, allowlists и concurrency lock не расширены. Новый CI contour не может пользоваться чужой старой provenance.

## Свежие проверки

- `node scripts/test-build-pipeline.mjs`: PASS, 148 прежних assertion; связанные CI/receipt/provenance/полнота suites прошли; вложенные 22 сценария handoff и 40 тестов версии прошли.
- После последнего узкого guard перед download повторён только затронутый `node scripts/test-windows-ci-handoff.mjs`: 22 сценария и workflow contracts PASS. Остальная успешная интеграция переиспользована, не выдана за новый прогон.
- `node scripts/test-test-registration.mjs`: PASS; оба новых теста зарегистрированы как nested существующего build-pipeline и реально вызываются им.
- Списки RELEASE_0298_CI_PATHS и catalog.allowedCiPaths совпадают: 35 точных путей. Старый общий CI_PATHS не расширен; product inputs и исторические producer pins не менялись.
- YAML трёх изменённых workflows разобран существующим PyYAML из установленного OpenViking runtime: PASS. Node yaml и системный Python yaml отсутствуют; новые зависимости не устанавливались.
- `git diff --check`, синтаксис helpers, strict OpenSpec: PASS. Независимый обзор handoff/source/attempt/path/receipt и historical publisher constraints завершён.

Первый интеграционный прогон выявил оставшиеся literal-version assertions Web; assertions приведены к новому contract, затем весь pipeline прошёл. Ошибка чтения отсутствующего fixture.bin внутри негативного Git-теста ожидаема; итоговый exit code=0.

## Граница доказательства

Настоящий hosted Actions, MSI install, compilation продукта и повтор упавшего package job не запускались. Реальная экономия времени ещё не измерена. Exact absolute runner layout должен совпасть; иначе restore закрыто отклоняет передачу. Для ввода в GitHub необходимы отдельно разрешённые commit/push/Actions. Локальные тестовые artifacts не являются релизными.

## Разбор эффективности

- Caveman: короткие сообщения о завершении каждого пункта; условия и ограничения сохранены.
- LeanCTX: точные owner roots и свежие pre/post reads. Большой catalog и monolith усекались лимитами; нужны ограниченные окна/полный контроль покрытия, а не повтор одного огромного запроса. Доля экономии токенов не измерена.
- Serena: SOURCE активирован и подтверждён, использован для нужного publisher symbol. MAIN cpp-only не поддерживает .mjs; попытка конфигурации зависла, применён предусмотренный literal/unsupported-file маршрут без смены config.
- context-mode: не использовался; отдельный разрешённый индекс для этих оригиналов отсутствует, bounded excerpts дали необходимый ответ.
- RTK: обычный краткий вывод; raw diff и exact matching через proxy.
- OpenViking: SOURCE search существующей generation `9c60b82d7ce64b9e89c1af36f8c95e9b`, 0 новых LLM calls, 3 cached summaries. Найденные product specs не помогли задаче CI; pending отсутствует. MAIN assessment потребовал новый индекс, но новый cloud corpus не разрешён. Индекс не создавался, семантический поиск MAIN не заявляется.

Повторных вопросов о разрешённых локальных чтениях не было: известный runtime lock/access сбой проходил через точный escalation route. Первые ошибки аргументов LeanCTX и две попытки отсутствующего YAML parser были лишними; дальнейший маршрут зафиксирован в источниках ниже. Новую программу оптимизации и новый навык не создавать: достаточно применять существующий owner-context-preflight и проверенный runtime.

Источники: [sources.md](sources.md); [решения пользователя и итог](../../../../KAIGEN-WORKFLOW-DECISIONS-2026-10-05.md) в основном owner-проекте.
