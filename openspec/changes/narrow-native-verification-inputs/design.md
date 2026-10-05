# Design

## Context

См. proposal.md — Why. Предыдущий ordinary plan клонировал inputs из старого плана одноразовым Node producer. MAIN workers проверяют hashes и передают план source-owned validator; постоянного ordinary closure producer нет. `current-verification.mjs` проверяет целый текущий source inventory, этот отдельный контракт сохраняется.

Аудит выполнен на `046c865fc9f67337190867ababb5a46591f2b304`. Default `cargo test --lib` не включает tauri-macros/custom-protocol: pinned tauri-macros/codegen/build 2.7.0 с tauri 2.12.0 и заданным devUrl использует пустой EmbeddedAssets. `tauri_build::build()` по проверенной recipe читает native config/ACL/icons/resources, не запускает frontend build.

## Goals / Non-Goals

**Goals:** постоянный producer, проверяемая validator policy, безопасная миграция и регрессии на неполную closure.

**Non-Goals:** универсальный dependency parser, оптимизация explicit full-release выбора, изменение CI catalogs, новые product artifacts, hosted/network операции и переоценка старого evidence.

## Decisions

1. Новый `scripts/native-verification-inputs.mjs` читает immutable Git source и выдаёт детерминированные inputs/policy для поддерживаемого check. CLI создаёт новый план write-once; входной plan и baseline evidence не изменяет. При новой policy, изменённых inputs, command/variant или bindings переводит check в run и удаляет evidence.
2. Узкая policy зависит от version, producer/validator identity, command/variant, отсортированных paths/modes/hashes и проверенной reader recipe. Whole-source commit/tree остаётся identity плана и не входит в узкий fingerprint.
3. Проверенную recipe закрепляет source-owned review record с paths/modes/SHA-256 и informational anchor указанного аудита. Runtime не требует Git object этого исторического anchor: чистый snapshot содержит сам hash-bound record. Неизвестная или изменённая reader recipe, config membership, unsafe mode, внешний override или неподдерживаемая конфигурация отклоняют узкую policy. Автоматического fallback на весь Git source нет: он не покрывает неизвестные внешние reads. Последующая native-задача может обновить review после реального аудита зависимостей; старые snapshots не переписываются.
4. Source closure: prepared-cache — четыре PS1 (test, helper, build-portable, prepare-dependencies); retry-cap — его PS1; loopback — PS1 и C harness. Rust — tracked src-tauri, mlkem native C/headers, runtime, web-background-transfer fixture и Cargo/config/toolchain membership. Reader code/manifests/build/config и весь mlkem subtree требуют точного review guard: C/header тоже могут добавлять внешние include paths. Остальные известные data inputs входят полными hashes и могут инвалидировать reuse без изменения policy.
5. `incremental-windows-verification.mjs` recomputes policy до reuse/execution. Новый result сохраняет ту же policy и variant; legacy/imported/equivalence результаты не получают новую policy автоматически. Existing assertMatchingInputs и original timestamps сохраняются. Старый cross-source запрет rust:all остаётся для legacy; только полностью проверенная новая policy с точным ordinary result/command/variant/inputs позволяет reuse полного неизменного Rust набора после UI-only diff. Явно выбранный fresh run не отменяется. Producer identity проверяется также по фактически выполняемым модулям, а не только по blobs целевого source.
6. Source-only closure не доказывает идентичность DLL, VS/SDK, prepared libraries или effective runtime. Existing file inputs и внешние cache/runner/runtime gates сохраняются. Непроверенные существенные environment/config overrides и внешние Cargo configs блокируют узкую policy; их значения не сохраняются в диагностике. Единственное разрешённое compiler-flag исключение — точная пара path remaps действующего Windows runner: execution root в `C:\KaigenRepro\source` и actual OS user profile в `C:\KaigenRepro\user`, с U+001F separator и без других токенов. Его `build-portable.ps1` также входит в Rust review guard.
7. Регрессии подключаются к существующему verification contract entrypoint. Disposable Git fixtures проверяют positive UI-only compatibility и negative source/config/policy/receipt cases. Product builds не нужны для изменения verification tooling; предыдущее product evidence сохраняет исходную identity.

## Risks / Trade-offs

- [Новый reader прочитает путь вне closure] → точный review guard и отказ до аудита, без эвристического parser.
- [Добавленный config пропущен при прежних hashes] → проверка membership и modes, включая ранее отсутствовавшие Cargo/toolchain/config файлы; физический состав discovery-каталогов в execution root проверяется отдельно от Git, чтобы игнорируемые файлы и reparse paths не меняли closure незаметно.
- [Старый результат ошибочно объявлен новым] → явное совпадение result policy/producer/command и неизменные старые inputs.
- [После native-правки нужно обновлять review] → намеренный компромисс первого этапа; новая policy не отменяет обычные полные проверки.

## Migration Plan

Сначала принять новый producer/validator и выполнить contract tests. При следующем применении создать новый plan; affected checks выполнить свежими для первого результата новой policy. Только последующие совместимые планы допускают reuse через обычный validator. Откат tooling сохраняет все старые планы/receipts и не требует отката уже установленного продукта.
