# Источники реализации — 5 октября 2026

- GitHub download-artifact: https://github.com/actions/download-artifact — download по artifact ID, по умолчанию текущий repository/run без отдельного token; contract для передачи build → package.
- GitHub upload-artifact: https://github.com/actions/upload-artifact — immutable artifacts и outputs artifact-id/digest; не считать Actions cache происхождением релизного файла.
- Повтор отдельных jobs: https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs — проверен 05.10.2026; можно повторить failed/specific job, исходные GITHUB_SHA и GITHUB_REF сохраняются.
- Канонический local source версии: package.json; согласованность package-lock.json, src-tauri/Cargo.toml, src-tauri/Cargo.lock, src-tauri/tauri.conf.json проверяет release-version helper.
- Точные workflow pins и historical release authority остаются в .github/workflows/publish-release-0298.yml и scripts/publish-actions-release.mjs; текущая версия не заменяет эти ограничения.
- Локальная проверка YAML: существующий PyYAML в Python runtime установленного OpenViking; путь брать из подтверждённого tool runtime/config, личный host path в source не копировать. В node_modules проекта и системном Python yaml отсутствует.
- Bounded LeanCTX CLI: `read-owner.mjs --root <exact-owner> --wrapper <verified-wrapper> --lines=N-M <file>`; параметр с `=`. Для крупного raw output контролировать фактическое усечение и покрытие; повтор полного запроса с большим внешним output budget не снимает внутренний лимит сервера.

Внешние источники сохранены сразу при обнаружении. Официальный tag download-artifact v8.0.1 проверен через git ls-remote https://github.com/actions/download-artifact.git refs/tags/v8*: SHA 3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c. Workflow закрепляет полный SHA; параметры artifact-ids и digest-mismatch описаны в официальном README.
