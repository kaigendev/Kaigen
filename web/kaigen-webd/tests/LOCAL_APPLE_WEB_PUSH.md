# Локальный стенд Apple Web Push

Стенд проверяет реальный Rust-отправитель Kaigen по HTTPS. Node.js принимает
запрос, проверяет подпись VAPID, а тестовый получатель расшифровывает сообщение
по RFC 8291. Проверяются ответы 201, 404, 410 и 503, совместимые поля уведомления
и раскрытие защищённого маршрута до точного профиля и чата.

## Повторный запуск на Windows

Запустить из корня KaigenToxClient с подготовленными Cargo-входами, ToxCore и
libsodium. Нужны Node.js и OpenSSL. Если OpenSSL есть в PATH, переменную
`OPENSSL` можно пропустить.

```powershell
$kaigenArtifacts = Join-Path (Split-Path -Parent (Get-Location).Path) 'outputs/local-apple-web-push'
New-Item -ItemType Directory -Force -Path $kaigenArtifacts | Out-Null
$env:KAIGEN_LOCAL_WEB_PUSH_RUN_ROOT = $kaigenArtifacts
$env:OPENSSL = 'C:/Program Files/Git/usr/bin/openssl.exe'
pwsh -NoProfile -File scripts/test-windows-rust.ps1 -Suite web-daemon `
  -Filter production_sender_round_trips_through_local_apple_web_push_provider -Ignored -NoCapture
```

Ожидается одна успешная проверка и строка `LOCAL_APPLE_WEB_PUSH_PASS`.
Тест сам запускает и останавливает провайдера. Временные ключи, сертификаты
и журнал запроса удаляются после прогона.

## Отдельный запуск провайдера

```text
node web/kaigen-webd/tests/local_apple_web_push_provider.mjs --dir <пустой-каталог-прогона> --vapid <тестовый-публичный-VAPID-ключ> --subject https://kaigen.test
```

Сервер слушает только 127.0.0.1 на свободном порту. В приватном каталоге прогона
появятся `ready.json` с портом, сертификатом и синтетической подпиской, а после
запросов — `observed.jsonl`. При ручном запуске остановить сервер и удалить
этот каталог после проверки. Ключи и данные подписки в отчёты не включать.

Тестовый клиент сопоставляет только `kaigen-fixture.push.apple.com` с loopback
и доверяет только сертификату прогона. Системный DNS и доверенные сертификаты
не меняются. Доставка от Apple и системный тап iOS проверяются отдельно.
