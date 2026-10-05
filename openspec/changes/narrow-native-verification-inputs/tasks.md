# Tasks

## 1. Producer and validation

- [x] 1.1 Добавить versioned native/Rust source-input generator и write-once CLI; проверить неизменный fingerprint после UI-only diff и перевод legacy plans на fresh run без записи старого evidence.
- [x] 1.2 Проверять canonical inputs, recipe membership, policy/producer/command/variant при validate/reuse и сохранять policy в новых results; проверить отказ для subset, подмены identity и legacy result.
- [x] 1.3 Добавить fail-closed guards для непроверенных reader/config/env изменений и unsafe paths/modes; проверить добавление config, native reader, внешний override и изменённую membership.

## 2. Verification and guidance

- [x] 2.1 Подключить regression family к существующему contract entrypoint; выполнить native-input, CI-incremental и build-pipeline contract checks, сохранив исходные сбои отдельно от повторов.
- [x] 2.2 Провести независимый review diff и проверить сохранение whole-run guards, full-release selection и старых evidence hashes; устранить найденные ошибки и повторить только затронутые checks.
- [x] 2.3 Описать фактический CLI, границы policy, первое fresh выполнение и требования обновления review в owner guidance; проверить OpenSpec strict validation, полный diff и final Git status.
