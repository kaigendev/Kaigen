# Native/Rust inputs для ordinary Windows verification

`scripts/native-verification-inputs.mjs` строит проверяемые source inputs для трёх native-проверок и поддержанных Rust library checks на Windows x64. Он заменяет одноразовое копирование широких списков из предыдущего ordinary плана. Это identity evidence; необходимость тестов определяет действующий PRODUCT-WORKFLOW, а не policy или её хеш.

## Использование

Сначала подготовить обычный план для точного immutable source с действительными source/productSource, baseline, changes, frontend coverage и внешними bindings. Затем создать отдельный план:

```text
node scripts/native-verification-inputs.mjs produce --root <source-root> --plan <current-plan.json> --plan-sha256 <sha256> --output <new-plan.json>
```

Source должен содержать producer, validator и review record. Исторический Git object аудита не требуется: record хранит проверенные paths, modes и hashes. Новый output создаётся write-once в том же каталоге, что и входной plan: это сохраняет значение относительных ссылок. Входной plan и старые receipts сохраняются.

Полученный plan всё равно проходит обычный `incremental-windows-verification.mjs validate`, зарегистрированный Windows worker и финальные проверки. Producer не меняет общую source identity, frontend coverage, baseline evidence или full-release selection.

## Когда возможен reuse

Узкая policy привязана к проверенной dependency-reader recipe, producer/validator, command/variant и полным source inputs. UI-only изменения Settings/i18n при неизменных условиях не меняют native/Rust source fingerprint.

Первая миграция получает `run`: прежний широкий результат не становится совместимым после удаления UI-файлов. Новый result содержит явную policy; последующий reuse требует её точного совпадения и обычной проверки исходного результата. Изменившиеся inputs, policy или bindings требуют нового выполнения. Состояние `run` не превращается в `reuse` только из-за неизменного fingerprint. Для `rust:all` cross-source reuse разрешает только полностью проверенная новая policy с совпадающими command, variant, inputs и ordinary result; прежний legacy запрет сохраняется.

`native:prepared-cache` зависит от четырёх проверенных PS1; retry-cap — от своего runner; offline-friend-request — от PS1 и C harness. Rust учитывает native source, manifests/build/config, capabilities/icons, mlkem C/headers, runtime и внешний по отношению к crate transfer fixture. Membership также значима: добавления, удаления, переименования и modes нельзя скрыть сохранением hashes старых файлов.

## Когда нужен новый review

Изменение dependency readers, Cargo/Tauri/build recipe, конфигурации, неподдержанный variant, внешние overrides или неизвестные inputs блокируют узкую policy. C/header-файлы mlkem также являются readers: они могут добавлять include paths, поэтому review связывает весь subtree и его membership. `native-verification-input-review.json` обновляют только после проверки реальных зависимостей и нужных регрессий. Нельзя просто заменить hashes ради прохождения validator.

Проверенный default Rust route использует devUrl без custom-protocol и не встраивает frontend. Удаление devUrl или изменение этого режима требует повторного аудита. Непроверенные user/ancestor Cargo configs и существенные environment overrides запрещены. Единственное допустимое compiler-flag исключение — точная пара path remaps, которую задаёт проверенный Windows runner; произвольные дополнительные flags запрещены.

Чистого Git status недостаточно: игнорируемый config или C-файл может изменить сборку. Проверка фактического состава discovery-каталогов в execution root должна отклонять дополнительные файлы и непроверенные reparse paths до разрешения узкой policy.

При отказе сохранить его причину и определить новую closure. Старый полный verification route остаётся отдельным действующим маршрутом; ошибка policy не даёт права ослабить его проверки или заявить reuse.

## Граница доказательства

Source fingerprint не доказывает идентичность внешних DLL, toxcore headers/libraries, PowerShell, VS/SDK или runtime. Существующие внешние file bindings, prepared-cache fingerprints, runner/environment и native runtime gates сохраняются. Immutable source inventory/build metadata в старом плане — provenance, а не замена этих проверок.

Whole-run inventory и pre/post source-mutation guards в `current-verification.mjs` остаются без изменений. Старые timestamps, source/artifact/runner identities и evidence hashes не переписываются. Для явно разрешённого тестирования изменившаяся policy требует нового доказательства; обычная сборка сама тесты не назначает.

Review от 10.10.2026 привязан к HEAD `d6e167fb673e675ba01edb6a27f9f5b33d7cc7f9`: просмотрены изменения portable build modes, toxcore pins, prepared-cache fixture, in-memory contact groups и минимального размера окон. Состав 177 уникальных reader paths и modes сохранён. Новый record hash включён в policy; прежние результаты не получают эту policy задним числом.
