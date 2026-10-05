# Spec Delta

## Purpose

Обеспечить воспроизводимое построение зависимостей нативных и Rust-проверок, чтобы независимая правка интерфейса не требовала повторов при сохранении полноты и исходной идентичности evidence.

## ADDED Requirements

### Requirement: Проверенный набор зависимостей

Система SHALL строить отсортированный набор полных source inputs отдельно для каждой поддерживаемой native/Rust-проверки и связывать его с версией policy, producer, command и variant. Validator MUST самостоятельно проверять полноту набора, hashes, membership и допустимые типы файлов.

#### Scenario: Независимая правка интерфейса
- **WHEN** меняются только Settings/i18n при неизменных проверенных native recipes, конфигурации и окружении
- **THEN** native/Rust source fingerprint сохраняется, а source identity всего плана и обязательные frontend-проверки учитывают новое состояние.

#### Scenario: Изменение нативного входа
- **WHEN** меняется native/Rust input либо добавляется, удаляется или переименовывается существенный файл
- **THEN** fingerprint меняется либо policy отклоняется до использования старого результата.

#### Scenario: Неполный набор
- **WHEN** из caller-supplied inputs удалён обязательный путь, подменён hash, mode, policy или variant
- **THEN** validator отвергает план до исполнения или reuse.

### Requirement: Граница проверенной recipe

Узкая policy MUST применяться только при совпадении с проверенной dependency-reader recipe и полном учёте конфигурации. Непроверенные readers, custom-protocol, overrides, внешние dependencies или неизвестные пути SHALL блокировать эту policy до нового аудита; полный tracked inventory не доказывает полноту внешних входов.

#### Scenario: Новый способ чтения frontend
- **WHEN** меняется native reader/build recipe, появляется Cargo/Tauri config, пропадает devUrl или включается custom-protocol
- **THEN** узкая policy не допускает reuse без проверки новой dependency closure.

#### Scenario: Внешний override
- **WHEN** процесс использует непроверенный environment override или dependency вне установленной source closure
- **THEN** producer или validator отклоняет узкую policy, сохраняя действующие runtime/cache проверки.

#### Scenario: Игнорируемый discovery input
- **WHEN** в execution root добавлен игнорируемый Tauri config, capability/permission или ML-KEM reader, хотя Git status чист
- **THEN** проверка физического состава отвергает узкую policy до reuse.

### Requirement: Неизменность прежнего evidence

Producer SHALL записывать новый план без перезаписи входного. Legacy plans/results MUST сохранять прежние inputs и правила; новая policy MUST принимать только результат с той же policy, producer identity и command/variant. Первая миграция или существенное расхождение SHALL требовать нового запуска и удалять прежнюю ссылку reuse.

#### Scenario: Первый переход
- **WHEN** старый широкий plan переводится на новую policy
- **THEN** затронутые проверки получают run, старые receipts остаются побайтно неизменными и не становятся совместимыми после удаления UI inputs.

#### Scenario: Поддельная миграция
- **WHEN** legacy result снабжён искусственными policy input IDs без надлежащей policy/producer identity
- **THEN** новая ветка reuse отвергает его.

### Requirement: Сохранение общих gates

Оптимизация MUST сохранять полную source identity плана, whole-run mutation checks, обязательное покрытие, original timestamps, runner/environment/cache gates и требования свежего запуска. Source fingerprint SHALL отражать только совместимость выбранных source inputs, а не доказывать идентичность внешних DLL или toolchain.

#### Scenario: Обязательный свежий прогон
- **WHEN** текущий gate или выбранный полный режим требует нового выполнения
- **THEN** неизменный узкий source fingerprint не отменяет этот запуск.
