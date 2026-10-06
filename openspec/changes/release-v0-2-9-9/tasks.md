# Tasks

## 1. Подготовка кандидата

- [x] 1.1 Проверить допуск, source/remote/tag identity и статическую согласованность About/components; сохранить отдельные факты проверки без runtime PASS.
- [x] 1.2 Обновить восемь version файлов до 0.2.9+9/0.2.9.9 и проверить release-version/component-inventory checks.
- [x] 1.3 Зафиксировать product/version commit и подготовить CI catalog 0.2.9.9; проверить full selection и неизменность product/build inputs для controller revision.
- [ ] 1.4 Реализовать общий Actions publisher и манифест 0.2.9.9; проверить смену версии без правки кода, негативные cases подмены identity, неполных jobs/assets и конфликтов tag/release независимым review.
- [x] 1.5 Зафиксировать окончательный local candidate commit/tree/diff digest, clean worktree и phase checkpoint до первой candidate-сборки.
- [x] 1.6 Проверить исправления изоляции окружения тестовых fixtures и платформенной применимости; независимо проверить раздельные built-from/verification identities на сохранённых artifacts и негативных случаях изменения product/build inputs.

## 2. Проверка кандидата

- [ ] 2.1 Завершить Windows unit с применимыми автоматическими/native/runtime проверками и hash-bound release-test-set receipt для девяти клиентов.
- [x] 2.2 Завершить Debian desktop unit; сохранить точные built-from identity, archive/hash и runtime receipt.
- [x] 2.3 Завершить macOS unit; сохранить identity, archive/hash, runtime receipt и явный ad-hoc/not-notarized public contract.
- [x] 2.4 Завершить Web Lab candidate package, backend/UI/browser flow и связанный с Web bundle receipt.
- [ ] 2.5 Выполнить Windows/Web двусторонний qTox compatibility gate и обязательную release matrix/integral; проверить required leaf receipts и карту reused/rerun/missing.

## 3. Actions и публикация

- [ ] 3.1 После green checkpoint отправить точный release commit в main, выполнить зарегистрированные Actions producers и проверить successful required jobs/artifact IDs/hashes.
- [ ] 3.2 Проверить семь финальных Actions assets, состав/privacy/versions и требуемый final Windows runtime smoke; сохранить отдельные producer receipts.
- [ ] 3.3 Выполнить Actions publisher 0.2.9.9, проверить published tag/commit/URL и hashes через GitHub API/download; сохранить успешный publisher receipt и локальные final assets.

## 4. Завершение

- [ ] 4.1 Синхронизировать выполненную release-publication spec и архивировать completed change; проверить OpenSpec strict validation.
- [ ] 4.2 Завершить разрешённые локальные commits, проверить Git status всех затронутых repositories и сохранность постороннего interface plan; провести workflow-optimization review по существующему evidence.
